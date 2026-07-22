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
import { getUsdRate } from "../lib/fx_rates";

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
  // [WELCOME-100-1] 100-token signup bonus (routes/welcome_bonus.ts; type=promo)
  welcome_bonus: "Welcome bonus",
};

// [WALLET-REDESIGN-1] Feature key → coarse category for the redesigned wallet
// screen's grouped spend rings. Eight buckets only; the screen renders one card
// per category, so every feature key MUST land in exactly one of them. Unlisted
// keys fall back in categoryFor(): `ava_*` → agent, everything else → market.
const FEATURE_CATEGORIES: Record<string, string> = {
  // call — anything that is a phone call / phone line
  call_billing: "call",
  telephony_tier1: "call",
  telephony_tier2: "call",
  telephony_addon: "call",
  ava_voicemail: "call",
  // agent — autonomous agents working on the user's behalf
  ava_receptionist_call: "agent",
  ava_receptionist_minute: "agent",
  campaign: "agent",
  campaign_did_month: "agent",
  ava_mcp_tool: "agent",
  guardian_always_on: "agent",
  // ava — interactive Ava AI usage
  ava_chat: "ava",
  avachat: "ava",
  ava_memory: "ava",
  ava_voice_reply: "ava",
  ava_image_free: "ava",
  ava_image_generate: "ava",
  // video — live/vision/voice sessions
  avalive: "video",
  ava_vision_snapshot: "video",
  avavision: "video",
  avavoice: "video",
  // market — marketplace, listings, escrow, bookings, translation
  avaolx: "market",
  listing_post: "market",
  listing_post_connect: "market",
  escrow: "market",
  avacal: "market",
  avacalendar: "market",
  translate: "market",
  // topup / payout — money in and money out
  avawallet: "topup",
  welcome_bonus: "topup",
  avapayout: "payout",
  avaaffiliate: "payout",
};

// [WALLET-REDESIGN-1] Human names for the eight category keys above.
const CATEGORY_LABELS: Record<string, string> = {
  call: "Phone calls",
  agent: "AI agents",
  transcribe: "Transcriptions",
  ava: "Ava AI chat",
  video: "Video calls",
  market: "Marketplace",
  topup: "Top ups",
  payout: "Payouts",
};

/** [WALLET-REDESIGN-1] Category bucket for a feature/app key (never null). */
function categoryFor(app: string | null | undefined): string {
  const key = (app || "").trim();
  const mapped = FEATURE_CATEGORIES[key];
  if (mapped) return mapped;
  return key.startsWith("ava_") ? "agent" : "market";
}

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
    case "promo": return "earn"; // [WELCOME-100-1] promo grants render as incoming
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
  earn: ["earn", "donation", "gift", "hold_release", "promo"],
  topup: ["topup"],
  payout: ["payout"],
  refund: ["refund"],
  // [WALLET-REDESIGN-1] Coarse money-in / money-out buckets backing the wallet's
  // All · In · Out chips. Without these the client had to filter "In" locally,
  // which breaks keyset pagination (a page of pure spend renders as an empty
  // list until more pages load). Server-side filtering keeps every page full.
  in: ["earn", "donation", "gift", "hold_release", "promo", "topup", "refund"],
  out: ["spend", "payout"],
};

// [WALLET-REDESIGN-1] Money formatting for top-up rows. topup_records stores the
// charged amount in MINOR units (cents for USD, paise for INR) — both divide by
// 100. Anything we can't confidently format returns null rather than a guess.
function formatMoney(minor: number, currency: string | null | undefined): string | null {
  if (!Number.isFinite(minor)) return null;
  const cur = String(currency || "USD").toUpperCase();
  const major = minor / 100;
  if (cur === "INR") return `₹${Math.round(major * 100) % 100 === 0 ? major.toFixed(0) : major.toFixed(2)}`;
  if (cur === "USD") return `$${major.toFixed(2)}`;
  return `${major.toFixed(2)} ${cur}`;
}

