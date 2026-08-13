/* ============================================================
   Метрики доски в формате Prometheus.

   Всё считается на месте, обычными числами: счётчик — это сложение, отметка
   времени — одно вычитание. Ничего не копится, ничего не пишется на диск, и на
   рисование это не влияет никак.

   Дорогое — пересчёт того, что приходится обходить (объекты и точки во всех
   комнатах). Такое считается не на каждом запросе, а раз в минуту и кладётся в
   кэш: сборщик ходит раз в тридцать секунд, и обходить ради него полсотни
   тысяч объектов дважды в минуту незачем.
   ============================================================ */
'use strict';

const counters = new Map();      // имя|метки → число
const gauges = new Map();
/* Гистограмма задержек: границы в секундах. Верхняя нарочно мелкая — нас
   интересует «уложились ли в человеческое время», а не хвосты в минуты. */
const BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
const hists = new Map();

const key = (name, labels) => labels
  ? name + '|' + Object.entries(labels).map(([k, v]) => k + '=' + v).sort().join(',')
  : name;

function inc(name, by = 1, labels) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) || 0) + by);
}
function set(name, value, labels) { gauges.set(key(name, labels), value); }

function observe(name, seconds, labels) {
  const k = key(name, labels);
  let h = hists.get(k);
  if (!h) { h = { counts: new Array(BUCKETS.length + 1).fill(0), sum: 0, n: 0 }; hists.set(k, h); }
  h.sum += seconds; h.n++;
  let i = 0;
  while (i < BUCKETS.length && seconds > BUCKETS[i]) i++;
  h.counts[i]++;
}
/** Замер: вернёт функцию, которую надо позвать по завершении. */
const timer = (name, labels) => {
  const t = process.hrtime.bigint();
  return () => observe(name, Number(process.hrtime.bigint() - t) / 1e9, labels);
};

/* ── то, что надо обходить: считаем редко и держим в кэше ── */
let heavy = { at: 0, items: 0, points: 0, images: 0 };
const HEAVY_EVERY = 60000;

function heavyStats(rooms) {
  const now = Date.now();
  if (now - heavy.at < HEAVY_EVERY) return heavy;
  let items = 0, points = 0, images = 0;
  for (const r of rooms.values()) {
    items += r.items.length;
    for (const it of r.items) {
      if (it.pts && it.pts.length) points += it.pts.length / (it.type === 'path' ? 2 : 3);
      else if (it.type === 'image') images++;
    }
  }
  heavy = { at: now, items, points: Math.round(points), images };
  return heavy;
}

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
function line(name, labels, value) {
  if (!labels) return name + ' ' + value + '\n';
  const l = Object.entries(labels).map(([k, v]) => k + '="' + esc(v) + '"').join(',');
  return name + '{' + l + '} ' + value + '\n';
}
const parse = k => {
  const [name, rest] = k.split('|');
  if (!rest) return [name, null];
  const labels = {};
  for (const pair of rest.split(',')) { const [a, b] = pair.split('='); labels[a] = b; }
  return [name, labels];
};

/** Весь ответ /metrics. rooms и wss нужны для мгновенных значений. */
function render({ rooms, clients }) {
  const m = process.memoryUsage();
  const h = heavyStats(rooms);
  let out = '';

  const g = (name, help, value, labels) => {
    out += '# HELP ' + name + ' ' + help + '\n# TYPE ' + name + ' gauge\n';
    out += line(name, labels, value);
  };

  g('doska_rooms_open', 'Досок держится в памяти', rooms.size);
  g('doska_ws_clients', 'Живых соединений', clients);
  g('doska_items_total', 'Объектов во всех комнатах (обновляется раз в минуту)', h.items);
  g('doska_points_total', 'Точек во всех комнатах (обновляется раз в минуту)', h.points);
  g('doska_images_total', 'Картинок во всех комнатах', h.images);
  g('doska_memory_bytes', 'Память процесса: куча и буферы', m.heapUsed + m.arrayBuffers, { part: 'heap' });
  out += line('doska_memory_bytes', { part: 'rss' }, m.rss);
  out += line('doska_memory_bytes', { part: 'external' }, m.external);
  g('doska_uptime_seconds', 'Сколько сервер живёт', Math.round(process.uptime()));

  for (const [k, v] of gauges) {
    const [name, labels] = parse(k);
    out += '# TYPE ' + name + ' gauge\n' + line(name, labels, v);
  }
  for (const [k, v] of counters) {
    const [name, labels] = parse(k);
    out += '# TYPE ' + name + ' counter\n' + line(name, labels, v);
  }
  for (const [k, hh] of hists) {
    const [name, labels] = parse(k);
    out += '# TYPE ' + name + ' histogram\n';
    let acc = 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      acc += hh.counts[i];
      out += line(name + '_bucket', { ...(labels || {}), le: String(BUCKETS[i]) }, acc);
    }
    acc += hh.counts[BUCKETS.length];
    out += line(name + '_bucket', { ...(labels || {}), le: '+Inf' }, acc);
    out += line(name + '_sum', labels, hh.sum.toFixed(6));
    out += line(name + '_count', labels, hh.n);
  }
  return out;
}

module.exports = { inc, set, observe, timer, render };
