#!/usr/bin/env bash
#
# Runs the authorization boundary tests against a PostgreSQL database.
#
#   npm run test:rls                       # uses a local throwaway database
#   DATABASE_URL=postgres://… npm run test:rls
#
# With DATABASE_URL set, the suite runs against that database. It wraps
# everything in a transaction and rolls back, so it is safe against a
# development database — but never point it at production.
#
# Without DATABASE_URL, a scratch database is created locally and dropped
# afterwards. That needs a running PostgreSQL and a role that can create
# databases.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$ROOT/supabase/tests/00-bootstrap.sql"
TESTS="$ROOT/supabase/tests/rls.sql"

# Every migration, in order, so the suite tests the schema as deployed.
apply_migrations() {
  local target="$1"
  for migration in "$ROOT"/supabase/migrations/*.sql; do
    run_sql -d "$target" -f "$migration" >/dev/null
  done
}

run_sql() { psql -q -v ON_ERROR_STOP=1 "$@"; }

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "==> Using DATABASE_URL"
  run_sql -d "$DATABASE_URL" -f "$BOOTSTRAP" >/dev/null
  apply_migrations "$DATABASE_URL"
  psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f "$TESTS" 2>&1 |
    grep -E 'NOTICE|ERROR' | sed 's/.*NOTICE:  //; s/.*ERROR:  /ERROR: /'
  exit "${PIPESTATUS[0]}"
fi

DB="${FORGE_RLS_DB:-forge_rls_test}"
echo "==> Creating scratch database $DB"
dropdb --if-exists "$DB"
createdb "$DB"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT

run_sql -d "$DB" -f "$BOOTSTRAP" >/dev/null
apply_migrations "$DB"
echo "==> Running authorization tests"
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$TESTS" 2>&1 |
  grep -E 'NOTICE|ERROR' | sed 's/.*NOTICE:  //; s/.*ERROR:  /ERROR: /'
exit "${PIPESTATUS[0]}"
