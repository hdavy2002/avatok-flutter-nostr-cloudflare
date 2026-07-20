// worker/src/routes/pstn_voicemail_stream.ts — [AVA-VM-SELFREC-1]
//
// GET /api/pstn-vm/stream/<secret>/<sid>  (Upgrade: websocket)
//
// Vobiz dials this wss:// URL when routes/pstn.ts's handleAnswer returned the
// self-record <Stream> XML (pstnVoicemailSelfRecord ON). Thin router only:
// verify the shared webhook secret, then hand the socket to VoicemailStreamRoom
// keyed by the session id (the DO validates the single-use `pstn_vm:<sid>` KV
// record and records the voicemail). Same shape as routes/pstn_agent.ts.
import type { Env } from "../types";

// KEEP IN SYNC with routes/pstn.ts FALLBACK_WEBHOOK_SECRET (duplicated on
// purpose — the voicemail lane and engine lanes don't import across each other).
const FALLBACK_WEBHOOK_SECRET = "vbz_p0_9f3e2c81aa774d54b6d0e51c7c2f4a68";
function webhookSecret(env: Env): string {
  return env.VOBIZ_WEBHOOK_SECRET || FALLBACK_WEBHOOK_SECRET;
}

export async function pstnVoicemailStream(req: Request, env: Env, path: string): Promise<Response> {
  // path = /api/pstn-vm/stream/<secret>/<sid>
  const rest = path.slice("/api/pstn-vm/stream/".length);
  const parts = rest.split("/").filter(Boolean);
  const secret = decodeURIComponent(parts[0] || "");
  const sid = decodeURIComponent(parts[1] || "");
  if (secret !== webhookSecret(env)) return new Response("forbidden", { status: 403 });
  if (!sid) return new Response("session required", { status: 400 });
  if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
  // No locationHint: DO placement follows the Vobiz WS origin, where we want the
  // media relay to live.
  return env.VOICEMAIL_STREAM_ROOM.get(env.VOICEMAIL_STREAM_ROOM.idFromName(sid)).fetch(req);
}
