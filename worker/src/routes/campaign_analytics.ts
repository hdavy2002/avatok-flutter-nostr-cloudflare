// worker/src/routes/campaign_analytics.ts — [AVA-CAMP-D-ANALYTICS] Tenant-
// isolated PostHog read RPC for outbound AI calling campaigns (Specs/
// OUTBOUND-AI-CALLING-CAMPAIGNS.md §12 "Analytics", §13 "Security &
// multi-tenancy").
//
// LAYERING (§12): PostHog is the compute layer only — never embedded UI,
// never a source of money/progress (that stays D1-authoritative). This file
// is the Worker's "tenancy/security/query-generation" layer: it authenticates
// the session, verifies ownership in D1, builds the ENTIRE PostHog Query API
// payload server-side from a FIXED metric catalog (never client-supplied
// HogQL/filters), and returns compact JSON for Flutter's native fl_chart.
// The personal API key and the HogQL text never reach the client.
//
// TENANT ISOLATION (§13):
//   - owner_uid is resolved from the authenticated session (requireUser),
//     never trusted from the client.
//   - a per-campaign metric verifies :id belongs to owner_uid in D1 first
//     (else 403) — mirrors routes/campaigns.ts's loadOwnedCampaign pattern.
//   - every HogQL query carries an injected `properties.owner_uid = '<uid>'`
//     constraint AND (for per-campaign) `properties.campaign_id = '<id>'` or
//     (for account) `properties.campaign_id IN (<owned ids>)`.
//   - every query ALWAYS excludes `properties.purpose = 'TEST'` (§12.1/§19
//     seam 8) unless explicitly not — support-only TEST-inclusion is not
//     exposed on this client-facing RPC by design.
//
// GRACEFUL DEGRADATION: if env.POSTHOG_PERSONAL_API_KEY is unset (gated
// secret, mirrors do/user_brain.ts's investigate() and routes/admin_dashboard
// .ts's adminAnalytics()), this NEVER 500s — it returns
// `{ok:true, unavailable:true, reason:'analytics_key_unset'}` so the Flutter
// analytics cards degrade to "Analytics temporarily unavailable" (§12.5)
// while the D1 dashboard (money/progress) is completely unaffected.
//
// CACHING: KV (env.TOKENS) 45s TTL keyed `campaign_id (or account:<uid>)
// + metric + period` (§12.2 "KV cache 30-60s").
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { metaDb } from "../db/shard";

