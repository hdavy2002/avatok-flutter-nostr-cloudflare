// [HF-CALLS-1] HF masked paid calls: start/status/cancel, wallet read, admin test credits, host presence, host call list,
// admin call list and the Vobiz webhooks. Contract: Specs/HF-CALLS-CONTRACT.md. Dark behind hfCallsEnabled.
//   POST /api/hf/calls {hostSlug, lane?}              -> {ok, callId, status:"ringing_host", rate, maxMinutes}
//   GET  /api/hf/calls/:id                            -> {id,status,hostSlug,hostName,rate,connectedAt,endedAt,billedMinutes,chargedRupees,endReason,canReview}
//   POST /api/hf/calls/:id/cancel                     (caller, before connect)
//   GET  /api/hf/wallet                               -> {balanceRupees, testCredits:true}
//   GET|PUT /api/hosts/me/presence {online}           -> {ok, presence}      POST /api/hosts/me/presence/beat
//   GET  /api/hosts/me/calls                          -> {ok, calls:[...], today:{calls,minutes,earningRupees}}   (handles only, never numbers)
//   POST /api/admin/hf/wallet/credit {uid, rupees 1..2000, note, opId?}      GET /api/admin/hf/calls?status=&limit=&offset=
//   POST /api/hf/vobiz/<VOBIZ_WEBHOOK_SECRET>/{answer/<host|caller>/<id> | digits/host/<id> | hangup/<host|caller>/<id> | conf/<id>/<host|caller> | notice/host-nopickup/<id>}
// Phone numbers are never present in any response, log or event here; they are read from the verified-WhatsApp store only at dial time (do/hf_call.ts).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, trackException } from "../hooks";
import { isAdminUid } from "../lib/preview";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { notifyHostOnline } from "../lib/hf_notify";
import { walletOp } from "./wallet";
import { readConfig } from "./config";
import {
  HF_CALL_APP, WALLET_APP, callsConfigured, claimHost, releaseHost, hasLaneAccess, isBlockedEitherWay, hfReserve, hfRelease, hfWalletBalance, type HfCallRow,
} from "../lib/hf_calls_store";
import { maxMinutesFor, START_RESERVE_MINUTES, MAX_CALL_MINUTES, hangupXml, callerDidntPickUpXml, callerHandle } from "../lib/hf_call_math";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);
const UNAVAILABLE = () => err(409, "host_unavailable", "This host isn't available right now.");
const NOT_ENABLED = () => err(404, "not_enabled", "Calls are not open yet.");
const REVIEW_WINDOW_MS = 7 * 24 * 3600_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
const callStub = (env: Env, id: string) => env.HF_CALL.get(env.HF_CALL.idFromName(id));
async function callsOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).hfCallsEnabled === true; } catch { return false; }
}
async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden", "Forbidden.");
  return { uid: u.uid };
}
async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/hf", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "admin_audit", action } });
  }
}
const rupees = (paise: number | null | undefined) => Math.round(Number(paise ?? 0)) / 100;

