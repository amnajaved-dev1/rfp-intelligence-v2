
# 🧠 SPS RFP Intelligence Portal v2.0

**AI-powered RFP analyzer** — upload a bid document, get an instant, evidence-backed Go/No-Go verdict.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![Gemini API](https://img.shields.io/badge/Google_Gemini-API-4285F4?style=for-the-badge&logo=google&logoColor=white)
![License](https://img.shields.io/badge/License-Educational-blue?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Active-success?style=for-the-badge)

Upload a PDF, DOCX, or TXT RFP (Request for Proposal), and the portal reads the *entire* document — including every exhibit and attachment — then returns a structured compliance breakdown: deliverables, financial checklist, legal checklist, evaluation criteria, risks, and a final fit score, all grounded in exact quotes from the source document.

---
## ✨ Features

- 📄 **Multi-format upload** — PDF, DOCX, and TXT supported, parsed entirely server-side
- ✅ **Row-by-row compliance checklist** — Financial, Legal, Operations, and Technical sections, each answered `YES` / `NO` / `N/A` with the exact RFP clause cited as evidence
- 🚦 **Go / Caution / No-Go verdict** — a single fit score (0–100) with a plain-English recommendation summary
- 📋 **Deliverables tracker** — every required form, submission, and attachment the RFP asks for, with due dates
- ⚖️ **Automated business rules** — e.g. payment terms flagged if longer than NET30, insurance requirements flagged if any single coverage exceeds $5M
- 🕓 **Analysis history** — past analyses are saved locally in the browser for quick recall
- 🖨️ **Print / export to PDF** — generate a clean, shareable checklist report
- 🔒 **Secure by design** — the Gemini API key lives only on the backend; the frontend never talks to Google directly, and uploaded files are processed in memory and never written to disk

## 🛠️ Tech Stack

| Layer      | Technology                                  |
|------------|----------------------------------------------|
| Backend    | Node.js, Express                              |
| AI Engine  | Google Gemini API                             |
| Uploads    | Multer (in-memory), custom PDF/DOCX text extraction |
| Security   | express-rate-limit, dotenv, CORS              |
| Frontend   | HTML, CSS, vanilla JavaScript                 |

## 📁 Project Structure
rfp-intelligence-v2/
├── backend/
│   ├── server.js         # Express server, file parsing, Gemini prompt + API calls
│   ├── package.json
│   └── .env               # GEMINI_API_KEY, PORT (not committed)
├── frontend/
│   └── index.html         # Upload UI, checklist tables, history, print/export
├── docs/
│   └── RFP_Intelligence_System_IEEE_830_SRS.docx   # Full Software Requirements Specification
└── README.md

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org) v18 or later
- A [Google Gemini API key](https://ai.google.dev/)

### 1. Clone the repo
```bash
git clone https://github.com/amnajaved-dev1/rfp-intelligence-v2.git
cd rfp-intelligence-v2
```

### 2. Install backend dependencies
```bash
cd backend
npm install
```

### 3. Configure environment variables
Create a `.env` file inside `backend/`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
PORT=3001
```

### 4. Run the server
```bash
npm start
```

### 5. Open the app
http://localhost:3001

## 🔍 How It Works

1. **Upload** — drag in a PDF, DOCX, or TXT RFP file (up to 15MB)
2. **Extract** — the backend parses the document server-side and returns plain text for review
3. **Analyze** — the extracted text, along with your company's stated strengths and gaps, is sent to Gemini using a structured prompt that enforces strict, quote-based answers
4. **Review** — results are rendered as sortable checklist tables across Deliverables, Financial, Legal, Operations, and Technical tabs, plus an overall fit score and recommendation
5. **Export** — print or save the final checklist as a PDF to share with your team

## 🔐 Security Notes

- The Gemini API key is never exposed to the browser — all AI calls are proxied through the Express backend
- Uploaded files are held in memory only and discarded after each request; nothing is written to disk
- Requests are rate-limited (30 requests / 15 minutes per IP) to protect your API quota
- `.env` is excluded via `.gitignore` — never commit real API keys

## 📄 Documentation

The full **Software Requirements Specification** (IEEE 830 format) is available in [`docs/`](./docs), covering functional requirements, system architecture, and design constraints in detail.

## 📜 License

This project is provided for educational purposes.
