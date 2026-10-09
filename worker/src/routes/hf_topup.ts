// [HF-TOPUP-1] HF wallet top-up, gateway-agnostic. Spec: Specs/HF-WALLET-TOPUP.md. Dark behind hfTopupEnabled + hfTopupGateway.
//   POST /api/hf/wallet/topup {amount}                    -> {ok, topupId, gateway, client_payload, testMode, amountRupees}   503 topup_unavailable when off
//   GET  /api/hf/wallet/topup/:id                         -> {ok, id, status, credited, amountRupees}   (owner only; re-asks the gateway while still 'created')
//   POST /api/hf/wallet/topup/webhook/:gateway            -> signed by the gateway (raw body verified first); credits exactly once
//   GET  /api/admin/hf/topups?status=&limit=&offset=      POST /api/admin/hf/topups/:id/reconcile
// HF top-up has its OWN switch. MONEY_IN_DISABLED (money.ts) and PERMANENTLY_DISABLED_PAYMENT_FLAGS (config.ts) gate the retired
// main-app rails only and are intentionally NOT consulted here; the main-app gateway flags (razorpayEnabled etc.) stay forced off.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit, withIdempotency, RL } from "../money";
import { trackException } from "../hooks";
import { isAdminUid } from "../lib/preview";
import { readConfig } from "./config";
import { BRAND } from "../lib/brand";
import { resolveGateway } from "../lib/payments/registry";
import { hfTopupFlags, hfTopupLive } from "../lib/hf_topup_config";
import { isClosing, CLOSING_MESSAGE } from "../lib/hf_exit"; // [HF-WALLET-EXIT-1]
import {
  newTopupId, getTopup, isHfTopupId, reconcileHfTopup, settleParsedWebhook, type HfTopupRow,
} from "../lib/hf_topup";

const APP = "hf_topup";
const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);
const UNAVAILABLE = () => json({ error: "topup_unavailable", reason: "topup_unavailable", message: "Adding money opens soon." }, 503);
const POLL_GAP_MS = 4000;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 4000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

async function createTopup(req: Request, env: Env): Promise<Response> {
  const cfg = await readConfig(env).catch(() => null);
  if (!cfg) return UNAVAILABLE();
  const flags = hfTopupFlags(cfg as never);
  const live = hfTopupLive(env, flags);
  if (!live.live) return UNAVAILABLE();
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  const adapter = resolveGateway(flags.gateway);
  if (!adapter) return UNAVAILABLE();
  // [HF-WALLET-EXIT-1] No new money in while the account is being closed (it would only have to be paid straight back out).
  if (await isClosing(env, u.uid)) return err(409, "account_closing", CLOSING_MESSAGE, { reason: "account_closing" });

  return withIdempotency(req, env, u.uid, async () => {
    const b = await readJson(req);
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount < flags.minRupees || amount > flags.maxRupees) {
      return err(400, "bad_amount", `Enter a whole amount between ₹${flags.minRupees} and ₹${flags.maxRupees}.`, { min: flags.minRupees, max: flags.maxRupees });
    }
    const limited = await rateLimit(env, `hftopup:${u.uid}`, RL.topup.max, RL.topup.windowSec);
    if (limited) return limited;

    const id = newTopupId();
    const now = Date.now();
    await env.DB_META.prepare(
      "INSERT INTO hf_topups (id, uid, amount_rupees, gateway, status, credited, created_at, updated_at) VALUES (?1,?2,?3,?4,'created',0,?5,?5)",
    ).bind(id, u.uid, amount, adapter.id, now).run();

    const order = await adapter.createOrder(env, { orderId: id, amountPaise: amount * 100, currency: "INR", uid: u.uid, listingId: "", kind: "wallet_topup" });
    if ("error" in order) {
      await env.DB_META.prepare("UPDATE hf_topups SET status='failed', raw_status=?2, updated_at=?3 WHERE id=?1").bind(id, order.error.slice(0, 80), Date.now()).run();
      return err(502, "gateway_error", "We could not start the payment. Please try again in a moment.");
    }
    await env.DB_META.prepare("UPDATE hf_topups SET gateway_order_id=?2, updated_at=?3 WHERE id=?1").bind(id, order.gateway_order_id, Date.now()).run();
    return json({ ok: true, topupId: id, gateway: adapter.id, client_payload: order.client_payload, testMode: live.testMode, amountRupees: amount });
  });
}

const publicRow = (r: HfTopupRow) => ({ ok: true, id: r.id, status: r.status, credited: r.credited === 1, amountRupees: r.amount_rupees, gateway: r.gateway });

