import type { Env } from "../types";
import { json } from "../util";
import { requireUser, requireStripeKyc, isFail } from "../authz";
import { walletOp } from "./wallet";
import { readConfig } from "./config";
import { requireAdminRole } from "./admin_dashboard";
import { sha256Hex } from "../util";
import { agreementAccepted, currentAgreementVersion } from "./kyc";

const AGREEMENT = "creator-agreement";
const VPA_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z]{2,32}$/;
const year = () => { const d = new Date(); const y = d.getUTCFullYear(); return `${d.getUTCMonth() >= 3 ? y : y - 1}-${String((d.getUTCMonth() >= 3 ? y + 1 : y)).slice(-2)}`; };
async function adminAudit(env: Env, admin: string, action: string, id: string, meta: any = {}) {
  await env.DB_WALLET.prepare("INSERT INTO admin_audit (id,admin_id,action,target,meta,created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(crypto.randomUUID(), admin, action, id, JSON.stringify(meta), Date.now()).run().catch(() => null);
}

export async function upiAccount(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = await req.json().catch(() => ({})) as any;
  const vpa = String(b.vpa || "").trim().toLowerCase();
  const holder = String(b.holder_name || "").trim();
  if (!VPA_RE.test(vpa) || !holder) return json({ error: "valid vpa and holder_name required" }, 400);
  const now = Date.now(); const cfg = await readConfig(env);
  const old = await env.DB_WALLET.prepare("SELECT id FROM upi_accounts WHERE uid=?1 AND status IN ('pending','verified')").bind(ctx.uid).first<any>();
  if (old) await env.DB_WALLET.prepare("UPDATE upi_accounts SET status='superseded', updated_at=?2 WHERE id=?1").bind(old.id, now).run();
  const id = crypto.randomUUID();
  await env.DB_WALLET.prepare(`INSERT INTO upi_accounts (id,uid,vpa,vpa_hash,holder_name,status,name_match,kyc_status,cooldown_until,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,'pending','unchecked','missing',?6,?7,?7)`)
    .bind(id, ctx.uid, vpa, await sha256Hex(vpa), holder, now + Number(cfg.upiVpaCooldownHours) * 3_600_000, now).run();
  return json({ ok: true, account_id: id, status: "pending", cooldown_until: now + Number(cfg.upiVpaCooldownHours) * 3_600_000 });
}

export async function upiAccountGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const r = await env.DB_WALLET.prepare("SELECT id,vpa,holder_name,status,name_match,kyc_status,cooldown_until FROM upi_accounts WHERE uid=?1 AND status IN ('pending','verified') ORDER BY created_at DESC LIMIT 1").bind(ctx.uid).first<any>();
  if (!r) return json({ account: null });
  const vpa = String(r.vpa); const at = vpa.indexOf("@");
  return json({ account: { ...r, vpa: `${vpa.slice(0, Math.min(3, at))}***${vpa.slice(at)}` } });
}

export async function upiPayoutQuote(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env); const b = new URL(req.url).searchParams; const coins = Math.trunc(Number(b.get("coins") || cfg.upiPayoutMinCoins));
  const bal = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
  return json({ coins, min_coins: cfg.upiPayoutMinCoins, available_coins: Number(bal.body?.balance || 0), gross_inr_paise: coins * 100, tds_inr_paise: null, net_inr_paise: null, tax_pending: true });
}

export async function upiPayoutRequest(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env); if (!cfg.upiPayoutEnabled) return json({ error: "upi payouts unavailable" }, 503);
  if (cfg.affiliatePayoutAllowlistOnly && !(env.AFFILIATE_PAYOUT_ALLOWLIST || "").split(",").map(s => s.trim()).includes(ctx.uid)) return json({ error: "payout allowlist only", reason: "allowlist_only" }, 403);
  const kyc = await requireStripeKyc(env, ctx.uid); if (kyc) return json({ error: kyc.error, reason: "stripe_kyc_required" }, kyc.status);
  if (!(await agreementAccepted(env, ctx.uid, AGREEMENT))) return json({ error: "agreement required", reason: "agreement_required", version: currentAgreementVersion(env, AGREEMENT) }, 403);
  const acct = await env.DB_WALLET.prepare("SELECT * FROM upi_accounts WHERE uid=?1 AND status IN ('pending','verified') ORDER BY created_at DESC LIMIT 1").bind(ctx.uid).first<any>();
  if (!acct) return json({ error: "upi account required" }, 400);
  if (Number(acct.cooldown_until) > Date.now()) return json({ error: "upi account cooling down" }, 403);
  if (acct.kyc_status !== "verified" || acct.name_match === "mismatch") return json({ error: "upi verification required" }, 403);
  const coins = Math.trunc(Number((await req.json().catch(() => ({})) as any).amount_coins));
  if (!(coins >= Number(cfg.upiPayoutMinCoins))) return json({ error: "minimum payout not met" }, 400);
  const id = crypto.randomUUID(); const ref = `upi_payout:${id}`; const now = Date.now(); const expires = now + Number(cfg.upiPayoutReservationTtlHours) * 3_600_000;
  await env.DB_WALLET.prepare(`INSERT INTO upi_payout_requests (id,uid,upi_account_id,gross_coins,gross_inr_paise,tds_inr_paise,net_inr_paise,tax_year,status,wallet_ref,reserve_expires_at,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,NULL,?5,?6,'created',?7,?8,?9,?9)`).bind(id, ctx.uid, acct.id, coins, coins * 100, year(), ref, expires, now).run();
  const r = await walletOp(env, ctx.uid, { op: "reserve", uid: ctx.uid, amount: coins, ref, allow_free: false, expires_at: expires, op_id: `upi_reserve:${id}`, app_name: "avapayout" });
  if (r.status !== 200) { await env.DB_WALLET.prepare("UPDATE upi_payout_requests SET status='failed',reject_reason=?2,updated_at=?3 WHERE id=?1").bind(id, String(r.body?.error || "reserve_failed"), Date.now()).run(); return json({ error: "insufficient paid balance" }, 402); }
  await env.DB_WALLET.prepare("UPDATE upi_payout_requests SET status='reserved',updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
  return json({ ok: true, payout_id: id, status: "reserved", gross_inr_paise: coins * 100 });
}

