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
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const gotrue  = require('./lib/gotrue');
const db      = require('./lib/db');
const session = require('./lib/session');
const store   = require('./lib/store');        // журнал операций и снимки досок
const pt      = require('./lib/points');       // точки в памяти лежат плотно
const metrics = require('./lib/metrics');      // счётчики для мониторинга
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
/* Точки — главный вес доски: один объект несёт их до двенадцати тысяч, и
   потолка по объектам тут мало. Любой, кому можно писать, набирал гигабайт за
   минуту, процесс упирался в память и обрывал все занятия разом. Четыре
   миллиона — больше чем вдвое против самого тяжёлого замеренного занятия. */
const MAX_POINTS  = Math.max(10, +process.env.MAX_POINTS || 4000000);
/* Сколько человек на одной доске. Владельца потолок не касается: толпа по
   гостевой ссылке не должна запирать преподавателя снаружи его же доски. */
const MAX_PEERS   = Math.max(1, +process.env.MAX_PEERS || 50);
/* Предохранитель на весь процесс: потолки выше — на доску, а досок много.
   Меньше порога, по которому pm2 перезапускает процесс (600 МБ): лучше
   сказать «доска заполнена», чем оборвать всех. */
const MEM_LIMIT   = (+process.env.MEM_LIMIT_MB || 480) * 1024 * 1024;
const DISK_RESERVE = 300 * 1024 * 1024;    // столько оставляем журналам занятий
const MAX_UPLOAD  = 16 * 1024 * 1024;      // 16 МБ на картинку
const SAVE_EVERY  = 4000;
const IDLE_UNLOAD = 30 * 60 * 1000;
const JOIN_TIMEOUT_MS = +process.env.JOIN_TIMEOUT_MS || 15000;
const CAP_RECHECK_MS  = +process.env.CAP_RECHECK_MS || 60000;

/* ═══════════════ вспомогательное ═══════════════ */
const okId    = s => /^[a-zA-Z0-9_-]{1,40}$/.test(s);
const rnd     = n => crypto.randomBytes(n * 2).toString('base64url').slice(0, n);
const pointsOf = it => pt.isPacked(it.pts) ? pt.count(it.pts, pt.strideOf(it)) : 0;

/* Имя попадает в журнал построчно, а scripts/day-report.js читает журнал как
   данные: перевод строки в имени гостя дописал бы туда поддельный вход. */
const cleanName = (v, max) =>
  String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim().slice(0, max);

/* Автор объекта. Поле by уходит всем участникам, и раньше в нём лежал сам
   идентификатор: uid учётной записи или номер гостя. Номер гостя при этом
   служил ему паролем: увидел чужой, зашёл заново с ним же — и стираешь чужое.
   Теперь на проводе и на диске только отпечаток, свой на каждую доску: для
   «моё / не моё» этого хватает, а обратно из него ничего не получить. Секрет
   здесь не нужен, отпечаток ничего не открывает: кто ты, решает сессия. */
const isAuthor = v => typeof v === 'string' && v.startsWith('a_');
const authorOf = (roomId, uid) =>
  'a_' + crypto.createHash('sha256').update(roomId + '|' + uid).digest('base64url').slice(0, 22);

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

/* Одна загрузка на доску, даже если её просят разом.

   Между «в карте комнаты нет» и «положили в карту» стоит чтение с диска, а это
   await: пока оно идёт, в ту же функцию успевают войти обработчики других
   соединений — тоже не найти комнату и тоже начать загрузку. В карте оставалась
   последняя созданная, а ws.room у вошедших раньше указывал на осиротевшие
   копии. Видно это было ровно там, где больно: класс заходит по ссылке
   одновременно, часть учеников попадает в свою копию комнаты и не видит чужих
   штрихов, а её собственных не видит никто — при том, что доска у каждого
   выглядит рабочей.

   Поэтому здесь помнится незавершённое обещание: второй и все следующие
   получают его же, а не начинают свою загрузку. Тот же приём, что у обмена
   refresh-токена в lib/session.js. */
const loadingRooms = new Map();

function loadRoom(id) {
  const have = rooms.get(id);
  if (have) return Promise.resolve(have);
  const already = loadingRooms.get(id);
  if (already) return already;
  // set синхронный и попадает в карту раньше любого микротаска, поэтому
  // .finally не может стереть запись прежде, чем она там появится
  const p = loadRoomNow(id).finally(() => loadingRooms.delete(id));
  loadingRooms.set(id, p);
  return p;
}

async function loadRoomNow(id) {
  const saved = await store.load(id);
  const r = {
    id,
    title: saved.title || 'Без названия',
    items: saved.items,
    ownerId: saved.ownerId || null,
    locked: !!saved.locked,
    anyEdit: !!saved.anyEdit,
    clients: new Set(), touched: Date.now(),
    /* Курсоры и видимые области — не рассылаются сразу, а копятся здесь и
       уходят пачкой раз в CURSOR_FLUSH_MS (см. ниже, почему). Карта, а не
       список: за 50 мс один и тот же человек успевает прислать курсор
       дважды, и старое положение никому не нужно — важно последнее. */
    curs: new Map(), pres: new Map(), live: new Map(),
    /* Указатель «идентификатор → объект».

       Без него каждое действие искало объект перебором всего содержимого:
       перенос — по разу, возврат стёртого — по разу на каждый из восьмисот
       объектов. На занятии с 4500 объектами это вылилось в миллионы сравнений
       и задержку до 2.5 секунды — её и показал мониторинг. Теперь поиск
       мгновенный, а порядок слоёв по-прежнему держит сам массив. */
    byId: new Map(),
    points: 0
  };
  for (const it of r.items) { r.byId.set(it.id, it); r.points += pointsOf(it); }

  // До v4 поле by хранило идентификатор СОКЕТА, а не человека: после
  // переподключения автор терял права на собственные штрихи. Новых владельцев
  // взять неоткуда, поэтому старое содержимое закрепляем за владельцем доски —
  // он и так может всё, а чужого у него не прибавится.
  if ((saved.v || 0) < 4 && r.items.length) {
    for (const it of r.items) it.by = r.ownerId || null;
    await store.snapshot(id, r);          // переписываем сразу, не полагаясь на журнал
    console.log('[' + id + '] содержимое переведено в v' + store.SNAP_V + ' (' + r.items.length + ' объектов)');
  }

  // Доски, написанные до появления отпечатков (см. authorOf). По виду значения,
  // а не по версии снимка: в журнале могут лежать строки обоих поколений.
  let renamed = 0;
  for (const it of r.items) {
    if (it.by != null && !isAuthor(it.by)) { it.by = authorOf(id, it.by); renamed++; }
  }
  if (renamed) {
    await store.snapshot(id, r);
    console.log('[' + id + '] авторы заменены отпечатками: ' + renamed);
  }

  rooms.set(id, r);
  metrics.inc('doska_room_loads_total');
  return r;
}

/** Изменение содержимого: в память и тут же строкой в журнал. Стоимость —
    размер правки, а не размер доски. */
function record(r, op) {
  store.append(r.id, op);
  // содержимое изменилось — сжатая доска для входящих (см. sendInit) устарела
  r.ver = (r.ver | 0) + 1;
  r.initCache = null;
}

/** Метаданные из БД перекрывают файловый кэш — источник правды один. */
function applyMeta(r, row) {
  if (!row) return r;
  /* Кто может стирать чужое — больше не настройка, а правило: участник
     удаляет только своё, преподаватель — что угодно и всегда (см. mine() в
     обработчике сообщений: owner там стоит первым).

     Настройка была, и она путала. «Любой участник удаляет любое» звучит
     безобидно, пока на доске двое, а на группе означает, что чужую работу
     сотрут по неосторожности и без следа — отменить чужое стирание у себя
     нельзя. Столбец в базе остаётся (её мы не ломаем), но значения его
     больше не читаем: правило одно для всех досок, включая заведённые
     раньше с «любой удаляет любое». */
  const anyEdit = false;
  if (r.title !== row.title || r.ownerId !== row.owner_id ||
      r.locked !== !!row.locked || r.anyEdit !== anyEdit) {
    r.title = row.title; r.ownerId = row.owner_id;
    r.locked = !!row.locked; r.anyEdit = anyEdit;
    record(r, { t: 'meta', title: r.title, ownerId: r.ownerId, locked: r.locked, anyEdit: r.anyEdit });
  }
  return r;
}

/* Вес доски уточняем здесь, а не на каждом стирании: при добавлении счётчик
   растёт сразу, а обход заодно учитывает стёртое и прорежённое. */
function weigh(r) {
  if (r.weighed === (r.ver | 0)) return;
  r.weighed = r.ver | 0;
  let n = 0;
  for (const it of r.items) n += pointsOf(it);
  r.points = n;
}

let memTight = false, diskTight = false;

