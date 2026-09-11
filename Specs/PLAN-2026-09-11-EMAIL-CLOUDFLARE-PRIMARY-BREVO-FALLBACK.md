# PLAN — Transactional email: Cloudflare Email Service primary, Brevo fallback

Date: 2026-09-11 · Status: SHIPPED TO PROD (consumers) 2026-09-11 · web pending PR merge · Owner: Davy
Scope: every outbound transactional email avaTOK sends today. Marketing campaigns / the Brevo contact list are OUT of scope (Brevo keeps those).

Sources studied: Cloudflare Email Service docs (developers.cloudflare.com/email-service — Workers API, REST API, send bindings, domains, limits, pricing, event subscriptions, suppression lists, local development) via Context7 + the Cloudflare docs MCP, and the current code paths listed in §1.

---

## 0. TL;DR

1. Onboard `avatok.ai` to **Email Sending** in the Cloudflare dashboard (zone is already on Cloudflare). Cloudflare auto-adds the `cf-bounce.avatok.ai` MX + SPF/DKIM/DMARC records. Nothing in Brevo changes yet.
2. Introduce ONE provider module, `consumers/src/email_provider.ts`, with two adapters (`cloudflare`, `brevo`) and a policy: **try Cloudflare first; on a retryable Cloudflare error, send the same message through Brevo in the same attempt**. Everything else in `email_delivery.ts` (the D1 outbox, CAS claim, lease, attempt budget) stays exactly as it is.
3. Add a `send_email` binding (`EMAIL`) to `consumers/wrangler.toml` (prod + staging) and a `EMAIL_PROVIDER` var (`cloudflare` | `brevo` | `cloudflare_then_brevo`) so cutover and rollback are a var flip + redeploy, not a code change.
4. Point the three web Pages endpoints (`contact`, `careers-apply`, `waitlist` thank-you) and `recon.ts` at the same policy (REST API on Pages; binding in the consumer).
5. **Bonus we get for free:** Cloudflare publishes `message.delivered` / `bounced` / `complained` / `rejected` events into a Queue. Today nothing ever moves an `email_outbox` row past `provider_accepted` (there is no Brevo webhook route in the repo). A small consumer on an `email-events` queue finally fills `delivered_at` / `bounced_at`.
6. Cut over per lane: staging → prod low-risk lanes (invites, OTP, receipts) → commercial confirmations. Brevo key stays configured throughout as the fallback.

Estimated effort: ~1.5–2 dev days of agent work + DNS wait + a soak week.

---

## 1. Inventory — what sends email today (verified 2026-09-11)

All Worker/consumer mail funnels through **one** HTTP call site; the web has three more; recon has one.

| # | Path | How it sends | Sender | Notes |
|---|------|--------------|--------|-------|
| A | `consumers/src/email_delivery.ts` → `sendEmailDurably()` | `fetch("https://api.brevo.com/v3/smtp/email")` with `BREVO_API_KEY` | `noreply@avatok.ai` (default; overridable per message via `msg.from`) | The only transport for everything enqueued on `Q_EMAIL`: booking matrix (`worker/src/cal/emails.ts`), receipts (`ledger.ts`), payouts (`routes/payout.ts`), invites (`routes/invite.ts`), email OTP (`routes/id.ts`), commercial confirmations (`lib/email_outbox.ts`), guardian digests, listing confirmations, money-engine mails, reminder ladder (`consumers/src/index.ts:102, 258`). Supports `replyTo` and base64 `attachments` (ICS). Backed by the D1 `email_outbox` table (CAS claim, 5-min lease, 5 attempts). |
| B | `consumers/src/recon.ts` → `alertEmail()` | direct Brevo fetch | `AvaTok Ops <noreply@avatok.ai>` → `ALERT_EMAIL` | Ops alert, not user-facing. Bypasses the outbox. |
| C | `web/src/pages/api/contact.ts` | direct Brevo fetch (Pages Function) | `hello@avatok.ai` (`BREVO_SENDER_EMAIL`) | Contact form → internal inbox. |
| D | `web/src/pages/api/careers-apply.ts` | two direct Brevo fetches | `hello@avatok.ai` | Internal notification + applicant acknowledgement. |
| E | `web/src/pages/api/waitlist.ts` | Brevo **contacts API** (list add) + Brevo transactional thank-you | `hello@avatok.ai` | The list-add stays on Brevo (out of scope). Only the thank-you email migrates. |
| F | `marketing/public/_worker.js` | same as E | — | Legacy marketing site worker. Migrate only if it is still deployed; otherwise leave. |

