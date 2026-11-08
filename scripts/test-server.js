/* ============================================================
   Прогон сервера: настоящий server.js, настоящие сокеты.

   Зачем. Клиент проверяется в check-client.js, а у сервера проверок не было
   совсем — при том что именно он решает, кто что может, и именно его падение
   разом обрывает все занятия. Здесь каждая проверка соответствует одной
   найденной дыре: вернётся дыра — выкладка не пройдёт (deploy.sh гоняет
   npm run check и при ошибке оставляет прежнюю версию).

   Как устроен. Поднимает заглушку Supabase и сам server.js отдельным
   процессом на свободных портах, с данными во временной папке. Боевые данные
   и боевой порт не трогает. Если проверка уронила сервер, это её провал, а
   следующая получает свежий процесс.

   Потолки и интервалы задаются окружением, чтобы проверять поведение на
   пределе за секунды: не ждать минуту и не рисовать четыре миллиона точек.
   ============================================================ */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'doska-test-'));
const TEACHER = '11111111-1111-4111-8111-111111111111';
const RIGHT = 'верный-пароль';
const MAX_PEERS = 3;
const MAX_POINTS = 5000;

const sleep = ms => new Promise(ok => setTimeout(ok, ms));

/* ─── заглушка Supabase ─── */

const boards = new Map();            // id → { guest: 'none' | 'view' | 'edit' }

function mockAnswer(req, body) {
  const u = new URL(req.url, 'http://x');
  const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
  if (u.pathname === '/rest/v1/rpc/doska_guest_open_link') {
    const b = boards.get(body.p_board_id);
    return [200, b && b.guest !== 'none'
      ? [{ board_id: body.p_board_id, title: 'Проверка', access: b.guest, object_edit_policy: 'own', locked: false }]
      : []];
  }
  if (u.pathname === '/auth/v1/token') {
    if (body.password !== RIGHT) return [400, { error_description: 'Invalid login credentials' }];
    return [200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600,
                   user: { id: TEACHER, email: body.email } }];
  }
  if (u.pathname === '/rest/v1/profiles')
    return [200, [{ id: TEACHER, role: 'teacher', full_name: 'Учитель', email: 't@t.t', organization_id: null }]];
  if (u.pathname === '/rest/v1/doska_boards') {
    const b = boards.get(id);
    return [200, b ? [{ id, owner_id: TEACHER, title: 'Проверка', guest_access: b.guest,
                        object_edit_policy: 'own', locked: false,
                        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] : []];
  }
  return [200, []];
}

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const [code, out] = mockAnswer(req, body);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

/* ─── сервер ─── */

let child = null, port = 0, base = '', tail = '';

const freePort = () => new Promise(ok => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});

async function start() {
  port = await freePort();
  base = 'http://127.0.0.1:' + port;
  tail = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: '1',
      SUPABASE_URL: 'http://127.0.0.1:' + mock.address().port, SUPABASE_ANON_KEY: 'test',
      SESSION_SECRET: 'x'.repeat(40),
      MAX_PEERS: String(MAX_PEERS), MAX_POINTS: String(MAX_POINTS),
      CAP_TTL_MS: '40', CAP_RECHECK_MS: '120', JOIN_TIMEOUT_MS: '400',
    },
  });
  const keep = d => { tail = (tail + d).slice(-1500); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  for (let i = 0; i < 200; i++) {
    if (await fetch(base + '/api/config').then(r => r.ok, () => false)) return;
    await sleep(25);
  }
  throw new Error('сервер не поднялся: ' + tail);
}

const running = () => child && child.exitCode === null && child.signalCode === null;

/* ─── помощники ─── */

let boardNo = 0, ipNo = 0;
const board = (guest = 'edit') => { const id = 't' + (++boardNo) + crypto.randomBytes(3).toString('hex');
                                    boards.set(id, { guest }); return id; };
const nextIp = () => { ipNo++; return '10.' + (ipNo >> 16 & 255) + '.' + (ipNo >> 8 & 255) + '.' + (ipNo & 255); };
const guestNo = () => crypto.randomBytes(12).toString('base64url');
const cookieOf = r => (r.headers.getSetCookie()[0] || '').split(';')[0];