async function checkDisk() {
  try {
    const s = await fsp.statfs(DATA_DIR);
    // files == 0 там, где файловая система не считает файлы (Windows)
    diskTight = s.bavail * s.bsize < DISK_RESERVE || (s.files > 0 && s.ffree < 5000);
  } catch {}
}
setInterval(checkDisk, 30000).unref();
checkDisk();

setInterval(() => {
  const now = Date.now();
  const m = process.memoryUsage();
  const tight = m.heapUsed + m.external > MEM_LIMIT;
  if (tight !== memTight) console.error('память: ' + (tight ? 'предел, новое не принимаем' : 'снова в норме'));
  memTight = tight;
  for (const r of [...rooms.values()]) {
    weigh(r);
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

/* Сессии: то же самое, но чаще. Уборщик в lib/session.js был написан и
   экспортирован, а вызывать его забыли — файлы .sess копились с самого начала
   и удалялись только когда человек выходил сам. Внутри каждого лежат
   зашифрованные токены Supabase, то есть, по сути, ключ от учётной записи
   mcko-app: такому нечего лежать на диске годами после последнего входа.
   Сессия и так считается протухшей по IDLE_MAX при чтении — уборщик лишь
   доводит дело до конца для тех, кого больше никто не читает. */
setInterval(() => session.sweep().catch(e => console.error('уборка сессий', e.message)),
            6 * 3600 * 1000).unref();
session.sweep().catch(() => {});

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
/* Тип файла называет тот, кто его присылает. Проверяем по первым байтам, иначе
   доска становится бесплатным хранилищем чего угодно под видом картинки. */
const IMAGE_MAGIC = {
  '.png':  b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  '.jpg':  b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.gif':  b => b.toString('latin1', 0, 4) === 'GIF8',
  '.webp': b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

const BOARD_QUOTA = 200 * 1024 * 1024;     // картинок на одну доску

/* Заголовки защиты. Здесь, а не в Caddyfile: едут вместе с кодом, и новая
   копия сервиса получит их сама. CSP — главное: посторонний скрипт на странице
   не выполнится, даже если где-то пропустим экранирование.

   Стили разрешены встроенные: разметка держит их в <style> и в атрибутах.
   Скрипты — только свои файлы, встроенных в странице нет. */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res) {
  const host = String(req.headers.host || '');
  const secure = session.isSecure(req);
  // 'self' в старых Safari не покрывает сокет, поэтому адрес называем явно
  const sock = /^[A-Za-z0-9.:[\]-]+$/.test(host) ? ' ' + (secure ? 'wss://' : 'ws://') + host : '';
  res.setHeader('content-security-policy', CSP + "; connect-src 'self'" + sock);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  // в адресе доски лежит пропуск гостя — на чужие сайты он уходить не должен
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');
}

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

async function jsonBody(req) {
  let v;
  try { v = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('плохой запрос'), { status: 400 }); }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw Object.assign(new Error('плохой запрос'), { status: 400 });
  return v;
}
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* Настоящий адрес посетителя. За Caddy у каждого соединения адрес 127.0.0.1,
   и счётчик ошибок входа был один на всех: пять опечаток от кого угодно
   запирали вход всему сайту на четверть часа. Заголовки верим только за
   прокси (TRUST_PROXY): порт приложения снаружи не виден, а X-Real-IP Caddy
   выставляет сам, поверх присланного. */
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

/* Частота запросов, доступных без входа: ведро токенов на адрес. Запас с
   расчётом на класс за одним адресом, заходящий по ссылке разом. Иначе
   каждый вход гостя — файл сессии на диске и обращение к базе, и поток таких
   запросов забивал бы и то и другое. */
const hits = new Map();
const HITS_MAX = 20000;
function sweepHits() {
  const old = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of hits) if (b.at < old) hits.delete(k);
}
setInterval(sweepHits, 10 * 60 * 1000).unref();

function tooMany(req, name, perMin) {
  const key = name + '|' + clientIp(req), now = Date.now();
  let b = hits.get(key);
  if (!b) {
    if (hits.size >= HITS_MAX) sweepHits();
    if (hits.size >= HITS_MAX) return false;    // карта полна — не повод отказывать всем
    b = { n: perMin, at: now };
    hits.set(key, b);
  }
  b.n = Math.min(perMin, b.n + (now - b.at) * perMin / 60000);
  b.at = now;
  if (b.n < 1) { metrics.inc('doska_rate_limited_total'); return true; }
  b.n -= 1;
  return false;
}

/* Попытки входа: свой счётчик, чтобы не выжигать общий лимит Supabase по IP
   (доска для него — один адрес на всех).

   Ключей два — адрес и почта, — и почту называет тот, кто стучится. Записи
   стирались только в loginBlocked, и только если по этому же ключу приходил
   новый запрос уже после истечения срока. То есть перебор по случайным
   адресам почты наращивал карту, которую никто не разбирал: попыток по каждому
   такому ключу больше не будет, значит и повода удалить запись не возникнет
   никогда. Поэтому здесь и уборка по времени, и жёсткий потолок. */
const attempts = new Map();
const ATTEMPT_MAX = 20000;
function sweepAttempts() {
  const now = Date.now();
  for (const [k, a] of attempts) if (now > a.until) attempts.delete(k);
}
setInterval(sweepAttempts, 10 * 60 * 1000).unref();

// На почту строже: это подбор пароля. С одного адреса могут входить многие.
const LOGIN_PER_MAIL = 5, LOGIN_PER_IP = 20;

function loginBlocked(key, max) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (Date.now() > a.until) { attempts.delete(key); return 0; }
  return a.n >= max ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
function loginFailed(key) {
  const a = attempts.get(key);
  if (!a) {
    // Потолок проверяем только когда заводим новый ключ: уже начатый счёт
    // обязан дорасти до блокировки, иначе переполнение карты становится
    // способом эту блокировку обойти.
    if (attempts.size >= ATTEMPT_MAX) sweepAttempts();
    if (attempts.size >= ATTEMPT_MAX) return;
    attempts.set(key, { n: 1, until: Date.now() + 15 * 60 * 1000 });
    return;
  }
  a.n++; a.until = Date.now() + 15 * 60 * 1000;
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

    // приставки — чтобы почта «1.2.3.4» не считалась в счётчик чужого адреса
    const ip = 'ip|' + clientIp(req), mail = 'mail|' + email;
    for (const [key, max] of [[ip, LOGIN_PER_IP], [mail, LOGIN_PER_MAIL]]) {
      const wait = loginBlocked(key, max);
      if (wait) return reply(res, 429, { error: 'слишком много попыток, подождите ' + wait + ' с' });
    }
    try {
      const tokens = await gotrue.signInWithPassword(email, password);
      // счётчик адреса не сбрасываем: иначе вход в свой аккаунт между попытками
      // обнулял бы перебор чужих
      attempts.delete(mail);
      return startSession(req, res, tokens);
    } catch (e) {
      if (e.transport) return reply(res, 503, { error: 'сервис входа недоступен, попробуйте позже' });
      loginFailed(ip); loginFailed(mail);
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
  if (tooMany(req, 'guest', 120)) return reply(res, 429, { error: 'слишком много запросов, подождите минуту' });
  if (diskTight) return reply(res, 503, { error: 'на сервере кончается место, попробуйте позже' });
  const b = await jsonBody(req);
  const boardId = str(b.board, 40);
  const token = str(b.g, 64);
  const name = cleanName(b.name, 24);
  if (!okId(boardId)) return reply(res, 400, { error: 'плохая ссылка' });

  // С токеном — по старой выданной ссылке; без токена — по самому адресу
  // доски, если владелец включил гостевой доступ.
  let row;
  try { row = token ? await db.guestOpen(boardId, token) : await db.guestOpenByLink(boardId); }
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
      if (!Object.keys(patch).length) return reply(res, 400, { error: 'нечего менять' });

      const row = await db.patchBoard(token, id, patch);
      const r = await loadRoom(id);
      applyMeta(r, row);
      cap_.invalidate(id);
      if ('title' in patch) broadcast(r, { t: 'title', title: r.title });
      if ('locked' in patch) broadcast(r, { t: 'lock', on: r.locked });
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
  if (tooMany(req, 'upload', 240)) return reply(res, 429, { error: 'слишком много загрузок, подождите минуту' });

  const s = await session.fromRequest(req);
  const { cap } = await cap_.resolve(s, id);
  // До комнаты: иначе запрос без всякого входа поднимал в памяти комнату с
  // любым присланным id, а при выгрузке она ещё и писалась на диск
  if (cap === 'none') return reply(res, 403, { error: 'нет доступа к доске' });
  // loadRoom, а не rooms.get: раньше загрузка отваливалась с 404 через полчаса
  // простоя комнаты, хотя доска никуда не девалась
  const room = await loadRoom(id);
  if (!cap_.mayEdit(cap, room.locked))
    return reply(res, 403, { error: 'доска закрыта преподавателем' });

  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = Object.hasOwn(IMAGE_EXT, type) && IMAGE_EXT[type];
  if (!ext) return reply(res, 415, { error: 'поддерживаются PNG, JPEG, WebP, GIF' });
  if (diskTight) return reply(res, 507, { error: 'на сервере кончается место' });
  if (await boardBytes(id) > BOARD_QUOTA)
    return reply(res, 507, { error: 'на доске кончилось место под картинки' });

  let buf;
  try { buf = await readBody(req, MAX_UPLOAD); }
  catch { return reply(res, 413, { error: 'картинка больше 16 МБ' }); }
  if (!buf.length) return reply(res, 400, { error: 'пустой файл' });
  if (!IMAGE_MAGIC[ext](buf)) return reply(res, 415, { error: 'файл не похож на картинку' });

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
    metrics.inc('doska_upload_total');
    metrics.inc('doska_upload_bytes_total', buf.length);
    // В журнал: сама картинка на доске появится отдельной операцией add, но
    // без этой строки журнал не знал бы, откуда взялся файл.
    record(room, { t: 'img', url: href, bytes: buf.length });
  }
  if (had) metrics.inc('doska_upload_dedup_total');   // склейка одинаковых
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
  /* Картинка читалась в память целиком — до 16 МБ на запрос. Класс из ста
     человек открывает доску со снимками одновременно, и это сотни мегабайт
     буферов разом, в самый неудачный момент: начало занятия. Отдаём потоком,
     памяти уходит один буфер чтения.

     ETag тут дешёвый и точный: имя файла — отпечаток его содержимого (см.
     handleUpload), значит другого содержимого под этим именем не будет
     никогда. Заголовок immutable браузер и так слушает, но повторный заход
     после чистки кэша теперь стоит 304, а не мегабайты. */
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) { res.writeHead(404); return res.end(); }
  const etag = '"' + parts[2] + '"';
  const head = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                 'cache-control': 'private, max-age=31536000, immutable', etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
  head['content-length'] = st.size;
  res.writeHead(200, head);
  const stream = fs.createReadStream(file);
  // оборвалась передача (закрыли вкладку) — закрываем и чтение, иначе
  // дескриптор проживёт до сборки мусора
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
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

/* Постоянный адрес доски. Пока он задан, обращения по старому — по голому
   IP с портом — переводятся на него же по https.

   Так продолжают работать ссылки, разосланные раньше: ученик открывает старую,
   его молча переводит на защищённое соединение, и доска открывается та же.
   Заодно исчезает половина бед незащищённого соединения — буфер обмена,
   предупреждения Telegram и мобильных браузеров. */
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const SITE_HOST = SITE_URL ? SITE_URL.replace(/^https?:\/\//, '') : '';

/* Обработчик асинхронный: всё, что вылетит мимо него, стало бы необработанным
   отказом и завершило процесс. Поэтому страховка здесь, снаружи всего разбора. */
const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    console.error(req.method, String(req.url).slice(0, 100), e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function route(req, res) {
  securityHeaders(req, res);
  // «GET //» — законный запрос и незаконный адрес: разбор бросает исключение
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400); return res.end(); }
  const p = url.pathname;

  if (SITE_HOST) {
    const host = String(req.headers.host || '');
    const bare = host.replace(/:\d+$/, '');
    // Caddy ходит на 127.0.0.1 — его не трогаем, иначе получится круг
    const local = bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
    if (!local && bare !== SITE_HOST.replace(/^www\./, '') && bare !== SITE_HOST &&
        bare !== 'www.' + SITE_HOST) {
      res.writeHead(308, { location: SITE_URL + req.url, 'cache-control': 'no-store' });
      return res.end();
    }
  }

  try {
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && crossSite(req))
        return reply(res, 403, { error: 'межсайтовый запрос' });

      // единственное, что доска рассказывает о себе до входа
      if (p === '/api/config')         return reply(res, 200, { mcko: MCKO_URL || null });
      if (p.startsWith('/api/auth/'))  return await handleAuth(req, res, url, p);
      if (p === '/api/sso/ticket')     return await handleSso(req, res, url, p);
      /* Пускает ли доска без учётной записи. Спрашивают до всякого входа:
         иначе человека без аккаунта уводило на страницу МЦКО, и обратно он уже
         не возвращался. Отдаём только уровень для гостей и название — больше о
         доске отсюда узнать нельзя, а сама функция в БД молчит про доски, где
         гостевой доступ выключен. */
      if (p === '/api/board-entry') {
        const bid = url.searchParams.get('b') || '';
        if (!okId(bid)) return reply(res, 400, { error: 'плохой id' });
        if (tooMany(req, 'entry', 120)) return reply(res, 429, { error: 'слишком много запросов' });
        let row = null;
        try { row = await db.guestOpenByLink(bid); }
        catch (e) { return reply(res, e.transport ? 503 : 400, { error: e.message }); }
        return reply(res, 200, row
          ? { guest: row.access, title: row.title }
          : { guest: 'none' });
      }

      /* Сводка нагрузки для администратора.

         Grafana слушает только localhost, и открывать её наружу ради вкладки в
         доске значило бы завести вторую дверь с своим паролем. Вместо этого
         доска сама спрашивает Prometheus — тот тоже только на localhost — и
         отдаёт готовые числа. Наружу не появляется ничего нового, а смотреть
         можно откуда угодно.

         Роль проверяем здесь, а не в клиенте: клиенту верить нельзя. */
      if (p === '/api/admin/stats') {
        const s = await session.fromRequest(req);
        if (!s || s.kind !== 'user') return reply(res, 401, { error: 'не авторизовано' });
        if (s.role !== 'admin') return reply(res, 403, { error: 'только для администратора' });
        return reply(res, 200, await adminStats());
      }

      if (p === '/api/guest/enter')    return await handleGuestEnter(req, res);
      if (p === '/api/upload')         return await handleUpload(req, res, url);
      if (p.startsWith('/api/boards')) return await handleBoards(req, res, url, p);

      if (p === '/api/students') {
        const s = await session.fromRequest(req);
        if (!s || s.kind !== 'user') return reply(res, 401, { error: 'не авторизовано' });
        // Список нужен учителю, чтобы выбрать участников доски. Ученику он
        // отдавал его самого — правило «читай своё» иначе и не могло, — а это
        // бессмысленный ответ на бессмысленный вопрос. Отвечаем прямо.
        if (s.role !== 'teacher') return reply(res, 403, { error: 'список учеников — для преподавателя' });
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
    // подробности сбоя — в журнал; посетителю незачем читать внутренности
    return reply(res, status, { error: status >= 500 ? 'сервис временно недоступен' : (e.message || 'ошибка') });
  }

  /* Метрики. Только с самой машины: по ним видно, сколько досок и насколько
     они живые, — наружу такое не отдают. Сборщик ходит изнутри.

     Адреса одного мало: за прокси любой запрос приходит с 127.0.0.1, и страница
     была открыта всему интернету. Прокси всегда дописывает свои заголовки, а
     сборщик ходит напрямую, без них. */
  if (p === '/metrics') {
    const from = req.socket.remoteAddress || '';
    const proxied = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
    if (proxied || !/^(::1|::ffff:127\.|127\.)/.test(from)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8',
                         'cache-control': 'no-store' });
    return res.end(metrics.render({ rooms, clients: wss.clients.size }));
  }

  /* --- статика --- */
  let rel;
  // «/%» и прочая порча в адресе роняли decodeURIComponent, а он стоял вне
  // try/catch: обработчик асинхронный, значит запрос просто повисал без ответа
  try { rel = decodeURIComponent(p === '/' ? '/index.html' : p); }
  catch { res.writeHead(400); return res.end(); }
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([\\/])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }

  let rec = await loadStatic(file).catch(() => null);
  let ext = path.extname(file);
  if (!rec) {
    /* Запасной путь — только для адресов доски (/board/xxx, /login): их
       разбирает сам клиент, и сервер отдаёт ему страницу.

       Но для запроса с расширением так делать нельзя. Клиент теперь состоит
       из полутора десятков модулей, и опечатка в пути импорта или файл, не
       доехавший при выкладке, возвращали бы 200 с HTML вместо модуля: браузер
       ругался бы на несовпадение типа, а по коду ответа всё выглядело бы
       благополучно. Пусть отсутствующий файл честно отвечает 404. */
    if (ext) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('нет такого файла'); }
    rec = await loadStatic(path.join(PUBLIC, 'index.html')).catch(() => null);
    ext = '.html';
  }
  if (!rec) { res.writeHead(404); return res.end('not found'); }
  return sendStatic(req, res, rec, ext);
}

