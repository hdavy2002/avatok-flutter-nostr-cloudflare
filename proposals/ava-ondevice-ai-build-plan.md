# AvaTok — On-Device Ava AI: Re-Wiring & Build Plan (v4)

**Context:** AvaTok currently routes **all** AI through Cloudflare Workers AI. This plan re-wires the intelligence layer so the everyday AI runs **on-device** (private, offline, ~free to serve), and Workers AI is kept only for heavy reasoning and TTS. It also defines the onboarding/compatibility flow and the device gate.

**Two structural changes in v4:**
- **Nostr is removed.** AvaTok is a standard messaging + audio/video calling app; no Nostr/relay architecture. This plan covers only the AI layer.
- **Revenue shifts off AI inference.** Most daily AI runs in-house on the user's device (near-zero cost to us). We monetize **services** instead: Composio access, cloud-AI top-ups, and group/video calling. Online AI usage drops sharply — that's intended.

**Locked on-device stack (compatible phones):** Cactus engine + Qwen3-0.6B (agent/router + embedder) + STT (Whisper/Moonshine) + sqlite-vec. TTS and hard reasoning stay on **our** CF Workers AI.

---

## 1. Naming

- **AvaTok** — the app: messaging, audio calls, video calls. Works on every supported phone.
- **Ava AI** — the on-device AI brain (compatible phones only).
- **AvaChat** — in-chat AI features (chat with Ava, tool-calling inside a conversation). Part of Ava AI.
- **AvaBrain toggle** — the on/off switch for Ava AI. ON by default on compatible phones; OFF = nothing is captured, embedded, or stored.

---

## 2. Core principles

**A. The model routes and retrieves; it does not train.** Personalization comes from a growing local memory + vector store (RAG), never on-device weight updates.

**B. On-device first.** Try on-device for everything it can do; escalate to cloud only for what it can't.

**C. Privacy = local processing.** On compatible phones, the user's content (messages, files, voice, embeddings, vectors) is processed and stored on the device. Only hard-reasoning prompts (and TTS text, if used) leave the phone.

**D. The engine is swappable.** Cactus sits behind a thin `InferenceEngine` interface so it can be replaced (e.g. with llama.cpp) without touching the app. Models are standard GGUF.

---

## 3. RE-WIRING INSTRUCTIONS (for the builder)

The app already calls Workers AI for everything. **Do not rip Workers AI out** — it stays as the escalation/TTS target. Instead, insert an on-device-first layer in front of it.

**Step 1 — Add an `InferenceEngine` abstraction.** All AI calls go through it. It decides: run on-device (Cactus) or call the cloud (Workers AI via AI Gateway). Today's direct Workers AI calls become the cloud branch of this interface.

**Step 2 — Move these to ON-DEVICE (Cactus + Qwen3-0.6B):**
- Intent understanding / request routing (what is the user asking).
- Agent / tool-calling decisions → Composio MCP (check email, fetch file, set reminder…).
- Embeddings (vectorize messages, files, requests) — Qwen does this.
- Local vector search / RAG retrieval (sqlite-vec).
- Simple Q&A and general chat answerable from local context.
- Voice transcription (STT).

**Step 3 — Keep these on CLOUD (your CF Workers AI via AI Gateway):**
- Hard reasoning / long-document / multi-step / nuanced drafting (escalation when the local model signals low confidence or `escalate`).
- TTS (Ava speaking back), if/when used.
- Anything flagged low-confidence by the on-device model.

**Result:** Workers AI traffic collapses to the hard/long-tail only. Everyday AI is local, private, and free to serve.

---

## 4. Device compatibility gate

Compatible = **RAM ≥ 4 GB AND free storage ≥ ~3–4 GB.** iOS: always compatible (all supported iPhones are 4GB+; skip detection). Android: detect at first AI setup.

| | **Incompatible (< 4 GB)** | **Compatible (4 GB+)** |
|---|---|---|
| Messaging, audio & video calls | ✅ | ✅ |
| On-device Ava AI (chat, find things, memory, STT) | ❌ none | ✅ (on-device, free to serve) |
| AvaChat / tool-calling in chat | ❌ | ✅ |
| Composio access | ❌ | ✅ (paid add-on) |
| Cloud AI top-ups (heavy reasoning) | ❌ | ✅ (paid) |

Incompatible phones get a plain messaging + calls app — **no AI features, no Composio, no AvaChat.** We do **not** fall back to cloud AI chat for them (keeps online inference low). They can still pay for calling services.

---

## 5. Onboarding — "Configure Ava AI" screen

Build a compatibility/onboarding screen with two states.

**Compatible state:**
- Headline: *"Your phone can run Ava AI."*
- Benefits copy: *"Ava runs privately on your device — your chats and files stay on your phone. Use Ava offline to find things, get things done, and have a general chat."*
- Then: let the user **name Ava** and set basic preferences → trigger the background model download → show *"Configuring Ava…"* with progress in settings → enable AI features on completion + checksum pass.

