// worker/src/routes/campaign_dids_route.ts — [AVA-CAMP-D-DIDS] DID
// provisioning routes for outbound AI calling campaigns (Specs/
// OUTBOUND-AI-CALLING-CAMPAIGNS.md §6.1 "DID provisioning", §5 "Billing &
// wallet" — DID 700 tokens/month, lazy renewal, §3 "user_dids").
//
// Scope: search Vobiz inventory, buy a number (charge-then-provision, with
// explicit handling of the "charged but provisioning failed" case), list the
// caller's owned numbers (for wizard reuse — "reusing an existing DID is
// free" per §5), and release a number.
//
// NOT in scope here (owned by other tasks): lazy MONTHLY RENEWAL of an
// already-owned DID (that's the telephony_tiers.ts maybeRenew() pattern,
// applied to user_dids by whichever code reads/ticks campaigns — this file
// only handles the one-time purchase charge) and mounting this route into
// index.ts (wiring agent's job, same convention as campaigns.ts).
//
// AUTH/GATING — mirrors routes/campaigns.ts's gate()/requireUser pattern
// exactly (campaignsEnabled flag + campaignOwnerAllowlist beta gate).
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { metaDb } from "../db/shard";
import { walletOp } from "./wallet";
import { chargeAmount } from "../feature_pricing";
import { getTelephonyProvider } from "../lib/telephony_provider";
import { maybeRenewDid } from "../lib/campaign_did_renewal";

// ---------------------------------------------------------------------------
// Gating helper — identical logic to routes/campaigns.ts's gate() (kept as a
// local copy rather than a shared import so this route file has no coupling
// to campaigns.ts internals per the task's "do not edit campaigns.ts" scope).
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
// Shared constants
// ---------------------------------------------------------------------------
const DID_MONTHLY_TOKENS = 700;
const DID_FEATURE_KEY = "campaign_did_month";
const MS_PER_DAY = 24 * 3600 * 1000;
const RENEWAL_PERIOD_MS = 30 * MS_PER_DAY; // spec §5 "~30 days"

// [AVA-CAMP-Q-BACKEND] Shared test DID — ONE Vobiz number on the owner's own
// account that every account can select while building a campaign, purely
// for testing (owner request 2026-07-20). Read from KV (env.TOKENS, the same
// binding platform_config uses) rather than D1 so the owner can set/clear it
// without a migration or a deploy. Plain E.164 string value, not JSON.
const SHARED_TEST_DID_KV_KEY = "campaign_test_did";
const SHARED_TEST_DID_LABEL = "Test number (shared)";

async function getSharedTestDid(env: Env): Promise<string | null> {
  try {
    const v = (await env.TOKENS.get(SHARED_TEST_DID_KV_KEY))?.trim();
    return v && isE164(v) ? v : null;
  } catch {
    return null;
  }
}

function sharedTestDidSummary(e164: string) {
  return { e164, label: SHARED_TEST_DID_LABEL, purpose: "shared_test", status: "active", shared: true };
}

function periodOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7); // "YYYY-MM"
}

function isE164(s: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(s);
}

interface UserDidRow {
  id: string;
  uid: string;
  e164: string;
  provider: string;
  purpose: string;
  monthly_tokens: number;
  status: string;
  purchased_at: number;
  next_renewal_at: number | null;
  provider_meta: string | null;
}