/* Отдача статики: кэш файла, сжатие и метка версии.

   Клиент доски — один файл, и он уходил целиком на каждую загрузку. Для
   ученика с телефона это секунды ожидания на ровном месте; brotli ужимает его
   примерно в пять раз.

   Но сжатия мало. Заголовок cache-control: no-cache велит браузеру
   перепроверять файл — а перепроверять было НЕЧЕМ: ни ETag, ни Last-Modified
   не отдавалось, значит условный запрос невозможен и каждое открытие страницы
   тянуло её целиком заново. На старте урока это сотня полных загрузок вместо
   сотни ответов «304» по сотне байт. Теперь есть ETag из размера и времени
   правки: выложили новую версию — метка сменилась сама.

   Держим в памяти и сырой файл тоже, не только сжатый: раньше сжатое
   кэшировалось, а исходное читалось с диска на каждый запрос.

   Ключом кэша сжатия был «способ:расширение:длина» — без имени файла. Пока
   файл один, это сходило с рук; два разных .js одинаковой длины уже отдавались
   бы вперемешку. Теперь кэш живёт при самой записи о файле, и ключ ему не
   нужен вовсе. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);
const fileCache = new Map();          // путь → { mtimeMs, size, raw, etag, zip }

async function loadStatic(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('не файл');
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const rec = {
    mtimeMs: st.mtimeMs, size: st.size,
    raw: await fsp.readFile(file),
    etag: '"' + st.size.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '"',
    zip: new Map(),
  };
  fileCache.set(file, rec);
  return rec;
}

function sendStatic(req, res, rec, ext) {
  const type = MIME[ext] || 'application/octet-stream';
  const head = { 'content-type': type, 'cache-control': 'no-cache',
                 vary: 'accept-encoding', etag: rec.etag };
  // ровно то же самое уже лежит в браузере — не шлём тело
  if (req.headers['if-none-match'] === rec.etag) {
    res.writeHead(304, { 'cache-control': 'no-cache', vary: 'accept-encoding', etag: rec.etag });
    return res.end();
  }
  const buf = rec.raw;
  const accept = String(req.headers['accept-encoding'] || '');
  // мелочь сжимать дороже, чем отдать как есть
  if (!COMPRESSIBLE.has(ext) || buf.length < 1024) {
    res.writeHead(200, head);
    return res.end(buf);
  }
  const how = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  if (!how) { res.writeHead(200, head); return res.end(buf); }

  const hit = rec.zip.get(how);
  if (hit) {
    res.writeHead(200, { ...head, 'content-encoding': how });
    return res.end(hit);
  }
  const done = (e, out) => {
    if (e) { res.writeHead(200, head); return res.end(buf); }
    rec.zip.set(how, out);
    res.writeHead(200, { ...head, 'content-encoding': how });
    res.end(out);
  };
  if (how === 'br') zlib.brotliCompress(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }, done);
  else zlib.gzip(buf, { level: 7 }, done);
}

/* ═══════════════ сводка для администратора ═══════════════
   Спрашиваем Prometheus по соседству. Если его нет или он не отвечает, честно
   говорим об этом, а не показываем нули: пустой график и сломанный сбор — это
   разные вещи, и путать их нельзя. */
