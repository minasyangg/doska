/* ============================================================
   Поиск записи в ввезённое имя.

   Самый коварный класс ошибок при разделении клиента на модули — и тот, на
   котором первый заход и сломался.

   Ввезённая привязка доступна только для чтения. Пока клиент был одним файлом,
   общее изменяемое состояние (что выделено, что тянут, что рисуют сейчас) жило
   в одной области видимости: ввод спокойно писал то, что читает отрисовка.
   После разделения ввод стал ВВОЗИТЬ эти имена, и первое же присваивание
   давало TypeError. Сидят такие присваивания внутри обработчиков — поэтому
   связывание проходило, загрузка проходила, а доска не открывалась.

   Проверка нарочно статическая, по тексту: выполнение сюда не годится. Чтобы
   поймать присваивание запуском, надо довести код ровно до той строки, а
   половина веток на заглушке недостижима. Текст же виден весь и сразу.

   Что считается записью: =, ++, --, а также +=, -=, *=, /= и прочие
   составные. Не считается: сравнение (==, ===, !=, >=), стрелка (=>) и
   собственное объявление (const x =, let x =) — последнее вообще не запись в
   чужое, а заведение своего имени, просто совпавшего.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const NAME = '[A-Za-z_$][A-Za-z0-9_$]*';
const ASSIGN = new RegExp(
  '(?<![.\\w$])(' + NAME + ')\\s*(?:(?<![=!<>+\\-*/%|&^])=(?![=>])|\\+\\+|--|[+\\-*/%|&^]=)',
  'g');
const DECLARE = /(?:^|[;{}\s(])(?:const|let|var)\s+$/;
const IMPORT_LINE = /^import \{ (.+?) \} from '\.\/(.+?)\.js';$/;

/** Строка без содержимого литералов и комментариев, но той же длины. */
function blankOut(line) {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, m => "'" + ' '.repeat(m.length - 2) + "'")
    .replace(/"(?:[^"\\]|\\.)*"/g, m => '"' + ' '.repeat(m.length - 2) + '"')
    .replace(/`(?:[^`\\]|\\.)*`/g, m => '`' + ' '.repeat(m.length - 2) + '`')
    .replace(/\/\/.*$/, '');
}

/**
 * @param {string} dir каталог с модулями
 * @returns {Array<{file:string, line:number, name:string, from:string}>}
 */
function findImportWrites(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'main.js') continue;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);

    const imported = new Map();
    for (const l of lines) {
      const m = l.trim().match(IMPORT_LINE);
      if (m) for (const n of m[1].split(',')) imported.set(n.trim(), m[2]);
    }
    if (!imported.size) continue;

    let inBlock = false;
    lines.forEach((raw, i) => {
      // многострочный комментарий: внутри него искать нечего
      let l = raw;
      if (inBlock) {
        const end = l.indexOf('*/');
        if (end < 0) return;
        l = ' '.repeat(end + 2) + l.slice(end + 2);
        inBlock = false;
      }
      const open = l.lastIndexOf('/*');
      if (open >= 0 && l.indexOf('*/', open) < 0) { inBlock = true; l = l.slice(0, open); }
      l = blankOut(l);

      let m;
      ASSIGN.lastIndex = 0;
      while ((m = ASSIGN.exec(l))) {
        const name = m[1];
        if (!imported.has(name)) continue;
        if (DECLARE.test(l.slice(0, m.index))) continue;
        out.push({ file: f, line: i + 1, name, from: imported.get(name) });
      }
    });
  }
  return out;
}

module.exports = { findImportWrites };
