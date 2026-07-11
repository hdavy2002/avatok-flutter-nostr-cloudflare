// Paid-call routes (WP2, plan §3B / §11 / §15.3 / §15.4 of
// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
//   GET  /api/call/paid/offer      — the CALLEE's published offer, resolved from
//                                     a dialed number or uid (caller-facing, pre-prompt)
//   GET  /api/call/paid/settings   — callee's published rate + length options
//   PUT  /api/call/paid/settings   — callee sets rate + length options (>= minServiceRate)
//   POST /api/call/paid/prepare    — caller gets a price quote (NO hold yet)
//   POST /api/call/paid/confirm    — caller confirms: hold escrow, arm the CallRoom
//                                     DO's per-minute billing ticker
//   POST /api/call/paid/cancel     — caller abandoned after confirm (identity gate /
//                                     backed out) — disarm + refund the untouched hold
//
// ALL routes 403 unless readConfig(env).paidCalls === true (plan §7 item 12 /
// §15.6 — every phase ships behind its own kill switch).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig } from "./config";
import { buildCallSnapshot } from "../lib/call_snapshot";
import { holdForCall } from "../lib/call_billing";
import { newTraceId } from "../lib/call_events";
import { nameFor } from "../lib/identity";
import { resolveNumberAndProfile } from "./agent_profiles";

// ---------------------------------------------------------------------------
// paid_call_settings — the callee's published rate + length options. Lazily
// ensured on DB_META, same pattern as agent_settings.ts's ensureTable().
// ---------------------------------------------------------------------------
let tableEnsured = false;
async function ensureTable(env: Env): Promise<void> {
  if (tableEnsured) return;
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS paid_call_settings (
       uid TEXT PRIMARY KEY,
       rate INTEGER NOT NULL,
       length_options TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ).run();
  tableEnsured = true;
}

interface PaidCallSettings { rate: number | null; length_options: number[] }

async function getPaidCallSettings(env: Env, uid: string): Promise<PaidCallSettings> {
  await ensureTable(env);
  const row = await metaDb(env).prepare(
    "SELECT rate, length_options FROM paid_call_settings WHERE uid=?1",
  ).bind(uid).first<{ rate: number; length_options: string }>();
  if (!row) return { rate: null, length_options: [] };
  let opts: number[] = [];
  try { opts = JSON.parse(row.length_options); } catch { opts = []; }
  return { rate: Number(row.rate), length_options: Array.isArray(opts) ? opts.map(Number).filter((n) => n > 0) : [] };
}

// ---------------------------------------------------------------------------
// [15.4] Child-account guard. There is no dedicated `account_type` column, but
// there IS a real self-declared age field already used for exactly this kind
// of gate: `users.birth_year`, with a `< 18` check in
// routes/ava_guardian.ts's isMinorAccount() (F6 adult-content opt-out). This
// mirrors that EXACT function (same fail-open-to-adult semantics: no declared
// birth_year → treated as adult, matching "is_adult !== false" — only a KNOWN
// minor blocks). TODO(WP3/legal): if/when a dedicated parent/child
// `account_type` lands (the identity ladder work), prefer it here — birth_year
// is self-declared and not independently verified, which is a known
// limitation to flag in the §3B legal/compliance review.
async function isChildAccount(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT birth_year FROM users WHERE uid=?1").bind(uid).first<{ birth_year: number | null }>();
    const by = r?.birth_year ?? null;
    if (!by) return false; // no declared year → treated as adult (fail open, never traps an adult as a minor)
    return new Date().getFullYear() - by < 18;
  } catch {
    return false; // table/column unavailable — fail open toward adult
  }
}

function paidCallsGate(cfg: { paidCalls: boolean }): boolean {
  return cfg.paidCalls === true;
}

