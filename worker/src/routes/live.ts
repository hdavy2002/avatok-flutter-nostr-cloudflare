// AvaLive delivery (Phase 7). Cloudflare Stream Live: the creator publishes via
// WHIP from the phone; paid viewers play the WHEP/LL-HLS URL. The interaction
// room (reactions / flying messages / stickers / donations / moderation) is the
// session's StreamSessionDO (`live:<listingId>`), reached over one WS.
//
//   POST /api/live/:listingId/start    creator → create Live Input, go live
//   POST /api/live/:listingId/stop     creator → end stream, settlement pending
//   GET  /api/live/:listingId/join     paid order (or creator) → play URL + room token
//   GET  /api/live/:listingId/room     WS → session DO (signed token in ?token=)
//   POST /api/live/:listingId/donate   {amount} → instant wallet transfer + banner
//   POST /api/live/:listingId/mod      creator → mute/ban/slow/pin (A1)
//   GET  /api/live/:listingId/state    HUD/polling fallback
//
// Access control: join tokens are issued ONLY to users holding a paid (or free)
// order for the listing — and never to users the creator has blocked (A5).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { rateLimit, RL } from "../money";
import { donation } from "../ledger";
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";

const APP = "avalive";
const PRE_LIVE_MS = 15 * 60_000;   // creator can go live 15 min early

// ---------------------------------------------------------------------------
// Session tokens — HMAC over {sid, uid, role, order, exp} (JOIN_LINK_SECRET).
// Stateless: a rejoin after an app crash gets a new token for the SAME identity
// (A3) — the DO merges attendance gaps < 90 s.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export interface SessionTokenPayload { sid: string; uid: string; role: "host" | "viewer" | "attendee"; order: string | null; name: string; exp: number }

export async function signSessionToken(env: Env, p: SessionTokenPayload): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(p)));
  return `${body}.${b64u(await hmac(env.JOIN_LINK_SECRET || "dev-join-secret", body))}`;
}

export async function verifySessionToken(env: Env, token: string): Promise<SessionTokenPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (b64u(await hmac(env.JOIN_LINK_SECRET || "dev-join-secret", body)) !== sig) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64u(body))) as SessionTokenPayload;
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------

export function sessionStub(env: Env, key: string) {
  return env.STREAM_SESSION_DO.get(env.STREAM_SESSION_DO.idFromName(key));
}
export async function sessionOp(env: Env, key: string, op: object): Promise<any> {
  const r = await sessionStub(env, key).fetch("https://session/op", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op),
  });
  return r.json().catch(() => ({}));
}

async function displayName(env: Env, uid: string): Promise<string> {
  try {
    const r = await metaDb(env).prepare("SELECT name, handle FROM profiles WHERE npub=?1 OR clerk_user_id=?1").bind(uid).first<any>();
    return r?.name || r?.handle || "Someone";
  } catch { return "Someone"; }
}

/** Creator block list (A5): creator→buyer row in `blocks` refuses tokens/booking. */
export async function creatorBlocked(env: Env, creatorId: string, uid: string): Promise<boolean> {
  try {
    const r = await metaDb(env).prepare("SELECT 1 FROM blocks WHERE uid=?1 AND blocked_npub=?2").bind(creatorId, uid).first();
    return !!r;
  } catch { return false; }
}

async function loadListing(env: Env, id: string): Promise<any | null> {
  return metaDb(env).prepare("SELECT id, creator_id, kind, title, price, starts_at, duration_min, status FROM listings WHERE id=?1").bind(id).first<any>();
}