// [WALLET-REDESIGN-1] Fiat amount per top-up row. topup_records lives in the same
// DB (DB_WALLET) and is keyed by stripe_session_id, which the wallet_transactions
// row carries in `ref`. Done as a second scoped lookup rather than a LEFT JOIN so
// the keyset WHERE clause above keeps using unqualified column names (a join makes
// `uid`/`created_at`/`status` ambiguous), and so a failure here can never 500 the
// statement — it just drops the `usd` field. Returns ref → formatted string.
async function topupFiatByRef(env: Env, uid: string, refs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!refs.length) return out;
  try {
    const capped = refs.slice(0, 200);
    const ph = capped.map((_, n) => `?${n + 2}`).join(",");
    const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
      `SELECT stripe_session_id, amount_cents, currency FROM topup_records
       WHERE uid=?1 AND stripe_session_id IN (${ph})`,
    ).bind(uid, ...capped).all();
    for (const r of ((rs.results ?? []) as any[])) {
      const money = formatMoney(Number(r.amount_cents), r.currency as string | null);
      if (money) out[String(r.stripe_session_id)] = money;
    }
  } catch { /* table missing / query failed — statement renders without fiat */ }
  return out;
}

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
    `SELECT id, type, amount, balance_after, app_name, counterparty_uid, ref, status, created_at FROM wallet_transactions
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  // [WALLET-REDESIGN-1] Fiat amounts for the top-up rows on THIS page only.
  const fiat = await topupFiatByRef(
    env, ctx.uid,
    page.filter((r) => String(r.type || "") === "topup" && r.ref).map((r) => String(r.ref)),
  );

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
      // [WALLET-REDESIGN-1] additive fields for the redesigned wallet screen
      category: categoryFor(app),
      counterparty_uid: r.counterparty_uid ? String(r.counterparty_uid) : null,
      status: type === "refund" ? "refunded"
        : (String(r.status || "").toLowerCase() === "pending" ? "pending" : "completed"),
      usd: type === "topup" && r.ref ? (fiat[String(r.ref)] ?? null) : null,
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

// ── [WALLET-REDESIGN-1] Statement export ────────────────────────────────────
// GET /api/wallet/statement/export?from=<ms>&to=<ms>&format=csv[&tz_offset_min=]
// Same rows and labelling as /api/wallet/statement, flattened to CSV for the
// "download / share my statement" action. No cursor: newest-first, hard-capped
// at 1000 rows so one request can never sweep a whole account history.
const EXPORT_MAX_ROWS = 1000;

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Guard against spreadsheet formula injection on =,+,-,@ leading chars.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function walletStatementExport(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);
  const format = (u.searchParams.get("format") || "csv").trim().toLowerCase();
  if (format !== "csv") return json({ error: "unsupported format" }, 400);
  const from = Number(u.searchParams.get("from") || 0);
  const to = Number(u.searchParams.get("to") || 0);
  const tzOffsetMin = Math.max(-840, Math.min(840, Math.trunc(Number(u.searchParams.get("tz_offset_min") || 0)) || 0));

  const where: string[] = ["uid=?1"];
  const binds: unknown[] = [ctx.uid];
  let i = 2;
  if (from > 0) { where.push(`created_at >= ?${i++}`); binds.push(from); }
  if (to > 0) { where.push(`created_at <= ?${i++}`); binds.push(to); }

  const rs = await env.DB_WALLET.withSession("first-unconstrained").prepare(
    `SELECT id, type, amount, balance_after, app_name, counterparty_uid, ref, status, created_at FROM wallet_transactions
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${EXPORT_MAX_ROWS}`,
  ).bind(...binds).all();
  const rows = (rs.results ?? []) as any[];

  const lines: string[] = ["Date,Time,Type,Category,Description,Tokens,Balance After,Reference,Status"];
  for (const r of rows) {
    const amount = Number(r.amount);
    const type = String(r.type || "");
    const app = r.app_name ? String(r.app_name) : null;
    // Local wall-clock for the reader, using the same offset convention as
    // /summary's daily_spend so an exported day matches the charted day.
    const local = new Date(Number(r.created_at) + tzOffsetMin * 60_000).toISOString();
    lines.push([
      csvCell(local.slice(0, 10)),
      csvCell(local.slice(11, 19)),
      csvCell(type),
      csvCell(CATEGORY_LABELS[categoryFor(app)] || categoryFor(app)),
      csvCell(labelFor(type, app, amount)),
      csvCell(amount),
      csvCell(r.balance_after != null ? Number(r.balance_after) : ""),
      csvCell(r.ref ?? ""),
      csvCell(type === "refund" ? "refunded"
        : (String(r.status || "").toLowerCase() === "pending" ? "pending" : "completed")),
    ].join(","));
  }

  track(env, ctx.uid, "wallet_statement_exported", "avawallet", { n: rows.length, format, from, to });
  const name = `avatok-statement-${from || 0}-${to || Date.now()}.csv`;
  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
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
  // [WALLET-REDESIGN-1] Minutes offset from UTC for LOCAL-day bucketing of
  // daily_spend (e.g. 330 = IST). Clamped to ±14h; default 0 (UTC) so existing
  // callers that omit it keep the old behaviour.
  const tzOffsetMin = Math.max(-840, Math.min(840, Math.trunc(Number(u.searchParams.get("tz_offset_min") || 0)) || 0));

  const bal = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
  const balance = Number(bal.body?.balance ?? 0);
  const spendable = Number(bal.body?.spendable ?? balance);
  const held = Number(bal.body?.held ?? 0);
  const free = Number(bal.body?.free ?? 0);

  const db = env.DB_WALLET.withSession("first-unconstrained");
  // [WALLET-UX-1] 'promo' included: the statement feed already buckets promo
  // grants (welcome bonus) under direction 'earn' (DIRECTION_TYPES), so the
  // summary's earn aggregates must count them too — otherwise a user whose only
  // activity is the welcome bonus sees empty cockpit panels above a statement
  // row the same screen labels "Welcome bonus".
  const earnTypes = "('earn','donation','gift','hold_release','promo')";
  const spends = await db.prepare(
    `SELECT COALESCE(app_name,'') AS app, COALESCE(SUM(-amount),0) AS tokens, COUNT(*) AS n
     FROM wallet_transactions WHERE uid=?1 AND created_at>=?2 AND type='spend' AND amount<0
     GROUP BY COALESCE(app_name,'') ORDER BY tokens DESC LIMIT 500`,
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

  // [WALLET-REDESIGN-1] The spend query now pulls the long tail (LIMIT 500) so
  // category folding below can't silently drop small features; by_feature itself
  // still emits at most the top 40 rows it always did.
  const byFeatureAll = ((spends.results ?? []) as any[]).map((r) => ({
    feature_key: String(r.app || "") || null,
    label: labelFor("spend", String(r.app || "") || null, -1),
    tokens: Number(r.tokens),
    count: Number(r.n),
  }));
  const byFeature = byFeatureAll.slice(0, 40);

  // [WALLET-REDESIGN-1] Fold every spend feature into its coarse category. Done
  // in TS (not SQL) so the mapping lives in one place next to FEATURE_LABELS.
  const catAgg = new Map<string, { tokens: number; count: number }>();
  for (const f of byFeatureAll) {
    const key = categoryFor(f.feature_key);
    const cur = catAgg.get(key) || { tokens: 0, count: 0 };
    cur.tokens += f.tokens;
    cur.count += f.count;
    catAgg.set(key, cur);
  }
  const byCategory = [...catAgg.entries()]
    .map(([key, v]) => ({ key, label: CATEGORY_LABELS[key] || titleize(key), tokens: v.tokens, count: v.count }))
    .sort((a, b) => b.tokens - a.tokens);

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

  // [WALLET-REDESIGN-1] Per-day spend series for the wallet chart. Bucketed by
  // LOCAL day (tz_offset_min) in SQLite, then zero-filled in TS so the array is
  // ALWAYS exactly `days` long, oldest→newest — the chart never has to guess at
  // gaps. Best-effort: a failure yields an all-zero series, never a 500.
  const dailySpend: Array<{ day: string; tokens: number }> = [];
  try {
    const rs = await db.prepare(
      `SELECT date((created_at/1000) + (?3 * 60), 'unixepoch') AS d, COALESCE(SUM(-amount),0) AS tokens
       FROM wallet_transactions WHERE uid=?1 AND created_at>=?2 AND type='spend' AND amount<0
       GROUP BY d`,
    ).bind(ctx.uid, since, tzOffsetMin).all();
    const byDay = new Map<string, number>();
    for (const r of ((rs.results ?? []) as any[])) {
      if (r.d) byDay.set(String(r.d), Math.round(Number(r.tokens) || 0));
    }
    // Local "today" = now shifted by the offset, read in UTC terms.
    const localNow = Date.now() + tzOffsetMin * 60_000;
    for (let k = days - 1; k >= 0; k--) {
      const day = new Date(localNow - k * 86_400_000).toISOString().slice(0, 10);
      dailySpend.push({ day, tokens: byDay.get(day) ?? 0 });
    }
  } catch {
    const localNow = Date.now() + tzOffsetMin * 60_000;
    for (let k = days - 1; k >= 0; k--) {
      dailySpend.push({ day: new Date(localNow - k * 86_400_000).toISOString().slice(0, 10), tokens: 0 });
    }
  }

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
    // [WALLET-REDESIGN-1] additive: chart series + coarse category breakdown
    tz_offset_min: tzOffsetMin,
    daily_spend: dailySpend,
    by_category: byCategory,
  });
}

// ── [TOKENS-FX-1] Region-aware top-up quote ─────────────────────────────────
// GET /api/wallet/topup-quote[?country=XX]   (requireUser)
//
// Canonical economics: 1 USD = 100 Tokens (1 Token = $0.01), site-wide.
// India special case (owner decision): 1 Token = ₹1 FIXED — NOT FX-converted —
// with a ₹100 minimum (= 100 Tokens). Everyone outside India tops up in USD
// only. Country comes from Cloudflare's edge geo (req.cf.country); ?country=
// is a testing override. fx_usd_rate is INFORMATIONAL only (lib/fx_rates.ts)
// — no price or balance is ever derived from it.
export async function walletTopupQuote(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);
  const override = (u.searchParams.get("country") || "").trim().toUpperCase();
  const cfCountry = String(((req as any).cf?.country as string | undefined) || "").toUpperCase();
  const country = /^[A-Z]{2}$/.test(override) ? override : (cfCountry || "US");
  const india = country === "IN";

  const currency = india ? "INR" : "USD";
  const tokensPerUnit = india ? 1 : 100;   // ₹1 = 1 Token (fixed) · $1 = 100 Tokens
  const minAmount = india ? 100 : 1;       // ₹100 minimum · $1 minimum
  const presetAmounts = india ? [100, 200, 500, 1000] : [1, 2, 5, 10];
  const presets = presetAmounts.map((amount) => ({ amount, tokens: amount * tokensPerUnit }));

  const fx = await getUsdRate(env, currency);
  track(env, ctx.uid, "wallet_topup_quote", "avawallet", { country, currency, fx_source: fx.source });
  return json({
    country,
    currency,
    tokens_per_unit: tokensPerUnit,
    min_amount: minAmount,
    presets,
    fx_usd_rate: fx.rate,       // informational: live USD→currency (1 for USD)
    fx_source: fx.source,
    note: india
      ? "1 Token = ₹1 (fixed for India). Minimum top-up ₹100 = 100 Tokens."
      : "1 USD = 100 Tokens. Minimum top-up $1.",
  });
}
