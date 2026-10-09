// [HF-RETENTION-1 2026-10-09] HF per-user data purge. DPDP Act 2023 / rulebook HF-PRIV-6.
//
// ONE implementation, TWO deployments: the worker (workflows/deletion.ts + lib/hf_retention.ts) and the
// consumers (consumers/src/hf_purge.ts, the LIVE account-deletion cascade) cannot import each other
// (deployment boundary), so consumers/src/hf_purge.ts is a VERBATIM COPY of this file. Edit both together.
// It is deliberately self-contained: no imports, structural env type.
//
// What an account deletion removes: verification records (KYC, selfie, payout, OTP ledger), the voice
// intro and profile media, host profile + media jobs, lane access, review tokens and notifications, and
// reviews written by or about the account. What it does NOT remove (kept 1 year, then deleted by
// hf_retention.ts): hf_calls, hf_incidents, hf_blocks -- safety/legal records (includeSafetyRecords=false).
// hf/avatars/ is the shared catalogue and is never touched; the avatar is only released (taken_by_uid=NULL).
//
// Tables owned by other in-flight work (hf_lane_access, hf_calls, ...) may not exist yet and their column
// names are not fixed, so every statement is built from the columns that actually exist (pragma_table_info).

export interface HfPurgeEnv {
  DB_META: D1Database;
  VERIFICATION?: R2Bucket;
  BLOBS?: R2Bucket;
}

export type HfPurgeScope = "full" | "lane_caller";

export interface HfPurgeOpts {
  scope?: HfPurgeScope;
  /** Also delete hf_calls / hf_incidents / hf_blocks rows for the uid. Default false (retained 1 year). */
  includeSafetyRecords?: boolean;
  /** Share across uids in one run to avoid re-reading table columns. */
  colsCache?: Map<string, string[]>;
}

export interface HfPurgeResult {
  uid: string;
  scope: HfPurgeScope;
  counts: Record<string, number>;
  r2: { verification: number; blobs: number };
  avatars_released: number;
  skipped: string[];
  errors: string[];
}

/** Same blast-radius guard as UID_R2_SAFE in deletion_prefixes.ts (a test pins them equal). */
export const HF_UID_SAFE = /^[A-Za-z0-9_.:+-]{4,128}$/;

export interface HfR2Prefixes { verification: string[]; blobs: string[] }

/** R2 prefixes holding one uid's HF files. Empty for an unsafe uid ("delete NOTHING"). Every prefix ends in "/". */
export function hfR2Prefixes(uid: string, scope: HfPurgeScope = "full"): HfR2Prefixes {
  if (!uid || !HF_UID_SAFE.test(uid)) return { verification: [], blobs: [] };
  if (scope === "lane_caller") return { verification: [`hf/kyc/${uid}/`, `hf/selfie/${uid}/`], blobs: [] };
  return {
    verification: [`hf/kyc/${uid}/`, `hf/selfie/${uid}/`, `hf/intro/${uid}/`],
    blobs: [`hf/hosts/${uid}/`],
  };
}

export interface HfTableSpec {
  table: string;
  /** Candidate uid columns; only those that exist are used (OR-ed). */
  cols: string[];
  /** Deleted last, and only if every R2 delete succeeded (so a failed run can be retried from the row). */
  anchor?: boolean;
  /** Safety/legal record: only deleted with includeSafetyRecords. */
  safety?: boolean;
}

const OTHER_UID_COLS = ["caller_uid", "host_uid", "uid"];

export function hfPurgeTables(scope: HfPurgeScope, includeSafetyRecords = false): HfTableSpec[] {
  if (scope === "lane_caller") {
    return [
      { table: "hf_lane_access", cols: OTHER_UID_COLS },
      { table: "hf_selfie", cols: ["uid"] },
      { table: "hf_kyc", cols: ["uid"], anchor: true },
    ];
  }
  const all: HfTableSpec[] = [
    { table: "hf_host_media", cols: ["uid"] },
    { table: "hf_media_jobs", cols: ["uid"] },
    { table: "hf_selfie", cols: ["uid"] },
    { table: "hf_payout", cols: ["uid"] },
    { table: "hf_kyc_otp", cols: ["uid"] },
    { table: "hf_lane_access", cols: OTHER_UID_COLS },
    { table: "hf_review_tokens", cols: OTHER_UID_COLS },
    { table: "hf_notify", cols: ["uid", "caller_uid", "host_uid", "recipient_uid"] },
    { table: "hf_reviews", cols: ["caller_uid", "host_uid", "reviewer_uid", "uid"] },
    { table: "hf_calls", cols: ["caller_uid", "host_uid"], safety: true },
    { table: "hf_incidents", cols: ["caller_uid", "host_uid", "reporter_uid", "reported_uid", "subject_uid", "uid"], safety: true },
    { table: "hf_blocks", cols: ["blocker_uid", "blocked_uid", "caller_uid", "host_uid", "uid"], safety: true },
    { table: "hf_kyc", cols: ["uid"], anchor: true },
    { table: "hf_hosts", cols: ["uid"], anchor: true },
  ];
  return all.filter((t) => includeSafetyRecords || !t.safety);
}

