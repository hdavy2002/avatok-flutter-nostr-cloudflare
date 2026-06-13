# PHASE 6 GLUE — AvaAdmin (platform Mission-Control dashboard)

Owner: Phase 6. **No commit made.** Phase Z applies the SHARED-file edits below.
Status: Worker `npx tsc --noEmit` → **0 errors**. Web islands/pages `tsc` → **0 errors**
in Phase-6 files (the only repo `tsc` error is pre-existing `tailwind.config.ts:6`
`require` — not ours). `astro build` could not complete **in the sandbox** because the
FUSE mount blocks `unlink` inside Vite's dep-optimizer cache (`node_modules/.vite/deps/*`);
this is an environment limitation that does not occur on a normal disk — Phase Z should
run `cd web && npm run build` to confirm.

---

## 1. Files created (all within owned paths — no shared file edited)

**Worker**
- `worker/src/routes/admin_dashboard.ts` — all new aggregation/alerts/roles endpoints + PostHog proxy + `requireAdminRole` + exported `evaluateAlerts(env)`.
- `worker/scripts/seed-admin.ts` — idempotent Clerk-lookup admin-seed helper (no secret inlined).
- `worker/migrations/admin_dashboard.sql` — `admin_roles`, `admin_alert_rules`, `admin_alerts` (DB_WALLET; `CREATE TABLE IF NOT EXISTS` only).

**Web** (`web/src/...`)
- `islands/admin/adminApi.ts` — typed wrapper for `/api/admin/*` (owned; shared `lib/apiClient.ts` untouched) + `useAdminGate` hook + formatters.
- `islands/admin/AdminGate.tsx` — fail-closed gate wrapper (extra owned helper file).
- `islands/admin/{OverviewCards,LiveFeed,UserSearch,LedgerExplorer,PayoutsQueue,ReconPanel,AgentsPanel,AnalyticsCards,FlagsPanel,AuditLog,AlertsInbox}.tsx` (11 islands).
- `pages/admin/{index,live,users,money,creators,analytics,system}.astro` (7 pages; SSR, `private,no-store`).

---

## 2. SHARED-FILE EDITS FOR PHASE Z

### 2a. `worker/src/index.ts` — import + dispatch

Add the import (near the other route imports):
```ts
import {
  adminOverview, adminLive, adminAgents, adminHealth, adminAnalytics, adminAuditLog,
  adminUserSearch, adminAlerts, adminAlertAck, adminAlertResolve, adminAlertEvaluate,
  adminAlertRules, adminAlertRuleMutate, adminRoles, adminRoleSet,
} from "./routes/admin_dashboard";
```

Add the dispatch lines (inside the `/api/*` block, alongside the existing `/api/admin/*` money routes):
```ts
// AvaAdmin dashboard (Phase 6) — read-mostly + alerts/roles. requireAdmin inside.
if (p === "/api/admin/overview" && req.method === "GET") return await adminOverview(req, env);
if (p === "/api/admin/live" && req.method === "GET") return await adminLive(req, env);
if (p === "/api/admin/agents" && req.method === "GET") return await adminAgents(req, env);
if (p === "/api/admin/health" && req.method === "GET") return await adminHealth(req, env);
if (p === "/api/admin/analytics" && req.method === "GET") return await adminAnalytics(req, env);
if (p === "/api/admin/audit" && req.method === "GET") return await adminAuditLog(req, env);
if (p === "/api/admin/users/search" && req.method === "GET") return await adminUserSearch(req, env);

// Alerts
if (p === "/api/admin/alerts" && req.method === "GET") return await adminAlerts(req, env);
if (p === "/api/admin/alerts/evaluate" && req.method === "POST") return await adminAlertEvaluate(req, env);
{ const m = p.match(/^\/api\/admin\/alerts\/([A-Za-z0-9-]{1,64})\/ack$/); if (m && req.method === "POST") return await adminAlertAck(req, env, m[1]); }
{ const m = p.match(/^\/api\/admin\/alerts\/([A-Za-z0-9-]{1,64})\/resolve$/); if (m && req.method === "POST") return await adminAlertResolve(req, env, m[1]); }
if (p === "/api/admin/alert-rules" && (req.method === "GET" || req.method === "POST")) return await adminAlertRules(req, env);
{ const m = p.match(/^\/api\/admin\/alert-rules\/([A-Za-z0-9-]{1,64})$/); if (m && (req.method === "PUT" || req.method === "DELETE")) return await adminAlertRuleMutate(req, env, m[1]); }

// Roles (super only — enforced inside)
if (p === "/api/admin/roles" && req.method === "GET") return await adminRoles(req, env);
{ const m = p.match(/^\/api\/admin\/roles\/([A-Za-z0-9_-]{1,64})$/); if (m && req.method === "PUT") return await adminRoleSet(req, env, m[1]); }
```
> Note: the dashboard REUSES the existing money endpoints (`/api/admin/ledger`,
> `/api/admin/refund`, `/api/admin/adjust`, `/api/admin/account/:uid`,
> `/api/admin/recon`, `/api/admin/settlements*`, `/api/admin/config`,
> `/api/admin/affiliates`, `/api/admin/tax-export`) — already dispatched. Nothing to add for those.

