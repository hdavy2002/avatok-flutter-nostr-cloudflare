// STREAM-LANE: Ava receptionist surface for the Stream call lane.
//
// [STREAM-RECEPTIONIST-1 2026-08-24] Reported the same day: calling a phone
// that was off rang forever on this lane and never reached Ava. The four-ring
// handoff lives in the legacy CallRoom DO, which counts the CALLEE's
// device-ringing receipts — a dead phone sends none, so nothing ever counted
// and nothing ever fired. The Stream lane does not create a CallRoom at all, so
// it had no ring accounting whatsoever.
//
// This screen is the client half of the bridge. It exists because
// `ReceptionistCall` turned out to be lane-agnostic: given a callee uid it
// mints its own session through `/api/receptionist/start` (whose `call_id` is
// OPTIONAL — every CALL_ROOMS interaction inside it is guarded), opens its own
// WebSocket and owns its own audio. It needs nothing from the legacy lane, so
// nothing here imports features/avatok/call_screen.dart — the two lanes must
// stay independent, exactly as stream_call_screen.dart's header says.
//
// Visual language deliberately mirrors stream_call_screen.dart (AD.* tokens,
// PhosphorIcons control row) rather than the old lane's `_ReceptionistDuo`.
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../core/analytics.dart';
import '../core/ava_identity.dart';
import '../core/avatar.dart';
import '../core/calls/call_audio_controller.dart';
import '../core/peer_identity_cache.dart';
import '../core/profile_store.dart';
import '../core/receptionist_api.dart';
import '../core/receptionist_call.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
import '../core/voice/native_voice_audio.dart' show CallAudioRoute;
import '../main.dart' show RootFlow;

/// What the Ava surface is showing. Deliberately separate from
/// `stream_call_screen.dart`'s `_Phase`: this screen never has a Stream call,
/// so `reconnecting`/`live` there mean media states that cannot occur here.
enum _AvaPhase { connecting, live, wrapup, failed }

/// Hands a Stream-lane caller to the callee's Ava receptionist.
///
/// Mounted by [StreamCallService.showAva] in two situations, both of which have
/// already ENDED any Stream call before arriving here:
///  * the Worker refused the dial with `code: 'receptionist'` because presence
///    proved the callee is not checking in (`activationMode: 'unreachable'`);
///  * the caller's own ring window elapsed unanswered (`'rings'`).
class StreamAvaScreen extends StatefulWidget {
  const StreamAvaScreen({
    super.key,
    required this.peerId,
    required this.activationMode,
    this.peerName,
    this.peerAvatarUrl,
    this.peerEmail,
    this.myName,
    this.myAvatarUrl,
    this.traceId,
    this.callId,
  });

  /// The callee whose receptionist this is — Ava answers on THEIR behalf, and
  /// their settings and wallet are what gate the session.
  final String peerId;

  /// `'rings'` (rang, nobody picked up) or `'unreachable'` (phone off / not
  /// checking in). These are two INDEPENDENT owner toggles server-side
  /// (`recept_avatok_not_picked_up` / `recept_avatok_unreachable`), so the value
  /// must be honest — sending `'rings'` for an off phone would consult the wrong
  /// switch. Passed straight through to `/api/receptionist/start`.
  final String activationMode;

  final String? peerName;
  final String? peerAvatarUrl;
  final String? peerEmail;

  /// The caller's own name/photo, for the "you ↔ Ava" pair.
  final String? myName;
  final String? myAvatarUrl;

  final String? traceId;

  /// The Stream call id this handoff came from, when there was one. Carried for
  /// telemetry correlation only — a `'rings'` handoff has one, an `'unreachable'`
  /// refusal never created a Stream call and so has none.
  final String? callId;

  @override
  State<StreamAvaScreen> createState() => _StreamAvaScreenState();
}

