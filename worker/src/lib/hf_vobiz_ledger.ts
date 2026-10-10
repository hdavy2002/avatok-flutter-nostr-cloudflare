// [HF-VOBIZ-SPEND-1] Tamper-evident ledger of every Vobiz leg we pay for. Contract: Specs/HF-VOBIZ-SPEND-CONTRACT.md §1, §3.
// NEVER PURGED (owner decision: keep 8 years). Phone numbers are stored in full but never logged.
//
// Hash rule: row_hash = sha256hex(prev_hash + "|" + canonicalJson(hashed columns)), prev_hash = row_hash of the previous row
// (by rowid) in the same table, '' for the first row.
//
// WHAT IS HASHED (HASH_COLS below) - insert-time columns only. For hf_vobiz_legs the columns that are amended later
// (cdr_json, cdr_checked_at, cdr_attempts, mismatch) are NOT hashed. The rule that keeps this consistent:
//   - a leg created from the hangup WEBHOOK holds the webhook's numbers in its cost/billsec/time columns, forever;
//     the Vobiz CDR numbers live only in cdr_json (+ the `mismatch` note). The CDR fill never rewrites hashed columns.
//   - a leg created from a CDR holds the CDR numbers in those columns.
//   - every CDR fill (and every CDR-created leg) also appends a row to hf_vobiz_leg_cdr_log holding sha256(canonical(cdr)),
//     itself chained, so a later edit of cdr_json can be detected by comparing against that log.
// hf_vobiz_recharges.confirmed is also excluded from the hash (the owner flips it 0 -> 1 on a detected row).
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { getCdr, rupeesToPaise, parseTimeMs, type VobizCdr } from "./hf_vobiz_api";

type ChainTable = "hf_vobiz_legs" | "hf_vobiz_leg_cdr_log" | "hf_vobiz_balance" | "hf_vobiz_recharges";

const APP = BRAND.slug;

/** Columns covered by row_hash, per table. Order irrelevant (canonical JSON sorts keys). */
export const HASH_COLS: Record<ChainTable, string[]> = {
  hf_vobiz_legs: ["leg_uuid", "call_id", "role", "user_uid", "direction", "from_number", "to_number", "start_at", "answer_at", "end_at",
    "duration_sec", "billsec", "cost_paise", "streaming_cost_paise", "total_cost_paise", "currency", "hangup_cause", "hangup_source",
    "mos", "source", "webhook_json", "created_at"],
  hf_vobiz_leg_cdr_log: ["leg_uuid", "cdr_hash", "created_at"],
  hf_vobiz_balance: ["at", "balance_paise", "available_paise", "reserved_paise", "promo_paise", "credit_limit_paise", "status",
    "account_active", "account_enabled", "risk_status", "ok", "http_status", "error", "raw_json"],
  hf_vobiz_recharges: ["id", "at", "amount_paise", "kind", "utr", "invoice_no", "note", "created_by", "created_at"],
};
const ALL_COLS: Record<ChainTable, string[]> = {
  hf_vobiz_legs: [...HASH_COLS.hf_vobiz_legs, "cdr_json", "cdr_checked_at", "cdr_attempts", "mismatch"],
  hf_vobiz_leg_cdr_log: HASH_COLS.hf_vobiz_leg_cdr_log,
  hf_vobiz_balance: HASH_COLS.hf_vobiz_balance,
  hf_vobiz_recharges: [...HASH_COLS.hf_vobiz_recharges, "confirmed"],
};

// ── hashing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortDeep((v as Record<string, unknown>)[k]);
    return o;
  }
  return v === undefined ? null : v;
}
/** JSON with all object keys sorted (recursively); undefined -> null. */
export function canonicalJson(v: unknown): string { return JSON.stringify(sortDeep(v)); }

export async function computeRowHash(prevHash: string, fields: Record<string, unknown>): Promise<string> {
  return sha256Hex(`${prevHash}|${canonicalJson(fields)}`);
}

function hashedFields(table: ChainTable, row: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const c of HASH_COLS[table]) o[c] = row[c] === undefined ? null : row[c];
  return o;
}

