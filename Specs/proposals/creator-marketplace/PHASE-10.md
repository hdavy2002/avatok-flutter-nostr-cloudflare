# Phase 10 — AvaTalk Group Conferencing (LiveKit, ≤25) + Rulebook Update

**Read first:** `00-UNIVERSAL-PROPOSAL.md` §3 (rule change). Prereq: Phase 1.
**Owner decision 2026-06-10:** the "AvaTok calls are 1:1 ONLY" rule is CHANGED —
group chats may hold audio/video conferences, max 25 participants, via LiveKit.
1:1 calls keep the existing P2P CallRoom-DO path.

## ⚠️ ALREADY BUILT — verified 2026-06-10.
- `conferenceEnabled` kill switch already exists in `routes/config.ts`
  (Phase 1 shipped it) — gate everything in this phase behind it.
- CallRoom DO (1:1 P2P, 2-peer cap) exists and stays untouched except the
  ringing-race fix from Phase 1 A4. No LiveKit code exists anywhere — this
  phase is genuinely greenfield apart from the guard changes.

## Objective
Group audio/video conferencing inside AvaTalk group chats with a hard 25-member
cap, standard meeting UI, and graceful UX when a group exceeds 25 members.

## 0. Rulebook + guard updates (do FIRST, deliberately)
- `CLAUDE.md` + `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md`: replace "group calls NOT
  allowed" with: "Group conferences allowed in AvaTalk groups, ≤25 participants,
  via LiveKit. 1:1 stays P2P (CallRoom DO, 2-peer cap unchanged). Group/conference
  CONSULTING still lives in AvaConsult."
- Client `_call()` guard: currently blocks any `group`/`gid` — change to: allow
  when `memberCount <= 25`, else show the limit notice (below).
- `CallRoom` DO keeps its 2-peer cap — it serves 1:1 only; group conferences use
  LiveKit rooms instead (do NOT raise the DO cap).

## 1. LiveKit infrastructure
- **Start with LiveKit Cloud** (fastest; per-minute pricing), keep self-host on
  the table (LiveKit is OSS; a Hetzner/Fly deployment later cuts cost — decision
  point once usage is known). Config via env: `LIVEKIT_URL`, `LIVEKIT_API_KEY/SECRET`.
- Worker `routes/conference.ts`:
  - `POST /api/conference/:groupId/start` {video|audio} — caller must be a group
    member; **reject if group member count > 25**; create/locate LiveKit room
    `group:<groupId>`; set `max_participants=25` server-side; return access token
    (identity = Clerk id, name, canPublish).
  - `POST /api/conference/:groupId/join` — member + room live ⇒ token; enforce cap
    (LiveKit max_participants is the backstop).
  - Webhook (LiveKit → worker): room_started/finished, participant joined/left ⇒
    post system messages into the group thread ("Call started — 4 in call") and
    push "incoming group call" FCM to members (joinable, not ringing-modal).

## 2. Flutter (`app/lib/features/avatok/` + new `conference/`)
- **Group thread app bar:** video + audio call icons.
  - `memberCount <= 25`: icons active → start/join conference.
  - `memberCount > 25`: icons disabled (greyed) + a small notice icon; tapping it
    pops: *"This group has more than 25 members, so video calls are disabled. You
    need fewer than 25 people to have a video conference."* Same for audio.
- **Conference room UI** (`livekit_client` Flutter SDK), standard conventions
  (Meet/WhatsApp-like): grid (2–8) → paginated grid (9+), active-speaker tile,
  mute/cam/flip/speaker, participants sheet, leave/end (starter can end for all),
  audio-only mode = avatar tiles, minimized PiP banner back in the chat
  ("Ongoing call · 6 — tap to join").
- In-thread system rows for call start/end with join button while live.
- Per-account scoping for any local prefs (last mic/cam choice).

## 3. Notes
- Group messaging features (text, media, polls, etc.) are untouched.
- 1:1 call path untouched (regression-test it).
- Conference participation has no marketplace/escrow involvement (free feature).

## Acceptance criteria
- [ ] 3 phones/emulators in a group conference (video + audio modes) via LiveKit.
- [ ] Group with 26 members: icons disabled, notice popup text exact.
- [ ] 26th joiner of a live room is refused (server cap), even racing.
- [ ] 1:1 P2P call still works end-to-end (no regression).
- [ ] System messages + joinable push behave; PiP return-to-call works.
- [ ] CLAUDE.md + rulebook committed with the new rule wording.

## Definition of done
Deploy worker, LiveKit creds in secrets, Graphiti episode (explicitly record the
RULE CHANGE), STATUS_REPORT.md, push.