// ---------------------------------------------------------------------------
// POST /api/live/:listingId/start — creator creates the Live Input + goes live.
// ---------------------------------------------------------------------------
export async function liveStart(req: Request, env: Env): Promise<Response> {
  const id = sidOf(req); if (!id) return json({ error: "bad listing id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const l = await loadListing(env, id);
  if (!l || l.kind !== "live_event") return json({ error: "listing not found" }, 404);
  if (l.creator_id !== ctx.uid) return json({ error: "not your event" }, 403);
  if (!["published", "live"].includes(l.status)) return json({ error: "event not bookable/startable", status: l.status }, 409);
  const startsAt = Number(l.starts_at);
  if (Date.now() < startsAt - PRE_LIVE_MS) return json({ error: "too early", starts_at: startsAt }, 409);
  if (!env.STREAM_ACCOUNT_ID || !env.STREAM_API_TOKEN) return json({ error: "streaming unavailable", reason: "STREAM_ACCOUNT_ID/STREAM_API_TOKEN unset" }, 503);

  const db = metaDb(env);
  const endsAt = startsAt + Number(l.duration_min ?? 60) * 60_000;
  const existing = await db.prepare("SELECT live_input, whip_url, whep_url, state FROM live_sessions WHERE listing_id=?1").bind(id).first<any>();

  let whip = existing?.whip_url as string | undefined;
  let whep = existing?.whep_url as string | undefined;
  let inputId = existing?.live_input as string | undefined;
  if (!inputId) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream/live_inputs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        meta: { name: `avalive:${id}`, creator: ctx.uid, listing: id },
        recording: { mode: "automatic", timeoutSeconds: 30 },
      }),
    });
    const j = (await r.json()) as any;
    if (!r.ok || !j?.result?.uid) return json({ error: "stream live_input create failed", detail: j?.errors ?? j }, 502);
    inputId = String(j.result.uid);
    whip = j.result.webRTC?.url ?? null;
    whep = j.result.webRTCPlayback?.url ?? null;
    await db.prepare(
      `INSERT INTO live_sessions (listing_id, live_input, whip_url, whep_url, state, created_at, updated_at)
       VALUES (?1,?2,?3,?4,'scheduled',?5,?5)
       ON CONFLICT(listing_id) DO UPDATE SET live_input=?2, whip_url=?3, whep_url=?4, updated_at=?5`,
    ).bind(id, inputId, whip, whep, Date.now()).run();
  }

  // Mark live + arm the session DO (alarms at start+wait and end+grace).
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE listings SET status='live', updated_at=?2 WHERE id=?1").bind(id, now),
    db.prepare("UPDATE live_sessions SET state='live', started_at=COALESCE(started_at,?2), last_disconnect_at=NULL, updated_at=?2 WHERE listing_id=?1").bind(id, now),
  ]);
  await sessionOp(env, `live:${id}`, { op: "init", creator_npub: ctx.uid });
  await sessionOp(env, `live:${id}`, { op: "schedule", sid: id, kind: "live_event", starts_at: startsAt, ends_at: endsAt, host_id: ctx.uid });
  await sessionOp(env, `live:${id}`, { op: "host-live", live: true });

  const token = await signSessionToken(env, { sid: id, uid: ctx.uid, role: "host", order: null, name: await displayName(env, ctx.uid), exp: endsAt + 6 * 3_600_000 });
  track(env, ctx.uid, "live_started", APP, { listing: id });
  brainFact(env, ctx.uid, "went_live", APP, { title: l.title });
  return json({ ok: true, whip, whep, room_token: token, starts_at: startsAt, ends_at: endsAt });
}

