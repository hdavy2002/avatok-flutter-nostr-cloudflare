// AvaAdmin — platform Mission-Control dashboard (PHASE 6).
//
// Read-mostly aggregation + a PostHog HogQL proxy + live-ops snapshot + the
// alerts/roles surfaces. Reuses the EXISTING admin gate (`requireAdmin` from
// admin_money.ts) and the existing money endpoints — it NEVER re-implements a
// money primitive. Every state-changing endpoint additionally calls
// `requireAdminRole` and writes an `admin_audit` row.
//
// Endpoints (all under /api/admin/*; dispatch wired by Phase Z — see glue note):
//   GET  /api/admin/overview                §5.1 KPI bundle
//   GET  /api/admin/live                    §5.2 live-ops snapshot
//   GET  /api/admin/agents                  §5.6 voice+vision agent aggregates
//   GET  /api/admin/health                  §5.7 error/latency/queue/job snapshot
//   GET  /api/admin/analytics?insight=&range=   PostHog HogQL proxy (allow-listed)
//   GET  /api/admin/audit?admin=&action=&limit=&cursor=
//   GET  /api/admin/users/search?q=
//   GET  /api/admin/alerts?status=          · POST /api/admin/alerts/:id/ack · /resolve
//   POST /api/admin/alerts/evaluate         manual trigger of the evaluation pass
//   GET|POST /api/admin/alert-rules · PUT|DELETE /api/admin/alert-rules/:id
//   GET  /api/admin/roles · PUT /api/admin/roles/:uid   (super only)
//
// All state-changing routes are `finance`+ or `super`; read routes need only
// `requireAdmin`. The server is the real boundary (fail closed with 403).
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { metaDb } from "../db/shard";
import { ACCT_PLATFORM_FEES } from "../ledger";

// ─────────────────────────── roles (§5.14) ────────────────────────────────
export type AdminRole = "super" | "finance" | "analyst" | "readonly";
const ROLE_RANK: Record<AdminRole, number> = { readonly: 0, analyst: 1, finance: 2, super: 3 };

/** Resolve an admin's effective role. A uid in ADMIN_UIDS with NO admin_roles
 *  row defaults to `super` (so the ADMIN_UIDS-only setup keeps working). */
export async function resolveRole(env: Env, uid: string): Promise<AdminRole> {
  try {
    const row = await env.DB_WALLET.prepare("SELECT role FROM admin_roles WHERE uid=?1").bind(uid).first<{ role: string }>();
    if (row?.role && row.role in ROLE_RANK) return row.role as AdminRole;
  } catch { /* table may not exist yet → default below */ }
  return "super"; // requireAdmin already proved uid ∈ ADMIN_UIDS
}

/** Coarse gate (requireAdmin) + role-rank check. Returns {uid, role} or a 403. */
export async function requireAdminRole(
  req: Request,
  env: Env,
  minRole: AdminRole,
): Promise<{ uid: string; role: AdminRole } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) return a;
  const role = await resolveRole(env, a.uid);
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    return json({ error: "insufficient admin role", role, required: minRole }, 403);
  }
  return { uid: a.uid, role };
}

// ─────────────────────────── audit (mirrors admin_money) ───────────────────
async function audit(env: Env, adminId: string, action: string, target: string | null, meta: object): Promise<void> {
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), adminId, action, target, JSON.stringify(meta), Date.now()).run();
  } catch { console.error("[admin_audit] write failed", action); }
}

