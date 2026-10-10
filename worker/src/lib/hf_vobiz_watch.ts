// [HF-VOBIZ-SPEND-1] WATCH lane: every-minute Vobiz watcher.
// Records the Vobiz balance, pulls recent call records, checks that every rupee that left the balance is explained by a
// call, and raises ALERTS (WhatsApp + email). It NEVER pauses calls, flips flags or touches hf_calls.
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { sendAdminAlert } from "./saathum_upi3";
import { enqueueEmail } from "./email_outbox";
import { vobizConfigured, getBalance, getAccount, listRecentCdrs } from "./hf_vobiz_api";
import { chainInsert, upsertLegFromCdr, recheckPendingLegs, verifyChain } from "./hf_vobiz_ledger";
import { maybeSendVobizReports } from "./hf_vobiz_report";

/** Owner thresholds (paise). */
export const UNEXPLAINED_ALERT_PAISE = 2000;   // Rs 20
export const LOW_BALANCE_PAISE = 50000;        // Rs 500
/**
 * OWNER: the most we expect to pay Vobiz per started minute of a leg, in paise (150 = Rs 1.50). A leg whose total cost
 * divided by ceil(billsec/60) goes above this raises a "rate_high" alert. This is a guess -- check Vobiz's price list
 * and change this number here (it is not an env var on purpose).
 */
export const EXPECTED_MAX_PAISE_PER_MIN = 150;
export const ALERT_EMAIL = "hdavy2005@gmail.com";

const IST_MS = 330 * 60_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EDGE_TOLERANCE_MS = 3 * MIN;
const RECONCILE_EVERY_MS = 15 * MIN;
const RECONCILE_LAG_MS = 15 * MIN;
const MIN_RECHARGE_JUMP_PAISE = 100;           // Rs 1
const MANUAL_RECHARGE_WINDOW_MS = 30 * MIN;
const MAX_NEW_CDRS_PER_TICK = 15;
const MAX_ALERTS_PER_KIND_PER_TICK = 5;

// ---------- pure helpers ----------
export function istDate(ms: number): string { return new Date(ms + IST_MS).toISOString().slice(0, 10); }
export function istHm(ms: number): string { return new Date(ms + IST_MS).toISOString().slice(11, 16); }
export function istHourKey(ms: number): string { return new Date(ms + IST_MS).toISOString().slice(0, 13); }
export function istDayStart(ms: number): number { return Math.floor((ms + IST_MS) / DAY) * DAY - IST_MS; }
export function rupees(paise: number): string { return `₹${(paise / 100).toFixed(2)}`; }

/** The last full IST clock hour that ended at least 15 minutes before `now`. */
export function lastClosedHour(now: number): { from: number; to: number } {
  let end = Math.floor((now + IST_MS) / HOUR) * HOUR - IST_MS;
  if (now - end < RECONCILE_LAG_MS) end -= HOUR;
  return { from: end - HOUR, to: end };
}

export const dedupeKeys = {
  lowBalance: (now: number) => `low_balance:${istDate(now)}`,
  unexplainedHour: (windowStart: number) => `unexplained:${windowStart}`,
  unexplainedDay: (now: number) => `unexplained_day:${istDate(now)}`,
  unknownTraffic: (legUuid: string) => `unknown_traffic:${legUuid}`,
  rateHigh: (legUuid: string) => `rate_high:${legUuid}`,
  cdrMismatch: (legUuid: string) => `cdr_mismatch:${legUuid}`,
  accountInactive: (now: number) => `account_inactive:${istDate(now)}`,
  // at most one api_failing alert per 6 IST hours, so a dead/suspended account does not send 24 WhatsApps a day
  apiFailing: (now: number) => `api_failing:${istDate(now)}:${Math.floor((((now + IST_MS) % DAY) / HOUR) / 6)}`,
  chainBroken: (table: string, now: number) => `chain_broken:${table}:${istDate(now)}`,
};

