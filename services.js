'use strict';
// External services: email, ffmpeg, speech-to-text, AI analysis. Reads settings from process.env at call time.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');

const E = () => process.env;
const demo = () => E().MOCK === '1';
const mailConfigured = () => !!E().RESEND_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Email ---------- */
async function sendMail(to, subject, text) {
  if (!mailConfigured()) {
    console.log(`[mail:dev] to=${to}\nsubject=${subject}\n${text}\n`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + E().RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: E().MAIL_FROM || 'ClassMind <onboarding@resend.dev>', to: [to], subject, text }),
  });
  if (!r.ok) throw new Error('Email provider error ' + r.status);
}

/* ---------- ffmpeg ---------- */
function extractAudio(src, dst) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', dst]);
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg is not installed on the server.' : e.message)));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(/does not contain any stream|Output file does not contain/i.test(err) ? 'This file has no audio track.' : 'Could not read audio from this file.'));
    });
  });
}

/* ---------- Speech to text (utterances: {speaker,start,text}, start in ms) ---------- */
const ts = (ms) => {
  const s = Math.floor(Math.max(0, ms || 0) / 1000), f = (n) => String(n).padStart(2, '0');
  return `${f(Math.floor(s / 3600))}:${f(Math.floor((s % 3600) / 60))}:${f(s % 60)}`;
};

async function transcribe(audioPath) {
  if (demo()) {
    const raw = JSON.parse(await fsp.readFile(path.join(__dirname, 'mock', 'transcript.json'), 'utf8'));
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
      return raw.map((u, i) => ({
        speaker: u.speaker || 'SPK-01',
        name: u.name || ('Speaker ' + (u.speaker || '01')),
        start: Number.isFinite(u.start) ? u.start : i * 15000,
        text: u.text
      }));
    }
    return raw.map((text, i) => ({ speaker: 'SPK-01', name: 'Instructor', start: i * 30000, text }));
  }
  const key = E().ASSEMBLYAI_API_KEY;
  if (!key) throw new Error('No speech-to-text key set. Add ASSEMBLYAI_API_KEY to .env (or start with "npm run demo").');
  const base = 'https://api.assemblyai.com/v2';
  const up = await fetch(base + '/upload', { method: 'POST', headers: { authorization: key, 'content-type': 'application/octet-stream' }, body: await fsp.readFile(audioPath) });
  if (!up.ok) throw new Error('Speech service rejected the upload (' + up.status + ').');
  const { upload_url } = await up.json();
  const cr = await fetch(base + '/transcript', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, speaker_labels: true, language_detection: true }),
  });
  if (!cr.ok) throw new Error('Speech service could not start (' + cr.status + ').');
  const { id } = await cr.json();
  const deadline = Date.now() + (+E().TRANSCRIBE_TIMEOUT_MIN || 120) * 60000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const pr = await fetch(base + '/transcript/' + id, { headers: { authorization: key } });
    if (!pr.ok) throw new Error('Speech service status error (' + pr.status + ').');
    const j = await pr.json();
    if (j.status === 'error') throw new Error('Transcription failed: ' + (j.error || 'unknown error'));
    if (j.status === 'completed') {
      if (Array.isArray(j.utterances) && j.utterances.length) return j.utterances.map((u) => ({ speaker: u.speaker, start: u.start, text: u.text }));
      if (j.text) return [{ speaker: 'A', start: 0, text: j.text }];
      throw new Error('No speech was found in this recording.');
    }
  }
  throw new Error('Transcription took too long.');
}

function shapeTranscript(utt) {
  const ids = new Map();
  const names = new Map();
  const words = new Map();
  const transcript = utt.map((u) => {
    let id = u.speaker;
    if (!id || (!id.startsWith('SPK-') && !id.startsWith('CM-'))) {
      if (!ids.has(u.speaker)) ids.set(u.speaker, 'SPK-' + String(ids.size + 1).padStart(2, '0'));
      id = ids.get(u.speaker);
    }
    const name = u.name || ('Speaker ' + id.replace(/^[^\d]*/, ''));
    names.set(id, name);
    words.set(id, (words.get(id) || 0) + (u.text.match(/\S+/g) || []).length);
    const start = Number.isFinite(u.start) ? u.start : 0;
    return { speaker: id, name, start, timeStr: ts(start), text: u.text };
  });
  const total = [...words.values()].reduce((a, b) => a + b, 0) || 1;
  const speakers = [...words].map(([id, w]) => ({
    id,
    name: names.get(id) || id,
    words: w,
    share: Math.round((w * 100) / total)
  }));
  return { transcript, speakers };
}

