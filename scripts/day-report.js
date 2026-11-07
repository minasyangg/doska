/* ============================================================
   Отчёт о занятиях за день — текст для Telegram.

   Источник — лог pm2 (/var/log/doska/out.log, в ecosystem.config.js стоит
   time: true): сервер пишет туда каждый вход и выход строками
     2026-10-07T18:00:31: [bGR_U93Ihyl] + Иванова Мария Петровна (owner) → 2
     2026-10-07T18:53:09: [bGR_U93Ihyl] − Иванова Мария Петровна → 1
   а раз в минуту — кто что делал на доске (см. noteActivity в server.js):
     2026-11-07T18:05:00: [bGR_U93Ihyl] действия {"Иванова Мария Петровна":[12,40],"Пётр":[0,3]}
   Названия досок — из их снимков.

   Занятие — отрезок, когда на доске одновременно были владелец и хотя бы
   один ученик и кто-то из них что-то делал. Одной открытой вкладки мало: её
   забывают закрыть, и занятие тянулось бы до ночи. Поэтому занятие кончается
   на последнем действии, а всё, что короче MIN_LESSON, занятием не считается.

   Переподключения занятие не дробят и времени у него не отнимают: разрыв до
   LESSON_GAP остаётся внутри занятия, оно считается от начала до конца. Вычитать
   разрывы нельзя: 29.10.2026 у ученика пропадала связь, он заходил на минуту с
   разрывами по 5-7 минут, а урок шёл. Минутные заходы (MIN_VISIT) в конце
   занятие только не продлевают: после урока люди заглядывают на доску. По логу
   на ноябрь 2026 разрывы внутри уроков доходили до 16 минут, а отдельные занятия
   на одной доске отстояли минимум на 36.

   Дольше LESSON_MAX занятие не идёт, настоящий его конец по логу уже не виден.
   Если на доске действовали двое, занятие подтверждено, и ему засчитывается
   обычная длина урока LESSON_USUAL. Если действовал один, это не урок, а
   подготовка при чужой забытой вкладке: такое занятие не засчитывается.

   Занятие считается от своего настоящего начала, даже если оно было вчера:
   иначе за полночь время отсчитывалось бы заново, и хвост от забытых вкладок
   снова становился занятием.

   Строки о действиях появились 7 ноября 2026. Дни раньше считаются только по
   присутствию: восстановить действия за них не из чего, и занятие длиннее
   предела получает LESSON_USUAL без проверки.

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
// Такой перерыв занятие не делит: связь пропала, телефон уснул, ученик решает
// на бумаге, учитель объясняет голосом. Забытой вкладке запас не поможет:
// конец всё равно на последнем действии, а не на закрытии вкладки.
const LESSON_GAP = 30 * 60e3;
const MIN_VISIT = 2 * 60e3;          // короче — шум: заглянул, на минуту переподключился
const MIN_LESSON = 10 * 60e3;        // короче — проверили связь, открыли не ту доску
const LESSON_MAX = 2 * 3600e3;       // дольше занятие не идёт
const LESSON_USUAL = 90 * 60e3;      // столько засчитываем тому, что вышло за предел

const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const arg = [process.argv[2], (process.env.SSH_ORIGINAL_COMMAND || '').trim()]
  .find(a => a && DAY_RE.test(a));
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const day = arg || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const [Y, M, D] = day.split('-').map(Number);
const dayStart = new Date(Y, M - 1, D).getTime();
const nextDay = new Date(Y, M - 1, D + 1).getTime();
const dayEnd = Math.min(nextDay, now.getTime());
const hm = t => {
  if (t >= nextDay) return '24:00';
  const d = new Date(t);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const range = (a, b, live) => hm(a) + '–' + (live ? 'идёт' : hm(b));

/* ─── разбор лога ─── */

const LINE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d): (.*)$/;
const JOIN = /^\[([A-Za-z0-9_-]{1,40})\] \+ (.*) \((owner|edit|view)\) → \d+$/;
const LEAVE = /^\[([A-Za-z0-9_-]{1,40})\] − (.*) → \d+$/;
const ACTS = /^\[([A-Za-z0-9_-]{1,40})\] действия (\{.*\})$/;
const BOOT = /^Доска: http/;          // сервер поднялся заново — прежние соединения оборваны

