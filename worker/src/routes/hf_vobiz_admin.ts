// [HF-VOBIZ-SPEND-1] Admin API for the Vobiz spend monitor (lane REPORT). Contract: Specs/HF-VOBIZ-SPEND-CONTRACT.md section 5.
// All routes are admin-only (isAdminUid, same gate as routes/hf_calls.ts) and every call is written to admin_audit (DB_WALLET).
//   GET  /api/admin/hf/vobiz/summary
//   GET  /api/admin/hf/vobiz/legs?from=&to=&uid=&callId=&unknown=1&limit=&offset=
//   GET  /api/admin/hf/vobiz/users?from=&to=
//   GET  /api/admin/hf/vobiz/calls/:id
//   GET  /api/admin/hf/vobiz/balance?from=&to=
//   GET  /api/admin/hf/vobiz/alerts?limit=            POST /api/admin/hf/vobiz/alerts/:id/ack
//   GET  /api/admin/hf/vobiz/recharges                POST /api/admin/hf/vobiz/recharges      POST /api/admin/hf/vobiz/recharges/:id/confirm
//   GET  /api/admin/hf/vobiz/report.pdf?from=&to=&uid=     GET /api/admin/hf/vobiz/report.csv?from=&to=&uid=
//   POST /api/admin/hf/vobiz/sync {date: "YYYY-MM-DD"}
// Money in every response is paise (integer); times are epoch ms. Full phone numbers are returned (owner decision, admin only).
import type { Env } from "../types";
import { json, CORS } from "../util";
import { requireUser, isFail } from "../authz";
import { isAdminUid } from "../lib/preview";
import { trackException } from "../hooks";
import { listCdrs } from "../lib/hf_vobiz_api";
import { chainInsert, upsertLegFromCdr, verifyChain } from "../lib/hf_vobiz_ledger";
import {
  DAY_MS, LEG_COLS, LEG_TIME_SQL, legWhere, mapLeg, mapRecharge, lookupPeople, aggregateUsers, paidByCaller, loadAllLegs, loadRecharges,
  buildReportData, renderReportPdf, renderLegsCsv, reportDataSha, recordReport, istDayStart, istMonthStart, istDateStr, parseIstDate, downsample,
  type RechargeRow,
} from "../lib/hf_vobiz_report";