### 2b. `worker/wrangler.toml`

1. **Migration** — apply `admin_dashboard.sql` to the **avatok-wallet** D1 (same DB as `admin_audit`), prod + staging:
   ```
   wrangler d1 execute avatok-wallet --remote --file=worker/migrations/admin_dashboard.sql
   wrangler d1 execute avatok-wallet --remote --env staging --file=worker/migrations/admin_dashboard.sql
   ```
   (If a migrations manifest/tag list is maintained, add `admin_dashboard.sql` to it.)
2. **`POSTHOG_PERSONAL_API_KEY`** — confirm it is set as a **secret** (NOT in `[vars]`) in prod + staging; analytics cards degrade to "PostHog key not configured" if unset:
   ```
   wrangler secret put POSTHOG_PERSONAL_API_KEY            # prod
   wrangler secret put POSTHOG_PERSONAL_API_KEY --env staging
   ```
   (`POSTHOG_PROJECT_ID=139917` and `POSTHOG_QUERY_HOST=https://eu.posthog.com` are already in `[vars]`.)
3. **Optional `ADMIN_SLACK_WEBHOOK`** — if Slack alert channel is wanted, add as a secret. The code reads it via `(env as any).ADMIN_SLACK_WEBHOOK` and degrades silently if unset. To make it typed, add `ADMIN_SLACK_WEBHOOK?: string;` to `worker/src/types.ts` (not a forbidden file, but left to Z to avoid parallel collisions).
4. **Alert evaluation cron** — there is **no existing `scheduled()` handler** in `index.ts`. `evaluateAlerts(env)` is exported and ready; Phase Z should either (a) call it from the existing recon/settlement cron when one is added, or (b) rely on the manual `POST /api/admin/alerts/evaluate` button in the UI. No new DO is introduced either way.

### 2c. `ADMIN_UIDS` (seed admin `hdavy2002@gmail.com`)

Run `worker/scripts/seed-admin.ts` with `CLERK_SECRET_KEY` in the env (password set in Clerk by the owner, never in repo). It prints the Clerk uid → **append it to `ADMIN_UIDS` in `[vars]` (prod AND staging)**, then redeploy. A uid in `ADMIN_UIDS` with no `admin_roles` row defaults to `super` (resolution rule §5.14). **No password in the repo.**

### 2d. `web/src/components/Nav.astro` — admin link (admins only)

Add a conditional `Admin → /admin` link, shown only when the viewer is an admin. Cheapest correct approach: render it always-hidden server-side and reveal client-side after a `GET /api/admin/overview` 200 (the page itself is already fail-closed by `AdminGate`). Example link markup to match the kit:
```astro
<a href="/admin" data-admin-link hidden class="...nav-link classes...">Admin</a>
```
(or gate via the existing Clerk session in the nav island). The pages do not depend on this link existing — it is convenience only.

---

## 3. ENDPOINT RESPONSE SHAPES (web ↔ worker contract — verify in Z)

Authoritative TS interfaces live in `web/src/islands/admin/adminApi.ts` and match the
`json(...)` returns in `admin_dashboard.ts`. Summary:

