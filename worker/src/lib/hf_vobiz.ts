// [HF-CALLS-1] Best-effort "speak into a live conference" for the 60-second warning. VobizProvider has no such method, so this
// calls the Plivo-dialect REST endpoints directly. VERIFY ON FIRST LIVE CALL: neither path is confirmed against Vobiz docs.
// Never throws; a failed warning must not affect the call or the hard time limit.
import type { Env } from "../types";

const BASE = "https://api.vobiz.ai/api/v1";

async function post(env: Env, path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "X-Auth-ID": env.VOBIZ_AUTH_ID || "", "X-Auth-Token": env.VOBIZ_AUTH_TOKEN || "", "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch { return false; }
}

/** Try the conference-member speak endpoint first, then speaking to the call leg itself. */
export async function speakIntoCall(env: Env, a: { room: string; memberId?: string | null; callUuid?: string | null; text: string }): Promise<boolean> {
  const id = env.VOBIZ_AUTH_ID || "";
  if (a.memberId && (await post(env, `/Account/${id}/Conference/${encodeURIComponent(a.room)}/Member/${encodeURIComponent(a.memberId)}/Speak/`, { text: a.text }))) return true;
  if (a.callUuid && (await post(env, `/Account/${id}/Call/${encodeURIComponent(a.callUuid)}/Speak/`, { text: a.text, legs: "aleg" }))) return true;
  return false;
}
