/* ============================================================
   Нагрузка на доску: сколько человек она держит.

   Зачем. Про потолок в сто участников до сих пор были только оценки по коду.
   Считалось так: курсор идёт 18 раз в секунду от каждого, живой штрих — 22
   раза от каждого рисующего, и каждое такое сообщение сервер размножает на
   всех остальных. На сотне человек это под двести тысяч исходящих кадров в
   секунду — но такое надо проверять, а не считать в уме.

   Как входим без Supabase. Боты берут ГОСТЕВЫЕ сессии и создают их напрямую
   через lib/session.js — тем же вызовом, что и /api/guest/enter. Гостю права
   разрешаются без единого обращения к БД (см. lib/capability.js: сессия
   выдана на одну доску и уже подтверждена при входе), поэтому весь путь —
   рукопожатие, join, рисование — работает на одних локальных файлах. Ни
   ключей, ни отдельного режима в самом сервере для этого не понадобилось:
   заводить в боевом коде обход входа ради замеров нельзя.

   Важно: SESSION_SECRET у скрипта и у сервера должен совпадать — иначе сервер
   не расшифрует файлы сессий, которые скрипт положил на диск.

   Запуск (сервер уже поднят на том же DATA_DIR и том же SESSION_SECRET):

     node scripts/load-test.js --clients 100 --drawing 20 --seconds 30 --port 8099
   ============================================================ */
'use strict';
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const session = require('../lib/session');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};

const CLIENTS  = +arg('clients', 20);
const DRAWING  = +arg('drawing', Math.max(1, Math.round(CLIENTS * 0.2)));
const SECONDS  = +arg('seconds', 20);
const PORT     = +arg('port', process.env.PORT || 8080);
const HOST     = arg('host', '127.0.0.1');
const BOARD    = arg('board', 'loadtest');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

/* Частоты — ровно те, что придерживается настоящий клиент (net.stream,
   net.cursor, net.sendPresence в public/index.html). Взять другие значит
   мерить не ту нагрузку, которая бывает на самом деле. */
const LIVE_MS     = 45;
const CURSOR_MS   = 55;
const PRESENCE_MS = 250;
const STROKE_MS   = 1200;        // примерно столько длится один штрих

const stat = { joined: 0, joinFailed: 0, sent: 0, recv: 0, recvBytes: 0, joinMs: [] };
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

const makeSession = i => session.createGuest({
  boardId: BOARD, level: 'edit',
  guestId: 'load' + String(i).padStart(6, '0'),
  name: 'Бот ' + i,
});

function connect(i, sid, draws) {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://' + HOST + ':' + PORT, {
      headers: { cookie: session.COOKIE + '=' + sid },
    });
    const t0 = nowMs();
    const timers = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'join', room: BOARD, name: 'Бот ' + i }));
      stat.sent++;
    });
    ws.on('message', data => {
      stat.recv++;
      stat.recvBytes += data.length;
      // ждём init — до него участник доску ещё не видит
      if (!ws._ready && String(data).indexOf('"t":"init"') >= 0) {
        ws._ready = true;
        stat.joined++;
        stat.joinMs.push(nowMs() - t0);
        resolve({ ws, timers, draws });
      }
    });
    ws.on('error', () => { if (!ws._ready) { stat.joinFailed++; resolve(null); } });
    ws.on('close', () => { for (const t of timers) clearInterval(t); });
    setTimeout(() => { if (!ws._ready) { stat.joinFailed++; resolve(null); } }, 20000);
  });
}

/* Нагрузка одного бота. Курсор и область — от всех, живой штрих — только от
   рисующих: так и бывает на занятии, где пишет учитель и двое у доски. */
function startLoad(c, i) {
  if (!c) return;
  const ws = c.ws, timers = c.timers;
  const send = o => { if (ws.readyState === 1) { ws.send(JSON.stringify(o)); stat.sent++; } };
  let phase = i * 37;                       // разводим ботов по фазе, чтобы не били в такт

  timers.push(setInterval(() => {
    send({ t: 'cursor', x: 500 + Math.sin(phase += 0.1) * 400, y: 300 + Math.cos(phase) * 200 });
  }, CURSOR_MS));
  timers.push(setInterval(() => {
    send({ t: 'presence', cam: { x: 0, y: 0, z: 1 }, w: 1280, h: 720 });
  }, PRESENCE_MS));
  if (!c.draws) return;

  let sid = 'b' + i + '-' + Date.now(), sentPts = 0, k = 0;
  timers.push(setInterval(() => {
    // 6 точек за кадр — столько накапливает перо на 120 Гц за 45 мс
    const pts = [];
    for (let n = 0; n < 6; n++, k++)
      pts.push([+(100 + k * 0.7).toFixed(2), +(200 + Math.sin(k / 9) * 60).toFixed(2), 0.5]);
    send({ t: 'live', sid, from: sentPts, pts, kind: 'pen', color: '#1A1C20', size: 3 });
    sentPts += pts.length;
  }, LIVE_MS));
  timers.push(setInterval(() => {
    // штрих закончился — уходит настоящий объект, как и у живого клиента
    const pts = [];
    for (let n = 0; n < 40; n++)
      pts.push([+(100 + n * 2).toFixed(2), +(200 + Math.sin(n / 5) * 60).toFixed(2), 0.5]);
    send({ t: 'add', item: { id: sid, type: 'pen', color: '#1A1C20', size: 3, pts } });
    sid = 'b' + i + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    sentPts = 0; k = 0;
  }, STROKE_MS));
}

