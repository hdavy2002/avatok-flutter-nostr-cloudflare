# PHASE-0 GLUE — Spike & Pricing

**Doc-only phase. NO shared files edited. NO product files touched. NO commit.**

## Files created (all throwaway / docs, under owned paths)
- `Specs/avavision-build/PRICING.md` — the deliverable.
- `Specs/avavision-build/spike/index.html` — throwaway 3-layer spike (camera + MediaPipe/MoveNet
  overlay + knee-angle score; Gemini Live WS at LOW res 1 fps + mic; one snapshot call). **Delete in Phase Z.**
- `Specs/avavision-build/spike/README.md` — how to run the spike with a manually-minted ephemeral token.
- `Specs/avavision-build/glue/PHASE-0-GLUE.md` — this file.

## Shared-file edits required: NONE.

## Numbers Phase 1 MUST hard-code (from PRICING.md §8)
- `AVAVISION_MIN_RATE_PER_HOUR = 300` coins/hr ($3/hr) — **new** constant, do not change AvaVoice's
  `MIN_RATE_PER_HOUR = 100`. (Use 320 if you want margin on the chatty-coach + snapshot tail.)
- `free_snapshots_per_session` template default = **3** (range 2–6); enforce with a D1 counter column
  `snapshot_calls` on `avavision_sessions` — **no Durable Object, no token bucket** (MASTER §3).
- `AVAVISION_SNAPSHOT_MODEL` default = **`gemini-3-flash-preview`** (code execution on; verify vs live
  key — preview id may roll to GA `gemini-3-flash`).
- Live model = `gemini-3.1-flash-live-preview`; voice fallback `gemini-live-2.5-flash-native-audio`.
- Token video config = `MEDIA_RESOLUTION_LOW`, ~1 fps, server-locked.
- `CREATOR_PAYS_RATE_PER_HOUR = 500` is **unchanged** — $5/hr flat covers voice+video (margin ~$3.4/hr).

## Owner flag
AvaVoice's existing 100-coin floor is marginal for a chatty voice agent; AvaVision sets its own higher
floor (300) rather than inheriting it. Surfaced in PRICING.md §4 — no action taken here.

## Build/test results
Doc + throwaway HTML only — nothing to compile. Pricing math cross-checked two ways (token rates vs
Google per-minute rates), agree within ~25%; policy set on the conservative column. Spike requires a
live key + camera to produce real USAGE numbers (run locally per spike/README.md).

## Drift from MASTER
None. Confirmed: snapshot model exact id is `gemini-3-flash-preview` (MASTER suggested `gemini-3-flash`).
