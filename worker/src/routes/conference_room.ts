// [ADDCALL-2-SRV] HTTP front for ConferenceRoomDO — the migration coordinator.
// Spec: Specs/SPEC-ADD-TO-CALL-2026-08-06.md §3 (DO ownership), §4 (migration),
// §10 (telemetry).
//
// ── ADDRESSING: `roomId` IS THE 1:1 `call_id`, NOT THE GROUP ID ─────────────
// `/api/conference-room/<roomId>/<action>` resolves ConferenceRoomDO by
// `idFromName(roomId)`, and add-to-call passes the **1:1 call_id** of the call
// being escalated. That is load-bearing, not cosmetic: EITHER party may press
// Add (spec §decision summary), and both parties of a 1:1 share exactly one
// call_id, so both necessarily land on the SAME durable object and
// `reserveMigration`'s single-flight can pick a winner. Address it by groupId
// and two simultaneous Adds create two ad-hoc rooms in two different DOs, both
// "win", and the call splits in half with no error anywhere.
//
// `GroupCallRoom` — which owns media and IS authoritative for admission — is a
// different object addressed by `idFromName(groupId)`. Nothing here mints,
// validates or even reads a media ticket, and this object's `generation` must
// never be used for one (see do/conference_room.ts).
import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { json } from "../util";
import { contactFor } from "../lib/identity";
import { trackUserContact, trackException } from "../hooks";
import { CallEvent } from "../lib/call_telemetry_events";
import { escalationIdFor } from "./adhoc_room";

const APP = "avatok";

function room(env: Env, roomId: string) {
  return env.CONFERENCE_ROOMS.get(env.CONFERENCE_ROOMS.idFromName(roomId));
}

/** The actions that make up one escalation funnel. Only these are instrumented;
 *  `state` is a poll and would drown the funnel it is meant to explain. */
const MIGRATION_ACTIONS = new Set([
  "start", "migration/reserve", "migration/prepare", "migration/commit",
  "migration/abort", "migration/release",
]);

/**
 * Telemetry that never throws — every call site sits inside `ctx.waitUntil`.
 * workerd DROPS unawaited telemetry on an early-return error path (CLAUDE.md),
 * and the failure emits below are all followed immediately by a return.
 *
 * `participants` tags every uid in the room so ANY party's email retrieves the
 * escalation, not just the person who pressed Add (CLAUDE.md: a two-sided
 * feature must be pullable from either side).
 */
async function emit(
  env: Env, uid: string, event: string, props: Record<string, unknown>,
): Promise<void> {
  try {
    const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, uid, c.email, c.phone, event, APP, props);
  } catch { /* best-effort */ }
}

/** Map one DO response onto catalogue events. Names come from
 *  lib/call_telemetry_events.ts — spec §10 is explicit that these were written
 *  against this design and must be WIRED, not replaced with new ones. */
function eventsFor(action: string, ok: boolean): string[] {
  if (!ok) {
    // One name for every migration failure, with the reason in props, so the
    // funnel has a single drop-off event rather than six near-synonyms.
    return action === "migration/abort" ? [] : [CallEvent.groupcall_escalate_failed];
  }
  switch (action) {
    case "migration/prepare":
      return [CallEvent.groupcall_migration_prepare_completed];
    case "migration/commit":
      // sfu_audio_confirmed FIRST: the commit is only accepted because the
      // client presented `sfu_ready:true`, i.e. ICE+DTLS+audio flow confirmed
      // on the SFU path. It is one of the two moments spec §10 names as able
      // to fail, and this is its only server-side emit site.
      return [CallEvent.sfu_audio_confirmed, CallEvent.groupcall_switch_committed];
    case "migration/release":
      // The other named moment. The 1:1 leg is now down and the escalation is
      // genuinely finished, so escalate_completed closes the funnel opened by
      // groupcall_escalate_started in routes/adhoc_room.ts.
      return [CallEvent.groupcall_release_p2p, CallEvent.groupcall_escalate_completed];
    case "migration/abort":
      return [CallEvent.groupcall_migrate_rollback_completed];
    default:
      return [];
  }
}