// GET /api/call/paid/offer?to=<number-or-uid>[&service_id=…] — the CALLEE's
// published paid-call offer, shown to the CALLER before the price/length
// prompt (plan §3B step 2). `to` may be a dialed AvaTOK number OR a uid —
// resolveNumberAndProfile handles both (same resolver the routing engine
// uses). Missing/unpublished offer → {available:false} (200, not an error:
// "no offer" is the normal case for every free number). This route was the
// missing half of the client's PaidCallApi.offer() — it 404'd in prod
// (PostHog api_error /api/call/paid/offer, 2026-07-11) because only
// settings/prepare/confirm were ever registered.
export async function getPaidCallOfferRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!paidCallsGate(cfg)) return json({ error: "disabled", flag: "paidCalls" }, 403);

  const url = new URL(req.url);
  const to = (url.searchParams.get("to") || "").trim();
  if (!to) return json({ error: "to required" }, 400);
  if (await isChildAccount(env, ctx.uid)) return json({ available: false, reason: "child_account" });

  // `to` may be a uid OR a dialed number. Numbers resolve through (a) the
  // Mode-B service_numbers table (resolveNumberAndProfile) and (b) the users
  // primary-number columns (same lookup routes/number.ts uses) — whichever hits.
  const digits = to.replace(/\D/g, "");
  const looksLikeNumber = digits.length >= 4 && digits.length >= to.replace(/[\s()+-]/g, "").length;
  const resolved = await resolveNumberAndProfile(env, to, looksLikeNumber ? digits : null).catch(() => null);
  let calleeUid = resolved && !resolved.retired ? resolved.owner_uid : to;
  if (looksLikeNumber && resolved && !resolved.is_service_number) {
    // Not a service number — try the primary AvaTOK number directory.
    try {
      const row = await env.DB_META.prepare(
        "SELECT uid FROM users WHERE avatok_number=?1 OR number_norm=substr(?1,-10) LIMIT 1",
      ).bind(digits).first<{ uid: string }>();
      if (row?.uid) calleeUid = row.uid;
    } catch { /* directory miss → fall through with `to` as-is */ }
  }
  const settings = await getPaidCallSettings(env, calleeUid);
  if (settings.rate == null || !(settings.rate >= cfg.minServiceRate) || settings.length_options.length === 0) {
    return json({ available: false });
  }
  const calleeName = await nameFor(env, calleeUid).catch(() => null);
  return json({
    available: true,
    rate: settings.rate,
    length_options: settings.length_options,
    callee_name: calleeName ?? "",
    is_agent: resolved?.is_service_number === true && resolved?.agent_profile != null,
    callee_uid: calleeUid,
  });
}

// POST /api/call/paid/cancel { call_id } — the caller backed out AFTER
// /api/call/paid/confirm already held escrow + armed the CallRoom ticker
// (identity-gate 403 abort, abandoned dial). Disarm + refund via the DO's
// existing /billing-disarm (refundUnused no-ops when nothing was held, so
// this is safe to call unconditionally / repeatedly).
export async function cancelPaidCallRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!paidCallsGate(cfg)) return json({ error: "disabled", flag: "paidCalls" }, 403);
  const b = (await req.json().catch(() => ({}))) as { call_id?: string };
  const callId = String(b.call_id ?? "").trim();
  if (!callId) return json({ error: "call_id required" }, 400);
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
    await stub.fetch("https://call/billing-disarm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "CALLER_ABANDONED" }),
    });
  } catch { /* best-effort — §11 RING_TIMEOUT auto-refund is the backstop */ }
  return json({ ok: true });
}

// GET /api/call/paid/settings — the auth user's OWN published rate/options.
export async function getPaidCallSettingsRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!paidCallsGate(cfg)) return json({ error: "disabled", flag: "paidCalls" }, 403);
  const s = await getPaidCallSettings(env, ctx.uid);
  return json({ ok: true, settings: s, min_service_rate: cfg.minServiceRate });
}

// PUT /api/call/paid/settings { rate, length_options: number[] }
export async function putPaidCallSettingsRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!paidCallsGate(cfg)) return json({ error: "disabled", flag: "paidCalls" }, 403);
  if (await isChildAccount(env, ctx.uid)) return json({ error: "child accounts cannot set a paid-call rate" }, 403);

  const b = (await req.json().catch(() => ({}))) as { rate?: unknown; length_options?: unknown };
  const rate = Math.trunc(Number(b.rate));
  if (!(rate >= cfg.minServiceRate)) {
    return json({ error: `rate must be >= minServiceRate (${cfg.minServiceRate})`, min_service_rate: cfg.minServiceRate }, 400);
  }
  const rawOpts = Array.isArray(b.length_options) ? b.length_options : [];
  const opts = rawOpts.map((n) => Math.trunc(Number(n))).filter((n) => n > 0 && n <= 24 * 60);
  if (opts.length === 0) return json({ error: "length_options must be a non-empty array of positive minute counts" }, 400);
  const uniqueOpts = [...new Set(opts)].sort((a, b2) => a - b2);

  await ensureTable(env);
  await metaDb(env).prepare(
    `INSERT INTO paid_call_settings (uid, rate, length_options, updated_at) VALUES (?1,?2,?3,?4)
     ON CONFLICT(uid) DO UPDATE SET rate=excluded.rate, length_options=excluded.length_options, updated_at=excluded.updated_at`,
  ).bind(ctx.uid, rate, JSON.stringify(uniqueOpts), Date.now()).run();

  return json({ ok: true, settings: { rate, length_options: uniqueOpts } });
}