Config surface: `consumers/wrangler.toml` (secret comment at line ~256; staging note line ~308), `consumers/src/types.ts:51` (`BREVO_API_KEY?`), `secrets/deploy.sh:45`, `secrets/secret-values.env(.example)`, `web/wrangler.toml` + Pages dashboard env (`BREVO_API_KEY`, `BREVO_SENDER_*`, `BREVO_LIST_ID`), `app/lib/core/config.dart:350` (comment only).

Tests that pin Brevo behaviour: `consumers/test/email_delivery.test.ts`, `worker/test/commercial_email_delivery_behavior.test.ts`, `worker/test/commercial_email_journey_contract.test.ts`.

**Gap found while reading:** `email_outbox.delivered_at` / `bounced_at` exist (migration `2026-09-09-commercial-email-delivery.sql`) but no code ever writes them — there is no Brevo webhook route. The `lib/email_outbox.ts` docstring says "only a signed provider callback may move a row to delivered". §5 closes this with Cloudflare event subscriptions.

---

## 2. What Cloudflare Email Service gives us (from the docs)

**Sending surfaces**
- **Workers binding** — `[[send_email]] name = "EMAIL"` in wrangler; `await env.EMAIL.send({ to, from, subject, html, text?, replyTo?, cc?, bcc?, headers?, attachments? })` → `{ messageId }`. Errors are thrown as `Error` with a `.code` (table below). Binding can be restricted with `destination_address` / `allowed_destination_addresses` (useful for staging). `remote = true` lets `wrangler dev` hit the real service.
- **REST API** — `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`, Bearer token with **Email Sending: Edit**. Same JSON shape (`to, from, subject, html, text, headers`). Response `result: { delivered: [], permanent_bounces: [], queued: [] }`. This is the path for the Astro Pages Functions (Pages does not document a `send_email` binding; the REST API is the safe choice there, and it avoids a Pages→Workers migration for this task).
- **SMTP** also exists; not needed.

**Message shape / limits**
- Total message ≤ 5 MiB including base64 attachments; ≤ 50 recipients across to/cc/bcc; ≤ 32 attachments. Attachment object is `{ content (base64 string | ArrayBuffer), filename, type (MIME), disposition: "attachment" | "inline", contentId? }` — note `filename`/`type` are required, whereas Brevo takes `{ name, content }`. The ICS attachment path must map `name → filename` and set `type: "text/calendar"`.
- Custom headers: ≤ 20 allowlisted non-`X-` headers, 100-byte names, 2 KB values, 16 KB total. `From`/`To` etc. must go through API fields (`E_HEADER_USE_API_FIELD`).
- `from` must be on a domain onboarded to Email Sending (`E_SENDER_NOT_VERIFIED` / `E_SENDER_DOMAIN_NOT_AVAILABLE` otherwise). Each subdomain is its own sending domain.

**Quotas / pricing**
- Requires **Workers Paid** (we are on it — Queues, DOs, D1 already in use). 3,000 emails/month included, then **$0.35 per 1,000**.
- New accounts start with a **conservative daily quota that auto-scales** with reputation; higher limits can be requested. `E_DAILY_LIMIT_EXCEEDED` / `E_RATE_LIMIT_EXCEEDED` are the signals — exactly the case where the Brevo fallback earns its keep in the first weeks.
- Before the domain is onboarded you can only send to *verified destination addresses* (free, no quota) — good for the first smoke test.

**Error codes** (`error.code`) and how the policy treats them:

