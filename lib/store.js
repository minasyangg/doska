/* ============================================================
   Хранилище содержимого досок: журнал операций + снимки.

   Как было. Доска целиком лежала в одном файле <id>.json, и раз в четыре
   секунды он переписывался целиком, если что-то менялось. Два следствия, оба
   плохие:
     · стоимость сохранения — O(размера доски). Урок на двадцать тысяч
       объектов — это мегабайты JSON.stringify и мегабайты записи каждые
       четыре секунды, пока кто-то пишет. Чем дольше занятие, тем дороже
       каждый штрих;
     · окно потери — те же четыре секунды. Падение процесса, OOM, перезапуск
       сервера посреди объяснения — и последние секунды урока исчезли.

   Как стало. У каждой доски свой каталог:

       data/boards/<id>/snap.json    снимок состояния целиком
       data/boards/<id>/log.ndjson   журнал операций после снимка, по строке

   Каждая правка дописывается в конец журнала — это O(размера правки), а не
   доски. Снимок пересобирается редко: когда журнал перерос порог или комната
   выгружается. Загрузка — снимок плюс проигрывание журнала.

   Порядок записи выбран так, чтобы падение в любой момент не теряло данных:
   снимок пишется во временный файл и переименовывается (атомарно), и только
   после успеха журнал усекается. Если процесс умрёт между этими шагами,
   останется свежий снимок и уже ненужный журнал — проигрывание отбросит
   операции, чей номер не больше номера снимка, и состояние совпадёт.

   Оборванная последняя строка журнала (запись не долетела при падении)
   отбрасывается при чтении: строки самодостаточны, и потеря хвоста стоит
   последней операции, а не всей доски.
   ============================================================ */
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const pt = require('./points');

const brotli = promisify(zlib.brotliCompress);
const unbrotli = promisify(zlib.brotliDecompress);

const SNAP_V = 5;

/* Пороги уплотнения. Смысл — держать проигрывание при загрузке коротким и не
   давать журналу расти безгранично, но при этом снимать снимок редко. */
const SNAP_BYTES = 512 * 1024;   // журнал перерос — пора снимок
const SNAP_OPS   = 2000;

/* Задержка перед сбросом буфера на диск. Ноль означал бы системный вызов на
   каждый штрих, секунда — окно потери в секунду. Сто пятьдесят миллисекунд:
   человек не успевает заметить, а записей выходит единицы в секунду. */
const FLUSH_MS = 150;
/* Но если за эти миллисекунды набралось много (вставили картинку, отменили
   большое стирание) — пишем сразу, не дожидаясь таймера. */
const FLUSH_BYTES = 64 * 1024;

let DIR = { boards: null, files: null, trash: null };

function init(dirs) {
  DIR = dirs;
  for (const d of Object.values(DIR)) if (d) fs.mkdirSync(d, { recursive: true });
}

const rnd = n => crypto.randomBytes(n * 2).toString('base64url').slice(0, n);
const boardDir = id => path.join(DIR.boards, id);
const snapFile = id => path.join(boardDir(id), 'snap.json.br');
const logFile  = id => path.join(boardDir(id), 'log.ndjson');
/** Снимок без сжатия — так писала предыдущая версия. */
const plainSnap = id => path.join(boardDir(id), 'snap.json');
/** Ещё более ранний формат: вся доска одним файлом рядом с каталогами. */
const legacyFile = id => path.join(DIR.boards, id + '.json');

/* ═══════════════ уплотнение штрихов ═══════════════
   Перо шлёт точки густо: клиент отбрасывает те, что ближе 0.35 px к
   предыдущей, и всё равно на букву высотой 20 px приходится больше сотни
   точек. В памяти это нормально, а на диске каждая точка стоит около 26 байт,
   и плотно исписанный экран весит полтора мегабайта.

   Перед снимком линии прореживаются по Рамеру — Дугласу — Пекеру: выбрасываются
   точки, лежащие на прямой между соседями. На настоящих штрихах остаётся около
   пятой части точек при расхождении линии меньше 0.7 px — этого не видно даже
   вплотную.

   Отдельная забота — нажим: он задаёт толщину, и если выбросить точку, где
   перо надавили, линия потеряет утолщение. Поэтому вторым проходом
   возвращаются точки, чей нажим заметно отличается от того, что получился бы
   линейной прикидкой между оставленными соседями.

   Прореживается только то, что уходит на диск. Живая доска в памяти остаётся
   как есть, поэтому на сеанс это никак не влияет. */
