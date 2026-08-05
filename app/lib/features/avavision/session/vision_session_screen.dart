// vision_session_screen.dart — the AvaVision live session ("AvaVoice with eyes").
//
// Split-screen experience (proposal §3.4 / master requirement): the main view is
// the user's camera with the on-device overlay + a transparent score badge; a
// thumbnail shows the agent's avatar + voice indicator; a countdown + language
// chip sit on top; an optional "Analyze my form" button snapshots a hi-res frame.
//
// The session/billing lifecycle is copied verbatim from
// `app/lib/features/avavoice/call_screen.dart`: sessions/start → 60 s heartbeats
// → sessions/stop, the countdown→wrap-up→hard-cap machine, and dispose-safety
// (fire-and-forget stop on swipe-away). The camera/overlay/Live/snapshot layer
// is the VisionEngine on top.
//
// Public symbol contract (master §6 / Phase-3): exported unchanged as
// `VisionSessionScreen({required VisionAgent agent, required String language,
// String? bookingId, String? callId})` — Phase 2 navigates to it.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/avatar.dart';
import '../../../identity/identity.dart';
import '../../../core/ui/zine_widgets.dart';
import 'overlay_painters.dart';
import 'pose_channel.dart';
import '../../../core/avavision_api.dart';
import 'vision_engine.dart';
import 'vision_preview_pane.dart';


/// Sentence case for a display label. Replaces the `.toUpperCase()` the legacy
/// zine stickers applied to everything; call sites pass lowercase strings, so
/// simply dropping the transform would render them lowercase.
String _sentence(String s) =>
    s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

class VisionSessionScreen extends StatefulWidget {
  final VisionAgent agent;
  final String language;
  final String? bookingId;
  final String? callId;
  const VisionSessionScreen({
    super.key,
    required this.agent,
    required this.language,
    this.bookingId,
    this.callId,
  });

  @override
  State<VisionSessionScreen> createState() => _VisionSessionScreenState();
}

