/**
 * [CALL-RTK-2 2026-08-08] Cloudflare RealtimeKit token minting for AvaTOK calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * See `Specs/CALL-REALTIMEKIT-MIGRATION.md`. The short version: ~7,400 client
 * lines exist only because we drive the raw Cloudflare Realtime SFU and raw P2P
 * by hand — reconnection, WiFi<->cell handover, congestion adaptation, active
 * speaker. RealtimeKit (the former Dyte SDK, on the SAME Cloudflare Realtime SFU
 * we already pay for) internalises exactly those. This module is the entire
 * server half of that migration.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is a MEDIA-ADMISSION path only, and a deliberately small one. Ringing,
 * accept/decline, busy, presence, glare, the receptionist handoff and the 2-peer
 * cap all stay in `CallRoom` exactly as they are — RealtimeKit is meeting-join
 * based and has no concept of a phone ringing. Nothing above the media layer
 * changes, and nothing here can end, start or re-route a call.
 *
 * THE CONTRACT
 * ------------
 *   POST /api/callrtk/:room/join  { kind?: "audio"|"video"|"group", name? }
 *     -> { ok, provider, call_id, meeting_id, auth_token, preset, kind,
 *          join_deadline_sec }
 *
 * One route, one round trip: the client gets the meeting id and its own
 * participant token together and hands the token straight to `realtimekit_core`.
 *
 * PORTED FROM `calls/src/index.ts` (the AvaConsult prototype), with three
 * deliberate differences:
 *
 *  1. AUTHENTICATION. The prototype mints a token for anyone who can name a
 *     room string. Here every join is `requireUser`'d and then checked against
 *     the room's actual participant list (CallRoom's caller/callee pair for 1:1,
 *     `conversation_members` for a group). An unauthenticated mint would let any
 *     caller join any live conversation by guessing a room id — the single most
 *     dangerous thing this module could get wrong, and the same rule
 *     `call_sfu.ts` enforces with `ownsSession`.
 *  2. MEETING-ID HOME. The prototype caches `room -> meetingId` in KV. KV is
 *     eventually consistent, so two phones joining the same call within the same
 *     second can each read "no meeting", each create one, and end up in two
 *     different meetings hearing silence. The CallRoom DO is strongly consistent
 *     and already the authority on who is on this call, so the id lives there
 *     (`/rtk-meeting`, first-writer-wins).
 *  3. FLAGS. `callRealtimeKitV1` / `groupRealtimeKitV1` hard-refuse with 503
 *     before any Cloudflare call, same shape as `call_sfu.ts:137`.
 *
 * API SURFACE NOTE (verified against Cloudflare docs 2026-08-08): the current
 * RealtimeKit REST API is the Cloudflare account API —
 * `POST /client/v4/accounts/<account>/realtime/kit/<app>/meetings` with a
 * `Bearer` token — NOT the Dyte-era `api.realtime.cloudflare.com/v2` endpoint
 * with Basic `orgId:apiKey`. `CF_RTK_ORG_ID` therefore holds the RealtimeKit
 * **App ID** and `CF_RTK_API_KEY` the **API token**; the account id is reused
 * from the existing `CF_ACCOUNT_ID` var. The env names follow the spec so the
 * secret names in `scripts/cf.sh` match what was written down.
 */

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUser, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";

const APP = "avatok";
const PROVIDER = "realtimekit";

/**
 * Presets are created ONCE in the RealtimeKit dashboard (spec §3.1). A preset
 * name that does not exist there makes "Add Participant" fail with a 4xx, which
 * is why `kind` is a closed enumeration here rather than a passthrough string:
 * a client typo must be a 400 from us, not a confusing 502 from Cloudflare.
 */
const PRESETS = {
  audio: "avatok_1to1_audio",
  video: "avatok_1to1_video",
  group: "avatok_group",
} as const;

type RtkKind = keyof typeof PRESETS;

/** Same ≤25 conference cap the rest of the product enforces (owner rule, Phase 10). */
const MAX_GROUP_MEMBERS = 25;