const post = (p, body, ip = nextIp(), headers = {}) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function enter(id, { guestId = guestNo(), name = 'Гость' } = {}) {
  const r = await post('/api/guest/enter', { board: id, name, guestId });
  assert.strictEqual(r.status, 200, 'вход гостя');
  return cookieOf(r);
}
const login = (email, password, ip) => post('/api/auth/login', { email, password }, ip);

function open(cookie) {
  return new Promise((ok, no) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port, {
      headers: { cookie, 'x-real-ip': nextIp() }, maxPayload: 64 * 1024 * 1024 });
    ws.box = [];
    ws.on('message', d => { try { ws.box.push(JSON.parse(d)); } catch {} });
    ws.on('error', () => {});
    ws.on('open', () => ok(ws));
    ws.on('unexpected-response', (q, r) => no(new Error('рукопожатие ' + r.statusCode)));
  });
}

async function until(ws, pred, ms = 1500, what = 'сообщения') {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) {
    const hit = ws.box.find(pred);
    if (hit) return hit;
  }
  throw new Error('не дождались ' + what);
}

function closed(ws, ms = 1500) {
  return new Promise((ok, no) => {
    if (ws.readyState === 3) return ok(ws.closeCode);
    const t = setTimeout(() => no(new Error('сокет не закрыли')), ms);
    ws.on('close', c => { clearTimeout(t); ws.closeCode = c; ok(c); });
  });
}

const send = (ws, o) => ws.send(JSON.stringify(o));

async function joinWith(id, cookie, name = 'Гость') {
  const ws = await open(cookie);
  send(ws, { t: 'join', room: id, name });
  ws.init = await until(ws, m => m.t === 'init', 1500, 'доски');
  return ws;
}
const join = async (id, o = {}) => joinWith(id, await enter(id, o), o.name);

const stroke = (id, n = 2) => ({ id, type: 'pen', color: '#000', size: 2,
                                 pts: Array.from({ length: n }, (_, i) => [i, i, 0.5]) });
const hasItem = (ws, id) => ws.init.items.some(i => i.id === id);

/** Дописать и убедиться, что правка дошла: свежий участник видит доску как есть. */
async function look(id) {
  const ws = await join(id);
  ws.close();
  return ws;
}

async function roomsOpen() {
  const t = await (await fetch(base + '/metrics')).text();
  return +t.match(/^doska_rooms_open (\d+)/m)[1];
}

/* ─── проверки ─── */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* Сервер падает — обрываются все занятия сразу, поэтому это первое. */
for (const [label, frame] of [
  ['null', 'null'],
  ['число', '5'],
  ['строка', '"x"'],
  ['массив', '[]'],
  ['erase без списка', '{"t":"erase","ids":5}'],
  ['z без списка', '{"t":"z","ids":7}'],
  ['restore с пустотой', '{"t":"restore","items":[null]}'],
  ['add с типом __proto__', '{"t":"add","item":{"type":"__proto__","id":"p"}}'],
  ['add с типом valueOf', '{"t":"add","item":{"type":"valueOf","id":"v"}}'],
]) {
  test('кадр «' + label + '» не роняет сервер', async () => {
    const id = board();
    const ws = await join(id);
    ws.send(frame);
    await sleep(30);
    send(ws, { t: 'add', item: stroke('после') });
    await sleep(30);
    assert.ok(hasItem(await look(id), 'после'), 'сокет перестал работать');
    ws.close();
  });
}

test('кадр больше потолка закрывает сокет, а не сервер', async () => {
  const ws = await join(board());
  ws.send('x'.repeat(3 * 1024 * 1024));
  assert.strictEqual(await closed(ws), 1009);
});

test('испорченный кадр закрывает сокет, а не сервер', async () => {
  const ws = await join(board());
  ws._socket.write(Buffer.from([0xff, 0x00]));
  await closed(ws);
});

test('запрос с адресом «//» не роняет сервер', async () => {
  const answer = await new Promise((ok, no) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let got = '';
    s.on('data', d => got += d);
    s.on('close', () => ok(got));
    s.on('error', no);
  });
  assert.match(answer, /^HTTP\/1\.1 400/);
});