// ─────────────────────────── time helpers ─────────────────────────────────
const DAY = 86_400_000;
function startOfDayUTC(now = Date.now()): number { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function startOfMonthUTC(now = Date.now()): number { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
const STALE_BEAT_MS = 2 * 60_000; // mirror avavoice slot-freshness sweep

/** Run a scalar query, returning `fallback` on any error (graceful degrade). */
async function safeScalar<T = number>(p: Promise<{ [k: string]: any } | null>, key: string, fallback: T): Promise<T> {
  try { const r = await p; return (r?.[key] ?? fallback) as T; } catch { return fallback; }
}
async function safeAll<T = any>(p: Promise<{ results?: T[] }>): Promise<T[]> {
  try { return (await p).results ?? []; } catch { return []; }
}

// ═══════════════════════════ §5.1 OVERVIEW ════════════════════════════════
export async function adminOverview(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const W = env.DB_WALLET; const M = metaDb(env);
  const now = Date.now(); const sod = startOfDayUTC(now); const som = startOfMonthUTC(now);
  const fresh = now - STALE_BEAT_MS;

  const [
    liveStreams, consults, voiceCalls, visionCalls,
    escrowCoins, feesToday, feesMtd, gmvToday, signupsToday,
  ] = await Promise.all([
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM live_sessions WHERE state='live'").first(), "n", 0),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM bookings WHERE kind LIKE 'consult%' AND status='confirmed' AND starts_at<=?1 AND ends_at>=?1").bind(now).first(), "n", 0),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavoice_sessions WHERE status='active' AND last_beat_at>?1").bind(fresh).first(), "n", 0),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavision_sessions WHERE status='active' AND last_beat_at>?1").bind(fresh).first(), "n", 0),
    safeScalar(W.prepare("SELECT COALESCE(SUM(balance),0) AS n FROM wallet_accounts WHERE kind='escrow'").first(), "n", 0),
    safeScalar(W.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM wallet_ledger WHERE credit=?1 AND created_at>=?2").bind(ACCT_PLATFORM_FEES, sod).first(), "n", 0),
    safeScalar(W.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM wallet_ledger WHERE credit=?1 AND created_at>=?2").bind(ACCT_PLATFORM_FEES, som).first(), "n", 0),
    safeScalar(W.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM wallet_ledger WHERE type IN ('purchase_hold','donation') AND created_at>=?1").bind(sod).first(), "n", 0),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at>=?1").bind(sod).first(), "n", 0),
  ]);

  // "Needs attention" strip — each value links to its section in the UI.
  const [failedSettlements, reconDiffs, pendingPayouts, openReports, csamHits] = await Promise.all([
    safeScalar(W.prepare("SELECT COUNT(*) AS n FROM failed_settlements WHERE status='failed'").first(), "n", 0),
    safeScalar(W.prepare("SELECT COUNT(*) AS n FROM recon_runs WHERE ok=0").first(), "n", 0),
    safeScalar(W.prepare("SELECT COUNT(*) AS n FROM payout_requests WHERE status IN ('requested','quoted','failed')").first(), "n", 0),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM user_reports WHERE status='open'").first(), "n", 0),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM user_reports WHERE status='open' AND priority=1").first(), "n", 0),
  ]);
  const openAlerts = await safeScalar(W.prepare("SELECT COUNT(*) AS n FROM admin_alerts WHERE status='open'").first(), "n", 0);

  // Surface health: kill-switch state per surface (error rate folded in by UI via PostHog).
  let flags: Record<string, unknown> = {};
  try { const { readConfig } = await import("./config"); flags = (await readConfig(env)) as unknown as Record<string, unknown>; } catch { /* defaults */ }
  const surfaces = [
    { key: "live", label: "AvaLive", enabled: flags.liveEnabled !== false },
    { key: "consult", label: "AvaConsult", enabled: flags.consultEnabled !== false },
    { key: "conference", label: "Conference", enabled: flags.conferenceEnabled !== false },
    { key: "avavoice", label: "AvaVoice", enabled: flags.avavoiceEnabled !== false },
    { key: "avavision", label: "AvaVision", enabled: (flags as any).avavisionEnabled !== false },
    { key: "translation", label: "Translation", enabled: flags.translationEnabled !== false },
  ];

  return json({
    ts: now,
    sessions: {
      live_streams: liveStreams, consults, conference: null, // conference live-count: see conference_rooms in /live
      voice_calls: voiceCalls, vision_calls: visionCalls, translation: null,
      total: liveStreams + consults + voiceCalls + visionCalls,
    },
    money: { escrow_coins: escrowCoins, fees_today_coins: feesToday, fees_mtd_coins: feesMtd, gmv_today_coins: gmvToday },
    signups_today: signupsToday,
    needs_attention: { failed_settlements: failedSettlements, recon_diffs: reconDiffs, pending_payouts: pendingPayouts, open_reports: openReports, csam_hits: csamHits, open_alerts: openAlerts },
    surfaces,
  });
}