/** Nearest snapshot to `t` within `tolMs`, or null. Ties go to the earlier one. */
export function nearestBalance<T extends { at: number }>(balances: T[], t: number, tolMs = EDGE_TOLERANCE_MS): T | null {
  let best: T | null = null;
  for (const b of balances) {
    const d = Math.abs(b.at - t);
    if (d > tolMs) continue;
    if (!best || d < Math.abs(best.at - t) || (d === Math.abs(best.at - t) && b.at < best.at)) best = b;
  }
  return best;
}

/**
 * Pure money check for [from, to]. opening/closing = balance snapshots nearest each edge.
 * expected closing = opening + recharges - callCost; unexplained = expected closing - actual closing
 * (positive = money vanished). Legs count by endAt in (from, to]; recharges by at in (from, to].
 * With no snapshots everything is 0 -- callers must check the edges first (nearestBalance) and skip such windows.
 */
export function reconcileWindow(
  rows: { balances: { at: number; balancePaise: number }[]; legs: { endAt: number; totalCostPaise: number }[]; recharges: { at: number; amountPaise: number }[] },
  from: number, to: number,
): { openingPaise: number; closingPaise: number; callCostPaise: number; rechargePaise: number; unexplainedPaise: number } {
  const open = nearestBalance(rows.balances, from, Infinity);
  const close = nearestBalance(rows.balances, to, Infinity);
  const openingPaise = open?.balancePaise ?? 0;
  const closingPaise = close?.balancePaise ?? 0;
  let callCostPaise = 0;
  for (const l of rows.legs) if (l.endAt > from && l.endAt <= to) callCostPaise += Number(l.totalCostPaise) || 0;
  let rechargePaise = 0;
  for (const r of rows.recharges) if (r.at > from && r.at <= to) rechargePaise += Number(r.amountPaise) || 0;
  const expectedClosing = openingPaise + rechargePaise - callCostPaise;
  const unexplainedPaise = open && close ? expectedClosing - closingPaise : 0;
  return { openingPaise, closingPaise, callCostPaise, rechargePaise, unexplainedPaise };
}

// ---------- alerts ----------
function escHtml(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }

/** Insert the alert once (dedupe_key UNIQUE). Returns true only when it was new; then tells the owner. Never throws. */
export async function raiseAlert(env: Env, a: { kind: string; severity: "warn" | "critical"; dedupeKey: string; message: string; amountPaise?: number; meta?: unknown }): Promise<boolean> {
  try {
    const id = crypto.randomUUID();
    const now = Date.now();
    const r = await env.DB_META.prepare(
      `INSERT OR IGNORE INTO hf_vobiz_alerts (id,dedupe_key,kind,severity,message,amount_paise,meta_json,created_at,sent_whatsapp,sent_email)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,0)`,
    ).bind(id, a.dedupeKey, a.kind, a.severity, a.message, a.amountPaise ?? null, a.meta === undefined ? null : JSON.stringify(a.meta), now).run();
    if (Number((r as any).meta?.changes ?? 0) < 1) return false;

    let wa = false;
    try { wa = await sendAdminAlert(env, a.message); } catch (e) { await trackException(env, e, { route: "hf_vobiz.watch", handled: true }); }
    let em = false;
    try {
      const q = await enqueueEmail(env, {
        to: ALERT_EMAIL,
        subject: `${BRAND.name}: Vobiz alert (${a.kind.replace(/_/g, " ")})`,
        html: `<p>${escHtml(a.message)}</p><p>Alert id: ${escHtml(id)}</p>`,
        outboxKey: `vobiz-alert:${id}`,
        kind: "vobiz_alert",
      });
      em = q.queued || q.status === "queued" || q.status === "provider_accepted" || q.status === "delivered";
    } catch (e) { await trackException(env, e, { route: "hf_vobiz.watch", handled: true }); }
    void track(env, "system", "hf_vobiz_alert_raised", BRAND.slug, { area: "hf_vobiz", kind: a.kind, severity: a.severity, sent_whatsapp: wa, sent_email: em }).catch(() => undefined);
    if (wa || em) {
      await env.DB_META.prepare("UPDATE hf_vobiz_alerts SET sent_whatsapp=?2, sent_email=?3 WHERE id=?1").bind(id, wa ? 1 : 0, em ? 1 : 0).run();
    }
    return true;
  } catch (e) {
    await trackException(env, e, { route: "hf_vobiz.watch", handled: true });
    return false;
  }
}

