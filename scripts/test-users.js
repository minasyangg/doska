/* ============================================================
   Состав для проверок доски.

   Чтобы проверить доску по-настоящему, одного учителя мало: нужно войти
   учеником и увидеть, что видно ему, вторым учителем — и убедиться, что чужое
   ему не показывают, и гостем по ссылке. Держать эти учётные записи в голове
   не выйдет, поэтому они заводятся здесь.

   Запуск (ключ берётся из mcko-app — у доски его нет и быть не должно,
   сервисный ключ обходит все правила доступа):

     SUPABASE_SERVICE_ROLE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY ../mcko-app/.env.local | cut -d= -f2) \
       node scripts/test-users.js

   Скрипт можно гонять сколько угодно: он чинит недостающее и не трогает
   остальное. Пароли выставляются заново каждый раз — именно за этим он и
   нужен, если пароль забыт.

   Библиотек не подключает: доска везде ходит в Supabase обычными запросами,
   и заводить ради скрипта отдельную зависимость незачем.

   ВАЖНО: записи заводятся в той же базе, что и рабочие. Так уже устроены
   существующие учётные записи на @mcko.test — новые сделаны в том же стиле,
   чтобы их было видно и легко отличить от настоящих людей.
   ============================================================ */
'use strict';

const URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL ||
             'https://zcfgyfugxtbnqrcjfifo.supabase.co').replace(/\/$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SERVICE) {
  console.error('Нет SUPABASE_SERVICE_ROLE_KEY. Запускать так:');
  console.error('  node --env-file=.env.dev.local scripts/test-users.js');
  process.exit(1);
}

const H = { apikey: SERVICE, authorization: 'Bearer ' + SERVICE,
            'content-type': 'application/json' };

async function call(path, opt = {}) {
  const r = await fetch(URL + path, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(r.status + ' ' + path + ': ' +
    (body && body.message || body && body.error_description || text || '').slice(0, 160));
  return body;
}
/** Вставка «есть — обнови»: PostgREST умеет это заголовком Prefer. */
const upsert = (table, row, onConflict) =>
  call('/rest/v1/' + table + (onConflict ? '?on_conflict=' + onConflict : ''), {
    method: 'POST', body: JSON.stringify(row),
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
  });

const TEACHER = '33333333-3333-3333-3333-333333333333';   // Иванова Мария Петровна
const ORG = '11111111-1111-1111-1111-111111111111';
const PASS = 'Doska123!';
const GROUP = 'Проверка доски';

const CAST = [
  { email: 'st1@mcko.test',      role: 'student', name: 'Ученик Первый',
    of: TEACHER, why: 'обычный ученик основного учителя' },
  { email: 'st2@mcko.test',      role: 'student', name: 'Ученик Второй',
    of: TEACHER, why: 'второй ученик — доска на двоих и группы' },
  { email: 'st3@mcko.test',      role: 'student', name: 'Ученик Третий',
    of: TEACHER, why: 'третий — чтобы группа была не из двух человек' },
  { email: 'teacher2@mcko.test', role: 'teacher', name: 'Петров Иван Сергеевич',
    why: 'чужой учитель: его учеников и досок основной видеть не должен' },
  { email: 'st4@mcko.test',      role: 'student', name: 'Ученик Чужой',
    ofEmail: 'teacher2@mcko.test', why: 'ученик чужого учителя — его не должно быть в списках' },
];

(async () => {
  const ids = new Map();

  /* ── учётные записи ───────────────────────────────────── */
  const list = await call('/auth/v1/admin/users?per_page=1000');
  const byEmail = new Map((list.users || []).map(u => [u.email, u]));

  for (const p of CAST) {
    let user = byEmail.get(p.email);
    if (user) {
      await call('/auth/v1/admin/users/' + user.id, {
        method: 'PUT', body: JSON.stringify({ password: PASS, email_confirm: true }) });
      console.log('пароль обновлён: ' + p.email);
    } else {
      user = await call('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: p.email, password: PASS, email_confirm: true }) });
      console.log('заведён: ' + p.email);
    }
    ids.set(p.email, user.id);

    // Профиль заводит триггер на регистрации, но роль и организацию он берёт
    // по умолчанию — проставляем то, что нужно для проверок.
    await upsert('profiles', { id: user.id, email: p.email, role: p.role,
                               full_name: p.name, organization_id: ORG, is_active: true }, 'id');
  }

  /* ── кто чей ученик ───────────────────────────────────── */
  for (const p of CAST) {
    if (p.role !== 'student') continue;
    const teacherId = p.ofEmail ? ids.get(p.ofEmail) : p.of;
    if (!teacherId) continue;
    await upsert('teacher_students',
      { teacher_id: teacherId, student_id: ids.get(p.email), assigned_by: teacherId },
      'teacher_id,student_id');
  }

  /* ── группа основного учителя ─────────────────────────── */
  const found = await call('/rest/v1/groups?select=id&name=eq.' +
    encodeURIComponent(GROUP) + '&created_by=eq.' + TEACHER + '&limit=1');
  let groupId = found[0] && found[0].id;
  if (!groupId) {
    const made = await call('/rest/v1/groups', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ name: GROUP, organization_id: ORG, created_by: TEACHER,
                             description: 'Для проверки досок на группу' }) });
    groupId = made[0].id;
    console.log('заведена группа «' + GROUP + '»');
  }
  for (const email of ['st1@mcko.test', 'st2@mcko.test', 'st3@mcko.test']) {
    if (!ids.get(email)) continue;
    await upsert('group_members', { group_id: groupId, user_id: ids.get(email) },
                 'group_id,user_id');
  }

  /* ── что получилось ───────────────────────────────────── */
  console.log('\nСостав для проверок (пароль у новых записей «' + PASS + '»):\n');
  console.log('  teacher@mcko.test    — основной учитель, у него все доски');
  for (const p of CAST) console.log('  ' + p.email.padEnd(21) + '— ' + p.why);
  console.log('  admin@mcko.test      — администратор');
  console.log('\nГруппа «' + GROUP + '» — трое учеников основного учителя.');
  console.log('Пароли основного учителя и администратора скрипт не меняет.');
})().catch(e => { console.error('сорвалось:', e.message); process.exit(1); });
