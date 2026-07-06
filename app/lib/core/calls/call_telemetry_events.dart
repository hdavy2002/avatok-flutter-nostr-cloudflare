/// Shared call-telemetry contract (Specs/CALL-CONTROL-PLANE-UNIFIED-PLAN.md §8B).
///
/// This is the Flutter-side mirror of the backend's `call_telemetry_events.ts`
/// (worker), so client and server emit byte-identical event names and enum
/// wire values into PostHog (`Analytics.capture(event, props)` —
/// see `app/lib/core/analytics.dart`).
///
/// **Phase A — behavior-neutral.** Nothing in this file is wired into any call
/// site yet: it is constants only. Future work migrates call sites (dial,
/// CallRoom, GroupCall/SFU, receptionist, push, authority RPCs) to reference
/// these instead of ad-hoc string literals, per §8B.1 naming standard
/// (`lowercase snake_case`, `<domain>_<action>`, unit-suffixed properties).
///
/// See §8B.2 for the base event envelope (`event_time_ms, schema_version,
/// call_trace_id, account_id, protocol_version, …`) and §8B.3 for the global
/// enums mirrored below as Dart enums with a `.wire` snake_case getter.
library;

/// Telemetry/protocol schema versions stamped on every event per §8B.2 /
/// §8B.18. Bump only in lock-step with the backend contract.
const int kCallProtocolVersion = 1;
const int kCallTelemetrySchemaVersion = 1;

/// All PostHog event names for the call-control-plane telemetry contract
/// (§8B.4–§8B.12). Grouped by domain; every name is the literal snake_case
/// string emitted to PostHog — do not alter without a matching backend change
/// (§8B.18: never reuse a name with different semantics).
abstract class CallEvents {
  // ---- authority (control plane) — §8B.4 ----
  static const String authorityAcquireCall = 'authority_acquire_call';
  static const String authorityQueryBusy = 'authority_query_busy';
  static const String authorityStateTransition = 'authority_state_transition';
  static const String authorityTransitionRejected = 'authority_transition_rejected';
  static const String authorityEpochConflict = 'authority_epoch_conflict';
  static const String authorityPreemptCallback = 'authority_preempt_callback';
  static const String authorityCallbackReservationCreated = 'authority_callback_reservation_created';
  static const String authorityCallbackReservationExpired = 'authority_callback_reservation_expired';
  static const String authorityCallbackReservationConsumed = 'authority_callback_reservation_consumed';
  static const String authorityReceptionistAbandonRequested = 'authority_receptionist_abandon_requested';
  static const String authorityReleaseCall = 'authority_release_call';
  static const String authorityLeaseRenewed = 'authority_lease_renewed';
  static const String authorityLeaseExpired = 'authority_lease_expired';
  static const String authorityRecoveredAfterWake = 'authority_recovered_after_wake';
  static const String authorityCallroomReconciliation = 'authority_callroom_reconciliation';
  static const String authoritySplitBrainDetected = 'authority_split_brain_detected';
  static const String authorityRpcStarted = 'authority_rpc_started';
  static const String authorityRpcCompleted = 'authority_rpc_completed';
  static const String authorityRpcFailed = 'authority_rpc_failed';
  static const String authorityShadowDecision = 'authority_shadow_decision';
  static const String authorityShadowDivergence = 'authority_shadow_divergence';
  static const String authorityDuplicateMutation = 'authority_duplicate_mutation';
  static const String authorityOwnerChanged = 'authority_owner_changed';
  static const String authorityProtocolFallback = 'authority_protocol_fallback';