test('тип constructor не проводит объект мимо проверки', async () => {
  const id = board();
  const ws = await join(id);
  send(ws, { t: 'add', item: { type: 'constructor', id: 'обход', url: 'javascript:1', evil: 1 } });
  await sleep(30);
  assert.ok(!hasItem(await look(id), 'обход'));
  ws.close();
});

test('адрес автора и номер гостя не уходят другим участникам', async () => {
  const id = board(), secret = guestNo();
  const a = await join(id, { guestId: secret });
  const b = await join(id);
  send(a, { t: 'add', item: stroke('чьё') });
  const got = await until(b, m => m.t === 'add');
  assert.ok(!String(got.item.by).includes(secret), 'номер гостя виден в by');
  assert.ok(!String(got.item.by).startsWith('g:'), 'by раскрывает вид учётной записи');
  await sleep(30);
  const it = (await look(id)).init.items.find(i => i.id === 'чьё');
  assert.ok(!String(it.by).includes(secret), 'номер гостя виден при входе');
  a.close(); b.close();
});

test('подделать чужого гостя нельзя: чужое стереть не выходит', async () => {
  const id = board();
  const a = await join(id);
  const b = await join(id);
  send(a, { t: 'add', item: stroke('жертва') });
  const seen = await until(b, m => m.t === 'add');
  // ровно то, что мог сделать вор: взять увиденное by и зайти с ним же
  const forged = String(seen.item.by).replace(/^g:/, '').replace(/^a_/, '').slice(0, 32);
  const thief = await join(id, { guestId: forged });
  send(thief, { t: 'erase', ids: ['жертва'], force: true });
  await sleep(40);
  a.close(); b.close(); thief.close();      // иначе проверяющему не хватит места на доске
  await sleep(40);
  assert.ok(hasItem(await look(id), 'жертва'), 'чужое стёрто');
});

test('свой объект после перезахода остаётся своим', async () => {
  const id = board(), gid = guestNo();
  const a = await join(id, { guestId: gid });
  send(a, { t: 'add', item: stroke('моё') });
  await sleep(30);
  a.close();
  const again = await join(id, { guestId: gid });
  send(again, { t: 'erase', ids: ['моё'] });
  await sleep(30);
  assert.ok(!hasItem(await look(id), 'моё'), 'своё не стёрлось');
  again.close();
});

test('старая доска: автор узнаётся, а номер наружу не уходит', async () => {
  const id = board(), gid = 'OldGuest1234567890';
  const dir = path.join(DATA, 'boards', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'snap.json'), JSON.stringify({
    v: 5, seq: 0, title: 'старая', ownerId: TEACHER, locked: false, anyEdit: false,
    items: [{ id: 'старое', by: 'g:' + gid, type: 'pen', color: '#000', size: 2,
              pts: [[0, 0, 0.5], [5, 5, 0.5]] }],
  }));
  const ws = await join(id, { guestId: gid });
  const it = ws.init.items.find(i => i.id === 'старое');
  assert.ok(it, 'объект потерян');
  assert.strictEqual(it.by, ws.init.you.uid, 'автор не узнан');
  assert.ok(!String(it.by).includes(gid), 'старый номер виден');
  send(ws, { t: 'erase', ids: ['старое'] });
  await sleep(30);
  assert.ok(!hasItem(await look(id), 'старое'), 'автор потерял своё');
  ws.close();
});

test('учитель не получает на провод свой настоящий идентификатор', async () => {
  const id = board();
  const r = await login('uid@t.t', RIGHT, nextIp());
  const ws = await joinWith(id, cookieOf(r));
  assert.notStrictEqual(ws.init.you.uid, TEACHER);
  ws.close();
});

test('выключенный гостевой доступ закрывает уже открытую доску', async () => {
  const id = board();
  const ws = await join(id);
  boards.get(id).guest = 'none';
  assert.strictEqual(await closed(ws), 4003);
});

test('гостя можно понизить до зрителя посреди занятия', async () => {
  const id = board();
  const ws = await join(id);
  boards.get(id).guest = 'view';
  await until(ws, m => m.t === 'cap' && m.cap === 'view', 1500, 'понижения');
  send(ws, { t: 'add', item: stroke('запрет') });
  await sleep(30);
  assert.ok(!hasItem(await look(id), 'запрет'), 'зритель смог писать');
  ws.close();
});

