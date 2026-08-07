/* ============================================================
   Сервер доски v3
     · раздаёт клиент
     · держит сессии пользователей (своя кука, токены Supabase на сервере)
     · читает и пишет метаданные досок в БД mcko-app под правами пользователя
     · принимает загруженные картинки
     · синхронизирует комнаты по WebSocket
   Запуск: npm run dev      (порт из PORT, по умолчанию 8080)
   ============================================================ */
'use strict';
const http = require('http');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const gotrue  = require('./lib/gotrue');
const db      = require('./lib/db');
const session = require('./lib/session');
const cap_    = require('./lib/capability');   // с подчёркиванием: cap занято под уровень доступа

const PORT     = process.env.PORT || 8080;
const PUBLIC   = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR = {
  boards:   path.join(DATA_DIR, 'boards'),
  files:    path.join(DATA_DIR, 'files'),
  sessions: path.join(DATA_DIR, 'sessions')
};
for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });
session.init(DIR.sessions);

const MAX_ITEMS   = 80000;
const MAX_UPLOAD  = 16 * 1024 * 1024;      // 16 МБ на картинку
const SAVE_EVERY  = 4000;
const IDLE_UNLOAD = 30 * 60 * 1000;

/* ═══════════════ вспомогательное ═══════════════ */
const okId    = s => /^[a-zA-Z0-9_-]{1,40}$/.test(s);
const rnd     = n => crypto.randomBytes(n * 2).toString('base64url').slice(0, n);
const boardFile = id => path.join(DIR.boards, id + '.json');

const readJson = async (p, fallback) => {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
};

/* Запись во временный файл и rename: голый writeFile рвёт доску пополам, если
   процесс умрёт посреди записи, а доска — это единственная копия занятия.
   Очередь по пути нужна, чтобы два сохранения одной доски не переплелись. */
const writeQueue = new Map();
function writeJson(p, obj) {
  const prev = writeQueue.get(p) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = p + '.' + rnd(6) + '.tmp';
    try {
      await fsp.writeFile(tmp, JSON.stringify(obj));
      await fsp.rename(tmp, p);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  });
  writeQueue.set(p, next);
  next.catch(() => {}).finally(() => { if (writeQueue.get(p) === next) writeQueue.delete(p); });
  return next;
}

function reply(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ═══════════════ комнаты в памяти ═══════════════ */
/* На диске лежит только содержимое: объекты холста. Владелец, заголовок,
   замок и правила доступа живут в БД mcko-app (041_doska_boards.sql) и
   приезжают сюда через applyMeta() — файл их лишь кэширует, чтобы комната
   могла подняться, пока БД отвечает. */
const rooms = new Map();
const FILE_V = 4;

async function loadRoom(id) {
  let r = rooms.get(id);
  if (r) return r;
  const saved = await readJson(boardFile(id), null);
  r = {
    id,
    title: (saved && saved.title) || 'Без названия',
    items: (saved && Array.isArray(saved.items)) ? saved.items : [],
    ownerId: (saved && saved.ownerId) || null,
    locked: !!(saved && saved.locked),
    anyEdit: !!(saved && saved.anyEdit),
    clients: new Set(), dirty: false, touched: Date.now()
  };

  // До v4 поле by хранило идентификатор СОКЕТА, а не человека: после
  // переподключения автор терял права на собственные штрихи. Новых владельцев
  // взять неоткуда, поэтому старое содержимое закрепляем за владельцем доски —
  // он и так может всё, а чужого у него не прибавится.
  if (saved && (saved.v || 0) < FILE_V && r.items.length) {
    for (const it of r.items) it.by = r.ownerId || null;
    r.dirty = true;
    console.log('[' + id + '] содержимое переведено в v' + FILE_V + ' (' + r.items.length + ' объектов)');
  }

  rooms.set(id, r);
  return r;
}

/** Метаданные из БД перекрывают файловый кэш — источник правды один. */
function applyMeta(r, row) {
  if (!row) return r;
  const anyEdit = row.object_edit_policy === 'anyone';
  if (r.title !== row.title || r.ownerId !== row.owner_id ||
      r.locked !== !!row.locked || r.anyEdit !== anyEdit) {
    r.title = row.title; r.ownerId = row.owner_id;
    r.locked = !!row.locked; r.anyEdit = anyEdit;
    r.dirty = true;
  }
  return r;
}

function persist(r) {
  const snapshot = { v: FILE_V, title: r.title, ownerId: r.ownerId,
                     locked: r.locked, anyEdit: r.anyEdit, items: r.items };
  r.dirty = false;
  return writeJson(boardFile(r.id), snapshot)
    // Флаг снимаем только при успехе: иначе одна неудачная запись молча
    // выключала бы сохранение доски до конца её жизни.
    .catch(e => { r.dirty = true; console.error('save', r.id, e.message); });
}
setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    if (r.dirty) persist(r);
    if (!r.clients.size && now - r.touched > IDLE_UNLOAD) { collectOrphanFiles(r.id); rooms.delete(r.id); }
  }
}, SAVE_EVERY);

