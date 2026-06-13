# PHASE 0 — Spike & pricing (throwaway code, runs in parallel)

> Carry `MASTER-PROMPT.md`. This phase touches **no product files**. It produces measurements +
> one document. Output: `Specs/avavision-build/PRICING.md`. Then a Graphiti episode. No commit.

## Why this phase exists
Vision sessions stream video to Gemini Live (extra tokens beyond audio) and the "Analyze my form"
snapshot is a separate metered call. Before any listing goes live we must know the **real $/hr** so
the platform minimum rate never lets a user-pays listing run at a loss, and so the snapshot fair-use
cap keeps margins safe. We also confirm the engine stack actually runs end to end.

## You own (create only these — all throwaway / docs)
- `Specs/avavision-build/spike/` — any throwaway scripts/HTML you write to measure (not shipped).
- `Specs/avavision-build/PRICING.md` — the deliverable.
- `Specs/avavision-build/glue/PHASE-0-GLUE.md` — your glue note (just says "doc-only, no shared edits").

## Tasks (in order)
1. **Read** `Specs/AVAVISION-PROPOSAL.md` §2, §4 and `worker/src/routes/translate.ts` (the ephemeral
   token + metering pattern) and `worker/src/routes/avavoice.ts` (`avavoiceSessionStart`, billing
   helpers `perMin`, `billedMinutes`).
2. **Throwaway spike (web is fastest):** a single static HTML page in `spike/` that:
   - opens the camera with `getUserMedia`;
   - runs **one** MediaPipe JS Task (pose_landmarker) drawing a skeleton on a `<canvas>` at ~30fps,
     and computes one trivial geometry score (e.g. knee angle) — proves the free overlay layer;
   - opens a Gemini **Live** WebSocket with an ephemeral token (mint one manually with the project key
     from `secrets/secret-values.env`; do NOT hardcode it into any committed file) and sends ~1 fps
     **LOW-res** frames + mic audio, confirming the agent "sees" and talks;
   - has a button that posts **one** hi-res frame to a Gemini 3 Flash `generateContent` call with
     **code execution** on, and renders the returned annotated image + text — proves the snapshot path
     and confirms the exact working model string.
   Keep it crude. It is deleted by Phase Z; it only needs to prove the path and produce numbers.
3. **Measure and record** in `PRICING.md`:
   - tokens/sec and $/hr for **voice-only** vs **voice + 1fps LOW-res video** (use the metering math in
     the proposal §2.1 / §4.3 and verify against what the Live session reports);
   - token cost + latency of **one snapshot** call (and the working `AVAVISION_SNAPSHOT_MODEL` string);
   - a recommended **AvaVision platform minimum rate** (coins/hr) such that user-pays never loses money
     (compare to AvaVoice's `MIN_RATE_PER_HOUR = 100`);
   - a recommended default **`free_snapshots_per_session`** range that keeps margin safe;
   - confirmation that **creator-pays $5/hr flat (500 coins) bundled** still covers voice+video; if it
     does NOT, flag it loudly (do not silently change the price — the owner decided flat-bundled).
4. **Confirm engine reality** in `PRICING.md`: MoveNet runs in the browser (TF.js) and note the exact
   model/CDN you used; MediaPipe JS Tasks pose/face/hand/object/segmentation all load. Note any that
   failed so Phase 4/5 know.

## Acceptance
- `PRICING.md` answers: voice-only vs voice+video $/hr, snapshot cost + working model string,
  recommended min rate, recommended snapshot cap, and the creator-pays-covers-cost yes/no.
- The spike proved all three layers end to end at least once.

## Then
Write `glue/PHASE-0-GLUE.md` (doc-only, no shared edits, but list the **numbers Phase 1 must hard-code**:
min rate + default snapshot cap + snapshot model string). Write the Graphiti episode. **STOP. No commit.**