// ---------- state ----------
async function getState(env: Env, k: string): Promise<string | null> {
  const r = await env.DB_META.prepare("SELECT v FROM hf_vobiz_state WHERE k=?1").bind(k).first<{ v: string }>();
  return r?.v ?? null;
}
async function setState(env: Env, k: string, v: string, now: number): Promise<void> {
  await env.DB_META.prepare(
    "INSERT INTO hf_vobiz_state (k,v,updated_at) VALUES (?1,?2,?3) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
  ).bind(k, v, now).run();
}

async function step(env: Env, name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { await trackException(env, e, { route: "hf_vobiz.watch", handled: true, extra: { step: name } }); }
}

// ---------- steps ----------
async function stepBalance(env: Env, now: number): Promise<void> {
  const [bal, acct] = await Promise.all([getBalance(env), getAccount(env)]);
  const prev = bal.ok
    ? await env.DB_META.prepare("SELECT balance_paise FROM hf_vobiz_balance WHERE ok=1 ORDER BY id DESC LIMIT 1").first<{ balance_paise: number }>()
    : null;
  await chainInsert(env, "hf_vobiz_balance", {
    at: now,
    balance_paise: bal.ok ? bal.balancePaise ?? null : null,
    available_paise: bal.ok ? bal.availablePaise ?? null : null,
    reserved_paise: bal.ok ? bal.reservedPaise ?? null : null,
    promo_paise: bal.ok ? bal.promoPaise ?? null : null,
    credit_limit_paise: bal.ok ? bal.creditLimitPaise ?? null : null,
    status: bal.ok ? bal.status ?? null : null,
    account_active: acct.ok && acct.isActive !== undefined ? (acct.isActive ? 1 : 0) : null,
    account_enabled: acct.ok && acct.enabled !== undefined ? (acct.enabled ? 1 : 0) : null,
    risk_status: acct.ok ? acct.riskStatus ?? null : null,
    ok: bal.ok ? 1 : 0,
    http_status: bal.httpStatus ?? null,
    error: bal.ok ? null : String(bal.error ?? "request failed").slice(0, 300),
    raw_json: bal.raw === undefined ? null : JSON.stringify(bal.raw).slice(0, 4000),
  });

  // consecutive failures
  const failN = Number((await getState(env, "watch_fail_count")) ?? 0) || 0;
  if (bal.ok) {
    if (failN !== 0) await setState(env, "watch_fail_count", "0", now);
  } else {
    const n = failN + 1;
    await setState(env, "watch_fail_count", String(n), now);
    if (n >= 3) {
      await raiseAlert(env, {
        kind: "api_failing", severity: "critical", dedupeKey: dedupeKeys.apiFailing(now),
        message: `Vobiz alert: I cannot read your Vobiz balance (${n} checks in a row failed). Spending is not being watched. Open Admin > Phone costs.`,
        meta: { failures: n, httpStatus: bal.httpStatus, error: bal.error },
      });
    }
    return;
  }

  const balance = bal.balancePaise ?? 0;
  // A balance jump up with no manual recharge close by = a detected recharge (to be confirmed by the owner). Not an alert.
  if (prev && balance - prev.balance_paise >= MIN_RECHARGE_JUMP_PAISE) {
    const manual = await env.DB_META.prepare(
      "SELECT 1 AS x FROM hf_vobiz_recharges WHERE kind='manual' AND at BETWEEN ?1 AND ?2 LIMIT 1",
    ).bind(now - MANUAL_RECHARGE_WINDOW_MS, now + MANUAL_RECHARGE_WINDOW_MS).first();
    if (!manual) {
      const id = `det_${now}`;
      await chainInsert(env, "hf_vobiz_recharges", {
        id, at: now, amount_paise: balance - prev.balance_paise, kind: "detected", utr: null, invoice_no: null,
        note: "Balance went up; no recharge was entered by hand", confirmed: 0, created_by: "watcher", created_at: now,
      }, { col: "id", val: id });
    }
  }

  if (balance < LOW_BALANCE_PAISE) {
    await raiseAlert(env, {
      kind: "low_balance", severity: "critical", dedupeKey: dedupeKeys.lowBalance(now),
      message: `Vobiz alert: only ${rupees(balance)} is left in your Vobiz balance. Calls may stop soon. Please recharge. Open Admin > Phone costs.`,
      amountPaise: balance,
    });
  }

  if (acct.ok) {
    const risk = acct.riskStatus == null ? "" : String(acct.riskStatus).toLowerCase();
    // VERIFY ON FIRST LIVE CALL: which risk_status values mean "fine".
    const riskBad = risk !== "" && !["none", "normal", "ok", "clear", "low", "active", "good"].includes(risk);
    if (acct.isActive === false || acct.enabled === false || riskBad) {
      await raiseAlert(env, {
        kind: "account_inactive", severity: "critical", dedupeKey: dedupeKeys.accountInactive(now),
        message: `Vobiz alert: your Vobiz account looks ${acct.isActive === false ? "inactive" : acct.enabled === false ? "disabled" : `flagged (${risk})`}. Calls may fail. Open Admin > Phone costs.`,
        meta: { isActive: acct.isActive, enabled: acct.enabled, riskStatus: acct.riskStatus },
      });
    }
  }
}

