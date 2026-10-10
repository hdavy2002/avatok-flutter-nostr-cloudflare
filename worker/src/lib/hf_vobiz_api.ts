// [HF-VOBIZ-SPEND-1] Read-only Vobiz REST client for the spend monitor. Contract: Specs/HF-VOBIZ-SPEND-CONTRACT.md §2.
// Never throws. 8 s timeout per request. Money: rupee decimals -> paise. Times -> epoch ms or null.
// Docs: CDR GET /Account/{id}/cdr (page, per_page<=100, start_date, end_date YYYY-MM-DD), /cdr/{call_id},
// /cdr/recent?limit=, /cdr/export (CSV). Balance GET /Account/{id}/balance/INR. Account GET /Account/{id} (no trailing slash; is_active, enabled, is_verified verified 2026-10-10).
import type { Env } from "../types";

const BASE = "https://api.vobiz.ai/api/v1";
const TIMEOUT_MS = 8000;

export interface VobizBalance { ok: boolean; httpStatus: number; error?: string; balancePaise?: number; availablePaise?: number;
  reservedPaise?: number; promoPaise?: number; creditLimitPaise?: number; status?: string; raw?: unknown }
export interface VobizAccount { ok: boolean; httpStatus: number; error?: string; isActive?: boolean; enabled?: boolean; riskStatus?: string | null; raw?: unknown }
export interface VobizCdr { uuid: string; direction: string | null; from: string | null; to: string | null; startAt: number | null;
  answerAt: number | null; endAt: number | null; durationSec: number | null; billsec: number | null; costPaise: number | null;
  streamingCostPaise: number | null; totalCostPaise: number | null; currency: string | null; hangupCause: string | null;
  hangupSource: string | null; mos: number | null; raw: unknown }

export function vobizConfigured(env: Env): boolean {
  return !!(env.VOBIZ_AUTH_ID && env.VOBIZ_AUTH_TOKEN);
}

// ── pure helpers (exported for tests and for the ledger's webhook mapping) ─────────────────────────────────────────

/** Rupees (number or numeric string, e.g. "0.285") -> integer paise; null if not a finite number. */
export function rupeesToPaise(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : parseFloat(String(x));
  if (!Number.isFinite(n)) return null;
  return Math.round(Number((n * 100).toPrecision(12)));
}

