/* ============================================================
   Прогон клиента без браузера.

   Зачем. Автоматических проверок у клиента нет. Пока он лежал одним куском,
   это было терпимо: ошибка вылезала при первом же открытии доски. После
   разделения на модули появился класс ошибок, которого раньше быть не могло, —
   имя, объявленное в одном файле и использованное в другом без импорта. Такое
   не ловится ни node --check, ни глазами: страница просто не загружается, и
   хорошо ещё, если сразу, а не на редкой ветке вроде вкладки администратора.

   Что делает. Собирает граф модулей из public/js настоящим загрузчиком
   (vm.SourceTextModule), выполняет его на заглушке браузера и вторым проходом
   дёргает все развешенные обработчики.

   Почему настоящий загрузчик, а не склейка файлов. Склейка проверила бы, что
   код выполняется, но не проверила бы сами импорты: ввоз имени, которого сосед
   не вывозит, — это ошибка связывания, и её ловит только линкер. Он же
   сообщает о ней ДО выполнения, точным сообщением, а не падением где-то в
   середине.

   Учитывается ТОЛЬКО ошибка вида ReferenceError: всё прочее, что вылезает при
   вызове обработчика на заглушке, — это отсутствующее состояние доски, а не
   дефект кода, и шуметь про него бессмысленно.

   Чего он НЕ проверяет. Ветки внутри обработчиков, куда поддельное событие не
   заводит («если выделено больше одного»), остаются непройденными. Это не
   замена ручной проверке, это сито на один, зато самый разрушительный класс
   ошибок.

   Заглушка нарочно всеядная: любое свойство отдаёт объект, который можно и
   позвать, и сложить, и сравнить. Она не изображает браузер, она лишь не
   мешает коду доработать до конца.

   Запуск:  npm run check
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const NL = String.fromCharCode(10);
const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const ENTRY = path.join(JS_DIR, 'main.js');

/* ── заглушка браузера ────────────────────────────────────────
   Один универсальный узел на всё: элемент, контекст холста, список узлов.
   Возвращает сам себя на любое обращение, поэтому цепочки любой длины
   (document.getElementById('x').classList.toggle(...)) проходят насквозь. */
const handlers = [];
const isHandlerKey = k => typeof k === 'string' && k.startsWith('on') && k.length > 2;

/* Обход дерева обязан заканчиваться. Иначе цикл вида «поднимайся к родителю,
   пока он есть» — а такие в коде доски встречаются — на всеядной заглушке
   становится бесконечным: она ведь на любое обращение отдаёт объект, а объект
   всегда истинный. Поэтому связи между узлами возвращают null, а глубина
   вложенности ограничена. */
const TREE_KEYS = new Set(['parentNode', 'parentElement', 'closest', 'nextSibling',
                           'previousSibling', 'firstChild', 'lastChild', 'firstElementChild',
                           'lastElementChild', 'nextElementSibling', 'previousElementSibling',
                           'offsetParent']);
const MAX_DEPTH = 8;

function stubNode(name, depth) {
  depth = depth || 0;
  const fn = function () { return fn; };
  fn._name = name;
  const box = {
    // то, что код складывает и сравнивает как числа
    width: 1280, height: 720, clientWidth: 1280, clientHeight: 720,
    offsetWidth: 1280, offsetHeight: 720, scrollTop: 0, scrollLeft: 0,
    length: 0, value: '', textContent: '', innerHTML: '', className: '',
    checked: false, disabled: false, hidden: false, maxLength: 0, tabIndex: 0,
    // список узлов ведёт себя как пустой массив
    forEach() {}, map() { return []; }, filter() { return []; },
  };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;              // не путать с обещанием
      if (k in box) return box[k];
      if (TREE_KEYS.has(k)) return depth ? null : (() => null);
      if (depth >= MAX_DEPTH) return undefined;
      return stubNode(name + '.' + String(k), depth + 1);
    },
    set(t, k, v) {
      if (isHandlerKey(k) && typeof v === 'function') handlers.push([name + '.' + String(k), v]);
      box[k] = v; return true;
    },
    has() { return true; },
    apply(t, self, args) {
      // element.addEventListener('click', fn) — второй аргумент и есть обработчик
      if (name.endsWith('addEventListener') && typeof args[1] === 'function')
        handlers.push([name + '(' + args[0] + ')', args[1]]);
      return stubNode(name + '()', depth + 1);
    },
  });
}