class _StreamAvaScreenState extends State<StreamAvaScreen> {
  ReceptionistCall? _recept;
  _AvaPhase _phase = _AvaPhase.connecting;
  String _failReason = '';
  // Deliberately NO mute control here. `ReceptionistCall` has no mute verb —
  // the mic feeds Ava directly — and a button that silently did nothing is
  // worse than its absence.
  //
  // [STREAM-AVA-AUDIO-1 2026-08-24] Starts TRUE. Ava is a message being read to
  // you, not a person you hold the phone to your ear for — and the caller has
  // just been told nobody answered, so the phone is likely already away from
  // their face. See [_audioOwnerId] for why the default alone was not enough.
  bool _speakerOn = true;
  bool _popped = false;
  final int _startedAtMs = DateTime.now().millisecondsSinceEpoch;

  /// [STREAM-AVA-COPY-1 2026-08-24] Who the callee is, in their own pronoun.
  /// Starts from the durable on-device cache so the first frame is already
  /// right, then is refreshed from the receptionist config probe.
  PeerIdentity _peer = const PeerIdentity();

  /// [STREAM-AVA-COPY-1 2026-08-24] The caller's own name and photo.
  ///
  /// The screen rendered a bare "?" circle because both call sites push it
  /// WITHOUT `myName`/`myAvatarUrl` — nothing in the Stream lane carries the
  /// signed-in user's own profile, so `Avatar` fell through to its no-initials
  /// placeholder. Read it here instead of adding two more parameters that every
  /// future call site would have to remember to pass.
  String _myName = '';
  String _myAvatarUrl = '';

  /// [STREAM-AVA-AUDIO-1 2026-08-24] The id this screen owns audio under in
  /// [CallAudioController].
  ///
  /// Reported 2026-08-24: "Ava finally picked up, but her voice was very low,
  /// even with the speaker on." She was on the EARPIECE, and the speaker button
  /// could not get her off it.
  ///
  /// `CallAudioController` is the single owner of the live route
  /// ([CALL-AUDIO-OWNER-1]) and its `intent` defaults to
  /// `CallAudioRoute.earpiece`. Only `call_session.dart` — the LEGACY lane —
  /// ever calls `seed()`, so on the Stream lane the intent was never set and
  /// still read `earpiece`. `ReceptionistCall.start()` then calls
  /// `reassert('recept_prewarm_before')` and `reassert('recept_prewarm_after')`
  /// around the native engine's `startEngine`, and `_applyInternal` applies
  /// `intent` whether or not a call has been seeded — so both reasserts actively
  /// pulled Ava onto the earpiece and pinned her there.
  ///
  /// `ReceptionistCall.setSpeaker` writes only the native engine and never the
  /// controller, so tapping Speaker fought the owner instead of instructing it,
  /// which is exactly why the button appeared to do nothing. Seeding the
  /// controller here makes those two reasserts work FOR us, and routes the
  /// toggle through the owner as [CALL-AUDIO-OWNER-1] requires.
  String get _audioOwnerId => 'ava:${widget.peerId}:$_startedAtMs';

  @override
  void initState() {
    super.initState();
    // Seed both identities from local state FIRST, so the first painted frame
    // already says the right name and pronoun rather than correcting itself a
    // moment later. Neither await blocks the Ava session below.
    // ignore: discarded_futures
    _resolveIdentities();
    // ignore: discarded_futures
    _start();
  }

  /// [STREAM-AVA-COPY-1 2026-08-24] Three tiers, cheapest first: the durable
  /// per-account on-device cache, then whatever the caller's route already knew
  /// (`widget.peerName`), then the server probe — which
  /// `ReceptionistApi.configFor` has usually already cached in memory for this
  /// contact, so it normally costs no round trip at all.
  Future<void> _resolveIdentities() async {
    final cached = await PeerIdentityCache.instance.load(widget.peerId);
    if (!mounted) return;
    if (!cached.isEmpty) setState(() => _peer = cached);

    try {
      final me = await ProfileStore().load();
      if (mounted && (me.displayName.isNotEmpty || me.avatarUrl.isNotEmpty)) {
        setState(() {
          _myName = widget.myName?.trim().isNotEmpty == true
              ? widget.myName!.trim()
              : me.displayName;
          _myAvatarUrl = widget.myAvatarUrl?.trim().isNotEmpty == true
              ? widget.myAvatarUrl!.trim()
              : me.avatarUrl;
        });
      }
    } catch (_) {/* the call must not depend on reading our own profile */}

    try {
      final cfg = await ReceptionistApi.configFor(widget.peerId);
      if (cfg == null || !mounted) return;
      // `mergedWith` keeps anything the probe left blank — an owner who has not
      // set a gender must not erase a name we already had, and vice versa.
      final fresh = PeerIdentity.fromConfig(cfg).mergedWith(cached);
      if (fresh.isEmpty) return;
      setState(() => _peer = fresh);
      await PeerIdentityCache.instance.save(widget.peerId, fresh);
      Analytics.capture('stream_lane_ava_peer_identity', {
        ..._base('peer_resolved'),
        'from_cache': !cached.isEmpty,
        'has_first_name': fresh.firstName.isNotEmpty,
        // The VALUE that decides the sentence. `false` here on a build where
        // the owner has set a gender means the field is not reaching the caller.
        'has_gender': fresh.gender.isNotEmpty,
      });
    } catch (_) {/* copy degrades to they/their, which is still true */}
  }