/** «Изменена» берём из mtime файла содержимого: раньше на каждый штрих
    перечитывался и переписывался индекс всех учителей разом. */
const contentMtime = id =>
  fsp.stat(boardFile(id)).then(s => s.mtimeMs).catch(() => 0);

/* ═══════════════ HTTP ═══════════════ */
const MIME = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'
};
const IMAGE_EXT = { 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif' };

const BOARD_QUOTA = 200 * 1024 * 1024;     // картинок на одну доску

/* Раз аутентификация переехала в куку, появился межсайтовый риск: чужая
   страница может послать запрос от имени вошедшего. SameSite=Lax закрывает
   основное, проверка Origin — остальное, и стоит она копейки. */
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const o = req.headers.origin;
  if (!o) return false;                    // curl и серверные вызовы Origin не шлют
  return o !== 'http://' + req.headers.host && o !== 'https://' + req.headers.host;
}

const jsonBody = async req =>
  JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* Попытки входа: свой счётчик, чтобы не выжигать общий лимит Supabase по IP
   (доска для него — один адрес на всех). */
const attempts = new Map();
function loginBlocked(key) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (Date.now() > a.until) { attempts.delete(key); return 0; }
  return a.n >= 5 ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
function loginFailed(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n++; a.until = Date.now() + 15 * 60 * 1000;
  attempts.set(key, a);
}

/** Общий вход в сессию: обменяли токены — поставили куку. */
async function startSession(req, res, tokens, redirect) {
  const s = await session.createUser(tokens);
  const head = { 'set-cookie': session.cookieFor(req, s.sid), 'cache-control': 'no-store' };
  if (redirect) { res.writeHead(302, { ...head, location: redirect }); return res.end(); }
  head['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(200, head);
  res.end(JSON.stringify({ user: publicUser(s) }));
}

const publicUser = s => s && s.kind === 'user'
  ? { id: s.uid, name: s.fullName, email: s.email, role: s.role }
  : null;

/* Одноразовые тикеты SSO. Живут в памяти: 60 секунд, один раз, и mcko-app
   всегда рядом — переживать перезапуск им незачем. */
const tickets = new Map();
const SSO_SECRET = process.env.DOSKA_SSO_SECRET || '';
/* Адрес mcko-app. Нужен ровно для одного: человек пришёл по ссылке на доску,
   своей сессии у него тут нет — вместо формы входа отправляем его в mcko-app,
   и если он там уже вошёл, то вернётся сюда уже с сессией и ничего не вводя. */
const MCKO_URL = (process.env.MCKO_URL || '').replace(/\/+$/, '');
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.until < now) tickets.delete(k);
}, 30000).unref();

/* ═══════════════ HTTP: обработчики ═══════════════ */

