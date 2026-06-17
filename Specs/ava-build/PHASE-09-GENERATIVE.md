# Phase 9 — Generative (Image gen, async in-thread)

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0, P3 (async `ava_status` + post result). PaidFeature for metering.

## OWNED FILES
- NEW: `worker/src/routes/ava_image.ts` — `POST /api/ava/image`: Gemini Nano Banana 2
  (3.1 Flash Image) generate/edit; llama-guard on prompt + output; upload result to
  R2/public CDN; return a media ref.
- NEW dir `app/lib/features/ava_generative/` — request affordance ("Ava, make a
  logo…"), registers an `image.generate` AvaTool (the shim P5 references).

## DO NOT TOUCH
P0 hot files, spine files (P3 — use its posting + `ava_status` API).

## Tasks
1. Async UX: post `ava_status` ("Ava is generating an image…") immediately; group
   keeps chatting; when ready, post the image as an `ava` message into the thread.
2. **Premium**: wallet-metered via PaidFeature (deduct coins per image).
3. **Moderation mandatory** on prompts and outputs (deepfake/abuse), incl. minors.
4. Support edit ("make it blue") and stickers/memes if cheap.

## Acceptance
- "Ava, make me a logo" shows the working chip, then drops the image into the thread.
- Wallet deducts; moderation blocks disallowed prompts/outputs.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