  /// What to CALL the callee in a sentence: their first name if we have it,
  /// then whatever the route passed, then a neutral noun. Never the raw uid.
  String get _peerFirstName {
    if (_peer.firstName.isNotEmpty) return _peer.firstName;
    final routed = (widget.peerName ?? '').trim();
    if (routed.isNotEmpty) return routed.split(RegExp(r'\s+')).first;
    return '';
  }

  String get _peerDisplayName {
    if (_peer.displayName.isNotEmpty) return _peer.displayName;
    return (widget.peerName ?? '').trim();
  }

  Map<String, Object> _base(String outcome) => <String, Object>{
        'peer_id': widget.peerId,
        'peer_email': widget.peerEmail ?? '',
        'activation_mode': widget.activationMode,
        'trace_id': widget.traceId ?? '',
        'call_id': widget.callId ?? '',
        'lane': 'streamlane',
        'outcome': outcome,
      };

  Future<void> _start() async {
    // [STREAM-AVA-AUDIO-1 2026-08-24] Take ownership of the route BEFORE
    // `ReceptionistCall.start()`, because its first act is a reassert that
    // applies whatever `intent` says. Seeding first turns that reassert from the
    // thing that pinned Ava to the earpiece into the thing that puts her on the
    // speaker. `apply` here is what actually writes the native route for a lane
    // that never had an owner; the reasserts inside `start()` then only have to
    // hold it.
    CallAudioController.instance.seed(
      callId: _audioOwnerId,
      route: _speakerOn ? CallAudioRoute.speaker : CallAudioRoute.earpiece,
    );
    final seeded = await CallAudioController.instance
        .apply(source: 'stream_ava_start')
        .catchError((_) => null);
    Analytics.capture('stream_lane_ava_audio_route', {
      ..._base('route_seeded'),
      'intent': _speakerOn ? 'speaker' : 'earpiece',
      'confirmed': CallAudioController.instance.confirmedRouteName,
      'usable': CallAudioController.instance.hasUsableConfirmedRoute,
      'applied': seeded != null,
    });
    final recept = ReceptionistCall(
      calleeUid: widget.peerId,
      // Deliberately NOT the Stream call id. `receptionistStart` treats a
      // `call_id` as a legacy CallRoom name and will try to claim that DO;
      // handing it an `sl-…` Stream id would make it look up a room that does
      // not exist. Omitting it is the supported shape (`if (callId)` guards).
      activationMode: widget.activationMode,
      // Matches the seeded intent, so the native engine's own `startEngine`
      // route write agrees with the owner instead of contradicting it.
      speaker: _speakerOn,
    );
    _recept = recept;
    // The owner re-asserts every collaborator that must agree with the route it
    // confirmed — for this screen that is Ava's `speaker` flag and the button.
    CallAudioController.instance.onRouteConfirmed = (speakerOn) {
      _recept?.speaker = speakerOn;
      if (mounted && speakerOn != _speakerOn) {
        setState(() => _speakerOn = speakerOn);
      }
    };
    recept.onStatus = (status) {
      if (!mounted) return;
      setState(() {
        switch (status) {
          case 'live':
          case 'connected':
          case 'reconnected':
            _phase = _AvaPhase.live;
          case 'wrapup':
            _phase = _AvaPhase.wrapup;
          case 'ended':
            break;
          default:
            // 'connecting' / 'reconnecting' — keep the connecting surface.
            break;
        }
      });
    };
    // ignore: discarded_futures
    recept.done.then((reason) {
      if (!mounted) return;
      Analytics.capture('stream_lane_ava_ended', {
        ..._base('ended'),
        'reason': reason,
        'duration_ms': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
      });
      _exit(source: 'ava_done', reason: reason);
    });

    Analytics.capture('stream_lane_ava_handoff', _base('started'));
    final ok = await recept.start();
    if (!mounted) return;
    if (!ok) {
      final reason = recept.failReason ?? 'unknown';
      setState(() {
        _phase = _AvaPhase.failed;
        _failReason = reason;
      });
      Analytics.capture('stream_lane_ava_failed', {
        ..._base('failed'),
        'reason': reason,
      });
      return;
    }
    Analytics.capture('stream_lane_ava_connected', {
      ..._base('connected'),
      'connect_ms': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
    });
  }