async function handleAuth(req, res, url, p) {
  if (p === '/api/auth/me') {
    const s = await session.fromRequest(req);
    if (!s) return reply(res, 401, { error: 'не авторизовано' });
    if (s.kind === 'guest')
      return reply(res, 200, { guest: { boardId: s.boardId, level: s.level, name: s.name } });
    return reply(res, 200, { user: publicUser(s) });
  }

  if (p === '/api/auth/login') {
    if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
    if (!gotrue.configured()) return reply(res, 503, { error: 'вход не настроен на сервере' });
    const b = await jsonBody(req);
    const email = str(b.email, 200).toLowerCase();
    const password = String(b.password || '');
    if (!email || !password) return reply(res, 400, { error: 'нужны почта и пароль' });

    const ip = req.socket.remoteAddress || '?';
    for (const key of [ip, email]) {
      const wait = loginBlocked(key);
      if (wait) return reply(res, 429, { error: 'слишком много попыток, подождите ' + wait + ' с' });
    }
    try {
      const tokens = await gotrue.signInWithPassword(email, password);
      attempts.delete(ip); attempts.delete(email);
      return startSession(req, res, tokens);
    } catch (e) {
      if (e.transport) return reply(res, 503, { error: 'сервис входа недоступен, попробуйте позже' });
      loginFailed(ip); loginFailed(email);
      return reply(res, 401, { error: 'неверная почта или пароль' });
    }
  }

  if (p === '/api/auth/logout') {
    if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
    const sid = session.sidFrom(req);
    if (sid) await session.destroy(sid, { revoke: true });
    res.writeHead(200, { 'set-cookie': session.clearCookie(req),
                         'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true }));
  }
  return reply(res, 404, { error: 'нет такого метода' });
}

/* Вход по ссылке из mcko-app. hashed_token приходит серверным вызовом и
   меняется на короткий тикет — в браузер уходит только он, а не полноценный
   ключ от аккаунта, который иначе осел бы в истории и в Referer. */
async function handleSso(req, res, url, p) {
  if (p === '/api/sso/ticket') {
    if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
    if (!SSO_SECRET) return reply(res, 503, { error: 'SSO не настроен' });
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const a = Buffer.from(given), b = Buffer.from(SSO_SECRET);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return reply(res, 401, { error: 'не тот ключ' });

    const body = await jsonBody(req);
    const hash = str(body.hashed_token, 512);
    if (!hash) return reply(res, 400, { error: 'нет hashed_token' });
    if (tickets.size > 1000) return reply(res, 503, { error: 'слишком много запросов' });
    const ticket = rnd(32);
    tickets.set(ticket, { hash, until: Date.now() + 60 * 1000 });
    return reply(res, 200, { ticket, expires_in: 60 });
  }

  if (p === '/sso') {
    const ticket = url.searchParams.get('ticket') || '';
    const boardId = url.searchParams.get('b') || '';
    const dest = okId(boardId) ? '/board/' + boardId : '/';
    const rec = tickets.get(ticket);
    tickets.delete(ticket);                              // строго один раз
    if (!rec || rec.until < Date.now()) {
      res.writeHead(302, { location: '/login?e=ticket' });
      return res.end();
    }
    try {
      const tokens = await gotrue.verifyTokenHash(rec.hash);
      return startSession(req, res, tokens, dest);
    } catch (e) {
      console.error('sso', e.message);
      res.writeHead(302, { location: '/login?e=' + (e.transport ? 'offline' : 'ticket') });
      return res.end();
    }
  }
  return reply(res, 404, { error: 'нет такого метода' });
}

/** Гость меняет токен из ссылки на обычную сессию доски. Кука нужна именно
    как кука: <img> не умеет слать заголовки, а картинки тоже под защитой. */
async function handleGuestEnter(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
  const b = await jsonBody(req);
  const boardId = str(b.board, 40);
  const token = str(b.g, 64);
  const name = str(b.name, 24);
  if (!okId(boardId) || !token) return reply(res, 400, { error: 'плохая ссылка' });

  let row;
  try { row = await db.guestOpen(boardId, token); }
  catch (e) { return reply(res, e.transport ? 503 : 400, { error: e.message }); }
  if (!row) return reply(res, 403, { error: 'ссылка недействительна' });

  const guestId = 'g:' + (/^[A-Za-z0-9_-]{8,32}$/.test(str(b.guestId, 32)) ? str(b.guestId, 32) : rnd(16));
  const s = await session.createGuest({ boardId, level: row.access, guestId, name });
  const r = await loadRoom(boardId);
  applyMeta(r, { title: row.title, owner_id: r.ownerId, locked: row.locked,
                 object_edit_policy: row.object_edit_policy });
  res.writeHead(200, { 'set-cookie': session.cookieFor(req, s.sid),
                       'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  return res.end(JSON.stringify({ guest: { boardId, level: row.access, name }, title: row.title }));
}

/* ─── доски ─── */

async function handleBoards(req, res, url, p) {
  const s = await session.fromRequest(req);
  if (!s || s.kind !== 'user') return reply(res, 401, { error: 'не авторизовано' });
  const token = await session.accessToken(s);
  if (!token) return reply(res, 401, { error: 'сессия истекла' });

  const seg = p.split('/').filter(Boolean);      // api, boards, [id], [участок], [uid]
  const id = seg[2] || '';

  /* GET /api/boards — список */
  if (!id) {
    if (req.method === 'GET') {
      const rows = await db.listBoards(token);
      const out = await Promise.all(rows.map(async b => ({
        id: b.id, title: b.title, locked: b.locked,
        guestAccess: b.guest_access, objectEditPolicy: b.object_edit_policy,
        mine: b.owner_id === s.uid,
        ownerName: b.owner && b.owner.full_name || null,
        created: Date.parse(b.created_at) || 0,
        updated: Math.max(Date.parse(b.updated_at) || 0, await contentMtime(b.id))
      })));
      out.sort((a, b) => b.updated - a.updated);
      return reply(res, 200, { boards: out, you: publicUser(s) });
    }
    if (req.method === 'POST') {
      if (s.role !== 'teacher') return reply(res, 403, { error: 'доски создаёт преподаватель' });
      const b = await jsonBody(req);
      const title = str(b.title, 80) || 'Новая доска';
      const row = await db.createBoard(token, { id: 'b' + rnd(10), owner_id: s.uid, title });
      const r = await loadRoom(row.id);
      applyMeta(r, row); persist(r);
      return reply(res, 200, { board: { id: row.id, title: row.title, mine: true } });
    }
    return reply(res, 405, { error: 'не тот метод' });
  }

  if (!okId(id)) return reply(res, 400, { error: 'плохой id доски' });
  const { cap, board } = await cap_.resolve(s, id, { fresh: true });
  if (cap === 'none') return reply(res, 404, { error: 'доска не найдена' });
  const owner = cap === 'owner';
  const part = seg[3] || '';

  /* PATCH/DELETE /api/boards/:id */
  if (!part) {
    if (req.method === 'GET') return reply(res, 200, { board, cap });
    if (!owner) return reply(res, 403, { error: 'только владелец' });

    if (req.method === 'PATCH') {
      const b = await jsonBody(req);
      const patch = {};
      if ('title' in b) patch.title = str(b.title, 80) || board.title;
      if ('locked' in b) patch.locked = !!b.locked;
      if ('guest_access' in b && ['none', 'view', 'edit'].includes(b.guest_access))
        patch.guest_access = b.guest_access;
      if ('object_edit_policy' in b && ['creator', 'anyone'].includes(b.object_edit_policy))
        patch.object_edit_policy = b.object_edit_policy;
      if (!Object.keys(patch).length) return reply(res, 400, { error: 'нечего менять' });

      const row = await db.patchBoard(token, id, patch);
      const r = await loadRoom(id);
      applyMeta(r, row);
      cap_.invalidate(id);
      if ('title' in patch) broadcast(r, { t: 'title', title: r.title });
      if ('locked' in patch) broadcast(r, { t: 'lock', on: r.locked });
      if ('object_edit_policy' in patch) broadcast(r, { t: 'policy', anyEdit: r.anyEdit });
      if (patch.guest_access === 'none') await db.dropGuestLink(token, id).catch(() => {});
      return reply(res, 200, { board: row });
    }

    if (req.method === 'DELETE') {
      await db.softDeleteBoard(token, id);
      cap_.invalidate(id);
      const r = rooms.get(id);
      if (r) { for (const c of r.clients) c.close(4004, 'доска удалена'); rooms.delete(id); }
      await fsp.unlink(boardFile(id)).catch(() => {});
      await fsp.rm(path.join(DIR.files, id), { recursive: true, force: true }).catch(() => {});
      return reply(res, 200, { ok: true });
    }
    return reply(res, 405, { error: 'не тот метод' });
  }

  /* /api/boards/:id/participants[/:uid] */
  if (part === 'participants') {
    if (req.method === 'GET') {
      if (!owner) return reply(res, 403, { error: 'только владелец' });
      const rows = await db.listParticipants(token, id);
      return reply(res, 200, { participants: rows.map(r => ({
        id: r.user_id, access: r.access,
        name: r.profile && r.profile.full_name || null,
        grade: r.profile && r.profile.grade || null
      })) });
    }
    if (!owner) return reply(res, 403, { error: 'только владелец' });
    const uid = seg[4] || '';

    if (req.method === 'POST') {
      const b = await jsonBody(req);
      const who = str(b.user_id, 64);
      const access = b.access === 'view' ? 'view' : 'edit';
      if (!who) return reply(res, 400, { error: 'не указан ученик' });
      try {
        await db.addParticipant(token, id, who, access, s.uid);
      } catch (e) {
        // 42501 — политика: значит это не его ученик
        if (e.status === 403 || e.code === '42501')
          return reply(res, 403, { error: 'этот ученик не закреплён за вами' });
        if (e.code === '23505') return reply(res, 200, { ok: true });
        throw e;
      }
      cap_.invalidate(id);
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'PATCH' && uid) {
      const b = await jsonBody(req);
      await db.setParticipantAccess(token, id, uid, b.access === 'view' ? 'view' : 'edit');
      cap_.invalidate(id);
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && uid) {
      await db.removeParticipant(token, id, uid);
      cap_.invalidate(id);
      return reply(res, 200, { ok: true });
    }
    return reply(res, 405, { error: 'не тот метод' });
  }

  /* /api/boards/:id/guest-link */
  if (part === 'guest-link') {
    if (!owner) return reply(res, 403, { error: 'только владелец' });
    if (req.method === 'GET') {
      const link = await db.getGuestLink(token, id);
      return reply(res, 200, { token: link ? link.token : null });
    }
    if (req.method === 'POST') {                      // создать или перевыпустить
      const value = rnd(32);
      await db.setGuestLink(token, id, value);
      cap_.invalidate(id);
      return reply(res, 200, { token: value });
    }
    if (req.method === 'DELETE') {
      await db.dropGuestLink(token, id);
      cap_.invalidate(id);
      return reply(res, 200, { ok: true });
    }
    return reply(res, 405, { error: 'не тот метод' });
  }
  return reply(res, 404, { error: 'нет такого метода' });
}

/* ─── картинки ─── */

const dirSizes = new Map();
async function boardBytes(id) {
  const cached = dirSizes.get(id);
  if (cached && cached.until > Date.now()) return cached.n;
  const dir = path.join(DIR.files, id);
  let n = 0;
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (st) n += st.size;
  }
  dirSizes.set(id, { n, until: Date.now() + 60000 });
  return n;
}

async function handleUpload(req, res, url) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
  const id = url.searchParams.get('board') || '';
  if (!okId(id)) return reply(res, 400, { error: 'плохой id доски' });

  const s = await session.fromRequest(req);
  const { cap } = await cap_.resolve(s, id);
  // loadRoom, а не rooms.get: раньше загрузка отваливалась с 404 через полчаса
  // простоя комнаты, хотя доска никуда не девалась
  const room = await loadRoom(id);
  if (!cap_.mayEdit(cap, room.locked))
    return reply(res, cap === 'none' ? 403 : 403,
      { error: cap === 'none' ? 'нет доступа к доске' : 'доска закрыта преподавателем' });

  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = IMAGE_EXT[type];
  if (!ext) return reply(res, 415, { error: 'поддерживаются PNG, JPEG, WebP, GIF' });
  if (await boardBytes(id) > BOARD_QUOTA)
    return reply(res, 507, { error: 'на доске кончилось место под картинки' });

  let buf;
  try { buf = await readBody(req, MAX_UPLOAD); }
  catch { return reply(res, 413, { error: 'картинка больше 16 МБ' }); }
  if (!buf.length) return reply(res, 400, { error: 'пустой файл' });

  const dir = path.join(DIR.files, id);
  await fsp.mkdir(dir, { recursive: true });
  const name = Date.now().toString(36) + rnd(6) + ext;
  await fsp.writeFile(path.join(dir, name), buf);
  dirSizes.delete(id);
  return reply(res, 200, { url: '/files/' + id + '/' + name });
}

async function handleFile(req, res, p) {
  const parts = p.split('/').filter(Boolean);
  if (parts.length !== 3 || !okId(parts[1]) || !/^[a-zA-Z0-9._-]+$/.test(parts[2])) {
    res.writeHead(400); return res.end();
  }
  // Раньше картинки лежали в открытом доступе с годовым кэшем: увидел ссылку —
  // читаешь вечно. Теперь тот же вопрос о правах, что и на саму доску.
  const s = await session.fromRequest(req);
  const { cap } = await cap_.resolve(s, parts[1]);
  if (cap === 'none') { res.writeHead(403); return res.end(); }

  const file = path.join(DIR.files, parts[1], parts[2]);
  const buf = await fsp.readFile(file).catch(() => null);
  if (!buf) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'private, max-age=31536000, immutable'
  });
  res.end(buf);
}

