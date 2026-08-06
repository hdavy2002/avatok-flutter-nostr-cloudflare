// [CF-CALL-003/007] Cloudflare Realtime A/V group-call screen — the ONLY
// group-call screen as of CF-CALL-007 (the prior `conference_screen.dart`
// provider was removed). AD dark tokens (near-black chrome, hairline-bordered
// circle controls, accent speaking border, grid/paginated-grid tiles); all
// media/session logic lives in `CloudflareConferenceController`.
//
// Reached only when RemoteConfig.cloudflareConferenceEnabled is true (see the
// chat_thread.dart launch-site branch). When the flag is off, group calls are
// simply unavailable — there is no other transport to fall back to.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as webrtc;
import 'package:permission_handler/permission_handler.dart' show openAppSettings;
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/call_recording/call_recording_model.dart';
import '../../core/call_recording/call_recording_store.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/add_to_call_sheet.dart'; // [ADDCALL-3-UI] the ONE people picker
import 'add_to_call_ring.dart'; // [ADDCALL-3-UI]
import 'cloudflare_conference_controller.dart';

class CloudflareConferenceScreen extends StatefulWidget {
  final String gid;
  final String title;
  final bool video;
  final bool starter;

  /// [ADDCALL-2-UI] An ALREADY-CONNECTED controller to adopt instead of building
  /// one (make-before-break — `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` §4).
  ///
  /// The whole point of the migration is that the conference is up, verified
  /// and carrying the live capture stream BEFORE the 1:1 leg is released, so by
  /// the time this screen exists the call is already running. Building a second
  /// controller here would `/join` twice, publish twice and re-prompt for the
  /// microphone.
  ///
  /// Null for every other call site, which keeps their behaviour identical.
  /// This screen still owns disposal either way.
  final CloudflareConferenceController? adopt;

  const CloudflareConferenceScreen({
    super.key,
    required this.gid,
    required this.title,
    required this.video,
    required this.starter,
    this.adopt,
  });

  @override
  State<CloudflareConferenceScreen> createState() => _CloudflareConferenceScreenState();
}