const RDP_EPS  = 0.35;   // px, допустимое расхождение линии
const PRESS_EPS = 0.06;  // доля нажима, при которой точку стоит сохранить

function simplify(buf, stride) {
  const n = pt.count(buf, stride);
  if (n < 3) return buf;
  const X = i => buf[i * stride], Y = i => buf[i * stride + 1];
  const P = i => (stride > 2 ? buf[i * stride + 2] : 0.5);

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;

  // геометрия
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = X(a), ay = Y(a);
    const dx = X(b) - ax, dy = Y(b) - ay;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1, best = RDP_EPS;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((X(i) - ax) * dy - (Y(i) - ay) * dx) / len;
      if (d > best) { best = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }

  // Нажим: возвращаем точки, где толщина иначе поедет. Проход рекурсивный, как
  // и геометрический: вернуть одну точку на промежуток мало — если нажим гулял,
  // после вставки обе половины надо проверить заново, иначе обещанный допуск
  // не выдерживается.
  if (stride > 2) {
    const gaps = [];
    for (let i = 1, prev = 0; i < n; i++) {
      if (!keep[i]) continue;
      if (i - prev > 1) gaps.push([prev, i]);
      prev = i;
    }
    while (gaps.length) {
      const [a, b] = gaps.pop();
      const p0 = P(a), p1 = P(b);
      let far = -1, best = PRESS_EPS;
      for (let j = a + 1; j < b; j++) {
        const d = Math.abs(P(j) - (p0 + (p1 - p0) * ((j - a) / (b - a))));
        if (d > best) { best = d; far = j; }
      }
      if (far > 0) {
        keep[far] = 1;
        if (far - a > 1) gaps.push([a, far]);
        if (b - far > 1) gaps.push([far, b]);
      }
    }
  }

  let left = 0;
  for (let i = 0; i < n; i++) left += keep[i];
  const out = new Float32Array(left * stride);
  for (let i = 0, k = 0; i < n; i++) {
    if (!keep[i]) continue;
    for (let s = 0; s < stride; s++) out[k * stride + s] = buf[i * stride + s];
    k++;
  }
  return out;
}

/** Прореживание прямо в памяти комнаты.

    Раньше оно применялось только к копии, уходящей в снимок, и живая доска
    продолжала держать все точки, как их прислало перо. Замер показал, во что
    это обходится: занятие на 1.5 млн точек весит 22 МБ в памяти против 0.8 МБ
    на диске — разница вся в точках, которые всё равно не видны.

    Прореживаем и в памяти тоже. Расхождение то же самое, меньше 0.7 px, а
    после перезагрузки доска и так приходила уже прорежённой — меняется лишь
    момент, когда это происходит. */
function thinInPlace(items) {
  let before = 0, after = 0;
  for (const it of items) {
    if (!pt.isPacked(it.pts)) continue;
    const stride = pt.strideOf(it);
    const n = pt.count(it.pts, stride);
    if (n < 3) continue;
    const cut = simplify(it.pts, stride);
    before += n; after += pt.count(cut, stride);
    it.pts = cut;
  }
  return { before, after };
}

/** Копия объектов, пригодная для записи: координаты до десятых, нажим до
    сотых. Десятая доля пикселя не видна на любом увеличении, а в JSON это
    три-четыре знака экономии на числе. Прореживание к этому моменту уже
    сделано в памяти. */
function compact(items) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    out[i] = pt.isPacked(it.pts) ? pt.wire(it, pt.strideOf(it), 1, 2) : pt.wire(it);
  }
  return out;
}

/* ── состояние на комнату ───────────────────────────────────
   seq   — номер последней записанной операции
   buf   — строки, ещё не долетевшие до диска
   bytes — размер журнала на диске, чтобы знать, когда уплотнять
   ops   — операций с последнего снимка
   chain — последовательность записей: два appendFile подряд не должны
           перемешаться, иначе строки перепутаются местами            */
