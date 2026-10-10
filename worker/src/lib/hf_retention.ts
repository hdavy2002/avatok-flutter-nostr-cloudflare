// [HF-RETENTION-1 2026-10-09] HF data-retention purge. DPDP Act 2023 / rulebook HF-PRIV-6:
// host data is kept while hosting + 1 year; call records and safety logs are kept 1 year, then deleted.
// Called from scheduled() every 5-minute tick; self-throttles to once per IST day through KV (same shape
// as preeti/maintenance.ts). If a step still has work left after its batch limit, the day key is released
// so the next tick continues the backlog.
//
// Tables owned by other in-flight work (hf_calls, hf_incidents, hf_blocks, hf_reviews, hf_review_tokens,
// hf_notify, hf_lane_access) may not exist yet and their exact columns are not fixed -- every statement is
// built from the columns that exist (see hf_purge.ts) and a missing table/column makes that step a no-op.
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { purgeHfUser, tableColumns, tsMsExpr, type HfPurgeResult } from "./hf_purge";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
export const HF_RETENTION = {
  callsDays: 365, incidentsDays: 365, blocksDays: 365,
  notifyDays: 90, kycOtpDays: 30, pushTokenDays: 180,
  draftDays: 365, closedHostDays: 365, laneCallerDays: 365,
  rowBatch: 200, uidBatch: 50, maxRowBatchesPerRun: 5,
} as const;

const DRAFT_STATUSES = ["draft", "pending_host", "rejected"];
const CLOSED_STATUSES = ["closed"];            // no such status exists yet; honoured if/when hosts can close
const DELETED_DONE = "SELECT uid FROM deletion_requests WHERE status='done'";

export interface HfRetentionSummary {
  calls: number; incidents: number; blocks: number; review_tokens: number; notify: number; reviews: number;
  kyc_otp: number; push_tokens: number; drafts: number; closed_hosts: number; lane_callers: number;
  r2_objects: number; errors: number; more: boolean; ms: number;
}

type Cols = Map<string, string[]>;

/** COALESCE of the timestamp columns that exist, normalised to ms; null if none exist. */
function tsExpr(cols: string[], candidates: string[]): string | null {
  const have = candidates.filter((c) => cols.includes(c));
  if (!have.length) return null;
  return have.length === 1 ? tsMsExpr(have[0]) : tsMsExpr(`COALESCE(${have.join(", ")})`);
}