// ── POST /api/hf/calls ───────────────────────────────────────────────────────
async function startCall(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  if (!callsConfigured(env)) return err(503, "calls_not_ready", "Calls aren't ready yet. Please try again later.");
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const uid = u.uid;
  const body = await readJson(req);
  const slug = String(body.hostSlug ?? "").trim().toLowerCase();
  const laneIn = body.lane == null || body.lane === "" ? null : String(body.lane);
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return UNAVAILABLE();
  if (laneIn !== null && laneIn !== "women" && laneIn !== "lgbtq") return err(400, "invalid_lane", "Unknown lane.");

  if (!(await verifiedWhatsAppNumber(env, uid))) return err(403, "not_verified", "Please verify your WhatsApp number first.");
  const limited = await rateLimit(env, `hfcall:${uid}`, 10, 600);
  if (limited) return limited;

  const host = await env.DB_META.prepare("SELECT uid, display_name, price_per_min, women_lane, lgbtq_lane, presence, status FROM hf_hosts WHERE slug=?1")
    .bind(slug).first<{ uid: string; display_name: string | null; price_per_min: number; women_lane: number; lgbtq_lane: number; presence: string | null; status: string }>();
  if (!host || host.status !== "live" || host.uid === uid || host.presence !== "online") return UNAVAILABLE();
  if (await isBlockedEitherWay(env, uid, host.uid)) return UNAVAILABLE();
  if (!(await verifiedWhatsAppNumber(env, host.uid))) return UNAVAILABLE();

  if (host.women_lane === 1 && !(await hasLaneAccess(env, uid, "women"))) return err(403, "lane_required", "This host takes calls from verified women only.", { lane: "women" });
  if (laneIn === "lgbtq") {
    if (host.lgbtq_lane !== 1) return UNAVAILABLE();
    if (!(await hasLaneAccess(env, uid, "lgbtq"))) return err(403, "lane_required", "Please verify to use this lane.", { lane: "lgbtq" });
  }
  const lane = laneIn ?? (host.women_lane === 1 ? "women" : null);

  const open = await env.DB_META.prepare(
    "SELECT 1 AS x FROM hf_calls WHERE caller_uid=?1 AND status IN ('ringing_host','ringing_caller','connected') AND created_at>?2 LIMIT 1",
  ).bind(uid, Date.now() - 4 * 3600_000).first();
  if (open) return err(409, "call_in_progress", "You already have a call in progress.");

  const rate = Math.trunc(Number(host.price_per_min));
  if (!(rate > 0)) return UNAVAILABLE();
  const callId = crypto.randomUUID();
  const needed = rate * START_RESERVE_MINUTES;

  const rsv = await hfReserve(env, uid, needed, callId, "reserve");
  if (!rsv.ok) {
    if (rsv.status === 402) return err(402, "low_balance", `You need at least ₹${needed} for this call.`, { needed, balance: rsv.available });
    return err(502, "wallet_error", "We couldn't check your balance. Please try again.");
  }
  const fundsRupees = rsv.available + needed;
  const maxMinutes = maxMinutesFor(fundsRupees, rate);
  const limitReason = Math.floor(fundsRupees / rate) < MAX_CALL_MINUTES ? "balance" : "time_limit";

  if (!(await claimHost(env, host.uid))) {
    await hfRelease(env, uid, callId).catch(() => false);
    return UNAVAILABLE();
  }
  const undo = async () => { await releaseHost(env, host.uid).catch(() => undefined); await hfRelease(env, uid, callId).catch(() => false); };
  try {
    await env.DB_META.prepare(
      "INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, lane, created_at, conference_name) VALUES (?1,?2,?3,?4,'ringing_host',?5,?6,?7)",
    ).bind(callId, uid, host.uid, rate * 100, lane, Date.now(), `hf_${callId.replace(/-/g, "")}`).run();
  } catch (e) {
    await undo();
    await trackException(env, e, { uid, route: "/api/hf/calls", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "insert" } });
    return err(500, "internal_error", "Something went wrong.");
  }
  try {
    const r = await callStub(env, callId).fetch("https://hfcall/init", {
      method: "POST",
      body: JSON.stringify({ callId, callerUid: uid, hostUid: host.uid, rateRupees: rate, reservedRupees: needed, fundsRupees, maxMinutes, limitReason }),
    });
    if (!r.ok) return err(502, "call_failed", "We couldn't place the call. Please try again.");
  } catch (e) {
    await env.DB_META.prepare("UPDATE hf_calls SET status='failed', end_reason='error', ended_at=?1 WHERE id=?2 AND status='ringing_host'").bind(Date.now(), callId).run().catch(() => undefined);
    await undo();
    await trackException(env, e, { uid, route: "/api/hf/calls", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "init" } });
    return err(502, "call_failed", "We couldn't place the call. Please try again.");
  }
  void track(env, uid, "hf_call_started", HF_CALL_APP, { area: "hf_call", call_id: callId, rate_rupees: rate, lane, max_minutes: maxMinutes }).catch(() => undefined);
  return json({ ok: true, callId, status: "ringing_host", rate, maxMinutes });
}

