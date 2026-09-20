# REPORT — Lane 05-email

Batch: `saathum-20260920` · Branch: `saathum/05-email` · Scope per BRIEFS.md:
sender domain and templates, Cloudflare Email + Brevo fallback.

## Starting condition — inherited uncommitted work

This worktree already contained substantial **uncommitted** changes when I
started (visible in `git status`/`git diff` before I touched anything) —
apparently an earlier, interrupted pass at this exact lane. It updated the
sender domain and every transactional template string from `avatok.ai`/
`AvaTOK` to `saathum.com`/`Saathum` across `consumers/`, `worker/`, and
`web/src/pages/api/*`, and left careful `[SAATHUM-EMAIL-1]` comments warning
that the new domain must not be deployed live until it's actually onboarded
with both email providers — but it referenced a plan document,
`Specs/PLAN-2026-09-20-SAATHUM-EMAIL-DOMAIN-CUTOVER.md`, that didn't exist
yet. I reviewed that work line-by-line, verified it against the existing
(shipped) `Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md`,
kept it (it was correct and well-reasoned), extended it in a few places, and
wrote the missing plan doc it pointed to. Nothing here overwrites or
discards prior work — it completes it.

## What changed

### Sender domain / brand in templates (16 files, all committed on this branch)
- `consumers/src/email_provider.ts` — default sender fallback →
  `Saathum <noreply@saathum.com>` (only fires when `EMAIL_FROM_DEFAULT` is
  unset).
- `consumers/src/index.ts` — fixed a **dead** local `parseSender()` (superseded
  by `email_provider.ts` since the 2026-09-11 migration, never called) so a
  future revival doesn't resurrect the old brand/domain.
- `consumers/src/types.ts` — doc-comment default updated to match.
- `consumers/src/calendar.ts` — reminder-ladder emails (T-24h/T-60m), booking
  and live-ticket join/room URLs now `https://saathum.com/...`. **No
  `WEB_BASE_URL` escape hatch exists in this file** (unlike `cal/emails.ts`) —
  flagged inline and in the plan doc §5.
- `consumers/src/recon.ts` — ops alert sender → `Saathum Ops
  <noreply@saathum.com>`.
- `consumers/wrangler.toml` — `EMAIL_FROM_DEFAULT` flipped to the new address
  on both the prod top-level block and `[env.staging]`, each with a 🚨
  comment explaining exactly why it must not go live before the domain is
  verified (see Risk section below).
- `web/src/lib/sendMail.ts` — default sender name/email → Saathum/saathum.com.
- `web/src/pages/api/waitlist.ts` — already used `ORG` (from
  `web/src/lib/org.ts`) for the brand name and logo/URL per SPEC hard rule 3;
  I left this as-is, it's the correct pattern.
- `web/src/pages/api/contact.ts`, `web/src/pages/api/careers-apply.ts` — I
  additionally changed these (they were still hand-typing "Saathum" as a
  literal string) to import `ORG` and use `ORG.name` for all brand-name copy,
  matching `waitlist.ts`'s existing pattern and SPEC hard rule 3 ("Brand
  facts live ONLY in web/src/lib/org.ts. Never hand-type them into a page.").
  The actual mailbox addresses (`support@saathum.com`, `hello@saathum.com`)
  stay literal — those are sender-domain facts this lane owns, not brand
  facts `org.ts` models.
- `worker/src/cal/emails.ts` — email shell footer, listing-published .ics
  filename, join-CTA label, reminder subject → Saathum. `webBase()` fallback
  → `https://saathum.com` (this one does read `env.WEB_BASE_URL` first,
  unlike `calendar.ts`).
- `worker/src/ledger.ts` — receipt email title/subject/payment-source line.
- `worker/src/lib/agent_live/emails.ts` — email shell footer, `webBase()`
  fallback.
- `worker/src/routes/id.ts` — **the passwordless sign-in OTP email** and the
  password-set OTP email: copy + sender → Saathum/saathum.com. See Risk
  section — this is the one send in the whole batch where a mistake locks
  users out entirely.
- `worker/src/routes/invite.ts` — invite email copy, subject, sender;
  `DOWNLOAD_URL`/`INVITE_BASE` → `saathum.com` (must mirror the Flutter
  app's `kInviteBase` — flagged for the app-side lane).
- `worker/src/routes/verse.ts` — monthly earnings-statement email subject.

### New file
- `Specs/PLAN-2026-09-20-SAATHUM-EMAIL-DOMAIN-CUTOVER.md` — the domain
  cutover plan every `[SAATHUM-EMAIL-1]` comment in the diff points at.
  Covers: what's actually verified today (nothing, as far as this repo's
  config shows — §1), why this is sequenced separately from the already-
  shipped Cloudflare-primary/Brevo-fallback architecture (§2), the phased
  onboarding (Cloudflare Email Sending, Brevo domain/sender verification,
  inbound Email Routing for `support@`, event-subscription resubscription —
  §3), fully-drafted SPF and DMARC records plus documented (not fabricated)
  DKIM/MX record slots (§4.1–4.4, **no DNS published**, per SPEC hard rule),
  the deliverability risk analysis this lane's brief specifically asked for
  (§4), and explicit call-outs that the web-app-live cutover and Universal/
  App Links are separate, larger pieces of work this lane does not cover
  (§5, §6).

### What I deliberately did NOT touch
- `web/src/lib/org.ts` — owned by lane 10 (brand-sweep); still says
  `avaTOK`/`avatok.ai`/the Delaware entity. My `ORG.name`/`ORG.legalName`/
  `ORG.url` usages in `waitlist.ts`/`contact.ts`/`careers-apply.ts` will
  automatically pick up whatever lane 10 sets there — no coordination
  needed beyond both lanes landing.