  // ---- receptionist — §8B.5 ----
  static const String receptionistSessionStarted = 'receptionist_session_started';
  static const String receptionistSessionConnected = 'receptionist_session_connected';
  static const String receptionistSttStarted = 'receptionist_stt_started';
  static const String receptionistSttStopped = 'receptionist_stt_stopped';
  static const String receptionistLlmStarted = 'receptionist_llm_started';
  static const String receptionistLlmCompleted = 'receptionist_llm_completed';
  static const String receptionistSessionEnded = 'receptionist_session_ended';
  static const String receptionistAbandonRequested = 'receptionist_abandon_requested';
  static const String receptionistAbandonReceived = 'receptionist_abandon_received';
  static const String receptionistAbandonCompleted = 'receptionist_abandon_completed';
  static const String receptionistPreemptRequested = 'receptionist_preempt_requested';
  static const String receptionistPreemptCompleted = 'receptionist_preempt_completed';
  static const String receptionistPreemptFailed = 'receptionist_preempt_failed';
  static const String receptionistVoicemailGenerated = 'receptionist_voicemail_generated';
  static const String receptionistVoicemailSuppressed = 'receptionist_voicemail_suppressed';
  static const String receptionistSummaryGenerated = 'receptionist_summary_generated';
  static const String receptionistSummarySuppressed = 'receptionist_summary_suppressed';
  static const String receptionistDeliveryStarted = 'receptionist_delivery_started';
  static const String receptionistDeliveryCompleted = 'receptionist_delivery_completed';
  static const String receptionistDeliveryFailed = 'receptionist_delivery_failed';
  static const String receptionistAudioUploaded = 'receptionist_audio_uploaded';
  static const String receptionistAudioDeleted = 'receptionist_audio_deleted';
  static const String receptionistCallbackPreemptFunnel = 'receptionist_callback_preempt_funnel';
  static const String receptionistFalseDelivery = 'receptionist_false_delivery';

  // ---- busy — §8B.6 ----
  static const String busyDecision = 'busy_decision';
  static const String busyShown = 'busy_shown';
  static const String busyToneStarted = 'busy_tone_started';
  static const String busyToneCompleted = 'busy_tone_completed';
  static const String busyRedirectReceptionist = 'busy_redirect_receptionist';
  static const String busyTerminalScreenShown = 'busy_terminal_screen_shown';
  static const String busyTerminalScreenClosed = 'busy_terminal_screen_closed';
  static const String busyFalsePositive = 'busy_false_positive';
  static const String busyFalseNegative = 'busy_false_negative';
  static const String busyShadowMatch = 'busy_shadow_match';
  static const String busyShadowMismatch = 'busy_shadow_mismatch';
  static const String busyIgnoredDuplicate = 'busy_ignored_duplicate';
  static const String busyOverrideByAuthority = 'busy_override_by_authority';
  static const String busyRetryAfterTimeout = 'busy_retry_after_timeout';
  static const String busyRateLimited = 'busy_rate_limited';

  // ---- call / CallRoom (P2P setup funnel) — §8B.7 ----
  static const String callDialStarted = 'call_dial_started';
  static const String callRequestSent = 'call_request_sent';
  static const String callRequestReceived = 'call_request_received';
  static const String callIncomingShown = 'call_incoming_shown';
  static const String callRingStarted = 'call_ring_started';
  static const String callRingStopped = 'call_ring_stopped';
  static const String callAnswered = 'call_answered';
  static const String callDeclined = 'call_declined';
  static const String callCancelled = 'call_cancelled';
  static const String callConnectStarted = 'call_connect_started';
  static const String callConnected = 'call_connected';
  static const String callEnded = 'call_ended';

  static const String callroomDuplicateSessionDetected = 'callroom_duplicate_session_detected';
  static const String callroomDuplicateSessionBlocked = 'callroom_duplicate_session_blocked';
  static const String callroomDuplicateSessionAdopted = 'callroom_duplicate_session_adopted';
  static const String callroomStateReconciled = 'callroom_state_reconciled';

  // ---- rtc (WebRTC internals + quality + operational) — §8B.7, §8B.10 ----
  static const String rtcOfferCreated = 'rtc_offer_created';
  static const String rtcAnswerCreated = 'rtc_answer_created';
  static const String rtcOfferSent = 'rtc_offer_sent';
  static const String rtcAnswerSent = 'rtc_answer_sent';
  static const String rtcIceGatheringStarted = 'rtc_ice_gathering_started';
  static const String rtcIceGatheringCompleted = 'rtc_ice_gathering_completed';
  static const String rtcIceConnectionStateChanged = 'rtc_ice_connection_state_changed';
  static const String rtcDtlsStateChanged = 'rtc_dtls_state_changed';
  static const String rtcSelectedCandidatePair = 'rtc_selected_candidate_pair';
  static const String rtcTurnRelayUsed = 'rtc_turn_relay_used';
  static const String rtcDirectP2pEstablished = 'rtc_direct_p2p_established';
  static const String rtcReconnectStarted = 'rtc_reconnect_started';
  static const String rtcReconnectCompleted = 'rtc_reconnect_completed';
  static const String rtcReconnectFailed = 'rtc_reconnect_failed';
  static const String rtcTrackAdded = 'rtc_track_added';

  static const String rtcQualityTick = 'rtc_quality_tick';
  static const String rtcQualitySummary = 'rtc_quality_summary';

