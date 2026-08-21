// [ADDCALL-2-UI 2026-08-06] The PEER's half of make-before-break, plus the
// router that gets `addcall*` frames to whichever half is running.
//
// Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` §4.2 — *"the callee is already on
// a live 1:1 signalling socket; pass the new gid over that socket before
// teardown rather than ringing them."*
//
// ─────────────────────────────────────────────────────────────────────────────
//  THE ORDERING THAT MATTERS: THE PEER IS IN THE CONFERENCE FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
//   adder                                   peer (this file)
//   ─────                                   ────────────────
//   /start, then  ──── `addcall` ─────────►  build conference on ITS OWN live
//   builds its own conference in parallel    capture stream, verify inbound audio
//                 ◄─── `addcall-ack` ─────   "I am in and I can hear it"
//   reserve/prepare/commit
//                 ──── `addcall-go` ──────►  hand the mic to the conference,
//   hand the mic over, drop the 1:1,          drop the 1:1, show the group call
//   /migration/release
//
// The peer does NOT tear down on `addcall-ack`. It acks and waits. That is the
// difference between a rollback that returns both people to a working 1:1 and
// one that returns only the adder — if the peer released its leg on ack and the
// adder then failed to commit, the peer would be sitting alone in a conference
// with a call it can no longer get back.
//
// Conversely the ADDER does not tear down until the ack arrives, because the
// peer must be in the conference before the 1:1 goes away or the peer gets
// silence. Both halves wait for the other; neither can strand the other.
//
// If the peer is on a build that predates this feature, its signalling switch
// has no case for `addcall` (there is no `default:` branch) and the frame is a
// silent no-op. No ack ever arrives, the adder times out, and both people stay
// on the 1:1 they already had. That is the correct behaviour for an un-upgraded
// peer and it needs no version negotiation.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/call_recording/call_recording_store.dart'; // [ADDCALL-4-UI]
import '../../core/calls/call_escalation_guard.dart';
import '../../core/calls/call_session.dart';
import '../../core/calls/call_telemetry_events.dart';
import '../../core/remote_config.dart';
import '../../push/push_service.dart' show navigatorKey;
import 'cloudflare_conference_controller.dart';
import 'cloudflare_conference_screen.dart';
import 'conference_migration_coordinator.dart';

class CallEscalationService {
  CallEscalationService._();
  static final CallEscalationService instance = CallEscalationService._();

  /// Build budget for the peer's own conference leg. Matches the adder's.
  static const Duration kBuildBudget = ConferenceMigrationCoordinator.kBuildBudget;

  /// How long the peer waits for inbound audio before refusing to ack.
  static const Duration kEvidenceBudget = Duration(seconds: 12);

  /// How long the peer holds the overlap open waiting for `addcall-go`.
  /// Comfortably longer than the adder's reserve→commit budget (8s) so a slow
  /// but successful commit is not abandoned one second before it lands.
  static const Duration kGoBudget = Duration(seconds: 20);

  /// In-flight ADDER migrations, keyed by 1:1 call id, so `addcall-ack` and a
  /// peer-side `addcall-abort` reach the coordinator that is waiting for them.
  final Map<String, ConferenceMigrationCoordinator> _adders = {};

  /// In-flight PEER responses, keyed by 1:1 call id.
  final Map<String, _PeerEscalation> _peers = {};

  bool _installed = false;

  /// Wire the signalling hook. Idempotent; called once from `main()`.
  ///
  /// It has to be installed at boot rather than by the call screen because the
  /// `addcall` frame can arrive while the call is MINIMIZED, with no widget
  /// listening to anything.
  void install() {
    if (_installed) return;
    _installed = true;
    CallSession.escalationFrameHandler = (session, frame) {
      unawaited(instance._onFrame(session, frame));
    };
  }

  void registerAdder(String callId, ConferenceMigrationCoordinator c) => _adders[callId] = c;

  void unregisterAdder(String callId, ConferenceMigrationCoordinator c) {
    if (identical(_adders[callId], c)) _adders.remove(callId);
  }

  // ---------------------------------------------------------------------------
  //  Routing
  // ---------------------------------------------------------------------------

