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

async function del(env: Env, path: string): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: { "X-Auth-ID": env.VOBIZ_AUTH_ID || "", "X-Auth-Token": env.VOBIZ_AUTH_TOKEN || "", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
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

export type WhisperVia = "member_speak" | "call_speak" | "member_play" | "none";

/**
 * [HF-CALL-MODES-C] Say something to the CALLER only (the low-wallet whisper, spec D5). Three tries in order, the first that Vobiz accepts wins and
 * is reported in `via` (PostHog hf_call_whisper.via) so the first live call shows which path works:
 *   1. conference Member Speak on the caller's member id            (only that member hears it)
 *   2. Speak on the caller's own call leg (legs "aleg")              (the caller leg is its own outbound call, so aleg = the caller)
 *   3. conference Member Play of a pre-rendered MP3, when `mp3Url` is given (one file per line, so the text is not spoken by a synthesiser)
 * The host's member id and leg are never parameters here, so this can never reach the influencer. Never throws.
 */
export async function speakToCaller(env: Env, a: { room: string; callerMemberId?: string | null; callerLegUuid?: string | null; text: string; mp3Url?: string | null }): Promise<{ ok: boolean; via: WhisperVia }> {
  const id = env.VOBIZ_AUTH_ID || "";
  if (a.callerMemberId && (await post(env, `/Account/${id}/Conference/${encodeURIComponent(a.room)}/Member/${encodeURIComponent(a.callerMemberId)}/Speak/`, { text: a.text }))) return { ok: true, via: "member_speak" };
  if (a.callerLegUuid && (await post(env, `/Account/${id}/Call/${encodeURIComponent(a.callerLegUuid)}/Speak/`, { text: a.text, legs: "aleg" }))) return { ok: true, via: "call_speak" };
  if (a.mp3Url && a.callerMemberId && (await post(env, `/Account/${id}/Conference/${encodeURIComponent(a.room)}/Member/${encodeURIComponent(a.callerMemberId)}/Play/`, { url: a.mp3Url }))) return { ok: true, via: "member_play" };
  return { ok: false, via: "none" };
}

export type SharedAnnouncementVia = "member_play" | "member_speak" | "none";

/**
 * Pause a two-person PSTN conference for a shared service announcement.
 * Both people are muted before their individual audio is injected, so neither
 * can speak over it. We deliberately address the two known member IDs rather
 * than using Vobiz's `all`, which could affect an unexpected participant.
 */
export async function pauseForSharedAnnouncement(env: Env, a: { room: string; memberIds: string[]; text: string; mp3Url?: string | null }): Promise<{ ok: boolean; via: SharedAnnouncementVia }> {
  const ids = [...new Set(a.memberIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length !== 2) return { ok: false, via: "none" };
  const id = env.VOBIZ_AUTH_ID || "";
  const members = ids.map(encodeURIComponent).join(",");
  const base = `/Account/${id}/Conference/${encodeURIComponent(a.room)}/Member/${members}`;
  if (!(await post(env, `${base}/Mute/`, {}))) return { ok: false, via: "none" };
  if (a.mp3Url && (await post(env, `${base}/Play/`, { url: a.mp3Url }))) return { ok: true, via: "member_play" };
  const spoken = await Promise.all(ids.map((memberId) => speakIntoCall(env, { room: a.room, memberId, text: a.text })));
  if (spoken.every(Boolean)) return { ok: true, via: "member_speak" };
  await del(env, `${base}/Mute/`);
  return { ok: false, via: "none" };
}

/** Restore speech after a shared announcement. Idempotent on Vobiz. */
export async function resumeAfterSharedAnnouncement(env: Env, a: { room: string; memberIds: string[] }): Promise<boolean> {
  const ids = [...new Set(a.memberIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length !== 2) return false;
  const id = env.VOBIZ_AUTH_ID || "";
  const members = ids.map(encodeURIComponent).join(",");
  return del(env, `/Account/${id}/Conference/${encodeURIComponent(a.room)}/Member/${members}/Mute/`);
}
