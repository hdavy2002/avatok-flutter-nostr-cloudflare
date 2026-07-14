import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'avadial_channel.dart';
import 'avadial_theme.dart';
import 'block_list.dart';
import 'device_contacts.dart';
import 'in_call_screen.dart';

/// The spam-shield paint bucket for an incoming PSTN call (plan §4.3).
enum PstnColor { red, green, blue }

/// Full-screen incoming PSTN call screen (plan §4.3). Painted from the reputation
/// score + the device phone book:
///   - RED   — known spammer (score >= warn threshold): warning UI, default Decline.
///   - GREEN — a device contact: friendly, name + avatar.
///   - BLUE  — unknown: neutral, Answer · Decline · Block · Report spam.
///
/// All actions route through [AvaDialChannel] (answer/reject) + [BlockList]
/// (block/report). No raw phone number reaches analytics — only the colour bucket.
class PstnCallScreen extends StatefulWidget {
  /// Native call id (from [AvaCallEvent.id]) — targets the right [Call] for
  /// answer/reject. Null in a preview/no-active-call context (buttons then only
  /// dismiss).
  final String? callId;
  final String number;

  /// Community spam score 0..100 (from the snapshot / lookup); null = unknown.
  final int? spamScore;

  /// Warn threshold above which a score paints RED (mirrors the snapshot value).
  final int warnThreshold;

  const PstnCallScreen({
    super.key,
    required this.number,
    this.callId,
    this.spamScore,
    this.warnThreshold = 70,
  });

  @override
  State<PstnCallScreen> createState() => _PstnCallScreenState();
}

class _PstnCallScreenState extends State<PstnCallScreen> {
  DeviceContact? _contact;
  late PstnColor _color;

  // [AVADIAL-HARDEN-1] Guards against a caller hanging up while this screen is
  // still showing live Answer/Decline buttons, and against navigating to the
  // active-call UI before native confirms the call actually connected.
  StreamSubscription<AvaCallEvent>? _callSub;
  StreamSubscription<String>? _removedSub;
  bool _closed = false;
  bool _answering = false;
  Timer? _answerTimeout;

  @override
  void initState() {
    super.initState();
    _contact = DeviceContacts.I.lookup(widget.number);
    _color = _resolveColor();
    Analytics.capture('pstn_call_screen_shown', {'color': _color.name});

    // [AVADIAL-HARDEN-1] Mirror InCallScreen's subscription pattern so this
    // screen reacts to the call dying (or connecting) while it's up.
    _callSub = AvaDialChannel.I.calls.listen(_onCallEvent);
    _removedSub = AvaDialChannel.I.removedCalls.listen(_onCallRemoved);

    // [AVADIAL-STUCK-1] Stale-launch guard: this screen can be pushed from a
    // pending launch extra recorded while the app was backgrounded/dead. If the
    // call already ended, no onCallRemoved will EVER arrive (the removal predates
    // our listeners) — probe native once and self-close instead of sitting on a
    // ghost ringing screen (owner bug 2026-07-14).
    final id = widget.callId;
    if (id != null) {
      AvaDialChannel.I.callState(id).then((state) {
        if (!mounted || _closed) return;
        if (state == null || state == 'disconnected' || state == 'disconnecting') {
          _autoClose('stale_launch');
        }
      });
    }
  }

  @override
  void dispose() {
    _callSub?.cancel();
    _removedSub?.cancel();
    _answerTimeout?.cancel();
    super.dispose();
  }

  // [AVADIAL-HARDEN-1] Answer waits here for the native 'active' state before
  // navigating; any other event (or a remove) just tracks/auto-closes.
  void _onCallEvent(AvaCallEvent e) {
    if (widget.callId == null || e.id != widget.callId) return;
    // [AVADIAL-HARDEN-2] Transition to the in-call UI on a real native 'active'
    // event regardless of _answering — the call can be answered from the
    // notification action (or another surface) while this ringing screen is
    // still visible, not just via this screen's own Answer button. The
    // failed-answer 10s timeout below is unaffected: it only resets
    // _answering, it never fires navigation itself.
    if (e.state == 'active') {
      _answerTimeout?.cancel();
      _goActive();
      return;
    }
    if (e.state == 'disconnected' || e.state == 'disconnecting') {
      _autoClose(e.state);
    }
  }

  void _onCallRemoved(String id) {
    if (widget.callId == null || id != widget.callId) return;
    _autoClose('removed');
  }

