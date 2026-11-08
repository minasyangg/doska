#!/bin/bash
# Резервная копия содержимого досок: раз в сутки по cron, архив на дату.
#
# Что внутри: доски, картинки и корзина. Сессии не берём: это зашифрованные
# ключи от учётных записей, а потерять их не страшно, люди просто войдут заново.
#
# Копия лежит на том же диске, поэтому спасает от ошибки, порчи данных и
# неудачной выкладки, но не от потери самого сервера. Для этого архивы нужно
# ещё увозить на другую машину.
set -euo pipefail

SRC="${DATA_DIR:-/var/www/doska/data}"
DEST="${BACKUP_DIR:-/var/backups/doska}"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$DEST"
chmod 700 "$DEST"

STAMP=$(date +%F)
TMP="$DEST/.doska-$STAMP.tar.gz.tmp"
trap 'rm -f "$TMP"' EXIT

# Код 1 у tar значит «файл менялся, пока читали»: журнал занятия и правда может
# дописываться. Строки в нём самодостаточны, такая копия годится.
rc=0
tar -C "$SRC" --exclude=./sessions --warning=no-file-changed -czf "$TMP" . || rc=$?
if [ "$rc" -gt 1 ]; then
  echo "backup: tar завершился с кодом $rc" >&2
  exit "$rc"
fi

# Архив, который нельзя прочитать, хуже отсутствующего: на него будут надеяться.
tar -tzf "$TMP" > /dev/null
mv "$TMP" "$DEST/doska-$STAMP.tar.gz"

ls -1t "$DEST"/doska-*.tar.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup: $DEST/doska-$STAMP.tar.gz, $(du -h "$DEST/doska-$STAMP.tar.gz" | cut -f1)"
