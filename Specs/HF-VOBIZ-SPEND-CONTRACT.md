# HF-VOBIZ-SPEND-1 — build contract (shared by every lane)

Plan + owner decisions: `Specs/PLAN-2026-10-10-HF-VOBIZ-SPEND-MONITOR.md`. This file fixes names so lanes can be
built in parallel. **Do not rename anything here without the coordinator.**

Owner decisions: keep records 8 years (never purge these tables); FULL phone numbers stored and shown (admin only,
admin reads audited); alerts only, never auto-pause calls; alert thresholds ₹20 unexplained, ₹500 low balance;
alerts by WhatsApp (`sendAdminAlert` from `lib/saathum_upi3.ts`) + email.

Money unit everywhere in our tables: **paise (INTEGER)**. Vobiz returns rupees as decimals → `Math.round(x * 100)`.
Times: **epoch ms (INTEGER)**. Vobiz times are strings → `Date.parse` (treat a string with no zone as UTC; if the
parse fails store NULL). Database binding: `env.DB_META`. Vobiz creds: `env.VOBIZ_AUTH_ID`, `env.VOBIZ_AUTH_TOKEN`
(headers `X-Auth-ID`, `X-Auth-Token`), base `https://api.vobiz.ai/api/v1`.

## 1. Tables — `worker/migrations/2026-10-10-hf-vobiz-spend.sql` (CREATE TABLE / INDEX only, lane CORE)

```sql
-- one row per Vobiz leg. Append-only: rows are INSERTed, then only the "cdr_*" columns may be filled once.
CREATE TABLE hf_vobiz_legs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,      -- chain order
  leg_uuid TEXT NOT NULL UNIQUE,              -- Vobiz CallUUID / CDR uuid
  call_id TEXT,                               -- hf_calls.id, NULL = not one of our calls ("unknown traffic")
  role TEXT NOT NULL,                         -- 'host' | 'caller' | 'unknown'
  user_uid TEXT,                              -- uid of the person on this leg (host_uid or caller_uid)
  direction TEXT,                             -- 'outbound' | 'inbound'
  from_number TEXT, to_number TEXT,           -- full E.164 (owner decision)
  start_at INTEGER, answer_at INTEGER, end_at INTEGER,
  duration_sec INTEGER, billsec INTEGER,
  cost_paise INTEGER, streaming_cost_paise INTEGER, total_cost_paise INTEGER, currency TEXT,
  hangup_cause TEXT, hangup_source TEXT, mos REAL,
  source TEXT NOT NULL,                       -- 'webhook' | 'cdr' (who created the row)
  webhook_json TEXT,                          -- raw hangup webhook fields (JSON), NULL if created from CDR
  cdr_json TEXT,                              -- raw Vobiz CDR (JSON), filled once
  cdr_checked_at INTEGER,                     -- when the CDR was fetched; NULL = still pending
  cdr_attempts INTEGER NOT NULL DEFAULT 0,
  mismatch TEXT,                              -- NULL, or a short note when webhook and CDR disagree
  created_at INTEGER NOT NULL,
  row_hash TEXT NOT NULL,                     -- sha256 hex of canonical(row at insert) + prev_hash
  prev_hash TEXT NOT NULL                     -- row_hash of seq-1, '' for the first row
);
-- indexes: (call_id), (user_uid, end_at), (end_at), (cdr_checked_at, cdr_attempts)

-- the CDR fill is an amendment, also chained (so a later change to cdr data is detectable):
CREATE TABLE hf_vobiz_leg_cdr_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, leg_uuid TEXT NOT NULL, cdr_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, row_hash TEXT NOT NULL, prev_hash TEXT NOT NULL);

CREATE TABLE hf_vobiz_balance (               -- one row per watcher tick
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  balance_paise INTEGER, available_paise INTEGER, reserved_paise INTEGER, promo_paise INTEGER, credit_limit_paise INTEGER,
  status TEXT,                                -- balance.status
  account_active INTEGER, account_enabled INTEGER, risk_status TEXT,   -- from the account object (may be NULL)
  ok INTEGER NOT NULL,                        -- 1 = Vobiz answered; 0 = request failed
  http_status INTEGER, error TEXT, raw_json TEXT,
  row_hash TEXT NOT NULL, prev_hash TEXT NOT NULL
); -- index (at)

CREATE TABLE hf_vobiz_recharges (             -- money put INTO Vobiz
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, amount_paise INTEGER NOT NULL,
  kind TEXT NOT NULL,                         -- 'manual' (owner typed) | 'detected' (balance jumped up) 
  utr TEXT, invoice_no TEXT, note TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,       -- detected rows become 1 when the owner confirms
  created_by TEXT, created_at INTEGER NOT NULL,
  row_hash TEXT NOT NULL, prev_hash TEXT NOT NULL
); -- index (at)

CREATE TABLE hf_vobiz_alerts (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,   -- unexplained_charge | low_balance | unknown_traffic | rate_high | account_inactive | api_failing | cdr_mismatch | chain_broken
  severity TEXT NOT NULL,                     -- 'warn' | 'critical'
  message TEXT NOT NULL, amount_paise INTEGER, meta_json TEXT,
  created_at INTEGER NOT NULL, sent_whatsapp INTEGER NOT NULL DEFAULT 0, sent_email INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER, acked_by TEXT
); -- index (created_at)

CREATE TABLE hf_vobiz_reports (               -- every PDF we generated or emailed
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,    -- 'download' | 'daily' | 'monthly'
  period_from INTEGER NOT NULL, period_to INTEGER NOT NULL, user_uid TEXT,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, emailed_to TEXT, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE hf_vobiz_state (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);  -- cursors, last-sent markers
```