const fetchMetrics = async () => {
  try { return await (await fetch('http://' + HOST + ':' + PORT + '/metrics')).text(); }
  catch { return ''; }
};
// разбор без регулярок: в имени метрики бывают и кавычки, и фигурные скобки
const pick = (text, name) => {
  for (const line of text.split('\n'))
    if (line.startsWith(name + ' ')) return +line.slice(name.length + 1);
  return null;
};

(async () => {
  fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
  session.init(path.join(DATA_DIR, 'sessions'));
  if (!process.env.SESSION_SECRET)
    console.warn('! SESSION_SECRET не задан — сервер не расшифрует эти сессии, входы не пройдут');

  console.log('участников ' + CLIENTS + ', из них рисуют ' + DRAWING + ', длительность ' + SECONDS + ' с');
  console.log('доска ' + BOARD + ' на ' + HOST + ':' + PORT);

  const before = await fetchMetrics();
  if (!before) { console.error('сервер не отвечает на /metrics — он точно поднят?'); process.exit(1); }

  console.log('вход…');
  const tJoin = nowMs();
  const conns = await Promise.all(Array.from({ length: CLIENTS }, async (_, i) => {
    const s = await makeSession(i);
    return connect(i, s.sid, i < DRAWING);
  }));
  const joinTotal = nowMs() - tJoin;
  console.log('вошли ' + stat.joined + ' из ' + CLIENTS +
              (stat.joinFailed ? ' (не смогли ' + stat.joinFailed + ')' : '') +
              ', всего ' + joinTotal + ' мс');
  if (!stat.joined) { console.error('никто не вошёл — проверьте SESSION_SECRET и DATA_DIR'); process.exit(1); }

  // считаем только установившийся режим, без всплеска на входе
  stat.sent = 0; stat.recv = 0; stat.recvBytes = 0;
  const mid = await fetchMetrics();
  const t0 = nowMs();
  conns.forEach(startLoad);
  console.log('нагрузка ' + SECONDS + ' с…');
  await new Promise(r => setTimeout(r, SECONDS * 1000));
  const dt = (nowMs() - t0) / 1000;

  const after = await fetchMetrics();
  for (const c of conns) if (c) { for (const t of c.timers) clearInterval(t); c.ws.close(); }

  const mb = n => (typeof n === 'number' ? (n / 1048576).toFixed(1) : '—');
  const per = n => Math.round(n / dt);
  const q = (t, n) => { const v = pick(t, n); return v === null ? '—' : v; };
  const ms = v => (typeof v === 'number' ? (v * 1000).toFixed(1) + ' мс' : v);
  const joins = stat.joinMs.sort((a, b) => a - b);

  console.log('');
  console.log('──────── итог ────────');
  console.log('вошли:               ' + stat.joined + ' из ' + CLIENTS +
              ', медиана ' + (joins[joins.length >> 1] || 0) + ' мс, худший ' + (joins[joins.length - 1] || 0) + ' мс');
  console.log('боты отправили:      ' + stat.sent + ' (' + per(stat.sent) + '/с)');
  console.log('боты получили:       ' + stat.recv + ' (' + per(stat.recv) + '/с), ' +
              mb(stat.recvBytes) + ' МБ (' + mb(stat.recvBytes / dt) + ' МБ/с)');
  console.log('размножение:         x' + (stat.sent ? (stat.recv / stat.sent).toFixed(1) : 0));
  console.log('');
  console.log('задержка цикла p50:  ' + ms(q(after, 'doska_loop_delay_seconds{q="0.5"}')));
  console.log('задержка цикла p99:  ' + ms(q(after, 'doska_loop_delay_seconds{q="0.99"}')));
  console.log('задержка цикла max:  ' + ms(q(after, 'doska_loop_delay_seconds{q="max"}')));
  console.log('память RSS:          ' + mb(q(after, 'doska_memory_bytes{part="rss"}')) + ' МБ' +
              ' (до нагрузки ' + mb(q(mid, 'doska_memory_bytes{part="rss"}')) + ')');
  console.log('комнат загружено:    ' + q(after, 'doska_room_loads_total'));
  console.log('отброшено лимитом:   ' + q(after, 'doska_relay_dropped_total'));
  console.log('объектов на доске:   ' + q(after, 'doska_items_total'));
  process.exit(0);
})();