/* ---------- Claude ---------- */
async function claude(system, user, maxTokens) {
  const key = E().ANTHROPIC_API_KEY;
  if (!key) throw new Error('No AI key set. Add ANTHROPIC_API_KEY to .env (or start with "npm run demo").');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: E().ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error('AI service error (' + r.status + ').');
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

const asText = (transcript) => transcript.map((l) => `[${l.timeStr || ts(l.start)}] ${l.name ? l.name + ' (' + l.speaker + ')' : l.speaker}: ${l.text}`).join('\n');

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('bad json');
  return JSON.parse(text.slice(a, b + 1));
}
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x, n = 600) => String(x == null ? '' : x).slice(0, n);

function shuffleQuestion(q) {
  const opts = arr(q.options).map((o) => str(o, 200)).slice(0, 4);
  let ans = Number.isInteger(q.answer) ? q.answer : 0;
  if (opts.length < 2 || ans < 0 || ans >= opts.length) return null;
  const idx = opts.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return { q: str(q.q, 400), options: idx.map((i) => opts[i]), answer: idx.indexOf(ans) };
}

function cleanAnalysis(a) {
  const quiz = {};
  for (const lvl of ['Easy', 'Medium', 'Hard']) quiz[lvl] = arr(a.quiz && a.quiz[lvl]).map(shuffleQuestion).filter(Boolean);
  const out = {
    summary: str(a.summary, 4000),
    keyPoints: arr(a.keyPoints).map((x) => str(x)),
    insights: arr(a.insights).map((x) => str(x)),
    tasks: arr(a.tasks).map((t) => ({ task: str(t.task, 300), owner: str(t.owner || 'Everyone', 80), due: str(t.due || 'not specified', 80) })).filter((t) => t.task),
    quiz,
    flashcards: arr(a.flashcards).map((f) => ({ q: str(f.q, 300), a: str(f.a, 500) })).filter((f) => f.q && f.a),
  };
  if (!out.summary || !Object.values(quiz).some((l) => l.length)) throw new Error('bad shape');
  return out;
}

const ANALYZE_SYSTEM = `You are a careful teaching assistant. You receive a timestamped, speaker-labelled transcript of a class or meeting.
Return ONLY one JSON object, no other text, with exactly these keys:
{"summary": string (a clear summary of the whole session, 120-250 words),
 "keyPoints": string[] (5-10 items, include [mm:ss] timestamps where useful),
 "insights": string[] (3-6 deeper takeaways),
 "tasks": [{"task": string, "owner": string (speaker ID or "Everyone"), "due": string (as said, or "not specified")}] (only tasks, homework or deadlines actually spoken; empty array if none),
 "quiz": {"Easy": Q[5], "Medium": Q[5], "Hard": Q[5]},
 "flashcards": [{"q": string, "a": string}] (8-12 items)}
Q = {"q": string, "options": string[3 or 4], "answer": integer index of the correct option}.
Quiz questions must test SUBJECT KNOWLEDGE taught in the session (concepts, facts, reasoning), never who spoke or when. Easy = recall, Medium = understanding, Hard = application or analysis. Use only what the transcript supports. Never invent names; refer to speakers by their IDs.`;

async function analyze(transcript) {
  if (demo()) return cleanAnalysis(JSON.parse(await fsp.readFile(path.join(__dirname, 'mock', 'analysis.json'), 'utf8')));
  const text = asText(transcript).slice(0, 700000);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try { return cleanAnalysis(parseJson(await claude(ANALYZE_SYSTEM, text, 12000))); } catch (e) { lastErr = e; if (/AI service|No AI key/.test(e.message)) throw e; }
  }
  throw new Error('The AI returned an unreadable result. Please try again. (' + lastErr.message + ')');
}

async function ask(transcript, question) {
  if (demo()) {
    const w = (question.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    let best = null, bs = 0;
    for (const l of transcript) { const n = w.filter((x) => l.text.toLowerCase().includes(x)).length; if (n > bs) { bs = n; best = l; } }
    return best ? `${best.speaker} said: ${best.text}` : 'I could not find that in this recording.';
  }
  const sys = 'Answer the question using ONLY the transcript. Name the speaker ID and the [hh:mm:ss] time where it was said. If the transcript does not contain the answer, say so. Be brief.';
  return (await claude(sys, `Transcript:\n${asText(transcript).slice(0, 700000)}\n\nQuestion: ${question}`, 800)).trim();
}

async function processVideo(video, stage) {
  const t0 = Date.now();
  stage('Extracting audio…');
  const audio = video.path + '.mp3';
  try {
    await extractAudio(video.path, audio);
    stage('Transcribing speech and identifying speakers…');
    const { transcript, speakers } = shapeTranscript(await transcribe(audio));
    stage('Writing summary, quiz and tasks…');
    const A = await analyze(transcript);
    return { demo: demo(), seconds: Math.round((Date.now() - t0) / 1000), transcript, speakers, ...A };
  } finally {
    fs.rm(audio, { force: true }, () => {});
  }
}

module.exports = { sendMail, mailConfigured, processVideo, ask, ts };
