// [STREAM-CALLTYPES-1 2026-09-12] Create the two avaTOK GetStream call types.
//
// WHY THIS EXISTS
//
// `worker/src/lib/commercial_stream_sessions.ts` mints `avatok_livestream` and
// `avatok_consult_1to1` as the provider call types for every paid session. Step 1
// of Specs/PHASE1-SPACE-LAUNCH-AUDIT-2026-08-26.md ("create call types … in the
// GetStream dashboard") was never carried out, so production app 3um6zw5rahvs only
// ever had [audio_room, default, development, livestream]. Every
// `createProviderCall` therefore 404'd, every /join and /prepare-host answered 502
// "provider call unavailable", and `commercial_sessions` held ZERO rows: the paid
// live + consult lane has never created a call in production. Proved on 2026-09-12
// by probing the provider with a real user token:
//
//   "avatok_livestream: call type does not exist, available call types are:
//    [audio_room, default, development, livestream]"
//
// A console-only fix cannot be scripted, re-run after an app rotation, or asserted
// in a test. So the same server token the rest of the lane already signs is used to
// create the types through the REST API, idempotently.
//
// SCOPE: this route creates call types and nothing else. It writes no KV, no D1,
// and never edits a call type that already exists — an operator who has tuned
// permissions in the dashboard must not have them silently reset by a redeploy.
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";

const VIDEO_API = "https://video.stream-io-api.com/api/v2/video";

/** The call types the commercial lane mints. Must stay in lockstep with
 *  `lib/commercial_stream_sessions.ts` — see the contract test. */
export const AVATOK_CALL_TYPES = ["avatok_livestream", "avatok_consult_1to1"] as const;
export type AvatokCallType = (typeof AVATOK_CALL_TYPES)[number];

/** Which built-in type each one is cloned from (grants are copied verbatim). */
export const CALL_TYPE_TEMPLATE: Record<AvatokCallType, string> = {
  avatok_livestream: "livestream",
  avatok_consult_1to1: "default",
};