/** Bound on anything client-chosen that we echo to Cloudflare. */
const MAX_NAME_LEN = 60;

function rtkConfigured(env: Env): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_RTK_ORG_ID && env.CF_RTK_API_KEY);
}

function rtkBase(env: Env): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.CF_RTK_ORG_ID}`;
}

type RtkResult = { ok: boolean; status: number; data: Record<string, unknown> };

/**
 * The only place this module talks to Cloudflare. The body is parsed
 * defensively for the same reason `call_sfu.ts` does it: a non-JSON error page
 * from an edge must not throw inside a call path, it must become a status the
 * client can fall back from. A network throw is surfaced as status 0 and
 * reported — never swallowed into an empty `catch {}`.
 */
async function rtk(
  env: Env,
  path: string,
  init: RequestInit,
  errCtx: { uid?: string; stage: string; room: string },
): Promise<RtkResult> {
  try {
    const r = await fetch(`${rtkBase(env)}${path}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${env.CF_RTK_API_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    let data: Record<string, unknown> = {};
    try { data = (await r.json()) as Record<string, unknown>; } catch { /* non-JSON edge error */ }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    // A thrown fetch (DNS, TLS, abort) is invisible in the response status, so
    // it goes to Error Tracking explicitly. Awaited, not fire-and-forget:
    // workerd cancels unawaited telemetry on early-return error paths.
    await trackException(env, e, {
      uid: errCtx.uid,
      route: "/api/callrtk/join",
      method: "POST",
      handled: true,
      app_name: APP,
      extra: { stage: errCtx.stage, call_id: errCtx.room, provider: PROVIDER },
    }).catch(() => undefined);
    return { ok: false, status: 0, data: {} };
  }
}

function roomFetch(env: Env, room: string, path: string, init?: RequestInit): Promise<Response> {
  return env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(room)).fetch(`https://call${path}`, init);
}

/**
 * Is this uid actually on this call?
 *
 * 1:1 — CallRoom already holds the caller/callee pair and refuses to answer for
 * a room with no participants, so this is one strongly-consistent read.
 * Group — the roster is `conversation_members`, the same table `groupcall.ts`
 * reads; the ≤25 cap is enforced here too so a RealtimeKit token can never be
 * the way around it.
 */
async function admitted(
  env: Env, room: string, uid: string, kind: RtkKind,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (kind === "group") {
    try {
      const rows = await env.DB_META
        .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1")
        .bind(room).all<{ uid: string }>();
      const members = (rows.results || []).map((r) => r.uid);
      if (!members.includes(uid)) return { ok: false, error: "not_a_participant", status: 403 };
      if (members.length > MAX_GROUP_MEMBERS) {
        return { ok: false, error: "group_too_large", status: 409 };
      }
      return { ok: true };
    } catch {
      // Fail CLOSED. An unreadable roster is not permission to join.
      return { ok: false, error: "roster_unavailable", status: 503 };
    }
  }
  const r = await roomFetch(env, room, `/participants?callId=${encodeURIComponent(room)}`);
  if (!r.ok) return { ok: false, error: "participants_unavailable", status: 503 };
  const b = (await r.json().catch(() => ({}))) as { callerUid?: string; calleeUid?: string };
  if (uid !== b.callerUid && uid !== b.calleeUid) {
    return { ok: false, error: "not_a_participant", status: 403 };
  }
  return { ok: true };
}

/**
 * Guard, mirroring `call_sfu.ts`. The uid is resolved BEFORE the flag refusals
 * on purpose: a block that cannot be attributed to a person cannot be diagnosed
 * when the owner says "my call didn't connect". `email` rides every event for
 * the same reason — a call bug is a conversation between two people and both
 * sides have to be pullable from PostHog later.
 */
type Guard = { uid: string; email: string | null; kind: RtkKind; deadlineSec: number; name: string };

