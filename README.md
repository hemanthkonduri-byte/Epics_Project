# Epics

Full project: website + backend. Accounts with email verification, video upload with a word-for-word
speaker-labelled transcript, summary, 15-question quiz, flashcards, task alerts by email, "Ask AI",
and live meetings with a shared speaker-labelled transcript. No npm packages needed.

## Easiest way on Windows
1. Unzip, open the `epics` folder.
2. Double-click `SETUP-AND-START.bat` the first time. It asks for your Gmail address, Gmail App password and (optionally) the two API keys, writes the settings file for you, and starts the app.
3. Next time, double-click `START-APP.bat`.

## Requirements
- Node.js 22.5 or newer (https://nodejs.org)
- ffmpeg on PATH (Windows: `winget install ffmpeg`; Mac: `brew install ffmpeg`)

## Run it (demo mode, no keys)
    npm run demo
Open http://localhost:3000. Sign up; the 6-digit code is shown in the page (development only).
Demo mode returns the built-in sample transcript for any upload.

## Real mode
1. Copy `.env.example` to `.env` and fill in:
   - `SESSION_SECRET` long random text
   - `ASSEMBLYAI_API_KEY` speech-to-text with speaker labels
   - `ANTHROPIC_API_KEY` summary, quiz, flashcards, tasks, Ask AI
   - Real emails for codes and alerts, choose one:
     - **Gmail (easiest):** turn on 2-Step Verification, create an App password at https://myaccount.google.com/apppasswords, then set
       `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=you@gmail.com`, `SMTP_PASS=<16-letter app password>`,
       `MAIL_FROM=ClassMind <you@gmail.com>`. Restart the server. Codes and task alerts then arrive in the real inbox.
     - **Resend:** `RESEND_API_KEY` and `MAIL_FROM` (needs a verified domain to email other people).
     When email is configured, the code is no longer shown on the page.
2. `npm start`

## Live meetings (built)
- Hosts start a room and share the 6-character code; participants join with it. Any number can join
  (limited only by your server).
- Every person's browser (Chrome or Edge) transcribes their own microphone and sends each sentence to
  the room, so everyone sees `[time] Name (CM-123456): exact words`. Transcripts are saved in the database.
- Host controls: lock or unlock the room, remove a person, end for all. Participants: raise hand, mic on/off, leave.
- NOT built: live audio and video. That needs a WebRTC media server such as LiveKit (next step).

## Going live
- Use HTTPS and set `COOKIE_SECURE=1`, `TRUST_PROXY=1`. Data is in `data/app.db` (SQLite); back it up.
- Uploaded videos are deleted after processing; transcripts are kept.

## Security built in
scrypt password hashing, httpOnly session cookie, rate limits, wrong-code lockout, CSRF header check,
upload limits, security headers, escaped output.

## Not tested yet
The AssemblyAI, Anthropic and Resend connections (no keys were available when built). Try a short video first.

## Push to GitHub
    cd epics
    git init
    git add .
    git commit -m "Initial commit: Epics"
    git branch -M main
    git remote add origin https://github.com/YOUR-USERNAME/epics.git
    git push -u origin main
(Create an empty repository named `epics` on github.com first. `.env` and `data/` are git-ignored.)
