/* ============================================================
   Тонкая обёртка над Supabase Auth (GoTrue) по HTTP.
   SDK не тянем намеренно: доске нужны пять запросов, а не пакет на
   полмегабайта. Всё, что здесь есть, — это те самые пять.

   Токены пользователя живут только на сервере доски (см. lib/session.js);
   в браузер уходит лишь id сессии в httpOnly-куке.
   ============================================================ */
'use strict';

const URL_BASE = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON     = () => process.env.SUPABASE_ANON_KEY || '';

/** Настроен ли вообще Supabase. Без него доска работает только для гостей. */
const configured = () => !!(URL_BASE() && ANON());

/* Ошибка с различением «не тот пароль» и «Supabase недоступен»: первое —
   ответ пользователю, второе — не повод понижать чьи-то права (см. resolve
   в lib/capability.js, где сетевой сбой не разжалует учителя в ученика). */
class AuthError extends Error {
  constructor(message, { status = 0, transport = false } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.transport = transport;
  }
}

async function call(path, { method = 'POST', body, token, timeout = 10000 } = {}) {
  if (!configured()) throw new AuthError('Supabase не настроен', { transport: true });
  const headers = { apikey: ANON() };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let r;
  try {
    r = await fetch(URL_BASE() + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    throw new AuthError('Supabase недоступен: ' + e.message, { transport: true });
  }

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const msg = (data && (data.error_description || data.msg || data.message || data.error))
      || ('Supabase ответил ' + r.status);
    // 5xx — это про Supabase, а не про пользователя
    throw new AuthError(msg, { status: r.status, transport: r.status >= 500 });
  }
  return data;
}

/** Нормализует ответ с токенами в то, что кладём в сессию. */
function toSession(data) {
  if (!data || !data.access_token || !data.refresh_token) {
    throw new AuthError('Supabase не вернул токены');
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // expires_in в секундах; держим абсолютное время, чтобы не пересчитывать
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    user: data.user ? { id: data.user.id, email: data.user.email || null } : null
  };
}

/** Вход по паролю — этим доска и становится самостоятельным приложением. */
const signInWithPassword = (email, password) =>
  call('/auth/v1/token?grant_type=password', { body: { email, password } }).then(toSession);

/** Обновление протухшего access-токена. Вызывать строго по одному на сессию:
    ротация refresh-токенов включена, и два параллельных обмена одним и тем же
    токеном за пределами refresh_token_reuse_interval убивают всё семейство. */
const refresh = refresh_token =>
  call('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token } }).then(toSession);

/** Погашение одноразового hashed_token из admin.generateLink на стороне mcko-app.
    Только {type, token_hash}: если добавить email или redirect_to, GoTrue
    отвечает 400 «Only the token_hash and type should be provided». */
const verifyTokenHash = (token_hash, type = 'magiclink') =>
  call('/auth/v1/verify', { body: { type, token_hash } }).then(toSession);

/** Кто это. Используется как проверка живости токена. */
const getUser = token =>
  call('/auth/v1/user', { method: 'GET', token })
    .then(u => (u && u.id ? { id: u.id, email: u.email || null } : null));

/** Выход. scope=local обязателен: по умолчанию GoTrue гасит ВСЕ сессии
    пользователя, то есть выход из доски выкинул бы его и из mcko-app. */
const signOut = token =>
  call('/auth/v1/logout?scope=local', { token }).catch(e => {
    if (e.transport) return null;   // сеть отвалилась — сессию всё равно сносим
    throw e;
  });

module.exports = {
  AuthError, configured,
  signInWithPassword, refresh, verifyTokenHash, getUser, signOut,
  supabaseUrl: URL_BASE, anonKey: ANON
};