// ── GET /api/hf/calls/:id ────────────────────────────────────────────────────
async function getCall(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const c = await env.DB_META.prepare("SELECT * FROM hf_calls WHERE id=?1").bind(id).first<HfCallRow>();
  if (!c || (c.caller_uid !== u.uid && c.host_uid !== u.uid)) return err(404, "not_found", "Call not found.");
  const h = await env.DB_META.prepare("SELECT slug, display_name FROM hf_hosts WHERE uid=?1").bind(c.host_uid).first<{ slug: string | null; display_name: string | null }>().catch(() => null);
  let canReview = false;
  if (c.caller_uid === u.uid && c.status === "completed" && Number(c.billed_minutes) >= 1 && Date.now() - Number(c.ended_at ?? c.created_at) < REVIEW_WINDOW_MS) {
    const rv = await env.DB_META.prepare("SELECT 1 AS x FROM hf_reviews WHERE call_id=?1").bind(id).first().catch(() => null);
    canReview = !rv;
  }
  return json({
    id: c.id, status: c.status, hostSlug: h?.slug ?? null, hostName: h?.display_name ?? null, rate: rupees(c.rate_paise),
    connectedAt: c.connected_at, endedAt: c.ended_at, billedMinutes: c.billed_minutes, chargedRupees: rupees(c.charged_paise), endReason: c.end_reason, canReview,
  }, 200, { "cache-control": "private, no-store" });
}

async function cancelCall(req: Request, env: Env, id: string): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const c = await env.DB_META.prepare("SELECT caller_uid, status FROM hf_calls WHERE id=?1").bind(id).first<{ caller_uid: string; status: string }>();
  if (!c || c.caller_uid !== u.uid) return err(404, "not_found", "Call not found.");
  if (c.status === "connected") return err(409, "already_connected", "The call is already connected.");
  if (c.status !== "ringing_host" && c.status !== "ringing_caller") return json({ ok: true, status: c.status });
  const r = await callStub(env, id).fetch("https://hfcall/cancel", { method: "POST", body: "{}" });
  const out = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string };
  if (r.status === 409) return err(409, "already_connected", "The call is already connected.");
  return json({ ok: true, status: out.status ?? "failed" });
}

async function walletGet(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  return json({ balanceRupees: await hfWalletBalance(env, u.uid), testCredits: true }, 200, { "cache-control": "private, no-store" });
}

// ── host presence ────────────────────────────────────────────────────────────
async function presenceRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const host = await env.DB_META.prepare("SELECT uid, status, presence FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ uid: string; status: string; presence: string | null }>();
  if (!host || host.status !== "live") return err(409, "not_live", "Your profile isn't live yet.");
  const now = Date.now();
  if (req.method === "GET") return json({ ok: true, presence: host.presence ?? "offline" }, 200, { "cache-control": "private, no-store" });
  if (p.endsWith("/beat")) {
    await env.DB_META.prepare("UPDATE hf_hosts SET presence_at=?1 WHERE uid=?2 AND presence IN ('online','busy')").bind(now, u.uid).run();
    return json({ ok: true, presence: host.presence ?? "offline" });
  }
  const body = await readJson(req);
  if (typeof body.online !== "boolean") return err(400, "invalid_field", "online must be true or false.");
  if (body.online) {
    if (!(await verifiedWhatsAppNumber(env, u.uid))) return err(403, "not_verified", "Verify your WhatsApp number to take calls.");
    await env.DB_META.prepare("UPDATE hf_hosts SET presence=CASE WHEN presence='busy' THEN 'busy' ELSE 'online' END, presence_at=?1 WHERE uid=?2").bind(now, u.uid).run();
  } else {
    await env.DB_META.prepare("UPDATE hf_hosts SET presence='offline', presence_at=?1 WHERE uid=?2").bind(now, u.uid).run();
  }
  const after = (await env.DB_META.prepare("SELECT presence FROM hf_hosts WHERE uid=?1").bind(u.uid).first<{ presence: string }>())?.presence ?? "offline";
  if (body.online && (host.presence ?? "offline") === "offline" && after === "online") {
    const work = notifyHostOnline(env, ctx, u.uid).catch(() => undefined);
    if (ctx) ctx.waitUntil(work); else await work;
  }
  void track(env, u.uid, "hf_host_presence", HF_CALL_APP, { area: "hf_call", presence: after }).catch(() => undefined);
  return json({ ok: true, presence: after });
}

