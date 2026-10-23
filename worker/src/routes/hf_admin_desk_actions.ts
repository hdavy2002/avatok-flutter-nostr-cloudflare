// [HF-ADMIN-COMPLETE-1] The admin desk can ACT, not only read.
//   GET  /api/admin/hf/desk/member?uid=            one member: profile, rupee wallet (same function as GET /api/hf/wallet), top-ups, withdrawals,
//                                                  refunds, bookings, calls, blocks, reports, tickets, closure status, internal notes
//   GET  /api/admin/hf/desk/wallets?q=&cursor=     members who hold or ever paid money, each with the rupee balance incl. paise
//   POST /api/admin/hf/desk/support/:id/{resolve|reopen|note|reply}     "Ask us" questions (hf_support_tickets)
//   POST /api/admin/hf/desk/reports/:id/{review|note|reply}             /report form submissions (hf_reports)
//   POST /api/admin/hf/desk/incidents/:id/review                        call reports / hash blocks (hf_incidents)
//   POST /api/admin/hf/desk/member/:uid/note                            internal note on a member
// Admin-only (requireUser + isAdminUid -> 403). Every POST writes an hf_admin_actions row (the timeline the page shows) AND an admin_audit row
// (same table the other admin routes use) and emits the PostHog event `hf_admin_action`. Replies go out through the EXISTING senders only:
// enqueueEmail (durable outbox) and sendWhatsAppText (the WasenderAPI session). Nothing here moves money.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isAdminUid } from "../lib/preview";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { enqueueEmail } from "../lib/email_outbox";
import { sendWhatsAppText } from "../lib/whatsapp_send";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { balanceSummary } from "../lib/hf_token_ledger";
import { walletGetFor } from "./hf_calls";
import { rows, one, actionsFor, actionOut, reportedMember, type ActionRow } from "../lib/hf_admin_actions_lib";
import { DESK_PAGE, HF_MEMBER_SQL, maskPhone, NAME_SQL } from "./hf_admin_desk";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
const n = (v: unknown) => Number(v ?? 0) || 0;
const ID_RE = /^[A-Za-z0-9_.:@-]{1,100}$/;
const REVIEW_STATES = ["reviewed", "actioned", "closed", "open"] as const;
type ReviewState = (typeof REVIEW_STATES)[number];
type Kind = "ticket" | "report" | "incident" | "member";
const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : "");

