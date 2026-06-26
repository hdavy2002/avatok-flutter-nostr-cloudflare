import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// In-call UI for a voice agent session.
///
/// Lifecycle (spec §3.2/§3.3): sessions/start → 60 s heartbeats →
/// sessions/stop. The countdown mirrors the server-side hard cap; the agent
/// itself wraps up politely via the platform prompt layer, and the
/// VoiceSessionDO alarm is the final backstop.
///
/// NOTE: the realtime Gemini Live audio engine (mic → WS → speaker) lands in
/// build Phase 3; this screen drives the full session/billing lifecycle and
/// shows a clear status while the audio engine is being wired.
class VoiceCallScreen extends StatefulWidget {
  final VoiceAgent agent;
  final String language;
  final String? bookingId;
  final String? callId; // from /calls/now
  const VoiceCallScreen({super.key, required this.agent, required this.language,
      this.bookingId, this.callId});
  @override
  State<VoiceCallScreen> createState() => _VoiceCallScreenState();
}

class _VoiceCallScreenState extends State<VoiceCallScreen> {
  String _state = 'connecting'; // connecting | live | wrapup | ended | error
  String? _error;
  String? _sessionId;
  int _limitMinutes = kMaxSessionMinutes;
  int _elapsedSec = 0;
  bool _muted = false;
  Timer? _tick, _beat;