/** Vobiz time string -> epoch ms. A string with no zone is UTC. Numbers: < 1e12 are seconds. Unparseable -> null. */
export function parseTimeMs(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  if (typeof x === "number") return Number.isFinite(x) ? (x < 1e12 ? Math.round(x * 1000) : Math.round(x)) : null;
  let s = String(x).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseTimeMs(Number(s));
  s = s.replace(" ", "T");
  const hasTime = /T\d{2}:\d{2}/.test(s);
  const hasZone = /\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (hasTime && !hasZone) s += "Z";
  else if (!hasTime) s += "T00:00:00Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const intOrNull = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : parseFloat(String(x));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const strOrNull = (x: unknown): string | null => (x === null || x === undefined || x === "" ? null : String(x));
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

/** Tolerant: raw may be the CDR itself, or nested under data / cdr / object / objects[] / results[]. */
export function parseCdr(raw: any): VobizCdr | null {
  let o: any = raw;
  for (let i = 0; i < 4 && o; i++) {
    if (Array.isArray(o)) { o = o[0]; continue; }
    if (!isObj(o)) return null;
    if (o.uuid || o.call_uuid || o.id || o.call_id) break;
    const next = o.data ?? o.cdr ?? o.object ?? o.objects ?? o.results ?? o.items ?? null;
    if (next === null) break;
    o = next;
  }
  if (!isObj(o)) return null;
  // VERIFY ON FIRST LIVE CALL: the exact key names below follow the docs; fallbacks are Plivo-style guesses.
  const uuid = strOrNull(o.uuid ?? o.call_uuid ?? o.id ?? o.call_id);
  if (!uuid) return null;
  return {
    uuid,
    direction: strOrNull(o.call_direction ?? o.direction),
    from: strOrNull(o.caller_id_number ?? o.from_number ?? o.from),
    to: strOrNull(o.destination_number ?? o.to_number ?? o.to),
    startAt: parseTimeMs(o.start_time ?? o.initiation_time),
    answerAt: parseTimeMs(o.answer_time),
    endAt: parseTimeMs(o.end_time),
    durationSec: intOrNull(o.duration),
    billsec: intOrNull(o.billsec ?? o.bill_duration),
    costPaise: rupeesToPaise(o.cost),
    streamingCostPaise: rupeesToPaise(o.streaming_cost),
    totalCostPaise: rupeesToPaise(o.total_cost ?? o.cost),
    currency: strOrNull(o.currency),
    hangupCause: strOrNull(o.hangup_cause),
    hangupSource: strOrNull(o.hangup_source),
    mos: o.mos === null || o.mos === undefined || o.mos === "" || !Number.isFinite(Number(o.mos)) ? null : Number(o.mos),
    raw: o,
  };
}

function listFrom(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (!isObj(raw)) return [];
  for (const k of ["data", "objects", "cdrs", "cdr", "items", "results"]) {
    const v = (raw as any)[k];
    if (Array.isArray(v)) return v;
    if (isObj(v)) { const inner = listFrom(v); if (inner.length) return inner; }
  }
  return [];
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Res { ok: boolean; status: number; text: string; json: any; error?: string }

async function req(env: Env, path: string, accept: "json" | "any" = "json"): Promise<Res> {
  if (!vobizConfigured(env)) return { ok: false, status: 0, text: "", json: null, error: "vobiz_not_configured" };
  try {
    const headers: Record<string, string> = { "X-Auth-ID": env.VOBIZ_AUTH_ID || "", "X-Auth-Token": env.VOBIZ_AUTH_TOKEN || "" };
    if (accept === "json") headers["Accept"] = "application/json";
    const r = await fetch(`${BASE}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await r.text().catch(() => "");
    let json: any = null;
    if (accept === "json") { try { json = JSON.parse(text); } catch { json = null; } }
    return { ok: r.ok, status: r.status, text, json, error: r.ok ? undefined : `http_${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, text: "", json: null, error: e instanceof Error && e.name ? `${e.name}` : "fetch_failed" };
  }
}

const acct = (env: Env) => encodeURIComponent(env.VOBIZ_AUTH_ID || "");

export async function getBalance(env: Env, currency: "INR" = "INR"): Promise<VobizBalance> {
  const r = await req(env, `/Account/${acct(env)}/balance/${currency}`);
  if (!r.ok) return { ok: false, httpStatus: r.status, error: r.error, raw: r.json ?? undefined };
  const j = isObj(r.json) ? (isObj(r.json.data) ? r.json.data : r.json) : null;
  if (!j) return { ok: false, httpStatus: r.status, error: "bad_json" };
  // VERIFY ON FIRST LIVE CALL: field names per docs; values are rupee decimals.
  return {
    ok: true, httpStatus: r.status,
    balancePaise: rupeesToPaise(j.balance) ?? undefined,
    availablePaise: rupeesToPaise(j.available_balance) ?? undefined,
    reservedPaise: rupeesToPaise(j.reserved_funds) ?? undefined,
    promoPaise: rupeesToPaise(j.promotional_balance) ?? undefined,
    creditLimitPaise: rupeesToPaise(j.credit_limit) ?? undefined,
    status: strOrNull(j.status) ?? undefined,
    raw: r.json,
  };
}

export async function getAccount(env: Env): Promise<VobizAccount> {
  const r = await req(env, `/Account/${acct(env)}`); // [HF-VOBIZ-SPEND-3] verified 2026-10-10: no trailing slash (with one the body is empty)
  if (!r.ok) return { ok: false, httpStatus: r.status, error: r.error, raw: r.json ?? undefined };
  const j = isObj(r.json) ? (isObj(r.json.data) ? r.json.data : isObj(r.json.account) ? r.json.account : r.json) : null;
  if (!j) return { ok: false, httpStatus: r.status, error: "bad_json" };
  // VERIFY ON FIRST LIVE CALL: is_active / enabled / risk_status per docs.
  const b = (x: unknown): boolean | undefined => (x === undefined || x === null ? undefined : x === true || x === 1 || x === "true" || x === "1");
  return { ok: true, httpStatus: r.status, isActive: b(j.is_active), enabled: b(j.enabled), riskStatus: j.risk_status === undefined ? null : strOrNull(j.risk_status), raw: r.json };
}

export async function getCdr(env: Env, legUuid: string): Promise<VobizCdr | null> {
  const r = await req(env, `/Account/${acct(env)}/cdr/${encodeURIComponent(legUuid)}`);
  if (!r.ok || !r.json) return null;
  return parseCdr(r.json);
}

export async function listRecentCdrs(env: Env, limit = 50): Promise<VobizCdr[]> {
  const r = await req(env, `/Account/${acct(env)}/cdr/recent?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`);
  if (!r.ok || !r.json) return [];
  return listFrom(r.json).map(parseCdr).filter((c): c is VobizCdr => !!c);
}

export async function listCdrs(env: Env, q: { startDate: string; endDate: string; page?: number; perPage?: number }): Promise<{ items: VobizCdr[]; hasMore: boolean }> {
  const perPage = Math.max(1, Math.min(100, q.perPage ?? 100));
  const page = Math.max(1, q.page ?? 1);
  const qs = `page=${page}&per_page=${perPage}&start_date=${encodeURIComponent(q.startDate)}&end_date=${encodeURIComponent(q.endDate)}`;
  const r = await req(env, `/Account/${acct(env)}/cdr?${qs}`);
  if (!r.ok || !r.json) return { items: [], hasMore: false };
  const rows = listFrom(r.json);
  const items = rows.map(parseCdr).filter((c): c is VobizCdr => !!c);
  // VERIFY ON FIRST LIVE CALL: pagination keys. Fall back to "a full page means there may be more".
  const m: any = isObj(r.json) ? (r.json.meta ?? r.json.pagination ?? r.json) : {};
  let hasMore = rows.length >= perPage;
  if (typeof m.has_more === "boolean") hasMore = m.has_more;
  else if (typeof m.total_pages === "number") hasMore = page < m.total_pages;
  else if (typeof m.total === "number") hasMore = page * perPage < m.total;
  return { items, hasMore };
}

export async function exportCdrCsv(env: Env, startDate: string, endDate: string): Promise<string | null> {
  const r = await req(env, `/Account/${acct(env)}/cdr/export?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`, "any");
  return r.ok ? r.text : null;
}