export async function conferenceRoomRoute(req: Request, env: Env, roomId: string, action: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  const allowed = new Set(["state", "start", "participant/reserve", "participant/join", "participant/leave", "migration/reserve", "migration/prepare", "migration/commit", "migration/abort", "migration/release", "billing/start", "billing/sponsor/accept", "billing/tick", "host/transfer", "end"]);
  if (!allowed.has(action)) return json({ error: "not found" }, 404);
  // Owner decision 2026-08-02: human audio/video conferences are permanently
  // free. Keep legacy billing actions as harmless success responses so an older
  // installed client cannot fail a call, but never hold, settle, or transfer
  // wallet funds. These actions deliberately do not reach the DO.
  if (action === "billing/start" || action === "billing/sponsor/accept") {
    return json({ ok: true, free: true, tariff_per_hour: 0, billing_disabled: true });
  }
  if (action === "billing/tick") {
    return json({ ok: true, free: true, settled: false, billing_disabled: true });
  }
  if (action === "start") {
    // Membership is checked HERE, before the DO seeds its participant array —
    // which is what makes `requireMember` inside the DO mean anything at all.
    //
    // `kind` is deliberately NOT filtered. An add-to-call room is
    // `kind='call'` (routes/adhoc_room.ts), and neither this query nor the
    // DO's own `isGroupMember` looks at `kind`, so an invisible ad-hoc room
    // satisfies this check exactly like a real group. That is the same
    // property `groupcall.ts` relies on; do not "tighten" it to kind='group'
    // or every add-to-call escalation 403s here.
    const groupId = String((body as any)?.group_id ?? "").trim();
    if (!groupId) return json({ error: "group_id required" }, 400);
    const member = await env.DB_META.prepare("SELECT 1 AS ok FROM conversation_members WHERE conv_id=?1 AND uid=?2 LIMIT 1").bind(groupId, ctx.uid).first<{ ok: number }>();
    if (!member) {
      exec?.waitUntil(emit(env, ctx.uid, CallEvent.groupcall_escalate_failed, {
        escalation_id: escalationIdFor(roomId), call_id: roomId, group_id: groupId,
        stage: "start", reason: "not_a_group_participant",
      }));
      return json({ error: "not a group participant" }, 403);
    }
  }
  const payload: Record<string, unknown> = { ...(body as Record<string, unknown>), uid: ctx.uid };

  let res: Response;
  try {
    res = await room(env, roomId).fetch(`https://conference-room/${action}`, {
      method: req.method === "GET" ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: req.method === "GET" ? undefined : JSON.stringify(payload),
    });
  } catch (e) {
    exec?.waitUntil(trackException(env, e, {
      uid: ctx.uid, route: `/api/conference-room/:id/${action}`, method: req.method, handled: true,
      extra: { escalation_id: escalationIdFor(roomId), call_id: roomId },
    }));
    if (MIGRATION_ACTIONS.has(action)) {
      exec?.waitUntil(emit(env, ctx.uid, CallEvent.groupcall_escalate_failed, {
        escalation_id: escalationIdFor(roomId), call_id: roomId, stage: action, reason: "do_unreachable",
      }));
    }
    return json({ error: "conference_room_unavailable" }, 503);
  }

  if (!MIGRATION_ACTIONS.has(action) || !exec) return res;

  // Read the body once so we can both instrument it and return it verbatim.
  // `res.clone()` would work too, but a DO response is small and re-wrapping
  // avoids holding two streams open on a hot path.
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON: still emit */ }

  const ok = res.status >= 200 && res.status < 300;
  const participants = Array.isArray(parsed?.participants) && parsed!.participants.every((x) => typeof x === "string")
    ? (parsed!.participants as string[])
    : undefined;
  const props: Record<string, unknown> = {
    escalation_id: escalationIdFor(roomId),
    call_id: roomId,
    stage: action,
    status: res.status,
    group_id: parsed?.group_id ?? undefined,
    conference_id: parsed?.conference_id ?? undefined,
    migration_id: parsed?.migration_id ?? (payload.migration_id as string | undefined),
    generation: parsed?.generation ?? undefined,
    // Every participant, so either side of the call retrieves this escalation.
    participants,
  };
  if (!ok) {
    props.reason = typeof parsed?.error === "string" ? parsed.error : `http_${res.status}`;
    props.code = parsed?.code ?? undefined;
  }
  if (action === "migration/release") {
    props.overlap_ms = parsed?.overlap_ms ?? undefined;
    props.committed_at = parsed?.committed_at ?? undefined;
  }
  if (action === "migration/abort") {
    props.reason = props.reason ?? (payload.reason as string | undefined) ?? "client_abort";
  }

  for (const ev of eventsFor(action, ok)) {
    exec.waitUntil(emit(env, ctx.uid, ev, props));
  }

  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
}
