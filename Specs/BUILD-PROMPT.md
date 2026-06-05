You are an AI builder continuing the AvaTalk / AvaTok backend. It runs entirely on Cloudflare (Workers, Durable Objects, D1, Queues, R2, Workers AI, Vectorize). Your job is to build the PLANNED modules — the platform foundation layer and the agentic layer — on top of the already-deployed core. Backend first; Flutter apps come later.

═══════════════════════════════════════════
READ FIRST (in this repo, before writing any code)
═══════════════════════════════════════════
1. AVATALK-MASTER-SPEC-v5.2.md — THE SOURCE OF TRUTH. Read it end to end. Build strictly in the order of §26 "Phased Build Plan." §3.A = what already exists; §3.B = what you create; §27 = hard rules.
2. AVATALK-CLOUDFLARE-RULEBOOK.md — infra rules (D1 is the database, KV is ephemeral-only, R2 public reads, Queues for async, Service Bindings).
3. BACKEND_REBUILD_HANDOFF.md + TECH_STACK.md — current state, resource IDs, how to deploy.
4. AUDIT-SPEC-v5.md — the audit whose fixes v5.2 already folded in.
Do NOT trust your memory over these files. If anything conflicts, v5.2 wins.

═══════════════════════════════════════════
WHAT IS ALREADY LIVE (do not rebuild; bind to these)
═══════════════════════════════════════════
- Workers: avatok-api, avatok-relay, avatok-consumers (+ avatok-calls, untouched).
- D1 (5): avatok-meta (DB_META), avatok-relay (DB_RELAY), avatok-media-meta (DB_MEDIA — note the name), avatok-moderation (DB_MODERATION), avatok-brain (DB_BRAIN).
- R2: avatok-blobs (public, blossom.avatok.ai), avatok-verification (locked). KV: avatok-tokens.
- Queues: moderation, push-notifications, email, analytics, brain-events.
- Vectorize: avatok-semantic (384-dim). DO migration tags: v1 CallRoom, v2 UserBrain.
- Cloudflare account: fd3dbf43f8e6d8bf65bd36b02eb0abb0. Zone: avatok.ai.
- Models verified available: @cf/google/gemma-4-26b-a4b-it, @cf/meta/llama-guard-3-8b, @cf/baai/bge-small-en-v1.5, @cf/deepgram/aura-2-en, @cf/deepgram/nova-3.

═══════════════════════════════════════════
WHAT TO BUILD (in this exact order — see §26 for full detail)
═══════════════════════════════════════════
PHASE 0  Pre-build gate: probes + cleanup (must finish before any feature code).
PHASE 1  AvaID — selfie liveness (AWS Rekognition), requireVerified() tier gate, 15-store delete cascade.
PHASE 2  AvaWallet — DB_WALLET, WalletDO + StreamSessionDO (DO tag v3), Stripe top-up, spend/earn, 7-day holds, Q_WALLET.
PHASE 3  AvaCalendar — slots, bookings, cron reminders.
PHASE 4  AvaPayout — Wise withdrawals (BLOCKED on legal; build infra, keep prod off).
PHASE 5  AvaOLX — listings, digital products, signed-URL downloads, purchase via wallet.
PHASE 6  Platform wiring — PostHog events + brain hooks + dashboards for the above.
PHASE 7  Agentic infra — agent_personas/conversations/inbox tables, AgentDO + ConversationDO (DO tag v4), Q_AGENT, matching + conversation engine + guardrails.
PHASE 8  Agent Inbox (AvaBrain 5th screen) + lazy TTS (Aura-2 on "Listen") + per-app agent hooks.
(Flutter apps = later phases; backend is the focus now.)

