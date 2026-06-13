# PHASE 6 — AvaAdmin: the platform Mission-Control dashboard. Runs in parallel.

> Carry `MASTER-PROMPT.md`. You build a **platform-wide admin console** ("AvaAdmin") — a bird's-eye
> view of users, money, operations, errors, and every live surface (AvaLive streaming, AvaConsult,
> AvaTalk conference, AvaVoice agents, AvaVision agents, Live Translation). It is **not** AvaVision-
> specific, but it ships in this wave because AvaVision adds a new surface that needs monitoring.
> You own a disjoint set of files; shared wiring goes to Phase Z via a glue note. **No commit.**

This phase is **additive and parallel-safe** like the others: new `admin_dashboard*` files that reuse
the existing admin gate (`requireAdmin`) and the existing money/insights endpoints. You do **not**
refactor the existing admin money console (`worker/src/routes/admin_money.ts`) — you read it as a
template and add aggregation + analytics + live-ops endpoints alongside it.

---

## 0. REALITY THIS PHASE IS BUILT ON (verified against the codebase 2026-06-13)

Build against what exists. Do **not** invent infra.

- **Admin gate already exists.** `worker/src/routes/admin_money.ts` exports `requireAdmin(req, env)`:
  it calls `requireUser`, then checks the caller's Clerk uid against `env.ADMIN_UIDS`
  (comma-separated list in `worker/wrangler.toml [vars]`). Reuse it verbatim — do not write a new gate.
- **Audit logging already exists.** `admin_audit` table in `DB_WALLET` (`id, admin_id, action, target,
  meta, created_at`), written by the local `audit(env, adminId, action, target, meta)` helper in
  `admin_money.ts`. **Every state-changing admin action you add MUST call an equivalent `audit(...)`.**