const BASE = "/api/admin/hf/vobiz/";
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);
type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminUid, `hf_vobiz_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    await trackException(env, e, { route: BASE, handled: true, extra: { area: "hf_vobiz_admin", step: "admin_audit", action } }).catch(() => undefined);
  }
}

/** from/to default to today (IST) when absent or invalid; `to` is inclusive. */
function range(url: URL): { from: number; to: number } {
  const now = Date.now();
  const f = num(url.searchParams.get("from")), t = num(url.searchParams.get("to"));
  const from = f != null && f >= 0 ? Math.floor(f) : istDayStart(now);
  const to = t != null && t > 0 ? Math.floor(t) : (f != null ? from + DAY_MS - 1 : istDayStart(now) + DAY_MS - 1);
  return { from, to: Math.max(to, from) };
}
const intParam = (v: string | null, def: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v ?? def)) || def));

// ── handlers ─────────────────────────────────────────────────────────────────
async function periodStats(env: Env, from: number, to: number): Promise<{ costPaise: number; legs: number; minutes: number }> {
  const r = await env.DB_META.prepare(
    `SELECT COUNT(*) AS legs, COALESCE(SUM(l.total_cost_paise),0) AS cost, COALESCE(SUM(l.billsec),0) AS bs FROM hf_vobiz_legs l WHERE ${LEG_TIME_SQL} >= ?1 AND ${LEG_TIME_SQL} <= ?2`,
  ).bind(from, to).first<{ legs: number; cost: number; bs: number }>();
  return { costPaise: Number(r?.cost ?? 0), legs: Number(r?.legs ?? 0), minutes: Math.round(Number(r?.bs ?? 0) / 6) / 10 };
}
async function unexplainedFor(env: Env, from: number, to: number): Promise<number> {
  try {
    const q = "ok = 1 AND balance_paise IS NOT NULL";
    const open = await env.DB_META.prepare(`SELECT at, balance_paise FROM hf_vobiz_balance WHERE ${q} AND at <= ?1 ORDER BY at DESC LIMIT 1`).bind(from).first<{ at: number; balance_paise: number }>()
      ?? await env.DB_META.prepare(`SELECT at, balance_paise FROM hf_vobiz_balance WHERE ${q} AND at >= ?1 ORDER BY at ASC LIMIT 1`).bind(from).first<{ at: number; balance_paise: number }>();
    const close = await env.DB_META.prepare(`SELECT at, balance_paise FROM hf_vobiz_balance WHERE ${q} AND at <= ?1 ORDER BY at DESC LIMIT 1`).bind(to).first<{ at: number; balance_paise: number }>();
    if (!open || !close || close.at <= open.at) return 0;
    const cost = await env.DB_META.prepare(`SELECT COALESCE(SUM(l.total_cost_paise),0) AS c FROM hf_vobiz_legs l WHERE ${LEG_TIME_SQL} > ?1 AND ${LEG_TIME_SQL} <= ?2`).bind(open.at, close.at).first<{ c: number }>();
    const rch = await env.DB_META.prepare("SELECT COALESCE(SUM(amount_paise),0) AS c FROM hf_vobiz_recharges WHERE at > ?1 AND at <= ?2 AND (kind='manual' OR confirmed=1)").bind(open.at, close.at).first<{ c: number }>();
    return open.balance_paise + Number(rch?.c ?? 0) - Number(cost?.c ?? 0) - close.balance_paise;
  } catch { return 0; }
}
async function chargedUsers(env: Env, from: number, to: number): Promise<number> {
  try {
    const r = await env.DB_META.prepare("SELECT COALESCE(SUM(charged_paise),0) AS c FROM hf_calls WHERE ended_at >= ?1 AND ended_at <= ?2").bind(from, to).first<{ c: number }>();
    return Number(r?.c ?? 0);
  } catch { return 0; }
}
/** The whole-chain check is slow; the summary refreshes every 15 s, so reuse a result up to 10 minutes old. */
async function chainOkCached(env: Env, now: number): Promise<boolean> {
  const key = "report_chain_cache";
  try {
    const row = await env.DB_META.prepare("SELECT v FROM hf_vobiz_state WHERE k=?1").bind(key).first<{ v: string }>();
    if (row) { const c = JSON.parse(row.v) as { ok: boolean; at: number }; if (now - c.at < 600_000) return c.ok; }
  } catch { /* recompute */ }
  let ok = true;
  for (const t of ["hf_vobiz_legs", "hf_vobiz_balance", "hf_vobiz_recharges", "hf_vobiz_leg_cdr_log"]) {
    try { if (!(await verifyChain(env, t)).ok) ok = false; } catch { ok = false; }
  }
  try {
    await env.DB_META.prepare("INSERT INTO hf_vobiz_state (k,v,updated_at) VALUES (?1,?2,?3) ON CONFLICT(k) DO UPDATE SET v=?2, updated_at=?3").bind(key, JSON.stringify({ ok, at: now }), now).run();
  } catch { /* cache is optional */ }
  return ok;
}

async function summary(env: Env): Promise<Response> {
  const now = Date.now();
  const dayStart = istDayStart(now), monthStart = istMonthStart(now);
  const newest = await env.DB_META.prepare("SELECT at, ok, account_active FROM hf_vobiz_balance ORDER BY at DESC LIMIT 1").first<Raw>().catch(() => null);
  const lastOk = await env.DB_META.prepare("SELECT at, balance_paise, available_paise, reserved_paise FROM hf_vobiz_balance WHERE ok=1 ORDER BY at DESC LIMIT 1").first<Raw>().catch(() => null);
  const [today, month, unToday, unMonth, chToday, chMonth, alerts, pending, chainOk] = await Promise.all([
    periodStats(env, dayStart, now), periodStats(env, monthStart, now),
    unexplainedFor(env, dayStart, now), unexplainedFor(env, monthStart, now),
    chargedUsers(env, dayStart, now), chargedUsers(env, monthStart, now),
    env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_vobiz_alerts WHERE acked_at IS NULL").first<{ c: number }>().catch(() => null),
    env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_vobiz_legs WHERE cdr_checked_at IS NULL").first<{ c: number }>().catch(() => null),
    chainOkCached(env, now),
  ]);
  return json({
    live: {
      balancePaise: num(lastOk?.balance_paise), availablePaise: num(lastOk?.available_paise), reservedPaise: num(lastOk?.reserved_paise),
      at: num(newest?.at), balanceAt: num(lastOk?.at), ok: newest ? Number(newest.ok) === 1 : false,
      accountActive: newest?.account_active == null ? null : Number(newest.account_active) === 1,
    },
    today, month,
    unexplainedTodayPaise: unToday, unexplainedMonthPaise: unMonth,
    chargedUsersTodayPaise: chToday, chargedUsersMonthPaise: chMonth,
    openAlerts: Number(alerts?.c ?? 0), pendingCdr: Number(pending?.c ?? 0), chainOk,
  }, 200, NO_STORE);
}

async function legsList(env: Env, url: URL): Promise<Response> {
  const callId = url.searchParams.get("callId")?.trim() || undefined;
  const uid = url.searchParams.get("uid")?.trim() || undefined;
  const unknown = url.searchParams.get("unknown") === "1";
  const r = callId ? null : range(url); // a drill-down by call id is not limited to today
  const limit = intParam(url.searchParams.get("limit"), 100, 1, 500), offset = intParam(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const { where, binds } = legWhere({ from: r?.from, to: r?.to, uid, callId, unknown });
  const from = "FROM hf_vobiz_legs l LEFT JOIN hf_calls c ON c.id = l.call_id";
  const total = await env.DB_META.prepare(`SELECT COUNT(*) AS c ${from} ${where}`).bind(...binds).first<{ c: number }>();
  const rs = (await env.DB_META.prepare(
    `SELECT ${LEG_COLS} ${from} ${where} ORDER BY ${LEG_TIME_SQL} DESC, l.seq DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
  ).bind(...binds, limit, offset).all<Raw>()).results ?? [];
  const people = await lookupPeople(env, rs.map((x) => str(x.user_uid)).filter((x): x is string => !!x));
  return json({ items: rs.map((x) => mapLeg(x, people)), total: Number(total?.c ?? 0) }, 200, NO_STORE);
}

