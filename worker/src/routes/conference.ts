// AvaTalk group conferencing (Phase 10 — RULE CHANGE 2026-06-10).
// Groups may hold audio/video conferences, max 25 participants, via LiveKit.
// 1:1 calls stay on the P2P CallRoom-DO path (2-peer cap UNTOUCHED).
//
// Endpoints (Clerk/NIP-98 auth via requireUser):
//   POST /api/conference/:groupId/start  {kind: "video"|"audio"}
//   POST /api/conference/:groupId/join
//   GET  /api/conference/:groupId/status        — live? how many in call (PiP banner)
//   POST /api/conference/webhook                — LiveKit → worker (JWT-verified)
//
// Rules enforced here:
//   - `conferenceEnabled` kill switch (KV platform_config) gates everything.
//   - caller must be a member of the group (D1 conversation_members). Legacy
//     local-only groups (pre-pivot, no D1 row) fall back to authenticated-user
//     access — the unguessable group id is the capability; LiveKit
//     max_participants=25 still backstops the cap. Registered groups get the
//     strict membership check.
//   - group member count > 25 ⇒ 403 (client also greys the icons).
//   - LiveKit room `group:<groupId>` created with max_participants=25 — the
//     server-side backstop that refuses the 26th joiner even when racing.
//
// LiveKit auth is plain JWT HS256 + Twirp HTTP — no SDK dependency.
//
// MULTI-REGION (Specs/AVA-SFU-SELFHOST-PLAYBOOK.md): a room is PINNED to ONE
// region (self-hosted OSS has no cross-region media mesh — that's Cloud-only).
// `LIVEKIT_REGIONS` (JSON secret) maps region→creds; absent ⇒ a single `cloud`
// region synthesized from the legacy LIVEKIT_URL/API_KEY/API_SECRET, so this is
// a no-op until you populate it. start() picks a region (free→cloud; paid→nearest
// by req.cf.continent, falling back to cloud), records it in KV `conf_region:<gid>`
// + room metadata, and join/end/status read it back so every participant lands on
// the SAME node. NAT traversal uses Cloudflare Calls TURN (minted per call).
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { isFail, requireUser } from "../authz";
import { PLANS, tierOf } from "./plans";
import { enforceAllowance, planLimitBody } from "../lib/usage";
import { track, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { mintIceServers } from "./media";

// Absolute backstop — no tier may ever exceed this on the SFU. Per-call caps are
// the STARTER's plan `confParticipants` (Free 5 / Plus 10 / Pro 25 / Max 25).
// Free (tier 0) DOES use the SFU now (LiveKit Cloud, ≤5, 60 min/day) — see issue().
const MAX_PARTICIPANTS = 25;
const TOKEN_TTL_S = 6 * 3600; // long enough for any realistic call
const REGION_TTL_S = 6 * 3600; // KV room→region pin lives at least as long as a call

// ---- region routing -----------------------------------------------------------

/** One LiveKit cluster's credentials (cloud or a self-hosted region). */
interface LkCreds { url: string; key: string; secret: string; }

/** continent (req.cf.continent) → preferred self-hosted region key. */
const CONTINENT_REGION: Record<string, string> = {
  EU: "eu", AF: "eu", NA: "us", SA: "us", AS: "ap", OC: "ap",
};

/** The region map actually in effect. `LIVEKIT_REGIONS` JSON secret overrides;
 *  always falls back to a `cloud` region built from the legacy single creds. */
function regionsConfig(env: Env): Record<string, LkCreds> {
  const out: Record<string, LkCreds> = {};
  try {
    const parsed = env.LIVEKIT_REGIONS ? (JSON.parse(env.LIVEKIT_REGIONS) as Record<string, Partial<LkCreds>>) : {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && v.url && v.key && v.secret) out[k] = { url: v.url, key: v.key, secret: v.secret };
    }
  } catch { /* malformed secret — ignore, use legacy cloud */ }
  if (!out.cloud && env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
    out.cloud = { url: env.LIVEKIT_URL, key: env.LIVEKIT_API_KEY, secret: env.LIVEKIT_API_SECRET };
  }
  return out;
}

/** Pick the region a NEW room should live on. Free → always cloud. Paid →
 *  nearest self-hosted region by continent, falling back to cloud when that
 *  region isn't deployed yet. */
