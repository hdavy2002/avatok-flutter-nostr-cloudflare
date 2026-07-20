// worker/src/routes/campaign_pstn.ts — [AVA-CAMP-B2-ROUTES] Outbound Vobiz
// webhook lane for AI calling campaigns (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md
// §7 "Telephony pipeline", §6.3 "Dial loop" steps 3-5, §4 "Call state machine",
// §8 "AI conversation runtime", §17 Phase B2).
//
// Path base: /api/campaign-pstn/<action>/<secret>/<attempt_uuid>
//   POST answer   — callee picked up; drive CallFSM -> 'answered', return the
//                   bidirectional <Stream> XML into VobizAgentRoom in campaign
//                   mode, seeding the pstn_agent:<sid> KV handoff.
//   POST ring     — CallFSM -> 'ringing'.
//   POST hangup   — parse Vobiz hangup params, CallFSM -> terminal outcome,
//                   notify CampaignDO via onCallEnded.
//   POST amd      — async machine-detection verdict; advisory only (§7), just
//                   record it (and best-effort hint the room), never hangs up.
//
// CONVENTIONS (copied from routes/pstn.ts, the canonical Vobiz webhook file
// in this repo — read there for the full rationale):
//   - secret-in-path auth: the trailing path segment must equal
//     env.VOBIZ_WEBHOOK_SECRET (no probe-grade fallback here — campaigns are a
//     production feature behind campaignOwnerAllowlist, so an unset secret
//     should fail closed, not fall back to a shared constant).
//   - Vobiz posts application/x-www-form-urlencoded; parse via URLSearchParams.
//   - every handler is best-effort / defensive: a thrown error must not surface
//     a raw 5xx to Vobiz on a webhook path (see the safetyNetXml()/try-catch
//     shape below, mirroring pstn.ts).
//   - unknown/duplicate webhooks are idempotent — CallFSM.applyAttemptTransition
//     already treats "already in target state" as a success no-op (see
//     lib/call_fsm.ts), so handlers here don't need their own dedupe layer.
//
// SERVICE BOUNDARY NOTE: like pstn.ts, this file builds XML + a KV handoff
// blob only. It does NOT import any Gemini/prompt/engine module — the
// VobizAgentRoom DO (do/vobiz_agent_room.ts) is responsible for reading the
// campaign-mode handoff context and actually running the call. The seam is
// marked with a TODO below.
import type { Env } from "../types";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { applyAttemptTransition, type AttemptState } from "../lib/call_fsm";
import { track } from "../hooks";
// [AVA-CAMP-F4-CTRL] warm-transfer human-handover controller — see
// lib/campaign_handover.ts for the FSM orchestration; this file only wires
// its webhook subpaths (secret-check + attempt lookup are reused from above).
import {
  humanAnswerXml,
  callerTransferXml,
  onHumanAnswered,
  onHandoverLegHangup,
  onConferenceEvent,
} from "../lib/campaign_handover";

const PUBLIC_BASE = "https://api.avatok.ai";
const AGENT_KV_TTL_SEC = 300; // Vobiz must connect the WS within 5 min (matches pstn.ts's agent lane)
const CAMPAIGN_TOKENS_PER_MIN = 6; // §5 "AI talk time 6 tokens/min" — TODO(Phase C): read campaignTokensPerMin from readConfig(env) once the room-side billing wiring lands, instead of this literal.

function webhookSecret(env: Env): string {
  return env.VOBIZ_WEBHOOK_SECRET || "";
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Always-safe XML the callee hears if anything upstream throws — never dead
 *  air, mirrors routes/pstn.ts's safetyNetXml(). */
function safetyNetXml(): Response {
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Speak>We're sorry, something went wrong. Goodbye.</Speak>` +
    `<Hangup/></Response>`,
  );
}

async function parseForm(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const text = await req.text();
    const params = new URLSearchParams(text);
    for (const [k, v] of params.entries()) out[k] = v;
  } catch { /* best-effort — empty fields, never throw */ }
  return out;
}

interface AttemptOwnerRow {
  campaign_id: string;
  contact_id: string;
  uid: string; // campaigns.uid — the owner
  goal_text: string;
  compiled_prompt: string | null;
  kb_store: string | null;
  language_hint: string | null;
  voice_persona: string | null;
  // [AVA-CAMP-C-ROOM] added so the handoff KV can carry what
  // do/vobiz_agent_room.ts's campaign-mode branch needs (buildCampaignTools'
  // contactName/contactE164/bookingEnabled) — was missing before this edit.
  booking_enabled: number; // SQLite 0/1
  contact_name: string | null;
  contact_e164: string | null;
}

