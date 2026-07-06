# Guardian v2 — Sync Verification + Draft Plan (2026-07-06)

Owner asks (this session): confirm red-flag state sync/backup, remove premium tags, explicit/stranger-only activation with header off-switch, chat-only (never calls), live LLM pipe with zero felt lag, no media scanning, and a face-liveness gate when guardian is turned on. This document verifies the current state and drafts the plan. Not yet built.

---

## PART A — Sync & backup verification (simple English)

**Question: if a chat/bubble goes red on one device, does that red state reach my other devices, live and after reinstall?**

**Answer: only partially. Confirmed in code:**

1. **The live red-bubble signal does NOT sync.** When Guardian flags a message, it pushes a `safety_flag` frame through the InboxDO `/event` path. That path is **broadcast-only — it is never stored** (verified in `do/inbox.ts`: `/event` frames fan out to connected sockets and vanish). A device that is offline, or a second device that connects later, never receives it.
2. **The red state is saved only on the one device that saw it.** `SafetyFlagStore` writes to on-device DiskCache (`avatok_safety_flags`). It is per-account scoped (bible rule respected) but **device-local**: not synced to other devices, not in the Drive backup set, gone on reinstall.
3. **"This is fine" dismissals are also local-only.** Dismiss a red flag on your phone and your tablet still shows it red (if it ever knew about it at all).
4. **One partial safety net exists:** the private warning Ava posts is a durable `ava_private` message in your InboxDO, and its meta carries `flagged_created_at`. When a new device replays message history, `_noteGuardianFlag` re-derives red state from that timestamp. So *some* red bubbles reappear after a re-sync — but only via the timestamp path (fragile: ts collisions, archived pages), not the msg-id path, and never the dismissals.
5. **What DOES sync properly:** the per-chat guardian on/off toggle (server D1 `ava_guardian_prefs`) and the flag log (`ava_guardian_flags` in D1). The server knows everything; the *client presentation state* is what's device-stranded.

**Verdict: your suspicion is correct.** Server-side records are durable, but red-bubble and dismissal state is device-local. Fix is in Phase P3 below.

---

## PART B — Draft plan

### P0 — Strip premium, free for all (small, mechanical)

- Delete `isEntitled()` and every call site in `ava_guardian.ts`; delete the "PREMIUM"/entitlement comments.
- Delete the 402-revert path in `GuardianPrefsClient.set` and `PaidFeature` import in `guardian_section.dart`.
- Collapse `deep_monitor` into `secure_chat`: one concept — "Guardian is ON for this chat." Keep the D1 column (ignore it) to avoid a migration; stop reading/writing it. Remove the second toggle from `GuardianSettingsSheet` and the account-wide deep default from settings.
- Update stale llama-guard comments while in the file.

### P1 — Activation model: explicit or stranger-accept only

Today: scanning runs on every message platform-wide (cheap tier + Nemotron), with the shield only adding the Opus tier. New model — **Guardian runs ONLY when ON for that conversation**:

- **ON trigger 1 — explicit:** user taps the shield badge in the chat header (existing `_toggleGuardian`). Kept.
- **ON trigger 2 — stranger accept:** when the user accepts a message request from someone not in contacts (the existing stranger gate / `inboxAcceptState` accept action in `chat_thread.dart` + `safety.ts`), the client auto-calls `setGuardianPrefs(secureChat:true)` for that conv and shows a one-line notice: "Ava Guardian is on for this chat — tap the shield to turn it off."
- **OFF:** tap the green shield in the header → off immediately (existing toggle already does this; keep a confirm-free single tap, prefs synced server-side).
- **Server change:** in `guardianScan`, short-circuit unless at least one recipient has `secure_chat=1` for the conv. The always-on Nemotron platform scan (`safetyScanEnabled`) becomes conditional on the same check.
  - ⚠️ Owner should confirm: this also turns off the current *platform-wide* CSAE/threat floor for unwatched chats. If we want to keep a minimal illegal-content floor everywhere (recommended for store compliance), keep Nemotron always-on but only *surface* warnings in guardian-ON chats, and keep flag rows + admin telemetry for csae/trafficking regardless.
- Child accounts: guardian force-ON for all chats, not user-disableable (ties to existing minor detection via `birth_year`; the shield shows locked-on for minors).

### P2 — Scope: chat only, never calls

- Guardian already only hooks `messaging.ts` text fan-out; calls (CallRoom DO / LiveKit conferences) never pass through it. Make this explicit: no-op on call-signaling kinds, and no guardian UI on call screens. One guard clause + a comment; mostly a documentation/verification task.

### P3 — State sync + backup (fixes Part A)

Make red-flag state server-durable and multi-device, reusing existing patterns:

- **Persist flags in the InboxDO** (the owner-state pattern `_syncHidden` already uses): new small SQLite table in each user's InboxDO — `safety_flags(msg_id PK, conv, category, severity, dismissed INT, ts)`. Guardian's existing `/event` call becomes `/safety_flag` on the recipient's InboxDO: **store the row, then broadcast** the live frame (store-and-forward instead of broadcast-only).
- **Seed on /sync:** include `safety_flags` for the requested convs in the sync response (same way hidden/soft-delete state is seeded). New device cold-open → red bubbles correct.
- **Dismissals sync:** "This is fine" posts `{msg_id, dismissed:true}` to the same InboxDO endpoint; other devices get a live frame and future syncs carry it.
- **Client:** `SafetyFlagStore` stays as the local cache but is now hydrated from /sync; drop the fragile `flagged_created_at` timestamp path once msg-id seeding works.
- Backup: nothing extra needed — InboxDO is the durable home (bible rule: DO-local SQLite per user is the message store), and it survives reinstall via normal sync.

