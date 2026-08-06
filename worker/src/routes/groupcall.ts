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
import { mintIceServersWithStatus } from "./media";

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
async function presence(env: Env, groupId: string): Promise<{ live: boolean; count: number; call_id: string | null; state: string; media_kind: string | null }> {
  const r = await roomFetch<{ live?: boolean; count?: number; call_id?: string | null; state?: string; media_kind?: string | null }>(env, groupId, "/presence");
  if (!r.ok || !r.data) return { live: false, count: 0, call_id: null, state: "ended", media_kind: null };
  return {
    live: !!r.data.live, count: r.data.count ?? 0, call_id: r.data.call_id ?? null,
    state: r.data.state ?? "ended", media_kind: r.data.media_kind ?? null,
  };
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
/** Constant-time comparison of two base64url-encoded HMAC signatures, over the
 *  raw decoded bytes (never the encoded string, and never short-circuiting on
 *  the first mismatching byte) — a plain `!==` on the encoded strings leaks
 *  timing information proportional to the matching prefix length, which is a
 *  known HMAC-verification side channel. */
function constantTimeEqual(aEncoded: string, bEncoded: string): boolean {
  let a: Uint8Array, b: Uint8Array;
  try { a = fromB64u(aEncoded); } catch { return false; }
  try { b = fromB64u(bEncoded); } catch { return false; }
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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
  if (!constantTimeEqual(expect, sig)) return null;
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
  // Defensive: an analytics reject must never surface on the join/publish/pull
  // path — this whole function is best-effort telemetry, not call-critical.
  try {
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
  } catch { /* telemetry is never allowed to fail the call path */ }
}

// ---- [GCALL-W4-RING] ringing the group ------------------------------------------
//
// Mirrors the 1:1 ring in routes/api.ts (WS fast path + FCM offline path), with
// the parts that only make sense for a two-party call left out: there is no
// per-callee CallRoom participant record, no ring-receipt/native-action token
// and no server ring deadline. A group ring is an invitation to a call that
// already exists — the authority IS the call, and the DO cancels the ring when
// it ends (see cancelRing in do/group_call_room.ts).
//
// The push reuses the EXISTING `kind:"call"` consumer branch rather than adding
// a new push kind, so no consumers deploy is required for this to ring: the
// group-ness rides along as extra fields the client reads.
const GROUP_RING_TTL_MS = 45_000;

async function ringGroup(
  env: Env, req: Request,
  a: {
    groupId: string; uid: string; email: string | null; callId: string; callTraceId: string;
    mediaKind: string; targets: string[]; generation: number;
  },
): Promise<void> {
  const [callerName, groupName] = await Promise.all([
    displayNameOf(env, a.uid),
    groupTitleOf(env, a.groupId),
  ]);
  const now = Date.now();
  const kind = a.mediaKind === "audio" ? "audio" : "video";
  const frame = {
    // `call_ring` is the type the client already routes to its incoming-call
    // handler; `group:true` + `gid` are what make it open the conference screen
    // instead of the 1:1 one. `fromPub` (not `from`) because FCM reserves `from`.
    type: "call_ring",
    group: true,
    gid: a.groupId,
    callId: a.callId,
    fromPub: a.uid,
    fromName: callerName,
    groupName,
    kind,
    generation: a.generation,
    tokenExpiresAt: now + GROUP_RING_TTL_MS,
    trace_id: a.callTraceId,
    ts: now,
  };
  const body = JSON.stringify(frame);

  // [GCALL-TEL] Per-target delivery outcome. "The phone never rang" has three
  // completely different causes — the WS frame never went, the push never went,
  // or both went and the handset dropped them — and without recording which leg
  // landed for WHICH person there is no way to tell them apart afterwards.
  let wsLive = 0, wsFailed = 0, pushQueued = 0, pushFailed = 0;
  await Promise.all(a.targets.map(async (to) => {
    // WS fast path — instant for anyone with the app open.
    try {
      const r = await env.INBOX.get(env.INBOX.idFromName(to)).fetch("https://inbox/event", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      try {
        if (((await r.json()) as { live?: boolean })?.live) wsLive++; else wsFailed++;
      } catch { wsFailed++; }
    } catch { wsFailed++; /* offline: the push below is the backstop */ }
    // FCM path — for a phone in a pocket, which is the whole point.
    try {
      await env.Q_PUSH.send({
        kind: "call", to, from: a.uid, fromName: callerName, callId: a.callId,
        callType: kind, traceId: a.callTraceId, ts: now,
        tokenExpiresAt: now + GROUP_RING_TTL_MS,
        group: true, gid: a.groupId, groupName,
      });
      pushQueued++;
    } catch { pushFailed++; /* the WS frame may still have landed */ }
  }));

  await emitConf(env, req, a.uid, a.email, "cloudflare_conference_ring_sent", {
    groupId: a.groupId, call_id: a.callId, call_trace_id: a.callTraceId, generation: a.generation,
    extra: {
      targets: a.targets.length, media_kind: a.mediaKind, ttl_ms: GROUP_RING_TTL_MS,
      group_name: groupName, caller_name: callerName,
      ws_live: wsLive, ws_failed: wsFailed, push_queued: pushQueued, push_failed: pushFailed,
      // Raw uids, not hashes: this is the ONE event that has to be joinable
      // against each recipient's own `group_call_ring_received` when a tester
      // says "he called and my phone never rang". `emitConf` already carries
      // the caller's email, so the pair is retrievable from either end.
      target_uids: a.targets,
    },
  });
}

/** Best-effort display name for the caller shown on the ringing screen. */
async function displayNameOf(env: Env, uid: string): Promise<string> {
  try {
    // Same shape (and same fallback chain) as senderName in routes/messaging.ts.
    const r = await env.DB_META.prepare("SELECT display_name, handle FROM users WHERE uid=?1 LIMIT 1")
      .bind(uid).first<{ display_name: string | null; handle: string | null }>();
    return (r?.display_name || r?.handle || "AvaTOK").toString();
  } catch { return "AvaTOK"; }
}

async function groupTitleOf(env: Env, conv: string): Promise<string> {
  try {
    const r = await env.DB_META.prepare("SELECT title FROM conversations WHERE id=?1")
      .bind(conv).first<{ title: string | null }>();
    const t = (r?.title ?? "").trim();
    return t || "Group call";
  } catch { return "Group call"; }
}

// ---- guard shared by every endpoint -------------------------------------------

// [R6 2026-08-01] `lkConf` removed with LiveKit. `flags()` no longer returns it,
// and nothing read it — it survived the cutover only in this type and in the
// return below, which is what made the build stop compiling.
type Guard = { uid: string; email: string | null; cfConf: boolean } | Response;

async function guard(req: Request, env: Env, groupId: string, opts: { checkCap?: boolean } = {}): Promise<Guard> {
  const f = await flags(env);
  // [GCALL-W1-503] The two unavailable paths used to return a bare 503 and emit
  // NOTHING server-side, so "group calls are down" was invisible in telemetry —
  // indistinguishable from nobody trying. Identify the caller first (cheap
  // relative to the SFU round trips this is refusing) so the block is
  // attributable to a tester's email, then refuse with a reason the client can
  // render honestly.
  if (!f.conf || !f.enabled || !sfuConfigured(env)) {
    const reason = !f.conf || !f.enabled ? "flags" : "unconfigured";
    const who = await requireUser(req, env);
    if (!isFail(who)) {
      const whoEmail = await emailFor(env, who.uid).catch(() => null);
      await trackUser(env, who.uid, whoEmail, "groupcall_blocked", "avatok", {
        reason: `unavailable_${reason}`,
        conference_enabled: f.conf, cf_conference_enabled: f.cfConf,
        sfu_configured: sfuConfigured(env),
        group_id: groupId, provider: PROVIDER, ...confGeo(req),
      });
    }
    return json({
      error: reason === "flags" ? "group calling is unavailable" : "group call backend not configured",
      unavailable_reason: reason,
    }, 503);
  }
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const email = await emailFor(env, u.uid).catch(() => null);

  // [ADDCALL-0] FAIL CLOSED. This used to read
  //   `if (mem.length > 0 && !mem.includes(u.uid))`
  // which let a group id with ZERO member rows admit ANYONE — the roster being
  // empty was read as "no roster to check" rather than "you are not on it".
  // That is the opposite of `ConferenceRoomDO.isGroupMember`
  // (`worker/src/do/conference_room.ts:161-172`), which fails closed on purpose
  // and says why: "a caller who learns a room id must not be able to consume a
  // roster slot".
  //
  // Verified before changing: nothing legitimate depends on the empty case.
  // Every writer of a `conversations` row inserts at least one
  // `conversation_members` row in the same D1 batch — convCreate
  // (`messaging.ts:1572-1578`, owner inserted even when `groupInvitesEnabled`
  // holds the invitees back), convAdopt (`:1615-1621`), DM creation — and no
  // deletion can strand one (`convRemoveMember` refuses to remove the owner;
  // `convLeave` reassigns or deletes the conversation; `convDelete` removes
  // both). A PENDING invitee leaves the roster non-empty, so that case was
  // already handled by the `!mem.includes` half and is unchanged. Every
  // `groupId` reaching here comes from the `/api/groupcall/:id/...` route match
  // in `index.ts` and is always a real conversation id. The only thing that
  // could have relied on fail-open was a legacy local-only group whose
  // `convAdopt` never succeeded — and that group is already non-functional
  // (message fan-out and `ringGroup` both read the same empty roster, so nobody
  // is notified and nobody is rung).
  //
  // A D1 failure inside `groupMembers` throws, which surfaces as a 500 rather
  // than an admission — also closed.
  //
  // Telemetry distinguishes the two causes so an empty-roster hit is visible in
  // PostHog rather than hiding inside the ordinary not-a-member count.
  const mem = await groupMembers(env, groupId);
  if (!mem.includes(u.uid)) {
    const reason = mem.length === 0 ? "empty_roster" : "not_member";
    await trackUser(env, u.uid, email, "groupcall_blocked", "avatok",
      { reason, group_id: groupId, provider: PROVIDER, ...confGeo(req) });
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
  const t0 = Date.now();
  const g = await guard(req, env, groupId, { checkCap: true });
  if (g instanceof Response) return g;

  let wantVideo = false;
  try { const b = (await req.json()) as { video?: boolean }; wantVideo = b?.video === true; } catch { /* optional body */ }
  const mediaKind = g.cfConf && wantVideo ? "audio_video" : "audio";

  // Roster size before this joiner is admitted — cheaply available from the
  // same DO presence read already used for the capacity check above, reused
  // here for cloudflare_conference_ticket_issued.existing_participant_count
  // and cloudflare_conference_joined.roster_size_on_join per the telemetry
  // contract (Specs/CF-CONFERENCE-TELEMETRY-CONTRACT-2026-07-24.md §2, §3).
  const preJoin = await presence(env, groupId);

  await emitConf(env, req, g.uid, g.email, "conference_provider_selected", {
    groupId,
    extra: {
      decided_provider: "cloudflare_realtime",
      decision_source: "worker",
      media_kind_requested: mediaKind,
      cloudflare_conference_enabled: g.cfConf,
    },
  });
  await emitConf(env, req, g.uid, g.email, "cloudflare_conference_join_started", { groupId, extra: { route: "join" } });

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
  // [GCALL-W4-RING] Hand the DO the roster to un-ring when the call ends.
  const roster = await groupMembers(env, groupId);
  const ringTargets = roster.filter((u) => u !== g.uid);
  const authRes = await roomFetch<{ call_id: string; call_trace_id: string; generation: number; state: string; media_kind: string; max_participants: number; started_by?: string; error?: string; cap?: number }>(
    env, groupId, "/authority/start",
    { uid: g.uid, media_kind: mediaKind, max_participants: cap, ring_targets: ringTargets, gid: groupId },
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
  const sessionIdHash = (await sha256Hex(sessionId)).slice(0, 16);
  await emitConf(env, req, g.uid, g.email, "cloudflare_conference_ticket_issued", {
    groupId, call_id: authority.call_id, call_trace_id: authority.call_trace_id, generation: authority.generation,
    extra: {
      route: "join",
      session_id_hash: sessionIdHash,
      ttl_ms: TICKET_TTL_S * 1000,
      max_participants: authority.max_participants,
      existing_participant_count: preJoin.count,
    },
  });

  const ice = await mintIceServersWithStatus(env, ICE_TTL_S);
  const url = new URL(req.url);
  const wsUrl = `wss://${url.host}/api/groupcall/${groupId}/ws?ticket=${encodeURIComponent(ticket)}`;

  await emitConf(env, req, g.uid, g.email, "cloudflare_conference_joined", {
    groupId, call_id: authority.call_id, call_trace_id: authority.call_trace_id, generation: authority.generation,
    extra: {
      session_id_hash: sessionIdHash,
      media_kind: authority.media_kind,
      elapsed_ms: Date.now() - t0,
      roster_size_on_join: preJoin.count,
    },
  });
  await trackUser(env, g.uid, g.email, "groupcall_join", "avatok",
    { session_id: sessionId, call_id: authority.call_id, group_id: groupId, provider: PROVIDER, ...confGeo(req) });

  // [GCALL-W4-RING] Ring the rest of the group — the thing group calls have
  // never done. Until now the ONLY notification a group call produced was an
  // ordinary chat message ("📹 Video call started — tap 📞 to join") and its
  // content-less chat chime: no call push, no CallKit, no ring frame. If your
  // phone was in your pocket you simply never knew.
  //
  // Fired only by the person who actually CREATED the authority, and only into
  // an empty room. That is also what settles the two-simultaneous-starters race:
  // the DO converges both racers onto one call_id, and only the one whose start
  // minted it rings anybody.
  if (authority.started_by === g.uid && preJoin.count === 0 && ringTargets.length) {
    await ringGroup(env, req, {
      groupId, uid: g.uid, email: g.email, callId: authority.call_id,
      callTraceId: authority.call_trace_id, mediaKind: authority.media_kind,
      targets: ringTargets, generation: authority.generation,
    });
  }

  return json({
    provider: PROVIDER,
    call_id: authority.call_id,
    call_trace_id: authority.call_trace_id,
    session_id: sessionId,
    join_ticket: ticket,
    ice_servers: ice.iceServers,
    relay_available: !ice.relayDegraded,
    relay_degraded: ice.relayDegraded,
    ...(ice.relayReason ? { relay_reason: ice.relayReason } : {}),
    media: { audio: true, video: authority.media_kind !== "audio" },
    max_participants: authority.max_participants,
    ws_url: wsUrl,
    generation: authority.generation,
  });
}

/** Mint a fresh one-time WS ticket for an existing SFU session. Reconnects must
 * never reuse the original bearer ticket now that ticket nonces are consumed
 * on upgrade. This does not create another SFU session or change room media. */
export async function groupCallRejoin(req: Request, env: Env, groupId: string): Promise<Response> {
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const sessionId = String(b?.sessionId ?? "").trim();
  if (!sessionId) return json({ error: "sessionId required" }, 400);
  const auth = await roomFetch<{ call_id: string; call_trace_id: string; generation: number; state: string; media_kind: string; max_participants: number; error?: string }>(
    env, groupId, "/authority/join", { uid: g.uid },
  );
  if (!auth.ok || !auth.data?.call_id || auth.data.state === "ended") {
    return json({ error: auth.data?.error ?? "call is no longer active" }, auth.status >= 400 ? auth.status : 409);
  }
  const check = await roomFetch<{ ok: boolean; error?: string }>(env, groupId, "/authority/session_check", {
    uid: g.uid, session_id: sessionId,
  });
  // The existing attachment is the proof that this session belongs to this
  // authenticated uid. If its close event already won the race, the caller
  // must use the full join flow, which mints a new SFU session; never mint a
  // ticket for an arbitrary session id supplied by a group member.
  if (!check.ok) return json({ error: "session is not eligible for reconnect" }, 409);
  const ticket = await mintJoinTicket(env, {
    call_id: auth.data.call_id, uid: g.uid, session_id: sessionId, generation: auth.data.generation,
  });
  if (!ticket) return json({ error: "call ticketing not configured" }, 503);
  const ice = await mintIceServersWithStatus(env, ICE_TTL_S);
  const url = new URL(req.url);
  return json({
    provider: PROVIDER, call_id: auth.data.call_id, call_trace_id: auth.data.call_trace_id,
    session_id: sessionId, join_ticket: ticket, ice_servers: ice.iceServers,
    relay_available: !ice.relayDegraded, relay_degraded: ice.relayDegraded,
    ...(ice.relayReason ? { relay_reason: ice.relayReason } : {}),
    media: { audio: true, video: auth.data.media_kind !== "audio" },
    max_participants: auth.data.max_participants, generation: auth.data.generation,
    ws_url: `wss://${url.host}/api/groupcall/${groupId}/ws?ticket=${encodeURIComponent(ticket)}`,
  });
}

// ---- POST /publish (local mic/camera tracks) ------------------------------------

const MAX_TRACK_NAME_LEN = 128;
const ALLOWED_KINDS = new Set(["audio", "video"]);

export async function groupCallPublish(req: Request, env: Env, groupId: string): Promise<Response> {
  const t0 = Date.now();
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!b?.sessionId || !b?.offer?.sdp) return json({ error: "sessionId + offer required" }, 400);

  // Best-effort attempt counter: client increments on a retried publish (e.g.
  // after generation_conflict) per the telemetry contract §3.1; default 1.
  const attempt = Number.isFinite(b?.attempt) && b.attempt >= 1 ? Math.trunc(b.attempt) : 1;

  // Explicit track metadata (Phase 2): one local offer, audio + optional video.
  // Never trust anything beyond kind/trackName/mid from the client; location is
  // forced to "local" and kinds are validated against the call's media mode.
  const rawTracks: any[] = Array.isArray(b.tracks) && b.tracks.length
    ? b.tracks
    : [{ location: "local", mid: b.mid ?? "0", kind: "audio", trackName: b.trackName ?? `mic-${g.uid}` }];
  const midCount = rawTracks.length;
  const requestedKinds = new Set(rawTracks.map((t) => (ALLOWED_KINDS.has(t?.kind) ? t.kind : "audio")));
  const trackKind = requestedKinds.has("video") && requestedKinds.has("audio")
    ? "audio_video" : requestedKinds.has("video") ? "video" : "audio";

  const check = await roomFetch<{ ok: boolean; generation: number; media_kind: string; call_id: string; error?: string }>(
    env, groupId, "/authority/session_check", { uid: g.uid, session_id: b.sessionId },
  );
  if (!check.ok || !check.data?.ok) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_failed", {
      groupId,
      extra: {
        stage: "session_check", status: check.status, track_kind: trackKind, attempt,
        elapsed_ms: Date.now() - t0,
        failure_code: check.status === 409 ? "generation_conflict" : "publish_track_rejected",
      },
    });
    return json({ error: check.data?.error ?? "not connected to this call" }, check.status === 409 ? 409 : 404);
  }
  const { generation, media_kind, call_id } = check.data;

  let audioCount = 0, videoCount = 0;
  const tracks: { location: "local"; mid: string; trackName: string }[] = [];
  for (const t of rawTracks) {
    const kind = ALLOWED_KINDS.has(t?.kind) ? t.kind : "audio";
    if (kind === "video") {
      if (media_kind === "audio") {
        await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_failed", {
          groupId, call_id, generation,
          extra: { reason: "video_not_enabled", track_kind: trackKind, attempt, elapsed_ms: Date.now() - t0, failure_code: "publish_track_rejected" },
        });
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

  await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_started", {
    groupId, call_id, generation, extra: { track_kind: trackKind, mid_count: midCount, attempt },
  });

  const r = await sfu(env, "POST", `/sessions/${b.sessionId}/tracks/new`, {
    sessionDescription: { type: "offer", sdp: b.offer.sdp },
    tracks,
  });
  if (!r.ok || !r.data?.sessionDescription) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_failed", {
      groupId, call_id, generation,
      extra: { status: r.status, track_kind: trackKind, attempt, elapsed_ms: Date.now() - t0, failure_code: "publish_sdp_failed" },
    });
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "publish", status: r.status, group_id: groupId, provider: PROVIDER });
    return json({ error: "could not publish track", detail: r.data }, 502);
  }
  await emitConf(env, req, g.uid, g.email, "cloudflare_track_publish_completed", {
    groupId, call_id, generation, extra: { track_kind: trackKind, attempt, elapsed_ms: Date.now() - t0 },
  });
  await trackUser(env, g.uid, g.email, "groupcall_publish", "avatok", { group_id: groupId, provider: PROVIDER });
  return json({ answer: r.data.sessionDescription, tracks: r.data.tracks ?? [] });
}