const st = new Map();
const stateOf = id => {
  let s = st.get(id);
  if (!s) { s = { seq: 0, buf: [], bufBytes: 0, bytes: 0, ops: 0, timer: null, chain: Promise.resolve() }; st.set(id, s); }
  return s;
};

/* Доски, уехавшие в корзину. Между решением сохранить и самой записью успевает
   пройти удаление: снимок тогда воссоздавал каталог уже удалённой доски и падал
   с ENOENT на полпути. Здесь нужен именно список, а не забывание состояния, —
   запись уже могла быть поставлена в очередь. */
const gone = new Set();

/* ═══════════════ чтение ═══════════════ */

function emptyState() {
  return { v: SNAP_V, seq: 0, title: null, ownerId: null, locked: false, anyEdit: false, items: [] };
}

/** Применение операции к состоянию. Здесь нет ни одной проверки прав: они уже
    сделаны в момент, когда операция попала в журнал.

    byId — необязательный указатель «идентификатор → объект». Без него каждая
    операция журнала искала объект перебором всего содержимого: до двух тысяч
    операций (SNAP_OPS) на доску в двадцать тысяч объектов — это десятки
    миллионов сравнений строк на одной загрузке, и всё это до того, как первый
    участник увидит доску. Та же болезнь и то же лекарство, что у byId в
    комнате (см. loadRoomNow в server.js). Без указателя работает как прежде —
    он нужен только тому, кто проигрывает журнал целиком. */
function applyOp(state, op, byId) {
  const has = id => byId ? byId.has(id) : state.items.some(x => x.id === id);
  const put = it => { state.items.push(it); if (byId) byId.set(it.id, it); };
  switch (op.t) {
    case 'add':
      if (op.item && !has(op.item.id)) put(op.item);
      return;
    case 'bulk':
      for (const it of op.items || []) if (!has(it.id)) put(it);
      return;
    case 'move': {
      const it = byId ? byId.get(op.id) : state.items.find(x => x.id === op.id);
      if (!it) return;
      for (const k in op) if (k !== 't' && k !== 'q' && k !== 'id') it[k] = op[k];
      return;
    }
    case 'erase': {
      const gone = new Set(op.ids || []);
      state.items = state.items.filter(it => !gone.has(it.id));
      if (byId) for (const id of gone) byId.delete(id);
      return;
    }
    case 'clear':
      state.items = [];
      if (byId) byId.clear();
      return;
    case 'z': {
      // порядок в массиве и есть порядок слоёв
      const ids = new Set(op.ids || []);
      if (!ids.size) return;
      const picked = [], rest = [];
      for (const it of state.items) (ids.has(it.id) ? picked : rest).push(it);
      state.items = op.to === 'back' ? picked.concat(rest) : rest.concat(picked);
      return;
    }
    case 'lock':
      state.locked = !!op.on;
      return;
    case 'img':
      // Запись о загруженном файле. Состояние доски не меняет — картинка
      // появляется отдельной операцией add. Нужна, чтобы по журналу было
      // видно, откуда взялся файл в data/files.
      return;
    case 'meta':
      if ('title' in op) state.title = op.title;
      if ('ownerId' in op) state.ownerId = op.ownerId;
      if ('locked' in op) state.locked = !!op.locked;
      if ('anyEdit' in op) state.anyEdit = !!op.anyEdit;
      return;
  }
}

/** Разбор журнала. Возвращает операции, годные к проигрыванию. */
function parseLog(text, afterSeq) {
  const out = [];
  if (!text) return out;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let op;
    try { op = JSON.parse(line); }
    catch {
      // Ломаться может только последняя строка — её не дописали при падении.
      // Мусор в середине означал бы порчу файла, и молча её проглатывать
      // нельзя: пусть будет видно в логах.
      if (i < lines.length - 1) console.error('журнал: битая строка', i + 1);
      continue;
    }
    if (!op || typeof op !== 'object') continue;
    if ((op.q | 0) <= afterSeq) continue;         // уже вошло в снимок
    out.push(op);
  }
  return out;
}