  Future<void> _hangUp() async {
    final recept = _recept;
    _recept = null;
    Analytics.capture('stream_lane_ava_hangup', {
      ..._base('caller_hangup'),
      'duration_ms': DateTime.now().millisecondsSinceEpoch - _startedAtMs,
    });
    if (recept != null && !recept.isEnded) {
      try {
        await recept.hangup();
      } catch (_) {/* leaving must never throw at the user */}
    }
    _exit(source: 'hangup_button');
  }

  /// [STREAM-AVA-AUDIO-1 2026-08-24] Goes through [CallAudioController] FIRST.
  ///
  /// `ReceptionistCall.setSpeaker` only writes the native engine, and while
  /// `callAudioOwnerV1` is on nothing but the owner may write the route — so a
  /// direct call raced the owner's reasserts and lost, which is what made the
  /// button look dead. `setIntent` before `apply` is the documented order: it
  /// means a fast double-tap always carries the latest intent.
  Future<void> _toggleSpeaker() async {
    final next = !_speakerOn;
    setState(() => _speakerOn = next);
    CallAudioController.instance
        .setIntent(next ? CallAudioRoute.speaker : CallAudioRoute.earpiece);
    try {
      final result = await CallAudioController.instance
          .apply(source: 'stream_ava_user_toggle');
      await _recept?.setSpeaker(next);
      Analytics.capture('stream_lane_ava_audio_route', {
        ..._base('user_toggle'),
        'intent': next ? 'speaker' : 'earpiece',
        'confirmed': CallAudioController.instance.confirmedRouteName,
        'usable': CallAudioController.instance.hasUsableConfirmedRoute,
        'applied': result != null,
      });
    } catch (_) {
      if (mounted) setState(() => _speakerOn = !next);
    }
  }

  void _exit({required String source, String? reason}) {
    if (_popped) return;
    _popped = true;
    Analytics.capture('stream_lane_ava_screen_exit', {
      ..._base('exit'),
      'source': source,
      'reason': reason ?? '',
      'phase': _phase.name,
    });
    final nav = Navigator.of(context);
    if (nav.canPop()) {
      nav.pop();
    } else {
      nav.pushReplacement(
        MaterialPageRoute<void>(builder: (_) => const RootFlow()),
      );
    }
  }

  @override
  void dispose() {
    // [STREAM-AVA-AUDIO-1] Hand the route back, or the next call in this app
    // session inherits an Ava-shaped speaker intent it never asked for. The
    // controller's own holder guard makes this a no-op if something else has
    // already seeded over us.
    CallAudioController.instance.onRouteConfirmed = null;
    CallAudioController.instance.release(_audioOwnerId);
    final recept = _recept;
    _recept = null;
    if (recept != null && !recept.isEnded) {
      // ignore: discarded_futures
      recept.hangup().catchError((_) {});
    }
    super.dispose();
  }

