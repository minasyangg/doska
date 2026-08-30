/* ============================================================
   Прогон клиента без браузера.

   Зачем. Клиент — один файл на шесть с половиной тысяч строк, и
   автоматических проверок у него нет вообще. Пока он лежит одним куском, это
   терпимо: ошибка вылезает при первом же открытии доски. Но как только его
   режут на модули, появляется целый класс ошибок, которых раньше быть не
   могло, — имя, объявленное в одном файле и использованное в другом без
   импорта. Такое не ловится ни node --check, ни глазами: страница просто
   падает на загрузке, и хорошо ещё, если сразу, а не на редкой ветке вроде
   вкладки администратора.

   Что делает. Достаёт содержимое <script> из index.html и выполняет его в
   Node на заглушке браузера — в СТРОГОМ режиме. Дальше падение говорит само
   за себя: обращение к необъявленному имени, присваивание необъявленному
   (в обычном режиме молча заводило глобальную, в строгом — ошибка), опечатка
   в имени функции.

   Вторым проходом дёргаются сами обработчики. Развешивая их, заглушка не
   выбрасывает их, а запоминает, и потом каждый зовётся с поддельным событием.
   Так под проверку попадает и то, что иначе выполнилось бы только по нажатию.
   Считаются при этом ТОЛЬКО ошибки вида ReferenceError: всё прочее, что
   вылезает при вызове обработчика на заглушке, — это отсутствующее состояние
   доски, а не дефект кода, и шуметь про него бессмысленно.

   Чего он НЕ проверяет, и это важно понимать. Ветки внутри обработчиков,
   куда поддельное событие не заводит (проверки вида «если выделено больше
   одного»), остаются непройденными. Это не замена ручной проверке, это сито
   на один, зато самый частый и самый разрушительный класс ошибок.

   Заглушка нарочно всеядная: любое свойство отдаёт объект, который можно и
   позвать, и сложить, и сравнить. Она не изображает браузер, она лишь не
   мешает коду доработать до конца.

   Запуск:  node scripts/check-client.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const NL = String.fromCharCode(10);
const FILE = path.join(__dirname, '..', 'public', 'index.html');

/* ── заглушка браузера ────────────────────────────────────────
   Один универсальный узел на всё: элемент, контекст холста, список узлов.
   Возвращает сам себя на любое обращение, поэтому цепочки любой длины
   (document.getElementById('x').classList.toggle(...)) проходят насквозь. */
/* Обработчики не выбрасываем, а собираем: второй проход их вызовет. */
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

const doc = stubNode('document');
const storage = { getItem: () => null, setItem() {}, removeItem() {} };

const sandbox = {
  console,
  document: doc,
  localStorage: storage, sessionStorage: storage,
  location: { protocol: 'https:', host: 'tutpad.ru', hostname: 'tutpad.ru',
              pathname: '/', search: '', hash: '', href: 'https://tutpad.ru/' },
  history: { pushState() {}, replaceState() {} },
  navigator: { userAgent: 'check-client', maxTouchPoints: 0, clipboard: { write() {} } },
  performance: { now: () => 0 },
  devicePixelRatio: 2,
  innerWidth: 1280, innerHeight: 720,
  crypto: { getRandomValues: a => a, randomUUID: () => 'x' },
  // таймеры и кадры глушим: скрипт вешает несколько интервалов, и живыми они
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

/* ── сам прогон ──────────────────────────────────────────── */
function scriptsOf(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const html = fs.readFileSync(FILE, 'utf8');
const parts = scriptsOf(html);
if (!parts.length) { console.error('в index.html не нашлось ни одного <script> с кодом'); process.exit(1); }

const js = parts.join('\n');
console.log('index.html: ' + parts.length + ' блок(ов) <script>, ' + js.split('\n').length + ' строк');

vm.createContext(sandbox);
let failed = false;
try {
  // строгий режим — то же, что включат ES-модули; здесь он и проверяется
  vm.runInContext("'use strict';\n" + js, sandbox, { filename: 'index.html<script>', timeout: 20000 });
  console.log('загрузка прошла: строгий режим выдержан, необъявленных имён нет');

  /* Второй проход: дёргаем собранные обработчики. Событие поддельное и
     всеядное — задача не изобразить нажатие, а дать коду дойти до тех строк,
     которые при загрузке не выполняются.

     Каждый вызов идёт через vm со своим таймаутом, и это не перестраховка:
     на поддельном событии один из обработчиков честно уходит в бесконечный
     цикл (что понятно — он рассчитывает на настоящие числа, а получает нули),
     и без ограничения проверка просто виснет навсегда. V8 такой цикл прерывает,
     а обычный try/catch — нет. */
  /* Снимок списка обязателен: вызванный обработчик сам создаёт элементы и
     вешает на них свои обработчики (карточка доски, строка участника, поле
     формулы), список растёт прямо во время обхода, и цикл по живой длине
     никогда не кончается — на первом же прогоне их набралось 125 тысяч. */
  const list = handlers.slice();
  sandbox.__handlers = list;
  sandbox.__ev = stubNode('event');
  sandbox.__err = null;
  const refErrors = [];
  let called = 0, stuck = 0;
  for (let i = 0; i < list.length; i++) {
    called++;
    try {
      vm.runInContext(
        '__err = null; try { __handlers[' + i + '][1](__ev); } catch (e) { __err = e; }',
        sandbox, { timeout: 300 });
      const e = sandbox.__err;
      // всё, кроме ReferenceError, — это отсутствующее состояние доски на
      // заглушке, а не дефект кода
      if (e && e.constructor && e.constructor.name === 'ReferenceError')
        refErrors.push([list[i][0], e.message, e]);
    } catch { stuck++; }        // не уложился в таймаут — не наше дело
  }
  console.log('обработчиков вызвано: ' + called +
              (stuck ? ' (' + stuck + ' не уложились в таймаут — пропущены)' : '') +
              (refErrors.length ? '' : ', необъявленных имён среди них нет'));
  if (refErrors.length) {
    failed = true;
    console.error(NL + 'НЕОБЪЯВЛЕННЫЕ ИМЕНА в обработчиках:');
    for (const [where, msg, e] of refErrors) {
      const line = String(e.stack || '').split(NL).find(l => l.includes('index.html<script>'));
      console.error('  ' + where + ': ' + msg + (line ? '   ' + line.trim() : ''));
    }
  }
} catch (e) {
  failed = true;
  console.error('\nОШИБКА при загрузке клиента:');
  console.error('  ' + e.name + ': ' + e.message);
  const line = (e.stack || '').split('\n').find(l => l.includes('index.html<script>'));
  if (line) console.error('  ' + line.trim());
  if (e instanceof ReferenceError)
    console.error('\n  Похоже на необъявленное имя. В обычном режиме такое молча заводило\n' +
                  '  глобальную переменную, в строгом (и в ES-модулях) это ошибка.');
}
process.exit(failed ? 1 : 0);
