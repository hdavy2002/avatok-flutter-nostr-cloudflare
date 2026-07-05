# Permanent Fix Plan — Evening Test Session 2026-07-05 (davy ⇄ Sat)

Telemetry-verified on build 0.1.17+18 + deployed worker. Governed by the frozen
DETERMINISTIC-CORE-ARCH.md (v1.4): every fix below is an authority/state fix or a
capability gap — no timers-as-logic, no client assertions, no patches.

## First: what the new build PROVED (working as designed)

- `call_end_pressed` → instant end, every time (end button fixed — 4 clean hangups).
- `call_minimized` fired repeatedly (minimize/back fixed — it NEVER fired before).
- `call_dup_session_blocked` fired on 4 restore-path duplicates (guard works there).
- Mid-call network blip at 12:22 → `call_reconnect_ok`, `call_peer_rejoined` — the
  call SURVIVED a drop that yesterday would have killed it.
- `call_media_stalled` fired (watchdog live), `msg_echo_received` (echo pipeline
  live), `netbrain_*` states tracking Sat's flaky network in real time.

## The 8 remaining root causes (telemetry + code refs)

### 1. [CALL-GEN-2] CRITICAL — our generation guard drops the PEER's frames
Evidence: 114 × `invariant_protected{stale_generation_rejected, client}` every ~15s
after the 12:22 reconnect on call avatok-69ddef2d.
Cause: server keeps generations PER-PEER, but the client compares every inbound
frame against its OWN single `_gen`. After MY reconnect bumps MY gen, the peer's
(older-gen) frames are dropped forever — including, potentially, his `bye` (=
"can't disconnect" reports). Media survives (P2P), signaling goes deaf.
Permanent fix: client tracks `Map<senderId, gen>`; a frame is stale only if lower
than the last known gen FOR THAT SENDER; DO re-stamps relayed frames with the
sender's authoritative gen. (This is the spec's own #5 done correctly.)

### 2. [CALL-DUP-SESSION-2] one construction path still bypasses the registry
Evidence: avatok-3a2d4f15 12:20:06-08 — Sat accepted, then a SECOND
`call_session_extracted` 1.5s later (between them `call_fgs_started` +
`call_backgrounded`) with NO `call_dup_session_blocked` → 2-peer-cap busy →
busy handler killed the live call (same class as yesterday).
Cause: the CallKit-accept-while-app-backgrounded / FGS bring-to-front flow reaches
CallSession creation without `CallSessionManager.attach()`.
Permanent fix: route THAT path through the manager (find via the accept trace in
push_service/callkit handler); add a debug-build assert + `invariant_protected
{kind:duplicate_session_prevented}` when the registry saves us. Interim server
backstop until CALL-FSM-1: CallRoom rejects a join for a (user,device) that already
has a live socket in the room with `already_joined` (attach, don't busy).

### 3. [CALL-EXCL-1] no single audio authority on the device
Evidence: 12:19 — davy's call avatok-0751b1f6 went to Ava (receptionist session
live); Sat called back (avatok-70056d77); davy ACCEPTED and both ran concurrently —
Ava listened to davy talking to Sat; davy had to kill both, then got busy on redial.
Permanent fix (device-level invariant): **exactly one audio-owning session per
device.** Accepting any call → the acceptance path (single authority point in the
manager) must first (a) gracefully END any receptionist session — command
`owner_answered`: Ava exits silently, posts NO voicemail, sends NO caller-ack; and
(b) end any other live call leg (proper bye, not busy). Server side: when the
receptionist session's CALLEE and a new live call's CALLEE are the same user and
the caller is the same peer, receptionist DO/session auto-yields (`ava_recept_yielded
{reason:owner_answered}`).

### 4. [CALL-GLARE-2] mutual calling must auto-connect, not busy
Evidence: after the double-session mess, davy redialed and got "Ava is taking your
call" → "user is busy" (receptionist `start_failed` on the answered flag — the
sequencing was fixed but glare + duplicate still produce busy dead-ends).
Permanent fix: deterministic glare resolution at the CallRoom (not client): when two
INVITING rooms exist between the same pair within the glare window, the DO (via the
place-call route checking for a reciprocal pending invite) folds the second dial
into an AUTO-ACCEPT of the first (stable rule: lexicographically smaller callId
wins as "the call"). Caller UI: "connecting…" instead of busy. Client CALL-GLARE-1
heuristics stay as fallback for old servers.

