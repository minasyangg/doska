/* ============================================================
   Плотная укладка точек.

   Точка на доске — это три числа: две координаты и нажим. В виде отдельного
   массива [x, y, p] она стоит около 82 байт: три числа по восемь и почти
   семьдесят байт служебных заголовков объекта. Замерено на настоящих штрихах:
   полная доска в 80 000 линий занимала 485 МБ, и держать несколько таких
   разом процесс не мог — отсюда и потолок в 80 000.

   Уложенные подряд в Float32Array те же три числа занимают двенадцать байт.
   Полная доска — 23 МБ вместо 485, в двадцать раз меньше.

   Float32 хранит около семи значащих цифр. Координаты доски округляются до
   десятых, нажим до сотых, а самая далёкая точка при разумном отдалении не
   уходит за сотню тысяч — там шаг float32 около сотой пикселя. Запаса хватает
   с избытком.

   По проводу и на диске формат прежний — [[x,y,p], ...]. Разворачиваем на
   границе: так старые снимки читаются как есть, а клиент можно перевести
   отдельно и не одновременно с сервером.
   ============================================================ */
'use strict';

/** У линий и многоугольников нажима нет, у штрихов есть. */
const strideOf = it => (it && it.type === 'path') ? 2 : 3;

/** Пары-тройки чисел → сплошной Float32Array. */
function pack(list, stride) {
  const n = list.length;
  const out = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    const a = list[i];
    const o = i * stride;
    out[o] = +a[0] || 0;
    out[o + 1] = +a[1] || 0;
    if (stride > 2) out[o + 2] = a.length > 2 ? +a[2] || 0 : 0.5;
  }
  return out;
}

/** Обратно в пары-тройки — для отправки и записи.

    Округление обязательно, и это не украшательство: 315.05 после обхода через
    float32 становится 315.04998779296875, и в JSON такое число занимает
    втрое больше места, чем исходное. */
function unpack(buf, stride, dxy = 2, dp = 3) {
  const kxy = Math.pow(10, dxy), kp = Math.pow(10, dp);
  const n = (buf.length / stride) | 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    out[i] = stride > 2
      ? [Math.round(buf[o] * kxy) / kxy, Math.round(buf[o + 1] * kxy) / kxy,
         Math.round(buf[o + 2] * kp) / kp]
      : [Math.round(buf[o] * kxy) / kxy, Math.round(buf[o + 1] * kxy) / kxy];
  }
  return out;
}

const count = (buf, stride) => (buf.length / stride) | 0;

const isPacked = v => v instanceof Float32Array;

/** Уложить точки объекта, если они ещё в виде массива массивов. */
function packItem(it) {
  if (!it || !Array.isArray(it.pts)) return it;
  it.pts = pack(it.pts, strideOf(it));
  return it;
}

/** Копия объекта или заплатки, пригодная для JSON: точки развёрнуты.
    Всё, что уходит с сервера — участникам, в журнал, в снимок — проходит
    через это. Забыть где-то одно место значит отправить Float32Array,
    который JSON.stringify превратит в {"0":…,"1":…} и сломает клиенту разбор,
    поэтому проверка на такой промах стоит в тестах. */
function wire(o, stride, dxy, dp) {
  if (!o || !isPacked(o.pts)) return o;
  return { ...o, pts: unpack(o.pts, stride === undefined ? strideOf(o) : stride, dxy, dp) };
}

module.exports = { strideOf, pack, unpack, count, isPacked, packItem, wire };