async function usersList(env: Env, url: URL): Promise<Response> {
  const { from, to } = range(url);
  const legs = await loadAllLegs(env, { from, to });
  const people = await lookupPeople(env, legs.flatMap((l) => [l.userUid, l.callerUid]).filter((x): x is string => !!x));
  const paid = await paidByCaller(env, from, to);
  // people who paid for calls in the period but have no leg yet still belong in the list
  const missing = [...paid.keys()].filter((u) => !people.has(u));
  for (const [k, v] of await lookupPeople(env, missing)) people.set(k, v);
  return json({ items: aggregateUsers(legs, paid, people) }, 200, NO_STORE);
}

async function callDetail(env: Env, id: string): Promise<Response> {
  const c = await env.DB_META.prepare(
    `SELECT c.id, c.status, c.caller_uid, c.host_uid, c.rate_paise, c.created_at, c.connected_at, c.ended_at, c.billed_minutes, c.charged_paise,
            c.host_earning_paise, c.end_reason, c.host_leg_uuid, c.caller_leg_uuid, h.display_name AS host_name
       FROM hf_calls c LEFT JOIN hf_hosts h ON h.uid = c.host_uid WHERE c.id = ?1`,
  ).bind(id).first<Raw>();
  if (!c) return err(404, "not_found", "No such call.");
  const rows = (await env.DB_META.prepare(
    "SELECT l.*, c.caller_uid AS c_caller_uid FROM hf_vobiz_legs l LEFT JOIN hf_calls c ON c.id = l.call_id WHERE l.call_id = ?1 ORDER BY l.seq",
  ).bind(id).all<Raw>()).results ?? [];
  const people = await lookupPeople(env, [String(c.caller_uid), String(c.host_uid), ...rows.map((x) => str(x.user_uid)).filter((x): x is string => !!x)]);
  const parse = (v: unknown) => { if (typeof v !== "string" || !v) return null; try { return JSON.parse(v) as unknown; } catch { return v; } };
  const caller = people.get(String(c.caller_uid)), host = people.get(String(c.host_uid));
  return json({
    call: {
      id: c.id, status: c.status, callerUid: c.caller_uid, callerName: caller?.name ?? null, callerPhone: caller?.phone ?? null,
      hostUid: c.host_uid, hostName: str(c.host_name) ?? host?.name ?? null, hostPhone: host?.phone ?? null, ratePaise: num(c.rate_paise),
      createdAt: num(c.created_at), connectedAt: num(c.connected_at), endedAt: num(c.ended_at), billedMinutes: num(c.billed_minutes),
      chargedPaise: num(c.charged_paise), hostEarningPaise: num(c.host_earning_paise), endReason: str(c.end_reason),
      hostLegUuid: str(c.host_leg_uuid), callerLegUuid: str(c.caller_leg_uuid),
    },
    legs: rows.map((x) => ({ ...mapLeg(x, people), webhook: parse(x.webhook_json), cdr: parse(x.cdr_json) })),
  }, 200, NO_STORE);
}