/** Look up the attempt's campaign/owner/contact context in one join — used by
 *  answer (handoff seeding) and hangup (CampaignDO notify target). */
async function lookupAttemptContext(env: Env, attemptUuid: string): Promise<AttemptOwnerRow | null> {
  const row = await metaDb(env)
    .prepare(
      `SELECT a.campaign_id AS campaign_id, a.contact_id AS contact_id,
              c.uid AS uid, c.goal_text AS goal_text, c.compiled_prompt AS compiled_prompt,
              c.kb_store AS kb_store, c.language_hint AS language_hint, c.voice_persona AS voice_persona,
              c.booking_enabled AS booking_enabled,
              ct.name AS contact_name, ct.e164 AS contact_e164
       FROM campaign_call_attempts a
       JOIN campaigns c ON c.id = a.campaign_id
       JOIN campaign_contacts ct ON ct.id = a.contact_id
       WHERE a.attempt_uuid=?1`,
    )
    .bind(attemptUuid)
    .first<AttemptOwnerRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/campaign-pstn/answer/<secret>/<attempt_uuid>
// ---------------------------------------------------------------------------
async function handleAnswer(req: Request, env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) {
    return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`, 403);
  }
  if (!attemptUuid) return safetyNetXml();

  try {
    const fields = await parseForm(req);
    const callUuid = fields.CallUUID || "";
    const now = Date.now();

    // NOTE: dial_reserved -> answered is NOT a legal direct edge in
    // ATTEMPT_ALLOWED (lib/call_fsm.ts) — the row must already be 'calling'
    // (call_uuid set) or 'ringing' by the time this webhook lands. CampaignDO's
    // dial loop (§6.3 step 3) is expected to persist call_uuid on the attempt
    // row right after placing the outbound call, before any webhook can
    // arrive. If that hasn't happened yet (e.g. CampaignDO not deployed), this
    // transition is a no-op failure — deliberately NOT gated on below: the
    // callee must still be connected to the AI room even if the FSM audit
    // trail can't record the transition (this file's "never lose a call"
    // posture, matching routes/pstn.ts).
    const db = metaDb(env);
    const answerPatch: Record<string, unknown> = { answered_at: now };
    if (callUuid) answerPatch.call_uuid = callUuid;
    await applyAttemptTransition(db, attemptUuid, "answered", {
      trigger: "webhook",
      patch: answerPatch,
    });

    const ctx = await lookupAttemptContext(env, attemptUuid);
    if (!ctx) return safetyNetXml(); // attempt row vanished — never leave the callee on dead air

    // [AVA-CAMP-D-ANALYTICS] call_answered — §12.1 event taxonomy. Additive;
    // does not affect the XML/handoff path above or below it.
    void track(env, ctx.uid, "call_answered", "avatok", {
      campaign_id: ctx.campaign_id, attempt_uuid: attemptUuid,
      analytics_schema_version: 1, purpose: "LIVE",
    });

    // Minimal compiled prompt for B2 (full compilation is Phase C, §8 "Prompt
    // compiled server-side, frozen with compiled_prompt_hash + prompt_version
    // at launch") — campaigns.launch is expected to have already frozen
    // compiled_prompt; fall back to goal_text only if launch hasn't run yet
    // (e.g. a TEST call against a draft), so the room never gets an empty prompt.
    const compiledPrompt = (ctx.compiled_prompt && ctx.compiled_prompt.trim())
      ? ctx.compiled_prompt
      : ctx.goal_text;

    // ── [AVA-CAMP-B2-ROUTES] CAMPAIGN-MODE HANDOFF ────────────────────────
    // Same KV shape/TTL as routes/pstn.ts's agentStreamXmlOrNull() handoff
    // (pstn_agent:<sid>), extended with campaign-mode fields. sid is derived
    // from attempt_uuid (stable, unique) rather than call_uuid so the handoff
    // key is known BEFORE the answer webhook (the dial loop could pre-seed it
    // at dial time in a later phase if needed).
    //
    // TODO(Phase C / do/vobiz_agent_room.ts): the room must branch on
    // `mode === 'campaign'` and read {campaign_id, attempt_uuid, owner_uid,
    // compiled_prompt, kb_store, billing_ref, tokens_per_min} to run the call
    // with the campaign's prompt/KB instead of the inbound-receptionist path,
    // and must report elapsed seconds against `billing_ref` (=attempt_uuid)
    // via WalletDO's escrow ops (walletConsumeReserved/walletReleaseReservation
    // in routes/wallet.ts) rather than the receptionist's per-minute billing.
    // No such branch exists in the room today — this handler only seeds the
    // context and returns the stream XML, per the B2 task scope.
    const sid = `camp-${attemptUuid}`;
    try {
      await env.TOKENS.put(`pstn_agent:${sid}`, JSON.stringify({
        mode: "campaign",
        campaign_id: ctx.campaign_id,
        attempt_uuid: attemptUuid,
        owner_uid: ctx.uid,
        compiled_prompt: compiledPrompt,
        kb_store: ctx.kb_store || null,
        billing_ref: attemptUuid,
        tokens_per_min: CAMPAIGN_TOKENS_PER_MIN,
        language_hint: ctx.language_hint || null,
        voice_persona: ctx.voice_persona || null,
        call_uuid: callUuid || null,
        // [AVA-CAMP-C-ROOM] added — do/vobiz_agent_room.ts's campaign-mode
        // branch needs these for buildCampaignTools() (contact name/E.164 for
        // the booking tool's event description, booking_enabled to gate
        // whether the calendar tools are declared at all).
        contact_name: ctx.contact_name || null,
        contact_e164: ctx.contact_e164 || null,
        booking_enabled: !!ctx.booking_enabled,
        ts: now,
      }), { expirationTtl: AGENT_KV_TTL_SEC });
    } catch {
      // KV write failure — the room has nothing to read on connect. Fail the
      // call politely rather than let Vobiz bridge audio into an unseeded room.
      return safetyNetXml();
    }

    // Same bidirectional <Stream> shape as routes/pstn.ts's agent lane —
    // <Response><Stream bidirectional keepCallAlive contentType="audio/x-l16;rate=16000">
    // wss://.../api/pstn-agent/stream/<secret>/<sid></Stream></Response>.
    // Reuses the EXISTING pstn-agent websocket route (routes/pstn_agent.ts) —
    // no new websocket endpoint for campaigns; VobizAgentRoom is keyed by sid
    // exactly like the inbound agent lane, so the only new surface is the KV
    // handoff's `mode` field above.
    const wsBase = PUBLIC_BASE.replace(/^https:/, "wss:");
    const streamUrl = `${wsBase}/api/pstn-agent/stream/${encodeURIComponent(secret)}/${encodeURIComponent(sid)}`;
    const cbUrl = `${PUBLIC_BASE}/api/campaign-pstn/stream-cb/${encodeURIComponent(secret)}/${encodeURIComponent(attemptUuid)}`;
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000" ` +
      `statusCallbackUrl="${esc(cbUrl)}">${esc(streamUrl)}</Stream>` +
      `</Response>`,
    );
  } catch {
    return safetyNetXml();
  }
}

