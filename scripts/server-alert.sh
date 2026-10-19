#!/bin/bash
# ============================================================
# Сторож нагрузки сервера доски — cron раз в минуту.
#
# Одно ядро и 1 ГБ памяти делят две службы: сама доска (pm2-root) и Caddy,
# через который идут и доска, и обратный прокси сайта mcko.tutpad.ru
# (docs/ru-proxy.md в репозитории mcko-app). У доски приоритет по
# процессору (CPUWeight=200 у pm2-root, у Caddy 100), но если процессор
# или память кончаются, об этом надо узнать сразу, а не от учеников.
#
# Тревога — когда SUSTAIN минут подряд:
#   - процессор занят больше чем на CPU_BUSY_MAX %, или
#   - процессы ждут своей очереди к процессору дольше CPU_WAIT_MAX %
#     времени (PSI, /proc/pressure/cpu) — это и есть «толкаются», или
#   - свободной памяти меньше MEM_MIN_MB.
# Пока перегрузка длится — напоминание раз в REMIND_MIN минут; когда
# SUSTAIN минут подряд всё в норме — сообщение «отбой». В сообщении видно,
# кто ест процессор: доска, Caddy или остальное (Grafana, Prometheus…).
#
# Сообщение уходит в Telegram через GitHub (workflow server-alert.yml) —
# тем же путём и тем же токеном, что отчёт о занятиях (send-day-report.sh):
# с сервера Telegram не открывается.
#
# cron: /etc/cron.d/server-load-alert
#   * * * * * root /bin/bash /var/www/doska/scripts/server-alert.sh >> /var/log/doska/server-alert.log 2>&1
# В журнал пишутся только отправки и ошибки, не каждая минута.
#
# Ручной запуск: --dry — показать текущие замеры, --test — прислать
# проверочное сообщение (цепочка сервер → GitHub → Telegram).
# ============================================================
set -uo pipefail

CPU_BUSY_MAX=${CPU_BUSY_MAX:-85}
CPU_WAIT_MAX=${CPU_WAIT_MAX:-30}
MEM_MIN_MB=${MEM_MIN_MB:-150}
SUSTAIN=${SUSTAIN:-3}
REMIND_MIN=${REMIND_MIN:-60}

STATE_DIR=/var/lib/server-alert
STATE=$STATE_DIR/state
TOKEN_FILE=${DOSKA_GH_TOKEN_FILE:-/etc/doska/github-token}
URL=https://api.github.com/repos/minasyangg/doska/actions/workflows/server-alert.yml/dispatches
CG=/sys/fs/cgroup/system.slice

log() { echo "$(date '+%F %T') $*"; }

mkdir -p "$STATE_DIR"
# два запуска не должны писать состояние одновременно
exec 9>"$STATE_DIR/lock"
flock -n 9 || exit 0

# --- замеры ---
now=$(date +%s)
read -r _ u n s idle iow irq sirq steal _ < /proc/stat
total=$((u + n + s + idle + iow + irq + sirq + steal))
idle_all=$((idle + iow))
cpu_wait=$(awk '/^some/ { sub("avg60=", "", $3); printf "%d", $3 + 0.5 }' /proc/pressure/cpu)
mem_avail=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)
swap_used=$(awk '/^SwapTotal:/ { t = $2 } /^SwapFree:/ { f = $2 } END { printf "%d", (t - f) / 1024 }' /proc/meminfo)
usage_us() { awk '/^usage_usec/ { print $2 }' "$CG/$1/cpu.stat" 2>/dev/null || echo 0; }
doska_us=$(usage_us pm2-root.service)
caddy_us=$(usage_us caddy.service)

PREV_TS=0 PREV_TOTAL=0 PREV_IDLE=0 PREV_DOSKA=0 PREV_CADDY=0
BAD=0 GOOD=0 ACTIVE=0 SINCE=0 LAST_SENT=0
[ -r "$STATE" ] && . "$STATE"

# Проценты — за время с прошлого запуска (обычно минута). Первый запуск
# сравнивать не с чем: только запоминаем точку отсчёта.
dt_total=$((total - PREV_TOTAL))
dt_us=$(( (now - PREV_TS) * 1000000 ))
cpu_busy=0 doska_pct=0 caddy_pct=0
if [ "$PREV_TS" -gt 0 ] && [ "$dt_total" -gt 0 ] && [ "$dt_us" -gt 0 ]; then
  cpu_busy=$(( 100 * (dt_total - (idle_all - PREV_IDLE)) / dt_total ))
  doska_pct=$(( 100 * (doska_us - PREV_DOSKA) / dt_us ))
  caddy_pct=$(( 100 * (caddy_us - PREV_CADDY) / dt_us ))
  # после перезапуска службы её счётчик начинается с нуля
  [ "$doska_pct" -lt 0 ] && doska_pct=0
  [ "$caddy_pct" -lt 0 ] && caddy_pct=0