export async function upiPayoutRequests(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const r = await env.DB_WALLET.prepare("SELECT id,gross_coins,gross_inr_paise,tds_inr_paise,net_inr_paise,status,utr,created_at,updated_at FROM upi_payout_requests WHERE uid=?1 ORDER BY created_at DESC LIMIT 50").bind(ctx.uid).all();
  return json({ requests: r.results ?? [] });
}

export async function adminUpiPayouts(req: Request, env: Env): Promise<Response> {
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  const r = await env.DB_WALLET.prepare("SELECT r.*,a.vpa,a.holder_name FROM upi_payout_requests r JOIN upi_accounts a ON a.id=r.upi_account_id WHERE r.status IN ('reserved','approved','needs_reconciliation','paid') ORDER BY r.created_at ASC LIMIT 200").all();
  return json({ requests: r.results ?? [] });
}
export async function adminUpiAccountVerify(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  const r = await env.DB_WALLET.prepare("UPDATE upi_accounts SET status='verified',name_match='manual_ok',kyc_status='verified',updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
  if (!(r.meta?.changes ?? 0)) return json({ error: "not found" }, 404);
  await adminAudit(env, a.uid, "upi_account_verified", id, {});
  return json({ ok: true, status: "verified" });
}

async function adminPayout(req: Request, env: Env, id: string, action: "approve"|"reject"|"paid"|"reconcile"): Promise<Response> {
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  const row = await env.DB_WALLET.prepare("SELECT * FROM upi_payout_requests WHERE id=?1").bind(id).first<any>(); if (!row) return json({ error: "not found" }, 404);
  const b = await req.json().catch(() => ({})) as any; const now = Date.now();
  if (action === "approve") { if (row.status !== "reserved") return json({ error: "invalid state" }, 409); await env.DB_WALLET.prepare("UPDATE upi_payout_requests SET status='approved',admin_uid=?2,updated_at=?3 WHERE id=?1").bind(id,a.uid,now).run(); await adminAudit(env,a.uid,"upi_payout_approved",id,{}); return json({ ok:true,status:"approved" }); }
  if (action === "reject") { if (!["reserved","approved"].includes(row.status)) return json({ error:"invalid state" },409); const r=await walletOp(env,row.uid,{op:"release_reservation",uid:row.uid,ref:row.wallet_ref,op_id:`upi_release:${id}`,app_name:"avapayout"}); if(r.status!==200)return json({error:"release failed"},502); await env.DB_WALLET.prepare("UPDATE upi_payout_requests SET status='released',admin_uid=?2,reject_reason=?3,updated_at=?4 WHERE id=?1").bind(id,a.uid,String(b.reason||"rejected"),now).run(); await adminAudit(env,a.uid,"upi_payout_rejected",id,{reason:String(b.reason||"")}); return json({ok:true,status:"released"}); }
  if (action === "paid") { if (row.status !== "approved" || !String(b.utr||"")) return json({error:"approved payout and utr required"},400); const r=await walletOp(env,row.uid,{op:"consume_reserved",uid:row.uid,amount:row.gross_coins,ref:row.wallet_ref,allow_free:false,type:"payout",app_name:"avapayout",op_id:`upi_consume:${id}`,ledger:{debit:`user:${row.uid}`,credit:"external:payout",type:"payout",ref:row.wallet_ref}}); if(r.status!==200 || Number(r.body?.consumed||0)!==row.gross_coins){await env.DB_WALLET.prepare("UPDATE upi_payout_requests SET status='needs_reconciliation',utr=?2,updated_at=?3 WHERE id=?1").bind(id,String(b.utr),now).run();return json({error:"needs reconciliation"},409);} await env.DB_WALLET.prepare("UPDATE upi_payout_requests SET status='paid',utr=?2,admin_uid=?3,updated_at=?4 WHERE id=?1").bind(id,String(b.utr),a.uid,now).run(); await adminAudit(env,a.uid,"upi_payout_marked_paid",id,{utr:String(b.utr)}); return json({ok:true,status:"paid"}); }
  if (action === "reconcile") { if (row.status !== "paid" || !String(b.bank_ref||"")) return json({error:"paid payout and bank_ref required"},400); await env.DB_WALLET.prepare("UPDATE upi_payout_requests SET status='reconciled',bank_ref=?2,reconciled_at=?3,updated_at=?3 WHERE id=?1").bind(id,String(b.bank_ref),now).run(); return json({ok:true,status:"reconciled"}); }
  return json({ error:"unsupported" },400);
}
export const adminUpiApprove=(r:Request,e:Env,id:string)=>adminPayout(r,e,id,"approve");
export const adminUpiReject=(r:Request,e:Env,id:string)=>adminPayout(r,e,id,"reject");
export const adminUpiPaid=(r:Request,e:Env,id:string)=>adminPayout(r,e,id,"paid");
export const adminUpiReconcile=(r:Request,e:Env,id:string)=>adminPayout(r,e,id,"reconcile");