| Code | Meaning | Policy |
|------|---------|--------|
| `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR`, `E_DELIVERY_FAILED` | transient / capacity | **fall back to Brevo now**; if Brevo also fails, mark retryable failure (existing behaviour) |
| `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE` | our config is wrong | **fall back to Brevo** + log loudly (PostHog `$exception`), do not retry Cloudflare for this message |
| `E_RECIPIENT_SUPPRESSED` | Cloudflare knows this address hard-bounced/complained | **do NOT fall back** — mark row `bounced`, non-retryable. Sending anyway via Brevo would hurt reputation. |
| `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_TOO_MANY_ATTACHMENTS`, `E_CONTENT_TOO_LARGE`, `E_HEADER_*` | our payload is wrong | non-retryable failure, no fallback (Brevo would reject the same payload or we would be masking a bug) |
| `E_RECIPIENT_NOT_ALLOWED` | staging allowlist | non-retryable; expected on staging for non-allowlisted addresses |

**Observability**
- Dashboard activity log (Sent / Delivered / Delivery failed / Rejected / Failed) and GraphQL datasets `emailSendingAdaptive(Groups)`.
- **Event subscriptions → Cloudflare Queues**: `cf.email.sending.message.delivered | deferred | bounced | complained | rejected`. Payload carries `messageId`, `recipient`, `terminal`, `delivery.smtpStatusCode`, `bounce.type (hard|soft)`. This is the missing "signed provider callback".
- Account **suppression list** is auto-managed (hard bounces, repeated soft bounces, complaints); manual add/remove, except complaint entries.

---

## 3. Target design

```
producers (worker, unchanged)
   └─ Q_EMAIL ──► consumers: sendEmailDurably()          [outbox CAS/lease/attempts — unchanged]
                      └─ email_provider.sendWithPolicy(msg, env)
                            ├─ cloudflare adapter  (env.EMAIL.send)      ← primary
                            └─ brevo adapter       (api.brevo.com)       ← fallback
                      └─ outbox row gets provider = 'cloudflare' | 'brevo', provider_message_id

Cloudflare Email Sending ──events──► Queue "email-events" ──► consumers.queue()  → email_outbox.delivered_at / bounced_at

web Pages functions ──► shared helper using REST API (Cloudflare) → Brevo fallback
recon.ts ──► same helper (binding)
```

### 3.1 New module `consumers/src/email_provider.ts`

```ts
export type ProviderName = "cloudflare" | "brevo";
export type SendOutcome =
  | { ok: true; provider: ProviderName; messageId: string | null }
  | { ok: false; provider: ProviderName; retryable: boolean; terminal?: "bounced"; error: string };

export interface OutboundEmail {           // = EmailMsg minus outbox bookkeeping
  to: string; subject: string; html: string; text?: string;
  from?: string; replyTo?: { email: string; name?: string };
  attachments?: { name: string; content: string; type?: string }[];
  headers?: Record<string, string>;
}

export async function sendViaCloudflare(msg, env): Promise<SendOutcome>
export async function sendViaBrevo(msg, env): Promise<SendOutcome>
export async function sendWithPolicy(msg, env): Promise<SendOutcome & { fallbackUsed: boolean }>
```

Policy, driven by `env.EMAIL_PROVIDER`:
- `cloudflare_then_brevo` (target): Cloudflare; if outcome is retryable **or** a sender-config error → Brevo. Suppressed / payload errors → return as-is.
- `cloudflare`: Cloudflare only (used once Brevo is decommissioned or during a Brevo incident).
- `brevo`: today's behaviour (rollback switch).
- Missing binding or missing key → that adapter reports `retryable:false, error:"not configured"` and the policy moves on; if *both* are unconfigured the existing "not configured" failure path runs.