### 5. [AVA-VM-CLOSE-1] Ava cannot end a voicemail herself
Evidence: 11:37-11:38 avatok-0a1fbc40 — caller left a ~3s message; Ava idle-nudged,
then hit the hard wrap cue ("that's all the time I have"). The cap is a GC backstop
that became the UX.
Permanent fix: give the Gemini Live session an explicit `end_call` TOOL + prompt
contract: after the caller's message + N seconds of silence, or explicit "that's
all/bye", Ava says a short goodbye and CALLS the tool (event-driven close — spec
rule: outcomes by decision, not timer). Caps stay as backstops only. Add
`ava_recept_self_closed {reason: message_complete|caller_bye|silence}` telemetry.

### 6. [CALL-FSI-1] no lock-screen incoming-call UI (Android 14+)
Evidence: ring audible, no call screen even after unlock; user opens app manually;
Ava answers first.
Cause: Android 14 revokes USE_FULL_SCREEN_INTENT for non-dialer apps unless the
user grants it in Settings; the app never checks/requests it, and there is no
recovery path; callkit params/channel importance need alignment.
Permanent fix: FSI runtime check + one-time in-app prompt deep-linking to the FSI
settings page; max-importance call channel; verify flutter_callkit_incoming
full-screen params + activity showWhenLocked/turnScreenOn; fallback high-priority
notification with answer/decline actions when FSI denied. Telemetry:
`call_fsi_permission {granted}` on every incoming ring.

### 7. [CALL-FOCUS-1] + [CHAT-UPLOAD-1] background/during-call survival
Evidence: cutoffs "especially when using WhatsApp"; PDF upload coincided with both
sides hitting netbrain_recovering + reconnect at 12:22.
Cause (focus): audio focus requested with NO OnAudioFocusChangeListener
(AvaVoiceAudioPlugin.kt:485-496) — WhatsApp takes focus, our capture dies silently.
Cause (upload): unthrottled, main-thread-adjacent upload saturates uplink during a
live call (chat_thread.dart:3468-3496) and starves WebRTC.
Permanent fix (focus): register focus listener → on loss: hold call (mute capture,
"On hold" banner, keep RTC alive), on regain: resume. Telemetry
`call_audio_focus_lost/regained`. Permanent fix (upload): uploads run throttled
(chunked with pacing) whenever a live CallSession exists + encryption off the main
thread; never block, never saturate. Telemetry `chat_upload_during_call`.

### 8. [CHAT-PDFVIEW-1] + [CHAT-PASTE-1] attachments parity
Evidence: uploaded PDF won't open; "upload image"/"paste image" menu confusion.
Cause: tap → `launchUrl(external)` fails silently with no handler; `pdfx` is in
pubspec but unused. The input field ALREADY supports native image paste
(contentInsertionConfiguration, chat_thread.dart:6212) — the menu item is redundant.
Permanent fix: in-app PDF viewer screen (pdfx) with download/decrypt progress and
OS-open + share fallback (works for all file types: viewer for pdf/images, OS intent
otherwise, clear error if no handler); delete the redundant "Paste image" menu
entry; long-press paste already works — add a one-time hint.

## Execution order (each stage deployable, one issue per commit)

1. CALL-GEN-2 (critical correctness of our own guard) — client + DO
2. CALL-DUP-SESSION-2 (close the last construction leak + server backstop)
3. CALL-EXCL-1 (single audio authority; Ava yields on owner answer)
4. CALL-GLARE-2 (auto-connect mutual dials — server rule + client UX)
5. AVA-VM-CLOSE-1 (end_call tool + prompt contract)
6. CALL-FSI-1 (lock-screen call UI permission flow)
7. CALL-FOCUS-1 + CHAT-UPLOAD-1 (hold on focus loss; throttled uploads)
8. CHAT-PDFVIEW-1 + CHAT-PASTE-1 (viewer + menu cleanup)

Items 3-4 are the down-payment on CALL-FSM-1 (Phase B): they place the authority in
the manager/DO exactly where the FSM will live, so nothing is throwaway.

Verification per item: telemetry assertion added to the two-phone checklist
(e.g. after 1: zero client-side stale_generation_rejected storms; after 3:
`ava_recept_yielded` replaces concurrent recept+call; after 4: zero busy on mutual
dial; after 6: `call_fsi_permission granted=true` and ring→screen < 2s).
