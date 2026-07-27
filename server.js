/* ============================================================
   Сервер доски v2
     · раздаёт клиент
     · держит список досок преподавателя
     · принимает загруженные картинки
     · синхронизирует комнаты по WebSocket
   Запуск: node server.js       (порт из PORT, по умолчанию 8080)
   ============================================================ */
'use strict';
const http = require('http');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT     = process.env.PORT || 8080;
const PUBLIC   = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR = {
  boards: path.join(DATA_DIR, 'boards'),
  files:  path.join(DATA_DIR, 'files'),
  index:  path.join(DATA_DIR, 'index')
};
for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });

const MAX_ITEMS   = 80000;
const MAX_UPLOAD  = 16 * 1024 * 1024;      // 16 МБ на картинку
const SAVE_EVERY  = 4000;
const IDLE_UNLOAD = 30 * 60 * 1000;

// общий с mcko-app Supabase-проект — используется только как поставщик
// личности учителя (см. README, раздел "Вход учителя"), не как БД для доски
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const USER_CACHE_TTL = 60 * 1000;
const userCache = new Map(); // access token -> { user, expires }

/* Проверяет Supabase access-токен через /auth/v1/user, кэширует результат на
   минуту, чтобы не дёргать Supabase на каждое WS-сообщение. Возвращает
   {id, email} проверенного пользователя или null (в т.ч. если проект не
   настроен через переменные окружения — тогда роль учителя недоступна). */
async function verifySupabaseUser(token) {
  if (!token || typeof token !== 'string' || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const cached = userCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.user;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !data.id) return null;
    const user = { id: data.id, email: data.email || null };
    userCache.set(token, { user, expires: Date.now() + USER_CACHE_TTL });
    return user;
  } catch { return null; }
}

/* ═══════════════ вспомогательное ═══════════════ */
const okId    = s => /^[a-zA-Z0-9_-]{1,40}$/.test(s);
const rnd     = n => crypto.randomBytes(n * 2).toString('base64url').slice(0, n);
const boardFile = id => path.join(DIR.boards, id + '.json');
const indexFile = tk => path.join(DIR.index, crypto.createHash('sha256').update(tk).digest('hex') + '.json');

const readJson = async (p, fallback) => {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, obj) => fsp.writeFile(p, JSON.stringify(obj));

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
const rooms = new Map();

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
    clients: new Set(), dirty: false, touched: Date.now()
  };
  rooms.set(id, r);
  return r;
}
function persist(r) {
  r.dirty = false;
  writeJson(boardFile(r.id), { v: 3, title: r.title, ownerId: r.ownerId, locked: r.locked, items: r.items })
    .catch(e => console.error('save', r.id, e.message));
}
setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    if (r.dirty) persist(r);
    if (!r.clients.size && now - r.touched > IDLE_UNLOAD) rooms.delete(r.id);
  }
}, SAVE_EVERY);

/* время последнего изменения — в список преподавателя */
async function touchIndex(boardId) {
  const files = await fsp.readdir(DIR.index).catch(() => []);
  for (const f of files) {
    const p = path.join(DIR.index, f);
    const idx = await readJson(p, null);
    if (!idx || !Array.isArray(idx.boards)) continue;
    const b = idx.boards.find(x => x.id === boardId);
    if (b) { b.updated = Date.now(); await writeJson(p, idx); return; }
  }
}