async function balanceSeries(env: Env, url: URL): Promise<Response> {
  const { from, to } = range(url);
  const rs = (await env.DB_META.prepare("SELECT at, balance_paise, available_paise, ok FROM hf_vobiz_balance WHERE at >= ?1 AND at <= ?2 ORDER BY at ASC LIMIT 50000").bind(from, to).all<Raw>()).results ?? [];
  const pts = rs.map((r) => ({ at: Number(r.at), balancePaise: num(r.balance_paise), availablePaise: num(r.available_paise), ok: Number(r.ok) === 1 }));
  const recharges = await loadRecharges(env, from, to, 500);
  return json({ points: downsample(pts, 500), recharges }, 200, NO_STORE);
}

async function alertsList(env: Env, url: URL): Promise<Response> {
  const limit = intParam(url.searchParams.get("limit"), 100, 1, 500);
  const rs = (await env.DB_META.prepare("SELECT * FROM hf_vobiz_alerts ORDER BY created_at DESC LIMIT ?1").bind(limit).all<Raw>()).results ?? [];
  const parse = (v: unknown) => { if (typeof v !== "string" || !v) return null; try { return JSON.parse(v) as unknown; } catch { return null; } };
  return json({
    items: rs.map((a) => ({
      id: String(a.id), dedupeKey: String(a.dedupe_key), kind: String(a.kind), severity: String(a.severity), message: String(a.message), amountPaise: num(a.amount_paise),
      meta: parse(a.meta_json), createdAt: Number(a.created_at), sentWhatsapp: Number(a.sent_whatsapp) === 1, sentEmail: Number(a.sent_email) === 1,
      ackedAt: num(a.acked_at), ackedBy: str(a.acked_by),
    })),
  }, 200, NO_STORE);
}
async function alertAck(env: Env, id: string, adminUid: string): Promise<Response> {
  const r = await env.DB_META.prepare("UPDATE hf_vobiz_alerts SET acked_at=?2, acked_by=?3 WHERE id=?1 AND acked_at IS NULL").bind(id, Date.now(), adminUid).run();
  if ((r.meta?.changes ?? 0) > 0) return json({ ok: true }, 200, NO_STORE);
  const exists = await env.DB_META.prepare("SELECT 1 AS x FROM hf_vobiz_alerts WHERE id=?1").bind(id).first();
  return exists ? json({ ok: true, alreadyAcked: true }, 200, NO_STORE) : err(404, "not_found", "No such alert.");
}

