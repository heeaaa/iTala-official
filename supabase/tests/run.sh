#!/usr/bin/env bash
#
# Applies every migration to a FRESH throwaway database and asserts the
# security and integrity behaviour we actually care about. Run it before
# pasting anything into a real project, and whenever a migration changes.
#
#   ./supabase/tests/run.sh
#
# Connects to a local Postgres as a superuser, creates a uniquely named
# scratch database, runs everything there, and drops it again. It never
# touches an existing database beyond creating and dropping its own.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PGHOST="${PGHOST:-/tmp}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER

DB="itala_verify_$$"
admin=(psql -q -v ON_ERROR_STOP=1 -d postgres)
run=(psql -q -v ON_ERROR_STOP=1 -d "$DB")

cleanup() { "${admin[@]}" -c "drop database if exists \"$DB\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Fresh database $DB"
"${admin[@]}" -c "create database \"$DB\""

echo "==> Supabase shim"
"${run[@]}" -f "$HERE/00_supabase_shim.sql" 2>&1 | grep -v 'wal_level' || true

echo "==> Migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  "${run[@]}" -f "$f" > /dev/null 2>&1
done

echo "==> Behaviour"
out="$("${run[@]}" -f "$HERE/10_behaviour.sql" 2>&1)"
echo "$out" | grep -oE '(PASS|FAIL): .*' || true

if echo "$out" | grep -q 'FAIL\|ERROR'; then
  echo "==> FAILED"
  echo "$out" | tail -30
  exit 1
fi

echo "==> $(echo "$out" | grep -c 'PASS:') assertions passed"
