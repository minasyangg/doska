#!/bin/bash
# ============================================================
# Ежевечерний отчёт о занятиях — запускает сервер, а не расписание GitHub.
#
# cron на сервере (/etc/cron.d/doska-day-report) в 23:30 зовёт этот скрипт,
# он просит GitHub запустить workflow «Отчёт о занятиях в Telegram» за
# сегодняшнюю дату. Дальше всё как при ручном запуске: GitHub заходит
# сюда ограниченным ключом за текстом (scripts/day-report.js) и шлёт его
# боту.
#
# Почему не напрямую в Telegram: с сервера api.telegram.org не открывается.
# Почему не расписанием GitHub: оно «по возможности» — дважды подряд
# запуск просто не случился, и GitHub в документации прямо это допускает.
#
# Дату передаём явно: если GitHub выполнит запуск уже после полуночи,
# отчёт всё равно будет за тот день, ради которого его просили.
#
# Принятый запрос ещё не значит отправленный отчёт. 11.11.2026 GitHub
# ответил «принято», а запуск через семь минут кончился startup_failure, так
# и не начавшись, — и сообщить «отчёт не собрался» было некому: это делает
# сам запуск. Поэтому скрипт дожидается, чем кончился запуск, и при неудаче
# повторяет его, до пяти раз с растущей паузой, чтобы пересидеть сбой GitHub.
# Запуск, который за отведённое время так и не завершился, перед повтором
# отменяется: иначе он мог бы ещё пройти, и отчёт пришёл бы дважды.
#
# Вручную за прошлый день: send-day-report.sh 2026-11-11
#
# Токен — fine-grained, только репозиторий doska, право Actions: write.
# Лежит в /etc/doska/github-token (600, root), в git не попадает.
# ============================================================
set -uo pipefail

TOKEN_FILE=${DOSKA_GH_TOKEN_FILE:-/etc/doska/github-token}
API=${DOSKA_GH_API:-https://api.github.com/repos/minasyangg/doska}
WF=$API/actions/workflows/day-report.yml
# Интервалы в секундах; меняются окружением только для проверки скрипта
POLL=${DOSKA_REPORT_POLL:-20}        # как часто спрашивать о запуске
APPEAR=${DOSKA_REPORT_APPEAR:-300}   # не появился за это время — не появится
FINISH=${DOSKA_REPORT_FINISH:-1200}  # отчёт идёт секунды; дольше — завис
PAUSE=${DOSKA_REPORT_PAUSE:-600}     # пауза перед повтором: 10, 20, 30, 40 минут
ATTEMPTS=5
DAY=${1:-$(date +%F)}
log() { echo "$(date '+%F %T') $*"; }

if ! [[ $DAY =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then log "не дата: $DAY"; exit 1; fi
if [ ! -r "$TOKEN_FILE" ]; then log "нет токена в $TOKEN_FILE"; exit 1; fi
TOKEN=$(tr -d ' \r\n' < "$TOKEN_FILE")
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

# токен — через конфиг на stdin, а не аргументом: так его не видно в ps
gh() {
  curl -sS -m 30 -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
       -K - "$@" <<< "header = \"Authorization: Bearer $TOKEN\""
}

# 0 — запрос принят, 1 — не приняли и после повторов, 2 — повторять бессмысленно
dispatch() {
  local code try
  # GitHub изредка отвечает ошибкой — пробуем несколько раз с паузой
  for try in 1 2 3 4 5; do
    code=$(gh -o "$BODY" -w '%{http_code}' -X POST "$WF/dispatches" \
              -d "{\"ref\":\"main\",\"inputs\":{\"day\":\"$DAY\"}}")
    [ "$code" = 204 ] && return 0
    log "запрос $try: HTTP $code $(head -c 300 "$BODY" | tr '\n' ' ')"
    # 401/403/404/422 — токен истёк, отозван или без нужного права
    case "$code" in 401|403|404|422) return 2;; esac
    sleep 60
  done
  return 1
}

# Наш запуск — самый свежий из запущенных вручную не раньше момента запроса;
# полминуты запаса — на расхождение часов с GitHub. Печатает «id статус итог».
run_of() {
  gh "$WF/runs?event=workflow_dispatch&per_page=5" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      let runs = [];
      try { runs = JSON.parse(s).workflow_runs || []; } catch {}
      const r = runs.find(r => Date.parse(r.created_at) / 1000 >= +process.argv[1] - 30);
      if (r) console.log(r.id, r.status, r.conclusion || "-");
    });' "$1"
}

# Чем кончился запуск: success, startup_failure, failure… А также none — так и
# не появился, и timeout — не завершился вовремя, тогда он отменяется.
outcome() {
  local since=$1 waited=0 id= status= result=
  while [ "$waited" -lt "$FINISH" ]; do
    sleep "$POLL"; waited=$((waited + POLL))
    read -r id status result <<< "$(run_of "$since")"
    if [ -z "$id" ]; then
      [ "$waited" -ge "$APPEAR" ] && { echo none; return; }
      continue
    fi
    [ "$status" = completed ] && { echo "$result"; return; }
  done
  [ -n "$id" ] && gh -o /dev/null -X POST "$API/actions/runs/$id/cancel"
  echo timeout
}

for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  since=$(date +%s)
  dispatch; rc=$?
  [ "$rc" = 2 ] && exit 1
  if [ "$rc" = 0 ]; then
    log "отчёт за $DAY запрошен"
    result=$(outcome "$since")
    if [ "$result" = success ]; then log "отчёт за $DAY отправлен"; exit 0; fi
    log "отчёт за $DAY: запуск на GitHub кончился «$result», попытка $attempt из $ATTEMPTS"
  fi
  [ "$attempt" -lt "$ATTEMPTS" ] && sleep $((PAUSE * attempt))
done
log "отчёт за $DAY так и не отправлен"
exit 1