// ═══════════════════════════ §5.2 LIVE OPS ════════════════════════════════
export async function adminLive(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const M = metaDb(env); const now = Date.now(); const fresh = now - STALE_BEAT_MS;

  const live_streams = await safeAll(M.prepare(
    "SELECT listing_id, state, started_at FROM live_sessions WHERE state='live' ORDER BY started_at DESC LIMIT 50",
  ).all());
  const consults = await safeAll(M.prepare(
    "SELECT id, creator_id, buyer_id, kind, starts_at, ends_at, price, status FROM bookings WHERE kind LIKE 'consult%' AND status='confirmed' AND ends_at>=?1 ORDER BY starts_at ASC LIMIT 50",
  ).bind(now).all());
  const voice_calls = await safeAll(M.prepare(
    "SELECT id, agent_id, user_id, started_at, billed_minutes, limit_minutes, gross_coins FROM avavoice_sessions WHERE status='active' AND last_beat_at>?1 ORDER BY started_at DESC LIMIT 50",
  ).bind(fresh).all());
  // Vision may not be deployed yet → degrade gracefully.
  let vision_calls: any[] = []; let vision_available = true;
  try {
    const r = await M.prepare(
      "SELECT id, agent_id, user_id, started_at, billed_minutes, limit_minutes, gross_coins, frames_streamed, snapshot_calls, avg_score FROM avavision_sessions WHERE status='active' AND last_beat_at>?1 ORDER BY started_at DESC LIMIT 50",
    ).bind(fresh).all();
    vision_calls = r.results ?? [];
  } catch { vision_available = false; }

  // Per-agent slot utilization (busiest voice+vision agents, X/10).
  const voiceSlots = await safeAll(M.prepare(
    "SELECT agent_id, COUNT(*) AS active FROM avavoice_sessions WHERE status='active' AND last_beat_at>?1 GROUP BY agent_id ORDER BY active DESC LIMIT 10",
  ).bind(fresh).all());

  // Conference rooms — LiveKit REMOVED [CF-CALL-007A] (2026-07-24). This tile
  // always reported null/[] even before removal (never wired to a real
  // ListRooms call), so there is no functional loss here; group-call live
  // counts for the CF Realtime SFU path live under /api/groupcall/:id/status
  // instead, not in this admin surface.
  const conference_rooms: { count: number | null; rooms: any[] } = { count: null, rooms: [] };

  return json({
    ts: now,
    live_streams, consults, voice_calls,
    vision_calls, vision_available,
    conference_rooms,
    slot_utilization: { cap: 10, voice: voiceSlots },
    translation: { active: null }, // ephemeral surface
  });
}

// ═══════════════════════════ §5.6 AGENTS / AI SPEND ═══════════════════════
export async function adminAgents(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const M = metaDb(env); const now = Date.now(); const since = now - 7 * DAY; const fresh = now - STALE_BEAT_MS;

  const voice = {
    total_agents: await safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavoice_agents").first(), "n", 0),
    active_sessions: await safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavoice_sessions WHERE status='active' AND last_beat_at>?1").bind(fresh).first(), "n", 0),
    calls_7d: await safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavoice_sessions WHERE started_at>?1 AND status='ended'").bind(since).first(), "n", 0),
    gross_7d_coins: await safeScalar(M.prepare("SELECT COALESCE(SUM(gross_coins),0) AS n FROM avavoice_sessions WHERE started_at>?1").bind(since).first(), "n", 0),
  };
  let vision: any = { available: false };
  try {
    vision = {
      available: true,
      total_agents: await safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavision_agents").first(), "n", 0),
      active_sessions: await safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavision_sessions WHERE status='active' AND last_beat_at>?1").bind(fresh).first(), "n", 0),
      calls_7d: await safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavision_sessions WHERE started_at>?1 AND status='ended'").bind(since).first(), "n", 0),
      gross_7d_coins: await safeScalar(M.prepare("SELECT COALESCE(SUM(gross_coins),0) AS n FROM avavision_sessions WHERE started_at>?1").bind(since).first(), "n", 0),
      snapshots_7d: await safeScalar(M.prepare("SELECT COALESCE(SUM(snapshot_calls),0) AS n FROM avavision_sessions WHERE started_at>?1").bind(since).first(), "n", 0),
      avg_score: await safeScalar(M.prepare("SELECT CAST(AVG(avg_score) AS INTEGER) AS n FROM avavision_sessions WHERE started_at>?1 AND avg_score IS NOT NULL").bind(since).first(), "n", null as any),
    };
  } catch { vision = { available: false }; }

  // AI spend proxy (ai_spend day rows: calls + summed latency ms).
  const ai_spend_14d = await safeAll(M.prepare(
    "SELECT day, calls, ms FROM ai_spend ORDER BY day DESC LIMIT 14",
  ).all());

  return json({ voice, vision, ai_spend_14d });
}

