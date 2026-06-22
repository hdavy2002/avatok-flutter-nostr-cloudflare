# PROPOSAL — Ava Receptionist v2 (Persona UI · Missed-Call Transfer · Native Audio · In-Thread Message)

**Status:** Proposal / not yet built
**Author:** Owner + Claude
**Date:** 2026-06-22
**Builds on:** `Specs/PROPOSAL-AI-RECEPTIONIST.md` (v1 — already shipped: backend pipeline,
2-min cap, Gemini Live via AI Gateway, summary + recording + push).
**Related:** `AVAVOICE-PROPOSAL.md`, `PROPOSAL-LIVE-TRANSLATION-GEMINI.md`,
`AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`, `AVATALK-CLOUDFLARE-RULEBOOK.md`.

---

## 0. What already exists (v1 — do NOT rebuild)

The receptionist spine is **live**, not theoretical. Confirmed in code:

| Piece | Path | State |
|---|---|---|
| Settings card (enable, instructions, display name, voice, KB upload) | `app/lib/features/settings/sections/receptionist_section.dart` | shipped |
| Caller-side bridge (mic→WS, plays Ava audio) | `app/lib/core/receptionist_call.dart` | shipped (audio path weak — see §3) |
| Trigger after ring timeout | `app/lib/features/avatok/call_screen.dart` (`_onNoAnswer` → `_tryReceptionist`, 35 s) | shipped |
| Server routes (settings, config, start, finish, KB) | `worker/src/routes/receptionist.ts` | shipped |
| Live session DO (Gemini Live, 2-min cap, transcript, summary, recording, push) | `worker/src/do/reception_room.ts` | shipped |
| Hidden system prompt builder | `composeReceptionistPrompt()` in `receptionist.ts` | shipped |
| D1 schema | `worker/migrations/receptionist.sql` | shipped |
| Kill switch | `receptionistEnabled` in `routes/config.ts` | shipped |

**v2 is additive.** It changes four things only: the **trigger**, the **settings UI**, the
**audio engine**, and **where/how the message is delivered**. Everything else (Gemini Live, AI
Gateway metering, 2-min cap, summary, recording, premium gate, telemetry) is reused untouched.

---

## 1. Owner decisions baked into this version

- **Three ways Ava can take a call** (was: single fixed ring-timeout):
  1. **Auto after 5 rings** — caller hears 5 consecutive rings; if the owner hasn't picked up,
     Ava takes over. (Default behaviour; ring count tunable via RemoteConfig.)
  2. **Answer on first ring** (opt-in toggle) — when the owner is busy/travelling, Ava answers
     immediately on the first ring for *every* incoming call. Paired with a **status dropdown**
     (Busy / Travelling / In a meeting / …) that Ava speaks naturally.
  3. **Manual hand-off** — a **third "Agent" button on the incoming-call ringing screen** (next
     to the green accept / red decline). The owner taps/swipes it to hand the live call straight
     to Ava. Declining a call can also route to Ava (opt-in).
- **Settings gets a persona.** Ava can self-introduce under a chosen **name**, speak a chosen
  **language**, and use an optional **custom greeting / system prompt** on top of the safety
  scaffold.
- **Audio is rebuilt as a native full-duplex engine** (echo cancellation, speaker/earpiece
  toggle, half-duplex on loudspeaker). Shared with the live-call / translation path — built once.
- **The taken message lands INSIDE the caller's normal chat thread** (Messenger → that
  contact) as an agent chat bubble — not in a separate `recept_…` conversation.
- **2-minute hard cap unchanged.** Persona/language never weaken the safety guardrails or the cap.
- **Still premium-only**, still metered via AI Gateway, charges still off for now.

---

## 2. Activation model — three ways Ava takes a call

> **Clarification (owner, 2026-06-22):** the trigger is about **rings on the current call**, not a
> count of missed calls across attempts. There is **no per-caller miss counter** — that idea is
> dropped.

