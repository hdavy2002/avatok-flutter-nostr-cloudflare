// AvaTalk group conference room (Phase 10 — LiveKit, ≤25 participants).
//
// Standard meeting conventions (Meet/WhatsApp-like):
//   - grid for 2–8 tiles, paginated grid (PageView) for 9+
//   - active-speaker highlight, mute/cam/flip/speaker controls
//   - participants sheet, leave vs "end for all" (starter only)
//   - audio-only mode = avatar tiles
//   - minimize (back arrow) keeps the room CONNECTED — the chat thread shows
//     the "Ongoing call · N — tap to return" banner and re-opens this screen.
//
// PERF note (PERF-MEMORY-BUDGET.md): livekit_client rides on the SAME
// flutter_webrtc/libwebrtc the 1:1 CallScreen already links — no second
// WebRTC stack is added to the APK.
//
// 1:1 calls do NOT use this screen — they stay on the P2P CallRoom-DO path.
//
// Zine: paper chrome everywhere; participant tiles get 2px ink borders
// (lime when speaking); control bar = paper-2 band with bordered circle
// buttons (leave = coral); sheets on paper.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' show Helper;
import 'package:livekit_client/livekit_client.dart' as lk;
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../translation/translate_overlay.dart';
import 'conference_api.dart';
import 'conference_telemetry.dart';

/// The one live conference this device is in (a phone is in ≤1 call at a time).
/// Owning the Room OUTSIDE the screen lets the user minimize back into the chat
/// without dropping the call; the screen re-attaches on return.
class OngoingConference {
  static OngoingConference? active;

  final String gid;
  final String title;
  final bool video;
  final bool starter;
  final lk.Room room;
  OngoingConference({required this.gid, required this.title, required this.video, required this.starter, required this.room});

  int get participantCount => room.remoteParticipants.length + 1;

  Future<void> leave() async {
    try { await room.disconnect(); } catch (_) {}
    try { await room.dispose(); } catch (_) {}
    if (identical(active, this)) active = null;
  }
}