const PROM = process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090';

async function promQuery(q) {
  const r = await fetch(PROM + '/api/v1/query?query=' + encodeURIComponent(q),
    { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('Prometheus ответил ' + r.status);
  const d = await r.json();
  const v = d && d.data && d.data.result && d.data.result[0];
  return v ? +v.value[1] : null;
}

/* Что показываем. Подписи здесь же: у числа без объяснения нет смысла. */
const ADMIN_METRICS = [
  ['boards',   'doska_rooms_open',        'Досок открыто'],
  ['people',   'doska_ws_clients',        'Людей на досках'],
  ['items',    'doska_items_total',       'Объектов во всех досках'],
  ['points',   'doska_points_total',      'Точек'],
  ['images',   'doska_images_total',      'Картинок'],
  ['memory',   'doska_memory_bytes{part="rss"}', 'Память доски'],
  ['uptime',   'doska_uptime_seconds',    'Сервер живёт'],
  ['lag',      'histogram_quantile(0.95, sum(rate(doska_op_seconds_bucket[5m])) by (le))',
               'Задержка операции, 95%'],
  ['ops',      'sum(rate(doska_messages_total[5m]))', 'Операций в секунду'],
  ['cpu',      '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
               'Загрузка процессора'],
  ['freeMem',  'node_memory_MemAvailable_bytes', 'Свободная память машины'],
  ['freeDisk', 'node_filesystem_avail_bytes{mountpoint="/"}', 'Свободно на диске'],
];

async function adminStats() {
  const out = { at: Date.now(), ok: true, error: null, values: {} };
  try {
    const got = await Promise.all(ADMIN_METRICS.map(([, q]) => promQuery(q).catch(() => null)));
    ADMIN_METRICS.forEach(([key, , label], i) => {
      out.values[key] = { label, value: got[i] };
    });
    if (got.every(v => v === null)) { out.ok = false; out.error = 'Prometheus не отвечает или ещё не собрал данные'; }
  } catch (e) {
    out.ok = false; out.error = e.message;
  }
  return out;
}

/* ═══════════════ WebSocket ═══════════════ */
/* noServer + свой обработчик upgrade: сессию надо достать из куки ДО того,
   как рукопожатие состоится, и заодно проверить Origin — SameSite куки на
   вебсокеты не распространяется, а значит чужая страница могла бы открыть
   сокет от имени вошедшего. */
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const COLORS = ['#2F80ED','#EB5757','#27AE60','#9B51E0','#F2994A','#00A3A3','#D64B9B'];
let seq = 0;

server.on('upgrade', async (req, socket, head) => {
  // Пока читаем сессию, за сокетом никто не следит, и обрыв в этот момент
  // стал бы необработанной ошибкой на весь процесс
  socket.on('error', () => {});
  const host = req.headers.host, o = req.headers.origin;
  if (o && o !== 'http://' + host && o !== 'https://' + host) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  if (tooMany(req, 'ws', 240)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy();
  }
  const s = await session.fromRequest(req).catch(() => null);
  if (!s) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.session = s;
    wss.emit('connection', ws, req);
  });
});

/* Метка операции для метрик — только из этого списка.

   Раньше сюда шло само присланное поле t, обрезанное до 12 символов. Тип
   сообщения приходит от клиента и ничем не проверяется: handleMessage
   неизвестные молча игнорирует, но счётчик успевал отработать раньше. То есть
   любой участник доски — хватало обычного ученика с изменённым клиентом — мог
   слать сообщения со случайным t и наращивать карты счётчиков и гистограмм в
   lib/metrics.js без всякого потолка. Это и рост памяти процесса, и взрыв
   кардинальности в Prometheus, который такую метрику потом не переварит.

   Список ровно тот, что разбирает switch ниже; всё прочее считается вместе
   как other — знать, сколько пришло мусора, полезно, а вот во что именно он
   был одет, метрике незачем. */
const OP_NAMES = new Set(['join', 'add', 'move', 'erase', 'restore', 'z',
                          'cursor', 'live', 'view', 'presence', 'callAll',
                          'lock', 'clear']);
const opLabel = t => (typeof t === 'string' && OP_NAMES.has(t)) ? t : 'other';

/* ═══════ ретрансляция: проверка и частота ═══════

   Пять типов сообщений сервер не хранит, а просто пересылает остальным:
   живой штрих, курсор, видимая область, камера владельца и «все ко мне». До
   этого они уходили дальше ровно в том виде, в каком пришли, — то есть чужой
   клиент мог прислать что угодно, и это что угодно размножалось на всех
   участников комнаты. При потолке кадра в 2 МБ и сотне человек одно сообщение
   давало до 200 МБ исходящего трафика.

   Проверять их как обычные объекты (CLEANERS) незачем: они никуда не
   записываются и живут до следующего такого же. Нужно ровно одно — чтобы
   размер и форма были предсказуемыми.

   Частоту ограничиваем только здесь. Обычные правки (add/move/erase) под
   лимит не попадают сознательно: клиент шлёт их по одному сообщению на
   объект, и групповая операция вроде «выделить всё → повернуть» законно даёт
   тысячи подряд. Отбрасывать их значило бы молча терять чужую работу, а
   закрывать сокет — терять её же, только заметно. Сначала нужно научить
   клиента слать такое одним сообщением; пока этого нет, лимит на них не
   ставим. Потерять же кадр курсора или живого штриха безвредно по самой их
   природе: следующий кадр через 45-55 мс всё равно всё перекроет. */

const fin = (v, d) => Number.isFinite(+v) ? +v : d;
const LIVE_KINDS = new Set(['pen', 'marker']);
/* Точек в кадре живого штриха. Клиент шлёт накопленное за 45 мс — это единицы,
   от силы десятки даже с пера на 120 Гц. 512 взяты с большим запасом: смысл
   не в точности границы, а в том, что она вообще есть. */
const LIVE_MAX_PTS = 512;

