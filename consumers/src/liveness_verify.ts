// LIVE-V2 P0 — async liveness-verify consumer handler.
//
// STATUS: DARK. This handler is NOT fed by any live queue today. avatok-api runs
// the liveness checks (runLivenessChecks) inline via ctx.waitUntil on the /verify
// request — see worker/src/routes/liveness.ts and its `LIVE-V2 NOTE (queue vs
// waitUntil)`. Two things block the queue path right now:
//   1. New infra: it needs `wrangler queues create liveness-verify` + a
//      [[queues.consumers]] binding here + a Q_LIVENESS producer on avatok-api.
//   2. Cross-package import: the real check logic (runLivenessChecks) lives in the
//      avatok-api worker package and can't be imported here (the same package-split
//      limitation noted for liveness_sweep.ts). A queue consumer would have to call
//      avatok-api via a service binding (an internal /internal/liveness/run route)
//      rather than re-implement the LLaVA/Whisper pipeline.
//
// This file + LivenessVerifyMsg exist so that wiring the queue later is a small,
// obvious change: create the queue, add the producer/consumer bindings, add an
// internal run route on avatok-api, and have this handler POST to it. Until then
// the dispatch case below is unreachable (no queue named "liveness-verify" is
// consumed), so it changes NOTHING about current behaviour.
import type { Env, LivenessVerifyMsg } from "./types";

export async function handleLivenessVerify(msg: LivenessVerifyMsg, env: Env): Promise<void> {
  // Intentionally a no-op stub. See the file header: the live path is avatok-api's
  // ctx.waitUntil(runLivenessChecks(...)). If/when a `liveness-verify` queue is
  // provisioned, forward to an internal avatok-api route that calls
  // runLivenessChecks, e.g.:
  //
  //   await env.AVATOK_API.fetch("https://internal/internal/liveness/run", {
  //     method: "POST",
  //     body: JSON.stringify({ uid: msg.uid, session_id: msg.session_id }),
  //   });
  //
  // (AVATOK_API service binding not declared yet — deliberately out of P0 scope.)
  void msg; void env;
}