**Incompatible state:**
- Headline: *"Ava AI isn't available on this phone."*
- Copy: *"On-device AI needs more memory than your device has. You can still use AvaTok for messaging and audio & video calls — AI features (AvaChat, smart actions) won't be enabled on this device."*
- No download, no AI surfaces shown.

**Download rules:** WiFi-only by default (opt-in cellular), resumable, checksum-verified. While downloading, keep AI surfaces in a clear "still setting up" state — never hit a half-initialized model.

---

## 6. On-device stack & footprint (compatible phones)

Locked: Cactus + Qwen3-0.6B (agent/router + embedder) + STT + sqlite-vec. STT runs inside Cactus (no extra runtime). TTS + reasoning are cloud.

| Component | Download / disk | Active RAM |
|---|---|---|
| APK (Flutter + Cactus native + sqlite-vec + UI) | ~20–30 MB | ~150–200 MB overhead |
| Qwen3-0.6B (Q4) — agent/router + embedder | ~394 MB | ~400–600 MB |
| STT — Whisper-base / Moonshine-base | ~50–80 MB | ~150–250 MB (on-demand) |
| sqlite-vec | <1 MB (in APK) | negligible |
| TTS + reasoning | $0 — cloud | $0 |

**Headline numbers:**
- Initial APK: **~20–30 MB.**
- Deferred download: **~460 MB** (Qwen ~394 + STT ~65).
- Total installed: **~485 MB** + data growth (~100–300 MB over time).
- Peak RAM: **~700 MB idle** (LLM only), **~900 MB while transcribing** (STT loads on-demand, then frees).
- Require **~3–4 GB free storage**.

Fits a 4GB phone with room to spare. (Cactus zero-copy mmap keeps resident RAM well below file size; load STT on-demand and free it after use.)

---

## 7. Data flow, RAG & the agent

**Embed when:** on message send/receive → embed text + store vector with its SQLite row id; on file index → embed filename + caption/OCR text; on voice message → STT transcribes on-device → embed the transcript; on user request → embed to retrieve. All background, batched, **only when AvaBrain is ON.**

**Vector↔row link:** sqlite-vec virtual table inside AvaTok's SQLite DB; each vector maps to its source row id; retrieval returns row ids → join back to content.

**Agent / request lifecycle:**
1. Request (typed, or voice → on-device STT → text).
2. Embed request → sqlite-vec top-k → pull relevant rows.
3. Semantic tool filtering → narrow Composio tools to the relevant few.
4. Assemble router prompt: request + retrieved rows + filtered tools.
5. Router emits tool-call JSON, answers locally, or signals escalate.
6. Fire Composio MCP tool, or escalate to Workers AI.

**Router output:**
```json
{ "action": "tool_call",            // or "answer" or "escalate"
  "tool": "gmail.search_messages",
  "arguments": { "query": "from:sarah invoice", "after": "2026-06-13" },
  "confidence": 0.0 }
```
Use Cactus's own returned `confidence` / `confidence_threshold` to trigger escalation.

---

## 8. Cloud (your CF Workers AI via AI Gateway)

Run Cactus **local-only** — no `cactus auth`, no `cactusToken`, no Cactus hybrid. Escalation is your code:

- If `action == escalate` or confidence < threshold → call **your Workers AI endpoint via AI Gateway** with the assembled prompt.
- TTS (if used) → a Workers AI TTS model via AI Gateway. **Voice TTS sends text to cloud; if Ava speaks, disclose it.** (STT stays on-device, so incoming voice audio never leaves the phone.)

AI Gateway gives caching, per-user rate limits, fallbacks, analytics. Keep the cloud target behind an abstraction (Workers AI ↔ other = one-line swap). **Verify which STT/TTS models are live in the Workers AI catalog** before committing any voice UX that relies on cloud TTS.

---

## 9. Monetization (revenue moves off AI inference)

Everyday AI runs on-device = ~$0 to serve. Online AI usage drops, and that's the plan. Charge for **services**, not inference:

- **Composio access** — the "act across your apps" layer (email/file/calendar actions). Paid add-on on compatible phones.
- **Cloud AI top-ups** — heavy reasoning beyond what the on-device model handles. Metered/paid.
- **Group & video calling** — premium calling tiers (available to all phones, incompatible included).

On-device AI + basic messaging are the free hook; the paid services are the revenue. Most daily use is in-house, so cloud cost is low and bounded (AI Gateway caps it).

---

## 10. Privacy & compliance

- **AvaBrain toggle ON by default** (compatible phones). OFF = nothing captured, embedded, or stored; no background embedding.
- **Disable Cactus telemetry explicitly** in the Flutter setup (default varies by binding; verify).
- **DPDP Act consent** for on-device processing of messages/files/voice; log consent state.
- **On-device = local.** On compatible phones, content + embeddings + vectors + transcription stay on the device. Only hard-reasoning prompts (and TTS text, if used) leave.
- **On-device-only mode** — optional toggle disabling cloud escalation entirely (no hard-reasoning answers offline).

---

## 11. Licensing & the two Cactus cost vectors

