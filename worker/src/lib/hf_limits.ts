// [HF-WALLET-LIMITS-1] Caller spend limits (HF-PAY-7) + IST calendar helpers shared by receipts and reconciliation.
// Only REAL money counts (hf_calls.paid_rupees); test credits never do. Top-ups are not spending and are never blocked by a limit.
// The pure half (no Env) is unit-tested in hf_limits.test.ts; the D1 half is small and defensive (a missing column / table never blocks a call).
import type { Env } from "../types";

export const IST_OFFSET_MS = 19_800_000; // UTC+05:30, no DST
export const DEFAULT_DAILY_LIMIT = 2000;
export const DEFAULT_MONTHLY_LIMIT = 15000;
export const MAX_LIMIT_RUPEES = 1_000_000;
const ACTIVE = "('ringing_host','ringing_caller','connected')";
const ACTIVE_STALE_MS = 4 * 3600_000; // same horizon the "call in progress" check uses

// ── IST boundaries (pure) ────────────────────────────────────────────────────
const shifted = (ms: number) => new Date(ms + IST_OFFSET_MS); // read with getUTC*

/** Start (00:00 IST) of the IST day containing `ms`, as epoch ms. */
export function istDayStart(ms: number): number {
  const d = shifted(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS;
}
export const istNextDayStart = (ms: number): number => istDayStart(ms) + 86_400_000;
/** Start (00:00 IST on the 1st) of the IST calendar month containing `ms`. */
export function istMonthStart(ms: number): number {
  const d = shifted(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_OFFSET_MS;
}
export function istNextMonthStart(ms: number): number {
  const d = shifted(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - IST_OFFSET_MS;
}
export function istPrevMonthStart(ms: number): number {
  return istMonthStart(istMonthStart(ms) - 1);
}
/** "YYYY-MM-DD" in IST. */
export function istDateStr(ms: number): string {
  const d = shifted(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/** "YYYY-MM" in IST. */
export const istMonthStr = (ms: number): string => istDateStr(ms).slice(0, 7);
/** "YYYY-MM-DD" (an IST date) -> epoch ms of its 00:00 IST, or null when it is not a real date. */
export function parseIstDate(s: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t - IST_OFFSET_MS;
}
/** Indian financial year (April to March) of the IST moment `ms`: start year, "2026-27" and short "26-27". */
export function financialYear(ms: number): { startYear: number; label: string; short: string } {
  const d = shifted(ms);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const a = String((y + 1) % 100).padStart(2, "0");
  return { startYear: y, label: `${y}-${a}`, short: `${String(y % 100).padStart(2, "0")}-${a}` };
}

// ── limit math (pure) ────────────────────────────────────────────────────────
const wholeOr = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(MAX_LIMIT_RUPEES, Math.trunc(n)) : fallback;
};
export interface LimitCfg { hfDailySpendLimitRupees?: unknown; hfMonthlySpendLimitRupees?: unknown; hfTopupConfirmAboveRupees?: unknown }
export interface Limits { daily: number; monthly: number }

/** Flag defaults; a missing or negative flag falls back to the owner-decided 2,000 / 15,000. A flag of 0 means "no spending". */
export function limitDefaults(cfg: LimitCfg): Limits {
  return { daily: wholeOr(cfg.hfDailySpendLimitRupees, DEFAULT_DAILY_LIMIT), monthly: wholeOr(cfg.hfMonthlySpendLimitRupees, DEFAULT_MONTHLY_LIMIT) };
}
/** Per-user override wins column by column (NULL = use the default). */
export function effectiveLimits(defaults: Limits, override: { daily_rupees?: number | null; monthly_rupees?: number | null } | null): Limits {
  return {
    daily: override?.daily_rupees == null ? defaults.daily : wholeOr(override.daily_rupees, defaults.daily),
    monthly: override?.monthly_rupees == null ? defaults.monthly : wholeOr(override.monthly_rupees, defaults.monthly),
  };
}

export interface Remaining { dayRemaining: number; monthRemaining: number; room: number; binding: "day" | "month" | null }
/** Rupees of real money that can still be spent today / this month; `room` is the tighter of the two. */
export function remaining(limits: Limits, spentToday: number, spentMonth: number): Remaining {
  const dayRemaining = Math.max(0, limits.daily - Math.max(0, Math.trunc(spentToday)));
  const monthRemaining = Math.max(0, limits.monthly - Math.max(0, Math.trunc(spentMonth)));
  const room = Math.min(dayRemaining, monthRemaining);
  return { dayRemaining, monthRemaining, room, binding: room === dayRemaining ? "day" : "month" };
}

export type StartDecision =
  | { ok: true; paidUsable: number; capped: boolean }
  | { ok: false; reason: "spend_limit"; binding: "day" | "month" };
/**
 * Call start. `shortfall` = paid rupees the call must reserve beyond test credits (the 2-minute minimum), `paidAvailable` = the caller's
 * whole paid balance (after that reserve is counted in). The paid money the call may spend is capped at the limit room; test credits are
 * never capped. If the room cannot even cover the paid part of the 2-minute minimum, the call is refused (never phrased as the host's choice).
 */
export function decideStart(a: { shortfall: number; paidAvailable: number; room: number; binding: "day" | "month" | null }): StartDecision {
  const room = Math.max(0, Math.trunc(a.room));
  const avail = Math.max(0, Math.trunc(a.paidAvailable));
  if (a.shortfall > 0 && room < a.shortfall) return { ok: false, reason: "spend_limit", binding: a.binding ?? "day" };
  const paidUsable = Math.min(avail, room);
  return { ok: true, paidUsable, capped: paidUsable < avail };
}
/** Why the call will end: the spend limit when it is what cut the funds short of a full-length call, else the usual balance / time limit. */
export function callLimitReason(a: { fundsRupees: number; rateRupees: number; maxCallMinutes: number; capped: boolean }): "spend_limit" | "balance" | "time_limit" {
  if (Math.floor(a.fundsRupees / a.rateRupees) >= a.maxCallMinutes) return "time_limit";
  return a.capped ? "spend_limit" : "balance";
}
/** The friendly refusal text (HF-WELL-3: a rule of the service, never "the host blocked you"). */
export function limitMessage(binding: "day" | "month", limits: Limits): string {
  return binding === "month"
    ? `You've reached this month's limit of ₹${limits.monthly.toLocaleString("en-IN")}. It resets on the 1st.`
    : `You've reached today's limit of ₹${limits.daily.toLocaleString("en-IN")}. It resets at midnight.`;
}

// ── D1 half ──────────────────────────────────────────────────────────────────
/** Real (paid) rupees the caller has spent, or may still spend through calls in progress, since `sinceMs`. */
export async function realSpent(env: Env, uid: string, sinceMs: number, now = Date.now()): Promise<number> {
  try {
    const r = await env.DB_META.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status IN ${ACTIVE} THEN COALESCE(limit_cap_rupees,0) ELSE COALESCE(paid_rupees,0) END),0) AS s
         FROM hf_calls WHERE caller_uid=?1 AND created_at>=?2 AND (status NOT IN ${ACTIVE} OR created_at>?3)`,
    ).bind(uid, sinceMs, now - ACTIVE_STALE_MS).first<{ s: number }>();
    return Math.max(0, Math.trunc(Number(r?.s ?? 0)));
  } catch {
    // limit_cap_rupees not migrated yet: settled paid money only.
    const r = await env.DB_META.prepare("SELECT COALESCE(SUM(COALESCE(paid_rupees,0)),0) AS s FROM hf_calls WHERE caller_uid=?1 AND created_at>=?2")
      .bind(uid, sinceMs).first<{ s: number }>().catch(() => null);
    return Math.max(0, Math.trunc(Number(r?.s ?? 0)));
  }
}

export interface OverrideRow { uid: string; daily_rupees: number | null; monthly_rupees: number | null; note: string | null; admin_uid: string | null; updated_at: number }
export async function getOverride(env: Env, uid: string): Promise<OverrideRow | null> {
  return (await env.DB_META.prepare("SELECT uid, daily_rupees, monthly_rupees, note, admin_uid, updated_at FROM hf_spend_limits WHERE uid=?1").bind(uid).first<OverrideRow>().catch(() => null)) ?? null;
}
export async function limitsFor(env: Env, uid: string, cfg: LimitCfg): Promise<Limits> {
  return effectiveLimits(limitDefaults(cfg), await getOverride(env, uid));
}

export interface LimitSummary extends Limits {
  spentToday: number; spentThisMonth: number; dayRemaining: number; monthRemaining: number; room: number; binding: "day" | "month" | null; resetsAt: number;
}
export async function limitSummary(env: Env, uid: string, cfg: LimitCfg, now = Date.now()): Promise<LimitSummary> {
  const limits = await limitsFor(env, uid, cfg);
  const [spentToday, spentThisMonth] = await Promise.all([realSpent(env, uid, istDayStart(now), now), realSpent(env, uid, istMonthStart(now), now)]);
  const r = remaining(limits, spentToday, spentThisMonth);
  return { ...limits, spentToday, spentThisMonth, ...r, resetsAt: istNextDayStart(now) };
}

/** Admin write. null for a column clears the override for it; both null removes the row. */
export async function setOverride(env: Env, uid: string, adminUid: string, daily: number | null, monthly: number | null, note: string): Promise<void> {
  if (daily === null && monthly === null) {
    await env.DB_META.prepare("DELETE FROM hf_spend_limits WHERE uid=?1").bind(uid).run();
    return;
  }
  await env.DB_META.prepare(
    `INSERT INTO hf_spend_limits (uid, daily_rupees, monthly_rupees, note, admin_uid, updated_at) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(uid) DO UPDATE SET daily_rupees=excluded.daily_rupees, monthly_rupees=excluded.monthly_rupees, note=excluded.note, admin_uid=excluded.admin_uid, updated_at=excluded.updated_at`,
  ).bind(uid, daily, monthly, note.slice(0, 200), adminUid, Date.now()).run();
}

// ── [HF-TOK-LEDGER-1 / HF-TOK-D9] token mode: limits count RUPEES PAID FOR TOKENS, checked at purchase ─────────────────────────────────
// With hfTokensEnabled on, calls are no longer limited by spend: the daily / monthly limits (Rs 2,000 / Rs 15,000, per-user overrides
// kept) apply to what a buyer pays for token purchase lots (hf_token_lots.paid_paise, kind purchase) in the IST day / month. Refunded
// (revoked) lots do not count. Test lots pay nothing. The Play verify route (HF-TOK-PLAY-1) calls checkPurchaseAllowed BEFORE opening the sheet.
/** Paise paid for token purchases since `sinceMs`. */
export async function paidPaiseSince(env: Env, uid: string, sinceMs: number): Promise<number> {
  const r = await env.DB_META.prepare(
    "SELECT COALESCE(SUM(paid_paise),0) AS s FROM hf_token_lots WHERE uid=?1 AND kind='purchase' AND status='active' AND created_at>=?2",
  ).bind(uid, sinceMs).first<{ s: number }>();
  return Math.max(0, Math.trunc(Number(r?.s ?? 0)));
}
export const paidTodayPaise = (env: Env, uid: string, now = Date.now()): Promise<number> => paidPaiseSince(env, uid, istDayStart(now));
export const paidMonthPaise = (env: Env, uid: string, now = Date.now()): Promise<number> => paidPaiseSince(env, uid, istMonthStart(now));

export type PurchaseCheck =
  | { ok: true; dayRemainingPaise: number; monthRemainingPaise: number }
  | { ok: false; binding: "day" | "month"; message: string; dayRemainingPaise: number; monthRemainingPaise: number; resetsAt: number };

/** Pure: would paying `pricePaise` now stay inside both limits (rupee limits, compared in paise)? The tighter limit is the one named. */
export function decidePurchase(limits: Limits, paidToday: number, paidMonth: number, pricePaise: number, now = Date.now()): PurchaseCheck {
  const price = Math.max(0, Math.trunc(pricePaise));
  const dayRemainingPaise = Math.max(0, limits.daily * 100 - Math.max(0, Math.trunc(paidToday)));
  const monthRemainingPaise = Math.max(0, limits.monthly * 100 - Math.max(0, Math.trunc(paidMonth)));
  if (price <= dayRemainingPaise && price <= monthRemainingPaise) return { ok: true, dayRemainingPaise, monthRemainingPaise };
  const binding: "day" | "month" = price > dayRemainingPaise ? "day" : "month";
  return { ok: false, binding, message: limitMessage(binding, limits), dayRemainingPaise, monthRemainingPaise, resetsAt: binding === "month" ? istNextMonthStart(now) : istNextDayStart(now) };
}

/** For the future Play verify route: may this user buy a pack costing `pricePaise` right now? */
export async function checkPurchaseAllowed(env: Env, uid: string, pricePaise: number, cfg: LimitCfg, now = Date.now()): Promise<PurchaseCheck> {
  const [limits, today, month] = await Promise.all([limitsFor(env, uid, cfg), paidTodayPaise(env, uid, now), paidMonthPaise(env, uid, now)]);
  return decidePurchase(limits, today, month, pricePaise, now);
}
