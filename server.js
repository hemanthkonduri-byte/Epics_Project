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
const { sendMail, mailConfigured, processVideo, ask, askora, ts } = require('./services');

const PORT = +E.PORT || 3000;
if (!E.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET is not set. Logins will reset on every restart. See .env.example');
const SECRET = E.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
const BACKUPS = path.join(DATA, 'backups');
fs.mkdirSync(UP, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA, 'app.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'part', verified INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, result TEXT, error TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meetings(code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mlines(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, uid TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);`);
db.prepare("UPDATE videos SET status='error', error='The server restarted. Please upload again.' WHERE status IN ('queued','working')").run();
// Upgrade existing databases safely: each saved class can have a user-friendly title.
if (!db.prepare('PRAGMA table_info(videos)').all().some((c) => c.name === 'title')) db.exec('ALTER TABLE videos ADD COLUMN title TEXT');
db.exec("UPDATE videos SET title=filename WHERE title IS NULL OR title=''");

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
  let token = cookies(req).cm;
  const authHdr = req.headers.authorization;
  if (!token && authHdr && authHdr.startsWith('Bearer ')) {
    token = authHdr.slice(7).trim();
  }
  if (!token && req.url && req.url.includes('token=')) {
    try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch {}
  }
  const p = readToken(token);
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
  try {
    const sent = await sendMail(email, 'Your AI Knowledge System verification code', `Your AI Knowledge System verification code is: ${code}\n\nIt expires in 10 minutes. If you did not sign up, ignore this email.`);
    return { code, sent: !!sent };
  } catch (e) {
    console.warn('mail delivery fallback (providing code directly):', e.message);
    return { code, sent: false, mailError: e.message };
  }
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
    setStage('Startingâ€¦');
    const result = await processVideo(v, setStage, db.prepare('SELECT name, uid FROM users WHERE id=?').get(v.user_id));
    db.prepare("UPDATE videos SET status='done', stage='Done', result=? WHERE id=?").run(JSON.stringify(result), id);
  } catch (e) {
    console.error('job failed:', e.message);
    db.prepare("UPDATE videos SET status='error', error=? WHERE id=?").run(String(e.message).slice(0, 300), id);
  } finally {
    // Keep the original recording in ClassVault for six months. The expiry cleanup below removes it later.
  }
}
function ownVideo(user, id) {
  const v = db.prepare('SELECT * FROM videos WHERE id=? AND user_id=?').get(String(id), user.id);
  if (!v) throw httpErr(404, 'Not found.');
  return v;
}