### 2.0 Today
`call_screen.dart` arms `Timer(Duration(seconds: 35))`; on timeout `_onNoAnswer()` tries Ava.
v2 keeps that auto path but expresses it as a **ring count** and adds two more activation modes
(answer-on-first-ring, and a manual Agent button on the incoming UI).

### 2.1 Mode A — Auto after 5 rings (default)
1. Caller A rings owner B. B's phone rings normally.
2. If B does **not** pick up within **5 consecutive rings**, and B is premium + Ava enabled +
   `receptionistEnabled` on → the call routes to Ava (B's phone stops ringing, A is connected to
   Ava). Otherwise → normal missed call.
3. The ring count is configurable via RemoteConfig (`receptionistRings`, default **5**). Internally
   the caller app maps it to the ring window it already uses (each ring ≈ a fixed cadence; today's
   35 s timeout is the reference). No per-caller state, no extra round-trip.

### 2.2 Mode B — "Answer on first ring" (owner is busy / away)
A new **toggle in Settings → Receptionist**: *"Let Ava answer every call for me right now."* When
ON, Ava picks up on the **first ring** for *all* incoming calls — the owner is heads-down,
travelling, in meetings, etc.

- Paired with a **status dropdown** (see §4) the owner sets once: **Busy · Travelling · In a
  meeting · Driving · On holiday · After hours · Custom.** The chosen status is injected into
  Ava's hidden prompt so she answers naturally and can respond if asked: *"Sonal is travelling
  right now — can I take a message?"*
- This is a **fast on/off** the owner flips when stepping away; it does not require editing the
  full instructions each time (though they can). Consider surfacing it as a quick toggle outside
  Settings too (e.g. on the calls screen) so it's one tap.
- Server-authoritative: `config?to=<uid>` returns `mode: "first_ring"` so the caller app knows to
  hand off immediately instead of waiting 5 rings.

### 2.3 Mode C — Manual hand-off from the incoming-call screen
When B's phone rings, B can actively send the call to Ava instead of ignoring it.

- **Add a third action to the incoming-call ringing UI.** Today the incoming call uses
  `flutter_callkit_incoming` (native CallKit on iOS / ConnectionService full-screen intent on
  Android), which shows the usual **green Accept** / **red Decline**. Add a **third "Agent"
  action** (robot/headset icon, brand colour) between them: *"Let Ava answer."*
