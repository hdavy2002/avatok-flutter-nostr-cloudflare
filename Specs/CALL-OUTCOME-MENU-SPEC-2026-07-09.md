# Call Outcome Menu ("One UI to Rule Them All") + Ava Sales Agent + Token Rename

**Date:** 2026-07-09 · **Status:** APPROVED DESIGN (owner session) · **Target:** staging
**Supersedes the caller-side outcome flows in:** PROPOSAL-AI-RECEPTIONIST.md, PROPOSAL-RECEPTIONIST-V2.md (Mode A caller UX), the "busy card vs Ava" split in CALL-MESSAGING-RECEPTIONIST-REMEDIATION-PLAN.md, and the confusing three-story sequence documented in CALL-CONDITIONS-SIMPLE-2026-07-07.md §1.
**Explicitly OUT OF SCOPE:** marketplace system, dating/matrimonial system (both exist hidden; separate projects). This spec covers only the calling UI, Ava context, rate limits, and the coins→tokens rename.

---

## 1. Core decision

Ava no longer "auto picks up." Every call that does not end in a live human
connection lands the caller on ONE server-driven menu screen — the **Call
Outcome Menu**. Same screen, same options, for all five scenarios:

| # | Scenario | Path to menu |
|---|----------|--------------|
| 1 | Callee rejects (voice) | Immediately on decline |
| 2 | Callee doesn't answer | After ring-out (`receptionistRings`, currently 4 ≈ 20 s) |
| 3 | Callee phone unreachable (no ring-ack within 6 s) | ~2 simulated rings as feedback, then menu |
| 4 | Callee phone off | Same as 3 |
| 5 | Owner has Ava-mode ("Ava handles all calls") ON | 2 real/simulated rings + "**{Name}'s Ava is answering…**" transition, then menu |
| 6 | Callee is busy (on another call) | Menu immediately, with a RED status banner "{Name} is busy on another call" above the buttons (replaces the separate busy card) |

This replaces both the current unreachable→"Ava is taking your call"→"No
answer" three-conflicting-stories flow AND the separate busy card — one menu
component for all six scenarios.

**Honest-status requirement (scenarios 2–4).** The caller must be TOLD what
happened before seeing the options — a status header above the menu:
"{Name} isn't answering" (ring-out) / "{Name}'s phone appears to be off or
unreachable" (no ring-ack). The caller HEARS the ring beeps during the
locate attempt, so they know AvaTOK tried to reach the callee; only then
does the menu appear as the feedback + options step. Busy (scenario 6) uses
the same header slot in red. Video calls get the same menu with **Talk to
Ava removed** (no video receptionist).

## 2. The menu

Rendered from server config (owner may be offline — the menu MUST NOT depend
on the callee device). UI shell/theme cached on-device for instant pop; data
(owner name, avatar, Ava availability, listings flag) hydrates from one
endpoint.

Buttons, in order:

1. **Talk to Ava** — always shown. Greyed out (with tooltip/notice) when the
   caller has used their 2 sessions today for this owner, or when
   `receptionistEnabled`/kill switch is off.
2. **Leave a voice note** — recorder starts in-place; note lands in owner's
   messenger.
3. **Leave a text note** — box slides open beneath the button; quick message.
4. **See Listings** — HIDDEN when the owner has zero PUBLIC listings.
   Opens the owner's public marketplace profile (streams, 1:1 services,
   items). NEVER shows dating/matrimonial (those are private, separate
   sidebar world). **DO NOT WIRE YET (owner 2026-07-09):** marketplace is
   still hidden — gate the button behind `callMenuListingsEnabled=false`
   so it stays invisible until marketplace goes public; navigation wiring
   is a follow-up ticket.

### Known vs stranger (options 2 & 3)

- **Known contact:** note goes straight into the existing thread; both sides
  see it as a normal voice note / message.
- **Stranger:** note is held behind the accept / decline / block gate.
  REQUIREMENT: the pending-request view must be scrollable and must NOT hide
  the note bubble — the owner can PLAY the voice note / READ the text before
  accepting. Accept opens the thread; block blocks the NUMBER (all threads),
  not just the thread.

## 3. Talk to Ava — sales agent, not answering machine

- Retrained role: 2-way conversation about what the caller wants, not
  "leave a message after the beep."
- **Context Ava gets:** owner's PUBLIC listings (so she can answer "does he
  do consultations?", pitch services, steer the caller to See Listings or a
  booking), plus owner-configured persona/business settings (who the owner
  is, what the business does). She NEVER surfaces private
  (dating/matrimonial) listings.
