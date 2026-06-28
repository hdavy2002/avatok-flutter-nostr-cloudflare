# AvaTOK Team Receptionist (IVR / Auto-Attendant) — Design Spec

**Status:** DRAFT for owner review · **Date:** 2026-06-28 · **Owner:** Davy
**Depends on / reuses:** `Specs/AVATOK-NUMBER-FEATURE-SPEC.md`,
`Specs/PROPOSAL-RECEPTIONIST-V2.md`, the AI Receptionist v3 rework (commit
`76c91c5`), `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md`.
**Graphiti:** `proj_avaflutterapp`.

---

## 0. One-paragraph summary

A team manager subscribes to a **Team plan**. In a new **Team** sidebar section he
adds staff by entering: *staff name, company role/department, voice, greeting, and
the staff member's AvaTOK number*. The team's own AvaTOK number becomes an
**auto-attendant (IVR)**: when anyone calls it, they hear *"You've reached Hilton —
1 for Accounts, 2 for Housekeeping…"* and see **tappable menu buttons** (these are
in-network app calls, not PSTN, so there is no telephone keypad). Tapping an entry
**rings that staff member's number** over the existing 1:1 call path. If the staffer
doesn't answer, **their own Ava receptionist takes over and takes a message**. The
message lands as a **card** on the dialed staffer's phone **and** the manager's
phone: *"Julie called from +1 302-334-8738 and left this message,"* with a **Call**
button and a **Play** button. Every staff account added to the team becomes a **Pro
account for free**, and **all their AvaTOK expenses bill to the Team plan wallet**
instead of their personal wallet.

The feature is **~90% composition of things that already ship.** New work is: a Team
data model, a thin IVR-menu layer on the team number, a billing-uid indirection, and
the message-card UI. No new realtime infra, no Nostr, no PSTN.

---

## 1. What already exists (and is reused as-is)

| Capability | Where it lives today | Reused for |
|---|---|---|
| Virtual in-network number → account resolve | `worker/migrations/avatok_numbers.sql`, `worker/src/routes/number.ts` (`me`, `assign`, resolve) | Team number + staff-number lookup |
| 1:1 P2P call signaling | `CallRoom` DO (`worker/src/do/call_room.ts`), `app/.../call_screen.dart` | Ringing the selected staffer (2-peer cap untouched) |
| "Ava answers after N rings / takes a message" | AI Receptionist v3: `worker/src/routes/receptionist.ts`, `worker/src/do/reception_room.ts`, `app/lib/core/receptionist_call.dart`, `receptionist_settings`/`receptionist_sessions` tables | Per-staff fallback voicemail; voice + greeting per entry |
| Recording → R2, transcript, summary | `receptionistRecording`, `recording_url`, `summary_json` | The **Play** button + message body |
| Coin wallet, idempotent charge | `WalletDO`, `chargeFeature(env, uid, key, opId)` (`worker/src/feature_pricing.ts`) | Team-wallet billing via a billing-uid shim |
| Subscription tiers Free/Plus/Pro/Max | `subscriptions`, `tierOf(env, uid)` | Staff auto-upgraded to Pro while on a team |
| Kill switches / config | `worker/src/routes/config.ts` (KV) | `teamIvrEnabled` master switch |
| Telemetry (email-stamped) | PostHog project 139917 | New `team_*` / `ivr_*` events |

**Design rule:** the **staff list _is_ the menu.** There is no separate "IVR builder."
The ordered list of staff entries (slot 1..9) + the team greeting render the menu.
Each entry's role/department = the button label; each entry's voice + greeting =
that department's Ava fallback persona.

---

## 2. Refinements — the better / faster / cheaper choices

These are the decisions that make this cheap to run and fast to ship (all confirmed
with the owner):

1. **Tap-menu IVR, not an AI front desk.** The team number's greeting can be plain
   **TTS or a recorded clip** + on-screen buttons. **Zero AI/LLM cost to route a
   call.** Gemini Live minutes are spent **only** when a staffer misses the call and
   their Ava takes a message — exactly when there's real value. (An AI natural-language
   "who would you like to reach?" front desk is kept as a *future* upgrade flag,
   `ivrAiFrontDesk`, off by default.)
2. **Reuse per-staff receptionist, don't build a team receptionist.** Each staffer
   already can have an Ava (v3). The team feature just *guarantees* it's on and
   pre-fills voice + greeting from the menu entry. One code path, already tested.
3. **Billing indirection, not a billing rewrite.** Add one helper,
   `billingUidFor(env, uid)`. Every existing `chargeFeature(...)` / wallet spend
   routes the charge to the **team's billing uid** when the spender is a team member,
   else to themselves. ~10-line surgical change at the charge boundary; nothing else
   in the money engine moves.
