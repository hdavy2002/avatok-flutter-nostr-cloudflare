// CF Realtime SFU — group AUDIO call routes (Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md).
// Audio-only, ≤32 participants, NO user time limit, active-speaker pull. Replaces
// the LiveKit path for the GROUP audio path when `groupAudioSfuEnabled` is ON
// (dormant by default — LiveKit stays the live group path until this is flipped).
//
// The SFU has no rooms: this module proxies the rtc.live.cloudflare.com
// sessions/tracks API (keeping CF_RT_SFU_APP_TOKEN server-side) and the roster +
// active-speaker signalling lives in the GroupCallRoom DO (do/group_call_room.ts).
//
// Endpoints (all requireUser; all gated by conferenceEnabled && groupAudioSfuEnabled):
//   POST /api/groupcall/:groupId/join        → { sessionId, iceServers, wsPath, roster }
//   POST /api/groupcall/:groupId/publish     {sessionId, offer}  → { answer, tracks }
//   POST /api/groupcall/:groupId/pull        {sessionId, remoteSessionId, trackName} → { offer, tracks, renegotiate }
//   PUT  /api/groupcall/:groupId/renegotiate {sessionId, answer} → { ok }
//   POST /api/groupcall/:groupId/close       {sessionId, mids[]} → { ok }
//   GET  /api/groupcall/:groupId/status      → { live, count, max }
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { mintIceServers } from "./media";

const MAX_GROUP = 32;
const ICE_TTL_S = 6 * 3600;
const PROVIDER = "cloudflare_sfu";

// ---- config / membership (mirrors conference.ts, kept local) -------------------

async function flags(env: Env): Promise<{ conf: boolean; sfu: boolean }> {
  try {
    const c = (await env.TOKENS.get("platform_config", "json")) as
      { conferenceEnabled?: boolean; groupAudioSfuEnabled?: boolean } | null;
    return { conf: c?.conferenceEnabled !== false, sfu: c?.groupAudioSfuEnabled === true };
  } catch { return { conf: true, sfu: false }; }
}

function sfuConfigured(env: Env): boolean {
  return !!(env.CF_RT_SFU_APP_ID && env.CF_RT_SFU_APP_TOKEN);
}

function confGeo(req: Request): Record<string, string | null> {
  const cf = (req as any).cf ?? {};
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    country: s(cf.country), city: s(cf.city), region: s(cf.region),
    timezone: s(cf.timezone), continent: s(cf.continent), colo: s(cf.colo),
  };
}

async function groupMembers(env: Env, groupId: string): Promise<string[]> {
  const rows = await env.DB_META
    .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1")
    .bind(groupId).all<{ uid: string }>();
  return (rows.results || []).map((r) => r.uid);
}

// ---- SFU REST proxy ------------------------------------------------------------

function sfuBase(env: Env): string {
  return `https://rtc.live.cloudflare.com/v1/apps/${env.CF_RT_SFU_APP_ID}`;
}

async function sfu(
  env: Env, method: string, path: string, body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${sfuBase(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_RT_SFU_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

function roomStub(env: Env, groupId: string) {
  return env.GROUP_CALL_ROOMS.get(env.GROUP_CALL_ROOMS.idFromName(groupId));
}

/** Current live participant count from the GroupCallRoom DO (presence probe). */
async function presence(env: Env, groupId: string): Promise<{ live: boolean; count: number }> {
  try {
    const r = await roomStub(env, groupId).fetch("https://room/presence");
    if (!r.ok) return { live: false, count: 0 };
    const d = (await r.json()) as { live?: boolean; count?: number };
    return { live: !!d.live, count: d.count ?? 0 };
  } catch { return { live: false, count: 0 }; }
}

// ---- guard shared by every endpoint -------------------------------------------

type Guard = { uid: string; email: string | null } | Response;

async function guard(req: Request, env: Env, groupId: string, opts: { checkCap?: boolean } = {}): Promise<Guard> {
  const f = await flags(env);
  if (!f.conf || !f.sfu) return json({ error: "group audio is unavailable" }, 503);
  if (!sfuConfigured(env)) return json({ error: "group audio backend not configured" }, 503);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const email = await emailFor(env, u.uid).catch(() => null);

  // Membership (registered groups). Legacy local-only groups have no D1 rows —
  // fall back to authenticated access; the unguessable group id is the capability.
  const mem = await groupMembers(env, groupId);
  if (mem.length > 0 && !mem.includes(u.uid)) {
    await trackUser(env, u.uid, email, "groupcall_blocked", "avatok",
      { reason: "not_member", group_id: groupId, provider: PROVIDER, ...confGeo(req) });
    return json({ error: "not a member" }, 403);
  }
  // Hard 32 cap at JOIN (the DO is the racing backstop on WS connect).
  if (opts.checkCap) {
    const p = await presence(env, groupId);
    if (p.count >= MAX_GROUP) {
      await trackUser(env, u.uid, email, "groupcall_blocked", "avatok",
        { reason: "room_full", cap: MAX_GROUP, group_id: groupId, provider: PROVIDER, ...confGeo(req) });
      return json({ error: `call is full (${MAX_GROUP})`, cap: MAX_GROUP }, 409);
    }
  }
  return { uid: u.uid, email };
}

// ---- POST /join ----------------------------------------------------------------

export async function groupCallJoin(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId, { checkCap: true });
  if (g instanceof Response) return g;

  const s = await sfu(env, "POST", "/sessions/new");
  if (!s.ok || !s.data?.sessionId) {
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "session_new", status: s.status, group_id: groupId, provider: PROVIDER, ...confGeo(req) });
    return json({ error: "could not create audio session" }, 502);
  }
  const iceServers = await mintIceServers(env, ICE_TTL_S);
  const p = await presence(env, groupId);
  await trackUser(env, g.uid, g.email, "groupcall_join", "avatok",
    { session_id: s.data.sessionId, members_live: p.count, group_id: groupId, provider: PROVIDER, ...confGeo(req) });

  return json({
    sessionId: s.data.sessionId,
    iceServers,
    wsPath: `/api/groupcall/${groupId}/ws`,
    max: MAX_GROUP,
    provider: PROVIDER,
  });
}

