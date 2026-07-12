// [AVA-SPAM-2] AvaDial community spam-shield routes — Phase 2a. ALL DARK behind the
// `spamShield` flag (config.ts DEFAULTS, default false): every route below 403s and
// the nightly job no-ops while OFF. Spec: Specs/PLAN-2026-07-12-home-ava-tok-services
// -shell.md §4.4 (D1 + Cache API + R2; deterministic versioned scoring; AI only
// classifies free-text reasons — never decides the verdict).
//
// Read path (§4.4 item 3): lookups hit D1 by e164_hash through the Cache API (~24h
// TTL); the bloom filter + version manifest distribute from R2 (public, CDN-cached
// via BLOSSOM_BASE_URL) — NO new R2 binding, we reuse the existing public BLOBS
// bucket (same pipeline /upload/public + affiliate assets already use).
import type { Env } from "../types";
import { json, normalizePhone, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { requireAdmin } from "./admin_money";
import { metaDb } from "../db/shard";
import { rateLimit } from "../money";
import { readConfig } from "./config";
import {
  scoreNumber,
  computeReporterTrust,
  FORMULA_VERSION,
  BASE_TRUST,
  type ReportInput,
  type SpamLabel,
} from "../spam/scoring";
import { buildBloom, serializeBloom, type BloomFilter } from "../spam/bloom";

const REPORT_RL = { max: 30, windowSec: 3600 }; // per-uid report cap
const LOOKUP_CACHE_TTL_S = 24 * 60 * 60; // 24h edge cache — scores change nightly
const BLOOM_KEY_PREFIX = "spam/bloom";
const MANIFEST_KEY = "spam/bloom/manifest.json";

/** True when the whole feature is enabled in KV `platform_config`. */
async function shieldOn(env: Env): Promise<boolean> {
  try {
    return (await readConfig(env)).spamShield === true;
  } catch {
    return false; // fail-closed: config unreadable → stay dark
  }
}

const off = () => json({ error: "spam shield disabled" }, 403);

// AI's ONLY role (spec §4.4) is turning optional free-text into a category that
// feeds the formula as one weighted input. For Phase 2a we ship a cheap deterministic
// keyword stand-in (no LLM in the hot path — reporting must be instant/free); a real
// classifier can replace this later WITHOUT touching the formula. Never decides the
// verdict; only picks a reason weight.
const REASON_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(scam|fraud|phish|steal|money|bank|otp)\b/i, "scam"],
  [/\b(robo|automated|recording|press \d)\b/i, "robocall"],
  [/\b(harass|abuse|threat|stalk)\b/i, "harassment"],
  [/\b(sale|offer|promo|market|telemarket|insurance|loan)\b/i, "telemarketer"],
];
function classifyReason(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [re, cat] of REASON_KEYWORDS) if (re.test(text)) return cat;
  return "other";
}

// POST /api/spam/report {number, verdict, reason?}
export async function spamReport(req: Request, env: Env): Promise<Response> {
  if (!(await shieldOn(env))) return off();
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const rl = await rateLimit(env, `spam-report:${ctx.uid}`, REPORT_RL.max, REPORT_RL.windowSec);
  if (rl) return rl;

  const b = (await req.json().catch(() => ({}))) as {
    number?: string;
    verdict?: string;
    reason?: string;
  };
  const raw = (b.number ?? "").toString().trim();
  if (!raw) return json({ error: "number required" }, 400);
  const verdict = b.verdict === "not_spam" ? "not_spam" : b.verdict === "spam" ? "spam" : null;
  if (!verdict) return json({ error: "verdict must be 'spam' or 'not_spam'" }, 400);

  const e164 = normalizePhone(raw);
  if (e164.replace(/\D/g, "").length < 6) return json({ error: "invalid number" }, 400);
  const e164Hash = await sha256Hex(e164);

  const reasonText = (b.reason ?? "").toString().slice(0, 500) || null;
  const reasonCategory = classifyReason(reasonText);
  const now = Date.now();

  try {
    // One live report per (number, reporter): re-report overwrites the prior verdict.
    await metaDb(env)
      .prepare(
        `INSERT INTO spam_number_reports
           (id, e164_hash, e164, reporter_uid, verdict, reason_category, reason_text, created_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(e164_hash, reporter_uid) DO UPDATE SET
           verdict=excluded.verdict,
           reason_category=excluded.reason_category,
           reason_text=excluded.reason_text,
           created_ms=excluded.created_ms`,
      )
      .bind(crypto.randomUUID(), e164Hash, e164, ctx.uid, verdict, reasonCategory, reasonText, now)
      .run();
  } catch (e) {
    console.error("[spam/report] insert failed", String(e));
    return json({ error: "report failed" }, 500);
  }

  // Telemetry (best-effort, never blocks) — mirrors number.ts analytics style.
  try {
    void env.Q_ANALYTICS.send({
      event: "spam_report",
      uid: ctx.uid,
      ts: now,
      props: {
        verdict,
        reason_category: reasonCategory,
        has_reason: !!reasonText,
        app_name: "avatok",
        service_name: "avatok-api",
        worker: true,
        account_id: ctx.uid,
      },
    });
  } catch { /* telemetry never blocks */ }

  return json({ ok: true, verdict });
}

