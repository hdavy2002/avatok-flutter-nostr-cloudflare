// call_telemetry_events.ts — PostHog telemetry contract for the unified
// call control-plane + SFU plan.
// Spec: Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md §8B (full event catalog).
//
// This module is the canonical TypeScript source of the `snake_case` event
// names, global enums, and base envelope described in §8B.1–8B.3, plus every
// event in the per-domain catalogs §8B.4–8B.12. It mirrors the existing
// telemetry patterns in this codebase:
//   - worker/src/lib/ava_search_telemetry.ts — best-effort, off-request-path
//     (via ctx.waitUntil), never throws, stamps test-user email/phone.
//   - worker/src/lib/event_bus.ts — mirrors events to Q_ANALYTICS so they land
//     in the same PostHog project without a new pipeline.
//
// STATUS: this module is exported but NOT YET IMPORTED by any caller.
// Behavior-neutral — zero runtime change until a producer wires it in.

import type { Env } from "../types";

// ---------------------------------------------------------------------------
// 8B.1 Naming standard / schema version
// ---------------------------------------------------------------------------

/** Bump whenever the event/property contract changes (§8B.18). */
export const CALL_TELEMETRY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 8B.3 Global enums (never send free-form strings)
// ---------------------------------------------------------------------------

export const BUSY_REASONS = [
  "active_call",
  "receptionist",
  "callback_reserved",
  "group_full",
  "migration",
  "ringing_other_device",
  "account_switch",
  "device_handoff",
  "rate_limited",
  "blocked",
  "do_not_disturb",
  "provider_failure",
  "unknown",
] as const;
export type BusyReason = (typeof BUSY_REASONS)[number];

export const AUTHORITY_PHASES = [
  "idle",
  "incoming_ringing",
  "outgoing_ringing",
  "connecting",
  "connected",
  "receptionist_active",
  "callback_reserved",
  "migrating",
  "releasing",
] as const;
export type AuthorityPhase = (typeof AUTHORITY_PHASES)[number];

export const ENDED_REASONS = [
  "completed",
  "declined",
  "busy",
  "missed",
  "cancelled",
  "timeout",
  "network",
  "ice_failure",
  "provider_failure",
  "rtc_error",
  "migration_failed",
  "preempted",
  "duplicate_session",
  "authority_rejected",
  "abandoned",
  "voicemail",
  "rate_limited",
  "unknown",
] as const;
export type EndedReason = (typeof ENDED_REASONS)[number];

export const RTC_ERROR_STAGES = [
  "token",
  "authority_rpc",
  "callroom_rpc",
  "groupcall_rpc",
  "websocket",
  "push",
  "ice",
  "dtls",
  "publish",
  "subscribe",
  "renegotiation",
  "turn",
  "relay",
  "track",
  "codec",
  "provider",
  "network",
  "permission",
  "timeout",
  "unknown",
] as const;
export type RtcErrorStage = (typeof RTC_ERROR_STAGES)[number];

export const RTC_PROVIDERS = ["cloudflare", "jitsi", "livekit", "mock", "unknown"] as const;
export type RtcProvider = (typeof RTC_PROVIDERS)[number];

export const RTC_MODES = ["p2p", "sfu"] as const;
export type RtcMode = (typeof RTC_MODES)[number];

export const MEDIA_MODES = ["audio", "video", "audio_locked"] as const;
export type MediaMode = (typeof MEDIA_MODES)[number];

export const AUTHORITY_DECISIONS = [
  "allow",
  "busy",
  "preempt",
  "redirect_receptionist",
  "reject",
  "retry",
  "conflict",
] as const;
export type AuthorityDecision = (typeof AUTHORITY_DECISIONS)[number];

// ---------------------------------------------------------------------------
// 8B.2 Base event envelope (on EVERY event)
// ---------------------------------------------------------------------------

/**
 * Base envelope carried on every call-telemetry event. Callers pass whatever
 * subset they have; `emitCallEvent` stamps `event_time_ms` / `schema_version`
 * if omitted. `call_trace_id` never changes for the lifetime of a call and is
 * propagated client → push → Authority → CallRoom → GroupCall → SFU → PostHog.
 */