- `worker/src/routes/id.ts:203`'s "AvaTOK number" comment (code comment, not
  user-facing copy) — lane 10's brief explicitly claims "AvaTOK number" →
  "Saathum number" across app/web/help/**emails**; left for them rather than
  partially doing their sweep.
- Any DNS record, any Cloudflare dashboard action, any Brevo dashboard
  action, any deploy. SPEC hard rule 8 — deploys are the coordinator's call,
  and per the plan doc, this specific cutover must not be bundled into the
  general rename deploy regardless (see Risk section).
- `marketing/public/_worker.js` — PLAN-2026-09-11 §8 flagged it as
  possibly-dead legacy code outside that migration's scope; same applies
  here, and I didn't find it referenced by anything live.

## 🚨 Deliverability risk — the highest-risk item in this batch

Per the brief: **sign-in is passwordless end-to-end.** `routes/id.ts`'s email
OTP is the only credential a user has to get in — no password fallback (removed
2026-07-18, `id.ts:203`), no SMS fallback. If the new sender domain goes live
before it's actually verified with both providers, **every OTP send fails
closed on both the Cloudflare primary path and the Brevo fallback path in
the same attempt**, because both read from the one `EMAIL_FROM_DEFAULT` var —
there is no partial-failure state here, it's binary. Full analysis, the three
concrete failure modes, and the recommended sequencing (do not bundle the
`EMAIL_FROM_DEFAULT` flip into the general rename deploy) are in the new plan
doc §4. I'm flagging it here too because it's the one fact in this report
that must not get lost in a longer document: **the code on this branch is a
draft of the target end-state, not something safe to deploy as-is.** It
needs `saathum.com` verified in Cloudflare Email Sending AND verified as a
Brevo sender before `EMAIL_FROM_DEFAULT` (or any of the literal `from:`
strings this lane changed) reaches a live environment.

## Verification performed

- **Typecheck**, all three packages, using the main checkout's already-
  installed `node_modules` via a temporary symlink (removed afterward; never
  ran `npm install` in this worktree, per the CLAUDE.md sandbox rule):
  - `consumers`: `tsc --noEmit` — clean.
  - `worker`: `tsc --noEmit` — clean.
  - `web`: `tsc --noEmit -p tsconfig.json` — pre-existing errors in
    unrelated files (`astro.config.mjs`, several `.tsx` islands, `qrcode`
    module types, `help.ts`, a Playwright spec) confirmed **not** touching
    any file this lane edited (`sendMail.ts`, `contact.ts`,
    `careers-apply.ts`, `waitlist.ts`) — grepped the error output for those
    filenames, zero hits. `astro check` itself wants to auto-`npm i
    @astrojs/check typescript`, which I declined rather than installing.
- **Tests**, same temporary-symlink approach:
  - `consumers`: `email_delivery.test.ts` + `email_events.test.ts` — 27/27
    pass.
  - `web`: `test/sendMail.test.ts` — 12/12 pass (the two tests that mention
    `avatok.ai` pass an **explicit** `from:` override to test REST-body
    serialization, not the default-sender fallback I changed — confirmed
    they don't need updating).
  - `worker`: `commercial_email_delivery_behavior.test.ts` +
    `commercial_email_journey_contract.test.ts` — 6/6 pass. Ran the **full**
    worker suite too: 1045/1098 pass, 53 failures across 13 files
    (`wallet_reservation_policy.test.ts`, `paytm_checksum.test.mjs`,
    `commercial_pricing_authority.test.ts`, etc.) — none of those files
    touch anything this lane edited, and they fail on a `FakeSql` mock gap
    (`human_call_credit` table) and other pre-existing issues unrelated to
    email. Pre-existing, not introduced by this lane.
- No new Astro **page** routes were added or changed by this lane (only
  existing API endpoints and Worker/consumer email-sending code) — SPEC hard
  rule 6 ("curl the actual page") doesn't have a new page to apply to here;
  noting that explicitly rather than silently skipping it.
- Confirmed via grep that no other `noreply@avatok`/`hello@avatok`/
  `support@avatok` sender addresses remain in any file that actually sends
  email (`Q_EMAIL.send`, `env.EMAIL.send`, `sendMail(` call sites) across
  `worker/`, `consumers/`, `web/src`.

## Gaps / what I could not do

- **Cannot confirm whether `saathum.com` is even registered or on the
  Cloudflare account** — no way to check this from the repo, and the plan
  doc says so explicitly (§1) rather than assuming. This blocks Phase 0 of
  the cutover plan and is a question for the owner, not something I could
  resolve here.
- **DKIM records are not draftable** — both Cloudflare and Brevo generate
  their own key pairs at onboarding time. The plan documents the record
  *slots* (hostname pattern) but not values; publishing fabricated values
  would be actively harmful (looks configured, fails verification).
- **No live DMARC record for `avatok.ai` is documented anywhere in this
  repo**, so I couldn't mirror an existing policy for consistency — I
  proposed a conservative `p=none`-first ramp instead (plan §4.4) and
  flagged that the owner should confirm live state and reconcile if one
  already exists.
- I did not attempt `astro build` (a full production build) — it's a heavier
  operation than this lane's four-file change warrants, and none of the
  files I touched are page routes, so there's no new SSR surface to prove
  renders. If the coordinator wants a full-build sanity pass across all
  lanes' changes together, that's better done once at integration time.
- I have no way to actually send a test email or inspect Cloudflare/Brevo
  dashboard state from this environment — everything in the "verification
  performed" section above is static analysis + unit tests, not a live
  send. The plan doc's Phase 5 (real test sends, header inspection) is
  explicitly owner/coordinator action, not something achievable from here.