- **Tapping Agent** → B's side declines the human leg and signals the caller to connect to Ava;
  A starts talking to Ava immediately (reading B's Settings → Receptionist config).
- **Decline → Ava (opt-in).** A setting *"When I decline a call, let Ava take it"* — for the
  "I'm in a meeting and cut the call" case. When on, pressing red Decline routes to Ava instead of
  a plain missed call. Default OFF so Decline stays Decline unless the owner opts in.

#### UI build note (platform reality)
- **Android:** the full-screen incoming UI can be customised — add the third Agent button directly
  to the incoming-call screen / notification actions.
- **iOS CallKit:** the native call screen is **locked to two buttons** (Accept/Decline) and cannot
  show a third. Options: (a) treat **Decline-routes-to-Ava** as the iOS path (opt-in), and/or (b)
  present an **in-app incoming screen** (when the app is foregrounded) carrying the three buttons.
  Flag this for the iOS build; Android gets the true three-button UI first.
- If a dedicated in-app ringing UI doesn't already exist (only the native CallKit one does), build
  one so the Agent action has a home on both platforms.

### 2.4 Precedence
First-ring mode (B) wins when on. Otherwise the call rings; B may hand off manually at any ring
(C); if B does nothing, auto-handoff fires at ring 5 (A). All three are gated by premium + Ava
enabled + `receptionistEnabled`.

---

## 3. Native full-duplex audio engine (the real echo fix)

### 3.1 Why
`receptionist_call.dart` admits it: playback is "a pragmatic chunked-WAV scheme on audioplayers
… latency/gapless behaviour needs tuning." It plays Ava's PCM through `audioplayers` with **no
echo cancellation**. On loudspeaker, Ava's own voice re-enters the mic and she answers herself.

### 3.2 The fix (mirror the `AvaVisionPlugin` native pattern; `minSdk 24` supports platform AEC)
Build a native full-duplex audio engine, shared by the receptionist **and** live/translation calls:
- **Record** from the `VOICE_COMMUNICATION` source with `AcousticEchoCanceler` +
  `NoiseSuppressor` attached.
- **Play** Ava's PCM on a `VOICE_COMMUNICATION` `AudioTrack` under `MODE_IN_COMMUNICATION`, so the
  platform AEC subtracts Ava's voice from the mic → true full-duplex barge-in on earpiece/BT.
- **Echo fix on loudspeaker (the pragmatic one):** half-duplex — while Ava speaks (plus a **400 ms
  tail**) the mic upload is **paused**, so she physically cannot hear herself. Earpiece/BT stay
  full-duplex (no echo there, barge-in works).

### 3.3 Audio route is a user choice (not forced speaker)
- A **speaker / earpiece toggle** on the call + receptionist screen.
- Speaker off → route to connected **Bluetooth / wired headset**, else the **earpiece**.
- Choice **remembered per account** (`scopedKey` / `AccountScope.id` per the rulebook).

### 3.4 Wiring
`ReceptionistCall` drops the `audioplayers` queue and `record` stream and calls the new engine
(same PCM16 16 k up / 24 k down contract the DO already speaks). No server change needed — the
DO's frame shapes are unchanged.

---

## 4. Settings → Receptionist (expanded persona UI)

Extend the existing card in `receptionist_section.dart`. Today: enable, instructions, "how Ava
refers to you", voice, KB. **Add:**

| Field | Stored as | Used by |
|---|---|---|
| **Persona name** — what Ava calls *herself* ("Hi, this is Maya, Sonal's assistant") | `persona_name` | greeting line in `composeReceptionistPrompt()` |
| **Language** — "Auto-detect" + 27 verified languages | `language_code` | `speechConfig.languageCode` in the DO `setup` + pinned in the prompt |
| **Custom greeting** — the exact opening line (optional) | `greeting_text` | first turn / prompt scaffold |
| **Answer on first ring** — toggle, "Let Ava answer every call right now" (Mode B) | `answer_all` (0/1) | `config?to=` returns `mode:"first_ring"`; caller hands off on ring 1 |
| **Availability status** — dropdown: Busy · Travelling · In a meeting · Driving · On holiday · After hours · Custom | `status_preset` (+ `status_custom`) | injected into the hidden prompt so Ava says e.g. "Sonal is travelling…" |
| **Let Ava take declined calls** — toggle (Mode C, decline path) | `decline_to_ava` (0/1) | red Decline routes to Ava instead of a missed call |
| **Advanced: custom behaviour prompt** (optional, power users) | `custom_prompt` | appended to scaffold, **never replaces** safety rules |

UI: keep the Zine card style. Language uses the same picker as **Settings → Ava voice**
("Auto-detect" + 27 languages, each verified to complete the Live handshake so a selection can
never break a call). Persona name + greeting are short text fields. The **status dropdown** maps
each preset to a natural phrase Ava can speak and answer questions about ("she's in a meeting",
"she's travelling"); Custom reveals a short free-text field. The **Answer-on-first-ring** toggle
is the quick "I'm away" switch (also worth mirroring as a one-tap control on the calls screen).
Custom prompt sits behind an "Advanced" expander with a note that safety rules always apply.

### 4.1 System-prompt composition (server-side, locked)
`composeReceptionistPrompt()` becomes:
```
[fixed safety scaffold: "you are an AI assistant named <persona_name>, never claim to be
 <display_name> or any human, disclose recording, refuse harmful/illegal, obey [SYSTEM] cues]
+ [2-minute timing rules — unchanged]
+ [language pin: "Speak in <language>" unless Auto-detect]
+ [availability status: "<owner> is <busy|travelling|in a meeting|…> right now" — from status_preset/custom]
+ [greeting_text if set, else a generated greeting from display_name + status + instructions]
+ [OWNER INSTRUCTIONS free text — unchanged]
+ [custom_prompt if set]
```
The scaffold and the cap **always win**; persona/greeting/custom only fill the gaps. Still
composed on the Worker, still never sent to the client.

### 4.2 Schema additions
```sql
ALTER TABLE receptionist_settings ADD COLUMN persona_name   TEXT;
ALTER TABLE receptionist_settings ADD COLUMN language_code  TEXT;     -- NULL = auto-detect
ALTER TABLE receptionist_settings ADD COLUMN greeting_text  TEXT;
ALTER TABLE receptionist_settings ADD COLUMN custom_prompt  TEXT;     -- length-capped, sanitized
ALTER TABLE receptionist_settings ADD COLUMN answer_all     INTEGER NOT NULL DEFAULT 0; -- Mode B: answer on first ring
ALTER TABLE receptionist_settings ADD COLUMN status_preset  TEXT;     -- busy|travelling|meeting|driving|holiday|after_hours|custom
ALTER TABLE receptionist_settings ADD COLUMN status_custom  TEXT;     -- free text when preset=custom
ALTER TABLE receptionist_settings ADD COLUMN decline_to_ava INTEGER NOT NULL DEFAULT 0; -- Mode C: decline routes to Ava
```
`receptionistPutSettings` validates/caps each (greeting ≤ 200 chars, custom_prompt ≤ 1000,
status_custom ≤ 120, language against the 27-code allow-list, `status_preset` against the fixed
enum), exactly like the existing `instructions_text` cap. `GET /api/receptionist/config?to=` now
also returns `mode` (`first_ring` when `answer_all`, else `rings`) and the resolved status phrase
so the caller app knows whether to hand off on ring 1 or wait for ring 5.

---

## 5. Message delivery — into the contact's chat thread as a bubble

### 5.1 Today (the gap)
`reception_room.ts → postMessage()` posts to a **separate** conversation:
`recept_<owner>__tel:<phone>`, `kind:"receptionist"`. No chat widget renders that kind yet, and
it's isolated from the caller's real DM thread. So the user doesn't see a clean "they called and
left this" bubble where they'd expect it.

### 5.2 New behaviour
After Ava hangs up (or hits the 2-min cap), the message appears **inside the caller's normal
Messenger thread** as an **agent chat bubble**:

> 📞 **+44 7700 900xxx called and left a message**
> *"Hi, it's Sam — can Sonal call me back about Friday? Not urgent."*
> ⏱ 0:48 · ▶ Play recording

Tapping expands the full transcript; ▶ plays the R2 recording.

### 5.3 Changes
- **Route to the real thread.** Resolve the caller to their contact and post into the existing
  `dm_…` conversation (normal DMs start with `dm_`, confirmed in `config.dart` / `verse_api.dart`),
  keyed by **normalized E.164** so unknown callers still attach to the right contact. Keep the
  `recept_…` write only as a fallback when no contact/thread can be resolved.
- **Render the bubble.** Add a chat-bubble widget for `kind:"receptionist"` in the Messenger
  message list: agent-styled bubble, summary line, expandable transcript, inline player for
  `recording_url`. This is the missing UI piece — the data is already on the message payload
  (`receptionist: { summary, transcript, recording_url, duration_s, caller_phone }`).
- **Push unchanged** ("Ava took a message"), but its `conv` now deep-links to the real thread.

### 5.4 Privacy / scoping
Bubble + recording cached on-device per account (`AccountScope.id`), honouring AvaBrain consent
toggles for transcripts (private content on-device only) — per the rulebook.

---

## 6. Architecture (delta only)

```
A (Flutter)                                  B (owner, premium)
   |                                              |  GET /receptionist/config?to=B → { available, mode, status }
   | call B  ───────────────────────────────────▶|  rings…
   |                                              |
   |  Mode B (answer_all): hand off on ring 1     |
   |  Mode C: B taps "Agent" on incoming UI ──────┤  [NEW §2.3]  (or Decline→Ava if opted in)
   |  Mode A: no pickup by ring 5  ───────────────┘  [§2.1]
   |        └─ any of the above → ReceptionistCall.start()
   v
 Native full-duplex audio engine  [NEW §3] ──WS PCM16──> ReceptionRoom DO (unchanged core)
   (AEC + speaker/earpiece toggle)                          |  Gemini Live via AI Gateway
                                                            |  2-min cap, transcript, summary, R2 rec
                                                            v
                              postMessage() → caller's REAL dm_… thread  [CHANGED §5]
                                                            |
                                          agent chat bubble + ▶ recording in Messenger  [NEW UI §5]
```

---

## 7. Data model summary

- `receptionist_settings` — **+8 columns** (`persona_name`, `language_code`, `greeting_text`,
  `custom_prompt`, `answer_all`, `status_preset`, `status_custom`, `decline_to_ava`).
- No new tables (the per-caller miss counter is **dropped** — trigger is ring-based, §2).
- `receptionist_sessions` — add `activation_mode` (`rings`\|`first_ring`\|`manual`\|`decline`) so
  telemetry/analytics can see *how* each call was handed off; otherwise unchanged.
- Message payload — **unchanged shape**, **new destination** (`dm_…` thread).

---

## 8. Telemetry (PostHog) — full spec in companion doc

Rich, end-to-end instrumentation (latency, blockers, guardrails, performance, network, call
quality) is specified in **`Specs/RECEPTIONIST-V2-TELEMETRY.md`**. Headlines:

- **One call = one trace** (`trace_id = session_id`) across caller app → Worker → DO → Gemini
  (+ AI Gateway `cf-aig-log-id`).
- **Every event carries email + phone** via `trackUserContact(env, uid, email, phone, …)` (server)
  and the client `Analytics.capture` envelope — so support pulls a user's whole history by email
  or phone. Bare `track()` is not allowed for receptionist events.
- Events span trigger/routing, connect latency, **first-audio (perceived) latency**, per-turn
  latency, network/call quality, guardrail hits, cutoff, and delivery — plus `metric()` points for
  dashboards, latency budgets + `release`-tagged alerts, six saved insights, and a one-filter
  support lookup. Keep all v1 events; surface in the in-app diagnostics view (`diag_logs`).

---

## 9. Guardrails (rulebook)

- **Premium gate** stays server-side (`isPremiumAI`); enabling is the paid action, OFF is free.
- **Per-account scoping** for the audio-route choice, settings mirror, message/recording cache.
- **Safety scaffold + 2-min cap always win** over persona/greeting/custom prompt; custom prompt
  is sanitized + length-capped and cannot reveal/override the hidden rules.
- **No impersonation** — persona name is explicitly "<name>, <owner>'s AI assistant."
- **Recording disclosure** in the greeting (two-party-consent regions); text-only fallback if
  the caller declines.
- **Kill switch** `receptionistEnabled` unchanged; new behaviour all flag/RemoteConfig-gated.
- **Abuse:** rate-limit Ava minutes per caller; L0/guest callers get shorter handling. In
  first-ring mode (B), cap total Ava minutes/day so an "answer everything" setting can't run up
  unbounded cost.

---

## 10. Rollout plan / milestones

1. **Flags + RemoteConfig** (`receptionistRings=5`, `receptionistEnabled` already exists).
   Defaults safe.
2. **Settings UI fields** (persona, language, greeting, custom prompt, **answer-on-first-ring
   toggle, status dropdown, decline-to-Ava toggle**) + schema ALTERs + `composeReceptionistPrompt()`
   update (inject status). *(Cleanest first win — backend-light, visible.)*
3. **In-thread message bubble** — route `postMessage()` to `dm_…` + new `kind:"receptionist"`
   chat-bubble widget with player. *(Second win — makes v1 output actually visible.)*
4. **Activation modes** —
   (A) express auto-handoff as **5 rings** (`receptionistRings`) in `call_screen.dart`;
   (B) **first-ring** mode: `config` returns `mode:"first_ring"` → caller hands off on ring 1;
   (C) **manual Agent button** on the incoming-call UI (Android three-button first; iOS via
   decline-to-Ava and/or in-app ringing screen) + the decline-routes-to-Ava path.
5. **Native full-duplex audio engine** — shared plugin; AEC + half-duplex-on-speaker + route
   toggle (per-account); swap `ReceptionistCall` onto it; reuse for live/translation calls.
6. **Telemetry + diagnostics** surfacing (incl. `activation_mode` on every session).
7. **Premium dogfood on staging → limited cohort → widen.**

> Ship order note: 2 and 3 are independent and low-risk — do them first. 4C (incoming-UI Agent
> button) needs platform-specific work (iOS CallKit can't show a third button — see §2.3). 5
> (native audio) is the heaviest and benefits live calls too, so scope it as its own workstream.

---

## 11. Cost (unchanged from v1)

Still ≤ 2 min per answered call, ~**$0.05/call** (Gemini Live audio + negligible D1/R2). Mode A
(5 rings) keeps cost low — Ava only answers genuinely unanswered calls. Mode B (answer-all) raises
volume by design while the owner is away, so it carries a **daily Ava-minutes cap** (§9) to keep
spend bounded.

---

## 12. Open questions

- Ring count: **5** default — confirm; expose to the owner or keep RemoteConfig-only?
- iOS Mode C: accept that iOS gets **decline-to-Ava / in-app ringing screen** rather than a true
  third CallKit button? (proposal: yes — Android ships the three-button UI first.)
- Should **first-ring mode** auto-expire (e.g. after N hours / next morning) so the owner can't
  forget it's on? (proposal: optional auto-off timer + a persistent "Ava is answering your calls"
  banner.)
- Status dropdown: final preset list (Busy · Travelling · In a meeting · Driving · On holiday ·
  After hours · Custom) — add/remove any?
- Custom prompt: offer a few **preset personas** (Professional / Friendly / Brief) as one-tap
  starting points above the free-text box? (proposal: yes.)
- Language: default to the **owner's app language** when "Auto-detect" misfires on short audio?

---

## 13. TL;DR

v1 already works end-to-end. v2 adds four things on top, all additive: **(1)** **three activation
modes** — auto after **5 rings** (default), an **"answer every call on the first ring"** toggle for
when the owner is away (with a **status dropdown**: busy / travelling / in a meeting / … that Ava
speaks), and a **manual "Agent" button on the incoming-call screen** plus optional
decline-routes-to-Ava (no missed-call counter — the trigger is ring-based); **(2)** a richer
**Settings → Receptionist** card with **persona name, language (auto + 27), greeting, availability
status, and an advanced custom prompt**, all layered over the unchangeable safety scaffold + 2-min
cap; **(3)** a **native full-duplex audio engine** (platform AEC, half-duplex on loudspeaker,
speaker/earpiece toggle remembered per account) shared with live calls; and **(4)** the taken
message delivered **inside the caller's real chat thread as an agent bubble** with the transcript +
a play button — instead of a hidden separate conversation. Ship the Settings fields and the
in-thread bubble first; the incoming-UI Agent button needs platform-specific work (iOS CallKit
caps at two buttons); treat the native audio engine as its own workstream since live calls benefit
too.