async function topupStatus(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  let row = await getTopup(env, id);
  if (!row || row.uid !== u.uid) return err(404, "not_found", "Top-up not found.");
  if (row.status === "created" && row.gateway_order_id && Date.now() - row.updated_at > POLL_GAP_MS) {
    const adapter = resolveGateway(row.gateway);
    if (adapter?.configured(env)) {
      try { await reconcileHfTopup(env, adapter, row); } catch (e) { await trackException(env, e, { uid: u.uid, route: "hf_topup.poll", handled: true, app_name: APP }); }
      row = (await getTopup(env, id)) ?? row;
    }
  }
  return json(publicRow(row));
}

async function topupWebhook(req: Request, env: Env, gateway: string): Promise<Response> {
  const adapter = resolveGateway(gateway);
  if (!adapter) return json({ error: "unknown gateway" }, 404);
  if (!adapter.configured(env)) return json({ error: "unconfigured" }, 503);
  const raw = await req.text();
  let verified = false;
  try { verified = await adapter.verifyWebhook(env, raw, req.headers); } catch (e) {
    await trackException(env, e, { route: `/api/hf/wallet/topup/webhook/${gateway}`, method: "POST", handled: true, app_name: APP });
  }
  if (!verified) return json({ error: "bad signature" }, 401);
  const parsed = adapter.parseWebhook(raw);
  let res: Response;
  if (!parsed || !isHfTopupId(parsed.our_order_id)) res = json({ ok: true, ignored: "not_a_topup" });
  else res = await settleParsedWebhook(env, adapter, parsed);
  // Some gateways (Paytm's hosted page) deliver by redirecting the buyer's browser with a form POST.
  if ((req.headers.get("content-type") ?? "").toLowerCase().includes("application/x-www-form-urlencoded") && res.status < 500) {
    const to = new URL(`${BRAND.webOrigin}/wallet`);
    if (parsed && isHfTopupId(parsed.our_order_id)) to.searchParams.set("topup", parsed.our_order_id);
    return new Response(null, { status: 303, headers: { location: to.toString() } });
  }
  return res;
}

// ── admin ────────────────────────────────────────────────────────────────────
async function adminCtx(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error, u.error);
  if (!isAdminUid(env, u.uid)) return err(403, "forbidden", "Forbidden.");
  return { uid: u.uid };
}

async function adminList(req: Request, env: Env): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const q = new URL(req.url).searchParams;
  const status = q.get("status") ?? "";
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(q.get("limit") ?? 50)) || 50));
  const offset = Math.max(0, Math.trunc(Number(q.get("offset") ?? 0)) || 0);
  const where = ["created", "paid", "failed", "refunded", "expired"].includes(status) ? "WHERE status=?1" : "";
  const sql = `SELECT id,uid,amount_rupees,gateway,gateway_order_id,status,credited,raw_status,gateway_payment_id,created_at,updated_at,paid_at FROM hf_topups ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const st = env.DB_META.prepare(sql);
  const rows = (await (where ? st.bind(status) : st).all<HfTopupRow>()).results ?? [];
  const f = hfTopupFlags((await readConfig(env).catch(() => ({}))) as never);
  return json({ ok: true, topups: rows, flags: { enabled: f.enabled, gateway: f.gateway, live: hfTopupLive(env, f).live } });
}

async function adminReconcile(req: Request, env: Env, id: string): Promise<Response> {
  const a = await adminCtx(req, env);
  if (a instanceof Response) return a;
  const row = await getTopup(env, id);
  if (!row) return err(404, "not_found", "Top-up not found.");
  const adapter = resolveGateway(row.gateway);
  if (!adapter || !adapter.configured(env)) return err(409, "gateway_unconfigured", "That gateway has no keys set.");
  const out = await reconcileHfTopup(env, adapter, row);
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), a.uid, "hf_topup_reconcile", id, JSON.stringify({ result: out.result }), Date.now()).run();
  } catch { /* audit is best-effort */ }
  const fresh = (await getTopup(env, id)) ?? row;
  return json({ ...publicRow(fresh), result: out.result, reason: "reason" in out ? out.reason : undefined });
}

export async function hfTopupRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method;
  try {
    if (p === "/api/hf/wallet/topup" && m === "POST") return await createTopup(req, env);
    let x = p.match(/^\/api\/hf\/wallet\/topup\/webhook\/([a-z_]+)$/);
    if (x && m === "POST") return await topupWebhook(req, env, x[1]);
    x = p.match(/^\/api\/hf\/wallet\/topup\/(hftop_[a-f0-9]{24})$/);
    if (x && m === "GET") return await topupStatus(req, env, x[1]);
    if (p === "/api/admin/hf/topups" && m === "GET") return await adminList(req, env);
    x = p.match(/^\/api\/admin\/hf\/topups\/(hftop_[a-f0-9]{24})\/reconcile$/);
    if (x && m === "POST") return await adminReconcile(req, env, x[1]);
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_topup" } });
    return err(500, "internal_error", "Something went wrong.");
  }
}
