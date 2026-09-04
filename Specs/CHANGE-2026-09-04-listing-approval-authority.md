# CHANGE RECORD 2026-09-04 — Listing approval authority

**For independent review.** Everything below shipped to **PRODUCTION**. Line numbers were read
out of the files at `e369ea6b`, not from memory. Where I am uncertain, I say so — please attack
those parts first.

| | |
|---|---|
| Commits | `fa44bc21` then `e369ea6b`, both on `main`, both pushed |
| Base before this work | `a5f996ec` |
| Worker versions deployed | `ce390381-b3f2-48f3-8494-4929095f7589`, then `aef3b590-11e0-45e1-ba09-000486cb02b3` |
| Web deploy | run `33891303875`, conclusion `success`, on `fa44bc21` |
| Prod D1 migration | `worker/migrations/2026-09-04-listing-reviewed-version.sql`, **applied to `DB_META`** |
| Driving audit | `Specs/AUDIT-2026-09-04-listing-pipeline-join-pricing.md` (3 cross-review rounds) |

---

## 0. The context a reviewer needs first

**avaTOK's paid marketplace is LIVE in production.** All six commercial flags are `true`, plus
`marketplaceEnabled`, `marketplacePublishEnabled`, `listingFeeEnabled`,
`posterAutoGenerateOnSubmit`, `freeSessionsEnabled`, `shellV2`. `listingPublishKycRequired` is
**false**.

This matters because **two independent reviewers (me and an external Codex reviewer) both got
this wrong** by reading `DEFAULTS` in `worker/src/routes/config.ts` instead of production. Every
severity call in the first audit was wrong as a result — defects that read as future risk were
live and sellable. Verify with:

```bash
curl -s -H 'Cache-Control: no-cache' "https://api.avatok.ai/api/config?cb=$RANDOM"
```

The comment at `web/src/lib/getstream.ts:88` claiming "all six commercial flags are false in
production as of 1 Sep 2026" is **stale and false**. It was not fixed in this change; it should be.

Money rails are separately still off (`walletRealMoney`, `billingEnabled`, `gstEnabled` all
false), so the defects below were reachable but no real money moved.

---

## 1. What was broken (all four live and reachable)

**C01 — the approval gate had a side door.**
`setListingStatus` validated the TARGET status and rejected only a SOURCE of `draft`. So
`pending_review → live`, `rejected → live`, `approved → live`, `completed → live` and
`cancelled → live` all reached a raw `UPDATE`. Checkout (`commercial_checkout.ts:366`) and join
(`commercial_stream_sessions.ts:553`) both accept `live`. **A rejected listing was sellable.**
The same branch also allowed `→ draft` from any status, letting a creator launder a rejection.

**C03 — two publish doors behaving differently.**
`adminListingAction` published with a raw `UPDATE`, running none of the creator-path validations
or side effects. Consequences: admin-published listings were never `ftsSync`'d, so they were
**un-searchable by name** (`exploreSearch` hard-returns empty on an FTS miss; browse still
worked), and the admin write had no cover cap so a poster + 5 uploads = 6 covers could ship.

**C02 — approval not bound to reviewed content.**
`attrs` was accepted wholesale from creators while admin publish trusted `attrs.poster.status` —
a creator could forge poster approval. Separately, `updateListing` never touched `status`, so a
creator could get a listing approved and then rewrite title, price, category and photos with the
approval still attached.

**Free entry ungated.**
`free_entry` was a plain creator-settable boolean with no role check, exposed as a checkbox to
every creator, while `freeSessionsEnabled=true` in prod. Free sessions have **no mid-session
cut-off** — `free_session.ts` is an admission-time headcount ceiling plus a settlement clamp, so
an overrunning stream's cost is absorbed by the platform.

---

## 2. What was built

### `worker/src/lib/listing_transitions.ts` (new, pure, 45 unit tests)

The single authority on `(from, to, actor)`. `TRANSITIONS:110` is pure data; `checkTransition:178`
and `allowedTargets:209` only read it.

- `live` is reachable **only** via actor `system` + `provider_confirmed`. No creator or admin row
  targets it, and a test asserts that property across the whole table.
- `cancelled|completed → draft` **is** allowed for the creator — archive restore is a real shipped
  feature and an earlier version of this table would have 409'd it. The terminal check therefore
  runs *after* the table lookup, not before.
