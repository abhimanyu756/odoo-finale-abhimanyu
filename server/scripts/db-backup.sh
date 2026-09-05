#!/usr/bin/env bash
# Snapshot the demo database. Run this before any risky demo step.
#   npm run db:backup            -> backups/<timestamp>.dump
#   npm run db:backup -- golden  -> backups/golden.dump
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
mkdir -p backups
NAME="${1:-$(date +%Y%m%d-%H%M%S)}"
# Prisma's ?schema=public is not a libpq parameter; pg_dump rejects it.
PG_URL="${DATABASE_URL%%\?*}"
pg_dump "$PG_URL" -Fc -f "backups/$NAME.dump"
echo "Wrote backups/$NAME.dump ($(du -h "backups/$NAME.dump" | cut -f1))"
