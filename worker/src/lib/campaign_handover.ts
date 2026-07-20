// worker/src/lib/campaign_handover.ts — [AVA-CAMP-F4-CTRL] Warm-transfer
// human-handover controller for outbound AI calling campaigns
// (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §7 "Handover (warm transfer via
// conference)", §16 H1-H9 failure matrix, §5 "tariff switch 6->2, rolling
// reservation top-up", §19 seam 1).
//
// SERVICE BOUNDARY: this module is the ORCHESTRATION layer for the handover
// sub-machine — it drives `applyHandoverTransition` (lib/call_fsm.ts), talks
// to the `TelephonyProvider` (lib/telephony_provider.ts) to place/transfer/
// hangup legs, and does the connect-time wallet reserve + release-on-failure
// (routes/wallet.ts). It does NOT bill: per-second consume/settle at call end
// is CampaignDO's job (`onCallEnded`, out of scope here) — this module only
// reserves headroom for the human segment and releases it if the handover
// never connects.
//
// KV STATE: `ho:<attempt_uuid>` is the ephemeral per-handover blob (human_call_uuid,
// caller_call_uuid, conf_name, reason/contactName/campaignName/summary for the
// whisper, owner_uid + reserve_ref so downstream webhook calls don't need a
// D1 join every time, and bridge_confirmed/outcome flags the room can poll).
// There is deliberately NO D1 column for human_call_uuid (would be redundant
// with call_uuid semantics on other tables) — see the task note this module
// was built against. `handover_connected_at` IS a real D1 column, added by
// migrations/2026-07-20-campaign-handover-connect.sql because it didn't exist
// on the base migration and analytics (§12.1 handover_connected) wants a real
// instant, not just a status string.
//
// VOBIZ DOCS CONSULTED (mcp__vobiz-docs__search_vobiz, 2026-07-20):
//   - Conference callback fields: `ConferenceAction` (enter|exit — NOT a
//     "join"/"leave" pair), `Event` (ConferenceEnter/ConferenceExit),
//     `ConferenceUUID`, `ConferenceName`, `ConferenceMemberID`,
//     `ConferenceFirstMember`/`ConferenceLastMember`, `CallUUID`, `From`,
//     `To`, `Direction`, `CallStatus` (the last four only on `enter`).
//     https://vobiz.ai/docs/xml/conference/conference-callbacks#parameters-sent-to-callbackurl
//     IMPORTANT: there is no "which leg" field — this module resolves
//     caller-vs-human by matching the callback's `CallUUID` against the KV
//     blob's `caller_call_uuid`/`human_call_uuid`.
//   - `startConferenceOnEnter`/`endConferenceOnExit` "moderator-controlled
//     conference" pattern: https://vobiz.ai/docs/xml/conference/attributes#moderator-controlled-conference
//     — the participant who sets `endConferenceOnExit="true"` ends the room
//     for everyone when THEY leave. We make the human leg the moderator (see
//     humanAnswerXml) so an owner hangup always tears the room down; the
//     caller leg does NOT set it (see callerTransferXml for why).
//   - Transfer API: `POST …/Call/{call_uuid}/` with `{legs, aleg_url,
//     aleg_method}` redirects just the A-leg to fresh XML — matches
//     `TelephonyProvider.transferCall`. https://vobiz.ai/docs/call/transfer-call
import type { Env } from "../types";
import { applyHandoverTransition, HANDOVER_RING_MS } from "./call_fsm";
import { getTelephonyProvider } from "./telephony_provider";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { walletReserve, walletReleaseReservation } from "../routes/wallet";

const PUBLIC_BASE = "https://api.avatok.ai";
const IST_OFFSET_MIN = 330; // UTC+5:30 (same constant as do/campaign_do.ts)
// KV TTL for the `ho:<attempt_uuid>` blob. Generous vs. the ring/bridge
// timeouts (25s/25s) because it must survive the ENTIRE bridged human-to-human
// segment, which has "no hard cap on the human segment" per spec §5 — 6h is a
// pragmatic backstop, not a call-duration limit (the wallet top-up loop and
// the room itself are what actually bound a real call's length).
const HO_BLOB_TTL_SEC = 6 * 60 * 60;

