// [ADDCALL-2-UI 2026-08-06] Make-before-break: the ADDER's half of the seamless
// 1:1 -> group migration.
//
// Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` §4 (the migration) and §10
// (telemetry). Server: `worker/src/routes/conference_room.ts` +
// `worker/src/do/conference_room.ts` (`[ADDCALL-2-SRV]`).
//
// ─────────────────────────────────────────────────────────────────────────────
//  THE ORDER OF OPERATIONS IS THE WHOLE FEATURE. READ THIS BEFORE CHANGING IT.
// ─────────────────────────────────────────────────────────────────────────────
//
// The spec's §4.1 sequence is reserve -> prepare -> build the conference ->
// verify -> commit. This implementation runs the SAME state machine but builds
// and verifies the conference BEFORE taking the reservation, for one concrete
// reason: `ConferenceRoomDO`'s single-flight lock auto-aborts after
// `MIGRATION_PREPARE_TIMEOUT_MS = 10_000` (do/conference_room.ts:130), and a
// conference build is not reliably a 10-second operation. It is /join, a
// WebSocket upgrade, an awaited `welcome`, a publish, a renegotiation, the peer
// doing all of the same on their own device, and finally an inbound-RTP stats
// sample — because `hasMediaEvidence` is evidence of the PEER's audio arriving,
// not of our own publish succeeding.
//
// Reserving first would therefore have made the lock expire underneath a
// migration that was going perfectly well, and the user would have seen "we
// couldn't add anyone" on a call where everything worked. Reserving last means
// reserve -> prepare -> commit are three fast HTTP calls inside about a second,
// which is what that 10s budget was sized for.
//
// The single-flight guarantee is NOT weakened by this, because the race is
// arbitrated one step earlier and more cheaply: `/start` is addressed by the
// **1:1 call id**, so both parties pressing Add land on the same durable
// object, and the second one is refused with 409 `group_mismatch` BEFORE it
// builds anything (do/conference_room.ts:332). `/migration/reserve` remains the
// guard on the commit itself. Two locks, both used, neither on the critical
// path of a 10-second media build.
//
// ─────────────────────────────────────────────────────────────────────────────
//  EVERY FAILURE RETURNS TO A WORKING 1:1. THAT IS THE ACCEPTANCE CRITERION.
// ─────────────────────────────────────────────────────────────────────────────
//
// This object NEVER touches the 1:1 leg. It does not hang up, it does not stop
// a track, it does not close a peer connection. It builds a second call
// alongside the first and reports whether that second call is good enough to
// switch to. The caller (`call_screen.dart`) owns the teardown and only
// performs it after [run] has returned `ok`. So a failure here — at any step —
// leaves the user on exactly the call they were already on, and [rollback]
// exists to undo only the things this object created.
//
// The one exception, and it is the reason [rollback] is not simply
// `conference.leave()`: the conference has by then taken over the device's one
// native audio session, and `leave()` ends it. The caller must re-assert the
// 1:1's session afterwards (`CallSession.reassertAudioSession`) or the call
// survives with no communication mode and no route. [rollback]'s contract says
// so; do not "simplify" it back to a bare leave.
import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/calls/call_telemetry_events.dart';
import 'cloudflare_conference_api.dart';
import 'cloudflare_conference_controller.dart';

enum ConferenceMigrationPhase {
  idle,
  started,
  building,
  verifying,
  reserved,
  prepared,
  committed,
  released,
  aborted,
}

/// The result of one escalation attempt. [message] is a finished sentence for a
/// human — never a raw server string, never JSON (CLAUDE.md's honesty rule).
class ConferenceMigrationOutcome {
  const ConferenceMigrationOutcome({
    required this.ok,
    required this.stage,
    this.reason = '',
    this.message = '',
    this.retryAfterMs,
  });

  final bool ok;

  /// Which step it got to. Matches the server's `stage` prop so the client and
  /// worker halves of the funnel line up on one `escalation_id`.
  final String stage;

  /// Machine-readable cause, for telemetry only.
  final String reason;

  /// What to say to the user. Empty on success.
  final String message;

  /// Set when a reserve lost the single flight — the server's own back-off.
  final int? retryAfterMs;
}