- **Money console endpoints already exist** (reuse, don't duplicate): `GET /api/admin/ledger`,
  `POST /api/admin/refund`, `POST /api/admin/adjust`, `GET /api/admin/account/:userId`,
  `POST /api/admin/escrow/{hold,release}`, `GET /api/admin/recon`, `GET /api/admin/tax-export`,
  `GET /api/admin/settlements`, `POST /api/admin/settlements/:id/retry`,
  `GET /api/admin/affiliates`, `POST /api/admin/affiliates/:uid/{suspend,unsuspend}`,
  `PUT /api/admin/config` (kill switches). Your dashboard **calls these**; it does not re-implement them.
- **Kill switches** live in `worker/src/routes/config.ts` (`PlatformConfig`) and are flipped via
  `PUT /api/admin/config`. Surface them in the dashboard, do not bypass them.
- **PostHog is wired.** Project `139917`, EU. `POSTHOG_PROJECT_ID` + `POSTHOG_QUERY_HOST`
  (`https://eu.posthog.com`) in `wrangler.toml [vars]`; the **query** API needs the secret
  `POSTHOG_PERSONAL_API_KEY` (gated — confirm it is set in prod; if unset, analytics cards degrade
  gracefully to "PostHog key not configured"). App ingestion key lives in `app/lib/core/analytics.dart`.
  **The PostHog personal key must NEVER reach the browser** — all PostHog queries go through the Worker.
- **Money model:** AvaCoins, integer, **1 coin = $0.01**. Ledger accounts: `user:<uid>`,
  `escrow:<orderId>`, `platform:fees`. Double-entry rows in `wallet_ledger` (`debit, credit, amount,
  type, ref, meta, created_at`). `wallet_accounts.balance` is the consumer-maintained live balance;
  `WalletDO` is the balance authority. AvaVoice/AvaVision creator split = 50/50 (`FEE_RATE=0.5`);
  general marketplace platform fee = 20% (`PLATFORM_FEE_RATE` in `ledger.ts`).
- **Live-ops surfaces to monitor** (route file → main table → status values):
  - AvaLive — `worker/src/routes/live.ts` → `live_sessions` (state `scheduled|live|ended`) + `StreamSessionDO`.
  - AvaConsult — `worker/src/routes/consult.ts` → `bookings` (kind `consult`, status `confirmed|completed|cancelled`) + `StreamSessionDO`.
  - AvaTalk Conference — `worker/src/routes/conference.ts` → `conversation_members`; live state is ephemeral in LiveKit (query the LiveKit server API for room/participant counts).
  - AvaVoice — `worker/src/routes/avavoice.ts` → `avavoice_sessions` (status `active|ended`, slot cap 10, D1 active-row count + 2-min stale sweep).
  - AvaVision — `worker/src/routes/avavision.ts` (Phase 1) → `avavision_sessions` (same model + `frames_streamed, snapshot_calls, avg_score, peak_score`).
  - Live Translation — `worker/src/routes/translate.ts` → ephemeral; bill via `/beat`.
- **Web client exists** (`web/`, Astro) with the web-client foundation (`apiClient`, `clerk.tsx` with
  `GuestGate`/`requireGuestAuth`, `zine` tokens, `Base.astro`, `Nav.astro`). Reuse it like Phases 4/5.
- **DOs that exist:** `CallRoom, UserBrain, WalletDO, StreamSessionDO, AGENT_DO, ConversationDO,
  InboxDO`. **Do NOT add a new DO** (it forces a `wrangler.toml` migration = forbidden mid-parallel-
  build). Live counts come from D1 queries + the LiveKit/Stream APIs + reading existing DO state via
  their existing endpoints — never a new DO.

---

## 1. PLATFORM DECISION (confirm in your glue note)

**Default: a web admin console at `avatok.ai/admin`** (server-rendered Astro shell + React islands,
gated by `requireGuestAuth()` **and** an admin-uid check), backed by **new Worker aggregation
endpoints** under `/api/admin/*`. Rationale: the data is dense and chart-heavy, PostHog embeds cleanly
on web, and the PostHog personal key stays server-side in the Worker. A thin Flutter entry can link out
to it later (the app already has `app/lib/core/admin_tools.dart` placeholders). If the owner wants the
console **inside the Flutter app instead**, stop and flag — that changes ownership and is a separate
build.

---

## 2. THE SEED ADMIN USER (security-critical — read carefully)

The owner wants an admin account seeded: **`hdavy2002@gmail.com`**.

**Do NOT commit the password to the repo, ever.** A plaintext credential in git is a security incident.
Instead, Phase Z performs the seed as an operational step:

1. Create/confirm the Clerk user `hdavy2002@gmail.com` in the Clerk dashboard (or via the Clerk Backend
   API with `CLERK_SECRET_KEY`), and set its password **there** (the owner-supplied password is entered
   directly into Clerk, not stored in any file).
2. Take the resulting **Clerk user id** (`user_...`) and **append it to `ADMIN_UIDS`** in
   `worker/wrangler.toml [vars]` (prod **and** staging), then redeploy. This is the only repo change.
3. Optionally insert a `users` row if one isn't auto-created on first sign-in.
4. Write an `admin_audit` row recording the grant (`action: "admin_granted"`).

The phase ships a small idempotent helper `worker/scripts/seed-admin.ts` (run manually by Phase Z with
the Clerk secret in the env, **not** committed with any secret inlined) that: looks up the user by
email via the Clerk API, prints the uid to paste into `ADMIN_UIDS`, and writes the audit row. It never
writes the password anywhere.

> Recommended hardening to note for the owner: keep `ADMIN_UIDS` short, require Clerk 2FA on every admin
> account, and consider a `role` column (`super | finance | analyst | readonly`) so analysts can view
> without holding refund/adjust power. A `role` model is **proposed** below as optional scope.

---

## 3. YOU OWN (create/edit ONLY these)

**Worker (backend aggregation + PostHog proxy):**
- `worker/src/routes/admin_dashboard.ts` — NEW. Read-mostly aggregation endpoints + the PostHog query
  proxy + live-ops snapshot. Reuses `requireAdmin` (import from `admin_money.ts`, read-only) and the
  existing DB/ledger helpers.
- `worker/scripts/seed-admin.ts` — NEW. The idempotent admin-seed helper (no secrets inlined).
- `worker/migrations/admin_dashboard.sql` — NEW, **required**. Creates the `admin_roles`,
  `admin_alerts`, and `admin_alert_rules` tables (§5.12/§5.14) in `DB_WALLET` (same DB as `admin_audit`,
  so the audit/roles/alerts data lives together). The migration tag + D1 apply instruction go in the
  glue note for Phase Z. Keep it additive (CREATE TABLE IF NOT EXISTS only — no ALTER of existing tables).

**Web (the console UI, inside the existing web client):**
- `web/src/pages/admin/index.astro` — Overview / bird's-eye (server shell + island)
- `web/src/pages/admin/live.astro` — Live operations feed
- `web/src/pages/admin/users.astro` — Users & accounts
- `web/src/pages/admin/money.astro` — Finance (ledger, payouts, recon, fees)
- `web/src/pages/admin/creators.astro` — Creators, listings, agents, moderation
- `web/src/pages/admin/analytics.astro` — PostHog-backed cards & funnels
- `web/src/pages/admin/system.astro` — Flags/kill switches, health, audit log
- `web/src/islands/admin/` — React islands: `OverviewCards.tsx`, `LiveFeed.tsx`, `UserSearch.tsx`,
  `LedgerExplorer.tsx`, `PayoutsQueue.tsx`, `ReconPanel.tsx`, `AgentsPanel.tsx`, `AnalyticsCards.tsx`,
  `FlagsPanel.tsx`, `AuditLog.tsx`, `AlertsInbox.tsx`, plus `adminApi.ts` (typed fetch wrapper for
  `/api/admin/*`, mirroring `lib/apiClient.ts`; do not edit the shared `apiClient.ts`).
- `Specs/avavision-build/glue/PHASE-6-GLUE.md` — your glue note.

**Do NOT touch:** `worker/src/index.ts`, `worker/src/routes/config.ts`, `worker/src/routes/admin_money.ts`,
`worker/wrangler.toml`, the web foundation (`web/src/lib/**`, `web/src/components/**`, `Nav.astro`,
`Base.astro`, configs, tokens). All edits to these go in the glue note for Phase Z.

---

## 4. DEPENDENCY / ORDERING

Requires the **web-client Phase 0 foundation** in `web/` (same as Phases 4 & 5). If absent, build the
Worker endpoints (§5) and the `adminApi.ts` first, stub the pages, and flag the block in your Graphiti
episode. The Worker side has **no dependency** on AvaVision Phase 1 except the AvaVision live-ops card,
which should **degrade gracefully** (show "AvaVision: not yet deployed") if `avavision_sessions` doesn't
exist yet — wrap that one query in a try/catch so the dashboard works before AvaVision ships.

---

## 5. THE FEATURE SET (this is the list to review — every item is a concrete, working feature)

> Owner: review/cut/extend this list; then this phase file gets updated to match. Each numbered block
> is a dashboard section; bullets are the working features inside it. "Card" = a live KPI tile,
> "Feed" = an auto-refreshing list, "Action" = a state-changing admin operation (audited).

### 5.1 Overview — the bird's-eye home (`/admin`)
- **Live KPI cards** (auto-refresh ~10s): active users now; active sessions split by surface (live
  streams / consults / conference rooms / voice calls / vision calls / translation); coins in escrow;
  platform fees today + MTD; GMV today; new signups today; global error rate (PostHog, last 1h); API
  p95 latency (PostHog/worker).
- **Revenue sparkline** (today vs yesterday vs 7-day) and **active-sessions sparkline**.
- **"Needs attention" strip**: failed settlements count, recon diffs, pending payouts, open moderation
  reports, CSAM hash hits (high-priority red), error spikes — each links to its section.
- **Surface health row**: one chip per surface (green/amber/red) from its kill-switch state + error rate.

### 5.2 Live Operations feed (`/admin/live`) — real-time
- **Live streams feed**: each active `live_sessions.state='live'` row → creator, title, viewer count
  (from `StreamSessionDO` state endpoint), donations this stream, elapsed. Action: open creator,
  **force-end stream** (calls existing `/api/live/:id/stop` as admin), **kill switch** the surface.
- **Active consults feed**: `bookings` (kind consult, in time window) → parties, mode (P2P/group),
  elapsed, price. Action: open, force-complete/cancel.
- **Conference rooms feed**: from the LiveKit server API → room, participant count (≤25 cap shown).
- **Voice/Vision agent calls feed**: active `avavoice_sessions` / `avavision_sessions` → agent, caller,
  minutes, $/min, model; for vision: live FormScore (avg), frames streamed, snapshots used. Action:
  open agent, end session.
- **Translation sessions**: active count + coins/hr.
- **Concurrency gauges**: per-agent slot utilization (X/10) for the busiest agents.

### 5.3 Users & accounts (`/admin/users`)
- **Search** by email / Clerk uid / npub / handle.
- **Profile panel**: balance, held coins, KYC/tax status (`payout_accounts`), identity-ladder level
  (L0–L3), strikes, parent/child account links (per the shared-phone account model), devices, signup
  date, last active (PostHog).
- **Their activity**: listings, agents, recent sessions, recent ledger rows (calls `/api/admin/account/:userId`).
- **Actions** (all audited): adjust balance, issue refund, suspend/unsuspend, reset password (Clerk),
  add strike, view-as (read-only support context). No "delete user" without a confirm + reason.
- **Cohorts**: link to PostHog cohort/segment for the selected user.

### 5.4 Money & finance (`/admin/money`)
- **Ledger explorer**: search `wallet_ledger` by user/ref/type/date; running balances; export CSV.
- **Platform fees**: accrued today/MTD/all-time (`credit='platform:fees'`); fee-by-surface breakdown.
- **Escrow**: outstanding holds, aging; spot-reconcile against `wallet_accounts`.
- **Payouts queue**: `payout_requests` by status (pending/completed/failed); **retry** failed; tax-export CSV by year.
- **Failed settlements (DLQ)**: `failed_settlements` list with error + payload; **retry** (existing endpoint).
- **Reconciliation**: `recon_runs` history; red banner on any nonzero diff; manual "run recon now"
  (calls `/api/admin/money/evaluate` / recon trigger).
- **Affiliate commissions**: per-order rows; affiliate leaderboard; suspend/unsuspend.
- **Revenue charts**: GMV, net revenue, fees over time, by surface, by creator tier.

### 5.5 Creators & marketplace (`/admin/creators`)
- **Top creators** by settled earnings (period selectable).
- **Listings overview** by kind (live/consult/voice/vision) and status; quick filters.
- **Agent performance**: AvaVoice + AvaVision agent stats (calls, revenue, avg/peak score, snapshot
  usage, missed-call rate) — aggregates the existing `/api/avavoice/agents/:id/stats` +
  `/api/avavision/agents/:id/stats`.
- **Verification queue**: identity-ladder upgrade requests.
- **Takedown actions** (audited): unpublish/suspend a listing or agent.

### 5.6 AI agents focus (Voice + Vision) — section within Creators or standalone tab
- Active/total agents per surface; concurrency utilization; **token/AI spend** (from `ai_spend.sql`
  table) by model and surface; Gemini model mix; snapshot count + estimated cost; token-mint failure
  rate (`avavoice_token_mint_failed` events); avg session length; top agents by revenue and by rating.

### 5.7 Errors & health (`/admin/system` → Health tab)
- **Error feed** (PostHog `apiError` + error-tracking events) grouped by endpoint/status, last 1h/24h,
  with trend; click → recent occurrences.
- **Latency**: p50/p95/p99 by endpoint.
- **Queue depths**: analytics queue, settlement queue, DLQ size.
- **Job status**: recon job, settlement engine pass, stale-session sweep — last run + result.
- **Infra usage**: D1 read/write, R2 storage, KV ops, DO counts (best-effort from Cloudflare API or
  documented as a follow-up if the CF GraphQL analytics API isn't wired).

### 5.8 Kill switches & config (`/admin/system` → Flags tab)
- Live toggles for **every** `PlatformConfig` flag (`avavoiceEnabled`, `avavisionEnabled`,
  `translationEnabled`, `translationGroupEnabled`, `conferenceEnabled`, `liveEnabled`, `consultEnabled`,
  …). Each toggle calls `PUT /api/admin/config` and is audited. Confirm dialog on disable. Shows current
  value + who last changed it (from `admin_audit`).

### 5.9 Analytics — PostHog-backed cards (`/admin/analytics`)
- **Engagement**: DAU/WAU/MAU, stickiness, retention curve.
- **Funnels**: signup → first session → first purchase → repeat; per-surface funnels.
- **Feature adoption**: usage by app (from `app_name`/`screenViewed` events).
- **Geography**: distribution from `listing_views` (country/city) + PostHog geo.
- **Trends**: any event over time (configurable event picker).
- **Session replay** deep-links into PostHog.
- All rendered as our own `zine`-styled cards via the **Worker → PostHog HogQL proxy** (§6), so the key
  never hits the browser; each card caches server-side (~60s) to respect PostHog rate limits.

### 5.10 Growth & affiliate (`/admin/creators` → Affiliate tab, or standalone)
- Affiliate links, conversions, commissions, leaderboard, suspend/unsuspend; referral funnels.

### 5.11 Content & safety / moderation (`/admin/creators` → Moderation tab)
- Reports queue (`user_reports`), moderation results, **CSAM hash hits** (top-priority alert),
  user strikes, takedown actions (audited), AvaBrain consent stats.

### 5.12 Alerts & notifications *(REQUIRED — uses the `admin_alerts` / `admin_alert_rules` tables)*
- **Alert rules** (`admin_alert_rules`): admin-defined thresholds — error-rate spike, recon diff ≠ 0,
  escrow imbalance, failed payout, CSAM hash hit, agent-busy saturation, settlement-DLQ growth. Each
  rule = `{ id, metric, comparator, threshold, window_sec, channels[], enabled, created_by, created_at }`.
- **Evaluation**: a scheduled pass (reuse the existing cron/queue cadence the recon/settlement jobs use —
  do NOT add a new DO) reads the same aggregates as `/api/admin/health` + `/api/admin/overview`, opens an
  `admin_alerts` row when a rule trips, and dispatches to its channels.
- **Channels**: email (existing transactional email path), Slack webhook (env `ADMIN_SLACK_WEBHOOK`,
  optional — degrade if unset), and in-app push.
- **Alerts inbox** (`AlertsInbox.tsx`): open/acknowledged/resolved alerts with ack/resolve actions
  (audited). The §5.1 "Needs attention" strip is the passive always-on view; this is the active one.

### 5.13 Audit log viewer (`/admin/system` → Audit tab)
- Full `admin_audit` browser: filter by admin, action, target, date; export. Read-only.

### 5.14 Admin roles *(REQUIRED — uses the `admin_roles` table)*
- Tiered access: `super` (everything, incl. managing roles), `finance` (money + payouts + refunds),
  `analyst`/`readonly` (read-only — no state-changing actions). `admin_roles` = `{ uid, role, granted_by,
  created_at }`.
- **Resolution rule**: a uid in `ADMIN_UIDS` with no `admin_roles` row defaults to `super` (so the
  current setup keeps working). Otherwise the row's `role` governs.
- **Server-side enforcement**: `requireAdmin` stays the coarse gate (is-an-admin); add a thin
  `requireAdminRole(req, env, minRole)` helper in `admin_dashboard.ts` that every state-changing endpoint
  calls. Read-only endpoints need only `requireAdmin`. The web UI hides actions the role can't perform,
  but the server is the real boundary (fail closed with 403).
- Role management UI (super only): assign/revoke roles; every change audited.

---

## 6. WORKER ENDPOINTS YOU BUILD (`worker/src/routes/admin_dashboard.ts`)

All gated by `requireAdmin`. All state-changing ones call `audit(...)`. Read-mostly; reuse existing
helpers (`metaDb`, `DB_WALLET`, ledger reads). **Never** invent a money primitive — for refunds/adjusts/
payout-retries the dashboard calls the **existing** `/api/admin/*` money endpoints.

- `GET /api/admin/overview` — the §5.1 KPI bundle (one aggregated payload; each sub-count wrapped in
  try/catch so a missing table never 500s the whole card set).
- `GET /api/admin/live` — the §5.2 live snapshot (D1 active counts + per-surface lists; viewer/room
  counts fetched from `StreamSessionDO`/LiveKit where available).
- `GET /api/admin/agents` — §5.6 agent + AI-spend aggregates.
- `GET /api/admin/health` — §5.7 error/latency/queue/job snapshot (PostHog + worker internals).
- `GET /api/admin/analytics?insight=<name>&range=<>` — **PostHog HogQL proxy**: server-side POST to
  `${POSTHOG_QUERY_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query` with
  `Authorization: Bearer ${POSTHOG_PERSONAL_API_KEY}`, a fixed allow-list of named HogQL queries
  (no arbitrary query from the client — prevents injection / data exfiltration), server-cached ~60s.
  If the key is unset, return `{ disabled: true }` and the card shows a friendly "configure PostHog".
- `GET /api/admin/audit?admin=&action=&limit=` — paginated `admin_audit` reader.
- `GET /api/admin/users/search?q=` — resolve email/uid/npub/handle → profile summary (joins the data
  `/api/admin/account/:userId` returns, plus identity-ladder + listings/agents counts).
- **Alerts (§5.12, required):** `GET /api/admin/alerts` (open/ack/resolved), `POST /api/admin/alerts/:id/ack`,
  `POST /api/admin/alerts/:id/resolve`, `GET|POST|PUT|DELETE /api/admin/alert-rules`. The evaluation pass
  runs on the existing scheduled cadence (recon/settlement), not a new DO.
- **Roles (§5.14, required):** `GET /api/admin/roles`, `PUT /api/admin/roles/:uid` (super only, audited).
  Plus the `requireAdminRole(req, env, minRole)` helper used by every state-changing endpoint above.

Return shapes: define a typed response per endpoint at the top of the file and mirror it in
`web/src/islands/admin/adminApi.ts`. Document every shape in the glue note so the web islands and Phase Z
stay in sync. Never expose `POSTHOG_PERSONAL_API_KEY`, raw Clerk secrets, or another user's PII beyond
what the existing money console already exposes to admins.

---

## 7. WEB BUILD NOTES

- Reuse the foundation kit (`Button, Card, Pill, Sheet, Spinner, Avatar`), `zine` tokens, hard shadows,
  the fonts. Charts: **Chart.js** (allowed CDN) for sparklines/curves; tables via the kit or a light
  grid. Live feeds: poll the relevant endpoint on an interval (10–15s) — **no new WebSocket/DO**.
- **Gate hard**: the admin pages mount only after `requireGuestAuth()` succeeds AND the Worker confirms
  admin (the islands call `/api/admin/overview`; a 403 renders an "Admins only" page). Don't rely on
  client-side hiding alone — the Worker gate is the real boundary.
- Keep heavy panels behind `client:visible`; the overview loads fast.
- Add the `Admin` nav link **only for admins** (Phase Z wires `Nav.astro` to show it conditionally).

---

## 8. GLUE NOTE (`Specs/avavision-build/glue/PHASE-6-GLUE.md`)

- **`worker/src/index.ts`** — the `import { ... } from "./routes/admin_dashboard"` line + the exact
  `if (p === "/api/admin/overview") …` dispatch lines for every endpoint in §6.
- **`worker/wrangler.toml`** — confirm `POSTHOG_PERSONAL_API_KEY` is set as a **secret** in prod +
  staging (note the `wrangler secret put` command; do not inline the value). If you added the optional
  `admin_dashboard.sql`, the migration tag + the D1 apply instruction (avatok-meta or avatok-wallet —
  pick the DB the tables belong to and say which).
- **`ADMIN_UIDS`** — the instruction for Phase Z to append the seeded admin's Clerk uid (from
  `seed-admin.ts`) to `[vars]` in prod **and** staging. **No password in the repo.**
- **`web/src/components/Nav.astro`** — the conditional `Admin → /admin` link (admins only).
- Whether you reused Phase 4/5's `avavisionApi.ts` pattern; whether you kept the optional
  alerts/roles scope or cut it.
- Every response shape (so Phase Z can verify the web ↔ worker contract).
- Build result (`cd web && npm run build`) + `cd worker && npx tsc --noEmit`.

## 9. SECURITY CHECKLIST (must all hold)
- [ ] No password / secret committed anywhere. Admin seeded via Clerk; only the uid goes in `ADMIN_UIDS`.
- [ ] `POSTHOG_PERSONAL_API_KEY` used **only** server-side; never sent to the browser.
- [ ] PostHog proxy uses a fixed allow-list of named queries (no arbitrary HogQL from the client).
- [ ] Every state-changing endpoint calls `requireAdmin` AND writes an `admin_audit` row.
- [ ] Money mutations reuse the existing audited money endpoints (no new money primitives).
- [ ] Admin pages fail closed (Worker 403 → "Admins only"), not just hidden client-side.

## 10. ACCEPTANCE
- [ ] `admin_dashboard.ts` created; all §6 endpoints gated by `requireAdmin`; reads degrade gracefully
      when a surface/table is absent; PostHog proxy works (or cleanly reports "key not configured").
- [ ] Web `/admin/*` pages render with `zine` styling, fail closed for non-admins, and show live cards +
      feeds for users, money, ops, errors, and every live surface (live/consult/conference/voice/vision/
      translation).
- [ ] Seed-admin path documented; `seed-admin.ts` is idempotent and stores no secret.
- [ ] **Roles**: `admin_roles` enforced server-side via `requireAdminRole`; uid in `ADMIN_UIDS` w/o a row
      defaults to `super`; role UI hides + server blocks disallowed actions.
- [ ] **Alerts**: `admin_alert_rules` + `admin_alerts` created; evaluation runs on the existing schedule;
      inbox ack/resolve audited; channels degrade gracefully when unset.
- [ ] No new DO; no shared file edited (all in the glue note); `npx tsc --noEmit` + `npm run build` green.
- [ ] Graphiti episode written (`group_id="proj_avaflutterapp"`). **No commit.**