/* ═══════════════ HTTP ═══════════════ */
const MIME = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'
};
const IMAGE_EXT = { 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif' };

const api = {
  async list(b) {
    const user = await verifySupabaseUser(b.token);
    if (!user) return [401, { error: 'не авторизовано' }];
    const idx = await readJson(indexFile(user.id), { boards: [] });
    return [200, { boards: idx.boards }];
  },

  async create(b) {
    const user = await verifySupabaseUser(b.token);
    if (!user) return [401, { error: 'не авторизовано' }];
    const idx = await readJson(indexFile(user.id), { boards: [] });
    if (idx.boards.length >= 500) return [400, { error: 'слишком много досок' }];
    const board = {
      id: 'b' + rnd(10),
      title: String(b.title || '').trim().slice(0, 80) || 'Новая доска',
      created: Date.now(), updated: Date.now()
    };
    idx.boards.unshift(board);
    await writeJson(indexFile(user.id), idx);
    const r = await loadRoom(board.id);
    r.ownerId = user.id; r.title = board.title; persist(r);
    return [200, { board }];
  },

  async rename(b) {
    const user = await verifySupabaseUser(b.token);
    if (!user || !okId(String(b.id || ''))) return [400, { error: 'плохие данные' }];
    const idx = await readJson(indexFile(user.id), { boards: [] });
    const rec = idx.boards.find(x => x.id === b.id);
    if (!rec) return [404, { error: 'доска не найдена' }];
    rec.title = String(b.title || '').trim().slice(0, 80) || rec.title;
    rec.updated = Date.now();
    await writeJson(indexFile(user.id), idx);
    const r = await loadRoom(b.id);
    r.title = rec.title; r.dirty = true;
    broadcast(r, { t: 'title', title: rec.title });
    return [200, { ok: true, title: rec.title }];
  },

  async remove(b) {
    const user = await verifySupabaseUser(b.token);
    if (!user || !okId(String(b.id || ''))) return [400, { error: 'плохие данные' }];
    const idx = await readJson(indexFile(user.id), { boards: [] });
    const i = idx.boards.findIndex(x => x.id === b.id);
    if (i < 0) return [404, { error: 'доска не найдена' }];
    idx.boards.splice(i, 1);
    await writeJson(indexFile(user.id), idx);
    const r = rooms.get(b.id);
    if (r) { for (const c of r.clients) c.close(4004, 'доска удалена'); rooms.delete(b.id); }
    await fsp.unlink(boardFile(b.id)).catch(() => {});
    await fsp.rm(path.join(DIR.files, b.id), { recursive: true, force: true }).catch(() => {});
    return [200, { ok: true }];
  }
};
const API_ROUTES = { list: 'list', create: 'create', rename: 'rename', delete: 'remove' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  /* --- список досок --- */
  if (p.startsWith('/api/boards/')) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
    const fn = api[API_ROUTES[p.split('/')[3]] || ''];
    if (!fn) return reply(res, 404, { error: 'нет такого метода' });
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const [code, out] = await fn(body);
      return reply(res, code, out);
    } catch (e) { return reply(res, 400, { error: e.message }); }
  }

  /* --- загрузка картинки: POST /api/upload?board=ID&token=SUPABASE_JWT --- */
  if (p === '/api/upload') {
    if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
    const id = url.searchParams.get('board') || '';
    if (!okId(id)) return reply(res, 400, { error: 'плохой id доски' });
    const room = rooms.get(id);
    if (!room) return reply(res, 404, { error: 'доска не открыта' });
    if (room.locked) {
      const user = await verifySupabaseUser(url.searchParams.get('token'));
      if (!user || user.id !== room.ownerId) return reply(res, 403, { error: 'доска закрыта преподавателем' });
    }
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    const ext = IMAGE_EXT[type];
    if (!ext) return reply(res, 415, { error: 'поддерживаются PNG, JPEG, WebP, GIF' });
    let buf;
    try { buf = await readBody(req, MAX_UPLOAD); }
    catch { return reply(res, 413, { error: 'картинка больше 16 МБ' }); }
    if (!buf.length) return reply(res, 400, { error: 'пустой файл' });
    const dir = path.join(DIR.files, id);
    await fsp.mkdir(dir, { recursive: true });
    const name = Date.now().toString(36) + rnd(6) + ext;
    await fsp.writeFile(path.join(dir, name), buf);
    return reply(res, 200, { url: '/files/' + id + '/' + name });
  }

  /* --- отдача картинок --- */
  if (p.startsWith('/files/')) {
    const parts = p.split('/').filter(Boolean);
    if (parts.length !== 3 || !okId(parts[1]) || !/^[a-zA-Z0-9._-]+$/.test(parts[2])) {
      res.writeHead(400); return res.end();
    }
    const file = path.join(DIR.files, parts[1], parts[2]);
    return fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                           'cache-control': 'public, max-age=31536000, immutable' });
      res.end(buf);
    });
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
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
const COLORS = ['#2F80ED','#EB5757','#27AE60','#9B51E0','#F2994A','#00A3A3','#D64B9B'];
let seq = 0;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcast(room, o, except) {
  const s = JSON.stringify(o);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(s);
}
const peerInfo = c => ({ id: c.me.id, name: c.me.name, role: c.me.role, color: c.me.color });

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

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.room = null;
  ws.me = { id: 'u' + (++seq) + Date.now().toString(36).slice(-3), name: 'Гость',
            role: 'student', color: COLORS[seq % COLORS.length] };

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      if (ws.room || !okId(String(m.room || ''))) return;
      const room = await loadRoom(String(m.room));
      ws.room = room;
      ws.me.name = String(m.name || 'Гость').trim().slice(0, 24) || 'Гость';
      // роль проверяется один раз при подключении, не на каждое сообщение —
      // как и раньше, доска не переаутентифицирует середину сессии
      const token = typeof m.token === 'string' ? m.token.slice(0, 4096) : '';
      let role = 'student';
      if (token) {
        const user = await verifySupabaseUser(token);
        if (user) {
          // доска без владельца (например, созданная до этой миграции) —
          // первый вошедший с валидным токеном закрепляется как учитель
          if (!room.ownerId) { room.ownerId = user.id; room.dirty = true; }
          if (user.id === room.ownerId) role = 'teacher';
        }
      }
      ws.me.role = role;
      room.clients.add(ws); room.touched = Date.now();
      send(ws, { t: 'init', you: peerInfo(ws), title: room.title, locked: room.locked,
                 peers: [...room.clients].filter(c => c !== ws).map(peerInfo), items: room.items });
      broadcast(room, { t: 'peer', peer: peerInfo(ws) }, ws);
      console.log('[' + room.id + '] + ' + ws.me.name + ' (' + ws.me.role + ') → ' + room.clients.size);
      return;
    }

    const room = ws.room;
    if (!room) return;
    room.touched = Date.now();
    const teacher = ws.me.role === 'teacher';
    const mayEdit = teacher || !room.locked;
    const mine = it => teacher || it.by === ws.me.id;

    switch (m.t) {
      case 'live':
        if (!mayEdit) return;
        broadcast(room, { t: 'live', by: ws.me.id, sid: m.sid, from: m.from | 0,
                          pts: m.pts, kind: m.kind, color: m.color, size: m.size }, ws);
        return;

      case 'add': {
        if (!mayEdit) return;
        const src = m.item || {};
        const it = pick(src.type)(src, ws.me.id);
        if (!it || room.items.some(x => x.id === it.id)) return;
        room.items.push(it);
        if (room.items.length > MAX_ITEMS) room.items.splice(0, 2000);
        room.dirty = true; touchIndex(room.id);
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
          const it = pick(src.type)(src, ws.me.id);
          if (it && !room.items.some(x => x.id === it.id)) { room.items.push(it); back.push(it); }
        }
        if (!back.length) return;
        room.dirty = true;
        broadcast(room, { t: 'bulk', items: back }, ws);
        return;
      }

      case 'cursor':
        broadcast(room, { t: 'cursor', id: ws.me.id, x: m.x, y: m.y }, ws);
        return;

      case 'view':
        if (!teacher) return;
        broadcast(room, { t: 'view', cam: m.cam, w: m.w }, ws);
        return;

      case 'lock':
        if (!teacher) return;
        room.locked = !!m.on; room.dirty = true;
        broadcast(room, { t: 'lock', on: room.locked });
        return;

      case 'clear':
        if (!teacher) return;
        room.items = []; room.dirty = true;
        broadcast(room, { t: 'cleared' });
        return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    broadcast(room, { t: 'left', id: ws.me.id });
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

server.listen(PORT, () => {
  console.log('Доска: http://localhost:' + PORT);
  console.log('Данные: ' + DATA_DIR);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const r of rooms.values()) if (r.dirty) persist(r);
  console.log('\nсохранено, выход');
  process.exit(0);
});