  static const String rtcNetworkChanged = 'rtc_network_changed';
  static const String rtcBandwidthEstimateChanged = 'rtc_bandwidth_estimate_changed';
  static const String rtcActiveSpeakerChanged = 'rtc_active_speaker_changed';
  static const String rtcTrackMuted = 'rtc_track_muted';
  static const String rtcTrackUnmuted = 'rtc_track_unmuted';
  static const String rtcCameraEnabled = 'rtc_camera_enabled';
  static const String rtcCameraDisabled = 'rtc_camera_disabled';
  static const String rtcMicrophoneEnabled = 'rtc_microphone_enabled';
  static const String rtcMicrophoneDisabled = 'rtc_microphone_disabled';
  static const String rtcError = 'rtc_error';
  static const String rtcProviderWarning = 'rtc_provider_warning';
  static const String rtcProviderRecovered = 'rtc_provider_recovered';
  static const String rtcMediaPermissionDenied = 'rtc_media_permission_denied';
  static const String rtcDeviceChanged = 'rtc_device_changed';
  static const String rtcCodecNegotiated = 'rtc_codec_negotiated';
  static const String rtcCodecChanged = 'rtc_codec_changed';

  // ---- push — §8B.8 ----
  static const String pushSent = 'push_sent';
  static const String pushSendFailed = 'push_send_failed';
  static const String pushReceived = 'push_received';
  static const String pushOpened = 'push_opened';
  static const String pushProcessed = 'push_processed';
  static const String pushProcessingFailed = 'push_processing_failed';
  static const String pushDuplicateReceived = 'push_duplicate_received';
  static const String pushOutOfOrder = 'push_out_of_order';
  static const String pushIgnoredStaleEpoch = 'push_ignored_stale_epoch';
  static const String pushAuthorityQueryStarted = 'push_authority_query_started';
  static const String pushAuthorityQueryCompleted = 'push_authority_query_completed';
  static const String pushAuthorityQueryFailed = 'push_authority_query_failed';
  static const String pushRoutedToReceptionist = 'push_routed_to_receptionist';
  static const String pushCallbackPreemptReceived = 'push_callback_preempt_received';
  static const String pushNotificationDisplayed = 'push_notification_displayed';
  static const String pushNotificationTapped = 'push_notification_tapped';
  static const String pushExpired = 'push_expired';
  static const String pushDeliveryTimeout = 'push_delivery_timeout';
  static const String pushRetryScheduled = 'push_retry_scheduled';

  // ---- groupcall / SFU — §8B.9 ----
  static const String groupcallEscalateStarted = 'groupcall_escalate_started';
  static const String groupcallEscalateCompleted = 'groupcall_escalate_completed';
  static const String groupcallEscalateFailed = 'groupcall_escalate_failed';
  static const String groupcallMigrationPrepareCompleted = 'groupcall_migration_prepare_completed';
  static const String groupcallSfuRoomCreated = 'groupcall_sfu_room_created';
  static const String groupcallSfuRoomCreationFailed = 'groupcall_sfu_room_creation_failed';
  static const String groupcallJoinStarted = 'groupcall_join_started';
  static const String groupcallJoinCompleted = 'groupcall_join_completed';
  static const String groupcallJoinFailed = 'groupcall_join_failed';
  static const String groupcallLeave = 'groupcall_leave';
  static const String groupcallMigrateTimeout = 'groupcall_migrate_timeout';
  static const String groupcallMigrateRollbackStarted = 'groupcall_migrate_rollback_started';
  static const String groupcallMigrateRollbackCompleted = 'groupcall_migrate_rollback_completed';
  static const String sfuAudioConfirmed = 'sfu_audio_confirmed';
  static const String groupcallReadyToSwitch = 'groupcall_ready_to_switch';
  static const String groupcallSwitchCommitted = 'groupcall_switch_committed';
  static const String groupcallReleaseP2p = 'groupcall_release_p2p';

  static const String groupcallInviteCreated = 'groupcall_invite_created';
  static const String groupcallInviteSent = 'groupcall_invite_sent';
  static const String groupcallInviteReceived = 'groupcall_invite_received';
  static const String groupcallInviteAccepted = 'groupcall_invite_accepted';
  static const String groupcallInviteDeclined = 'groupcall_invite_declined';
  static const String groupcallInviteExpired = 'groupcall_invite_expired';