// ── chained insert ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Append one row. Race-safe: one INSERT..SELECT whose WHERE re-checks that prev_hash is still the latest row_hash (and, if
 * uniqueKey is given, that the key is not already present). changes==0 means duplicate (-> inserted:false) or a lost race (retry, max 4 tries).
 */
export async function chainInsert(env: Env, table: ChainTable, row: Record<string, unknown>,
  uniqueKey?: { col: string; val: string }): Promise<{ inserted: boolean; rowHash: string }> {
  const db = env.DB_META;
  const cols = ALL_COLS[table].filter((c) => row[c] !== undefined);
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await db.prepare(`SELECT row_hash FROM ${table} ORDER BY rowid DESC LIMIT 1`).first<{ row_hash: string }>();
    const prev = latest?.row_hash ?? "";
    const rowHash = await computeRowHash(prev, hashedFields(table, row));
    const allCols = [...cols, "row_hash", "prev_hash"];
    const vals: unknown[] = [...cols.map((c) => row[c] ?? null), rowHash, prev];
    let sql = `INSERT INTO ${table} (${allCols.join(",")}) SELECT ${allCols.map(() => "?").join(",")} WHERE (SELECT COALESCE((SELECT row_hash FROM ${table} ORDER BY rowid DESC LIMIT 1), '')) = ?`;
    vals.push(prev);
    if (uniqueKey) { sql += ` AND NOT EXISTS (SELECT 1 FROM ${table} WHERE ${uniqueKey.col} = ?)`; vals.push(uniqueKey.val); }
    const r = await db.prepare(sql).bind(...vals).run();
    if ((r.meta?.changes ?? 0) > 0) return { inserted: true, rowHash };
    if (uniqueKey) {
      const ex = await db.prepare(`SELECT row_hash FROM ${table} WHERE ${uniqueKey.col} = ?`).bind(uniqueKey.val).first<{ row_hash: string }>();
      if (ex) return { inserted: false, rowHash: ex.row_hash };
    }
  }
  throw new Error(`hf_vobiz chain_race on ${table}`);
}

// ── webhook capture ─────────────────────────────────────────────────────────────────────────────────────────────────

const intOrNull = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = parseFloat(String(x));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const strOrNull = (x: unknown): string | null => (x === null || x === undefined || x === "" ? null : String(x));

/** Attribute a leg to one of our calls by its Vobiz uuid (hf_calls.host_leg_uuid / caller_leg_uuid). */
async function attributeByLeg(env: Env, legUuid: string): Promise<{ callId: string; role: "host" | "caller"; uid: string } | null> {
  const row = await env.DB_META.prepare("SELECT id, host_uid, caller_uid, host_leg_uuid FROM hf_calls WHERE host_leg_uuid = ?1 OR caller_leg_uuid = ?1").bind(legUuid).first<any>();
  if (!row) return null;
  const role = row.host_leg_uuid === legUuid ? "host" : "caller";
  return { callId: row.id, role, uid: role === "host" ? row.host_uid : row.caller_uid };
}

/** Never throws. Called from HfCallDO.hangup() for each hangup webhook (both legs). */
export async function recordLegFromWebhook(env: Env, a: { callId: string; role: "host" | "caller"; legUuid: string | null; fields: Record<string, string> }): Promise<void> {
  try {
    const f = a.fields || {};
    const legUuid = strOrNull(f.CallUUID) ?? a.legUuid;
    if (!legUuid) return;
    const c = await env.DB_META.prepare("SELECT host_uid, caller_uid FROM hf_calls WHERE id = ?").bind(a.callId).first<{ host_uid: string; caller_uid: string }>();
    const user = c ? (a.role === "host" ? c.host_uid : c.caller_uid) : null;
    // VERIFY ON FIRST LIVE CALL: Plivo-dialect webhook field names; TotalCost assumed to be rupees.
    const totalPaise = rupeesToPaise(f.TotalCost);
    await chainInsert(env, "hf_vobiz_legs", {
      leg_uuid: legUuid, call_id: c ? a.callId : null, role: a.role, user_uid: user ?? null,
      direction: strOrNull(f.Direction)?.toLowerCase() ?? null,
      from_number: strOrNull(f.From), to_number: strOrNull(f.To),
      start_at: parseTimeMs(f.StartTime), answer_at: parseTimeMs(f.AnswerTime), end_at: parseTimeMs(f.EndTime) ?? Date.now(),
      duration_sec: intOrNull(f.Duration), billsec: intOrNull(f.BillDuration),
      cost_paise: totalPaise, streaming_cost_paise: null, total_cost_paise: totalPaise, currency: strOrNull(f.Currency),
      hangup_cause: strOrNull(f.HangupCause), hangup_source: strOrNull(f.HangupSource), mos: null,
      source: "webhook", webhook_json: JSON.stringify(f),
      cdr_json: null, cdr_checked_at: null, cdr_attempts: 0, mismatch: null,
      created_at: Date.now(),
    }, { col: "leg_uuid", val: legUuid });
    // [HF-VOBIZ-SPEND-1] success value: has_cost=true means the webhook carried Vobiz's charge for this leg.
    void track(env, user ?? "system", "hf_vobiz_leg_recorded", APP, { area: "hf_vobiz", source: "webhook", role: a.role, has_cost: totalPaise !== null }).catch(() => undefined);
  } catch (e) {
    await trackException(env, e, { route: "hf_vobiz_ledger.webhook", handled: true, app_name: APP, extra: { area: "hf_vobiz", call: a.callId } });
  }
}

