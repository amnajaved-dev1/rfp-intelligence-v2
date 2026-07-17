// server.js
// Backend proxy for the RFP Intelligence Portal.
//
// Why this exists: the Gemini API key must never live in browser/frontend code.
// Anyone can open dev tools and read it out of page source or network requests
// if it's called from the browser directly. This server holds the key in an
// environment variable (.env, NOT committed to git) and the frontend calls
// THIS server instead of calling Google directly.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

// Simple PDF text extraction without pdf-parse
async function parsePdf(buffer) {
  try {
    // Try pdf-parse first
    const pdfParse = require('pdf-parse');
    return await pdfParse(buffer);
  } catch(e1) {
    try {
      // Fallback: extract readable text directly from PDF buffer
      const text = buffer.toString('latin1');
      const matches = text.match(/\(([^)]{2,200})\)/g) || [];
      const extracted = matches
        .map(m => m.slice(1, -1))
        .filter(s => /[a-zA-Z]{3,}/.test(s))
        .join(' ')
        .replace(/\\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
      if (extracted.length > 100) return { text: extracted };
      throw new Error('Could not extract text from PDF');
    } catch(e2) {
      throw new Error('PDF parsing failed: ' + e2.message);
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// FIX #3: insurance go/no-go threshold is now a config value, not something
// baked into the LLM prompt as a "fact-finding" instruction. Change this (or
// set INSURANCE_THRESHOLD in .env) to match your company's actual risk
// tolerance. The LLM's job is now only to extract the real dollar figures
// from the RFP text; the GO/NO-GO math happens here in plain JS.
const INSURANCE_THRESHOLD = Number(process.env.INSURANCE_THRESHOLD || 5000000);

if (!GEMINI_API_KEY) {
  console.error('\n[FATAL] GEMINI_API_KEY is not set.');
  console.error('Create a .env file in /backend (copy .env.example) and paste your key in.\n');
  process.exit(1);
}

// --- CORS ---
// In dev, allow your local frontend. In production, set FRONTEND_ORIGIN in .env
// to your deployed frontend's URL and lock this down (avoid '*').
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '5mb' })); // RFP text can be long; allow a generous body size

// --- File upload handling ---
// Files are kept in memory only (never written to disk) and discarded after
// the request completes. Max 15MB, restricted to PDF/DOCX/TXT.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = [
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];
    const okExt = /\.(pdf|txt|doc|docx)$/i.test(file.originalname);
    if (okTypes.includes(file.mimetype) || okExt) return cb(null, true);
    cb(new Error('Unsupported file type. Upload a PDF, DOCX, or TXT file.'));
  }
});

// --- Basic rate limiting ---
// Protects your free Gemini quota from being burned by retries/abuse.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                  // 30 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }
});
app.use('/api/', limiter);

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Extract endpoint ---
// Frontend uploads the raw file here first. We extract plain text server-side
// (so the browser never needs a PDF/DOCX parsing library) and hand back the
// text for the user to review/edit before analysis, plus the filename.
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { buffer, mimetype, originalname } = req.file;
    let text = '';

    if (mimetype === 'application/pdf' || /\.pdf$/i.test(originalname)) {
      const parsed = await parsePdf(buffer);
      text = parsed.text;
    } else if (/\.(docx)$/i.test(originalname)) {
      // Lightweight DOCX text extraction without extra heavy deps:
      // DOCX is a zip; pull document.xml and strip tags.
      const mammothText = await extractDocxText(buffer);
      text = mammothText;
    } else {
      // .txt or .doc fallback: treat as plain text
      text = buffer.toString('utf-8');
    }

    text = (text || '').trim();
    if (text.length < 50) {
      return res.status(422).json({ error: 'Could not extract readable text from this file. Try a different file or paste the text manually.' });
    }

    res.json({ filename: originalname, text });
  } catch (err) {
    console.error('Extract error:', err.message);
    res.status(502).json({ error: err.message || 'Could not read the uploaded file.' });
  }
});

