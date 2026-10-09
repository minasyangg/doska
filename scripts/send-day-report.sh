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
# Токен — fine-grained, только репозиторий doska, право Actions: write.
# Лежит в /etc/doska/github-token (600, root), в git не попадает.
# ============================================================
set -uo pipefail

TOKEN_FILE=${DOSKA_GH_TOKEN_FILE:-/etc/doska/github-token}
URL=https://api.github.com/repos/minasyangg/doska/actions/workflows/day-report.yml/dispatches
DAY=$(date +%F)
log() { echo "$(date '+%F %T') $*"; }

if [ ! -r "$TOKEN_FILE" ]; then log "нет токена в $TOKEN_FILE"; exit 1; fi
TOKEN=$(tr -d ' \r\n' < "$TOKEN_FILE")
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

# GitHub изредка отвечает ошибкой — пробуем несколько раз с паузой
for attempt in 1 2 3 4 5; do
  # токен — через конфиг на stdin, а не аргументом: так его не видно в ps
  code=$(curl -sS -m 30 -o "$BODY" -w '%{http_code}' -X POST "$URL" \
           -H 'Accept: application/vnd.github+json' \
           -H 'X-GitHub-Api-Version: 2022-11-28' \
           -d "{\"ref\":\"main\",\"inputs\":{\"day\":\"$DAY\"}}" \
           -K - <<< "header = \"Authorization: Bearer $TOKEN\"")
  if [ "$code" = 204 ]; then log "отчёт за $DAY запрошен"; exit 0; fi
  log "попытка $attempt: HTTP $code $(head -c 300 "$BODY" | tr '\n' ' ')"
  # 401/403/404 — токен истёк, отозван или без нужного права: повтор не поможет
  case "$code" in 401|403|404|422) exit 1;; esac
  sleep 60
done
exit 1