- **Timing: 3-minute hard budget.** Free conversation to 2:00; at 2:00 she
  enters wrap-up mode (steers to close, offers "you can also leave a voice
  note"); 2:00–3:00 is the graceful close window. No abrupt cutoff.
- **Output:** conversation summary/transcript dumped into the OWNER's
  messenger only. Nothing is sent to the caller (it was a conversation, not
  a message).
- **Caps:** 2 Ava sessions per caller-number per owner per day (protects the
  owner's token budget). Per-owner: a different owner's Ava is a separate
  allowance. After 2, the button greys out.
- Existing pipeline reused: `worker/src/routes/receptionist.ts` +
  `worker/src/do/reception_room.ts`, engine per `receptionistUseCf`.
  Honest-sequence rules from CALL-CONDITIONS report still apply ("Ava is
  taking…" only after she actually speaks; ~8 s / 2 tries → "Couldn't reach
  Ava"). If the owner picks up mid-session, Ava steps aside.

## 4. Server-driven config

New/extended endpoint (Worker; suggested `GET /api/call-menu/:number`),
served from owner config (KV/DO), returning:

```jsonc
{
  "owner": { "name": "…", "avatar": "…" },
  "avaAvailable": true,          // receptionistEnabled && kill switches && caller under daily cap
  "avaSessionsLeftToday": 1,     // for greying out client-side
  "hasPublicListings": true,     // drives See Listings visibility
  "transition": "ava|missed|declined|unreachable" // copy variant for the header
}
```

Client caches the shell; fetch happens in parallel with the ring/transition
so the menu appears without a loading spinner.

## 5. Rate limits — flags in `config.ts` DEFAULTS

All numeric, KV-overridable, no build needed to tune:

| Flag | Default | Meaning |
|------|---------|---------|
| `callMenuEnabled` | staging: true / prod: false | master kill switch for the whole outcome menu |
| `callMenuListingsEnabled` | false | See Listings button — stays OFF until marketplace goes public |
| `callMenuRateLimitEnabled` | true | master switch for the limits below |
| `avaSessionsPerCallerPerDay` | 2 | Talk-to-Ava cap (owner decision) |
| `strangerVoiceNotesPerDay` | 5 | per stranger-caller per owner per day |
| `strangerTextNotesPerDay` | 10 | per stranger-caller per owner per day |

Known contacts: unlimited notes. Enforced server-side (DO counter keyed
`caller#owner#yyyymmdd`); client greying is cosmetic only. Remember the KV
overrides-only rule: DEFAULTS in `worker/src/routes/config.ts` is the source
of truth; never re-materialize the full blob.

## 6. Wallet: AvaCoins → Tokens

- **Rename** the coin unit to **tokens** everywhere (app UI, worker routes,
  ledger copy, storage-overage language in the rulebook). 1 token = 1¢ USD.
- **Beta grant:** 1,000 tokens/user/month (=$10), funded by us.
- **Ava call pricing:** 3 tokens/min (3¢/min), charged to the OWNER whose
  Ava takes the call. 1,000 tokens ≈ 333 Ava-minutes ≈ ~110 max-length
  sessions/month; the 2/day-per-caller cap prevents single-caller drain.
- Touch points (from code graph): `worker/src/do/wallet.ts`,
  `worker/src/routes/wallet.ts` (`walletOp`, `transferCoins`,
  `creditTopup`, `walletBalance`), `worker/src/feature_pricing.ts`
  (`featureCost`, `chargeFeature` — add/rename Ava-receptionist per-minute
  entry), `worker/src/ledger.ts`, `worker/src/money_engine.ts`,
  `app/lib/features/wallet/wallet_screen.dart`, storage quota copy in
  `worker/src/routes/media.ts` / `storage.ts`.
- Migration note: internal identifiers can stay (`transferCoins`) if risky
  to rename; the USER-FACING unit, values, and docs must say tokens.
  Decide during implementation whether to rename ledger row labels or map
  at display time (display-time mapping is safer for existing rows).
- **Monthly grant: RESET, no rollover (beta).** Balance tops back up to
  1,000 on the monthly cycle; unused tokens do not accumulate. Mechanism
  (cron vs lazy top-up on first wallet read of the month) decided at
  implementation — lazy top-up recommended (no fleet-wide cron spike).

## 7. Telemetry (PostHog, per project rules)

Events (all with user email/phone): `call_menu_shown` (scenario, owner),
`call_menu_option_selected` (option), `ava_session_started/ended` (duration,
tokens charged, wrap-up reached?), `ava_session_capped`,
`stranger_note_left` (voice|text), `stranger_note_rate_limited`,
`listings_opened_from_call_menu`.

## 8. Open items — RESOLVED (owner 2026-07-09)

1. Busy card → YES, folded in as scenario 6; red "busy" banner above the
   buttons, then the same menu.
2. Token grant → RESET monthly in beta, no rollover.
3. Video calls → YES, same menu minus Talk to Ava.
4. See Listings → do NOT wire yet; button gated behind
   `callMenuListingsEnabled=false` until marketplace goes public. Ava's
   listings-context wiring is likewise deferred with it.
5. Copy/i18n per-scenario transition headers → confirmed requirement
   (isn't answering / phone off / busy / Ava answering / declined).

Remaining implementation-time details: grant mechanism (lazy top-up vs
cron), ledger label rename vs display-time mapping.

## 9. Decisions log (owner, 2026-07-09)

- One UI for all non-answered call outcomes; Ava never auto-picks-up.
- 2 rings of feedback before the menu in Ava-mode/unreachable cases.
- Button renamed "Talk to Ava"; always visible. See Listings hidden at zero
  public listings.
- Ava = sales agent + receptionist; knows public listings + owner persona;
  3-min budget with wrap-up at 2:00; summary to owner only.
- 2 Ava sessions/caller/owner/day; notes rate-limited (5 voice / 10 text
  for strangers) via flags from day one.
- Coins → tokens; 1 token = 1¢; 1,000/month beta grant; Ava = 3 tokens/min.
- Dating/matrimonial: private duplicate of marketplace, own sidebar,
  never public, never in Ava's pitch — NOT part of this project.
- Verification: existing liveness + OTP onboarding is sufficient gating.
- Busy folded into the menu (scenario 6, red banner). Honest status header
  + audible ring beeps before the menu in scenarios 2–4.
- Token grant resets monthly in beta (no rollover).
- Video calls get the same menu minus Talk to Ava.
- See Listings button NOT wired yet (`callMenuListingsEnabled=false`).
