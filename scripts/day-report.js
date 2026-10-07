/* ============================================================
   Отчёт о занятиях за день — текст для Telegram.

   Источник — лог pm2 (/var/log/doska/out.log, в ecosystem.config.js стоит
   time: true): сервер и так пишет туда каждый вход и выход строками
     2026-10-07T18:00:31: [bGR_U93Ihyl] + Иванова Мария Петровна (owner) → 2
     2026-10-07T18:53:09: [bGR_U93Ihyl] − Иванова Мария Петровна → 1
   Названия досок — из их снимков. Сама доска ничего не пишет специально
   для отчёта и ни о нём не знает.

   Занятие — отрезок, когда на доске одновременно были владелец и хотя бы
   один ученик. Переподключения (обрыв связи, перезагрузка вкладки) короче
   нескольких минут занятие не рвут.

   Запуск: node scripts/day-report.js [ГГГГ-ММ-ДД]   — без даты за сегодня.
   GitHub Actions заходит сюда по ssh ключом, которому разрешена только эта
   команда; дату тогда можно передать как саму ssh-команду.
   Время — местное время сервера (Москва).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOG = process.env.REPORT_LOG || '/var/log/doska/out.log';
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RECONNECT = 5 * 60e3;          // такой разрыв одного человека — переподключение
const LESSON_GAP = 10 * 60e3;        // такой перерыв внутри занятия его не делит
const MIN_VISIT = 2 * 60e3;          // короче — в отчёт не попадает

const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const arg = [process.argv[2], (process.env.SSH_ORIGINAL_COMMAND || '').trim()]
  .find(a => a && DAY_RE.test(a));
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const day = arg || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const [Y, M, D] = day.split('-').map(Number);
const dayStart = new Date(Y, M - 1, D).getTime();
const dayEnd = Math.min(new Date(Y, M - 1, D + 1).getTime(), now.getTime());
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const range = (a, b, live) => hm(a) + '–' + (live ? 'идёт' : hm(b));

/* ─── разбор лога ─── */

const LINE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d): (.*)$/;
const JOIN = /^\[([A-Za-z0-9_-]{1,40})\] \+ (.*) \((owner|edit|view)\) → \d+$/;
const LEAVE = /^\[([A-Za-z0-9_-]{1,40})\] − (.*) → \d+$/;
const BOOT = /^Доска: http/;          // сервер поднялся заново — прежние соединения оборваны

const open = new Map();               // доска|имя → {n, from, cap}
const spans = [];                     // {board, name, cap, from, to}

function close(key, at) {
  const o = open.get(key);
  open.delete(key);
  // в id доски черты нет, а в имени гостя может быть что угодно
  const i = key.indexOf('|');
  spans.push({ board: key.slice(0, i), name: key.slice(i + 1), cap: o.cap, from: o.from, to: at });
}

for (const raw of fs.readFileSync(LOG, 'utf8').split('\n')) {
  const m = LINE.exec(raw);
  if (!m) continue;
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  if (at >= dayEnd) break;
  const text = m[7];
  let j;
  if ((j = JOIN.exec(text))) {
    const key = j[1] + '|' + j[2];
    const o = open.get(key);
    if (o) { o.n++; if (j[3] === 'owner') o.cap = 'owner'; }
    else open.set(key, { n: 1, from: at, cap: j[3] });
  } else if ((j = LEAVE.exec(text))) {
    const key = j[1] + '|' + j[2];
    const o = open.get(key);
    // две вкладки одного человека — уходит, когда закрыта последняя
    if (o && --o.n <= 0) close(key, at);
  } else if (BOOT.test(text)) {
    for (const key of [...open.keys()]) close(key, at);
  }
}
// «идёт сейчас» имеет смысл только для сегодняшнего отчёта: в прошлом дне
// незакрытый отрезок просто перешёл за полночь
const stillHere = new Set(dayEnd === now.getTime() ? open.keys() : []);
for (const key of [...open.keys()]) close(key, dayEnd);

/* ─── отрезки за выбранный день ─── */

