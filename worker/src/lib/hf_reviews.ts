// [HF-CALLS-1] HF reviews (rulebook HF-REV-1..4).
//   onCallCompleted(env, ctx, call)             called by the calls agent when a call ends with billed_minutes >= 1: review token (7 days) + WhatsApp link
//   GET  /api/hf/review/:token                  (no sign-in) -> { hostName, hostSlug, callDate, minutes, alreadyReviewed }
//   POST /api/hf/review/:token                  (no sign-in) { stars 1..5, text? <=500, topic? } -> { ok }
//   POST /api/hf/calls/:id/review               (signed-in caller of a completed call, within 7 days) same body
//   GET  /api/admin/hf/reviews?status=pending   -> { ok, items }   (pending|approved|rejected|all)
//   POST /api/admin/hf/reviews/:id              { decision: approve|reject, reason? } -> { ok, status }
// Reviews start `pending`; only approved ones count in aggregates / public lists. Gated by hfCallsEnabled (admin routes are not).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackException } from "../hooks";
import { BRAND, brandUrl } from "./brand";
import { readConfig } from "../routes/config";
import { isAdminUid } from "./preview";
import { sendWhatsAppText } from "./whatsapp_send";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { pushReviewRequest } from "./hf_push"; // [HF-APP-4]
import {
  validateReviewInput, tokenExpired, reviewWindowOpen, isRegular, buildAggregate, firstNameOf, callDateIst, toMs,
  REVIEW_WINDOW_MS, REGULAR_CALLS, EMPTY_AGG, type HostAggregate, type StarRow,
} from "./hf_reviews_pure";

export * from "./hf_reviews_pure";

const APP = BRAND.slug;
const err = (status: number, error: string, message?: string) => json({ error, message: message ?? error }, status);
const cap = (s: unknown, n: number) => String(s ?? "").slice(0, n);

/** hfCallsEnabled is added to PlatformConfig by the calls agent; read it untyped so this file compiles either way. */
export async function hfCallsOn(env: Env): Promise<boolean> {
  try { return ((await readConfig(env)) as unknown as Record<string, unknown>).hfCallsEnabled === true; } catch { return false; }
}

export type HfCallLike = { id: string; caller_uid: string; host_uid: string; billed_minutes?: number | null };

type CallRow = { id: string; caller_uid: string; host_uid: string; status: string; billed_minutes: number | null; ended_at: number | null; created_at: number | null };
const CALL_SQL = "SELECT id, caller_uid, host_uid, status, billed_minutes, ended_at, created_at FROM hf_calls WHERE id=?1";
const COMPLETED_PAID = "status='completed' AND billed_minutes >= 1";

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── call completion ──────────────────────────────────────────────────────────
/** Never throws. Idempotent per call: a second invocation neither mints a second token nor re-sends the WhatsApp. */
export async function onCallCompleted(env: Env, ctx: ExecutionContext | undefined, call: HfCallLike): Promise<void> {
  const work = (async () => {
    try {
      if (!call?.id || !call.caller_uid || !call.host_uid) return;
      if (call.billed_minutes != null && Number(call.billed_minutes) < 1) return;
      const now = Date.now();
      const token = newToken();
      const ins = await env.DB_META.prepare("INSERT OR IGNORE INTO hf_review_tokens (token, call_id, expires_at, created_at) VALUES (?1,?2,?3,?4)")
        .bind(token, call.id, now + REVIEW_WINDOW_MS, now).run();
      if (!ins.meta?.changes) return; // already minted (and sent) for this call
      const host = await env.DB_META.prepare("SELECT display_name FROM hf_hosts WHERE uid=?1").bind(call.host_uid).first<{ display_name: string | null }>().catch(() => null);
      const name = firstNameOf(host?.display_name) === "A caller" ? "your host" : firstNameOf(host?.display_name);
      await pushReviewRequest(env, undefined, call.caller_uid, name, token); // [HF-APP-4] push on top of WhatsApp
      const e164 = await verifiedWhatsAppNumber(env, call.caller_uid);
      if (!e164) return;
      await sendWhatsAppText(env, e164, `How was your call with ${name}? ${brandUrl("/review/" + token)}`);
    } catch (e) {
      await trackException(env, e, { route: "hf_reviews.onCallCompleted", handled: true, app_name: APP, extra: { area: "hf_reviews", call: call?.id } });
    }
  })();
  if (ctx) ctx.waitUntil(work);
  await work;
}

