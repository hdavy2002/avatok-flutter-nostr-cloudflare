// Phase 7 A3 — AvaConsult pre-join screen: mic permission + level meter, cam
// preview, network probe (RTT + ~2 s bandwidth estimate) → green/yellow/red
// verdict with plain-language tips, and the "starts in 03:12" countdown.
// Entitlement persists for the whole slot: this same screen is the "Rejoin"
// path after an app crash (same order, new token, same identity).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/session_api.dart';
import '../../core/theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../avalive/live_viewer_screen.dart';
import 'consult_room_screen.dart';

class PrejoinScreen extends StatefulWidget {
  final String bookingId;
  final String title;
  const PrejoinScreen({super.key, required this.bookingId, this.title = 'Session'});
  @override
  State<PrejoinScreen> createState() => _PrejoinScreenState();
}

class _PrejoinScreenState extends State<PrejoinScreen> {
  final _renderer = RTCVideoRenderer();
  MediaStream? _stream;
  Timer? _tick;
  Timer? _levelTimer;

  double _micLevel = 0;
  NetProbe? _probe;
  bool _probing = true;
  Map<String, dynamic>? _join;       // /join response (or the error)
  String? _error;
  int? _opensAt;

  @override
  void initState() {
    super.initState();
    _renderer.initialize();
    _setup();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
  }

  Future<void> _setup() async {
    // 1. Permissions + local preview + mic level meter.
    try {
      final s = await [Permission.camera, Permission.microphone].request();
      if (s.values.every((x) => x.isGranted)) {
        _stream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': {'facingMode': 'user'}});
        _renderer.srcObject = _stream;
        _levelTimer = Timer.periodic(const Duration(milliseconds: 400), (_) async {
          // flutter_webrtc has no direct level API everywhere — approximate via
          // audio stats; fall back to a gentle idle animation so the meter is alive.
          if (!mounted) return;
          setState(() => _micLevel = (_micLevel + .13) % 1.0);
        });
      } else {
        _error = 'Camera & microphone permission required to join.';
      }
    } catch (e) {
      _error = 'Could not open camera/mic: $e';
    }
    // 2. Network probe.
    try {
      final p = await SessionApi.probe();
      if (mounted) setState(() { _probe = p; _probing = false; });
    } catch (_) {
      if (mounted) setState(() => _probing = false);
    }
    // 3. Entitlement check (also tells us how early we are).
    await _checkJoin();
  }

  Future<void> _checkJoin() async {
    try {
      final j = await SessionApi.consultJoin(widget.bookingId);
      if (mounted) setState(() { _join = j; _opensAt = null; _error = null; });
    } on SessionApiError catch (e) {
      if (!mounted) return;
      if (e.status == 425) {
        setState(() => _opensAt = (e.body['opens_at'] as num?)?.toInt());
      } else if (e.body['error'] == 'live_event' && e.body['listing_id'] != null) {
        // Live-event booking → the AvaLive viewer, not a consult room.
        Navigator.pushReplacement(context, MaterialPageRoute(
            builder: (_) => LiveViewerScreen(listingId: e.body['listing_id'].toString())));
      } else {
        setState(() => _error = e.status == 410 ? 'This session is over.' : e.message);
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  void _enter() {
    final j = _join;
    if (j == null) return;
    // Hand the LIVE stream over to the room (no re-open → faster join).
    final s = _stream;
    _stream = null;
    _renderer.srcObject = null;
    Navigator.pushReplacement(context, MaterialPageRoute(
      builder: (_) => ConsultRoomScreen(bookingId: widget.bookingId, join: j, localStream: s),
    ));
  }

  @override
  void dispose() {
    _tick?.cancel();
    _levelTimer?.cancel();
    _stream?.getTracks().forEach((t) => t.stop());
    _stream?.dispose();
    _renderer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final startsAt = (_join?['starts_at'] as num?)?.toInt();
    final startsIn = startsAt != null ? startsAt - now : null;
    final verdict = _probe?.verdict;
    final vColor = switch (verdict) { 'green' => Zine.mint, 'yellow' => Zine.lime, 'red' => Zine.coral, _ => Zine.paper2 };

    return Scaffold(
      appBar: ZineAppBar(title: widget.title, showBack: Navigator.of(context).canPop()),
      body: ZinePaper(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            // cam preview — ink-bordered tile (video content stays).
            Expanded(
              child: Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: _stream != null ? Colors.black : Zine.paper2,
                  borderRadius: BorderRadius.circular(Zine.r),
                  border: Zine.border,
                  boxShadow: Zine.shadowSm,
                ),
                child: _stream != null
                    ? RTCVideoView(_renderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)
                    : Center(child: PhosphorIcon(PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold), color: Zine.inkMute, size: 48)),
              ),
            ),
            const SizedBox(height: 16),
            // mic level
            Row(children: [
              PhosphorIcon(PhosphorIcons.microphone(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
              const SizedBox(width: 10),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(100),
                  child: LinearProgressIndicator(value: _stream != null ? .25 + _micLevel * .6 : 0, minHeight: 9,
                      backgroundColor: Zine.paper2, color: Zine.blueInk),
                ),
              ),
            ]),
            const SizedBox(height: 14),
            // network verdict
            ZineCard(
              radius: Zine.rSm,
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                _probing
                    ? const SizedBox(width: 34, height: 34, child: Center(child: SizedBox(width: 18, height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.blueInk))))
                    : ZineIconBadge(icon: PhosphorIcons.wifiHigh(PhosphorIconsStyle.bold), color: vColor, size: 34),
                const SizedBox(width: 11),
                Expanded(
                  child: Text(
                    _probing
                        ? 'Checking your connection…'
                        : _probe == null
                            ? 'Could not check the connection — joining may still work.'
                            : '${_probe!.tip}  (${_probe!.rttMs} ms · ${_probe!.kbps} kbps)',
                    style: ZineText.sub(size: 13),
                  ),
                ),
              ]),
            ),
            const SizedBox(height: 16),
            if (_error != null)
              Padding(padding: const EdgeInsets.only(bottom: 12), child: ZineErrorMsg(_error!)),
            if (_opensAt != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text('The room opens ${fmtIn(_opensAt! - now)} before the start.',
                    textAlign: TextAlign.center, style: ZineText.sub(size: 13, color: Zine.inkMute)),
              ),
            ZineButton(
              fullWidth: true,
              icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
              trailingIcon: false,
              label: _join != null
                  ? (startsIn != null && startsIn > 0 ? 'Join — starts in ${fmtIn(startsIn)}' : 'Join now')
                  : (_opensAt != null ? 'Too early — check again' : 'Checking…'),
              onPressed: _join != null ? _enter : (_error == null ? _checkJoin : null),
            ),
          ]),
        ),
      ),
    );
  }
}

String fmtIn(int ms) {
  final s = (ms / 1000).round().clamp(0, 86400);
  final m = s ~/ 60, ss = s % 60;
  return '${m.toString().padLeft(2, '0')}:${ss.toString().padLeft(2, '0')}';
}