// ── CDR reconcile ───────────────────────────────────────────────────────────────────────────────────────────────────

function mismatchNote(webhookTotal: number | null, webhookBill: number | null, cdr: VobizCdr): string | null {
  const notes: string[] = [];
  if (webhookTotal !== null && cdr.totalCostPaise !== null && Math.abs(webhookTotal - cdr.totalCostPaise) > 1)
    notes.push(`cost webhook ${webhookTotal} vs cdr ${cdr.totalCostPaise} paise`);
  if (webhookBill !== null && cdr.billsec !== null && Math.abs(webhookBill - cdr.billsec) > 2)
    notes.push(`billsec webhook ${webhookBill} vs cdr ${cdr.billsec}`);
  return notes.length ? notes.join("; ") : null;
}

async function appendCdrLog(env: Env, legUuid: string, cdr: VobizCdr, now: number): Promise<void> {
  await chainInsert(env, "hf_vobiz_leg_cdr_log", { leg_uuid: legUuid, cdr_hash: await sha256Hex(canonicalJson(cdr.raw)), created_at: now });
}

async function upsertCore(env: Env, cdr: VobizCdr): Promise<{ result: "inserted" | "filled" | "unchanged"; mismatch: boolean }> {
  const now = Date.now();
  const ex = await env.DB_META.prepare("SELECT leg_uuid, total_cost_paise, billsec, cdr_checked_at, source FROM hf_vobiz_legs WHERE leg_uuid = ?").bind(cdr.uuid).first<any>();
  const rawJson = JSON.stringify(cdr.raw);
  if (!ex) {
    const att = await attributeByLeg(env, cdr.uuid);
    const r = await chainInsert(env, "hf_vobiz_legs", {
      leg_uuid: cdr.uuid, call_id: att?.callId ?? null, role: att?.role ?? "unknown", user_uid: att?.uid ?? null,
      direction: cdr.direction?.toLowerCase() ?? null, from_number: cdr.from, to_number: cdr.to,
      start_at: cdr.startAt, answer_at: cdr.answerAt, end_at: cdr.endAt, duration_sec: cdr.durationSec, billsec: cdr.billsec,
      cost_paise: cdr.costPaise, streaming_cost_paise: cdr.streamingCostPaise, total_cost_paise: cdr.totalCostPaise, currency: cdr.currency,
      hangup_cause: cdr.hangupCause, hangup_source: cdr.hangupSource, mos: cdr.mos,
      source: "cdr", webhook_json: null, cdr_json: rawJson, cdr_checked_at: now, cdr_attempts: 1, mismatch: null, created_at: now,
    }, { col: "leg_uuid", val: cdr.uuid });
    if (r.inserted) { await appendCdrLog(env, cdr.uuid, cdr, now); return { result: "inserted", mismatch: false }; }
    return { result: "unchanged", mismatch: false };
  }
  if (ex.cdr_checked_at !== null && ex.cdr_checked_at !== undefined) return { result: "unchanged", mismatch: false };
  const note = ex.source === "webhook" ? mismatchNote(ex.total_cost_paise ?? null, ex.billsec ?? null, cdr) : null;
  const u = await env.DB_META.prepare("UPDATE hf_vobiz_legs SET cdr_json = ?, cdr_checked_at = ?, cdr_attempts = cdr_attempts + 1, mismatch = ? WHERE leg_uuid = ? AND cdr_checked_at IS NULL")
    .bind(rawJson, now, note, cdr.uuid).run();
  if ((u.meta?.changes ?? 0) === 0) return { result: "unchanged", mismatch: false };
  await appendCdrLog(env, cdr.uuid, cdr, now);
  // [HF-VOBIZ-SPEND-1] success value: has_cost=true means Vobiz's own CDR gave us a total cost for the leg.
  void track(env, "system", "hf_vobiz_cdr_checked", APP, { area: "hf_vobiz", has_cost: cdr.totalCostPaise !== null, mismatch: !!note }).catch(() => undefined);
  return { result: "filled", mismatch: !!note };
}

