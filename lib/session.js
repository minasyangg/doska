/* ============================================================
   Серверные сессии доски.

   В браузер уходит только id сессии в httpOnly-куке. Пара токенов Supabase
   лежит на сервере и шифруется на диске: файл сессии — это, по сути, ключ от
   аккаунта mcko-app, и обращаться с ним надо соответственно.

   Почему у доски своя пара токенов, а не проброшенная из mcko-app: ротация
   refresh-токенов включена, и если бы доска обновляла тот же токен, что и
   вкладка mcko-app, они бы гасили сессии друг друга. Своя пара выдаётся либо
   входом по паролю, либо погашением одноразового hashed_token (SSO).
   ============================================================ */
'use strict';
const crypto = require('crypto');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const gotrue = require('./gotrue');
const db = require('./db');

const SID_RE      = /^[A-Za-z0-9_-]{43}$/;
const COOKIE      = 'doska_sid';
const MAX_AGE     = 30 * 24 * 3600;          // жёсткий потолок жизни сессии
const IDLE_MAX    = 14 * 24 * 3600 * 1000;   // и отдельно — простой
const TOUCH_EVERY = 10 * 60 * 1000;          // не переписывать файл на каждый чих
const REFRESH_LEAD = 120 * 1000;             // обновлять токен заранее
const CACHE_MAX   = 5000;

let DIR = null;
let key = null;

function init(sessionsDir) {
  DIR = sessionsDir;
  fs.mkdirSync(DIR, { recursive: true });
  const secret = process.env.SESSION_SECRET || '';
  if (secret.length >= 32) {
    key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'doska-session-v1', 32));
  } else {
    key = crypto.randomBytes(32);
    console.warn(secret
      ? 'SESSION_SECRET короче 32 символов — использован временный ключ.'
      : 'SESSION_SECRET не задан — использован временный ключ.');
    console.warn('Все входы слетят при перезапуске. Задайте SESSION_SECRET в .env.dev.local.');
  }
}

/* ─── шифрование файла сессии ───────────────────────────── */

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function unseal(buf) {
  if (!buf || buf.length < 29) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }   // сменился SESSION_SECRET или файл побит
}

const fileOf = sid => path.join(DIR, sid + '.sess');

/* ─── кэш в памяти ──────────────────────────────────────── */

const cache = new Map();                       // sid -> запись
function remember(s) {
  cache.delete(s.sid); cache.set(s.sid, s);     // переставляем в конец = LRU
  // цикл, а не if: при обычной работе лишняя всегда одна, но так размер
  // гарантированно приходит в норму, а не догоняет её по одной записи
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return s;
}

/* ─── жизненный цикл ────────────────────────────────────── */

const newSid = () => crypto.randomBytes(32).toString('base64url');

async function save(s) {
  await fsp.writeFile(fileOf(s.sid), seal(s), { mode: 0o600 });
  return remember(s);
}

const expired = s =>
  !s || Date.now() - s.createdAt > MAX_AGE * 1000 || Date.now() - s.lastSeen > IDLE_MAX;

async function load(sid) {
  if (!sid || !SID_RE.test(sid)) return null;
  let s = cache.get(sid);
  if (!s) {
    const buf = await fsp.readFile(fileOf(sid)).catch(() => null);
    s = unseal(buf);
    if (!s || s.sid !== sid) return null;
    remember(s);
  }
  if (expired(s)) { await destroy(sid); return null; }
  // lastSeen обновляем лениво: иначе каждая картинка перезаписывала бы файл
  if (Date.now() - s.lastSeen > TOUCH_EVERY) { s.lastSeen = Date.now(); save(s).catch(() => {}); }
  return s;
}

async function destroy(sid, { revoke = false } = {}) {
  const s = cache.get(sid);
  cache.delete(sid);
  await fsp.unlink(fileOf(sid)).catch(() => {});
  if (revoke && s && s.access_token) await gotrue.signOut(s.access_token).catch(() => {});
}

