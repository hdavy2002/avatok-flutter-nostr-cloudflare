// [HF-VOBIZ-SPEND-1] Vobiz spend report (lane REPORT). Contract: Specs/HF-VOBIZ-SPEND-CONTRACT.md section 5.
// Reads the hf_vobiz_* ledger tables and produces (a) ReportData, (b) an A4-landscape PDF (pdf-lib, Helvetica, WinAnsi-safe),
// (c) a CSV of every leg, and (d) the nightly / monthly email. Money in our tables is paise; shown as "Rs 12.34".
// Times are epoch ms; shown in IST ("10 Oct 2026 14:05:09 IST"). Full phone numbers are shown on purpose (owner decision, admin only).
import type { Env } from "../types";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { BRAND } from "./brand";
import { sha256Hex } from "../util";
import { winAnsiSafe } from "./me_dashboard_logic";
import { personName, phoneSql } from "./admin2_people_data";
import { enqueueEmail } from "./email_outbox";
import { exportCdrCsv } from "./hf_vobiz_api";
import { verifyChain } from "./hf_vobiz_ledger";
import { trackException } from "../hooks";

// ── time + money helpers (pure) ──────────────────────────────────────────────
export const IST_OFFSET_MS = 330 * 60_000;
export const DAY_MS = 86_400_000;
export const REPORT_EMAIL_TO = "hdavy2005@gmail.com";
export const PDF_LEG_CAP = 20_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** Start (epoch ms) of the IST calendar day containing `ms`. */
export function istDayStart(ms: number): number { return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS; }
/** "YYYY-MM-DD" in IST. */
export function istDateStr(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
/** Start of the IST month containing `ms`; `monthsBack` = 1 gives the previous month. */
export function istMonthStart(ms: number, monthsBack = 0): number {
  const d = new Date(ms + IST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1) - IST_OFFSET_MS;
}
/** "YYYY-MM-DD" -> start of that IST day, or null when malformed / not a real date. */
export function parseIstDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return t - IST_OFFSET_MS;
}
/** "10 Oct 2026 14:05:09 IST" */
export function formatIstFull(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} IST`;
}
/** Same without the zone suffix, for table cells whose header already says IST. */
export function formatIstCell(ms: number | null | undefined): string { return formatIstFull(ms).replace(/ IST$/, ""); }
/** "10 Oct 2026" */
export function formatIstDay(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** Paise -> "Rs 12.34" (always two decimals, Indian digit grouping, ASCII only so Helvetica can draw it). */
export function rs(paise: number | null | undefined): string {
  if (paise == null || !Number.isFinite(paise)) return "-";
  const neg = paise < 0; const a = Math.abs(Math.round(paise));
  return `${neg ? "-" : ""}Rs ${Math.trunc(a / 100).toLocaleString("en-IN")}.${p2(a % 100)}`;
}
const rsPlain = (paise: number | null | undefined) => (paise == null || !Number.isFinite(paise) ? "" : (paise / 100).toFixed(2));
const mins = (billsec: number) => (billsec / 60).toFixed(1);

/** JSON with keys sorted at every level (stable input for the data hash). */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

// ── types ────────────────────────────────────────────────────────────────────
export interface LegRow {
  seq: number; legUuid: string; callId: string | null; role: string; userUid: string | null; userName: string | null; userPhone: string | null;
  callerUid: string | null; direction: string | null; from: string | null; to: string | null;
  startAt: number | null; answerAt: number | null; endAt: number | null; durationSec: number | null; billsec: number | null;
  costPaise: number | null; streamingCostPaise: number | null; totalCostPaise: number | null;
  hangupCause: string | null; hangupSource: string | null; mos: number | null; source: string;
  cdrCheckedAt: number | null; mismatch: string | null; createdAt: number;
}
export interface UserAgg { calls: number; billsec: number; costPaise: number }
export interface UserRow { uid: string; name: string | null; phone: string | null; asCaller: UserAgg; asHost: UserAgg; paidPaise: number; vobizCostPaise: number; diffPaise: number }
export interface DayRow { day: string; legs: number; billsec: number; costPaise: number; rechargePaise: number }
export interface RechargeRow { id: string; at: number; amountPaise: number; kind: string; utr: string | null; invoiceNo: string | null; note: string | null; confirmed: boolean; createdBy: string | null; createdAt: number }
export interface AlertRow { id: string; kind: string; severity: string; message: string; amountPaise: number | null; createdAt: number; ackedAt: number | null }
export interface ChainRow { table: string; ok: boolean; rows: number; brokenAt: number | null }
export interface ReportMoney {
  reconciled: boolean; note: string | null;
  openingPaise: number | null; openingAt: number | null; closingPaise: number | null; closingAt: number | null;
  rechargePaise: number; callCostPaise: number; expectedClosingPaise: number | null; unexplainedPaise: number | null;
}
export interface ReportData {
  meta: { id: string; generatedAt: number; brand: string }; // excluded from the data hash
  period: { from: number; to: number; userUid: string | null; userName: string | null };
  totals: { legs: number; billsec: number; costPaise: number; streamingCostPaise: number; unknownLegs: number; unknownCostPaise: number; pendingCdr: number; mismatches: number };
  money: ReportMoney;
  days: DayRow[]; users: UserRow[]; legs: LegRow[];
  balances: { at: number; balancePaise: number | null; availablePaise: number | null; ok: boolean }[]; balanceTicks: number; failedTicks: number;
  recharges: RechargeRow[]; alerts: AlertRow[]; chain: ChainRow[];
}

/** sha256 of the canonical JSON of the report data (everything except `meta`). */
export async function reportDataSha(d: ReportData): Promise<string> {
  const { meta: _m, ...rest } = d;
  return sha256Hex(canonicalJson(rest));
}

// ── DB access shared with the admin routes ───────────────────────────────────
export const LEG_COLS = `l.seq, l.leg_uuid, l.call_id, l.role, l.user_uid, l.direction, l.from_number, l.to_number, l.start_at, l.answer_at, l.end_at,
  l.duration_sec, l.billsec, l.cost_paise, l.streaming_cost_paise, l.total_cost_paise, l.hangup_cause, l.hangup_source, l.mos, l.source,
  l.cdr_checked_at, l.mismatch, l.created_at, c.caller_uid AS c_caller_uid`;
/** A leg belongs to the period by the time it ended (else started, else was recorded). */
export const LEG_TIME_SQL = "COALESCE(l.end_at, l.start_at, l.created_at)";

export interface LegQuery { from?: number; to?: number; uid?: string; callId?: string; unknown?: boolean }
export function legWhere(q: LegQuery): { where: string; binds: unknown[] } {
  const conds: string[] = []; const binds: unknown[] = [];
  const ref = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  if (q.from != null) conds.push(`${LEG_TIME_SQL} >= ${ref(q.from)}`);
  if (q.to != null) conds.push(`${LEG_TIME_SQL} <= ${ref(q.to)}`);
  if (q.uid) { const r = ref(q.uid); conds.push(`(l.user_uid = ${r} OR c.caller_uid = ${r} OR c.host_uid = ${r})`); }
  if (q.callId) conds.push(`l.call_id = ${ref(q.callId)}`);
  if (q.unknown) conds.push("l.call_id IS NULL");
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", binds };
}

type RawLeg = Record<string, unknown>;
const n = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const s = (v: unknown): string | null => (v == null ? null : String(v));
export function mapLeg(r: RawLeg, people?: Map<string, { name: string | null; phone: string | null }>): LegRow {
  const uid = s(r.user_uid); const p = uid ? people?.get(uid) : undefined;
  return {
    seq: Number(r.seq), legUuid: String(r.leg_uuid), callId: s(r.call_id), role: String(r.role ?? "unknown"), userUid: uid,
    userName: p?.name ?? null, userPhone: p?.phone ?? null, callerUid: s(r.c_caller_uid), direction: s(r.direction),
    from: s(r.from_number), to: s(r.to_number), startAt: n(r.start_at), answerAt: n(r.answer_at), endAt: n(r.end_at),
    durationSec: n(r.duration_sec), billsec: n(r.billsec), costPaise: n(r.cost_paise), streamingCostPaise: n(r.streaming_cost_paise),
    totalCostPaise: n(r.total_cost_paise), hangupCause: s(r.hangup_cause), hangupSource: s(r.hangup_source), mos: n(r.mos),
    source: String(r.source ?? ""), cdrCheckedAt: n(r.cdr_checked_at), mismatch: s(r.mismatch), createdAt: Number(r.created_at ?? 0),
  };
}

/** uid -> {name, phone} (full readable phone, same source the admin customer pages use). */
export async function lookupPeople(env: Env, uids: string[]): Promise<Map<string, { name: string | null; phone: string | null }>> {
  const out = new Map<string, { name: string | null; phone: string | null }>();
  const list = [...new Set(uids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    try {
      const rs = await env.DB_META.prepare(
        `SELECT u.uid AS uid, u.display_name, u.first_name, u.last_name, ${phoneSql("u.uid", "u")} AS phone FROM users u WHERE u.uid IN (${chunk.map((_, k) => `?${k + 1}`).join(",")})`,
      ).bind(...chunk).all<{ uid: string; display_name: string | null; first_name: string | null; last_name: string | null; phone: string | null }>();
      for (const r of rs.results ?? []) out.set(r.uid, { name: personName(r), phone: r.phone ?? null });
    } catch { /* names are a convenience; legs still print with their uid */ }
  }
  return out;
}

/** Every matching leg (chunked by seq so thousands of rows never hit one huge result), newest first. */
export async function loadAllLegs(env: Env, q: LegQuery): Promise<LegRow[]> {
  const { where, binds } = legWhere(q);
  const raw: RawLeg[] = [];
  let cursor = 0;
  for (let guard = 0; guard < 400; guard++) {
    const cur = `?${binds.length + 1}`;
    const sql = `SELECT ${LEG_COLS} FROM hf_vobiz_legs l LEFT JOIN hf_calls c ON c.id = l.call_id ${where ? `${where} AND` : "WHERE"} l.seq > ${cur} ORDER BY l.seq LIMIT 5000`;
    const rs = (await env.DB_META.prepare(sql).bind(...binds, cursor).all<RawLeg>()).results ?? [];
    raw.push(...rs);
    if (rs.length < 5000) break;
    cursor = Number(rs[rs.length - 1].seq);
  }
  const people = await lookupPeople(env, raw.flatMap((r) => [s(r.user_uid), s(r.c_caller_uid)]).filter((x): x is string => !!x));
  const legs = raw.map((r) => mapLeg(r, people));
  legs.sort((a, b) => (legTime(a) - legTime(b)) || (a.seq - b.seq));
  return legs;
}
export const legTime = (l: LegRow): number => l.endAt ?? l.startAt ?? l.createdAt;

export function aggregateUsers(legs: LegRow[], paidByCaller: Map<string, number>, people: Map<string, { name: string | null; phone: string | null }>): UserRow[] {
  const empty = (): UserAgg => ({ calls: 0, billsec: 0, costPaise: 0 });
  const rows = new Map<string, UserRow & { cc: Set<string>; hc: Set<string> }>();
  const get = (uid: string) => {
    let r = rows.get(uid);
    if (!r) {
      const p = people.get(uid);
      r = { uid, name: uid === "" ? "Unknown traffic (not our calls)" : (p?.name ?? null), phone: p?.phone ?? null, asCaller: empty(), asHost: empty(), paidPaise: 0, vobizCostPaise: 0, diffPaise: 0, cc: new Set(), hc: new Set() };
      rows.set(uid, r);
    }
    return r;
  };
  for (const l of legs) {
    const cost = l.totalCostPaise ?? 0, bs = l.billsec ?? 0;
    const key = l.callId == null ? "" : (l.userUid ?? "");
    if (l.callId == null || l.role === "unknown" || !l.userUid) {
      if (l.callId == null) { const r = get(""); r.asHost.calls++; r.asHost.billsec += bs; r.asHost.costPaise += cost; r.vobizCostPaise += cost; }
    } else {
      const r = get(key);
      const agg = l.role === "caller" ? r.asCaller : r.asHost;
      (l.role === "caller" ? r.cc : r.hc).add(l.callId);
      agg.billsec += bs; agg.costPaise += cost;
    }
    // what a placed call costs us (both of its legs) is attributed to the person who placed it
    if (l.callId && l.callerUid) get(l.callerUid).vobizCostPaise += cost;
  }
  for (const [uid, paid] of paidByCaller) if (uid) get(uid).paidPaise = paid;
  const out: UserRow[] = [];
  for (const r of rows.values()) {
    if (r.uid !== "") { r.asCaller.calls = r.cc.size; r.asHost.calls = r.hc.size; }
    r.diffPaise = r.paidPaise - r.vobizCostPaise;
    const { cc: _c, hc: _h, ...plain } = r;
    out.push(plain);
  }
  out.sort((a, b) => b.vobizCostPaise - a.vobizCostPaise || a.uid.localeCompare(b.uid));
  return out;
}

export async function paidByCaller(env: Env, from: number, to: number): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  try {
    const rs = await env.DB_META.prepare(
      "SELECT caller_uid, SUM(charged_paise) AS paid FROM hf_calls WHERE ended_at >= ?1 AND ended_at <= ?2 GROUP BY caller_uid",
    ).bind(from, to).all<{ caller_uid: string; paid: number | null }>();
    for (const r of rs.results ?? []) m.set(r.caller_uid, Number(r.paid ?? 0));
  } catch { /* hf_calls always exists in prod; tolerate a fixture without it */ }
  return m;
}

export async function loadRecharges(env: Env, from: number, to: number, limit = 500): Promise<RechargeRow[]> {
  const rs = await env.DB_META.prepare(
    "SELECT id, at, amount_paise, kind, utr, invoice_no, note, confirmed, created_by, created_at FROM hf_vobiz_recharges WHERE at >= ?1 AND at <= ?2 ORDER BY at DESC LIMIT ?3",
  ).bind(from, to, limit).all<RawLeg>();
  return (rs.results ?? []).map(mapRecharge);
}
export function mapRecharge(r: RawLeg): RechargeRow {
  return { id: String(r.id), at: Number(r.at), amountPaise: Number(r.amount_paise), kind: String(r.kind), utr: s(r.utr), invoiceNo: s(r.invoice_no), note: s(r.note), confirmed: Number(r.confirmed) === 1, createdBy: s(r.created_by), createdAt: Number(r.created_at) };
}

/** Opening + recharges - call costs = expected closing, versus the actual closing balance. */
export async function computeMoney(env: Env, from: number, to: number, periodCostPaise: number): Promise<ReportMoney> {
  const base: ReportMoney = { reconciled: false, note: null, openingPaise: null, openingAt: null, closingPaise: null, closingAt: null, rechargePaise: 0, callCostPaise: periodCostPaise, expectedClosingPaise: null, unexplainedPaise: null };
  try {
    const q = "balance_paise IS NOT NULL AND ok = 1";
    let open = await env.DB_META.prepare(`SELECT at, balance_paise FROM hf_vobiz_balance WHERE ${q} AND at <= ?1 ORDER BY at DESC LIMIT 1`).bind(from).first<{ at: number; balance_paise: number }>();
    if (!open) open = await env.DB_META.prepare(`SELECT at, balance_paise FROM hf_vobiz_balance WHERE ${q} AND at >= ?1 AND at <= ?2 ORDER BY at ASC LIMIT 1`).bind(from, to).first<{ at: number; balance_paise: number }>();
    const close = await env.DB_META.prepare(`SELECT at, balance_paise FROM hf_vobiz_balance WHERE ${q} AND at <= ?1 ORDER BY at DESC LIMIT 1`).bind(to).first<{ at: number; balance_paise: number }>();
    if (!open || !close || close.at <= open.at) { base.note = "Not enough balance readings in this period to reconcile."; return base; }
    // the window between the two readings, so the arithmetic matches what was actually observed
    const cost = await env.DB_META.prepare(`SELECT COALESCE(SUM(l.total_cost_paise),0) AS c FROM hf_vobiz_legs l WHERE ${LEG_TIME_SQL} > ?1 AND ${LEG_TIME_SQL} <= ?2`).bind(open.at, close.at).first<{ c: number }>();
    const rch = await env.DB_META.prepare("SELECT COALESCE(SUM(amount_paise),0) AS c FROM hf_vobiz_recharges WHERE at > ?1 AND at <= ?2 AND (kind='manual' OR confirmed=1)").bind(open.at, close.at).first<{ c: number }>();
    const callCost = Number(cost?.c ?? 0), recharge = Number(rch?.c ?? 0);
    const expected = open.balance_paise + recharge - callCost;
    return {
      reconciled: true, note: "Costs and recharges counted between the two balance readings.",
      openingPaise: open.balance_paise, openingAt: open.at, closingPaise: close.balance_paise, closingAt: close.at,
      rechargePaise: recharge, callCostPaise: callCost, expectedClosingPaise: expected, unexplainedPaise: expected - close.balance_paise,
    };
  } catch (e) {
    base.note = "Balance data unavailable.";
    return base;
  }
}

// ── buildReportData ──────────────────────────────────────────────────────────
export async function buildReportData(env: Env, q: { from: number; to: number; userUid?: string }): Promise<ReportData> {
  const { from, to } = q;
  const uid = q.userUid?.trim() || undefined;
  const legs = await loadAllLegs(env, { from, to, uid });
  const people = await lookupPeople(env, [...legs.flatMap((l) => [l.userUid, l.callerUid]).filter((x): x is string => !!x), ...(uid ? [uid] : [])]);

  const totals = { legs: legs.length, billsec: 0, costPaise: 0, streamingCostPaise: 0, unknownLegs: 0, unknownCostPaise: 0, pendingCdr: 0, mismatches: 0 };
  const dayMap = new Map<string, DayRow>();
  for (const l of legs) {
    const c = l.totalCostPaise ?? 0;
    totals.billsec += l.billsec ?? 0; totals.costPaise += c; totals.streamingCostPaise += l.streamingCostPaise ?? 0;
    if (l.callId == null) { totals.unknownLegs++; totals.unknownCostPaise += c; }
    if (l.cdrCheckedAt == null) totals.pendingCdr++;
    if (l.mismatch) totals.mismatches++;
    const day = istDateStr(legTime(l));
    const d = dayMap.get(day) ?? { day, legs: 0, billsec: 0, costPaise: 0, rechargePaise: 0 };
    d.legs++; d.billsec += l.billsec ?? 0; d.costPaise += c; dayMap.set(day, d);
  }

  const recharges = await loadRecharges(env, from, to).catch(() => [] as RechargeRow[]);
  for (const r of recharges) {
    if (!(r.kind === "manual" || r.confirmed)) continue;
    const day = istDateStr(r.at);
    const d = dayMap.get(day) ?? { day, legs: 0, billsec: 0, costPaise: 0, rechargePaise: 0 };
    d.rechargePaise += r.amountPaise; dayMap.set(day, d);
  }

  const money: ReportMoney = uid
    ? { reconciled: false, note: "Per-person report: account-level reconciliation is only shown in the all-traffic report.", openingPaise: null, openingAt: null, closingPaise: null, closingAt: null, rechargePaise: 0, callCostPaise: totals.costPaise, expectedClosingPaise: null, unexplainedPaise: null }
    : await computeMoney(env, from, to, totals.costPaise);

  const users = aggregateUsers(legs, await paidByCaller(env, from, to), people);
  const filteredUsers = uid ? users.filter((u) => u.uid === uid) : users;

  // balance readings: only the ones where the number changed (plus first/last), capped at 400 rows
  let balances: ReportData["balances"] = []; let balanceTicks = 0, failedTicks = 0;
  try {
    const rs = (await env.DB_META.prepare("SELECT at, balance_paise, available_paise, ok FROM hf_vobiz_balance WHERE at >= ?1 AND at <= ?2 ORDER BY at ASC LIMIT 20000").bind(from, to).all<RawLeg>()).results ?? [];
    balanceTicks = rs.length;
    let prev: number | null | undefined;
    const changed: ReportData["balances"] = [];
    rs.forEach((r, i) => {
      const ok = Number(r.ok) === 1; if (!ok) failedTicks++;
      const bal = n(r.balance_paise);
      if (i === 0 || i === rs.length - 1 || !ok || bal !== prev) changed.push({ at: Number(r.at), balancePaise: bal, availablePaise: n(r.available_paise), ok });
      if (ok) prev = bal;
    });
    balances = changed.length > 400 ? downsample(changed, 400) : changed;
  } catch { /* leave empty */ }

  let alerts: AlertRow[] = [];
  try {
    const rs = (await env.DB_META.prepare("SELECT id, kind, severity, message, amount_paise, created_at, acked_at FROM hf_vobiz_alerts WHERE created_at >= ?1 AND created_at <= ?2 ORDER BY created_at ASC LIMIT 500").bind(from, to).all<RawLeg>()).results ?? [];
    alerts = rs.map((r) => ({ id: String(r.id), kind: String(r.kind), severity: String(r.severity), message: String(r.message), amountPaise: n(r.amount_paise), createdAt: Number(r.created_at), ackedAt: n(r.acked_at) }));
  } catch { /* leave empty */ }

  const chain: ChainRow[] = [];
  for (const t of ["hf_vobiz_legs", "hf_vobiz_leg_cdr_log", "hf_vobiz_balance", "hf_vobiz_recharges"]) {
    try { const v = await verifyChain(env, t); chain.push({ table: t, ok: v.ok, rows: v.rows, brokenAt: v.brokenAt ?? null }); }
    catch { chain.push({ table: t, ok: false, rows: 0, brokenAt: null }); }
  }

  return {
    meta: { id: crypto.randomUUID(), generatedAt: Date.now(), brand: BRAND.name },
    period: { from, to, userUid: uid ?? null, userName: uid ? (people.get(uid)?.name ?? null) : null },
    totals, money,
    days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    users: filteredUsers, legs, balances, balanceTicks, failedTicks, recharges: recharges.slice().sort((a, b) => a.at - b.at), alerts, chain,
  };
}
function downsample<T>(a: T[], max: number): T[] {
  if (a.length <= max) return a;
  const out: T[] = []; const step = (a.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(a[Math.round(i * step)]);
  return out;
}
export { downsample };

// ── CSV ──────────────────────────────────────────────────────────────────────
export function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  let t = String(v);
  if (/^[=@]/.test(t)) t = `'${t}`; // spreadsheet formula guard
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
const CSV_HEAD = ["seq", "vobiz_leg_uuid", "our_call_id", "role", "user_uid", "user_name", "user_phone", "direction", "from_number", "to_number",
  "start_ist", "answer_ist", "end_ist", "duration_sec", "billsec", "cost_rs", "streaming_cost_rs", "total_cost_rs", "hangup_cause", "hangup_source", "mos", "source", "cdr_checked", "mismatch"];
