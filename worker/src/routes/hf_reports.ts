// [HF-DAILY-FLOWS-1] "Report a person" (/report) is stored, not only mailed, and the team can list reports and dashboard questions.
//   POST /api/hf/reports { contact, profile, call, details }  public (a bearer token, when sent, ties the report to the account)
//        -> { ok, id:"HF-R-XXXXXXXX" }   400 invalid_field | 429 rate limited | 503 not_ready (table missing: the page falls back to the email draft)
//   GET  /api/admin/hf/reports?status=open|closed|all             ADMIN_UIDS only -> { ok, items:[{ id, uid, contact, profile, call, details, status, createdAt }] }
//   GET  /api/admin/hf/support-tickets?status=open|closed|all     ADMIN_UIDS only -> { ok, items:[{ id, uid, topic, message, status, createdAt }] }  (the dashboard "Ask us" questions)
// The report is also emailed to the grievance inbox so a person sees it even before an admin page lists it.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { enqueueEmail } from "../lib/email_outbox";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, message: message ?? error, ...extra }, status, NO_STORE);
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : "");
const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

export async function hfReportsRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const isPost = p === "/api/hf/reports";
  const adminReports = p === "/api/admin/hf/reports";
  const adminTickets = p === "/api/admin/hf/support-tickets";
  if (!isPost && !adminReports && !adminTickets) return null;
  const m = req.method;
  if (isPost ? m !== "POST" : m !== "GET") return err(405, "method_not_allowed");
  try {
    if (!isPost) {
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
      const status = new URL(req.url).searchParams.get("status") || "open";
      if (!["open", "closed", "reviewed", "actioned", "all"].includes(status)) return err(400, "bad_status"); // [HF-ADMIN-COMPLETE-1] reviewed/actioned set from the desk
      const table = adminReports ? "hf_reports" : "hf_support_tickets";
      const rows = (await env.DB_META.prepare(`SELECT * FROM ${table} ${status === "all" ? "" : "WHERE status=?1"} ORDER BY created_at DESC LIMIT 200`)
        .bind(...(status === "all" ? [] : [status])).all<Record<string, unknown>>()).results ?? [];
      return json({
        ok: true,
        items: rows.map((r) => adminReports
          ? { id: r.id, uid: r.uid ?? null, contact: r.contact, profile: r.profile, call: r.call_ref, details: r.details, status: r.status, createdAt: Number(r.created_at) }
          : { id: r.id, uid: r.uid, topic: r.topic, message: r.message, status: r.status, createdAt: Number(r.created_at) }),
      }, 200, NO_STORE);
    }

    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown";
    const limited = await rateLimit(env, `hfreport:${await sha256Hex(ip)}`, 5, 3600);
    if (limited) return limited;
    let b: Record<string, unknown> | null = null;
    try { const t = await req.text(); b = t && t.length < 20_000 ? (JSON.parse(t) as Record<string, unknown>) : null; } catch { b = null; }
    if (!b || typeof b !== "object") return err(400, "invalid_field", "Please fill in the form.");
    const contact = clean(b.contact, 200), profile = clean(b.profile, 200), call = clean(b.call, 200), details = clean(b.details, 6000);
    if (contact.length < 3) return err(400, "invalid_field", "Please add your phone number or email so we can reach you.", { field: "contact" });
    if (profile.length < 2) return err(400, "invalid_field", "Please add the other person's profile name.", { field: "profile" });
    if (call.length < 2) return err(400, "invalid_field", "Please add the call ID.", { field: "call" });
    if ([...details].length < 10) return err(400, "invalid_field", "Please tell us what happened (at least 10 characters).", { field: "details" });

    let uid: string | null = null;
    if (req.headers.has("authorization")) {
      const u = await requireUser(req, env);
      if (!isFail(u)) uid = u.uid;
    }
    const now = Date.now();
    const id = `HF-R-${(await sha256Hex(`${contact}:${now}:${crypto.randomUUID()}`)).slice(0, 8).toUpperCase()}`;
    try {
      await env.DB_META.prepare("INSERT INTO hf_reports (id, uid, contact, profile, call_ref, details, status, created_at) VALUES (?1,?2,?3,?4,?5,?6,'open',?7)")
        .bind(id, uid, contact, profile, call, details, now).run();
    } catch (e) {
      if (/no such table/i.test(String(e))) return err(503, "not_ready", "Reports are not switched on yet. Please use the email draft.");
      throw e;
    }
    try {
      await enqueueEmail(env, {
        to: BRAND.emails.grievance, subject: `[${id}] User report — call ${call}`, outboxKey: `hf-report:${id}`, kind: "hf_user_report", recipientId: uid ?? "anonymous",
        html: `<p><strong>${id}</strong> · call ${escHtml(call)} · profile ${escHtml(profile)} · reporter ${escHtml(contact)}${uid ? ` · account ${escHtml(uid)}` : ""}</p><pre style="white-space:pre-wrap;font:15px/1.5 system-ui">${escHtml(details)}</pre>`,
      });
    } catch (e) { await trackException(env, e, { uid: uid ?? undefined, route: p, handled: true, app_name: APP, extra: { area: "hf_reports", step: "email" } }); }
    void track(env, uid ?? "anonymous", "hf_report_submitted", APP, { report_id: id, signed_in: !!uid });
    return json({ ok: true, id }, 200, NO_STORE);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_reports" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