// ---------------------------------------------------------------------------
// POST /api/campaign-pstn/ring/<secret>/<attempt_uuid>
// ---------------------------------------------------------------------------
async function handleRing(req: Request, env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  if (!attemptUuid) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  try {
    const fields = await parseForm(req);
    const db = metaDb(env);
    const ringPatch: Record<string, unknown> = { ring_at: Date.now() };
    if (fields.CallUUID) ringPatch.call_uuid = fields.CallUUID;
    await applyAttemptTransition(db, attemptUuid, "ringing", {
      trigger: "webhook",
      patch: ringPatch,
    });
  } catch { /* best-effort — never fail a webhook over our own bug */ }
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ---------------------------------------------------------------------------
// POST /api/campaign-pstn/hangup/<secret>/<attempt_uuid>
// ---------------------------------------------------------------------------

/** Map a raw Vobiz/provider hangup cause to one of CallFSM's terminal
 *  AttemptStates for a call that was NEVER answered (see handleHangup —
 *  whether the call was answered is now decided from the attempt row's
 *  `answered_at`, the DB source of truth, not from webhook field heuristics).
 *  Conservative default: anything unrecognized -> 'failed' (never silently
 *  drop an attempt into a state CampaignDO won't retry correctly per the
 *  §6.4 retry taxonomy — 'failed' is the safe fallback the retry policy
 *  already has an explicit rule for). */
function terminalOutcomeFromCause(raw: string, fields: Record<string, string>): AttemptState {
  const cause = (raw || "").toUpperCase();
  const status = (fields.CallStatus || fields.HangupSource || "").toLowerCase();
  if (cause.includes("USER_BUSY") || cause.includes("BUSY")) return "busy";
  if (cause.includes("NO_ANSWER") || cause.includes("NOANSWER") || status === "no-answer") return "no_answer";
  if (cause.includes("REJECTED") || cause.includes("CANCEL")) return "canceled";
  return "failed";
}

async function handleHangup(req: Request, env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  if (!attemptUuid) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);

  try {
    const fields = await parseForm(req);
    const rawCause = fields.HangupCause || fields.HangupCauseName || fields.HangupSource || "";
    const durationS = Number(fields.Duration ?? fields.BillDuration ?? 0) || 0;
    const now = Date.now();

    const db = metaDb(env);

    // Whether the call was ever answered is decided from the attempt row's
    // `answered_at` (DB truth, set by the answer webhook) — NOT re-derived
    // from this hangup webhook's fields. If it was answered, the outcome
    // MUST stay 'answered' (a real completed call is not a "miss"); only an
    // unanswered call gets classified via terminalOutcomeFromCause.
    const attemptRow = await db
      .prepare(`SELECT answered_at FROM campaign_call_attempts WHERE attempt_uuid=?1`)
      .bind(attemptUuid)
      .first<{ answered_at: number | null }>();
    const wasAnswered = !!attemptRow?.answered_at;
    const outcome: AttemptState = wasAnswered ? "answered" : terminalOutcomeFromCause(rawCause, fields);

    const transition = await applyAttemptTransition(db, attemptUuid, outcome, {
      trigger: "webhook",
      patch: {
        ended_at: now,
        hangup_cause_raw: rawCause || null,
        pstn_total_duration_s: durationS,
      },
    });

    // Best-effort: if the direct transition was illegal from the derived
    // current state (e.g. a duplicate/late webhook arriving after settlement
    // already ran), that's fine — applyAttemptTransition's no-op/idempotency
    // handling covers same-state re-delivery (an answered call re-applying
    // 'answered' is exactly this no-op path, patching ended_at/duration in
    // place), and an illegal cross-state transition here just means a
    // later/earlier webhook already moved the row; we still want to notify
    // CampaignDO exactly once per real hangup, so proceed to notify
    // regardless of `transition.ok` (best-effort, never block the webhook
    // 200 to Vobiz).
    void transition;

    const ctx = await lookupAttemptContext(env, attemptUuid);
    if (ctx?.campaign_id) {
      try {
        const doNs = (env as unknown as { CAMPAIGN_DO?: DurableObjectNamespace }).CAMPAIGN_DO;
        if (doNs) {
          const stub = doNs.get(doNs.idFromName(ctx.campaign_id));
          await stub.fetch("https://c/onCallEnded", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              attempt_uuid: attemptUuid,
              outcome,
              hangup_cause_raw: rawCause || null,
              pstn_total_duration_s: durationS,
            }),
          });
        }
        // else: CAMPAIGN_DO binding not wired yet (wiring lands with the DO
        // itself, out of this task's scope per the B2 route task) — the FSM
        // transition above still landed in D1, so nothing is lost; CampaignDO
        // will reconcile from D1 on its next tick once it exists.
      } catch { /* best-effort — CallFSM write above is the source of truth */ }
    }
  } catch { /* fully best-effort handler — never surface a 5xx to Vobiz */ }

  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ---------------------------------------------------------------------------