// ═══════════════════════════ §5.7 HEALTH ══════════════════════════════════
export async function adminHealth(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const W = env.DB_WALLET;
  const dlq = await safeScalar(W.prepare("SELECT COUNT(*) AS n FROM failed_settlements WHERE status='failed'").first(), "n", 0);
  const lastRecon = await safeScalar<any>(W.prepare("SELECT date, ok, created_at FROM recon_runs ORDER BY date DESC LIMIT 1").first(), "date", null);
  const lastReconRow = await (async () => { try { return await W.prepare("SELECT date, ok, created_at FROM recon_runs ORDER BY date DESC LIMIT 1").first<any>(); } catch { return null; } })();
  // Error/latency come from PostHog — surfaced via /api/admin/analytics. Here we
  // report only worker-internal job/queue state we can read from D1.
  return json({
    ts: Date.now(),
    queues: { settlement_dlq: dlq },
    jobs: { recon: lastReconRow ? { date: lastReconRow.date, ok: !!lastReconRow.ok, at: lastReconRow.created_at } : null },
    posthog_note: env.POSTHOG_PERSONAL_API_KEY ? "use /api/admin/analytics for error/latency cards" : "PostHog key not configured",
    _lastReconDate: lastRecon,
  });
}

// ═══════════════════════════ POSTHOG PROXY (§5.9/§6) ══════════════════════
// Fixed allow-list of named HogQL queries — NO arbitrary query from the client.
// {RANGE} is replaced with a sanitized integer day count.
const POSTHOG_QUERIES: Record<string, string> = {
  dau: "SELECT count(DISTINCT person_id) AS value FROM events WHERE timestamp > now() - INTERVAL {RANGE} DAY",
  events_total: "SELECT count() AS value FROM events WHERE timestamp > now() - INTERVAL {RANGE} DAY",
  signups: "SELECT count() AS value FROM events WHERE event = 'signed_up' AND timestamp > now() - INTERVAL {RANGE} DAY",
  errors: "SELECT count() AS value FROM events WHERE event = 'apiError' AND timestamp > now() - INTERVAL {RANGE} DAY",
  error_by_endpoint: "SELECT properties.endpoint AS endpoint, count() AS n FROM events WHERE event = 'apiError' AND timestamp > now() - INTERVAL {RANGE} DAY GROUP BY endpoint ORDER BY n DESC LIMIT 20",
  active_now: "SELECT count(DISTINCT person_id) AS value FROM events WHERE timestamp > now() - INTERVAL 5 MINUTE",
  trend_daily: "SELECT toDate(timestamp) AS day, count() AS n FROM events WHERE timestamp > now() - INTERVAL {RANGE} DAY GROUP BY day ORDER BY day",
};

// Tiny server-side cache (per isolate) to respect PostHog rate limits (~60s).
const phCache = new Map<string, { at: number; body: unknown }>();
const PH_TTL = 60_000;