function cleanLive(m) {
  if (!Array.isArray(m.pts)) return null;
  const src = m.pts.slice(0, LIVE_MAX_PTS);
  const pts = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const a = Array.isArray(src[i]) ? src[i] : [];
    pts[i] = [fin(a[0], 0), fin(a[1], 0), Math.max(0, Math.min(1, fin(a[2], 0.5)))];
  }
  return {
    // sid — ключ, по которому получатель складывает кадры одного штриха
    // (remoteLive у клиента). Своей длины у него нет, поэтому задаём здесь.
    sid: String(m.sid == null ? '' : m.sid).slice(0, 48),
    from: m.from | 0,
    pts,
    kind: LIVE_KINDS.has(m.kind) ? m.kind : 'pen',
    color: String(m.color == null ? '#1A1C20' : m.color).slice(0, 24),
    size: Math.min(600, Math.max(0.2, fin(m.size, 2))),
  };
}
/* Камера: три числа, ничего больше. Раньше сюда проходил любой объект, и у
   получателя S.cam.z становился чем угодно вплоть до NaN — после такого доска
   у него просто гасла, и вернуть её можно было только перезагрузкой. */
const cleanCam = c => ({
  x: fin(c && c.x, 0), y: fin(c && c.y, 0),
  z: Math.min(64, Math.max(0.01, fin(c && c.z, 1))),
});

/* Ведро токенов на сокет: RATE_PER_SEC в среднем, RATE_BURST разом.
   Законный клиент шлёт около 50 таких сообщений в секунду (штрих 22, курсор
   18, область 4, камера 8) — запас больше чем двукратный. */
const RATE_PER_SEC = 120;
const RATE_BURST = 240;
function mayRelay(ws) {
  const b = ws.relay, now = Date.now();
  b.n = Math.min(RATE_BURST, b.n + (now - b.at) * RATE_PER_SEC / 1000);
  b.at = now;
  if (b.n < 1) { metrics.inc('doska_relay_dropped_total'); return false; }
  b.n -= 1;
  return true;
}

/* Всё, что уходит участнику, идёт через out(). Пока ему готовят доску
   (ws.held — см. sendInit), сообщения не отправляются, а копятся и уходят
   следом за ней в том же порядке: иначе чужой штрих, нарисованный в эти
   миллисекунды, пришёл бы раньше доски и был бы ею же затёрт. */
const MAX_BUFFERED = 32 * 1024 * 1024;
function out(ws, s) {
  if (ws.readyState !== 1) return;
  // Кто не читает, тот копит у нас в памяти всё, что ему шлют. Настоящий
  // клиент на плохой связи переподключится и получит доску заново.
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
  if (ws.held) ws.held.push(s); else ws.send(s);
}
const send = (ws, o) => out(ws, JSON.stringify(o));
function broadcast(room, o, except) {
  const s = JSON.stringify(o);
  for (const c of room.clients) if (c !== except) out(c, s);
}

/* ─── доска для входящего ───

   Тяжёлая доска — это мегабайты JSON: на доске в 13 600 штрихов init весил
   5.8 МБ и шёл несжатым, по сети это секунды. Сжатие всего WebSocket
   (perMessageDeflate) не берём нарочно: браузер стал бы сжимать каждый кадр
   живого штриха, а одноядерный сервер — распаковывать, то есть дороже
   стало бы именно рисование. Сжимаем только доску при входе: gzip уровня 4,
   5.8 МБ → 1.44 МБ за ~0.1 с, причём в пуле потоков zlib, не останавливая
   приём штрихов.

   Сжатое держим в room.initCache, пока доска не менялась (record() и
   прореживание в store.snapshot поднимают room.ver): несколько входов подряд
   — учитель и ученики к началу урока, все сразу после перезапуска сервера —
   собирают и сжимают её один раз.

   Клиент без DecompressionStream (старые Safari) о сжатии не просит и
   получает доску как раньше. */
const INIT_GZIP_LEVEL = 4;
const gzip = (buf) => new Promise((ok, no) =>
  zlib.gzip(buf, { level: INIT_GZIP_LEVEL }, (e, r) => e ? no(e) : ok(r)));

function initHead(ws, room) {
  // uid здесь — отпечаток автора (authorOf), а не учётная запись: клиенту он
  // нужен, чтобы понимать, какие объекты его собственные
  // now — часы сервера: по ним у всех участников совпадает движение моделей
  return { t: 'init', you: { ...peerInfo(ws), uid: ws.me.uid }, now: Date.now(),
           title: room.title, locked: room.locked, anyEdit: room.anyEdit,
           peers: [...room.clients].filter(c => c !== ws).map(peerInfo) };
}

function sendInit(ws, room, packed) {
  const head = initHead(ws, room);
  if (!packed) { send(ws, { ...head, items: room.items.map(i => pt.wire(i)) }); return; }

  let c = room.initCache;
  if (!c || c.ver !== (room.ver | 0)) {
    // Строку собираем сейчас же: это и есть доска на момент входа. Всё, что
    // изменится дальше, придёт этому участнику отдельными сообщениями.
    const json = JSON.stringify(room.items.map(i => pt.wire(i)));
    c = room.initCache = { ver: room.ver | 0, gz: gzip(json) };
    // не вышло сжать — этот кэш не нужен никому; входящий получит как раньше
    c.gz.catch(() => { if (room.initCache === c) room.initCache = null; });
  }
  ws.held = [];
  const release = () => { const held = ws.held || []; ws.held = null; for (const s of held) out(ws, s); };
  c.gz.then(buf => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ ...head, z: 'gzip' }));
    ws.send(buf);                         // двоичный кадр сразу следом
    release();
  }, e => {
    console.error('[' + room.id + '] сжатие доски:', e.message);
    // доску отдаём как было и уже без сжатия; придержанное — после неё
    const held = ws.held || []; ws.held = null;
    send(ws, { ...head, items: room.items.map(i => pt.wire(i)) });
    // состояние могло уйти вперёд, пока сжимали: тогда придержанные правки
    // уже есть в доске, и повтор их безвреден — add одного id клиент не
    // дублирует, move и erase идемпотентны
    for (const s of held) out(ws, s);
  });
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

/* Дуга циркуля.

   Хранится тем, чем её и рисуют: центр, радиус и два угла. Держать её как
   прямоугольник с шириной и высотой значило бы разрешить растянуть — а
   растянутая дуга перестаёт быть дугой окружности, которую и чертят циркулем.
   Поэтому у неё нет ни w, ни h, и менять у неё можно только углы. */