Hash rule (all chained tables): `row_hash = sha256hex(prev_hash + "|" + canonicalJson(fields))`, where
`canonicalJson` = JSON of the inserted columns (excluding seq/id-autoincrement, row_hash, prev_hash) with keys sorted.
`prev_hash` = `row_hash` of the latest row in the same table ('' if none). Inserts into one chained table are
serialised by doing read-latest + INSERT in one `DB_META.batch` guarded with `WHERE NOT EXISTS` on the unique key;
on a lost race, retry up to 3 times.

## 2. `worker/src/lib/hf_vobiz_api.ts` (lane CORE) — never throws

```ts
export interface VobizBalance { ok: boolean; httpStatus: number; error?: string; balancePaise?: number; availablePaise?: number;
  reservedPaise?: number; promoPaise?: number; creditLimitPaise?: number; status?: string; raw?: unknown }
export interface VobizAccount { ok: boolean; httpStatus: number; error?: string; isActive?: boolean; enabled?: boolean; riskStatus?: string | null; raw?: unknown }
export interface VobizCdr { uuid: string; direction: string | null; from: string | null; to: string | null; startAt: number | null;
  answerAt: number | null; endAt: number | null; durationSec: number | null; billsec: number | null; costPaise: number | null;
  streamingCostPaise: number | null; totalCostPaise: number | null; currency: string | null; hangupCause: string | null;
  hangupSource: string | null; mos: number | null; raw: unknown }
export function vobizConfigured(env: Env): boolean;
export async function getBalance(env: Env, currency?: "INR"): Promise<VobizBalance>;      // GET /Account/{id}/balance/INR
export async function getAccount(env: Env): Promise<VobizAccount>;                        // GET /Account/{id}/
export async function getCdr(env: Env, legUuid: string): Promise<VobizCdr | null>;        // GET /Account/{id}/cdr/{uuid}
export async function listRecentCdrs(env: Env, limit?: number): Promise<VobizCdr[]>;      // GET /Account/{id}/cdr/recent?limit=
export async function listCdrs(env: Env, q: { startDate: string; endDate: string; page?: number; perPage?: number }): Promise<{ items: VobizCdr[]; hasMore: boolean }>; // YYYY-MM-DD
export async function exportCdrCsv(env: Env, startDate: string, endDate: string): Promise<string | null>; // GET /cdr/export, raw CSV text
export function parseCdr(raw: any): VobizCdr | null;   // tolerant: CDR may be nested under data / object / objects[]
```
Fields per docs: `uuid` (fallback `call_uuid`/`id`), `call_direction`, `caller_id_number`, `destination_number`,
`start_time`, `answer_time`, `end_time`, `duration`, `billsec`, `cost`, `streaming_cost`, `total_cost`, `currency`,
`hangup_cause`, `hangup_source`, `mos`. Mark every guess `// VERIFY ON FIRST LIVE CALL`.

## 3. `worker/src/lib/hf_vobiz_ledger.ts` (lane CORE)

