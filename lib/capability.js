/* ============================================================
   Что этот человек может делать с этой доской.

   Один порядок разрешения на всё приложение — и HTTP, и WebSocket спрашивают
   здесь, чтобы права не разъезжались между «можно загрузить картинку» и
   «можно нарисовать линию».

     1. доски нет или удалена                        → none
     2. owner_id совпадает                           → owner
     3. есть строка участника: view / edit           → view / edit
     4. строка доски видна, но 1-3 не сработали      → view
     5. гостевая сессия именно на эту доску          → view / edit по ссылке
     6. иначе                                        → none

   Пункт 4 — не костыль, а следствие устройства RLS: единственная политика,
   которая отдаёт доску не владельцу и не участнику, — админская «читает свою
   организацию». Раз строка пришла, значит человек админ этой организации, и
   доске незачем самой знать что-либо про организации.
   ============================================================ */
'use strict';
const db = require('./db');
const session = require('./session');

const TTL = 60 * 1000;
const cache = new Map();                       // sid + '|' + boardId -> {res, until}
const CACHE_MAX = 20000;

const NONE = Object.freeze({ cap: 'none', board: null });

/* Незавершённые запросы по ключу «сессия|доска».

   Разрешение прав — это два обращения к PostgREST (сама доска и строка
   участника). Сто человек, заходящих в доску по ссылке одновременно, давали
   двести запросов залпом, и то же самое повторялось при ежеминутной
   перепроверке. Две вкладки одного человека — это одна и та же сессия, и
   ходить за одним ответом дважды незачем; при перепроверке всех разом
   совпадений набирается и того больше.

   Тот же приём, что у loadRoom в server.js и у обмена refresh-токена в
   session.js: второй и следующие получают уже начатое обещание. */
const inflight = new Map();

const RANK = { none: 0, view: 1, edit: 2, owner: 3 };
const atLeast = (cap, need) => RANK[cap] >= RANK[need];

/** Может ли рисовать прямо сейчас: замок доски владельца не касается. */
const mayEdit = (cap, locked) => cap === 'owner' || (cap === 'edit' && !locked);

async function resolveUser(s, boardId) {
  const token = await session.accessToken(s);
  if (!token) return NONE;

  const board = await db.getBoard(token, boardId);
  if (!board) return NONE;
  if (board.owner_id === s.uid) return { cap: 'owner', board };

  const access = await db.getMyAccess(token, boardId, s.uid);
  if (access === 'edit' || access === 'view') return { cap: access, board };

  return { cap: 'view', board };               // видна — значит админ организации
}

/**
 * @param {object|null} s     сессия из lib/session
 * @param {string} boardId
 * @param {object} [opts]     fresh: не брать из кэша
 * @returns {{cap:string, board:object|null}}
 */
async function resolve(s, boardId, { fresh = false } = {}) {
  if (!s || !boardId) return NONE;

  if (s.kind === 'guest') {
    // Гостевая сессия выдана ровно на одну доску и уже подтверждена токеном
    // ссылки при входе (см. /api/guest/enter), перепроверять нечего.
    return s.boardId === boardId ? { cap: s.level, board: null } : NONE;
  }

  const key = s.sid + '|' + boardId;
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.res;
  }

  // Уже идёт поход за этим же ключом — ждём его, а не начинаем свой. Верно и
  // для fresh: тот запрос всё равно идёт в БД, ответ будет свежим.
  const running = inflight.get(key);
  if (running) return running;
  const p = resolveFresh(s, boardId, key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function resolveFresh(s, boardId, key) {
  let res;
  try {
    res = await resolveUser(s, boardId);
  } catch (e) {
    // Сеть или Supabase легли — не разжалуем человека посреди урока. Понижает
    // только внятный ответ БД, что доступа нет. Если ответа не было никогда,
    // не пускаем: неизвестность трактуем в пользу закрытости.
    const hit = cache.get(key);
    if (e.transport && hit) return hit.res;
    if (e.transport) return NONE;
    res = NONE;
  }

  cache.set(key, { res, until: Date.now() + TTL });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return res;
}

/** Сбросить кэш: после правки участников или настроек доски. */
function invalidate(boardId) {
  if (!boardId) { cache.clear(); return; }
  const tail = '|' + boardId;
  for (const k of cache.keys()) if (k.endsWith(tail)) cache.delete(k);
}

module.exports = { resolve, invalidate, mayEdit, atLeast, RANK, NONE };