/// Last-used mic/cam/speaker choices. DiskCache is already per-account
/// (Rulebook Golden Rule 11 — per-account scoping).
class _ConfPrefs {
  static const _key = 'conference_prefs';
  static Future<Map<String, dynamic>> load() async {
    try {
      final raw = await DiskCache.read(_key);
      if (raw != null) return (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {}
    return const {};
  }

  static Future<void> save({required bool mic, required bool cam, required bool speaker}) async {
    try { await DiskCache.write(_key, jsonEncode({'mic': mic, 'cam': cam, 'speaker': speaker})); } catch (_) {}
  }
}

class ConferenceScreen extends StatefulWidget {
  /// Re-attach to an already-running conference (tap on the ongoing banner).
  final OngoingConference? resume;

  /// Or start/join fresh with a ticket from ConferenceApi.
  final ConferenceTicket? ticket;
  final String? gid;
  final String? title;
  final bool starter;

  const ConferenceScreen.resume(OngoingConference this.resume, {super.key})
      : ticket = null, gid = null, title = null, starter = false;
  const ConferenceScreen.connect({required ConferenceTicket this.ticket, required String this.gid,
      required String this.title, required this.starter, super.key})
      : resume = null;

  @override
  State<ConferenceScreen> createState() => _ConferenceScreenState();
}

class _ConferenceScreenState extends State<ConferenceScreen> {
  OngoingConference? _conf;
  lk.EventsListener<lk.RoomEvent>? _events;
  ConferenceTelemetry? _tel;
  Timer? _beatTimer; // per-minute conf_min metering (ALL SFU plans, incl. Free 60 min/day)
  String? _error;
  bool _mic = true, _cam = true, _speaker = true;
  bool _leaving = false;
  int _page = 0;
  static const _perPage = 8;

  bool get _video => _conf?.video ?? true;

  @override
  void initState() {
    super.initState();
    if (widget.resume != null) {
      _attach(widget.resume!);
    } else {
      _connect();
    }
  }

  Future<void> _connect() async {
    final t = widget.ticket!;
    final video = t.kind != 'audio';
    _tel = ConferenceTelemetry(gid: widget.gid!, video: video, starter: widget.starter);
    final prefs = await _ConfPrefs.load();
    _mic = prefs['mic'] as bool? ?? true;
    _cam = video && (prefs['cam'] as bool? ?? true);
    _speaker = prefs['speaker'] as bool? ?? true;
    final room = lk.Room(roomOptions: const lk.RoomOptions(adaptiveStream: true, dynacast: true));
    final connectT0 = DateTime.now().millisecondsSinceEpoch;
    try {
      await room.connect(t.url, t.token);
      await room.localParticipant?.setMicrophoneEnabled(_mic);
      if (_cam) await room.localParticipant?.setCameraEnabled(true);
      try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    } catch (e) {
      AvaLog.I.log('conference', 'connect failed: $e');
      _tel?.joinFailed(e);
      try { await room.dispose(); } catch (_) {}
      if (mounted) setState(() => _error = 'Could not join the call');
      return;
    }
    _tel?.joined(room,
        joinMs: DateTime.now().millisecondsSinceEpoch - connectT0,
        serverHost: Uri.tryParse(t.url)?.host);
    final conf = OngoingConference(
        gid: widget.gid!, title: widget.title!, video: video, starter: widget.starter, room: room);
    OngoingConference.active = conf;
    _attach(conf);
  }

  void _attach(OngoingConference conf) {
    _conf = conf;
    // Resume path (re-attach to an already-running room) had no telemetry instance.
    if (_tel == null) {
      _tel = ConferenceTelemetry(gid: conf.gid, video: conf.video, starter: conf.starter);
      _tel!.resumed(conf.room);
    }
    conf.room.addListener(_onRoomChanged);
    _events = conf.room.createListener()
      ..on<lk.ParticipantConnectedEvent>((_) => _tel?.participantChanged(conf.room, 'join'))
      ..on<lk.ParticipantDisconnectedEvent>((_) => _tel?.participantChanged(conf.room, 'leave'))
      ..on<lk.RoomDisconnectedEvent>((_) {
        // Room ended remotely ("end for all", network) → fully tear down.
        _beatTimer?.cancel();
        _tel?.left(conf.room, reason: 'room_disconnected');
        if (identical(OngoingConference.active, conf)) OngoingConference.active = null;
        if (mounted && !_leaving) Navigator.of(context).pop();
      });
    _startBeat();
    if (mounted) setState(() {});
  }

  /// Meter conf_min once a minute (every SFU plan, including Free at 60 min/day).
  /// When the daily cap is exhausted the server returns 402; we leave the call and
  /// prompt an upgrade.
  void _startBeat() {
    _beatTimer?.cancel();
    _beatTimer = Timer.periodic(const Duration(minutes: 1), (_) async {
      final conf = _conf;
      if (conf == null || _leaving) return;
      final ok = await ConferenceApi.beat(conf.gid, minutes: 1);
      if (!ok && mounted && !_leaving) {
        _beatTimer?.cancel();
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text("You've used your plan's group-call minutes for today — upgrade for more")));
        _tel?.left(conf.room, reason: 'plan_limit');
        _leaving = true;
        await conf.leave();
        if (mounted) Navigator.pop(context);
      }
    });
  }

  void _onRoomChanged() { if (mounted) setState(() {}); }

  @override
  void dispose() {
    // Safety net for real teardowns only. MINIMIZE also disposes this screen but
    // keeps the room CONNECTED (call continues), so guard on connectionState —
    // emitting conference_left on a minimize would wrongly end the call's metrics.
    // left() is idempotent, so an explicit leave/disconnect already covered.
    if (_conf != null &&
        _conf!.room.connectionState == lk.ConnectionState.disconnected) {
      _tel?.left(_conf!.room, reason: 'dispose');
    }
    _beatTimer?.cancel();
    _conf?.room.removeListener(_onRoomChanged);
    _events?.dispose();
    super.dispose();
  }

  // ---- controls ----------------------------------------------------------------

  Future<void> _toggleMic() async {
    _mic = !_mic;
    await _conf?.room.localParticipant?.setMicrophoneEnabled(_mic);
    _savePrefs(); if (mounted) setState(() {});
  }

  Future<void> _toggleCam() async {
    _cam = !_cam;
    await _conf?.room.localParticipant?.setCameraEnabled(_cam);
    _savePrefs(); if (mounted) setState(() {});
  }

  Future<void> _flipCam() async {
    final pubs = _conf?.room.localParticipant?.videoTrackPublications ?? const [];
    for (final pub in pubs) {
      final t = pub.track;
      if (t is lk.LocalVideoTrack) {
        try { await Helper.switchCamera(t.mediaStreamTrack); } catch (_) {}
        return;
      }
    }
  }

  Future<void> _toggleSpeaker() async {
    _speaker = !_speaker;
    try { await Helper.setSpeakerphoneOn(_speaker); } catch (_) {}
    _savePrefs(); if (mounted) setState(() {});
  }

  void _savePrefs() => _ConfPrefs.save(mic: _mic, cam: _cam, speaker: _speaker);