const open = new Map();               // доска|имя → {n, from, cap}
const spans = [];                     // {board, name, cap, from, to}
const acts = new Map();               // доска → [{at, by: {имя: [правки, движения]}}]
let trackedFrom = Infinity;           // с этого момента лог знает о действиях

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
  } else if ((j = ACTS.exec(text))) {
    let by;
    try { by = JSON.parse(j[2]); } catch { continue; }
    trackedFrom = Math.min(trackedFrom, at);
    if (!acts.has(j[1])) acts.set(j[1], []);
    acts.get(j[1]).push({ at, by });
  } else if (BOOT.test(text)) {
    for (const key of [...open.keys()]) close(key, at);
  }
}
// «идёт сейчас» имеет смысл только для сегодняшнего отчёта: в прошлом дне
// незакрытый отрезок просто перешёл за полночь
const stillHere = new Set(dayEnd === now.getTime() ? open.keys() : []);
for (const key of [...open.keys()]) close(key, dayEnd);

/* ─── отрезки ─── */

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

/** Когда на доске что-то делали (who — только этот человек). Время, о котором
    лог ещё не знал, считается занятым: иначе старые дни опустели бы целиком. */
function busyTime(board, who) {
  const list = (acts.get(board) || [])
    .filter(a => !who || Object.hasOwn(a.by, who))
    .map(a => ({ from: a.at - 60e3, to: a.at }));
  list.push({ from: 0, to: Math.min(trackedFrom, dayEnd) });
  return merge(list, LESSON_GAP);
}
/** Куски присутствия → занятия: разрыв до LESSON_GAP занятие не делит, минутные
    заходы по краям границ не двигают. */
function toLessons(pieces) {
  const out = [];
  let group = [];
  const flush = () => {
    const solid = group.filter(s => s.to - s.from >= MIN_VISIT);
    group = [];
    if (solid.length) out.push({ from: solid[0].from, to: solid[solid.length - 1].to });
  };
  for (const s of [...pieces].sort((a, b) => a.from - b.from)) {
    if (group.length && s.from - group[group.length - 1].to > LESSON_GAP) flush();
    group.push(s);
  }
  flush();
  return out;
}
/** Сколько правок и движений сделали эти люди за отрезок. Строка лога
    подводит итог минуты, поэтому последнюю, начатую до конца, тоже берём. */
function tally(board, names, span) {
  const sum = [0, 0];
  for (const a of acts.get(board) || []) {
    if (a.at <= span.from || a.at >= span.to + 60e3) continue;
    for (const n of names) {
      if (!Object.hasOwn(a.by, n)) continue;
      sum[0] += a.by[n][0] || 0;
      sum[1] += a.by[n][1] || 0;
    }
  }
  return sum;
}

const byBoard = new Map();
for (const s of spans.filter(s => s.to > dayStart && s.to > s.from)) {
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
  const pieces = intersect(together, busyTime(board));
  const everyone = [...people.keys()];
  const found = toLessons(pieces).filter(l => {
    if (l.to - l.from < MIN_LESSON) return false;
    if (l.to - l.from <= LESSON_MAX || l.from < trackedFrom) return true;
    return everyone.filter(n => tally(board, [n], l).some(Boolean)).length >= 2;
  }).map(l => l.to - l.from > LESSON_MAX ? { from: l.from, to: l.from + LESSON_USUAL } : l)
    .map(clip).filter(l => l.to > l.from);
  for (const l of found) {
    const who = students.filter(([, p]) => intersect(merge(p.spans, RECONNECT), [l]).length).map(([n]) => n);
    const live = [...stillHere].some(k => k.startsWith(board + '|')) && l.to >= dayEnd - LESSON_GAP;
    lessons.push({ board, title: boardTitle(board), teacher: owners.map(([n]) => n).join(', '),
                   from: l.from, to: l.to, live, students: who,
                   tracked: l.from >= trackedFrom,
                   byTeacher: tally(board, owners.map(([n]) => n), l), byStudents: tally(board, who, l) });
  }
  if (!found.length) {
    for (const [name, p] of people) {
      // заглянул на пару секунд — не заход, а шум: открыл не ту доску и ушёл
      const here = merge(p.spans.map(clip).filter(s => s.to > s.from), RECONNECT);
      const ss = merge(intersect(here, busyTime(board, name)), LESSON_GAP)
        .filter(s => s.to - s.from >= MIN_VISIT);
      if (!ss.length) continue;
      const live = stillHere.has(board + '|' + name);
      visits.push({ board, title: boardTitle(board), name, owner: p.cap === 'owner', from: ss[0].from,
                    ranges: ss.map((s, k) => range(s.from, s.to, live && k === ss.length - 1 && s.to >= dayEnd - LESSON_GAP)) });
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
    if (!l.tracked) return;
    // ученик мог просто смотреть с планшета, поэтому занятие остаётся, но с пометкой
    const quiet = !l.byStudents[0] && !l.byStudents[1];
    out.push(`   правок на доске: преподаватель ${l.byTeacher[0]}, ${l.students.length > 1 ? 'ученики' : 'ученик'} ${l.byStudents[0]}` +
             (quiet ? ' · ⚠️ ученик ничего не делал на доске' : ''));
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