/** Картинки, на которые больше никто не ссылается. Сутки отсрочки — потому
    что стёртую картинку ещё можно вернуть отменой. */
async function collectOrphanFiles(id) {
  const r = rooms.get(id);
  if (!r) return;
  const used = new Set(r.items.filter(i => i.type === 'image').map(i => i.url));
  const dir = path.join(DIR.files, id);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (used.has('/files/' + id + '/' + f)) continue;
    const p = path.join(dir, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) { await fsp.unlink(p).catch(() => {}); dirSizes.delete(id); }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && crossSite(req))
        return reply(res, 403, { error: 'межсайтовый запрос' });

      // единственное, что доска рассказывает о себе до входа
      if (p === '/api/config')         return reply(res, 200, { mcko: MCKO_URL || null });
      if (p.startsWith('/api/auth/'))  return await handleAuth(req, res, url, p);
      if (p === '/api/sso/ticket')     return await handleSso(req, res, url, p);
      if (p === '/api/guest/enter')    return await handleGuestEnter(req, res);
      if (p === '/api/upload')         return await handleUpload(req, res, url);
      if (p.startsWith('/api/boards')) return await handleBoards(req, res, url, p);

      if (p === '/api/students') {
        const s = await session.fromRequest(req);
        if (!s || s.kind !== 'user') return reply(res, 401, { error: 'не авторизовано' });
        const token = await session.accessToken(s);
        const rows = await db.listMyStudents(token);
        return reply(res, 200, { students: rows });
      }
      return reply(res, 404, { error: 'нет такого метода' });
    }

    if (p === '/sso') return await handleSso(req, res, url, p);
    if (p.startsWith('/files/')) return await handleFile(req, res, p);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : (e.transport ? 503 : 500);
    if (status >= 500) console.error(req.method, p, e.message);
    return reply(res, status, { error: e.message || 'ошибка сервера' });
  }

  /* --- статика --- */
  const rel = decodeURIComponent(p === '/' ? '/index.html' : p);
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([\\/])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, b2) => {
      if (e2) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(b2);
    });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                         'cache-control': 'no-cache' });
    res.end(buf);
  });
});