// ---- POST /pull (a remote participant's track) -----------------------------------

export async function groupCallPull(req: Request, env: Env, groupId: string): Promise<Response> {
  const t0 = Date.now();
  const g = await guard(req, env, groupId);
  if (g instanceof Response) return g;
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const trackName = b?.trackName ?? b?.track_name;
  const remoteUid = b?.remoteUid ?? b?.remote_uid;
  if (!b?.sessionId || !b?.remoteSessionId || !trackName) {
    return json({ error: "sessionId + remoteSessionId + trackName required" }, 400);
  }
  const trackKind = b?.kind === "video" ? "video" : "audio";
  const attempt = Number.isFinite(b?.attempt) && b.attempt >= 1 ? Math.trunc(b.attempt) : 1;

  // Server-side authorization: the subscriber must be a live participant of THIS
  // call and the publisher must actually be publishing that exact track — and
  // bounded per-client pull caps are enforced here (audio existing N; video
  // configurable, default 9, hard ceiling 12).
  const authz = await roomFetch<{ ok: boolean; error?: string }>(env, groupId, "/authority/pull", {
    uid: g.uid, session_id: b.sessionId, remote_uid: remoteUid ?? null, kind: trackKind, track_name: trackName, max_video: b?.maxVideo ?? b?.max_video,
  });
  if (!authz.ok || !authz.data?.ok) {
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_failed", {
      groupId,
      extra: {
        stage: "authorize", status: authz.status, track_kind: trackKind, attempt,
        elapsed_ms: Date.now() - t0, failure_code: "pull_track_rejected",
      },
    });
    return json({ error: authz.data?.error ?? "pull not authorized" }, authz.status >= 400 ? authz.status : 403);
  }

  await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_started", { groupId, extra: { track_kind: trackKind, attempt } });

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
    await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_failed", {
      groupId,
      extra: {
        stage: "sfu", status: r.status, track_kind: trackKind, attempt,
        elapsed_ms: Date.now() - t0, failure_code: "pull_sdp_failed",
      },
    });
    await trackUser(env, g.uid, g.email, "groupcall_error", "avatok",
      { stage: "pull", status: r.status, group_id: groupId, provider: PROVIDER });
    return json({ error: "could not pull track", detail: r.data }, 502);
  }
  await emitConf(env, req, g.uid, g.email, "cloudflare_track_pull_completed", {
    groupId, extra: { track_kind: trackKind, attempt, elapsed_ms: Date.now() - t0 },
  });
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

