# PLAN — Saathum email domain cutover (avatok.ai → saathum.com sender domain)

Date: 2026-09-20 · Status: DRAFT — no DNS published, no domain onboarded, no prod
deploy · Lane: 05-email (batch `saathum-20260920`) · Depends on:
`Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md` (Cloudflare
Email Service primary / Brevo fallback — SHIPPED TO PROD on `avatok.ai`
2026-09-11; this plan does not re-architect that, it re-points it at a second
domain).

Scope: everywhere `worker/`, `consumers/`, `web/` send transactional email.
Out of scope: DNS publication (hard rule — this plan drafts records, it does
not create them), the web app going live at `saathum.com` (a separate,
larger cutover — §5), Universal/App Links (§6), and anything owned by other
lanes (taxonomy, flags, brand strings outside sender/template code, the
avatok.ai freeze, takedowns).

---

## 0. TL;DR

1. **Do not flip `EMAIL_FROM_DEFAULT` / any hardcoded sender to `@saathum.com`
   in a live environment until Phase 0–3 below are DONE.** The code in this
   branch already reads `saathum.com` as its *default* — that is deliberate
   (it is the target end-state and the templates need to say "Saathum" now),
   but every touched file carries a `[SAATHUM-EMAIL-1]` comment saying not to
   deploy it live yet, and `consumers/wrangler.toml`'s two `EMAIL_FROM_DEFAULT`
   lines are the actual deploy-time switch — they must not reach a live
   `wrangler deploy` before onboarding finishes. That is a coordinator
   decision, not this lane's.
2. `saathum.com` needs the **same two onboardings `avatok.ai` already has**:
   Cloudflare Email Sending (for the primary send path) and a verified Brevo
   sender/domain (for the fallback path) — see PLAN-2026-09-11 §0/§2 for how
   those work. Until both are verified, every send under the new address
   fails closed on **both** the primary and fallback path at once — see §4.
3. `saathum.com` also needs its own **inbound Email Routing** rule for
   `support@saathum.com` to receive anything (Email Sending only lets you
   send; receiving is a separate Cloudflare product) — see §3.
4. **The passwordless-login OTP email is the single highest-risk item in this
   whole batch.** `routes/id.ts`'s `idEmailStart` is the only credential a
   user has; if it lands in spam or bounces on a brand-new, unauthenticated
   sending domain, users cannot sign in and there is no fallback UI path.
   See §4.
5. SPF and DMARC for `saathum.com` are drafted in full below (§4.4) — those
   are values *we* choose. DKIM is **not** draftable here: both Cloudflare and
   Brevo generate their own DKIM key pairs and TXT record values at the
   moment each service onboards the domain, so those slots are documented by
   hostname/selector pattern only, to be filled in from each dashboard.

---

## 1. Current state (verified in this worktree, 2026-09-20)

- `saathum.com` does not appear anywhere in `web/wrangler.toml`,
  `worker/wrangler.toml`, or `consumers/wrangler.toml` except the
  `EMAIL_FROM_DEFAULT` lines this lane just added. No zone, no DNS, no
  Cloudflare Email Sending onboarding, no Brevo sender verification exists
  for it as far as this repo's config surface shows.