function b64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Same HS256 server token the commercial lane signs (`providerTokens().server`). */
async function serverToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ server: true, iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`;
}

function bindings(env: Env): { apiKey: string; apiSecret: string } | null {
  const apiKey = env.STREAM_VIDEO_API_KEY ?? "";
  const apiSecret = env.STREAM_VIDEO_API_SECRET ?? "";
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

type CallTypeRead = { name?: string; grants?: Record<string, string[]>; settings?: Record<string, unknown> };

/**
 * The settings each new type needs EXPLICITLY, because a brand-new call type is
 * created from Stream's own defaults, not from the template we copy grants from.
 *
 * Deliberately minimal: only the switches the product depends on. Everything
 * else stays on Stream's defaults so this route has as few ways to 400 as
 * possible — `settingsFallbacks` walks down to an even smaller body if the API
 * rejects a key, and the response says which shape was accepted.
 */
export function settingsFor(name: AvatokCallType): Record<string, unknown> {
  if (name === "avatok_livestream") {
    return {
      // RULEBOOK-PAID-SESSIONS §4: the host opens a private backstage room and
      // then goes live explicitly — `commercialLivePrepareHost` depends on it.
      backstage: { enabled: true },
      // `runControl` sends `start_hls: true` on go_live.
      broadcasting: { enabled: true, hls: { enabled: true, auto_on: false } },
      // commercialRecordingEnabled / commercialReplayEnabled are both false in
      // production; the call type must not record behind the flag's back.
      recording: { mode: "disabled" },
      transcription: { mode: "disabled" },
    };
  }
  return {
    // A 1:1 consult never rings through GetStream — the Phase-7 waiting room
    // does presence (RULEBOOK §3), so ringing here would bill a second lane.
    backstage: { enabled: false },
    recording: { mode: "disabled" },
    transcription: { mode: "disabled" },
    limits: { max_participants: 2 },
  };
}

/** Progressively smaller settings bodies, tried in order on a 400. */
export function settingsFallbacks(name: AvatokCallType): Array<Record<string, unknown>> {
  const full = settingsFor(name);
  const out: Array<Record<string, unknown>> = [full];
  if (name === "avatok_consult_1to1") {
    const { limits, ...noLimits } = full as Record<string, unknown> & { limits?: unknown };
    out.push(noLimits);
  } else {
    const { broadcasting, ...noBroadcast } = full as Record<string, unknown> & { broadcasting?: unknown };
    out.push(noBroadcast);
  }
  out.push({});
  return out;
}

async function listCallTypes(apiKey: string, token: string): Promise<{
  ok: boolean; status: number; names: string[]; raw: Record<string, CallTypeRead>;
}> {
  const response = await fetch(`${VIDEO_API}/calltypes?api_key=${encodeURIComponent(apiKey)}`, {
    headers: { Authorization: token, "stream-auth-type": "jwt" },
  });
  if (!response.ok) return { ok: false, status: response.status, names: [], raw: {} };
  const body = await response.json().catch(() => ({})) as { call_types?: Record<string, CallTypeRead> };
  const raw = body.call_types ?? {};
  return { ok: true, status: response.status, names: Object.keys(raw).sort(), raw };
}

/**
 * POST /api/admin/stream/calltypes/ensure
 *
 * Idempotent: a type that already exists is reported `present` and left alone.
 * Returns the call-type list as it stands afterwards, so the caller never has to
 * trust this function's own bookkeeping.
 */
export async function ensureStreamCallTypes(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;
  const creds = bindings(env);
  if (!creds) return json({ error: "commercial media unavailable", reason: "stream_video_unconfigured" }, 503);
  const token = await serverToken(creds.apiSecret);

  const before = await listCallTypes(creds.apiKey, token);
  if (!before.ok) {
    return json({ error: "provider call type list unavailable", provider_status: before.status }, 502);
  }

  const results: Array<Record<string, unknown>> = [];
  for (const name of AVATOK_CALL_TYPES) {
    if (before.names.includes(name)) {
      results.push({ name, outcome: "present" });
      continue;
    }
    const template = before.raw[CALL_TYPE_TEMPLATE[name]];
    if (!template) {
      results.push({ name, outcome: "failed", reason: "template_missing", template: CALL_TYPE_TEMPLATE[name] });
      continue;
    }
    // Grants are plain `{ role: [permission, …] }` in both the read and the write
    // shape, so the template's are copied verbatim: the built-in `livestream`
    // already means "host publishes and controls the call, `user` watches", and
    // `default` already means "both members publish". Restating those permission
    // slugs by hand is how they drift.
    const grants = template.grants ?? {};
    let created = false;
    let lastStatus: number | null = null;
    let lastError: string | null = null;
    let acceptedShape = -1;
    const shapes = settingsFallbacks(name);
    for (let i = 0; i < shapes.length && !created; i++) {
      const response = await fetch(`${VIDEO_API}/calltypes?api_key=${encodeURIComponent(creds.apiKey)}`, {
        method: "POST",
        headers: { Authorization: token, "stream-auth-type": "jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ name, grants, settings: shapes[i] }),
      });
      lastStatus = response.status;
      if (response.ok) {
        created = true;
        acceptedShape = i;
        break;
      }
      lastError = (await response.text().catch(() => "")).slice(0, 400);
      // Only a 4xx is worth retrying with a smaller body; a 5xx is the provider,
      // and retrying a narrower shape against it would just hide the outage.
      if (response.status >= 500) break;
    }
    results.push(created
      ? { name, outcome: "created", template: CALL_TYPE_TEMPLATE[name], settings_shape: acceptedShape }
      : { name, outcome: "failed", provider_status: lastStatus, provider_error: lastError });
  }

  const after = await listCallTypes(creds.apiKey, token);
  const missing = AVATOK_CALL_TYPES.filter((name) => !after.names.includes(name));
  return json({
    ok: missing.length === 0,
    call_types: after.names,
    missing,
    results,
  }, missing.length === 0 ? 200 : 502);
}