- Three `system` rows added later for review invalidation (§2.4).

### `worker/src/lib/free_entry_gate.ts` (new)

`freeEntryAllowed(env, cfg, uid):37`. Gated by config key `freeEntryAllowlistOnly`, **default
`true`, fail closed**. Allowed iff uid ∈ `ADMIN_UIDS` or ∈ `FREE_ENTRY_ALLOWLIST`.
`ADMIN_UIDS` contains exactly one uid, `user_3AuqQadIDHJftJtTkLD0DtKM8MB`, which is the owner's
test account `hdavy2002@gmail.com` (confirmed via PostHog `clerk_uid`), so no separate allowlist
is set today. Surfaced per-user as `free_entry_allowed` on `GET /api/listings/mine`
(`listings.ts:2157`), consumed by the wizard.

### `publishListingAuthoritative` — `listings.ts:1781`

One publisher, called by both doors. `publishListing` is now a thin HTTP wrapper;
`admin_listings.ts:238` calls the same function. **Every identity and money check is keyed on the
listing's creator, never the reviewing admin** — an admin publishing must not spend their own
wallet or have their own KYC checked.

### `systemMarkListingLive` — `listings.ts:2139`, wired at `commercial_stream_sessions.ts:1706`

Carries the "is LIVE now" follower fanout that used to fire on the closed bypass.

⚠️ **A proposed call site was rejected and this is worth checking.** `commercialLiveGoLive`
(~1157) only moves the session to `backstage` (`runControl` at ~1121:
`args.action === "go_live" ? "backstage" : "ending"`), never to `live`, with no provider
confirmation. Wiring there would have let a creator flip their listing live without the provider
confirming — re-opening the bypass. It is instead called from the provider-signature-verified
`recordCommercialStreamEvent`, gated on `callType === "avatok_livestream"` and on a `wasLive`
snapshot taken **before** the state UPDATE (`:1684`), because that UPDATE's
`WHERE state IN ('scheduled','backstage','live')` also matches a replayed webhook, so
`.meta.changes` alone cannot distinguish a real transition from a redelivery.

### C02 — review binding

- Migration: `reviewed_content_hash TEXT`, `reviewed_at INTEGER`, `reviewed_by TEXT`. **Applied to
  prod**; all three confirmed via `pragma_table_info`.
- `reviewedContentHash:950` — SHA-256 over a key-sorted serialisation of
  `REVIEW_MATERIAL_FIELDS:923` plus `attrs` minus `RESERVED_ATTRS_KEYS:238`.
  **Included:** title, description, category, price, currency_display, cover_media, starts_at,
  duration_min, capacity, free_entry, creator-owned attrs.
  **Excluded:** `attrs.poster`, `status`, counters, timestamps — a poster regeneration or a
  view-count bump must not invalidate a review.
- `sanitizeCreatorAttrs:246` strips `poster` from creator input and splices the server's stored
  value back, so a creator can neither forge nor erase it.
- On a material edit: `approved → pending_review`; `published`/`live` with **no** sold
  entitlements → `pending_review`; `published`/`live` **with** sold entitlements → **409
  `material_edit_blocked_sold_out`**. `hasSoldEntitlements:973` returns `true|false|null` and any
  non-`false` (including the unverifiable `null`) refuses. Stranding a paying buyer is worse than
  refusing an edit.

**One thing was rejected in review and a reviewer should confirm it stayed rejected.** The first
implementation called `checkTransition`, received a refusal (no rule existed for
`approved|published|live → pending_review`), recorded `transition_table_has_rule: false`, and
**wrote the status anyway via a literal SQL fragment.** That is the same "two authorities" shape
that made `setListingStatus` a bypass. Three `system` rows were added to the table instead, and
the code now refuses the entire edit with 409 `material_edit_blocked_no_transition_rule` if
`checkTransition` ever says no. Tests assert creator and admin can **never** trigger that
demotion — otherwise a creator could bounce their own published listing back into the queue to
dodge a hold or a report.

---

## 3. Verification actually performed