// ---- POST /publish (local mic track) ------------------------------------------

export async function groupCallPublish(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b?.sessionId || !b?.offer?.sdp) return json({ error: "sessionId + offer required" }, 400);

  const r = await sfu(env, "POST", `/sessions/${b.sessionId}/tracks/new`, {
    sessionDescription: { type: "offer", sdp: b.offer.sdp },
    tracks: (b.tracks && Array.isArray(b.tracks) && b.tracks.length
      ? b.tracks
      : [{ location: "local", mid: b.mid ?? "0", trackName: b.trackName ?? `mic-${g.uid}` }]),
  });
  if (!r.ok || !r.data?.sessionDescription) {
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "publish", status: r.status, group_id: groupId, provider: PROVIDER });
    return json({ error: "could not publish audio", detail: r.data }, 502);
  }
  await trackUser(env, g.uid, g.email, "groupcall_publish", "avatok",
    { group_id: groupId, provider: PROVIDER });
  return json({ answer: r.data.sessionDescription, tracks: r.data.tracks ?? [] });
}

// ---- POST /pull (a remote speaker's track) ------------------------------------

export async function groupCallPull(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b?.sessionId || !b?.remoteSessionId || !b?.trackName) {
    return json({ error: "sessionId + remoteSessionId + trackName required" }, 400);
  }
  const r = await sfu(env, "POST", `/sessions/${b.sessionId}/tracks/new`, {
    tracks: [{ location: "remote", sessionId: b.remoteSessionId, trackName: b.trackName }],
  });
  if (!r.ok) {
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "pull", status: r.status, group_id: groupId, provider: PROVIDER });
    return json({ error: "could not pull speaker", detail: r.data }, 502);
  }
  return json({
    offer: r.data?.sessionDescription ?? null,
    tracks: r.data?.tracks ?? [],
    renegotiate: !!r.data?.requiresImmediateRenegotiation,
  });
}

// ---- PUT /renegotiate ----------------------------------------------------------

export async function groupCallRenegotiate(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b?.sessionId || !b?.answer?.sdp) return json({ error: "sessionId + answer required" }, 400);
  const r = await sfu(env, "PUT", `/sessions/${b.sessionId}/renegotiate`, {
    sessionDescription: { type: "answer", sdp: b.answer.sdp },
  });
  if (!r.ok) return json({ error: "renegotiate failed", detail: r.data }, 502);
  return json({ ok: true });
}

// ---- POST /close (drop pulled tracks; leave is the WS close) -------------------

export async function groupCallClose(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b?.sessionId || !Array.isArray(b?.mids)) return json({ error: "sessionId + mids[] required" }, 400);
  const r = await sfu(env, "PUT", `/sessions/${b.sessionId}/tracks/close`, {
    tracks: b.mids.map((mid: string) => ({ mid })),
    force: b.force === true,
  });
  await trackUser(env, g.uid, g.email, "groupcall_leave", "avatok",
    { group_id: groupId, provider: PROVIDER });
  if (!r.ok) return json({ error: "close failed", detail: r.data }, 502);
  return json({ ok: true });
}

// ---- GET /status (in-chat "ongoing call" banner) ------------------------------

export async function groupCallStatus(req: Request, env: Env, groupId: string): Promise<Response> {
  const f = await flags(env);
  if (!f.conf || !f.sfu || !sfuConfigured(env)) return json({ live: false, count: 0, max: MAX_GROUP });
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const p = await presence(env, groupId);
  return json({ live: p.live, count: p.count, max: MAX_GROUP });
}
