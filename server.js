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
const store   = require('./lib/store');        // журнал операций и снимки досок
const pt      = require('./lib/points');       // точки в памяти лежат плотно
const cap_    = require('./lib/capability');   // с подчёркиванием: cap занято под уровень доступа

const PORT     = process.env.PORT || 8080;
const PUBLIC   = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR = {
  boards:   path.join(DATA_DIR, 'boards'),
  files:    path.join(DATA_DIR, 'files'),
  sessions: path.join(DATA_DIR, 'sessions'),
  // удалённые доски не стираются, а уезжают сюда: в базе строка тоже лишь
  // помечается удалённой, и содержимое должно вести себя так же
  trash:    path.join(DATA_DIR, 'trash')
};
for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });
session.init(DIR.sessions);
store.init(DIR);

/* Потолок объектов на доску. Из окружения — чтобы проверять поведение на
   переполнении, не рисуя восемьдесят тысяч штрихов. */
const MAX_ITEMS   = Math.max(10, +process.env.MAX_ITEMS || 80000);
const MAX_UPLOAD  = 16 * 1024 * 1024;      // 16 МБ на картинку
const SAVE_EVERY  = 4000;
const IDLE_UNLOAD = 30 * 60 * 1000;

/* ═══════════════ вспомогательное ═══════════════ */
const okId    = s => /^[a-zA-Z0-9_-]{1,40}$/.test(s);
const rnd     = n => crypto.randomBytes(n * 2).toString('base64url').slice(0, n);

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
/* На диске лежит только содержимое: объекты холста, журналом операций со
   снимками — см. lib/store.js. Владелец, заголовок, замок и правила доступа
   живут в БД mcko-app (041_doska_boards.sql) и приезжают сюда через
   applyMeta() — файл их лишь кэширует, чтобы комната могла подняться, пока БД
   отвечает. */
const rooms = new Map();

async function loadRoom(id) {
  let r = rooms.get(id);
  if (r) return r;
  const saved = await store.load(id);
  r = {
    id,
    title: saved.title || 'Без названия',
    items: saved.items,
    ownerId: saved.ownerId || null,
    locked: !!saved.locked,
    anyEdit: !!saved.anyEdit,
    clients: new Set(), touched: Date.now()
  };

  // До v4 поле by хранило идентификатор СОКЕТА, а не человека: после
  // переподключения автор терял права на собственные штрихи. Новых владельцев
  // взять неоткуда, поэтому старое содержимое закрепляем за владельцем доски —
  // он и так может всё, а чужого у него не прибавится.
  if ((saved.v || 0) < 4 && r.items.length) {
    for (const it of r.items) it.by = r.ownerId || null;
    await store.snapshot(id, r);          // переписываем сразу, не полагаясь на журнал
    console.log('[' + id + '] содержимое переведено в v' + store.SNAP_V + ' (' + r.items.length + ' объектов)');
  }

  rooms.set(id, r);
  return r;
}

/** Изменение содержимого: в память и тут же строкой в журнал. Стоимость —
    размер правки, а не размер доски. */
function record(r, op) {
  store.append(r.id, op);
}

/** Метаданные из БД перекрывают файловый кэш — источник правды один. */
function applyMeta(r, row) {
  if (!row) return r;
  const anyEdit = row.object_edit_policy === 'anyone';
  if (r.title !== row.title || r.ownerId !== row.owner_id ||
      r.locked !== !!row.locked || r.anyEdit !== anyEdit) {
    r.title = row.title; r.ownerId = row.owner_id;
    r.locked = !!row.locked; r.anyEdit = anyEdit;
    record(r, { t: 'meta', title: r.title, ownerId: r.ownerId, locked: r.locked, anyEdit: r.anyEdit });
  }
  return r;
}

setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    // снимок делается редко — только когда журнал перерос порог; в остальное
    // время это просто досброс накопленных строк
    store.maybeSnapshot(r.id, r).catch(() => {});
    if (!r.clients.size && now - r.touched > IDLE_UNLOAD) {
      collectOrphanFiles(r.id);
      rooms.delete(r.id);
      store.closeRoom(r.id, r).catch(e => console.error('выгрузка', r.id, e.message));
    }
  }
}, SAVE_EVERY);

// корзина: раз в сутки убираем то, что пролежало месяц
setInterval(() => store.sweepTrash().catch(() => {}), 24 * 3600 * 1000).unref();
store.sweepTrash().catch(() => {});

/** «Изменена» берём из mtime файлов содержимого: раньше на каждый штрих
    перечитывался и переписывался индекс всех учителей разом. */