/* ═══════════════ WebSocket ═══════════════ */
/* noServer + свой обработчик upgrade: сессию надо достать из куки ДО того,
   как рукопожатие состоится, и заодно проверить Origin — SameSite куки на
   вебсокеты не распространяется, а значит чужая страница могла бы открыть
   сокет от имени вошедшего. */
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const COLORS = ['#2F80ED','#EB5757','#27AE60','#9B51E0','#F2994A','#00A3A3','#D64B9B'];
let seq = 0;

server.on('upgrade', async (req, socket, head) => {
  const host = req.headers.host, o = req.headers.origin;
  if (o && o !== 'http://' + host && o !== 'https://' + host) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  const s = await session.fromRequest(req).catch(() => null);
  if (!s) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.session = s;
    wss.emit('connection', ws, req);
  });
});

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcast(room, o, except) {
  const s = JSON.stringify(o);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(s);
}
const peerInfo = c => ({ id: c.me.sid, name: c.me.name, cap: c.me.cap, color: c.me.color });

function cleanStroke(s, by) {
  if (!Array.isArray(s.pts) || !s.pts.length) return null;
  return { id: String(s.id).slice(0, 48), by, type: s.type === 'marker' ? 'marker' : 'pen',
           color: String(s.color || '#1A1C20').slice(0, 24),
           size: Math.min(600, Math.max(0.2, +s.size || 2)),
           pts: s.pts.slice(0, 12000).map(a => [+a[0] || 0, +a[1] || 0, Math.max(0, Math.min(1, +a[2] || 0.5))]),
           locked: !!s.locked };
}
function cleanImage(im, by) {
  if (typeof im.url !== 'string' || !im.url.startsWith('/files/')) return null;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  return { id: String(im.id).slice(0, 48), by, type: 'image', url: im.url.slice(0, 200),
           x: num(im.x, 0), y: num(im.y, 0),
           w: Math.max(4, Math.min(40000, num(im.w, 200))),
           h: Math.max(4, Math.min(40000, num(im.h, 200))),
           rot: num(im.rot, 0),
           locked: !!im.locked };
}