  VoiceAgent get a => widget.agent;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavoice', 'call',
        from: widget.bookingId != null ? 'booking' : 'call_now');
    _start();
  }

  @override
  void dispose() {
    _tick?.cancel();
    _beat?.cancel();
    final s = _sessionId;
    if (s != null && _state != 'ended') {
      // Fire-and-forget: never leave a slot/billing hanging on swipe-away.
      AvaVoiceApi.sessionStop(s, reason: 'user');
    }
    super.dispose();
  }

  Future<void> _start() async {
    final r = await AvaVoiceApi.sessionStart(
        bookingId: widget.bookingId, callId: widget.callId, language: widget.language);
    if (!mounted) return;
    Analytics.capture('avavoice_session_connect_result', {
      'agent': a.id, 'status': (r['status'] as num?)?.toInt() ?? 0,
      'language': widget.language, 'kind': widget.bookingId != null ? 'booking' : 'call_now',
    });
    if (r['status'] != 200) {
      setState(() {
        _state = 'error';
        _error = switch (r['status']) {
          402 => 'Not enough Tokens to start this call.',
          409 => '${a.name} is busy on all lines — please try again shortly.',
          _ => r['detail']?.toString() ?? r['error']?.toString() ?? 'Could not connect.',
        };
      });
      return;
    }
    final t = VoiceSessionTicket.fromJson(r);
    setState(() {
      _sessionId = t.sessionId;
      _limitMinutes = t.limitMinutes.clamp(1, kMaxSessionMinutes);
      _state = 'live';
    });
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
    _beat = Timer.periodic(const Duration(seconds: 60), (_) => _heartbeat());
    // TODO(phase 3): hand t.geminiToken + t.model to the Gemini Live audio
    // engine (mic 16 kHz PCM → WS, play 24 kHz output, vision frames when
    // a.visionEnabled). Session/billing lifecycle is fully active already.
  }

  void _onTick() {
    if (!mounted) return;
    setState(() {
      _elapsedSec++;
      final remaining = _limitMinutes * 60 - _elapsedSec;
      if (remaining <= 120 && _state == 'live') {
        _state = 'wrapup';
        Analytics.capture('avavoice_wrapup_shown',
            {'agent': a.id, 'elapsed_sec': _elapsedSec, 'limit_min': _limitMinutes});
      }
      if (remaining <= 0) _end(reason: 'hard_cap');
    });
  }

  Future<void> _heartbeat() async {
    final s = _sessionId;
    if (s == null) return;
    final r = await AvaVoiceApi.sessionHeartbeat(s);
    if (!mounted) return;
    if (r['status'] == 402 || r['ended'] == true) {
      _end(reason: r['status'] == 402 ? 'insufficient_avacoins' : 'server');
    }
  }

  Future<void> _end({String reason = 'user'}) async {
    if (_state == 'ended') return;
    _tick?.cancel();
    _beat?.cancel();
    setState(() => _state = 'ended');
    Analytics.capture('avavoice_call_ended_client', {
      'agent': a.id, 'reason': reason, 'seconds': _elapsedSec,
      'limit_min': _limitMinutes, 'language': widget.language, 'muted': _muted,
    });
    final s = _sessionId;
    if (s != null) await AvaVoiceApi.sessionStop(s, reason: reason);
    if (!mounted) return;
    final billed = (_elapsedSec / 60).ceil();
    showDialog(context: context, barrierDismissible: false, builder: (d) => AlertDialog(
      backgroundColor: Zine.card,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: const BorderSide(color: Zine.ink, width: Zine.bw)),
      titleTextStyle: ZineText.cardTitle(size: 20),
      contentTextStyle: ZineText.sub(size: 14),
      title: const Text('Call ended'),
      content: Text(a.isFreeForCallers
          ? 'You talked with ${a.name} for ${_fmt(_elapsedSec)}. This call was free — the creator covered it.'
          : 'You talked with ${a.name} for ${_fmt(_elapsedSec)}.\n\nBilled: $billed min × ${fmtCoins(perMinuteCoins(a.ratePerHourCoins))} = ${fmtCoins(billed * perMinuteCoins(a.ratePerHourCoins))}. Any unused escrow is refunded to your AvaWallet.'),
      actions: [TextButton(
          onPressed: () { Navigator.pop(d); Navigator.pop(context); },
          child: const Text('Done'))],
    ));
  }

  String _fmt(int sec) {
    final m = sec ~/ 60, s = sec % 60;
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final remaining = (_limitMinutes * 60 - _elapsedSec).clamp(0, kMaxSessionMinutes * 60);
    // Voice-agent call = paper screen: lilac AI crest, mono state stickers,
    // zine bordered control circles, coral hang-up.
    return Scaffold(
      backgroundColor: Zine.paper,
      body: ZinePaper(
        child: SafeArea(
          child: Column(children: [
            const SizedBox(height: 14),
            // Top bar: language + timer mono stickers.
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: Row(children: [
                _chip(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                    languageLabel(widget.language)),
                const Spacer(),
                _chip(PhosphorIcons.timer(PhosphorIconsStyle.bold),
                    _state == 'live' || _state == 'wrapup' ? '-${_fmt(remaining)}' : '--:--',
                    alert: _state == 'wrapup'),
              ]),
            ),
            const Spacer(),
            // Agent identity — lilac AI crest with ink ring + hard shadow.
            _PulsingRing(
              active: _state == 'live' || _state == 'wrapup',
              child: Container(
                padding: const EdgeInsets.all(6),
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: Zine.lilac,
                  border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bwLg)),
                  boxShadow: Zine.shadow,
                ),
                child: Avatar(seed: a.id, name: a.name, size: 116, avatarUrl: a.avatarUrl),
              ),
            ),
            const SizedBox(height: 22),
            Text(a.name, textAlign: TextAlign.center, style: ZineText.hero(size: 28)),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(a.role, textAlign: TextAlign.center, style: ZineText.sub(size: 13)),
            ),
            const SizedBox(height: 16),
            if (_state == 'error')
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 32),
                child: Text(_error ?? 'Connection failed',
                    textAlign: TextAlign.center,
                    style: ZineText.tag(size: 12, color: Zine.coral)),
              )
            else
              ZineSticker(
                switch (_state) {
                  'connecting' => 'connecting…',
                  'live' => _fmt(_elapsedSec),
                  'wrapup' => '${_fmt(_elapsedSec)} · wrapping up',
                  _ => 'call ended',
                },
                kind: _state == 'wrapup' ? ZineStickerKind.no : ZineStickerKind.plain,
              ),
            if (_state == 'wrapup')
              Padding(
                padding: const EdgeInsets.fromLTRB(32, 12, 32, 0),
                child: Text(
                    'Time is almost up — the agent will wrap up politely. You can book another session to continue.',
                    textAlign: TextAlign.center,
                    style: ZineText.sub(size: 12)),
              ),
            const Spacer(),
            // Controls — bordered circles; hang-up = coral.
            Padding(
              padding: const EdgeInsets.only(bottom: 30),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                if (a.visionEnabled) ...[
                  _roundBtn(PhosphorIcons.monitor(PhosphorIconsStyle.bold), () {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                        content: Text('Screen sharing arrives with the live audio engine (Phase 4).')));
                  }),
                  const SizedBox(width: 18),
                ],
                _roundBtn(
                    _muted
                        ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.bold)
                        : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
                    () => setState(() => _muted = !_muted),
                    active: _muted),
                const SizedBox(width: 18),
                _roundBtn(
                    PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.bold),
                    _state == 'error' || _state == 'ended'
                        ? () => Navigator.pop(context)
                        : () => _end(reason: 'user'),
                    large: true, danger: true),
              ]),
            ),
          ]),
        ),
      ),
    );
  }

  // Mono sticker chip — ink border, hard shadow; coral when alerting.
  Widget _chip(IconData icon, String label, {bool alert = false}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
        decoration: BoxDecoration(
          color: alert ? Zine.coral : Zine.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 2),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(icon, size: 14, color: alert ? Colors.white : Zine.ink),
          const SizedBox(width: 6),
          Text(label.toUpperCase(),
              style: ZineText.tag(size: 11, color: alert ? Colors.white : Zine.ink)),
        ]),
      );

  // Zine control circle — card fill (lime when active toggle), coral = hang-up.
  Widget _roundBtn(IconData icon, VoidCallback onTap,
          {bool large = false, bool danger = false, bool active = false}) =>
      ZinePressable(
        onTap: onTap,
        color: danger ? Zine.coral : (active ? Zine.lime : Zine.card),
        radius: BorderRadius.circular(100),
        boxShadow: large ? Zine.shadowSm : Zine.shadowXs,
        child: SizedBox(
          width: large ? 64 : 52, height: large ? 64 : 52,
          child: Center(
            child: PhosphorIcon(icon,
                size: large ? 28 : 22, color: danger ? Colors.white : Zine.ink),
          ),
        ),
      );
}

class _PulsingRing extends StatefulWidget {
  final Widget child;
  final bool active;
  const _PulsingRing({required this.child, required this.active});
  @override
  State<_PulsingRing> createState() => _PulsingRingState();
}

class _PulsingRingState extends State<_PulsingRing>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(seconds: 2))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) return widget.child;
    return AnimatedBuilder(
      animation: _c,
      builder: (_, child) => Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(
            // Flat lilac ring (AI accent), alpha-pulsed — no gradients.
            color: Zine.lilac.withValues(alpha: .25 + .45 * (1 - (_c.value - .5).abs() * 2)),
            width: 3 + 3 * (1 - (_c.value - .5).abs() * 2),
          ),
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}