  static const String groupcallMembershipCasConflict = 'groupcall_membership_cas_conflict';
  static const String groupcallFullRejected = 'groupcall_full_rejected';
  static const String groupcallDegradeWarningShown = 'groupcall_degrade_warning_shown';
  static const String groupcallDegradeWarningConfirmed = 'groupcall_degrade_warning_confirmed';
  static const String groupcallDegradeWarningCancelled = 'groupcall_degrade_warning_cancelled';
  static const String groupcallModeDegraded = 'groupcall_mode_degraded';
  static const String groupcallAudioLockEnforced = 'groupcall_audio_lock_enforced';
  static const String groupcallVideoPublishRejected = 'groupcall_video_publish_rejected';
  static const String groupcallRosterUpdated = 'groupcall_roster_updated';
  static const String groupcallProviderCapacityRejected = 'groupcall_provider_capacity_rejected';

  // ---- abuse / rate-limit — §8B.11 ----
  static const String abuseCallRateLimitTriggered = 'abuse_call_rate_limit_triggered';
  static const String abuseInviteRateLimitTriggered = 'abuse_invite_rate_limit_triggered';
  static const String abuseReceptionistRateLimitTriggered = 'abuse_receptionist_rate_limit_triggered';
  static const String abuseCallbackRateLimitTriggered = 'abuse_callback_rate_limit_triggered';
  static const String abuseDuplicateCallDetected = 'abuse_duplicate_call_detected';
  static const String abuseRingFloodDetected = 'abuse_ring_flood_detected';
  static const String abuseGroupInviteStormDetected = 'abuse_group_invite_storm_detected';
  static const String abuseGroupCreationRateLimit = 'abuse_group_creation_rate_limit';
  static const String abuseBlockedUserCallAttempt = 'abuse_blocked_user_call_attempt';
  static const String abuseInvalidInviteSignature = 'abuse_invalid_invite_signature';
  static const String abuseReplayedInviteDetected = 'abuse_replayed_invite_detected';
  static const String abuseInvalidMutationId = 'abuse_invalid_mutation_id';
  static const String abuseProtocolVersionRejected = 'abuse_protocol_version_rejected';
  static const String abuseTurnCredentialFailure = 'abuse_turn_credential_failure';

  // ---- geo / placement — §8B.12 ----
  static const String serverGeoSnapshot = 'server_geo_snapshot';
  static const String clientSfuLatencySnapshot = 'client_sfu_latency_snapshot';
  static const String geoRouteDecision = 'geo_route_decision';
}

/// §8B.3 `busy_reason` — never send free-form strings for this property.
enum BusyReason {
  activeCall,
  receptionist,
  callbackReserved,
  groupFull,
  migration,
  ringingOtherDevice,
  accountSwitch,
  deviceHandoff,
  rateLimited,
  blocked,
  doNotDisturb,
  providerFailure,
  unknown,
}

extension BusyReasonWire on BusyReason {
  String get wire => const {
        BusyReason.activeCall: 'active_call',
        BusyReason.receptionist: 'receptionist',
        BusyReason.callbackReserved: 'callback_reserved',
        BusyReason.groupFull: 'group_full',
        BusyReason.migration: 'migration',
        BusyReason.ringingOtherDevice: 'ringing_other_device',
        BusyReason.accountSwitch: 'account_switch',
        BusyReason.deviceHandoff: 'device_handoff',
        BusyReason.rateLimited: 'rate_limited',
        BusyReason.blocked: 'blocked',
        BusyReason.doNotDisturb: 'do_not_disturb',
        BusyReason.providerFailure: 'provider_failure',
        BusyReason.unknown: 'unknown',
      }[this]!;
}

/// §8B.3 `authority_phase`.
enum AuthorityPhase {
  idle,
  incomingRinging,
  outgoingRinging,
  connecting,
  connected,
  receptionistActive,
  callbackReserved,
  migrating,
  releasing,
}

extension AuthorityPhaseWire on AuthorityPhase {
  String get wire => const {
        AuthorityPhase.idle: 'idle',
        AuthorityPhase.incomingRinging: 'incoming_ringing',
        AuthorityPhase.outgoingRinging: 'outgoing_ringing',
        AuthorityPhase.connecting: 'connecting',
        AuthorityPhase.connected: 'connected',
        AuthorityPhase.receptionistActive: 'receptionist_active',
        AuthorityPhase.callbackReserved: 'callback_reserved',
        AuthorityPhase.migrating: 'migrating',
        AuthorityPhase.releasing: 'releasing',
      }[this]!;
}

