'use strict';
// Friendly setup: asks a few questions and writes the .env settings file for you.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(String(a || '').trim())));

(async () => {
  console.log('\n==============================================');
  console.log('   ClassMind setup  (this takes about 2 minutes)');
  console.log('==============================================\n');

  const ff = spawnSync('ffmpeg', ['-version'], { shell: true });
  if (ff.status !== 0) console.log('NOTE: ffmpeg was not found. Close this window, open a new one, and try again.\n      (If it still fails, videos cannot be read.)\n');

  console.log('STEP 1 of 3: Your Gmail, so the app can email you codes and alerts.');
  console.log('  (You need a Gmail "App password" for this. If you do not have one yet, close');
  console.log('   this window, create it first, then double-click SETUP-AND-START.bat again.)\n');
  const email = await ask('  Type your Gmail address and press Enter: ');
  const pass = (await ask('  Paste your 16-letter App password and press Enter: ')).replace(/\s+/g, '');

  console.log('\nSTEP 2 of 3: Speech-to-text key from assemblyai.com');
  console.log('  This makes every video get its OWN real transcript.');
  const aai = await ask('  Paste the key and press Enter (or just press Enter to skip): ');

  console.log('\nSTEP 3 of 3: AI key from console.anthropic.com');
  console.log('  This writes the summary, quiz and flashcards.');
  const ant = await ask('  Paste the key and press Enter (or just press Enter to skip): ');
  rl.close();

  const file = path.join(__dirname, '.env');
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.old');
  const lines = [
    'PORT=3000',
    'SESSION_SECRET=' + crypto.randomBytes(32).toString('hex'),
    'COOKIE_SECURE=0',
    '',
    'SMTP_HOST=' + (email ? 'smtp.gmail.com' : ''),
    'SMTP_PORT=465',
    'SMTP_USER=' + email,
    'SMTP_PASS=' + pass,
    'MAIL_FROM=ClassMind <' + email + '>',
    '',
    'ASSEMBLYAI_API_KEY=' + aai,
    'ANTHROPIC_API_KEY=' + ant,
    'ANTHROPIC_MODEL=claude-sonnet-5-5',
    '',
    'MAX_UPLOAD_MB=2048',
    'CONCURRENCY=2',
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'));

  console.log('\nSaved your settings.');
  console.log(email && pass ? '  Email: ON  (codes and alerts will be emailed to the address each person signs up with)' : '  Email: OFF (you skipped it)');
  console.log(aai ? '  Real transcripts: ON' : '  Real transcripts: OFF (every video will fail until you add the key)');
  console.log(ant ? '  AI summary and quiz: ON' : '  AI summary and quiz: OFF');
  console.log('\nStarting the app now...\n');
})();