export async function adminAnalytics(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url);
  const insight = (u.searchParams.get("insight") || "").trim();
  const range = Math.min(90, Math.max(1, Math.trunc(Number(u.searchParams.get("range") || 7)) || 7));

  if (!insight || !(insight in POSTHOG_QUERIES)) {
    return json({ error: "unknown insight", available: Object.keys(POSTHOG_QUERIES) }, 400);
  }
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) {
    return json({ disabled: true, reason: "PostHog key not configured" });
  }
  const cacheKey = `${insight}:${range}`;
  const hit = phCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PH_TTL) return json({ insight, range, cached: true, ...(hit.body as object) });

  const host = env.POSTHOG_QUERY_HOST || "https://eu.posthog.com";
  const query = POSTHOG_QUERIES[insight].replace(/\{RANGE\}/g, String(range));
  try {
    const res = await fetch(`${host}/api/projects/${env.POSTHOG_PROJECT_ID}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return json({ error: "posthog query failed", status: res.status, detail: txt.slice(0, 400) }, 502);
    }
    const data = (await res.json()) as { results?: unknown[]; columns?: string[] };
    const body = { results: data.results ?? [], columns: data.columns ?? [] };
    phCache.set(cacheKey, { at: Date.now(), body });
    return json({ insight, range, cached: false, ...body });
  } catch (e) {
    return json({ error: "posthog unreachable", detail: e instanceof Error ? e.message : String(e) }, 502);
  }
}

// ═══════════════════════════ §5.13 AUDIT VIEWER ═══════════════════════════
export async function adminAuditLog(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url);
  const adminId = (u.searchParams.get("admin") || "").trim();
  const action = (u.searchParams.get("action") || "").trim();
  const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") || 100)));
  const before = Number(u.searchParams.get("cursor") || 0); // created_at cursor for pagination
  const where: string[] = []; const binds: unknown[] = []; let i = 1;
  if (adminId) { where.push(`admin_id=?${i++}`); binds.push(adminId); }
  if (action) { where.push(`action=?${i++}`); binds.push(action); }
  if (before > 0) { where.push(`created_at<?${i++}`); binds.push(before); }
  const sql = `SELECT id, admin_id, action, target, meta, created_at FROM admin_audit${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ${limit}`;
  const rows = await safeAll(env.DB_WALLET.prepare(sql).bind(...binds).all());
  const next = rows.length === limit ? rows[rows.length - 1].created_at : null;
  return json({ entries: rows, next_cursor: next });
}

// ═══════════════════════════ §5.3 USER SEARCH ═════════════════════════════
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function adminUserSearch(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const M = metaDb(env); const W = env.DB_WALLET;

  // Resolve to a user row by uid | handle | uid | email (hashed).
  let user: any = null;
  try {
    if (q.includes("@") && q.includes(".")) {
      const eh = await sha256Hex(q.toLowerCase());
      user = await M.prepare("SELECT uid, handle, display_name, avatar_url, created_at FROM users WHERE email_hash=?1 LIMIT 1").bind(eh).first<any>();
    }
    if (!user) {
      const handle = q.replace(/^@/, "").toLowerCase();
      user = await M.prepare(
        "SELECT uid, handle, display_name, avatar_url, created_at FROM users WHERE uid=?1 OR handle=?2 LIMIT 1",
      ).bind(q, handle).first<any>();
    }
  } catch { /* users table shape differences → null */ }

  if (!user) { await audit(env, a.uid, "user_search_miss", q, {}); return json({ found: false }); }
  const uid = String(user.uid);

  // Ledger-derived balance + held + recent rows (same source the money console uses).
  const acct = `user:${uid}`;
  const [kyc, strikes, level, recent, listings, vAgents, oAgents] = await Promise.all([
    safeScalar<any>(M.prepare("SELECT status FROM kyc_status WHERE uid=?1").bind(uid).first(), "status", "none"),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM strikes WHERE uid=?1").bind(uid).first(), "n", 0),
    safeScalar<any>(M.prepare("SELECT COUNT(*) AS n FROM identity_proofs WHERE uid=?1 AND status='verified'").bind(uid).first(), "n", 0),
    safeAll(W.prepare("SELECT id, debit, credit, amount, type, ref, created_at FROM wallet_ledger WHERE debit=?1 OR credit=?1 ORDER BY created_at DESC LIMIT 25").bind(acct).all()),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM listings WHERE creator_id=?1").bind(uid).first(), "n", 0),
    safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavoice_agents WHERE creator_id=?1").bind(uid).first(), "n", 0),
    (async () => { try { return await safeScalar(M.prepare("SELECT COUNT(*) AS n FROM avavision_agents WHERE creator_id=?1").bind(uid).first(), "n", 0); } catch { return 0; } })(),
  ]);

  await audit(env, a.uid, "user_search", uid, { q });
  return json({
    found: true,
    user: { uid, handle: user.handle, display_name: user.display_name, avatar_url: user.avatar_url, created_at: user.created_at },
    kyc, strikes, verified_proofs: level,
    counts: { listings, voice_agents: vAgents, vision_agents: oAgents },
    recent_ledger: recent,
    note: "balance authority is WalletDO; for live balance call GET /api/admin/account/:uid",
  });
}

// ═══════════════════════════ §5.12 ALERTS ═════════════════════════════════
export async function adminAlerts(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const status = (new URL(req.url).searchParams.get("status") || "open").trim();
  const rows = await safeAll(env.DB_WALLET.prepare(
    "SELECT id, rule_id, metric, observed, threshold, severity, message, status, acked_by, acked_at, resolved_by, resolved_at, created_at FROM admin_alerts WHERE status=?1 ORDER BY created_at DESC LIMIT 200",
  ).bind(status).all());
  return json({ alerts: rows });
}

export async function adminAlertAck(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  await env.DB_WALLET.prepare("UPDATE admin_alerts SET status='acknowledged', acked_by=?2, acked_at=?3 WHERE id=?1 AND status='open'")
    .bind(id, a.uid, Date.now()).run().catch(() => {});
  await audit(env, a.uid, "alert_ack", id, {});
  return json({ ok: true });
}

export async function adminAlertResolve(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  await env.DB_WALLET.prepare("UPDATE admin_alerts SET status='resolved', resolved_by=?2, resolved_at=?3 WHERE id=?1")
    .bind(id, a.uid, Date.now()).run().catch(() => {});
  await audit(env, a.uid, "alert_resolve", id, {});
  return json({ ok: true });
}

// alert-rules CRUD
export async function adminAlertRules(req: Request, env: Env): Promise<Response> {
  const method = req.method;
  if (method === "GET") {
    const a = await requireAdmin(req, env); if (a instanceof Response) return a;
    const rows = await safeAll(env.DB_WALLET.prepare(
      "SELECT id, metric, comparator, threshold, window_sec, channels, enabled, created_by, created_at, updated_at FROM admin_alert_rules ORDER BY created_at DESC",
    ).all());
    return json({ rules: rows.map((r: any) => ({ ...r, enabled: !!r.enabled, channels: safeJson(r.channels, []) })) });
  }
  // create
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as any;
  const metric = String(b.metric || "").trim();
  const comparator = String(b.comparator || "gt").trim();
  const threshold = Number(b.threshold);
  if (!metric || !ALERT_METRICS.includes(metric)) return json({ error: "valid metric required", metrics: ALERT_METRICS }, 400);
  if (!["gt", "gte", "lt", "lte", "eq", "ne"].includes(comparator)) return json({ error: "bad comparator" }, 400);
  if (!Number.isFinite(threshold)) return json({ error: "threshold must be a number" }, 400);
  const id = crypto.randomUUID(); const now = Date.now();
  const channels = Array.isArray(b.channels) ? b.channels.filter((c: unknown) => ["email", "slack", "push"].includes(String(c))) : [];
  await env.DB_WALLET.prepare(
    "INSERT INTO admin_alert_rules (id, metric, comparator, threshold, window_sec, channels, enabled, created_by, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
  ).bind(id, metric, comparator, threshold, Math.max(60, Number(b.window_sec) || 3600), JSON.stringify(channels), b.enabled === false ? 0 : 1, a.uid, now).run();
  await audit(env, a.uid, "alert_rule_create", id, { metric, comparator, threshold });
  return json({ ok: true, id });
}

export async function adminAlertRuleMutate(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  if (req.method === "DELETE") {
    await env.DB_WALLET.prepare("DELETE FROM admin_alert_rules WHERE id=?1").bind(id).run().catch(() => {});
    await audit(env, a.uid, "alert_rule_delete", id, {});
    return json({ ok: true });
  }
  // PUT — patch enabled / threshold / comparator / channels / window_sec
  const b = (await req.json().catch(() => ({}))) as any;
  const sets: string[] = []; const binds: unknown[] = []; let i = 1;
  if (typeof b.enabled === "boolean") { sets.push(`enabled=?${i++}`); binds.push(b.enabled ? 1 : 0); }
  if (Number.isFinite(Number(b.threshold))) { sets.push(`threshold=?${i++}`); binds.push(Number(b.threshold)); }
  if (typeof b.comparator === "string" && ["gt", "gte", "lt", "lte", "eq", "ne"].includes(b.comparator)) { sets.push(`comparator=?${i++}`); binds.push(b.comparator); }
  if (Array.isArray(b.channels)) { sets.push(`channels=?${i++}`); binds.push(JSON.stringify(b.channels.filter((c: unknown) => ["email", "slack", "push"].includes(String(c))))); }
  if (Number.isFinite(Number(b.window_sec))) { sets.push(`window_sec=?${i++}`); binds.push(Math.max(60, Number(b.window_sec))); }
  if (!sets.length) return json({ error: "nothing to update" }, 400);
  sets.push(`updated_at=?${i++}`); binds.push(Date.now());
  binds.push(id);
  await env.DB_WALLET.prepare(`UPDATE admin_alert_rules SET ${sets.join(", ")} WHERE id=?${i}`).bind(...binds).run();
  await audit(env, a.uid, "alert_rule_update", id, b);
  return json({ ok: true });
}

// Manual trigger (also exported as evaluateAlerts for the cron Phase Z wires).
export async function adminAlertEvaluate(req: Request, env: Env): Promise<Response> {
  const a = await requireAdminRole(req, env, "finance"); if (a instanceof Response) return a;
  const summary = await evaluateAlerts(env);
  await audit(env, a.uid, "alert_evaluate", null, summary);
  return json({ ok: true, ...summary });
}

const ALERT_METRICS = ["error_rate", "recon_diff", "escrow_imbalance", "failed_payout", "csam_hit", "agent_saturation", "settlement_dlq"];

function cmp(comparator: string, observed: number, threshold: number): boolean {
  switch (comparator) {
    case "gt": return observed > threshold;
    case "gte": return observed >= threshold;
    case "lt": return observed < threshold;
    case "lte": return observed <= threshold;
    case "eq": return observed === threshold;
    case "ne": return observed !== threshold;
    default: return false;
  }
}

/** Read the current value of an alert metric (D1-only; error_rate is best-effort PostHog). */
async function metricValue(env: Env, metric: string): Promise<number> {
  const W = env.DB_WALLET; const M = metaDb(env); const fresh = Date.now() - STALE_BEAT_MS;
  switch (metric) {
    case "recon_diff": return safeScalar(W.prepare("SELECT COUNT(*) AS n FROM recon_runs WHERE ok=0").first(), "n", 0);
    case "settlement_dlq": return safeScalar(W.prepare("SELECT COUNT(*) AS n FROM failed_settlements WHERE status='failed'").first(), "n", 0);
    case "failed_payout": return safeScalar(W.prepare("SELECT COUNT(*) AS n FROM payout_requests WHERE status='failed'").first(), "n", 0);
    case "csam_hit": return safeScalar(M.prepare("SELECT COUNT(*) AS n FROM user_reports WHERE status='open' AND priority=1").first(), "n", 0);
    case "agent_saturation": {
      const v = await safeScalar(M.prepare("SELECT MAX(c) AS n FROM (SELECT COUNT(*) AS c FROM avavoice_sessions WHERE status='active' AND last_beat_at>?1 GROUP BY agent_id)").bind(fresh).first(), "n", 0);
      return Number(v); // 0..10 (cap)
    }
    case "escrow_imbalance": return 0; // recon job is the authority; placeholder 0
    case "error_rate": {
      if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return 0;
      try {
        const host = env.POSTHOG_QUERY_HOST || "https://eu.posthog.com";
        const res = await fetch(`${host}/api/projects/${env.POSTHOG_PROJECT_ID}/query`, {
          method: "POST", headers: { Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: { kind: "HogQLQuery", query: POSTHOG_QUERIES.errors.replace(/\{RANGE\}/g, "1") } }),
        });
        if (!res.ok) return 0;
        const d = (await res.json()) as { results?: any[][] };
        return Number(d.results?.[0]?.[0] ?? 0);
      } catch { return 0; }
    }
    default: return 0;
  }
}

/** Evaluation pass: open admin_alerts for tripped rules, dedupe on open rule_id,
 *  dispatch channels. Runs on the EXISTING schedule (recon/settlement) — Phase Z
 *  wires it into the cron; no new DO. Idempotent within a window. */
export async function evaluateAlerts(env: Env): Promise<{ checked: number; tripped: number; opened: number }> {
  let rules: any[] = [];
  try { rules = (await env.DB_WALLET.prepare("SELECT * FROM admin_alert_rules WHERE enabled=1").all()).results ?? []; } catch { return { checked: 0, tripped: 0, opened: 0 }; }
  let tripped = 0; let opened = 0;
  for (const r of rules) {
    const observed = await metricValue(env, r.metric);
    if (!cmp(r.comparator, observed, Number(r.threshold))) continue;
    tripped++;
    // Dedupe: skip if an open alert already exists for this rule.
    const existing = await env.DB_WALLET.prepare("SELECT id FROM admin_alerts WHERE rule_id=?1 AND status='open' LIMIT 1").bind(r.id).first().catch(() => null);
    if (existing) continue;
    const id = crypto.randomUUID();
    const severity = r.metric === "csam_hit" ? "critical" : (r.metric === "recon_diff" || r.metric === "failed_payout") ? "warning" : "warning";
    const message = `${r.metric} ${r.comparator} ${r.threshold} (observed ${observed})`;
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_alerts (id, rule_id, metric, observed, threshold, severity, message, status, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8)",
    ).bind(id, r.id, r.metric, observed, Number(r.threshold), severity, message, Date.now()).run();
    opened++;
    await dispatchAlert(env, safeJson(r.channels, []), severity, message);
  }
  return { checked: rules.length, tripped, opened };
}

async function dispatchAlert(env: Env, channels: string[], severity: string, message: string): Promise<void> {
  // Email (existing transactional path / Q_EMAIL) — best-effort.
  if (channels.includes("email")) {
    try {
      const to = (env as any).ALERT_EMAIL || "hdavy2005@gmail.com";
      await env.Q_EMAIL.send({ to, subject: `[AvaAdmin ${severity}] ${message}`, text: message, kind: "admin_alert" });
    } catch { /* degrade */ }
  }
  // Slack webhook (optional; degrade if unset).
  if (channels.includes("slack")) {
    try {
      const hook = (env as any).ADMIN_SLACK_WEBHOOK as string | undefined;
      if (hook) await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `:rotating_light: *AvaAdmin ${severity}* — ${message}` }) });
    } catch { /* degrade */ }
  }
  // in-app push — left to Phase Z (admin push topic); no-op here.
}

// ═══════════════════════════ §5.14 ROLES ══════════════════════════════════
export async function adminRoles(req: Request, env: Env): Promise<Response> {
  const a = await requireAdminRole(req, env, "super"); if (a instanceof Response) return a;
  const rows = await safeAll(env.DB_WALLET.prepare("SELECT uid, role, granted_by, created_at FROM admin_roles ORDER BY created_at DESC").all());
  // Show ADMIN_UIDS that have no explicit row (effective 'super').
  const adminUids = (env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const withRow = new Set(rows.map((r: any) => r.uid));
  const implicit = adminUids.filter((u) => !withRow.has(u)).map((uid) => ({ uid, role: "super", granted_by: "ADMIN_UIDS", created_at: null, implicit: true }));
  return json({ roles: [...rows, ...implicit] });
}

export async function adminRoleSet(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await requireAdminRole(req, env, "super"); if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as any;
  const role = String(b.role || "").trim();
  if (!(role in ROLE_RANK)) return json({ error: "valid role required", roles: Object.keys(ROLE_RANK) }, 400);
  const now = Date.now();
  await env.DB_WALLET.prepare(
    "INSERT INTO admin_roles (uid, role, granted_by, created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(uid) DO UPDATE SET role=?2, granted_by=?3",
  ).bind(uid, role, a.uid, now).run();
  await audit(env, a.uid, "role_set", uid, { role });
  return json({ ok: true, uid, role });
}

// ─────────────────────────── util ─────────────────────────────────────────
function safeJson<T>(s: unknown, fallback: T): T { try { return JSON.parse(String(s)) as T; } catch { return fallback; } }