/** Same pattern as hf_hosts_admin: a failed audit insert is reported, it does not undo a decision the admin already took. */
async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<boolean> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_desk_${action}`, target, JSON.stringify(meta), Date.now()).run();
    return true;
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/hf/desk", handled: true, app_name: APP, extra: { area: "hf_admin_desk_actions", step: "admin_audit", action } });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------- reads
async function memberDetail(env: Env, uid: string): Promise<Response> {
  if (!ID_RE.test(uid)) return err(400, "bad_uid");
  const u = await one<Record<string, any>>(env,
    `SELECT u.uid, u.created_at AS joined_at, u.created_via, u.private_number, ${NAME_SQL("r", "u")} AS name, r.username, r.created_at AS registered_at, e.email,
            COALESCE(cv.phone_verified,0) AS wa_ok, COALESCE(cv.email_verified,0) AS email_ok, (SELECT s.status FROM account_status s WHERE s.clerk_user_id=u.uid) AS account_status
       FROM users u LEFT JOIN hf_user_registration r ON r.uid=u.uid LEFT JOIN hf_user_email e ON e.uid=u.uid LEFT JOIN contact_verification cv ON cv.uid=u.uid WHERE u.uid=?1`, uid);
  if (!u) return err(404, "not_found", "No such member.");
  const host = await one<Record<string, any>>(env, "SELECT status, category, slug, display_name FROM hf_hosts WHERE uid=?1", uid);
  const exit = await one<Record<string, any>>(env, "SELECT status, requested_at, updated_at, note FROM hf_exit_requests WHERE uid=?1", uid);

  // The rupee wallet: the very function behind GET /api/hf/wallet, so the admin reads the figure the member sees.
  let wallet: Record<string, unknown> | null = null;
  try {
    const w = (await (await walletGetFor(env, uid)).json()) as Record<string, any>;
    wallet = {
      mode: w.mode ?? "legacy",
      ...(w.wallet ? { ...w.wallet, balanceRupees: n(w.wallet.balancePaise) / 100, availableRupees: n(w.wallet.availablePaise) / 100, reservedRupees: n(w.wallet.reservedPaise) / 100, paidRupees: n(w.wallet.paidPaise) / 100, testRupees: n(w.wallet.testPaise) / 100, debtRupees: n(w.wallet.debtPaise) / 100 }
        : { balanceRupees: n(w.balanceRupees), paidRupees: n(w.paidBalance), testRupees: n(w.testBalance), spendableRupees: n(w.spendable) }),
      host: w.host ?? null, history: Array.isArray(w.history) ? w.history.slice(0, 20) : [],
    };
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/hf/desk/member", handled: true, app_name: APP, extra: { area: "hf_admin_desk_actions", step: "wallet" } });
  }

  const [topups, withdrawals, refunds, bookings, calls, blockedBy, blockedThem, incidents, tickets, notes] = await Promise.all([
    rows(env, "SELECT * FROM hf_topups WHERE uid=?1 ORDER BY created_at DESC LIMIT 50", uid),
    rows(env, "SELECT id, amount_rupees, status, utr, reject_reason, created_at, paid_at FROM hf_payout_requests WHERE host_uid=?1 ORDER BY created_at DESC LIMIT 50", uid),
    rows(env, "SELECT id, amount_rupees, status, reason, exit, created_at, refunded_at FROM hf_refund_requests WHERE uid=?1 ORDER BY created_at DESC LIMIT 20", uid),
    rows(env, `SELECT id, host_uid, customer_uid, starts_at, duration_min, status, reserved_paise, cancel_reason, created_at FROM hf_bookings WHERE customer_uid=?1 OR host_uid=?1 ORDER BY created_at DESC LIMIT 50`, uid),
    rows(env, "SELECT * FROM hf_calls WHERE caller_uid=?1 OR host_uid=?1 ORDER BY created_at DESC LIMIT 50", uid),
    rows(env, `SELECT b.blocked_uid AS other_uid, b.call_id, b.created_at, ${NAME_SQL("r", "x")} AS name FROM hf_blocks b LEFT JOIN hf_user_registration r ON r.uid=b.blocked_uid LEFT JOIN users x ON x.uid=b.blocked_uid WHERE b.blocker_uid=?1 ORDER BY b.created_at DESC LIMIT 50`, uid),
    rows(env, `SELECT b.blocker_uid AS other_uid, b.call_id, b.created_at, ${NAME_SQL("r", "x")} AS name FROM hf_blocks b LEFT JOIN hf_user_registration r ON r.uid=b.blocker_uid LEFT JOIN users x ON x.uid=b.blocker_uid WHERE b.blocked_uid=?1 ORDER BY b.created_at DESC LIMIT 50`, uid),
    rows(env, `SELECT i.id, i.call_id, i.reporter_uid, i.kind, i.created_at FROM hf_incidents i LEFT JOIN hf_calls c ON c.id=i.call_id
                WHERE i.reporter_uid=?1 OR c.caller_uid=?1 OR c.host_uid=?1 ORDER BY i.created_at DESC LIMIT 30`, uid),
    rows(env, "SELECT id, topic, message, status, created_at FROM hf_support_tickets WHERE uid=?1 ORDER BY created_at DESC LIMIT 30", uid),
    rows<ActionRow>(env, "SELECT * FROM hf_admin_actions WHERE subject_type='member' AND subject_id=?1 ORDER BY created_at ASC, rowid ASC LIMIT 200", uid),
  ]);
  // /report form submissions the member filed, or that name them (profile text = their @username / slug / display name).
  const handles = [u.username, host?.slug, host?.display_name].filter((x): x is string => typeof x === "string" && x.trim().length >= 2).map((x) => x.trim().replace(/^@/, "").toLowerCase());
  const reportsAbout = await rows(env, `SELECT id, uid, contact, profile, call_ref, details, status, created_at FROM hf_reports WHERE uid=?1${handles.length ? ` OR lower(replace(profile,'@','')) IN (${handles.map((_, i) => `?${i + 2}`).join(",")})` : ""} ORDER BY created_at DESC LIMIT 30`, uid, ...handles);

  const closing = exit && exit.status !== "cancelled" && exit.status !== "done" ? exit.status : null;
  return json({
    ok: true,
    member: {
      uid: u.uid, name: u.name ?? null, username: u.username ?? null, email: u.email ?? null, phone: maskPhone(u.private_number ?? null), joinedAt: n(u.joined_at) || null, via: u.created_via ?? null,
      registeredAt: n(u.registered_at) || null, whatsappVerified: n(u.wa_ok) === 1, emailVerified: n(u.email_ok) === 1, accountStatus: u.account_status ?? null,
      host: host ? { status: host.status, category: host.category, slug: host.slug, displayName: host.display_name } : null,
      closure: exit ? { status: exit.status, active: !!closing, requestedAt: n(exit.requested_at), updatedAt: n(exit.updated_at), note: exit.note ?? null } : null,
    },
    wallet,
    topups: topups.map((t) => ({ id: t.id, amountRupees: n(t.amount_rupees), gateway: t.gateway, status: t.status, credited: n(t.credited) === 1, refundedRupees: n(t.refunded_rupees), walletRupees: t.wallet_paise == null ? null : n(t.wallet_paise) / 100, createdAt: n(t.created_at), paidAt: n(t.paid_at) || null })),
    withdrawals: withdrawals.map((w) => ({ id: w.id, amountRupees: n(w.amount_rupees), status: w.status, utr: w.utr ?? null, rejectReason: w.reject_reason ?? null, createdAt: n(w.created_at), paidAt: n(w.paid_at) || null })),
    refunds: refunds.map((r) => ({ id: r.id, amountRupees: n(r.amount_rupees), status: r.status, reason: r.reason ?? null, exit: n(r.exit) === 1, createdAt: n(r.created_at), refundedAt: n(r.refunded_at) || null })),
    bookings: bookings.map((b) => ({ id: b.id, role: b.host_uid === uid ? "host" : "caller", otherUid: b.host_uid === uid ? b.customer_uid : b.host_uid, startsAt: n(b.starts_at), durationMin: n(b.duration_min), status: b.status, reservedRupees: n(b.reserved_paise) / 100, cancelReason: b.cancel_reason ?? null, createdAt: n(b.created_at) })),
    calls: calls.map((c) => ({ id: c.id, role: c.host_uid === uid ? "host" : "caller", otherUid: c.host_uid === uid ? c.caller_uid : c.host_uid, status: c.status, createdAt: n(c.created_at), seconds: n(c.billable_seconds), minutes: c.billed_minutes == null ? null : n(c.billed_minutes), chargedRupees: c.consumed_value_paise != null ? n(c.consumed_value_paise) / 100 : c.charged_paise != null ? n(c.charged_paise) / 100 : null })),
    blocks: { byMember: blockedThem.map((b) => ({ uid: b.other_uid, name: b.name ?? null, callId: b.call_id ?? null, at: n(b.created_at) })), ofMember: blockedBy.map((b) => ({ uid: b.other_uid, name: b.name ?? null, callId: b.call_id ?? null, at: n(b.created_at) })) },
    incidents: incidents.map((i) => ({ id: i.id, callId: i.call_id, kind: i.kind, reporterUid: i.reporter_uid, at: n(i.created_at) })),
    reports: reportsAbout.map((r) => ({ id: r.id, uid: r.uid ?? null, contact: r.contact, profile: r.profile, call: r.call_ref, details: r.details, status: r.status, createdAt: n(r.created_at) })),
    tickets: tickets.map((t) => ({ id: t.id, topic: t.topic, message: t.message, status: t.status, createdAt: n(t.created_at) })),
    notes: notes.map(actionOut),
  }, 200, NO_STORE);
}

/** Members who hold or ever paid money, with the rupee balance (paise kept) from the same ledger the wallet screen reads. */
async function walletsList(env: Env, url: URL): Promise<Response> {
  const off = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
  const offset = Number.isFinite(off) && off > 0 ? off : 0;
  const q = clean(url.searchParams.get("q"), 80).toLowerCase();
  const binds: unknown[] = [];
  let where = `${HF_MEMBER_SQL} AND (EXISTS (SELECT 1 FROM hf_topups t0 WHERE t0.uid=u.uid AND t0.status='paid') OR EXISTS (SELECT 1 FROM hf_token_lots l0 WHERE l0.uid=u.uid))`;
  if (q) {
    binds.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    where += ` AND (lower(COALESCE(r.username,'')) LIKE ?1 ESCAPE '\\' OR lower(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')) LIKE ?1 ESCAPE '\\' OR lower(COALESCE(e.email,'')) LIKE ?1 ESCAPE '\\' OR u.uid LIKE ?1 ESCAPE '\\')`;
  }
  const list = await rows(env,
    `SELECT u.uid, ${NAME_SQL("r", "u")} AS name, r.username, e.email,
            (SELECT COALESCE(SUM(t.amount_rupees),0) FROM hf_topups t WHERE t.uid=u.uid AND t.status='paid') AS paid_rupees,
            (SELECT MAX(COALESCE(t.paid_at,t.created_at)) FROM hf_topups t WHERE t.uid=u.uid AND t.status='paid') AS last_topup
       FROM users u LEFT JOIN hf_user_registration r ON r.uid=u.uid LEFT JOIN hf_user_email e ON e.uid=u.uid
      WHERE ${where} ORDER BY last_topup DESC, u.uid DESC LIMIT ${DESK_PAGE + 1} OFFSET ${offset}`, ...binds);
  const more = list.length > DESK_PAGE;
  const page = more ? list.slice(0, DESK_PAGE) : list;
  const items = await Promise.all(page.map(async (r) => {
    let s: Awaited<ReturnType<typeof balanceSummary>> | null = null;
    try { s = await balanceSummary(env, r.uid); } catch { s = null; }
    return {
      uid: r.uid, name: r.name ?? null, username: r.username ?? null, email: r.email ?? null, paidTopupRupees: n(r.paid_rupees), lastTopupAt: n(r.last_topup) || null,
      balanceRupees: s ? s.totalPaise / 100 : null, availableRupees: s ? s.availablePaise / 100 : null, reservedRupees: s ? Math.max(0, s.totalPaise - s.availablePaise) / 100 : null, debtRupees: s ? s.debtValuePaise / 100 : null,
    };
  }));
  return json({ ok: true, items, nextCursor: more ? String(offset + DESK_PAGE) : null }, 200, NO_STORE);
}