class _VisionSessionScreenState extends State<VisionSessionScreen>
    with WidgetsBindingObserver {
  // consent → connecting → live → wrapup → ended | error
  String _state = 'consent';
  String? _error;
  String? _sessionId;
  int _limitMinutes = kMaxSessionMinutes;
  int _elapsedSec = 0;
  bool _twoMinCueSent = false;

  // snapshot quota
  int _snapCap = 0;
  int _snapUsed = 0;
  bool _snapInFlight = false;

  Timer? _tick, _beat;
  late final VisionEngine _engine = VisionEngine(agent: widget.agent);

  VisionAgent get a => widget.agent;
  bool get _snapEnabled => a.agenticSnapshotEnabled;
  bool get _capReached => _snapCap > 0 && _snapUsed >= _snapCap;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Camera consent gate (master rule 10 / proposal §6): nothing turns on until
    // the user explicitly accepts. Shown as soon as the first frame is up.
    WidgetsBinding.instance.addPostFrameCallback((_) => _askConsent());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tick?.cancel();
    _beat?.cancel();
    final s = _sessionId;
    if (s != null && _state != 'ended') {
      // Fire-and-forget: never leave a slot/billing hanging on swipe-away. stop
      // is idempotent server-side (§B), so we don't await or re-settle.
      AvaVisionApi.sessionStop(s, reason: 'user');
    }
    _engine.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState st) {
    // Privacy: mute the mic the moment we background while live. Camera/model
    // are paused natively when the PlatformView loses its surface; billing keeps
    // its own cadence and the stale-heartbeat sweep covers an outright kill.
    if (st == AppLifecycleState.paused && _state == 'live' && !_engine.muted.value) {
      _engine.toggleMute();
    }
  }

  // ── consent ──────────────────────────────────────────────────────────────
  Future<void> _askConsent() async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isDismissible: false,
      enableDrag: false,
      backgroundColor: Colors.transparent,
      builder: (_) => _ConsentSheet(agentName: a.name),
    );
    if (ok != true) {
      if (mounted) Navigator.of(context).maybePop();
      return;
    }
    final grants = await [Permission.camera, Permission.microphone].request();
    final camOk = grants[Permission.camera]?.isGranted ?? false;
    final micOk = grants[Permission.microphone]?.isGranted ?? false;
    if (!camOk || !micOk) {
      setState(() {
        _state = 'error';
        _error = 'AvaVision needs camera and microphone access to coach you.';
      });
      return;
    }
    _start();
  }

  // ── lifecycle (mirrors call_screen.dart) ───────────────────────────────────
  Future<void> _start() async {
    setState(() => _state = 'connecting');
    final r = await AvaVisionApi.sessionStart(
        bookingId: widget.bookingId, callId: widget.callId, language: widget.language);
    if (!mounted) return;
    if (r['status'] != 200) {
      setState(() {
        _state = 'error';
        _error = switch (r['status']) {
          402 => 'Not enough Tokens to start this session.',
          409 => '${a.name} is busy on all lines — please try again shortly.',
          _ => r['detail']?.toString() ?? r['error']?.toString() ?? 'Could not connect.',
        };
      });
      return;
    }
    final t = VisionSessionTicket.fromJson(r);
    setState(() {
      _sessionId = t.sessionId;
      _limitMinutes = t.limitMinutes.clamp(1, kMaxSessionMinutes);
      _snapCap = t.freeSnapshotsPerSession;
      _state = 'live';
    });
    await _engine.start(t);
    if (!mounted) return;
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
    _beat = Timer.periodic(const Duration(seconds: 60), (_) => _heartbeat());
  }

  void _onTick() {
    if (!mounted) return;
    setState(() {
      _elapsedSec++;
      final remaining = _limitMinutes * 60 - _elapsedSec;
      if (remaining <= 120 && _state == 'live') {
        _state = 'wrapup';
        if (!_twoMinCueSent) {
          _twoMinCueSent = true;
          // Exact wrap-up grounding (master §5).
          _engine.sendSystemText('2 minutes remaining');
        }
      }
      if (remaining <= 0) _end(reason: 'hard_cap');
    });
  }

  Future<void> _heartbeat() async {
    final s = _sessionId;
    if (s == null || (_state != 'live' && _state != 'wrapup')) return;
    final r = await AvaVisionApi.sessionHeartbeat(s);
    if (!mounted) return;
    // A late beat that comes back ended must transition to ended, not error.
    if (r['status'] == 402 || r['ended'] == true) {
      _end(reason: r['status'] == 402 ? 'insufficient_avacoins' : 'server');
    }
  }

  Future<void> _end({String reason = 'user'}) async {
    if (_state == 'ended') return;
    _tick?.cancel();
    _beat?.cancel();
    setState(() => _state = 'ended');
    await _engine.stop();
    final s = _sessionId;
    if (s != null) await AvaVisionApi.sessionStop(s, reason: reason);
    if (!mounted) return;
    final billed = (_elapsedSec / 60).ceil();
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (d) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rLg),
            side: const BorderSide(color: AD.borderControl, width: 1)),
        titleTextStyle: ADText.threadName().copyWith(fontSize: 20, height: 1.1, letterSpacing: -0.2),
        contentTextStyle: ADText.preview().copyWith(fontSize: 14, height: 1.42),
        title: const Text('Session ended'),
        content: Text(a.isFreeForCallers
            ? 'You trained with ${a.name} for ${_fmt(_elapsedSec)}. This session was free — the creator covered it.'
            : 'You trained with ${a.name} for ${_fmt(_elapsedSec)}.\n\nBilled: $billed min × ${fmtCoins(perMinuteCoins(a.ratePerHourCoins))} = ${fmtCoins(billed * perMinuteCoins(a.ratePerHourCoins))}. Any unused escrow is refunded to your AvaWallet.'),
        actions: [
          TextButton(
            onPressed: () { Navigator.pop(d); Navigator.pop(context); },
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  String _fmt(int sec) {
    final m = sec ~/ 60, s = sec % 60;
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  // ── snapshot ("Analyze my form") ───────────────────────────────────────────
  Future<void> _analyze() async {
    if (_snapInFlight || _capReached || !_snapEnabled) return;
    setState(() => _snapInFlight = true);
    final r = await _engine.analyze();
    if (!mounted) { _snapInFlight = false; return; }
    setState(() => _snapInFlight = false);

    final status = (r['status'] as num?)?.toInt() ?? 0;
    if (status == 429 || r['error']?.toString() == 'SNAPSHOT_CAP_REACHED') {
      setState(() => _snapUsed = _snapCap); // lock the button
      _showCapReached();
      return;
    }
    if (status != 200) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(r['detail']?.toString() ??
              (status == 402 ? 'Not enough Tokens for a deep analysis.' : 'Analysis failed — try again.'))));
      return;
    }
    setState(() => _snapUsed += 1);
    final result = VisionSnapshotResult.fromJson(r);
    _showSnapshotSheet(result);
  }

  void _showCapReached() {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (_) => _Sheet(child: Column(mainAxisSize: MainAxisSize.min, children: [
        ZineIconBadge(icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold), color: AD.tabCalls),
        const SizedBox(height: Msg.s3),
        Text('Deep analyses used up', style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
        const SizedBox(height: 8),
        Text(
          'You\'ve used all ${_snapCap == 1 ? 'your' : 'the $_snapCap'} free "Analyze my form" check${_snapCap == 1 ? '' : 's'} for this session — no charge. Your coach keeps guiding you live with the on-screen score.',
          textAlign: TextAlign.center, style: ADText.preview().copyWith(fontSize: 14, height: 1.42),
        ),
        const SizedBox(height: Msg.s4),
        ZineButton(label: 'Keep training', fullWidth: true,
            onPressed: () => Navigator.pop(context)),
      ])),
    );
  }

  void _showSnapshotSheet(VisionSnapshotResult res) {
    bool saved = false;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => StatefulBuilder(builder: (ctx, setSheet) {
        final bytes = _decodeImage(res.annotatedImage);
        return _Sheet(child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Text('Form analysis', style: ADText.threadName().copyWith(fontSize: 19, height: 1.1, letterSpacing: -0.2)),
              const Spacer(),
              if (res.score != null)
                _Badge('${a.scoreLabel ?? 'Score'} ${res.score!.round()}'),
            ]),
            const SizedBox(height: Msg.s3),
            if (bytes != null)
              ClipRRect(
                borderRadius: BorderRadius.circular(Msg.rLg),
                child: Container(
                  decoration: BoxDecoration(border: Border.all(color: AD.borderControl, width: 1), borderRadius: BorderRadius.circular(Msg.rLg)),
                  child: Image.memory(bytes, fit: BoxFit.cover),
                ),
              ),
            const SizedBox(height: Msg.s3),
            if (res.breakdown.isNotEmpty)
              Text(res.breakdown, style: ADText.preview().copyWith(fontSize: 14, height: 1.42)),
            const SizedBox(height: 16),
            // Saving is OFF by default and per-account scoped (rulebook #1/#3).
            Row(children: [
              Expanded(child: Text('Save to my device', style: ADText.tabLabel().copyWith(fontSize: 13, letterSpacing: 0.52))),
              ZineToggle(
                value: saved,
                onChanged: bytes == null ? null : (v) async {
                  if (v) await _saveSnapshotScoped(bytes);
                  setSheet(() => saved = v);
                },
              ),
            ]),
            const SizedBox(height: 16),
            ZineButton(label: 'Back to session', fullWidth: true,
                onPressed: () => Navigator.pop(context)),
          ]),
        ));
      }),
    );
  }

  static Uint8List? _decodeImage(String s) {
    if (s.isEmpty) return null;
    try {
      final b64 = s.startsWith('data:') ? s.substring(s.indexOf(',') + 1) : s;
      return base64Decode(b64);
    } catch (_) {
      return null;
    }
  }

  /// Per-account scoped save (rulebook: never a raw global path; parent + child
  /// share one phone). Off by default — only runs when the user flips the toggle.
  Future<void> _saveSnapshotScoped(Uint8List bytes) async {
    try {
      final root = await getApplicationSupportDirectory();
      final scope = (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
      final dir = Directory('${root.path}/avavision_snapshots/$scope');
      await dir.create(recursive: true);
      final f = File('${dir.path}/${DateTime.now().millisecondsSinceEpoch}.jpg');
      await f.writeAsBytes(bytes);
    } catch (_) {/* best-effort; failure is non-fatal */}
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final remaining = (_limitMinutes * 60 - _elapsedSec).clamp(0, kMaxSessionMinutes * 60);
    final live = _state == 'live' || _state == 'wrapup';
    return Scaffold(
      backgroundColor: AD.bg,
      body: Stack(fit: StackFit.expand, children: [
        // 1) Camera + overlay (the "main" view).
        if (live) _cameraLayer() else Container(color: AD.bg),

        // 2) Top chips: language + countdown.
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Column(children: [
              Row(children: [
                _chip(PhosphorIcons.translate(PhosphorIconsStyle.bold), _langLabel(widget.language)),
                const Spacer(),
                _chip(PhosphorIcons.timer(PhosphorIconsStyle.bold),
                    live ? '-${_fmt(remaining)}' : '--:--', alert: _state == 'wrapup'),
              ]),
              const SizedBox(height: Msg.s2),
              if (live) _seenIndicator(),
            ]),
          ),
        ),

        // 3) Score badge (transparent, technique only).
        if (live && a.scoringMode != 'none') Positioned(
          left: 16, bottom: 150, child: _scoreBadge(),
        ),

        // 4) Agent thumbnail (avatar + voice indicator).
        if (live) Positioned(right: 16, top: 96, child: _agentThumb()),

        // 5) Connecting / error overlays.
        if (_state == 'connecting' || _state == 'consent') _statusOverlay('Connecting to ${a.name}…'),
        if (_state == 'error') _errorOverlay(),

        // 6) Bottom controls.
        if (live) Align(alignment: Alignment.bottomCenter, child: _controls()),
      ]),
    );
  }

  Widget _cameraLayer() => ValueListenableBuilder<VisionFrame>(
        valueListenable: _engine.frame,
        builder: (_, frame, __) {
          final painter = overlayPainterFor(a.overlayStyle, frame);
          return Stack(fit: StackFit.expand, children: [
            VisionCameraView(creationParams: {
              'capability': a.capability,
              'overlay_style': a.overlayStyle,
              'lens_facing': 'front',
            }),
            if (painter != null) CustomPaint(painter: painter),
          ]);
        },
      );

  // "The agent can see you" persistent indicator (master §6 / rule 10).
  Widget _seenIndicator() => Align(
        alignment: Alignment.center,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: BorderRadius.circular(Msg.rPill),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: Msg.none,
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.fill), size: 13, color: AD.danger),
            const SizedBox(width: Msg.s1),
            Text('${a.name} can see you',
                style: ADText.tabLabel(c: AD.textPrimary).copyWith(fontSize: 11, letterSpacing: 0.44)),
          ]),
        ),
      );

  Widget _scoreBadge() {
    final showAgent = a.scoringMode == 'gemini_qualitative';
    final vn = showAgent ? _engine.agentScore : _engine.localScore;
    return ValueListenableBuilder<int?>(
      valueListenable: vn,
      builder: (_, score, __) {
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: BoxDecoration(
            color: AD.card.withValues(alpha: .92),
            borderRadius: BorderRadius.circular(Msg.rMd),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: Msg.none,
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(a.scoreLabel ?? 'Score', style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 10, letterSpacing: 0.8)),
            const SizedBox(height: 2),
            Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
              Text(score?.toString() ?? '—', style: ADText.appTitle().copyWith(fontSize: 30, height: 1.08, letterSpacing: -0.6)),
              if (a.scoringMode == 'hybrid' && showAgent == false)
                Padding(
                  padding: const EdgeInsets.only(left: 6, bottom: 4),
                  child: Text('live', style: ADText.sectionLabel(c: AD.textTertiary).copyWith(fontSize: 9, letterSpacing: 0.72)),
                ),
            ]),
          ]),
        );
      },
    );
  }

  Widget _agentThumb() => Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: AD.tabCalls,
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
        ),
        child: Stack(alignment: Alignment.bottomCenter, children: [
          Avatar(seed: a.id, name: a.name, size: 64, avatarUrl: a.avatarUrl),
          // Voice indicator: pulses while the agent is talking back.
          ValueListenableBuilder<String>(
            valueListenable: _engine.caption,
            builder: (_, cap, __) => cap.isEmpty
                ? const SizedBox.shrink()
                : Positioned(
                    bottom: -2,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                        color: AD.primaryBadge,
                        borderRadius: BorderRadius.circular(Msg.rPill),
                        border: Border.all(color: AD.borderControl, width: 1),
                      ),
                      child: PhosphorIcon(PhosphorIcons.waveform(PhosphorIconsStyle.bold),
                          size: 12, color: Colors.white),
                    ),
                  ),
          ),
        ]),
      );

  Widget _controls() => Padding(
        padding: const EdgeInsets.only(bottom: 34),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_snapEnabled) ...[
            _AnalyzeButton(
              inFlight: _snapInFlight,
              capReached: _capReached,
              remaining: _snapCap - _snapUsed,
              cap: _snapCap,
              onTap: _analyze,
            ),
            const SizedBox(height: 16),
          ],
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            _roundBtn(PhosphorIcons.cameraRotate(PhosphorIconsStyle.bold),
                () => _engine.flipCamera()),
            const SizedBox(width: 16),
            ValueListenableBuilder<bool>(
              valueListenable: _engine.muted,
              builder: (_, muted, __) => _roundBtn(
                muted
                    ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                    : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                () => _engine.toggleMute(),
                active: muted,
              ),
            ),
            const SizedBox(width: 16),
            _roundBtn(PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.bold),
                () => _end(reason: 'user'), large: true, danger: true),
          ]),
        ]),
      );

  Widget _statusOverlay(String msg) => Container(
        color: AD.bg,
        alignment: Alignment.center,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const CircularProgressIndicator(color: AD.primaryBadge),
          const SizedBox(height: Msg.s4),
          Text(msg, style: ADText.preview(c: AD.textPrimary).copyWith(fontSize: 14, height: 1.42)),
        ]),
      );

  Widget _errorOverlay() => Container(
        color: AD.bg,
        alignment: Alignment.center,
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineIconBadge(icon: PhosphorIcons.warning(PhosphorIconsStyle.bold), color: AD.danger),
            const SizedBox(height: 16),
            Text(_error ?? 'Something went wrong',
                textAlign: TextAlign.center, style: ADText.preview(c: AD.textPrimary).copyWith(fontSize: 15, height: 1.42)),
            const SizedBox(height: Msg.s5),
            ZineButton(
              label: 'Back',
              onPressed: () => Navigator.of(context).maybePop(),
              variant: ZineButtonVariant.ghost,
            ),
          ]),
        ),
      );

  Widget _chip(IconData icon, String label, {bool alert = false}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
        decoration: BoxDecoration(
          color: alert ? AD.danger : AD.card,
          borderRadius: BorderRadius.circular(Msg.rPill),
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(icon, size: 14, color: alert ? Colors.white : AD.textPrimary),
          const SizedBox(width: Msg.s1),
          Text(label,
              style: ADText.tabLabel(c: alert ? Colors.white : AD.textPrimary).copyWith(fontSize: 11, letterSpacing: 0.44)),
        ]),
      );

  Widget _roundBtn(IconData icon, VoidCallback onTap,
          {bool large = false, bool danger = false, bool active = false}) =>
      ZinePressable(
        onTap: onTap,
        color: danger ? AD.danger : (active ? AD.primaryBadge : AD.card),
        radius: BorderRadius.circular(Msg.rPill),
        boxShadow: Msg.none,
        child: SizedBox(
          width: large ? 64 : 52, height: large ? 64 : 52,
          child: Center(
            child: PhosphorIcon(icon, size: large ? 28 : 22, color: danger ? Colors.white : AD.textPrimary),
          ),
        ),
      );

  // Minimal language label (avoids importing Phase-2/avavoice catalogs). Falls
  // back to the raw code, which is acceptable for a chip.
  String _langLabel(String code) => switch (code) {
        'en-US' || 'en-GB' || 'en-IN' => 'English',
        'es-ES' || 'es-MX' => 'Español',
        'pt-BR' => 'Português',
        'fr-FR' => 'Français',
        'de-DE' => 'Deutsch',
        'hi-IN' => 'हिन्दी',
        'ja-JP' => '日本語',
        'ko-KR' => '한국어',
        'cmn-CN' => '中文',
        _ => code,
      };
}