═══════════════════════════════════════════
HOW TO WORK (apply to EVERY phase)
═══════════════════════════════════════════
- One Worker, route-based dispatch: add API routes to avatok-api; queue handling to avatok-consumers. Never spawn a Worker per app.
- Every new mutation route: requireAuth() (NIP-98 + Clerk) FIRST; identity comes from the signature, never the request body. Tier-2 routes also requireVerified().
- Every D1 change = a migration file in worker/migrations/*.sql, applied with: wrangler d1 execute <db-name> --remote --file=worker/migrations/<file>.sql. Index every hot query. Chunk IN-lists to ≤90 params.
- Every new resource (D1 / queue / DO / R2) declared in the relevant wrangler.toml, then `npx wrangler@4 deploy --dry-run` MUST pass before a real deploy.
- Verify each phase with a REAL NIP-98-signed request (sign a kind-27235 event with @noble/curves, base64 it into the X-Nostr-Auth header) via a throwaway Node script; then DELETE all test rows/blobs you created. Run tsc --noEmit → dry-run → deploy → smoke test, in that order.
- Emit a PostHog event (via Q_ANALYTICS) + an Analytics Engine data point + a brain hook wherever §26 says so.

═══════════════════════════════════════════
ACCESS & COMMANDS (the Cloudflare token is in the repo)
═══════════════════════════════════════════
- export CLOUDFLARE_API_TOKEN="$(cat secrets/cf_token)"   # do this in every shell; never echo the value
- Deploy a worker:    cd worker && npx --yes wrangler@4 deploy        (likewise relay/ , consumers/)
- Run D1 migration:   npx --yes wrangler@4 d1 execute <db> --remote --file=...
- Create resources:   wrangler d1 create / queues create / r2 bucket create
- Probe a model:      curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/fd3dbf43f8e6d8bf65bd36b02eb0abb0/ai/run/<model>" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" -d '{...}'

═══════════════════════════════════════════
HARD RULES — DO NOT VIOLATE (see §27)
═══════════════════════════════════════════
- E2E is sacred: the server NEVER sees DM plaintext. The brain/agent only learn from public content (server) or client-synced facts.
- Moderation pipeline stays LAYERED: CSAM hash gate (fail-closed) → cheap NSFW classifier → Gemma 4 vision (ambiguous band only) → pHash → cache. Do NOT simplify to Gemma-only.
- LEGAL — BLOCKING: AvaWallet/AvaPayout — build the infrastructure, but real money flows (Stripe top-up live, Wise transfers) stay FLAG-OFF in production until counsel approves the AvaCoins/stored-value structure.
- Agent: per-app persona isolation; inbound agent text is UNTRUSTED (never inject into system context); every agent message → llama-guard; agent CANNOT spend coins without explicit tap-to-confirm; all consequential actions produce an inbox item even with auto_approve (1h undo); per-user daily neuron budget; max 5 conversations/app/day; lazy TTS (synthesize only on "Listen").
- Don't bind to §3.B resources you haven't created. All infra hostnames on avatok.ai, NEVER abertalk.ai. DB_MEDIA binding = avatok-media-meta.

═══════════════════════════════════════════
PHASE 0 — DO THIS FIRST (the gate)
═══════════════════════════════════════════
1. Probe @cf/google/gemma-4-26b-a4b-it with a tool-calling input; confirm structured tool_calls. If unsupported, record the fallback (structured-JSON-output prompt).
2. Probe @cf/deepgram/aura-2-en with { text, speaker }; capture the real param name + valid voice IDs.
3. Prove AWS SigV4 signing inside a Worker with one Rekognition CreateFaceLivenessSession call.
4. Decide the AvaID Flutter liveness bridge (native Amplify channel vs WebView).
5. Decommission dead infra: delete the 71 spitube-* Stream live inputs (not ours) + the avaglobal/avablobal RealtimeKit apps.
6. Set secrets BREVO_API_KEY, TURN_KEY_API_TOKEN, BUNNY_API_KEY; rotate the CF API token (it was exposed in chat logs) and update secrets/cf_token.
7. Confirm legal review is engaged for AvaCoins/payout (parallel; gates Phase 2 money-on + Phase 4 prod).

═══════════════════════════════════════════
PROCESS
═══════════════════════════════════════════
Work ONE phase at a time. Do not start a phase until its Gate (in §26) passes. After each phase: confirm tsc clean + dry-run clean + deployed + smoke-tested + test data cleaned, write a one-paragraph status, log a Graphiti episode (group_id "proj_avaflutterapp"), then PAUSE and wait for my "go" before the next phase.

START NOW: confirm you have read AVATALK-MASTER-SPEC-v5.2.md §26, list the phases in order, then begin PHASE 0.