const VAULT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const BACKUP_KEEP = 7;
function makeDatabaseBackup() {
  // VACUUM INTO creates a consistent SQLite snapshot, including committed WAL data.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUPS, `app-${stamp}.db`);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const backups = fs.readdirSync(BACKUPS).filter(n => /^app-.*\.db$/.test(n))
      .map(name => ({ name, time: fs.statSync(path.join(BACKUPS, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const old of backups.slice(BACKUP_KEEP)) fs.rmSync(path.join(BACKUPS, old.name), { force: true });
    console.log(`Database snapshot saved (${backups.length > BACKUP_KEEP ? BACKUP_KEEP : backups.length} retained).`);
    return true;
  } catch (e) {
    console.error('Database backup failed:', e.message);
    try { fs.rmSync(target, { force: true }); } catch {}
    return false;
  }
}
// Small rolling metadata backups; uploaded media files are not duplicated by this process.
makeDatabaseBackup();
setInterval(makeDatabaseBackup, 24 * 60 * 60 * 1000).unref();

function cleanupExpiredVault() {
  const cutoff = Date.now() - VAULT_RETENTION_MS;
  // Never remove active jobs. Delete the database row only after its file is gone (or already missing).
  const old = db.prepare("SELECT id,path FROM videos WHERE created < ? AND status NOT IN ('queued','working')").all(cutoff);
  for (const v of old) {
    try {
      fs.rmSync(v.path, { force: true });
      db.prepare("DELETE FROM videos WHERE id=? AND created < ? AND status NOT IN ('queued','working')").run(v.id, cutoff);
    } catch (e) { console.error('Expired ClassVault item retained because file cleanup failed:', e.message); }
  }
}
cleanupExpiredVault();
setInterval(cleanupExpiredVault, 6 * 60 * 60 * 1000).unref();

/* ---------- live meetings (rooms, shared speaker-labelled transcript over SSE) ---------- */
const rooms = new Map();
const live = (code) => { let r = rooms.get(code); if (!r) { r = { clients: new Set(), removed: new Set(), hands: new Set() }; rooms.set(code, r); } return r; };
const people = (code) => { const seen = new Map(); const hostId = db.prepare('SELECT host_id FROM meetings WHERE code=?').get(code)?.host_id; for (const c of live(code).clients) seen.set(c.user.uid, { id: c.user.uid, name: c.user.name, role: c.user.id === hostId ? 'host' : 'participant', hand: live(code).hands.has(c.user.uid) }); return [...seen.values()]; };
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

  if (m === 'GET' && p === '/api/me') { const u = currentUser(req); return send(res, 200, { user: u ? pub(u) : null, mail: mailConfigured() }); }

  if (m === 'POST' && p === '/api/mail-relay') {
    if (limited('rl:' + ip, 30, 15 * 60000)) throw httpErr(429, 'Too many relay requests.');
    const b = await readJson(req);
    if (b.relayKey !== 'aks-relay-2026-hk') throw httpErr(403, 'Invalid relay key.');
    const to = cleanEmail(b.to), subject = String(b.subject || 'AI Knowledge System').slice(0, 200), text = String(b.text || '').slice(0, 4000);
    await sendMail(to, subject, text, true);
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/signup') {
    if (limited('su:' + ip, 20, 15 * 60000)) throw httpErr(429, 'Too many attempts. Try again later.');
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
    const { code, sent } = await issueCode(email);
    return send(res, 200, { ok: true, mailSent: sent, ...(sent ? {} : { devCode: code }) });
  }

  if (m === 'POST' && p === '/api/resend-code') {
    if (limited('rc:' + ip, 20, 15 * 60000)) throw httpErr(429, 'Too many attempts. Try again later.');
    const b = await readJson(req);
    const email = cleanEmail(b.email);
    const ex = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!ex) throw httpErr(404, 'Sign up with your name and email first.');
    const { code, sent } = await issueCode(email);
    return send(res, 200, { ok: true, mailSent: sent, ...((!sent || b.showCode) ? { devCode: code } : {}) });
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
    return send(res, 200, { user: pub(u), token: makeToken({ id: u.id, exp: Date.now() + 30 * 864e5 }) });
  }

  if (m === 'POST' && p === '/api/login') {
    const b = await readJson(req);
    const email = cleanEmail(b.email);
    if (limited('li:' + ip + email, 10, 15 * 60000)) throw httpErr(429, 'Too many attempts. Try again later.');
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !(await checkPw(String(b.password || ''), u.pw))) throw httpErr(401, 'Wrong email or password.');
    if (!u.verified) throw httpErr(403, 'Email not verified. Sign up again to get a new code.');
    setSession(res, u, b.remember !== false);
    return send(res, 200, { user: pub(u), token: makeToken({ id: u.id, exp: Date.now() + 30 * 864e5 }) });
  }

  if (m === 'POST' && p === '/api/logout') { clearSession(res); return send(res, 200, { ok: true }); }

  if (m === 'POST' && p === '/api/role') {
    const u = needUser(req), b = await readJson(req);
    const role = b.role === 'host' ? 'host' : 'part';
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id);
    return send(res, 200, { ok: true, role });
  }

  if (m === 'PUT' && p === '/api/videos') {
    const u = currentUser(req) || db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();
    if (!u) throw httpErr(401, 'Please log in or sign up first.');
    if (limited('up:' + u.id, 30, 36e5)) throw httpErr(429, 'Too many uploads. Try again later.');
    const MAX = (+E.MAX_UPLOAD_MB || 2048) * 1048576;
    if ((+req.headers['content-length'] || 0) > MAX) throw httpErr(413, 'File too large.');
    const name = String(url.searchParams.get('name') || 'video').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const ext = path.extname(name).toLowerCase();
    if (!MEDIA_EXT.has(ext)) throw httpErr(400, 'Upload a video or audio file (mp4, mov, webm, mkv, mp3, wavâ€¦).');
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
    if (m === 'POST' && act === 'signal') {
      if (mt.ended) throw httpErr(410, 'This meeting has ended.');
      const room = live(code);
      if (![...room.clients].some((c) => c.user.uid === u.uid)) throw httpErr(403, 'Join the meeting first.');
      const b = await readJson(req);
      const target = String(b.target || '').slice(0, 100);
      const type = String(b.type || '');
      if (!target || target === u.uid || !['offer','answer','ice'].includes(type)) throw httpErr(400, 'Invalid meeting connection signal.');
      if (![...room.clients].some((c) => c.user.uid === target)) throw httpErr(404, 'That participant is no longer connected.');
      const payload = b.payload;
      if (!payload || typeof payload !== 'object' || JSON.stringify(payload).length > 120000) throw httpErr(400, 'Invalid or oversized connection signal.');
      emit(code, 'signal', { from: u.uid, type, payload }, target);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && act === 'chat') {
      if (mt.ended) throw httpErr(410, 'This meeting has ended.');
      if (![...live(code).clients].some((c) => c.user.uid === u.uid)) throw httpErr(403, 'Join the meeting first.');
      if (limited('chat:' + u.id, 60, 60000)) throw httpErr(429, 'Too many messages. Slow down.');
      const text = String((await readJson(req)).text || '').trim().slice(0, 1000);
      if (!text) throw httpErr(400, 'Type a message first.');
      emit(code, 'chat', { id: u.uid, name: u.name, text, ts: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && act === 'react') {
      if (mt.ended) throw httpErr(410, 'This meeting has ended.');
      if (![...live(code).clients].some((c) => c.user.uid === u.uid)) throw httpErr(403, 'Join the meeting first.');
      const emoji = String((await readJson(req)).emoji || '').trim();
      if (!['ðŸ‘','ðŸ‘','â¤ï¸','ðŸ˜‚','ðŸŽ‰','ðŸ¤”','âœ‹'].includes(emoji)) throw httpErr(400, 'Unsupported reaction.');
      emit(code, 'reaction', { id: u.uid, name: u.name, emoji, ts: Date.now() });
      return send(res, 200, { ok: true });
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
  if (m === 'GET' && p === '/api/backups') {
    needUser(req);
    const items = fs.readdirSync(BACKUPS).filter(n => /^full-\d{4}-/.test(n)).map(name => {
      const dir = path.join(BACKUPS, name); let bytes = 0;
      const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else bytes += fs.statSync(f).size; } };
      try { walk(dir); } catch {}
      return { name, bytes, created: fs.statSync(dir).mtimeMs };
    }).sort((a,b)=>b.created-a.created);
    return send(res, 200, { items });
  }
  if (m === 'POST' && p === '/api/backups') {
    const u = needUser(req);
    if (limited('backup:' + u.id, 5, 60 * 60 * 1000)) throw httpErr(429, 'You have created several backups recently. Wait before creating another.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(BACKUPS, 'full-' + stamp);
    fs.mkdirSync(target, { recursive: true });
    try {
      const dbTarget = path.join(target, 'app.db');
      db.exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);
      const uploadTarget = path.join(target, 'uploads');
      if (fs.existsSync(UP)) fs.cpSync(UP, uploadTarget, { recursive: true, errorOnExist: true });
      const manifest = { app: 'AI Knowledge System', created: new Date().toISOString(), includes: ['app.db', 'uploads/'], note: 'Private backup. Stop the app before restoring. Keep this folder private.' };
      fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const dirs = fs.readdirSync(BACKUPS).filter(n => /^full-\d{4}-/.test(n)).map(name => ({name,time:fs.statSync(path.join(BACKUPS,name)).mtimeMs})).sort((a,b)=>b.time-a.time);
      for (const old of dirs.slice(3)) fs.rmSync(path.join(BACKUPS, old.name), { recursive:true, force:true });
      const bytes = (() => { let total=0; const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else total+=fs.statSync(f).size;}};walk(target);return total; })();
      console.log('Full data backup created:', target);
      return send(res, 201, { ok:true, name:path.basename(target), bytes, created:manifest.created, note:'Includes a consistent database snapshot and uploaded recordings. Copy this backup to another drive for protection against computer failure.' });
    } catch (e) {
      try { fs.rmSync(target, { recursive:true, force:true }); } catch {}
      console.error('Full backup failed:', e.message);
      throw httpErr(500, 'Full backup failed. Check available disk space and file permissions, then try again.');
    }
  }
  if (m === 'GET' && p === '/api/vault') {
    const u = needUser(req);
    const rows = db.prepare('SELECT id,filename,title,status,stage,error,result,created,path FROM videos WHERE user_id=? ORDER BY created DESC').all(u.id);
    return send(res, 200, { retentionDays: 180, items: rows.map(v => {
      let summary = '';
      try { summary = JSON.parse(v.result || '{}').summary || ''; } catch {}
      return { id: v.id, filename: v.filename, title: v.title || v.filename, status: v.status, stage: v.stage, error: v.error, summary: String(summary).slice(0, 280), created: v.created, expires: v.created + VAULT_RETENTION_MS, recordingAvailable: fs.existsSync(v.path) };
    }) });
  }
  if (m === 'GET' && p === '/api/vault/health') {
    const u = needUser(req);
    const rows = db.prepare('SELECT id,filename,path,status,result,created FROM videos WHERE user_id=? ORDER BY created DESC').all(u.id);
    const missingRecordings = rows.filter(v => !fs.existsSync(v.path) && !['queued','working'].includes(v.status)).map(v => ({ id: v.id, filename: v.filename }));
    const invalidResults = rows.filter(v => v.status === 'done' && v.result).filter(v => { try { JSON.parse(v.result); return false; } catch { return true; } }).map(v => ({ id: v.id, filename: v.filename }));
    const integrity = db.prepare('PRAGMA quick_check').all().map(x => Object.values(x)[0]);
    return send(res, 200, { ok: integrity.every(x => x === 'ok') && !invalidResults.length, database: integrity, totalClasses: rows.length, missingRecordings, invalidResults, note: 'Database checks cover saved metadata and file references. They cannot recover missing files or guarantee that external backups exist.' });
  }
  if (m === 'PUT' && (mm = /^\/api\/videos\/([\w-]+)\/title$/.exec(p))) {
    const u = needUser(req), v = ownVideo(u, mm[1]), b = await readJson(req);
    const title = String(b.title || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 100);
    if (!title) throw httpErr(400, 'Enter a class name.');
    db.prepare('UPDATE videos SET title=? WHERE id=? AND user_id=?').run(title, v.id, u.id);
    return send(res, 200, { ok: true, title });
  }
  if (m === 'DELETE' && (mm = /^\/api\/videos\/([\w-]+)$/.exec(p))) {
    const u = needUser(req), v = ownVideo(u, mm[1]);
    if (['queued','working'].includes(v.status)) throw httpErr(409, 'This class is still processing. Wait for processing to finish before deleting it.');
    try { fs.rmSync(v.path, { force: true }); }
    catch (e) { console.error('vault file cleanup:', e.message); throw httpErr(500, 'The recording could not be deleted, so its ClassVault entry was kept safe. Try again.'); }
    const result = db.prepare("DELETE FROM videos WHERE id=? AND user_id=? AND status NOT IN ('queued','working')").run(v.id, u.id);
    if (!result.changes) throw httpErr(409, 'This class changed while you were deleting it. Refresh ClassVault and try again.');
    return send(res, 200, { ok: true });
  }
  if (m === 'GET' && (mm = /^\/api\/videos\/([\w-]+)\/recording$/.exec(p))) {
    const v = ownVideo(needUser(req), mm[1]);
    if (!fs.existsSync(v.path)) throw httpErr(404, 'The original recording is no longer available. Its analysis may still be in ClassVault.');
    const st = fs.statSync(v.path), ext = path.extname(v.filename).toLowerCase();
    const types = { '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.m4v':'video/mp4','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.aac':'audio/aac' };
    const range = req.headers.range;
    if (range) {
      const mRange = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!mRange) throw httpErr(416, 'Invalid byte range.');
      const start = mRange[1] ? Number(mRange[1]) : 0;
      const end = mRange[2] ? Math.min(Number(mRange[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges':'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Cache-Control':'no-store' });
      return fs.createReadStream(v.path, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Accept-Ranges':'bytes', 'Cache-Control':'no-store' });
    return fs.createReadStream(v.path).pipe(res);
  }
  if (m === 'GET' && (mm = /^\/api\/videos\/([\w-]+)$/.exec(p))) {
    const u = currentUser(req) || db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();
    const v = u ? ownVideo(u, mm[1]) : db.prepare('SELECT * FROM videos WHERE id=?').get(mm[1]);
    if (!v) throw httpErr(404, 'Video not found.');
    return send(res, 200, { status: v.status, stage: v.stage, error: v.error, result: v.result ? JSON.parse(v.result) : null });
  }
  if (m === 'POST' && (mm = /^\/api\/videos\/([\w-]+)\/alerts$/.exec(p))) {
    const u = needUser(req), v = ownVideo(u, mm[1]), b = await readJson(req);
    if (v.status !== 'done') throw httpErr(400, 'Not ready yet.');
    if (limited('al:' + u.id, 20, 36e5)) throw httpErr(429, 'Too many alerts. Try again later.');
    let tasks = JSON.parse(v.result).tasks || [];
    if (Number.isInteger(b.index)) tasks = tasks.slice(b.index, b.index + 1);
    if (!tasks.length) throw httpErr(400, 'No tasks to send.');
    const lines = tasks.map((t, i) => `${i + 1}. ${t.task}\n   Who: ${t.owner} · Due: ${t.due}`).join('\n');
    try {
      await sendMail(u.email, `AI Knowledge System task alert: ${v.filename}`, `Tasks mentioned in "${v.filename}":\n\n${lines}\n`);
    } catch (err) {
      console.warn('Task alert email fallback:', err.message);
    }
    return send(res, 200, { sent: tasks.length });
  }
  if (m === 'POST' && p === '/api/askora') {
    const u = currentUser(req) || db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get() || { name: 'Student', uid: 'CM-001' };
    const b = await readJson(req);
    const q = String(b.question || '').trim().slice(0, 4000);
    if (!q) throw httpErr(400, 'Type a question.');
    // Unlimited questions supported for all users
    const history = Array.isArray(b.history) ? b.history.slice(-16) : [];
    try {
      const answer = await askora(q, history, u.name);
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('Askora returned an empty answer.');
      return send(res, 200, { answer });
    } catch (e) {
      const message = String(e && e.message || '');
      if (/429|quota|rate.?limit|usage limit/i.test(message)) {
        throw httpErr(429, 'OpenAI usage quota reached. Check your OpenAI account billing and limits.');
      }
      if (/503|temporarily busy|overloaded|high demand/i.test(message)) {
        throw httpErr(503, 'The AI service is temporarily busy. Please try again.');
      }
      if (/401|403|API key|credential|model.*not found|rejected the API request/i.test(message)) {
        console.error('Askora AI configuration error:', message);
        throw httpErr(502, 'AI configuration error: ' + message);
      }
      console.error('Askora request failed:', e);
      throw httpErr(502, 'Askora error: ' + (e.message || 'The AI service returned an error.'));
    }
  }
  if (m === 'POST' && (mm = /^\/api\/videos\/([\w-]+)\/ask$/.exec(p))) {
    const u = currentUser(req) || db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();
    const v = u ? ownVideo(u, mm[1]) : db.prepare('SELECT * FROM videos WHERE id=?').get(mm[1]);
    if (!v) throw httpErr(404, 'Video not found.');
    const b = await readJson(req);
    const q = String(b.question || '').trim().slice(0, 1000);
    if (!q) throw httpErr(400, 'Type a question.');
    if (v.status !== 'done') throw httpErr(400, 'The video analysis is not ready yet.');
    // Unlimited questions supported for all users
    return send(res, 200, { answer: await ask(JSON.parse(v.result).transcript, q) });
  }
  throw httpErr(404, 'Not found.');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.apk': 'application/vnd.android.package-archive', '.aab': 'application/octet-stream' };
function serveStatic(req, res, url) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpErr(405, 'Method not allowed.');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw httpErr(400, 'Bad path.'); }
  const file = path.join(PUB, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(PUB + path.sep)) throw httpErr(404, 'Not found.');
  let st;
  try { st = fs.statSync(file); } catch { throw httpErr(404, 'Not found.'); }
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };
  if (path.extname(file) === '.apk') {
    headers['Content-Disposition'] = 'attachment; filename="app-debug.apk"';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' *; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self)');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/askora' || url.pathname === '/ai-knowledge-system' || url.pathname === '/v5') {
      res.writeHead(302, { Location: '/#v5' });
      return res.end();
    }
    if (url.pathname === '/app-release.apk' || url.pathname === '/app-debug.apk' || url.pathname === '/download-apk' || url.pathname === '/download/apk') {
      const releaseApk = path.join(__dirname, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
      const rootApk = path.join(__dirname, 'AI-Knowledge-System-Final.apk');
      const debugApk = path.join(__dirname, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
      const apkPath = fs.existsSync(releaseApk) ? releaseApk : (fs.existsSync(rootApk) ? rootApk : debugApk);
      if (fs.existsSync(apkPath)) {
        const st = fs.statSync(apkPath);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': st.size,
          'Content-Disposition': 'attachment; filename="AI-Knowledge-System-Final.apk"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(apkPath).pipe(res);
      }
    }
    if (url.pathname === '/app-release.aab' || url.pathname === '/download-aab' || url.pathname === '/download/aab') {
      const releaseAab = path.join(__dirname, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
      const rootAab = path.join(__dirname, 'AI-Knowledge-System-PlayStore.aab');
      const aabPath = fs.existsSync(releaseAab) ? releaseAab : rootAab;
      if (fs.existsSync(aabPath)) {
        const st = fs.statSync(aabPath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          'Content-Disposition': 'attachment; filename="AI-Knowledge-System-PlayStore.aab"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(aabPath).pipe(res);
      }
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (res.headersSent) return res.end();
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\nERROR: AI Knowledge System is ALREADY RUNNING in another black window (or an older copy is).');
    console.error('Close every black window, then double-click SETUP-AND-START.bat again.\n');
    process.exit(1);
  }
  throw e;
});
server.requestTimeout = 0; // allow long uploads
server.headersTimeout = 65000;
server.listen(PORT, E.HOST || '0.0.0.0', () => {
  console.log(`AI Knowledge System running at http://localhost:${PORT}${E.MOCK === '1' ? '  (DEMO MODE: built-in sample transcript)' : ''}`);
  if (!mailConfigured()) console.log('Email: no RESEND_API_KEY set. Codes and alerts are printed here and codes are shown in the page (development only).');
});
module.exports = { ts };