  Future<void> _onFrame(CallSession session, Map<String, dynamic> d) async {
    final type = d['type']?.toString() ?? '';
    final callId = session.config.room;
    switch (type) {
      case 'addcall-ack':
        _adders[callId]?.onPeerFrame(d);
        return;
      case 'addcall-abort':
        // Either side can send this. Give it to whichever half is live here.
        _adders[callId]?.onPeerFrame(d);
        _peers[callId]?.onAbort((d['reason'] ?? 'peer_aborted').toString());
        return;
      case 'addcall-go':
        _peers[callId]?.onGo();
        return;
      case 'addcall':
        await _onAddcall(session, d);
        return;
    }
  }

  // ---------------------------------------------------------------------------
  //  The peer's half
  // ---------------------------------------------------------------------------

  Future<void> _onAddcall(CallSession session, Map<String, dynamic> d) async {
    final callId = session.config.room;
    final gid = (d['gid'] ?? '').toString();
    final escalationId = (d['escalation_id'] ?? 'addcall:$callId').toString();

    void nack(String reason) {
      session.sendEscalationFrame({
        'type': 'addcall-ack', 'ok': false, 'reason': reason, 'gid': gid,
      });
      Analytics.capture(CallEvents.groupcallEscalateFailed, {
        'escalation_id': escalationId, 'call_id': callId,
        'stage': 'peer_join', 'reason': reason, 'role': 'peer', 'phase': 2,
      });
    }

    Analytics.capture(CallEvents.groupcallInviteReceived, {
      'escalation_id': escalationId,
      'call_id': callId,
      'gid_hash': gid.hashCode.toString(),
      'via': 'call_socket',
    });

    if (gid.isEmpty) { nack('no_gid'); return; }
    if (_peers.containsKey(callId)) { nack('already_escalating'); return; }
    // The kill switch has to be honoured on BOTH devices. A peer whose config
    // says the feature is off must not be dragged into a conference by an adder
    // whose config says it is on.
    if (!RemoteConfig.addToCallEnabled) { nack('disabled'); return; }
    // [STREAM-GATE-1 2026-08-21] …and the GROUP-CALL kill switches, which this
    // gate was missing. An escalation builds a `CloudflareConferenceController`
    // — a Cloudflare Realtime conference — so it is a group-call ENTRY POINT and
    // must obey the same switches as the chat-thread call icons
    // (`chat_thread/calls.dart:_confAllowed`). Without this, turning
    // `conferenceEnabled` off darkened the header buttons but left this door
    // open: an adder could still pull this device out of a working 1:1 and into
    // a conference the Worker will then refuse (`routes/groupcall.ts` gates every
    // endpoint on conferenceEnabled && cloudflareConferenceEnabled), costing the
    // peer their call for a screen that can never connect.
    // Owner decision 2026-08-21: group calls go dark now; group MESSAGING is
    // untouched by this — nothing here is on any messaging path.
    if (!RemoteConfig.conferenceEnabled || !RemoteConfig.cloudflareConferenceEnabled) {
      nack('conference_disabled');
      return;
    }
    if (session.isEnded) { nack('call_ended'); return; }

    // Resolve the navigator BEFORE building anything. Without one there is
    // nowhere to put the conference, and we would release a working 1:1 for a
    // screen that can never appear — the same "lost their call for nothing"
    // outcome Phase 1 ordered itself around.
    final nav = navigatorKey.currentState;
    if (nav == null) { nack('no_navigator'); return; }

    // Checked here so we refuse before taking the lease; `run` re-reads it,
    // because the only safe read of a borrowed stream is the one taken at the
    // moment it is used.
    if (session.borrowedLocalCaptureStream == null) {
      nack('no_capture_stream');
      return;
    }

    final lease = CallEscalationGuard.acquire(
      escalationId: escalationId, callId: callId, gid: gid,
    );
    if (lease == null) { nack('guard_busy'); return; }

    final peer = _PeerEscalation(
      session: session, gid: gid, escalationId: escalationId, lease: lease,
    );
    _peers[callId] = peer;
    try {
      await peer.run(
        nav: nav,
        video: d['video'] == true,
        names: ((d['names'] as List?) ?? const []).map((e) => e.toString()).toList(),
      );
    } catch (e, st) {
      Analytics.captureException(e, st,
          handled: true,
          screen: 'call_escalation_peer',
          extra: {'escalation_id': escalationId, 'call_id': callId});
      await peer.abandon('peer_exception');
    } finally {
      _peers.remove(callId);
      CallEscalationGuard.release(lease, outcome: peer.outcome);
    }
  }
}