// ---------------------------------------------------------------------------
// POST /api/live/:listingId/stop — creator ends the stream (settlement at
// end-of-window alarm, or immediately when past 50% of the slot).
// ---------------------------------------------------------------------------
export async function liveStop(req: Request, env: Env): Promise<Response> {
  const id = sidOf(req); if (!id) return json({ error: "bad listing id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const l = await loadListing(env, id);
  if (!l) return json({ error: "listing not found" }, 404);
  if (l.creator_id !== ctx.uid) return json({ error: "not your event" }, 403);
  const now = Date.now();
  await metaDb(env).prepare(
    "UPDATE live_sessions SET state='ended', ended_at=COALESCE(ended_at,?2), updated_at=?2 WHERE listing_id=?1",
  ).bind(id, now).run();
  await sessionOp(env, `live:${id}`, { op: "host-live", live: false });
  // Settle now rather than waiting for the end-of-slot alarm.
  await env.Q_MONEY.send({ type: "evaluate", sid: id, kind: "live_event", phase: "end" });
  track(env, ctx.uid, "live_stopped", APP, { listing: id });
  return json({ ok: true, state: "settlement_pending" });
}

// ---------------------------------------------------------------------------
// GET /api/live/:listingId/join — entitlement check → play URL + room token.
// ---------------------------------------------------------------------------
export async function liveJoin(req: Request, env: Env): Promise<Response> {
  const id = sidOf(req); if (!id) return json({ error: "bad listing id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const l = await loadListing(env, id);
  if (!l || l.kind !== "live_event") return json({ error: "listing not found" }, 404);

  const isHost = l.creator_id === ctx.uid;
  let orderId: string | null = null;
  if (!isHost) {
    if (await creatorBlocked(env, l.creator_id, ctx.uid)) return json({ error: "not available" }, 403);
    const o = await metaDb(env).prepare(
      "SELECT id, status FROM orders WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('held','free') ORDER BY created_at DESC LIMIT 1",
    ).bind(id, ctx.uid).first<any>();
    if (!o) return json({ error: "no paid order for this event" }, 403);   // acceptance: non-payer refused
    orderId = String(o.id);
  }
  // Banned viewers keep the entitlement but not the room (A1 — refund is an admin decision).
  const ban = await sessionOp(env, `live:${id}`, { op: "is-banned", uid: ctx.uid });
  if (!isHost && ban?.banned) return json({ error: "removed from this stream" }, 403);

  const ls = await metaDb(env).prepare("SELECT whep_url, hls_url, state, started_at FROM live_sessions WHERE listing_id=?1").bind(id).first<any>();
  const startsAt = Number(l.starts_at);
  const endsAt = startsAt + Number(l.duration_min ?? 60) * 60_000;
  const token = await signSessionToken(env, {
    sid: id, uid: ctx.uid, role: isHost ? "host" : "viewer", order: orderId,
    name: await displayName(env, ctx.uid), exp: endsAt + 2 * 3_600_000,
  });
  track(env, ctx.uid, isHost ? "live_host_join" : "live_view_join", APP, { listing: id });
  return json({
    ok: true, whep: ls?.whep_url ?? null, hls: ls?.hls_url ?? null,
    state: ls?.state ?? "scheduled", live: ls?.state === "live",
    starts_at: startsAt, ends_at: endsAt, title: l.title,
    creator_id: l.creator_id, room_token: token,
  });
}

// ---------------------------------------------------------------------------
// GET /api/live/:listingId/room — WS into the session DO (?token=).
// ---------------------------------------------------------------------------
export async function liveRoom(req: Request, env: Env): Promise<Response> {
  const id = sidOf(req); if (!id) return json({ error: "bad listing id" }, 400);
  if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
  const token = new URL(req.url).searchParams.get("token") || "";
  const p = await verifySessionToken(env, token);
  if (!p || p.sid !== id) return json({ error: "bad token" }, 403);
  const h = new Headers(req.headers);
  h.set("x-session-uid", p.uid);
  h.set("x-session-role", p.role);
  h.set("x-session-name", p.name);
  if (p.order) h.set("x-session-order", p.order);
  return sessionStub(env, `live:${id}`).fetch(new Request(req.url, { method: "GET", headers: h }));
}

// ---------------------------------------------------------------------------
// POST /api/live/:listingId/donate {amount} — instant transfer + on-stream banner.
// ---------------------------------------------------------------------------
export async function liveDonate(req: Request, env: Env): Promise<Response> {
  const id = sidOf(req); if (!id) return json({ error: "bad listing id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const limited = await rateLimit(env, `donate:${ctx.uid}`, RL.donation.max, RL.donation.windowSec);
  if (limited) return limited;
  const b = (await req.json().catch(() => ({}))) as any;
  const amount = Math.trunc(Number(b.amount));
  if (!(amount > 0 && amount <= 100_000)) return json({ error: "amount must be 1..100000 coins" }, 400);
  const l = await loadListing(env, id);
  if (!l) return json({ error: "listing not found" }, 404);
  if (l.creator_id === ctx.uid) return json({ error: "cannot donate to yourself" }, 400);

  const donationId = crypto.randomUUID();
  const r = await donation(env, ctx.uid, l.creator_id, amount, donationId, { title: `Donation — ${l.title}` });
  if (!r.ok) {
    if (r.status === 402) return json({ error: "insufficient_funds", needed: amount, ...r.body }, 402);
    return json(r.body, r.status);
  }
  const name = await displayName(env, ctx.uid);
  await sessionOp(env, `live:${id}`, { op: "donation", name, amount, net: r.net });
  try { await notifyUser(env, l.creator_id, { type: "wallet", title: `${name} donated ${amount} AvaCoins`, body: l.title, data: { deeplink: "/wallet", amount: r.net } }); } catch { /* best-effort */ }
  brainFact(env, ctx.uid, "donated", APP, { title: l.title, amount });
  track(env, ctx.uid, "live_donation", APP, { amount, listing: id });
  metric(env, "live_donation", [amount, r.fee]);
  return json({ ok: true, gross: amount, net: r.net, fee: r.fee, balance: r.body?.buyer_balance });
}

// ---------------------------------------------------------------------------
// POST /api/live/:listingId/mod — creator moderation (A1).
// ---------------------------------------------------------------------------
export async function liveMod(req: Request, env: Env): Promise<Response> {
  const id = sidOf(req); if (!id) return json({ error: "bad listing id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const l = await loadListing(env, id);
  if (!l) return json({ error: "listing not found" }, 404);
  if (l.creator_id !== ctx.uid) return json({ error: "host only" }, 403);
  const b = (await req.json().catch(() => ({}))) as any;
  const r = await sessionOp(env, `live:${id}`, { op: "mod", action: b.action, target: b.target, sec: b.sec, text: b.text });
  // Bans feed the pattern-review pipeline (A1).
  if (b.action === "ban" && b.target) {
    try {
      await metaDb(env).prepare(
        "INSERT INTO user_reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES (?1,?2,'live_ban',?3,?4,'open',?5)",
      ).bind(crypto.randomUUID(), ctx.uid, String(b.target), `banned from live ${id}`, Date.now()).run();
    } catch { /* table shape best-effort */ }
  }
  track(env, ctx.uid, "live_mod_action", APP, { action: b.action });
  return json(r);
}

// GET /api/live/:listingId/state — polling fallback for the HUD.
export async function liveState(req: Request, env: Env): Promise<Response> {
  const id = sidOf(req); if (!id) return json({ error: "bad listing id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const s = await sessionOp(env, `live:${id}`, { op: "state" });
  // Earnings-so-far for the creator HUD: ticket revenue + donations.
  if (s?.host_id === ctx.uid || s?.creator_npub === ctx.uid) {
    const o = await metaDb(env).prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS gross FROM orders WHERE listing_id=?1 AND status IN ('held','free','settled')",
    ).bind(id).first<any>();
    (s as any).orders = { joined: Number(o?.n ?? 0), gross: Number(o?.gross ?? 0), projected: Math.round(Number(o?.gross ?? 0) * 0.8) };
  }
  return json(s);
}

function sidOf(req: Request): string | null {
  const m = new URL(req.url).pathname.match(/^\/api\/live\/([A-Za-z0-9-]{1,64})\//);
  return m ? m[1] : null;
}