Mapping details:
- `sender()` already parses `"Name <addr>"`; Cloudflare accepts `{ email, name }` so reuse it.
- Attachments: `{ filename: a.name, content: a.content, type: a.type ?? guessMime(a.name) /* .ics → text/calendar */, disposition: "attachment" }`.
- Always also pass `text` (strip-tags of `html`) — cheap deliverability win; Brevo path can ignore it.
- Add `headers: { "X-AvaTOK-Outbox-Key": key, "X-AvaTOK-Kind": kind }` on Cloudflare sends so activity logs and events can be joined back to the outbox even if `messageId` is lost (X- headers do not count toward the 20-header allowlist cap).

### 3.2 Changes to `email_delivery.ts`
- Replace the inline `fetch(api.brevo.com)` block with `const out = await sendWithPolicy(msg, env)`.
- Success → existing `provider_accepted` UPDATE, plus `provider=?` and the Cloudflare/Brevo `messageId`.
- `out.terminal === "bounced"` → `UPDATE … delivery_status='bounced', bounced_at=now, next_attempt_at=NULL` (new branch; today only failures exist).
- Retryable / non-retryable failures → existing `markFailure()` unchanged, error string prefixed with the provider (`Cloudflare E_RATE_LIMIT_EXCEEDED …` / `Brevo 503 …`).
- Remove the early `if (!env.BREVO_API_KEY)` guard; the policy owns "nothing configured".

### 3.3 Schema (one migration, D1 `DB_META`)
`worker/migrations/2026-09-XX-email-provider.sql`
```sql
ALTER TABLE email_outbox ADD COLUMN provider TEXT;              -- 'cloudflare' | 'brevo'
ALTER TABLE email_outbox ADD COLUMN fallback_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN last_event TEXT;            -- delivered|deferred|bounced|complained|rejected
CREATE INDEX IF NOT EXISTS idx_email_outbox_provider_msg ON email_outbox(provider, provider_message_id);
```

### 3.4 Wrangler / config
`consumers/wrangler.toml` (top-level and `[env.staging]`):
```toml
[[send_email]]
name = "EMAIL"
# staging only — hard cap on who staging can mail:
# allowed_destination_addresses = ["hdavy2005@gmail.com", "<qa inbox>"]

[vars]
EMAIL_PROVIDER = "brevo"            # flip to "cloudflare_then_brevo" at cutover
EMAIL_FROM_DEFAULT = "AvaTok <noreply@avatok.ai>"

[[queues.consumers]]                # §5
queue = "email-events"
max_batch_size = 25
max_batch_timeout = 5
```
`consumers/src/types.ts`: add `EMAIL?: SendEmail; EMAIL_PROVIDER?: string;`. `consumers/package.json` pins `@cloudflare/workers-types ^4.20250510.0` (May 2025) — that predates the structured `send({to, from, …})` builder overload, so bump it (or declare a local `SendEmail` interface) before the adapter will type-check.

Web (`web/wrangler.toml` / Pages env): add `CF_ACCOUNT_ID` var and `CF_EMAIL_API_TOKEN` secret (token scope: **Account → Email Sending → Edit**, nothing else), keep `BREVO_API_KEY` for fallback + list-add. New `web/src/lib/sendMail.ts` implementing the same policy over REST + Brevo; `contact.ts`, `careers-apply.ts`, `waitlist.ts` call it. Sender `hello@avatok.ai` is on the same onboarded domain so no extra setup.

