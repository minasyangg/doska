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

/* ═══════════════ вспомогательное ═══════════════ */
const okId    = s => /^[a-zA-Z0-9_-]{1,40}$/.test(s);
const okToken = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{16,64}$/.test(s);
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
    teacherKey: (saved && saved.teacherKey) || null,
    locked: !!(saved && saved.locked),
    clients: new Set(), dirty: false, touched: Date.now()
  };
  rooms.set(id, r);
  return r;
}
function persist(r) {
  r.dirty = false;
  writeJson(boardFile(r.id), { v: 2, title: r.title, teacherKey: r.teacherKey, locked: r.locked, items: r.items })
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
    if (!okToken(b.token)) return [400, { error: 'плохой токен' }];
    const idx = await readJson(indexFile(b.token), { boards: [] });
    return [200, { boards: idx.boards }];
  },

  async create(b) {
    if (!okToken(b.token)) return [400, { error: 'плохой токен' }];
    const idx = await readJson(indexFile(b.token), { boards: [] });
    if (idx.boards.length >= 500) return [400, { error: 'слишком много досок' }];
    const board = {
      id: 'b' + rnd(10), key: rnd(24),
      title: String(b.title || '').trim().slice(0, 80) || 'Новая доска',
      created: Date.now(), updated: Date.now()
    };
    idx.boards.unshift(board);
    await writeJson(indexFile(b.token), idx);
    const r = await loadRoom(board.id);
    r.teacherKey = board.key; r.title = board.title; persist(r);
    return [200, { board }];
  },

  async rename(b) {
    if (!okToken(b.token) || !okId(String(b.id || ''))) return [400, { error: 'плохие данные' }];
    const idx = await readJson(indexFile(b.token), { boards: [] });
    const rec = idx.boards.find(x => x.id === b.id);
    if (!rec) return [404, { error: 'доска не найдена' }];
    rec.title = String(b.title || '').trim().slice(0, 80) || rec.title;
    rec.updated = Date.now();
    await writeJson(indexFile(b.token), idx);
    const r = await loadRoom(b.id);
    r.title = rec.title; r.dirty = true;
    broadcast(r, { t: 'title', title: rec.title });
    return [200, { ok: true, title: rec.title }];
  },

  async remove(b) {
    if (!okToken(b.token) || !okId(String(b.id || ''))) return [400, { error: 'плохие данные' }];
    const idx = await readJson(indexFile(b.token), { boards: [] });
    const i = idx.boards.findIndex(x => x.id === b.id);
    if (i < 0) return [404, { error: 'доска не найдена' }];
    idx.boards.splice(i, 1);
    await writeJson(indexFile(b.token), idx);
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

  /* --- загрузка картинки: POST /api/upload?board=ID&key=KEY --- */
  if (p === '/api/upload') {
    if (req.method !== 'POST') return reply(res, 405, { error: 'нужен POST' });
    const id = url.searchParams.get('board') || '';
    if (!okId(id)) return reply(res, 400, { error: 'плохой id доски' });
    const room = rooms.get(id);
    if (!room) return reply(res, 404, { error: 'доска не открыта' });
    if (room.locked && url.searchParams.get('key') !== room.teacherKey)
      return reply(res, 403, { error: 'доска закрыта преподавателем' });
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
           pts: s.pts.slice(0, 12000).map(a => [+a[0] || 0, +a[1] || 0, Math.max(0, Math.min(1, +a[2] || 0.5))]) };
}
function cleanImage(im, by) {
  if (typeof im.url !== 'string' || !im.url.startsWith('/files/')) return null;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  return { id: String(im.id).slice(0, 48), by, type: 'image', url: im.url.slice(0, 200),
           x: num(im.x, 0), y: num(im.y, 0),
           w: Math.max(4, Math.min(40000, num(im.w, 200))),
           h: Math.max(4, Math.min(40000, num(im.h, 200))) };
}

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
      const key = typeof m.key === 'string' ? m.key.slice(0, 64) : '';
      if (!room.teacherKey && key) { room.teacherKey = key; room.dirty = true; }
      ws.me.role = key && key === room.teacherKey ? 'teacher' : 'student';
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
        const it = src.type === 'image' ? cleanImage(src, ws.me.id) : cleanStroke(src, ws.me.id);
        if (!it || room.items.some(x => x.id === it.id)) return;
        room.items.push(it);
        if (room.items.length > MAX_ITEMS) room.items.splice(0, 2000);
        room.dirty = true; touchIndex(room.id);
        broadcast(room, { t: 'add', item: it }, ws);
        return;
      }

      case 'move': {
        if (!mayEdit) return;
        const it = room.items.find(x => x.id === m.id && x.type === 'image');
        if (!it || !mine(it)) return;
        const num = (v, d) => Number.isFinite(+v) ? +v : d;
        it.x = num(m.x, it.x); it.y = num(m.y, it.y);
        it.w = Math.max(4, Math.min(40000, num(m.w, it.w)));
        it.h = Math.max(4, Math.min(40000, num(m.h, it.h)));
        room.dirty = true;
        broadcast(room, { t: 'move', id: it.id, x: it.x, y: it.y, w: it.w, h: it.h }, ws);
        return;
      }

      case 'erase': {
        if (!mayEdit) return;
        const ids = new Set((m.ids || []).slice(0, 5000).map(String));
        const gone = [];
        room.items = room.items.filter(it => {
          if (!ids.has(it.id) || !mine(it)) return true;
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
          const it = src.type === 'image' ? cleanImage(src, ws.me.id) : cleanStroke(src, ws.me.id);
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
