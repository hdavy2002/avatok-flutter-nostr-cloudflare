// CF Realtime SFU — group call routes
// (Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md,
//  Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md Phase 1/2).
//
// Two flags layer on the SAME endpoints:
//   groupAudioSfuEnabled     — legacy audio-only path (≤32, dormant). Unchanged
//                               behavior, now additionally ticket-authenticated.
//   cloudflareConferenceEnabled — [CF-CALL-001/002] the authenticated CF Realtime
//                               A/V call authority (≤25, parity with the LiveKit
//                               conference cap). Adds video + the signed join
//                               ticket + the GroupCallRoom DO authority.
//
// The SFU has no rooms: this module proxies the rtc.live.cloudflare.com
// sessions/tracks API (keeping CF_RT_SFU_APP_TOKEN server-side) and the roster +
// active-speaker signalling + call authority live in the GroupCallRoom DO
// (do/group_call_room.ts).
//
// Endpoints (all requireUser; all gated by conferenceEnabled && (groupAudioSfuEnabled || cloudflareConferenceEnabled)):
//   POST /api/groupcall/:groupId/join        → join-ticket contract (see groupCallJoin)
//   POST /api/groupcall/:groupId/publish     {sessionId, offer, tracks[]}  → { answer, tracks }
//   POST /api/groupcall/:groupId/pull        {sessionId, remoteSessionId, remoteUid, kind, trackName} → { offer, tracks, renegotiate }
//   PUT  /api/groupcall/:groupId/renegotiate {sessionId, answer} → { ok }
//   POST /api/groupcall/:groupId/close       {sessionId, mids[], tracks?[]} → { ok }
//   GET  /api/groupcall/:groupId/status      → { live, count, max }
//
// [CF-CALL-001] Non-negotiable migration rules honored here:
//   - every call gets a unique OPAQUE call_id (never the group id).
//   - the WS upgrade is authenticated via a short-lived signed join ticket, not a
//     query parameter or client-supplied uid (verified in do/group_call_room.ts
//     BEFORE the DO does anything with the connection).
//   - CF Realtime API tokens (CF_RT_SFU_APP_TOKEN) and CONF_TICKET_SECRET never
//     leave the Worker; the client only ever receives the minted ticket.
//   - never log SDP/ICE creds/tokens.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { isFail, requireUser } from "../authz";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { mintIceServers } from "./media";

const MAX_GROUP = 32;              // legacy audio-only backstop (groupAudioSfuEnabled)
const MAX_CONF_PARTICIPANTS = 25;  // [CF-CALL-001] A/V cap — parity with conference.ts, never weakened
const ICE_TTL_S = 6 * 3600;
const PROVIDER = "cloudflare_realtime";
const TICKET_TTL_S = 60; // short-lived: only needs to cover the WS-upgrade race

// ---- config / membership (mirrors conference.ts, kept local) -------------------

