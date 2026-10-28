// [HF-CALL-SAFETY-BE] Vobiz call-recording helpers. Docs read 2026-10-28 (NOT yet exercised on a live call - see Specs/HF-CALL-SAFETY-1.md):
//   * <Conference record="true"> "does not currently produce a recording file" and POST .../Conference/{room}/Record/ answers
//     {"message":"async api spawned"} with no recording id, so neither is used. The documented working way is a per-leg
//     <Record recordSession="true" .../> placed before <Conference>; it keeps going to the next element and records the whole leg
//     (stereo MP3, 8 kHz, one party per channel, bridged audio included). playBeep="false": NOTHING new is heard on the call.
//   * Completion callback: POST to the Record element's callbackUrl with Event=RecordStop, RecordingID, RecordUrl (or RecordFile),
//     RecordingDuration (s), RecordingEndReason. Vobiz retries non-200 up to 3 times, so the handler must be idempotent.
//   * Recording URLs need X-Auth-ID / X-Auth-Token headers (not public). GET /Account/{id}/Recording/{rid}/ returns recording_url etc.
//     DELETE /Account/{id}/Recording/{rid}/ -> 204, permanent (it also stops Vobiz's storage charge).
import type { Env } from "../types";
import { esc } from "./hf_call_math";

const BASE = "https://api.vobiz.ai/api/v1";
export const MAX_AUDIO_BYTES = 60 * 1024 * 1024;

/** The Record verb for one leg. Empty string when recording is off. No spoken words, no beep. */
export function recordLegXml(callbackUrl: string | null, maxLengthSec: number): string {
  if (!callbackUrl) return "";
  return `<Record recordSession="true" playBeep="false" fileFormat="mp3" maxLength="${Math.max(60, Math.trunc(maxLengthSec))}" timeout="${Math.max(60, Math.trunc(maxLengthSec))}" callbackUrl="${esc(callbackUrl)}" callbackMethod="POST"/>`;
}

const authHeaders = (env: Env): Record<string, string> => ({ "X-Auth-ID": env.VOBIZ_AUTH_ID || "", "X-Auth-Token": env.VOBIZ_AUTH_TOKEN || "" });
export const vobizReady = (env: Env): boolean => !!(env.VOBIZ_AUTH_ID && env.VOBIZ_AUTH_TOKEN);

/** Only ever fetch an https URL on the provider's own domain (the URL comes from a webhook body). */
export function safeVobizUrl(u: string | null | undefined): URL | null {
  try {
    const x = new URL(String(u ?? ""));
    return x.protocol === "https:" && (x.hostname === "vobiz.ai" || x.hostname.endsWith(".vobiz.ai")) ? x : null;
  } catch { return null; }
}

/** Container sniffing: the docs warn the file type may not match the extension. */
export function sniffAudioMime(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "audio/wav";
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";
  return "audio/mpeg";
}

export async function getRecordingMeta(env: Env, recordingId: string): Promise<{ url: string | null; durationSec: number | null } | null> {
  if (!vobizReady(env)) return null;
  try {
    const r = await fetch(`${BASE}/Account/${encodeURIComponent(env.VOBIZ_AUTH_ID || "")}/Recording/${encodeURIComponent(recordingId)}/`, { headers: { ...authHeaders(env), Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    const o = j?.data ?? j;
    const ms = Number(o?.recording_duration_ms);
    return { url: typeof o?.recording_url === "string" ? o.recording_url : null, durationSec: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null };
  } catch { return null; }
}

export async function downloadRecording(env: Env, url: string): Promise<ArrayBuffer> {
  const u = safeVobizUrl(url);
  if (!u) throw new Error("bad_recording_url");
  if (!vobizReady(env)) throw new Error("vobiz_not_configured");
  const r = await fetch(u.toString(), { headers: authHeaders(env), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`vobiz_download_${r.status}`);
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > MAX_AUDIO_BYTES) throw new Error("recording_too_large");
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error("recording_too_large");
  if (buf.byteLength < 200) throw new Error("recording_empty");
  return buf;
}

/** Delete the recording at Vobiz (only call after our own copy is safely in R2). 404 counts as already gone. */
export async function deleteVobizRecording(env: Env, recordingId: string): Promise<boolean> {
  if (!vobizReady(env)) return false;
  try {
    const r = await fetch(`${BASE}/Account/${encodeURIComponent(env.VOBIZ_AUTH_ID || "")}/Recording/${encodeURIComponent(recordingId)}/`, { method: "DELETE", headers: authHeaders(env), signal: AbortSignal.timeout(8000) });
    return r.status === 204 || r.status === 200 || r.status === 404;
  } catch { return false; }
}