const storage = { getItem: () => null, setItem() {}, removeItem() {} };

const sandbox = {
  console,
  document: stubNode('document'),
  localStorage: storage, sessionStorage: storage,
  location: { protocol: 'https:', host: 'tutpad.ru', hostname: 'tutpad.ru',
              pathname: '/', search: '', hash: '', href: 'https://tutpad.ru/' },
  history: { pushState() {}, replaceState() {} },
  navigator: { userAgent: 'check-client', maxTouchPoints: 0, clipboard: { write() {} } },
  performance: { now: () => 0 },
  devicePixelRatio: 2,
  innerWidth: 1280, innerHeight: 720,
  crypto: { getRandomValues: a => a, randomUUID: () => 'x' },
  // таймеры и кадры глушим: клиент вешает несколько интервалов, и живыми они
  // здесь только помешали бы процессу завершиться
  setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  addEventListener(type, fn) { if (typeof fn === 'function') handlers.push(['window.' + type, fn]); },
  removeEventListener() {},
  fetch: () => new Promise(() => {}),
  WebSocket: function () { return stubNode('ws'); },
  Image: function () { return stubNode('img'); },
  FileReader: function () { return stubNode('fr'); },
  Blob: function () { return stubNode('blob'); },
  URL: { createObjectURL: () => '', revokeObjectURL() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => stubNode('style'),
  alert() {}, confirm: () => true, prompt: () => null,
  btoa: s => Buffer.from(String(s), 'binary').toString('base64'),
  atob: s => Buffer.from(String(s), 'base64').toString('binary'),
  ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

/* ── сборка графа модулей ─────────────────────────────────── */
const loaded = new Map();
function moduleFor(file) {
  const key = path.resolve(file);
  if (loaded.has(key)) return loaded.get(key);
  const src = fs.readFileSync(key, 'utf8');
  const m = new vm.SourceTextModule(src, {
    identifier: pathToFileURL(key).href,
    context: sandbox,
    initializeImportMeta(meta) { meta.url = pathToFileURL(key).href; },
  });
  loaded.set(key, m);
  return m;
}
function linker(spec, referrer) {
  const from = path.dirname(new URL(referrer.identifier).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return moduleFor(path.resolve(from, spec));
}

(async () => {
  if (!fs.existsSync(ENTRY)) {
    console.error('нет ' + ENTRY + ' — клиент ещё не разделён на модули?');
    process.exit(1);
  }
  const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));
  console.log('public/js: ' + files.length + ' модулей, ' +
              files.reduce((n, f) => n + fs.readFileSync(path.join(JS_DIR, f), 'utf8').split(NL).length, 0) +
              ' строк');

  let failed = false;
  const entry = moduleFor(ENTRY);
  try {
    // связывание: именно здесь всплывает ввоз имени, которого сосед не вывозит
    await entry.link(linker);
    console.log('связывание прошло: все импорты нашли свои экспорты');
  } catch (e) {
    console.error(NL + 'ОШИБКА СВЯЗЫВАНИЯ: ' + e.message);
    process.exit(1);
  }
  try {
    await entry.evaluate({ timeout: 30000 });
    console.log('загрузка прошла: необъявленных имён нет');
  } catch (e) {
    failed = true;
    console.error(NL + 'ОШИБКА при загрузке клиента:');
    console.error('  ' + e.name + ': ' + e.message);
    const line = String(e.stack || '').split(NL).find(l => l.includes('/js/'));
    if (line) console.error('  ' + line.trim());
    if (e instanceof ReferenceError)
      console.error(NL + '  Похоже на имя, которое объявлено в другом модуле, но сюда не ввезено.');
    process.exit(1);
  }

  /* Дымовая проверка: «загрузилось» и «загрузилось правильно» — разные вещи.

     Модули ссылаются друг на друга кольцами, и при кольцах реестр может
     оказаться пустым, а не отсутствующим: имя есть, ошибки нет, просто данные
     не успели попасть на место. Поэтому проверяем не наличие имён, а
     наполненность самых крупных реестров — тех, из которых собирается
     интерфейс и разбираются присланные объекты. Пустой SHAPES означает доску
     без фигур, пустой PATCHABLE — что чужие правки не применяются.  */
  /* Размер считаем без instanceof: реестры созданы внутри контекста vm, у
     которого свои Set и Map, и проверка на принадлежность через границу
     контекста не срабатывает — Set с четырьмя элементами выглядел бы пустым
     объектом. Смотрим на утиный признак: есть числовое .size или .length. */
  const size = v => !v ? -1
                  : typeof v.size === 'number' ? v.size
                  : typeof v.length === 'number' ? v.length
                  : typeof v === 'object' ? Object.keys(v).length : -1;
  /* Проверяем только МЕЖМОДУЛЬНЫЕ реестры — те, что один модуль вывозит, а
     другой ввозит. Именно там и живут ошибки порядка: реестр, оставшийся
     внутри своего модуля, к моменту использования гарантированно готов, а
     ради проверки вывозить его наружу значило бы врать про границы модуля. */
  const PROBES = [
    ['core.js',     'PENS',         'цвета пера'],
    ['core.js',     'FILLS',        'цвета заливки'],
    ['core.js',     'GRID_MODES',   'виды сетки'],
    ['core.js',     'GRID_NAMES',   'названия сеток'],
    ['core.js',     'STYLED',       'типы со стилем'],
    ['geometry.js', 'BOX_TYPES',    'типы с рамкой'],
    ['geometry.js', 'BACK_TYPES',   'типы, рисуемые снизу'],
    ['geometry.js', 'SELECTABLE',   'выделяемые типы'],
    ['geometry.js', 'ARC_TYPES',    'типы дуг'],
    ['shapes.js',   'SHAPES',       'каталог фигур'],
    ['shapes.js',   'SHAPE_GROUPS', 'разделы каталога фигур'],
    ['shapes.js',   'SHAPE_NAMES',  'названия фигур'],
    ['graph.js',    'GRAPH_COLORS', 'цвета кривых'],
  ];
  const empty = [];
  for (const [file, name, what] of PROBES) {
    const mod = loaded.get(path.join(JS_DIR, file));
    const v = mod && mod.namespace ? mod.namespace[name] : undefined;
    if (v === undefined) empty.push(name + ' (' + what + '): нет такого вывоза в ' + file);
    else if (size(v) <= 0) empty.push(name + ' (' + what + '): пусто');
  }
  if (empty.length) {
    failed = true;
    console.error(NL + 'РЕЕСТРЫ ПУСТЫ ИЛИ ОТСУТСТВУЮТ:');
    for (const e of empty) console.error('  ' + e);
  } else {
    console.log('реестры на месте и наполнены: ' + PROBES.length + ' проверено');
  }

  /* Второй проход: дёргаем собранные обработчики.

     Снимок списка обязателен: вызванный обработчик сам создаёт элементы и
     вешает на них свои (карточка доски, строка участника, поле формулы),
     список растёт прямо во время обхода, и цикл по живой длине никогда не
     кончается — на первом прогоне их набралось 125 тысяч.

     Каждый вызов идёт через vm со своим таймаутом: часть обработчиков на
     поддельном событии честно уходит в бесконечный цикл (они рассчитывают на
     настоящие числа, а получают нули), и такой цикл прерывает только V8, а
     обычный try/catch — нет. */
  const list = handlers.slice();
  sandbox.__handlers = list;
  sandbox.__ev = stubNode('event');
  sandbox.__err = null;
  const refErrors = [];
  let stuck = 0;
  for (let i = 0; i < list.length; i++) {
    try {
      vm.runInContext(
        '__err = null; try { __handlers[' + i + '][1](__ev); } catch (e) { __err = e; }',
        sandbox, { timeout: 300 });
      const e = sandbox.__err;
      if (e && e.constructor && e.constructor.name === 'ReferenceError')
        refErrors.push([list[i][0], e.message, e]);
    } catch { stuck++; }
  }
  console.log('обработчиков вызвано: ' + list.length +
              (stuck ? ' (' + stuck + ' не уложились в таймаут — пропущены)' : '') +
              (refErrors.length ? '' : ', необъявленных имён среди них нет'));
  if (refErrors.length) {
    failed = true;
    console.error(NL + 'НЕОБЪЯВЛЕННЫЕ ИМЕНА в обработчиках:');
    for (const [where, msg, e] of refErrors) {
      const line = String(e.stack || '').split(NL).find(l => l.includes('/js/'));
      console.error('  ' + where + ': ' + msg + (line ? '   ' + line.trim() : ''));
    }
  }
  process.exit(failed ? 1 : 0);
})();