// POST /api/campaign-pstn/amd/<secret>/<attempt_uuid> — async machine-
// detection verdict (§7 "AMD is advisory only" — never hangs up here).
// ---------------------------------------------------------------------------
async function handleAmd(req: Request, env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  if (!attemptUuid) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);

  try {
    const fields = await parseForm(req);
    // Vobiz's async-AMD callback field names per its docs: MachineDetection /
    // Confidence (percent or 0-1 depending on account config) — accept both
    // common shapes defensively.
    const result = (fields.MachineDetection || fields.Type || fields.AnsweredBy || "").toLowerCase() || null;
    const confidenceRaw = fields.Confidence ?? fields.confidence ?? "";
    let confidence: number | null = null;
    if (confidenceRaw !== "") {
      const n = Number(confidenceRaw);
      if (Number.isFinite(n)) confidence = n > 1 ? n / 100 : n;
    }

    const db = metaDb(env);
    // Record-only patch — do NOT drive a state transition here (§7: "never
    // jump UNKNOWN -> HANGUP"; AMD is a hint, not a hangup trigger). We use a
    // raw UPDATE rather than applyAttemptTransition because this is not a
    // state transition at all, just enriching the row.
    await db
      .prepare(`UPDATE campaign_call_attempts SET amd_result=?1, amd_confidence=?2 WHERE attempt_uuid=?3`)
      .bind(result, confidence, attemptUuid)
      .run();

    // Best-effort hint forward to the room's handoff blob, IF it still exists
    // (the room may already be running with the earlier snapshot; this is a
    // documented advisory hint only — see the TODO in handleAnswer for the
    // room-side seam that would actually consume it. No error here should
    // ever surface to Vobiz.)
    try {
      const sid = `camp-${attemptUuid}`;
      const existing = await env.TOKENS.get(`pstn_agent:${sid}`, "json") as Record<string, unknown> | null;
      if (existing) {
        await env.TOKENS.put(`pstn_agent:${sid}`, JSON.stringify({
          ...existing,
          amd_hint: { result, confidence, ts: Date.now() },
        }), { expirationTtl: AGENT_KV_TTL_SEC });
      }
    } catch { /* best-effort */ }
  } catch { /* fully best-effort — AMD is advisory, never break the webhook */ }

  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ---------------------------------------------------------------------------
