// Money ops console (Phase 2, audit item A2). Admin = uid in ADMIN_UIDS (same
// gate as /api/admin/config). EVERY action is audit-logged to admin_audit.
//
//   GET  /api/admin/ledger?user=&ref=&limit=     search any user's ledger
//   POST /api/admin/refund  {orderId, amount, reason, userId?}   standard refund() primitive
//   POST /api/admin/adjust  {account, amount, reason}            'adjustment' rows only
//   GET  /api/admin/account/:userId              balance, holds, KYC, strikes, recent rows
//   POST /api/admin/escrow/hold    {userId, orderId, amount, title?}   (testing)
//   POST /api/admin/escrow/release {orderId, creatorId, title?}        (testing)
//   GET  /api/admin/recon                        recent reconciliation runs
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { hold, release, refund, adjust, acctUser, escrowBalance } from "../ledger";
import { walletOp } from "./wallet";
import { reverseAffiliate } from "./affiliate";

export async function requireAdmin(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const admins = (env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(ctx.uid)) return json({ error: "admin only" }, 403);
  return { uid: ctx.uid };
}

async function audit(env: Env, adminId: string, action: string, target: string | null, meta: object): Promise<void> {
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), adminId, action, target, JSON.stringify(meta), Date.now()).run();
  } catch { /* audit must not block, but log */ console.error("[admin_audit] write failed", action); }
}

// GET /api/admin/ledger?user=&ref=&limit=
export async function adminLedger(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url);
  const user = (u.searchParams.get("user") || "").trim();
  const ref = (u.searchParams.get("ref") || "").trim();
  const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") || 100)));
  if (!user && !ref) return json({ error: "user or ref required" }, 400);

  const where: string[] = []; const binds: unknown[] = []; let i = 1;
  if (user) { where.push(`(debit=?${i} OR credit=?${i})`); binds.push(acctUser(user)); i++; }
  if (ref) { where.push(`ref=?${i++}`); binds.push(ref); }
  const rs = await env.DB_WALLET.prepare(
    `SELECT id, debit, credit, amount, type, ref, meta, created_at FROM wallet_ledger WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).bind(...binds).all();
  await audit(env, a.uid, "ledger_search", user || ref, { user, ref, n: (rs.results ?? []).length });
  return json({ entries: rs.results ?? [] });
}

// POST /api/admin/refund {orderId, amount, reason, userId?}
export async function adminRefund(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as any;
  const orderId = String(b.orderId || ""); const amount = Math.trunc(Number(b.amount));
  const reason = String(b.reason || "").trim();
  if (!orderId || !(amount > 0) || !reason) return json({ error: "orderId, amount>0, reason required" }, 400);

  // Buyer defaults to the debit side of the order's purchase_hold row.
  let uid = String(b.userId || "");
  if (!uid) {
    const h = await env.DB_WALLET.prepare(
      "SELECT debit FROM wallet_ledger WHERE ref=?1 AND type='purchase_hold' ORDER BY created_at ASC LIMIT 1",
    ).bind(orderId).first<{ debit: string }>();
    if (!h?.debit?.startsWith("user:")) return json({ error: "no purchase_hold found for orderId; pass userId" }, 404);
    uid = h.debit.slice(5);
  }
  const opId = crypto.randomUUID().slice(0, 8);
  const r = await refund(env, orderId, uid, amount, { opId: `refund:${orderId}:${opId}`, reason: `admin: ${reason}` });
  // AvaAffiliate (§6 reversal mirror): a post-settlement refund claws back the
  // commission proportionally (status → 'reversed'). Best-effort, idempotent.
  let affClawed = 0;
  if (r.ok) affClawed = await reverseAffiliate(env, orderId, amount, `admin: ${reason}`, opId);
  await audit(env, a.uid, "refund", orderId, { uid, amount, reason, ok: r.ok, affiliate_clawed: affClawed });
  return json(r.body, r.status);
}

// POST /api/admin/adjust {account, amount, reason} — adjustment rows only,
// applied through WalletDO + ledger (never D1-only).
export async function adminAdjust(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as any;
  const account = String(b.account || "").replace(/^user:/, "");
  const amount = Math.trunc(Number(b.amount));
  const reason = String(b.reason || "").trim();
  if (!account || !amount || !reason) return json({ error: "account, non-zero amount, reason required" }, 400);
  const opId = `adj:${crypto.randomUUID()}`;
  const r = await adjust(env, account, amount, reason, a.uid, opId);
  await audit(env, a.uid, "adjust", account, { amount, reason, op_id: opId, ok: r.ok });
  return json(r.body, r.status);
}

// GET /api/admin/account/:userId — balance (live from DO), holds, KYC, strikes, recent orders.
export async function adminAccount(req: Request, env: Env, userId: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const bal = await walletOp(env, userId, { op: "balance", uid: userId });
  const [kyc, strikes, recent] = await Promise.all([
    env.DB_META.prepare("SELECT status FROM kyc_status WHERE uid=?1").bind(userId).first<{ status: string }>().catch(() => null),
    env.DB_META.prepare("SELECT COUNT(*) AS n FROM strikes WHERE uid=?1").bind(userId).first<{ n: number }>().catch(() => null),
    env.DB_WALLET.prepare(
      "SELECT id, debit, credit, amount, type, ref, created_at FROM wallet_ledger WHERE debit=?1 OR credit=?1 ORDER BY created_at DESC LIMIT 25",
    ).bind(acctUser(userId)).all(),
  ]);
  await audit(env, a.uid, "account_view", userId, {});
  return json({
    uid: userId,
    balance: bal.body?.balance ?? null, held: bal.body?.held ?? null,
    kyc: kyc?.status ?? "none", strikes: strikes?.n ?? 0,
    recent: recent.results ?? [],
  });
}

// POST /api/admin/escrow/hold + /release — the escrow primitives over admin HTTP (testing).
export async function adminEscrowHold(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.userId || !b.orderId || !(Number(b.amount) > 0)) return json({ error: "userId, orderId, amount>0 required" }, 400);
  const r = await hold(env, String(b.userId), String(b.orderId), Number(b.amount), { title: b.title, opId: b.opId });
  await audit(env, a.uid, "escrow_hold", String(b.orderId), { uid: b.userId, amount: b.amount, ok: r.ok });
  return json(r.body, r.status);
}

export async function adminEscrowRelease(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.orderId || !b.creatorId) return json({ error: "orderId, creatorId required" }, 400);
  const r = await release(env, String(b.orderId), String(b.creatorId), { title: b.title });
  await audit(env, a.uid, "escrow_release", String(b.orderId), { creator: b.creatorId, ok: r.ok });
  return json(r.body, r.status);
}

// GET /api/admin/tax-export?year=YYYY — Phase 3 A1: CSV of creator payout
// earnings for year-end reporting (1099-K / DAC7). One row per creator per
// currency: settled (completed) withdrawals joined with the tax data captured
// at payout setup. Reconciles against settled ledger totals.
export async function adminTaxExport(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const year = Number(new URL(req.url).searchParams.get("year") || new Date().getUTCFullYear());
  if (!(year >= 2020 && year <= 2100)) return json({ error: "valid year required" }, 400);
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);

  const rs = await env.DB_WALLET.prepare(
    `SELECT r.uid, r.target_currency,
            COUNT(*) AS payouts, SUM(r.amount_coins) AS total_coins, SUM(r.amount_cents) AS total_cents,
            MAX(a2.tax_country) AS tax_country, MAX(a2.tax_id_type) AS tax_id_type,
            MAX(a2.tax_id_last4) AS tax_id_last4, MAX(a2.tax_form_status) AS tax_form_status
       FROM payout_requests r LEFT JOIN payout_accounts a2 ON a2.id = r.account_id
      WHERE r.status='completed' AND r.created_at >= ?1 AND r.created_at < ?2
      GROUP BY r.uid, r.target_currency ORDER BY total_cents DESC`,
  ).bind(from, to).all();

  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = "uid,target_currency,payouts,total_coins,total_usd,tax_country,tax_id_type,tax_id_last4,tax_form_status";
  const rows = (rs.results ?? []).map((r: any) =>
    [r.uid, r.target_currency, r.payouts, r.total_coins, (Number(r.total_cents) / 100).toFixed(2),
     r.tax_country, r.tax_id_type, r.tax_id_last4, r.tax_form_status].map(esc).join(","));
  await audit(env, a.uid, "tax_export", String(year), { rows: rows.length });
  return new Response([header, ...rows].join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="avatok-tax-${year}.csv"` },
  });
}