  void _goActive() {
    if (_closed || !mounted) return;
    _closed = true;
    final id = widget.callId!;
    Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => InCallScreen(callId: id, number: widget.number, initialState: 'active'),
    ));
  }

  // [AVADIAL-HARDEN-1] Pops the screen once (guarded by _closed) when the call
  // dies out from under it — most commonly the caller hanging up while ringing.
  void _autoClose(String state) {
    if (_closed || !mounted) return;
    _closed = true;
    _answerTimeout?.cancel();
    Analytics.capture('pstn_call_missed_closed', {'state': state});
    if (Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  PstnColor _resolveColor() {
    final score = widget.spamScore;
    if (score != null && score >= widget.warnThreshold) return PstnColor.red;
    if (_contact != null) return PstnColor.green;
    return PstnColor.blue;
  }

  Color get _accent => switch (_color) {
        PstnColor.red => AD.danger,
        PstnColor.green => AD.incomingCall,
        PstnColor.blue => AD.iconSearch,
      };

  // [AVADIAL-HARDEN-1] Don't navigate on tap — wait for native to actually
  // confirm the call is 'active' (see _onCallEvent) so a failed/late answer()
  // never strands the user on a blank InCallScreen. 10s timeout falls back to
  // re-showing this screen as ringing rather than crashing/hanging.
  Future<void> _answer() async {
    final id = widget.callId;
    if (id == null) {
      _close();
      return;
    }
    if (_answering) return;
    setState(() => _answering = true);
    await AvaDialChannel.I.answer(id);
    if (!mounted || _closed) return;
    _answerTimeout?.cancel();
    _answerTimeout = Timer(const Duration(seconds: 10), () {
      if (!mounted || _closed || !_answering) return;
      setState(() => _answering = false);
    });
  }

  Future<void> _decline() async {
    final id = widget.callId;
    if (id != null) await AvaDialChannel.I.reject(id);
    _close();
  }

  Future<void> _block() async {
    await BlockList.I.block(widget.number, reportedSpam: false);
    await _decline();
  }

  Future<void> _reportSpam() async {
    await BlockList.I.reportSpam(widget.number);
    await _decline();
  }

  void _close() {
    if (_closed || !mounted) return;
    _closed = true;
    _answerTimeout?.cancel();
    if (Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // Dedicated dark PSTN screen (owner request 2026-07-12) — separate from,
      // and never replaced by, the AvaTalk/messenger call UI. Color-coded by
      // caller-id bucket: red = spam, green = known contact, blue = unknown.
      backgroundColor: AvaDialTheme.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 28),
          child: Column(
            children: [
              const Spacer(),
              _header(),
              const SizedBox(height: 24),
              if (_color == PstnColor.red) _redBanner(),
              const Spacer(),
              _actions(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header() {
    final name = _contact?.name;
    final kicker = switch (_color) {
      PstnColor.red => 'SUSPECTED SPAM',
      PstnColor.green => 'INCOMING CALL',
      PstnColor.blue => 'UNKNOWN NUMBER',
    };
    return Column(children: [
      Container(
        width: 108,
        height: 108,
        decoration: BoxDecoration(
          color: _accent,
          shape: BoxShape.circle,
          border: Border.all(color: AvaDialTheme.border, width: 2),
          boxShadow: const <BoxShadow>[],
        ),
        child: Icon(
          _color == PstnColor.red
              ? PhosphorIcons.warning(PhosphorIconsStyle.fill)
              : PhosphorIcons.phoneIncoming(PhosphorIconsStyle.fill),
          size: 52,
          color: Colors.white,
        ),
      ),
      const SizedBox(height: 20),
      Text(kicker, style: ZineText.kicker(color: _accent == AD.danger ? AD.danger : AvaDialTheme.textSoft)),
      const SizedBox(height: 6),
      Text(
        name ?? widget.number,
        textAlign: TextAlign.center,
        style: ZineText.hero(size: 30, color: AvaDialTheme.text),
      ),
      if (name != null) ...[
        const SizedBox(height: 4),
        Text(widget.number, style: ZineText.sub(size: 15, color: AvaDialTheme.textSoft)),
      ],
    ]);
  }

  Widget _redBanner() => AdCard(
        color: AvaDialTheme.surface2,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold), color: AD.danger),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              widget.spamScore != null
                  ? 'Reported by the community (score ${widget.spamScore}). '
                      'We recommend declining.'
                  : 'This number has been reported as spam. We recommend declining.',
              style: ZineText.sub(size: 13.5, color: AvaDialTheme.text),
            ),
          ),
        ]),
      );

  Widget _actions() {
    switch (_color) {
      case PstnColor.red:
        // Default action = Decline (prominent). Answer-anyway is secondary.
        return Column(children: [
          AdButton(
            label: 'Decline',
            variant: AdButtonVariant.danger,
            fullWidth: true,
            icon: Icons.call_end,
            trailingIcon: false,
            onPressed: _decline,
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: AdButton(
                label: 'Block',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                onPressed: _block,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: AdButton(
                // [AVADIAL-HARDEN-1] Disabled + relabeled while waiting on native 'active'.
                label: _answering ? 'Answering…' : 'Answer anyway',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                onPressed: _answering ? null : _answer,
              ),
            ),
          ]),
        ]);
      case PstnColor.green:
        return Row(children: [
          Expanded(
            child: AdButton(
              label: 'Decline',
              variant: AdButtonVariant.danger,
              fullWidth: true,
              onPressed: _decline,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: AdButton(
              // [AVADIAL-HARDEN-1] Disabled + relabeled while waiting on native 'active'.
              label: _answering ? 'Answering…' : 'Answer',
              variant: AdButtonVariant.primary,
              fullWidth: true,
              onPressed: _answering ? null : _answer,
            ),
          ),
        ]);
      case PstnColor.blue:
        return Column(children: [
          Row(children: [
            Expanded(
              child: AdButton(
                label: 'Decline',
                variant: AdButtonVariant.danger,
                fullWidth: true,
                onPressed: _decline,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: AdButton(
                // [AVADIAL-HARDEN-1] Disabled + relabeled while waiting on native 'active'.
                label: _answering ? 'Answering…' : 'Answer',
                variant: AdButtonVariant.primary,
                fullWidth: true,
                onPressed: _answering ? null : _answer,
              ),
            ),
          ]),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: AdButton(
                label: 'Block',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                onPressed: _block,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: AdButton(
                label: 'Report spam',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                onPressed: _reportSpam,
              ),
            ),
          ]),
        ]);
    }
  }
}