// POST /api/campaign-pstn/stream-cb/<secret>/<attempt_uuid> — Vobiz <Stream>
// status callbacks for the campaign-mode stream (mirrors routes/pstn.ts's
// handleStreamCb: pure best-effort observability, no state change).
// ---------------------------------------------------------------------------
async function handleStreamCb(req: Request, env: Env, secret: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  try { await parseForm(req); } catch { /* best-effort */ }
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ---------------------------------------------------------------------------
// [AVA-CAMP-F4-CTRL] Warm-transfer human-handover webhook lane (spec §7, §16
// H1-H9). All orchestration lives in lib/campaign_handover.ts — these
// handlers only do secret-check + form-parse + hand the parsed fields off.
// Path shape matches the rest of this file:
//   /api/campaign-pstn/ho-answer/<secret>/<attempt_uuid>   — human leg answer_url
//   /api/campaign-pstn/ho-ring/<secret>/<attempt_uuid>     — human leg ring_url
//   /api/campaign-pstn/ho-hangup/<secret>/<attempt_uuid>   — human leg hangup_url
//   /api/campaign-pstn/ho-amd/<secret>/<attempt_uuid>      — human leg machine_detection_url
//   /api/campaign-pstn/ho-transfer/<secret>/<attempt_uuid> — Transfer-API aleg_url (the CALLER)
//   /api/campaign-pstn/conf-event/<secret>/<attempt_uuid>  — <Conference callbackUrl>
// ---------------------------------------------------------------------------

// POST /api/campaign-pstn/ho-answer/<secret>/<attempt_uuid> — the human
// (owner) leg answered; just return the whisper + hold-in-conference XML.
// No FSM transition here — that happens off the AMD verdict (ho-amd below),
// matching spec §7's "AMD enabled on this leg too" (the handover leg, unlike
// the main campaign leg, gates on AMD rather than treating it as advisory).
async function handleHoAnswer(env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) {
    return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`, 403);
  }
  if (!attemptUuid) return safetyNetXml();
  try {
    return xml(await humanAnswerXml(env, attemptUuid));
  } catch {
    return safetyNetXml();
  }
}

// POST /api/campaign-pstn/ho-ring/<secret>/<attempt_uuid> — best-effort ack,
// no FSM/state change (mirrors handleRing's shape for the main leg).
async function handleHoRing(req: Request, env: Env, secret: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  try { await parseForm(req); } catch { /* best-effort */ }
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// POST /api/campaign-pstn/ho-hangup/<secret>/<attempt_uuid> — human leg ended
// (H4 pre-bridge, or a normal post-bridge PSTN hangup that
// onHandoverLegHangup will itself no-op on — see lib/campaign_handover.ts).
async function handleHoHangup(req: Request, env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  if (!attemptUuid) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  try {
    await parseForm(req);
    await onHandoverLegHangup(env, attemptUuid, "human");
  } catch { /* best-effort — never fail a webhook over our own bug */ }
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// POST /api/campaign-pstn/ho-amd/<secret>/<attempt_uuid> — async
// machine-detection verdict for the HUMAN leg. Same field-shape fallback as
// handleAmd above (Vobiz's AnsweredBy/MachineDetection/Type naming varies by
// account config) but this one gates a real state transition (H5), unlike
// the main leg's advisory-only handleAmd.
async function handleHoAmd(req: Request, env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  if (!attemptUuid) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  try {
    const fields = await parseForm(req);
    const raw = (fields.MachineDetection || fields.Type || fields.AnsweredBy || "").toLowerCase();
    const amd: "human" | "machine" | null = raw.includes("machine") ? "machine" : raw.includes("human") ? "human" : null;
    await onHumanAnswered(env, attemptUuid, amd);
  } catch { /* best-effort — never fail a webhook over our own bug */ }
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// POST /api/campaign-pstn/ho-transfer/<secret>/<attempt_uuid> — the
// Transfer-API `aleg_url` for the CALLER leg (moved here by
// provider.transferCall in onHumanAnswered); returns the XML that joins the
// caller into the same conference room as the human.
async function handleHoTransfer(env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) {
    return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`, 403);
  }
  if (!attemptUuid) return safetyNetXml();
  try {
    return xml(callerTransferXml(attemptUuid, secret));
  } catch {
    return safetyNetXml();
  }
}

