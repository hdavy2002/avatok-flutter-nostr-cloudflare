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
// Config (secrets): LIVEKIT_URL (wss://… or https://…), LIVEKIT_API_KEY,
// LIVEKIT_API_SECRET. Unset ⇒ 503 (flag-gated like every other integration).
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { PLANS, tierOf } from "./plans";
import { enforceAllowance, planLimitBody } from "../lib/usage";
import { readConfig } from "./config";

// Absolute backstop — no tier may ever exceed this on the SFU. Per-call caps are
// the STARTER's plan `confParticipants` (Plus 10 / Pro 25 / Max 25). Free (tier 0)
// does NOT use the SFU at all — those group calls run P2P-mesh (≤5) client-side,
// so issue() rejects tier 0 with `mode:"mesh"` and the client routes accordingly.
const MAX_PARTICIPANTS = 25;
const TOKEN_TTL_S = 6 * 3600; // long enough for any realistic call

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

/** Mint a LiveKit access token (JWT HS256). */
async function lkToken(env: Env, claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: env.LIVEKIT_API_KEY, nbf: now - 10, exp: now + TOKEN_TTL_S, ...claims };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.LIVEKIT_API_SECRET!), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

/** Twirp call against the LiveKit RoomService. */
async function lkApi(env: Env, method: string, body: Record<string, unknown>): Promise<Response> {
  const host = env.LIVEKIT_URL!.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
  const admin = await lkToken(env, { video: { roomCreate: true, roomList: true, roomAdmin: true } });
  return fetch(`${host}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify(body),
  });
}

function roomName(groupId: string): string { return `group:${groupId}`; }

function configured(env: Env): boolean {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

async function conferenceEnabled(env: Env): Promise<boolean> {
  try {
    const cfg = (await env.TOKENS.get("platform_config", "json")) as { conferenceEnabled?: boolean } | null;
    return cfg?.conferenceEnabled !== false; // default ON (matches routes/config.ts DEFAULTS)
  } catch { return true; }
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

  // Plan gate. Free (tier 0) gets P2P-mesh group calls (≤5), NOT the SFU — tell
  // the client to route to mesh. Paid tiers get the SFU capped by their plan.
  const tier = await tierOf(env, u.uid);
  if (tier === 0) {
    return json({ error: "Free plan group calls are peer-to-peer", mode: "mesh", maxMesh: 5 }, 403);
  }
  const cap = Math.min(PLANS[tier].confParticipants, MAX_PARTICIPANTS); // 10 / 25 / 25

  // Membership + per-plan size cap (hard product rule). Legacy local groups have
  // no D1 rows — fall back to authenticated access (see header comment).
  const mem = await groupMembers(env, groupId);
  if (mem.length > 0) {
    if (!mem.includes(u.uid)) return json({ error: "not a member" }, 403);
    if (mem.length > cap) {
      return json({ error: `your plan allows up to ${cap} on a group call — upgrade for more`, cap, tier }, 403);
    }
  }

  const room = roomName(groupId);
  let kind = "video";
  try { const b = (await req.json()) as { kind?: string }; if (b?.kind === "audio") kind = "audio"; } catch { /* optional body */ }

  if (create) {
    // Idempotent: CreateRoom on an existing name returns the room. The per-plan
    // `cap` here is THE backstop — a racing (cap+1)th joiner is refused by
    // LiveKit itself even if two workers issued tokens.
    const r = await lkApi(env, "CreateRoom", {
      name: room, max_participants: cap, empty_timeout: 120, departure_timeout: 30,
      metadata: JSON.stringify({ groupId, kind, started_by: u.uid, starter_tier: tier }),
    });
    if (!r.ok) return json({ error: "could not create conference room", detail: await r.text() }, 502);
  } else {
    // join: the room must be live (started by someone). ListParticipants 404s/
    // errors when the room doesn't exist.
    const r = await lkApi(env, "ListParticipants", { room });
    if (!r.ok) return json({ error: "no live conference for this group" }, 404);
    const list = (await r.json()) as { participants?: unknown[] };
    if ((list.participants?.length ?? 0) >= cap) return json({ error: `conference is full (${cap})` }, 409);
  }

  const token = await lkToken(env, {
    sub: u.uid,
    jti: u.uid,
    name: await displayName(env, u.uid),
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  });

  const url = env.LIVEKIT_URL!.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return json({ url, token, room, kind, max: cap, tier });
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
  const room = roomName(groupId);
  const lr = await lkApi(env, "ListRooms", { names: [room] });
  if (lr.ok) {
    const data = (await lr.json()) as { rooms?: { name: string; metadata?: string }[] };
    const r = data.rooms?.find((x) => x.name === room);
    if (!r) return json({ error: "no live conference" }, 404);
    try {
      const meta = JSON.parse(r.metadata || "{}");
      if (meta.started_by && meta.started_by !== u.uid) return json({ error: "only the starter can end for all" }, 403);
    } catch { /* unreadable metadata — fall through, allow */ }
  }
  const del = await lkApi(env, "DeleteRoom", { room });
  if (!del.ok) return json({ error: "could not end conference" }, 502);
  return json({ ok: true });
}

// ---- POST /api/conference/:groupId/beat ----------------------------------------
// Per-plan conf_min DAILY metering for SFU (paid) calls. The client posts one
// beat per elapsed minute; when the starter/joiner's tier conf_min cap is
// exhausted the beat returns 402 and the client leaves with an upgrade prompt.
// Free tier never reaches here — its calls run P2P-mesh, which is unmetered
// (P2P media costs us nothing). Gated by `billingEnabled` (no-op while off).
export async function conferenceBeat(req: Request, env: Env, _groupId: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);

  let billing = true;
  try { billing = !!(await readConfig(env)).billingEnabled; } catch { billing = false; }
  if (!billing) return json({ ok: true, metered: false });

  const tier = await tierOf(env, u.uid);
  let minutes = 1;
  try {
    const b = (await req.json()) as { minutes?: number };
    if (Number.isFinite(b?.minutes)) minutes = Math.max(1, Math.min(10, Math.trunc(b!.minutes!)));
  } catch { /* default 1 */ }

  const r = await enforceAllowance(env, u.uid, tier, "conf_min", minutes, { commit: true });
  if (!r.allowed) return json(planLimitBody(r), 402);
  return json({ ok: true, metered: true, remaining: r.remaining, cap: r.cap });
}

// ---- GET /api/conference/:groupId/status ---------------------------------------
// Lightweight "is there an ongoing call?" for the in-chat PiP banner.
export async function conferenceStatus(req: Request, env: Env, groupId: string): Promise<Response> {
  if (!configured(env)) return json({ live: false, count: 0 });
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const r = await lkApi(env, "ListParticipants", { room: roomName(groupId) });
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

async function verifyLkJwt(env: Env, jwt: string, body: string): Promise<boolean> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    const key = await hmacKey(env.LIVEKIT_API_SECRET!);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[2].length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=")));
    if (payload.iss !== env.LIVEKIT_API_KEY) return false;
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(body));
    const sha = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return payload.sha256 === sha;
  } catch { return false; }
}