class ConferenceMigrationCoordinator {
  ConferenceMigrationCoordinator({
    required this.roomId,
    required this.groupId,
    required this.escalationId,
    required this.video,
    required this.sharedLocalStream,
    required this.controllerFactory,
    required this.sendToPeer,
    this.inviteeNames = const [],
  });

  /// The **1:1 call id**. `ConferenceRoomDO` is addressed by this, not by the
  /// group id — that is what makes both parties of the call land on the same
  /// durable object (routes/conference_room.ts, addressing note).
  final String roomId;

  /// The ad-hoc `kind='call'` conversation id — the gid the conference joins.
  final String groupId;

  /// `addcall:<call_id>`, byte-identical to the Worker's `escalationIdFor`.
  final String escalationId;

  final bool video;
  final MediaStream sharedLocalStream;
  final CloudflareConferenceController Function(MediaStream stream) controllerFactory;

  /// Sends one frame down the live 1:1 signalling socket (spec §4.2).
  final void Function(Map<String, dynamic> frame) sendToPeer;

  /// Display names of the people being added, so the peer can title its own
  /// conference screen. The adder's own title would read back to the peer as
  /// their own name.
  final List<String> inviteeNames;

  // ---- budgets ---------------------------------------------------------------
  //
  // All three are CLIENT-side deadlines that fire BEFORE the corresponding
  // server-side one, so the user gets our sentence rather than a 409 three
  // steps downstream (spec §4.3: the coordinator had "no client-side
  // abort-on-timeout" at all; the DO self-aborts at 10s).

  /// Building the conference: /join + WS + welcome + publish.
  static const Duration kBuildBudget = Duration(seconds: 20);

  /// Waiting for our own inbound audio AND the peer's ack. These collapse into
  /// one wait because they have the same dependency — the peer being in the
  /// conference and publishing.
  static const Duration kReadyBudget = Duration(seconds: 15);

  /// reserve -> prepare -> commit. Deliberately under the DO's 10s so we abort
  /// first and can name the stage.
  static const Duration kCommitBudget = Duration(seconds: 8);

  ConferenceMigrationPhase phase = ConferenceMigrationPhase.idle;
  String? migrationId;
  String? generation;
  CloudflareConferenceController? conference;

  /// Milliseconds the device ran two publishers and two audio sessions. Filled
  /// by [release]; -1 until then.
  int overlapMs = -1;

  bool _peerAcked = false;
  String? _peerNack;
  bool _closed = false;

  // ---------------------------------------------------------------------------
  //  Peer frames
  // ---------------------------------------------------------------------------

  /// Called by `CallEscalationService` for `addcall-ack` / `addcall-abort`
  /// frames arriving on the 1:1 socket while this migration is in flight.
  void onPeerFrame(Map<String, dynamic> d) {
    final t = d['type']?.toString() ?? '';
    if (t == 'addcall-ack') {
      if (d['ok'] == true) {
        _peerAcked = true;
      } else {
        _peerNack = (d['reason'] ?? 'peer_declined').toString();
      }
    } else if (t == 'addcall-abort') {
      _peerNack = (d['reason'] ?? 'peer_aborted').toString();
    }
  }

  void _announceToPeer() {
    sendToPeer(<String, dynamic>{
      'type': 'addcall',
      'gid': groupId,
      'video': video,
      'escalation_id': escalationId,
      'names': inviteeNames,
    });
    Analytics.capture(CallEvents.groupcallInviteSent, {
      'escalation_id': escalationId,
      'call_id': roomId,
      'gid_hash': groupId.hashCode.toString(),
      'via': 'call_socket',
    });
  }

  // ---------------------------------------------------------------------------
  //  The state machine
  // ---------------------------------------------------------------------------

