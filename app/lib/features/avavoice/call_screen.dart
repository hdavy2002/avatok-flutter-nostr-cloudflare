import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/theme.dart';
import 'widgets.dart';

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
          402 => 'Not enough AvaCoins to start this call.',
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
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
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
    return Scaffold(
      backgroundColor: const Color(0xFF14101F),
      body: SafeArea(
        child: Column(children: [
          const SizedBox(height: 12),
          // Top bar: language + timer chips.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Row(children: [
              _chip(Icons.translate, languageLabel(widget.language)),
              const Spacer(),
              _chip(Icons.timer_outlined,
                  _state == 'live' || _state == 'wrapup' ? '-${_fmt(remaining)}' : '--:--',
                  color: _state == 'wrapup' ? AvaColors.coral : null),
            ]),
          ),
          const Spacer(),
          // Agent identity + animated ring.
          _PulsingRing(active: _state == 'live' || _state == 'wrapup',
              child: Avatar(seed: a.id, name: a.name, size: 120, avatarUrl: a.avatarUrl)),
          const SizedBox(height: 20),
          Text(a.name, style: const TextStyle(
              color: Colors.white, fontWeight: FontWeight.w800, fontSize: 22)),
          const SizedBox(height: 6),
          Text(a.role, textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white60, fontSize: 13)),
          const SizedBox(height: 14),
          Text(
            switch (_state) {
              'connecting' => 'Connecting…',
              'live' => _fmt(_elapsedSec),
              'wrapup' => '${_fmt(_elapsedSec)} · wrapping up soon',
              'error' => _error ?? 'Connection failed',
              _ => 'Call ended',
            },
            textAlign: TextAlign.center,
            style: TextStyle(
                color: _state == 'error' ? AvaColors.coral : Colors.white70,
                fontWeight: FontWeight.w700, fontSize: 15),
          ),
          if (_state == 'wrapup')
            const Padding(
              padding: EdgeInsets.fromLTRB(32, 10, 32, 0),
              child: Text('Time is almost up — the agent will wrap up politely. You can book another session to continue.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white54, fontSize: 12)),
            ),
          const Spacer(),
          // Controls.
          Padding(
            padding: const EdgeInsets.only(bottom: 28),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              if (a.visionEnabled) ...[
                _roundBtn(Icons.screen_share_outlined, Colors.white12, () {
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                      content: Text('Screen sharing arrives with the live audio engine (Phase 4).')));
                }),
                const SizedBox(width: 18),
              ],
              _roundBtn(_muted ? Icons.mic_off : Icons.mic, Colors.white12,
                  () => setState(() => _muted = !_muted)),
              const SizedBox(width: 18),
              _roundBtn(Icons.call_end, AvaColors.danger,
                  _state == 'error' || _state == 'ended'
                      ? () => Navigator.pop(context)
                      : () => _end(reason: 'user'),
                  large: true),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _chip(IconData icon, String label, {Color? color}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
            color: (color ?? Colors.white).withValues(alpha: .12),
            borderRadius: BorderRadius.circular(20)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 14, color: color ?? Colors.white70),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(
              color: color ?? Colors.white70, fontWeight: FontWeight.w800, fontSize: 12)),
        ]),
      );

  Widget _roundBtn(IconData icon, Color bg, VoidCallback onTap, {bool large = false}) =>
      InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: Container(
          width: large ? 70 : 56, height: large ? 70 : 56,
          decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
          child: Icon(icon, color: Colors.white, size: large ? 30 : 24),
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
            color: kAvaVoicePurple.withValues(alpha: .25 + .35 * (1 - (_c.value - .5).abs() * 2)),
            width: 3 + 3 * (1 - (_c.value - .5).abs() * 2),
          ),
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}