async function flags(env: Env): Promise<{ conf: boolean; sfu: boolean; cfConf: boolean; enabled: boolean }> {
  try {
    const c = (await env.TOKENS.get("platform_config", "json")) as
      { conferenceEnabled?: boolean; groupAudioSfuEnabled?: boolean; cloudflareConferenceEnabled?: boolean } | null;
    const conf = c?.conferenceEnabled !== false;
    const sfu = c?.groupAudioSfuEnabled === true;
    const cfConf = c?.cloudflareConferenceEnabled === true;
    return { conf, sfu, cfConf, enabled: sfu || cfConf };
  } catch { return { conf: true, sfu: false, cfConf: false, enabled: false }; }
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

async function roomFetch<T = any>(env: Env, groupId: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const r = await roomStub(env, groupId).fetch(`https://room${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: T | null = null;
    try { data = (await r.json()) as T; } catch { /* empty */ }
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 502, data: null };
  }
}

/** Current live participant count / call authority from the GroupCallRoom DO. */
async function presence(env: Env, groupId: string): Promise<{ live: boolean; count: number; call_id: string | null; state: string }> {
  const r = await roomFetch<{ live?: boolean; count?: number; call_id?: string | null; state?: string }>(env, groupId, "/presence");
  if (!r.ok || !r.data) return { live: false, count: 0, call_id: null, state: "ended" };
  return { live: !!r.data.live, count: r.data.count ?? 0, call_id: r.data.call_id ?? null, state: r.data.state ?? "ended" };
}

// ---- signed join tickets [CF-CALL-001] ------------------------------------------
// {call_id, uid, session_id, generation, exp, nonce}, HMAC-SHA256, base64url.
// CONF_TICKET_SECRET is a DEDICATED Worker secret — it never falls back to a
// different secret's value. Unset ⇒ ticket minting fails closed (503), never a
// hardcoded dev secret (this is a security boundary, not a convenience token).

export interface JoinTicket {
  call_id: string;
  uid: string;
  session_id: string;
  generation: number;
  exp: number; // epoch ms
  nonce: string;
}

function b64u(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
async function hmacTicket(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

/** Mint a short-lived signed join ticket. Returns null if CONF_TICKET_SECRET is unset. */
export async function mintJoinTicket(env: Env, payload: Omit<JoinTicket, "exp" | "nonce">): Promise<string | null> {
  const secret = env.CONF_TICKET_SECRET;
  if (!secret) return null;
  const full: JoinTicket = { ...payload, exp: Date.now() + TICKET_TTL_S * 1000, nonce: crypto.randomUUID() };
  const body = b64u(new TextEncoder().encode(JSON.stringify(full)));
  const sig = b64u(await hmacTicket(secret, body));
  return `${body}.${sig}`;
}

/** Verify a join ticket. Called from do/group_call_room.ts BEFORE the WS upgrade
 *  is accepted — this is the authorization boundary for the socket. */
export async function verifyJoinTicket(env: Env, token: string): Promise<JoinTicket | null> {
  const secret = env.CONF_TICKET_SECRET;
  if (!secret) return null;
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const expect = b64u(await hmacTicket(secret, body));
  if (expect.length !== sig.length || expect !== sig) return null;
  try {
    const t = JSON.parse(new TextDecoder().decode(fromB64u(body))) as JoinTicket;
    if (!t.call_id || !t.uid || !t.session_id || !t.exp || !t.nonce) return null;
    if (Date.now() > t.exp) return null;
    return t;
  } catch { return null; }
}

// ---- telemetry [CF-CALL-001/002] -------------------------------------------------
// Every Cloudflare conference event carries call_id, call_trace_id,
// transport=cloudflare_realtime, group_id_hash, participant_hash, generation
// (proposal §"PostHog Error Tracking and telemetry contract"). Hashes are short
// sha256 prefixes — never the raw group id / uid on the wire to PostHog.
async function emitConf(
  env: Env, req: Request, uid: string, email: string | null, event: string,
  ctx: { groupId: string; call_id?: string | null; call_trace_id?: string | null; generation?: number | null; extra?: Record<string, unknown> },
): Promise<void> {
  const [groupHash, uidHash] = await Promise.all([sha256Hex(ctx.groupId), sha256Hex(uid)]);
  await trackUser(env, uid, email, event, "avatok", {
    call_id: ctx.call_id ?? null,
    call_trace_id: ctx.call_trace_id ?? null,
    transport: PROVIDER,
    group_id_hash: groupHash.slice(0, 16),
    participant_hash: uidHash.slice(0, 16),
    generation: ctx.generation ?? null,
    provider: PROVIDER,
    ...confGeo(req),
    ...(ctx.extra ?? {}),
  });
}

// ---- guard shared by every endpoint -------------------------------------------

type Guard = { uid: string; email: string | null; cfConf: boolean } | Response;

async function guard(req: Request, env: Env, groupId: string, opts: { checkCap?: boolean } = {}): Promise<Guard> {
  const f = await flags(env);
  if (!f.conf || !f.enabled) return json({ error: "group calling is unavailable" }, 503);
  if (!sfuConfigured(env)) return json({ error: "group call backend not configured" }, 503);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const email = await emailFor(env, u.uid).catch(() => null);

  const mem = await groupMembers(env, groupId);
  if (mem.length > 0 && !mem.includes(u.uid)) {
    await trackUser(env, u.uid, email, "groupcall_blocked", "avatok",
      { reason: "not_member", group_id: groupId, provider: PROVIDER, ...confGeo(req) });
    return json({ error: "not a member" }, 403);
  }
  // Phase-2 A/V mode respects the SAME ≤25 group-conference cap as the LiveKit
  // path (conference.ts) — never weakened. groupAudioSfuEnabled-only calls keep
  // the legacy 32 cap.
  if (f.cfConf && mem.length > MAX_CONF_PARTICIPANTS) {
    await trackUser(env, u.uid, email, "groupcall_blocked", "avatok", {
      reason: "size_cap", cap: MAX_CONF_PARTICIPANTS, members: mem.length, group_id: groupId, provider: PROVIDER, ...confGeo(req),
    });
    return json({ error: `group calls allow up to ${MAX_CONF_PARTICIPANTS} participants`, cap: MAX_CONF_PARTICIPANTS }, 403);
  }
  if (opts.checkCap) {
    const p = await presence(env, groupId);
    const cap = f.cfConf ? MAX_CONF_PARTICIPANTS : MAX_GROUP;
    if (p.count >= cap) {
      await trackUser(env, u.uid, email, "groupcall_blocked", "avatok",
        { reason: "room_full", cap, group_id: groupId, provider: PROVIDER, ...confGeo(req) });
      return json({ error: `call is full (${cap})`, cap }, 409);
    }
  }
  return { uid: u.uid, email, cfConf: f.cfConf };
}

// ---- POST /join ------------------------------------------------------------------

export async function groupCallJoin(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId, { checkCap: true });
  if (g instanceof Response) return g;

  await emitConf(env, req, g.uid, g.email, "conference_provider_selected", { groupId, extra: { decision: "cloudflare_realtime", cf_conf: g.cfConf } });
  await emitConf(env, req, g.uid, g.email, "cloudflare_conference_join_started", { groupId });

  let wantVideo = false;
  try { const b = (await req.json()) as { video?: boolean }; wantVideo = b?.video === true; } catch { /* optional body */ }
  const mediaKind = g.cfConf && wantVideo ? "audio_video" : "audio";

  const s = await sfu(env, "POST", "/sessions/new");
  if (!s.ok || !s.data?.sessionId) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_conference_error", { groupId, extra: { stage: "session_new", status: s.status } });
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "session_new", status: s.status, group_id: groupId, provider: PROVIDER, ...confGeo(req) });
    return json({ error: "could not create call session" }, 502);
  }
  const sessionId: string = s.data.sessionId;

  // Create/join the call authority (DO). This mints call_id/call_trace_id/
  // generation the first time, or hands back the live call's identity.
  const cap = g.cfConf ? MAX_CONF_PARTICIPANTS : MAX_GROUP;
  const authRes = await roomFetch<{ call_id: string; call_trace_id: string; generation: number; state: string; media_kind: string; max_participants: number; error?: string; cap?: number }>(
    env, groupId, "/authority/start", { uid: g.uid, media_kind: mediaKind, max_participants: cap },
  );
  if (!authRes.ok || !authRes.data?.call_id) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_conference_error", { groupId, extra: { stage: "authority_start", status: authRes.status } });
    if (authRes.status === 409) return json({ error: authRes.data?.error ?? "call is full", cap: authRes.data?.cap ?? cap }, 409);
    return json({ error: "could not create call authority" }, 502);
  }
  const authority = authRes.data;

  const ticket = await mintJoinTicket(env, {
    call_id: authority.call_id, uid: g.uid, session_id: sessionId, generation: authority.generation,
  });
  if (!ticket) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_conference_error", {
      groupId, call_id: authority.call_id, call_trace_id: authority.call_trace_id, generation: authority.generation,
      extra: { stage: "ticket_mint", reason: "CONF_TICKET_SECRET unset" },
    });
    return json({ error: "call ticketing not configured" }, 503);
  }
  await emitConf(env, req, g.uid, g.email, "cloudflare_conference_ticket_issued", {
    groupId, call_id: authority.call_id, call_trace_id: authority.call_trace_id, generation: authority.generation,
  });

  const iceServers = await mintIceServers(env, ICE_TTL_S);
  const url = new URL(req.url);
  const wsUrl = `wss://${url.host}/api/groupcall/${groupId}/ws?ticket=${encodeURIComponent(ticket)}`;

  await emitConf(env, req, g.uid, g.email, "cloudflare_conference_joined", {
    groupId, call_id: authority.call_id, call_trace_id: authority.call_trace_id, generation: authority.generation,
    extra: { session_id: sessionId, media_kind: authority.media_kind },
  });
  await trackUser(env, g.uid, g.email, "groupcall_join", "avatok",
    { session_id: sessionId, call_id: authority.call_id, group_id: groupId, provider: PROVIDER, ...confGeo(req) });

  return json({
    provider: PROVIDER,
    call_id: authority.call_id,
    call_trace_id: authority.call_trace_id,
    session_id: sessionId,
    join_ticket: ticket,
    ice_servers: iceServers,
    media: { audio: true, video: authority.media_kind !== "audio" },
    max_participants: authority.max_participants,
    ws_url: wsUrl,
    generation: authority.generation,
  });
}

// ---- POST /publish (local mic/camera tracks) ------------------------------------

const MAX_TRACK_NAME_LEN = 128;
const ALLOWED_KINDS = new Set(["audio", "video"]);

export async function groupCallPublish(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b?.sessionId || !b?.offer?.sdp) return json({ error: "sessionId + offer required" }, 400);

  const check = await roomFetch<{ ok: boolean; generation: number; media_kind: string; call_id: string; error?: string }>(
    env, groupId, "/authority/session_check", { uid: g.uid, session_id: b.sessionId },
  );
  if (!check.ok || !check.data?.ok) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_failed", { groupId, extra: { stage: "session_check", status: check.status } });
    return json({ error: check.data?.error ?? "not connected to this call" }, check.status === 409 ? 409 : 404);
  }
  const { generation, media_kind, call_id } = check.data;

  // Explicit track metadata (Phase 2): one local offer, audio + optional video.
  // Never trust anything beyond kind/trackName/mid from the client; location is
  // forced to "local" and kinds are validated against the call's media mode.
  const rawTracks: any[] = Array.isArray(b.tracks) && b.tracks.length
    ? b.tracks
    : [{ location: "local", mid: b.mid ?? "0", kind: "audio", trackName: b.trackName ?? `mic-${g.uid}` }];

  let audioCount = 0, videoCount = 0;
  const tracks: { location: "local"; mid: string; trackName: string }[] = [];
  for (const t of rawTracks) {
    const kind = ALLOWED_KINDS.has(t?.kind) ? t.kind : "audio";
    if (kind === "video") {
      if (media_kind === "audio") {
        await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_failed", { groupId, call_id, generation, extra: { reason: "video_not_enabled" } });
        return json({ error: "video is not enabled for this call" }, 400);
      }
      videoCount++;
    } else {
      audioCount++;
    }
    const trackName = String(t?.trackName || "").slice(0, MAX_TRACK_NAME_LEN);
    if (!trackName) return json({ error: "trackName required" }, 400);
    tracks.push({ location: "local", mid: String(t?.mid ?? "0"), trackName });
  }
  if (audioCount > 1 || videoCount > 1) return json({ error: "at most one audio and one video track per publish" }, 400);

  await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_started", { groupId, call_id, generation });

  const r = await sfu(env, "POST", `/sessions/${b.sessionId}/tracks/new`, {
    sessionDescription: { type: "offer", sdp: b.offer.sdp },
    tracks,
  });
  if (!r.ok || !r.data?.sessionDescription) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_failed", { groupId, call_id, generation, extra: { status: r.status } });
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "publish", status: r.status, group_id: groupId, provider: PROVIDER });
    return json({ error: "could not publish track", detail: r.data }, 502);
  }
  await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_completed", { groupId, call_id, generation });
  await trackUser(env, g.uid, g.email, "groupcall_publish", "avatok", { group_id: groupId, provider: PROVIDER });
  return json({ answer: r.data.sessionDescription, tracks: r.data.tracks ?? [] });
}