/// One peer-side response to an `addcall`. Owns the conference it builds and is
/// the only thing that may release the peer's 1:1 leg.
class _PeerEscalation {
  _PeerEscalation({
    required this.session,
    required this.gid,
    required this.escalationId,
    required this.lease,
  });

  final CallSession session;
  final String gid;
  final String escalationId;
  final CallEscalationLease lease;

  CloudflareConferenceController? _conf;
  bool _go = false;
  String? _abortReason;
  String outcome = 'unknown';

  void onGo() {
    _go = true;
  }

  void onAbort(String reason) {
    _abortReason = reason;
  }

  Future<void> run({
    required NavigatorState nav,
    required bool video,
    required List<String> names,
  }) async {
    final stream = session.borrowedLocalCaptureStream;
    if (stream == null) {
      outcome = 'no_capture_stream';
      _nack('no_capture_stream');
      return;
    }

    final title = _title(names);
    // `starter: false` — the ADDER minted the room and writes the outgoing
    // call-history row. Two starters would write two rows for one call.
    // `initialSpeakerOn` carries this call's CURRENT route across rather than
    // jumping an earpiece conversation onto loudspeaker mid-sentence.
    final c = CloudflareConferenceController(
      gid: gid,
      title: title,
      wantVideo: video,
      starter: false,
      sharedLocalStream: stream,
      initialSpeakerOn: session.speakerOn.value,
    );
    _conf = c;

    try {
      await c.connect().timeout(CallEscalationService.kBuildBudget);
    } on TimeoutException {
      outcome = 'build_timeout';
      await abandon('build_timeout');
      return;
    }
    if (_abortReason != null) {
      outcome = 'aborted_by_adder';
      await abandon(_abortReason!);
      return;
    }
    if (c.state != CfConnState.connected) {
      outcome = 'not_connected';
      await abandon(c.permissionDenied ? 'permission_denied' : 'conference_not_connected');
      return;
    }

    // Inbound audio before acking. An ack is what authorises the adder to drop
    // the only working leg, so it must mean "I can hear this call", not "my
    // socket opened".
    final heard = await _await(
      CallEscalationService.kEvidenceBudget,
      () => c.hasMediaEvidence,
    );
    if (_abortReason != null) {
      outcome = 'aborted_by_adder';
      await abandon(_abortReason!);
      return;
    }
    if (!heard) {
      outcome = 'no_media_evidence';
      await abandon('no_media_evidence');
      return;
    }

    session.sendEscalationFrame({'type': 'addcall-ack', 'ok': true, 'gid': gid});
    Analytics.capture(CallEvents.groupcallInviteAccepted, {
      'escalation_id': escalationId,
      'call_id': session.config.room,
      'gid_hash': gid.hashCode.toString(),
      'role': 'peer',
    });

    // Hold the overlap open until the adder commits. Do NOT release the 1:1
    // here — see the ordering note at the top of this file.
    await _await(CallEscalationService.kGoBudget, () => _go || _abortReason != null);
    // Order matters only for the honesty of the reason we record: an explicit
    // abort, a call that died underneath us, and a silent timeout are three
    // different bugs and must not collapse into one.
    if (_abortReason != null) {
      outcome = _abortReason!;
      await abandon(outcome);
      return;
    }
    if (session.isEnded) {
      // The 1:1 died while we waited (a network drop, or the adder's `bye`
      // overtaking its own `go`). The conference is carrying tracks that
      // teardown has already stopped, so there is nothing to salvage.
      outcome = 'call_ended_before_go';
      await abandon(outcome);
      return;
    }
    if (!_go) {
      outcome = 'go_timeout';
      await abandon(outcome);
      return;
    }

    // ── Commit locally. Ownership of the microphone changes hands FIRST, so
    //    that whatever ends the 1:1 next — our own hangup, or the adder's `bye`
    //    racing it — cannot stop the tracks the conference is publishing.
    session.loanCaptureStream(() => c.ownsSharedLocalStream);
    c.assumeSharedLocalStreamOwnership();

    // [ADDCALL-4-UI] The PEER can be the one recording, so the attribution fix
    // has to live on both halves of the escalation, not just the adder's. A
    // no-op unless this device has a recording in flight for this call.
    // Spec §7 / §11 item 4.
    CallRecordingStore.I.markEscalatedToGroup(
      callId: session.config.room, gid: gid, groupLabel: title,
    );

    // Pop the call screen if one is attached, and clear `minimized` so the
    // floating call pill does not outlive the call it points at.
    try {
      final pop = session.onRequestPop;
      session.onRequestPop = null;
      pop?.call();
    } catch (_) {}
    try { session.minimized.value = false; } catch (_) {}

    // `hangup` rather than `endByUser`: this is not the user hanging up, and
    // `endByUser` would send a `bye` that reads to the adder as the peer
    // leaving. The adder is releasing its own leg at the same moment.
    try {
      await session.hangup('escalated-to-group');
    } catch (e, st) {
      Analytics.captureException(e, st,
          handled: true, screen: 'call_escalation_peer',
          extra: {'stage': 'peer_hangup', 'escalation_id': escalationId});
    }

    nav.push(MaterialPageRoute(
      builder: (_) => CloudflareConferenceScreen(
        gid: gid, title: title, video: video, starter: false, adopt: c,
      ),
    ));

    _conf = null; // the screen owns it now
    outcome = 'committed';
    Analytics.capture(CallEvents.groupcallEscalateCompleted, {
      'escalation_id': escalationId,
      'call_id': session.config.room,
      'gid_hash': gid.hashCode.toString(),
      'role': 'peer',
      'phase': 2,
    });
  }