test('гость без доступа не видит картинки доски', async () => {
  const id = board();
  const cookie = await enter(id);
  boards.get(id).guest = 'none';
  await sleep(80);
  const r = await fetch(base + '/files/' + id + '/x.png', { headers: { cookie } });
  assert.strictEqual(r.status, 403);
});

test('загрузка без прав не поднимает комнату', async () => {
  const before = await roomsOpen();
  const r = await fetch(base + '/api/upload?board=ghost' + crypto.randomBytes(3).toString('hex'), {
    method: 'POST', headers: { 'content-type': 'image/png', 'x-real-ip': nextIp() }, body: 'x' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(await roomsOpen(), before, 'комната поднялась');
});

test('загрузка принимает только настоящие картинки', async () => {
  const id = board();
  const cookie = await enter(id);
  const up = (body, type) => fetch(base + '/api/upload?board=' + id, {
    method: 'POST', headers: { 'content-type': type, cookie, 'x-real-ip': nextIp() }, body });
  assert.strictEqual((await up('<html><script>1</script>', 'image/png')).status, 415, 'html под видом png');
  assert.strictEqual((await up('x', 'constructor')).status, 415, 'тип constructor');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  assert.strictEqual((await up(png, 'image/png')).status, 200, 'настоящий png');
});

test('метрики не видны через прокси, а изнутри видны', async () => {
  assert.strictEqual((await fetch(base + '/metrics')).status, 200);
  const r = await fetch(base + '/metrics', { headers: { 'x-forwarded-for': '8.8.8.8' } });
  assert.strictEqual(r.status, 403);
});

test('ошибки входа с одного адреса не запирают вход остальным', async () => {
  const a = nextIp();
  for (let i = 0; i < 5; i++) assert.strictEqual((await login('x' + i + '@t.t', 'нет', a)).status, 401);
  assert.strictEqual((await login('other@t.t', RIGHT, nextIp())).status, 200);
});

test('подбор пароля к одной почте запирается', async () => {
  for (let i = 0; i < 5; i++) await login('victim@t.t', 'нет', nextIp());
  assert.strictEqual((await login('victim@t.t', RIGHT, nextIp())).status, 429);
});

test('перебор почт с одного адреса запирается', async () => {
  const a = nextIp();
  for (let i = 0; i < 20; i++) await login('spray' + i + '@t.t', 'нет', a);
  assert.strictEqual((await login('sprayN@t.t', RIGHT, a)).status, 429);
});

test('поток гостевых входов с одного адреса режется', async () => {
  const id = board(), a = nextIp();
  let refused = 0;
  for (let i = 0; i < 140; i++) {
    const r = await post('/api/guest/enter', { board: id, name: 'г', guestId: guestNo() }, a);
    if (r.status === 429) refused++;
  }
  assert.ok(refused > 0, 'лимита нет');
  assert.strictEqual((await post('/api/guest/enter', { board: id, name: 'г', guestId: guestNo() })).status, 200);
});

test('пустое тело запроса — ошибка запроса, а не сервера', async () => {
  assert.strictEqual((await post('/api/guest/enter', 'null')).status, 400);
  assert.strictEqual((await post('/api/guest/enter', '{битый')).status, 400);
});

test('заголовки защиты стоят на всех ответах', async () => {
  for (const p of ['/', '/api/config', '/js/нет-такого.js']) {
    const h = (await fetch(base + p)).headers;
    assert.match(h.get('content-security-policy') || '', /script-src 'self'/, p);
    assert.match(h.get('content-security-policy') || '', /frame-ancestors 'none'/, p);
    assert.strictEqual(h.get('x-content-type-options'), 'nosniff', p);
    assert.strictEqual(h.get('x-frame-options'), 'DENY', p);
    assert.strictEqual(h.get('referrer-policy'), 'same-origin', p);
  }
});

test('сверх потолка на доску не пускают, а владельца пускают', async () => {
  const id = board();
  const people = [];
  for (let i = 0; i < MAX_PEERS; i++) people.push(await join(id));
  const extra = await open(await enter(id));
  send(extra, { t: 'join', room: id, name: 'лишний' });
  assert.strictEqual(await closed(extra), 4008);
  const r = await login('owner@t.t', RIGHT, nextIp());
  const owner = await joinWith(id, cookieOf(r));
  assert.strictEqual(owner.init.you.cap, 'owner');
  [...people, owner].forEach(w => w.close());
});

test('ушедший посреди входа не остаётся призраком', async () => {
  const id = board();
  const cookie = await enter(id);
  for (let i = 0; i < 5; i++) {
    const w = await open(cookie);
    send(w, { t: 'join', room: id, name: 'призрак' });
    w.terminate();
  }
  await sleep(120);
  const ws = await join(id);
  assert.strictEqual(ws.init.peers.length, 0, 'в комнате остались призраки');
  ws.close();
});

test('сокет без входа на доску не висит', async () => {
  const id = board();
  const ws = await open(await enter(id));
  await closed(ws);
});

test('потолок точек: доска перестаёт принимать, а не сервер падает', async () => {
  const id = board();
  const ws = await join(id);
  send(ws, { t: 'add', item: stroke('первый', 3000) });
  send(ws, { t: 'add', item: stroke('второй', 3000) });
  await until(ws, m => m.t === 'full', 1500, 'отказа');
  await sleep(30);
  const seen = await look(id);
  assert.ok(hasItem(seen, 'первый'), 'первый штрих потерян');
  assert.ok(!hasItem(seen, 'второй'), 'потолок не сработал');
  ws.close();
});

test('имя гостя не подделывает строки журнала', async () => {
  const id = board();
  const ws = await join(id);
  const other = await join(id, { name: 'а\n2026-01-01T00:00:00: [x] + b (owner) → 2' });
  const peer = ws.box.find(m => m.t === 'peer') || await until(ws, m => m.t === 'peer');
  assert.ok(!/[\r\n]/.test(peer.peer.name), 'перевод строки прошёл');
  ws.close(); other.close();
});

test('обычное занятие работает: штрих, правка, стирание', async () => {
  const id = board();
  const a = await join(id);
  const b = await join(id);
  send(a, { t: 'add', item: stroke('штрих') });
  const got = await until(b, m => m.t === 'add');
  assert.strictEqual(got.item.by, a.init.you.uid, 'своё не узнаётся');
  send(a, { t: 'move', id: 'штрих', color: '#123456' });
  await until(b, m => m.t === 'move' && m.color === '#123456');
  send(b, { t: 'erase', ids: ['штрих'] });
  await sleep(30);
  assert.ok(hasItem(await look(id), 'штрих'), 'чужой участник стёр не своё');
  send(a, { t: 'erase', ids: ['штрих'] });
  await until(b, m => m.t === 'erase');
  a.close(); b.close();
});

/* ─── прогон ─── */

(async () => {
  // Выкладка гоняет это на боевой машине с одним ядром, возможно посреди
  // занятия: уступаем процессор настоящему серверу. Дочерний процесс наследует.
  try { os.setPriority(19); } catch {}
  await new Promise(ok => mock.listen(0, '127.0.0.1', ok));
  await start();
  let failed = 0;
  for (const t of tests) {
    let err = null;
    try {
      await t.fn();
    } catch (e) { err = e; }
    await sleep(err ? 150 : 25);            // процессу нужно время, чтобы умереть
    if (!running()) { err = new Error('сервер упал' + (err ? ': ' + err.message : '')); await start(); }
    if (err) { failed++; console.log('✗ ' + t.name + '\n    ' + err.message); }
  }
  // Сервер при остановке ещё дописывает снимки досок: пока он жив, папку не
  // удалить. Да и уборка не должна решать судьбу выкладки, проверки уже прошли.
  const gone = new Promise(ok => child.once('exit', ok));
  child.kill();
  await Promise.race([gone, sleep(5000)]);
  mock.close();
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  console.log(failed ? 'сервер: не прошло ' + failed + ' из ' + tests.length
                     : 'сервер: все ' + tests.length + ' проверок прошли');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(e);
  if (child) child.kill();
  process.exit(1);
});