  /// [STREAM-AVA-COPY-1 2026-08-24] Says WHY you are talking to an assistant,
  /// using the callee's name and their own pronoun.
  ///
  /// The first cut read "Ava is picking up…" and then, once she HAD picked up,
  /// "They can't be reached — Ava is taking a message" — which the owner read as
  /// the call having failed at the exact moment it succeeded. The live line now
  /// states the situation in the past tense (the ringing is over) and names the
  /// assistant's owner, so the screen never contradicts what is happening.
  String get _statusLabel {
    final name = _peerFirstName;
    final poss = _peer.possessivePronoun; // her / his / their
    final who = name.isEmpty ? 'They' : name;
    switch (_phase) {
      case _AvaPhase.connecting:
        return name.isEmpty
            ? 'Connecting you to their assistant…'
            : "Connecting you to $name's assistant…";
      case _AvaPhase.live:
        // Two genuinely different facts, and the caller deserves the right one:
        // 'rings' means the phone rang and nobody answered; 'unreachable' means
        // it never rang because the phone is not reachable at all.
        return widget.activationMode == 'unreachable'
            ? "$who can't be reached right now, so you're talking to "
                '$poss assistant'
            : "$who didn't pick up, so you're talking to $poss assistant";
      case _AvaPhase.wrapup:
        return name.isEmpty
            ? 'Wrapping up — your message will be passed on'
            : 'Wrapping up — $name will get your message';
      case _AvaPhase.failed:
        return _failReasonCopy(_failReason);
    }
  }

  /// Honest, non-technical copy per server refusal reason. Anything unmapped
  /// stays generic rather than leaking a machine reason at the user.
  static String _failReasonCopy(String reason) {
    switch (reason) {
      case 'insufficient_tokens':
        return "Ava can't take this call right now.";
      case 'scenario_disabled':
        return "They don't have Ava answering unanswered calls.";
      case 'disabled':
        return 'Ava is unavailable right now.';
      case 'network':
        return "Couldn't reach Ava — check your connection.";
      default:
        return "Couldn't reach Ava — please try again.";
    }
  }

  @override
  Widget build(BuildContext context) {
    final peerName = _peerDisplayName;
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: Msg.s5),
            Text(
              peerName.isEmpty ? 'Ava' : "$peerName's Ava",
              style: const TextStyle(
                color: AD.textPrimary,
                fontSize: 20,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s5),
              child: Text(
                _statusLabel,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AD.textSecondary),
              ),
            ),
            const Spacer(),
            _AvaDuo(
              recept: _recept,
              connecting: _phase == _AvaPhase.connecting,
              myAvatarUrl: _myAvatarUrl,
              myName: _myName,
              avaLabel: _peerFirstName.isEmpty
                  ? 'Ava'
                  : "$_peerFirstName's Ava",
            ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.only(bottom: Msg.s6),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (_phase != _AvaPhase.failed) ...[
                    _controlButton(
                      icon: _speakerOn
                          ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                          : PhosphorIcons.speakerSlash(
                              PhosphorIconsStyle.bold),
                      onTap: _toggleSpeaker,
                      // [STREAM-AVA-AUDIO-1] Highlighted = speaker ON. The
                      // first cut highlighted speaker OFF (treating it as the
                      // notable state, mirroring mute), which read as "speaker
                      // is already on" and is part of why the reported "even
                      // with the speaker on" was ambiguous.
                      active: _speakerOn,
                    ),
                    const SizedBox(width: Msg.s5),
                  ],
                  _controlButton(
                    icon: PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.fill),
                    onTap: _hangUp,
                    danger: true,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Same treatment as stream_call_screen.dart's control row: indigo idle with a
  /// cream glyph, marigold when toggled, rani for hang-up. The two creams that
  /// used to be here were invisible against the page.
  Widget _controlButton({
    required PhosphorIconData icon,
    required VoidCallback onTap,
    bool danger = false,
    bool active = false,
  }) {
    final Color bg;
    final Color fg;
    if (danger) {
      bg = AD.primaryBadge;
      fg = AD.tabActiveLabel;
    } else if (active) {
      bg = AD.haldi;
      fg = AD.textPrimary;
    } else {
      bg = AD.tabCalls;
      fg = AD.tabActiveLabel;
    }
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
        child: Icon(icon, color: fg, size: 26),
      ),
    );
  }
}

