// [HF-WIRE-13] Admin view of the call-money monitor's cases (table hf_money_audit).
//   GET  /api/admin/hf/money-audit?status=open|fixed|resolved|all&kind=call|booking&limit=100&before=<ms>
//   POST /api/admin/hf/money-audit/:id/resolve   { note? }   -> closes an open case (no money moves)
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isAdminUid } from "../lib/preview";

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
    const res = await env.DB_META.prepare("UPDATE hf_money_audit SET status='resolved', updated_at=?1 WHERE id=?2 AND status='open'").bind(Date.now(), m[1]).run();
    if (Number(res.meta?.changes ?? 0) === 0) return err(404, "not_found", "No open case with that id.");
    return json({ ok: true });
  }
  return err(405, "method_not_allowed");
}

function safeJson(s: unknown): unknown { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return s; } }
