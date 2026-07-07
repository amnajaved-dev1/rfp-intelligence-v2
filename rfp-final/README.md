# SPS RFP Intelligence Portal v2.0

## Setup (VS Code)

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Add your Gemini API key
Edit `backend/.env`:
```
GEMINI_API_KEY=YOUR_KEY_HERE
PORT=3001
```

### 3. Run the server
```bash
npm start
```

### 4. Open in browser
http://localhost:3001

## Features
- ✅ Row-by-row YES/NO/REVIEW checklist (Financial, Legal, Operations, Technical)
- ✅ GO/CAUTION/NO-GO verdict with fit score
- ✅ Analysis history (saved in browser)
- ✅ Deliverables, Evaluation Criteria, Risks tabs
- ✅ Print / Export PDF
- ✅ Supports PDF, DOCX, TXT files