class _CloudflareConferenceScreenState extends State<CloudflareConferenceScreen> with WidgetsBindingObserver {
  late final CloudflareConferenceController _ctrl;
  static const _perPage = 8;
  int _page = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final adopted = widget.adopt;
    _ctrl = adopted ??
        CloudflareConferenceController(
            gid: widget.gid, title: widget.title, wantVideo: widget.video, starter: widget.starter);
    _ctrl.addListener(_onChanged);
    // [ADDCALL-2-UI] An adopted controller is already connected — calling
    // connect() on it a second time would re-run the entire join sequence.
    if (adopted == null) unawaited(_ctrl.connect());
  }

  void _onChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // [GCALL-W2-HOLD] Lifecycle handling was resume-only, so backgrounding
    // neither survived nor left cleanly. `paused` now keeps the call (the
    // foreground service holds the process) and merely records it; `detached`
    // is the process actually going away, which must leave properly rather
    // than let the DO discover it 45-60s later via the zombie sweep.
    switch (state) {
      case AppLifecycleState.resumed:
        _ctrl.onForegroundResume();
      case AppLifecycleState.paused:
        _ctrl.onBackgrounded();
      case AppLifecycleState.detached:
        unawaited(_ctrl.leave(reason: 'app_detached'));
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        break;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _ctrl.removeListener(_onChanged);
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _leave() async {
    await _ctrl.leave(reason: 'voluntary');
    if (mounted) Navigator.of(context).maybePop();
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  [ADDCALL-3-UI] Add someone once the call is ALREADY a conference.
  //
  //  Spec: `Specs/SPEC-ADD-TO-CALL-2026-08-06.md` §5.
  //
  //  The 1:1 screen's Add tile is gone by the time the user is here — they
  //  escalated, or they were rung into a group call — so without this control
  //  "add one more person" is simply impossible after the first add.
  //
  //  ── THE SAME PICKER, NOT A SECOND ONE ────────────────────────────────────
  //  `showAddToCallSheet` is reused verbatim. It needs two things from the live
  //  roster and gets both from the controller rather than from a guess:
  //   · `alreadyOnCall` — remote participants PLUS you, so the remaining
  //     allowance against the cap of 10 is computed from what is actually in the
  //     room, not from the 2 the 1:1 path can assume.
  //   · `excludeUids` — everyone already here, so nobody is offered a person the
  //     server would only answer `already_present` for.
  //
  //  ── TWO STEPS HERE, ONE IN THE ESCALATION ────────────────────────────────
  //  Nobody has written a `conversation_members` row for these people, so this
  //  path runs `/adhoc-room/add` and THEN `/invite` (`addMembership: true`). The
  //  escalation path skips the add because `/adhoc-room/create` already did it.
  //  That single flag is the only difference; see `add_to_call_ring.dart`.
  // ───────────────────────────────────────────────────────────────────────────

  bool _adding = false;

  Future<void> _addPeople() async {
    if (_adding) return;
    // Defensive: the control is not rendered with the flag off, so reaching this
    // means the config flipped mid-call. The server 403s `disabled` anyway.
    if (!RemoteConfig.addToCallEnabled) return;

    // The roster is REMOTE participants; you are rendered separately as the
    // local tile. Both the count and the exclusion list have to include you.
    final present = _ctrl.roster.map((p) => p.uid).toSet()..add(_ctrl.myId);
    final picked = await showAddToCallSheet(
      context,
      callId: widget.gid,
      alreadyOnCall: present.length,
      excludeUids: present,
    );
    if (!mounted || picked == null || picked.isEmpty) return;

    setState(() => _adding = true);
    final names = <String, String>{for (final c in picked) c.uid: c.name};
    final outcome = await AddToCallRing.run(
      gid: widget.gid,
      uids: picked.map((c) => c.uid).toList(),
      // Byte-identical to the Worker's `escalationIdFor(groupId)`, so both
      // halves of this funnel join on one key.
      escalationId: 'addcall:${widget.gid}',
      addMembership: true,
    );
    if (!mounted) return;
    setState(() => _adding = false);
    AddToCallRing.report(ScaffoldMessenger.maybeOf(context), outcome, names);
  }

  @override
  Widget build(BuildContext context) {
    if (_ctrl.state == CfConnState.failed) {
      return Scaffold(
        backgroundColor: AD.bg,
        body: ZinePaper(
          child: SafeArea(
            child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              // `statusText` now carries the server's real message (or a
              // permission-specific one) instead of one generic line for every
              // possible cause.
              ZineEmptyState(icon: PhosphorIcons.warning(PhosphorIconsStyle.regular), text: _ctrl.statusText),
              const SizedBox(height: Msg.s4),
              // A permission refusal is the one failure the user can fix on the
              // spot — give them the door instead of a dead end.
              if (_ctrl.permissionDenied) ...[
                ZineButton(label: 'Open settings', fontSize: 16, onPressed: openAppSettings),
                const SizedBox(height: Msg.s2),
              ],
              ZineButton(label: 'Close', variant: ZineButtonVariant.ghost, fontSize: 16,
                  onPressed: () => Navigator.pop(context)),
            ])),
          ),
        ),
      );
    }
    if (_ctrl.state == CfConnState.connecting) {
      return const Scaffold(
        backgroundColor: AD.bg,
        body: Center(child: CircularProgressIndicator(color: AD.primaryBadge)),
      );
    }

    final members = _ctrl.roster;
    // Report currently-visible uids to the controller so it can apply the
    // viewport-aware video subscription policy (CF-CALL-004).
    final int pages = members.isEmpty ? 1 : ((members.length + _perPage - 1) ~/ _perPage);
    final int page = _page < 0 ? 0 : (_page >= pages ? pages - 1 : _page);
    final start = page * _perPage;
    final end = (start + _perPage) > members.length ? members.length : start + _perPage;
    final visible = members.sublist(start, end);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _ctrl.setVisibleTiles(visible.map((p) => p.uid).toSet());
    });

    return PopScope(
      canPop: true,
      child: Scaffold(
        backgroundColor: AD.bg,
        body: ZinePaper(
          child: SafeArea(
            child: Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s2, Msg.s3, Msg.s2),
                child: Row(children: [
                  ZineBackButton(icon: PhosphorIcons.caretDown(PhosphorIconsStyle.regular), onTap: () => Navigator.pop(context)),
                  const SizedBox(width: Msg.s3),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.threadName()),
                    Text(
                      // A reconnect used to render as a completely frozen call:
                      // `reconnecting` had no UI at all, so the only visible
                      // difference between recovering and dead was neither.
                      _ctrl.state == CfConnState.reconnecting
                          ? 'Reconnecting…'
                          : '${members.length + 1} in call · Cloudflare',
                      style: ADText.sectionLabel(),
                    ),
                  ])),
                ]),
              ),
              // [ADDCALL-0] Recording indicator — the conference twin of the 1:1
              // pill (`call_screen.dart` `_RecordingIndicatorPill`). Gated on
              // `callRecordingIndicatorEnabled` ALONE, exactly as the 1:1 pill
              // is: `callRecordingEnabled` is the switch on the ability to
              // RECORD, and the device that most needs to see this pill is the
              // one that cannot record but can be recorded.
              //
              // Renders nothing when nobody is recording, so the ordinary case
              // costs no layout.
              if (RemoteConfig.callRecordingIndicatorEnabled)
                Center(child: _ConferenceRecordingPill(gid: widget.gid)),
              if (_ctrl.notice != null) _noticeBar(_ctrl.notice!),
              Expanded(
                child: pages == 1
                    ? _grid([_LocalTile(_ctrl), ...visible.map((p) => _RemoteTile(_ctrl, p))])
                    : Column(children: [
                        Expanded(
                          child: PageView.builder(
                            itemCount: pages,
                            onPageChanged: (i) => setState(() => _page = i),
                            itemBuilder: (_, i) {
                              final s = i * _perPage;
                              final e = (s + _perPage) > members.length ? members.length : s + _perPage;
                              final tiles = <Widget>[
                                if (i == 0) _LocalTile(_ctrl),
                                ...members.sublist(s, e).map((p) => _RemoteTile(_ctrl, p)),
                              ];
                              return _grid(tiles);
                            },
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                            for (var i = 0; i < pages; i++)
                              Container(
                                width: 8, height: 8, margin: const EdgeInsets.symmetric(horizontal: 3),
                                decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: i == page ? AD.primaryBadge : AD.card,
                                    border: Border.all(color: AD.borderControl, width: 1)),
                              ),
                          ]),
                        ),
                      ]),
              ),
              Container(
                decoration: const BoxDecoration(
                  color: AD.headerFooter,
                  border: Border(top: Msg.hairline),
                ),
                padding: const EdgeInsets.symmetric(vertical: Msg.s3),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _ctl(_ctrl.muted ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.regular) : PhosphorIcons.microphone(PhosphorIconsStyle.regular),
                      _ctrl.muted ? 'Unmute' : 'Mute', _ctrl.toggleMute, active: !_ctrl.muted),
                  // Camera controls follow the EFFECTIVE media mode, not
                  // `widget.video` (the request). A video call that downgraded
                  // to audio — camera permission denied, or the call itself is
                  // audio-only — used to keep showing a camera button that
                  // could never do anything.
                  if (_ctrl.effectiveVideo)
                    _ctl(_ctrl.cameraOn ? PhosphorIcons.videoCamera(PhosphorIconsStyle.regular) : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.regular),
                        'Camera', _ctrl.toggleCamera, active: _ctrl.cameraOn),
                  if (_ctrl.effectiveVideo && _ctrl.cameraOn)
                    _ctl(PhosphorIcons.cameraRotate(PhosphorIconsStyle.regular), 'Flip', _ctrl.flipCamera, active: true),
                  _ctl(_ctrl.speakerOn ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.regular) : PhosphorIcons.ear(PhosphorIconsStyle.regular),
                      'Speaker', _ctrl.toggleSpeaker, active: _ctrl.speakerOn),
                  // [ADDCALL-3-UI] Add more people. Hidden entirely when
                  // `addToCallEnabled` is off — with the flag off this row is
                  // byte-for-byte what it has always been — and dimmed while a
                  // add/ring round trip is in flight so a double tap cannot ring
                  // the same person twice.
                  //
                  // `userPlus` is a real phosphor_flutter 2.1.0 name, matching
                  // the 1:1 screen's Add tile (call_screen.dart) and
                  // search_screen.dart:515. A GUESSED Phosphor name compiles and
                  // then fails at kernel snapshot, i.e. only in CI — verify
                  // against the repo, never intuition.
                  if (RemoteConfig.addToCallEnabled)
                    Opacity(
                      opacity: _adding ? 0.45 : 1,
                      child: _ctl(
                          PhosphorIcons.userPlus(PhosphorIconsStyle.regular),
                          'Add',
                          _adding ? () {} : () => unawaited(_addPeople()),
                          active: true),
                    ),
                  GestureDetector(
                    onTap: _leave,
                    child: Container(
                      width: 56, height: 56,
                      decoration: BoxDecoration(
                        color: AD.danger, shape: BoxShape.circle,
                        border: Border.all(color: AD.borderControl, width: 1), boxShadow: Msg.lift,
                      ),
                      child: PhosphorIcon(PhosphorIcons.phoneX(PhosphorIconsStyle.bold), color: AD.destructiveInk, size: 24),
                    ),
                  ),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  /// Non-fatal condition worth stating plainly: an audio downgrade, or a
  /// degraded TURN relay. Dismissible — it never blocks the call.
  Widget _noticeBar(String text) => Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          color: AD.card,
          border: Border(bottom: Msg.hairline),
        ),
        padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s2, Msg.s2, Msg.s2),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.regular), size: 16, color: AD.iconNeutral),
          const SizedBox(width: Msg.s2),
          Expanded(child: Text(text, style: ADText.timestamp(c: AD.textSecondary))),
          GestureDetector(
            onTap: () => setState(() => _ctrl.notice = null),
            child: Padding(
              padding: const EdgeInsets.all(Msg.s1),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.regular), size: 14, color: AD.iconNeutral),
            ),
          ),
        ]),
      );

  Widget _ctl(IconData icon, String tip, VoidCallback onTap, {required bool active}) => Tooltip(
        message: tip,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 48, height: 48,
            decoration: BoxDecoration(
              color: active ? AD.card : AD.danger,
              shape: BoxShape.circle,
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: Icon(icon, color: active ? AD.iconNeutral : AD.destructiveInk, size: 22),
          ),
        ),
      );

  Widget _grid(List<Widget> tiles) {
    final cols = tiles.length <= 1 ? 1 : (tiles.length <= 4 ? 2 : 2);
    final rows = (tiles.length / cols).ceil().clamp(1, 100);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: LayoutBuilder(builder: (ctx, c) {
        final tileH = (c.maxHeight - (rows - 1) * 8) / rows;
        final tileW = (c.maxWidth - (cols - 1) * 8) / cols;
        return GridView.builder(
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: cols, mainAxisSpacing: 8, crossAxisSpacing: 8,
              childAspectRatio: tileW / (tileH <= 0 ? 1 : tileH)),
          itemCount: tiles.length,
          itemBuilder: (_, i) => tiles[i],
        );
      }),
    );
  }
}