// GET /api/spam/lookup/:e164 — public-read but auth-gated. Served through the Cache
// API (24h TTL) keyed per number-hash, so hot numbers never touch D1.
export async function spamLookup(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  e164Param: string,
): Promise<Response> {
  if (!(await shieldOn(env))) return off();
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);

  const raw = decodeURIComponent(e164Param || "").trim();
  if (!raw) return json({ error: "number required" }, 400);
  const e164 = normalizePhone(raw);
  const e164Hash = await sha256Hex(e164);

  // Cache key is the HASH only (no raw PII, no auth in the key → shared across users).
  const cacheKey = new Request(`https://spam-cache.avatok.internal/lookup/${e164Hash}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let row: { score: number; label: string; report_count: number; formula_version: string } | null =
    null;
  try {
    row = await metaDb(env)
      .prepare(
        `SELECT score, label, report_count, formula_version
           FROM spam_number_scores WHERE e164_hash = ?1`,
      )
      .bind(e164Hash)
      .first<{ score: number; label: string; report_count: number; formula_version: string }>();
  } catch (e) {
    console.error("[spam/lookup] query failed", String(e));
  }

  const body = row
    ? {
        score: row.score,
        label: row.label,
        reports: row.report_count,
        formula_version: row.formula_version,
      }
    : { score: 0, label: "none", reports: 0, formula_version: FORMULA_VERSION };

  const res = json(body);
  const toCache = new Response(res.clone().body, res);
  toCache.headers.set("cache-control", `public, max-age=${LOOKUP_CACHE_TTL_S}`);
  ctx.waitUntil(cache.put(cacheKey, toCache));
  return res;
}

// GET /api/spam/bloom — the R2-stored bloom manifest {version, url, count, updated_ms}.
export async function spamBloom(req: Request, env: Env): Promise<Response> {
  if (!(await shieldOn(env))) return off();
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);

  try {
    const obj = await env.BLOBS.get(MANIFEST_KEY);
    if (!obj) {
      // No filter built yet (job hasn't run). Honest empty manifest.
      return json({ version: null, url: null, count: 0, updated_ms: 0, formula_version: FORMULA_VERSION });
    }
    const manifest = await obj.json();
    return json(manifest as Record<string, unknown>);
  } catch (e) {
    console.error("[spam/bloom] manifest read failed", String(e));
    return json({ error: "bloom manifest unavailable" }, 500);
  }
}

// POST /api/spam/rescore — admin-gated manual trigger for the nightly job (until a
// scheduled()/cron handler is wired in index.ts; see runSpamScoring doc below).
export async function spamRescore(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;
  if (!(await shieldOn(env))) return off();
  const result = await runSpamScoring(env);
  return json({ ok: true, ...result });
}

interface RescoreResult {
  numbers: number;
  red: number;
  caution: number;
  reporters: number;
  bloom_count: number;
  bloom_version: string | null;
  formula_version: string;
}

/**
 * NIGHTLY JOB — aggregate reports → recompute reporter trust → publish scores →
 * rebuild the bloom filter → PUT to R2 with a version manifest. Deterministic and
 * replayable (uses the pure scorer). Currently invoked MANUALLY via
 * POST /api/spam/rescore (admin) because this worker has NO scheduled() handler yet.
 * WIRING A CRON: add `[triggers] crons = ["0 3 * * *"]` to worker/wrangler.toml and a
 * `scheduled(event, env, ctx)` handler to index.ts that calls `runSpamScoring(env)`
 * (guard on spamShield first). No code here changes when that lands.
 */
export async function runSpamScoring(env: Env): Promise<RescoreResult> {
  if (!(await shieldOn(env))) {
    return {
      numbers: 0,
      red: 0,
      caution: 0,
      reporters: 0,
      bloom_count: 0,
      bloom_version: null,
      formula_version: FORMULA_VERSION,
    };
  }
  const db = metaDb(env);
  const now = Date.now();

  // 1. Load current reporter trust (defaults to BASE_TRUST for unseen reporters).
  const trust = new Map<string, number>();
  try {
    const tr = await db.prepare("SELECT uid, trust FROM spam_reporter_trust").all<{ uid: string; trust: number }>();
    for (const r of tr.results ?? []) trust.set(r.uid, r.trust);
  } catch (e) {
    console.error("[spam/rescore] trust load failed", String(e));
  }

  // 2. Load all reports. Phase-2a scale is small (feature dark); a hard cap guards
  //    against a runaway table. At real scale this becomes a paged/queue-driven pass.
  interface Row {
    e164_hash: string;
    e164: string;
    reporter_uid: string;
    verdict: string;
    reason_category: string | null;
    created_ms: number;
  }
  let rows: Row[] = [];
  try {
    const q = await db
      .prepare(
        `SELECT e164_hash, e164, reporter_uid, verdict, reason_category, created_ms
           FROM spam_number_reports LIMIT 500000`,
      )
      .all<Row>();
    rows = q.results ?? [];
  } catch (e) {
    console.error("[spam/rescore] reports load failed", String(e));
  }

  // Group by number.
  const byHash = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = byHash.get(r.e164_hash);
    if (arr) arr.push(r);
    else byHash.set(r.e164_hash, [r]);
  }

  // 3. Score each number with CURRENT trust; collect labels + red-list for the bloom.
  const scored: Array<{ hash: string; e164: string; score: number; label: SpamLabel; reports: number }> = [];
  const labelByHash = new Map<string, SpamLabel>();
  const redHashes: string[] = [];
  for (const [hash, group] of byHash) {
    const reports: ReportInput[] = group.map((g) => ({
      reporterUid: g.reporter_uid,
      trust: trust.get(g.reporter_uid) ?? BASE_TRUST,
      verdict: g.verdict === "not_spam" ? "not_spam" : "spam",
      reasonCategory: g.reason_category,
      createdMs: g.created_ms,
    }));
    const res = scoreNumber({ now, reports });
    scored.push({ hash, e164: group[0].e164, score: res.score, label: res.label, reports: res.distinctReporters });
    labelByHash.set(hash, res.label);
    if (res.label === "red") redHashes.push(hash);
  }

  // 4. Recompute reporter trust from agreement with the fresh labels. A report
  //    "agrees" when its verdict matches the number's final direction.
  const agree = new Map<string, number>();
  const disagree = new Map<string, number>();
  for (const r of rows) {
    const label = labelByHash.get(r.e164_hash) ?? "none";
    const numberIsSpammy = label === "red" || label === "caution";
    const reporterSaysSpam = r.verdict !== "not_spam";
    const agreed = numberIsSpammy === reporterSaysSpam;
    const m = agreed ? agree : disagree;
    m.set(r.reporter_uid, (m.get(r.reporter_uid) ?? 0) + 1);
  }
  const reporterUids = new Set<string>([...agree.keys(), ...disagree.keys()]);
  let reportersUpdated = 0;
  for (const uid of reporterUids) {
    const t = computeReporterTrust(agree.get(uid) ?? 0, disagree.get(uid) ?? 0);
    try {
      await db
        .prepare(
          `INSERT INTO spam_reporter_trust (uid, trust, updated_ms) VALUES (?1,?2,?3)
             ON CONFLICT(uid) DO UPDATE SET trust=excluded.trust, updated_ms=excluded.updated_ms`,
        )
        .bind(uid, t, now)
        .run();
      reportersUpdated++;
    } catch (e) {
      console.error("[spam/rescore] trust upsert failed", uid, String(e));
    }
  }

  // 5. Publish scores.
  let redCount = 0;
  let cautionCount = 0;
  for (const s of scored) {
    if (s.label === "red") redCount++;
    else if (s.label === "caution") cautionCount++;
    try {
      await db
        .prepare(
          `INSERT INTO spam_number_scores
             (e164_hash, e164, score, label, report_count, formula_version, updated_ms)
           VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT(e164_hash) DO UPDATE SET
             e164=excluded.e164, score=excluded.score, label=excluded.label,
             report_count=excluded.report_count, formula_version=excluded.formula_version,
             updated_ms=excluded.updated_ms`,
        )
        .bind(s.hash, s.e164, s.score, s.label, s.reports, FORMULA_VERSION, now)
        .run();
    } catch (e) {
      console.error("[spam/rescore] score upsert failed", s.hash, String(e));
    }
  }

  // 6. Rebuild the bloom over the RED list and PUT to R2 with a version manifest.
  let bloomVersion: string | null = null;
  let bloomCount = 0;
  try {
    const filter: BloomFilter = await buildBloom(redHashes, 0.01);
    bloomCount = filter.count;
    const version = `${FORMULA_VERSION}-${now}`;
    const bloomKey = `${BLOOM_KEY_PREFIX}/${version}.bin`;
    await env.BLOBS.put(bloomKey, serializeBloom(filter), {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const manifest = {
      version,
      url: `${env.BLOSSOM_BASE_URL}/${bloomKey}`,
      count: filter.count,
      updated_ms: now,
      formula_version: FORMULA_VERSION,
      m: filter.m,
      k: filter.k,
    };
    await env.BLOBS.put(MANIFEST_KEY, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
    bloomVersion = version;
  } catch (e) {
    console.error("[spam/rescore] bloom publish failed", String(e));
  }

  return {
    numbers: scored.length,
    red: redCount,
    caution: cautionCount,
    reporters: reportersUpdated,
    bloom_count: bloomCount,
    bloom_version: bloomVersion,
    formula_version: FORMULA_VERSION,
  };
}
