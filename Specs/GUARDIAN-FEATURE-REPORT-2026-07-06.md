# Ava Guardian — Feature Report (2026-07-06)

What the Guardian does during a chat session, how it works end-to-end, its use cases, and what could be added or deleted.

Sources: `worker/src/routes/ava_guardian.ts`, `worker/src/routes/messaging.ts`, `worker/src/lib/moderation.ts`, `worker/src/routes/config.ts`, `app/lib/features/ava_guardian/` (guardian_settings.dart, guardian_warning.dart), `app/lib/features/settings/sections/guardian_section.dart`, `app/lib/features/avatok/chat_thread.dart`, `Specs/ava-build/PHASE-08-GUARDIAN.md`, Graphiti (`proj_avaflutterapp`).

---

## 1. What it is

Guardian is Ava's chat safety layer (built as Phase 8). It watches messages flowing through the platform and privately warns the at-risk recipient — never the sender — when it detects scams, spam, grooming/luring, threats, hate, CSAE, trafficking, or (structurally, not yet really) deepfake media. It also maintains parent↔child links, escalates repeat offenders to an auto-block, alerts linked parents, and can build a weekly parent digest.

Owner decisions baked in:

- **Free on all plans** (2026-06-24) — `isEntitled()` hard-returns `true`; no premium gating anywhere despite "PREMIUM" comments and a `PaidFeature` wrapper still lingering in code/docs.
- **Adult sexual content is never flagged** — explicit policy in `mapNemotronCategories`.
- **Parent digest UI hidden** (2026-07-04, `kParentDigestUiEnabled=false`) because no cron delivers it.

Kill switches (KV `platform_config`): `guardianEnabled` (master — hides all UI and no-ops every scan) and `safetyScanEnabled` (the always-on Nemotron pass only). Both default ON in code; **remember the KV lesson: KV overrides code defaults and the reader does not fall back** — flag flips must be patched in KV.

---

## 2. What happens during a chat session (message lifecycle)

### 2.1 Send path (server)

When any user sends a message, `messaging.ts` fans it out to recipients' InboxDOs **first**, then fires a detached, non-blocking call:

```
void guardianScan(env, { conv, message: payload, members, senderUid, geo: {country, region, city, colo, ip} })
```

Delivery is never delayed or blocked — Guardian is observe-and-warn, not a filter. Nothing is ever censored or dropped.

### 2.2 Inside `guardianScan` — the tiered scan

The design is a **cost staircase**: cheap things run always, expensive things only on signal.

1. **Skip Ava's own kinds** (`ava`, `ava_private`, `ava_status`) and no-op if `guardianEnabled=false`.
2. **Extract text** from the raw body or the `{t, body|text}` JSON envelope.
3. **Tier 0 — cheap regex heuristics (free, every message):** `cheapScan()` runs pure string patterns:
   - *Grooming signals* (highest priority): secrecy ("don't tell your mom", "our secret", "delete this chat"), move-off-platform (Snap/WhatsApp/Telegram/number requests), meet-up requests, age probes, intimacy/photo requests. 1 signal → severity 2, 2+ → severity 3.
   - *Scam patterns:* gift cards, crypto+send/invest, wire/Zelle/CashApp, verify-your-account/OTP, lottery/prize, guaranteed returns, link shorteners. 1 hit → sev 2, 2+ → sev 3.
   - *Spam patterns:* "click here / act now / dm me for promo…" — needs 2 hits, sev 1.
4. **Deepfake check** if `media_ref` present — pipeline is real (fetches R2/HTTP bytes) but `detectSynthetic()` is a **stub** returning `not_checked`; it can never fire today.
5. **Tier 1 — always-on Nemotron content-safety scan** (once per message, `safetyScanEnabled`): `moderate()` via OpenRouter `nvidia/nemotron-3.5` (free tier). Fail-open. Categories mapped: csae/trafficking/grooming (sev 3), hate/threat/scam (sev 2). Adult sexual content explicitly returns null (no flag).
6. **Per-recipient loop** (recipients = members minus sender). For each recipient:
   - Read per-(uid,conv) prefs `{secure_chat, deep_monitor}` from D1 `ava_guardian_prefs`.
   - Compute `deep` = own deep_monitor pref, or being a child whose linked parent exists (entitlement now always true).
   - **Tier 2 — AI security classifier** `classifyThreat()` (Claude Opus 4.8 via OpenRouter) runs only when the chat is *watched*: secureChat ON, deep monitoring, or a cheap-heuristic hit needing triage. This is what catches nuanced grooming the keyword list misses; it can also return a tailored `advisory` used as the warning text.
   - Category resolution order: deepfake hit > cheap/Opus verdict > Nemotron fallback.

### 2.3 On a flag — what the recipient experiences

For each flagged recipient, in order:

1. **Durable flag row** written to D1 `ava_guardian_flags` (id, uid, conv, peer, category, severity 1–3, detail) — powers escalation counting and the parent digest.
2. **Live `safety_flag` frame** pushed over the recipient's InboxDO WebSocket carrying the offending message's `client_id` → the open chat **paints that bubble red immediately**. The sender never receives this frame.
3. **Private warning message** (`postAvaMessage` with `private:true`, source `guardian`) — an `ava_private` message written *only* to the at-risk user's InboxDO. Body meta carries `{guardian:true, category, severity, red_flag:true, flagged_client_id, flagged_created_at, peer}`. Warn policy: grooming/scam/deepfake/csae/trafficking/threat/hate always warn; spam only at sev ≥ 2 (avoid nagging). Warning copy is category-specific, child-appropriate, non-graphic, and always ends "(Only you can see this message.)".
4. **Escalation (grooming/scam only):**
   - Count sev≥2 flags from the *same sender* in this conv over 30 days. At **3 flags** (`BLOCK_THRESHOLD`) → auto-insert into the `blocks` table (recipient blocks sender; the messaging gate rejects all future sends), send a "Ava has blocked this person" private message, and push-alert the linked parent.
   - A single sev≥2 grooming/scam flag already push-alerts the linked parent ("Ava flagged a grooming message sent to your child").
5. **Telemetry** (PostHog, category `guardian`): `guardian_scan` on every scan (conv, kind, group?, recipients, msg_len, cheap_hit, sender email, country/region/city/colo/IP), plus `safety_scan`/`safety_scan_error`, `guardian_flag` (who→who with emails, category, severity, engine, classifier latency), `guardian_warning_sent`, `guardian_sender_blocked`, `guardian_shield_toggled`, `guardian_adult_optout_set`.

### 2.4 Client rendering (chat_thread.dart)

- **Shield header icon** per chat (hidden when `RemoteConfig.guardianEnabled` is false). Tap = toggle secure-chat watching (green = on); long-press = full `GuardianSettingsSheet`.
- Incoming `ava_private` guardian envelopes render as lilac "AVA · PRIVATE" bubbles; `GuardianWarningCard`/`GuardianWarningSheet` add a tappable card with **Block this person / Report to AvaTOK / Dismiss** actions.
- Red-bubble state persists per account via `SafetyFlagStore` (survives reopen); a locally dismissed "This is fine" removes it. Live `safety_flag` frames update open threads in real time; offline recipients still get the durable warning message + flag row.

---

## 3. Surfaces and controls