Keep these separate:

**(1) Engine license — applies always.** Cactus is **not MIT** — source-available: free for individuals, students, non-profits, and **orgs with BOTH < $2M total funding AND < $2M gross annual revenue** (org-wide). Above either → paid commercial license (founders@cactuscompute.com); crossing a threshold later → auto-terminates with a **30-day** window.
- Today: **free** (DAVY INTERNATIONAL LIMITED is under both).
- On success past $2M: a license cost at undisclosed price → get the number early.

**(2) Hybrid cloud usage — you don't use it → $0.** Cactus's pricing pages (free cloud minutes/tokens, pay-as-you-go) are for *their* cloud. You run on-device + escalate to *your own* Workers AI, so this never applies.

**Hedge:** Cactus behind the `InferenceEngine` interface; GGUF models, sqlite-vec, and Workers AI are engine-independent. If the license turns unfavorable at scale, swap to **llama.cpp (MIT)** — a one-adapter rewrite.

---

## 12. Build phases

**Phase 0 — Inference abstraction.** Add `InferenceEngine` in front of all current Workers AI calls (cloud branch = existing behavior). Wire `cactus` plugin (local branch), behind it. Host Qwen3-0.6B on R2. One local completion running.

**Phase 1 — Compatibility gate + onboarding.** RAM/storage detection, iOS shortcut, the two-state Configure-Ava screen, deferred R2 download (WiFi/resumable/checksum/pre-config state).

**Phase 2 — Re-wire routing to local.** Move intent/routing, embeddings, simple chat to on-device. Workers AI now escalation-only.

**Phase 3 — Agent + Composio.** On-device router → tool-call JSON → fire a Composio tool (start Gmail/Drive). Semantic tool filtering. Gate Composio behind the paid add-on.

**Phase 4 — Memory / RAG.** Embedder (Qwen) + sqlite-vec; embed on ingest; retrieve into the router prompt.

**Phase 5 — Voice (STT).** On-device transcription (load-on-demand). Voice messages → transcript → agent. (TTS via Workers AI only if/when needed.)

**Phase 6 — Escalation + monetization.** Confidence-based handoff to Workers AI; meter cloud AI top-ups; wire Composio + calling to billing.

**Phase 7 — Privacy hardening.** AvaBrain toggle, telemetry off, DPDP consent, on-device-only mode.

Get one compatible device doing the full local loop (Phases 2–5) before polishing tiering/billing.

---

## 13. Confirmed facts (Cactus repo + docs, June 2026)

- **Local inference needs no Cactus token.** `cactus_init(weights, rag_path, bool)` — no auth param. `cactus auth` / `cactusToken` are hybrid-cloud-only. `--token` flags are HuggingFace tokens for gated models.
- **Cloud handoff is fully disableable** (`--no-cloud-handoff`, `--confidence-threshold`); completion returns `cloud_handoff: false` + a `confidence` score.
- **Qwen3-0.6B** is listed as completion + tools + embed (one model = router + agent + embedder). STT runs natively in Cactus.
- **License:** source-available, free under the $2M dual threshold; hybrid cloud pricing is separate and unused.

---

## 14. Open questions — verify

1. **Workers AI STT/TTS catalog** — confirm which models are live before relying on cloud TTS.
2. **Cactus commercial-license price** above $2M — email early.
3. **Quantization** of Qwen3-0.6B / STT on target devices — quality on *your* prompts.
4. **Composio tool set** — fine-tune/prompt the router on your actual Composio schemas.
5. **Free-storage threshold** — confirm ~3–4 GB free is enough across target devices (footprint ~485 MB + data growth).

---

## 15. Quick reference — Cactus (Flutter, local-only)

```dart
import 'package:cactus/cactus.dart';

// Agent/router + embedder — no token for local inference
final lm = await CactusLM.init(modelUrl: '<R2 qwen3-0.6b gguf>', contextSize: 2048);
final res = await lm.completion(messages, maxTokens: 256, temperature: 0.3, mode: 'local');
final emb = await lm.embedding('text', mode: 'local');

// Voice in — STT on-device, on-demand, then free it
final stt = await CactusSTT.init(modelUrl: '<R2 whisper-base gguf>');
final text = await stt.transcribe(audioPath);

// Escalation = YOUR Workers AI via AI Gateway (not Cactus hybrid):
// if (res.action == 'escalate' || res.confidence < threshold)
//    answer = await myWorkersAIviaAIGateway(prompt);

// Disable telemetry explicitly in setup.
```

---

*Re-wire: put an InferenceEngine in front of today's Workers AI calls. On compatible 4GB+ phones, route intent, agent/tool-calling, embeddings, memory, and STT to on-device Cactus + Qwen + sqlite-vec; keep Workers AI for hard reasoning + TTS only. Incompatible phones get plain AvaTok messaging/calls, no AI. Revenue moves to Composio, cloud top-ups, and calling — everyday AI runs in-house, free to serve. Cactus is local-only behind a swappable engine; free under $2M, llama.cpp as the exit.*