// --------------------------------------------------------------------------------------------------------------- writes
interface Subject { kind: Kind; id: string; uid: string | null; contact: string | null; label: string }

async function loadSubject(env: Env, kind: Kind, id: string): Promise<Subject | null> {
  if (kind === "ticket") {
    const t = await one<Record<string, any>>(env, "SELECT id, uid, topic FROM hf_support_tickets WHERE id=?1", id);
    return t ? { kind, id, uid: t.uid ?? null, contact: null, label: `your question (${clean(t.topic, 60)})` } : null;
  }
  if (kind === "report") {
    const r = await one<Record<string, any>>(env, "SELECT id, uid, contact FROM hf_reports WHERE id=?1", id);
    return r ? { kind, id, uid: r.uid ?? null, contact: r.contact ?? null, label: "your report" } : null;
  }
  if (kind === "incident") {
    const i = await one<Record<string, any>>(env, "SELECT id, reporter_uid FROM hf_incidents WHERE id=?1", id);
    return i ? { kind, id, uid: i.reporter_uid ?? null, contact: null, label: "your report" } : null;
  }
  const m = await one<Record<string, any>>(env, "SELECT uid FROM users WHERE uid=?1", id);
  return m ? { kind, id, uid: m.uid, contact: null, label: "your account" } : null;
}