  /// Runs start -> announce -> build -> verify -> reserve -> prepare -> commit.
  ///
  /// On `ok`, [conference] is connected, carrying [sharedLocalStream], with
  /// confirmed inbound audio, and the server has committed. The caller may then
  /// transfer stream ownership, tear down the 1:1 and call [release].
  ///
  /// On failure the caller must call [rollback] (this method does NOT roll back
  /// itself, because the caller has to interleave the audio-session restore).
  Future<ConferenceMigrationOutcome> run() async {
    if (phase != ConferenceMigrationPhase.idle) {
      return const ConferenceMigrationOutcome(
        ok: false, stage: 'preflight', reason: 'coordinator_reused',
        message: "We couldn't set up the group call. Please try again.",
      );
    }
    try {
      // ── 1. /start. Gap #1 from spec §4.3: nothing has ever called this, and
      //    without it every `migration/reserve` 403s because `requireMember`
      //    searches an empty participant array.
      final started = await ConferenceRoomApi.start(
        roomId,
        groupId: groupId,
        mediaKind: video ? 'audio_video' : 'audio',
      );
      generation = started['generation']?.toString();
      phase = ConferenceMigrationPhase.started;

      // ── 2. Hand the gid to the other original party NOW, before we build our
      //    own leg, so both devices build in parallel. Ours cannot reach
      //    `hasMediaEvidence` until theirs is publishing anyway (evidence is
      //    inbound RTP), so announcing late would serialise two 5-second builds
      //    into one 10-second one.
      _announceToPeer();

      // ── 3. Build the conference on the mic that is already open.
      phase = ConferenceMigrationPhase.building;
      final c = controllerFactory(sharedLocalStream);
      conference = c;
      try {
        await c.connect().timeout(kBuildBudget);
      } on TimeoutException {
        return _fail('build', 'build_timeout',
            "The group call didn't connect in time, so you're still on your original call.");
      }
      if (c.state != CfConnState.connected) {
        // `connect()` swallows its own failures into `state`/`statusText`
        // rather than throwing, so this is the normal failure path, not the
        // exceptional one.
        return _fail(
          'build',
          c.permissionDenied ? 'permission_denied' : 'conference_not_connected',
          c.permissionDenied
              ? 'AvaTOK needs microphone access to start a group call.'
              : "The group call didn't connect, so you're still on your original call.",
        );
      }

      // ── 4. Verify: OUR media, and the peer actually in the room. Spec §4.1
      //    step 6 is the client half of the evidence gate the DO enforces at
      //    commit — `sfu_ready:true` is a claim, and this is what makes it true.
      phase = ConferenceMigrationPhase.verifying;
      final ready = await _awaitReady(c);
      if (!ready.ok) return ready;

      Analytics.capture(CallEvents.groupcallReadyToSwitch, {
        'escalation_id': escalationId,
        'call_id': roomId,
        'gid_hash': groupId.hashCode.toString(),
        'peer_acked': _peerAcked,
      });
      Analytics.capture(CallEvents.sfuAudioConfirmed, {
        'escalation_id': escalationId,
        'call_id': roomId,
        'gid_hash': groupId.hashCode.toString(),
      });

      // ── 5-7. reserve -> prepare -> commit, all inside kCommitBudget.
      return await _commitPhase(c).timeout(
        kCommitBudget,
        onTimeout: () => _fail('commit', 'commit_budget_exceeded',
            "We couldn't finish moving the call, so you're still on your original call."),
      );
    } on CloudflareConferenceException catch (e) {
      return _fromServerError(phase.name, e);
    } catch (e, st) {
      Analytics.captureException(e, st,
          handled: true,
          screen: 'conference_migration',
          extra: {'escalation_id': escalationId, 'stage': phase.name});
      return _fail(phase.name, 'exception',
          "We couldn't set up the group call, so you're still on your original call.");
    }
  }