4. **Flat menu + Ava fallback** (no nested sub-menus, no hunt-groups in v1). Up to 9
   entries. Matches the mental model and ships fast. Hunt-groups / sub-menus are
   noted as v2 flags.
5. **Message card = a receptionist session + a notification.** The card is just a
   render of an existing `receptionist_sessions` row (caller_phone, summary,
   recording_url) fanned out to two subscribers. No new message store.

---

## 3. Data model (new)

All in **D1 `avatok-meta`** (same DB as numbers + receptionist). New migration
`worker/migrations/team_plan.sql`.

```sql
-- A team = one billing unit owned by the subscribing manager.
CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,          -- uuid
  owner_uid     TEXT NOT NULL,             -- the manager (subscriber)
  name          TEXT NOT NULL,             -- "Hilton"
  team_number   TEXT,                      -- the AvaTOK number that runs the IVR (FK avatok_numbers.number)
  greeting_text TEXT,                      -- "You've reached Hilton"
  greeting_clip TEXT,                      -- optional R2 key of a recorded greeting
  billing_uid   TEXT NOT NULL,             -- wallet that pays for member usage (defaults to owner_uid)
  plan_tier     INTEGER NOT NULL DEFAULT 2,-- tier granted to members (2 = Pro)
  seat_limit    INTEGER NOT NULL DEFAULT 5,
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_number ON teams(team_number) WHERE team_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_uid);

-- One row per menu entry / staff member. slot = the "press N" digit.
CREATE TABLE IF NOT EXISTS team_members (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL,
  slot          INTEGER NOT NULL,          -- 1..9 (the press-N key / button order)
  display_name  TEXT NOT NULL,             -- "Julie"
  role_label    TEXT NOT NULL,             -- "Housekeeping" (the button text + menu phrase)
  member_uid    TEXT,                      -- resolved Clerk uid of the staff account (NULL until accepted)
  member_number TEXT NOT NULL,             -- the staff member's AvaTOK number (E.164 digits)
  voice_name    TEXT NOT NULL DEFAULT 'Puck', -- Ava voice for this dept's fallback
  greeting_text TEXT,                      -- per-dept Ava opener override (optional)
  invite_status TEXT NOT NULL DEFAULT 'pending', -- pending | active | removed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_slot ON team_members(team_id, slot) WHERE invite_status != 'removed';
CREATE INDEX IF NOT EXISTS idx_team_members_uid ON team_members(member_uid);
CREATE INDEX IF NOT EXISTS idx_team_members_number ON team_members(member_number);

-- Fast lookup: which team (if any) does a uid belong to, and who pays.
CREATE TABLE IF NOT EXISTS team_billing_map (
  member_uid  TEXT PRIMARY KEY,            -- staff uid
  team_id     TEXT NOT NULL,
  billing_uid TEXT NOT NULL,               -- = teams.billing_uid (denormalized for O(1) charge-time read)
  updated_at  INTEGER NOT NULL
);
```

**Why `team_billing_map` is denormalized:** `billingUidFor()` runs on the hot path of
*every* paid feature charge. A single PK lookup keyed by uid keeps it ~free. It's
written whenever a member is added/removed.

---

## 4. Call-routing flow (end to end)

```
Caller taps the team's AvaTOK number
        │
        ▼
[1] GET /api/team/ivr?number=<team_number>      (PUBLIC-ish, rate-limited)
    → { team_name, greeting_text|greeting_clip, entries:[{slot, role_label, available}] }
        │
        ▼
[2] App plays greeting (TTS of greeting_text, or the clip) and shows tap buttons
    "1 Accounts · 2 Housekeeping · 3 …"      ← NO AI, NO call connected yet
        │  caller taps slot N
        ▼
[3] Resolve entry N → member_number → existing number→uid resolve
        │
        ▼
[4] Place a normal 1:1 call to that staffer via CallRoom DO  (unchanged path)
        │
        ├── staffer answers ───────────────► normal call. Done. (cost: $0 routing)
        │
        └── no answer after N rings / busy / declined
                    │
                    ▼
        [5] Staffer's Ava receptionist starts (receptionistStart) with:
              owner_uid   = member_uid
              voice       = entry.voice_name
              greeting    = entry.greeting_text (or team default)
              caller_phone/name carried through
            → ReceptionRoom DO ↔ Gemini Live, 55s soft / 70s hard cap (v3 rules)
            → records to R2, writes receptionist_sessions row (+ summary_json)
                    │
                    ▼
        [6] On session end → fan out a MESSAGE CARD to:
              • the dialed staffer (member_uid)
              • the team manager (teams.owner_uid)
            via the existing notify path (/api/notify, name+preview fan-out)
```

