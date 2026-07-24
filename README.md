<div align="center">

# 🧠 SPS RFP Intelligence Portal

### AI-powered RFP analyzer that turns a 40-page bid document into a 30-second Go/No-Go verdict.

<p>
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white" />
  <img src="https://img.shields.io/badge/Google_Gemini-API-4285F4?style=for-the-badge&logo=google&logoColor=white" />
  <img src="https://img.shields.io/badge/License-Educational-blue?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Status-Active-success?style=for-the-badge" />
</p>

**Upload → Extract → Analyze → Decide.**
Every answer grounded in an exact quote from the source document. No hallucinated compliance.

</div>

---

## 📖 Table of Contents

- [Why This Exists](#-why-this-exists)
- [Features](#-features)
- [Tech Stack](#️-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [How It Works](#-how-it-works)
- [Security](#-security-notes)
- [Documentation](#-documentation)
- [License](#-license)

---

## 💡 Why This Exists

Reading a full RFP by hand — cross-referencing exhibits, hunting for the insurance clause buried on page 34, double-checking payment terms — is slow and error-prone. The RFP Intelligence Portal reads the *entire* document, including every exhibit and attachment, and hands back a structured, quote-backed compliance breakdown so your team can spend time deciding, not searching.

---

## ✨ Features

| | |
|---|---|
| 📄 **Multi-format upload** | PDF, DOCX, and TXT — parsed entirely server-side |
| ✅ **Row-by-row compliance checklist** | Financial, Legal, Operations, and Technical sections, each answered `YES` / `NO` / `N/A` with the exact RFP clause cited as evidence |
| 🚦 **Go / Caution / No-Go verdict** | A single fit score (0–100) with a plain-English recommendation summary |
| 📋 **Deliverables tracker** | Every required form, submission, and attachment, with due dates |
| ⚖️ **Automated business rules** | e.g. payment terms flagged if longer than NET30, insurance flagged if any single coverage exceeds $5M |
| 🕓 **Analysis history** | Past analyses saved locally in-browser for quick recall |
| 🖨️ **Print / export to PDF** | Clean, shareable checklist report |
| 🔒 **Secure by design** | API key stays server-side, files processed in memory only, never written to disk |

---

## 🛠️ Tech Stack

<div align="center">

| Layer | Technology |
|:---|:---|
| **Backend** | Node.js · Express |
| **AI Engine** | Google Gemini API |
| **Uploads** | Multer (in-memory) · custom PDF/DOCX text extraction |
| **Security** | express-rate-limit · dotenv · CORS |
| **Frontend** | HTML · CSS · vanilla JavaScript |

</div>

---

## 📁 Project Structure

```
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
```

---

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
```
http://localhost:3001
```

---

## 🔍 How It Works

```
 1. Upload      →  drag in a PDF, DOCX, or TXT RFP (up to 15MB)
 2. Extract     →  backend parses the document server-side into plain text
 3. Analyze     →  extracted text + your company's strengths/gaps sent to
                    Gemini via a structured, strict, quote-based prompt
 4. Review      →  sortable checklist tables: Deliverables, Financial,
                    Legal, Operations, Technical — plus overall fit score
 5. Export      →  print or save the final checklist as a PDF
```

---

## 🔐 Security Notes

- 🔑 The Gemini API key is **never** exposed to the browser — all AI calls are proxied through the Express backend
- 🧹 Uploaded files are held in memory only and discarded after each request — nothing touches disk
- ⏱️ Requests are rate-limited (30 requests / 15 minutes per IP) to protect your API quota
- 🙈 `.env` is excluded via `.gitignore` — never commit real API keys

---

## 📄 Documentation

The full **Software Requirements Specification** (IEEE 830 format) lives in [`docs/`](./docs), covering functional requirements, system architecture, and design constraints in detail.

---

## 📜 License

This project is provided for **educational purposes**.

<div align="center">

Made with ☕ and a strict "cite your sources" prompt.

</div>