// ── submit (shared) ──────────────────────────────────────────────────────────
async function submit(env: Env, call: CallRow, body: unknown): Promise<Response> {
  const v = validateReviewInput(body);
  if (!v.ok) return err(v.status, v.error, v.message);
  if (!(call.status === "completed" && Number(call.billed_minutes) >= 1)) return err(409, "not_reviewable", "Only completed calls can be reviewed.");
  if (!reviewWindowOpen(call.ended_at, call.created_at, Date.now())) return err(410, "expired", "The review window for this call has closed.");
  const u = await env.DB_META.prepare("SELECT display_name FROM users WHERE uid=?1").bind(call.caller_uid).first<{ display_name: string | null }>().catch(() => null);
  const id = "hr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  try {
    await env.DB_META.prepare(
      `INSERT INTO hf_reviews (id, call_id, caller_uid, host_uid, stars, text, topic, first_name, minutes, status, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',?10)`,
    ).bind(id, call.id, call.caller_uid, call.host_uid, v.stars, v.text, v.topic, firstNameOf(u?.display_name), Math.max(0, Number(call.billed_minutes) | 0), Date.now()).run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) return err(409, "already_reviewed", "You already reviewed this call.");
    throw e;
  }
  void track(env, call.caller_uid, "hf_review_submitted", APP, { stars: v.stars, has_text: !!v.text });
  return json({ ok: true });
}

async function readBody(req: Request): Promise<unknown> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8_000) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

// ── routes ───────────────────────────────────────────────────────────────────
async function tokenRoute(req: Request, env: Env, token: string): Promise<Response> {
  const t = await env.DB_META.prepare("SELECT token, call_id, expires_at FROM hf_review_tokens WHERE token=?1").bind(token).first<{ call_id: string; expires_at: number }>();
  if (!t) return err(404, "not_found", "This review link isn't valid.");
  if (tokenExpired(t.expires_at, Date.now())) return err(410, "expired", "This review link has expired.");
  const call = await env.DB_META.prepare(CALL_SQL).bind(t.call_id).first<CallRow>().catch(() => null);
  if (!call) return err(404, "not_found", "This review link isn't valid.");
  const done = await env.DB_META.prepare("SELECT 1 AS x FROM hf_reviews WHERE call_id=?1").bind(call.id).first();
  if (req.method === "GET") {
    const h = await env.DB_META.prepare("SELECT display_name, slug FROM hf_hosts WHERE uid=?1").bind(call.host_uid).first<{ display_name: string | null; slug: string | null }>().catch(() => null);
    return json({
      hostName: h?.display_name ?? "your host", hostSlug: h?.slug ?? null, callDate: callDateIst(toMs(call.ended_at) || toMs(call.created_at)),
      minutes: Math.max(0, Number(call.billed_minutes) | 0), alreadyReviewed: !!done,
    });
  }
  if (done) return err(409, "already_reviewed", "You already reviewed this call.");
  return submit(env, call, await readBody(req));
}

async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  return { uid: u.uid };
}

async function adminAudit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_review_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/hf/reviews", handled: true, app_name: APP, extra: { area: "hf_reviews", step: "admin_audit", action } });
  }
}