const clip = s => ({ ...s, from: Math.max(s.from, dayStart), to: Math.min(s.to, dayEnd) });
function merge(list, gap) {
  const out = [];
  for (const s of [...list].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && s.from - last.to <= gap) last.to = Math.max(last.to, s.to);
    else out.push({ from: s.from, to: s.to });
  }
  return out;
}
function intersect(a, b) {
  const out = [];
  for (const x of a) for (const y of b) {
    const from = Math.max(x.from, y.from), to = Math.min(x.to, y.to);
    if (to > from) out.push({ from, to });
  }
  return out;
}

const byBoard = new Map();
for (const s of spans.map(clip).filter(s => s.to > s.from)) {
  if (!byBoard.has(s.board)) byBoard.set(s.board, []);
  byBoard.get(s.board).push(s);
}

function boardTitle(id) {
  const dir = path.join(DATA, 'boards', id);
  try { return JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'snap.json.br')))).title || id; } catch {}
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'snap.json'), 'utf8')).title || id; } catch {}
  return id;
}

const lessons = [];
const visits = [];
for (const [board, list] of byBoard) {
  const people = new Map();                       // имя → {cap, spans}
  for (const s of list) {
    const p = people.get(s.name) || { cap: s.cap, spans: [] };
    if (s.cap === 'owner') p.cap = 'owner';
    p.spans.push(s);
    people.set(s.name, p);
  }
  const owners = [...people].filter(([, p]) => p.cap === 'owner');
  const students = [...people].filter(([, p]) => p.cap !== 'owner');
  const teacherTime = merge(owners.flatMap(([, p]) => p.spans), RECONNECT);

  const together = intersect(teacherTime, merge(students.flatMap(([, p]) => p.spans), RECONNECT));
  const found = merge(together, LESSON_GAP);
  for (const l of found) {
    const who = students.filter(([, p]) => intersect(merge(p.spans, RECONNECT), [l]).length).map(([n]) => n);
    const live = [...stillHere].some(k => k.startsWith(board + '|')) && l.to >= dayEnd - 1000;
    lessons.push({ board, title: boardTitle(board), teacher: owners.map(([n]) => n).join(', '),
                   from: l.from, to: l.to, live, students: who });
  }
  if (!found.length) {
    for (const [name, p] of people) {
      // заглянул на пару секунд — не заход, а шум: открыл не ту доску и ушёл
      const ss = merge(p.spans, RECONNECT).filter(s => s.to - s.from >= MIN_VISIT);
      if (!ss.length) continue;
      const live = stillHere.has(board + '|' + name);
      visits.push({ board, title: boardTitle(board), name, owner: p.cap === 'owner', from: ss[0].from,
                    ranges: ss.map((s, k) => range(s.from, s.to, live && k === ss.length - 1 && s.to >= dayEnd - 1000)) });
    }
  }
}

/* ─── текст ─── */

const dur = ms => {
  const m = Math.round(ms / 60e3), h = Math.floor(m / 60);
  return h ? `${h} ч ${pad(m % 60)} мин` : `${m} мин`;
};
const plural = (n, one, few, many) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
                'сентября', 'октября', 'ноября', 'декабря'];
const WEEK = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const date = `${D} ${MONTHS[M - 1]} (${WEEK[new Date(Y, M - 1, D).getDay()]})`;

const out = [];
if (!lessons.length) {
  out.push(`📋 ${date}: занятий не было.`);
} else {
  out.push(`📋 Занятия за ${date}`, '');
  lessons.sort((a, b) => a.from - b.from);
  lessons.forEach((l, i) => {
    out.push(`${i + 1}. ${l.teacher} — «${l.title}»`);
    out.push(`   ${range(l.from, l.to, l.live)} · ${dur(l.to - l.from)} · ${l.students.join(', ')}`);
  });
  const total = lessons.reduce((s, l) => s + (l.to - l.from), 0);
  out.push('', `Итого: ${lessons.length} ${plural(lessons.length, 'занятие', 'занятия', 'занятий')}, ${dur(total)}`);
}
if (visits.length) {
  out.push('', 'Заходили без занятия:');
  visits.sort((a, b) => a.from - b.from);
  for (const v of visits)
    out.push(`• «${v.title}» — ${v.name}${v.owner ? ' (преподаватель)' : ''}: ${v.ranges.join(', ')}`);
}
process.stdout.write(out.join('\n') + '\n');