/** Читает доску с диска: снимок плюс журнал. */
async function load(id) {
  gone.delete(id);                        // доску открывают снова — она жива
  const s = stateOf(id);

  // Три поколения формата подряд: сжатый снимок, несжатый снимок, одиночный
  // файл. Читаем что есть — переезд происходит сам при первом сохранении.
  let snap = null, fromOld = false;
  try { snap = JSON.parse(await unbrotli(await fsp.readFile(snapFile(id)))); } catch {}
  if (!snap) {
    try { snap = JSON.parse(await fsp.readFile(plainSnap(id), 'utf8')); fromOld = !!snap; } catch {}
  }
  let fromLegacy = false;
  if (!snap) {
    try { snap = JSON.parse(await fsp.readFile(legacyFile(id), 'utf8')); fromLegacy = !!snap; } catch {}
  }

  const state = { ...emptyState(), ...(snap || {}) };
  if (!Array.isArray(state.items)) state.items = [];
  state.seq = snap && Number.isFinite(snap.seq) ? snap.seq : 0;

  let logText = '';
  try { logText = await fsp.readFile(logFile(id), 'utf8'); } catch {}
  const ops = parseLog(logText, state.seq);
  if (ops.length) {
    // указатель строим один раз на всё проигрывание, а не ищем перебором
    // на каждой операции; порядок слоёв по-прежнему держит сам массив
    const index = new Map();
    for (const it of state.items) index.set(it.id, it);
    for (const op of ops) { applyOp(state, op, index); state.seq = Math.max(state.seq, op.q | 0); }
  }

  // С диска и из журнала точки приходят массивами массивов — укладываем плотно
  // один раз здесь, чтобы дальше в памяти жила только компактная форма.
  for (const it of state.items) pt.packItem(it);

  s.seq = state.seq;
  s.bytes = Buffer.byteLength(logText);
  s.ops = ops.length;
  s.legacy = fromLegacy;
  s.plain = fromOld;
  if (ops.length) console.log('[' + id + '] журнал: доиграно операций ' + ops.length);
  return state;
}

/* ═══════════════ запись ═══════════════ */

function scheduleFlush(id) {
  const s = stateOf(id);
  if (s.timer) return;
  s.timer = setTimeout(() => { s.timer = null; flush(id).catch(() => {}); }, FLUSH_MS);
  if (s.timer.unref) s.timer.unref();
}

/** Дописать операцию. Не ждёт диска: возвращает управление сразу, чтобы
    рисование не упиралось в файловую систему. */
function append(id, op) {
  const s = stateOf(id);
  const line = JSON.stringify({ q: ++s.seq, ...op }) + '\n';
  s.buf.push(line);
  s.bufBytes += Buffer.byteLength(line);
  if (s.bufBytes >= FLUSH_BYTES) { flush(id).catch(() => {}); return; }
  scheduleFlush(id);
}

/** Сброс накопленного в журнал. Записи выстроены в цепочку, чтобы не
    перемешаться между собой. */
function flush(id) {
  const s = stateOf(id);
  if (gone.has(id)) { s.buf = []; s.bufBytes = 0; return s.chain; }
  if (!s.buf.length) return s.chain;
  const chunk = s.buf.join('');
  s.buf = []; s.bufBytes = 0;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }

  s.chain = s.chain.catch(() => {}).then(async () => {
    await fsp.mkdir(boardDir(id), { recursive: true });
    await fsp.appendFile(logFile(id), chunk);
    s.bytes += Buffer.byteLength(chunk);
    s.ops += (chunk.match(/\n/g) || []).length;
  }).catch(e => {
    // Диск отказал. Возвращаем строки в буфер: следующая попытка допишет их
    // вместе с новыми, а если и она не пройдёт — снимок всё равно сохранит
    // состояние целиком, потому что оно живёт в памяти.
    s.buf.unshift(chunk);
    s.bufBytes += Buffer.byteLength(chunk);
    console.error('журнал', id, e.message);
  });
  return s.chain;
}

const needSnapshot = id => {
  const s = stateOf(id);
  return s.bytes >= SNAP_BYTES || s.ops >= SNAP_OPS;
};

/** Снимок целиком плюс усечение журнала. Порядок обязателен: сначала снимок
    во временный файл и переименование, и только потом обнуление журнала. */
