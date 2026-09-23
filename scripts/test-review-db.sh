#!/usr/bin/env bash
set -euo pipefail
# Isolated PostgreSQL only. Never connects to Supabase or the production database.
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d /tmp/ppa-review.XXXXXX)"
"$PG_BIN/initdb" -D "$test_dir/data" -A trust -U postgres > "$test_dir/init.log"
trap '"$PG_BIN/pg_ctl" -D "$test_dir/data" -m fast stop >/dev/null 2>&1 || true' EXIT
"$PG_BIN/pg_ctl" -D "$test_dir/data" -l "$test_dir/server.log" -o "-h '' -k $test_dir -p 55438" start >/dev/null
psql_cmd=("$PG_BIN/psql" -h "$test_dir" -p 55438 -U postgres -d postgres -X -v ON_ERROR_STOP=1)
"${psql_cmd[@]}" -f "$repo_dir/tests/sql/bootstrap.sql" > "$test_dir/migrations.log"
for migration in "$repo_dir"/supabase/migrations/*.sql; do
  "${psql_cmd[@]}" -f "$migration" >> "$test_dir/migrations.log"
done
"${psql_cmd[@]}" -f "$repo_dir/tests/sql/review_five_fixes.sql"
"${psql_cmd[@]}" -f "$repo_dir/tests/sql/queue_concurrency_setup.sql" >> "$test_dir/migrations.log"
# The first session keeps its row lock while the second attempts a claim.
"${psql_cmd[@]}" -f "$repo_dir/tests/sql/queue_concurrency_worker.sql" > "$test_dir/worker-a.log" &
worker_pid=$!
ready=false
for ((attempt=0; attempt<100; attempt++)); do
  if grep -q 'WORKER_A_CLAIMED' "$test_dir/worker-a.log"; then ready=true; break; fi
  sleep 0.02
done
if [[ "$ready" != true ]]; then echo 'Worker A did not acquire its claim'; exit 1; fi
claimed_b="$("${psql_cmd[@]}" -Atc 'select count(*) from claim_recompute_batch(20,300)')"
wait "$worker_pid"
[[ "$claimed_b" == 0 ]] || { echo "Duplicate concurrent claim: $claimed_b"; exit 1; }
[[ "$("${psql_cmd[@]}" -Atc "select count(*) from recompute_queue where status='processing'")" == 1 ]]
echo 'PASS: concurrent workers cannot claim the same product'
echo "Isolated DB checks passed. Logs: $test_dir"