  Future<ConferenceMigrationOutcome> _commitPhase(CloudflareConferenceController c) async {
    // 5. reserve — the single flight for the commit.
    final r = await ConferenceRoomApi.reserveMigration(roomId);
    migrationId = r['migration_id']?.toString();
    if (migrationId == null || migrationId!.isEmpty) {
      return _fail('reserve', 'no_migration_id',
          "We couldn't set up the group call, so you're still on your original call.");
    }
    // ECHO the server's generation. Deriving it from the 1:1's call epoch is
    // the mistake this whole comment chain exists to prevent — they are
    // different counters and the failure lands at `prepare` as `stale_epoch`.
    generation = (r['generation'] ?? generation)?.toString();
    phase = ConferenceMigrationPhase.reserved;

    // 6. prepare.
    await ConferenceRoomApi.prepareMigration(
      roomId,
      migrationId: migrationId!,
      callEpoch: generation ?? '',
    );
    phase = ConferenceMigrationPhase.prepared;
    Analytics.capture(CallEvents.groupcallMigrationPrepareCompleted, {
      'escalation_id': escalationId,
      'call_id': roomId,
      'gid_hash': groupId.hashCode.toString(),
      'generation': generation ?? '',
    });

    // 7. Re-verify immediately before committing. Two round trips have passed
    //    since step 4 and the conference could have dropped in that window;
    //    committing on stale evidence is the one failure that authorises the
    //    NEXT step — releasing the 1:1 — and produces a call with no audio.
    if (c.state != CfConnState.connected || !c.hasMediaEvidence) {
      return _fail('verify', 'evidence_lost_before_commit',
          "The group call dropped before we could switch, so you're still on your original call.");
    }
    if (_peerNack != null) {
      return _fail('verify', _peerNack!,
          "We couldn't move the other person to the group call, so you're still on your original call.");
    }

    await ConferenceRoomApi.commitMigration(roomId, migrationId: migrationId!, sfuReady: true);
    phase = ConferenceMigrationPhase.committed;
    Analytics.capture(CallEvents.groupcallSwitchCommitted, {
      'escalation_id': escalationId,
      'call_id': roomId,
      'gid_hash': groupId.hashCode.toString(),
      'generation': generation ?? '',
    });
    return const ConferenceMigrationOutcome(ok: true, stage: 'commit');
  }

