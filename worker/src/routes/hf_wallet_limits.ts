// [HF-WALLET-LIMITS-1] Receipts, admin spend-limit override and admin reconciliation. Rules HF-PAY-7, HF-PAY-16, HF-PAY-17.
//   GET  /api/hf/wallet/receipts                          -> {ok, receipts:[{id,number,kind,source,amountRupees,issuedAt}], invoicing}
//   GET  /api/hf/wallet/receipts/:id                      -> printable HTML (owner only)
//   GET  /api/admin/hf/limits/:uid                        -> {ok, uid, defaults, override, effective, spentToday, spentThisMonth}
//   PUT  /api/admin/hf/limits/:uid {dailyRupees?, monthlyRupees?, note}   (null clears that column; omitted keeps it)
//   GET  /api/admin/hf/reconciliation?from=&to=[&format=csv]   (IST dates, inclusive, max 93 days)
// The wallet endpoint itself (GET /api/hf/wallet) gains `limits` in routes/hf_calls.ts; call-start enforcement is there too.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { isAdminUid } from "../lib/preview";
import { readConfig } from "./config";
import { HF_CALL_APP } from "../lib/hf_calls_store";
import { getOverride, limitDefaults, limitSummary, setOverride, MAX_LIMIT_RUPEES } from "../lib/hf_limits";
import { backfillTopupReceipts, getReceipt, listReceipts, renderReceiptHtml, supplierFrom, invoicingOn } from "../lib/hf_receipts";
import { loadReconciliation, parseRange, reconciliationCsv } from "../lib/hf_reconcile";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);
const NO_STORE = { "cache-control": "private, no-store" };
const cfgOf = async (env: Env) => ((await readConfig(env).catch(() => ({}))) ?? {}) as Record<string, unknown>;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 4000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
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
    await trackException(env, e, { route: "/api/admin/hf", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_wallet_limits", step: "admin_audit", action } });
  }
}

// ── receipts ─────────────────────────────────────────────────────────────────
async function receiptList(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const cfg = await cfgOf(env);
  await backfillTopupReceipts(env, cfg, u.uid);
  const rows = await listReceipts(env, u.uid);
  return json({
    ok: true, invoicing: invoicingOn(supplierFrom(cfg)),
    receipts: rows.map((r) => ({ id: r.id, number: r.number, kind: r.kind, source: r.source, amountRupees: r.amount_rupees, issuedAt: r.issued_at })),
  }, 200, NO_STORE);
}
async function receiptView(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const r = await getReceipt(env, id);
  if (!r || r.uid !== u.uid) return err(404, "not_found", "Receipt not found.");
  const cfg = await cfgOf(env);
  const name = (await env.DB_META.prepare("SELECT display_name FROM users WHERE uid=?1").bind(u.uid).first<{ display_name: string | null }>().catch(() => null))?.display_name ?? null;
  return new Response(renderReceiptHtml(r, supplierFrom(cfg), name), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" },
  });
}

// ── admin: spend-limit override ──────────────────────────────────────────────
async function limitGet(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const cfg = await cfgOf(env);
  const [override, s] = await Promise.all([getOverride(env, uid), limitSummary(env, uid, cfg)]);
  return json({
    ok: true, uid, defaults: limitDefaults(cfg),
    override: override ? { dailyRupees: override.daily_rupees, monthlyRupees: override.monthly_rupees, note: override.note, adminUid: override.admin_uid, updatedAt: override.updated_at } : null,
    effective: { daily: s.daily, monthly: s.monthly }, spentToday: s.spentToday, spentThisMonth: s.spentThisMonth, resetsAt: s.resetsAt,
  }, 200, NO_STORE);
}
const limitField = (v: unknown): number | null | undefined | "bad" => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_LIMIT_RUPEES ? v : "bad";
};
async function limitPut(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const b = await readJson(req);
  const d = limitField(b.dailyRupees), m = limitField(b.monthlyRupees);
  if (d === "bad") return err(400, "invalid_field", `dailyRupees must be a whole number from 0 to ${MAX_LIMIT_RUPEES}, or null.`, { field: "dailyRupees" });
  if (m === "bad") return err(400, "invalid_field", `monthlyRupees must be a whole number from 0 to ${MAX_LIMIT_RUPEES}, or null.`, { field: "monthlyRupees" });
  if (d === undefined && m === undefined) return err(400, "invalid_field", "Send dailyRupees and/or monthlyRupees.");
  const note = String(b.note ?? "").trim().slice(0, 200);
  if (!note) return err(400, "invalid_field", "Add a note saying why.", { field: "note" });
  if (!(await env.DB_META.prepare("SELECT 1 AS x FROM users WHERE uid=?1").bind(uid).first().catch(() => null))) return err(404, "not_found", "No such user.");
  const prior = await getOverride(env, uid);
  const nextDaily = d === undefined ? (prior?.daily_rupees ?? null) : d;
  const nextMonthly = m === undefined ? (prior?.monthly_rupees ?? null) : m;
  await setOverride(env, uid, a.uid, nextDaily, nextMonthly, note);
  await audit(env, a.uid, "spend_limit_set", uid, { daily: nextDaily, monthly: nextMonthly, was: { daily: prior?.daily_rupees ?? null, monthly: prior?.monthly_rupees ?? null }, note });
  return limitGet(req, env, uid);
}

// ── admin: reconciliation ────────────────────────────────────────────────────
async function reconciliation(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  if ("error" in range) return err(400, "invalid_range", range.error);
  const rep = await loadReconciliation(env, range.fromMs, range.toMs);
  await audit(env, a.uid, "reconciliation_viewed", `${rep.from}..${rep.to}`, { mismatches: rep.mismatches.length, csv: url.searchParams.get("format") === "csv" });
  if (url.searchParams.get("format") === "csv") {
    return new Response(reconciliationCsv(rep), {
      status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="hf-reconciliation-${rep.from}-to-${rep.to}.csv"`, "cache-control": "private, no-store" },
    });
  }
  return json({ ok: true, ...rep }, 200, NO_STORE);
}

/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfWalletLimitsRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method;
  try {
    if (p === "/api/hf/wallet/receipts" && m === "GET") return await receiptList(req, env);
    let x = p.match(/^\/api\/hf\/wallet\/receipts\/(hfr_[a-f0-9]{32})$/);
    if (x && m === "GET") return await receiptView(req, env, x[1]);
    x = p.match(/^\/api\/admin\/hf\/limits\/([^/]{1,128})$/);
    if (x && m === "GET") return await limitGet(req, env, decodeURIComponent(x[1]));
    if (x && m === "PUT") return await limitPut(req, env, decodeURIComponent(x[1]));
    if (p === "/api/admin/hf/reconciliation" && m === "GET") return await reconciliation(req, env);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: HF_CALL_APP, extra: { area: "hf_wallet_limits" } });
    return err(500, "internal_error", "Something went wrong.");
  }
}
