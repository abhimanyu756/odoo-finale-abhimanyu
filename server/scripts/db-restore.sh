#!/usr/bin/env bash
# Restore a snapshot, replacing everything currently in the database.
#   npm run db:restore -- golden   (or a path, or omit for the newest dump)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

ARG="${1:-}"
if [ -z "$ARG" ]; then
  FILE=$(ls -t backups/*.dump | head -1)
elif [ -f "$ARG" ]; then
  FILE="$ARG"
else
  FILE="backups/$ARG.dump"
fi
[ -f "$FILE" ] || { echo "No such dump: $FILE"; exit 1; }

read -rp "Replace ALL data in $DB_DATABASE with $FILE? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted."; exit 1; }

PG_URL="${DATABASE_URL%%\?*}"
pg_restore --clean --if-exists --no-owner --no-privileges -d "$PG_URL" "$FILE"
echo "Restored from $FILE"