/// The caller and Ava, side by side, with a live link between them.
///
/// [STREAM-AVA-UI-1 2026-08-24] Rebuilt from the first cut, which the owner
/// reported as three separate problems in one screenshot: the two faces were
/// tiny, Ava's was greyed out, and the animation that used to show both sides
/// communicating was gone.
///
///  * Size: 84px / r42 became [_avatarSize] 132. This is the focal point of the
///    screen — there is nothing else on it — so it is now sized like one.
///  * No more grey. The old `dimmed` flag dropped Ava to 45% opacity for the
///    whole `connecting` phase, which reads as "disabled", not "connecting".
///    Waiting is now expressed by the LINK animating on its own instead.
///  * The link ([_LinkFlow]) is the replacement for the legacy lane's
///    `_LinkPainter`: dots travelling between the two faces, toward whoever is
///    currently speaking, driven by the same `micLevel`/`avaLevel` notifiers.
///    While connecting they drift gently toward Ava, so the screen is alive
///    before the first word rather than frozen behind a curtain.
class _AvaDuo extends StatelessWidget {
  const _AvaDuo({
    required this.recept,
    required this.connecting,
    required this.avaLabel,
    this.myAvatarUrl,
    this.myName,
  });

  final ReceptionistCall? recept;
  final bool connecting;

  /// "Sonal's Ava" — whose assistant this is, not just "Ava".
  final String avaLabel;
  final String? myAvatarUrl;
  final String? myName;

  static const double _avatarSize = 132;

  @override
  Widget build(BuildContext context) {
    final r = recept;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Pulse(
          level: r?.micLevel,
          label: 'You',
          size: _avatarSize,
          child: Avatar(
            seed: 'me',
            name: myName ?? '',
            avatarUrl: myAvatarUrl,
            size: _avatarSize,
          ),
        ),
        _LinkFlow(
          mic: r?.micLevel,
          ava: r?.avaLevel,
          connecting: connecting,
          height: _avatarSize,
        ),
        _Pulse(
          level: r?.avaLevel,
          label: avaLabel,
          size: _avatarSize,
          child: Container(
            width: _avatarSize,
            height: _avatarSize,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: AD.tabCalls,
              image: DecorationImage(
                image: AssetImage(AvaId.avatarAsset),
                fit: BoxFit.cover,
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// One face, haloed in proportion to how loudly its owner is speaking.
class _Pulse extends StatelessWidget {
  const _Pulse({
    required this.child,
    required this.label,
    required this.size,
    this.level,
  });

  final Widget child;
  final String label;
  final double size;
  final ValueListenable<double>? level;
  static const double _labelWidth = 140;

  @override
  Widget build(BuildContext context) {
    final listenable = level;
    final face = SizedBox(width: size, height: size, child: child);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (listenable == null)
          face
        else
          ValueListenableBuilder<double>(
            valueListenable: listenable,
            builder: (context, v, child) {
              final t = v.isNaN ? 0.0 : v.clamp(0.0, 1.0);
              return Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(
                      color: AD.haldi.withValues(alpha: 0.55 * t),
                      blurRadius: 8 + 22 * t,
                      spreadRadius: 1 + 9 * t,
                    ),
                  ],
                ),
                child: child,
              );
            },
            child: face,
          ),
        const SizedBox(height: Msg.s3),
        SizedBox(
          width: _labelWidth,
          child: Text(
            label,
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: AD.textSecondary),
          ),
        ),
      ],
    );
  }
}

/// [STREAM-AVA-UI-1 2026-08-24] The living link between the two faces.
///
/// This is the replacement for the animation the owner missed — the legacy
/// lane's `_LinkPainter` (features/avatok/call_screen.dart), which this lane
/// deliberately does not import. Dots travel along the gap, and they travel
/// TOWARD whoever is currently speaking: driven right by Ava's level, left by
/// the caller's mic. When neither is speaking — and during `connecting`, before
/// there is any audio at all — they drift slowly toward Ava, so the screen shows
/// that something is happening instead of freezing.
///
/// Deliberately cheap: one 16.7ms ticker, six dots, no per-frame allocation
/// beyond the painter, and it repaints only while mounted. The old approach
/// (greying Ava out) needed no ticker but told the user the wrong thing.
class _LinkFlow extends StatefulWidget {
  const _LinkFlow({
    required this.mic,
    required this.ava,
    required this.connecting,
    required this.height,
  });