/** +91 default for a bare 10-digit number; anything else must already carry its country code. */
export function toE164(contact: string): string | null {
  const d = contact.replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
}

async function sendReply(env: Env, s: Subject, channel: "email" | "whatsapp", message: string): Promise<{ ok: true; to: string } | { ok: false; status: number; error: string; message: string }> {
  if (channel === "email") {
    const typed = s.contact && s.contact.includes("@") ? s.contact.trim() : null;
    const to = typed || (s.uid ? await emailFor(env, s.uid).catch(() => null) : null);
    if (!to) return { ok: false, status: 422, error: "no_email", message: "There is no email address on file for this person. Try WhatsApp." };
    const q = await enqueueEmail(env, {
      to, subject: `Re: ${s.id} - ${BRAND.name} support`, outboxKey: `hf-admin-reply:${s.id}:${Date.now()}`, kind: "hf_admin_reply", recipientId: s.uid ?? "anonymous",
      html: `<p style="font:15px/1.5 system-ui">${escHtml(message).replace(/\n/g, "<br>")}</p><p style="font:13px/1.5 system-ui;color:#666">This is a reply about ${escHtml(s.label)} (${escHtml(s.id)}). Just reply to this email to write back.</p>`,
      replyTo: { email: BRAND.emails.support, name: BRAND.name },
    });
    if (q.status === "failed" || q.status === "bounced" || q.status === "unavailable") return { ok: false, status: 502, error: "email_failed", message: "The email could not be queued. Nothing was sent." };
    return { ok: true, to };
  }
  const e164 = (s.uid ? await verifiedWhatsAppNumber(env, s.uid).catch(() => null) : null) || (s.contact && !s.contact.includes("@") ? toE164(s.contact) : null);
  if (!e164) return { ok: false, status: 422, error: "no_whatsapp", message: "There is no WhatsApp number on file for this person. Try email." };
  const r = await sendWhatsAppText(env, e164, message);
  if (!r.ok) {
    const msg = r.reason === "not_on_whatsapp" ? "That number is not on WhatsApp." : r.reason === "unconfigured" ? "WhatsApp sending is not set up." : "WhatsApp did not accept the message. Try again in a minute.";
    return { ok: false, status: r.reason === "not_on_whatsapp" ? 422 : 502, error: `whatsapp_${r.reason}`, message: msg };
  }
  return { ok: true, to: maskPhone(e164) ?? "whatsapp" };
}