async function rechargesList(env: Env): Promise<Response> {
  const rs = (await env.DB_META.prepare(
    "SELECT id, at, amount_paise, kind, utr, invoice_no, note, confirmed, created_by, created_at FROM hf_vobiz_recharges ORDER BY at DESC LIMIT 200",
  ).all<Raw>()).results ?? [];
  const items: RechargeRow[] = rs.map(mapRecharge);
  return json({ items }, 200, NO_STORE);
}
async function readBody(req: Request): Promise<Raw> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 8000) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {}; } catch { return {}; }
}
const clip = (v: unknown, max: number): string | null => { const t = v == null ? "" : String(v).trim(); return t ? t.slice(0, max) : null; };
async function rechargeAdd(req: Request, env: Env, adminUid: string): Promise<Response> {
  const b = await readBody(req);
  const rupees = Number(b.amountRupees);
  if (!Number.isFinite(rupees) || rupees <= 0 || rupees > 10_000_000) return err(400, "invalid_amount", "Enter the amount in rupees (more than 0).");
  const amountPaise = Math.round(rupees * 100);
  let at = Date.now();
  if (b.at != null && b.at !== "") {
    const t = typeof b.at === "number" ? b.at : /^\d+$/.test(String(b.at)) ? Number(b.at) : Date.parse(String(b.at));
    if (!Number.isFinite(t) || t <= 0 || t > Date.now() + DAY_MS) return err(400, "invalid_time", "That date and time is not valid.");
    at = Math.floor(t);
  }
  const id = crypto.randomUUID();
  const res = await chainInsert(env, "hf_vobiz_recharges", {
    id, at, amount_paise: amountPaise, kind: "manual", utr: clip(b.utr, 80), invoice_no: clip(b.invoiceNo, 80), note: clip(b.note, 300),
    confirmed: 1, created_by: adminUid, created_at: Date.now(),
  }, { col: "id", val: id });
  if (!res.inserted) return err(409, "not_saved", "Could not save the recharge. Please try again.");
  return json({ ok: true, id, amountPaise }, 200, NO_STORE);
}
async function rechargeConfirm(env: Env, id: string): Promise<Response> {
  const r = await env.DB_META.prepare("UPDATE hf_vobiz_recharges SET confirmed=1 WHERE id=?1 AND kind='detected' AND confirmed=0").bind(id).run();
  if ((r.meta?.changes ?? 0) > 0) return json({ ok: true }, 200, NO_STORE);
  const row = await env.DB_META.prepare("SELECT kind, confirmed FROM hf_vobiz_recharges WHERE id=?1").bind(id).first<{ kind: string; confirmed: number }>();
  if (!row) return err(404, "not_found", "No such recharge.");
  return json({ ok: true, alreadyConfirmed: true }, 200, NO_STORE);
}