/* общие поля стиля для фигур/линий (цвет, толщина, дэш, заливка) */
function cleanStyle(o) {
  return {
    color: String(o.color || '#1A1C20').slice(0, 24),
    size: Math.min(600, Math.max(0.1, +o.size || 2)),
    dash: [0, 1, 2].includes(+o.dash) ? +o.dash : 0,
    fill: typeof o.fill === 'string' ? o.fill.slice(0, 24) : null
  };
}
function cleanShape(s, by) {
  if (s.kind !== 'rect' && s.kind !== 'ellipse') return null;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  return { id: String(s.id).slice(0, 48), by, type: 'shape', kind: s.kind,
           x: num(s.x, 0), y: num(s.y, 0),
           w: Math.max(0.5, Math.min(40000, num(s.w, 100))),
           h: Math.max(0.5, Math.min(40000, num(s.h, 100))),
           rot: num(s.rot, 0),
           locked: !!s.locked,
           ...cleanStyle(s) };
}
const clampArrow = v => [0, 1, 2, 3].includes(+v) ? +v : 0;
function cleanPath(p, by) {
  if (!['line', 'polyline', 'curve', 'polygon'].includes(p.kind)) return null;
  if (!Array.isArray(p.pts)) return null;
  const minPts = p.kind === 'polygon' ? 3 : 2;
  const pts = p.pts.slice(0, 2000).map(a => [+a[0] || 0, +a[1] || 0]);
  if (pts.length < minPts) return null;
  return { id: String(p.id).slice(0, 48), by, type: 'path', kind: p.kind,
           pts, closed: p.kind === 'polygon',
           a1: clampArrow(p.a1), a2: clampArrow(p.a2),
           locked: !!p.locked,
           ...cleanStyle(p) };
}

/* реестр валидаторов по типу — новый тип регистрируется здесь один раз,
   вместо тернарника в add/restore. Незарегистрированный тип (штрихи,
   а также будущие типы до появления своего cleaner'а) идёт через cleanStroke. */
const CLEANERS = { image: cleanImage, shape: cleanShape, path: cleanPath };
const pick = type => CLEANERS[type] || cleanStroke;

/* PATCHABLE[type] — какие поля можно менять через 'move'; PATCH_CLAMP[type][key] —
   как провалидировать/зажать присланное значение (get текущее it для отката). */