function webhookSecret(env: Env): string {
  return env.VOBIZ_WEBHOOK_SECRET || "";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function kvKey(attemptUuid: string): string {
  return `ho:${attemptUuid}`;
}

// ---------------------------------------------------------------------------
// KV blob shape
// ---------------------------------------------------------------------------

export interface HandoverBlob {
  human_call_uuid: string | null;
  caller_call_uuid: string;
  conf_name: string;
  reason: string;
  contactName?: string | null;
  campaignName?: string | null;
  summary?: string | null;
  owner_uid?: string | null;
  reserve_ref?: string | null;
  bridge_confirmed?: boolean;
  resume_ai?: boolean;
  outcome?: string | null;
  ts?: number;
  // [AVA-CAMP-P-ENGINE] campaign_id + active-handover bookkeeping. campaign_id
  // is written once at initiateHandover time (it's on HandoverCtx already,
  // just wasn't persisted onto the blob before this task) so downstream
  // webhook-driven code (onConferenceEvent/onHandoverLegHangup) and
  // CampaignDO's alarm-driven serviceActiveHandovers() can both resolve which
  // per-campaign `ho_active:<campaign_id>` set this attempt belongs to
  // without a D1 join. connected_at/members/single_since are the rolling
  // top-up + conference-TTL state (spec §4/§5): members is derived purely
  // from Vobiz conference enter/exit events (this is always a 2-party room —
  // human + caller — so it only ever ranges 0..2); single_since is the epoch
  // ms the room dropped to exactly 1 participant (cleared back to null the
  // moment it returns to 2), which campaign_do.ts's alarm compares against
  // the 60s CONFERENCE_TTL_MS.
  campaign_id?: string | null;
  connected_at?: number | null;
  members?: number;
  single_since?: number | null;
  // High-water mark of which rolling top-up window has been reserved so far
  // (0 = only the initial connect-time reservation) — written by
  // campaign_do.ts's serviceActiveHandovers() directly via the same `ho:` KV
  // key so its idempotent-reserve check doesn't have to re-call the wallet on
  // every tick within an already-topped-up window.
  topped_up_window?: number;
}

async function readBlob(env: Env, attemptUuid: string): Promise<HandoverBlob | null> {
  try {
    return (await env.TOKENS.get(kvKey(attemptUuid), "json")) as HandoverBlob | null;
  } catch {
    return null;
  }
}

async function writeBlobPatch(
  env: Env,
  attemptUuid: string,
  existing: HandoverBlob | null,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const merged = { ...(existing ?? {}), ...patch, ts: Date.now() };
    await env.TOKENS.put(kvKey(attemptUuid), JSON.stringify(merged), { expirationTtl: HO_BLOB_TTL_SEC });
  } catch {
    // best-effort — the FSM/D1 write is the source of truth; a lost blob only
    // degrades the room's ability to poll for "should I resume AI now".
  }
}

/** Read-only accessor for CampaignDO's alarm loop (lib/campaign_do.ts) — the
 *  DO needs the raw blob (members/single_since/connected_at/reserve_ref/
 *  owner_uid/human_call_uuid/caller_call_uuid) to service rolling top-ups and
 *  the conference TTL, but must not itself know the KV key shape. */
export async function getHandoverBlob(env: Env, attemptUuid: string): Promise<HandoverBlob | null> {
  return readBlob(env, attemptUuid);
}

// ---------------------------------------------------------------------------
// Active-handover set — `ho_active:<campaign_id>` (spec §5 rolling top-up /
// §4 conference TTL). One JSON array of {attempt_uuid, connected_at} per
// campaign; membership starts at BridgeConfirmed (onConferenceEvent below)
// and ends the moment the handover is no longer a live bridged call (a final
// conference exit here, a post-bridge hangup in onHandoverLegHangup, or a
// TTL/credit-exhaustion disconnect driven by campaign_do.ts's
// serviceActiveHandovers()). Same "best-effort, never throw" contract as the
// rest of this module's KV I/O.
// ---------------------------------------------------------------------------

export interface ActiveHandoverEntry {
  attempt_uuid: string;
  connected_at: number;
}

function activeKey(campaignId: string): string {
  return `ho_active:${campaignId}`;
}

export async function readActiveHandovers(env: Env, campaignId: string): Promise<ActiveHandoverEntry[]> {
  try {
    const arr = await env.TOKENS.get(activeKey(campaignId), "json");
    return Array.isArray(arr) ? (arr as ActiveHandoverEntry[]) : [];
  } catch {
    return [];
  }
}