function didSummary(row: UserDidRow) {
  return {
    e164: row.e164,
    purpose: row.purpose,
    status: row.status,
    next_renewal_at: row.next_renewal_at,
    monthly_tokens: row.monthly_tokens,
  };
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/dids/search?country=IN&contains=&page=1 — read-only,
// no charge. Browses provider inventory (spec §6.1).
// ---------------------------------------------------------------------------
async function searchDids(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const country = (url.searchParams.get("country") || "IN").trim().toUpperCase();
  const contains = url.searchParams.get("contains")?.trim() || undefined;
  const pageRaw = Number(url.searchParams.get("page") ?? 1);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;

  try {
    const provider = getTelephonyProvider(env, "vobiz");
    const res = await provider.searchNumbers({ country, contains, page });
    return json({
      ok: true,
      items: res.items.map((it) => ({
        e164: it.e164,
        region: it.region,
        monthlyFee: it.monthlyFee,
        currency: it.currency,
      })),
      total: res.total,
    });
  } catch (e) {
    return json({ error: "search failed", detail: String(e).slice(0, 200) }, 502);
  }
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/dids/buy {e164} — CHARGE-THEN-PROVISION.
//
// Ordering is deliberate (spec §5 DID billing + this task's explicit
// requirement): the 700-token charge is the FIRST irreversible step, because
// chargeAmount is idempotent-by-opId and cheap to retry/verify, while a
// provider purchase is not idempotent (a duplicate purchaseNumber call could
// buy or attempt to buy the same number twice / hit "already owned"
// provider-side errors). Charging first means an insufficient-balance caller
// never reaches the provider at all. The risk this shifts onto us is "charged
// but purchaseNumber failed" — handled explicitly below with a credit-back.
// ---------------------------------------------------------------------------
async function buyDid(req: Request, env: Env, uid: string): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const e164 = String(body.e164 ?? "").trim();
  if (!isE164(e164)) return json({ error: "e164 required, must be E.164 (e.g. +9198xxxxxxx)" }, 400);

  // [AVA-CAMP-Q-BACKEND] Shared test DID — selecting it is NEVER a purchase.
  // It already exists (on the owner's own account) and is exposed to every
  // caller purely for testing; charging 700 tokens or attempting
  // provider.purchaseNumber() on a number that's already live and owned
  // elsewhere would either double-charge or collide with the provider. Return
  // success with no D1 write, no wallet charge, no provider call — the
  // campaign simply stores this e164 as its did_e164 (routes/campaigns.ts's
  // createCampaign already accepts any did_e164 string) and CampaignDO's
  // dial-loop admission (do/campaign_do.ts alarmDialLoop) resolves it against
  // `user_dids` by e164 exactly like any other DID, which already has this
  // row (owned by the owner's account) as 'active'.
  const sharedTestDid = await getSharedTestDid(env);
  if (sharedTestDid && e164 === sharedTestDid) {
    return json({ ok: true, e164, shared: true, already_owned: true, next_renewal_at: null });
  }

  const now = Date.now();
  const opId = `did:${uid}:${e164}:${periodOf(now)}`;

  // Pre-check: user_dids.e164 has a UNIQUE index — fail fast with a clean 409
  // instead of racing the provider + wallet for a number someone already owns
  // (this account or another). If THIS uid already owns it and it's active,
  // treat as a no-op success (idempotent retry / wizard "reuse" path).
  const existing = await metaDb(env)
    .prepare(`SELECT * FROM user_dids WHERE e164=?1`)
    .bind(e164)
    .first<UserDidRow>();
  if (existing) {
    if (existing.uid === uid && existing.status !== "released") {
      return json({ ok: true, e164: existing.e164, next_renewal_at: existing.next_renewal_at, already_owned: true });
    }
    return json({ error: "number already owned" }, 409);
  }

  // Step 1 — CHARGE FIRST. Insufficient balance never reaches the provider.
  const charge = await chargeAmount(env, uid, DID_FEATURE_KEY, DID_MONTHLY_TOKENS, opId);
  if (!charge.ok) {
    if (charge.reason === "insufficient") {
      return json({ error: "insufficient balance", balance: charge.balance }, 402);
    }
    return json({ error: "charge failed", detail: charge.reason ?? "unknown" }, 402);
  }

  // Step 2 — PROVISION. If this throws, the user has already been charged
  // 700 tokens for a number they don't have — attempt an immediate
  // credit-back using the SAME walletOp "credit" pattern used elsewhere in
  // the codebase for post-charge refunds (worker/src/routes/translate.ts's
  // trueup refund, worker/src/ledger.ts's refund() for escrow orders). This
  // is a plain (non-escrow) wallet credit: platform:fees -> user, keyed off
  // `${opId}:refund` so a retried buy attempt can never double-refund.
  let purchased;
  try {
    const provider = getTelephonyProvider(env, "vobiz");
    purchased = await provider.purchaseNumber(e164);
  } catch (provisionErr) {
    const refundOpId = `${opId}:refund`;
    let refunded = false;
    try {
      const r = await walletOp(env, uid, {
        op: "credit",
        uid,
        amount: DID_MONTHLY_TOKENS,
        type: "refund",
        app_name: DID_FEATURE_KEY,
        ref: opId,
        op_id: refundOpId,
        ledger: {
          debit: "platform:fees",
          credit: `user:${uid}`,
          type: "campaign_did_refund",
          ref: opId,
          meta: JSON.stringify({
            title: "Campaign DID purchase failed after charge",
            e164,
            reason: String(provisionErr).slice(0, 300),
          }),
        },
      });
      refunded = r.status === 200;
    } catch { /* refund attempt itself failed — fall through to reconciliation log below */ }

    // ALWAYS log this case regardless of refund outcome — if the credit-back
    // itself failed, this is the only record that a reconciliation pass
    // needs to find and fix (charged 700 tokens, no DID, no refund).
    console.error(
      `[AVA-CAMP-D-DIDS] provision-after-charge failure uid=${uid} e164=${e164} opId=${opId} ` +
      `refunded=${refunded} err=${String(provisionErr).slice(0, 300)}`,
    );

    return json(
      {
        error: refunded
          ? "number purchase failed at the provider; your 700 tokens were refunded"
          : "number purchase failed at the provider; refund attempt also failed — this has been logged for manual reconciliation, contact support",
        refunded,
        detail: String(provisionErr).slice(0, 200),
      },
      502,
    );
  }

  // Step 3 — RECORD OWNERSHIP. The provider purchase already succeeded (real
  // money spent with Vobiz) — if the D1 insert fails here, do NOT release the
  // number automatically (releasing a number the provider just billed us for,
  // right after a transient D1 hiccup, is a worse outcome than a temporarily
  // orphaned-from-D1 but still-owned, still-working number). Log for
  // reconciliation and surface a 502 so the caller can retry the buy, which
  // will now find `existing` above (once D1 recovers) rather than
  // double-purchasing.
  const id = crypto.randomUUID();
  const nextRenewalAt = now + RENEWAL_PERIOD_MS;
  try {
    await metaDb(env)
      .prepare(
        `INSERT INTO user_dids
           (id, uid, e164, provider, purpose, monthly_tokens, status, purchased_at, next_renewal_at, provider_meta)
         VALUES (?1, ?2, ?3, 'vobiz', 'campaign', ?4, 'active', ?5, ?6, ?7)`,
      )
      .bind(id, uid, e164, DID_MONTHLY_TOKENS, now, nextRenewalAt, JSON.stringify(purchased.providerMeta ?? purchased))
      .run();
  } catch (dbErr) {
    console.error(
      `[AVA-CAMP-D-DIDS] provider purchase succeeded but user_dids insert failed — RECONCILE ` +
      `uid=${uid} e164=${e164} opId=${opId} err=${String(dbErr).slice(0, 300)}`,
    );
    return json(
      { error: "purchased but failed to record ownership; retry — this has been logged for reconciliation", detail: String(dbErr).slice(0, 200) },
      502,
    );
  }

  return json({ ok: true, e164, next_renewal_at: nextRenewalAt });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/dids — list the caller's owned numbers (wizard reuse).
// ---------------------------------------------------------------------------
async function listDids(env: Env, uid: string): Promise<Response> {
  const { results } = await metaDb(env)
    .prepare(`SELECT * FROM user_dids WHERE uid=?1 ORDER BY purchased_at DESC`)
    .bind(uid)
    .all<UserDidRow>();
  const rows = results ?? [];

  // [AVA-CAMP-P-ENGINE] renew-on-read: opportunistic, best-effort lazy
  // renewal so an owner who views this list (without a campaign tick ever
  // running that day) still sees an up-to-date status/next_renewal_at rather
  // than a stale 'active' past its due date. Mirrors the admission-time check
  // in do/campaign_do.ts's alarm(); a failure here never breaks the listing —
  // it just serves the pre-renewal snapshot for that row.
  for (const row of rows) {
    if (row.status !== "active") continue;
    try {
      const renewal = await maybeRenewDid(env, {
        id: row.id, uid: row.uid, e164: row.e164, next_renewal_at: row.next_renewal_at, status: row.status,
      });
      if (renewal.renewed || renewal.status !== row.status) {
        // Re-read this one row for the authoritative post-renewal
        // status/next_renewal_at rather than recomputing locally — cheap
        // (only on the rare tick a renewal/status-flip actually happened).
        const fresh = await metaDb(env)
          .prepare(`SELECT status, next_renewal_at FROM user_dids WHERE id=?1`)
          .bind(row.id)
          .first<{ status: string; next_renewal_at: number | null }>();
        if (fresh) {
          row.status = fresh.status;
          row.next_renewal_at = fresh.next_renewal_at;
        }
      }
    } catch { /* best-effort — serve the pre-renewal snapshot for this row */ }
  }

  const summaries: Array<ReturnType<typeof didSummary> | ReturnType<typeof sharedTestDidSummary>> = rows.map(didSummary);

  // [AVA-CAMP-Q-BACKEND] Append the shared test DID (if the owner has set one
  // in KV) so every account sees it as a selectable option in the wizard,
  // without it being a real row in THIS caller's `user_dids` (it belongs to
  // the owner's account, not each caller's). Skip if this caller already owns
  // it outright (an active row for the same e164 already in `rows` — avoids a
  // confusing duplicate entry for the owner's own account).
  const sharedE164 = await getSharedTestDid(env);
  if (sharedE164 && !rows.some((r) => r.e164 === sharedE164 && r.status === "active")) {
    summaries.push(sharedTestDidSummary(sharedE164));
  }

  return json({ ok: true, dids: summaries });
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/dids/:e164 — release (verifies ownership).
// ---------------------------------------------------------------------------
async function releaseDid(env: Env, uid: string, e164Raw: string): Promise<Response> {
  const e164 = decodeURIComponent(e164Raw).trim();
  const row = await metaDb(env)
    .prepare(`SELECT * FROM user_dids WHERE e164=?1`)
    .bind(e164)
    .first<UserDidRow>();
  if (!row) return json({ error: "not found" }, 404);
  if (row.uid !== uid) return json({ error: "forbidden" }, 403);
  if (row.status === "released") return json({ ok: true, e164, status: "released", already_released: true });

  // Guard against releasing a number a running campaign is actively using —
  // the CampaignDO/dial loop resolves its caller ID from campaigns.did_e164,
  // and a mid-flight release would break in-progress or scheduled dials.
  const activeCampaign = await metaDb(env)
    .prepare(
      `SELECT id FROM campaigns WHERE did_e164=?1 AND uid=?2
         AND status IN ('running','pausing','window_wait','out_of_tokens') LIMIT 1`,
    )
    .bind(e164, uid)
    .first<{ id: string }>();
  if (activeCampaign) {
    return json({ error: "number is in use by an active campaign", campaign_id: activeCampaign.id }, 409);
  }

  try {
    const provider = getTelephonyProvider(env, "vobiz");
    await provider.releaseNumber(e164);
  } catch (e) {
    return json({ error: "release failed at provider", detail: String(e).slice(0, 200) }, 502);
  }

  try {
    await metaDb(env).prepare(`UPDATE user_dids SET status='released' WHERE e164=?1 AND uid=?2`).bind(e164, uid).run();
  } catch (e) {
    // Provider already released it (irreversible) — log for reconciliation so
    // the stale 'active' D1 row gets corrected rather than silently drifting.
    console.error(`[AVA-CAMP-D-DIDS] provider release succeeded but D1 update failed — RECONCILE uid=${uid} e164=${e164} err=${String(e).slice(0, 300)}`);
    return json({ error: "released at provider but failed to update record; logged for reconciliation", detail: String(e).slice(0, 200) }, 502);
  }

  return json({ ok: true, e164, status: "released" });
}

// ---------------------------------------------------------------------------
// Dispatcher — mount at /api/campaigns/dids (wiring agent's job, same
// convention as campaigns.ts: mount BEFORE the generic /api/campaigns/:id
// dispatcher so "dids" is never swallowed as a campaign id).
// ---------------------------------------------------------------------------
export async function campaignDidsRoute(req: Request, env: Env, path: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const gated = await gate(env, ctx.uid);
  if (gated) return json({ error: gated.error }, gated.status);

  const rest = path.slice("/api/campaigns/dids".length).replace(/^\/+/, ""); // "" | "search" | "buy" | "<e164>"
  const parts = rest.split("/").filter(Boolean);

  if (parts.length === 0) {
    if (req.method === "GET") return await listDids(env, ctx.uid);
    return json({ error: "method not allowed" }, 405);
  }

  if (parts[0] === "search" && parts.length === 1) {
    if (req.method === "GET") return await searchDids(req, env);
    return json({ error: "method not allowed" }, 405);
  }

  if (parts[0] === "buy" && parts.length === 1) {
    if (req.method === "POST") return await buyDid(req, env, ctx.uid);
    return json({ error: "method not allowed" }, 405);
  }

  // Anything else with exactly one segment is treated as an e164 for release
  // (segment may be URL-encoded, e.g. "%2B9198xxxxxxx").
  if (parts.length === 1) {
    if (req.method === "DELETE") return await releaseDid(env, ctx.uid, parts[0]);
    return json({ error: "method not allowed" }, 405);
  }

  return json({ error: "not found" }, 404);
}