export interface CallEventEnvelope {
  // Required on every event
  event_time_ms?: number;
  schema_version?: number;
  call_trace_id: string;

  // Call-scoped
  call_id?: string;
  authority_epoch?: number;
  authority_phase?: AuthorityPhase;

  // Identity / device (required per spec; optional here so a best-effort
  // emitter can still send a partial envelope rather than throwing)
  account_id?: string;
  /** Test users only, per project rule (see ava_search_telemetry.ts). */
  account_email?: string;
  device_session_id?: string;
  device_id?: string;
  owner_device?: boolean;
  app_version?: string;
  build?: string;
  protocol_version?: number;

  // RTC shape
  rtc_provider?: RtcProvider;
  rtc_mode?: RtcMode;
  media_mode?: MediaMode;
  participant_count?: number;

  /** caller | callee | invitee | adder … */
  role?: string;

  // Device / network
  network_type?: string;
  carrier?: string;
  device_model?: string;
  os?: string;
  os_version?: string;
  locale?: string;

  // Server-side (from request.cf)
  country?: string;
  colo?: string;

  // Correlation
  request_id?: string;
  authority_id?: string;
  room_id?: string;
  mutation_id?: string;

  // Sampling
  retry_count?: number;
  sampled?: boolean;
  sample_rate?: number;