  Future<void> _leave() async {
    final conf = _conf;
    if (conf == null) { if (mounted) Navigator.pop(context); return; }
    if (conf.starter) {
      final choice = await showModalBottomSheet<String>(
        context: context,
        backgroundColor: Zine.paper,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r))),
        builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.signOut(PhosphorIconsStyle.bold), color: Zine.ink),
              title: Text('Leave call', style: ZineText.value(size: 15)),
              onTap: () => Navigator.pop(ctx, 'leave')),
          ListTile(
              leading: PhosphorIcon(PhosphorIcons.phoneX(PhosphorIconsStyle.bold), color: Zine.coral),
              title: Text('End call for everyone', style: ZineText.value(size: 15, color: Zine.coral)),
              onTap: () => Navigator.pop(ctx, 'end')),
        ])),
      );
      if (choice == null) return;
      if (choice == 'end') unawaited(ConferenceApi.end(conf.gid));
      _tel?.left(conf.room,
          reason: choice == 'end' ? 'ended_for_all' : 'leave',
          endedForAll: choice == 'end');
    } else {
      _tel?.left(conf.room, reason: 'leave');
    }
    _leaving = true;
    _beatTimer?.cancel();
    await conf.leave();
    if (mounted) Navigator.pop(context);
  }

  /// Back arrow = minimize: keep the room connected, return to the chat (the
  /// thread shows the "Ongoing call — tap to return" banner).
  void _minimize() => Navigator.pop(context);

  void _participantsSheet() {
    final conf = _conf; if (conf == null) return;
    final ps = _participants(conf);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r))),
      builder: (ctx) => SafeArea(child: ListView(shrinkWrap: true, children: [
        Padding(padding: const EdgeInsets.all(14),
            child: Text('In call · ${ps.length} of 25', style: ZineText.cardTitle(size: 17))),
        for (final p in ps)
          ListTile(
            leading: Avatar(seed: p.identity, name: _nameOf(p), size: 36),
            title: Text(_nameOf(p) + (p is lk.LocalParticipant ? ' (you)' : ''),
                style: ZineText.value(size: 15, weight: FontWeight.w700)),
            trailing: PhosphorIcon(
                p.isMuted
                    ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                    : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                size: 18, color: p.isMuted ? Zine.inkMute : Zine.mintInk),
          ),
      ])),
    );
  }

  // ---- helpers ------------------------------------------------------------------

  List<lk.Participant> _participants(OngoingConference conf) => [
        if (conf.room.localParticipant != null) conf.room.localParticipant!,
        ...conf.room.remoteParticipants.values,
      ];

  String _nameOf(lk.Participant p) => p.name.isNotEmpty ? p.name : 'AvaTOK user';

  lk.VideoTrack? _videoOf(lk.Participant p) {
    for (final pub in p.videoTrackPublications) {
      final t = pub.track;
      if (t is lk.VideoTrack && !pub.muted) return t;
    }
    return null;
  }

  // ---- UI -----------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        backgroundColor: Zine.paper,
        body: ZinePaper(
          child: SafeArea(
            child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
              ZineEmptyState(icon: PhosphorIcons.warning(PhosphorIconsStyle.bold), text: _error!),
              const SizedBox(height: 16),
              ZineButton(label: 'Close', variant: ZineButtonVariant.ghost, fontSize: 16,
                  onPressed: () => Navigator.pop(context)),
            ])),
          ),
        ),
      );
    }
    final conf = _conf;
    if (conf == null) {
      return const Scaffold(
        backgroundColor: Zine.paper,
        body: Center(child: CircularProgressIndicator(color: Zine.blueInk)),
      );
    }

    final ps = _participants(conf);
    final int pages = ps.isEmpty ? 1 : ((ps.length + _perPage - 1) ~/ _perPage);
    final int page = _page < 0 ? 0 : (_page >= pages ? pages - 1 : _page);

    return PopScope(
      canPop: true, // back = minimize (room stays connected)
      child: Scaffold(
        backgroundColor: Zine.paper,
        body: ZinePaper(
          child: SafeArea(
            child: Column(children: [
              // top bar — paper band
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                child: Row(children: [
                  ZineBackButton(
                      icon: PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                      onTap: _minimize),
                  const SizedBox(width: 12),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(conf.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: ZineText.cardTitle(size: 18)),
                    Text('${ps.length} IN CALL · MAX 25', style: ZineText.kicker(size: 10.5)),
                  ])),
                  // Live voice translation ($3/h in Tokens) — group conferences.
                  if (RemoteConfig.translationGroupEnabled)
                    TranslateOverlay(context: 'conference', refId: conf.gid, inline: true),
                  const SizedBox(width: 8),
                  ZineBackButton(
                      icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold),
                      onTap: _participantsSheet),
                ]),
              ),
              // tiles: grid (≤8) or paginated grid (9+)
              Expanded(
                child: pages == 1
                    ? _grid(ps)
                    : Column(children: [
                        Expanded(
                          child: PageView.builder(
                            itemCount: pages,
                            onPageChanged: (i) => setState(() => _page = i),
                            itemBuilder: (_, i) {
                              final end = i * _perPage + _perPage;
                              return _grid(ps.sublist(i * _perPage, end > ps.length ? ps.length : end));
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
                                    color: i == page ? Zine.coral : Zine.card,
                                    border: Border.all(color: Zine.ink, width: 2)),
                              ),
                          ]),
                        ),
                      ]),
              ),
              // controls — paper-2 band with bordered circle buttons
              Container(
                decoration: const BoxDecoration(
                  color: Zine.paper2,
                  border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
                ),
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _ctl(
                      _mic
                          ? PhosphorIcons.microphone(PhosphorIconsStyle.bold)
                          : PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold),
                      _mic ? 'Mute' : 'Unmute', _toggleMic, active: _mic),
                  if (_video)
                    _ctl(
                        _cam
                            ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                            : PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold),
                        'Camera', _toggleCam, active: _cam),
                  if (_video && _cam)
                    _ctl(PhosphorIcons.cameraRotate(PhosphorIconsStyle.bold), 'Flip', _flipCam, active: true),
                  _ctl(
                      _speaker
                          ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold)
                          : PhosphorIcons.ear(PhosphorIconsStyle.bold),
                      'Speaker', _toggleSpeaker, active: _speaker),
                  // leave / end — coral circle
                  GestureDetector(
                    onTap: _leave,
                    child: Container(
                      width: 56, height: 56,
                      decoration: BoxDecoration(
                        color: Zine.coral,
                        shape: BoxShape.circle,
                        border: Border.all(color: Zine.ink, width: Zine.bw),
                        boxShadow: Zine.shadowSm,
                      ),
                      child: PhosphorIcon(PhosphorIcons.phoneX(PhosphorIconsStyle.fill),
                          color: Colors.white, size: 24),
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

  /// Bordered circle control — card fill when on, coral (danger) when off.
  Widget _ctl(IconData icon, String tip, VoidCallback onTap, {required bool active}) => Tooltip(
        message: tip,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 48, height: 48,
            decoration: BoxDecoration(
              color: active ? Zine.card : Zine.coral,
              shape: BoxShape.circle,
              border: Border.all(color: Zine.ink, width: Zine.bw),
              boxShadow: Zine.shadowXs,
            ),
            child: Icon(icon, color: active ? Zine.ink : Colors.white, size: 22),
          ),
        ),
      );

  Widget _grid(List<lk.Participant> ps) {
    final cols = ps.length <= 1 ? 1 : (ps.length <= 4 ? 2 : 2);
    final rows = (ps.length / cols).ceil();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: LayoutBuilder(builder: (ctx, c) {
        final tileH = (c.maxHeight - (rows - 1) * 8) / rows;
        final tileW = (c.maxWidth - (cols - 1) * 8) / cols;
        return GridView.builder(
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: cols, mainAxisSpacing: 8, crossAxisSpacing: 8,
              childAspectRatio: tileW / tileH),
          itemCount: ps.length,
          itemBuilder: (_, i) => _tile(ps[i]),
        );
      }),
    );
  }

  Widget _tile(lk.Participant p) {
    final track = _video ? _videoOf(p) : null;
    final speaking = p.isSpeaking;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Zine.paper2,
        borderRadius: BorderRadius.circular(14),
        // 2px ink borders on tiles; lime = active speaker.
        border: Border.all(color: speaking ? Zine.lime : Zine.ink, width: speaking ? Zine.bw : 2),
      ),
      child: Stack(fit: StackFit.expand, children: [
        if (track != null)
          lk.VideoTrackRenderer(track)
        else
          Center(child: Avatar(seed: p.identity, name: _nameOf(p), size: 64)),
        Positioned(
          left: 6, bottom: 6, right: 6,
          child: Row(children: [
            Flexible(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: Zine.ink.withValues(alpha: 0.55), // ink-alpha pill over video
                  borderRadius: BorderRadius.circular(100),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Flexible(child: Text(
                    p is lk.LocalParticipant ? 'You' : _nameOf(p),
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.value(size: 11.5, color: Colors.white, weight: FontWeight.w700),
                  )),
                  if (p.isMuted) ...[
                    const SizedBox(width: 4),
                    PhosphorIcon(PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold),
                        color: Colors.white, size: 12),
                  ],
                ]),
              ),
            ),
          ]),
        ),
      ]),
    );
  }
}