/// §8B.3 `ended_reason`.
enum EndedReason {
  completed,
  declined,
  busy,
  missed,
  cancelled,
  timeout,
  network,
  iceFailure,
  providerFailure,
  rtcError,
  migrationFailed,
  preempted,
  duplicateSession,
  authorityRejected,
  abandoned,
  voicemail,
  rateLimited,
  unknown,
}

extension EndedReasonWire on EndedReason {
  String get wire => const {
        EndedReason.completed: 'completed',
        EndedReason.declined: 'declined',
        EndedReason.busy: 'busy',
        EndedReason.missed: 'missed',
        EndedReason.cancelled: 'cancelled',
        EndedReason.timeout: 'timeout',
        EndedReason.network: 'network',
        EndedReason.iceFailure: 'ice_failure',
        EndedReason.providerFailure: 'provider_failure',
        EndedReason.rtcError: 'rtc_error',
        EndedReason.migrationFailed: 'migration_failed',
        EndedReason.preempted: 'preempted',
        EndedReason.duplicateSession: 'duplicate_session',
        EndedReason.authorityRejected: 'authority_rejected',
        EndedReason.abandoned: 'abandoned',
        EndedReason.voicemail: 'voicemail',
        EndedReason.rateLimited: 'rate_limited',
        EndedReason.unknown: 'unknown',
      }[this]!;
}

/// §8B.3 `rtc_error_stage`.
enum RtcErrorStage {
  token,
  authorityRpc,
  callroomRpc,
  groupcallRpc,
  websocket,
  push,
  ice,
  dtls,
  publish,
  subscribe,
  renegotiation,
  turn,
  relay,
  track,
  codec,
  provider,
  network,
  permission,
  timeout,
  unknown,
}

extension RtcErrorStageWire on RtcErrorStage {
  String get wire => const {
        RtcErrorStage.token: 'token',
        RtcErrorStage.authorityRpc: 'authority_rpc',
        RtcErrorStage.callroomRpc: 'callroom_rpc',
        RtcErrorStage.groupcallRpc: 'groupcall_rpc',
        RtcErrorStage.websocket: 'websocket',
        RtcErrorStage.push: 'push',
        RtcErrorStage.ice: 'ice',
        RtcErrorStage.dtls: 'dtls',
        RtcErrorStage.publish: 'publish',
        RtcErrorStage.subscribe: 'subscribe',
        RtcErrorStage.renegotiation: 'renegotiation',
        RtcErrorStage.turn: 'turn',
        RtcErrorStage.relay: 'relay',
        RtcErrorStage.track: 'track',
        RtcErrorStage.codec: 'codec',
        RtcErrorStage.provider: 'provider',
        RtcErrorStage.network: 'network',
        RtcErrorStage.permission: 'permission',
        RtcErrorStage.timeout: 'timeout',
        RtcErrorStage.unknown: 'unknown',
      }[this]!;
}

/// §8B.3 `rtc_provider`.
enum RtcProvider { cloudflare, jitsi, livekit, mock, unknown }

extension RtcProviderWire on RtcProvider {
  String get wire => const {
        RtcProvider.cloudflare: 'cloudflare',
        RtcProvider.jitsi: 'jitsi',
        RtcProvider.livekit: 'livekit',
        RtcProvider.mock: 'mock',
        RtcProvider.unknown: 'unknown',
      }[this]!;
}

/// §8B.3 `rtc_mode`.
enum RtcMode { p2p, sfu }

extension RtcModeWire on RtcMode {
  String get wire => const {
        RtcMode.p2p: 'p2p',
        RtcMode.sfu: 'sfu',
      }[this]!;
}

/// §8B.3 `media_mode`.
enum MediaMode { audio, video, audioLocked }

extension MediaModeWire on MediaMode {
  String get wire => const {
        MediaMode.audio: 'audio',
        MediaMode.video: 'video',
        MediaMode.audioLocked: 'audio_locked',
      }[this]!;
}

/// §8B.3 `authority_decision`.
enum AuthorityDecision { allow, busy, preempt, redirectReceptionist, reject, retry, conflict }

extension AuthorityDecisionWire on AuthorityDecision {
  String get wire => const {
        AuthorityDecision.allow: 'allow',
        AuthorityDecision.busy: 'busy',
        AuthorityDecision.preempt: 'preempt',
        AuthorityDecision.redirectReceptionist: 'redirect_receptionist',
        AuthorityDecision.reject: 'reject',
        AuthorityDecision.retry: 'retry',
        AuthorityDecision.conflict: 'conflict',
      }[this]!;
}