async function stepCdrs(env: Env): Promise<void> {
  const recent = await listRecentCdrs(env, 50);
  const done = recent.filter((c) => c.uuid && (c.endAt != null || c.totalCostPaise != null));
  if (!done.length) return;
  const known = await env.DB_META.prepare(
    `SELECT leg_uuid FROM hf_vobiz_legs WHERE leg_uuid IN (${done.map((_, i) => `?${i + 1}`).join(",")})`,
  ).bind(...done.map((c) => c.uuid)).all<{ leg_uuid: string }>();
  const have = new Set((known.results ?? []).map((r) => r.leg_uuid));
  // Known legs are completed by recheckPendingLegs; here we only add legs we have never seen (unknown traffic included).
  const fresh = done.filter((c) => !have.has(c.uuid)).slice(0, MAX_NEW_CDRS_PER_TICK);
  for (const c of fresh) {
    try { await upsertLegFromCdr(env, c); } catch (e) { await trackException(env, e, { route: "hf_vobiz.watch", handled: true }); }
  }
}

async function stepReconcile(env: Env, now: number): Promise<void> {
  const last = Number((await getState(env, "watch_last_reconcile_at")) ?? 0) || 0;
  if (now - last < RECONCILE_EVERY_MS) return;
  await setState(env, "watch_last_reconcile_at", String(now), now);

  const hour = lastClosedHour(now);
  const day = { from: istDayStart(now), to: now };
  const out: Record<string, unknown> = {};
  for (const [label, w] of [["hour", hour], ["day", day]] as const) {
    const res = await reconcileOne(env, w.from, w.to);
    out[label] = { from: w.from, to: w.to, ...(res ?? { skipped: true }) };
    if (!res || res.pending > 0) continue;       // no usable edges, or call records still arriving: judge on a later pass
    if (res.unexplainedPaise > UNEXPLAINED_ALERT_PAISE) {
      const span = label === "hour" ? `between ${istHm(w.from)} and ${istHm(w.to)}` : `so far today (since ${istHm(w.from)})`;
      await raiseAlert(env, {
        kind: "unexplained_charge", severity: "critical",
        dedupeKey: label === "hour" ? dedupeKeys.unexplainedHour(w.from) : dedupeKeys.unexplainedDay(now),
        message: `Vobiz alert: ${rupees(res.unexplainedPaise)} left your Vobiz balance ${span} that no call explains. Open Admin > Phone costs.`,
        amountPaise: res.unexplainedPaise, meta: { from: w.from, to: w.to, ...res },
      });
    }
  }
  await setState(env, "watch_last_reconcile", JSON.stringify(out), now);
}