/** One row per leg, every leg (no cap). Money as plain rupees with two decimals; times in IST. */
export function renderLegsCsv(d: ReportData): string {
  const lines: string[] = [CSV_HEAD.join(",")];
  for (const l of d.legs) {
    lines.push([
      l.seq, l.legUuid, l.callId, l.role, l.userUid, l.userName, l.userPhone, l.direction, l.from, l.to,
      l.startAt != null ? formatIstFull(l.startAt) : "", l.answerAt != null ? formatIstFull(l.answerAt) : "", l.endAt != null ? formatIstFull(l.endAt) : "",
      l.durationSec, l.billsec, rsPlain(l.costPaise), rsPlain(l.streamingCostPaise), rsPlain(l.totalCostPaise),
      l.hangupCause, l.hangupSource, l.mos, l.source, l.cdrCheckedAt != null ? "yes" : "pending", l.mismatch,
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// ── PDF ──────────────────────────────────────────────────────────────────────
const PW = 841.89, PH = 595.28, MX = 28, MTOP = 34, MBOT = 38;
const INK = rgb(0.13, 0.12, 0.11), MUTED = rgb(0.42, 0.40, 0.38), RULE = rgb(0.80, 0.78, 0.75), STRIPE = rgb(0.955, 0.945, 0.935), RED = rgb(0.70, 0.10, 0.10);
interface Col { h: string; w: number; right?: boolean }

class PdfWriter {
  pages: PDFPage[] = []; page!: PDFPage; y = 0;
  constructor(readonly doc: PDFDocument, readonly font: PDFFont, readonly bold: PDFFont) { this.newPage(); }
  newPage() { this.page = this.doc.addPage([PW, PH]); this.pages.push(this.page); this.y = PH - MTOP; }
  ensure(h: number) { if (this.y - h < MBOT) this.newPage(); }
  fit(t: string, width: number, size: number, f: PDFFont): string {
    t = winAnsiSafe(t);
    if (f.widthOfTextAtSize(t, size) <= width) return t;
    let lo = 0, hi = t.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f.widthOfTextAtSize(t.slice(0, mid) + "..", size) <= width) lo = mid; else hi = mid - 1; }
    return t.slice(0, lo) + "..";
  }
  text(t: string, x: number, size = 11, f = this.font, color = INK) { this.page.drawText(winAnsiSafe(t), { x, y: this.y, size, font: f, color }); }
  heading(t: string, size = 15) { this.ensure(size + 26); this.y -= 8; this.text(t, MX, size, this.bold); this.y -= 6; this.page.drawLine({ start: { x: MX, y: this.y }, end: { x: PW - MX, y: this.y }, thickness: 0.8, color: RULE }); this.y -= 16; }
  line(t: string, size = 11, color = INK, f = this.font) { this.ensure(size + 5); this.text(t, MX, size, f, color); this.y -= size + 5; }
  wrapped(t: string, size = 11, color = INK) {
    const words = winAnsiSafe(t).split(" "); let cur = "";
    for (const w of words) { const nx = cur ? `${cur} ${w}` : w; if (this.font.widthOfTextAtSize(nx, size) > PW - 2 * MX && cur) { this.line(cur, size, color); cur = w; } else cur = nx; }
    if (cur) this.line(cur, size, color);
  }
  kv(label: string, value: string, color = INK) {
    this.ensure(17); this.text(label, MX, 11, this.font, MUTED); this.text(value, MX + 230, 11, this.bold, color); this.y -= 17;
  }
  table(cols: Col[], rows: { cells: string[]; color?: ReturnType<typeof rgb>; bold?: boolean }[], size = 9) {
    const avail = PW - 2 * MX; const tw = cols.reduce((a, c) => a + c.w, 0); const k = avail / tw;
    const w = cols.map((c) => c.w * k); const rowH = size + 5;
    const headLines = Math.max(...cols.map((c) => c.h.split("\n").length));
    const drawHead = () => {
      this.ensure(headLines * (size + 2) + rowH * 2);
      let x = MX; const top = this.y;
      cols.forEach((c, i) => {
        c.h.split("\n").forEach((ln, li) => {
          const tx = c.right ? x + w[i] - 3 - this.bold.widthOfTextAtSize(winAnsiSafe(ln), size) : x + 2;
          this.page.drawText(winAnsiSafe(ln), { x: tx, y: top - li * (size + 2), size, font: this.bold, color: INK });
        });
        x += w[i];
      });
      this.y = top - headLines * (size + 2) - 1;
      this.page.drawLine({ start: { x: MX, y: this.y + 2 }, end: { x: PW - MX, y: this.y + 2 }, thickness: 0.8, color: INK });
      this.y -= rowH - 2;
    };
    drawHead();
    rows.forEach((r, ri) => {
      if (this.y - rowH < MBOT) { this.newPage(); drawHead(); }
      if (ri % 2 === 1) this.page.drawRectangle({ x: MX, y: this.y - 3, width: avail, height: rowH, color: STRIPE });
      let x = MX; const f = r.bold ? this.bold : this.font;
      r.cells.forEach((cell, i) => {
        const t = this.fit(cell, w[i] - 5, size, f);
        const tx = cols[i].right ? x + w[i] - 3 - f.widthOfTextAtSize(t, size) : x + 2;
        this.page.drawText(t, { x: tx, y: this.y, size, font: f, color: r.color ?? INK });
        x += w[i];
      });
      this.y -= rowH;
    });
    this.y -= 6;
  }
}

const short = (id: string | null, n = 13) => (id ? (id.length > n ? id.slice(0, n) + ".." : id) : "-");

/** A4-landscape PDF. Fonts: standard Helvetica (>= 9pt in tables, 11pt body). Footer with page n/N on every page. */
export async function renderReportPdf(d: ReportData, opts: { summary?: boolean } = {}): Promise<Uint8Array> {
  const sha = await reportDataSha(d);
  const doc = await PDFDocument.create();
  const title = `${d.meta.brand} - Vobiz spend report ${d.meta.id}`;
  doc.setTitle(winAnsiSafe(title)); doc.setAuthor(winAnsiSafe(d.meta.brand)); doc.setCreator(winAnsiSafe(d.meta.brand));
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new PdfWriter(doc, font, bold);

  // cover
  w.text(d.meta.brand, MX, 24, bold); w.y -= 26;
  w.text("Vobiz spend report", MX, 16, bold); w.y -= 24;
  w.kv("Period (IST)", `${formatIstFull(d.period.from)}  to  ${formatIstFull(d.period.to)}`);
  w.kv("Scope", d.period.userUid ? `One person: ${d.period.userName ?? "(no name)"} (${d.period.userUid})` : "All traffic on the Vobiz account");
  w.kv("Generated (IST)", formatIstFull(d.meta.generatedAt));
  w.kv("Report id", d.meta.id);
  w.kv("Data sha256", sha);
  w.kv("Legs in report", String(d.totals.legs));
  if (d.legs.length > PDF_LEG_CAP) w.kv("Leg table", `First ${PDF_LEG_CAP} of ${d.legs.length} legs shown here. The CSV has every leg.`, RED);

  w.heading("Money summary");
  const m = d.money;
  if (m.reconciled) {
    w.kv("Opening balance", `${rs(m.openingPaise)}   (reading at ${formatIstFull(m.openingAt)})`);
    w.kv("+ Recharges (confirmed)", rs(m.rechargePaise));
    w.kv("- Call costs", rs(m.callCostPaise));
    w.kv("= Expected closing balance", rs(m.expectedClosingPaise));
    w.kv("Actual closing balance", `${rs(m.closingPaise)}   (reading at ${formatIstFull(m.closingAt)})`);
    const un = m.unexplainedPaise ?? 0;
    w.kv("Unexplained difference", `${rs(un)}${un > 0 ? "  (balance fell more than calls explain)" : un < 0 ? "  (balance is higher than expected)" : "  (none)"}`, Math.abs(un) > 0 ? RED : INK);
  } else {
    w.kv("Call costs in period", rs(d.totals.costPaise));
  }
  if (m.note) w.line(m.note, 11, MUTED);
  w.kv("Total call cost (all legs in period)", rs(d.totals.costPaise));
  w.kv("Talk time (billed)", `${mins(d.totals.billsec)} minutes across ${d.totals.legs} legs`);
  w.kv("Traffic not matched to our calls", `${d.totals.unknownLegs} legs, ${rs(d.totals.unknownCostPaise)}`, d.totals.unknownLegs ? RED : INK);
  w.kv("Legs still waiting for Vobiz CDR", String(d.totals.pendingCdr));
  w.kv("Legs where webhook and CDR disagree", String(d.totals.mismatches), d.totals.mismatches ? RED : INK);

  w.heading("Day by day (IST)");
  if (d.days.length) {
    w.table([{ h: "Day", w: 120 }, { h: "Legs", w: 60, right: true }, { h: "Billed min", w: 90, right: true }, { h: "Call cost", w: 100, right: true }, { h: "Recharged", w: 100, right: true }],
      d.days.map((x) => ({ cells: [x.day, String(x.legs), mins(x.billsec), rs(x.costPaise), x.rechargePaise ? rs(x.rechargePaise) : "-"] })), 11);
  } else w.line("No legs in this period.", 11, MUTED);

  w.heading("Per person");
  if (d.users.length) {
    w.table([
      { h: "Name", w: 120 }, { h: "Phone", w: 95 }, { h: "Uid", w: 80 },
      { h: "As caller\ncalls", w: 50, right: true }, { h: "As caller\nmin", w: 50, right: true }, { h: "As caller\ncost", w: 66, right: true },
      { h: "As host\ncalls", w: 46, right: true }, { h: "As host\nmin", w: 46, right: true }, { h: "As host\ncost", w: 66, right: true },
      { h: "Paid by\nperson", w: 70, right: true }, { h: "Vobiz cost\nof calls", w: 70, right: true }, { h: "Paid minus\ncost", w: 70, right: true },
    ], d.users.map((u) => ({
      cells: [u.name ?? "(no name)", u.phone ?? "-", u.uid ? short(u.uid, 12) : "-",
        String(u.asCaller.calls), mins(u.asCaller.billsec), rs(u.asCaller.costPaise), String(u.asHost.calls), mins(u.asHost.billsec), rs(u.asHost.costPaise),
        rs(u.paidPaise), rs(u.vobizCostPaise), rs(u.diffPaise)],
      color: u.uid === "" ? RED : INK,
    })));
    w.line("Vobiz cost of calls = both legs of every call the person placed. Paid by person = what the wallet charged them for those calls.", 9, MUTED);
  } else w.line("No people in this period.", 11, MUTED);

  // legs
  if (opts.summary) {
    w.heading("Leg detail");
    w.wrapped(`This is the summary edition of the report: the table of all ${d.legs.length} legs is left out to fit an email. Every leg is in the attached CSV file(s).`, 11, RED);
  } else {
  w.newPage();
  w.heading("Every leg");
  const shown = d.legs.length > PDF_LEG_CAP ? d.legs.slice(0, PDF_LEG_CAP) : d.legs;
  if (d.legs.length > PDF_LEG_CAP) w.line(`Showing the first ${PDF_LEG_CAP} of ${d.legs.length} legs, oldest first. The CSV has every leg.`, 11, RED);
  w.line("Ids are shortened here (first 13 characters); the CSV carries the full Vobiz uuid and call id.", 9, MUTED);
  if (shown.length) {
    w.table([
      { h: "Time (IST)", w: 112 }, { h: "Dir", w: 24 }, { h: "Role", w: 38 }, { h: "From", w: 86 }, { h: "To", w: 86 },
      { h: "Bill s", w: 34, right: true }, { h: "Cost", w: 54, right: true }, { h: "Total", w: 58, right: true }, { h: "Hangup", w: 62 },
      { h: "Vobiz uuid", w: 96 }, { h: "Our call id", w: 96 }, { h: "CDR", w: 52 },
    ], shown.map((l) => ({
      cells: [formatIstCell(legTime(l)), l.direction === "inbound" ? "in" : l.direction === "outbound" ? "out" : "-", l.role, l.from ?? "-", l.to ?? "-",
        l.billsec == null ? "-" : String(l.billsec), rs(l.costPaise), rs(l.totalCostPaise), l.hangupCause ?? "-", short(l.legUuid), l.callId ? short(l.callId) : "NOT OURS",
        l.mismatch ? "MISMATCH" : l.cdrCheckedAt != null ? "ok" : "pending"],
      color: l.mismatch || l.callId == null ? RED : INK,
    })));
  } else w.line("No legs in this period.", 11, MUTED);
  }

  w.heading("Balance readings");
  w.line(`${d.balanceTicks} readings taken; ${d.failedTicks} failed. Only readings where the balance changed are listed (at most 400).`, 11, MUTED);
  if (d.balances.length) {
    w.table([{ h: "Time (IST)", w: 140 }, { h: "Balance", w: 100, right: true }, { h: "Available", w: 100, right: true }, { h: "Reading", w: 80 }],
      d.balances.map((b) => ({ cells: [formatIstCell(b.at), rs(b.balancePaise), rs(b.availablePaise), b.ok ? "ok" : "FAILED"], color: b.ok ? INK : RED })), 9);
  }
  w.heading("Recharges in period");
  if (d.recharges.length) {
    w.table([{ h: "Time (IST)", w: 120 }, { h: "Amount", w: 80, right: true }, { h: "Kind", w: 60 }, { h: "Confirmed", w: 60 }, { h: "UTR", w: 110 }, { h: "Invoice", w: 90 }, { h: "Note", w: 220 }],
      d.recharges.map((r) => ({ cells: [formatIstCell(r.at), rs(r.amountPaise), r.kind, r.confirmed ? "yes" : "NO", r.utr ?? "-", r.invoiceNo ?? "-", r.note ?? "-"] })), 9);
  } else w.line("No recharges recorded in this period.", 11, MUTED);

  w.heading("Alerts in period");
  if (d.alerts.length) {
    w.table([{ h: "Time (IST)", w: 120 }, { h: "Kind", w: 100 }, { h: "Level", w: 55 }, { h: "Amount", w: 70, right: true }, { h: "Acknowledged", w: 80 }, { h: "Message", w: 330 }],
      d.alerts.map((a) => ({ cells: [formatIstCell(a.createdAt), a.kind, a.severity, a.amountPaise != null ? rs(a.amountPaise) : "-", a.ackedAt ? "yes" : "no", a.message], color: a.severity === "critical" ? RED : INK })), 9);
  } else w.line("No alerts raised in this period.", 11, MUTED);

  w.heading("Tamper check (hash chains)");
  w.table([{ h: "Table", w: 200 }, { h: "Rows checked", w: 90, right: true }, { h: "Result", w: 260 }],
    d.chain.map((c) => ({ cells: [c.table, String(c.rows), c.ok ? "chain intact" : `BROKEN${c.brokenAt != null ? ` at row ${c.brokenAt}` : ""}`], color: c.ok ? INK : RED })), 11);

  // footer on every page, now that the page count is known
  const total = w.pages.length;
  w.pages.forEach((pg, i) => {
    const t = winAnsiSafe(`${d.meta.brand} - Vobiz spend report ${d.meta.id} · page ${i + 1}/${total} · data sha256 ${sha.slice(0, 16)}`);
    pg.drawLine({ start: { x: MX, y: 28 }, end: { x: PW - MX, y: 28 }, thickness: 0.5, color: RULE });
    pg.drawText(t, { x: MX, y: 15, size: 9, font, color: MUTED });
  });
  return await doc.save();
}

/** Record a generated PDF (sha256 = the data hash printed in its footer). */
export async function recordReport(env: Env, r: { id: string; kind: "download" | "daily" | "monthly"; from: number; to: number; userUid?: string | null; sha256: string; bytes: number; emailedTo?: string | null; createdBy?: string | null }): Promise<void> {
  await env.DB_META.prepare(
    "INSERT INTO hf_vobiz_reports (id, kind, period_from, period_to, user_uid, sha256, bytes, emailed_to, created_by, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
  ).bind(r.id, r.kind, r.from, r.to, r.userUid ?? null, r.sha256, r.bytes, r.emailedTo ?? null, r.createdBy ?? null, Date.now()).run();
}

// ── nightly / monthly email ──────────────────────────────────────────────────
export interface DueReport { kind: "daily" | "monthly"; key: string; from: number; to: number; label: string }

/** Pure. Reports that are due at `now`; the caller drops the ones already marked as sent.
 *  Daily: the IST day that is just ending, from 23:55 IST (plus the previous day as a catch-up).
 *  Monthly: the previous IST month, from the 1st at 00:10 IST (catch-up until the 3rd). */
export function reportsDue(now: number): DueReport[] {
  const out: DueReport[] = [];
  const ist = new Date(now + IST_OFFSET_MS);
  const minuteOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const today = istDayStart(now);
  const dayReport = (start: number): DueReport => ({ kind: "daily", key: istDateStr(start), from: start, to: start + DAY_MS - 1, label: formatIstDay(start) });
  out.push(dayReport(today - DAY_MS));
  if (minuteOfDay >= 23 * 60 + 55) out.push(dayReport(today));
  const dom = ist.getUTCDate();
  if ((dom === 1 && minuteOfDay >= 10) || (dom >= 2 && dom <= 3)) {
    const start = istMonthStart(now, 1), end = istMonthStart(now, 0) - 1;
    const sd = new Date(start + IST_OFFSET_MS);
    out.push({ kind: "monthly", key: `${sd.getUTCFullYear()}-${p2(sd.getUTCMonth() + 1)}`, from: start, to: end, label: `${MONTHS[sd.getUTCMonth()]} ${sd.getUTCFullYear()}` });
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const utf8 = (t: string) => new TextEncoder().encode(t);
/** The email queue message (and its D1 outbox row) is size-limited, so each email's attachments share one budget; bigger sets go out as several emails. */
export const ATTACH_BUDGET_B64 = 90_000;
const b64Len = (bytes: number) => Math.ceil(bytes / 3) * 4;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Split CSV text into chunks whose base64 size is within `budget`, cutting only at row boundaries (quote-aware) and repeating the header row. */
export function splitCsvText(text: string, budget = ATTACH_BUDGET_B64): string[] {
  const enc = new TextEncoder();
  const maxBytes = Math.floor(budget / 4) * 3;
  if (enc.encode(text).length <= maxBytes) return [text];
  // rows end at a newline outside quotes
  const rows: string[] = []; let start = 0, inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (c === "\n" && !inQ) { rows.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) rows.push(text.slice(start));
  if (rows.length < 2) return [text];
  const header = rows[0], hb = enc.encode(header).length;
  const chunks: string[] = []; let cur: string[] = []; let size = hb;
  for (let i = 1; i < rows.length; i++) {
    const rb = enc.encode(rows[i]).length;
    if (cur.length && size + rb > maxBytes) { chunks.push(header + cur.join("")); cur = []; size = hb; }
    cur.push(rows[i]); size += rb;
  }
  if (cur.length) chunks.push(header + cur.join(""));
  return chunks;
}

interface Att { name: string; content: string }
/** Greedy, order-preserving packing of attachments into emails of at most `budget` base64 chars (an unsplittable oversize file gets its own email). */
export function packParts(atts: Att[], budget = ATTACH_BUDGET_B64): Att[][] {
  const parts: Att[][] = []; let cur: Att[] = []; let used = 0;
  for (const a of atts) {
    if (cur.length && used + a.content.length > budget) { parts.push(cur); cur = []; used = 0; }
    cur.push(a); used += a.content.length;
  }
  if (cur.length) parts.push(cur);
  return parts;
}
function csvAtts(base: string, text: string): Att[] {
  const chunks = splitCsvText(text);
  return chunks.map((c, i) => ({ name: chunks.length > 1 ? `${base}-part${i + 1}.csv` : `${base}.csv`, content: toBase64(utf8(c)) }));
}

async function sendOne(env: Env, due: DueReport): Promise<void> {
  const d = await buildReportData(env, { from: due.from, to: due.to });
  let pdf = await renderReportPdf(d);
  let summaryPdf = false;
  if (b64Len(pdf.length) > ATTACH_BUDGET_B64) { pdf = await renderReportPdf(d, { summary: true }); summaryPdf = true; }
  const csv = renderLegsCsv(d);
  const sha = await reportDataSha(d);
  const vobizCsv = await exportCdrCsv(env, istDateStr(due.from), istDateStr(due.to)).catch(() => null);

  const tag = due.key;
  const atts: Att[] = [
    { name: summaryPdf ? `vobiz-spend-${tag}-summary.pdf` : `vobiz-spend-${tag}.pdf`, content: toBase64(pdf) },
    ...csvAtts(`vobiz-legs-${tag}`, csv),
    ...(vobizCsv != null ? csvAtts(`vobiz-cdr-${tag}`, vobizCsv) : []),
  ];
  const parts = packParts(atts);

  const m = d.money;
  const rows: [string, string][] = [
    ["Period (IST)", `${formatIstFull(due.from)} to ${formatIstFull(due.to)}`],
    ["Total call cost", rs(d.totals.costPaise)],
    ["Legs / billed minutes", `${d.totals.legs} legs, ${mins(d.totals.billsec)} min`],
  ];
  if (m.reconciled) rows.push(["Opening balance", rs(m.openingPaise)], ["Recharges", rs(m.rechargePaise)], ["Closing balance", rs(m.closingPaise)], ["Unexplained difference", rs(m.unexplainedPaise)]);
  else rows.push(["Balance reconciliation", m.note ?? "not available"]);
  rows.push(["Traffic not matched to our calls", `${d.totals.unknownLegs} legs, ${rs(d.totals.unknownCostPaise)}`], ["Legs awaiting Vobiz CDR", String(d.totals.pendingCdr)],
    ["Alerts in period", String(d.alerts.length)], ["Chain check", d.chain.every((c) => c.ok) ? "intact" : "BROKEN - look at the PDF"], ["Data sha256", sha]);
  const notes: string[] = [];
  if (vobizCsv == null) notes.push("Vobiz did not return its own CDR export for this period, so it is not attached.");
  if (summaryPdf) notes.push("The full PDF was too large for email, so the attached PDF is the summary edition. Every leg is in the attached CSV file(s).");
  else if (d.legs.length > PDF_LEG_CAP) notes.push(`The PDF lists the first ${PDF_LEG_CAP} legs only; the CSV has all ${d.legs.length}.`);
  if (parts.length > 1) notes.push(`These files are too large for one email, so they come in ${parts.length} emails. All of them must arrive.`);

  const N = parts.length;
  for (let i = 0; i < N; i++) {
    const partTxt = N > 1 ? ` (part ${i + 1} of ${N})` : "";
    const body = i === 0
      ? `<p>${esc(BRAND.name)} Vobiz spend report for <b>${esc(due.label)}</b>${esc(partTxt)}.</p><table cellpadding="6" style="border-collapse:collapse;font-size:15px">${rows.map(([k, v]) => `<tr><td style="color:#6b6661">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>`
      : `<p>${esc(BRAND.name)} Vobiz spend report for <b>${esc(due.label)}</b>${esc(partTxt)}. Summary figures are in part 1.</p>`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#221f1c">${body}${notes.length ? `<p>${notes.map(esc).join("<br>")}</p>` : ""}<p style="color:#6b6661">Attached: ${parts[i].map((a) => esc(a.name)).join(", ")}.</p></div>`;
    const res = await enqueueEmail(env, {
      to: REPORT_EMAIL_TO, subject: `Vobiz spend report \u2014 ${due.label} \u2014 ${rs(d.totals.costPaise)}${partTxt}`, html, attachments: parts[i],
      kind: "hf_vobiz_report", outboxKey: `hf-vobiz-report:${due.kind}:${due.key}:part${i + 1}`, messageVersion: "hf-vobiz-report.v1",
    });
    if (!res.queued && !["provider_accepted", "delivered", "sending"].includes(res.status)) throw new Error(`report email part ${i + 1} not queued (${res.status})`);
  }
  await recordReport(env, { id: d.meta.id, kind: due.kind, from: due.from, to: due.to, sha256: sha, bytes: pdf.length, emailedTo: REPORT_EMAIL_TO, createdBy: "system" });
}

/** Called every minute by the watcher. Never throws. Exactly one email per day / month (marker row is claimed before building). */
export async function maybeSendVobizReports(env: Env, now: number): Promise<void> {
  try {
    for (const due of reportsDue(now)) {
      const k = `report_sent:${due.kind}:${due.key}`;
      try {
        const claim = await env.DB_META.prepare("INSERT OR IGNORE INTO hf_vobiz_state (k, v, updated_at) VALUES (?1, 'claimed', ?2)").bind(k, now).run();
        if ((claim.meta?.changes ?? 0) === 0) continue; // already sent, or another tick owns it
        try {
          await sendOne(env, due);
          await env.DB_META.prepare("UPDATE hf_vobiz_state SET v='sent', updated_at=?2 WHERE k=?1").bind(k, Date.now()).run();
        } catch (e) {
          // release the claim so the next minute retries, but give up after 3 failed attempts (marker stays, value 'failed')
          const tk = `report_tries:${due.kind}:${due.key}`;
          const row = await env.DB_META.prepare("SELECT v FROM hf_vobiz_state WHERE k=?1").bind(tk).first<{ v: string }>().catch(() => null);
          const tries = Number(row?.v ?? 0) + 1;
          await env.DB_META.prepare("INSERT INTO hf_vobiz_state (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v=?2, updated_at=?3").bind(tk, String(tries), Date.now()).run().catch(() => undefined);
          if (tries >= 3) await env.DB_META.prepare("UPDATE hf_vobiz_state SET v='failed', updated_at=?2 WHERE k=?1").bind(k, Date.now()).run().catch(() => undefined);
          else await env.DB_META.prepare("DELETE FROM hf_vobiz_state WHERE k=?1").bind(k).run().catch(() => undefined);
          await trackException(env, e, { route: "hf_vobiz_report", handled: true, extra: { area: "hf_vobiz_report", kind: due.kind, key: due.key, tries } }).catch(() => undefined);
        }
      } catch (e) {
        await trackException(env, e, { route: "hf_vobiz_report", handled: true, extra: { area: "hf_vobiz_report", step: "claim" } }).catch(() => undefined);
      }
    }
  } catch { /* never throws */ }
}