  final ValueListenable<double>? mic;
  final ValueListenable<double>? ava;
  final bool connecting;
  final double height;

  static const double width = 72;

  @override
  State<_LinkFlow> createState() => _LinkFlowState();
}

class _LinkFlowState extends State<_LinkFlow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 2),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mic = widget.mic;
    final ava = widget.ava;
    return SizedBox(
      width: _LinkFlow.width,
      height: widget.height,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          // Read the two levels at paint time. They are ValueNotifiers updated
          // by the audio engine on its own cadence, so sampling them here keeps
          // this to ONE animation clock rather than three rebuild sources.
          final micLevel = _read(mic);
          final avaLevel = _read(ava);
          return CustomPaint(
            painter: _LinkFlowPainter(
              phase: _c.value,
              micLevel: micLevel,
              avaLevel: avaLevel,
              connecting: widget.connecting,
            ),
          );
        },
      ),
    );
  }

  static double _read(ValueListenable<double>? v) {
    final raw = v?.value ?? 0.0;
    if (raw.isNaN) return 0.0;
    return raw.clamp(0.0, 1.0);
  }
}

class _LinkFlowPainter extends CustomPainter {
  _LinkFlowPainter({
    required this.phase,
    required this.micLevel,
    required this.avaLevel,
    required this.connecting,
  });

  /// 0..1, one full traversal per cycle.
  final double phase;
  final double micLevel;
  final double avaLevel;
  final bool connecting;

  static const int _dots = 6;

  @override
  void paint(Canvas canvas, Size size) {
    // This box is sized to the AVATAR's height (the labels sit below it, outside
    // this painter), so its own centre is the faces' centre.
    final y = size.height / 2;
    final loud = avaLevel > micLevel ? avaLevel : micLevel;

    // Direction: +1 toward Ava (right), -1 toward the caller (left). Whoever is
    // louder wins; silence (and connecting) drifts toward Ava.
    final towardAva = avaLevel >= micLevel;
    final dir = towardAva ? 1.0 : -1.0;
    final colour = towardAva ? AD.tabCalls : AD.haldi;

    // A quiet line the dots ride along, so the two faces always read as joined
    // even at total silence.
    final rail = Paint()
      ..color = AD.textSecondary.withValues(alpha: 0.18)
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(Offset(2, y), Offset(size.width - 2, y), rail);

    // Speed rises with volume; connecting has no audio so it gets a slow float.
    final speed = connecting ? 0.45 : 0.55 + 1.6 * loud;
    final travel = size.width - 8;
    final dot = Paint()..style = PaintingStyle.fill;

    for (var i = 0; i < _dots; i++) {
      // Evenly spaced along the cycle, wrapped into 0..1.
      var t = (phase * speed + i / _dots) % 1.0;
      if (dir < 0) t = 1.0 - t;
      final x = 4 + travel * t;
      // Fade in and out at the ends so dots appear to emerge from one face and
      // sink into the other rather than popping on at a hard edge.
      final edge = (t < 0.5 ? t : 1.0 - t) * 2.0; // 0 at ends, 1 at centre
      final alpha = (connecting ? 0.35 : 0.30 + 0.62 * loud) * edge;
      final radius = (connecting ? 2.0 : 2.0 + 2.4 * loud) * (0.55 + 0.45 * edge);
      dot.color = colour.withValues(alpha: alpha.clamp(0.0, 1.0));
      canvas.drawCircle(Offset(x, y), radius, dot);
    }
  }

  @override
  bool shouldRepaint(_LinkFlowPainter old) =>
      old.phase != phase ||
      old.micLevel != micLevel ||
      old.avaLevel != avaLevel ||
      old.connecting != connecting;
}