const clampPts = (v, it) => {
  if (!Array.isArray(v) || !v.length) return it.pts;
  return v.slice(0, 12000).map(a => [+a[0] || 0, +a[1] || 0, Math.max(0, Math.min(1, +a[2] || 0.5))]);
};
const PATCH_CLAMP = {
  image: {
    x: (v, it) => Number.isFinite(+v) ? +v : it.x,
    y: (v, it) => Number.isFinite(+v) ? +v : it.y,
    w: (v, it) => Math.max(4, Math.min(40000, Number.isFinite(+v) ? +v : it.w)),
    h: (v, it) => Math.max(4, Math.min(40000, Number.isFinite(+v) ? +v : it.h)),
    rot: (v, it) => Number.isFinite(+v) ? +v : it.rot,
    locked: (v) => !!v
  },
  pen: {
    pts: clampPts,
    color: (v, it) => typeof v === 'string' ? v.slice(0, 24) : it.color,
    size: (v, it) => Number.isFinite(+v) ? Math.min(600, Math.max(0.2, +v)) : it.size,
    locked: (v) => !!v
  },
  shape: {
    x: (v, it) => Number.isFinite(+v) ? +v : it.x,
    y: (v, it) => Number.isFinite(+v) ? +v : it.y,
    w: (v, it) => Math.max(0.5, Math.min(40000, Number.isFinite(+v) ? +v : it.w)),
    h: (v, it) => Math.max(0.5, Math.min(40000, Number.isFinite(+v) ? +v : it.h)),
    rot: (v, it) => Number.isFinite(+v) ? +v : it.rot,
    color: (v, it) => typeof v === 'string' ? v.slice(0, 24) : it.color,
    size: (v, it) => Number.isFinite(+v) ? Math.min(600, Math.max(0.1, +v)) : it.size,
    dash: (v, it) => [0, 1, 2].includes(+v) ? +v : it.dash,
    fill: (v, it) => v === null ? null : (typeof v === 'string' ? v.slice(0, 24) : it.fill),
    locked: (v) => !!v
  },
  path: {
    pts: (v, it) => {
      if (!Array.isArray(v)) return it.pts;
      const minPts = it.kind === 'polygon' ? 3 : 2;
      const pts = v.slice(0, 2000).map(a => [+a[0] || 0, +a[1] || 0]);
      return pts.length >= minPts ? pts : it.pts;
    },
    color: (v, it) => typeof v === 'string' ? v.slice(0, 24) : it.color,
    size: (v, it) => Number.isFinite(+v) ? Math.min(600, Math.max(0.1, +v)) : it.size,
    dash: (v, it) => [0, 1, 2].includes(+v) ? +v : it.dash,
    fill: (v, it) => v === null ? null : (typeof v === 'string' ? v.slice(0, 24) : it.fill),
    a1: (v, it) => [0, 1, 2, 3].includes(+v) ? +v : it.a1,
    a2: (v, it) => [0, 1, 2, 3].includes(+v) ? +v : it.a2,
    locked: (v) => !!v
  }
};
PATCH_CLAMP.marker = PATCH_CLAMP.pen;
const PATCHABLE = Object.fromEntries(Object.entries(PATCH_CLAMP).map(([t, c]) => [t, Object.keys(c)]));

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.room = null;
  // sid — на сокет (курсоры, аватарки, две вкладки одного человека различимы),
  // uid — на человека: именно он попадает в поле by у объектов, поэтому
  // «стереть своё» переживает переподключение.
  ws.me = { sid: 'u' + (++seq) + Date.now().toString(36).slice(-3), uid: null,
            name: 'Гость', cap: 'none', color: COLORS[seq % COLORS.length] };

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      if (ws.room || !okId(String(m.room || ''))) return;
      const id = String(m.room);
      const s = ws.session;
      const { cap, board } = await cap_.resolve(s, id);
      if (cap === 'none') { send(ws, { t: 'denied' }); ws.close(4003, 'нет доступа'); return; }

      const room = await loadRoom(id);
      if (board) applyMeta(room, board);
      ws.room = room;
      ws.me.cap = cap;
      ws.me.uid = s.kind === 'guest' ? s.guestId : s.uid;
      // имя вошедшего берём из профиля mcko-app, а не с его слов
      ws.me.name = s.kind === 'user'
        ? (s.fullName || s.email || 'Преподаватель').slice(0, 24)
        : (String(m.name || s.name || 'Гость').trim().slice(0, 24) || 'Гость');

      room.clients.add(ws); room.touched = Date.now();
      // uid отдаём только самому себе: клиенту он нужен, чтобы понимать, какие
      // объекты его собственные, а остальным участникам знать его незачем
      send(ws, { t: 'init', you: { ...peerInfo(ws), uid: ws.me.uid },
                 title: room.title, locked: room.locked, anyEdit: room.anyEdit,
                 peers: [...room.clients].filter(c => c !== ws).map(peerInfo), items: room.items });
      broadcast(room, { t: 'peer', peer: peerInfo(ws) }, ws);
      console.log('[' + room.id + '] + ' + ws.me.name + ' (' + cap + ') → ' + room.clients.size);
      return;
    }

    const room = ws.room;
    if (!room) return;
    room.touched = Date.now();
    const owner = ws.me.cap === 'owner';
    const mayEdit = cap_.mayEdit(ws.me.cap, room.locked);
    const mine = it => owner || room.anyEdit || (it.by != null && it.by === ws.me.uid);

    switch (m.t) {
      case 'live':
        if (!mayEdit) return;
        broadcast(room, { t: 'live', by: ws.me.sid, sid: m.sid, from: m.from | 0,
                          pts: m.pts, kind: m.kind, color: m.color, size: m.size }, ws);
        return;

      case 'add': {
        if (!mayEdit) return;
        const src = m.item || {};
        const it = pick(src.type)(src, ws.me.uid);
        if (!it || room.items.some(x => x.id === it.id)) return;
        room.items.push(it);
        if (room.items.length > MAX_ITEMS) room.items.splice(0, 2000);
        room.dirty = true;
        broadcast(room, { t: 'add', item: it }, ws);
        return;
      }

      case 'move': {
        if (!mayEdit) return;
        const it = room.items.find(x => x.id === m.id);
        if (!it || !mine(it)) return;
        const allowed = PATCHABLE[it.type];
        if (!allowed) return;
        const clamp = PATCH_CLAMP[it.type];
        const wasLocked = !!it.locked;
        const applied = {};
        for (const k of allowed) {
          if (!(k in m)) continue;
          // заблокированный объект принимает только снятие замка — остальные
          // поля патча отбрасываются, иначе изменённый клиент мог бы игнорировать lock
          if (wasLocked && k !== 'locked') continue;
          applied[k] = clamp[k](m[k], it);
        }
        if (!Object.keys(applied).length) return;
        Object.assign(it, applied);
        room.dirty = true;
        broadcast(room, { t: 'move', id: it.id, ...applied }, ws);
        return;
      }

      case 'erase': {
        if (!mayEdit) return;
        const ids = new Set((m.ids || []).slice(0, 5000).map(String));
        const gone = [];
        room.items = room.items.filter(it => {
          if (!ids.has(it.id) || !mine(it) || it.locked) return true;
          gone.push(it.id); return false;
        });
        if (!gone.length) return;
        room.dirty = true;
        broadcast(room, { t: 'erase', ids: gone }, ws);
        return;
      }

      case 'restore': {
        if (!mayEdit || !Array.isArray(m.items)) return;
        const back = [];
        for (const src of m.items.slice(0, 800)) {
          const it = pick(src.type)(src, ws.me.uid);
          if (it && !room.items.some(x => x.id === it.id)) { room.items.push(it); back.push(it); }
        }
        if (!back.length) return;
        room.dirty = true;
        broadcast(room, { t: 'bulk', items: back }, ws);
        return;
      }

      case 'cursor':
        // курсор рисует и наблюдатель, но не тот, кого уже отключили от доски
        if (ws.me.cap === 'none') return;
        broadcast(room, { t: 'cursor', id: ws.me.sid, x: m.x, y: m.y }, ws);
        return;

      case 'view':
        if (!owner) return;
        broadcast(room, { t: 'view', cam: m.cam, w: m.w }, ws);
        return;

      case 'lock':
        if (!owner) return;
        room.locked = !!m.on; room.dirty = true;
        broadcast(room, { t: 'lock', on: room.locked });
        // в БД пишем мимо ответа: замок нужен здесь и сейчас, а строка доски
        // догонит — падение записи не должно ломать урок
        session.accessToken(ws.session)
          .then(t => db.patchBoard(t, room.id, { locked: room.locked }))
          .catch(e => console.error('lock', room.id, e.message));
        return;

      case 'clear':
        if (!owner) return;
        room.items = []; room.dirty = true;
        broadcast(room, { t: 'cleared' });
        return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    broadcast(room, { t: 'left', id: ws.me.sid });
    if (room.dirty) persist(room);
    console.log('[' + room.id + '] − ' + ws.me.name + ' → ' + room.clients.size);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

/* Права проверяются заново раз в минуту, а не на каждое сообщение: обработчик
   должен оставаться синхронным, иначе движок начнёт ждать сеть. Владелец убрал
   участника — тот отвалится в течение минуты, а не после конца урока. */
setInterval(async () => {
  for (const ws of wss.clients) {
    if (!ws.room || !ws.session) continue;
    let cap;
    try { ({ cap } = await cap_.resolve(ws.session, ws.room.id, { fresh: true })); }
    catch { continue; }                       // сбой связи прав не отнимает
    if (cap === ws.me.cap) continue;
    ws.me.cap = cap;
    if (cap === 'none') { send(ws, { t: 'denied' }); ws.close(4003, 'доступ отозван'); continue; }
    send(ws, { t: 'cap', cap });
    broadcast(ws.room, { t: 'peer', peer: peerInfo(ws) }, ws);
  }
}, 60000);

server.listen(PORT, () => {
  console.log('Доска: http://localhost:' + PORT);
  console.log('Данные: ' + DATA_DIR);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const r of rooms.values()) if (r.dirty) persist(r);
  console.log('\nсохранено, выход');
  process.exit(0);
});
