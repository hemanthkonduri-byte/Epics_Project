'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');

/* ---------- config (.env) ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file */ }
if (process.argv.includes('--demo')) process.env.MOCK = '1';
const E = process.env;
const { sendMail, mailConfigured, processVideo, ask, ts } = require('./services');

const PORT = +E.PORT || 3000;
if (!E.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET is not set. Logins will reset on every restart. See .env.example');
const SECRET = E.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA, 'app.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'part', verified INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, result TEXT, error TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meetings(code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mlines(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, uid TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);`);
db.prepare("UPDATE videos SET status='error', error='The server restarted. Please upload again.' WHERE status IN ('queued','working')").run();

/* ---------- helpers ---------- */
const scrypt = promisify(crypto.scrypt);
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(pw, salt, 64)).toString('hex');
}
async function checkPw(pw, stored) {
  const [s, h] = stored.split(':');
  const got = await scrypt(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const hmac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
function makeToken(payload) { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return body + '.' + hmac(body); }
function readToken(t) {
  if (!t) return null;
  const [body, sig] = t.split('.');
  if (!body || !sig || !safeEq(sig, hmac(body))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
function setSession(res, user, remember) {
  const exp = Date.now() + (remember ? 30 * 864e5 : 12 * 36e5);
  const flags = `; HttpOnly; SameSite=Lax; Path=/${remember ? '; Max-Age=' + 30 * 86400 : ''}${E.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', 'cm=' + makeToken({ id: user.id, exp }) + flags);
}
const clearSession = (res) => res.setHeader('Set-Cookie', 'cm=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
function currentUser(req) {
  const p = readToken(cookies(req).cm);
  return p ? db.prepare('SELECT * FROM users WHERE id=? AND verified=1').get(p.id) || null : null;
}
const needUser = (req) => currentUser(req) || (() => { throw httpErr(401, 'Please log in.'); })();
const pub = (u) => ({ id: u.uid, name: u.name, email: u.email, role: u.role });

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter((t) => now - t < windowMs);
  a.push(now);
  hits.set(key, a);
  return a.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 36e5)) hits.delete(k); }, 6e5).unref();

const DISPOSABLE = new Set(['mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com']);
function cleanEmail(x) {
  const e = String(x || '').trim().toLowerCase();
  if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) throw httpErr(400, 'Enter a valid email.');
  if (DISPOSABLE.has(e.split('@')[1])) throw httpErr(400, 'Temporary email domains are not allowed.');
  return e;
}

function readJson(req, max = 100000) {
  return new Promise((resolve, reject) => {
    let n = 0, big = false;
    const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > max) big = true; else chunks.push(d); });
    req.on('end', () => {
      if (big) return reject(httpErr(413, 'Request too large.'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(httpErr(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const clientIp = (req) => (E.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'ip';

/* ---------- email codes ---------- */
async function issueCode(email) {
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare('INSERT OR REPLACE INTO codes(email,hash,expires,tries) VALUES(?,?,?,0)').run(email, sha(code + ':' + email), Date.now() + 10 * 60000);
  try { await sendMail(email, 'Your ClassMind verification code', `Your ClassMind code is ${code}.\nIt expires in 10 minutes. If you did not sign up, ignore this email.`); }
  catch (e) { console.error('mail error:', e.message); throw httpErr(502, 'Could not send the email. Check the address and try again.'); }
  return code;
}
function newUid() {
  for (;;) { const id = 'CM-' + crypto.randomInt(100000, 1000000); if (!db.prepare('SELECT 1 FROM users WHERE uid=?').get(id)) return id; }
}

/* ---------- job queue ---------- */
const queue = [];
let running = 0;
function enqueue(id) { queue.push(id); pump(); }
function pump() {
  while (running < (+E.CONCURRENCY || 2) && queue.length) { const id = queue.shift(); running++; runJob(id).finally(() => { running--; pump(); }); }
}
async function runJob(id) {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(id);
  if (!v) return;
  const setStage = (s) => db.prepare("UPDATE videos SET status='working', stage=? WHERE id=?").run(s, id);
  try {
    setStage('Starting…');
    const result = await processVideo(v, setStage);
    db.prepare("UPDATE videos SET status='done', stage='Done', result=? WHERE id=?").run(JSON.stringify(result), id);
  } catch (e) {
    console.error('job failed:', e.message);
    db.prepare("UPDATE videos SET status='error', error=? WHERE id=?").run(String(e.message).slice(0, 300), id);
  } finally {
    fs.rm(v.path, { force: true }, () => {}); // keep the transcript, delete the big video file
  }
}
function ownVideo(user, id) {
  const v = db.prepare('SELECT * FROM videos WHERE id=? AND user_id=?').get(String(id), user.id);
  if (!v) throw httpErr(404, 'Not found.');
  return v;
}

/* ---------- live meetings (rooms, shared speaker-labelled transcript over SSE) ---------- */
const rooms = new Map();
const live = (code) => { let r = rooms.get(code); if (!r) { r = { clients: new Set(), removed: new Set(), hands: new Set() }; rooms.set(code, r); } return r; };
const people = (code) => { const seen = new Map(); for (const c of live(code).clients) seen.set(c.user.uid, { id: c.user.uid, name: c.user.name, hand: live(code).hands.has(c.user.uid) }); return [...seen.values()]; };
function emit(code, ev, data, onlyUid) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of live(code).clients) { if (onlyUid && c.user.uid !== onlyUid) continue; try { c.res.write(msg); } catch { /* closed */ } }
}
function meeting(code) {
  const m = db.prepare('SELECT * FROM meetings WHERE code=?').get(String(code).toUpperCase());
  if (!m) throw httpErr(404, 'Meeting not found. Check the code.');
  return m;
}
function canJoin(m, u) {
  if (m.ended) throw httpErr(410, 'This meeting has ended.');
  if (live(m.code).removed.has(u.uid)) throw httpErr(403, 'You were removed from this meeting.');
  if (m.locked && u.id !== m.host_id) throw httpErr(403, 'This meeting is locked by the host.');
}
function dropClients(code, onlyUid) {
  const r = live(code);
  for (const c of [...r.clients]) if (!onlyUid || c.user.uid === onlyUid) { r.clients.delete(c); try { c.res.end(); } catch { /* closed */ } }
}

/* ---------- routes ---------- */
const MEDIA_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mp3', '.wav', '.m4a', '.ogg', '.aac']);

async function api(req, res, url) {
  const m = req.method, p = url.pathname, ip = clientIp(req);
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'cm') throw httpErr(403, 'Blocked request.');

  if (m === 'GET' && p === '/api/me') { const u = currentUser(req); return send(res, 200, { user: u ? pub(u) : null }); }

  if (m === 'POST' && p === '/api/signup') {
    if (limited('su:' + ip, 10, 15 * 60000)) throw httpErr(429, 'Too many attempts. Try again later.');
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 80), email = cleanEmail(b.email), pw = String(b.password || '');
    if (!name) throw httpErr(400, 'Enter your name.');
    if (pw.length < 6 || pw.length > 200) throw httpErr(400, 'Password must be 6 to 200 characters.');
    const role = b.role === 'host' ? 'host' : 'part';
    const ex = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (ex && ex.verified) throw httpErr(409, 'Account already exists. Use Existing user.');
    const ph = await hashPw(pw);
    if (ex) db.prepare('UPDATE users SET name=?, pw=?, role=? WHERE id=?').run(name, ph, role, ex.id);
    else db.prepare('INSERT INTO users(uid,name,email,pw,role,verified,created) VALUES(?,?,?,?,?,0,?)').run(newUid(), name, email, ph, role, Date.now());
    const code = await issueCode(email);
    return send(res, 200, { ok: true, ...(mailConfigured() ? {} : { devCode: code }) });
  }

  if (m === 'POST' && p === '/api/verify') {
    if (limited('vf:' + ip, 20, 15 * 60000)) throw httpErr(429, 'Too many attempts. Try again later.');
    const b = await readJson(req);
    const email = cleanEmail(b.email), code = String(b.code || '').trim();
    const row = db.prepare('SELECT * FROM codes WHERE email=?').get(email);
    if (!row || row.expires < Date.now()) throw httpErr(400, 'Code expired. Sign up again to get a new code.');
    if (row.tries >= 5) throw httpErr(429, 'Too many wrong codes. Sign up again to get a new code.');
    if (!safeEq(row.hash, sha(code + ':' + email))) {
      db.prepare('UPDATE codes SET tries=tries+1 WHERE email=?').run(email);
      throw httpErr(400, 'Incorrect code.');
    }
    db.prepare('UPDATE users SET verified=1 WHERE email=?').run(email);
    db.prepare('DELETE FROM codes WHERE email=?').run(email);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    setSession(res, u, b.remember !== false);
    return send(res, 200, { user: pub(u) });
  }

  if (m === 'POST' && p === '/api/login') {
    const b = await readJson(req);
    const email = cleanEmail(b.email);
    if (limited('li:' + ip + email, 10, 15 * 60000)) throw httpErr(429, 'Too many attempts. Try again later.');
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !(await checkPw(String(b.password || ''), u.pw))) throw httpErr(401, 'Wrong email or password.');
    if (!u.verified) throw httpErr(403, 'Email not verified. Sign up again to get a new code.');
    setSession(res, u, b.remember !== false);
    return send(res, 200, { user: pub(u) });
  }

  if (m === 'POST' && p === '/api/logout') { clearSession(res); return send(res, 200, { ok: true }); }

  if (m === 'POST' && p === '/api/role') {
    const u = needUser(req), b = await readJson(req);
    const role = b.role === 'host' ? 'host' : 'part';
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id);
    return send(res, 200, { ok: true, role });
  }

  if (m === 'PUT' && p === '/api/videos') {
    const u = needUser(req);
    if (limited('up:' + u.id, 30, 36e5)) throw httpErr(429, 'Too many uploads. Try again later.');
    const MAX = (+E.MAX_UPLOAD_MB || 2048) * 1048576;
    if ((+req.headers['content-length'] || 0) > MAX) throw httpErr(413, 'File too large.');
    const name = String(url.searchParams.get('name') || 'video').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const ext = path.extname(name).toLowerCase();
    if (!MEDIA_EXT.has(ext)) throw httpErr(400, 'Upload a video or audio file (mp4, mov, webm, mkv, mp3, wav…).');
    const id = crypto.randomUUID(), fp = path.join(UP, id + ext);
    let n = 0;
    const cap = new Transform({ transform(c, _e, cb) { n += c.length; n > MAX ? cb(httpErr(413, 'File too large.')) : cb(null, c); } });
    try { await pipeline(req, cap, fs.createWriteStream(fp)); }
    catch (e) { fs.rm(fp, { force: true }, () => {}); throw e.status ? e : httpErr(400, 'Upload interrupted.'); }
    if (!n) { fs.rm(fp, { force: true }, () => {}); throw httpErr(400, 'Empty file.'); }
    db.prepare("INSERT INTO videos(id,user_id,filename,path,status,stage,created) VALUES(?,?,?,?,'queued','Queued',?)").run(id, u.id, name, fp, Date.now());
    enqueue(id);
    return send(res, 200, { id });
  }

  if (m === 'POST' && p === '/api/rooms') {
    const u = needUser(req);
    if (u.role !== 'host') throw httpErr(403, 'Only hosts can start meetings. Switch your role in Account.');
    if (limited('rm:' + u.id, 30, 36e5)) throw httpErr(429, 'Too many meetings. Try again later.');
    const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 6 }, () => AB[crypto.randomInt(AB.length)]).join(''); } while (db.prepare('SELECT 1 FROM meetings WHERE code=?').get(code));
    db.prepare('INSERT INTO meetings(code,host_id,created) VALUES(?,?,?)').run(code, u.id, Date.now());
    return send(res, 200, { code });
  }
  let rr;
  if ((rr = /^\/api\/rooms\/([A-Za-z0-9]{6})(?:\/(\w+))?$/.exec(p))) {
    const u = needUser(req), mt = meeting(rr[1]), code = mt.code, act = rr[2], isHost = u.id === mt.host_id;
    if (m === 'POST' && act === 'join') { canJoin(mt, u); return send(res, 200, { code, host: isHost }); }
    if (m === 'GET' && act === 'events') {
      canJoin(mt, u);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      const client = { res, user: u };
      live(code).clients.add(client);
      const lines = db.prepare('SELECT uid AS id, name, text, ts FROM mlines WHERE code=? ORDER BY id LIMIT 20000').all(code);
      res.write(`event: init\ndata: ${JSON.stringify({ host: isHost, locked: !!mt.locked, people: people(code), lines })}\n\n`);
      emit(code, 'people', people(code));
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
      req.on('close', () => {
        clearInterval(beat);
        const r = live(code);
        r.clients.delete(client);
        if (![...r.clients].some((c) => c.user.uid === u.uid)) r.hands.delete(u.uid);
        emit(code, 'people', people(code));
        if (!r.clients.size && !db.prepare('SELECT 1 FROM meetings WHERE code=? AND ended=0').get(code)) rooms.delete(code);
      });
      return;
    }
    if (m === 'GET' && act === 'transcript') {
      const mine = isHost || db.prepare('SELECT 1 FROM mlines WHERE code=? AND uid=?').get(code, u.uid);
      if (!mine) throw httpErr(403, 'Not allowed.');
      return send(res, 200, { code, lines: db.prepare('SELECT uid AS id, name, text, ts FROM mlines WHERE code=? ORDER BY id').all(code) });
    }
    if (m === 'POST' && act === 'line') {
      if (mt.ended) throw httpErr(410, 'This meeting has ended.');
      if (![...live(code).clients].some((c) => c.user.uid === u.uid)) throw httpErr(403, 'Join the meeting first.');
      if (limited('ln:' + u.id, 240, 60000)) throw httpErr(429, 'Slow down.');
      const text = String((await readJson(req)).text || '').trim().slice(0, 1000);
      if (!text) throw httpErr(400, 'Empty line.');
      const line = { id: u.uid, name: u.name, text, ts: Date.now() };
      db.prepare('INSERT INTO mlines(code,uid,name,text,ts) VALUES(?,?,?,?,?)').run(code, u.uid, u.name, text, line.ts);
      emit(code, 'line', line);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && act === 'hand') {
      const up = !!(await readJson(req)).up, r = live(code);
      up ? r.hands.add(u.uid) : r.hands.delete(u.uid);
      emit(code, 'people', people(code));
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && ['lock', 'end', 'remove'].includes(act)) {
      if (!isHost) throw httpErr(403, 'Only the host can do this.');
      const b = await readJson(req);
      if (act === 'lock') {
        const lk = b.locked ? 1 : 0;
        db.prepare('UPDATE meetings SET locked=? WHERE code=?').run(lk, code);
        emit(code, 'lock', { locked: !!lk });
      } else if (act === 'end') {
        db.prepare('UPDATE meetings SET ended=1 WHERE code=?').run(code);
        emit(code, 'ended', {});
        dropClients(code);
        rooms.delete(code);
      } else {
        const target = String(b.id || '');
        if (target === u.uid) throw httpErr(400, 'You cannot remove yourself.');
        live(code).removed.add(target);
        emit(code, 'removed', {}, target);
        dropClients(code, target);
        emit(code, 'people', people(code));
      }
      return send(res, 200, { ok: true });
    }
    throw httpErr(404, 'Not found.');
  }

  let mm;
  if (m === 'GET' && (mm = /^\/api\/videos\/([\w-]+)$/.exec(p))) {
    const v = ownVideo(needUser(req), mm[1]);
    return send(res, 200, { status: v.status, stage: v.stage, error: v.error, result: v.result ? JSON.parse(v.result) : null });
  }
  if (m === 'POST' && (mm = /^\/api\/videos\/([\w-]+)\/alerts$/.exec(p))) {
    const u = needUser(req), v = ownVideo(u, mm[1]), b = await readJson(req);
    if (v.status !== 'done') throw httpErr(400, 'Not ready yet.');
    if (limited('al:' + u.id, 20, 36e5)) throw httpErr(429, 'Too many alerts. Try again later.');
    let tasks = JSON.parse(v.result).tasks;
    if (Number.isInteger(b.index)) tasks = tasks.slice(b.index, b.index + 1);
    if (!tasks.length) throw httpErr(400, 'No tasks to send.');
    const lines = tasks.map((t, i) => `${i + 1}. ${t.task}\n   Who: ${t.owner} · Due: ${t.due}`).join('\n');
    try { await sendMail(u.email, `ClassMind task alert: ${v.filename}`, `Tasks mentioned in "${v.filename}":\n\n${lines}\n`); }
    catch { throw httpErr(502, 'Could not send the email.'); }
    return send(res, 200, { sent: tasks.length });
  }
  if (m === 'POST' && (mm = /^\/api\/videos\/([\w-]+)\/ask$/.exec(p))) {
    const u = needUser(req), v = ownVideo(u, mm[1]), b = await readJson(req);
    const q = String(b.question || '').trim().slice(0, 500);
    if (!q) throw httpErr(400, 'Type a question.');
    if (v.status !== 'done') throw httpErr(400, 'Not ready yet.');
    if (limited('ak:' + u.id, 60, 36e5)) throw httpErr(429, 'Too many questions. Try again later.');
    return send(res, 200, { answer: await ask(JSON.parse(v.result).transcript, q) });
  }
  throw httpErr(404, 'Not found.');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpErr(405, 'Method not allowed.');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw httpErr(400, 'Bad path.'); }
  const file = path.join(PUB, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(PUB + path.sep)) throw httpErr(404, 'Not found.');
  let st;
  try { st = fs.statSync(file); } catch { throw httpErr(404, 'Not found.'); }
  if (!st.isFile()) throw httpErr(404, 'Not found.');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self)');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (res.headersSent) return res.end();
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
});
server.requestTimeout = 0; // allow long uploads
server.headersTimeout = 65000;
server.listen(PORT, E.HOST || '0.0.0.0', () => {
  console.log(`ClassMind running at http://localhost:${PORT}${E.MOCK === '1' ? '  (DEMO MODE: built-in sample transcript)' : ''}`);
  if (!mailConfigured()) console.log('Email: no RESEND_API_KEY set. Codes and alerts are printed here and codes are shown in the page (development only).');
});
module.exports = { ts };