fi
other_pct=$((cpu_busy - doska_pct - caddy_pct))
[ "$other_pct" -lt 0 ] && other_pct=0

details() {
  printf 'Процессор: занят %s%%, процессы ждали очереди %s%% времени\n' "$cpu_busy" "$cpu_wait"
  printf 'Доска: %s%% · Caddy (доска + прокси mcko.tutpad.ru): %s%% · остальное: %s%%\n' \
    "$doska_pct" "$caddy_pct" "$other_pct"
  printf 'Память: свободно %s МБ, в swap %s МБ' "$mem_avail" "$swap_used"
}

send() {
  local text=$1 body code
  if [ ! -r "$TOKEN_FILE" ]; then log "нет токена в $TOKEN_FILE"; return 1; fi
  body=$(jq -cn --arg t "$text" '{ref: "main", inputs: {text: $t}}')
  # токен — через конфиг на stdin, а не аргументом: так его не видно в ps
  code=$(curl -sS -m 20 -o "$STATE_DIR/last-response" -w '%{http_code}' -X POST "$URL" \
           -H 'Accept: application/vnd.github+json' \
           -H 'X-GitHub-Api-Version: 2022-11-28' \
           -d "$body" \
           -K - <<< "header = \"Authorization: Bearer $(tr -d ' \r\n' < "$TOKEN_FILE")\"")
  if [ "$code" = 204 ]; then log "отправлено: ${text%%$'\n'*}"; return 0; fi
  log "не отправлено, HTTP $code $(head -c 300 "$STATE_DIR/last-response" | tr '\n' ' ')"
  return 1
}

case "${1:-}" in
  --dry) details; echo; exit 0 ;;
  --test) send "🔔 Проверка: тревоги о нагрузке сервера доски подключены.
$(details)"; exit $? ;;
esac

reasons=()
[ "$cpu_busy" -ge "$CPU_BUSY_MAX" ] && reasons+=("процессор занят на ${cpu_busy}%")
[ "$cpu_wait" -ge "$CPU_WAIT_MAX" ] && reasons+=("процессы ждут процессор ${cpu_wait}% времени")
[ "$mem_avail" -lt "$MEM_MIN_MB" ] && reasons+=("свободно всего ${mem_avail} МБ памяти")
if [ "${#reasons[@]}" -gt 0 ]; then BAD=$((BAD + 1)); GOOD=0; else GOOD=$((GOOD + 1)); BAD=0; fi
why=$(IFS=';'; echo "${reasons[*]:-}" | sed 's/;/, /g')

if [ "$ACTIVE" = 0 ] && [ "$BAD" -ge "$SUSTAIN" ]; then
  # не ушло — повторим через минуту: BAD продолжает расти
  if send "⚠️ Сервер доски на пределе уже ${BAD} мин: ${why}.
$(details)"; then
    ACTIVE=1 SINCE=$((now - BAD * 60)) LAST_SENT=$now
  fi
elif [ "$ACTIVE" = 1 ] && [ "$BAD" -gt 0 ] && [ $((now - LAST_SENT)) -ge $((REMIND_MIN * 60)) ]; then
  send "⚠️ Сервер доски всё ещё на пределе ($(( (now - SINCE) / 60 )) мин): ${why}.
$(details)" && LAST_SENT=$now
elif [ "$ACTIVE" = 1 ] && [ "$GOOD" -ge "$SUSTAIN" ]; then
  if send "✅ Нагрузка на сервере доски снова в норме, перегрузка длилась около $(( (now - SINCE) / 60 )) мин.
$(details)"; then
    ACTIVE=0 LAST_SENT=$now
  fi
fi

cat > "$STATE.tmp" <<EOF
PREV_TS=$now
PREV_TOTAL=$total
PREV_IDLE=$idle_all
PREV_DOSKA=$doska_us
PREV_CADDY=$caddy_us
BAD=$BAD
GOOD=$GOOD
ACTIVE=$ACTIVE
SINCE=$SINCE
LAST_SENT=$LAST_SENT
EOF
mv "$STATE.tmp" "$STATE"
