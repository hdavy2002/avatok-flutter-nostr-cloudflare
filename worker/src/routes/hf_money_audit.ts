// [HF-WIRE-13] Admin view of the call-money monitor's cases (table hf_money_audit).
//   GET  /api/admin/hf/money-audit?status=open|fixed|resolved|all&kind=call|booking&limit=100&before=<ms>
//   POST /api/admin/hf/money-audit/:id/resolve   { note? }   -> closes an open case (no money moves)
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isAdminUid } from "../lib/preview";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";

const err = (status: number, error: string, message?: string) => json({ error, message: message ?? error }, status);

export async function hfMoneyAuditRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p !== "/api/admin/hf/money-audit" && !p.startsWith("/api/admin/hf/money-audit/")) return null;
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
  const url = new URL(req.url);
  if (p === "/api/admin/hf/money-audit" && req.method === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    const kind = url.searchParams.get("kind");
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
    const before = Number(url.searchParams.get("before") ?? 0) || Date.now() + 1;
    const where: string[] = ["created_at<?1"]; const binds: unknown[] = [before];
    if (status !== "all") { binds.push(status); where.push(`status=?${binds.length}`); }
    if (kind === "call" || kind === "booking") { binds.push(kind); where.push(`kind=?${binds.length}`); }
    binds.push(limit);
    const rows = (await env.DB_META.prepare(
      `SELECT * FROM hf_money_audit WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?${binds.length}`,
    ).bind(...binds).all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] }))).results ?? [];
    const counts = (await env.DB_META.prepare("SELECT status, COUNT(*) AS n FROM hf_money_audit GROUP BY status").all<{ status: string; n: number }>().catch(() => ({ results: [] }))).results ?? [];
    return json({
      cases: rows.map((r) => ({ ...r, detail: safeJson(r.detail) })),
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      next: rows.length === limit ? Number(rows[rows.length - 1].created_at) : null,
    });
  }
  const m = /^\/api\/admin\/hf\/money-audit\/([^/]+)\/resolve$/.exec(p);
  if (m && req.method === "POST") {
    // [HF-ADMIN-COMPLETE-1] The note is kept (hf_admin_actions), the decision is audited (admin_audit) and counted (PostHog hf_admin_action).
    let note = ""; try { const b = JSON.parse((await req.text()) || "{}"); note = typeof b?.note === "string" ? b.note.trim().slice(0, 2000) : ""; } catch { /* no body */ }
    const now = Date.now();
    const res = await env.DB_META.prepare("UPDATE hf_money_audit SET status='resolved', updated_at=?1 WHERE id=?2 AND status='open'").bind(now, m[1]).run();
    if (Number(res.meta?.changes ?? 0) === 0) return err(404, "not_found", "No open case with that id.");
    try { await env.DB_META.prepare("INSERT INTO hf_admin_actions (id, subject_type, subject_id, action, body, channel, admin_uid, created_at) VALUES (?1,'money',?2,'resolve',?3,NULL,?4,?5)").bind(crypto.randomUUID(), m[1], note || null, u.uid, now).run(); } catch { /* table arrives with 2026-10-23-hf-admin-actions.sql */ }
    let audited = true;
    try { await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(crypto.randomUUID(), u.uid, "hf_desk_money_resolve", m[1], JSON.stringify({ note: note.slice(0, 300) }), now).run(); }
    catch (e) { audited = false; await trackException(env, e, { route: p, handled: true, app_name: BRAND.slug, extra: { area: "hf_money_audit", step: "admin_audit" } }); }
    void track(env, u.uid, "hf_admin_action", BRAND.slug, { kind: "money", verb: "resolve", target_id: m[1], audited });
    return json({ ok: true, audited });
  }
  return err(405, "method_not_allowed");
}

function safeJson(s: unknown): unknown { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return s; } }