async function reconcileOne(env: Env, from: number, to: number) {
  const bal = await env.DB_META.prepare(
    `SELECT at, balance_paise FROM hf_vobiz_balance WHERE ok=1 AND balance_paise IS NOT NULL
       AND ((at BETWEEN ?1 AND ?2) OR (at BETWEEN ?3 AND ?4)) ORDER BY at`,
  ).bind(from - EDGE_TOLERANCE_MS, from + EDGE_TOLERANCE_MS, to - EDGE_TOLERANCE_MS, to + EDGE_TOLERANCE_MS)
    .all<{ at: number; balance_paise: number }>();
  const balances = (bal.results ?? []).map((r) => ({ at: Number(r.at), balancePaise: Number(r.balance_paise) }));
  if (!nearestBalance(balances, from) || !nearestBalance(balances, to)) return null;   // no ok snapshot near an edge
  const legs = await env.DB_META.prepare(
    "SELECT end_at, COALESCE(total_cost_paise, cost_paise, 0) AS c FROM hf_vobiz_legs WHERE end_at > ?1 AND end_at <= ?2",
  ).bind(from, to).all<{ end_at: number; c: number }>();
  const rch = await env.DB_META.prepare(
    "SELECT at, amount_paise FROM hf_vobiz_recharges WHERE at > ?1 AND at <= ?2",
  ).bind(from, to).all<{ at: number; amount_paise: number }>();
  const pend = await env.DB_META.prepare(
    "SELECT COUNT(*) AS n FROM hf_vobiz_legs WHERE end_at > ?1 AND end_at <= ?2 AND cdr_checked_at IS NULL AND cdr_attempts < 30",
  ).bind(from, to).first<{ n: number }>();
  const r = reconcileWindow({
    balances,
    legs: (legs.results ?? []).map((l) => ({ endAt: Number(l.end_at), totalCostPaise: Number(l.c) })),
    recharges: (rch.results ?? []).map((x) => ({ at: Number(x.at), amountPaise: Number(x.amount_paise) })),
  }, from, to);
  return { ...r, pending: Number(pend?.n ?? 0) };
}

async function stepLegAlerts(env: Env, now: number): Promise<void> {
  const since = now - 2 * DAY;
  const unknown = await env.DB_META.prepare(
    `SELECT leg_uuid, from_number, to_number, total_cost_paise FROM hf_vobiz_legs l
      WHERE call_id IS NULL AND end_at > ?1
        AND NOT EXISTS (SELECT 1 FROM hf_vobiz_alerts a WHERE a.dedupe_key = 'unknown_traffic:' || l.leg_uuid)
      ORDER BY seq DESC LIMIT ${MAX_ALERTS_PER_KIND_PER_TICK}`,
  ).bind(since).all<{ leg_uuid: string; from_number: string | null; to_number: string | null; total_cost_paise: number | null }>();
  for (const l of unknown.results ?? []) {
    await raiseAlert(env, {
      kind: "unknown_traffic", severity: "critical", dedupeKey: dedupeKeys.unknownTraffic(l.leg_uuid),
      message: `Vobiz alert: a Vobiz call that is not one of ours was found (${l.from_number ?? "?"} to ${l.to_number ?? "?"}, cost ${rupees(Number(l.total_cost_paise ?? 0))}). Open Admin > Phone costs.`,
      amountPaise: l.total_cost_paise ?? undefined, meta: { legUuid: l.leg_uuid },
    });
  }

  const high = await env.DB_META.prepare(
    `SELECT leg_uuid, billsec, COALESCE(total_cost_paise, cost_paise) AS c FROM hf_vobiz_legs l
      WHERE end_at > ?1 AND billsec > 0 AND COALESCE(total_cost_paise, cost_paise) > ?2 * ((billsec + 59) / 60)
        AND NOT EXISTS (SELECT 1 FROM hf_vobiz_alerts a WHERE a.dedupe_key = 'rate_high:' || l.leg_uuid)
      ORDER BY seq DESC LIMIT ${MAX_ALERTS_PER_KIND_PER_TICK}`,
  ).bind(since, EXPECTED_MAX_PAISE_PER_MIN).all<{ leg_uuid: string; billsec: number; c: number }>();
  for (const l of high.results ?? []) {
    const perMin = Math.round(Number(l.c) / Math.ceil(Number(l.billsec) / 60));
    await raiseAlert(env, {
      kind: "rate_high", severity: "warn", dedupeKey: dedupeKeys.rateHigh(l.leg_uuid),
      message: `Vobiz alert: a call cost ${rupees(perMin)} per minute, more than the ${rupees(EXPECTED_MAX_PAISE_PER_MIN)} we expect. Open Admin > Phone costs.`,
      amountPaise: Number(l.c), meta: { legUuid: l.leg_uuid, perMinPaise: perMin },
    });
  }

  const mism = await env.DB_META.prepare(
    `SELECT leg_uuid, mismatch FROM hf_vobiz_legs l
      WHERE mismatch IS NOT NULL AND end_at > ?1
        AND NOT EXISTS (SELECT 1 FROM hf_vobiz_alerts a WHERE a.dedupe_key = 'cdr_mismatch:' || l.leg_uuid)
      ORDER BY seq DESC LIMIT ${MAX_ALERTS_PER_KIND_PER_TICK}`,
  ).bind(since).all<{ leg_uuid: string; mismatch: string }>();
  for (const l of mism.results ?? []) {
    await raiseAlert(env, {
      kind: "cdr_mismatch", severity: "warn", dedupeKey: dedupeKeys.cdrMismatch(l.leg_uuid),
      message: `Vobiz alert: for one call, the cost Vobiz told us at hang-up is different from its final record (${String(l.mismatch).slice(0, 120)}). Open Admin > Phone costs.`,
      meta: { legUuid: l.leg_uuid },
    });
  }
}