```ts
export async function chainInsert(env: Env, table: "hf_vobiz_legs"|"hf_vobiz_leg_cdr_log"|"hf_vobiz_balance"|"hf_vobiz_recharges", row: Record<string, unknown>, uniqueKey?: { col: string; val: string }): Promise<{ inserted: boolean; rowHash: string }>;
export async function recordLegFromWebhook(env: Env, a: { callId: string; role: "host"|"caller"; legUuid: string | null; fields: Record<string,string> }): Promise<void>; // never throws
export async function upsertLegFromCdr(env: Env, cdr: VobizCdr): Promise<"inserted"|"filled"|"unchanged">; // attributes via hf_calls host_leg_uuid / caller_leg_uuid
export async function recheckPendingLegs(env: Env, max?: number): Promise<{ checked: number; filled: number; mismatches: number }>; // legs with cdr_checked_at NULL, ended > 90 s ago, attempts < 30
export async function verifyChain(env: Env, table: string, fromSeqOrId?: number): Promise<{ ok: boolean; rows: number; brokenAt?: number }>;
```
`recordLegFromWebhook`: webhook fields we expect (Plivo dialect): `CallUUID`, `From`, `To`, `Direction`, `Duration`,
`BillDuration`, `TotalCost`, `StartTime`, `AnswerTime`, `EndTime`, `HangupCause`, `HangupSource` — store whatever
arrives in `webhook_json`, map the known ones. uid comes from `hf_calls` (host_uid / caller_uid).
Mismatch rule: CDR `total_cost` vs webhook `TotalCost` differ by > 1 paisa, or billsec differs by > 2 s.

CORE also edits `do/hf_call.ts` **only** in `hangup()` (and where legs are dialed if needed) to call
`recordLegFromWebhook` via `this.state.waitUntil` / `ctx` without changing call logic or response timing.

## 4. `worker/src/lib/hf_vobiz_watch.ts` (lane WATCH)

```ts
export async function runVobizWatch(env: Env, now?: number): Promise<void>;   // called every minute; never throws
export async function raiseAlert(env: Env, a: { kind: string; severity: "warn"|"critical"; dedupeKey: string; message: string; amountPaise?: number; meta?: unknown }): Promise<boolean>;
export function reconcileWindow(rows: { balances: {at:number;balancePaise:number}[]; legs: {endAt:number;totalCostPaise:number}[]; recharges: {at:number;amountPaise:number}[] }, from: number, to: number): { openingPaise: number; closingPaise: number; callCostPaise: number; rechargePaise: number; unexplainedPaise: number }; // pure
```
Each tick: (1) balance + account → `hf_vobiz_balance` (ok=0 row on failure); (2) `listRecentCdrs(50)` → `upsertLegFromCdr`;
(3) `recheckPendingLegs(20)`; (4) every 15 min: reconcile the last closed hour (window ended ≥ 15 min ago) and the
running day; (5) alerts: unexplained > ₹20 (2000 paise), balance < ₹500 (50000 paise), leg with call_id NULL,
effective rate (total_cost / ceil(billsec/60)) > `env`-free constant `EXPECTED_MAX_PAISE_PER_MIN` (start 150, in the
same file, note to owner), account inactive / disabled / risk flag, 3 failed ticks in a row (api_failing), cdr
mismatch, chain broken (verify once an hour). A balance INCREASE of ≥ ₹1 with no manual recharge within ±30 min →
insert `hf_vobiz_recharges` kind='detected', confirmed=0 (not an alert). Dedupe keys: e.g. `low_balance:<IST date>`,
`unexplained:<window start>`, `unknown_traffic:<leg_uuid>`. WhatsApp text in simple English. Email to
`hdavy2005@gmail.com` via `queueDurableEmail`-style helper in `lib/email_outbox.ts` (find the exported enqueue fn).
(6) call `maybeSendVobizReports(env, now)` from lane REPORT.
**Never** touches hf_calls status, flags, or pauses calls.

## 5. Report + admin API (lane REPORT) — `worker/src/lib/hf_vobiz_report.ts`, `worker/src/routes/hf_vobiz_admin.ts`