export async function hfReviewsRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  void ctx;
  const p = new URL(req.url).pathname;
  const m = req.method;
  const tok = p.match(/^\/api\/hf\/review\/([A-Za-z0-9_-]{16,96})$/);
  const sess = p.match(/^\/api\/hf\/calls\/([A-Za-z0-9_-]{4,64})\/review$/);
  const adminOne = p.match(/^\/api\/admin\/hf\/reviews\/([A-Za-z0-9_-]{4,64})$/);
  const isAdminList = p === "/api/admin/hf/reviews";
  if (!tok && !sess && !adminOne && !isAdminList) return null;
  try {
    if (tok) {
      if (m !== "GET" && m !== "POST") return err(405, "method_not_allowed");
      if (!(await hfCallsOn(env))) return err(404, "not_enabled");
      return await tokenRoute(req, env, tok[1]);
    }
    if (sess) {
      if (m !== "POST") return err(405, "method_not_allowed");
      if (!(await hfCallsOn(env))) return err(404, "not_enabled");
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      const call = await env.DB_META.prepare(CALL_SQL).bind(sess[1]).first<CallRow>().catch(() => null);
      if (!call || call.caller_uid !== u.uid) return err(404, "not_found");
      return await submit(env, call, await readBody(req));
    }
    const a = await adminCtx(req, env);
    if (a instanceof Response) return a;
    if (isAdminList) {
      if (m !== "GET") return err(405, "method_not_allowed");
      const s = new URL(req.url).searchParams.get("status") || "pending";
      if (!["pending", "approved", "rejected", "all"].includes(s)) return err(400, "bad_status");
      const rows = (await env.DB_META.prepare(
        `SELECT r.*, h.slug AS host_slug, h.display_name AS host_name FROM hf_reviews r LEFT JOIN hf_hosts h ON h.uid = r.host_uid
         ${s === "all" ? "" : "WHERE r.status=?1"} ORDER BY r.created_at ${s === "pending" ? "ASC" : "DESC"} LIMIT 200`,
      ).bind(...(s === "all" ? [] : [s])).all<Record<string, unknown>>()).results ?? [];
      return json({
        ok: true,
        items: rows.map((r) => ({
          id: r.id, callId: r.call_id, hostUid: r.host_uid, hostSlug: r.host_slug ?? null, hostName: r.host_name ?? null, firstName: r.first_name,
          stars: r.stars, text: r.text, topic: r.topic ?? null, minutes: r.minutes, status: r.status, rejectReason: r.reject_reason ?? null,
          createdAt: r.created_at, decidedAt: r.decided_at ?? null,
        })),
      });
    }
    if (adminOne) {
      if (m !== "POST") return err(405, "method_not_allowed");
      const b = (await readBody(req)) as { decision?: unknown; reason?: unknown };
      if (b.decision !== "approve" && b.decision !== "reject") return err(400, "bad_decision");
      const reason = b.decision === "reject" ? cap(b.reason, 200).trim() || null : null;
      const row = await env.DB_META.prepare("SELECT id, host_uid, call_id, stars, status FROM hf_reviews WHERE id=?1").bind(adminOne[1]).first<{ id: string; host_uid: string; call_id: string; stars: number; status: string }>();
      if (!row) return err(404, "not_found");
      const next = b.decision === "approve" ? "approved" : "rejected";
      if (row.status === next) return json({ ok: true, status: next });
      await env.DB_META.prepare("UPDATE hf_reviews SET status=?2, reject_reason=?3, decided_by=?4, decided_at=?5 WHERE id=?1")
        .bind(row.id, next, reason, a.uid, Date.now()).run();
      await adminAudit(env, a.uid, b.decision, row.id, { hostUid: row.host_uid, callId: row.call_id, stars: row.stars, from: row.status, reason });
      void track(env, a.uid, "hf_review_decided", APP, { decision: b.decision });
      return json({ ok: true, status: next });
    }
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_reviews" } });
    return err(500, "internal_error");
  }
}

// ── public aggregates (read by routes/hf_hosts_public.ts) ────────────────────
const qs = (n: number) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(",");

