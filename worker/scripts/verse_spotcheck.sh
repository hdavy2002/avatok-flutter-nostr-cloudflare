#!/usr/bin/env bash
# Phase 8 acceptance — AvaVerse numbers reconcile with the wallet ledger +
# listings tables. Compares GET /api/verse/summary against raw D1 queries.
#
# Usage:
#   CF_TOKEN=$(cat secrets/cf_token) BEARER=<clerk-jwt> UID=<clerk-uid> \
#     ./scripts/verse_spotcheck.sh [staging|prod]
set -euo pipefail
ENV="${1:-staging}"
ACC="fd3dbf43f8e6d8bf65bd36b02eb0abb0"
if [ "$ENV" = "prod" ]; then
  HOST="https://api.avatok.ai"; META="c4ec8c0e-e1ac-4a1d-8e41-636f4007871b"; WALLET="63d7181c-0539-4ff2-8690-4ff9bb785457"
else
  HOST="https://api-staging.avatok.ai"; META="3866e75b-89ab-4325-bbfa-4bef61395107"; WALLET="371e6b93-dc1e-4d35-91f0-f0c7573f1fb0"
fi
: "${CF_TOKEN:?set CF_TOKEN}"; : "${BEARER:?set BEARER (Clerk JWT)}"; : "${UID:?set UID (creator uid)}"

d1() { # d1 <db-id> <sql>
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database/$1/query" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    --data "{\"sql\": $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$2")}" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"][0]["results"][0])'
}

echo "== /api/verse/summary (period=all) =="
SUMMARY=$(curl -s "$HOST/api/verse/summary?period=all&fresh=1" -H "Authorization: Bearer $BEARER")
echo "$SUMMARY" | python3 -m json.tool | head -25

echo "== raw: settled (ledger credits − fee debits) =="
d1 "$WALLET" "SELECT (SELECT COALESCE(SUM(amount),0) FROM wallet_ledger WHERE credit='user:$UID' AND type IN ('escrow_release','donation')) - (SELECT COALESCE(SUM(amount),0) FROM wallet_ledger WHERE debit='user:$UID' AND type='fee') AS settled"

echo "== raw: pending escrow gross (orders held) — summary shows ×0.8 =="
d1 "$META" "SELECT COALESCE(SUM(amount),0) AS held_gross FROM orders WHERE creator_id='$UID' AND status='held'"

echo "== raw: projection inputs (upcoming events) — summary shows joined×price×0.8 =="
d1 "$META" "SELECT COUNT(*) AS upcoming, COALESCE(SUM(joined_count*price),0) AS gross FROM listings WHERE creator_id='$UID' AND kind='live_event' AND status IN ('published','live') AND starts_at>CAST(strftime('%s','now') AS INTEGER)*1000"

echo "== raw: joins last 24h =="
d1 "$META" "SELECT COUNT(*) AS joins_24h FROM bookings WHERE creator_id='$UID' AND status IN ('confirmed','completed') AND created_at>(CAST(strftime('%s','now') AS INTEGER)-86400)*1000"

echo "Compare the raw values above with earnings.settled / earnings.pending_escrow_net(×0.8) / projections / momentum.joins_24h."