| Surface | What it holds |
|---|---|
| Per-chat sheet (`GuardianSettingsSheet`, from shield long-press) | Secure-chat mode toggle; "always-on deep monitoring" toggle (both free). Server is source of truth via `POST /api/ava/guardian/scan` `{prefs}`/`{get_prefs}`; graceful per-account DiskCache fallback offline. |
| Settings → "Guardian / safety" (`guardian_section.dart`, order 28) | Scam-shield assurance row (read-only — basic safety can't be turned off), account-wide deep-monitor default for new stranger chats, warning-display (banner) pref, adult-content warning opt-out, parent digest opt-in (**hidden**, `kParentDigestUiEnabled=false`). Section registers/unregisters live on `guardianEnabled` config polls. |
| Adult opt-out (F6) | Account-wide `ava_guardian_account_prefs.adult_optout`. Adults may hide adult-content caution cards. Server **refuses for minors** (403 `minor_cannot_opt_out`, checked against `users.birth_year`); client also hides the toggle for minors. Fail-open toward adult if birth_year unknown. |

### API route — `POST /api/ava/guardian/scan` (single multi-mode endpoint, Clerk-authed)

| Body | Action |
|---|---|
| `{conv, message|text, members?, sender?}` | On-demand scan; caller is the protected recipient |
| `{media_ref}` | Deepfake check (stubbed) |
| `{prefs:{conv, secureChat?, deepMonitor?}}` / `{get_prefs:{conv}}` | Per-chat prefs |
| `{adult_optout: bool}` / `{get_adult_optout:true}` | Adult opt-out (minor-refused) |
| `{link_child:{child_uid}}` | Record parent↔child link |
| `{digest:true, windowDays?}` | Caller's parent digest (≤31 days) |

### Data model (self-creating D1 tables in DB_META, no migrations)

`ava_guardian_prefs` (uid, conv, secure_chat, deep_monitor) · `ava_guardian_flags` (flag log) · `ava_parent_links` (parent_uid ↔ child_uid, one parent per child) · `ava_guardian_account_prefs` (adult_optout).

---

## 4. Use cases

1. **Child protection (core):** a stranger DMs a child with grooming language → red bubble + private child-friendly warning; parent push-alerted on serious flags; repeat sender auto-blocked after 3 strikes. Parent-linked children get deep monitoring implicitly.
2. **Scam protection for everyone:** gift-card/crypto/OTP/phishing patterns caught free on every message, in DMs and groups.
3. **Stranger-chat vigilance:** user turns on the shield for one suspicious chat → Opus classifier runs on every incoming message there.
4. **Content safety floor:** always-on Nemotron pass flags hate/threat/CSAE/trafficking platform-wide, while deliberately leaving adult peer speech alone.
5. **Parental oversight:** flag log rolls up into a per-child weekly digest (built, not delivered — see gaps).
6. **Trust & safety telemetry:** every scan/flag/block records who→who, category, engine, latency, and geo/IP — evidence trail for abuse investigation.

---

## 5. Gaps / candidates to ADD

1. **Deepfake detection is a stub** — `detectSynthetic()` always returns `not_checked`, so the `deepfake` category, its warning text, and the media UI card are dead paths. Wire a real detector (Hive/Sightengine/Reality Defender via Worker secret, or a Workers-AI model when available) or delete the surface. Note: the frozen Trust Engine (Specs/TRUST-ENGINE-ARCH.md) standardizes on AWS Rekognition behind generic provider interfaces — a Rekognition-based or Trust-Engine-shared ModerationProvider would fit, but AWS creds are still unconfigured on avatok-api (2026-07-05).
2. **Parent digest never fires** — `runParentDigests()` exists but no cron/scheduled handler calls it; UI hidden for exactly this reason. Add a weekly `scheduled` handler + a real delivery channel (the push preview is one line; Brevo email would be richer), then flip `kParentDigestUiEnabled`.
3. **No parent↔child linking UX** — `{link_child}` API exists but nothing in the app calls it; `ava_parent_links` only fills if something writes it. Without links, parent alerts, child-implied deep monitoring, and digests are all inert. Wire it into the child-account creation / family flow.
4. **Only text + images are scanned** — voice notes, video, stickers, polls, contact cards, and location messages bypass Guardian entirely. Voice notes already have a transcription path (2026-07-04 work); feeding transcripts into `guardianScan` is cheap.
5. **Per-message scan, no thread memory** — grooming often escalates gradually across many individually-innocent messages. The 30-day flag count is the only cross-message signal. Consider a rolling per-(conv,sender) risk score or feeding recent context into `classifyThreat`.
6. **Cost exposure on the Opus classifier** — `classifyThreat` uses Claude Opus 4.8 via OpenRouter and runs on *every* message in watched chats. No rate cap, budget breaker, or cheaper-model fallback (contrast: the Trust Engine mandates quota-aware breakers). A hostile user with secureChat on in a busy group = unbounded spend. Add a per-conv/day cap and a downgrade path (Nemotron-only) on quota.
7. **No user-visible flag history** — flags land in D1 and telemetry, but the protected user (or parent, outside the unbuilt digest) has no in-app "safety activity" view. A simple list from `ava_guardian_flags` would increase trust.
8. **Report action destination** — `GuardianWarningSheet`'s "Report to AvaTOK" is a host-wired callback; verify every host actually wires it to a real report pipeline that lands somewhere reviewable (admin dashboard).
9. **False-positive feedback loop** — "This is fine" dismissal is local-only; it never teaches the server. Track dismissals as telemetry (or a flag-row status) to tune the regexes and prompts.
10. **`ava_guardian_flags` growth** — no TTL/pruning; only a 30-day window is ever read for escalation and ≤31 days for digests. Add retention cleanup.

## 6. Candidates to DELETE / clean up

1. **Dead premium plumbing** — `isEntitled()` stub, the 402 revert path in `GuardianPrefsClient.set`, `PaidFeature` import in guardian_section, and all "PREMIUM" comments contradict the 2026-06-24 free decision. Either delete or keep one clearly-marked re-enable point.
2. **Redundant "deep monitoring" toggle** — with entitlement always true and secure-chat already running the Opus classifier per message, deep monitoring adds nothing per-chat (the code comment itself says it's redundant). Options: collapse both toggles into a single "Ava is watching this chat" switch, or keep deep as the account-wide default only.
3. **Stale llama-guard references** — header comments still describe `@cf/meta/llama-guard-3-8b` / `ai_gate.isSafe` as the escalation model; actual code uses `classifyThreat` (Opus) + `moderate` (Nemotron). Update comments and PHASE-08 spec so future agents don't rebuild against the wrong model.
4. **Deepfake surface (if not wiring a model soon)** — the category, warning copy, `{media_ref}` API mode, and client card are all unreachable; consider hiding until a detector lands rather than shipping a "This image may be fake" path that can never trigger.
5. **`readConfig` called twice per scan** (master switch, then safetyScanEnabled) — trivial, but one read suffices.
6. **PII in telemetry** — every `guardian_scan` records sender email + raw IP for *all* traffic in watched chats. Useful for abuse forensics, but it's broad PII collection on innocent messages; consider limiting IP/email capture to flagged events only (also relevant for Play/App Store data-safety declarations).

---

## 7. Privacy posture (worth preserving as-is)

Warnings are strictly one-sided (`ava_private` writes only the at-risk user's InboxDO — verified against `do/ava_agent.ts`); the sender never learns a scan, flag, warning, or safety_flag frame happened. E2E/on-device-only content is never read. Minors can't disable adult-content warnings (server-enforced). Everything is fail-open and best-effort so safety machinery can never break message delivery.