const contentMtime = id => store.mtime(id);

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
      applyMeta(r, row);
      await store.snapshot(row.id, r);      // у новой доски сразу есть снимок

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
      // В корзину, а не в небытие: в базе строка тоже лишь помечается
      // удалённой. Раньше здесь стирались и содержимое, и картинки — «мягкое»
      // удаление на деле было необратимым.
      const where = await store.trash(id);
      console.log('[' + id + '] удалена, содержимое в корзине: ' + where);
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

  // Имя файла — отпечаток содержимого. Один и тот же скриншот, вставленный
  // дважды (а так и бывает: разобрали задачу, вернулись к ней через десять
  // минут), ложится одним файлом. На боевом сервере из четырёх картинок две
  // оказались копиями.
  const name = crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 22) + ext;
  const file = path.join(dir, name);
  const href = '/files/' + id + '/' + name;

  const had = await fsp.stat(file).then(() => true).catch(() => false);
  if (!had) {
    // временный файл и переименование: иначе второй участник может успеть
    // прочитать наполовину записанную картинку
    const tmp = file + '.' + rnd(6) + '.tmp';
    try {
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    dirSizes.delete(id);
    // В журнал: сама картинка на доске появится отдельной операцией add, но
    // без этой строки журнал не знал бы, откуда взялся файл.
    record(room, { t: 'img', url: href, bytes: buf.length });
  }
  return reply(res, 200, { url: href, dedup: had });
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

/* Признак принадлежности к группе: общий для всех типов. Пустая строка и
   мусор превращаются в null — «сам по себе». */
const clampGroup = v => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 48) : null;

function cleanStroke(s, by) {
  if (!Array.isArray(s.pts) || !s.pts.length) return null;
  const src = s.pts.slice(0, 12000);
  const pts = new Float32Array(src.length * 3);
  for (let i = 0; i < src.length; i++) {
    const a = src[i] || [], o = i * 3;
    pts[o] = +a[0] || 0;
    pts[o + 1] = +a[1] || 0;
    pts[o + 2] = Math.max(0, Math.min(1, +a[2] || 0.5));
  }
  return { id: String(s.id).slice(0, 48), by, type: s.type === 'marker' ? 'marker' : 'pen',
           color: String(s.color || '#1A1C20').slice(0, 24),
           size: Math.min(600, Math.max(0.2, +s.size || 2)),
           pts,
           g: clampGroup(s.g),
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
           // картинки рисуются под записями, чтобы вставленный снимок не закрыл
           // написанное. front поднимает конкретную картинку поверх — но только
           // если человек попросил об этом явно
           front: !!im.front,
           g: clampGroup(im.g),
           locked: !!im.locked };
}

/* Надпись на доске. w — ширина, по которой переносятся строки; высота
   считается при отрисовке, хранить её незачем. size — кегль в единицах доски. */
