# Load testing the InboxDO messaging path

`k6-inbox.js` drives the real client protocol (WSS connect → hello/sync → timed
sends → live-delivery latency on the peer's socket). Phase gates from
`Specs/SCALE-UPGRADE-PROPOSAL-1M-2026-06-10.md`:

- before marketing push: **10k concurrent sockets** green
- Phase 1 → 2 gate: **25k** green; Phase 2 → 3 gate: **100k**
- thresholds (baked into the script): delivery p99 < 1.5s, p75 < 400ms,
  first sync p95 < 2s, send failures < 1%

## 1. Generate test-user tokens

Every VU needs a Clerk JWT. Create N test users once (Clerk Backend API), then
mint session JWTs before each run (they expire) into `tokens.txt`, one
`uid:jwt` per line:

```bash
# create users (once): POST https://api.clerk.com/v1/users  (test+i@avatok.ai)
# per run: POST /v1/sign_in_tokens or actor tokens → exchange for session JWTs
node make-tokens.mjs --count 1000 > tokens.txt   # write this helper when first needed
```

Use a **staging/preview deployment** of `avatok-api` for big runs (same code,
separate DO namespace) so test inboxes never pollute production user data, and
ask Cloudflare support to raise the account's concurrent-DO/socket soft limits
if a 100k run is planned.

## 2. Run

```bash
brew install k6   # or: docker run -i grafana/k6
k6 run -e BASE=api.avatok.ai -e TOKENS_FILE=./tokens.txt \
       -e VUS=1000 -e DURATION=10m -e MSG_INTERVAL_S=15 k6-inbox.js
```

Scale VUS up in steps (100 → 1k → 10k). >10k VUs needs a beefy runner
(k6 ~1–2MB/VU → run distributed: `k6-operator` on k8s or several cloud VMs with
`--execution-segment`).

## 3. What to watch while it runs

- k6 thresholds (the run fails loudly if budgets are missed)
- Cloudflare dash → Workers → avatok-api: error rate, CPU time
- Analytics Engine `api` dataset: per-route latency (index.ts writes it)
- D1 avatok-meta: rows_read spike from `blockersOf`/`members` (should be flat —
  messaging hot path doesn't touch D1 per message except conv membership)
- Queues: push-notifications backlog (offline sends) should drain, not grow

## 4. Group fan-out test (after groups ship in volume)

Create one conversation with M members (conv create API), then have 1 VU send
into it while M sockets listen — verifies the >25-recipient Queues fan-out path
(`kind: "fanout"` in consumers) end-to-end.