- Whether `saathum.com` is even **registered** and whether its zone has been
  **added to the Cloudflare account** (`fd3dbf43f8e6d8bf65bd36b02eb0abb0` —
  same account as `avatok.ai`, confirmed in `web/wrangler.toml:32` and
  PLAN-2026-09-11's deploy log) is outside what this lane can verify from the
  repo. **Ask the owner before Phase 0.** If the zone is not on Cloudflare
  yet, Email Sending onboarding cannot proceed (it depends on Cloudflare
  controlling the zone's DNS, exactly as it does for `avatok.ai` today).
- `avatok.ai`'s existing root SPF (`v=spf1 include:_spf.mx.cloudflare.net
  include:spf.brevo.com ~all`, confirmed in PLAN-2026-09-11's implementation
  log) has **no DMARC record documented anywhere in this repo** — this plan
  is the first place a DMARC policy for either domain gets written down.
  Confirm live DMARC state for `avatok.ai` (`dig TXT _dmarc.avatok.ai`)
  before assuming §4.4's record is new territory; if one already exists,
  match its policy rather than introducing a second, different one.
- Code state in this worktree: every literal sender/template string this
  lane found (`consumers/`, `worker/`, `web/src/pages/api/*`,
  `web/src/lib/sendMail.ts`) now reads `saathum.com` / "Saathum" — see
  `REPORT.md` for the file list. Nothing has been deployed; this lane does
  not deploy (SPEC hard rule 8).

---

## 2. Why this is a separate, sequenced plan and not part of PLAN-2026-09-11

PLAN-2026-09-11 solved "which transport sends the mail" (Cloudflare primary,
Brevo fallback) for the existing, already-verified `avatok.ai` domain. This
plan solves a different problem: "which **domain** is the mail verified to
come from." Those are independent axes — you can (and briefly will, per §7)
run the exact same Cloudflare-then-Brevo policy code against a sender address
that neither provider has verified yet, and it will fail closed on **both**
adapters simultaneously, which is a materially worse failure mode than either
plan alone suggests. PLAN-2026-09-11's own Phase 0 already assumed
`avatok.ai`'s zone was already on Cloudflare and onboarding was a same-day,
same-account operation; this plan cannot assume that for `saathum.com` and
says so in §1.

---

## 3. Phases

### Phase 0 — Domain prerequisites (owner action, no code) · timing unknown until confirmed
1. Confirm `saathum.com` is registered and its authoritative nameservers
   point at Cloudflare (zone exists in the same account,
   `fd3dbf43f8e6d8bf65bd36b02eb0abb0`). If not, this blocks everything below.
2. Decide: **apex `saathum.com`** for transactional mail (mirrors what
   `avatok.ai` does today — `noreply@`, `hello@`, `support@`), or a dedicated
   subdomain (e.g. `mail.saathum.com`) to isolate sending reputation from any
   future marketing/bulk mail on the apex. PLAN-2026-09-11 §8 flagged this
   same open question for `avatok.ai` and it was never decided either way —
   raise both together with the owner rather than deciding by default a
   second time. This plan assumes **apex**, matching every sender string
   already written into the templates (`noreply@saathum.com`,
   `hello@saathum.com`, `support@saathum.com`); switching to a subdomain
   later means re-touching every file this lane just touched.

### Phase 1 — Cloudflare Email Sending onboarding · ~15 min once Phase 0 is done
1. Dashboard → Email → **Email Sending** → onboard `saathum.com`. Cloudflare
   writes its own MX (`cf-bounce.saathum.com`), an SPF `include`, a DKIM TXT
   record (`cf2dkim1._domainkey.saathum.com`-style selector — Cloudflare
   assigns the exact selector at onboarding; do not guess it in DNS you
   publish), and can add a DMARC record if the zone has none — **decline
   that if §4.4 has already been published, so Cloudflare doesn't overwrite
   our chosen policy.**
2. Same account as `avatok.ai` (`fd3dbf43f8e6d8bf65bd36b02eb0abb0`) — no new
   `CF_ACCOUNT_ID` needed anywhere; `web/wrangler.toml:32` already carries
   the right value for both domains.
3. Send one test message to a verified destination address
   (`hdavy2005@gmail.com`, same as PLAN-2026-09-11 Phase 0 step 4) via the
   dashboard/REST API from `noreply@saathum.com`. Confirm DKIM=pass,
   SPF=pass, DMARC=pass in the received headers before touching any Brevo
   config.

### Phase 2 — Brevo sender/domain verification · owner action in Brevo dashboard
1. Brevo verification is **separate from Cloudflare** and separate from the
   existing `avatok.ai` Brevo account config — a new domain needs its own
   authentication there even though it is the same Brevo account used today.
2. Brevo issues its own DKIM TXT record (selector/hostname supplied at
   verification time — do not reuse `avatok.ai`'s Brevo DKIM values, they
   are domain-specific) and a domain-ownership TXT record. Add both once
   issued; this plan cannot draft their content in advance.
3. Verify at least the specific sender addresses this lane uses as `from`
   values even if full domain authentication is pending:
   `noreply@saathum.com`, `hello@saathum.com` (careers/contact/waitlist
   sender), and anything `EMAIL_FROM_DEFAULT` resolves to. An unverified
   Brevo sender fails the **fallback** path the same way an unverified
   Cloudflare domain fails the **primary** path — see §4's "both paths fail
   closed" risk.

### Phase 3 — Inbound Email Routing for `support@saathum.com` · ~10 min once Phase 0 is done
`contact.ts`'s error copy and `careers-apply.ts` both point users at
`support@saathum.com` as a real, reachable inbox. Email Sending (Phase 1)
only covers **outbound**. Set up Cloudflare **Email Routing** for
`saathum.com` (Rules → Email → Routing rules) forwarding `support@` to
wherever the team actually reads support mail today (check what
`support@avatok.ai` forwards to and mirror it — do not guess a new
destination). Confirm Email Routing and Email Sending can coexist on one
zone (they generally do, on different MX/record slots) before assuming this
is a non-issue.

### Phase 4 — DNS records, drafted (do not publish — SPEC hard rule)

#### 4.1 SPF (root TXT) — fully specified, ours to choose
```
saathum.com.   TXT   "v=spf1 include:_spf.mx.cloudflare.net include:spf.brevo.com ~all"
```
Identical shape to `avatok.ai`'s current record (PLAN-2026-09-11
implementation log). Both providers' includes must be present from day one
— unlike the `avatok.ai` case (where Cloudflare onboarded onto an
already-Brevo-authenticated domain and merged into an existing record),
`saathum.com` starts from nothing, so there is no "don't overwrite the
existing include" risk here — just don't publish only one provider's
include and forget the other, or whichever path you add second will look
like a spoofed sender until you do. Keep total DNS lookups ≤ 10 (two
includes here is fine).

#### 4.2 DKIM — provider-issued, slots only
```
<cloudflare-selector>._domainkey.saathum.com.   TXT   <value from Cloudflare Email Sending onboarding, Phase 1>
<brevo-selector>._domainkey.saathum.com.        TXT   <value from Brevo domain verification, Phase 2>
```
Do not fabricate placeholder values in real DNS — an invalid DKIM record is
worse than none (it makes the domain look configured when signature
verification will simply fail). Fill these in only from each provider's
dashboard once Phase 1 / Phase 2 are actually run.

#### 4.3 MX — provider-issued (Cloudflare Email Sending bounce handling)
```
saathum.com.   MX   <priority>   cf-bounce.saathum.com.
```
Exact priority/value confirmed at Phase 1 onboarding (mirrors
`cf-bounce.avatok.ai` on the existing domain). If Phase 3's Email Routing
also wants MX records on the same zone, confirm with Cloudflare's current
docs whether Email Sending's bounce MX and Email Routing's inbound MX
coexist on the apex without conflict before publishing either — this was
not a question PLAN-2026-09-11 had to answer because `avatok.ai` did not
also need inbound routing set up in that pass.

#### 4.4 DMARC (root TXT) — drafted, ours to choose, start conservative
```
_dmarc.saathum.com.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc-reports@saathum.com; fo=1; adkim=r; aspf=r"
```
- **`p=none` to start, deliberately.** A brand-new sending domain with zero
  sending history should not start at `p=reject` — any misconfigured lane
  (and this batch touches a dozen send sites at once) would silently drop
  real mail with no visibility. `p=none` still gets you aggregate reports
  (`rua`) so you can see what's failing before enforcing anything.
- Ramp path (do in order, each after a clean reporting period with no
  unexplained failures): `p=none` → `p=quarantine; pct=25` → `pct=100` →
  `p=reject`. This mirrors standard DMARC rollout practice; there is nothing
  Saathum-specific about the ramp itself.
- `rua=mailto:dmarc-reports@saathum.com` needs that inbox to actually exist
  — either fold it into Phase 3's routing rule or point it at a mailbox the
  team already monitors (e.g. the same destination `support@` forwards to).
  **Do not publish this record with an address nobody reads** — an
  unmonitored `rua` defeats the entire point of starting at `p=none`.
- `avatok.ai` has no DMARC record in this repo's history (§1) — if the owner
  confirms one exists live, that policy (not this draft) is the one to
  match for consistency across both domains, and this section should be
  updated to say so rather than silently diverging.

### Phase 5 — Verification test pass · after Phase 1–4
Repeat PLAN-2026-09-11 Phase 0 step 4 for the new domain: one test send via
Cloudflare, one via Brevo (temporarily force the policy or use each
provider's own test-send tool), confirm DKIM=pass **and** DMARC=pass **and**
SPF=pass in the received raw headers for both. Do this before any code
change reaches a live environment — this is the gate, not `astro build` or
`tsc --noEmit`, neither of which can catch a deliverability failure.

### Phase 6 — Staging cutover · mirrors PLAN-2026-09-11 §4 Phase 2
1. `consumers/wrangler.toml` `[env.staging]` already carries the drafted
   `EMAIL_FROM_DEFAULT = "Saathum <noreply@saathum.com>"` (this lane's
   diff) and staging is already hard-capped to
   `hdavy2005@gmail.com`-only sends via the existing destination allowlist
   pattern (PLAN-2026-09-11 §3.4) — this is the correct, low-risk place to
   prove the new domain sends before touching prod, exactly as the
   `[SAATHUM-EMAIL-1]` comment on that line says.
2. Run the same staging journey PLAN-2026-09-11 Phase 2 specifies (OTP,
   invite, booking confirmation + ICS, commercial confirmation, payout
   status, receipt) but now checking the `From:` header reads
   `saathum.com` and still passes authentication.
3. Force a fallback the same way (bad `from` domain → `E_SENDER_NOT_VERIFIED`
   → Brevo takes over) to prove the fallback path is *also* verified for
   the new domain, not just the primary — this is the scenario §0.2 warns
   about.

### Phase 7 — Prod cutover, per lane · mirrors PLAN-2026-09-11 §4 Phase 4 watch order
Same watch order as the original plan, but re-run for the new domain instead
of assumed from the old domain's track record:
1. Ops alerts (`recon.ts`) first — internal-only, lowest blast radius.
2. **Email OTP (`routes/id.ts`) and invites next, watched closely** — OTP is
   flagged separately in §4 below as the highest-risk send in the batch;
   treat its `fallback_used` rate and any `E_SENDER_NOT_VERIFIED` /
   `E_RATE_LIMIT_EXCEEDED` log lines as a stop-the-rollout signal, not just
   something to note.
3. Receipts, payout status, booking matrix + ICS (verify calendar
   attachments render identically in Gmail/Outlook/Apple Mail from the new
   sender).
4. Commercial confirmations last (money lane).
5. Web (`sendMail.ts` via `contact.ts` / `careers-apply.ts` / `waitlist.ts`)
   deploys only through the GitHub web-deploy workflow, never a local Pages
   deploy — a local deploy ships without the Clerk key and breaks sign-in
   (CLAUDE.md, SPEC, and PLAN-2026-09-11 §4 Phase 4 all say this
   independently; it is not new to this plan).

Rollback at any point: flip `EMAIL_FROM_DEFAULT` back to the `avatok.ai`
address and redeploy consumers — the code takes the sender from that one var
plus the literal `from:` strings this lane changed, so rollback is a revert
of this lane's commit plus a redeploy, not a data migration.

### Phase 8 — Delivery-events resubscription
PLAN-2026-09-11's implementation log recorded that **Cloudflare allows only
one event subscription per sending domain** — the existing `email-events`
subscription is bound to `avatok.ai`. Onboarding `saathum.com` needs its
**own** event subscription (source Email Sending, domain `saathum.com`,
same event types: `message.delivered/.deferred/.bounced/.complained/.rejected`)
pointed at the same `email-events` queue (or a new one) before
`consumers/src/email_events.ts` will see any delivery/bounce data for the
new domain — without this, `email_outbox` rows for `saathum.com` sends will
sit at `provider_accepted` forever, exactly the pre-existing gap
PLAN-2026-09-11 §5 closed for `avatok.ai`. Do this in the same pass as
Phase 1, not as an afterthought — it's cheap to add at onboarding time and
easy to forget once the domain "already works" for sending.

---

## 4. Deliverability risk — read this before touching `EMAIL_FROM_DEFAULT`

**This is the highest-risk item in the whole `saathum-20260920` batch, and it
was called out as such in this lane's brief.** Sign-in is passwordless
end-to-end: `worker/src/routes/id.ts`'s `idEmailStart` sends a 6-digit code
that *is* the login. There is no password fallback, no SMS fallback (phone
was deliberately removed as an identity gate — `routes/id.ts:203`, unrelated
to this lane but confirms the OTP email is genuinely the only door in), and
no in-app recovery path if the mail never arrives. Three concrete ways this
breaks if sequencing is skipped:

1. **Deploying the new sender before Phase 1+2 are both verified** — every
   send fails on *both* the Cloudflare primary path (`E_SENDER_NOT_VERIFIED`
   / `E_SENDER_DOMAIN_NOT_AVAILABLE`) *and* the Brevo fallback
   (sender-not-verified rejection) in the same attempt, because
   `EMAIL_FROM_DEFAULT` drives both adapters from one value
   (`consumers/src/email_provider.ts:resolvePolicy` /
   `parseSender`). PLAN-2026-09-11's whole fallback design assumes the
   *domain* is already trusted and only the *transport* might fail — a
   brand-new, unverified domain defeats that assumption for both legs at
   once. This is why the `[SAATHUM-EMAIL-1]` comments on every touched
   `from:`/`EMAIL_FROM_DEFAULT` line say not to deploy until both providers
   verify it.
2. **A brand-new domain with zero sending reputation lands in spam even when
   technically "delivered."** DKIM/SPF/DMARC passing is necessary but not
   sufficient — a domain that has never sent mail before has no reputation
   with Gmail/Outlook/etc. Phase 5–7's staged rollout (OTP watched first,
   small volume, real inboxes checked by hand — not just log lines) exists
   specifically to catch "delivered per Cloudflare, landed in spam per
   Gmail" before it reaches every user.
3. **`p=reject` too early on a young domain amplifies any DKIM/SPF
   misconfiguration into total delivery failure instead of a soft
   signal.** §4.4's `p=none`-first ramp exists for this reason specifically
   for the OTP lane — a `p=reject` DMARC policy plus one wrong DKIM selector
   would mean 100% of login codes silently vanish with no forwarding
   provider fallback (unlike a marketing send, there's no "check spam
   folder eventually" grace period when the user is mid-signup).

**Recommendation to the coordinator:** do not fold `EMAIL_FROM_DEFAULT`'s
flip into the same deploy as the rest of the Saathum rename merge. Ship the
code from every lane together (templates, flags, taxonomy, UI), but hold
prod's `EMAIL_FROM_DEFAULT` at the `avatok.ai` value — reverting just that
one line back at merge time if needed — until Phase 0–5 above are
independently confirmed done, then flip it as its own deploy per Phase 7.
Staging can and should run ahead on `saathum.com` (Phase 6) since it is
already destination-capped to the owner's own inbox and cannot leak to real
users.

---

## 5. Web base URL — explicitly NOT bundled into this plan

`worker/src/cal/emails.ts:webBase()` and `worker/src/lib/agent_live/emails.ts:webBase()`
both fall back to `https://saathum.com` when `env.WEB_BASE_URL` is unset —
and no `WEB_BASE_URL` var is set today, so that fallback **is** the live
value once deployed. `consumers/src/calendar.ts` goes further and hardcodes
`https://saathum.com` directly with no env-var escape hatch at all. Every
join/booking/live-room link this batch of files emails resolves through one
of these two mechanisms.

This is a **separate and larger cutover than the email sender domain**: it
requires the Saathum web app to actually be live and routable at
`saathum.com` (lane 06's frozen `avatok.ai` snapshot and lane 09's web-UI
work are the relevant pieces, not this lane). Sequencing risk: if the sender
domain (this plan) goes live before the web app is reachable at
`saathum.com`, every email this batch sends will *deliver successfully* and
then contain a **dead link** — arguably worse than a bounce, because the
user has no signal anything is wrong until they click. **Do not treat "email
sends now" as proof "the join link works" — check both independently before
any prod cutover.**

---

## 6. Universal/App Links — explicitly NOT bundled into this plan

`worker/src/routes/invite.ts` hardcodes `https://saathum.com/download` and
`https://saathum.com/i/` (mirroring the Flutter app's `kInviteBase`) and
notes in its own comment that `saathum.com` needs its own
`apple-app-site-association` and `assetlinks.json` before these links
deep-link into the app instead of just opening a browser tab. That is
app-config + web-hosting work outside this lane's ownership (sender
domain/templates) — flagged here only so the coordinator doesn't assume the
invite flow is fully cut over once mail delivers.

---

## 7. Acceptance checklist

- [ ] Phase 0 confirmed with the owner: `saathum.com` registered, zone on
      Cloudflare, apex-vs-subdomain decision made.
- [ ] `saathum.com` verified in Cloudflare Email Sending (Phase 1).
- [ ] `saathum.com` verified as a Brevo sender/domain (Phase 2).
- [ ] `support@saathum.com` inbound routing works and forwards somewhere
      monitored (Phase 3).
- [ ] SPF, DKIM (both providers), MX, DMARC published and passing for both
      a Cloudflare-path test send and a Brevo-path test send (Phase 4–5).
- [ ] `email-events` subscription exists for `saathum.com`, not just
      `avatok.ai` (Phase 8).
- [ ] Staging journey run end-to-end on `saathum.com`, including a forced
      fallback (Phase 6).
- [ ] OTP sign-in tested by hand from a real inbox (not just log lines) on
      staging before prod (§4).
- [ ] `WEB_BASE_URL` / web-app-live status checked independently before
      assuming email links work (§5) — owned by other lanes, cross-checked
      here.
- [ ] Coordinator has NOT bundled the prod `EMAIL_FROM_DEFAULT` flip into
      the general rename merge deploy — it ships as its own sequenced
      change per §4's recommendation.
- [ ] This plan's status line updated with the actual outcome once run —
      mirrors how PLAN-2026-09-11 tracks its own implementation/deploy log.
