# PROPOSAL — Ava Receptionist for AvaTalk ("Ava answers after 5 rings")

**Status:** Proposal / not yet built
**Author:** Owner + Claude
**Date:** 2026-06-19 (updated with owner direction)
**Framing:** This is an **AvaVoice assistant helping AvaTalk** — the first real deployment of
the Ava voice pipeline. The **future general AvaVoice product will be built on top of what we
ship here.** Treat the code as the AvaVoice foundation, not a throwaway.
**Related:** `AVAVOICE-PROPOSAL.md`, `PROPOSAL-LIVE-TRANSLATION-GEMINI.md`,
`AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`, `AVATALK-CLOUDFLARE-RULEBOOK.md`.

---

## 0. Owner decisions baked into this version

- **Premium-only** feature. Not for free accounts.
- **Gemini stack** (not the full Cloudflare voice stack): **Gemini Live 3.5 API** for the
  conversation + **Gemini File Search** for RAG.
- **Everything piped through Cloudflare AI Gateway → Gemini** (Realtime WebSockets API), so we
  get **metering + observability** from day one even though we don't charge yet.
- **2-minute hard cap** per call; system prompt starts wrapping at **1:20** and is force-cut at
  **2:00**.
- **No booking/slots** in this version (AvaVoice bookings come later).
- New AvaTalk settings section for AvaVoice with a **"Leave Instructions for Ava"** box.
- After the call, **Ava posts a message + voice recording under the caller's phone number.**
- **Contacts overhaul:** replace email-based contacts with **WhatsApp-style phone-number
  contacts** pulled from the device contact list. GUI changes from email search to
  **"Search phone number."**
- **PostHog telemetry** for fault-catching/diagnostics; logs surfaced in the **user's
  diagnostics** view too.
- **Metering/charges:** designed in (via AI Gateway) but switched **on later**.

---

## 1. The idea (one line)

When someone calls a **premium** AvaTalk user and they don't answer after ~5 rings, **Ava**
(their AvaVoice assistant) picks up, follows the user's written instructions, talks for **up to
2 minutes**, takes a message, then **posts that message + a voice recording into the caller's
contact thread** for the user to hear later.

---

## 2. Why this lives in AvaTalk, not WhatsApp (constraint)

You can't intercept a call ringing on a personal WhatsApp number — Meta exposes no API for it.
The WhatsApp **Business** Calling API only fires for calls to a *business* number, needs direct
Meta-partner approval, and from **15 Jan 2026** bans general-purpose AI chatbots on the
platform. We own the AvaTalk call stack end-to-end, so we can do what WhatsApp can't.

---

## 3. Reuse map (what already exists)

| Need | Component | Path |
|---|---|---|
| 1:1 call signaling + ring state | `CallRoom` DO | `worker/src/do/call_room.ts` |
| Call entrypoint | `call()` | `worker/src/routes/api.ts` (L35) |
| Agents / sessions / kill switch | `AvaVoice` | `worker/src/routes/avavoice.ts` (`ensureStore` L184) |
| Speech-to-speech | **Gemini Live 3.5** (we already run Gemini Live for Live Translate) | — |
| Media transport | Cloudflare Realtime / TURN | `TURN_KEY_API_TOKEN` |
| Diagnostics logging | PostHog `diag_logs` | (Cloudflare-native pivot) |
| Settings surface | Voice settings section | `app/lib/features/settings/sections/voice_section.dart` |
| Push / resync | push service, `RelayHub.ensureConnected` | `app/lib/core/push_service.dart` |

Note: in this version we **do not** use `ava_rag` / Vectorize — RAG is **Gemini File Search**.

---

## 4. Product behaviour (UX)

1. **A calls premium user B.** B's device rings as today.
2. **No answer after 5 rings (~28 s)** → if B is premium, has Ava enabled, and the
   `receptionistEnabled` kill switch is on → call flips to **Ava receptionist mode**.
   (Otherwise: normal missed call.)
3. **Ava greets** using B's **"Leave Instructions for Ava"** text. Example instruction from B:
   *"Take a message and let them know I'm in a meeting."* Ava: *"Hi, you've reached Sonal's
   assistant — she's in a meeting right now. I can take a message for her."*
4. **Conversation, capped at 2:00.** Hidden system prompt: be concise; **begin wrapping up at
   ~1:20**; **must end the call by 2:00.** Ava answers quick questions via Gemini File Search
   over B's knowledge (optional) and collects a message.
5. **On hang-up / cap:** Ava writes a **new message under A's phone number** (the contact
   thread) containing: structured summary (caller, reason, callback, urgency), full transcript,
   and a **voice recording** of the call for B to play back.
6. **B is notified** via push and sees a "📋 Ava message" card in that contact's thread.

Edge cases: caller hangs up early → save partial; both sides are receptionists → single prompt
+ no loop; B grabs the call before Ava answers → normal call.

---

## 5. Architecture — Gemini stack via Cloudflare AI Gateway