// ── small private widgets ─────────────────────────────────────────────────────

class _Badge extends StatelessWidget {
  final String text;
  const _Badge(this.text);
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: AD.primaryBadge,
          borderRadius: BorderRadius.circular(Msg.rPill),
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
        ),
        child: Text(_sentence(text), style: ADText.tabLabel().copyWith(fontSize: 12, letterSpacing: 0.48)),
      );
}

class _Sheet extends StatelessWidget {
  final Widget child;
  const _Sheet({required this.child});
  @override
  Widget build(BuildContext context) => Container(
        padding: EdgeInsets.fromLTRB(20, 18, 20, 20 + MediaQuery.of(context).padding.bottom),
        decoration: const BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brSheetTop,
          border: Border(
            top: BorderSide(color: AD.borderControl, width: 1),
            left: BorderSide(color: AD.borderControl, width: 1),
            right: BorderSide(color: AD.borderControl, width: 1),
          ),
        ),
        child: child,
      );
}

class _AnalyzeButton extends StatelessWidget {
  final bool inFlight, capReached;
  final int remaining, cap;
  final VoidCallback onTap;
  const _AnalyzeButton({
    required this.inFlight,
    required this.capReached,
    required this.remaining,
    required this.cap,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final label = capReached
        ? 'Deep analyses used up'
        : inFlight
            ? 'Analyzing…'
            : 'Analyze my form';
    return ZineButton(
      label: label,
      icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
      trailingIcon: false,
      loading: inFlight,
      variant: ZineButtonVariant.blue,
      onPressed: (capReached || inFlight) ? null : onTap,
    );
  }
}

class _ConsentSheet extends StatelessWidget {
  final String agentName;
  const _ConsentSheet({required this.agentName});
  @override
  Widget build(BuildContext context) => _Sheet(child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(child: ZineIconBadge(
              icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), color: AD.tabCalls)),
          const SizedBox(height: Msg.s3),
          Text('Turn on your camera?', textAlign: TextAlign.center, style: ADText.threadName().copyWith(fontSize: 20, height: 1.1, letterSpacing: -0.2)),
          const SizedBox(height: Msg.s2),
          Text(
            '$agentName is a vision coach. While you train, it sees a low-resolution view (about one frame a second) and hears you, so it can guide your technique. An on-device overlay tracks your movement — that part never leaves your phone. It only coaches technique, never judges your appearance, and you can stop anytime.',
            textAlign: TextAlign.center, style: ADText.preview().copyWith(fontSize: 14, height: 1.42),
          ),
          const SizedBox(height: Msg.s4),
          ZineButton(
            label: 'I understand — start',
            fullWidth: true,
            icon: PhosphorIcons.check(PhosphorIconsStyle.bold),
            onPressed: () => Navigator.pop(context, true),
          ),
          const SizedBox(height: Msg.s2),
          Center(child: ZineLink('Not now', onTap: () => Navigator.pop(context, false))),
        ],
      ));
}