/** Сессия пользователя из пары токенов Supabase. Роль и имя берём из profiles:
    в JWT их нет, а по auth.users роль не определить. */
async function createUser(tokens) {
  const uid = tokens.user && tokens.user.id;
  if (!uid) throw new gotrue.AuthError('Supabase не вернул пользователя');
  const profile = await db.getProfile(tokens.access_token, uid).catch(() => null);
  const now = Date.now();
  return save({
    kind: 'user', sid: newSid(), uid,
    email: (tokens.user && tokens.user.email) || (profile && profile.email) || null,
    role: (profile && profile.role) || null,
    fullName: (profile && profile.full_name) || null,
    orgId: (profile && profile.organization_id) || null,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    createdAt: now, lastSeen: now
  });
}

/** Гостевая сессия: аккаунта нет, но есть подтверждённый доступ к одной доске.
    guestId стабилен между перезаходами — на нём держится «стереть своё». */
async function createGuest({ boardId, level, guestId, name }) {
  const now = Date.now();
  return save({
    kind: 'guest', sid: newSid(),
    boardId, level, guestId, name: name || null,
    createdAt: now, lastSeen: now
  });
}

/* ─── обновление access-токена ──────────────────────────── */

// По одному обмену на сессию. Два параллельных обмена одним refresh-токеном за
// пределами refresh_token_reuse_interval отзывают всё семейство, и пользователь
// вылетает без всякой причины — это самое узкое место всей схемы.
const refreshing = new Map();

async function accessToken(s) {
  if (!s || s.kind !== 'user') return null;
  if (s.expires_at - Date.now() > REFRESH_LEAD) return s.access_token;

  let p = refreshing.get(s.sid);
  if (!p) {
    p = (async () => {
      const t = await gotrue.refresh(s.refresh_token);
      s.access_token = t.access_token;
      s.refresh_token = t.refresh_token;
      s.expires_at = t.expires_at;
      s.lastSeen = Date.now();
      await save(s);
      return s.access_token;
    })().finally(() => refreshing.delete(s.sid));
    refreshing.set(s.sid, p);
  }

  try {
    return await p;
  } catch (e) {
    // Сеть отвалилась — отдаём что есть: пусть лучше запрос упадёт на 401,
    // чем мы снесём живую сессию из-за пятиминутного сбоя Supabase.
    if (e.transport) return s.access_token;
    await destroy(s.sid);
    throw e;
  }
}

/* ─── куки ──────────────────────────────────────────────── */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sidFrom = req => parseCookies(req.headers.cookie)[COOKIE] || null;

/** Secure ставим только под HTTPS: иначе на http://localhost куку не примут
    и локально не заработает вообще ничего. */
function isSecure(req) {
  if (process.env.TRUST_PROXY === '1') {
    const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (p) return p === 'https';
  }
  return !!(req.socket && req.socket.encrypted);
}

const cookieFor = (req, sid) =>
  `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}` +
  (isSecure(req) ? '; Secure' : '');

const clearCookie = req =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (isSecure(req) ? '; Secure' : '');

/** Сессия текущего запроса или null. */
const fromRequest = req => load(sidFrom(req));

/* ─── уборка ────────────────────────────────────────────── */

async function sweep() {
  const names = await fsp.readdir(DIR).catch(() => []);
  const now = Date.now();
  for (const n of names) {
    if (!n.endsWith('.sess')) continue;
    const p = path.join(DIR, n);
    const st = await fsp.stat(p).catch(() => null);
    if (!st) continue;
    // mtime обновляется при каждом save, так что простоя достаточно
    if (now - st.mtimeMs > IDLE_MAX) {
      cache.delete(n.slice(0, -5));
      await fsp.unlink(p).catch(() => {});
    }
  }
}

module.exports = {
  init, COOKIE, MAX_AGE,
  createUser, createGuest, load, destroy, accessToken,
  parseCookies, sidFrom, fromRequest, cookieFor, clearCookie, isSecure,
  sweep, _cache: cache
};
