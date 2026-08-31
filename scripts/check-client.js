/* ============================================================
   Прогон клиента без браузера.

   Зачем. Автоматических проверок у клиента нет. Пока он лежал одним куском,
   это было терпимо: ошибка вылезала при первом же открытии доски. После
   разделения на модули появился класс ошибок, которого раньше быть не могло, —
   имя, объявленное в одном файле и использованное в другом без импорта. Такое
   не ловится ни node --check, ни глазами: страница просто не загружается, и
   хорошо ещё, если сразу, а не на редкой ветке вроде вкладки администратора.

   Что делает. Собирает граф модулей из public/js настоящим загрузчиком
   (vm.SourceTextModule), выполняет его на заглушке браузера, показывает три
   экрана (вход, доска, список досок) и последним проходом дёргает все
   развешенные обработчики. Плюс две проверки по тексту, до всякого запуска:
   запись в ввезённое имя и ссылка на разметку, которой нет.

   Почему настоящий загрузчик, а не склейка файлов. Склейка проверила бы, что
   код выполняется, но не проверила бы сами импорты: ввоз имени, которого сосед
   не вывозит, — это ошибка связывания, и её ловит только линкер. Он же
   сообщает о ней ДО выполнения, точным сообщением, а не падением где-то в
   середине.

   Учитывается ТОЛЬКО ошибка вида ReferenceError: всё прочее, что вылезает при
   вызове обработчика на заглушке, — это отсутствующее состояние доски, а не
   дефект кода, и шуметь про него бессмысленно. Считаются и отказы обещаний:
   добрая половина кода доски асинхронна, а там ошибка наружу не выходит.

   Чего он НЕ проверяет. Ветки внутри обработчиков, куда поддельное событие не
   заводит («если выделено больше одного»), остаются непройденными. Имена
   элементов, собранные из кусков ('#row'+i), не видны ни тексту, ни заглушке.
   И класс, упомянутый где-нибудь в коде, считается существующим, даже если из
   разметки его убрали, — сбор нарочно щедрый, чтобы не шуметь понапрасну.
   Это не замена ручной проверке, это сито на несколько самых разрушительных
   классов ошибок.

   Заглушка нарочно всеядная: любое свойство отдаёт объект, который можно и
   позвать, и сложить, и сравнить. Она не изображает браузер, она лишь не
   мешает коду доработать до конца.

   Одно исключение из всеядности — поиск по идентификатору. Всеядность здесь
   стоила дорого: раз заглушка отдаёт объект на любой запрос, обращение к
   элементу, который из разметки удалили, для неё неотличимо от обращения к
   живому. Поэтому document.getElementById сверяется с настоящей разметкой и
   на неизвестное имя честно отдаёт null — как отдал бы браузер. Что объявлено
   разметкой, собирает scripts/lib-dom-refs.js; он же ловит то же самое по
   тексту, ещё до запуска.

   Запуск:  npm run check
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const { findImportWrites } = require('./lib-import-writes');
const { collectKnown, findDeadRefs } = require('./lib-dom-refs');

const NL = String.fromCharCode(10);
const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const ENTRY = path.join(JS_DIR, 'main.js');
const HTML = path.join(__dirname, '..', 'public', 'index.html');

/* Что разметка объявляет на самом деле. Нужно и заглушке (см. ниже), и
   текстовой проверке, поэтому собирается один раз и до всего остального. */
const known = collectKnown(HTML, JS_DIR);

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