/** Aggregates for many hosts in 2 queries. A missing hf_calls / hf_reviews table yields zeros, never an error. */
export async function hostAggregates(env: Env, hostUids: string[]): Promise<Map<string, HostAggregate>> {
  const out = new Map<string, HostAggregate>();
  const ids = [...new Set(hostUids)].filter(Boolean);
  if (!ids.length) return out;
  const stars = new Map<string, StarRow>();
  const talk = new Map<string, { talked: number; regulars: number }>();
  try {
    const rs = (await env.DB_META.prepare(
      `SELECT host_uid, SUM(stars=1) AS c1, SUM(stars=2) AS c2, SUM(stars=3) AS c3, SUM(stars=4) AS c4, SUM(stars=5) AS c5
       FROM hf_reviews WHERE status='approved' AND host_uid IN (${qs(ids.length)}) GROUP BY host_uid`,
    ).bind(...ids).all<StarRow & { host_uid: string }>()).results ?? [];
    for (const r of rs) stars.set(r.host_uid, r);
  } catch { /* table not migrated yet */ }
  try {
    const rs = (await env.DB_META.prepare(
      `SELECT host_uid, COUNT(*) AS talked, SUM(CASE WHEN n >= ${REGULAR_CALLS} THEN 1 ELSE 0 END) AS regulars FROM (
         SELECT host_uid, caller_uid, COUNT(*) AS n FROM hf_calls WHERE ${COMPLETED_PAID} AND host_uid IN (${qs(ids.length)}) GROUP BY host_uid, caller_uid
       ) GROUP BY host_uid`,
    ).bind(...ids).all<{ host_uid: string; talked: number; regulars: number }>()).results ?? [];
    for (const r of rs) talk.set(r.host_uid, { talked: Number(r.talked) || 0, regulars: Number(r.regulars) || 0 });
  } catch { /* hf_calls not migrated yet */ }
  for (const id of ids) out.set(id, buildAggregate(stars.get(id), talk.get(id)?.talked ?? 0, talk.get(id)?.regulars ?? 0));
  return out;
}

export const aggregateFields = (a: HostAggregate | undefined) => {
  const x = a ?? EMPTY_AGG;
  return { rating: x.rating, reviewCount: x.reviewCount, ratingBreakdown: x.ratingBreakdown, talkedTo: x.talkedTo, regulars: x.regulars };
};

export type PublicReview = { firstName: string; stars: number; text: string; topic: string | null; minutes: number; regular: boolean; date: string };

/** Latest approved reviews for one host (detail page). */
export async function hostReviews(env: Env, hostUid: string, limit = 10): Promise<PublicReview[]> {
  try {
    const rows = (await env.DB_META.prepare(
      "SELECT caller_uid, first_name, stars, text, topic, minutes, created_at FROM hf_reviews WHERE host_uid=?1 AND status='approved' ORDER BY created_at DESC LIMIT ?2",
    ).bind(hostUid, limit).all<{ caller_uid: string; first_name: string; stars: number; text: string; topic: string | null; minutes: number; created_at: number }>()).results ?? [];
    if (!rows.length) return [];
    const regular = new Set<string>();
    try {
      const callers = [...new Set(rows.map((r) => r.caller_uid))];
      const cs = (await env.DB_META.prepare(
        `SELECT caller_uid, COUNT(*) AS n FROM hf_calls WHERE ${COMPLETED_PAID} AND host_uid=?1 AND caller_uid IN (${callers.map((_, i) => `?${i + 2}`).join(",")}) GROUP BY caller_uid`,
      ).bind(hostUid, ...callers).all<{ caller_uid: string; n: number }>()).results ?? [];
      for (const c of cs) if (isRegular(Number(c.n))) regular.add(c.caller_uid);
    } catch { /* hf_calls not migrated yet */ }
    return rows.map((r) => ({
      firstName: r.first_name || "A caller", stars: r.stars, text: r.text, topic: r.topic ?? null, minutes: r.minutes,
      regular: regular.has(r.caller_uid), date: callDateIst(r.created_at),
    }));
  } catch { return []; }
}
