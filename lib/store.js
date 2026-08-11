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
const snapFile = id => path.join(boardDir(id), 'snap.json');
const logFile  = id => path.join(boardDir(id), 'log.ndjson');
/** Старый формат: вся доска одним файлом рядом с каталогами. */
const legacyFile = id => path.join(DIR.boards, id + '.json');

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

/* ═══════════════ чтение ═══════════════ */

function emptyState() {
  return { v: SNAP_V, seq: 0, title: null, ownerId: null, locked: false, anyEdit: false, items: [] };
}

/** Применение операции к состоянию. Здесь нет ни одной проверки прав: они уже
    сделаны в момент, когда операция попала в журнал. */
function applyOp(state, op) {
  switch (op.t) {
    case 'add':
      if (op.item && !state.items.some(x => x.id === op.item.id)) state.items.push(op.item);
      return;
    case 'bulk':
      for (const it of op.items || []) if (!state.items.some(x => x.id === it.id)) state.items.push(it);
      return;
    case 'move': {
      const it = state.items.find(x => x.id === op.id);
      if (!it) return;
      for (const k in op) if (k !== 't' && k !== 'q' && k !== 'id') it[k] = op[k];
      return;
    }
    case 'erase': {
      const gone = new Set(op.ids || []);
      state.items = state.items.filter(it => !gone.has(it.id));
      return;
    }
    case 'clear':
      state.items = [];
      return;
    case 'lock':
      state.locked = !!op.on;
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
  const s = stateOf(id);

  let snap = null;
  try { snap = JSON.parse(await fsp.readFile(snapFile(id), 'utf8')); } catch {}

  // Старый формат — одиночный файл. Читаем как снимок; каталог и новый снимок
  // появятся при первом же сохранении.
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
  for (const op of ops) { applyOp(state, op); state.seq = Math.max(state.seq, op.q | 0); }

  s.seq = state.seq;
  s.bytes = Buffer.byteLength(logText);
  s.ops = ops.length;
  s.legacy = fromLegacy;
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
  await flush(id);
  const body = JSON.stringify({
    v: SNAP_V, seq: s.seq,
    title: state.title, ownerId: state.ownerId,
    locked: !!state.locked, anyEdit: !!state.anyEdit,
    items: state.items,
  });

  s.chain = s.chain.catch(() => {}).then(async () => {
    await fsp.mkdir(boardDir(id), { recursive: true });
    const tmp = snapFile(id) + '.' + rnd(6) + '.tmp';
    try {
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, snapFile(id));
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    // Снимок на диске — журнал больше не нужен.
    await fsp.writeFile(logFile(id), '');
    s.bytes = 0; s.ops = 0;
    // Старый одиночный файл теперь только мешает: при следующей загрузке его
    // прочитали бы как снимок, если каталог вдруг окажется пустым.
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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(DIR.trash, id + '_' + stamp);
  await fsp.mkdir(dest, { recursive: true });
  const moves = [
    [boardDir(id), path.join(dest, 'board')],
    [legacyFile(id), path.join(dest, 'board.json')],
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
    [snapFile(id), logFile(id), legacyFile(id)].map(p => fsp.stat(p).then(s => s.mtimeMs).catch(() => 0))
  );
  return Math.max(...times);
}

module.exports = {
  init, load, append, flush, snapshot, maybeSnapshot, closeRoom,
  trash, sweepTrash, mtime, needSnapshot,
  SNAP_V, _applyOp: applyOp, _parseLog: parseLog,
};
