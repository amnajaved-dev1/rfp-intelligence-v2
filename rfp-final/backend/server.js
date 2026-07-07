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
// and return the parsed JSON result to the frontend.
app.post('/api/analyze', async (req, res) => {
  try {
    const { rfpText, strengths, gaps } = req.body;

    if (!rfpText || typeof rfpText !== 'string' || rfpText.trim().length < 200) {
      return res.status(400).json({ error: 'rfpText is missing or too short. Upload a valid RFP document.' });
    }

    const prompt = buildPrompt(rfpText, strengths || '', gaps || '');
    const result = await callGemini(prompt);
    res.json(result);

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(502).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

function buildPrompt(rfpText, strengths, gaps) {
  const truncated = rfpText.length > 60000 ? rfpText.slice(0, 60000) + '\n\n[TRUNCATED]' : rfpText;
  return `You are a senior proposal/bid analyst. Read the ENTIRE RFP document below including ALL Exhibits (Exhibit A, Exhibit B, Exhibit C) and ALL Attachments carefully before answering. Do NOT skip exhibits — they contain critical insurance, legal, and compliance details.

STRICT RULES:
1. Read EVERY section including Exhibit A (General Terms), Exhibit B (Special Terms - Insurance), Exhibit C (Additional Terms - Data/Security) before answering.
2. answer must be "YES", "NO", or "N/A" — based ONLY on what is actually written in the RFP.
3. reason must quote the EXACT section number and specific text/numbers from the RFP (e.g. "Exhibit B Section B.2 requires Workers Compensation with statutory limits"). Never say "Not mentioned" if it appears in exhibits.
4. PAYMENT TERMS RULE: Search for NET30, payment within 30 days, or similar. Decision = "GO" if NET30 or less. Decision = "ESCALATE TO ACCOUNTING" if more than NET30 or unclear.
5. INSURANCE RULE: Find ALL insurance amounts in Exhibit B. Add up or identify the highest required amount. Decision = "GO" if $5M or less total. Decision = "NO-GO" if any single coverage exceeds $5M.
6. E-VERIFY RULE: Search Exhibit A carefully for E-Verify. It is often in sections about employment/immigration.
7. WORKERS COMP RULE: Search Exhibit B Insurance section carefully.
8. DELIVERABLES RULE: Extract every concrete deliverable, document, form, attachment, or submission item the RFP requires the bidder to submit. Include due dates where stated.
9. fit_score 0-100. "GO" if >=70, "NO-GO" if <40, "CAUTION" otherwise.
10. Output ONLY valid JSON. No markdown. No trailing commas. No commentary.

COMPANY STRENGTHS: ${strengths || '(not provided)'}
COMPANY GAPS: ${gaps || '(not provided)'}

RETURN THIS EXACT JSON — fill every field with real RFP data:
{
  "fit_score": 72,
  "recommendation": "GO",
  "recommendation_summary": "2-3 sentence summary referencing specific RFP details",

  "deliverables_checklist": [
    {
      "item": "RFP Cover Sheet (signed)",
      "due_date": "July 7, 2026 by 2:00 PM",
      "mandatory": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "RFP Section XI.B.1 requires return of signed RFP cover sheet"
    }
  ],

  "financial_checklist": [
    {
      "item": "Payment Terms",
      "question": "Is payment plan NET30 or less?",
      "answer": "YES",
      "decision": "GO",
      "reason": "Exhibit A Section EE.1.b states payment shall be made within 30 days (NET30)"
    },
    {
      "item": "Financial Stability Requirements",
      "question": "Does RFP require financial statements or proof of financial stability?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Unaudited Financial Statements",
      "question": "Are unaudited financial statements acceptable?",
      "answer": "N/A",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote or Not mentioned in RFP"
    },
    {
      "item": "Insurance Requirements",
      "question": "What insurance coverages are required and do they total $5M or less?",
      "answer": "YES",
      "decision": "GO",
      "reason": "Exhibit B Section B lists: Workers Comp (statutory), Employers Liability $1M, General Liability $1M, Auto Liability $1M, Cyber Liability $1M-$5M (Tier 1) — all under $5M threshold"
    },
    {
      "item": "Profitability Analysis",
      "question": "Can expected revenue cover projected costs based on RFP pricing structure?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Bid Bond",
      "question": "Is a bid bond / proposal bond required?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    }
  ],

  "legal_checklist": [
    {
      "item": "Relevant Experience",
      "question": "Does RFP require relevant experience?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Registration Requirement",
      "question": "Is company registration required (eVA, SEC, or state)?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Financial Statement of Previous Year",
      "question": "Is previous year financial statement required?",
      "answer": "NO",
      "decision": "GO",
      "reason": "exact quote or Not mentioned in RFP"
    },
    {
      "item": "Qualified Personnel",
      "question": "Does RFP specify qualified personnel requirements?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Technical Knowhow",
      "question": "Does RFP require specific technical expertise?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Expected Revenue Generation",
      "question": "Is contract value or expected revenue estimable from pricing schedule?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Period of Implementation",
      "question": "Is implementation period or contract duration defined?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Insurance Coverage",
      "question": "Are all required insurance coverages stated in Exhibit B?",
      "answer": "YES",
      "decision": "GO",
      "reason": "Exhibit B Section B lists Workers Comp, Employers Liability $1M, General Liability $1M, Auto Liability $1M, Cyber Liability tiered"
    },
    {
      "item": "Compliance of Law",
      "question": "Does RFP require compliance with applicable laws and regulations?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Compliance Requirements (Data Protection)",
      "question": "Are FERPA, HIPAA, GLBA, PCI-DSS or other data protection requirements mentioned?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "Exhibit C Section C.2 requires compliance with FERPA, HIPAA, HITECH, GLB, PCI-DSS, ADA, Section 508, NIST 800-171"
    },
    {
      "item": "State Registration",
      "question": "Is registration in the state (Virginia/eVA/SEC) required?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "E-Verify",
      "question": "Does RFP require use of E-Verify system? Check Exhibit A carefully.",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "Exhibit A Section S: employers with more than 50 employees entering contracts over $50,000 must register and participate in E-Verify program"
    },
    {
      "item": "Contractual Obligations",
      "question": "Are termination clauses, liability limits, and dispute resolution defined?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from Exhibit A sections KK and LL"
    }
  ],

  "operations_checklist": [
    {
      "item": "Insurance Requirement Form",
      "question": "Is a certificate of insurance or insurance form required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "Exhibit B Section B.5 requires Certificate of Insurance naming Commonwealth of Virginia and ODU as additional insured"
    },
    {
      "item": "Information Form (Tax ID, Owner Name, Ownership %)",
      "question": "Is a company information form with Tax ID required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "exact quote from RFP — Substitute W-9 Form required per Section XI.B.2"
    },
    {
      "item": "Small Business (MD)",
      "question": "Is Small Business (SWAM) certification required or evaluated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "MBE Certification",
      "question": "Is MBE / minority business certification required or evaluated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Workers Comp Insurance",
      "question": "Is Workers Compensation Insurance required? Check Exhibit B.",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "Exhibit B Section B.1 requires Workers Compensation coverage in compliance with laws of Commonwealth of Virginia with statutory limits"
    },
    {
      "item": "Business with Iran",
      "question": "Is a declaration regarding business with Iran required?",
      "answer": "NO",
      "decision": "GO",
      "reason": "Not mentioned in RFP"
    },
    {
      "item": "Submission Deadlines",
      "question": "Are submission deadlines clearly stated?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact deadline from RFP cover page"
    },
    {
      "item": "Document Compliance",
      "question": "Are formatting and submission requirements defined?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Signatory Authority",
      "question": "Is an authorized signatory required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Vendor Registration",
      "question": "Is vendor registration (eVA) required?",
      "answer": "YES",
      "decision": "ACTION REQUIRED",
      "reason": "exact quote from RFP section I.K"
    }
  ],

  "technical_checklist": [
    {
      "item": "Scope of Services Alignment",
      "question": "Does RFP scope align with company services and capabilities?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Technical Requirements",
      "question": "Do technical specs (Drupal, APIs, AI search) match company capabilities?",
      "answer": "YES",
      "decision": "GO",
      "reason": "exact quote from RFP section"
    },
    {
      "item": "Compliance with Industry Standards",
      "question": "Does RFP require WCAG, Section 508, NIST or other industry standards?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP — Section IV mentions WCAG 2.1 AA and Section 508; Exhibit C mentions NIST 800-53 and NIST 800-171"
    },
    {
      "item": "Security Considerations",
      "question": "Are security requirements (encryption, access controls, data protection) stated?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "Exhibit C Section G requires encryption per NIST SP 800-53, industry-standard security tools, anti-virus, intrusion detection"
    },
    {
      "item": "Integration Needs",
      "question": "Does project require system integrations (Drupal, APIs)?",
      "answer": "YES",
      "decision": "NEEDS REVIEW",
      "reason": "exact quote from RFP Section IV — Integration and Technical Fit"
    }
  ],

  "disqualifiers": [
    "list only TRUE hard disqualifiers the company cannot overcome, or leave empty array"
  ]
}

IMPORTANT: The JSON above shows EXAMPLE answers. You must replace ALL values with REAL answers found by reading the full RFP text below including every Exhibit and Attachment section.

For deliverables_checklist: Extract EVERY document, form, attachment (Attachment A, B, C, D, W-9, SWAM Plan, pricing pages, cover sheet, etc.) that must be submitted, with due dates.

RFP FULL TEXT (read every word including all Exhibits):
"""
${truncated}
"""`;
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

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
}

app.listen(PORT, () => {
  console.log(`RFP Intelligence backend running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});