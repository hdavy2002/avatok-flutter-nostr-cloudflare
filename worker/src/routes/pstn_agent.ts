// worker/src/routes/pstn_agent.ts — [AVA-PSTN-AGENT-1] Vobiz bidirectional
// media-stream upgrade route (Specs/PLAN-2026-07-19-vobiz-media-stream-agent.md).
//
// GET /api/pstn-agent/stream/<secret>/<sid>  (Upgrade: websocket)
//
// Vobiz dials this wss:// URL when routes/pstn.ts's handleAnswer returned the
// <Stream> XML for an agent-mode owner. Thin router only: verify the shared
// webhook secret, then hand the socket to the VobizAgentRoom DO keyed by the
// session id (the DO validates the single-use `pstn_agent:<sid>` KV record and
// runs the whole Gemini bridge). All engine logic lives in the DO — this file
// and pstn.ts stay on their own sides of the voicemail/engine service boundary
// (pstn.ts emits XML + KV only; this file is the engine lane's front door).
import type { Env } from "../types";

// Same shared-secret scheme as routes/pstn.ts's webhookSecret(). The constant
// is DUPLICATED (not imported) on purpose: the service boundary forbids
// imports between the voicemail lane and engine code in either direction.
// KEEP IN SYNC with routes/pstn.ts FALLBACK_WEBHOOK_SECRET.
const FALLBACK_WEBHOOK_SECRET = "vbz_p0_9f3e2c81aa774d54b6d0e51c7c2f4a68";
function webhookSecret(env: Env): string {
  return env.VOBIZ_WEBHOOK_SECRET || FALLBACK_WEBHOOK_SECRET;
}

export async function pstnAgentStream(req: Request, env: Env, path: string): Promise<Response> {
  // path = /api/pstn-agent/stream/<secret>/<sid>
  const rest = path.slice("/api/pstn-agent/stream/".length);
  const parts = rest.split("/").filter(Boolean);
  const secret = decodeURIComponent(parts[0] || "");
  const sid = decodeURIComponent(parts[1] || "");
  if (secret !== webhookSecret(env)) return new Response("forbidden", { status: 403 });
  if (!sid) return new Response("session required", { status: 400 });
  if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
  // No locationHint: DO placement follows this first request (the Vobiz WS
  // origin), which is exactly where we want the media relay to live.
  return env.VOBIZ_AGENT_ROOM.get(env.VOBIZ_AGENT_ROOM.idFromName(sid)).fetch(req);
}