| Check | Result |
|---|---|
| `worker` `tsc --noEmit` | clean |
| `web` `tsc --noEmit` | clean |
| `vitest run` | 762 tests, **722 pass**, 40 fail |
| `check_design_guard.py --check all` | within baseline (170/211 colours, 0/0 icons), baseline untouched |
| `check_ship_readiness.py --check flags` | OK, 0 contract gaps |
| `--check manifest` | both new entries accepted |
| `--check telemetry` | **SKIPPED** — no `POSTHOG_PERSONAL_API_KEY`. Not a pass. |

**The 40 failures are pre-existing.** Proven, not assumed: the suite was run at `HEAD` in a clean
`git worktree` and produced the same 8 files and same 40 tests
(`wallet_reservation_policy`, `ai_billing_accrual`, `song_quick_mode`, `spam/scoring`,
`paytm_checksum`, `native_decline_contract`, `ava_job_presence_contract`,
`human_call_usage_billing`). This change added 33 + 12 + 19 passing tests and no new failures.
**Those 40 are still broken and nobody is fixing them.**

---

## 4. 🚨 NOT VERIFIED — the most important section

**Production behaviour has not been verified.** Deployment, config propagation (3 cache-busted
probes) and schema are confirmed. Behaviour is not.

A PostHog query over the last day returns **zero events for every new event name**, and the
project taxonomy reports all of them as never-before-seen — consistent with a fresh deploy nobody
has exercised. Per this repo's own ship-gate rule, a green deploy is not proof.

Success values are declared in `tool/ship_manifest.json` under `LIST-APPROVAL-AUTH-1` and
`LIST-REVIEW-BINDING-1`. The manual test that would close this out:

1. Create a listing, submit for review → expect `listing_submitted_for_review`
2. Reject it from admin → then as creator attempt `POST /api/listings/:id/status {status:"live"}`
   → expect **409** with `reason: "live_is_provider_confirmed"`
3. Publish one from the admin screen → expect `admin_listing_published` with `ok: true`, and the
   listing findable by **typing its title** in search (this is the `ftsSync` fix)
4. Approve a listing, then change its price → expect it back in `pending_review`
5. Approve + publish + sell a ticket, then change the price → expect **409**
   `material_edit_blocked_sold_out`
6. As a non-admin creator, confirm no free-show checkbox; as admin, confirm it is present

---

## 5. Known gaps, deliberately not fixed

1. **`web/src/islands/admin/*` still has zero PostHog.** Queue latency now exists server-side
   (`queue_ms` on `admin_listing_published`) but reviewer click behaviour is still invisible.
2. **The 6-cover state's root cause is untouched.** `lib/listing_poster.ts:132-136` prepends the
   AI poster with no cap. Both publish doors now reject the result; the producer still creates it.
3. **`avavision_agents` is a second, entirely unmoderated publish pipeline** (`avavision.ts:665`)
   and is not covered by any of this.
4. **`getstream.ts:88`'s false production claim** was not deleted.
5. **`parseUidList` now has 7 near-identical copies** — this change added the 7th rather than
   reaching across a file-ownership boundary during parallel work. It should be consolidated.
6. **No price ceiling**, no consult duration validation, no recurring past-date check.
7. **Creator photos are still never gated on moderation status**, and `cover_media` still accepts
   any `https://` URL including off-site images that are never scanned.
8. **`shellV2: true` in prod ships AskAva with no kill switch**, contradicting
   `PIVOT-2026-08-27`. Out of scope here, but live.

---

## 6. Where I am least confident — please attack these

1. **The go-live call site.** I am confident `commercialLiveGoLive` was wrong. I am *less* certain
   `recordCommercialStreamEvent`'s `session_started`/`live_started` branch is the only place a
   session truly becomes live. If another path sets `state='live'`, the listing will silently
   never project and no follower notification will fire.
2. **`wasLive` as the idempotency guard.** It is read before the mutation in the same request. I
   have not proven it is safe against two concurrent webhook deliveries racing.
3. **The material-field list.** `REVIEW_MATERIAL_FIELDS:923` is a judgement call. If it is too
   broad, trivial edits will spam your review queue. Too narrow, and a creator can change
   something a reviewer cared about without re-review. `slug`, `blurb`, `video_url` and
   `vibe_tags` were **excluded** — arguably `video_url` should not be.
