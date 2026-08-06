/* ============================================================
   Доступ к БД mcko-app через PostgREST — всегда access-токеном самого
   пользователя, никогда сервисным ключом.

   Это не экономия, а архитектурное решение: авторизацию целиком делает RLS
   на стороне mcko-app (см. 041_doska_boards.sql). Доска не знает и не должна
   знать, кто чей ученик и какая организация чья — она спрашивает, а БД молча
   отдаёт только то, что этому пользователю положено. Сервисного ключа у доски
   нет вовсе, поэтому утечка с её диска не открывает чужие данные.
   ============================================================ */
'use strict';
const { supabaseUrl, anonKey } = require('./gotrue');

class DbError extends Error {
  constructor(message, { status = 0, transport = false, code = null } = {}) {
    super(message);
    this.name = 'DbError';
    this.status = status;
    this.transport = transport;
    this.code = code;
  }
}

async function rest(path, { token, method = 'GET', body, prefer, timeout = 10000 } = {}) {
  const base = supabaseUrl();
  if (!base) throw new DbError('Supabase не настроен', { transport: true });

  const headers = { apikey: anonKey(), authorization: 'Bearer ' + token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (prefer) headers.prefer = prefer;

  let r;
  try {
    r = await fetch(base + '/rest/v1' + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    throw new DbError('БД недоступна: ' + e.message, { transport: true });
  }

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    throw new DbError(
      (data && (data.message || data.hint)) || ('БД ответила ' + r.status),
      { status: r.status, transport: r.status >= 500, code: data && data.code }
    );
  }
  return data;
}

const one = rows => (Array.isArray(rows) && rows.length ? rows[0] : null);
const q = v => encodeURIComponent(v);

/* ─── профиль ───────────────────────────────────────────── */

/** Роль, имя и организация — из mcko-app, а не из своей таблицы.
    RLS даёт читать свой профиль всем, так что токена достаточно. */
const getProfile = (token, userId) =>
  rest(`/profiles?id=eq.${q(userId)}&select=id,role,full_name,email,organization_id&limit=1`, { token })
    .then(one);

/** Ученики этого учителя — для выбора участников. Фильтровать по учителю не
    надо: политика «profiles: teacher read own students» уже это делает. */
const listMyStudents = token =>
  rest('/profiles?role=eq.student&deleted_at=is.null&select=id,full_name,grade&order=full_name', { token });

/* ─── доски ─────────────────────────────────────────────── */

const BOARD_COLS =
  'id,owner_id,title,guest_access,object_edit_policy,locked,created_at,updated_at,' +
  'owner:profiles!doska_boards_owner_id_fkey(full_name)';

/** Один запрос на весь список: RLS сама объединяет свои доски, доски, где ты
    участник, и — для админа — доски организации. Кто есть кто, доска понимает
    по owner_id, а не отдельными запросами. */
const listBoards = token =>
  rest(`/doska_boards?deleted_at=is.null&select=${q(BOARD_COLS)}&order=updated_at.desc`, { token });

const getBoard = (token, id) =>
  rest(`/doska_boards?id=eq.${q(id)}&select=${q(BOARD_COLS)}&limit=1`, { token }).then(one);

const createBoard = (token, { id, owner_id, title }) =>
  rest('/doska_boards', {
    token, method: 'POST', prefer: 'return=representation',
    body: { id, owner_id, title }
  }).then(one);

const patchBoard = (token, id, patch) =>
  rest(`/doska_boards?id=eq.${q(id)}`, {
    token, method: 'PATCH', prefer: 'return=representation', body: patch
  }).then(one);

/** Удаление мягкое — политики delete нет вовсе, есть только deleted_at. */
const softDeleteBoard = (token, id) =>
  patchBoard(token, id, { deleted_at: new Date().toISOString() });

/* ─── участники ─────────────────────────────────────────── */

const listParticipants = (token, boardId) =>
  rest(`/doska_board_participants?board_id=eq.${q(boardId)}` +
       `&select=${q('board_id,user_id,access,created_at,profile:profiles!doska_board_participants_user_id_fkey(full_name,grade)')}`,
       { token });

/** added_by и «свой ли это ученик» проверяет политика insert, не мы. */
const addParticipant = (token, boardId, userId, access, addedBy) =>
  rest('/doska_board_participants', {
    token, method: 'POST', prefer: 'return=representation',
    body: { board_id: boardId, user_id: userId, access, added_by: addedBy }
  }).then(one);

const setParticipantAccess = (token, boardId, userId, access) =>
  rest(`/doska_board_participants?board_id=eq.${q(boardId)}&user_id=eq.${q(userId)}`, {
    token, method: 'PATCH', prefer: 'return=representation', body: { access }
  }).then(one);

const removeParticipant = (token, boardId, userId) =>
  rest(`/doska_board_participants?board_id=eq.${q(boardId)}&user_id=eq.${q(userId)}`,
       { token, method: 'DELETE' });

/** Уровень доступа этого пользователя к этой доске, или null. */
const getMyAccess = (token, boardId, userId) =>
  rest(`/doska_board_participants?board_id=eq.${q(boardId)}&user_id=eq.${q(userId)}&select=access&limit=1`,
       { token }).then(r => (one(r) || {}).access || null);

/* ─── гостевые ссылки ───────────────────────────────────── */

/** Токен видит только владелец: политика на doska_board_guest_links одна. */
const getGuestLink = (token, boardId) =>
  rest(`/doska_board_guest_links?board_id=eq.${q(boardId)}&select=token,created_at&limit=1`, { token })
    .then(one);

const setGuestLink = (token, boardId, tokenValue) =>
  rest('/doska_board_guest_links', {
    token, method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: { board_id: boardId, token: tokenValue }
  }).then(one);

const dropGuestLink = (token, boardId) =>
  rest(`/doska_board_guest_links?board_id=eq.${q(boardId)}`, { token, method: 'DELETE' });

/** Вход гостя. Единственный вызов от имени anon: security-definer функция
    отдаёт доску, только если токен верен И владелец включил гостевой доступ. */
async function guestOpen(boardId, guestToken) {
  const base = supabaseUrl();
  if (!base) throw new DbError('Supabase не настроен', { transport: true });
  let r;
  try {
    r = await fetch(base + '/rest/v1/rpc/doska_guest_open', {
      method: 'POST',
      headers: { apikey: anonKey(), authorization: 'Bearer ' + anonKey(),
                 'content-type': 'application/json' },
      body: JSON.stringify({ p_board_id: boardId, p_token: guestToken }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    throw new DbError('БД недоступна: ' + e.message, { transport: true });
  }
  if (!r.ok) throw new DbError('БД ответила ' + r.status, { status: r.status, transport: r.status >= 500 });
  return one(await r.json());
}

module.exports = {
  DbError, rest,
  getProfile, listMyStudents,
  listBoards, getBoard, createBoard, patchBoard, softDeleteBoard,
  listParticipants, addParticipant, setParticipantAccess, removeParticipant, getMyAccess,
  getGuestLink, setGuestLink, dropGuestLink, guestOpen
};