### P4 — Live pipe: scan BEFORE the user sees it, zero felt lag

Today Guardian scans *after* fan-out (recipient can read the scam before the warning lands). Requirement: message passes through the guardian LLM before reaching the user, with no perceived lag. Proposal — **two-lane inline scan, guardian-ON chats only**:

- **Fast lane (inline, blocking, budgeted):** in `messaging.ts`, when the conv is guardian-ON, run regex `cheapScan` (~0ms) + one **fast** model call (Nemotron via OpenRouter, or Workers AI equivalent) with a hard **400–600ms timeout** BEFORE fan-out. On verdict: fan out with the flag attached (message + red state + warning arrive together — the recipient never sees an unflagged scam frame). On timeout/error: **fail-open, deliver immediately**, and let the slow lane annotate late. Sender feels nothing (their own bubble is a local echo); recipient just gets the message a few hundred ms later than today, which is imperceptible against normal network jitter.
- **Slow lane (async, after delivery):** the deep classifier (currently Claude Opus 4.8 — consider downgrading to Sonnet/Haiku for cost; quality is sufficient for classification) runs detached as today, and on a late verdict pushes the now-durable `/safety_flag` (P3) → bubble turns red within 1–3s even when the fast lane missed it.
- **Cost/latency controls (Trust-Engine style):** per-conv/day classifier budget, 429 → fast-lane-only degradation, never queue messages behind a slow model. The kill switches stay: `guardianEnabled` master, plus a new `guardianInlineEnabled` to flip the fast lane off instantly if p95 latency regresses.
- Attach the flag to the fan-out payload (`meta.safety={category,severity}`) so flagged delivery is atomic — no separate frame race on the happy path.

### P5 — Remove media scanning

- Delete `detectSynthetic`, `fetchMediaBytes`, `checkMedia`, the `{media_ref}` API mode, the `deepfake` category + warning copy, and the client "This image may be fake" card. Media messages skip Guardian entirely (voice-note transcripts could be piped through the TEXT lane later — cheap option, noted as future work, not in scope now).

### P6 — Face-liveness gate on guardian activation (new feature)

Intent: turning Guardian ON makes the *other side* prove they're a real, recorded face — a strong deterrent. No phone OTP (OTP stays marketplace-listing-only, matching current policy and the broken Firebase phone provider anyway).

Reuse what's live: the 6-stage liveness V2 pipeline is deployed (worker + `liveness-verify` queue + `livenessV2Enabled=true`), and `identity_proofs` → `/api/identity/level` already powers green ticks.

**Flow — 1:1:**
1. A taps shield ON → server sets `secure_chat=1` AND marks the conv `guardian_gate: pending` for peer B (new D1 table `ava_guardian_gate(conv, uid, status, passed_at)` or rows in `ava_guardian_prefs`).
2. Ava posts a **system message to B**: "A turned on Ava Guardian for this chat. Complete a quick face check to keep chatting." with a button → existing liveness flow (face only, no OTP). A sees "Waiting for face check…" status under the shield.
3. B passes → `identity_proofs` row (proof kind `guardian_liveness` or reuse the standard liveness proof — if B already has a valid liveness proof at L≥the-required-level, **auto-pass, no prompt**) → gate `passed`, both sides see a "verified face" mark on the thread.
4. B declines / hasn't passed: owner decision needed on enforcement — options: (a) B can't send further messages into this conv until passed (hard gate, strongest deterrent), (b) B can send but every message carries an "unverified" badge and Guardian treats them at max suspicion (soft gate). **Recommend (a) hard gate with a 24h grace window** — that is what actually discourages bad actors.
5. Liveness results cached account-wide with an expiry (e.g. 90 days) so users aren't re-checked per chat.

**Flow — group:** member turns Guardian ON → every member (except already-proven ones) gets the same system message; the group info screen shows per-member pass status; unpassed members hit the same (a)/(b) enforcement inside that group. Group cap is ≤25 (conference rule) so fan-out is small. Only admins or any member? **Recommend: any member can turn it on, only an admin (or the enabler) can turn it off** — otherwise a predator in the group just toggles it off. Owner to confirm.

**Server pieces:** gate table + check in `messaging.ts` send path (one indexed read, cacheable in the conv hot path); reuse liveness verdict consumer to flip gate rows; push notification on gate events. **Client pieces:** system-message card with "Start face check" button into the existing liveness screen; waiting/verified states on the shield; group-info member status list.

**Abuse/edge cases:** minors — liveness for minors is sensitive (biometrics + COPPA-adjacent); recommend children are never *required* to record a face — a child turning Guardian on gates the OTHER side only. Re-verification on account switch (shared-phone rule): gate pass is per-uid, per-account-scoped as always.

### Rollout order & risk

P0 (premium strip) and P5 (media removal) are deletions — do first, low risk. P1 (activation) + P2 (calls) next. P3 (sync) is self-contained InboxDO work. P4 (inline lane) touches the hot messaging path — build behind `guardianInlineEnabled=false`, measure p95 send latency in PostHog (`msg_send_ms` vs baseline), flip on staged. P6 is the biggest new surface — spec the enforcement decision first, build behind `guardianGateEnabled=false`.

### Open decisions for owner

1. Keep a minimal always-on illegal-content (CSAE/trafficking) floor on unwatched chats, or truly scan nothing unless Guardian is ON? (Recommend: keep the floor, warnings surfaced only in guardian-ON chats.)
2. Liveness gate enforcement: hard block until passed (recommended) vs unverified-badge soft gate — and the grace window length.
3. Group: who can turn Guardian off once on? (Recommend: enabler or group admin only.)
4. Downgrade the deep classifier from Opus 4.8 to Sonnet/Haiku for cost?
5. Liveness pass validity period (suggest 90 days, account-wide).