/** Hourly: re-verify the hash chains. Tail-only for the big tables (the report lane checks the whole chain). */
async function stepVerify(env: Env, now: number): Promise<void> {
  const last = Number((await getState(env, "watch_last_verify_at")) ?? 0) || 0;
  if (now - last < HOUR) return;
  await setState(env, "watch_last_verify_at", String(now), now);
  const TAIL = 2000;
  const targets: { table: string; col: string | null }[] = [
    { table: "hf_vobiz_legs", col: "seq" }, { table: "hf_vobiz_leg_cdr_log", col: "seq" },
    { table: "hf_vobiz_balance", col: "id" }, { table: "hf_vobiz_recharges", col: null },
  ];
  for (const t of targets) {
    let from: number | undefined;
    if (t.col) {
      const m = await env.DB_META.prepare(`SELECT MAX(${t.col}) AS m FROM ${t.table}`).first<{ m: number | null }>();
      from = Math.max(0, Number(m?.m ?? 0) - TAIL);
    }
    const v = await verifyChain(env, t.table, from);
    if (!v.ok) {
      await raiseAlert(env, {
        kind: "chain_broken", severity: "critical", dedupeKey: dedupeKeys.chainBroken(t.table, now),
        message: `Vobiz alert: the tamper check failed on the "${t.table}" records${v.brokenAt != null ? ` (row ${v.brokenAt})` : ""}. Someone or something changed saved data. Open Admin > Phone costs.`,
        meta: v,
      });
    }
  }
}

/** Called every minute. Never throws. */
export async function runVobizWatch(env: Env, now: number = Date.now()): Promise<void> {
  try {
    if (!vobizConfigured(env)) return;
    await step(env, "balance", () => stepBalance(env, now));
    await step(env, "cdrs", () => stepCdrs(env));
    await step(env, "recheck", async () => { await recheckPendingLegs(env, 20); });
    await step(env, "reconcile", () => stepReconcile(env, now));
    await step(env, "leg_alerts", () => stepLegAlerts(env, now));
    await step(env, "verify", () => stepVerify(env, now));
    await step(env, "reports", () => maybeSendVobizReports(env, now));
  } catch (e) {
    try { await trackException(env, e, { route: "hf_vobiz.watch", handled: true }); } catch { /* never throw */ }
  }
}