```ts
export async function buildReportData(env: Env, q: { from: number; to: number; userUid?: string }): Promise<ReportData>;
export async function renderReportPdf(d: ReportData): Promise<Uint8Array>;   // pdf-lib, Helvetica, WinAnsi-safe text (see lib/me_receipt_pdf.ts)
export function renderLegsCsv(d: ReportData): string;
export async function maybeSendVobizReports(env: Env, now: number): Promise<void>; // daily at/after 23:55 IST, monthly on the 1st after 00:10 IST, once each (hf_vobiz_state markers)
export async function hfVobizAdminRoute(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null>; // null = not my path
```
All routes admin-only (`isAdminUid` like `routes/hf_calls.ts`), every call audited the same way as hf_calls' `audit()`:
- `GET /api/admin/hf/vobiz/summary` → `{ live: {balancePaise, availablePaise, reservedPaise, at, ok, accountActive}, today: {costPaise, legs, minutes}, month: {...}, unexplainedTodayPaise, unexplainedMonthPaise, chargedUsersTodayPaise, chargedUsersMonthPaise, openAlerts, pendingCdr, chainOk }`
- `GET /api/admin/hf/vobiz/legs?from=&to=&uid=&callId=&unknown=1&limit=&offset=` → `{ items: Leg[], total }`
- `GET /api/admin/hf/vobiz/users?from=&to=` → `{ items: [{uid, name, phone, asCaller:{calls,billsec,costPaise}, asHost:{...}, paidPaise, vobizCostPaise, diffPaise}] }` (name/phone from existing user tables; find how admin customers page gets them)
- `GET /api/admin/hf/vobiz/calls/:id` → `{ call: hf_calls row subset, legs: Leg[] }`
- `GET /api/admin/hf/vobiz/balance?from=&to=` → `{ points: [{at, balancePaise, availablePaise, ok}], recharges: [...] }` (downsample to ≤ 500 points)
- `GET /api/admin/hf/vobiz/alerts?limit=` / `POST /api/admin/hf/vobiz/alerts/:id/ack`
- `GET /api/admin/hf/vobiz/recharges` / `POST /api/admin/hf/vobiz/recharges {amountRupees, at, utr, invoiceNo, note}` / `POST /api/admin/hf/vobiz/recharges/:id/confirm`
- `GET /api/admin/hf/vobiz/report.pdf?from=&to=&uid=` (application/pdf, Content-Disposition attachment) and `GET .../report.csv` — each PDF logged in `hf_vobiz_reports` with sha256.
- `POST /api/admin/hf/vobiz/sync {date: YYYY-MM-DD}` → pulls `listCdrs` for that IST day and upserts (manual backfill).
`from`/`to` are epoch ms; default = today IST.

PDF sections: cover (period, generated at IST, report id, sha of data), money summary (opening + recharges − call
costs = expected closing vs actual closing, unexplained), day-by-day table, per-user table, every leg (time IST,
direction, from, to, billsec, cost ₹, total ₹, Vobiz uuid, our call id), balance changes, alerts in period, chain
check result. Footer on every page: "Hello Fraands — Vobiz spend report <id> · page n/N · data sha256 <first 16>".
Brand name from `lib/brand.ts` (`BRAND.name`) — never hand-typed.

Nightly email: PDF + CSV + Vobiz's own `exportCdrCsv` (attached unmodified as `vobiz-cdr-<date>.csv`) to
`hdavy2005@gmail.com`. Attachment content format: match what `lib/email_outbox.ts` expects (check the sender).

## 6. Web (lane WEB) — admin page `/admin/hosts/phone-costs`

`web/src/pages/admin/hosts/phone-costs.astro` + `web/src/islands/admin2/hosts/HostPhoneCosts.tsx`, nav item
"Phone costs" (active key `host-phone-costs`) next to "Calls and credits" / "Reconciliation". Follow the existing
admin2 hosts islands (HostCalls.tsx, HostReconciliation.tsx) exactly for fetch/auth/styles. Owner design rules:
full width (no narrow centred column), Nunito headlines, Comfortaa text, nothing under 14px, **no green anywhere**,
works on phone width. Sections: live tiles (refresh every 15 s), live legs feed (15 s), per-user table with search,
call drill-down (both legs, webhook vs CDR, mismatch badge), balance chart (inline SVG, no new deps), recharges
(add form + confirm detected), alerts (ack), date-range + user picker with **Download PDF** and **Download CSV**
(fetch with auth then blob download, since the API needs the auth header), "Sync a day from Vobiz" button.
Show money as ₹ with 2 decimals. Full phone numbers shown.

## 7. Wiring (coordinator only)
`worker/src/index.ts` (route + scheduled), `worker/wrangler.toml` (add cron `"* * * * *"`; dispatch by
`event.cron`), `tool/ship_manifest.json`, `Specs/RULEBOOK-HELLO-FRAANDS.md`. Lanes must NOT edit these.