/// [ADDCALL-0] "Recording" pill for the group-call screen.
///
/// The 1:1 screen has had one since [CALLREC-PEER-1]; the conference screen had
/// nothing, so in a group call one person could record and everyone else saw no
/// sign of it. Spec §7 (`Specs/SPEC-ADD-TO-CALL-2026-08-06.md`) makes this a
/// hard prerequisite for recording through an escalation: in a 1:1 the ToS
/// clause plus an on-screen indicator informs both parties, but in a 10-way call
/// the clause is carrying nine people on its own without this.
///
/// Deliberately mirrors `_RecordingIndicatorPill` in
/// `app/lib/features/avatok/call_screen.dart` — same destructive-token pill,
/// same filled dot, same `Recording · m:ss` / `Saving recording…` copy — so a
/// user who has seen one recognises the other instantly.
///
/// ⚠️ **The remote half is NOT wired yet — [peerRecording] is always false
/// today.** The 1:1 pill learns about the other side from the `callrec` frame,
/// which rides the `CallRoom` relay; a conference does not use `CallRoom` at
/// all, so that state has to be relayed through `GroupCallRoom` instead. That is
/// new transport, not a copy of the existing frame, and it is **Phase 4** work
/// per spec §7 / §9 — see the TODO on [peerRecording]. Until it lands this pill
/// is honest about exactly one thing: whether THIS device is recording.
class _ConferenceRecordingPill extends StatelessWidget {
  const _ConferenceRecordingPill({
    required this.gid,
    // TODO(ADDCALL-4): wire this to real peer recording state. Requires
    // relaying the `callrec` state frame through `GroupCallRoom` (spec §7:
    // "the indicator must show ... for EVERY participant whenever ANY
    // participant is recording"). Hard-coded false until then — do NOT read
    // this as "no one else is recording", it means "we cannot know yet".
    this.peerRecording = false,
    this.peerRecordingLabel = 'Someone',
  });

