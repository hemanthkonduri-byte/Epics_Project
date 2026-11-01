'use strict';
// External services: email, ffmpeg, speech-to-text, AI analysis. Reads settings from process.env at call time.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const tls = require('node:tls');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file */ }

const E = () => process.env;
const demo = () => E().MOCK === '1';
const mailConfigured = () => !!(E().RESEND_API_KEY || E().SMTP_HOST);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/* ---------- SMTP (works with Gmail app passwords, Outlook, any mail account; no packages) ---------- */
async function smtpSend(to, subject, text) {
  const e = E(), host = e.SMTP_HOST, port = +e.SMTP_PORT || 465;
  const fromHdr = e.MAIL_FROM || e.SMTP_USER;
  const fromAddr = (/<([^>]+)>/.exec(fromHdr) || [, fromHdr])[1];
  let sock, buf = '', err = null;
  const waiters = [];
  const pump = () => {
    for (;;) {
      const m = /^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/.exec(buf);
      if (!m || !waiters.length) return;
      buf = buf.slice(m[0].length);
      waiters.shift().resolve(m[0]);
    }
  };
  const fail = (x) => { err = err || x; waiters.splice(0).forEach((w) => w.reject(err)); };
  const attach = (s) => {
    sock = s; buf = '';
    s.setTimeout(20000, () => s.destroy(new Error('The mail server did not answer in time.')));
    s.on('data', (d) => { buf += d.toString('utf8').replace(/\r/g, ''); pump(); });
    s.on('error', fail);
    s.on('close', () => fail(new Error('The mail server closed the connection.')));
  };
  const read = (ok) => new Promise((resolve, reject) => {
    if (err) return reject(err);
    waiters.push({
      resolve: (r) => (ok.includes(r.slice(0, 3)) ? resolve(r) : reject(new Error('Mail server said: ' + r.trim().slice(0, 160)))),
      reject,
    });
    pump();
  });
  const cmd = (line, ok) => { sock.write(line + '\r\n'); return read(ok); };
  attach(port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
  try {
    await read(['220']);
    let hello = await cmd('EHLO epics.local', ['250']);
    if (port !== 465 && /STARTTLS/i.test(hello)) {
      await cmd('STARTTLS', ['220']);
      sock.removeAllListeners('data'); sock.removeAllListeners('close');
      attach(tls.connect({ socket: sock, servername: host }));
      hello = await cmd('EHLO epics.local', ['250']);
    }
    if (e.SMTP_USER) await cmd('AUTH PLAIN ' + Buffer.from('\0' + e.SMTP_USER + '\0' + (e.SMTP_PASS || '')).toString('base64'), ['235']);
    await cmd(`MAIL FROM:<${fromAddr}>`, ['250']);
    await cmd(`RCPT TO:<${to}>`, ['250', '251']);
    await cmd('DATA', ['354']);
    const enc = (t) => (/^[\x20-\x7e]*$/.test(t) ? t : '=?UTF-8?B?' + Buffer.from(t).toString('base64') + '?=');
    const body = Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
    const msg = [`From: ${enc(fromHdr)}`, `To: <${to}>`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@epics.local>`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
    await cmd(msg + '\r\n.', ['250']);
    sock.write('QUIT\r\n');
  } finally {
    try { sock.end(); } catch { /* closed */ }
  }
}

/* ---------- Email ---------- */
async function sendMail(to, subject, text) {
  if (!mailConfigured()) {
    console.log(`[mail:dev] to=${to}\nsubject=${subject}\n${text}\n`);
    return;
  }
  if (E().SMTP_HOST) return smtpSend(to, subject, text);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + E().RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: E().MAIL_FROM || 'AI Knowledge System <onboarding@resend.dev>', to: [to], subject, text }),
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
async function transcribe(audioPath) {
  if (demo()) {
    const paras = JSON.parse(await fsp.readFile(path.join(__dirname, 'mock', 'transcript.json'), 'utf8'));
    return paras.map((text, i) => ({ speaker: 'A', start: i * 30000, text }));
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

function shapeTranscript(utt, user) {
  const ids = new Map();
  const words = new Map();
  const transcript = utt.map((u) => {
    if (!ids.has(u.speaker)) ids.set(u.speaker, ids.size === 0 && user ? `${user.name} (${user.uid})` : 'Speaker ' + (ids.size + 1));
    const id = ids.get(u.speaker);
    words.set(id, (words.get(id) || 0) + (u.text.match(/\S+/g) || []).length);
    return { speaker: id, start: u.start, text: u.text };
  });
  const total = [...words.values()].reduce((a, b) => a + b, 0) || 1;
  const speakers = [...words].map(([id, w]) => ({ id, words: w, share: Math.round((w * 100) / total) }));
  return { transcript, speakers };
}

/* ---------- OpenAI Integration ---------- */
async function openaiChat(messages, options = {}) {
  const key = (E().OPENAI_API_KEY || '').trim();
  if (!key) throw new Error('No OpenAI API key set. Add OPENAI_API_KEY to your .env file.');

  const model = (E().OPENAI_MODEL || 'gpt-4o-mini').trim();
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens || 2500,
  };
  if (options.json) {
    body.response_format = { type: 'json_object' };
  }

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });

  const raw = await r.text();
  let j;
  try { j = JSON.parse(raw); } catch { j = {}; }

  if (!r.ok) {
    const detail = j.error && j.error.message ? j.error.message : raw.slice(0, 300);
    console.error('OpenAI API error (' + r.status + '):', detail);
    if (r.status === 401) throw new Error('Invalid OpenAI API key. Please check OPENAI_API_KEY in your .env file.');
    if (r.status === 429) throw new Error('OpenAI rate limit or quota exceeded. Please check your OpenAI account usage.');
    throw new Error('OpenAI AI error (' + r.status + '): ' + String(detail).slice(0, 220));
  }

  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content || !content.trim()) {
    throw new Error('OpenAI returned an empty response. Please try again.');
  }
  return content.trim();
}

/* ---------- AI Provider Router (OpenAI -> Gemini -> Anthropic) ---------- */
async function claude(system, user, maxTokens, jsonMode = false) {
  // 1. Primary: OpenAI
  if (E().OPENAI_API_KEY) {
    try {
      return await openaiChat([
        { role: 'system', content: system },
        { role: 'user', content: user }
      ], { maxTokens, json: jsonMode, temperature: 0.2 });
    } catch (err) {
      console.warn('[AI] OpenAI request failed (' + err.message + '). Falling back to secondary AI provider.');
      if (!E().GEMINI_API_KEY && !E().ANTHROPIC_API_KEY) throw err;
    }
  }

  // 2. Fallback: Gemini AI
  if (E().GEMINI_API_KEY) {
    const key = E().GEMINI_API_KEY;
    const model = (E().GEMINI_MODEL || 'gemini-3-flash-preview').trim();
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.2,
          ...(jsonMode ? { responseMimeType: 'application/json' } : {})
        },
      }),
    });

    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw || '{}'); } catch { j = {}; }
    if (!r.ok) {
      const detail = j.error && j.error.message ? j.error.message : raw.slice(0, 300);
      console.error('Gemini API error (' + r.status + '):', detail);
      if (r.status === 429) throw new Error('AI rate limit or free quota reached. Check usage and limits.');
      if (r.status === 503) throw new Error('AI is temporarily busy. Wait a little and try again.');
      if (r.status === 401 || r.status === 403) throw new Error('AI rejected the API request. Check your API key.');
      throw new Error('AI service error (' + r.status + '): ' + String(detail).slice(0, 220));
    }
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    const result = Array.isArray(parts) ? parts.map((part) => part.text || '').join('') : '';
    if (!result.trim()) {
      throw new Error('AI returned an empty response. Try again.');
    }
    return result;
  }

  // 3. Fallback: Anthropic
  if (E().ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': E().ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: E().ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        system,
        max_tokens: maxTokens || 4096,
        messages: [{ role: 'user', content: user }]
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Anthropic error (' + r.status + '): ' + (j.error?.message || 'failed'));
    return j.content?.[0]?.text || '';
  }

  throw new Error('No AI key found. Add OPENAI_API_KEY to your .env file.');
}

const ts = (ms) => { const s = Math.floor(ms / 1000), f = (n) => String(n).padStart(2, '0'); return `${f(Math.floor(s / 3600))}:${f(Math.floor((s % 3600) / 60))}:${f(s % 60)}`; };
const asText = (transcript) => transcript.map((l) => `[${ts(l.start)}] ${l.speaker}: ${l.text}`).join('\n');

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
 "tasks": [{"task": string, "owner": string (speaker name or "Everyone"), "due": string (as said, or "not specified")}] (only tasks, homework or deadlines actually spoken; empty array if none),
 "quiz": {"Easy": Q[5], "Medium": Q[5], "Hard": Q[5]},
 "flashcards": [{"q": string, "a": string}] (8-12 items)}
Q = {"q": string, "options": string[3 or 4], "answer": integer index of the correct option}.
Quiz questions must test SUBJECT KNOWLEDGE taught in the session (concepts, facts, reasoning), never who spoke or when. Easy = recall, Medium = understanding, Hard = application or analysis. Use only what the transcript supports. Never invent names; refer to speakers by the exact names given in the transcript.`;

async function analyze(transcript) {
  if (demo()) return cleanAnalysis(JSON.parse(await fsp.readFile(path.join(__dirname, 'mock', 'analysis.json'), 'utf8')));
  const text = asText(transcript).slice(0, 700000);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      return cleanAnalysis(parseJson(await claude(ANALYZE_SYSTEM, text, 12000)));
    } catch (e) {
      lastErr = e;
      // Retry only malformed model output. Provider/quota/configuration errors will not improve
      // with another request and should not consume extra quota.
      if (/rate limit|quota|temporarily busy|Gemini rejected|model was not found|No Gemini API key|Gemini AI service error|ffmpeg|API key/i.test(String(e.message))) throw e;
    }
  }
  throw new Error('The AI could not format a valid analysis. Please try again once. (' + lastErr.message + ')');
}

async function ask(transcript, question) {
  if (demo()) {
    const w = (question.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    let best = null, bs = 0;
    for (const l of transcript) { const n = w.filter((x) => l.text.toLowerCase().includes(x)).length; if (n > bs) { bs = n; best = l; } }
    return best ? `${best.speaker} at [${ts(best.start)}] said: ${best.text}` : 'I could not find that in this recording.';
  }
  const sys = `You are an expert AI teaching assistant answering questions about a lecture or meeting recording based on its transcript.
Answer accurately, clearly, and concisely using the provided transcript.
Include the speaker's name or ID and timestamp [hh:mm:ss] when citing when something was mentioned.
If the transcript does not contain the answer, state that clearly and briefly offer relevant guidance if applicable.`;
  return (await claude(sys, `Transcript:\n${asText(transcript).slice(0, 700000)}\n\nQuestion: ${question}`, 1200)).trim();
}

async function processVideo(video, stage, user) {
  const t0 = Date.now();
  stage('Extracting audio…');
  const audio = video.path + '.mp3';
  try {
    await extractAudio(video.path, audio);
    stage('Transcribing speech and identifying speakers…');
    const { transcript, speakers } = shapeTranscript(await transcribe(audio), user);
    stage('Writing summary, quiz and tasks…');
    const A = await analyze(transcript);
    return { demo: demo(), seconds: Math.round((Date.now() - t0) / 1000), transcript, speakers, ...A };
  } finally {
    fs.rm(audio, { force: true }, () => {});
  }
}

async function askora(question, history = [], name = 'there') {
  const q = String(question || '').trim().slice(0, 4000);
  if (!q) throw new Error('Type a question.');

  const system = `You are Askora, an advanced, highly intelligent AI assistant powered by OpenAI, functioning just like ChatGPT.
You assist students, educators, and lifelong learners with coursework, programming, exam preparation, writing, analysis, conceptual explanations, and everyday questions.
Guidelines for your responses:
- Provide clear, articulate, comprehensive, and logically organized answers.
- Break down complex topics into intuitive steps and offer real-world examples.
- When answering coding queries, provide clean, idiomatic code with clear explanations.
- Format responses beautifully using GitHub Flavored Markdown (headers, bullet points, numbered steps, bold highlights, tables, and code blocks).
- Be direct, insightful, engaging, and friendly without unnecessary filler.
User's name: ${String(name || 'there').slice(0, 100)}.`;

  const messages = [{ role: 'system', content: system }];
  if (Array.isArray(history)) {
    for (const m of history.slice(-16)) {
      if (m && m.content) {
        messages.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content).slice(0, 4000)
        });
      }
    }
  }
  messages.push({ role: 'user', content: q });

  // 1. Primary: OpenAI
  if (E().OPENAI_API_KEY) {
    try {
      return await openaiChat(messages, { maxTokens: 3000, temperature: 0.7 });
    } catch (err) {
      console.warn('[Askora] OpenAI request failed (' + err.message + '). Falling back to secondary AI provider.');
      if (!E().GEMINI_API_KEY) throw err;
    }
  }

  // 2. Fallback: Gemini AI
  if (E().GEMINI_API_KEY) {
    const prompt = messages.slice(1).map(m => `${m.role === 'assistant' ? 'Askora' : 'User'}: ${m.content}`).join('\n\n');
    const key = E().GEMINI_API_KEY;
    const model = (E().GEMINI_MODEL || 'gemini-3-flash-preview').trim();
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 3000, temperature: 0.7 }
      }),
    });
    const j = await r.json();
    const parts = j.candidates?.[0]?.content?.parts;
    const res = Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
    if (res.trim()) return res.trim();
  }

  // 3. Fallback: local Ollama
  try {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: q }],
        options: { temperature: 0.4 }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) {
      const data = await response.json();
      const answer = String(data.message?.content || '').trim();
      if (answer) return answer;
    }
  } catch {}

  throw new Error('No OpenAI API key set. Add OPENAI_API_KEY to your .env file to enable Askora.');
}

module.exports = { sendMail, mailConfigured, processVideo, ask, askora, ts };