function cleanArc(a, by) {
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  const ang = v => {
    const x = +v;
    return Number.isFinite(x) ? x : 0;
  };
  return { id: String(a.id).slice(0, 48), by, type: 'arc',
           cx: num(a.cx, 0), cy: num(a.cy, 0),
           r: Math.max(0.5, Math.min(40000, num(a.r, 50))),
           a0: ang(a.a0), a1: ang(a.a1),
           color: String(a.color || '#1A1C20').slice(0, 24),
           size: Math.min(600, Math.max(0.1, num(a.size, 2))),
           dash: [0, 1, 2].includes(+a.dash) ? +a.dash : 0,
           g: clampGroup(a.g),
           locked: !!a.locked };
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
// 4 — узкое остриё «вектора» в физике (см. drawArrowhead в index.html), не выбирается
// руками из обычного списка стрелок, но клиент присылает его для этого пресета
const clampArrow = v => [0, 1, 2, 3, 4].includes(+v) ? +v : 0;
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

/* Объекты-симуляции доп.меню «Физика» (магнит/компас и т.п.). Геометрия —
   как у картинки (x,y,w,h,rot), но размер зажат под иконку-объект, а не под
   загруженный файл: это не фото, а маленький штамп с фиксированными
   пропорциями. props — физические параметры конкретного kind; известные
   поля белого списка не пропускаем дальше — вся содержательная физика
   (поле магнита, стрелка компаса) всё равно считается на клиенте по одним
   этим координатам, серверу знать её не нужно. */
// оптика (источник/линза/зеркало) — та же геометрия x,y,w,h,rot, что и у
// магнита/компаса, лучи и преломление считает клиент по этим координатам
// у моделей и графика props меняются уже после постановки (см.
// PATCH_CLAMP.physics.props ниже). Сама формула — просто строка: её
// парсит и считает клиент своим кодом (см. graphParse в index.html), а не
// eval/new Function — сервер её не выполняет и не проверяет на валидность,
// только на размер.
const PHYSICS_KINDS = new Set(['magnet', 'compass', 'light-source', 'lens', 'mirror', 'heater', 'body', 'calorimeter', 'graph',
                               'pendulum', 'spring', 'wave', 'cylinder']);
const BODY_MATERIALS = new Set(['water', 'copper', 'aluminum', 'lead', 'steel']);
const material = v => BODY_MATERIALS.has(v) ? v : 'water';
// модели: поле → [мин, макс, по умолчанию], зеркало MODELS в public/js/models.js
const MODEL_RANGES = {
  pendulum: { len: [0.2, 2.5, 1], g: [1.6, 25, 9.8], amp: [1, 30, 15], mass: [0.1, 2, 0.5] },
  spring: { k: [5, 200, 20], mass: [0.05, 2, 0.5], amp: [1, 10, 5] },
  wave: { lambda: [0.5, 3, 2], period: [0.5, 5, 2], amp: [0.1, 1, 0.5] },
  cylinder: { T: [100, 1000, 300], n: [0.05, 1, 0.2], mass: [0, 50, 0], fric: [0, 500, 0],
              p0: [0, 200, 100], h: [0.05, 1, 0.5] },
  heater: { power: [50, 5000, 500] },
  body: { mass: [0.01, 1, 0.1], t0: [-30, 1700, 20], q: [0, 1e9, 0], watts: [0, 100000, 0] },
  calorimeter: { m1: [10, 1000, 200], t1: [-30, 500, 20], m2: [10, 1000, 100], t2: [-30, 500, 100] },
};
function cleanPhysicsProps(kind, props) {
  const p = props && typeof props === 'object' ? props : {};
  if (MODEL_RANGES[kind]) {
    const out = {};
    for (const [k, [lo, hi, def]] of Object.entries(MODEL_RANGES[kind]))
      out[k] = Math.max(lo, Math.min(hi, Number.isFinite(+p[k]) ? +p[k] : def));
    const at = Number.isFinite(+p.at) ? +p.at : 0;
    if (kind === 'cylinder') return { ...out, fixed: !!p.fixed };
    if (kind === 'heater') return { ...out, on: !!p.on };
    if (kind === 'body') return { ...out, material: material(p.material), at };
    if (kind === 'calorimeter') return { ...out, mat1: material(p.mat1), mat2: material(p.mat2), run: !!p.run, at };
    // ph и at — фаза колебаний и момент по часам сервера, см. models.js
    return { ...out, run: !!p.run, ph: Number.isFinite(+p.ph) ? +p.ph : 0, at };
  }
  if (kind === 'magnet') {
    const s = Number.isFinite(+p.strength) ? +p.strength : 1;
    // строгих Тесла тут нет — школьная модель условна, но подписана в Тл на панели
    return { strength: Math.max(0.2, Math.min(3, s)), showField: p.showField !== false };
  }
  if (kind === 'light-source') {
    const rc = Number.isFinite(+p.rayCount) ? Math.round(+p.rayCount) : 5;
    const sp = Number.isFinite(+p.spreadDeg) ? +p.spreadDeg : 16;
    return { rayCount: Math.max(1, Math.min(41, rc)), spreadDeg: Math.max(0, Math.min(90, sp)) };
  }
  if (kind === 'lens') {
    const f = Number.isFinite(+p.focal) ? +p.focal : 140;
    // знак — собирающая/рассеивающая, зажимаем модуль, знак не трогаем
    const sign = f < 0 ? -1 : 1;
    return { focal: sign * Math.max(60, Math.min(400, Math.abs(f))) };
  }
  if (kind === 'graph') {
    const v = p.view && typeof p.view === 'object' ? p.view : {};
    const view = {
      cx: Number.isFinite(+v.cx) ? +v.cx : 0,
      cy: Number.isFinite(+v.cy) ? +v.cy : 0,
      scale: Math.max(4, Math.min(4000, Number.isFinite(+v.scale) ? +v.scale : 40)),
    };
    const list = Array.isArray(p.expressions) ? p.expressions.slice(0, 8) : [];
    const expressions = list.map(e => ({
      id: (e && typeof e.id === 'string' && e.id) ? e.id.slice(0, 32) : rnd(8),
      // саму формулу не разбираем и не выполняем — это делает клиент своим
      // интерпретатором (см. graphParseExpr/graphEval в index.html), не
      // eval/new Function; здесь только ограничение размера
      text: (e && typeof e.text === 'string') ? e.text.slice(0, 200) : '',
      color: (e && typeof e.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(e.color)) ? e.color : '#2F6FE0',
      visible: !(e && e.visible === false),
      fill: !!(e && e.fill === true),
    }));
    const exprIds = new Set(expressions.map(e => e.id));
    // точки, поставленные вручную (см. двойной клик по графику в index.html):
    // координаты плюс необязательные подпись и привязка к формуле (onExpr) —
    // саму формулу точка не несёт, только id уже провалидированной выше
    const pts = Array.isArray(p.points) ? p.points.slice(0, 30) : [];
    const points = pts.map(pt => ({
      id: (pt && typeof pt.id === 'string' && pt.id) ? pt.id.slice(0, 32) : rnd(8),
      x: Number.isFinite(+(pt && pt.x)) ? +pt.x : 0,
      y: Number.isFinite(+(pt && pt.y)) ? +pt.y : 0,
      label: (pt && typeof pt.label === 'string') ? pt.label.slice(0, 6) : '',
      onExpr: (pt && typeof pt.onExpr === 'string' && exprIds.has(pt.onExpr)) ? pt.onExpr : null,
    }));
    // слайдеры-параметры: имя — ровно одна буква, не совпадающая с x/y/t
    // (это зарезервированные переменные графика) и не повторяющаяся у двух
    // слайдеров сразу — иначе на клиенте было бы неоднозначно, чьё значение
    // подставлять при вычислении
    const seenNames = new Set(['x', 'y', 't']);
    const prs = Array.isArray(p.params) ? p.params.slice(0, 6) : [];
    const params = [];
    for (const pr of prs) {
      const name = (pr && typeof pr.name === 'string') ? pr.name.trim().toLowerCase() : '';
      if (!/^[a-z]$/.test(name) || seenNames.has(name)) continue;
      seenNames.add(name);
      const val = Number.isFinite(+(pr && pr.value)) ? +pr.value : 1;
      params.push({ id: (pr && typeof pr.id === 'string' && pr.id) ? pr.id.slice(0, 32) : rnd(8),
                    name, value: Math.max(-10, Math.min(10, val)) });
    }
    const label = (v, d) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 12) : d;
    const labelSize = Math.max(9, Math.min(22, Number.isFinite(+p.labelSize) ? +p.labelSize : 13));
    return {
      view, expressions, points, params, labelSize,
      xLabel: label(p.xLabel, 'x'), yLabel: label(p.yLabel, 'y'),
      angleMode: p.angleMode === 'deg' ? 'deg' : 'rad',
    };
  }
  return {};
}
function cleanPhysics(o, by) {
  if (!PHYSICS_KINDS.has(o.kind)) return null;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  return { id: String(o.id).slice(0, 48), by, type: 'physics', kind: o.kind,
           x: num(o.x, 0), y: num(o.y, 0),
           w: Math.max(8, Math.min(400, num(o.w, 60))),
           h: Math.max(8, Math.min(400, num(o.h, 60))),
           rot: num(o.rot, 0),
           props: cleanPhysicsProps(o.kind, o.props),
           g: clampGroup(o.g),
           locked: !!o.locked };
}

/* реестр валидаторов по типу — новый тип регистрируется здесь один раз,
   вместо тернарника в add/restore. Незарегистрированный тип (штрихи,
   а также будущие типы до появления своего cleaner'а) идёт через cleanStroke. */
const CLEANERS = { image: cleanImage, shape: cleanShape, path: cleanPath, text: cleanText, arc: cleanArc, physics: cleanPhysics };
/* Только свои ключи. Тип присылает клиент: CLEANERS['constructor'] — это Object,
   и объект проходил на доску как есть, без единой проверки, и оставался там
   навсегда, ломая отрисовку у всех. */
const pick = type => (typeof type === 'string' && Object.hasOwn(CLEANERS, type) && CLEANERS[type]) || cleanStroke;