```
A (Flutter) --WebRTC audio--> Cloudflare Realtime/TURN <--> CallRoom DO
                                                              |
                                       (no-answer alarm)      |
                                                              v
                                                   Ava receptionist bridge (Worker/DO)
                                                              |
                                   ┌──────────────────────────────────────────────────┐
                                   │  Cloudflare AI Gateway  (Realtime WebSockets API)  │  <-- metering + observability
                                   │                 │                                  │
                                   │                 ▼                                  │
                                   │   Gemini Live 3.5  (speech ↔ speech)               │
                                   │   + Gemini File Search  (RAG / knowledge)          │
                                   └──────────────────────────────────────────────────┘
                                                              |
                            D1 (sessions, messages) + R2 (voice recording) keyed by PHONE NUMBER
                                                              |
                              PostHog telemetry  +  in-app user diagnostics
                                                              |
                                              push + contact-thread delivery to B
```

**Why this is metering-ready now:** Cloudflare AI Gateway's **Realtime WebSockets API**
officially supports the **Google Gemini Live API**, giving us per-session token/usage
visibility and a single choke point to attach AvaCoins charges later — without re-plumbing.

---

## 6. AvaTalk Settings → AvaVoice section ("Leave Instructions for Ava")

Add an **AvaVoice** section in AvaTalk settings (`voice_section.dart`), premium-gated:

- **Master toggle:** "Let Ava answer calls I miss" (default OFF).
- **"Leave Instructions for Ava"** — a free-text box (multi-line). This is B's plain-English
  brief, e.g. *"Take a message and tell them I'm in a meeting. If it's my brother Sam, tell him
  to call my office line."* This text is injected into Ava's hidden system prompt.
- **Persona/voice picker** (reuse AvaVoice voice preview clips); default voice if unset.
- (Later) knowledge for File Search; (later) metering/usage display.