// GET /api/admin/recon — recent reconciliation runs (+ live escrow spot-check via ?order=).
export async function adminRecon(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const order = new URL(req.url).searchParams.get("order");
  const runs = await env.DB_WALLET.prepare("SELECT date, ok, diff_json, created_at FROM recon_runs ORDER BY date DESC LIMIT 30").all().catch(() => ({ results: [] as any[] }));
  const spot = order ? { order, escrow_balance: await escrowBalance(env, order) } : null;
  return json({ runs: runs.results ?? [], spot });
}

// ---------------------------------------------------------------------------
// Phase 7 — DLQ console: list dead-lettered settlement jobs + manual retry.
// A retry re-enqueues the ORIGINAL payload to Q_MONEY; the engine's op_id
// dedupe guarantees no double-settle even if the job half-ran before dying.
// ---------------------------------------------------------------------------

// GET /api/admin/settlements?status=failed
export async function adminFailedSettlements(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const status = new URL(req.url).searchParams.get("status") || "failed";
  const rs = await env.DB_WALLET.prepare(
    "SELECT id, payload, error, created_at, retried_at, status FROM failed_settlements WHERE status=?1 ORDER BY created_at DESC LIMIT 100",
  ).bind(status).all().catch(() => ({ results: [] as any[] }));
  return json({ settlements: rs.results ?? [] });
}

// POST /api/admin/settlements/:id/retry
export async function adminRetrySettlement(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const row = await env.DB_WALLET.prepare("SELECT id, payload, status FROM failed_settlements WHERE id=?1").bind(id).first<any>();
  if (!row) return json({ error: "not found" }, 404);
  let payload: any; try { payload = JSON.parse(String(row.payload)); } catch { return json({ error: "unparseable payload" }, 422); }
  await env.Q_MONEY.send(payload);
  await env.DB_WALLET.prepare("UPDATE failed_settlements SET status='retried', retried_at=?2 WHERE id=?1").bind(id, Date.now()).run();
  await audit(env, a.uid, "settlement_retry", id, { payload });
  return json({ ok: true, requeued: payload });
}