// ---------------------------------------------------------------------------
// Gating (mirrors routes/campaigns.ts's gate() — kept local/duplicated on
// purpose: this file is additive and must not require editing campaigns.ts).
// ---------------------------------------------------------------------------
function parseUidList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function gate(env: Env, uid: string): Promise<{ error: string; status: number } | null> {
  const cfg = await readConfig(env);
  if (cfg.campaignsEnabled !== true) return { error: "disabled", status: 503 };
  if (cfg.campaignOwnerAllowlist === true) {
    const admins = parseUidList(env.ADMIN_UIDS);
    if (!admins.includes(uid)) return { error: "beta access required", status: 403 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixed metric catalog — reject anything not in this list (never client HogQL).
// ---------------------------------------------------------------------------
const CAMPAIGN_METRICS = [
  "outcomes", "cost", "hour_of_day", "funnel", "engagement",
  "machine_rate", "time_to_answer", "handover",
] as const;
type CampaignMetric = typeof CAMPAIGN_METRICS[number];

const ACCOUNT_METRICS = [
  "spend", "leaderboard", "volume", "outcome_dist", "funnel",
] as const;
type AccountMetric = typeof ACCOUNT_METRICS[number];

const PERIODS = ["7d", "30d"] as const;
type Period = typeof PERIODS[number];

function periodDays(period: string): number {
  return period === "30d" ? 30 : 7;
}

// ---------------------------------------------------------------------------
// HogQL string-literal safety. owner_uid comes from the verified Clerk
// session and campaign ids come from our own D1 rows — neither is ever
// client-supplied raw HogQL — but every identifier interpolated into a query
// string is still whitelisted-charset-checked here as defense in depth
// (§13 "the client never sends HogQL or arbitrary filters").
// ---------------------------------------------------------------------------
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function safeId(id: string): string | null {
  return SAFE_ID.test(id) ? id : null;
}

function quote(id: string): string {
  // Single-quote HogQL string literal; SAFE_ID already excludes quotes, but
  // escape defensively anyway.
  return `'${id.replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------------
// PostHog Query API call — fixed HogQL only, built entirely server-side.
// Returns null on any failure (unreachable, non-200, malformed) so callers
// degrade gracefully instead of throwing.
// ---------------------------------------------------------------------------
async function runHogQL(env: Env, hogql: string): Promise<{ results: unknown[]; columns: string[] } | null> {
  const key = env.POSTHOG_PERSONAL_API_KEY;
  const project = env.POSTHOG_PROJECT_ID;
  if (!key || !project) return null;
  const host = env.POSTHOG_QUERY_HOST || "https://eu.posthog.com";
  try {
    const res = await fetch(`${host}/api/projects/${project}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: unknown[]; columns?: string[] };
    return { results: data.results ?? [], columns: data.columns ?? [] };
  } catch {
    return null;
  }
}

/** Builds the injected tenant-isolation WHERE fragment (§12.2/§13). Always
 *  includes `purpose != 'TEST'`. Per-campaign: single `campaign_id = <id>`.
 *  Account: `campaign_id IN (<owned ids>)` — empty list ⇒ a clause that
 *  matches nothing (no owned campaigns ⇒ no data, never another tenant's). */
function tenantWhere(ownerUid: string, campaignIds: string[]): string {
  const uidLit = quote(ownerUid);
  const idsLit = campaignIds.length
    ? campaignIds.map(quote).join(",")
    : "'__none__'";
  const campaignClause = campaignIds.length === 1
    ? `properties.campaign_id = ${quote(campaignIds[0])}`
    : `properties.campaign_id IN (${idsLit})`;
  return `properties.owner_uid = ${uidLit} AND ${campaignClause} AND properties.purpose != 'TEST'`;
}

// ---------------------------------------------------------------------------
// D1 ownership resolution
// ---------------------------------------------------------------------------
async function ownedCampaignUid(env: Env, campaignId: string, uid: string): Promise<"forbidden" | "not_found" | "ok"> {
  const row = await metaDb(env).prepare(`SELECT uid FROM campaigns WHERE id=?1`).bind(campaignId).first<{ uid: string }>();
  if (!row) return "not_found";
  if (row.uid !== uid) return "forbidden";
  return "ok";
}

async function ownedCampaignIds(env: Env, uid: string): Promise<string[]> {
  const { results } = await metaDb(env).prepare(`SELECT id FROM campaigns WHERE uid=?1 LIMIT 500`).bind(uid).all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// KV cache (env.TOKENS, 45s TTL — §12.2 "KV cache 30-60s")
// ---------------------------------------------------------------------------
const CACHE_TTL_SEC = 45;

function cacheKey(scope: string, metric: string, period: string): string {
  return `camp_analytics:${scope}:${metric}:${period}`;
}

async function cacheGet(env: Env, key: string): Promise<unknown | null> {
  try {
    const raw = await env.TOKENS.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function cacheSet(env: Env, key: string, value: unknown): Promise<void> {
  try { await env.TOKENS.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SEC }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Per-campaign metric compute — one HogQL query (or a small fixed set) per
// metric, transformed into compact fl_chart-ready JSON (§12.2).
// ---------------------------------------------------------------------------
async function computeCampaignMetric(env: Env, metric: CampaignMetric, ownerUid: string, campaignId: string, days: number): Promise<unknown> {
  const where = tenantWhere(ownerUid, [campaignId]);
  const rangeClause = `timestamp > now() - INTERVAL ${days} DAY`;

  switch (metric) {
    case "outcomes": {
      const q = `SELECT properties.call_outcome AS outcome, count() AS n FROM events
        WHERE event = 'call_completed' AND ${where} AND ${rangeClause}
        GROUP BY outcome ORDER BY n DESC`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const labels: string[] = [];
      const values: number[] = [];
      for (const row of r.results as unknown[][]) {
        labels.push(String(row[0] ?? "unknown"));
        values.push(Number(row[1]) || 0);
      }
      return { labels, values };
    }

    case "cost": {
      const trendQ = `SELECT toDate(timestamp) AS day, sum(toFloat64OrZero(toString(properties.tokens_charged))) AS tokens
        FROM events WHERE event = 'call_completed' AND ${where} AND ${rangeClause}
        GROUP BY day ORDER BY day`;
      const aggQ = `SELECT
          sum(toFloat64OrZero(toString(properties.tokens_charged))) AS tokens_total,
          countIf(properties.call_outcome IN ('answered','handover','booked')) AS n_answered,
          countIf(event = 'booking_made') AS n_bookings
        FROM events WHERE event IN ('call_completed','booking_made') AND ${where} AND ${rangeClause}`;
      const [trend, agg] = await Promise.all([runHogQL(env, trendQ), runHogQL(env, aggQ)]);
      if (!trend || !agg) return null;
      const days_: string[] = [];
      const tokens: number[] = [];
      for (const row of trend.results as unknown[][]) {
        days_.push(String(row[0] ?? ""));
        tokens.push(Number(row[1]) || 0);
      }
      const aggRow = (agg.results as unknown[][])[0] ?? [0, 0, 0];
      const tokensTotal = Number(aggRow[0]) || 0;
      const nAnswered = Number(aggRow[1]) || 0;
      const nBookings = Number(aggRow[2]) || 0;
      // [AVA-CAMP-Q-BACKEND] ₹ figures alongside the token figures. 1 AvaCoin
      // token = ₹1 = $0.01 (worker/src/feature_pricing.ts's coins_per_usd:100 —
      // 100 tokens per USD, and $1 ≈ ₹1 at token-pricing parity in this app's
      // wallet model, i.e. tokens and rupees are the SAME number here), so
      // every *_inr field below is a same-value, clearly-labeled alias of its
      // token counterpart — no new query, just relabeled output for the
      // Flutter analytics cards that want to show ₹ instead of raw tokens.
      const costPerAnswer = nAnswered > 0 ? tokensTotal / nAnswered : null;
      const costPerBooking = nBookings > 0 ? tokensTotal / nBookings : null;
      return {
        days: days_,
        tokens,
        cost_per_answer: costPerAnswer,
        cost_per_booking: costPerBooking,
        // ₹ (INR) figures — 1 token = ₹1, see comment above.
        spend_inr: tokens,
        cost_per_answer_inr: costPerAnswer,
        cost_per_booking_inr: costPerBooking,
      };
    }

    case "hour_of_day": {
      const q = `SELECT toHour(timestamp) AS hr,
          countIf(properties.call_outcome = 'answered') AS answered,
          count() AS total
        FROM events WHERE event = 'call_completed' AND ${where} AND ${rangeClause}
        GROUP BY hr ORDER BY hr`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const hours: number[] = [];
      const answer_rate: number[] = [];
      for (const row of r.results as unknown[][]) {
        const total = Number(row[2]) || 0;
        hours.push(Number(row[0]) || 0);
        answer_rate.push(total > 0 ? (Number(row[1]) || 0) / total : 0);
      }
      return { hours, answer_rate };
    }

    case "funnel": {
      const q = `SELECT
          countIf(event = 'dial_requested' OR event = 'dial_permitted') AS queued,
          countIf(event = 'dial_permitted') AS dial_permitted,
          countIf(event = 'call_answered') AS answered,
          countIf(event = 'call_completed' AND properties.ai_duration_s >= 30) AS engaged,
          countIf(event = 'booking_made' OR event = 'handover_connected') AS converted
        FROM events WHERE ${where} AND ${rangeClause}
          AND event IN ('dial_requested','dial_permitted','call_answered','call_completed','booking_made','handover_connected')`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const row = (r.results as unknown[][])[0] ?? [0, 0, 0, 0, 0];
      return {
        steps: [
          { name: "Queued", count: Number(row[0]) || 0 },
          { name: "Dial permitted", count: Number(row[1]) || 0 },
          { name: "Answered", count: Number(row[2]) || 0 },
          { name: "Engaged ≥ 30s", count: Number(row[3]) || 0 },
          { name: "Booked/handed over", count: Number(row[4]) || 0 },
        ],
      };
    }

    case "engagement": {
      const q = `SELECT
          countIf(properties.ai_duration_s >= 30 OR properties.conversation_type = 'human') AS engaged,
          count() AS total
        FROM events WHERE event = 'call_completed' AND ${where} AND ${rangeClause}`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const row = (r.results as unknown[][])[0] ?? [0, 0];
      const engaged = Number(row[0]) || 0;
      const total = Number(row[1]) || 0;
      return { engaged, total, rate: total > 0 ? engaged / total : 0 };
    }

    case "machine_rate": {
      const q = `SELECT
          countIf(properties.conversation_type = 'voicemail' OR properties.call_outcome = 'machine') AS machine,
          count() AS total
        FROM events WHERE event = 'call_completed' AND ${where} AND ${rangeClause}`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const row = (r.results as unknown[][])[0] ?? [0, 0];
      const machine = Number(row[0]) || 0;
      const total = Number(row[1]) || 0;
      return { machine, total, rate: total > 0 ? machine / total : 0 };
    }

    case "time_to_answer": {
      // dial_permitted -> call_answered, joined by attempt_uuid, carrier-quality
      // signal (§12.3). HogQL doesn't have a friendly self-join sugar for this
      // across two event rows, so compute via a per-attempt_uuid subquery.
      const q = `SELECT
          quantile(0.5)(t) AS p50_s,
          quantile(0.95)(t) AS p95_s,
          avg(t) AS avg_s
        FROM (
          SELECT properties.attempt_uuid AS attempt_uuid,
            dateDiff('second', minIf(timestamp, event = 'dial_permitted'), minIf(timestamp, event = 'call_answered')) AS t
          FROM events
          WHERE ${where} AND ${rangeClause} AND event IN ('dial_permitted','call_answered')
          GROUP BY attempt_uuid
          HAVING minIf(timestamp, event = 'dial_permitted') > 0 AND minIf(timestamp, event = 'call_answered') > 0
        )`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const row = (r.results as unknown[][])[0] ?? [null, null, null];
      return {
        p50_s: row[0] != null ? Number(row[0]) : null,
        p95_s: row[1] != null ? Number(row[1]) : null,
        avg_s: row[2] != null ? Number(row[2]) : null,
      };
    }

    case "handover": {
      const q = `SELECT
          countIf(event = 'handover_requested') AS requested,
          countIf(event = 'handover_connected') AS connected,
          countIf(event = 'handover_failed') AS failed
        FROM events WHERE ${where} AND ${rangeClause}
          AND event IN ('handover_requested','handover_connected','handover_failed')`;
      const reasonQ = `SELECT properties.reason AS reason, count() AS n FROM events
        WHERE event = 'handover_failed' AND ${where} AND ${rangeClause}
        GROUP BY reason ORDER BY n DESC LIMIT 10`;
      const [r, rr] = await Promise.all([runHogQL(env, q), runHogQL(env, reasonQ)]);
      if (!r || !rr) return null;
      const row = (r.results as unknown[][])[0] ?? [0, 0, 0];
      const reasons = (rr.results as unknown[][]).map((row2) => ({ reason: String(row2[0] ?? "unknown"), count: Number(row2[1]) || 0 }));
      return { requested: Number(row[0]) || 0, connected: Number(row[1]) || 0, failed: Number(row[2]) || 0, reasons };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Account metric compute — same shape, tenant-scoped to ALL owned campaigns.
// ---------------------------------------------------------------------------
async function computeAccountMetric(env: Env, metric: AccountMetric, ownerUid: string, campaignIds: string[], days: number): Promise<unknown> {
  if (campaignIds.length === 0) {
    // No campaigns yet — return an empty-but-valid shape per metric rather
    // than querying PostHog with a clause that matches nothing anyway.
    switch (metric) {
      case "spend": return { days: [], tokens: [] };
      case "leaderboard": return { campaigns: [] };
      case "volume": return { days: [], count: [] };
      case "outcome_dist": return { labels: [], values: [] };
      case "funnel": return { steps: [] };
    }
  }
  const where = tenantWhere(ownerUid, campaignIds);
  const rangeClause = `timestamp > now() - INTERVAL ${days} DAY`;

  switch (metric) {
    case "spend": {
      const q = `SELECT toDate(timestamp) AS day, sum(toFloat64OrZero(toString(properties.tokens_charged))) AS tokens
        FROM events WHERE event = 'call_completed' AND ${where} AND ${rangeClause}
        GROUP BY day ORDER BY day`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const days_: string[] = [];
      const tokens: number[] = [];
      for (const row of r.results as unknown[][]) {
        days_.push(String(row[0] ?? ""));
        tokens.push(Number(row[1]) || 0);
      }
      return { days: days_, tokens };
    }

    case "leaderboard": {
      const q = `SELECT properties.campaign_id AS campaign_id,
          countIf(properties.call_outcome = 'answered') AS n_answered,
          countIf(event = 'booking_made') AS n_bookings,
          count() AS n_total
        FROM events WHERE (event = 'call_completed' OR event = 'booking_made') AND ${where} AND ${rangeClause}
        GROUP BY campaign_id ORDER BY n_answered DESC LIMIT 50`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const campaigns = (r.results as unknown[][]).map((row) => {
        const total = Number(row[3]) || 0;
        const answered = Number(row[1]) || 0;
        return {
          campaign_id: String(row[0] ?? ""),
          answer_rate: total > 0 ? answered / total : 0,
          booking_rate: total > 0 ? (Number(row[2]) || 0) / total : 0,
        };
      });
      return { campaigns };
    }

    case "volume": {
      const q = `SELECT toDate(timestamp) AS day, count() AS n
        FROM events WHERE event = 'dial_permitted' AND ${where} AND ${rangeClause}
        GROUP BY day ORDER BY day`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const days_: string[] = [];
      const count: number[] = [];
      for (const row of r.results as unknown[][]) {
        days_.push(String(row[0] ?? ""));
        count.push(Number(row[1]) || 0);
      }
      return { days: days_, count };
    }

    case "outcome_dist": {
      const q = `SELECT properties.call_outcome AS outcome, count() AS n FROM events
        WHERE event = 'call_completed' AND ${where} AND ${rangeClause}
        GROUP BY outcome ORDER BY n DESC`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const labels: string[] = [];
      const values: number[] = [];
      for (const row of r.results as unknown[][]) {
        labels.push(String(row[0] ?? "unknown"));
        values.push(Number(row[1]) || 0);
      }
      return { labels, values };
    }

    case "funnel": {
      const q = `SELECT
          countIf(event = 'dial_requested' OR event = 'dial_permitted') AS queued,
          countIf(event = 'dial_permitted') AS dial_permitted,
          countIf(event = 'call_answered') AS answered,
          countIf(event = 'call_completed' AND properties.ai_duration_s >= 30) AS engaged,
          countIf(event = 'booking_made' OR event = 'handover_connected') AS converted
        FROM events WHERE ${where} AND ${rangeClause}
          AND event IN ('dial_requested','dial_permitted','call_answered','call_completed','booking_made','handover_connected')`;
      const r = await runHogQL(env, q);
      if (!r) return null;
      const row = (r.results as unknown[][])[0] ?? [0, 0, 0, 0, 0];
      return {
        steps: [
          { name: "Queued", count: Number(row[0]) || 0 },
          { name: "Dial permitted", count: Number(row[1]) || 0 },
          { name: "Answered", count: Number(row[2]) || 0 },
          { name: "Engaged ≥ 30s", count: Number(row[3]) || 0 },
          { name: "Booked/handed over", count: Number(row[4]) || 0 },
        ],
      };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher — mount at /api/campaigns/:id/analytics and
// /api/campaigns/analytics/account (wiring agent's job; NOT done here).
// ---------------------------------------------------------------------------
export async function campaignAnalyticsRoute(req: Request, env: Env, path: string): Promise<Response> {
  try {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

    const ctx = await requireUser(req, env);
    if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
    const gated = await gate(env, ctx.uid);
    if (gated) return json({ error: gated.error }, gated.status);

    const u = new URL(req.url);
    const metricRaw = (u.searchParams.get("metric") || "").trim();
    const periodRaw = (u.searchParams.get("period") || "7d").trim();
    const period: Period = (PERIODS as readonly string[]).includes(periodRaw) ? (periodRaw as Period) : "7d";
    const days = periodDays(period);

    // /api/campaigns/analytics/account/... — account-level.
    const rest = path.replace(/^\/api\/campaigns\/?/, "").replace(/\/+$/, "");
    if (rest === "analytics/account" || rest.startsWith("analytics/account/")) {
      if (!(ACCOUNT_METRICS as readonly string[]).includes(metricRaw)) {
        return json({ error: "unknown metric", available: ACCOUNT_METRICS }, 400);
      }
      if (!env.POSTHOG_PERSONAL_API_KEY) {
        return json({ ok: true, unavailable: true, reason: "analytics_key_unset" });
      }
      const campaignIds = (await ownedCampaignIds(env, ctx.uid)).filter((id) => safeId(id) != null);
      const key = cacheKey(`account:${ctx.uid}`, metricRaw, period);
      const cached = await cacheGet(env, key);
      if (cached != null) return json({ ok: true, metric: metricRaw, period, cached: true, data: cached });

      const data = await computeAccountMetric(env, metricRaw as AccountMetric, ctx.uid, campaignIds, days);
      if (data == null) return json({ ok: true, unavailable: true, reason: "posthog_query_failed" });
      await cacheSet(env, key, data);
      return json({ ok: true, metric: metricRaw, period, cached: false, data });
    }

    // /api/campaigns/:id/analytics — per-campaign.
    const m = rest.match(/^([^/]+)\/analytics$/);
    if (!m) return json({ error: "not found" }, 404);
    const campaignId = decodeURIComponent(m[1]);
    if (safeId(campaignId) == null) return json({ error: "invalid campaign id" }, 400);

    if (!(CAMPAIGN_METRICS as readonly string[]).includes(metricRaw)) {
      return json({ error: "unknown metric", available: CAMPAIGN_METRICS }, 400);
    }

    const owned = await ownedCampaignUid(env, campaignId, ctx.uid);
    if (owned === "not_found") return json({ error: "not found" }, 404);
    if (owned === "forbidden") return json({ error: "forbidden" }, 403);

    if (!env.POSTHOG_PERSONAL_API_KEY) {
      return json({ ok: true, unavailable: true, reason: "analytics_key_unset" });
    }

    const key = cacheKey(campaignId, metricRaw, period);
    const cached = await cacheGet(env, key);
    if (cached != null) return json({ ok: true, metric: metricRaw, period, cached: true, data: cached });

    const data = await computeCampaignMetric(env, metricRaw as CampaignMetric, ctx.uid, campaignId, days);
    if (data == null) return json({ ok: true, unavailable: true, reason: "posthog_query_failed" });
    await cacheSet(env, key, data);
    return json({ ok: true, metric: metricRaw, period, cached: false, data });
  } catch (e) {
    // Never throw — analytics failures degrade gracefully (§12.5/§19 seam 8's
    // sibling rule, §15 "analytics failures degrade gracefully, D1 dashboard
    // unaffected").
    return json({ ok: true, unavailable: true, reason: "internal_error", detail: e instanceof Error ? e.message : String(e) });
  }
}
