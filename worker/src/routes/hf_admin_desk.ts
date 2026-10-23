// [HF-ADMIN-SWEEP-1] the call app admin "Members & activity" desk: READ-ONLY lists so the owner sees what users actually did.
// Before this the Hosts group could show influencers, payouts, refunds and calls, but NOT: who signed up, who booked, who
// topped up, who wrote to support, who reported/blocked whom. (The Users/Bookings/Payments pages read Saathum tables.)
//   GET /api/admin/hf/desk/summary
//   GET /api/admin/hf/desk/members?q=&cursor=            newest sign-ups first (any HF account, host or not)
//   GET /api/admin/hf/desk/bookings?status=&cursor=      hf_bookings with host + customer names
//   GET /api/admin/hf/desk/topups?status=&cursor=        hf_topups (Cashfree wallet top-ups), rupees
//   GET /api/admin/hf/desk/support?status=&cursor=       hf_support_tickets ("Ask us" on /dashboard/support)
//   GET /api/admin/hf/desk/reports?cursor=               hf_incidents (reports / hash blocks) + hf_blocks
// Admin-only (requireUser + isAdminUid). Nothing here writes. Money is converted to RUPEES on the wire (fields end in `Rupees`).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isAdminUid } from "../lib/preview";
import { trackException } from "../hooks";
import { actionsFor, reviewStateOf, rows as safeRows, reportedMember } from "../lib/hf_admin_actions_lib";

const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
export const DESK_PAGE = 50;
const IST_MS = 5.5 * 3600_000;

/** Display name of a person: registration name, else users.display_name, else null. */
export const NAME_SQL = (reg: string, usr: string) =>
  `COALESCE(NULLIF(trim(COALESCE(${reg}.first_name,'') || ' ' || COALESCE(${reg}.last_name,'')),''), NULLIF(trim(${usr}.display_name),''))`;

/** Any account that touched the call app: WhatsApp sign-up, registration, age confirm or an HF email. */
export const HF_MEMBER_SQL = `(EXISTS (SELECT 1 FROM hf_phone_signup s WHERE s.uid=u.uid)
  OR EXISTS (SELECT 1 FROM hf_user_registration r0 WHERE r0.uid=u.uid)
  OR EXISTS (SELECT 1 FROM hf_registration_progress p0 WHERE p0.uid=u.uid)
  OR EXISTS (SELECT 1 FROM hf_age_confirm a0 WHERE a0.uid=u.uid)
  OR EXISTS (SELECT 1 FROM hf_user_email e0 WHERE e0.uid=u.uid))`;

export function maskPhone(v: string | null): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  return d.length >= 4 ? `+${d.length > 10 ? d.slice(0, d.length - 10) : "91"} ••••• ${d.slice(-4)}` : null;
}
const n = (v: unknown) => Number(v ?? 0) || 0;
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

function page(url: URL): { limit: number; offset: number } {
  const off = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
  return { limit: DESK_PAGE + 1, offset: Number.isFinite(off) && off > 0 ? off : 0 };
}
function paged<T>(rows: T[], offset: number) {
  const more = rows.length > DESK_PAGE;
  return { items: more ? rows.slice(0, DESK_PAGE) : rows, nextCursor: more ? String(offset + DESK_PAGE) : null };
}