**Key point:** steps 1–4 add **no** AI cost and reuse the number-resolve + CallRoom
paths verbatim. Only step 5 (a real missed call) costs Gemini Live minutes, billed
to the **team** wallet.

### IVR availability nuance
An entry shows as greyed/"unavailable" when `member_number` has no active mapping or
the member's `invite_status != 'active'`. Tapping a greyed entry routes straight to
the team's default Ava (manager's voicemail) so a caller is never dead-ended.

---

## 5. The message card

Rendered from one `receptionist_sessions` row; no new storage. Card contents:

```
┌─────────────────────────────────────────────┐
│  ☎  Julie · Housekeeping                      │
│  Called from +1 302-334-8738 · 2:14 PM        │
│  "Hi, I'm in room 412, the AC isn't working   │
│   and I'd like someone to come up before 5."   │  ← summary_json.message / transcript
│                                               │
│   [ 📞 Call back ]      [ ▶ Play (0:38) ]      │
└─────────────────────────────────────────────┘
```

- **Call back** → 1:1 call to `caller_phone` (or caller_uid if in-network) via CallRoom.
- **Play** → streams `recording_url` (R2) of the voicemail/conversation.
- **Recipients:** dialed staffer + manager (confirmed). Stored as a small
  `team_message_recipients` fan-out, or simpler: tag the `receptionist_sessions`
  row with `team_id` + `member_slot` and let each recipient query
  `GET /api/team/messages` filtered by their uid (manager sees all team rows; staff
  see their own). **Recommend the query approach** — no extra table, manager gets the
  whole team inbox for free.

Add columns to `receptionist_sessions` (nullable, backward-compatible):
`team_id TEXT`, `team_slot INTEGER`.

---

## 6. Billing consolidation

### Mechanism
One new helper, called at the single charge boundary:

```ts
// worker/src/team_billing.ts
export async function billingUidFor(env: Env, uid: string): Promise<string> {
  const row = await metaSession(env)
    .prepare("SELECT billing_uid FROM team_billing_map WHERE member_uid=?1")
    .bind(uid).first<{ billing_uid: string }>();
  return row?.billing_uid ?? uid;   // own wallet if not on a team
}
```

Then `chargeFeature` (and any direct `walletOp` spend for AI/voice/receptionist)
charges `await billingUidFor(env, uid)` instead of `uid`. The **op_id stays keyed to
the originating member + action**, so audit trail still shows *who* spent, while the
*money* leaves the team wallet. Ledger double-entry and recon are unaffected (same
code, different payer uid).

### Tier entitlement
- On add: write `team_billing_map`, set the member's effective tier to
  `teams.plan_tier` (Pro). Implement as a **team-membership override** read by
  `tierOf(env, uid)` (check membership → return `max(personalTier, teamTier)`), so we
  don't mutate the member's real subscription and can cleanly revert.
- On remove: delete `team_billing_map` row, `invite_status='removed'`, free the slot.
  Member drops back to their personal tier; their wallet pays again.

### Edge cases (must handle)
- **Team wallet empty / over quota:** mirror the existing rule — AI features become
  read-only for members; **never delete** anything; manager is notified to top up.
- **Member already paying for Pro personally:** team membership supersedes for the
  duration; on removal they keep whatever personal sub they still have.
