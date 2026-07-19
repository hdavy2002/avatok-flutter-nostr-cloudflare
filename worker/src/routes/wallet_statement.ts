// [WALLET-COCKPIT-1] Cockpit wallet read APIs (Phase 2 of the 2026-07-19 master
// plan). The owner's ask: "full overview of where the user's money went and how
// much he earned." Two read-only endpoints, both scoped strictly to the authed
// user:
//
//   GET /api/wallet/statement?cursor=&limit=&direction=&from=&to=&q=
//     Human-labeled transaction feed read from wallet_transactions (the
//     user-facing audit store the WalletDO writes via Q_WALLET) — NOT the
//     double-entry wallet_ledger, which stays the recon/audit layer.
//
//   GET /api/wallet/summary?days=30
//     Aggregates for the cockpit instruments: totals earned/spent, per-feature
//     spend breakdown, earn sources, burn/day, runway, receptionist minutes.
//
// call_cost_ledger is INTERNAL: only the aggregate minutes for THIS uid are
// read here; actual_api_cost_inr is never selected and never leaves the server.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track } from "../hooks";
import { walletOp } from "./wallet";
import { metaDb } from "../db/shard";

// Human labels per app_name/feature key. Spends carry the chargeFeature key in
// app_name (feature_pricing.ts); earns carry the marketplace app. A key missing
// here falls back to a titleized form — never a raw snake_case string in the UI.
const FEATURE_LABELS: Record<string, string> = {
  // AI feature spends (FEATURE_COSTS keys land in app_name via chargeFeature)
  ava_receptionist_call: "AI Receptionist call",
  ava_receptionist_minute: "AI Receptionist",
  ava_voicemail: "Voicemail",
  ava_chat: "Ava chat",
  ava_memory: "Ava memory search",
  ava_image_free: "AI image",
  ava_image_generate: "AI image",
  ava_voice_reply: "Ava voice reply",
  ava_vision_snapshot: "Vision snapshot",
  ava_mcp_tool: "Connected-app action",
  guardian_always_on: "Guardian monitoring",
  // [TEL-TIERS-1] Telephony subscription tiers (telephony_tiers.ts) — monthly
  // chargeAmount spends; the featureKey lands in app_name like every spend.
  telephony_tier1: "Phone line — Tier 1",
  telephony_tier2: "Phone line — Tier 2",
  telephony_addon: "Extra phone channel",
  listing_post: "Marketplace listing",
  listing_post_connect: "Connect listing",
  // marketplace / app-level rows
  avaolx: "Marketplace sale",
  avalive: "AvaLive",
  avachat: "Paid chat",
  avacal: "Booking",
  avacalendar: "Booking",
  avavoice: "Voice consult",
  avavision: "Vision consult",
  translate: "Translation",
  avawallet: "Wallet",
  avapayout: "Payout",
  escrow: "Escrow",
  admin: "Adjustment",
  call_billing: "Paid call",
};