async function addActiveHandover(env: Env, campaignId: string, attemptUuid: string, connectedAt: number): Promise<void> {
  try {
    const list = await readActiveHandovers(env, campaignId);
    if (list.some((e) => e.attempt_uuid === attemptUuid)) return;
    list.push({ attempt_uuid: attemptUuid, connected_at: connectedAt });
    await env.TOKENS.put(activeKey(campaignId), JSON.stringify(list), { expirationTtl: HO_BLOB_TTL_SEC });
  } catch {
    // best-effort — worst case campaign_do.ts's alarm never sees this
    // handover in the active set and it just doesn't get rolling top-ups /
    // TTL enforcement; the base reservation + bridge itself are unaffected.
  }
}

export async function removeActiveHandover(env: Env, campaignId: string, attemptUuid: string): Promise<void> {
  try {
    const list = await readActiveHandovers(env, campaignId);
    const next = list.filter((e) => e.attempt_uuid !== attemptUuid);
    if (next.length) {
      await env.TOKENS.put(activeKey(campaignId), JSON.stringify(next), { expirationTtl: HO_BLOB_TTL_SEC });
    } else {
      await env.TOKENS.delete(activeKey(campaignId));
    }
  } catch {
    /* best-effort — a leaked active-set entry self-heals: campaign_do.ts's
       getHandoverBlob lookup on the next tick will find bridge_confirmed
       already resolved/gone and no-op it out. */
  }
}

/** D1 fallback for owner_uid when the KV blob is missing/expired (should not
 *  normally happen inside the blob's 6h TTL, but webhook handlers must never
 *  hard-fail on a missing cache entry). */
