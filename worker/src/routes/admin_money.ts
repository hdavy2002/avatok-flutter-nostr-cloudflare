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

async function requireAdmin(req: Request, env: Env): Promise<{ uid: string } | Response> {
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
  const r = await refund(env, orderId, uid, amount, { opId: `refund:${orderId}:${crypto.randomUUID().slice(0, 8)}`, reason: `admin: ${reason}` });
  await audit(env, a.uid, "refund", orderId, { uid, amount, reason, ok: r.ok });
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

// GET /api/admin/recon — recent reconciliation runs (+ live escrow spot-check via ?order=).
export async function adminRecon(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const order = new URL(req.url).searchParams.get("order");
  const runs = await env.DB_WALLET.prepare("SELECT date, ok, diff_json, created_at FROM recon_runs ORDER BY date DESC LIMIT 30").all().catch(() => ({ results: [] as any[] }));
  const spot = order ? { order, escrow_balance: await escrowBalance(env, order) } : null;
  return json({ runs: runs.results ?? [], spot });
}