// ── host dashboard calls (handles only) ──────────────────────────────────────
async function hostCalls(req: Request, env: Env): Promise<Response> {
  if (!(await callsOn(env))) return NOT_ENABLED();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const rows = (await env.DB_META.prepare(
    `SELECT c.id, c.status, c.created_at, c.connected_at, c.ended_at, c.billed_minutes, c.host_earning_paise, c.end_reason,
            (SELECT display_name FROM users x WHERE x.uid=c.caller_uid) AS caller_name
       FROM hf_calls c WHERE c.host_uid=?1 ORDER BY c.created_at DESC LIMIT 50`,
  ).bind(u.uid).all<{ id: string; status: string; created_at: number; connected_at: number | null; ended_at: number | null; billed_minutes: number; host_earning_paise: number; end_reason: string | null; caller_name: string | null }>()).results ?? [];
  // "Today" = the host's IST day.
  const istStart = Math.floor((Date.now() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000;
  const t = await env.DB_META.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(billed_minutes),0) AS m, COALESCE(SUM(host_earning_paise),0) AS e FROM hf_calls WHERE host_uid=?1 AND status='completed' AND billed_minutes>=1 AND created_at>=?2",
  ).bind(u.uid, istStart).first<{ n: number; m: number; e: number }>();
  return json({
    ok: true,
    calls: rows.map((r) => ({
      id: r.id, status: r.status, callerHandle: callerHandle(r.caller_name), createdAt: r.created_at, connectedAt: r.connected_at, endedAt: r.ended_at,
      billedMinutes: r.billed_minutes, earningRupees: rupees(r.host_earning_paise), endReason: r.end_reason,
    })),
    today: { calls: Number(t?.n ?? 0), minutes: Number(t?.m ?? 0), earningRupees: rupees(t?.e) },
  }, 200, { "cache-control": "private, no-store" });
}

// ── admin ────────────────────────────────────────────────────────────────────
async function adminCredit(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const b = await readJson(req);
  const uid = String(b.uid ?? "").trim();
  const amount = Number(b.rupees);
  const note = String(b.note ?? "").trim().slice(0, 200);
  if (!uid || uid.length > 128) return err(400, "invalid_field", "uid is required.", { field: "uid" });
  if (!Number.isInteger(amount) || amount < 1 || amount > 2000) return err(400, "invalid_field", "rupees must be a whole number from 1 to 2000.", { field: "rupees" });
  if (!note) return err(400, "invalid_field", "Add a note saying why.", { field: "note" });
  const exists = await env.DB_META.prepare("SELECT 1 AS x FROM users WHERE uid=?1").bind(uid).first().catch(() => null);
  if (!exists) return err(404, "not_found", "No such user.");
  const opKey = String(b.opId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || crypto.randomUUID();
  const r = await walletOp(env, uid, { op: "credit", uid, amount, type: "hf_test_credit", app_name: WALLET_APP, ref: `hftest:${a.uid}`, op_id: `hftest:${opKey}`, context: `Test credits: ${note}`.slice(0, 120) });
  if (r.status !== 200 || r.body?.ok !== true) return err(502, "wallet_error", "The credit didn't go through.");
  await audit(env, a.uid, "wallet_test_credit", uid, { rupees: amount, note, op: opKey });
  void track(env, a.uid, "hf_test_credit_added", HF_CALL_APP, { area: "hf_call", rupees: amount }).catch(() => undefined);
  return json({ ok: true, balanceRupees: Math.max(0, Math.trunc(Number(r.body?.balance ?? 0))) });
}

async function adminCalls(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 50)) || 50));
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)) || 0);
  const status = url.searchParams.get("status");
  const where = status && /^[a-z_]{3,20}$/.test(status) ? "WHERE c.status=?3" : "";
  const stmt = env.DB_META.prepare(
    `SELECT c.*, h.slug AS host_slug, h.display_name AS host_name, (SELECT display_name FROM users x WHERE x.uid=c.caller_uid) AS caller_name
       FROM hf_calls c LEFT JOIN hf_hosts h ON h.uid=c.host_uid ${where} ORDER BY c.created_at DESC LIMIT ?1 OFFSET ?2`,
  );
  const rows = (await (where ? stmt.bind(limit, offset, status) : stmt.bind(limit, offset)).all<HfCallRow & { host_slug: string | null; host_name: string | null; caller_name: string | null }>()).results ?? [];
  return json({
    ok: true,
    items: rows.map((c) => ({
      id: c.id, status: c.status, lane: c.lane, callerUid: c.caller_uid, callerName: c.caller_name, hostUid: c.host_uid, hostName: c.host_name, hostSlug: c.host_slug,
      rate: rupees(c.rate_paise), createdAt: c.created_at, connectedAt: c.connected_at, endedAt: c.ended_at, billedMinutes: c.billed_minutes,
      chargedRupees: rupees(c.charged_paise), hostEarningRupees: rupees(c.host_earning_paise), endReason: c.end_reason,
    })),
  }, 200, { "cache-control": "private, no-store" });
}

