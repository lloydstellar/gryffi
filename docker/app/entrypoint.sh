#!/bin/sh
# Gryffi Community Edition entrypoint
#
# Before the app starts: wait for the database, create the database roles the
# app uses (idempotent) and run the migrations. An update is therefore just a
# new image: the next start brings the database up to date.
set -eu

if [ -z "${MIGRATION_DATABASE_URL:-}" ] || [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "[gryffi] MIGRATION_DATABASE_URL and APP_DB_PASSWORD must be set (see .env)." >&2
  exit 1
fi

echo "[gryffi] Waiting for the database..."
tries=0
until pg_isready -q -d "$MIGRATION_DATABASE_URL"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "[gryffi] The database did not answer within 2 minutes." >&2
    exit 1
  fi
  sleep 2
done

echo "[gryffi] Preparing database roles..."
psql -q -X -d "$MIGRATION_DATABASE_URL" -f /app/db-roles/create-rls-role.sql > /dev/null
psql -q -X -d "$MIGRATION_DATABASE_URL" -v app_pw="$APP_DB_PASSWORD" -f /app/db-roles/create-app-runtime-role.sql > /dev/null

echo "[gryffi] Running database migrations..."
node src/db/migrate.js

exec "$@"