// POST /api/call/paid/prepare { callee, minutes, call_id } — price quote ONLY.
// No wallet check, no hold — that happens on /confirm (plan §3B: "nobody is
// connected until the funds are confirmed and held").
export async function preparePaidCallRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!paidCallsGate(cfg)) return json({ error: "disabled", flag: "paidCalls" }, 403);
  if (await isChildAccount(env, ctx.uid)) return json({ error: "child accounts cannot call paid lines" }, 403);

  const b = (await req.json().catch(() => ({}))) as { callee?: string; minutes?: unknown; call_id?: string };
  const callee = String(b.callee ?? "").trim();
  const minutes = Math.trunc(Number(b.minutes));
  if (!callee || !(minutes > 0) || !b.call_id) return json({ error: "callee, minutes, call_id required" }, 400);

  const settings = await getPaidCallSettings(env, callee);
  if (settings.rate == null || !(settings.rate >= cfg.minServiceRate)) {
    return json({ error: "this number has not published a paid-call rate" }, 404);
  }
  if (!settings.length_options.includes(minutes)) {
    return json({ error: "minutes must be one of the callee's published length options", length_options: settings.length_options }, 400);
  }
  const total = settings.rate * minutes;
  return json({
    ok: true, rate: settings.rate, minutes, total,
    length_options: settings.length_options,
    platform_fee_per_min: cfg.platformFeePerMin,
  });
}

// POST /api/call/paid/confirm { callee, minutes, call_id, is_service_number? }
// Holds the FULL chosen-duration cost up front (§3B step 5), then arms the
// CallRoom DO's per-minute billing ticker so it settles automatically as the
// call proceeds and auto-refunds the remainder on any disconnect.
export async function confirmPaidCallRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!paidCallsGate(cfg)) return json({ error: "disabled", flag: "paidCalls" }, 403);
  if (await isChildAccount(env, ctx.uid)) return json({ error: "child accounts cannot call paid lines" }, 403);

  const b = (await req.json().catch(() => ({}))) as {
    callee?: string; minutes?: unknown; call_id?: string; is_service_number?: boolean; trace_id?: string;
  };
  const callee = String(b.callee ?? "").trim();
  const minutes = Math.trunc(Number(b.minutes));
  const call_id = String(b.call_id ?? "").trim();
  if (!callee || !(minutes > 0) || !call_id) return json({ error: "callee, minutes, call_id required" }, 400);

  const settings = await getPaidCallSettings(env, callee);
  if (settings.rate == null || !(settings.rate >= cfg.minServiceRate)) {
    return json({ error: "this number has not published a paid-call rate" }, 404);
  }
  if (!settings.length_options.includes(minutes)) {
    return json({ error: "minutes must be one of the callee's published length options", length_options: settings.length_options }, 400);
  }
  const isServiceNumber = b.is_service_number === true;

  // §15.3: snapshot the rate/length/fee constants NOW — settlement and replay
  // read this frozen snapshot forever, never the live callee settings/config.
  const snapshot = await buildCallSnapshot(env, {
    rate: settings.rate,
    length_options: settings.length_options,
    platform_fee_per_min: cfg.platformFeePerMin,
    line_fee_per_min: cfg.serviceLineFeePerMin,
  });

  const traceId = b.trace_id || req.headers.get("x-trace-id") || newTraceId();
  const result = await holdForCall(env, { call_id, caller_id: ctx.uid, callee_id: callee, snapshot, minutes, trace_id: traceId });
  if (!result.ok) {
    const status = result.reason === "WALLET_INSUFFICIENT" ? 402 : 400;
    return json({ error: "hold failed", reason: result.reason ?? "VALIDATION" }, status);
  }

  // Arm the CallRoom DO's per-minute ticker. Best-effort from THIS route's
  // point of view (the escrow hold above already succeeded and is the money-
  // safety-critical step) — if the arm call fails, the caller/client still
  // gets a success response with the hold in place; a future WP3 "connect"
  // step can retry arming, and worst case the call proceeds unmetered until a
  // human notices (never double-charges either way, since settle is
  // idempotent per minute_index and re-arming just restarts the clock).
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(call_id));
    await stub.fetch("https://call/billing-arm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        call_id, trace_id: traceId, caller_id: ctx.uid, callee_id: callee,
        billing_mode: "B", is_service_number: isServiceNumber, snapshot, max_minutes: minutes,
      }),
    });
  } catch { /* best-effort — see comment above */ }

  return json({ ok: true, held: result.held, call_id, trace_id: traceId });
}