// ── Vobiz webhooks ───────────────────────────────────────────────────────────
const xml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml" } });
async function parseForm(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try { for (const [k, v] of new URLSearchParams(await req.text()).entries()) out[k] = v; } catch { /* empty fields */ }
  return out;
}

async function vobizWebhook(req: Request, env: Env, p: string): Promise<Response> {
  const parts = p.slice("/api/hf/vobiz/".length).split("/").filter(Boolean).map((x) => decodeURIComponent(x));
  const [secret, kind, a, b] = parts;
  const expected = env.VOBIZ_WEBHOOK_SECRET || "";
  if (!expected || secret !== expected) return xml(hangupXml(), 403);
  if (req.method !== "POST" && req.method !== "GET") return xml(hangupXml(), 405);
  const forward = async (op: string, id: string, role?: "host" | "caller"): Promise<Response> => {
    if (!ID_RE.test(id)) return xml(hangupXml());
    const fields = req.method === "POST" ? await parseForm(req) : Object.fromEntries(new URL(req.url).searchParams.entries());
    try {
      return await callStub(env, id).fetch(`https://hfcall/${op}`, { method: "POST", body: JSON.stringify({ role, fields }) });
    } catch (e) {
      await trackException(env, e, { route: `/api/hf/vobiz/${kind}`, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls", step: "forward", op } });
      return xml(op.includes("answer") || op === "host-digits" ? hangupXml("Sorry, something went wrong. Goodbye.") : "<?xml version=\"1.0\"?><Response></Response>");
    }
  };
  const role = (x: string | undefined): "host" | "caller" | null => (x === "host" || x === "caller" ? x : null);
  if (kind === "answer" && role(a)) return forward(a === "host" ? "host-answer" : "caller-answer", b ?? "", role(a)!);
  if (kind === "digits" && a === "host") return forward("host-digits", b ?? "", "host");
  if (kind === "hangup" && role(a)) return forward("hangup", b ?? "", role(a)!);
  if (kind === "conf" && role(b)) return forward("conf", a ?? "", role(b)!);
  if (kind === "notice" && a === "host-nopickup") return xml(callerDidntPickUpXml());
  return xml(hangupXml(), 404);
}

// ── router ───────────────────────────────────────────────────────────────────
/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfCallsRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = req.method;
  try {
    if (p.startsWith("/api/hf/vobiz/")) return await vobizWebhook(req, env, p);
    if (p === "/api/hf/calls" && m === "POST") return await startCall(req, env);
    const one = p.match(/^\/api\/hf\/calls\/([A-Za-z0-9_-]{8,64})$/);
    if (one && m === "GET") return await getCall(req, env, one[1]);
    const cancel = p.match(/^\/api\/hf\/calls\/([A-Za-z0-9_-]{8,64})\/cancel$/);
    if (cancel && m === "POST") return await cancelCall(req, env, cancel[1]);
    if (p === "/api/hf/wallet" && m === "GET") return await walletGet(req, env);
    if (p === "/api/hosts/me/presence" && (m === "PUT" || m === "GET")) return await presenceRoute(req, env, p, ctx);
    if (p === "/api/hosts/me/presence/beat" && m === "POST") return await presenceRoute(req, env, p, ctx);
    if (p === "/api/hosts/me/calls" && m === "GET") return await hostCalls(req, env);
    if (p === "/api/admin/hf/wallet/credit" && m === "POST") return await adminCredit(req, env);
    if (p === "/api/admin/hf/calls" && m === "GET") return await adminCalls(req, env);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls" } });
    if (p.startsWith("/api/hf/vobiz/")) return xml(hangupXml("Sorry, something went wrong. Goodbye."));
    return err(500, "internal_error", "Something went wrong.");
  }
}