The hidden system prompt = fixed scaffolding (role, 2-min timing rules, "you are an assistant,
never claim to be the human, disclose recording") **+** B's "Leave Instructions for Ava" text.

---

## 7. Conversation timing & cutoff (2-minute cap)

- On Ava-answer, start two DO alarms: **soft @ 1:20**, **hard @ 2:00**.
- System prompt explicitly states: *"You have a strict 2-minute limit. Around 80 seconds, begin
  closing: confirm the message and say goodbye. By 120 seconds the call ends."*
- **Soft alarm (1:20):** inject a system turn telling Ava to wrap up now.
- **Hard alarm (2:00):** Ava speaks a closing line, then the bridge tears down the session
  regardless of state. Always save whatever was captured.

---

## 8. Message + recording delivery (keyed by phone number)

- Record the call audio to **R2**: `media/<AccountScope.id>/ava/<phone>/<call_id>.opus`.
- Create a **new message in the thread for A's phone number** with:
  - `summary_json` (caller name, reason, callback, urgency),
  - `transcript` text,
  - `recording_url` (the playback the user listens to).
- Card renders in the contact thread as an "Ava message" with a play button + summary.
- Fire push to B.

---

## 9. Contacts overhaul — WhatsApp-style phone-number contacts

**Current:** people are added / searched by **email**. **New:** mirror WhatsApp — contacts are
**phone numbers** sourced from the device contact list.

- **Permission:** request device-contacts permission (iOS/Android), per platform rules.
- **GUI change:** replace "search email" with **"Search phone number."** As the user types a
  **name from their device contacts**, matching entries surface as **name + phone number**
  cards to add as a real AvaTalk contact.
- **Identity key:** contacts and threads are keyed by **normalized phone number (E.164)** so
  the receptionist message in §8 attaches to the right contact even for unknown callers.
- **Matching:** look up whether that phone number is an existing AvaTalk user; if yes, link the
  account; if no, keep it as a phone-only contact (still callable / messageable per current
  rules).
- **Migration:** keep existing email-linked contacts working; new adds go phone-first. Plan a
  backfill that maps known users' phone numbers where available.
- **Scoping:** contact store is per-account (`AccountScope.id`) — parent + child share a phone.

> This is a notable change touching onboarding/add-contact flows and the data model
> (`contacts` keyed by phone). Flagged as its own workstream within this proposal.

---

## 10. Metering & charges (designed now, on later)

- **All Gemini Live + File Search traffic routes through Cloudflare AI Gateway**, which records
  per-session usage. This is the metering hook.
- **Now:** premium perk, **no per-call charge**; we only *record* usage for cost visibility.
- **Later:** flip on AvaCoins billing at the AI Gateway choke point (per answered minute,
  mirroring Live Translate economics). Empty wallet → Ava disabled, never blocks normal calls.
  No re-architecture needed to enable.

---

## 11. Observability — PostHog + user diagnostics

- **PostHog telemetry** on every stage for fault-catching: `ava_call_triggered`,
  `ava_session_started`, `ava_stt_error`, `ava_model_error`, `ava_softcap_1m20`,
  `ava_hardcap_2m`, `ava_message_posted`, `ava_session_failed` (with latency + AI Gateway
  request id + error payloads).
- **User diagnostics view:** surface these logs in the in-app diagnostics screen (the existing
  `diag_logs` pipeline) so the owner/user can see exactly what happened on a given call —
  trigger, model errors, cutoff reason, delivery success.
- **AI Gateway logs** complement PostHog with token/usage + upstream Gemini errors.

---

## 12. Data model (D1)

- Reuse `sessions`: add `kind="receptionist"`, `owner_account`, `caller_phone`, `call_id`,
  `summary_json`, `transcript`, `recording_url`, `duration_s`, `cutoff_reason`,
  `ai_gateway_request_id`.
- `contacts` (new/overhauled): keyed by **E.164 phone**, `display_name`, `linked_account?`,
  `account_scope`.
- `receptionist_settings` (or columns on `avavoice_agents`): `enabled`, `instructions_text`,
  `voice_id`, keyed by `owner_account`.

---

## 13. Guardrails (rulebook)

- **Premium gate** enforced server-side (not just UI).
- **Per-account scoping** for settings, recordings, contacts, message caches.
- **AvaBrain consent** toggles honoured for transcripts; private content on-device only.
- **Kill switch** `receptionistEnabled` in `routes/config.ts`, default OFF.
- **Recording disclosure** in Ava's greeting (two-party-consent regions).
- **No impersonation** — Ava always identifies as an assistant.

---

## 14. Cost analysis

Conversation is capped at **2 minutes**, so cost per answered call is low.

| Item | Per answered call (≤2 min) |
|---|---|
| Gemini Live 3.5 audio (in+out, ~$0.023/min) | **~$0.046** |
| Gemini File Search (RAG, optional, short) | ~$0.00–0.01 |
| Cloudflare Realtime/TURN audio egress (~a few MB) | negligible |
| AI Gateway | no per-request fee (usage logging) |
| D1 + R2 (message + recording) | negligible |
| **Total** | **~$0.05 per call** |

Illustrative monthly: 1,000 answered calls ≈ **~$50**; 5,000 ≈ **~$250**. Trivial at test
scale; premium pricing more than covers it once metering is on.

> Caveat: Gemini Live per-minute rate from public pricing; confirm current 3.5 rate at build.

---

## 15. Risks & compliance

- **Recording/consent:** disclose in greeting; honour two-party-consent regions; allow
  text-only message if caller declines recording.
- **Contacts permission:** device-contact access is sensitive — clear rationale + per-platform
  consent; store scoped per account.
- **Latency:** keep the loop conversational; AI Gateway + Gemini Live streaming handles this.
- **Cutoff UX:** ensure the 2:00 hard cut still saves a message and ends gracefully.
- **Abuse:** rate-limit Ava minutes per caller; L0/guest callers get shorter handling.

---

## 16. Rollout plan / milestones

1. **Flags off.** `receptionistEnabled` (global) + per-user premium opt-in (default OFF).
2. CallRoom 5-ring alarm + state machine + fallback to missed call (no Ava yet).
3. Ava bridge: CallRoom → **AI Gateway → Gemini Live 3.5** happy path with fixed greeting.
4. "Leave Instructions for Ava" settings box → injected into system prompt.
5. 2-min timing (soft 1:20 / hard 2:00) + graceful cutoff.
6. Message + voice recording posted under caller's **phone number**; push + thread card.
7. Gemini File Search RAG (optional KB).
8. **Contacts overhaul** (phone-number, "Search phone number", device contacts) — parallel
   workstream; can ship slightly behind the receptionist if needed.
9. PostHog telemetry + user diagnostics surfacing.
10. Premium dogfood on staging → limited premium cohort behind flag → widen.
11. (Later) turn on AvaCoins metering at the AI Gateway choke point.

---

## 17. Open questions

- Ring count fixed at 5 (proposal: yes).
- Default Ava voice/persona when B sets instructions but no voice.
- Contacts: hard cutover to phone-first vs. dual email+phone during transition (proposal: dual
  during transition, phone-first for new adds).
- Should Ava read B's instructions verbatim tone, or rephrase into a polished greeting
  (proposal: rephrase, constrained by the instruction's intent).

---

## 18. TL;DR

Premium feature. Wire `CallRoom`'s no-answer path to **Ava**, running **Gemini Live 3.5 +
Gemini File Search**, **piped through Cloudflare AI Gateway** for metering/observability. New
AvaTalk **AvaVoice settings** with a **"Leave Instructions for Ava"** box drives the hidden
prompt. Calls are **capped at 2 min** (wrap at 1:20, cut at 2:00). Afterwards Ava posts a
**message + voice recording under the caller's phone number.** Contacts move to **WhatsApp-style
phone numbers** ("Search phone number" from device contacts) instead of email. **PostHog +
in-app diagnostics** for fault-catching. Metering is designed in but **charges come later**.
This is the **AvaVoice pipeline's first real deployment** — build it as the foundation.