// POST /api/campaign-pstn/conf-event/<secret>/<attempt_uuid> — <Conference
// callbackUrl> participant events (ConferenceAction=enter|exit). Only the
// CALLER's `enter` confirms the bridge (BridgeConfirmed) — see
// lib/campaign_handover.ts's onConferenceEvent for the leg-resolution logic.
async function handleConfEvent(req: Request, env: Env, secret: string, attemptUuid: string): Promise<Response> {
  if (!secret || secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  if (!attemptUuid) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  try {
    const fields = await parseForm(req);
    await onConferenceEvent(env, attemptUuid, {
      type: fields.ConferenceAction || undefined,
      callUuid: fields.CallUUID || undefined,
    });
  } catch { /* best-effort — never fail a webhook over our own bug */ }
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ---------------------------------------------------------------------------
// Dispatcher — mount at /api/campaign-pstn/ (wiring agent's job; NOT done
// here per the task scope — see the report for the exact mount instructions).
// Path shape: /api/campaign-pstn/<action>/<secret>/<attempt_uuid>
// ---------------------------------------------------------------------------
export async function campaignPstnRoute(req: Request, env: Env, path: string): Promise<Response> {
  try {
    const rest = path.slice("/api/campaign-pstn/".length);
    const parts = rest.split("/").filter(Boolean);
    const kind = parts[0] || "";
    const secret = decodeURIComponent(parts[1] || "");
    const attemptUuid = decodeURIComponent(parts[2] || "");

    if (kind === "answer" && req.method === "POST") return await handleAnswer(req, env, secret, attemptUuid);
    if (kind === "ring" && req.method === "POST") return await handleRing(req, env, secret, attemptUuid);
    if (kind === "hangup" && req.method === "POST") return await handleHangup(req, env, secret, attemptUuid);
    if (kind === "amd" && req.method === "POST") return await handleAmd(req, env, secret, attemptUuid);
    if (kind === "stream-cb" && req.method === "POST") return await handleStreamCb(req, env, secret);

    // [AVA-CAMP-F4-CTRL] handover subpaths (additive — see the section above).
    if (kind === "ho-answer" && req.method === "POST") return await handleHoAnswer(env, secret, attemptUuid);
    if (kind === "ho-ring" && req.method === "POST") return await handleHoRing(req, env, secret);
    if (kind === "ho-hangup" && req.method === "POST") return await handleHoHangup(req, env, secret, attemptUuid);
    if (kind === "ho-amd" && req.method === "POST") return await handleHoAmd(req, env, secret, attemptUuid);
    if (kind === "ho-transfer" && req.method === "POST") return await handleHoTransfer(env, secret, attemptUuid);
    if (kind === "conf-event" && req.method === "POST") return await handleConfEvent(req, env, secret, attemptUuid);

    return json({ error: "not found" }, 404);
  } catch {
    if (
      path.startsWith("/api/campaign-pstn/answer/") ||
      path.startsWith("/api/campaign-pstn/ring/") ||
      path.startsWith("/api/campaign-pstn/hangup/") ||
      path.startsWith("/api/campaign-pstn/amd/") ||
      path.startsWith("/api/campaign-pstn/ho-answer/") ||
      path.startsWith("/api/campaign-pstn/ho-transfer/")
    ) {
      return safetyNetXml();
    }
    return json({ error: "internal error" }, 500);
  }
}