export async function upsertLegFromCdr(env: Env, cdr: VobizCdr): Promise<"inserted" | "filled" | "unchanged"> {
  return (await upsertCore(env, cdr)).result;
}

/** Legs still waiting for their CDR, ended > 90 s ago, fewer than 30 attempts. Never throws. */
export async function recheckPendingLegs(env: Env, max = 20): Promise<{ checked: number; filled: number; mismatches: number }> {
  const out = { checked: 0, filled: 0, mismatches: 0 };
  try {
    const cutoff = Date.now() - 90_000;
    const rows = await env.DB_META.prepare(
      "SELECT leg_uuid FROM hf_vobiz_legs WHERE cdr_checked_at IS NULL AND cdr_attempts < 30 AND COALESCE(end_at, created_at) < ? ORDER BY seq LIMIT ?",
    ).bind(cutoff, max).all<{ leg_uuid: string }>();
    for (const r of rows.results ?? []) {
      out.checked++;
      try {
        const cdr = await getCdr(env, r.leg_uuid);
        if (cdr) {
          const x = await upsertCore(env, { ...cdr, uuid: r.leg_uuid });
          if (x.result === "filled") { out.filled++; if (x.mismatch) out.mismatches++; continue; }
        }
        await env.DB_META.prepare("UPDATE hf_vobiz_legs SET cdr_attempts = cdr_attempts + 1 WHERE leg_uuid = ? AND cdr_checked_at IS NULL").bind(r.leg_uuid).run();
      } catch (e) {
        await trackException(env, e, { route: "hf_vobiz_ledger.recheck", handled: true, app_name: APP, extra: { area: "hf_vobiz" } });
      }
    }
  } catch (e) {
    await trackException(env, e, { route: "hf_vobiz_ledger.recheck", handled: true, app_name: APP, extra: { area: "hf_vobiz" } });
  }
  return out;
}

// ── verification ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Walk the chain (by rowid) from `fromSeqOrId` (default: the start) and recompute every hash. brokenAt = rowid of the first bad row. */
export async function verifyChain(env: Env, table: string, fromSeqOrId = 0): Promise<{ ok: boolean; rows: number; brokenAt?: number }> {
  if (!(table in HASH_COLS)) return { ok: false, rows: 0 };
  const t = table as ChainTable;
  const db = env.DB_META;
  let prev: string;
  if (fromSeqOrId > 0) {
    const p = await db.prepare(`SELECT row_hash FROM ${t} WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`).bind(fromSeqOrId).first<{ row_hash: string }>();
    prev = p?.row_hash ?? "";
  } else prev = "";
  let cursor = fromSeqOrId > 0 ? fromSeqOrId - 1 : 0;
  let rows = 0;
  for (;;) {
    const page = await db.prepare(`SELECT rowid AS rid, * FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT 500`).bind(cursor).all<Record<string, unknown>>();
    const list = page.results ?? [];
    if (!list.length) break;
    for (const r of list) {
      rows++;
      const rid = Number(r.rid);
      if (r.prev_hash !== prev || (await computeRowHash(prev, hashedFields(t, r))) !== r.row_hash) return { ok: false, rows, brokenAt: rid };
      prev = r.row_hash as string;
      cursor = rid;
    }
    if (list.length < 500) break;
  }
  return { ok: true, rows };
}