  /// Poll until the conference has inbound audio AND the peer has acked, or the
  /// budget runs out. Reports WHICH of the two was missing — they fail for very
  /// different reasons and a single "timeout" would hide that.
  Future<ConferenceMigrationOutcome> _awaitReady(CloudflareConferenceController c) async {
    final sw = Stopwatch()..start();
    while (sw.elapsed < kReadyBudget) {
      if (_closed) {
        return _fail('verify', 'cancelled',
            "We couldn't set up the group call, so you're still on your original call.");
      }
      if (_peerNack != null) {
        return _fail('verify', _peerNack!,
            "We couldn't move the other person to the group call, so you're still on your original call.");
      }
      if (c.state == CfConnState.failed || c.state == CfConnState.ended) {
        return _fail('verify', 'conference_dropped',
            "The group call dropped, so you're still on your original call.");
      }
      if (_peerAcked && c.hasMediaEvidence) {
        return const ConferenceMigrationOutcome(ok: true, stage: 'verify');
      }
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    // Which half was missing? `!_peerAcked` almost always means the other
    // device is on a build that predates add-to-call and has no handler for the
    // `addcall` frame — a case worth naming rather than calling a timeout.
    final reason = !_peerAcked
        ? (c.hasMediaEvidence ? 'peer_never_acked' : 'peer_never_joined')
        : 'no_media_evidence';
    return _fail(
      'verify',
      reason,
      _peerAcked
          ? "We couldn't hear the group call, so you're still on your original call."
          : "We couldn't move the other person to the group call, so you're still on your original "
              'call. They may need to update AvaTOK.',
    );
  }

  ConferenceMigrationOutcome _fail(String stage, String reason, String message, {int? retryAfterMs}) {
    AvaLog.I.log('addcall', 'migration failed at $stage: $reason');
    Analytics.capture(CallEvents.groupcallEscalateFailed, {
      'escalation_id': escalationId,
      'call_id': roomId,
      'gid_hash': groupId.hashCode.toString(),
      'stage': stage,
      'reason': reason,
      'phase': 2,
      'peer_acked': _peerAcked,
    });
    return ConferenceMigrationOutcome(
      ok: false, stage: stage, reason: reason, message: message, retryAfterMs: retryAfterMs,
    );
  }

  /// Turn one of the DO's refusals into a sentence. The three that a user can
  /// actually hit are named; everything else gets the honest generic.
  ConferenceMigrationOutcome _fromServerError(String stage, CloudflareConferenceException e) {
    final raw = e.message.toLowerCase();
    if (e.status == 409 && raw.contains('already in progress')) {
      // Either the peer pressed Add at the same instant (`group_mismatch` at
      // /start) or beat us to the reservation (`single_flight`). Same sentence:
      // somebody else is already doing this to this call.
      return _fail(stage, 'single_flight',
          'The other person is already adding someone to this call.');
    }
    if (e.status == 409 && raw.contains('stale call epoch')) {
      return _fail(stage, 'stale_epoch',
          "We couldn't set up the group call, so you're still on your original call.");
    }
    if (e.status == 403) {
      return _fail(stage, 'not_a_participant',
          "You're not in that call any more.");
    }
    if (e.status == 503) {
      return _fail(stage, 'conference_room_unavailable',
          "We couldn't reach the call service, so you're still on your original call.");
    }
    return _fail(stage, 'http_${e.status}',
        "We couldn't set up the group call, so you're still on your original call.");
  }

  // ---------------------------------------------------------------------------
  //  Terminal transitions
  // ---------------------------------------------------------------------------

  /// Spec §4.1 step 8. Call ONLY after [run] returned ok, the capture stream has
  /// changed hands, and the 1:1 leg is actually down. Never throws.
  Future<int> release() async {
    try {
      final j = await ConferenceRoomApi.releaseMigration(roomId);
      overlapMs = (j['overlap_ms'] as num?)?.toInt() ?? -1;
      phase = ConferenceMigrationPhase.released;
    } catch (e) {
      // The escalation has already succeeded on this device by the time we get
      // here — the group call is up and the 1:1 is gone. A failed release is a
      // bookkeeping loss, not a call failure, and must never be surfaced as one.
      AvaLog.I.log('addcall', 'release failed (call is fine): $e');
    }
    Analytics.capture(CallEvents.groupcallReleaseP2p, {
      'escalation_id': escalationId,
      'call_id': roomId,
      'gid_hash': groupId.hashCode.toString(),
      'overlap_ms': overlapMs,
      'phase': 2,
    });
    return overlapMs;
  }

  /// Undo everything this object created, in the order that cannot strand the
  /// 1:1 call.
  ///
  /// **The caller must call `CallSession.reassertAudioSession()` afterwards.**
  /// `conference.leave()` ends the device's single native audio session, which
  /// the conference took over when it came up; without the re-assert the 1:1
  /// survives with no communication mode, no focus and no route — i.e. a call
  /// that is technically alive and completely silent.
  ///
  /// Idempotent. Never throws.
  Future<void> rollback(String reason) async {
    if (_closed) return;
    _closed = true;
    // Capture BEFORE overwriting: whether we ever reached the server at all
    // decides whether an abort is meaningful or just a guaranteed 403.
    final priorPhase = phase;
    phase = ConferenceMigrationPhase.aborted;
    Analytics.capture(CallEvents.groupcallMigrateRollbackStarted, {
      'escalation_id': escalationId,
      'call_id': roomId,
      'reason': reason,
    });

    // 1. Tell the peer first — it may be sitting in a conference of its own
    //    waiting for a `go` that is never coming, and the sooner it stops the
    //    shorter its own pointless overlap.
    try {
      sendToPeer(<String, dynamic>{
        'type': 'addcall-abort',
        'gid': groupId,
        'escalation_id': escalationId,
        'reason': reason,
      });
    } catch (_) {}

    // 2. Release the server lock. Idempotent server-side, and deliberately
    //    tolerant of a null migration id: the DO auto-aborts a stuck prepare
    //    and NULLS the id, and an abort that matches nothing is a no-op success
    //    there (do/conference_room.ts abortMigration).
    if (priorPhase != ConferenceMigrationPhase.idle) {
      try {
        await ConferenceRoomApi.abortMigration(roomId, migrationId: migrationId, reason: reason);
      } catch (_) {/* best effort — the lock also expires on its own at 10s */}
    }

    // 3. Give the capture stream back BEFORE leaving. `leave()` stops and
    //    disposes the local stream when it owns it, and that stream is the
    //    still-live 1:1's microphone. Getting this line wrong turns a
    //    recoverable failed escalation into a dead call.
    final c = conference;
    conference = null;
    if (c != null) {
      try { c.releaseSharedLocalStreamOwnership(); } catch (_) {}
      try { await c.leave(reason: 'escalation_rollback'); } catch (_) {}
      try { c.dispose(); } catch (_) {}
    }

    Analytics.capture(CallEvents.groupcallMigrateRollbackCompleted, {
      'escalation_id': escalationId,
      'call_id': roomId,
      'reason': reason,
    });
  }

  /// Called once the conference has been handed to a screen and this object is
  /// out of the loop, so a late peer frame cannot roll back a committed call.
  void detach() => _closed = true;
}