4. **Demoting a `live` listing.** `system_review_invalidated_live` allows `live → pending_review`
   when nothing is sold. A stream may be mid-broadcast. The session is the source of truth and
   should continue, but this interaction is untested.
5. **`hasSoldEntitlements` returning `null`.** It fails closed (refuses the edit). On an
   environment where `commercial_entitlements` does not exist, *every* material edit to a
   published listing is refused. That is safe but could look like a total outage of editing.
6. **Nothing tests the HTTP layer.** All 45+19 new tests are pure-function tests of the
   transition table and the hash. There is **no test** that `setListingStatus` actually refuses a
   `rejected → live` request end to end, nor that `publishListingAuthoritative` charges the
   creator rather than the admin. That is the single biggest testing gap in this change.

---

## 7. Operational note

A subagent ran `npm install` inside the Linux sandbox, which shares `worker/node_modules` with the
macOS host through a mount. It stripped `@cloudflare/workerd-darwin-arm64/bin`, breaking
`wrangler` on the host and blocking the migration mid-ship. Recovery is
**`npm ci --include=dev`** — plain `npm ci` makes it worse, because this machine has
`npm config omit=dev` set globally and silently drops wrangler and vitest entirely.
`package.json` and `package-lock.json` were verified unchanged afterwards.


---

## 8. Codex remediation — 2026-09-05

Claude's follow-up and Codex's independent review identified eleven production gaps in the
original two commits. They are remediated by:

| Item | Result |
|---|---|
| Code commit | `0f599a31` — `[LIST-APPROVAL-GAPS-1] Close listing authority gaps` |
| Deploy-path fix | `85f75754` — `[LIST-DEPLOY-GATE-1] Fix Worker migration paths` |
| Web run | [33906492556](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/33906492556), success |
| Pages artifact | `https://7fddd07f.avatok-app.pages.dev` (custom domain probe `avatok.ai` returned 200) |
| Worker run | [33906663871](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/33906663871), success |
| Worker version | `1419d16a-6b9e-45a8-8a5e-08340d637c4f` |
| CI validation | Worker typecheck clean; 5 focused files / 56 tests passed |
| D1 | reviewed hash columns present; authority/publication revisions present; lifecycle projection tables and trigger applied |

The first Worker attempt, run
[33906509574](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/33906509574),
passed validation and applied the additive authority columns, then stopped before deploy because
the lifecycle migration path was relative to the repository while `cf.sh` runs Wrangler from
`worker/`. Commit `85f75754` corrected both affected workflow paths. The successful rerun
confirmed the column runner was idempotent and completed the remaining migration and deploy.


The remediation closes the review findings as follows:

- Publication now requires approved status, approved poster, a non-null matching reviewed-content
  hash, current free-entry authorization, and a final status/version/hash compare-and-swap.
- Every listing update receives an optimistic authority revision. Creator edits, submissions,
  moderation actions, status changes, cancellation and both publication doors use conditional
  writes. Sold-entitlement checks read the primary D1 authority.
- Legacy approved rows can be explicitly rebound by an admin. A material edit on a legacy
  approved/published/live row invalidates review; unchanged saves do not manufacture approval.
- Creator attrs strip `poster` and every `__*` key. Poster generation uses request-local media,
  enforces available cover capacity before generation, retries a revision-only race, and cron
  resets interrupted `generating` attempts.
- AI compose creates `pending_review`, writes approval history, strips internal attrs and charges
  no listing entitlement. Flutter copy now says “Submit for review”; the app change is committed
  but no Android build was requested or triggered.
- GetStream livestreams become public only on `live_started`; provider responses cannot regress
  a webhook-confirmed live session to backstage. The signed Cloudflare lifecycle webhook fails
  closed when its secret is absent and rejects timestamps older than five minutes.
- Published/search, follower fan-out, live/completed listing projections, ticket-holder start/end
  notices, and interrupted poster state all have idempotent scheduled repair. Publication-cycle
  numbers prevent a restore/re-publish from suppressing a legitimate later notification.
- The review hash now includes the full editable public/reviewer-visible substance except slug and
  derived section. The web wizard lets a locked legacy free listing turn free entry off.

This update verifies deployment mechanics and unauthenticated health only. It does not claim that
the authenticated manual scenario list in section 4 has been exercised against a production user.