/** Места больше нет: потолок объектов, точек или памяти всего процесса. */
const roomFull = (room, it) =>
  memTight || room.items.length >= MAX_ITEMS || room.points + pointsOf(it) > MAX_POINTS;

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
  /* У дуги правится положение и углы, но не радиус: растянутая дуга перестаёт
     быть дугой окружности, а циркулем другой и не начертишь. Поэтому здесь нет
     ни r, ни ширины с высотой — и «растянуть» её нечем даже вручную. */
  arc: {
    g: clampG,
    cx: (v, it) => Number.isFinite(+v) ? +v : it.cx,
    cy: (v, it) => Number.isFinite(+v) ? +v : it.cy,
    a0: (v, it) => Number.isFinite(+v) ? +v : it.a0,
    a1: (v, it) => Number.isFinite(+v) ? +v : it.a1,
    color: (v, it) => typeof v === 'string' ? v.slice(0, 24) : it.color,
    size: (v, it) => Number.isFinite(+v) ? Math.min(600, Math.max(0.1, +v)) : it.size,
    dash: (v, it) => [0, 1, 2].includes(+v) ? +v : it.dash,
    locked: (v) => !!v
  },
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
  // kind не патчится — вид объекта задаётся один раз при постановке. props
  // патчится (через тот же cleanPhysicsProps, что и при 'add') — так работают
  // настройки моделей и графика, которые правят уже стоящий объект.
  physics: {
    g: clampG,
    x: (v, it) => Number.isFinite(+v) ? +v : it.x,
    y: (v, it) => Number.isFinite(+v) ? +v : it.y,
    w: (v, it) => Math.max(8, Math.min(400, Number.isFinite(+v) ? +v : it.w)),
    h: (v, it) => Math.max(8, Math.min(400, Number.isFinite(+v) ? +v : it.h)),
    rot: (v, it) => Number.isFinite(+v) ? +v : it.rot,
    props: (v, it) => cleanPhysicsProps(it.kind, v),
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
    a1: (v, it) => [0, 1, 2, 3, 4].includes(+v) ? +v : it.a1,
    a2: (v, it) => [0, 1, 2, 3, 4].includes(+v) ? +v : it.a2,
    locked: (v) => !!v
  }
};
PATCH_CLAMP.marker = PATCH_CLAMP.pen;
const PATCHABLE = Object.fromEntries(Object.entries(PATCH_CLAMP).map(([t, c]) => [t, Object.keys(c)]));

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Без этого слушателя кадр больше потолка или испорченный кадр становился
  // необработанным исключением: библиотека сообщает о нём событием 'error',
  // и процесс падал вместе со всеми занятиями. Сокет она закрывает сама.
  ws.on('error', () => metrics.inc('doska_bad_messages_total'));
  ws.room = null;
  // sid — на сокет (курсоры, аватарки, две вкладки одного человека различимы),
  // uid — на человека: именно он попадает в поле by у объектов, поэтому
  // «стереть своё» переживает переподключение.
  ws.me = { sid: 'u' + (++seq) + Date.now().toString(36).slice(-3), uid: null,
            name: 'Гость', cap: 'none', color: COLORS[seq % COLORS.length] };
  ws.relay = { n: RATE_BURST, at: Date.now() };   // ведро на ретрансляции
  // Вошедший клиент шлёт join сразу. Без срока соединения, так и не зашедшие на
  // доску, висели бы вечно и ничем не считались.
  ws.joinTimer = setTimeout(() => { if (!ws.room && !ws.joining) ws.close(4000, 'нет входа'); }, JOIN_TIMEOUT_MS);

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { metrics.inc('doska_bad_messages_total'); return; }
    // 'null' и '5' — тоже законный JSON, а дальше повсюду m.что-то
    if (!m || typeof m !== 'object' || Array.isArray(m)) { metrics.inc('doska_bad_messages_total'); return; }
    const op = opLabel(m.t);
    /* Сколько занял разбор и рассылка одного сообщения. Замер — два вычитания,
       на рисование не влияет, зато лаги видно раньше, чем их заметит учитель.
       Курсоры и живой штрих не меряем: их много, а полезного в их задержке
       ничего — они и так идут мимо всей логики. */
    const done = (op === 'cursor' || op === 'live')
      ? null : metrics.timer('doska_op_seconds', { op });
    try {
      await handleMessage(ws, m);
    } catch (e) {
      /* Обработчик асинхронный: исключение становилось необработанным отказом
         и завершало процесс. Поля сообщения присылает клиент, и достаточно
         было одного кривого кадра от любого участника, чтобы оборвать все
         занятия на сервере. В журнал — по разу на сокет, иначе поток мусора
         превратился бы в поток строк на диске. */
      metrics.inc('doska_bad_messages_total');
      if (!ws.errLogged) { ws.errLogged = true; console.error('сообщение ' + op + ':', e.message); }
      if (m.t === 'join' && !ws.room) ws.close(1011, 'не удалось войти');
    } finally {
      if (done) done();
      metrics.inc('doska_messages_total', 1, { op });
    }
  });

  async function handleMessage(ws, m) {
    if (m.t === 'join') {
      // joining — второй join не должен проскочить, пока первый ждёт базу: сокет
      // оказался бы сразу в двух комнатах и из одной никогда бы не вышел
      if (ws.room || ws.joining || !okId(String(m.room || ''))) return;
      ws.joining = true;
      const id = String(m.room);
      const s = ws.session;
      const { cap, board } = await cap_.resolve(s, id);
      if (cap === 'none') { send(ws, { t: 'denied' }); ws.close(4003, 'нет доступа'); return; }

      const room = await loadRoom(id);
      // Пока ждали базу и диск, человек мог уйти. Событие close уже отработало,
      // и добавленный сейчас сокет остался бы в комнате призраком навсегда.
      if (ws.readyState !== 1) return;
      if (cap !== 'owner' && room.clients.size >= MAX_PEERS) { ws.close(4008, 'доска заполнена'); return; }
      clearTimeout(ws.joinTimer);
      if (board) applyMeta(room, board);
      ws.room = room;
      ws.me.cap = cap;
      ws.me.uid = authorOf(id, s.kind === 'guest' ? s.guestId : s.uid);
      // имя вошедшего берём из профиля mcko-app, а не с его слов
      ws.me.name = s.kind === 'user'
        ? cleanName(s.fullName || s.email || 'Преподаватель', 24)
        : (cleanName(m.name || s.name || 'Гость', 24) || 'Гость');

      room.clients.add(ws); room.touched = Date.now();
      // z — клиент умеет распаковать gzip и просит доску сжатой
      sendInit(ws, room, m.z === 'gzip');
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
    noteActivity(room, ws, m);

    switch (m.t) {
      /* Сводка от браузера: за сколько у человека открылась доска и на что
         ушло время. Одна строка в журнал на подключение; формат нарочно не
         похож на «+ имя (роль) → n» — scripts/day-report.js её не считает. */
      case 'perf': {
        if (ws.perfLogged) return;
        ws.perfLogged = true;
        const n = k => Math.min(600000, Math.max(0, Math.round(+m[k] || 0)));
        const s = k => (n(k) / 1000).toFixed(1);
        const mb = (n('kb') / 1024).toFixed(2);
        console.log('[' + room.id + '] доска у ' + ws.me.name + ' открылась за ' + s('total') + ' с' +
          (m.page != null ? ' (+ страница ' + s('page') + ' с)' : '') + ': связь ' + s('open') +
          (m.z ? ', ответ сервера ' + s('wait') + ', загрузка ' + mb + ' МБ сжатой ' + s('data') +
                 ', распаковка ' + s('unpack')
               : ', ответ и загрузка ' + mb + ' МБ без сжатия ' + s('wait')) +
          ', разбор ' + s('apply') + ', кадр ' + s('paint') + ' · объектов ' + n('items'));
        return;
      }
      case 'live': {
        if (!mayEdit || !mayRelay(ws)) return;
        const live = cleanLive(m);
        if (!live) return;
        /* Копится так же, как курсоры, но склейкой, а не заменой: у живого
           штриха есть счётчик from, и получатель дописывает точки, только
           если from совпал с тем, сколько их у него уже есть. Выбросить
           промежуточный кадр значило бы разорвать эту цепочку, и остаток
           штриха у соседей просто не дорисовался бы до конца жеста.

           За 50 мс при шаге клиента в 45 мс иногда приходит два кадра — их и
           склеиваем в один. Если же from не сошёлся (начался новый штрих или
           кадры разъехались), кладём как есть: цепочку рассудит получатель. */
        const key = ws.me.sid + '|' + live.sid;
        const had = room.live.get(key);
        if (had && live.from === had.from + had.pts.length) {
          had.pts.push(...live.pts);
          had.kind = live.kind; had.color = live.color; had.size = live.size;
        } else {
          room.live.set(key, { by: ws.me.sid, ...live });
        }
        return;
      }

      case 'add': {
        if (!mayEdit) return;
        const src = m.item || {};
        const it = pick(src.type)(src, ws.me.uid);
        if (!it || room.byId.has(it.id)) return;

        // Потолок объектов. Раньше при переполнении молча выбрасывались две
        // тысячи самых старых — то есть начало занятия исчезало, и человек
        // узнавал об этом, только пролистав наверх. Теперь доска не принимает
        // новое и говорит об этом: потерять написанное хуже, чем упереться.
        if (roomFull(room, it)) {
          send(ws, { t: 'full' });
          return;
        }
        room.items.push(it);
        room.byId.set(it.id, it);
        room.points += pointsOf(it);
        const sent = pt.wire(it);
        record(room, { t: 'add', item: sent });
        broadcast(room, { t: 'add', item: sent }, ws);
        return;
      }

      case 'move': {
        if (!mayEdit) return;
        const it = room.byId.get(m.id);
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
        if (applied.pts) room.points += pt.count(applied.pts, pt.strideOf(it));   // точно посчитает weigh
        // заплатка тоже может нести точки — разворачиваем по шагу самого объекта
        const patch = pt.wire(applied, pt.strideOf(it));
        record(room, { t: 'move', id: it.id, ...patch });
        broadcast(room, { t: 'move', id: it.id, ...patch }, ws);
        return;
      }

      case 'erase': {
        if (!mayEdit) return;
        const ids = new Set((m.ids || []).slice(0, 5000).map(String));
        // Ластик закреплённое не трогает — это гарантия сервера, а не только
        // клиента: без нёе изменённый клиент мог бы стереть закреплённое тем
        // же взмахом. «Удалить» (ПКМ) и отмена/повтор — уже не взмах, а
        // осознанное действие человека, поэтому шлют force и обходят запрет;
        // «своё/чужое» (mine) им это не отменяет.
        const force = !!m.force;
        const gone = [];
        room.items = room.items.filter(it => {
          if (!ids.has(it.id) || !mine(it) || (it.locked && !force)) return true;
          gone.push(it.id); return false;
        });
        if (!gone.length) return;
        for (const id of gone) room.byId.delete(id);
        record(room, { t: 'erase', ids: gone });
        broadcast(room, { t: 'erase', ids: gone }, ws);
        return;
      }

      case 'restore': {
        if (!mayEdit || !Array.isArray(m.items)) return;
        const back = [];
        for (const src of m.items.slice(0, 800)) {
          if (!src || typeof src !== 'object') continue;
          const it = pick(src.type)(src, ws.me.uid);
          if (!it || room.byId.has(it.id)) continue;
          if (roomFull(room, it)) { send(ws, { t: 'full' }); break; }
          room.items.push(it); room.byId.set(it.id, it); room.points += pointsOf(it); back.push(it);
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
        if (ws.me.cap === 'none' || !mayRelay(ws)) return;
        room.curs.set(ws.me.sid, { x: fin(m.x, 0), y: fin(m.y, 0) });
        return;

      case 'view':
        if (!owner || !mayRelay(ws)) return;
        broadcast(room, { t: 'view', cam: cleanCam(m.cam), w: fin(m.w, 0) }, ws);
        return;

      // Своя видимая область — от кого угодно, не только от владельца: это
      // просто «вот где я сейчас смотрю» для стрелок-указателей у чужого
      // края экрана, а не управление чьей-то камерой (в отличие от 'view').
      case 'presence':
        if (ws.me.cap === 'none' || !mayRelay(ws)) return;
        room.pres.set(ws.me.sid, { cam: cleanCam(m.cam), w: fin(m.w, 0), h: fin(m.h, 0) });
        return;

      /* «Все ко мне»: преподаватель разово переносит участников к тому месту,
         где объясняет. От 'view' отличается тем, что применяется независимо от
         того, включил ли участник слежение. */
      case 'callAll':
        if (!owner || !mayRelay(ws)) return;
        broadcast(room, { t: 'goto', cam: cleanCam(m.cam), w: fin(m.w, 0) }, ws);
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
        room.byId.clear();
        room.points = 0;
        record(room, { t: 'clear' });
        broadcast(room, { t: 'cleared' });
        return;
    }
  }

  ws.on('close', () => {
    clearTimeout(ws.joinTimer);
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

/* ═══════ кто что делал на доске ═══════

   Открытая вкладка — ещё не занятие. 5 ноября учитель и ученик не закрыли
   вкладки после урока, и отчёт насчитал занятие до глубокой ночи, а следующим
   днём — ещё одно, которого не было. Поэтому раз в минуту в журнал уходит
   строка о том, кто за эту минуту что-то делал:
     [доска] действия {"Имя":[правки, движения]}
   Правки — изменения содержимого, движения — курсор и камера. Минут без
   действий в журнале нет вовсе. Читает это scripts/day-report.js.

   Считаем только то, за чем стоит человек. Сама по себе приходит первая
   область экрана при входе (sendPresence в 'init'): вкладка переподключается
   и без человека. */
const BOARD_EDITS = new Set(['add', 'move', 'erase', 'restore', 'z', 'clear']);
function noteActivity(room, ws, m) {
  const edit = BOARD_EDITS.has(m.t);
  if (!edit && m.t !== 'cursor' && m.t !== 'presence') return;
  if (m.t === 'presence' && !ws.framed) { ws.framed = true; return; }
  const acts = room.acts || (room.acts = new Map());
  const a = acts.get(ws.me.name) || [0, 0];
  a[edit ? 0 : 1]++;
  acts.set(ws.me.name, a);
}
function flushActivity() {
  for (const room of rooms.values()) {
    if (!room.acts || !room.acts.size) continue;
    console.log('[' + room.id + '] действия ' + JSON.stringify(Object.fromEntries(room.acts)));
    room.acts.clear();
  }
}
setInterval(flushActivity, 60000);

/* ═══════ курсоры и области — одной пачкой на комнату ═══════

   Замер (scripts/load-test.js) показал, где именно упирается доска, и это
   оказались не штрихи, а курсоры: их шлют ВСЕ, а рисуют единицы. Каждое такое
   сообщение размножалось на всех остальных, и на ста участниках выходило под
   180 тысяч исходящих кадров в секунду только на курсоры. Сервер отдавал
   около 34 тысяч — меньше десятой части того, что требовалось, и при этом
   переставал отвечать по HTTP вовсе.

   Дело было не в объёме данных, а в числе кадров: на каждый уходит вызов
   отправки и обрамление веб-сокета. Поэтому копим положения и раз в 50 мс
   шлём одно сообщение на комнату — данных столько же, кадров в сто раз
   меньше.

   Пачка уходит всем, включая самого отправителя (одна сборка, одна отправка
   на человека); свой курсор клиент пропускает при разборе — ему рисовать
   собственный незачем. */
const CURSOR_FLUSH_MS = 50;
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.curs.size) {
      const list = [];
      for (const [sid, p] of r.curs) list.push([sid, p.x, p.y]);
      r.curs.clear();
      broadcast(r, { t: 'cursors', list });
    }
    if (r.pres.size) {
      const list = [];
      for (const [sid, p] of r.pres) list.push([sid, p.cam, p.w, p.h]);
      r.pres.clear();
      broadcast(r, { t: 'presences', list });
    }
    if (r.live.size) {
      const list = [...r.live.values()];
      r.live.clear();
      broadcast(r, { t: 'lives', list });
    }
  }
}, CURSOR_FLUSH_MS);

/* Права проверяются заново раз в минуту, а не на каждое сообщение: обработчик
   должен оставаться синхронным, иначе движок начнёт ждать сеть. Владелец убрал
   участника — тот отвалится в течение минуты, а не после конца урока. */
async function recheckCap(ws) {
  let cap;
  try { ({ cap } = await cap_.resolve(ws.session, ws.room.id, { fresh: true })); }
  catch { return; }                           // сбой связи прав не отнимает
  if (cap === ws.me.cap) return;
  ws.me.cap = cap;
  if (cap === 'none') { send(ws, { t: 'denied' }); ws.close(4003, 'доступ отозван'); return; }
  send(ws, { t: 'cap', cap });
  broadcast(ws.room, { t: 'peer', peer: peerInfo(ws) }, ws);
}

/* Пачками, а не по одному. Раньше здесь стоял обычный for с await внутри: на
   сотне участников это две сотни обращений к Supabase строго друг за другом,
   и обход растягивался на секунды. Залпом все сразу — тоже нельзя, упрёмся в
   его лимиты. Восемь за раз держат обход в пределах секунды и не создают
   всплеска; одинаковые запросы (две вкладки одного человека) вдобавок
   склеиваются в lib/capability.js. */
const CAP_BATCH = 8;
setInterval(async () => {
  const list = [...wss.clients].filter(ws => ws.room && ws.session);
  for (let i = 0; i < list.length; i += CAP_BATCH) {
    await Promise.all(list.slice(i, i + CAP_BATCH).map(ws => recheckCap(ws)));
  }
}, CAP_RECHECK_MS);

/* На каком адресе слушать. По умолчанию все — так работает на своей машине и
   в проверках. За обратным прокси стоит указать 127.0.0.1: тогда порт доски
   снаружи попросту не виден, и единственная дверь в приложение — прокси с
   сертификатом. */
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('Доска: http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('Данные: ' + DATA_DIR);
});

/* Последняя страховка. По умолчанию необработанный отказ обещания завершает
   процесс, а с ним и все занятия; причины закрыты на границах (route и разбор
   сообщений), а это на случай того, что там ещё не предусмотрено. */
process.on('unhandledRejection', e => console.error('необработанный отказ:', (e && e.stack) || e));

/* Выход по сигналу: дописываем журналы и снимаем снимки. Раньше здесь был
   синхронный по виду, но асинхронный по сути вызов persist — процесс успевал
   умереть раньше, чем запись доходила до диска. */
let leaving = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  if (leaving) return;
  leaving = true;
  flushActivity();
  try {
    await Promise.all([...rooms.values()].map(r => store.closeRoom(r.id, r)));
    console.log('\nсохранено, выход');
  } catch (e) {
    console.error('сохранение при выходе:', e.message);
  }
  process.exit(0);
});