export async function members(env: Env, url: URL): Promise<Response> {
  const { limit, offset } = page(url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const binds: unknown[] = [];
  let where = HF_MEMBER_SQL;
  if (q) {
    binds.push(`%${esc(q.toLowerCase())}%`);
    const a = `?${binds.length}`;
    binds.push(`${esc(q)}%`);
    const b = `?${binds.length}`;
    const digits = q.replace(/\D/g, "");
    let phone = "";
    if (digits.length >= 4) { binds.push(`%${digits}`); phone = ` OR replace(COALESCE(u.private_number,''),'+','') LIKE ?${binds.length} ESCAPE '\\'`; }
    where += ` AND (lower(COALESCE(r.username,'')) LIKE ${a} ESCAPE '\\' OR lower(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')) LIKE ${a} ESCAPE '\\'
      OR lower(COALESCE(u.display_name,'')) LIKE ${a} ESCAPE '\\' OR lower(COALESCE(e.email,'')) LIKE ${a} ESCAPE '\\' OR u.uid LIKE ${b} ESCAPE '\\'${phone})`;
  }
  const rows = (await env.DB_META.prepare(
    `SELECT u.uid, u.created_at AS joined_at, u.created_via, u.private_number, ${NAME_SQL("r", "u")} AS name, r.username, r.created_at AS registered_at, e.email,
            COALESCE(cv.phone_verified,0) AS wa_ok, COALESCE(cv.email_verified,0) AS email_ok,
            h.status AS host_status, h.category AS host_category,
            (SELECT COUNT(*) FROM hf_topups t WHERE t.uid=u.uid AND t.status='paid') AS topups,
            (SELECT COALESCE(SUM(t.amount_rupees),0) FROM hf_topups t WHERE t.uid=u.uid AND t.status='paid') AS topup_rupees,
            (SELECT COUNT(*) FROM hf_bookings b WHERE b.customer_uid=u.uid) AS bookings,
            (SELECT COUNT(*) FROM hf_calls c WHERE c.caller_uid=u.uid) AS calls,
            (SELECT s.status FROM account_status s WHERE s.clerk_user_id=u.uid) AS account_status,
            (SELECT x.status FROM hf_exit_requests x WHERE x.uid=u.uid) AS exit_status
       FROM users u
       LEFT JOIN hf_user_registration r ON r.uid=u.uid
       LEFT JOIN hf_user_email e ON e.uid=u.uid
       LEFT JOIN contact_verification cv ON cv.uid=u.uid
       LEFT JOIN hf_hosts h ON h.uid=u.uid
      WHERE ${where}
      ORDER BY u.created_at DESC, u.uid DESC LIMIT ${limit} OFFSET ${offset}`,
  ).bind(...binds).all<Record<string, any>>()).results ?? [];
  const p = paged(rows, offset);
  return json({
    ok: true, nextCursor: p.nextCursor,
    items: p.items.map((r) => ({
      uid: r.uid, name: r.name ?? null, username: r.username ?? null, email: r.email ?? null, phone: maskPhone(r.private_number ?? null),
      joinedAt: n(r.joined_at) || null, via: r.created_via ?? null, registeredAt: n(r.registered_at) || null,
      whatsappVerified: n(r.wa_ok) === 1, emailVerified: n(r.email_ok) === 1,
      hostStatus: r.host_status ?? null, hostCategory: r.host_category ?? null,
      topups: n(r.topups), topupRupees: n(r.topup_rupees), bookings: n(r.bookings), calls: n(r.calls),
      accountStatus: r.account_status ?? null, closing: r.exit_status && r.exit_status !== "cancelled" && r.exit_status !== "done" ? r.exit_status : null,
    })),
  }, 200, NO_STORE);
}

export async function bookings(env: Env, url: URL): Promise<Response> {
  const { limit, offset } = page(url);
  const st = (url.searchParams.get("status") ?? "all").toLowerCase();
  const ok = ["confirming", "confirmed", "starting", "active", "settling", "completed", "cancelled", "failed"].includes(st);
  const rows = (await env.DB_META.prepare(
    `SELECT b.id, b.host_uid, b.customer_uid, b.starts_at, b.ends_at, b.status, b.duration_min, b.reserved_paise, b.expected_host_net_paise, b.settlement_status,
            b.cancel_reason, b.approved_at, b.decided_by, b.approval_deadline, b.call_id, b.topic_slug, b.created_at, b.cancelled_at, b.completed_at,
            COALESCE(NULLIF(trim(h.display_name),''), ${NAME_SQL("hr", "hu")}) AS host_name, h.slug AS host_slug,
            COALESCE(${NAME_SQL("cr", "cu")}, 'Caller') AS customer_name, cr.username AS customer_username
       FROM hf_bookings b
       LEFT JOIN hf_hosts h ON h.uid=b.host_uid
       LEFT JOIN hf_user_registration hr ON hr.uid=b.host_uid LEFT JOIN users hu ON hu.uid=b.host_uid
       LEFT JOIN hf_user_registration cr ON cr.uid=b.customer_uid LEFT JOIN users cu ON cu.uid=b.customer_uid
      ${ok ? "WHERE b.status=?1" : ""} ORDER BY b.created_at DESC, b.id DESC LIMIT ${limit} OFFSET ${offset}`,
  ).bind(...(ok ? [st] : [])).all<Record<string, any>>()).results ?? [];
  const counts = (await env.DB_META.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(reserved_paise),0) AS p FROM hf_bookings GROUP BY status").all<{ status: string; n: number; p: number }>()).results ?? [];
  const p = paged(rows, offset);
  return json({
    ok: true, nextCursor: p.nextCursor,
    counts: Object.fromEntries(counts.map((c) => [c.status, { n: n(c.n), rupees: n(c.p) / 100 }])),
    items: p.items.map((r) => ({
      id: r.id, status: r.status, hostUid: r.host_uid, hostName: r.host_name ?? null, hostSlug: r.host_slug ?? null, customerUid: r.customer_uid, customerName: r.customer_name, customerUsername: r.customer_username ?? null,
      startsAt: n(r.starts_at), endsAt: n(r.ends_at), durationMin: n(r.duration_min), reservedRupees: n(r.reserved_paise) / 100, hostNetRupees: n(r.expected_host_net_paise) / 100,
      settlement: r.settlement_status, cancelReason: r.cancel_reason ?? null, approvedAt: n(r.approved_at) || null, decidedBy: r.decided_by ?? null, approvalDeadline: n(r.approval_deadline) || null,
      callId: r.call_id ?? null, topic: r.topic_slug ?? null, createdAt: n(r.created_at), cancelledAt: n(r.cancelled_at) || null, completedAt: n(r.completed_at) || null,
    })),
  }, 200, NO_STORE);
}

export async function topups(env: Env, url: URL): Promise<Response> {
  const { limit, offset } = page(url);
  const st = (url.searchParams.get("status") ?? "all").toLowerCase();
  const ok = ["created", "paid", "failed", "refunded", "expired"].includes(st);
  const rows = (await env.DB_META.prepare(
    `SELECT t.*, /* t.* so a column an older database lacks (wallet_paise, gst_paise, refunded_rupees) reads as absent, not as an error */
            ${NAME_SQL("r", "u")} AS name, r.username, (SELECT rc.number FROM hf_receipts rc WHERE rc.source='topup' AND rc.source_id=t.id LIMIT 1) AS receipt
       FROM hf_topups t LEFT JOIN hf_user_registration r ON r.uid=t.uid LEFT JOIN users u ON u.uid=t.uid
      ${ok ? "WHERE t.status=?1" : ""} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit} OFFSET ${offset}`,
  ).bind(...(ok ? [st] : [])).all<Record<string, any>>()).results ?? [];
  const now = Date.now();
  const dayStart = Math.floor((now + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;
  const d = new Date(now + IST_MS);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_MS;
  const sumSql = "SELECT COUNT(*) AS n, COALESCE(SUM(amount_rupees),0) AS s FROM hf_topups WHERE status='paid' AND COALESCE(paid_at,created_at)>=?1";
  const [counts, today, month] = await Promise.all([
    env.DB_META.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_rupees),0) AS s FROM hf_topups GROUP BY status").all<{ status: string; n: number; s: number }>(),
    env.DB_META.prepare(sumSql).bind(dayStart).first<{ n: number; s: number }>(),
    env.DB_META.prepare(sumSql).bind(monthStart).first<{ n: number; s: number }>(),
  ]);
  const p = paged(rows, offset);
  return json({
    ok: true, nextCursor: p.nextCursor,
    counts: Object.fromEntries((counts.results ?? []).map((c) => [c.status, { n: n(c.n), rupees: n(c.s) }])),
    today: { n: n(today?.n), rupees: n(today?.s) }, month: { n: n(month?.n), rupees: n(month?.s) },
    items: p.items.map((r) => ({
      id: r.id, uid: r.uid, name: r.name ?? null, username: r.username ?? null, amountRupees: n(r.amount_rupees), gateway: r.gateway, status: r.status, credited: n(r.credited) === 1,
      refundedRupees: n(r.refunded_rupees), walletRupees: r.wallet_paise == null ? null : n(r.wallet_paise) / 100, gstRupees: r.gst_paise == null ? null : n(r.gst_paise) / 100,
      paymentId: r.gateway_payment_id ?? null, receipt: r.receipt ?? null, createdAt: n(r.created_at), paidAt: n(r.paid_at) || null,
    })),
  }, 200, NO_STORE);
}

export async function support(env: Env, url: URL): Promise<Response> {
  const { limit, offset } = page(url);
  const st = (url.searchParams.get("status") ?? "all").toLowerCase();
  const ok = /^[a-z_]{2,20}$/.test(st) && st !== "all";
  const rows = (await env.DB_META.prepare(
    `SELECT t.id, t.uid, t.topic, t.message, t.status, t.created_at, t.updated_at, ${NAME_SQL("r", "u")} AS name, r.username, e.email
       FROM hf_support_tickets t LEFT JOIN hf_user_registration r ON r.uid=t.uid LEFT JOIN users u ON u.uid=t.uid LEFT JOIN hf_user_email e ON e.uid=t.uid
      ${ok ? "WHERE t.status=?1" : ""} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit} OFFSET ${offset}`,
  ).bind(...(ok ? [st] : [])).all<Record<string, any>>()).results ?? [];
  const counts = (await env.DB_META.prepare("SELECT status, COUNT(*) AS n FROM hf_support_tickets GROUP BY status").all<{ status: string; n: number }>()).results ?? [];
  const p = paged(rows, offset);
  const acts = await actionsFor(env, "ticket", p.items.map((r) => String(r.id)));
  return json({
    ok: true, nextCursor: p.nextCursor, counts: Object.fromEntries(counts.map((c) => [c.status, n(c.n)])),
    items: p.items.map((r) => ({ id: r.id, uid: r.uid, name: r.name ?? null, username: r.username ?? null, email: r.email ?? null, topic: r.topic, message: r.message, status: r.status, createdAt: n(r.created_at), updatedAt: n(r.updated_at), actions: acts.get(String(r.id)) ?? [] })),
  }, 200, NO_STORE);
}

export async function reports(env: Env, url: URL): Promise<Response> {
  const { limit, offset } = page(url);
  const other = "(CASE WHEN i.reporter_uid=c.caller_uid THEN c.host_uid ELSE c.caller_uid END)";
  const rows = (await env.DB_META.prepare(
    `SELECT i.id, i.call_id, i.reporter_uid, i.kind, i.created_at, ${NAME_SQL("rr", "ru")} AS reporter_name,
            ${other} AS other_uid, COALESCE(NULLIF(trim(h.display_name),''), ${NAME_SQL("cr", "cu")}) AS other_name
       FROM hf_incidents i
       LEFT JOIN hf_user_registration rr ON rr.uid=i.reporter_uid LEFT JOIN users ru ON ru.uid=i.reporter_uid
       LEFT JOIN hf_calls c ON c.id=i.call_id
       LEFT JOIN hf_hosts h ON h.uid=${other}
       LEFT JOIN hf_user_registration cr ON cr.uid=${other}
       LEFT JOIN users cu ON cu.uid=${other}
      ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit} OFFSET ${offset}`,
  ).all<Record<string, any>>()).results ?? [];
  const blocks = offset > 0 ? [] : (await env.DB_META.prepare(
    `SELECT b.blocker_uid, b.blocked_uid, b.call_id, b.created_at, ${NAME_SQL("br", "bu")} AS blocker_name,
            COALESCE(NULLIF(trim(h.display_name),''), ${NAME_SQL("dr", "du")}) AS blocked_name
       FROM hf_blocks b LEFT JOIN hf_user_registration br ON br.uid=b.blocker_uid LEFT JOIN users bu ON bu.uid=b.blocker_uid
       LEFT JOIN hf_hosts h ON h.uid=b.blocked_uid LEFT JOIN hf_user_registration dr ON dr.uid=b.blocked_uid LEFT JOIN users du ON du.uid=b.blocked_uid
      ORDER BY b.created_at DESC LIMIT 100`,
  ).all<Record<string, any>>()).results ?? [];
  const p = paged(rows, offset);
  const incActs = await actionsFor(env, "incident", p.items.map((r) => String(r.id)));
  // [HF-ADMIN-COMPLETE-1] The /report form queue (hf_reports; absent until its migration is applied) with who it is about, and each item's timeline.
  const forms = offset > 0 ? [] : await safeRows<Record<string, any>>(env, "SELECT * FROM hf_reports ORDER BY (status='open') DESC, created_at DESC LIMIT 100");
  const formActs = await actionsFor(env, "report", forms.map((r) => String(r.id)));
  const userReports = await Promise.all(forms.map(async (r) => {
    const about = await reportedMember(env, String(r.profile ?? ""), String(r.call_ref ?? ""), r.uid ?? null);
    return { id: r.id, uid: r.uid ?? null, contact: r.contact, profile: r.profile, call: r.call_ref, details: r.details, status: r.status, createdAt: n(r.created_at),
      reportedUid: about?.uid ?? null, reportedName: about?.name ?? null, actions: formActs.get(String(r.id)) ?? [] };
  }));
  return json({
    ok: true, nextCursor: p.nextCursor, userReports,
    incidents: p.items.map((r) => { const a = incActs.get(String(r.id)) ?? []; return { id: r.id, callId: r.call_id, kind: r.kind, reporterUid: r.reporter_uid, reporterName: r.reporter_name ?? null, otherUid: r.other_uid ?? null, otherName: r.other_name ?? null, at: n(r.created_at), state: reviewStateOf(a), actions: a }; }),
    blocks: blocks.map((r) => ({ blockerUid: r.blocker_uid, blockerName: r.blocker_name ?? null, blockedUid: r.blocked_uid, blockedName: r.blocked_name ?? null, callId: r.call_id ?? null, at: n(r.created_at) })),
  }, 200, NO_STORE);
}

export async function summary(env: Env): Promise<Response> {
  const now = Date.now();
  const dayStart = Math.floor((now + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;
  const d = new Date(now + IST_MS);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_MS;
  const one = async (sql: string, ...b: unknown[]) => n((await env.DB_META.prepare(sql).bind(...b).first<{ n: number }>().catch(() => null))?.n);
  const sums = async (since: number) => {
    const r = await env.DB_META.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_rupees),0) AS s FROM hf_topups WHERE status='paid' AND COALESCE(paid_at,created_at)>=?1").bind(since).first<{ n: number; s: number }>().catch(() => null);
    return { n: n(r?.n), rupees: n(r?.s) };
  };
  const [total, d1, dToday, d7, registered, hostsLive, hostsReview, bookingsOpen, bookingsUpcoming, bookingsPending, ticketsOpen, payoutsOpen, refundsOpen, exitOpen, incidents30, incidentsOpen, formReportsOpen, moneyOpen, topToday, topMonth] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM users u WHERE ${HF_MEMBER_SQL}`),
    one(`SELECT COUNT(*) AS n FROM users u WHERE ${HF_MEMBER_SQL} AND u.created_at>=?1`, now - 86_400_000),
    one(`SELECT COUNT(*) AS n FROM users u WHERE ${HF_MEMBER_SQL} AND u.created_at>=?1`, dayStart),
    one(`SELECT COUNT(*) AS n FROM users u WHERE ${HF_MEMBER_SQL} AND u.created_at>=?1`, now - 7 * 86_400_000),
    one("SELECT COUNT(*) AS n FROM hf_user_registration"),
    one("SELECT COUNT(*) AS n FROM hf_hosts WHERE status='live'"),
    one("SELECT COUNT(*) AS n FROM hf_hosts WHERE status='pending_review'"),
    one("SELECT COUNT(*) AS n FROM hf_bookings WHERE status IN ('confirming','confirmed','starting','active','settling')"),
    one("SELECT COUNT(*) AS n FROM hf_bookings WHERE status IN ('confirmed','starting') AND starts_at>=?1", now),
    one("SELECT COUNT(*) AS n FROM hf_bookings WHERE status='confirming'"),
    one("SELECT COUNT(*) AS n FROM hf_support_tickets WHERE status='open'"),
    one("SELECT COUNT(*) AS n FROM hf_payout_requests WHERE status IN ('requested','approved')"),
    one("SELECT COUNT(*) AS n FROM hf_refund_requests WHERE status IN ('requested','failed','processing')"),
    one("SELECT COUNT(*) AS n FROM hf_exit_requests WHERE status NOT IN ('done','cancelled')"),
    one("SELECT COUNT(*) AS n FROM hf_incidents WHERE created_at>=?1", now - 30 * 86_400_000),
    // an incident is "open" until the desk has a review-type action on it (hf_admin_actions; before its migration every incident counts as open)
    (async () => {
      const r = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_incidents i WHERE NOT EXISTS (SELECT 1 FROM hf_admin_actions a WHERE a.subject_type='incident' AND a.subject_id=i.id AND a.action IN ('reviewed','actioned','closed'))").first<{ n: number }>().catch(() => null);
      return r ? n(r.n) : one("SELECT COUNT(*) AS n FROM hf_incidents");
    })(),
    one("SELECT COUNT(*) AS n FROM hf_reports WHERE status='open'"),
    one("SELECT COUNT(*) AS n FROM hf_money_audit WHERE status='open'"),
    sums(dayStart), sums(monthStart),
  ]);
  return json({
    ok: true, members: { total, last24h: d1, today: dToday, last7d: d7, registered }, hosts: { live: hostsLive, pendingReview: hostsReview },
    bookingsOpen, bookings: { open: bookingsOpen, upcoming: bookingsUpcoming, pendingApproval: bookingsPending },
    topups: { today: topToday, month: topMonth },
    ticketsOpen, payoutsOpen, refundsOpen, closingAccounts: exitOpen, incidents30d: incidents30,
    reportsOpen: incidentsOpen + formReportsOpen, moneyAlertsOpen: moneyOpen,
  }, 200, NO_STORE);
}

export async function hfAdminDeskRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (!p.startsWith("/api/admin/hf/desk/")) return null;
  if (req.method !== "GET") return err(405, "method_not_allowed");
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  const url = new URL(req.url);
  try {
    switch (p.slice("/api/admin/hf/desk/".length)) {
      case "summary": return await summary(env);
      case "members": return await members(env, url);
      case "bookings": return await bookings(env, url);
      case "topups": return await topups(env, url);
      case "support": return await support(env, url);
      case "reports": return await reports(env, url);
      default: return err(404, "not_found");
    }
  } catch (e) {
    await trackException(env, e, { uid: u.uid, route: p, handled: true, app_name: "hellofraands", extra: { area: "hf_admin_desk" } });
    return err(500, "desk_failed", "Could not load this list. Try again; if it keeps failing the server log has the reason.");
  }
}