const TABLE_RE = /^hf_[a-z_]{1,40}$/;
const COL_RE = /^[a-z_]{1,40}$/;

/** `DELETE FROM t WHERE c1=?1 OR c2=?1` from the candidates that exist; null when the table/columns are absent. */
export function buildDeleteSql(table: string, existingCols: string[], candidates: string[]): string | null {
  if (!TABLE_RE.test(table)) return null;
  const have = new Set(existingCols);
  const use = candidates.filter((c) => COL_RE.test(c) && have.has(c));
  if (!use.length) return null;
  return `DELETE FROM ${table} WHERE ${use.map((c) => `${c}=?1`).join(" OR ")}`;
}

/** SQL expression turning a seconds-or-milliseconds epoch column into milliseconds. */
export function tsMsExpr(col: string): string {
  return `(CASE WHEN ${col} < 100000000000 THEN ${col} * 1000 ELSE ${col} END)`;
}

export async function tableColumns(db: D1Database, table: string, cache?: Map<string, string[]>): Promise<string[]> {
  if (!TABLE_RE.test(table)) return [];
  const hit = cache?.get(table);
  if (hit) return hit;
  let cols: string[] = [];
  try {
    const r = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
    cols = (r.results ?? []).map((x) => x.name);
  } catch { cols = []; }
  cache?.set(table, cols);
  return cols;
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined, n = 0;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length) { await bucket.delete(keys); n += keys.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return n;
}

/**
 * Delete one uid's HF data. Never throws; failures land in `errors`. Idempotent -- safe to re-run.
 * Never touches the `users` row (the caller decides that) or hf/avatars/.
 */
export async function purgeHfUser(env: HfPurgeEnv, uid: string, opts: HfPurgeOpts = {}): Promise<HfPurgeResult> {
  const scope: HfPurgeScope = opts.scope ?? "full";
  const res: HfPurgeResult = { uid, scope, counts: {}, r2: { verification: 0, blobs: 0 }, avatars_released: 0, skipped: [], errors: [] };
  if (!uid || !HF_UID_SAFE.test(uid)) { res.errors.push("unsafe_uid"); return res; }

  // 1. R2 first. If it fails we keep the anchor rows (hf_kyc / hf_hosts) so the retention sweep can retry.
  const pref = hfR2Prefixes(uid, scope);
  for (const [label, bucket, prefixes] of [["verification", env.VERIFICATION, pref.verification], ["blobs", env.BLOBS, pref.blobs]] as const) {
    if (!prefixes.length) continue;
    if (!bucket) { res.skipped.push(`r2_${label}_unbound`); continue; }
    for (const p of prefixes) {
      try { res.r2[label] += await deleteR2Prefix(bucket, p); }
      catch (e) { res.errors.push(`r2_${label}:${String(e).slice(0, 120)}`); }
    }
  }
  const r2Failed = res.errors.length > 0;

  // 2. Release the host's catalogue avatar for re-use (stays 'active' unless it was already retired).
  if (scope === "full") {
    try {
      const r = await env.DB_META.prepare("UPDATE hf_avatars SET taken_by_uid=NULL WHERE taken_by_uid=?1").bind(uid).run();
      res.avatars_released = Number(r.meta?.changes ?? 0);
    } catch (e) { res.errors.push(`avatars:${String(e).slice(0, 120)}`); }
  }

  // 3. Rows. Anchors last, and only when R2 is clean.
  const specs = hfPurgeTables(scope, !!opts.includeSafetyRecords);
  for (const spec of [...specs.filter((s) => !s.anchor), ...specs.filter((s) => s.anchor)]) {
    if (spec.anchor && r2Failed) { res.skipped.push(`${spec.table}_kept_for_retry`); continue; }
    const cols = await tableColumns(env.DB_META, spec.table, opts.colsCache);
    const sql = buildDeleteSql(spec.table, cols, spec.cols);
    if (!sql) { res.skipped.push(`${spec.table}_absent`); continue; }
    try {
      const r = await env.DB_META.prepare(sql).bind(uid).run();
      res.counts[spec.table] = Number(r.meta?.changes ?? 0);
    } catch (e) { res.errors.push(`${spec.table}:${String(e).slice(0, 120)}`); }
  }
  return res;
}