// [GCALL-W1-STATUS] The response gained four additive fields; old clients
// ignore them, so the Worker can (and must) deploy ahead of the client build.
//   available / unavailable_reason — "calls are switched off" and "the call
//     backend is not configured" used to collapse into an ordinary
//     {live:false}, indistinguishable from "there is no call right now". The
//     thread therefore blamed every greyed-out call icon on ">25 members".
//   state / media_kind — the banner previously hardcoded a VIDEO join, and a
//     video publish into an audio call is rejected server-side, failing the
//     whole join. It can now join with the call's actual media kind.
export async function groupCallStatus(req: Request, env: Env, groupId: string): Promise<Response> {
  const f = await flags(env);
  const cap = f.cfConf ? MAX_CONF_PARTICIPANTS : MAX_GROUP;
  if (!f.conf || !f.enabled) {
    return json({ live: false, count: 0, max: cap, available: false, unavailable_reason: "flags" });
  }
  if (!sfuConfigured(env)) {
    return json({ live: false, count: 0, max: cap, available: false, unavailable_reason: "unconfigured" });
  }
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const p = await presence(env, groupId);
  return json({
    live: p.live, count: p.count, max: cap, call_id: p.call_id,
    state: p.state, media_kind: p.media_kind, available: true, unavailable_reason: null,
  });
}
