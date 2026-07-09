// ava_odl_routes.ts — Phase C/D routes for the Opportunity Detection Layer.
//
//   GET  /api/ava/triggers        → on-device trigger bank sync (plan D31).
//                                   {version, bank}; ETag keyed on the version
//                                   so devices poll cheaply (304 on match).
//   GET  /api/ava/ledger          → today's Capability Cost Ledger snapshot
//                                   (D25 raw KV counters; PostHog = history).
//   POST /api/ava/moment-outcome  → learning loop (Constitution 11):
//                                   {capability, conv, outcome} → trust ledger
//                                   + outcome counters + PostHog.
//
// All three require a signed-in user (requireUser) and nothing more — the
// trigger bank is not a secret (it ships to every device), and outcomes are
// always about the CALLER's own conversations (uid from auth, never the body).
//
// WIRING (index.ts is owned by the orchestrator — see
// Specs/reports/PHASE-CD-WIRING.md for the exact three lines to add).

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { TRIGGER_BANK, TRIGGER_BANK_VERSION } from "../lib/ava_triggers";
import { getCapabilities } from "../lib/ava_capabilities";
import { ledgerSnapshot, recordOutcome, isMuted, MOMENT_OUTCOMES, type MomentOutcome } from "../lib/ava_budget";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ava/triggers — D31 device sync. The device matches offline for the
// instant-wake hint; the server-side ODL stays the authority. List updates ship
// as this payload (config sync), never as app updates (bible §5).
// ─────────────────────────────────────────────────────────────────────────────
export async function avaTriggersGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const etag = `W/"ava-triggers-v${TRIGGER_BANK_VERSION}"`;
  const inm = req.headers.get("if-none-match") ?? "";
  if (inm.includes(etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "public, max-age=3600" } });
  }
  return json(
    { version: TRIGGER_BANK_VERSION, bank: TRIGGER_BANK },
    200,
    { etag, "cache-control": "public, max-age=3600" },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ava/ledger — today's per-capability counters (evals, would_fire,
// outcomes) merged with the registry row (owner/lifecycle/cost_class), i.e.
// the live feed of the D25 keep/tune/kill dashboard.
// ─────────────────────────────────────────────────────────────────────────────
export async function avaLedgerGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const caps = await getCapabilities(env);
  const snap = await ledgerSnapshot(env, caps.map((c) => c.id));
  const byId = new Map(snap.rows.map((r) => [r.capability, r]));
  return json({
    day: snap.day,
    capabilities: caps.map((c) => ({
      id: c.id, owner: c.owner, role: c.role, lifecycle: c.lifecycle,
      cost_class: c.cost_class, min_opportunity: c.min_opportunity,
      daily_limit: c.daily_limit, kill_switch: c.kill_switch,
      today: byId.get(c.id) ?? { capability: c.id, evals: 0, would_fire: 0, outcomes: {} },
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ava/moment-outcome — {capability, conv, outcome}. The learning
// loop: accepted/edited/ignored/dismissed → trust ledger (+1/−1, 30-day conv
// mute at ≤−3) + per-capability outcome counters + `ava_moment_outcome`.
// ─────────────────────────────────────────────────────────────────────────────
export async function avaMomentOutcome(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const capability = String(b?.capability ?? "").trim();
  const conv = String(b?.conv ?? "").trim();
  const outcome = String(b?.outcome ?? "").trim() as MomentOutcome;
  if (!capability || !conv) return json({ error: "capability and conv required" }, 400);
  if (!MOMENT_OUTCOMES.includes(outcome)) {
    return json({ error: `outcome must be one of ${MOMENT_OUTCOMES.join("|")}` }, 400);
  }

  const trust = await recordOutcome(env, { uid: ctx.uid, conv, capability, outcome });
  const muted = isMuted(trust);

  try {
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid), "ava_moment_outcome", "ava_odl", {
      capability, conv, outcome, trust_score: trust.score, muted, muted_until: trust.muted_until || null,
    });
  } catch {
    void track(env, ctx.uid, "ava_moment_outcome", "ava_odl", { capability, conv, outcome, trust_score: trust.score, muted });
  }

  return json({ ok: true, trust: trust.score, muted, muted_until: trust.muted_until || null });
}