function cleanText(t, by) {
  const body = String(t.text == null ? '' : t.text).slice(0, 4000);
  if (!body.trim()) return null;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  return { id: String(t.id).slice(0, 48), by, type: 'text',
           text: body,
           x: num(t.x, 0), y: num(t.y, 0),
           w: Math.max(24, Math.min(20000, num(t.w, 240))),
           rot: num(t.rot, 0),
           color: String(t.color || '#1A1C20').slice(0, 24),
           size: Math.min(400, Math.max(6, num(t.size, 24))),
           bold: !!t.bold, italic: !!t.italic,
           g: clampGroup(t.g),
           locked: !!t.locked };
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
/* Виды фигур. Список общий с клиентом (каталог SHAPES в index.html): здесь он
   нужен, чтобы на доску не попало то, чего доска не умеет нарисовать. */
const SHAPE_KINDS = new Set([
  'rect', 'triangle', 'rtriangle', 'trapezoid', 'trapezoid2', 'parallelogram', 'rhombus',
  'pentagon', 'hexagon', 'octagon', 'star',
  'ellipse', 'roundrect', 'semicircle', 'quarter',
  'cube', 'cubeHidden', 'cylinder', 'box', 'pyramid', 'cone',
  'sphere', 'tetra', 'prism', 'octahedron', 'frustum', 'frustcone',
]);

function cleanShape(s, by) {
  if (!SHAPE_KINDS.has(s.kind)) return null;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  return { id: String(s.id).slice(0, 48), by, type: 'shape', kind: s.kind,
           x: num(s.x, 0), y: num(s.y, 0),
           w: Math.max(0.5, Math.min(40000, num(s.w, 100))),
           h: Math.max(0.5, Math.min(40000, num(s.h, 100))),
           rot: num(s.rot, 0),
           g: clampGroup(s.g),
           locked: !!s.locked,
           ...cleanStyle(s) };
}
const clampArrow = v => [0, 1, 2, 3].includes(+v) ? +v : 0;
function cleanPath(p, by) {
  if (!['line', 'polyline', 'curve', 'polygon'].includes(p.kind)) return null;
  if (!Array.isArray(p.pts)) return null;
  const minPts = p.kind === 'polygon' ? 3 : 2;
  const src = p.pts.slice(0, 2000);
  if (src.length < minPts) return null;
  return { id: String(p.id).slice(0, 48), by, type: 'path', kind: p.kind,
           pts: pt.pack(src, 2), closed: p.kind === 'polygon',
           a1: clampArrow(p.a1), a2: clampArrow(p.a2),
           g: clampGroup(p.g),
           locked: !!p.locked,
           ...cleanStyle(p) };
}

/* реестр валидаторов по типу — новый тип регистрируется здесь один раз,
   вместо тернарника в add/restore. Незарегистрированный тип (штрихи,
   а также будущие типы до появления своего cleaner'а) идёт через cleanStroke. */
const CLEANERS = { image: cleanImage, shape: cleanShape, path: cleanPath, text: cleanText };
const pick = type => CLEANERS[type] || cleanStroke;

/* PATCHABLE[type] — какие поля можно менять через 'move'; PATCH_CLAMP[type][key] —
   как провалидировать/зажать присланное значение (get текущее it для отката). */
const clampPts = (v, it) => {
  if (!Array.isArray(v) || !v.length) return it.pts;
  const src = v.slice(0, 12000);
  const out = new Float32Array(src.length * 3);
  for (let i = 0; i < src.length; i++) {
    const a = src[i] || [], o = i * 3;
    out[o] = +a[0] || 0;
    out[o + 1] = +a[1] || 0;
    out[o + 2] = Math.max(0, Math.min(1, +a[2] || 0.5));
  }
  return out;
};
/* Группа общая для всех типов: правится тем же 'move', что и остальное. */
const clampG = (v, it) => v === null ? null : (typeof v === 'string' ? clampGroup(v) : it.g);

const PATCH_CLAMP = {
  image: {
    g: clampG,
    // поднять картинку поверх записей можно только по прямой просьбе человека
    front: (v) => !!v,
    x: (v, it) => Number.isFinite(+v) ? +v : it.x,
    y: (v, it) => Number.isFinite(+v) ? +v : it.y,
    w: (v, it) => Math.max(4, Math.min(40000, Number.isFinite(+v) ? +v : it.w)),
    h: (v, it) => Math.max(4, Math.min(40000, Number.isFinite(+v) ? +v : it.h)),
    rot: (v, it) => Number.isFinite(+v) ? +v : it.rot,
    locked: (v) => !!v
  },
  pen: {
    g: clampG,
    pts: clampPts,
    color: (v, it) => typeof v === 'string' ? v.slice(0, 24) : it.color,
    size: (v, it) => Number.isFinite(+v) ? Math.min(600, Math.max(0.2, +v)) : it.size,
    locked: (v) => !!v
  },
  shape: {
    g: clampG,
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
  text: {
    g: clampG,
    text: (v, it) => typeof v === 'string' && v.slice(0, 4000).trim() ? v.slice(0, 4000) : it.text,
    x: (v, it) => Number.isFinite(+v) ? +v : it.x,
    y: (v, it) => Number.isFinite(+v) ? +v : it.y,
    w: (v, it) => Math.max(24, Math.min(20000, Number.isFinite(+v) ? +v : it.w)),
    rot: (v, it) => Number.isFinite(+v) ? +v : it.rot,
    color: (v, it) => typeof v === 'string' ? v.slice(0, 24) : it.color,
    size: (v, it) => Number.isFinite(+v) ? Math.min(400, Math.max(6, +v)) : it.size,
    bold: (v) => !!v,
    italic: (v) => !!v,
    locked: (v) => !!v
  },
  path: {
    g: clampG,
    pts: (v, it) => {
      if (!Array.isArray(v)) return it.pts;
      const minPts = it.kind === 'polygon' ? 3 : 2;
      const src = v.slice(0, 2000);
      return src.length >= minPts ? pt.pack(src, 2) : it.pts;
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
                 peers: [...room.clients].filter(c => c !== ws).map(peerInfo),
                 items: room.items.map(i => pt.wire(i)) });
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

        // Потолок объектов. Раньше при переполнении молча выбрасывались две
        // тысячи самых старых — то есть начало занятия исчезало, и человек
        // узнавал об этом, только пролистав наверх. Теперь доска не принимает
        // новое и говорит об этом: потерять написанное хуже, чем упереться.
        if (room.items.length >= MAX_ITEMS) {
          send(ws, { t: 'full', max: MAX_ITEMS });
          return;
        }
        room.items.push(it);
        const sent = pt.wire(it);
        record(room, { t: 'add', item: sent });
        broadcast(room, { t: 'add', item: sent }, ws);
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
        // заплатка тоже может нести точки — разворачиваем по шагу самого объекта
        const patch = pt.wire(applied, pt.strideOf(it));
        record(room, { t: 'move', id: it.id, ...patch });
        broadcast(room, { t: 'move', id: it.id, ...patch }, ws);
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
        record(room, { t: 'erase', ids: gone });
        broadcast(room, { t: 'erase', ids: gone }, ws);
        return;
      }

      case 'restore': {
        if (!mayEdit || !Array.isArray(m.items)) return;
        const back = [];
        for (const src of m.items.slice(0, 800)) {
          if (room.items.length >= MAX_ITEMS) { send(ws, { t: 'full', max: MAX_ITEMS }); break; }
          const it = pick(src.type)(src, ws.me.uid);
          if (it && !room.items.some(x => x.id === it.id)) { room.items.push(it); back.push(it); }
        }
        if (!back.length) return;
        const sentBack = back.map(i => pt.wire(i));
        record(room, { t: 'bulk', items: sentBack });
        broadcast(room, { t: 'bulk', items: sentBack }, ws);
        return;
      }

      /* Порядок слоёв. Кто выше кого, решает место в массиве: рисуем по
         порядку. Двигаем только то, что человеку и так позволено трогать, —
         иначе через слои можно было бы переставлять чужое. */
      case 'z': {
        if (!mayEdit) return;
        const ids = new Set((m.ids || []).slice(0, 5000).map(String));
        if (!ids.size) return;
        const toFront = m.to !== 'back';
        const picked = [], rest = [];
        for (const it of room.items) {
          (ids.has(it.id) && mine(it) && !it.locked ? picked : rest).push(it);
        }
        if (!picked.length) return;
        room.items = toFront ? rest.concat(picked) : picked.concat(rest);
        const moved = picked.map(x => x.id);
        record(room, { t: 'z', ids: moved, to: toFront ? 'front' : 'back' });
        // отправителю тоже: часть объектов могла не пройти (чужие, запертые),
        // и без ответа его порядок разошёлся бы с общим
        broadcast(room, { t: 'z', ids: moved, to: toFront ? 'front' : 'back' });
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

      /* «Все ко мне»: преподаватель разово переносит участников к тому месту,
         где объясняет. От 'view' отличается тем, что применяется независимо от
         того, включил ли участник слежение. */
      case 'callAll':
        if (!owner) return;
        broadcast(room, { t: 'goto', cam: m.cam, w: m.w }, ws);
        return;

      case 'lock':
        if (!owner) return;
        room.locked = !!m.on;
        record(room, { t: 'lock', on: room.locked });
        broadcast(room, { t: 'lock', on: room.locked });
        // в БД пишем мимо ответа: замок нужен здесь и сейчас, а строка доски
        // догонит — падение записи не должно ломать урок
        session.accessToken(ws.session)
          .then(t => db.patchBoard(t, room.id, { locked: room.locked }))
          .catch(e => console.error('lock', room.id, e.message));
        return;

      case 'clear':
        if (!owner) return;
        room.items = [];
        record(room, { t: 'clear' });
        broadcast(room, { t: 'cleared' });
        return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    broadcast(room, { t: 'left', id: ws.me.sid });
    // Ушёл последний — самое время уплотнить: следующая загрузка не будет
    // проигрывать журнал. Пока кто-то остался, хватит досброса строк.
    (room.clients.size ? store.flush(room.id) : store.snapshot(room.id, room))
      .catch(e => console.error('сохранение', room.id, e.message));
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

/* Выход по сигналу: дописываем журналы и снимаем снимки. Раньше здесь был
   синхронный по виду, но асинхронный по сути вызов persist — процесс успевал
   умереть раньше, чем запись доходила до диска. */
let leaving = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  if (leaving) return;
  leaving = true;
  try {
    await Promise.all([...rooms.values()].map(r => store.closeRoom(r.id, r)));
    console.log('\nсохранено, выход');
  } catch (e) {
    console.error('сохранение при выходе:', e.message);
  }
  process.exit(0);
});