/** Batched, rowid-limited delete loop. Returns rows deleted and whether the batch cap was hit. */
async function deleteBatched(env: Env, table: string, where: string, binds: unknown[]): Promise<{ n: number; more: boolean }> {
  let n = 0;
  for (let i = 0; i < HF_RETENTION.maxRowBatchesPerRun; i++) {
    const r = await env.DB_META.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${HF_RETENTION.rowBatch})`,
    ).bind(...binds).run();
    const c = Number(r.meta?.changes ?? 0);
    n += c;
    if (c < HF_RETENTION.rowBatch) return { n, more: false };
  }
  return { n, more: true };
}

/** Rows older than `days` by the first existing timestamp column. `extra` is AND-ed on. */
async function purgeOld(env: Env, cols: Cols, table: string, tsCandidates: string[], days: number, extra?: (c: string[]) => string | null) {
  const c = await tableColumns(env.DB_META, table, cols);
  const ts = tsExpr(c, tsCandidates);
  if (!ts) return { n: 0, more: false };
  const cutoff = Date.now() - days * DAY_MS;
  const ex = extra ? extra(c) : "";
  if (ex === null) return { n: 0, more: false };
  return deleteBatched(env, table, `${ts} < ?1${ex ? ` AND ${ex}` : ""}`, [cutoff]);
}

const notOnHold = (c: string[]) => (c.includes("legal_hold") ? "COALESCE(legal_hold,0)=0" : "");

async function runStep<T>(env: Env, ctx: ExecutionContext, name: string, errs: { n: number }, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); }
  catch (e) {
    errs.n++;
    console.error(`[hf-retention] ${name} failed:`, String(e));
    ctx.waitUntil(trackException(env, e, { route: `hf_retention:${name}`, handled: true, app_name: BRAND.slug, extra: { area: "hf_retention", step: name } }));
    return fallback;
  }
}

async function purgeUids(env: Env, cols: Cols, uids: string[], scope: "full" | "lane_caller", acc: { r2: number; errs: number }): Promise<number> {
  let done = 0;
  for (const uid of uids) {
    const r: HfPurgeResult = await purgeHfUser(env, uid, { scope, colsCache: cols });
    acc.r2 += r.r2.verification + r.r2.blobs;
    if (r.errors.length) { acc.errs++; console.error("[hf-retention] purge errors", uid.slice(0, 12), r.errors.join("|")); } else done++;
  }
  return done;
}

export async function runHfRetention(env: Env, ctx: ExecutionContext): Promise<HfRetentionSummary | null> {
  const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const key = `hf_retention:${day}`;
  if (await env.TOKENS.get(key)) return null;
  await env.TOKENS.put(key, "1", { expirationTtl: 2 * 24 * 3600 });

  const t0 = Date.now();
  const cols: Cols = new Map();
  const errs = { n: 0 };
  const acc = { r2: 0, errs: 0 };
  let more = false;
  const s: HfRetentionSummary = { calls: 0, incidents: 0, blocks: 0, review_tokens: 0, notify: 0, reviews: 0, kyc_otp: 0, push_tokens: 0, drafts: 0, closed_hosts: 0, lane_callers: 0, r2_objects: 0, errors: 0, more: false, ms: 0 };
  const rows = (r: { n: number; more: boolean }) => { if (r.more) more = true; return r.n; };

  // Call records (time, length, price, how it ended): 1 year.
  s.calls = await runStep(env, ctx, "calls", errs, async () => rows(await purgeOld(env, cols, "hf_calls", ["ended_at", "created_at"], HF_RETENTION.callsDays)), 0);
  // Safety incidents: 1 year, unless the row carries a legal_hold flag.
  s.incidents = await runStep(env, ctx, "incidents", errs, async () => rows(await purgeOld(env, cols, "hf_incidents", ["created_at", "opened_at"], HF_RETENTION.incidentsDays, notOnHold)), 0);

  // Blocks are live safety state: kept while both accounts exist. Deleted at 1 year only when either account
  // has been deleted (deletion_requests.status='done' -- see report: not "missing from users").
  s.blocks = await runStep(env, ctx, "blocks", errs, async () => {
    const c = await tableColumns(env.DB_META, "hf_blocks", cols);
    const uidCols = ["blocker_uid", "blocked_uid", "caller_uid", "host_uid", "uid"].filter((x) => c.includes(x));
    return rows(await purgeOld(env, cols, "hf_blocks", ["created_at"], HF_RETENTION.blocksDays,
      () => (uidCols.length ? `(${uidCols.map((x) => `${x} IN (${DELETED_DONE})`).join(" OR ")})` : null)));
  }, 0);

  // Review-request tokens past their expiry.
  s.review_tokens = await runStep(env, ctx, "review_tokens", errs, async () => {
    const c = await tableColumns(env.DB_META, "hf_review_tokens", cols);
    if (!c.includes("expires_at")) return 0;
    return rows(await deleteBatched(env, "hf_review_tokens", `${tsMsExpr("expires_at")} < ?1`, [Date.now()]));
  }, 0);

  // Notification log: 90 days.
  s.notify = await runStep(env, ctx, "notify", errs, async () => rows(await purgeOld(env, cols, "hf_notify", ["created_at", "sent_at"], HF_RETENTION.notifyDays)), 0);

  // Reviews are public content: kept unless the caller or host account has been deleted (backstop for the
  // deletion path, which already removes them).
  s.reviews = await runStep(env, ctx, "reviews", errs, async () => {
    const c = await tableColumns(env.DB_META, "hf_reviews", cols);
    const uidCols = ["caller_uid", "host_uid"].filter((x) => c.includes(x));
    if (!uidCols.length) return 0;
    return rows(await deleteBatched(env, "hf_reviews", uidCols.map((x) => `${x} IN (${DELETED_DONE})`).join(" OR "), []));
  }, 0);

  // KYC OTP ledger: 30 days.
  s.kyc_otp = await runStep(env, ctx, "kyc_otp", errs, async () => rows(await purgeOld(env, cols, "hf_kyc_otp", ["created_at"], HF_RETENTION.kycOtpDays)), 0);

  // [HF-APP-4] Push device tokens not seen for 180 days (the app re-registers on every sign-in, so a live device is never old).
  s.push_tokens = await runStep(env, ctx, "push_tokens", errs, async () => rows(await purgeOld(env, cols, "hf_push_tokens", ["last_seen_at"], HF_RETENTION.pushTokenDays)), 0);

  // Abandoned host drafts: never went live and untouched for a year -> full HF purge (users row stays).
  s.drafts = await runStep(env, ctx, "drafts", errs, async () => {
    const cutoff = Date.now() - HF_RETENTION.draftDays * DAY_MS;
    const q = `SELECT uid FROM hf_hosts WHERE status IN (${DRAFT_STATUSES.map(() => "?").join(",")}) AND ${tsMsExpr("updated_at")} < ? ORDER BY updated_at LIMIT ${HF_RETENTION.uidBatch + 1}`;
    const r = await env.DB_META.prepare(q).bind(...DRAFT_STATUSES, cutoff).all<{ uid: string }>();
    const uids = (r.results ?? []).map((x) => x.uid);
    if (uids.length > HF_RETENTION.uidBatch) more = true;
    return purgeUids(env, cols, uids.slice(0, HF_RETENTION.uidBatch), "full", acc);
  }, 0);

  // Closed hosts. Accounts are HARD-deleted after the 30-day grace (the deletion path now purges HF data at
  // that moment), so this is (a) a backstop for HF rows of accounts whose deletion is 'done' but whose purge
  // failed (R2 error keeps the anchor row), and (b) hosts with a 'closed' status once 365 days old.
  s.closed_hosts = await runStep(env, ctx, "closed_hosts", errs, async () => {
    const cutoff = Date.now() - HF_RETENTION.closedHostDays * DAY_MS;
    const lim = HF_RETENTION.uidBatch + 1;
    const a = await env.DB_META.prepare(
      `SELECT uid FROM hf_hosts WHERE uid IN (${DELETED_DONE}) UNION SELECT uid FROM hf_kyc WHERE uid IN (${DELETED_DONE}) LIMIT ${lim}`,
    ).all<{ uid: string }>();
    const b = await env.DB_META.prepare(
      `SELECT uid FROM hf_hosts WHERE status IN (${CLOSED_STATUSES.map(() => "?").join(",")}) AND ${tsMsExpr("updated_at")} < ? LIMIT ${lim}`,
    ).bind(...CLOSED_STATUSES, cutoff).all<{ uid: string }>();
    const uids = [...new Set([...(a.results ?? []), ...(b.results ?? [])].map((x) => x.uid))];
    if (uids.length > HF_RETENTION.uidBatch) more = true;
    return purgeUids(env, cols, uids.slice(0, HF_RETENTION.uidBatch), "full", acc);
  }, 0);

  // Lane callers: no call as caller in 365 days AND KYC verified > 365 days ago -> drop KYC row, KYC/selfie
  // objects and lane access. Skipped entirely while hf_calls (caller_uid) does not exist: with no activity
  // data we must not guess.
  s.lane_callers = await runStep(env, ctx, "lane_callers", errs, async () => {
    const cc = await tableColumns(env.DB_META, "hf_calls", cols);
    const kc = await tableColumns(env.DB_META, "hf_kyc", cols);
    const callTs = tsExpr(cc, ["ended_at", "created_at"]);
    if (!cc.includes("caller_uid") || !callTs || !kc.includes("role")) return 0;
    const cutoff = Date.now() - HF_RETENTION.laneCallerDays * DAY_MS;
    const ver = tsMsExpr("COALESCE(k.verified_at, k.updated_at)");
    const r = await env.DB_META.prepare(
      `SELECT k.uid FROM hf_kyc k WHERE k.role='lane_caller' AND ${ver} < ?1
         AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.caller_uid=k.uid AND ${callTs.replaceAll(/\b(ended_at|created_at)\b/g, "c.$1")} >= ?1)
       LIMIT ${HF_RETENTION.uidBatch + 1}`,
    ).bind(cutoff).all<{ uid: string }>();
    const uids = (r.results ?? []).map((x) => x.uid);
    if (uids.length > HF_RETENTION.uidBatch) more = true;
    return purgeUids(env, cols, uids.slice(0, HF_RETENTION.uidBatch), "lane_caller", acc);
  }, 0);

  s.r2_objects = acc.r2;
  s.errors = errs.n + acc.errs;
  s.more = more;
  s.ms = Date.now() - t0;
  if (more) { try { await env.TOKENS.delete(key); } catch { /* next day's key still rolls over */ } }  // continue next tick
  await track(env, "system", "hf_retention_run", BRAND.slug, { day, ...s });
  return s;
}