// ---- POST /pull (a remote participant's track) -----------------------------------

export async function groupCallPull(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const trackName = b?.trackName ?? b?.track_name;
  const remoteUid = b?.remoteUid ?? b?.remote_uid;
  if (!b?.sessionId || !b?.remoteSessionId || !trackName) {
    return json({ error: "sessionId + remoteSessionId + trackName required" }, 400);
  }
  const kind = b?.kind === "video" ? "video" : "audio";

  // Server-side authorization: the subscriber must be a live participant of THIS
  // call and the publisher must actually be publishing that exact track — and
  // bounded per-client pull caps are enforced here (audio existing N; video
  // configurable, default 9, hard ceiling 12).
  const authz = await roomFetch<{ ok: boolean; error?: string }>(env, groupId, "/authority/pull", {
    uid: g.uid, session_id: b.sessionId, remote_uid: remoteUid ?? null, kind, track_name: trackName, max_video: b?.maxVideo ?? b?.max_video,
  });
  if (!authz.ok || !authz.data?.ok) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_failed", { groupId, extra: { stage: "authorize", status: authz.status, kind } });
    return json({ error: authz.data?.error ?? "pull not authorized" }, authz.status >= 400 ? authz.status : 403);
  }

  await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_started", { groupId, extra: { kind } });

  // Simulcast RID passthrough (best-effort — Cloudflare Realtime SFU simulcast,
  // https://developers.cloudflare.com/realtime/sfu/simulcast/). If the caller
  // supplies a preferred rid the field rides along on the remote track
  // descriptor; unsupported/ignored server-side revisions of the CF API simply
  // ignore the extra key.
  const rid = b?.rid ?? b?.preferredRid;
  const remoteTrack: Record<string, unknown> = { location: "remote", sessionId: b.remoteSessionId, trackName };
  if (rid && typeof rid === "string") remoteTrack.rid = rid;

  const r = await sfu(env, "POST", `/sessions/${b.sessionId}/tracks/new`, { tracks: [remoteTrack] });
  if (!r.ok) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_failed", { groupId, extra: { stage: "sfu", status: r.status, kind } });
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "pull", status: r.status, group_id: groupId, provider: PROVIDER });
    return json({ error: "could not pull track", detail: r.data }, 502);
  }
  await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_completed", { groupId, extra: { kind } });
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

// ---- POST /close (drop published/pulled tracks; leave is the WS close) ---------

export async function groupCallClose(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b?.sessionId || !Array.isArray(b?.mids)) return json({ error: "sessionId + mids[] required" }, 400);

  // Optional precise pull-cap bookkeeping: {tracks:[{kind,trackName}]}. Idempotent
  // on the DO side regardless of whether this is supplied.
  if (Array.isArray(b?.tracks)) {
    await Promise.all(b.tracks.map((t: any) =>
      roomFetch(env, groupId, "/authority/pull_close", { uid: g.uid, session_id: b.sessionId, kind: t?.kind === "video" ? "video" : "audio", track_name: t?.trackName ?? t?.track_name }),
    ));
  }

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
  const cap = f.cfConf ? MAX_CONF_PARTICIPANTS : MAX_GROUP;
  if (!f.conf || !f.enabled || !sfuConfigured(env)) return json({ live: false, count: 0, max: cap });
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const p = await presence(env, groupId);
  return json({ live: p.live, count: p.count, max: cap, call_id: p.call_id });
}