`secrets/deploy.sh`: keep `put consumers BREVO_API_KEY`; the consumer binding needs no secret. That script only drives the three Workers, so the web token is set in the Pages dashboard (or via the web-deploy workflow's secrets), not here.

---

## 4. Phased rollout

### Phase 0 — Domain & account (no code) · ½ day + DNS
1. Dashboard → Email Service → **Email Sending** → onboard `avatok.ai`. Cloudflare writes MX on `cf-bounce.avatok.ai`, SPF include, DKIM (`cf-bounce` selector), DMARC. Because DNS is on Cloudflare this verifies in ~5–15 min.
2. **Check existing SPF.** `avatok.ai` already has Brevo's `include:` (and possibly Clerk/Google). Cloudflare adds its own include — confirm the merged record stays ≤ 10 DNS lookups and that the Brevo include is *kept* (fallback sends must keep passing SPF/DMARC). Do not let the onboarding replace the TXT.
3. Do not touch Brevo's DKIM records.
4. Send one test to a verified destination address (`hdavy2005@gmail.com`) from the dashboard/REST to confirm DKIM=pass, DMARC=pass in the received headers.
5. Create the API token for the web (Email Sending: Edit). Record `account_id`.
6. Ask for a daily-limit raise via the dashboard now — pull the last 30 days of Brevo volume (`brevo get_analytics_summary`) as the justification so the auto-scaling ramp does not throttle launch traffic.

Exit: domain shows "Verified" in Email Sending; test mail authenticated.

### Phase 1 — Provider abstraction, Brevo still primary · 1 day
1. Add `email_provider.ts`, wire `sendEmailDurably`, migration §3.3, wrangler binding + `EMAIL_PROVIDER="brevo"`.
2. Tests: extend `consumers/test/email_delivery.test.ts` with a fake `EMAIL.send` — cases: CF ok; CF `E_RATE_LIMIT_EXCEEDED` → Brevo ok (`fallback_used=1`); CF `E_RECIPIENT_SUPPRESSED` → row `bounced`, Brevo **not** called; CF validation error → non-retryable, Brevo not called; both unconfigured → existing failure. Update `worker/test/commercial_email_delivery_behavior.test.ts` mocks (they stub `BREVO_API_KEY` + `fetch`; they must also accept a policy result).
3. Port `recon.ts` `alertEmail()` to `sendWithPolicy` (it is ops mail — fine to be first real Cloudflare traffic).
4. Deploy consumers via CI (no local toolchain — CI is the only build path). Behaviour is unchanged for users because `EMAIL_PROVIDER="brevo"`.

Exit: prod deployed, all Brevo tests green, recon alert arrives via Cloudflare.

### Phase 2 — Staging cutover · ½ day
1. `[env.staging]`: `EMAIL_PROVIDER="cloudflare_then_brevo"`, `allowed_destination_addresses` set to QA inboxes.
2. Run the staging journey: sign-up email OTP, invite, booking confirmation with ICS, commercial confirmation, payout status, receipt. Verify in the Email Sending activity log + `email_outbox.provider='cloudflare'`.
3. Force a fallback: temporarily set a bad `from` domain on staging → expect `E_SENDER_NOT_VERIFIED` → Brevo delivers, `fallback_used=1`, PostHog exception logged. Revert.

### Phase 3 — Delivery events (§5) · ½ day
Ship before prod cutover so the first Cloudflare week has real delivered/bounced data.

### Phase 4 — Prod cutover, per lane · over ~1 week
Flip `EMAIL_PROVIDER="cloudflare_then_brevo"` on prod consumers. Because every lane funnels through the one call site, the "per lane" ramp is a **watch order**, not separate flags:
- Day 1–2: ops alerts, email OTP (`routes/id.ts`), invites — high volume, low blast radius; watch `fallback_used` rate and `E_DAILY_LIMIT_EXCEEDED` in logs.
- Day 3–4: receipts, payout status, booking matrix + ICS attachment (verify Gmail/Outlook/Apple Mail render the calendar attachment identically).
- Day 5+: commercial confirmations (the money lane; `commercial_email_journey_contract.test.ts` covers the contract).
- Web: deploy `sendMail.ts` through the GitHub web-deploy workflow (never a local Pages deploy — that ships without the Clerk key and breaks sign-in).

Rollback at any point: `EMAIL_PROVIDER="brevo"` + redeploy consumers (≈2 min). No data migration to undo.

### Phase 5 — Settle · after 2 clean weeks
- Keep Brevo as fallback indefinitely (free tier covers fallback volume) **or** drop it and set `EMAIL_PROVIDER="cloudflare"`. Recommendation: keep it for at least a quarter; the daily-quota auto-scaling on a young Cloudflare sending account is the main risk and Brevo absorbs exactly that.
- Update comments/docs that say "Brevo" as the transport: `consumers/wrangler.toml` secret notes, `lib/email_outbox.ts` docstring, `cal/emails.ts` header, `routes/invite.ts:8` ("VERIFIED Brevo address" → "verified sending domain"), `app/lib/core/config.dart:350`, `CONFIG.md`/`TECH_STACK.md`, `secrets/secret-values.env.example`.
- Suppression hygiene: export Brevo's hard-bounce/blocklist and add those addresses to Cloudflare's account suppression list before/at cutover so we do not re-mail known-dead addresses from a fresh reputation.

---

## 5. Delivery events → outbox (closes the `delivered_at` gap)

1. Dashboard → Queues → create `email-events` (and `email-events-staging`). Event subscription: source **Email Sending**, domain `avatok.ai`, events `message.delivered`, `message.deferred`, `message.bounced`, `message.complained`, `message.rejected`.
2. `consumers/wrangler.toml`: add the `[[queues.consumers]]` block (§3.4). In `consumers/src/index.ts` the `queue()` handler already switches on the queue name (`q`, with `-staging` stripped) — add `case "email-events": await handleEmailEvent(msg.body, env)` pointing at a new `consumers/src/email_events.ts`.
3. Handler (idempotent on `payload.eventId`):
   - locate the row: `provider='cloudflare' AND provider_message_id = payload.messageId`; fallback lookup by `X-AvaTOK-Outbox-Key` is not available in events, so `messageId` is the join — make sure §3.2 stores it.
   - `delivered` → `delivery_status='delivered', delivered_at=eventTimestamp, last_event='delivered'`
   - `bounced` (terminal) / `complained` / `rejected` → `delivery_status='bounced', bounced_at=…, error_message=bounce.reason|rejection.detail`
   - `deferred` → `last_event='deferred'` only.
   - Guard: never move a row *backwards* (delivered beats deferred; bounced is final).
4. On `complained` or hard `bounced`, additionally write the address into a small `email_suppressions(email, reason, at)` table so producers (e.g. `verifiedClerkEmail`) can skip enqueueing — Cloudflare already suppresses on its side, but our fallback path would otherwise happily send it through Brevo. `sendWithPolicy` checks this table first and returns `terminal:"bounced"`.
5. Admin visibility: `worker/src/routes/commercial_diagnostics.ts` already reads `email_outbox` for the JOURNEY-04 delivery status — surface `provider`, `fallback_used`, `last_event` there.

Brevo-delivered messages will still stop at `provider_accepted` (no Brevo webhook is planned) — acceptable for a fallback lane.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Young sending account throttled (`E_DAILY_LIMIT_EXCEEDED`) at launch | Brevo fallback is automatic; request a limit raise in Phase 0 with Brevo volume as evidence; ramp lanes over a week. |
| SPF record edit breaks Brevo (fallback) authentication | Phase 0 step 2: merge includes, do not replace; verify a Brevo send still passes DMARC after onboarding. |
| ICS attachment shape mismatch (`name` vs `filename`, missing MIME) | Adapter maps explicitly; staging test opens the invite in three clients. |
| Pages Functions cannot use the `send_email` binding | Web uses the REST API with a least-privilege token; no Pages→Workers migration needed for this work. |
| Fallback double-sends | Policy only falls back when Cloudflare **threw** (no `messageId`). A Cloudflare success is never followed by Brevo. The outbox CAS still guarantees one send per attempt. |
| Re-mailing suppressed addresses via Brevo | `E_RECIPIENT_SUPPRESSED` and the local `email_suppressions` table short-circuit before the fallback. |
| Cost surprise | 3,000/month included then $0.35/1k — at even 100k/month that is ~$34. Brevo free tier (300/day) is enough for fallback-only traffic. |
| Staging leaks mail to real users | `allowed_destination_addresses` on the staging binding (hard limit enforced by the platform, not by our code). |

---

## 7. Acceptance checklist

- [ ] `avatok.ai` verified in Email Sending; DKIM/SPF/DMARC pass for both a Cloudflare send and a Brevo send.
- [ ] `EMAIL_PROVIDER` var exists on prod + staging consumers; rollback rehearsal done once on staging.
- [ ] `consumers/test/email_delivery.test.ts` covers the five policy cases in Phase 1 step 2.
- [ ] `email_outbox` rows show `provider`, `provider_message_id`, and — for Cloudflare sends — reach `delivered` or `bounced` within minutes via the events queue.
- [ ] Web contact / careers / waitlist thank-you arrive from `hello@avatok.ai` via Cloudflare; Brevo list-add unchanged.
- [ ] Recon alert email arrives via Cloudflare.
- [ ] Fallback rate on prod < 1% after week 1 (else investigate quota before widening lanes).
- [ ] Docs/comments in §Phase 5 updated; this plan's status flipped to SHIPPED with the date.

---

## 8. Open decisions for Davy

1. **Keep Brevo permanently as fallback, or sunset after a quarter?** (Plan assumes keep.)
2. **Separate sending subdomain?** Docs treat each subdomain as its own sending domain with its own reputation. Using `mail.avatok.ai` for transactional would isolate reputation from anything else on the apex, but it changes the visible `From:` and you would need Brevo to verify the same subdomain for the fallback to stay authenticated. Plan assumes **apex `avatok.ai`**, same as today.
3. **Migrate `marketing/public/_worker.js`?** Only if that site is still live; otherwise delete the Brevo code there in the scrub.

---

## Implementation log 2026-09-11

New files/modules added for the provider abstraction and delivery-events lane:
- `consumers/src/email_provider.ts` — the `sendWithPolicy` / `sendViaCloudflare` / `sendViaBrevo` module (§3.1).
- `consumers/src/email_events.ts` — the `email-events` queue consumer that fills `email_outbox.delivered_at` / `bounced_at` (§5).
- `web/src/lib/sendMail.ts` — the shared Cloudflare-REST + Brevo-fallback helper for the Pages functions (`contact.ts`, `careers-apply.ts`, `waitlist.ts`).
- `worker/migrations/2026-09-11-email-provider.sql` — `email_outbox.provider` / `fallback_used` / `last_event` / `last_event_at`, plus the new `email_suppressions` and `email_events_seen` tables (§3.3, §5).

Facts learned while working Phase 0:
- Domain `avatok.ai` was already onboarded to Email Sending on 2026-09-06.
- Queues created: `email-events` (id `675d68f675a44a5195eedd98c2c5e6d9`) and `email-events-staging`.
- Event subscription `3ca78989f397496ab3a12f460f61d14b` is registered on `email-events`.
- Cloudflare allows only **one** event subscription per sending domain — staging (`email-events-staging`) therefore gets no delivery events; staging visibility stays at `provider_accepted` until a real cutover.
- Account `fd3dbf43f8e6d8bf65bd36b02eb0abb0`, zone `ae74ddf95ebf8c401d254ae3d308d4b5`.
- Root SPF already reads `v=spf1 include:_spf.mx.cloudflare.net include:spf.brevo.com ~all` — both providers' includes are present, so no merge was needed at onboarding.

---

## Deploy log 2026-09-11

**consumers/worker deploy (already live in prod + staging, ahead of the PR):**
- Confirmed account: `wrangler whoami` → `Hdavy2005@gmail.com's Account`, id `fd3dbf43f8e6d8bf65bd36b02eb0abb0`.
- Flipped top-level `EMAIL_PROVIDER` `"brevo"` → `"cloudflare_then_brevo"` in `consumers/wrangler.toml` (line 309); `[env.staging]` was already `"cloudflare_then_brevo"` (line 570).
- Sanity: `consumers` `tsc --noEmit` clean, `vitest run` 45/45 passed; `web` `node --test test/sendMail.test.ts` 12/12 passed; `worker` `tsc --noEmit` clean.
- Migration `worker/migrations/2026-09-11-email-provider.sql`:
  - **Prod** `avatok-meta` (`c4ec8c0e-e1ac-4a1d-8e41-636f4007871b`): applied cleanly — 7 queries, 11 rows written. Verified via `PRAGMA table_info(email_outbox)`: `provider`, `fallback_used`, `last_event`, `last_event_at` all present (cid 21-24). Verified via `sqlite_master`: `email_suppressions`, `email_events_seen`, `idx_email_outbox_provider_msg` all present.
  - **Staging** `avatok-meta-staging` (`3866e75b-89ab-4325-bbfa-4bef61395107`): the `ALTER TABLE email_outbox …` statements failed with `no such table: email_outbox` — staging's D1 never received the earlier JOURNEY-04 migrations (`2026-09-03-commercial-email-outbox.sql`, `2026-09-09-commercial-email-delivery.sql`), a **pre-existing gap unrelated to this migration**. Applied only the file's two standalone `CREATE TABLE IF NOT EXISTS` statements to staging; `email_suppressions` and `email_events_seen` confirmed present there. `email_outbox` alters/index were skipped on staging — someone should backfill the base JOURNEY-04 schema on staging before relying on delivery-event tracking there.
  - Prod deploy (`npx wrangler deploy`): version `db46f261-8b7e-47bf-b267-507612b3bf74`. Confirmed bindings: `env.EMAIL (unrestricted)` Send Email binding, `Consumer for email-events`, `env.EMAIL_PROVIDER ("cloudflare_then_brevo")`.
  - Staging deploy (`npx wrangler deploy --env staging`) initially failed: `Queue "mkt-audio-dlq-staging" does not exist` — pre-existing wrangler.toml/Cloudflare-account drift (config declared the queue, it was never provisioned), unrelated to this migration. Ran `npx wrangler queues create mkt-audio-dlq-staging` (additive, matches already-committed config) and redeployed successfully. Confirmed `env.EMAIL`, `Consumer for email-events-staging`, `EMAIL_PROVIDER ("cloudflare_then_brevo")`.
  - Post-deploy: `curl -sI https://avatok.ai/` → `200`. Tailed `avatok-consumers` for ~90s — no traffic, no errors. `email_outbox` had no rows updated in the prior hour (baseline, expected pre-cutover).
- **Pages secret**: `CF_EMAIL_API_TOKEN` set on `avatok-app` (owner + coordinator, outside this session) — web will flip to Cloudflare-first sending on its next deploy once this PR merges.

**Git-history note:** `origin/main` had diverged from this session's local `main` — `origin`'s tip (`42b3c7f2`, message `[WEB-HELP-1] Help centre…`) is actually a large revert (~3,200 lines) of the waiting-room / live-grace / session-clock feature set relative to local `main`, and another session was actively editing files in that same area (`worker/src/commercial_settlement.ts`, `worker/src/do/stream_session.ts`, `worker/src/lib/commercial_notifications.ts`, `worker/src/routes/commercial_stream_sessions.ts`) at the time. Rather than rebase or merge local `main` onto `origin/main` (risking silently dropping or duplicating that in-flight work), the email-migration commit was shipped as a **branch off `origin/main` in a separate `git worktree`** (`git worktree add /tmp/avatok-email origin/main`, `git cherry-pick 0152d34b`), leaving local `main` and the other session's dirty files completely untouched. The cherry-pick applied cleanly with no conflicts (the email files are disjoint from the reverted waiting-room area).

**PR:** `email/cloudflare-primary-brevo-fallback` → `main`. https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/pull/2

**CI on the PR branch (`typecheck` workflow, run 34596912828):** `availability-web`, `consumers`, `worker`, `design-guard` jobs all passed. `ship-gate` failed, but on a pre-existing, unrelated backlog: `python3 tool/check_ship_readiness.py --check all` reports 32 issues with no telemetry success definition and 7 malformed manifest entries (`UI-MKT-VERT-1`, `WEB-ACCOUNT-1`, `AVA-GROUP-SESSION-1`, `SHARE-OG-IMAGE-1`, etc.) — none of them touch email/consumers/web-sendMail. Ran the same check against `origin/main` directly and got the identical 32/7 counts, confirming this PR did not introduce the failure.