function titleize(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  if (!words) return "Other";
  return words.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Direction bucket for a wallet_transactions row (type first, sign fallback). */
function directionFor(type: string, amount: number): string {
  switch (type) {
    case "spend": return "spend";
    case "earn": case "donation": case "gift": case "hold_release": return "earn";
    case "topup": return "topup";
    case "payout": return "payout";
    case "refund": return "refund";
    default: return amount < 0 ? "spend" : "other";
  }
}

/** Human label for a row: direction-specific first, then the app/feature map. */
function labelFor(type: string, app: string | null, amount: number): string {
  const dir = directionFor(type, amount);
  if (dir === "topup") return "Top-up";
  if (dir === "payout") return "Payout";
  if (dir === "refund") return "Refund";
  if (type === "donation") return "Gift received";
  const key = (app || "").trim();
  if (!key) return dir === "earn" ? "Marketplace sale" : "Other";
  const mapped = FEATURE_LABELS[key];
  if (mapped) return dir === "earn" && key === "avaolx" ? "Marketplace sale" : mapped;
  return titleize(key);
}

// Keyset cursor on (created_at, id) — same idiom as walletLedger.
function decodeCursor(c: string | null): { t: number; id: string } | null {
  if (!c) return null;
  try {
    const [t, ...rest] = atob(c).split(":");
    return { t: Number(t), id: rest.join(":") };
  } catch { return null; }
}
const encodeCursor = (t: number, id: string) => btoa(`${t}:${id}`);

// Map a requested direction to the wallet_transactions types it covers.
const DIRECTION_TYPES: Record<string, string[]> = {
  spend: ["spend"],
  earn: ["earn", "donation", "gift", "hold_release"],
  topup: ["topup"],
  payout: ["payout"],
  refund: ["refund"],
};

// GET /api/wallet/statement?cursor=&limit=50&direction=&from=&to=&q=
// Newest-first, keyset-paginated, strictly the authed user's rows.
export async function walletStatement(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") || 50)));
  const cur = decodeCursor(u.searchParams.get("cursor"));
  const direction = (u.searchParams.get("direction") || "").trim();
  const from = Number(u.searchParams.get("from") || 0);
  const to = Number(u.searchParams.get("to") || 0);
  const q = (u.searchParams.get("q") || "").trim();

  const where: string[] = ["uid=?1"];
  const binds: unknown[] = [ctx.uid];
  let i = 2;
  if (cur) { where.push(`(created_at < ?${i} OR (created_at = ?${i} AND id < ?${i + 1}))`); binds.push(cur.t, cur.id); i += 2; }
  const dirTypes = DIRECTION_TYPES[direction];
  if (dirTypes) { where.push(`type IN (${dirTypes.map(() => `?${i++}`).join(",")})`); binds.push(...dirTypes); }
  if (from > 0) { where.push(`created_at >= ?${i++}`); binds.push(from); }
  if (to > 0) { where.push(`created_at <= ?${i++}`); binds.push(to); }
  if (q) { where.push(`(ref LIKE ?${i} OR app_name LIKE ?${i})`); binds.push(`%${q}%`); i++; }

  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    `SELECT id, type, amount, balance_after, app_name, ref, created_at FROM wallet_transactions
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  const entries = page.map((r) => {
    const amount = Number(r.amount);
    const type = String(r.type || "");
    const app = r.app_name ? String(r.app_name) : null;
    const out: any = {
      id: String(r.id),
      ts: Number(r.created_at),
      type,
      direction: directionFor(type, amount),
      feature_key: app,
      label: labelFor(type, app, amount),
      tokens: amount, // already signed: +credit / -debit
      ref: r.ref ?? null,
    };
    if (r.balance_after != null) out.balance_after = Number(r.balance_after);
    return out;
  });
  track(env, ctx.uid, "wallet_statement_viewed", "avawallet", { n: entries.length, direction: direction || "all", filtered: !!(dirTypes || from || to || q) });
  return json({
    entries,
    cursor: rows.length > limit && last ? encodeCursor(Number(last.created_at), String(last.id)) : null,
  });
}

// GET /api/wallet/summary?days=30 — cockpit instrument aggregates. Balance is
// read live from the WalletDO (the authority); the window aggregates come from
// wallet_transactions; receptionist minutes come from call_cost_ledger as an
// AGGREGATE for this uid only (actual_api_cost_inr stays internal).
export async function walletSummary(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);
  const days = Math.min(365, Math.max(1, Math.trunc(Number(u.searchParams.get("days") || 30)) || 30));
  const since = Date.now() - days * 86_400_000;

  const bal = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
  const balance = Number(bal.body?.balance ?? 0);
  const spendable = Number(bal.body?.spendable ?? balance);
  const held = Number(bal.body?.held ?? 0);
  const free = Number(bal.body?.free ?? 0);

  const db = env.DB_WALLET.withSession("first-unconstrained");
  const earnTypes = "('earn','donation','gift','hold_release')";
  const spends = await db.prepare(
    `SELECT COALESCE(app_name,'') AS app, COALESCE(SUM(-amount),0) AS tokens, COUNT(*) AS n
     FROM wallet_transactions WHERE uid=?1 AND created_at>=?2 AND type='spend' AND amount<0
     GROUP BY COALESCE(app_name,'') ORDER BY tokens DESC LIMIT 40`,
  ).bind(ctx.uid, since).all();
  const earns = await db.prepare(
    `SELECT COALESCE(app_name,'') AS app, COALESCE(SUM(amount),0) AS tokens, COUNT(*) AS n
     FROM wallet_transactions WHERE uid=?1 AND created_at>=?2 AND type IN ${earnTypes} AND amount>0
     GROUP BY COALESCE(app_name,'') ORDER BY tokens DESC LIMIT 40`,
  ).bind(ctx.uid, since).all();
  const topups = await db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS t FROM wallet_transactions WHERE uid=?1 AND created_at>=?2 AND type='topup' AND amount>0",
  ).bind(ctx.uid, since).first<{ t: number }>();
  const payouts = await db.prepare(
    "SELECT COALESCE(SUM(-amount),0) AS t FROM wallet_transactions WHERE uid=?1 AND created_at>=?2 AND type='payout' AND amount<0",
  ).bind(ctx.uid, since).first<{ t: number }>();

  const byFeature = ((spends.results ?? []) as any[]).map((r) => ({
    feature_key: String(r.app || "") || null,
    label: labelFor("spend", String(r.app || "") || null, -1),
    tokens: Number(r.tokens),
    count: Number(r.n),
  }));
  const earnSources = ((earns.results ?? []) as any[]).map((r) => ({
    feature_key: String(r.app || "") || null,
    label: labelFor("earn", String(r.app || "") || null, 1),
    tokens: Number(r.tokens),
    count: Number(r.n),
  }));

  const spentTotal = byFeature.reduce((s, f) => s + f.tokens, 0);
  const earnedTotal = earnSources.reduce((s, f) => s + f.tokens, 0);
  const burnPerDay = Math.round((spentTotal / days) * 100) / 100;
  const runwayDays = burnPerDay > 0 ? Math.floor(spendable / burnPerDay) : null;

  // Receptionist minutes: aggregate seconds for THIS uid only. The table lives
  // in DB_META and is created lazily by ReceptionRoom — tolerate its absence.
  let minutesUsed = 0;
  let aiCalls = 0;
  try {
    const m = await metaDb(env).prepare(
      "SELECT COALESCE(SUM(duration_seconds),0) AS s, COUNT(*) AS n FROM call_cost_ledger WHERE user_id=?1 AND end_ts>=?2",
    ).bind(ctx.uid, since).first<{ s: number; n: number }>();
    minutesUsed = Math.round(Number(m?.s ?? 0) / 60);
    aiCalls = Number(m?.n ?? 0);
  } catch { /* table not created yet — zero minutes */ }

  track(env, ctx.uid, "wallet_summary_viewed", "avawallet", {
    days, spent_total: spentTotal, earned_total: earnedTotal, features: byFeature.length,
  });
  return json({
    days,
    balance,
    spendable,
    held,
    free,
    earned_total: earnedTotal,
    spent_total: spentTotal,
    net: earnedTotal - spentTotal,
    topups_total: Number(topups?.t ?? 0),
    payouts_total: Number(payouts?.t ?? 0),
    burn_per_day: burnPerDay,
    runway_days: runwayDays,
    minutes_used: minutesUsed,
    ai_calls: aiCalls,
    by_feature: byFeature,
    earn_sources: earnSources,
  });
}