  /// The conversation id of the group call this screen is showing.
  final String gid;

  /// True when at least one OTHER participant is recording. Always false today —
  /// see the class doc and the TODO above.
  final bool peerRecording;

  /// How to name the recording peer(s) once [peerRecording] can be true. With no
  /// transport there is no name to show, so the default is deliberately generic
  /// rather than a fabricated participant.
  final String peerRecordingLabel;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<CallRecordingPhase>(
      valueListenable: CallRecordingStore.I.phase,
      builder: (context, phase, _) => ValueListenableBuilder<String?>(
        valueListenable: CallRecordingStore.I.activeCallId,
        builder: (context, activeId, __) {
          // The recorder is process-wide and this device can only be in one
          // call, so a live recorder while this screen is up IS this call.
          //
          // Note we deliberately do NOT compare `activeId == gid` the way the
          // 1:1 pill compares against `session.room`. A recording that started
          // before an escalation keeps the pre-escalation 1:1 call id (the
          // recorder taps the audio device module, below the transport, and is
          // never restarted — spec §7), so matching on the gid would hide the
          // pill in precisely the case §7 exists for. `activeId != null` is the
          // honest test: some call on this device is being recorded.
          final mine = activeId != null;
          final recording = mine && phase == CallRecordingPhase.recording;
          final finalizing = mine && phase == CallRecordingPhase.finalizing;
          if (!recording && !finalizing && !peerRecording) {
            return const SizedBox.shrink();
          }
          return ValueListenableBuilder<CallRecordingProgress?>(
            valueListenable: CallRecordingStore.I.progress,
            builder: (context, progress, ___) {
              final elapsed = (recording && progress != null)
                  ? _recElapsed(progress.durationMs)
                  : '';
              final String text;
              if (finalizing && !peerRecording) {
                text = 'Saving recording…';
              } else if (recording && peerRecording) {
                text = 'You and $peerRecordingLabel are recording';
              } else if (peerRecording && !recording) {
                text = '$peerRecordingLabel is recording';
              } else {
                text = elapsed.isEmpty ? 'Recording' : 'Recording · $elapsed';
              }
              return Container(
                // Margin lives on the pill, not on the caller, so the
                // not-recording case (a `SizedBox.shrink`) leaves no gap in the
                // column at all.
                margin: const EdgeInsets.only(bottom: Msg.s2),
                padding: const EdgeInsets.symmetric(
                    horizontal: Msg.s3, vertical: Msg.s1),
                decoration: BoxDecoration(
                  color: AD.destructiveBg,
                  borderRadius: Msg.brPill,
                  border: Border.all(color: AD.destructiveBg, width: 1),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.circle(PhosphorIconsStyle.fill),
                      size: 10, color: AD.destructiveInk),
                  const SizedBox(width: Msg.s2),
                  Flexible(
                    child: Text(
                      text,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ADText.timestamp(c: AD.destructiveInk)
                          .copyWith(fontWeight: FontWeight.w700),
                    ),
                  ),
                ]),
              );
            },
          );
        },
      ),
    );
  }
}