  // Anything event-specific rides here too; emitCallEvent flattens `props`
  // alongside the envelope fields above.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 8B.4–8B.12 Event catalog — every event name, grouped by domain.
// ---------------------------------------------------------------------------

export const CallEvent = {
  // --- 8B.4 Authority event catalog (control plane) ---
  authority_acquire_call: "authority_acquire_call",
  authority_query_busy: "authority_query_busy",
  authority_state_transition: "authority_state_transition",
  authority_transition_rejected: "authority_transition_rejected",
  authority_epoch_conflict: "authority_epoch_conflict",
  authority_preempt_callback: "authority_preempt_callback",
  authority_callback_reservation_created: "authority_callback_reservation_created",
  authority_callback_reservation_expired: "authority_callback_reservation_expired",
  authority_callback_reservation_consumed: "authority_callback_reservation_consumed",
  authority_receptionist_abandon_requested: "authority_receptionist_abandon_requested",
  authority_release_call: "authority_release_call",
  authority_lease_renewed: "authority_lease_renewed",
  authority_lease_expired: "authority_lease_expired",
  authority_recovered_after_wake: "authority_recovered_after_wake",
  authority_callroom_reconciliation: "authority_callroom_reconciliation",
  authority_split_brain_detected: "authority_split_brain_detected",
  authority_rpc_started: "authority_rpc_started",
  authority_rpc_completed: "authority_rpc_completed",
  authority_rpc_failed: "authority_rpc_failed",
  authority_shadow_decision: "authority_shadow_decision",
  authority_shadow_divergence: "authority_shadow_divergence",
  authority_duplicate_mutation: "authority_duplicate_mutation",
  authority_owner_changed: "authority_owner_changed",
  authority_protocol_fallback: "authority_protocol_fallback",

  // --- 8B.5 Receptionist event catalog ---
  receptionist_session_started: "receptionist_session_started",
  receptionist_session_connected: "receptionist_session_connected",
  receptionist_stt_started: "receptionist_stt_started",
  receptionist_stt_stopped: "receptionist_stt_stopped",
  receptionist_llm_started: "receptionist_llm_started",
  receptionist_llm_completed: "receptionist_llm_completed",
  receptionist_session_ended: "receptionist_session_ended",
  receptionist_abandon_requested: "receptionist_abandon_requested",
  receptionist_abandon_received: "receptionist_abandon_received",
  receptionist_abandon_completed: "receptionist_abandon_completed",
  receptionist_preempt_requested: "receptionist_preempt_requested",
  receptionist_preempt_completed: "receptionist_preempt_completed",
  receptionist_preempt_failed: "receptionist_preempt_failed",
  receptionist_voicemail_generated: "receptionist_voicemail_generated",
  receptionist_voicemail_suppressed: "receptionist_voicemail_suppressed",
  receptionist_summary_generated: "receptionist_summary_generated",
  receptionist_summary_suppressed: "receptionist_summary_suppressed",
  receptionist_delivery_started: "receptionist_delivery_started",
  receptionist_delivery_completed: "receptionist_delivery_completed",
  receptionist_delivery_failed: "receptionist_delivery_failed",
  receptionist_audio_uploaded: "receptionist_audio_uploaded",
  receptionist_audio_deleted: "receptionist_audio_deleted",
  receptionist_callback_preempt_funnel: "receptionist_callback_preempt_funnel",
  /** Must be zero forever — see §8B.16 alert #2. */
  receptionist_false_delivery: "receptionist_false_delivery",

  // --- 8B.6 Busy event catalog ---
  busy_decision: "busy_decision",
  busy_shown: "busy_shown",
  busy_tone_started: "busy_tone_started",
  busy_tone_completed: "busy_tone_completed",
  busy_redirect_receptionist: "busy_redirect_receptionist",
  busy_terminal_screen_shown: "busy_terminal_screen_shown",
  busy_terminal_screen_closed: "busy_terminal_screen_closed",
  busy_false_positive: "busy_false_positive",
  busy_false_negative: "busy_false_negative",
  busy_shadow_match: "busy_shadow_match",
  busy_shadow_mismatch: "busy_shadow_mismatch",
  busy_ignored_duplicate: "busy_ignored_duplicate",
  busy_override_by_authority: "busy_override_by_authority",
  busy_retry_after_timeout: "busy_retry_after_timeout",
  busy_rate_limited: "busy_rate_limited",

  // --- 8B.7 P2P / CallRoom event catalog ---
  call_dial_started: "call_dial_started",
  call_request_sent: "call_request_sent",
  call_request_received: "call_request_received",
  call_incoming_shown: "call_incoming_shown",
  call_ring_started: "call_ring_started",
  call_ring_stopped: "call_ring_stopped",
  call_answered: "call_answered",
  call_declined: "call_declined",
  call_cancelled: "call_cancelled",
  call_connect_started: "call_connect_started",
  call_connected: "call_connected",
  call_ended: "call_ended",

  callroom_duplicate_session_detected: "callroom_duplicate_session_detected",
  callroom_duplicate_session_blocked: "callroom_duplicate_session_blocked",
  callroom_duplicate_session_adopted: "callroom_duplicate_session_adopted",
  callroom_state_reconciled: "callroom_state_reconciled",

  rtc_offer_created: "rtc_offer_created",
  rtc_answer_created: "rtc_answer_created",
  rtc_offer_sent: "rtc_offer_sent",
  rtc_answer_sent: "rtc_answer_sent",
  rtc_ice_gathering_started: "rtc_ice_gathering_started",
  rtc_ice_gathering_completed: "rtc_ice_gathering_completed",
  rtc_ice_connection_state_changed: "rtc_ice_connection_state_changed",
  rtc_dtls_state_changed: "rtc_dtls_state_changed",
  rtc_selected_candidate_pair: "rtc_selected_candidate_pair",
  rtc_turn_relay_used: "rtc_turn_relay_used",
  rtc_direct_p2p_established: "rtc_direct_p2p_established",
  rtc_reconnect_started: "rtc_reconnect_started",
  rtc_reconnect_completed: "rtc_reconnect_completed",
  rtc_reconnect_failed: "rtc_reconnect_failed",
  rtc_track_added: "rtc_track_added",

  // --- 8B.8 Push event catalog ---
  push_sent: "push_sent",
  push_send_failed: "push_send_failed",
  push_received: "push_received",
  push_opened: "push_opened",
  push_processed: "push_processed",
  push_processing_failed: "push_processing_failed",
  push_duplicate_received: "push_duplicate_received",
  push_out_of_order: "push_out_of_order",
  push_ignored_stale_epoch: "push_ignored_stale_epoch",
  push_authority_query_started: "push_authority_query_started",
  push_authority_query_completed: "push_authority_query_completed",
  push_authority_query_failed: "push_authority_query_failed",
  push_routed_to_receptionist: "push_routed_to_receptionist",
  push_callback_preempt_received: "push_callback_preempt_received",
  push_notification_displayed: "push_notification_displayed",
  push_notification_tapped: "push_notification_tapped",
  push_expired: "push_expired",
  push_delivery_timeout: "push_delivery_timeout",
  push_retry_scheduled: "push_retry_scheduled",

  // --- 8B.9 GroupCall / SFU event catalog ---
  groupcall_escalate_started: "groupcall_escalate_started",
  groupcall_escalate_completed: "groupcall_escalate_completed",
  groupcall_escalate_failed: "groupcall_escalate_failed",
  groupcall_migration_prepare_completed: "groupcall_migration_prepare_completed",
  groupcall_sfu_room_created: "groupcall_sfu_room_created",
  groupcall_sfu_room_creation_failed: "groupcall_sfu_room_creation_failed",
  groupcall_join_started: "groupcall_join_started",
  groupcall_join_completed: "groupcall_join_completed",
  groupcall_join_failed: "groupcall_join_failed",
  groupcall_leave: "groupcall_leave",
  groupcall_migrate_timeout: "groupcall_migrate_timeout",
  groupcall_migrate_rollback_started: "groupcall_migrate_rollback_started",
  groupcall_migrate_rollback_completed: "groupcall_migrate_rollback_completed",
  /** ice+dtls+audio-flow confirmed on the SFU path. */
  sfu_audio_confirmed: "sfu_audio_confirmed",
  groupcall_ready_to_switch: "groupcall_ready_to_switch",
  groupcall_switch_committed: "groupcall_switch_committed",
  groupcall_release_p2p: "groupcall_release_p2p",
  groupcall_invite_created: "groupcall_invite_created",
  groupcall_invite_sent: "groupcall_invite_sent",
  groupcall_invite_received: "groupcall_invite_received",
  groupcall_invite_accepted: "groupcall_invite_accepted",
  groupcall_invite_declined: "groupcall_invite_declined",
  groupcall_invite_expired: "groupcall_invite_expired",
  groupcall_membership_cas_conflict: "groupcall_membership_cas_conflict",
  groupcall_full_rejected: "groupcall_full_rejected",
  groupcall_degrade_warning_shown: "groupcall_degrade_warning_shown",
  groupcall_degrade_warning_confirmed: "groupcall_degrade_warning_confirmed",
  groupcall_degrade_warning_cancelled: "groupcall_degrade_warning_cancelled",
  groupcall_mode_degraded: "groupcall_mode_degraded",
  groupcall_audio_lock_enforced: "groupcall_audio_lock_enforced",
  groupcall_video_publish_rejected: "groupcall_video_publish_rejected",
  groupcall_roster_updated: "groupcall_roster_updated",
  groupcall_provider_capacity_rejected: "groupcall_provider_capacity_rejected",

  // --- 8B.10 RTC quality event catalog ---
  /** Highest-volume event: every 10s while connected. See §8B.14 sampling. */
  rtc_quality_tick: "rtc_quality_tick",
  rtc_quality_summary: "rtc_quality_summary",
  rtc_network_changed: "rtc_network_changed",
  rtc_bandwidth_estimate_changed: "rtc_bandwidth_estimate_changed",
  rtc_active_speaker_changed: "rtc_active_speaker_changed",
  rtc_track_muted: "rtc_track_muted",
  rtc_track_unmuted: "rtc_track_unmuted",
  rtc_camera_enabled: "rtc_camera_enabled",
  rtc_camera_disabled: "rtc_camera_disabled",
  rtc_microphone_enabled: "rtc_microphone_enabled",
  rtc_microphone_disabled: "rtc_microphone_disabled",
  rtc_error: "rtc_error",
  rtc_provider_warning: "rtc_provider_warning",
  rtc_provider_recovered: "rtc_provider_recovered",
  rtc_media_permission_denied: "rtc_media_permission_denied",
  rtc_device_changed: "rtc_device_changed",
  rtc_codec_negotiated: "rtc_codec_negotiated",
  rtc_codec_changed: "rtc_codec_changed",

  // --- 8B.11 Abuse / rate-limit catalog ---
  abuse_call_rate_limit_triggered: "abuse_call_rate_limit_triggered",
  abuse_invite_rate_limit_triggered: "abuse_invite_rate_limit_triggered",
  abuse_receptionist_rate_limit_triggered: "abuse_receptionist_rate_limit_triggered",
  abuse_callback_rate_limit_triggered: "abuse_callback_rate_limit_triggered",
  abuse_duplicate_call_detected: "abuse_duplicate_call_detected",
  abuse_ring_flood_detected: "abuse_ring_flood_detected",
  abuse_group_invite_storm_detected: "abuse_group_invite_storm_detected",
  abuse_group_creation_rate_limit: "abuse_group_creation_rate_limit",
  abuse_blocked_user_call_attempt: "abuse_blocked_user_call_attempt",
  abuse_invalid_invite_signature: "abuse_invalid_invite_signature",
  abuse_replayed_invite_detected: "abuse_replayed_invite_detected",
  abuse_invalid_mutation_id: "abuse_invalid_mutation_id",
  abuse_protocol_version_rejected: "abuse_protocol_version_rejected",
  abuse_turn_credential_failure: "abuse_turn_credential_failure",

  // --- 8B.12 Geo / placement dataset (drives Jitsi/SFU placement) ---
  server_geo_snapshot: "server_geo_snapshot",
  client_sfu_latency_snapshot: "client_sfu_latency_snapshot",
  geo_route_decision: "geo_route_decision",
} as const;

export type CallEventName = (typeof CallEvent)[keyof typeof CallEvent];

// ---------------------------------------------------------------------------
// Emitter — mirrors the ava_search_telemetry.ts / event_bus.ts sink pattern.
// ---------------------------------------------------------------------------

/**
 * Best-effort emit of a call-telemetry event. NEVER throws, NEVER blocks the
 * caller's request path — always run this off-path (fire-and-forget, or via
 * `ctx.waitUntil` when a request `ExecutionContext` is available).
 *
 * Mirrors the two existing sink patterns in this codebase:
 *   - event_bus.ts: forwards a `{ event, uid, ts, props }`-shaped message to
 *     the Q_ANALYTICS queue so it lands in the same PostHog project.
 *   - ava_search_telemetry.ts: stamps `email`/`phone` for the test-user
 *     account so support can pull telemetry by contact, and also writes an
 *     Analytics Engine data point via `metric()` for cheap aggregate counters.
 *
 * `props` should be a `CallEventEnvelope` (or a subset) — this function fills
 * in `event_time_ms` / `schema_version` when the caller omits them and does
 * NOT otherwise validate the envelope (producers are responsible for using
 * the enum types above rather than free-form strings, per §8B.3).
 */
export async function emitCallEvent(
  env: Env,
  event: CallEventName,
  props: CallEventEnvelope,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<void> {
  const send = (async () => {
    try {
      const envelope: CallEventEnvelope = {
        event_time_ms: Date.now(),
        schema_version: CALL_TELEMETRY_SCHEMA_VERSION,
        ...props,
      };

      const uid =
        (envelope.account_id as string | undefined) ??
        (envelope.device_id as string | undefined) ??
        "";

      // TODO verify sink: mirrors event_bus.ts's Q_ANALYTICS forwarding shape
      // (event/uid/ts/props) rather than inventing a new queue message shape.
      // If a dedicated call-telemetry queue/topic is introduced later, swap
      // the target here — producers calling emitCallEvent() need no changes.
      const analytics = (env as unknown as { Q_ANALYTICS?: { send(m: unknown): Promise<void> } })
        .Q_ANALYTICS;
      if (analytics) {
        await analytics.send({
          event,
          uid,
          ts: envelope.event_time_ms,
          props: envelope,
        });
      }
    } catch {
      /* best-effort; telemetry must never break the call path */
    }

    try {
      // Cheap aggregate counter alongside the rich PostHog event, same as
      // ava_search_telemetry.ts's metric() call for capacity/latency series.
      const { metric } = await import("../hooks");
      metric(env, "call_telemetry", [1], [event]);
    } catch {
      /* best-effort */
    }
  })();

  if (ctx?.waitUntil) {
    ctx.waitUntil(send);
  } else {
    await send.catch(() => { /* best-effort; never throw to the caller */ });
  }
}