function stubNode(name, depth, over) {
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
      if (over && Object.prototype.hasOwnProperty.call(over, k)) return over[k];
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

/* Половина кода доски асинхронна (маршруты, открытие доски, обращения к
   серверу). Ошибка в асинхронной функции не выбрасывается наружу, а тихо
   становится отказом обещания, и обычный try/catch вокруг вызова её не видит:
   проход отчитывался «всё хорошо», хотя route падал на первой же строке.
   Ловим отказы отдельно и разбираем вместе со всем остальным. */
const rejections = [];
process.on('unhandledRejection', e => rejections.push(e));
const settle = () => new Promise(r => setImmediate(r));

const storage = { getItem: () => null, setItem() {}, removeItem() {} };

/* ── поиск по идентификатору: тут заглушка честная ─────────────
   Всеядность нужна затем, чтобы код доработал до конца, — но у поиска по
   идентификатору она отнимает единственную осмысленную проверку. Здесь
   заглушка сверяется с настоящей разметкой и на неизвестное имя отдаёт null,
   как отдал бы браузер. Дальше код либо разыменует null и упадёт (ровно там,
   где упал бы у ученика), либо просто ничего не найдёт, — но само обращение
   уже записано, и о нём будет сказано.

   Это добирает то, чего не видит текстовая проверка: идентификаторы, которые
   в коде лежат не доводом вызова, а списком (app.js: boardUi) или
   переменной. */
const missingRefs = new Map();
function elementById(id) {
  id = String(id);
  // глубина 2 — та же, что была у document.getElementById() до этой правки:
  // от неё зависит, где обход дерева упрётся в потолок вложенности
  if (known.ids.has(id)) return stubNode('#' + id, 2);
  if (!missingRefs.has(id)) {
    const at = String(new Error().stack || '').split(NL).find(l => l.includes('/js/'));
    missingRefs.set(id, at ? at.trim() : 'место не определилось');
  }
  return null;
}

const sandbox = {
  console,
  document: stubNode('document', 0, {
    getElementById: elementById,
    querySelector(sel) {
      const s = String(sel).trim();
      return /^#[A-Za-z][\w-]*$/.test(s) ? elementById(s.slice(1))
                                         : stubNode('document.querySelector()', 2);
    },
  }),
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
  // Контекст vm даёт только интринсики языка — ни URL, ни URLSearchParams в
  // нём нет. Без этой строки route падал на разборе адреса, то есть на
  // отсутствии браузера, а не на собственной ошибке.
  URLSearchParams,
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

  /* Запись в ввезённое имя — проверяем ДО запуска и по тексту.
     Именно этот класс ошибок сломал первый заход: связывание проходило,
     загрузка проходила, а доска не открывалась, потому что присваивание
     ввезённой привязке даёт TypeError, и сидят такие присваивания внутри
     обработчиков. Подробности — в scripts/lib-import-writes.js. */
  const writes = findImportWrites(JS_DIR);
  if (writes.length) {
    failed = true;
    console.error(NL + 'ЗАПИСЬ В ВВЕЗЁННОЕ ИМЯ (' + writes.length + '):');
    for (const w of writes)
      console.error('  ' + w.file + ':' + w.line + '  ' + w.name + ' — ввезено из ' + w.from + ".js");
    console.error(NL + '  Ввезённая привязка доступна только для чтения. Имя должно жить в том' +
                  NL + '  модуле, который в него пишет, либо меняться через функцию этого модуля.');
  } else {
    console.log('записи в ввезённые имена: нет');
  }

  /* Ссылки на удалённую разметку — тоже по тексту и тоже до запуска.
     Запуском такое ловится плохо: обращение сидит внутри обработчика, а до
     обработчика поддельное событие доходит не всегда. В тексте же видно всё
     сразу. Подробности — в scripts/lib-dom-refs.js. */
  const dead = findDeadRefs(JS_DIR, known);
  if (dead.found.length) {
    failed = true;
    console.error(NL + 'ССЫЛКА НА РАЗМЕТКУ, КОТОРОЙ НЕТ (' + dead.found.length + '):');
    for (const d of dead.found)
      console.error('  ' + d.file + ':' + d.line + '  ' + d.ref +
                    '  —  ' + d.call + "('" + d.sel + "')");
    console.error(NL + '  Ни в public/index.html, ни в разметке, собираемой из кода, такого нет.' +
                  NL + '  Либо опечатка, либо остаток от удалённого куска интерфейса.');
  } else {
    console.log('ссылки на разметку: ' + dead.checked + ' проверено, все на месте' +
                ' (' + known.ids.size + ' id, ' + known.classes.size + ' классов, ' +
                known.attrs.size + ' data-атрибутов)');
  }

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

  /* Второй проход: три экрана.

     Загрузка модулей только развешивает обработчики — ни список досок, ни
     вход, ни сама доска при этом не показываются, и весь код показа экрана
     остаётся непройденным. А там-то и живут обращения к разметке: showView
     обходит список из семи идентификаторов и каждый разыменовывает. Список
     этот по тексту не проверить (идентификаторы лежат в массиве, а не доводом
     вызова), заглушкой — можно, но только если до него дойти.

     Заходим через nav: сначала ставим адрес, потом зовём — иначе route
     прочитает старый путь и покажет не тот экран. */
  const SCREENS = ['/login', '/board/probe', '/'];
  const refErrors = [];
  const app = loaded.get(path.join(JS_DIR, 'app.js'));
  sandbox.__nav = app && app.namespace ? app.namespace.nav : null;
  if (sandbox.__nav) {
    for (const p of SCREENS) {
      sandbox.location.pathname = p;
      sandbox.location.search = '';
      try {
        vm.runInContext('__err = null; try { __nav(' + JSON.stringify(p) + '); } catch (e) { __err = e; }',
                        sandbox, { timeout: 2000 });
        const e = sandbox.__err;
        if (e && e.constructor && e.constructor.name === 'ReferenceError')
          refErrors.push(['экран ' + p, e.message, e]);
      } catch { /* ушёл в бесконечный цикл на нулях — не наша забота */ }
    }
    await settle();
    sandbox.location.pathname = '/';
    console.log('экраны показаны: ' + SCREENS.length + ' (вход, доска, список досок)');
  } else {
    failed = true;
    console.error(NL + 'app.js больше не вывозит nav — экраны не показать');
  }

  /* Третий проход: дёргаем собранные обработчики.

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
  await settle();
  console.log('обработчиков вызвано: ' + list.length +
              (stuck ? ' (' + stuck + ' не уложились в таймаут — пропущены)' : '') +
              (refErrors.length ? '' : ', необъявленных имён среди них нет'));
  if (refErrors.length) {
    failed = true;
    console.error(NL + 'НЕОБЪЯВЛЕННЫЕ ИМЕНА (экраны и обработчики):');
    for (const [where, msg, e] of refErrors) {
      const line = String(e.stack || '').split(NL).find(l => l.includes('/js/'));
      console.error('  ' + where + ': ' + msg + (line ? '   ' + line.trim() : ''));
    }
  }
  /* Отказы обещаний — то же сито, что и у обработчиков: интересен только
     ReferenceError, всё прочее на заглушке ожидаемо (сервера нет, данных нет). */
  await settle();
  const refRejects = rejections.filter(e => e && e.constructor && e.constructor.name === 'ReferenceError');
  if (refRejects.length) {
    failed = true;
    console.error(NL + 'НЕОБЪЯВЛЕННЫЕ ИМЕНА в асинхронном коде (' + refRejects.length + '):');
    for (const e of refRejects) {
      const at = String(e.stack || '').split(NL).find(l => l.includes('/js/'));
      console.error('  ' + e.message + (at ? '   ' + at.trim() : ''));
    }
  } else if (rejections.length) {
    console.log('отказов обещаний: ' + rejections.length + ' — все ожидаемые (сервера нет)');
  }

  /* Что заглушка не нашла в разметке за оба прохода. Найденное текстовой
     проверкой не повторяем — это одно и то же, сказанное дважды. */
  const seen = new Set(dead.found.filter(d => d.ref[0] === '#').map(d => d.ref.slice(1)));
  const atRun = [...missingRefs].filter(([id]) => !seen.has(id));
  if (atRun.length) {
    failed = true;
    console.error(NL + 'ПОИСК ЭЛЕМЕНТА, КОТОРОГО НЕТ В РАЗМЕТКЕ (' + atRun.length + '):');
    for (const [id, at] of atRun) console.error('  #' + id + '   ' + at);
    console.error(NL + '  Найдено на выполнении: идентификатор пришёл не строкой в вызове,' +
                  NL + '  а из списка или переменной, поэтому по тексту его не видно.');
  }

  process.exit(failed ? 1 : 0);
})();
