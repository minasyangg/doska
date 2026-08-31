/* ============================================================
   Сверка кода с разметкой: ссылки на то, чего нет.

   Зачем. Прогон клиента (scripts/check-client.js) выполняет код на заглушке
   браузера, и заглушка эта нарочно всеядная: на любое обращение отдаёт объект.
   Свойство у неё, стало быть, есть всегда — а значит, обращение к элементу,
   который из разметки удалили, для неё неотличимо от обращения к живому.
   Именно так и вышло: из окна доступа убрали два поля, разметку удалили,
   а строки $('#stLock').value=… в коде остались. Браузер на них падает,
   прогон — нет.

   Что делает. Собирает всё, что разметка объявляет (идентификаторы, классы,
   data-атрибуты), и сверяет с тем, что код ищет. Ссылка, которой ничто не
   соответствует, — либо опечатка, либо остаток от удалённой разметки.

   Источников у разметки два, и оба обязательны: public/index.html и сами
   модули — половина интерфейса (окно доступа, карточки досок, строки формул)
   собирается строками прямо в коде.

   Перекос проверки нарочный. Сбор «что объявлено» намеренно широкий: читаем
   исходник целиком, вместе с комментариями, не разбирая, разметка это или
   обычная строка. Лишнее в этом наборе может только заглушить находку, но
   не выдумать новую, — а ложная тревога в проверке, которую гоняют перед
   каждой выкладкой, стоит дороже пропуска.

   По той же причине разбираются только ЦЕЛЬНЫЕ селекторы: строка,
   составленная из кусков ('#row'+i), пропускается — что там получится,
   по тексту не известно. Такие случаи достаёт вторая половина проверки, уже
   на выполнении: заглушка отдаёт null на неизвестный идентификатор.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

/* Методы, у которых первый довод — селектор. Свои сокращения (в boards.js это
   const $=s=>m.querySelector(s)) ищутся отдельно, по объявлению. */
const CORE_CALLS = ['getElementById', 'querySelectorAll', 'querySelector', 'closest', 'matches'];
const SHORTHANDS = ['\\$\\$', '\\$'];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const addAll = (set, str) => { for (const w of String(str).split(/\s+/)) if (w) set.add(w); };

/* ── что разметка объявляет ───────────────────────────────── */

function scanMarkup(known, src, isHtml) {
  let m;
  const id = /\bid\s*=\s*["'`]([A-Za-z][\w-]*)["'`]/g;
  while ((m = id.exec(src))) known.ids.add(m[1]);

  const setId = /setAttribute\s*\(\s*["'`]id["'`]\s*,\s*["'`]([A-Za-z][\w-]*)["'`]/g;
  while ((m = setId.exec(src))) known.ids.add(m[1]);

  const cls = /\b(?:className|class)\s*=\s*["'`]([^"'`]*)["'`]/g;
  while ((m = cls.exec(src))) addAll(known.classes, m[1]);

  const clsList = /classList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\(\s*["'`]([\w-]+)/g;
  while ((m = clsList.exec(src))) known.classes.add(m[1]);

  /* В разметке страницы data-атрибут — это любое его упоминание: там ничего,
     кроме разметки, нет. В коде — только настоящее объявление: если считать
     объявлением любое упоминание, то селектор [data-toolz] объявит атрибут сам
     себе и проверять станет нечего. */
  const attr = isHtml ? /\b(data-[\w-]+)/g : /\b(data-[\w-]+)\s*=/g;
  while ((m = attr.exec(src))) known.attrs.add(m[1]);

  const setAttr2 = /setAttribute\s*\(\s*["'`](data-[\w-]+)["'`]/g;
  while ((m = setAttr2.exec(src))) known.attrs.add(m[1]);

  // dataset.penKind — это тот же data-pen-kind, только с другой стороны
  const ds = /\bdataset\s*\.\s*([A-Za-z]\w*)/g;
  while ((m = ds.exec(src))) known.attrs.add('data-' + m[1].replace(/[A-Z]/g, c => '-' + c.toLowerCase()));
}

/**
 * Всё, что объявлено страницей и собираемой из кода разметкой.
 * @param {string} htmlFile путь к index.html
 * @param {string} jsDir каталог с модулями
 */
function collectKnown(htmlFile, jsDir) {
  const known = { ids: new Set(), classes: new Set(), attrs: new Set() };
  scanMarkup(known, fs.readFileSync(htmlFile, 'utf8'), true);
  for (const f of fs.readdirSync(jsDir))
    if (f.endsWith('.js')) scanMarkup(known, fs.readFileSync(path.join(jsDir, f), 'utf8'), false);
  return known;
}

/* ── что код ищет ─────────────────────────────────────────── */

/** Имена вроде $ — те, что в этом же файле объявлены обёрткой над querySelector. */
function shorthandsIn(src) {
  const out = [];
  const r = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*\bquerySelector(?:All)?\s*\(/g;
  let m;
  while ((m = r.exec(src))) out.push(esc(m[1]));
  return out;
}

/**
 * Ссылки на разметку, которой нигде нет.
 * @returns {{found:Array<{file:string,line:number,ref:string,sel:string,call:string}>, checked:number}}
 */
function findDeadRefs(jsDir, known) {
  const found = [];
  let checked = 0;

  for (const f of fs.readdirSync(jsDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    const names = CORE_CALLS.concat(SHORTHANDS, shorthandsIn(src));
    const call = new RegExp(
      '(?<![\\w$])(' + names.join('|') + ')\\s*\\(\\s*([\'"`])([^\'"`]*)\\2\\s*\\)', 'g');

    let m;
    while ((m = call.exec(src))) {
      const [, fn, , sel] = m;
      if (sel.includes('${') || !sel.trim()) continue;   // собранная строка — не наше дело
      const line = src.slice(0, m.index).split('\n').length;
      const say = (name, kind, ref) => {
        checked++;
        if (!kind.has(name)) found.push({ file: f, line, ref, sel, call: fn });
      };

      if (fn === 'getElementById') { say(sel.trim(), known.ids, '#' + sel.trim()); continue; }

      let t;
      const ids = /#([A-Za-z][\w-]*)/g;
      while ((t = ids.exec(sel))) say(t[1], known.ids, '#' + t[1]);
      const cls = /\.([A-Za-z][\w-]*)/g;
      while ((t = cls.exec(sel))) say(t[1], known.classes, '.' + t[1]);
      const at = /\[\s*(data-[\w-]+)/g;
      while ((t = at.exec(sel))) say(t[1], known.attrs, '[' + t[1] + ']');
    }
  }
  return { found, checked };
}

module.exports = { collectKnown, findDeadRefs };