async function act(env: Env, adminUid: string, kind: Kind, id: string, verb: string, body: Record<string, unknown>): Promise<Response> {
  const s = await loadSubject(env, kind, id);
  if (!s) return err(404, "not_found", "That item does not exist.");
  const now = Date.now();
  let action = verb, text: string | null = null, channel: string | null = null, newStatus: string | null = null;
  const meta: Record<string, unknown> = { kind };

  if (verb === "note") {
    text = clean(body.note, 2000);
    if (text.length < 2) return err(400, "invalid_field", "Write the note first.");
  } else if (verb === "resolve" || verb === "reopen") {
    if (kind !== "ticket") return err(404, "not_found");
    newStatus = verb === "resolve" ? "closed" : "open";
    text = clean(body.note, 2000) || null;
  } else if (verb === "review") {
    if (kind !== "report" && kind !== "incident") return err(404, "not_found");
    const st = clean(body.status, 20) as ReviewState;
    if (!REVIEW_STATES.includes(st)) return err(400, "invalid_field", "Choose reviewed, actioned, closed or open.");
    text = clean(body.reason, 2000);
    if (st !== "open" && text.length < 3) return err(400, "invalid_field", "Write the reason (at least 3 characters).");
    action = st; newStatus = st;
  } else if (verb === "reply") {
    if (kind === "member" || kind === "incident") return err(404, "not_found");
    const ch = clean(body.channel, 12);
    if (ch !== "email" && ch !== "whatsapp") return err(400, "invalid_field", "Choose email or WhatsApp.");
    text = clean(body.message, 2000);
    if (text.length < 3) return err(400, "invalid_field", "Write the message first.");
    const sent = await sendReply(env, s, ch, text);
    if (!sent.ok) {
      void track(env, adminUid, "hf_admin_action", APP, { kind, verb: "reply", target_id: id, channel: ch, result: sent.error });
      return err(sent.status, sent.error, sent.message);
    }
    action = ch === "email" ? "reply_email" : "reply_whatsapp"; channel = ch; meta.to = sent.to; meta.channel = ch;
    if (body.alsoResolve === true && kind === "ticket") newStatus = "closed";
  } else {
    return err(404, "not_found");
  }

  const actionId = crypto.randomUUID();
  await env.DB_META.prepare("INSERT INTO hf_admin_actions (id, subject_type, subject_id, action, body, channel, admin_uid, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
    .bind(actionId, kind, id, action, text, channel, adminUid, now).run();
  if (newStatus && kind === "ticket") await env.DB_META.prepare("UPDATE hf_support_tickets SET status=?1, updated_at=?2 WHERE id=?3").bind(newStatus, now, id).run();
  if (newStatus && kind === "report") await env.DB_META.prepare("UPDATE hf_reports SET status=?1 WHERE id=?2").bind(newStatus, id).run();
  if (text && verb !== "reply") meta.reason = text.slice(0, 300);
  if (newStatus) meta.status = newStatus;
  const audited = await audit(env, adminUid, `${kind}_${action}`, id, meta);
  void track(env, adminUid, "hf_admin_action", APP, { kind, verb: action, target_id: id, status: newStatus, channel, audited });
  return json({ ok: true, id: actionId, action, status: newStatus, audited }, 200, NO_STORE);
}

export async function hfAdminDeskActionsRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const base = "/api/admin/hf/desk/";
  if (!p.startsWith(base)) return null;
  const rest = p.slice(base.length);
  const post = /^(support|reports|incidents|member)\/([^/]+)\/(resolve|reopen|note|reply|review)$/.exec(rest);
  const isGet = rest === "member" || rest === "wallets";
  if (!post && !isGet) return null;
  if (post ? req.method !== "POST" : req.method !== "GET") return err(405, "method_not_allowed");
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  try {
    if (rest === "member") return await memberDetail(env, (new URL(req.url).searchParams.get("uid") ?? "").trim());
    if (rest === "wallets") return await walletsList(env, new URL(req.url));
    const [, group, rawId, verb] = post!;
    const id = decodeURIComponent(rawId);
    if (!ID_RE.test(id)) return err(400, "bad_id");
    const kind: Kind = group === "support" ? "ticket" : group === "reports" ? "report" : group === "incidents" ? "incident" : "member";
    if (kind === "member" && verb !== "note") return err(404, "not_found");
    let body: Record<string, unknown> = {};
    try { const t = await req.text(); const j = t && t.length < 20_000 ? JSON.parse(t) : {}; if (j && typeof j === "object") body = j as Record<string, unknown>; } catch { return err(400, "invalid_json"); }
    return await act(env, u.uid, kind, id, verb, body);
  } catch (e) {
    await trackException(env, e, { uid: u.uid, route: p, handled: true, app_name: APP, extra: { area: "hf_admin_desk_actions" } });
    return err(500, "desk_action_failed", "That did not work. Nothing was changed; try again.");
  }
}