- `GET /api/admin/overview` → `Overview` `{ ts, sessions{live_streams,consults,conference,voice_calls,vision_calls,translation,total}, money{escrow_coins,fees_today_coins,fees_mtd_coins,gmv_today_coins}, signups_today, needs_attention{failed_settlements,recon_diffs,pending_payouts,open_reports,csam_hits,open_alerts}, surfaces[{key,label,enabled}] }`
- `GET /api/admin/live` → `LiveSnapshot` `{ ts, live_streams[], consults[], voice_calls[], vision_calls[], vision_available, conference_rooms{count,rooms[]}, slot_utilization{cap,voice[{agent_id,active}]}, translation{active} }`
- `GET /api/admin/agents` → `AgentsSnapshot` `{ voice{total_agents,active_sessions,calls_7d,gross_7d_coins}, vision{available,…}, ai_spend_14d[{day,calls,ms}] }`
- `GET /api/admin/health` → `{ ts, queues{settlement_dlq}, jobs{recon|null}, posthog_note }`
- `GET /api/admin/analytics?insight=&range=` → `{ insight, range, cached, results[][], columns[] }` OR `{ disabled:true, reason }`. Allow-list: `dau,events_total,signups,errors,error_by_endpoint,active_now,trend_daily`. **No arbitrary HogQL from the client.**
- `GET /api/admin/audit?admin=&action=&limit=&cursor=` → `{ entries[], next_cursor }`
- `GET /api/admin/users/search?q=` → `UserSummary` `{ found, user{uid,handle,display_name,avatar_url,created_at}, kyc, strikes, verified_proofs, counts{listings,voice_agents,vision_agents}, recent_ledger[] }`
- `GET /api/admin/alerts?status=` → `{ alerts[] }` · `POST /api/admin/alerts/:id/ack|/resolve` → `{ ok }` · `POST /api/admin/alerts/evaluate` → `{ ok, checked, tripped, opened }`
- `GET|POST /api/admin/alert-rules` → `{ rules[] }` / `{ ok, id }` · `PUT|DELETE /api/admin/alert-rules/:id` → `{ ok }`
- `GET /api/admin/roles` → `{ roles[{uid,role,granted_by,created_at,implicit?}] }` · `PUT /api/admin/roles/:uid` `{role}` → `{ ok }`

---

## 4. Scope notes / decisions

- **Roles & Alerts: KEPT** (both marked REQUIRED). `admin_roles`/`admin_alerts`/`admin_alert_rules` created; `requireAdminRole(req,env,minRole)` gates every state-changing dashboard endpoint (ack/resolve/evaluate/rule-CRUD = `finance`+, role mgmt = `super`). Read endpoints need only `requireAdmin`. UI hides disallowed actions but the **Worker is the boundary** (403).
- **Money mutations reuse existing audited endpoints** (`/api/admin/adjust`, `/api/admin/refund`, `/api/admin/settlements/:id/retry`, `/api/admin/config`). No new money primitive added.
- **Graceful degradation**: every sub-query is wrapped (try/catch or `safeScalar/safeAll`); AvaVision cards show "not yet deployed" when `avavision_*` tables are absent. (As of build time `worker/src/routes/avavision.ts` + `migrations/avavision.sql` are present in the tree, so vision cards populate.)
- **Conference live counts**: LiveKit ListRooms requires a signed Twirp JWT — left as `count:null` ("—" in UI) with a note; Phase Z can wire the real call if desired (no new DO).
- **PostHog key never reaches the browser** — all queries proxied through the Worker; server-cached ~60s; allow-listed named queries only.
- I did **not** reuse a Phase 4/5 `avavisionApi.ts` — this phase only touches `/api/admin/*`, so a dedicated `islands/admin/adminApi.ts` is the right home. The shared `web/src/lib/apiClient.ts` was imported read-only (`request`, `ApiError`).
- Extra owned helper `islands/admin/AdminGate.tsx` added (within the owned `islands/admin/**` dir) to keep the fail-closed gate DRY across pages.

## 5. Security checklist (all hold)
- [x] No password/secret committed; admin seeded via Clerk, only uid → `ADMIN_UIDS`.
- [x] `POSTHOG_PERSONAL_API_KEY` used server-side only; never sent to browser.
- [x] PostHog proxy = fixed allow-list of named queries (no arbitrary HogQL).
- [x] Every state-changing endpoint calls `requireAdmin`(+role) AND writes `admin_audit`.
- [x] Money mutations reuse existing audited money endpoints (no new primitive).
- [x] Admin pages fail closed (Worker 403 → "Admins only"), not just client-hidden.
- [x] No new Durable Object; no shared file edited (all listed here for Z).