/// `m:ss`, or `h:mm:ss` past an hour. Same formatting as the 1:1 screen's
/// `_hhmmss`, duplicated because that one is library-private to `call_screen.dart`.
String _recElapsed(int ms) {
  final total = ms <= 0 ? 0 : ms ~/ 1000;
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  final ss = s.toString().padLeft(2, '0');
  if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$ss';
  return '$m:$ss';
}

class _LocalTile extends StatelessWidget {
  final CloudflareConferenceController ctrl;
  const _LocalTile(this.ctrl);

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: AD.card, borderRadius: Msg.brMd, border: Border.all(color: AD.borderControl, width: 1)),
      child: Stack(fit: StackFit.expand, children: [
        if (ctrl.cameraOn)
          webrtc.RTCVideoView(ctrl.localRenderer, mirror: true, objectFit: webrtc.RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
        else
          Center(child: PhosphorIcon(PhosphorIcons.user(PhosphorIconsStyle.regular), color: AD.textFaint, size: 48)),
        Positioned(left: 6, bottom: 6, child: _namePill('You', muted: ctrl.muted)),
      ]),
    );
  }
}

class _RemoteTile extends StatelessWidget {
  final CloudflareConferenceController ctrl;
  final CfParticipant p;
  const _RemoteTile(this.ctrl, this.p);