async function guard(req: Request, env: Env, room: string): Promise<Guard | Response> {
  const cfg = await readConfig(env);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: (u as { error: string }).error }, (u as { status: number }).status);
  const uid = (u as { uid: string }).uid;
  const email = await emailFor(env, uid).catch(() => null);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawKind = typeof body.kind === "string" ? body.kind : "audio";
  if (!(rawKind in PRESETS)) {
    return json({ error: "bad_kind", allowed: Object.keys(PRESETS) }, 400);
  }
  const kind = rawKind as RtkKind;
  const name = (typeof body.name === "string" && body.name.trim() ? body.name.trim() : "AvaTOK user")
    .slice(0, MAX_NAME_LEN);

  // Two flags, not one: a group pilot must be flippable without exposing 1:1
  // (spec §5 — Phase 1 is groups only).
  const flagOn = kind === "group" ? cfg.groupRealtimeKitV1 : cfg.callRealtimeKitV1;
  if (!flagOn) {
    await trackUser(env, uid, email, "call_rtk_blocked", APP, {
      call_id: room, kind, reason: "flag_off", provider: PROVIDER,
    }).catch(() => undefined);
    return json({ error: "rtk_unavailable", reason: "flag_off" }, 503);
  }
  if (kind === "group" && !cfg.conferenceEnabled) {
    await trackUser(env, uid, email, "call_rtk_blocked", APP, {
      call_id: room, kind, reason: "conference_off", provider: PROVIDER,
    }).catch(() => undefined);
    return json({ error: "rtk_unavailable", reason: "conference_off" }, 503);
  }
  if (!rtkConfigured(env)) {
    // Secrets missing. This branch must never be silent: a misconfigured
    // environment and a working one would otherwise be indistinguishable from
    // the client, which is exactly how the TURN "relay_degraded" blind spot
    // happened on the P2P path.
    await trackUser(env, uid, email, "call_rtk_blocked", APP, {
      call_id: room, kind, reason: "unconfigured", provider: PROVIDER,
    }).catch(() => undefined);
    return json({ error: "rtk_unavailable", reason: "unconfigured" }, 503);
  }

  const deadlineSec = typeof cfg.callRtkJoinDeadlineSec === "number" && cfg.callRtkJoinDeadlineSec > 0
    ? cfg.callRtkJoinDeadlineSec
    : 10;
  return { uid, email, kind, deadlineSec, name };
}

/**
 * Resolve the meeting for this room, creating it on first join.
 *
 * The DO is the arbiter of the create race, not us: both phones may create a
 * meeting concurrently, and whichever POSTs to `/rtk-meeting` second gets the
 * FIRST writer's id back (`created:false`) and adopts it. Its own freshly
 * created meeting is simply abandoned — an empty RealtimeKit meeting nobody
 * joins costs nothing, whereas two phones in two meetings is a connected call
 * with silence, the worst failure shape there is.
 */
async function resolveMeeting(
  env: Env, room: string, uid: string,
): Promise<{ ok: true; meetingId: string; created: boolean } | { ok: false; status: number; error: string; detail?: unknown }> {
  const got = await roomFetch(env, room, `/rtk-meeting?callId=${encodeURIComponent(room)}`);
  if (got.ok) {
    const b = (await got.json().catch(() => ({}))) as { meeting_id?: string | null };
    if (b.meeting_id) return { ok: true, meetingId: b.meeting_id, created: false };
  }

  const res = await rtk(env, "/meetings", {
    method: "POST",
    body: JSON.stringify({ title: `avatok:${room}` }),
  }, { uid, stage: "meeting_create", room });
  const data = res.data as { success?: boolean; result?: { id?: string }; data?: { id?: string } };
  // Cloudflare's account API wraps the payload in `result`; the Dyte-era API
  // used `data`. Accept either so a base-URL change cannot silently 502 us.
  const meetingId = data.result?.id ?? data.data?.id ?? "";
  if (!res.ok || !meetingId) {
    return { ok: false, status: res.status, error: "meeting_create_failed", detail: res.data };
  }

  const put = await roomFetch(env, room, "/rtk-meeting", {
    method: "POST",
    body: JSON.stringify({ callId: room, meetingId }),
  });
  if (!put.ok) return { ok: false, status: put.status, error: "meeting_store_failed" };
  const stored = (await put.json().catch(() => ({}))) as { meeting_id?: string; created?: boolean };
  return { ok: true, meetingId: stored.meeting_id || meetingId, created: stored.created !== false };
}