function pickRegion(env: Env, req: Request, tier: number): string {
  const cfg = regionsConfig(env);
  if (tier === 0) return cfg.cloud ? "cloud" : Object.keys(cfg)[0] ?? "cloud";
  const continent = (req as any).cf?.continent as string | undefined;
  const want = continent ? CONTINENT_REGION[continent] : undefined;
  if (want && cfg[want]) return want;
  return cfg.cloud ? "cloud" : (Object.keys(cfg)[0] ?? "cloud");
}

/** Resolve a region key → creds, falling back to cloud then any configured region. */
function credsFor(env: Env, region: string | null | undefined): LkCreds | null {
  const cfg = regionsConfig(env);
  return (region && cfg[region]) || cfg.cloud || Object.values(cfg)[0] || null;
}

function regionKvKey(groupId: string): string { return `conf_region:${groupId}`; }

/** The region a live room is pinned to (written at start). Defaults to cloud. */
async function roomRegion(env: Env, groupId: string): Promise<string> {
  try { return (await env.TOKENS.get(regionKvKey(groupId))) || "cloud"; } catch { return "cloud"; }
}

// ---- small utils --------------------------------------------------------------

const enc = new TextEncoder();

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Mint a LiveKit access token (JWT HS256) signed with a region's creds. */
async function lkToken(lk: LkCreds, claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: lk.key, nbf: now - 10, exp: now + TOKEN_TTL_S, ...claims };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(lk.secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

/** Twirp call against a specific region's LiveKit RoomService. */
async function lkApi(lk: LkCreds, method: string, body: Record<string, unknown>): Promise<Response> {
  const host = lk.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
  const admin = await lkToken(lk, { video: { roomCreate: true, roomList: true, roomAdmin: true } });
  return fetch(`${host}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify(body),
  });
}

function roomName(groupId: string): string { return `group:${groupId}`; }

/** Rich edge geo (Cloudflare request.cf) for the conference analytics dashboard:
 *  country, city, region, timezone, continent + the Cloudflare colo (edge PoP),
 *  a coarse "where the call entered the network" signal. Powers the "where are
 *  our top video-conf regions" PostHog view. Best-effort — all fields nullable. */
function confGeo(req: Request): Record<string, string | null> {
  const cf = (req as any).cf ?? {};
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    country: s(cf.country), city: s(cf.city), region: s(cf.region),
    timezone: s(cf.timezone), continent: s(cf.continent), colo: s(cf.colo),
  };
}

function configured(env: Env): boolean {
  return Object.keys(regionsConfig(env)).length > 0;
}

async function conferenceEnabled(env: Env): Promise<boolean> {
  try {
    const cfg = (await env.TOKENS.get("platform_config", "json")) as { conferenceEnabled?: boolean } | null;
    return cfg?.conferenceEnabled !== false; // default ON (matches routes/config.ts DEFAULTS)
  } catch { return true; }
}

// [CF-CALL-000/001] Phase-0 provider-drift assertion, ADAPTED for safety
// (owner-approved deviation from the literal proposal text): reject LiveKit
// issuance ONLY when `livekitConferenceEnabled===false`. We deliberately do NOT
// gate this on `cloudflareConferenceEnabled===true` — old installed clients that
// haven't picked up the Cloudflare A/V path yet must keep working while BOTH
// flags are on during the migration window. Flipping `livekitConferenceEnabled`
// off is the explicit, single kill switch for "no more LiveKit tokens."
async function livekitConferenceEnabled(env: Env): Promise<boolean> {
  try {
    const cfg = (await env.TOKENS.get("platform_config", "json")) as { livekitConferenceEnabled?: boolean } | null;
    return cfg?.livekitConferenceEnabled !== false; // default ON (matches routes/config.ts DEFAULTS)
  } catch { return true; }
}

async function cloudflareConferenceEnabled(env: Env): Promise<boolean> {
  try {
    const cfg = (await env.TOKENS.get("platform_config", "json")) as { cloudflareConferenceEnabled?: boolean } | null;
    return cfg?.cloudflareConferenceEnabled === true; // default OFF (matches routes/config.ts DEFAULTS)
  } catch { return false; }
}

/** conference_provider_selected — the decision-boundary telemetry event required
 *  by the migration proposal's PostHog contract (reconciled to
 *  Specs/CF-CONFERENCE-TELEMETRY-CONTRACT-2026-07-24.md §1.1), emitted every
 *  time this module decides to issue (or refuse) a LiveKit credential.
 *  `decision` keeps the finer-grained internal detail (cloud vs self-hosted
 *  region, or why it was rejected); `decided_provider` is the contract's
 *  fixed enum derived from it. Best-effort: an analytics reject must never
 *  surface on the join/start path. */
async function emitProviderSelected(
  env: Env, req: Request, uid: string, email: string | null, groupId: string,
  decision: "livekit_cloud" | "livekit_selfhost" | "rejected_disabled",
  opts: {
    decisionSource?: "client" | "worker";
    mediaKindRequested?: "audio" | "video" | "audio_video";
    cloudflareConferenceEnabled?: boolean;
    livekitConferenceEnabled?: boolean;
    extra?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    const [groupHash, uidHash] = await Promise.all([sha256Hex(groupId), sha256Hex(uid)]);
    const decidedProvider = decision.startsWith("livekit") ? "livekit" : "disabled";
    await trackUser(env, uid, email, "conference_provider_selected", "avatok", {
      transport: decision.startsWith("livekit") ? "livekit" : "none",
      decision, decided_provider: decidedProvider, decision_source: opts.decisionSource ?? "worker",
      media_kind_requested: opts.mediaKindRequested ?? null,
      cloudflare_conference_enabled: opts.cloudflareConferenceEnabled ?? null,
      livekit_conference_enabled: opts.livekitConferenceEnabled ?? null,
      group_id_hash: groupHash.slice(0, 16), participant_hash: uidHash.slice(0, 16),
      ...confGeo(req), ...(opts.extra ?? {}),
    });
  } catch { /* telemetry is never allowed to fail the conference start/join path */ }
}

/** Group members from D1 (Cloudflare-native conversations). Empty = unregistered legacy group. */
async function groupMembers(env: Env, groupId: string): Promise<string[]> {
  const rows = await env.DB_META
    .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1")
    .bind(groupId).all<{ uid: string }>();
  return (rows.results || []).map((r) => r.uid);
}

async function displayName(env: Env, uid: string): Promise<string> {
  try {
    const r = await env.DB_META.prepare("SELECT name FROM profiles WHERE uid = ?1").bind(uid).first<{ name?: string }>();
    if (r?.name) return r.name;
  } catch { /* table/shape drift — fall through */ }
  return "AvaTOK user";
}

// ---- token issue (start + join share this) ------------------------------------

async function issue(req: Request, env: Env, groupId: string, create: boolean): Promise<Response> {
  if (!(await conferenceEnabled(env))) return json({ error: "conferences are disabled" }, 503);
  if (!configured(env)) return json({ error: "conference backend not configured" }, 503);

  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);

  const g = confGeo(req);
  const email = await emailFor(env, u.uid).catch(() => null);

  // Parsed once, up front (the request body stream can only be read once), so
  // it's available both for conference_provider_selected.media_kind_requested
  // at the decision boundary and for the actual room kind further down.
  let kind = "video";
  try { const b = (await req.json()) as { kind?: string }; if (b?.kind === "audio") kind = "audio"; } catch { /* optional body */ }
  const mediaKindRequested = kind === "audio" ? "audio" : "video";

  const [lkConfFlag, cfConfFlag] = await Promise.all([livekitConferenceEnabled(env), cloudflareConferenceEnabled(env)]);

  // [CF-CALL-001] Phase-0 assertion (adapted): LiveKit issuance is refused ONLY
  // when the owner has explicitly turned it off. See livekitConferenceEnabled()
  // header comment for why this is NOT also gated on cloudflareConferenceEnabled.
  if (!lkConfFlag) {
    await emitProviderSelected(env, req, u.uid, email, groupId, "rejected_disabled", {
      mediaKindRequested, cloudflareConferenceEnabled: cfConfFlag, livekitConferenceEnabled: lkConfFlag,
      extra: { stage: create ? "start" : "join" },
    });
    return json({ error: "LiveKit conferencing has been retired for this app — use the Cloudflare call path" }, 410);
  }

  // Plan gate. RULE CHANGE 2026-06-28 (owner): Free (tier 0) NOW uses the SFU
  // too — on LiveKit Cloud, max 5 participants, metered to 60 min/day (6×10-min
  // calls ≈ one hour). Previously free was P2P-mesh only; the mesh path stays as
  // a dormant fallback. Per-call SIZE cap = the plan's confParticipants
  // (Free 5 / Plus 10 / Pro 25 / Max 25). `provider` is stamped so the analytics
  // dashboard can separate LiveKit-Cloud spend from the future self-hosted
  // regional SFU (see Specs/AVA-SFU-SELFHOST-PLAYBOOK.md). When self-hosted SFU
  // ships, free's 60 min/day expands to 180 (3h) — a plans.ts conf_min bump only.
  const tier = await tierOf(env, u.uid);
  const cap = Math.min(PLANS[tier].confParticipants, MAX_PARTICIPANTS); // 5 / 10 / 25 / 25

  // Region pin: a NEW room (create) is routed to the nearest region (free→cloud);
  // a JOIN reuses the region the room was started on (KV pin), so every
  // participant connects to the SAME node. credsFor falls back to cloud.
  const region = create ? pickRegion(env, req, tier) : await roomRegion(env, groupId);
  const lk = credsFor(env, region);
  if (!lk) return json({ error: "conference backend not configured" }, 503);
  const provider = region === "cloud" ? "livekit_cloud" : "livekit_selfhost";
  await emitProviderSelected(env, req, u.uid, email, groupId, provider, {
    mediaKindRequested, cloudflareConferenceEnabled: cfConfFlag, livekitConferenceEnabled: lkConfFlag,
    extra: { stage: create ? "start" : "join", region },
  });

  // Daily minute allowance (conf_min) enforced at ENTRY so a tapped-out user
  // can't start/join (the per-minute beat keeps consuming once inside). Peek only
  // (commit:false) — conferenceBeat does the actual decrement. Free = 60 min/day.
  const allow = await enforceAllowance(env, u.uid, tier, "conf_min", 1, { commit: false });
  if (!allow.allowed) {
    await trackUser(env, u.uid, email, "conf_blocked", "avatok", {
      reason: "daily_limit", stage: create ? "start" : "join", tier, cap_min: allow.cap,
      group_id: groupId, provider, ...g,
    });
    return json(planLimitBody(allow), 402);
  }

  // Membership + per-plan size cap (hard product rule). Legacy local groups have
  // no D1 rows — fall back to authenticated access (see header comment).
  const mem = await groupMembers(env, groupId);
  if (mem.length > 0) {
    if (!mem.includes(u.uid)) {
      await trackUser(env, u.uid, email, "conf_blocked", "avatok", { reason: "not_member", tier, group_id: groupId, ...g });
      return json({ error: "not a member" }, 403);
    }
    if (mem.length > cap) {
      await trackUser(env, u.uid, email, "conf_blocked", "avatok", {
        reason: "size_cap", tier, cap, members: mem.length, group_id: groupId, provider, ...g,
      });
      return json({ error: `your plan allows up to ${cap} on a group call — upgrade for more`, cap, tier }, 403);
    }
  }

  const room = roomName(groupId);

  if (create) {
    // Idempotent: CreateRoom on an existing name returns the room. The per-plan
    // `cap` here is THE backstop — a racing (cap+1)th joiner is refused by
    // LiveKit itself even if two workers issued tokens.
    const r = await lkApi(lk, "CreateRoom", {
      name: room, max_participants: cap, empty_timeout: 120, departure_timeout: 30,
      metadata: JSON.stringify({ groupId, kind, started_by: u.uid, starter_tier: tier, provider, region, edge: g.colo ?? null }),
    });
    if (!r.ok) {
      const detail = await r.text();
      await trackUser(env, u.uid, email, "conf_error", "avatok", {
        stage: "create_room", tier, region, detail: detail.slice(0, 300), group_id: groupId, provider, ...g,
      });
      return json({ error: "could not create conference room", detail }, 502);
    }
    // Pin the room→region so JOIN/END/STATUS target the same node. Best-effort:
    // a missed write just falls back to `cloud`, which is where free rooms live.
    try { await env.TOKENS.put(regionKvKey(groupId), region, { expirationTtl: REGION_TTL_S }); } catch { /* non-fatal */ }
  } else {
    // join: the room must be live (started by someone). ListParticipants 404s/
    // errors when the room doesn't exist.
    const r = await lkApi(lk, "ListParticipants", { room });
    if (!r.ok) {
      await trackUser(env, u.uid, email, "conf_blocked", "avatok", { reason: "no_live_room", tier, region, group_id: groupId, ...g });
      return json({ error: "no live conference for this group" }, 404);
    }
    const list = (await r.json()) as { participants?: unknown[] };
    if ((list.participants?.length ?? 0) >= cap) {
      await trackUser(env, u.uid, email, "conf_blocked", "avatok", { reason: "room_full", tier, cap, region, group_id: groupId, provider, ...g });
      return json({ error: `conference is full (${cap})` }, 409);
    }
  }

  const token = await lkToken(lk, {
    sub: u.uid,
    jti: u.uid,
    name: await displayName(env, u.uid),
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  });

  // Cloudflare Calls TURN/STUN for NAT traversal — handed to the client so the
  // LiveKit connection can relay when a direct path is blocked (esp. cellular).
  const iceServers = await mintIceServers(env, TOKEN_TTL_S);

  // Server-truth analytics: who / where / which tier / which backend / region.
  // The geo (...g) powers the "where are our video-conf regions" dashboard.
  await trackUser(env, u.uid, email, create ? "conf_start" : "conf_join", "avatok", {
    tier, kind, cap, provider, region, group_id: groupId,
    members: mem.length || null, remaining_min: allow.remaining, ...g,
  });

  const url = lk.url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return json({ url, token, room, kind, max: cap, tier, provider, region, iceServers });
}

export async function conferenceStart(req: Request, env: Env, groupId: string): Promise<Response> {
  return issue(req, env, groupId, true);
}

export async function conferenceJoin(req: Request, env: Env, groupId: string): Promise<Response> {
  return issue(req, env, groupId, false);
}

// ---- POST /api/conference/:groupId/end -----------------------------------------
// "End for all" — only the participant who STARTED the call (room metadata
// started_by) may delete the room; everyone else just leaves client-side.
export async function conferenceEnd(req: Request, env: Env, groupId: string): Promise<Response> {
  if (!configured(env)) return json({ error: "conference backend not configured" }, 503);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const lk = credsFor(env, await roomRegion(env, groupId));
  if (!lk) return json({ error: "conference backend not configured" }, 503);
  const room = roomName(groupId);
  const lr = await lkApi(lk, "ListRooms", { names: [room] });
  if (lr.ok) {
    const data = (await lr.json()) as { rooms?: { name: string; metadata?: string }[] };
    const r = data.rooms?.find((x) => x.name === room);
    if (!r) return json({ error: "no live conference" }, 404);
    try {
      const meta = JSON.parse(r.metadata || "{}");
      if (meta.started_by && meta.started_by !== u.uid) return json({ error: "only the starter can end for all" }, 403);
    } catch { /* unreadable metadata — fall through, allow */ }
  }
  const del = await lkApi(lk, "DeleteRoom", { room });
  if (!del.ok) return json({ error: "could not end conference" }, 502);
  try { await env.TOKENS.delete(regionKvKey(groupId)); } catch { /* non-fatal */ }
  await trackUser(env, u.uid, await emailFor(env, u.uid).catch(() => null), "conf_end", "avatok", {
    group_id: groupId, ...confGeo(req),
  });
  return json({ ok: true });
}

// ---- POST /api/conference/:groupId/beat ----------------------------------------
// Per-plan conf_min DAILY metering for SFU (paid) calls. The client posts one
// beat per elapsed minute; when the starter/joiner's tier conf_min cap is
// exhausted the beat returns 402 and the client leaves with an upgrade prompt.
// Free tier never reaches here — its calls run P2P-mesh, which is unmetered
// (P2P media costs us nothing). Gated by `billingEnabled` (no-op while off).
export async function conferenceBeat(req: Request, env: Env, groupId: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);

  const tier = await tierOf(env, u.uid);
  const g = confGeo(req);
  const email = await emailFor(env, u.uid).catch(() => null);
  let minutes = 1;
  try {
    const b = (await req.json()) as { minutes?: number };
    if (Number.isFinite(b?.minutes)) minutes = Math.max(1, Math.min(10, Math.trunc(b!.minutes!)));
  } catch { /* default 1 */ }

  // conf_min is ALWAYS enforced (NOT gated by billingEnabled): it is the hard cap
  // on our LiveKit SFU spend. Free = 60 min/day, Plus 180, Pro 480, Max unlimited.
  const r = await enforceAllowance(env, u.uid, tier, "conf_min", minutes, { commit: true });
  if (!r.allowed) {
    await trackUser(env, u.uid, email, "conf_limit_reached", "avatok", { tier, cap_min: r.cap, group_id: groupId, ...g });
    return json(planLimitBody(r), 402);
  }
  await trackUser(env, u.uid, email, "conf_minute", "avatok", {
    tier, minutes, used_min: r.used, remaining_min: r.remaining, cap_min: r.cap, group_id: groupId, ...g,
  });
  return json({ ok: true, metered: true, remaining: r.remaining, cap: r.cap });
}

// ---- GET /api/conference/:groupId/status ---------------------------------------
// Lightweight "is there an ongoing call?" for the in-chat PiP banner.
export async function conferenceStatus(req: Request, env: Env, groupId: string): Promise<Response> {
  if (!configured(env)) return json({ live: false, count: 0 });
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const lk = credsFor(env, await roomRegion(env, groupId));
  if (!lk) return json({ live: false, count: 0 });
  const r = await lkApi(lk, "ListParticipants", { room: roomName(groupId) });
  if (!r.ok) return json({ live: false, count: 0 });
  const list = (await r.json()) as { participants?: unknown[] };
  const count = list.participants?.length ?? 0;
  return json({ live: count > 0, count, max: MAX_PARTICIPANTS });
}

// ---- POST /api/conference/webhook ----------------------------------------------
// LiveKit webhooks: Authorization header is a JWT (HS256, our API secret) whose
// payload carries sha256(body). Events → system rows in the group thread +
// joinable (NOT ringing) push to members.
export async function conferenceWebhook(req: Request, env: Env): Promise<Response> {
  if (!configured(env)) return json({ error: "not configured" }, 503);

  const raw = await req.text();
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!(await verifyLkJwt(env, auth, raw))) return json({ error: "bad signature" }, 401);

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  const room: string = ev?.room?.name || "";
  if (!room.startsWith("group:")) return json({ ok: true }); // not ours
  const groupId = room.slice("group:".length);
  const n = Number(ev?.room?.numParticipants ?? ev?.room?.num_participants ?? 0);

  // Server-truth room lifecycle (no user geo here — this is LiveKit→worker). The
  // authoritative participant count + start/finish events feed the dashboard's
  // "live calls / peak participants" tiles and pair with the per-user conf_start/
  // conf_join geo events. starter_tier/provider come from the room metadata.
  let starterTier: number | null = null;
  let provider: string | null = null;
  try {
    const meta = JSON.parse(ev?.room?.metadata || "{}");
    if (typeof meta.starter_tier === "number") starterTier = meta.starter_tier;
    if (typeof meta.provider === "string") provider = meta.provider;
  } catch { /* metadata absent/unreadable */ }
  void track(env, "system", "conf_room_event", "avatok", {
    livekit_event: ev?.event, num_participants: n, group_id: groupId,
    starter_tier: starterTier, provider,
  });

  let body: string | null = null;
  let push = false;
  switch (ev?.event) {
    case "room_started":   body = "Call started"; push = true; break;
    case "room_finished":  body = "Call ended"; break;
    case "participant_joined": body = `Call ongoing — ${Math.max(n, 1)} in call`; break;
    case "participant_left":   body = n > 0 ? `Call ongoing — ${n} in call` : null; break;
    default: return json({ ok: true });
  }
  if (body === null) return json({ ok: true });

  // System rows into every member's InboxDO (registered groups only; ≤25 by
  // rule, so the synchronous parallel fan-out is within the router's cap).
  const mem = await groupMembers(env, groupId);
  const payload = {
    conv: groupId, sender: "system", kind: "conference", body,
    client_id: `conf-${ev.event}-${ev?.id ?? Date.now()}`, created_at: Date.now(),
  };
  await Promise.all(mem.map(async (m) => {
    try {
      const stub = env.INBOX.get(env.INBOX.idFromName(m));
      const res = await stub.fetch("https://inbox/append", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, owner: m }),
      });
      const r = (await res.json()) as { live?: boolean };
      // Joinable push (no ringing modal) when the call starts and they're offline.
      if (push && !r.live) await env.Q_PUSH.send({ kind: "notify", to: m, fromName: "Group call" });
    } catch { /* best-effort per member */ }
  }));

  return json({ ok: true });
}

// Webhooks can arrive from ANY region's LiveKit (each may have its own key/
// secret), so verify against every configured region until one validates.
async function verifyLkJwt(env: Env, jwt: string, body: string): Promise<boolean> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=")));
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[2].length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(body));
    const sha = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (payload.sha256 !== sha) return false;
    for (const lk of Object.values(regionsConfig(env))) {
      if (payload.iss !== lk.key) continue;
      const ok = await crypto.subtle.verify("HMAC", await hmacKey(lk.secret), sig, enc.encode(`${parts[0]}.${parts[1]}`));
      if (ok) return true;
    }
    return false;
  } catch { return false; }
}