  @override
  Widget build(BuildContext context) {
    final renderer = ctrl.rendererFor(p.uid);
    final speaking = ctrl.dominantSpeakerUid == p.uid;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: Msg.brMd,
        border: Border.all(
            color: speaking ? AD.primaryBadge : AD.borderControl,
            width: speaking ? 2 : 1),
      ),
      child: Stack(fit: StackFit.expand, children: [
        if (p.videoEnabled && renderer != null)
          webrtc.RTCVideoView(renderer, objectFit: webrtc.RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
        else
          Center(child: Avatar(seed: p.uid, name: p.uid, size: 56)),
        // [GCALL-W4-MUTE] Real mute state from the roster. This was
        // `p.audioTrack == null`, which is only true BEFORE someone's first
        // publish — so the mic-slash never appeared for anyone who had actually
        // muted, and vanished for good once they published.
        Positioned(left: 6, bottom: 6,
            child: _namePill(p.uid, muted: p.muted || p.audioTrack == null)),
      ]),
    );
  }
}

Widget _namePill(String name, {required bool muted}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: 2),
      // Name tag over a video tile — a genuine pill.
      decoration: BoxDecoration(color: AD.scrim, borderRadius: Msg.brPill),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Flexible(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ADText.bubbleMeta(c: AD.textPrimary))),
        if (muted) ...[
          const SizedBox(width: Msg.s1),
          PhosphorIcon(PhosphorIcons.microphoneSlash(PhosphorIconsStyle.regular), color: AD.textPrimary, size: 12),
        ],
      ]),
    );