- **Personal vs team spend split:** v1 = *all* member AvaTOK expenses bill to the
  team while active (owner's stated intent). A future flag `teamBillsAiOnly` could
  scope it to AI/voice only.
- **Manager removes a member mid-call:** in-flight session finishes on the team
  wallet (op already issued); next action re-resolves to the member's own wallet.

---

## 7. UI (Flutter)

All per-account local state **must** be scoped via `scopedKey`/`AccountScope`
(rulebook rule 1). New screens under `app/lib/features/team/`.

**Manager side (Team sidebar section):**
- *Team home:* team name, team AvaTOK number (assign/buy via existing number flow),
  greeting (text + "record greeting"), seat usage, team wallet balance + top-up.
- *Add staff* sheet: **Name · Role/Department · Voice (30-voice picker reused from
  receptionist v3) · Greeting · AvaTOK number.** Saving sends an invite to that
  number's account.
- *Menu preview:* live "press 1 / press 2…" list, drag to reorder slots.
- *Team inbox:* all message cards across the team.

**Staff side:**
- *Invite accept:* "Davy added you to the Hilton team — you're now Pro, paid by the
  team." Accept → `invite_status='active'`, Ava auto-enabled with the assigned voice.
- *Messages:* their own message cards (Call / Play).
- A small "Pro · billed by Hilton" badge on their account/settings.

**Caller side (already mostly there):**
- When dialing a number that is a `team_number`, the call screen renders the **IVR
  menu** (greeting + tap buttons) instead of a direct ring. Everything after a tap is
  the existing call/receptionist UI.

---

## 8. API surface (new routes, Worker `avatok-api`)

```
# Manager
POST   /api/team                    create team (name) → assigns billing_uid=owner
PUT    /api/team/:id                name, greeting_text, greeting_clip, team_number
GET    /api/team/:id                team + members + seat usage
POST   /api/team/:id/members        add {display_name, role_label, member_number, voice, greeting}
PUT    /api/team/:id/members/:mid   edit / reorder slot
DELETE /api/team/:id/members/:mid   remove (revert tier + billing)
GET    /api/team/:id/messages       team inbox (manager: all; staff: own)

# Staff
POST   /api/team/invite/accept      {team_id} → active, Ava on, tier override
POST   /api/team/invite/decline

# Caller (IVR)
GET    /api/team/ivr?number=<n>     menu payload (greeting + entries + availability)
POST   /api/team/ivr/route          {number, slot} → returns target member_number to dial
```

All gated by `teamIvrEnabled` KV flag. `requireUser` on everything except the IVR
read, which is rate-limited and returns only public menu labels (never raw staff
numbers — `ivr/route` returns the dial target after a real tap).

---

## 9. Telemetry (PostHog 139917, email-stamped)

New events (each carries user email + team_id): `team_created`, `team_member_added`,
`team_member_accepted`, `team_member_removed`, `ivr_menu_shown`, `ivr_slot_tapped`
(slot, role), `ivr_routed_connected` vs `ivr_routed_voicemail`, `team_message_card`
(delivered/played/called_back), `team_billing_charge` (member_uid, billing_uid,
feature, coins), `team_wallet_low`. New dashboard: **"Team Receptionist — Funnel,
Routing & Cost."** Reuse the v3 `ava_recept_cost` event for the fallback minutes.

---

## 10. Kill switches & safety
- `teamIvrEnabled` (master), `ivrAiFrontDesk` (future AI desk, off), `teamBillsAiOnly`
  (future scope flag, off) — all in `routes/config.ts` KV.
- Per-account scoping on every new local store (rulebook).
- No Nostr, no new central high-write store (rulebook). Messages stay in
  `receptionist_sessions`; teams in D1-meta; money in WalletDO.
- 1:1 CallRoom 2-peer cap **unchanged** — the IVR routes to a normal 1:1 call; it
  never makes a 3-way call. (Group calling stays in LiveKit/AvaConsult.)

---

## 11. Phased implementation plan

Each phase = its own set of one-issue-per-commit commits (per CLAUDE.md git
protocol), committed locally, **not pushed**. No local builds (CI only).

- **Phase 0 — Schema & flags.** `team_plan.sql` migration; `receptionist_sessions`
  gets `team_id`/`team_slot`; `teamIvrEnabled` flag. `[TEAM-0]`
- **Phase 1 — Team CRUD + billing shim.** `team.ts` routes; `billingUidFor`;
  `tierOf` membership override; route `chargeFeature` through the shim. `[TEAM-1..3]`
- **Phase 2 — IVR menu + routing.** `/api/team/ivr*`; call screen detects team
  number → renders tap menu → routes to staff 1:1 call. `[TEAM-4..5]`
- **Phase 3 — Fallback + message card.** Wire no-answer → per-staff `receptionistStart`
  with entry voice/greeting; fan-out card to staffer + manager; `/api/team/messages`;
  card UI (Call/Play). `[TEAM-6..7]`
- **Phase 4 — Manager + staff UI.** Team sidebar, add-staff sheet, reorder, invite
  accept, badges, team wallet top-up. `[TEAM-8..10]`
- **Phase 5 — Telemetry + dashboard + docs.** Events, dashboard, update Graphiti. `[TEAM-11]`

**Effort estimate:** backend Phases 0–3 are the bulk and are mostly glue over
existing code; UI Phase 4 is the largest single chunk. Realistically a few focused
sessions, not a rewrite.

---

## 12. Open questions for later (not blocking v1)
- Pricing of the **Team plan** itself (seat price, included AI minutes/coins, overage).
- Whether a staffer can be on **multiple** teams (v1 assumes one; PK on
  `team_billing_map.member_uid` enforces it — change to composite if needed).
- Recorded vs TTS greeting default (TTS is cheapest; recording is a nice upsell).
- Business hours / after-hours menu variants (v2).