const fileDate = (ms: number) => istDateStr(ms);
async function reportFile(env: Env, url: URL, adminUid: string, kind: "pdf" | "csv"): Promise<Response> {
  const { from, to } = range(url);
  const uid = url.searchParams.get("uid")?.trim() || undefined;
  const d = await buildReportData(env, { from, to, userUid: uid });
  const base = `vobiz-spend-${fileDate(from)}${fileDate(to) !== fileDate(from) ? `_to_${fileDate(to)}` : ""}${uid ? `-${uid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}` : ""}`;
  const headers = { ...CORS, ...NO_STORE, "access-control-expose-headers": "content-disposition" };
  if (kind === "csv") {
    return new Response(renderLegsCsv(d), { status: 200, headers: { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${base}.csv"` } });
  }
  const pdf = await renderReportPdf(d);
  try {
    await recordReport(env, { id: d.meta.id, kind: "download", from, to, userUid: uid ?? null, sha256: await reportDataSha(d), bytes: pdf.length, createdBy: adminUid });
  } catch (e) {
    await trackException(env, e, { route: BASE + "report.pdf", handled: true, extra: { area: "hf_vobiz_admin", step: "record_report" } }).catch(() => undefined);
  }
  return new Response(pdf, { status: 200, headers: { ...headers, "content-type": "application/pdf", "content-disposition": `attachment; filename="${base}.pdf"` } });
}

async function syncDay(req: Request, env: Env): Promise<Response> {
  const b = await readBody(req);
  const date = String(b.date ?? "");
  if (parseIstDate(date) == null) return err(400, "invalid_date", "Use a date like 2026-10-10.");
  const out = { pages: 0, fetched: 0, inserted: 0, filled: 0, unchanged: 0, failed: 0, truncated: false };
  for (let page = 1; page <= 50; page++) {
    const res = await listCdrs(env, { startDate: date, endDate: date, page, perPage: 100 });
    out.pages++;
    for (const cdr of res.items) {
      out.fetched++;
      try { out[await upsertLegFromCdr(env, cdr)]++; } catch { out.failed++; }
    }
    if (!res.hasMore || res.items.length === 0) break;
    if (page === 50) out.truncated = true;
  }
  return json({ ok: true, date, ...out }, 200, NO_STORE);
}

// ── router ───────────────────────────────────────────────────────────────────
/** Returns null when the path is not ours so index.ts can fall through. */
export async function hfVobizAdminRoute(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith(BASE)) return null;
  const m = req.method;
  if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const sub = p.slice(BASE.length);
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error, u.error);
    if (!isAdminUid(env, u.uid)) return err(403, "forbidden", "Forbidden.");
    const log = (action: string, target = "", meta: Record<string, unknown> = {}) => {
      const job = audit(env, u.uid, action, target || sub, { method: m, ...meta });
      try { ctx.waitUntil(job); } catch { void job; }
    };

    let mt: RegExpMatchArray | null;
    if (sub === "summary" && m === "GET") { log("summary"); return await summary(env); }
    if (sub === "legs" && m === "GET") { log("legs", "", { q: url.search.slice(0, 200) }); return await legsList(env, url); }
    if (sub === "users" && m === "GET") { log("users", "", { q: url.search.slice(0, 200) }); return await usersList(env, url); }
    if ((mt = sub.match(/^calls\/([A-Za-z0-9_-]{8,64})$/)) && m === "GET") { log("call", mt[1]); return await callDetail(env, mt[1]); }
    if (sub === "balance" && m === "GET") { log("balance", "", { q: url.search.slice(0, 200) }); return await balanceSeries(env, url); }
    if (sub === "alerts" && m === "GET") { log("alerts"); return await alertsList(env, url); }
    if ((mt = sub.match(/^alerts\/([A-Za-z0-9_-]{8,64})\/ack$/)) && m === "POST") { log("alert_ack", mt[1]); return await alertAck(env, mt[1], u.uid); }
    if (sub === "recharges" && m === "GET") { log("recharges"); return await rechargesList(env); }
    if (sub === "recharges" && m === "POST") { log("recharge_add"); return await rechargeAdd(req, env, u.uid); }
    if ((mt = sub.match(/^recharges\/([A-Za-z0-9_-]{8,64})\/confirm$/)) && m === "POST") { log("recharge_confirm", mt[1]); return await rechargeConfirm(env, mt[1]); }
    if (sub === "report.pdf" && m === "GET") { log("report_pdf", "", { q: url.search.slice(0, 200) }); return await reportFile(env, url, u.uid, "pdf"); }
    if (sub === "report.csv" && m === "GET") { log("report_csv", "", { q: url.search.slice(0, 200) }); return await reportFile(env, url, u.uid, "csv"); }
    if (sub === "sync" && m === "POST") { log("sync"); return await syncDay(req, env); }
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, extra: { area: "hf_vobiz_admin" } }).catch(() => undefined);
    return err(500, "internal_error", "Something went wrong.");
  }
}