async function lookupOwnerUid(env: Env, attemptUuid: string): Promise<string | null> {
  try {
    const row = await metaDb(env)
      .prepare(
        `SELECT c.uid AS uid FROM campaign_call_attempts a JOIN campaigns c ON c.id = a.campaign_id WHERE a.attempt_uuid=?1`,
      )
      .bind(attemptUuid)
      .first<{ uid: string }>();
    return row?.uid ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IST time helpers (mirrors do/campaign_do.ts's window math; duplicated
// rather than imported because campaign_do.ts is off-limits per this task's
// constraints and these are pure, tiny, dependency-free functions).
// ---------------------------------------------------------------------------

function istMinuteOfDay(nowMs: number): number {
  const istMs = nowMs + IST_OFFSET_MIN * 60_000;
  const d = new Date(istMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function istDayBoundsMs(nowMs: number): { start: number; end: number } {
  const istMs = nowMs + IST_OFFSET_MIN * 60_000;
  const d = new Date(istMs);
  const istMidnightUtcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = istMidnightUtcMs - IST_OFFSET_MIN * 60_000;
  return { start, end: start + 24 * 60 * 60_000 };
}

/** `campaigns.handover_window` is documented as "JSON or text window spec".
 *  Accepts `{startMin,endMin}` (minutes since IST midnight) or
 *  `{start:"HH:MM", end:"HH:MM"}`. Unset/unparseable -> no restriction
 *  (available all day), since the column is optional and the spec doesn't
 *  define a default window for the owner's own availability. */
function parseHandoverWindow(raw: string | null | undefined): { startMin: number; endMin: number } | null {
  if (!raw) return null;
  try {
    const w = JSON.parse(raw) as { startMin?: number; endMin?: number; start?: string; end?: string };
    if (typeof w.startMin === "number" && typeof w.endMin === "number") {
      return { startMin: w.startMin, endMin: w.endMin };
    }
    if (typeof w.start === "string" && typeof w.end === "string") {
      const toMin = (s: string): number => {
        const [h, m] = s.split(":").map((n) => Number(n) || 0);
        return h * 60 + m;
      };
      return { startMin: toMin(w.start), endMin: toMin(w.end) };
    }
  } catch {
    /* unparseable -> no restriction */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Eligibility (spec §7 — checked ONLY for the handover leg's admission; the
// window/DNC checks that gate the CAMPAIGN's outbound leg do NOT apply here,
// per spec: "Window/DNC checks do not apply to the handover leg (it's the
// owner's own number)." This is the owner's OWN availability window instead.)
// ---------------------------------------------------------------------------

export type HandoverErrorCode = "owner_unavailable" | "window_closed" | "daily_limit" | "busy" | "insufficient_balance";

interface HandoverCtx {
  attemptUuid: string;
  campaignId: string;
  ownerUid: string;
  callerCallUuid: string;
  didE164: string;
  handoverNumber: string;
  handoverWindow?: string | null;
  maxHandoversPerDay?: number | null;
  reason: string;
  contactName?: string | null;
  campaignName?: string | null;
  summary?: string | null;
}

async function checkEligibility(env: Env, ctx: HandoverCtx): Promise<{ ok: true } | { ok: false; error_code: HandoverErrorCode }> {
  // Kill switch — beyond the task's literal eligibility list, but required by
  // house convention (every campaignHandover* flag in config.ts DEFAULTS must
  // actually gate something, or it's a "fake flag"). Defaults to false, so an
  // integrator must flip `campaignHandoverEnabled=true` before this ever
  // succeeds — documented prominently in the task report.
  try {
    const cfg = await readConfig(env);
    if (cfg.campaignHandoverEnabled === false) return { ok: false, error_code: "owner_unavailable" };
  } catch {
    /* config read failure — fail OPEN here since the caller already decided
       to attempt a handover; the explicit per-owner checks below still gate
       real abuse/overload. */
  }

  const now = Date.now();
  const win = parseHandoverWindow(ctx.handoverWindow ?? null);
  if (win) {
    const m = istMinuteOfDay(now);
    const inWindow = win.startMin <= win.endMin
      ? m >= win.startMin && m < win.endMin
      : m >= win.startMin || m < win.endMin; // wraps past midnight
    if (!inWindow) return { ok: false, error_code: "window_closed" };
  }

  const db = metaDb(env);

  if (ctx.maxHandoversPerDay && ctx.maxHandoversPerDay > 0) {
    const { start, end } = istDayBoundsMs(now);
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM campaign_call_attempts a JOIN campaigns c ON c.id = a.campaign_id
         WHERE c.uid=?1 AND a.handover_status='connected' AND a.handover_connected_at>=?2 AND a.handover_connected_at<?3`,
      )
      .bind(ctx.ownerUid, start, end)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= ctx.maxHandoversPerDay) return { ok: false, error_code: "daily_limit" };
  }

  // "No other handover currently 'connected' for this owner" — the owner has
  // exactly one phone; a second bridge attempt while one is already live
  // would ring a busy/occupied line.
  const busy = await db
    .prepare(
      `SELECT 1 FROM campaign_call_attempts a JOIN campaigns c ON c.id = a.campaign_id
       WHERE c.uid=?1 AND a.handover_status='connected' AND a.ended_at IS NULL LIMIT 1`,
    )
    .bind(ctx.ownerUid)
    .first();
  if (busy) return { ok: false, error_code: "busy" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// initiateHandover
// ---------------------------------------------------------------------------

export async function initiateHandover(
  env: Env,
  ctx: HandoverCtx,
): Promise<{ ok: boolean; error_code?: HandoverErrorCode }> {
  const elig = await checkEligibility(env, ctx);
  if (!elig.ok) return elig;

  let cfg: Awaited<ReturnType<typeof readConfig>> | null = null;
  try { cfg = await readConfig(env); } catch { /* fall through to defaults below */ }

  // Rolling reservation headroom for the human-segment tariff (spec §5:
  // "rolling top-up of 20 tokens per 10 min at the 2/min tariff" = topupMin *
  // tokensPerMin). Read live config so a flipped flag takes effect without a
  // redeploy; 20 (10min*2/min) is the documented spec default if config is
  // unreadable.
  const topupMin = cfg?.campaignHandoverTopupMin ?? 10;
  const tokensPerMin = cfg?.campaignHandoverTokensPerMin ?? 2;
  const reserveTokens = Math.max(1, Math.round(topupMin * tokensPerMin)) || 20;
  const reserveRef = `${ctx.attemptUuid}:ho`;
  const reserveOpId = `${ctx.attemptUuid}:ho-reserve`;

  const reserved = await walletReserve(env, ctx.ownerUid, reserveTokens, reserveRef, reserveOpId);
  if (!reserved.ok) return { ok: false, error_code: "insufficient_balance" };

  const db = metaDb(env);
  const t1 = await applyHandoverTransition(db, ctx.attemptUuid, "HandoverRequested", {
    trigger: "system",
    correlationId: ctx.attemptUuid,
  });
  if (!t1.ok) {
    // Another tick/webhook already moved this attempt's handover state (race)
    // — release what we just reserved and report busy rather than double-book.
    await walletReleaseReservation(env, ctx.ownerUid, reserveRef, `${ctx.attemptUuid}:ho-release-race`);
    return { ok: false, error_code: "busy" };
  }
  await applyHandoverTransition(db, ctx.attemptUuid, "DialHuman", {
    trigger: "system",
    correlationId: ctx.attemptUuid,
  });

  const secret = webhookSecret(env);
  const ringSec = cfg?.campaignHandoverRingSec ?? Math.round(HANDOVER_RING_MS / 1000);
  const provider = getTelephonyProvider(env);

  let humanCallUuid: string;
  try {
    const r = await provider.makeCall({
      from: ctx.didE164,
      to: ctx.handoverNumber,
      answerUrl: `${PUBLIC_BASE}/api/campaign-pstn/ho-answer/${secret}/${ctx.attemptUuid}`,
      ringUrl: `${PUBLIC_BASE}/api/campaign-pstn/ho-ring/${secret}/${ctx.attemptUuid}`,
      hangupUrl: `${PUBLIC_BASE}/api/campaign-pstn/ho-hangup/${secret}/${ctx.attemptUuid}`,
      // §7: "AMD enabled on this leg too, so the owner's own voicemail never
      // receives the caller."
      machineDetection: "true",
      machineDetectionUrl: `${PUBLIC_BASE}/api/campaign-pstn/ho-amd/${secret}/${ctx.attemptUuid}`,
      ringTimeoutSec: ringSec,
    });
    humanCallUuid = r.callUuid;
  } catch {
    // Not one of the H1-H9 leaves verbatim (those all assume the human leg
    // was placed) — a hard dial failure at this point is the eligibility-time
    // equivalent of H1: fail the handover, release the reservation, let the
    // AI leg continue uninterrupted (it was never told to pause).
    await applyHandoverTransition(db, ctx.attemptUuid, "failed", { trigger: "system", correlationId: ctx.attemptUuid });
    await walletReleaseReservation(env, ctx.ownerUid, reserveRef, `${ctx.attemptUuid}:ho-release-dialfail`);
    return { ok: false, error_code: "owner_unavailable" };
  }

  await writeBlobPatch(env, ctx.attemptUuid, null, {
    human_call_uuid: humanCallUuid,
    caller_call_uuid: ctx.callerCallUuid,
    conf_name: `hx_${ctx.attemptUuid}`,
    reason: ctx.reason,
    contactName: ctx.contactName ?? null,
    campaignName: ctx.campaignName ?? null,
    summary: ctx.summary ?? null,
    owner_uid: ctx.ownerUid,
    reserve_ref: reserveRef,
    bridge_confirmed: false,
    // [AVA-CAMP-P-ENGINE] persisted so onConferenceEvent can add this attempt
    // to `ho_active:<campaign_id>` at BridgeConfirmed without a D1 lookup.
    campaign_id: ctx.campaignId,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// onHumanAnswered — H5 (machine) short-circuits before HumanAnswered is ever
// entered (failed_machine is only reachable from DialHuman per
// HANDOVER_ALLOWED); otherwise DialHuman -> HumanAnswered -> [transfer] ->
// BridgeRequested (Transfer-API 200 is the ONLY thing that earns
// BridgeRequested — spec §4).
// ---------------------------------------------------------------------------

export async function onHumanAnswered(env: Env, attemptUuid: string, amd?: "human" | "machine" | null): Promise<void> {
  const db = metaDb(env);
  const blob = await readBlob(env, attemptUuid);
  const ownerUid = blob?.owner_uid ?? (await lookupOwnerUid(env, attemptUuid));
  const reserveRef = blob?.reserve_ref ?? `${attemptUuid}:ho`;

  if (amd === "machine") {
    // H5: owner voicemail answers -> AMD aborts, back to AI, no transfer tariff.
    await applyHandoverTransition(db, attemptUuid, "failed_machine", { trigger: "webhook", correlationId: attemptUuid });
    if (blob?.human_call_uuid) {
      try { await getTelephonyProvider(env).hangupCall(blob.human_call_uuid); } catch { /* best-effort */ }
    }
    if (ownerUid) {
      try { await walletReleaseReservation(env, ownerUid, reserveRef, `${attemptUuid}:ho-release-machine`); } catch { /* best-effort */ }
    }
    await writeBlobPatch(env, attemptUuid, blob, { resume_ai: true, outcome: "failed_machine" });
    return;
  }

  const t = await applyHandoverTransition(db, attemptUuid, "HumanAnswered", { trigger: "webhook", correlationId: attemptUuid });
  if (!t.ok) return; // illegal/duplicate (e.g. late answer webhook after H1-H4 already resolved it) — no-op

  const secret = webhookSecret(env);
  try {
    await getTelephonyProvider(env).transferCall({
      callUuid: blob?.caller_call_uuid ?? "",
      legs: "aleg",
      alegUrl: `${PUBLIC_BASE}/api/campaign-pstn/ho-transfer/${secret}/${attemptUuid}`,
    });
    // Transfer-API 200 = BridgeRequested (NOT BridgeConfirmed — that only
    // happens on the caller-leg conference member-join event, §4).
    await applyHandoverTransition(db, attemptUuid, "BridgeRequested", { trigger: "system", correlationId: attemptUuid });
  } catch {
    // H1: transfer API 5xx -> failed, AI resumes at 6/min, reservation released.
    await applyHandoverTransition(db, attemptUuid, "failed", { trigger: "system", correlationId: attemptUuid });
    if (ownerUid) {
      try { await walletReleaseReservation(env, ownerUid, reserveRef, `${attemptUuid}:ho-release-transferfail`); } catch { /* best-effort */ }
    }
    await writeBlobPatch(env, attemptUuid, blob, { resume_ai: true, outcome: "failed" });
  }
}

// ---------------------------------------------------------------------------
// onConferenceEvent — caller-leg member-join = BridgeConfirmed (spec §4: "The
// AI leg never leaves before BridgeConfirmed = caller-leg conference
// member-join event"). Vobiz's conference callback carries no explicit
// "which leg" field (see the file-header vobiz-docs note), so `event.leg` is
// resolved from `event.callUuid` against the KV blob when the caller
// (routes/campaign_pstn.ts) doesn't already know it. `event.callUuid` is a
// deliberate ADDITION to the literal `{leg?, type?}` shape this module was
// speced with — necessary because the webhook itself only carries CallUUID.
// ---------------------------------------------------------------------------

export async function onConferenceEvent(
  env: Env,
  attemptUuid: string,
  event: { leg?: "caller" | "human"; type?: string; callUuid?: string },
): Promise<void> {
  const blob = await readBlob(env, attemptUuid);
  if (!blob) return; // no handover context to correlate against — nothing to do

  let leg = event.leg;
  if (!leg && event.callUuid) {
    if (event.callUuid === blob.caller_call_uuid) leg = "caller";
    else if (blob.human_call_uuid && event.callUuid === blob.human_call_uuid) leg = "human";
  }

  const isEnter = event.type === "enter";
  const isExit = event.type === "exit";
  const wasBridged = !!blob.bridge_confirmed;

  // Only the CALLER's own "enter" can confirm the bridge, and only once (a
  // human-alone "enter" — the owner waiting in the whisper room BEFORE the
  // caller's transfer lands — must NOT be mistaken for a bridge or start the
  // single-participant TTL clock; it is a normal 1-participant pre-bridge
  // state, not a "conference dropped to 1" state).
  if (isEnter && leg === "caller" && !wasBridged) {
    const db = metaDb(env);
    const now = Date.now();
    await applyHandoverTransition(db, attemptUuid, "BridgeConfirmed", {
      trigger: "webhook",
      correlationId: attemptUuid,
      patch: { handover_connected_at: now },
    });
    await applyHandoverTransition(db, attemptUuid, "AILeaving", { trigger: "system", correlationId: attemptUuid });

    // applyHandoverTransition's own write leaves the FINE-GRAINED state name
    // ('AILeaving', and eventually 'Completed') in `handover_status`. This
    // module's own eligibility queries (checkEligibility's daily-limit/"busy"
    // checks above) and the coarse enum documented on the column
    // (none|attempted|connected|failed|failed_machine|caller_abandoned) both
    // expect the literal string 'connected' once bridged — force it here.
    // deriveHandoverState (lib/call_fsm.ts) already maps 'connected' back to
    // 'Completed' for the FSM's own re-derivation, so this is loss-free.
    try {
      await db.prepare(`UPDATE campaign_call_attempts SET handover_status='connected' WHERE attempt_uuid=?1`).bind(attemptUuid).run();
    } catch {
      /* best-effort — the fsm_transitions audit rows above are already durable */
    }

    // Both legs are in the room the instant the bridge is confirmed ->
    // members=2, no single-participant TTL clock running yet.
    await writeBlobPatch(env, attemptUuid, blob, {
      bridge_confirmed: true, connected_at: now, members: 2, single_since: null,
    });

    // [AVA-CAMP-P-ENGINE] register with the per-campaign active-handover set
    // so campaign_do.ts's alarm starts servicing rolling top-ups / conf TTL
    // for this attempt. Best-effort — a missing campaign_id (should not
    // happen; written at initiateHandover time) just means no top-up/TTL
    // servicing, not a broken bridge.
    if (blob.campaign_id) await addActiveHandover(env, blob.campaign_id, attemptUuid, now);
    return;
  }

  if (!wasBridged) return; // pre-bridge, non-confirming event — nothing else to do

  // Post-bridge member-count / single-participant-TTL bookkeeping (spec §4
  // "destroy-on-single-participant"). This is a strictly 2-party room (human
  // + caller), so `members` only ever ranges 0..2.
  if (isEnter || isExit) {
    const prevMembers = Math.max(0, Number(blob.members) || 0);
    const nextMembers = isEnter ? Math.min(2, prevMembers + 1) : Math.max(0, prevMembers - 1);
    const singleSince = nextMembers === 1 ? (blob.single_since ?? Date.now()) : null;
    await writeBlobPatch(env, attemptUuid, blob, { members: nextMembers, single_since: singleSince });

    if (isExit && nextMembers <= 0 && blob.campaign_id) {
      // Final exit — both parties are gone. Tear down the active-set entry
      // and release whatever's left of the rolling reservation NOW rather
      // than waiting for campaign_do.ts's 60s conference-TTL watchdog to
      // notice on its next tick (that watchdog is the fallback for the case
      // where Vobiz's own endConferenceOnExit/exit callback doesn't fire
      // cleanly, not the primary path).
      await removeActiveHandover(env, blob.campaign_id, attemptUuid);
      if (blob.owner_uid) {
        const reserveRef = blob.reserve_ref ?? `${attemptUuid}:ho`;
        await walletReleaseReservation(env, blob.owner_uid, reserveRef, `${attemptUuid}:ho-release-final-exit`).catch(() => null);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// onHandoverLegHangup — H3 (caller hangs up pre-bridge) / H4 (human answers
// then hangs up pre-bridge). A POST-bridge hangup (bridge_confirmed=true) is
// NOT this function's concern — once BridgeConfirmed has fired, the call is
// a normal human-to-human PSTN segment and the existing attempt-level
// /hangup webhook (routes/campaign_pstn.ts handleHangup) owns settlement.
// ---------------------------------------------------------------------------

export async function onHandoverLegHangup(env: Env, attemptUuid: string, which: "human" | "caller"): Promise<void> {
  const blob = await readBlob(env, attemptUuid);

  if (blob?.bridge_confirmed) {
    // Post-bridge: this is now an ordinary human-to-human PSTN segment.
    // Attempt-level settlement (outcome, tokens_spent, the BASE `:ho`
    // reservation-vs-spend true-up) is owned exclusively by
    // routes/campaign_pstn.ts's handleHangup -> CampaignDO.onCallEnded — do
    // NOT duplicate that here. This function's only remaining job post-bridge
    // is [AVA-CAMP-P-ENGINE] active-handover bookkeeping cleanup: take this
    // attempt out of `ho_active:<campaign_id>` (so campaign_do.ts's alarm
    // stops rolling-top-up/TTL-servicing it) and release whatever's left of
    // the rolling-top-up reservation headroom — best-effort and idempotent
    // (harmless no-op if onConferenceEvent's final-exit path, or
    // campaign_do.ts's TTL/credit-exhaustion path, already did this).
    if (blob.campaign_id) await removeActiveHandover(env, blob.campaign_id, attemptUuid);
    if (blob.owner_uid) {
      const reserveRef = blob.reserve_ref ?? `${attemptUuid}:ho`;
      await walletReleaseReservation(env, blob.owner_uid, reserveRef, `${attemptUuid}:ho-release-hangup`).catch(() => null);
    }
    return;
  }

  const db = metaDb(env);
  const ownerUid = blob?.owner_uid ?? (await lookupOwnerUid(env, attemptUuid));
  const reserveRef = blob?.reserve_ref ?? `${attemptUuid}:ho`;

  if (which === "caller") {
    // H3: caller hangs up during DialHuman/HumanAnswered -> caller_abandoned;
    // cancel the ringing (or just-answered) human leg — the race may have
    // already lost, so hangupCall is best-effort.
    await applyHandoverTransition(db, attemptUuid, "caller_abandoned", { trigger: "webhook", correlationId: attemptUuid });
    if (blob?.human_call_uuid) {
      try { await getTelephonyProvider(env).hangupCall(blob.human_call_uuid); } catch { /* best-effort */ }
    }
  } else {
    // H4: human answers then hangs up pre-bridge -> failed, AI resumes with
    // a callback offer. The caller leg is untouched — it's still on the AI
    // <Stream> the whole time, nothing to hang up.
    await applyHandoverTransition(db, attemptUuid, "failed", { trigger: "webhook", correlationId: attemptUuid });
  }

  if (ownerUid) {
    try { await walletReleaseReservation(env, ownerUid, reserveRef, `${attemptUuid}:ho-release-${which}hangup`); } catch { /* best-effort */ }
  }

  await writeBlobPatch(env, attemptUuid, blob, {
    resume_ai: which !== "caller",
    outcome: which === "caller" ? "caller_abandoned" : "failed",
  });
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** Whisper the owner, then hold them in the conference as MODERATOR
 *  (`startConferenceOnEnter="true"` — they start the room; `endConferenceOnExit=
 *  "true"` — if THEY hang up, the room ends for everyone per Vobiz's
 *  moderator-controlled-conference pattern, so the caller is never left
 *  stranded alone in a live room after the owner leaves). */
export async function humanAnswerXml(env: Env, attemptUuid: string): Promise<string> {
  const secret = webhookSecret(env);
  const blob = await readBlob(env, attemptUuid);
  const contactName = blob?.contactName || "a contact";
  const campaignName = blob?.campaignName || "your campaign";
  const reason = blob?.reason || "the caller asked to speak with someone";
  const summary = blob?.summary || "";
  const confName = blob?.conf_name || `hx_${attemptUuid}`;
  const cbUrl = `${PUBLIC_BASE}/api/campaign-pstn/conf-event/${encodeURIComponent(secret)}/${encodeURIComponent(attemptUuid)}`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Speak>AvaTOK handover: ${esc(contactName)}, ${esc(campaignName)}. Reason: ${esc(reason)}. ${esc(summary)}</Speak>` +
    `<Conference callbackUrl="${esc(cbUrl)}" startConferenceOnEnter="true" endConferenceOnExit="true">${esc(confName)}</Conference>` +
    `</Response>`
  );
}

/** Redirect the CALLER's aleg into the same conference room. Deliberately NOT
 *  `endConferenceOnExit` for this leg (the caller is not the moderator — see
 *  the file-header vobiz-docs note): if the caller hangs up, the room stays
 *  up for the owner rather than being yanked out from under them mid-word,
 *  and the caller's own hangup is ALREADY handled by the existing
 *  attempt-level /hangup webhook regardless of conference state, so nothing
 *  is lost by leaving this `false`. `secret` is a deliberate ADDITION to the
 *  literal `(attemptUuid): string` signature this helper was speced with —
 *  the codebase's webhook convention is fail-closed secret-in-path auth
 *  (routes/campaign_pstn.ts), so the callback URL cannot be built without it;
 *  a version with no secret param would either hardcode/omit auth (unsafe)
 *  or need `env`, which the speced signature also didn't include. */
export function callerTransferXml(attemptUuid: string, secret: string): string {
  const confName = `hx_${attemptUuid}`;
  const cbUrl = `${PUBLIC_BASE}/api/campaign-pstn/conf-event/${encodeURIComponent(secret)}/${encodeURIComponent(attemptUuid)}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Conference callbackUrl="${esc(cbUrl)}" startConferenceOnEnter="true" endConferenceOnExit="false">${esc(confName)}</Conference>` +
    `</Response>`
  );
}