  /// Undo the peer's half and stay on the 1:1. Never throws; idempotent enough
  /// to be called from `run`'s catch and its early returns alike.
  Future<void> abandon(String reason) async {
    final c = _conf;
    _conf = null;
    _nack(reason);
    if (c != null) {
      // Give the capture stream back BEFORE leaving — `leave()` stops and
      // disposes the local stream when it owns it, and that stream is the
      // microphone of the 1:1 that is still running.
      try { c.releaseSharedLocalStreamOwnership(); } catch (_) {}
      try { await c.leave(reason: 'escalation_rollback'); } catch (_) {}
      try { c.dispose(); } catch (_) {}
      // The conference took over the device's single native audio session and
      // `leave()` has just ended it. Put the 1:1's back or the call survives
      // with no communication mode and no route — alive and silent.
      try { await session.reassertAudioSession(); } catch (_) {}
    }
    try { session.endCaptureStreamLoan(); } catch (_) {}
    AvaLog.I.log('addcall', 'peer escalation abandoned: $reason');
  }

  void _nack(String reason) {
    try {
      session.sendEscalationFrame({
        'type': 'addcall-ack', 'ok': false, 'reason': reason, 'gid': gid,
      });
    } catch (_) {}
    Analytics.capture(CallEvents.groupcallEscalateFailed, {
      'escalation_id': escalationId,
      'call_id': session.config.room,
      'gid_hash': gid.hashCode.toString(),
      'stage': 'peer_join',
      'reason': reason,
      'role': 'peer',
      'phase': 2,
    });
  }

  Future<bool> _await(Duration budget, bool Function() done) async {
    final sw = Stopwatch()..start();
    while (sw.elapsed < budget) {
      if (done()) return true;
      if (session.isEnded) return false;
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    return done();
  }

  String _title(List<String> names) {
    final all = <String>[
      if (session.config.title.trim().isNotEmpty) session.config.title.trim(),
      ...names.map((n) => n.trim()).where((n) => n.isNotEmpty),
    ];
    if (all.isEmpty) return 'Group call';
    if (all.length == 1) return all.first;
    final head = all.take(3).toList();
    final extra = all.length - head.length;
    final base = '${head.sublist(0, head.length - 1).join(', ')} & ${head.last}';
    return extra > 0 ? '$base +$extra' : base;
  }
}