async function snapshot(id, state) {
  const s = stateOf(id);
  if (gone.has(id)) return s.chain;      // доска уже в корзине — писать некуда
  await flush(id);
  // сначала прореживаем саму комнату, потом уже пишем — на диск и в памяти
  // остаётся одно и то же
  const cut = thinInPlace(state.items);
  if (cut.before > cut.after)
    console.log('[' + id + '] прорежено: точек ' + cut.before + ' → ' + cut.after);
  const body = JSON.stringify({
    v: SNAP_V, seq: s.seq,
    title: state.title, ownerId: state.ownerId,
    locked: !!state.locked, anyEdit: !!state.anyEdit,
    items: compact(state.items),
  });

  s.chain = s.chain.catch(() => {}).then(async () => {
    await fsp.mkdir(boardDir(id), { recursive: true });
    // Сжатие асинхронное и невысокого уровня: на настоящих штрихах brotli q4
    // даёт почти то же, что q9 (втрое), но в семь раз быстрее, а главное — не
    // держит поток, пока в доске рисуют.
    const packed = await brotli(Buffer.from(body), {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
    const tmp = snapFile(id) + '.' + rnd(6) + '.tmp';
    try {
      await fsp.writeFile(tmp, packed);
      await fsp.rename(tmp, snapFile(id));
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    // Снимок на диске — журнал больше не нужен.
    await fsp.writeFile(logFile(id), '');
    s.bytes = 0; s.ops = 0;
    // Снимки прежних поколений теперь только мешают: при следующей загрузке
    // их прочитали бы вместо свежего.
    if (s.plain)  { await fsp.unlink(plainSnap(id)).catch(() => {}); s.plain = false; }
    if (s.legacy) { await fsp.unlink(legacyFile(id)).catch(() => {}); s.legacy = false; }
  }).catch(e => console.error('снимок', id, e.message));

  return s.chain;
}

/** Сохранить, если пора. Зовётся часто, снимок делает редко. */
async function maybeSnapshot(id, state) {
  if (needSnapshot(id)) return snapshot(id, state);
  return flush(id);
}

/** Комната выгружается: дописать всё и оставить один компактный снимок. */
async function closeRoom(id, state) {
  await snapshot(id, state);
  st.delete(id);
}

/* ═══════════════ удаление ═══════════════ */

/** Доску удалили. Не стираем: строка в базе помечается удалённой, а не
    исчезает, и содержимое должно вести себя так же. Всё уезжает в корзину,
    откуда его можно достать руками, пока не подберёт уборщик. */
async function trash(id) {
  gone.add(id);
  const s = st.get(id);
  if (s) { if (s.timer) clearTimeout(s.timer); s.buf = []; s.bufBytes = 0;
           await s.chain.catch(() => {}); }   // дожидаемся уже начатой записи
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(DIR.trash, id + '_' + stamp);
  await fsp.mkdir(dest, { recursive: true });
  const moves = [
    [boardDir(id), path.join(dest, 'board')],
    [legacyFile(id), path.join(dest, 'board.json')],   // доска старого поколения
    [path.join(DIR.files, id), path.join(dest, 'files')],
  ];
  for (const [from, to] of moves) {
    await fsp.rename(from, to).catch(() => {});   // нет — и не надо
  }
  st.delete(id);
  return dest;
}

/** Уборщик корзины. Держим месяц: этого хватает, чтобы заметить ошибку и
    попросить вернуть занятие. */
const TRASH_TTL = 30 * 24 * 3600 * 1000;
async function sweepTrash() {
  const now = Date.now();
  for (const name of await fsp.readdir(DIR.trash).catch(() => [])) {
    const p = path.join(DIR.trash, name);
    const s = await fsp.stat(p).catch(() => null);
    if (s && s.isDirectory() && now - s.mtimeMs > TRASH_TTL) {
      await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
      console.log('корзина: убрано ' + name);
    }
  }
}

/** «Изменена» для списка досок — по самой свежей записи на диске. */
async function mtime(id) {
  const times = await Promise.all(
    [snapFile(id), plainSnap(id), logFile(id), legacyFile(id)]
      .map(p => fsp.stat(p).then(s => s.mtimeMs).catch(() => 0))
  );
  return Math.max(...times);
}

module.exports = {
  init, load, append, flush, snapshot, maybeSnapshot, closeRoom,
  trash, sweepTrash, mtime, needSnapshot,
  SNAP_V, _applyOp: applyOp, _parseLog: parseLog, _simplify: simplify, _compact: compact,
  _thinInPlace: thinInPlace,
};
