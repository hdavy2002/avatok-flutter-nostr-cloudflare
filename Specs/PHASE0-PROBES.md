# Phase 0 — Pre-build verification & cleanup (results)

_Run 2026-06-05 against account `fd3dbf43f8e6d8bf65bd36b02eb0abb0` (hdavy2005@gmail.com)._
_Gate for all later phases (§26). Every item below has a recorded yes/no + note._

## 0.1 — Gemma 4 tool-calling — ✅ PASS (native)

`POST /accounts/{acct}/ai/run/@cf/google/gemma-4-26b-a4b-it` with an OpenAI-style
`tools` array returns native structured tool calls. **No fallback needed.**

- **Request shape:** `tools: [{ "type": "function", "function": { "name", "description", "parameters": <JSON-Schema> } }]`. The bare `{name, parameters}` shape is rejected (`body.tools.0.function required`).
- **Response shape:** `result.choices[0].finish_reason == "tool_calls"`, and `result.choices[0].message.tool_calls[] = { id, type:"function", function:{ name, arguments:<JSON string> } }`. A `message.reasoning` field is also returned (thinking mode).
- **Implication for Phase 7:** build the agent executor on native `tool_calls`. Parse `function.arguments` as JSON. Keep the structured-JSON-output prompt only as a defensive fallback if a future model rev regresses.

## 0.2 — Aura-2 voices — ✅ PASS

`POST .../ai/run/@cf/deepgram/aura-2-en` returns `audio/mpeg` (MP3, 24 kHz mono).

- **Param name:** `speaker` (confirmed). `text` + `speaker`.
- **Valid voice IDs (40):** amalthea, andromeda, apollo, arcas, aries, asteria, athena, atlas, aurora, callista, cora, cordelia, delia, draco, electra, harmonia, helena, hera, hermes, hyperion, iris, janus, juno, jupiter, luna, mars, minerva, neptune, odysseus, ophelia, orion, orpheus, pandora, phoebe, pluto, saturn, thalia, theia, vesta, zeus.
- **Price:** $0.03 / 1k characters; supports async queue. Reinforces lazy-TTS (§20.5).
- **Implication for Phase 8:** voice-picker can offer those 40 IDs. `aura-2-es` exists for Spanish; `aura-1` is the cheaper ($0.015/1k) legacy option.

## 0.3 — AWS SigV4 inside a Worker — ✅ PASS

Implemented a pure Web-Crypto SigV4 signer at `worker/src/aws/sigv4.ts` (no AWS SDK —
the SDK does not run on Workers). Verified the signing-key derivation against AWS's
published test vector via `worker/scripts/sigv4_probe.mjs`:

```
derived : f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d
expected: f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d  → PASS
```

`signRequest()` produces Authorization + X-Amz-Date + X-Amz-Content-Sha256 headers and
supports `X-Amz-Target` (Rekognition uses JSON-RPC-style targets) and session tokens.
Live `CreateFaceLivenessSession` call is **flag-gated** until AWS creds are provided
(stub path returns a clear "verification unavailable" — see Phase 1).

## 0.4 — AvaID Flutter bridge decision — ✅ DECIDED

**Chosen: Option 1 — platform-channel bridge to the native AWS Amplify Face Liveness SDK**
(iOS + Android), exposed to Flutter via a `MethodChannel`.

Rationale: Amplify ships a maintained native liveness UI on both platforms with the
correct camera/anti-spoofing UX; a WebView around Amplify JS (option 2) has worse camera
permissions/UX on mobile, and manual capture (option 3) reimplements anti-spoofing we
shouldn't own. The Worker side is already unblocked by 0.3 (SigV4). Client work lands in
Phase 9; the server contract (`/api/id/session` → `/api/id/result`) is built in Phase 1
and is bridge-agnostic.

## 0.5 — Decommission dead infra — ✅ DONE (Stream) / ⏳ MANUAL (RealtimeKit)

- **Stream live inputs:** all **71** pre-existing inputs deleted (25 `spitube-channel-*`
  + 46 keyboard-mash test inputs: `test7`, `uyiuyiuy`, `asdsd`, …). None were AvaLive —
  AvaLive had provisioned zero. `GET /stream/live_inputs` now returns **0**. AvaLive will
  create its own inputs on demand (Phase 9).
- **RealtimeKit apps `avaglobal` / `avablobal`:** cannot be deleted via API (RealtimeKit
  is dashboard-only). **Manual action for the user:** delete these two apps in the
  RealtimeKit dashboard; keep `avatok-calls`.

## 0.6 — Secrets + token — ⏳ NOTED

- **Current secret state:** `avatok-api` has **no** secrets set; `avatok-consumers` has
  only `FCM_SERVICE_ACCOUNT`. The §28 "LIVE" list is aspirational — BREVO / TURN / BUNNY /
  CLERK / POSTHOG are **not** yet deployed. All call sites already env-gate these, so the
  Workers run without them (degraded features no-op). Set during the relevant phase.
- **CF API token rotation:** the spec flags the existing token as having appeared in chat
  logs and recommends rotation. **Per the user's instruction we are continuing with the
  existing token** (`secrets/cf_token`, verified active). **PENDING TO-DO:** rotate it in
  the Cloudflare dashboard and overwrite `secrets/cf_token` + the saved memory when
  convenient. This is a security hygiene item, not a blocker.

## 0.7 — Legal review (AvaCoins / payout) — ⏳ ENGAGED (parallel, BLOCKING for prod money)

Per §10.1 / §10.3, real-money flow (Stripe top-up → AvaCoins → Wise withdrawal) is a
prepaid-payment-instrument pattern (RBI PPI / US money transmission). **Build infra, keep
money-on flag-OFF in production until counsel approves.** This document serves as the
written kickoff record. Decision items for counsel: direct B2B creator payouts vs
stored-value caps vs escrow vs PPI/PA licensing. Gates Phase 2 money-on and Phase 4 prod.

---

## Exit check

- All four probes answered (0.1✅ 0.2✅ 0.3✅ 0.4✅).
- Dead Stream infra removed (`live_inputs` = 0); RealtimeKit cleanup handed to user.
- Secrets state documented; token-rotation noted as pending per user instruction.
- Legal engaged (written record above).
- `tsc --noEmit` = 0 and `wrangler deploy --dry-run` passes on `avatok-api` with the new
  `src/aws/sigv4.ts` present.

**Phase 0 gate: PASSED.**