/**
 * POST /api/callrtk/:room/join
 *
 * Returns the participant `auth_token` the client feeds to `realtimekit_core`.
 * `join_deadline_sec` is returned with it so the client's abort-to-legacy timer
 * is server-tunable from KV — the whole point of `callRtkJoinDeadlineSec` is
 * that a bad deadline is a flag flip, not a 40-80 minute CI round trip.
 */
export async function callRtkJoin(req: Request, env: Env, room: string): Promise<Response> {
  const g = await guard(req, env, room);
  if (g instanceof Response) return g;
  const startedAt = Date.now();

  const adm = await admitted(env, room, g.uid, g.kind);
  if (!adm.ok) {
    await trackUser(env, g.uid, g.email, "call_rtk_blocked", APP, {
      call_id: room, kind: g.kind, reason: adm.error, provider: PROVIDER,
    }).catch(() => undefined);
    return json({ error: adm.error }, adm.status);
  }

  const meeting = await resolveMeeting(env, room, g.uid);
  if (!meeting.ok) {
    await trackUser(env, g.uid, g.email, "call_rtk_error", APP, {
      call_id: room, kind: g.kind, stage: "meeting", status: meeting.status, provider: PROVIDER,
    }).catch(() => undefined);
    return json({ error: meeting.error, status: meeting.status }, 502);
  }

  const preset = PRESETS[g.kind];
  const pRes = await rtk(env, `/meetings/${encodeURIComponent(meeting.meetingId)}/participants`, {
    method: "POST",
    body: JSON.stringify({
      name: g.name,
      preset_name: preset,
      // Stable per-user id: RealtimeKit uses it to reconcile a rejoin with the
      // participant that just dropped, which is what makes a handover look like
      // a blip instead of a new person walking into the call.
      custom_participant_id: g.uid.slice(0, 64),
    }),
  }, { uid: g.uid, stage: "add_participant", room });
  const pData = pRes.data as { result?: { token?: string }; data?: { token?: string } };
  const authToken = pData.result?.token ?? pData.data?.token ?? "";
  if (!pRes.ok || !authToken) {
    await trackUser(env, g.uid, g.email, "call_rtk_error", APP, {
      call_id: room, kind: g.kind, stage: "add_participant", status: pRes.status,
      meeting_id: meeting.meetingId, preset, provider: PROVIDER,
    }).catch(() => undefined);
    return json({ error: "participant_add_failed", status: pRes.status }, 502);
  }

  await trackUser(env, g.uid, g.email, "call_rtk_joined", APP, {
    call_id: room,
    kind: g.kind,
    preset,
    meeting_id: meeting.meetingId,
    meeting_created: meeting.created,
    join_deadline_sec: g.deadlineSec,
    elapsed_ms: Date.now() - startedAt,
    provider: PROVIDER,
  }).catch(() => undefined);

  return json({
    ok: true,
    provider: PROVIDER,
    call_id: room,
    kind: g.kind,
    preset,
    meeting_id: meeting.meetingId,
    auth_token: authToken,
    // camelCase aliases: the spec writes the contract as `{ authToken,
    // meetingId }` and `realtimekit_core` names them that way, while every
    // other AvaTOK call route is snake_case. Emitting both costs 40 bytes and
    // removes an entire class of "the client read the wrong key" bug — the
    // dual-emit precedent from routes/call_translation.ts.
    meetingId: meeting.meetingId,
    authToken,
    join_deadline_sec: g.deadlineSec,
  });
}