// Minimal DOCX text extraction (no external binary deps): unzip in-memory,
// read word/document.xml, strip XML tags, collapse whitespace.
async function extractDocxText(buffer) {
  const { default: JSZip } = await import('jszip').then(m => ({ default: m.default || m }));
  const zip = await JSZip.loadAsync(buffer);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('Could not read this DOCX file.');
  const xml = await xmlFile.async('string');
  return xml
    .replace(/<w:p[ >]/g, '\n$&')        // newline before each paragraph
    .replace(/<[^>]+>/g, '')              // strip all tags
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Main analysis endpoint ---
// Frontend sends: { rfpText, strengths, gaps }
// We build the prompt server-side, call Gemini with the server-side key,
// apply deterministic post-processing (deadline check, insurance threshold),
// and return the result to the frontend.
app.post('/api/analyze', async (req, res) => {
  try {
    const { rfpText, strengths, gaps } = req.body;

    if (!rfpText || typeof rfpText !== 'string' || rfpText.trim().length < 200) {
      return res.status(400).json({ error: 'rfpText is missing or too short. Upload a valid RFP document.' });
    }

    const prompt = buildPrompt(rfpText, strengths || '', gaps || '');
    const result = await callGemini(prompt);
    const finalResult = applyDeterministicChecks(result);
    res.json(finalResult);

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(502).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// --- Merged analysis endpoint (NEW) ---
// Frontend sends: { documents: [{ filename, text }, ...], strengths, gaps }
// Combines MULTIPLE documents belonging to the same RFP opportunity into a
// SINGLE Gemini call and returns ONE merged result, with every finding
// tagged to its source filename via "source_document".
app.post('/api/analyze-merged', async (req, res) => {
  try {
    const { documents, strengths, gaps } = req.body;

    if (!Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ error: 'documents array is missing or empty.' });
    }
    for (const d of documents) {
      if (!d.text || typeof d.text !== 'string' || d.text.trim().length < 50) {
        return res.status(400).json({ error: `Document "${d.filename || 'unknown'}" has no readable text.` });
      }
    }

    const prompt = buildMergedPrompt(documents, strengths || '', gaps || '');
    const result = await callGemini(prompt);
    const finalResult = applyDeterministicChecks(result);
    res.json(finalResult);

  } catch (err) {
    console.error('Merged analysis error:', err.message);
    res.status(502).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// FIX #2 + #3: Deterministic, code-based checks that don't rely on the LLM's
// arithmetic or judgment. The LLM's job is now purely extraction (deadline
// date found, dollar figures found); the pass/fail decisions happen here in
// plain JS so they can't drift or be "reasoned" into a different answer.
function applyDeterministicChecks(result) {
  const out = { ...result };

  // --- Deadline check ---
  // The LLM is asked (see buildPrompt) to extract deadline_date_iso in
  // YYYY-MM-DD format. We compare it to the real current date ourselves.
  if (out.deadline_date_iso) {
    const deadline = new Date(out.deadline_date_iso + 'T23:59:59');
    const now = new Date();
    const passed = !isNaN(deadline.getTime()) && deadline.getTime() < now.getTime();
    out.deadline_passed = passed;
    if (passed) {
      out.recommendation = 'NO-GO';
      const warning = `⚠ SUBMISSION DEADLINE HAS PASSED (${out.deadline_date_iso}). This RFP cannot be submitted as-is — confirm whether an addendum has extended the deadline before proceeding. `;
      out.recommendation_summary = warning + (out.recommendation_summary || '');
    }
  } else {
    out.deadline_passed = null; // unknown — could not find/parse a deadline
  }

  // --- Insurance threshold check ---
  // The LLM extracts the raw dollar figures it found (insurance_figures) plus
  // whether each one is statutory (no fixed $) and, for tiered coverage like
  // Cyber Liability, whether that specific tier applies to this contract.
  // We only compare the threshold against entries that are (a) a real dollar
  // figure and (b) actually applicable — so a Tier 3/medical-data cyber
  // liability figure doesn't wrongly trigger NO-GO on a general web project
  // just because it appears somewhere in the RFP's insurance exhibit.
  if (Array.isArray(out.insurance_figures) && out.insurance_figures.length) {
    const applicableValues = out.insurance_figures
      .filter(f => f.is_statutory !== true && f.applies_to_this_contract !== false)
      .map(f => Number(f.amount))
      .filter(n => !isNaN(n) && n > 0);
    const highestSingle = applicableValues.length ? Math.max(...applicableValues) : null;
    out.insurance_highest_single_coverage = highestSingle;
    out.insurance_threshold_used = INSURANCE_THRESHOLD;
    out.insurance_exceeds_threshold = highestSingle !== null ? highestSingle > INSURANCE_THRESHOLD : null;

    // Flag if the model couldn't confidently determine tier applicability at all,
    // so the frontend can surface a "needs manual review" note.
    const undeterminedTiers = out.insurance_figures.filter(
      f => f.applies_to_this_contract === false && /could not be determined/i.test(f.tier_note || '')
    );
    out.insurance_tier_needs_review = undeterminedTiers.length > 0;
  }

  return out;
}

function buildPrompt(rfpText, strengths, gaps) {
  // FIX #5: 60,000 characters (~15k tokens) was needlessly conservative for
  // a document whose value proposition is "read every exhibit". Gemini 2.5
  // Flash handles far more context; raise the ceiling substantially and log
  // when truncation still happens so it's visible, not silent.
  const CHAR_LIMIT = 400000;
  const wasTruncated = rfpText.length > CHAR_LIMIT;
  if (wasTruncated) {
    console.warn(`[WARN] RFP text truncated from ${rfpText.length} to ${CHAR_LIMIT} characters. Exhibits may be cut off — consider raising CHAR_LIMIT.`);
  }
  const truncated = wasTruncated ? rfpText.slice(0, CHAR_LIMIT) + '\n\n[TRUNCATED]' : rfpText;

  // FIX #2: give the model today's real date so it can compare it to the
  // RFP's stated due date instead of never checking at all.
  const todayIso = new Date().toISOString().slice(0, 10);

  return `You are a senior proposal/bid analyst. Read the ENTIRE RFP document below including ALL Exhibits (Exhibit A, Exhibit B, Exhibit C) and ALL Attachments carefully before answering. Do NOT skip exhibits — they contain critical insurance, legal, and compliance details.

TODAY'S DATE: ${todayIso}

===========================================================================
CRITICAL ANTI-HALLUCINATION RULE — READ THIS BEFORE ANYTHING ELSE:
The JSON template shown further below is a STRUCTURAL example only. Every
specific number, section letter, statute citation, dollar figure, or quoted
phrase inside that example is FAKE and must NEVER be reused, adapted,
paraphrased, or echoed in your real answer, even if it happens to sound
plausible for this RFP. Before writing any "reason" field:
  1. Search the actual RFP text below for a sentence that supports the claim.
  2. Copy the section number and figures from THAT sentence, character for
     character — do not round, approximate, or reconstruct from memory.
  3. If you cannot find a specific supporting sentence, write exactly:
     "Not explicitly stated in RFP — verify manually."
Reusing an example's wording or numbers when the source text says something
different (or says nothing) is a serious error. When in doubt, quote less
and say "verify manually" more.
===========================================================================

STRICT RULES:
1. Read EVERY section including Exhibit A (General Terms), Exhibit B (Special Terms - Insurance), Exhibit C (Additional Terms - Data/Security) before answering.
2. answer must be "YES", "NO", or "N/A" — based ONLY on what is actually written in the RFP.
3. reason must quote the EXACT page number AND section number, in the format "Page N, Section X.Y: <specific text/numbers from the RFP>" (e.g. "Page 5, Exhibit B Section B.2: requires Workers Compensation with statutory limits"). See the PAGE CITATION RULE below for how to determine the page number. Never say "Not mentioned" if it appears in exhibits. If it genuinely doesn't appear anywhere, say "Not explicitly stated in RFP — verify manually," never invent a plausible-sounding citation.
4. PAYMENT TERMS RULE: Search for NET30, "30 days," or similar payment-timing language. Report exactly what the RFP says, including which party it applies to (University paying Contractor, or Contractor paying subcontractors). Do not assume NET30 applies to the University's payments unless the text says so explicitly for that direction.
5. INSURANCE EXTRACTION RULE: Find every insurance coverage type and dollar figure stated in Exhibit B (and Exhibit C if it adds cyber/security-specific figures). For EACH one, add an entry to "insurance_figures": { "coverage_type": "...", "amount": <number, no $ or commas, or null if the coverage is statutory/no-fixed-amount>, "is_statutory": <true if the RFP says "statutory limits" with no dollar figure, e.g. Workers Compensation — false otherwise>, "basis": "per occurrence / aggregate / combined single limit / range — exactly as stated, or 'not specified'", "applies_to_this_contract": <true/false>, "tier_note": "<short explanation of why this entry does or doesn't apply>" }.
   TIERED COVERAGE HANDLING: Some RFPs (like this one's Cyber Liability section) define multiple risk TIERS (e.g. Tier 1/2/3) based on how sensitive the data access is, where only ONE tier applies to a given contract — they are not all simultaneously required. When you encounter tiered coverage:
     a. Read the RFP's Statement of Needs and any Data/Security exhibit to determine what kind of data THIS specific engagement actually involves (e.g. does the vendor access student PII/FERPA records, payment card data, or PHI/medical records, or is it limited to general/public website content?).
     b. Mark "applies_to_this_contract": true on the ONE tier that matches that data-sensitivity level, and "applies_to_this_contract": false on the other tiers, with a "tier_note" explaining which data-sensitivity factor drove the determination.
     c. If you cannot confidently determine which tier applies from the text, mark all tiers "applies_to_this_contract": false and set "tier_note" to "Tier applicability could not be determined from RFP text — requires manual review with the contracting officer."
   Do NOT invent a per-occurrence/aggregate split if the RFP only gives one combined figure or a range — report it exactly as written. Do not calculate GO/NO-GO yourself; just extract the real figures and tier applicability — the threshold comparison is done in code afterward.
6. E-VERIFY RULE: Search Exhibit A carefully for E-Verify. Quote the exact Virginia Code section number as written in the RFP — do not recall it from general knowledge of similar clauses in other RFPs.
7. WORKERS COMP RULE: Search Exhibit B Insurance section carefully.
8. DELIVERABLES RULE: Extract every concrete deliverable, document, form, attachment, or submission item the RFP requires the bidder to submit. Include due dates where stated. For EVERY child item's "reason" field, you MUST start with "Page N, Section X.Y:" (see PAGE CITATION RULE below for how to find N) followed by a short paraphrase of what that section actually requires — e.g. "Page 13, Section XI.B.2: requires Complete Pricing Pages, Contractor Data Sheet, and Substitute W-9 Form as attachments." Never leave a deliverable's reason vague or generic, and never omit the page number — a reader must be able to flip straight to that physical page in the RFP PDF and find the requirement.
   YOU MUST SPLIT DELIVERABLES INTO AT LEAST 3-5 SEPARATE CATEGORIES. Do NOT place every deliverable under one giant category, even if they share a due date — that defeats the purpose of grouping. Group by document TYPE, not by due date. Use categories like (adapt names to what the RFP actually contains):
     - "Cover Sheet & Signature Documents" (RFP cover page, addenda acknowledgments, signature pages)
     - "Required Attachments & Forms" (lettered/numbered attachments, W-9, data sheets)
     - "SWAM / Diversity Compliance Documents" (past and proposed SWAM plans, certifications)
     - "Written Narrative & Technical Response Sections" (statement-of-needs responses, evaluation-criteria narratives, exceptions tab)
     - "Pricing & Cost Submission" (pricing schedules, cost tables)
   If a category would end up with more than 6-7 items, split it further rather than leaving it oversized. A single category holding most or all of the deliverables is treated as an error — re-check your grouping before finalizing.
9. fit_score 0-100. "GO" if >=70, "NO-GO" if <40, "CAUTION" otherwise. This is independent of the deadline check below.
10. DEADLINE RULE: Find the RFP's stated proposal submission due date (usually on the cover page and/or in the Instructions section). Convert it to ISO format YYYY-MM-DD and put it in "deadline_date_iso". If no clear date is stated, set "deadline_date_iso" to null. Compare it to TODAY'S DATE above yourself as a sanity check, and if it has clearly already passed, mention that plainly in "recommendation_summary" as well (this will also be verified independently in code).
11. CITATION ACCURACY RULE: Copy statute numbers, section letters/numbers, and dollar figures character-for-character from the RFP text. Never approximate, round, or reconstruct them from memory of similar documents.
12. PAGE CITATION RULE: The RFP text below likely contains literal page-footer markers such as "Page 5 of 21" (the total page count varies by document) printed at the bottom of every page — this is real text extracted from the PDF, not something you need to guess. Scan the document for whatever that exact footer pattern is in THIS RFP before relying on it. For every "reason" field anywhere in your output (deliverables_checklist, financial_checklist, legal_checklist, operations_checklist, technical_checklist):
    a. Find the specific sentence in the RFP text that supports your claim.
    b. Scan FORWARD from that sentence to the next "Page N of M" (or similar) footer marker that appears after it — that marker tells you which page the sentence is printed on (the marker appears at the END of the page it belongs to, since it's a footer).
    c. Prefix the reason with "Page N, " followed by the section reference and a colon, e.g. "Page 5, Exhibit B Section B.2: ..." or "Page 13, Section XI.B.2: ...".
    d. If the content appears before the very first page marker in the text (e.g. cover page content), use "Page 1" for the cover page.
    e. If you genuinely cannot locate any nearby page marker, use "Page unknown, Section X.Y:" — but still include whatever section reference you did find. Never drop the section reference just because the page is uncertain, and never fabricate a page number you didn't actually locate via a marker.
13. Output ONLY valid JSON. No markdown. No trailing commas. No commentary.

COMPANY STRENGTHS: ${strengths || '(not provided)'}
COMPANY GAPS: ${gaps || '(not provided)'}

RETURN THIS EXACT JSON STRUCTURE — every value below is a FAKE placeholder to show you the shape only. Replace ALL of them with real data found in the RFP text, following the anti-hallucination rule above:
{
  "fit_score": 0,
  "recommendation": "CAUTION",
  "recommendation_summary": "<write 2-3 sentences using only facts you actually found in the text below>",
  "deadline_date_iso": "<YYYY-MM-DD found in the RFP, or null if not found>",

  "deliverables_checklist": [
    {
      "category": "<a logical group name you choose, e.g. Proposal Submission Documents>",
      "due_date": "<deadline for this group as stated in the RFP, or N/A>",
      "items": [
        {
          "item": "<name of the specific document/form/attachment>",
          "mandatory": "YES",
          "decision": "ACTION REQUIRED",
          "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
        }
      ]
    }
  ],

  "insurance_figures": [
    {
      "coverage_type": "<e.g. Workers Compensation, Commercial General Liability, Cyber Liability Tier 1>",
      "amount": null,
      "is_statutory": false,
      "basis": "<per occurrence / aggregate / combined single limit / range — exactly as the RFP states it, or 'not specified'>",
      "applies_to_this_contract": true,
      "tier_note": "<if this is a tiered coverage, explain why this tier does/doesn't match this engagement's data sensitivity; otherwise 'Not tiered — applies as stated'>"
    }
  ],

  "financial_checklist": [
    {
      "item": "Payment Terms",
      "question": "What do the RFP's payment terms actually say, and to which party do they apply?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Financial Stability Requirements",
      "question": "Does RFP require financial statements or proof of financial stability?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Unaudited Financial Statements",
      "question": "Are unaudited financial statements acceptable?",
      "answer": "N/A",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — start with Page N, Section X.Y: if it exists in the text below, otherwise write exactly 'Not explicitly stated in RFP — verify manually'>"
    },
    {
      "item": "Profitability Analysis",
      "question": "Can expected revenue cover projected costs based on RFP pricing structure?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Bid Bond",
      "question": "Is a bid bond / proposal bond required?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    }
  ],

  "legal_checklist": [
    {
      "item": "Relevant Experience",
      "question": "Does RFP require relevant experience?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Registration Requirement",
      "question": "Is company registration required (eVA, SEC, or state)?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Financial Statement of Previous Year",
      "question": "Is previous year financial statement required?",
      "answer": "NO",
      "decision": "GO",
      "reason": "<verify — start with Page N, Section X.Y: if it exists in the text below, otherwise write exactly 'Not explicitly stated in RFP — verify manually'>"
    },
    {
      "item": "Qualified Personnel",
      "question": "Does RFP specify qualified personnel requirements?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Technical Knowhow",
      "question": "Does RFP require specific technical expertise?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Expected Revenue Generation",
      "question": "Is contract value or expected revenue estimable from pricing schedule?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Period of Implementation",
      "question": "Is implementation period or contract duration defined?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Insurance Coverage",
      "question": "Are all required insurance coverages stated in Exhibit B?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — list the coverage TYPES only here; put dollar figures in insurance_figures instead>"
    },
    {
      "item": "Compliance of Law",
      "question": "Does RFP require compliance with applicable laws and regulations?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Compliance Requirements (Data Protection)",
      "question": "Are FERPA, HIPAA, GLBA, PCI-DSS or other data protection requirements mentioned?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "State Registration",
      "question": "Is registration in the state (Virginia/eVA/SEC) required?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "E-Verify",
      "question": "Does RFP require use of E-Verify system? Check Exhibit A carefully.",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with Page N, Exhibit A Section S: followed by the EXACT Virginia Code section number as written in the RFP text below, do not recall from memory>"
    },
    {
      "item": "Contractual Obligations",
      "question": "Are termination clauses, liability limits, and dispute resolution defined?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    }
  ],

  "operations_checklist": [
    {
      "item": "Insurance Requirement Form",
      "question": "Is a certificate of insurance or insurance form required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Information Form (Tax ID, Owner Name, Ownership %)",
      "question": "Is a company information form with Tax ID required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Small Business (SWAM)",
      "question": "Is Small Business (SWAM) certification required or evaluated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "MBE Certification",
      "question": "Is MBE / minority business certification required or evaluated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Workers Comp Insurance",
      "question": "Is Workers Compensation Insurance required? Check Exhibit B.",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Business with Iran",
      "question": "Is a declaration regarding business with Iran required?",
      "answer": "NO",
      "decision": "GO",
      "reason": "<verify — start with Page N, Section X.Y: if applicable, otherwise write exactly 'Not explicitly stated in RFP — verify manually'>"
    },
    {
      "item": "Submission Deadlines",
      "question": "Are submission deadlines clearly stated?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with Page N, [Cover Page or Section X.Y]: followed by the exact date and time as written in the RFP text below>"
    },
    {
      "item": "Document Compliance",
      "question": "Are formatting and submission requirements defined?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Signatory Authority",
      "question": "Is an authorized signatory required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Vendor Registration",
      "question": "Is vendor registration (eVA) required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    }
  ],

  "technical_checklist": [
    {
      "item": "Scope of Services Alignment",
      "question": "Does RFP scope align with company services and capabilities?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Technical Requirements",
      "question": "Do technical specs (Drupal, APIs, AI search) match company capabilities?",
      "answer": "YES",
      "decision": "GO",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Compliance with Industry Standards",
      "question": "Does RFP require WCAG, Section 508, NIST or other industry standards?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Security Considerations",
      "question": "Are security requirements (encryption, access controls, data protection) stated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    },
    {
      "item": "Integration Needs",
      "question": "Does project require system integrations (Drupal, APIs)?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "<verify — must start with the exact format Page N, Section X.Y: using a real page and section found in the text below>"
    }
  ],

  "disqualifiers": [
    "<list only TRUE hard disqualifiers found explicitly in the text below, or leave this array empty>"
  ]
}

IMPORTANT: The JSON above shows the SHAPE of the answer only. Every "reason", quote, number, and citation must be replaced with something you actually verified in the RFP text below. If you did not find real support for a field, use "Not explicitly stated in RFP — verify manually" rather than filling in something plausible-sounding.

For deliverables_checklist: Use a TWO-LEVEL parent-child structure.
- "category" = a logical group name (e.g. "Proposal Submission Documents", "Required Attachments & Forms", "Technical & Narrative Sections", "SWAM & Compliance Documents")
- "due_date" = the deadline for that group (usually the main RFP deadline)
- "items" = array of individual deliverable items under that category
- Extract EVERY document, form, attachment (Attachment A, B, C, D, W-9, SWAM Plans, pricing pages, signed cover sheet, narrative sections, etc.) that the RFP requires the bidder to submit.
- For each item: mandatory YES/NO, decision ACTION REQUIRED or OPTIONAL, reason with exact RFP section.

RFP FULL TEXT (read every word including all Exhibits):
"""
${truncated}
"""`;
}

// --- Merged prompt builder (FIXED) ---
// Builds a single prompt covering MULTIPLE documents belonging to the same
// RFP opportunity. Every document is wrapped in clear START/END markers so
// the model can reliably tag each finding with the exact source filename
// via the required "source_document" field.
//
// IMPORTANT: this carries the SAME full checklist scaffold as the
// single-document buildPrompt (all ~30 named Financial/Legal/Operations/
// Technical items) so merged analyses are just as thorough as single-doc
// ones — the earlier version only gave Gemini one example item per section
// and a "same shape" note, which caused it to invent far fewer items than
// it should. Every example value below is a FAKE placeholder (per the
// anti-hallucination rule) and every item now also carries "source_document".
function buildMergedPrompt(documents, strengths, gaps) {
  const CHAR_LIMIT_PER_DOC = 200000;
  let combinedText = '';
  documents.forEach((d, i) => {
    const name = d.filename || `Document ${i + 1}`;
    let text = d.text || '';
    if (text.length > CHAR_LIMIT_PER_DOC) {
      console.warn(`[WARN] "${name}" truncated from ${text.length} to ${CHAR_LIMIT_PER_DOC} characters.`);
      text = text.slice(0, CHAR_LIMIT_PER_DOC) + '\n[TRUNCATED]';
    }
    combinedText += `\n\n===== DOCUMENT START: "${name}" =====\n${text}\n===== DOCUMENT END: "${name}" =====\n`;
  });

  const todayIso = new Date().toISOString().slice(0, 10);

  return `You are a senior proposal/bid analyst. You have been given MULTIPLE documents belonging to the SAME RFP opportunity (e.g. the main RFP, a pre-bid conference form, an addendum, separately-issued exhibits). Each document below is wrapped in ===== DOCUMENT START: "<filename>" ===== / ===== DOCUMENT END ===== markers showing its exact filename.

Produce ONE COMBINED analysis across ALL documents together — do NOT produce separate results per document. Merge deliverables, checklists, and insurance figures into single unified lists. For EVERY finding, you MUST include a "source_document" field with the EXACT filename (copied from the DOCUMENT START marker) it came from, so every fact can be traced back to its file. If the same requirement appears in more than one document, tag it with whichever document states it most explicitly, and you may add a note in "tier_note"/"reason" if documents conflict.

Read EVERY document below in full, including all Exhibits and Attachments in each one. Do not skip any document just because another one looks more important — required forms, deadlines, and disqualifiers can appear in any of them.

TODAY'S DATE: ${todayIso}

===========================================================================
CRITICAL ANTI-HALLUCINATION RULE — READ THIS BEFORE ANYTHING ELSE:
The JSON template shown further below is a STRUCTURAL example only. Every
specific number, section letter, statute citation, dollar figure, or quoted
phrase inside that example is FAKE and must NEVER be reused, adapted,
paraphrased, or echoed in your real answer, even if it happens to sound
plausible for this RFP. Before writing any "reason" field:
  1. Search the actual document text below for a sentence that supports the claim.
  2. Copy the section number and figures from THAT sentence, character for
     character — do not round, approximate, or reconstruct from memory.
  3. If you cannot find a specific supporting sentence, write exactly:
     "Not explicitly stated in RFP — verify manually."
Reusing an example's wording or numbers when the source text says something
different (or says nothing) is a serious error. When in doubt, quote less
and say "verify manually" more.
===========================================================================

STRICT RULES:
1. Read EVERY section of every document including all Exhibits before answering.
2. answer must be "YES", "NO", or "N/A" — based ONLY on what is actually written in the documents.
3. reason must quote the EXACT page number AND section number, in the format "Page N, Section X.Y: <specific text/numbers from the document>". See the PAGE CITATION RULE below. Never say "Not mentioned" if it appears in an exhibit. If it genuinely doesn't appear anywhere, say "Not explicitly stated in RFP — verify manually," never invent a plausible-sounding citation.
4. Every item in deliverables_checklist, financial_checklist, legal_checklist, operations_checklist, and technical_checklist MUST include "source_document" set to the exact filename (from the DOCUMENT START marker) that the reason/citation actually came from.
5. PAYMENT TERMS RULE: Search for NET30, "30 days," or similar payment-timing language. Report exactly what the text says, including which party it applies to. Do not assume it applies to the buyer's payments unless stated explicitly for that direction.
6. INSURANCE EXTRACTION RULE: Find every insurance coverage type and dollar figure stated anywhere across the documents. For EACH one, add an entry to "insurance_figures": { "coverage_type": "...", "amount": <number, no $ or commas, or null if statutory/no-fixed-amount>, "is_statutory": <true if "statutory limits" with no dollar figure, else false>, "basis": "per occurrence / aggregate / combined single limit / range — exactly as stated, or 'not specified'", "applies_to_this_contract": <true/false>, "tier_note": "<short explanation>", "source_document": "<exact filename>" }.
   TIERED COVERAGE HANDLING: If multiple risk TIERS are defined where only ONE applies to this contract, mark "applies_to_this_contract": true on the ONE tier that matches this engagement's actual data sensitivity, false on the others, with a tier_note explaining why. If you cannot confidently determine which tier applies, mark all tiers false and note "Tier applicability could not be determined from RFP text — requires manual review with the contracting officer." Do not invent splits the text doesn't give you. Do not calculate GO/NO-GO yourself — the threshold comparison is done in code afterward.
7. E-VERIFY RULE: Search every document carefully for E-Verify requirements. Quote the exact statute/code section number as written — do not recall from memory of similar clauses elsewhere.
8. WORKERS COMP RULE: Search every document's insurance section carefully.
9. DELIVERABLES RULE: Extract every concrete deliverable, document, form, attachment, or submission item ANY of the documents requires the bidder to submit. Include due dates where stated. For EVERY child item's "reason" field, start with "Page N, Section X.Y:" followed by a short paraphrase of what that section actually requires. Never omit the page number — a reader must be able to flip straight to that physical page and find the requirement.
   YOU MUST SPLIT DELIVERABLES INTO AT LEAST 3-5 SEPARATE CATEGORIES. Do NOT place every deliverable under one giant category. Group by document TYPE, not by due date. Use categories like (adapt to what the documents actually contain):
     - "Cover Sheet & Signature Documents"
     - "Required Attachments & Forms"
     - "SWAM / Diversity Compliance Documents"
     - "Written Narrative & Technical Response Sections"
     - "Pricing & Cost Submission"
     - "Post-Award Deliverables" (if applicable)
   If a category would end up with more than 6-7 items, split it further. A single category holding most or all of the deliverables is treated as an error.
10. fit_score 0-100. "GO" if >=70, "NO-GO" if <40, "CAUTION" otherwise. Independent of the deadline check below.
11. DEADLINE RULE (multi-document): Identify the REAL final RFP submission deadline — not a pre-bid conference RSVP date, not a Q&A cutoff, not a form-response date. If one document looks like an early-stage form (e.g. a pre-bid response form) rather than the main RFP itself, say so plainly in "recommendation_summary" so the reader understands why an individual document's date may look expired even if the real opportunity is still open. Convert the real deadline to ISO format YYYY-MM-DD in "deadline_date_iso", or null if no clear date is stated anywhere. Compare it to TODAY'S DATE yourself as a sanity check (this will also be verified independently in code).
12. CITATION ACCURACY RULE: Copy statute numbers, section letters/numbers, and dollar figures character-for-character. Never approximate, round, or reconstruct from memory.
13. PAGE CITATION RULE: Documents likely contain literal page-footer markers such as "Page 5 of 21" — real text extracted from the file. For every "reason" field:
    a. Find the specific sentence that supports your claim, and note WHICH document it's in.
    b. Scan FORWARD from that sentence to the next "Page N of M" footer marker in THAT SAME document.
    c. Prefix the reason with "Page N, " followed by the section reference and a colon.
    d. If content appears before the first page marker (e.g. cover page), use "Page 1".
    e. If no nearby page marker exists, use "Page unknown, Section X.Y:" — never fabricate a page number, and never drop the section reference just because the page is uncertain.
14. If the same requirement or fact is stated differently across two documents (a conflict), keep both, note the conflict explicitly in the "reason" text, and set "source_document" to the more authoritative/detailed document (or list both filenames separated by " / " if genuinely both matter).
15. Output ONLY valid JSON. No markdown. No trailing commas. No commentary.

COMPANY STRENGTHS: ${strengths || '(not provided)'}
COMPANY GAPS: ${gaps || '(not provided)'}

RETURN THIS EXACT JSON STRUCTURE — every value below is a FAKE placeholder to show you the shape only. Replace ALL of them with real data found in the documents below, following the anti-hallucination rule above. Every item array below must be populated as fully as the documents support — do not stop at one or two items per section if more standard items apply; check EVERY item listed and only omit ones that are genuinely not covered by any document (in which case still include the item with answer "N/A" and reason "Not explicitly stated in RFP — verify manually."):
{
  "fit_score": 0,
  "recommendation": "CAUTION",
  "recommendation_summary": "<2-3 sentences using only facts you actually found in the documents below>",
  "deadline_date_iso": "<YYYY-MM-DD found in the documents, or null if not found>",

  "deliverables_checklist": [
    {
      "category": "<a logical group name you choose>",
      "due_date": "<deadline for this group as stated, or N/A>",
      "items": [
        { "item": "<name of the specific document/form/attachment>", "mandatory": "YES", "decision": "ACTION REQUIRED", "reason": "<verify — Page N, Section X.Y: ...>", "source_document": "<exact filename>" }
      ]
    }
  ],

  "insurance_figures": [
    { "coverage_type": "<e.g. Workers Compensation, Commercial General Liability, Cyber Liability Tier 1>", "amount": null, "is_statutory": false, "basis": "<per occurrence / aggregate / combined single limit / range, or 'not specified'>", "applies_to_this_contract": true, "tier_note": "<explanation, or 'Not tiered — applies as stated'>", "source_document": "<exact filename>" }
  ],

  "financial_checklist": [
    { "item": "Payment Terms", "question": "What do the payment terms actually say, and to which party do they apply?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Financial Stability Requirements", "question": "Is proof of financial stability required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Unaudited Financial Statements", "question": "Are unaudited financial statements acceptable?", "answer": "N/A", "decision": "NEEDS REVIEW", "reason": "<verify or 'Not explicitly stated in RFP — verify manually'>", "source_document": "<exact filename>" },
    { "item": "Profitability Analysis", "question": "Can expected revenue cover projected costs based on the pricing structure?", "answer": "YES", "decision": "GO", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Bid Bond", "question": "Is a bid bond / proposal bond required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Electronic Funds Transfer (EFT) Registration", "question": "Is EFT registration mandatory?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Invoicing / Billing Terms", "question": "What are the stated invoicing requirements and timelines?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" }
  ],

  "legal_checklist": [
    { "item": "Relevant Experience", "question": "Is relevant experience required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Registration Requirement", "question": "Is company registration required (state/eVA/SEC/etc.)?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Financial Statement of Previous Year", "question": "Is a previous year financial statement required?", "answer": "NO", "decision": "GO", "reason": "<verify or 'Not explicitly stated in RFP — verify manually'>", "source_document": "<exact filename>" },
    { "item": "Qualified Personnel", "question": "Are qualified personnel requirements specified?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Technical Knowhow", "question": "Is specific technical expertise required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Expected Revenue Generation", "question": "Is contract value or expected revenue estimable from the pricing schedule?", "answer": "YES", "decision": "GO", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Period of Implementation", "question": "Is the implementation period or contract duration defined?", "answer": "YES", "decision": "GO", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Insurance Coverage", "question": "Are required insurance coverages stated?", "answer": "YES", "decision": "GO", "reason": "<verify — list coverage TYPES only here; dollar figures go in insurance_figures>", "source_document": "<exact filename>" },
    { "item": "Compliance of Law", "question": "Is compliance with applicable laws and regulations required?", "answer": "YES", "decision": "GO", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Compliance Requirements (Data Protection)", "question": "Are FERPA, HIPAA, GLBA, PCI-DSS or other data protection requirements mentioned?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "State Registration", "question": "Is state-level registration required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "E-Verify", "question": "Is use of the E-Verify system required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify — the EXACT statute/code section as written, do not recall from memory>", "source_document": "<exact filename>" },
    { "item": "Contractual Obligations", "question": "Are termination clauses, liability limits, and dispute resolution defined?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Bid/Proposal Irrevocability Period", "question": "How long must the bid remain valid and irrevocable?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Document Retention Period", "question": "How long must the contractor retain contract-related records?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" }
  ],

  "operations_checklist": [
    { "item": "Insurance Requirement Form", "question": "Is a certificate of insurance or insurance form required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Information Form (Tax ID, Owner Name, Ownership %)", "question": "Is a company information form with Tax ID required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Small Business (SWAM)", "question": "Is Small Business (SWAM) certification required or evaluated?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "MBE Certification", "question": "Is MBE / minority business certification required or evaluated?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Workers Comp Insurance", "question": "Is Workers Compensation Insurance required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Business with Iran / Restricted Entities Declaration", "question": "Is a declaration regarding business with restricted countries/entities required?", "answer": "NO", "decision": "GO", "reason": "<verify or 'Not explicitly stated in RFP — verify manually'>", "source_document": "<exact filename>" },
    { "item": "Submission Deadlines", "question": "Are submission deadlines clearly stated?", "answer": "YES", "decision": "GO", "reason": "<verify — exact date and time as written>", "source_document": "<exact filename>" },
    { "item": "Document Compliance", "question": "Are formatting and submission requirements defined?", "answer": "YES", "decision": "GO", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Signatory Authority", "question": "Is an authorized signatory required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Vendor Registration", "question": "Is vendor registration (e.g. eVA or equivalent) required?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "source_document": "<exact filename>" }
  ],

  "technical_checklist": [
    { "item": "Scope of Services Alignment", "question": "Does the scope align with typical vendor services and capabilities?", "answer": "YES", "decision": "GO", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Technical Requirements", "question": "Do the technical specs match standard vendor capabilities?", "answer": "YES", "decision": "GO", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Manufacturer / Reseller Authorization", "question": "Is the bidder required to be an authorized reseller or hold a manufacturer authorization letter?", "answer": "YES", "decision": "ACTION REQUIRED", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Compliance with Industry Standards", "question": "Are WCAG, Section 508, NIST or other industry standards required?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Security Considerations", "question": "Are security requirements (encryption, access controls, data protection) stated?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" },
    { "item": "Integration Needs", "question": "Does the project require system integrations (APIs, SSO, etc.)?", "answer": "YES", "decision": "NEEDS REVIEW", "reason": "<verify>", "source_document": "<exact filename>" }
  ],

  "disqualifiers": [
    "<list only TRUE hard disqualifiers found explicitly in the documents below, with a Page/Section citation, or leave this array empty>"
  ]
}

IMPORTANT: The JSON above shows the SHAPE and the STANDARD ITEM SET only. Every "reason", quote, number, and citation must be replaced with something you actually verified in the documents below. Populate every checklist item listed above by actually checking the documents for it — use "N/A" / "Not explicitly stated in RFP — verify manually" ONLY when a standard item is genuinely absent from every document, never skip an item entirely. You may ADD additional items beyond this list if the documents contain other important requirements not covered above.

For deliverables_checklist: Use a TWO-LEVEL parent-child structure exactly as shown — "category" groups, each containing an "items" array. Extract EVERY document, form, attachment (numbered/lettered attachments, W-9, SWAM plans, pricing pages, signed cover sheet, narrative sections, post-award deliverables, etc.) that ANY of the documents requires the bidder to submit, tagged with which document it came from.

DOCUMENTS (read every word, including all exhibits, in every document):
"""
${combinedText}
"""`;
}

async function callGemini(prompt) {
  // gemini-2.5-flash was deprecated ahead of schedule; Google's current
  // recommended replacement is gemini-3.5-flash (GA since May 19, 2026).
  // Configurable via .env in case Google deprecates this one too later —
  // no code change needed, just update GEMINI_MODEL.
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  // Retry on transient "model overloaded" (503) or rate-limit (429) errors.
  // These are momentary capacity spikes on Google's side, not real failures —
  // retrying with a short backoff usually succeeds within a few seconds
  // instead of surfacing an error to the user for something that self-resolves.
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1500; // 1.5s, 3s, 6s

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
          }
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        let msg = `Gemini API error (HTTP ${resp.status})`;
        try {
          const j = JSON.parse(errText);
          msg = j.error?.message || msg;
        } catch (e) { /* ignore parse failure, use default msg */ }

        const isTransient = resp.status === 503 || resp.status === 429;
        if (isTransient && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[WARN] Gemini transient error (HTTP ${resp.status}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(msg);
      }

      const json = await resp.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini. Try again.');

      let cleaned = text.trim();
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');

      try {
        return JSON.parse(cleaned);
      } catch (e) {
        throw new Error('Gemini returned malformed JSON. Try analyzing again.');
      }
    } catch (err) {
      lastErr = err;
      // Non-transient errors (bad JSON, empty response, network failure) still
      // get one retry each since these can also be momentary, but don't loop
      // forever on a genuinely broken request.
      if (attempt < MAX_RETRIES && /overloaded|UNAVAILABLE|fetch failed/i.test(err.message || '')) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[WARN] Gemini call failed (${err.message}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

app.listen(PORT, () => {
  console.log(`RFP Intelligence backend running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Gemini model: ${process.env.GEMINI_MODEL || 'gemini-3.5-flash'} (set GEMINI_MODEL in .env to change)`);
  console.log(`Insurance threshold: $${INSURANCE_THRESHOLD.toLocaleString()} (set INSURANCE_THRESHOLD in .env to change)`);
});
