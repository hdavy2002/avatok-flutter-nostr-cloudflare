import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/brand.dart';
import '../data/call_flags.dart';
import '../data/call_safety_store.dart';
import '../data/services.dart';
import '../data/telemetry.dart';
import 'desi.dart';
import 'theme.dart';

/// [HF-CALL-SAFETY-APP] Pieces shared by the call-safety screens, built to the owner-approved artboards (2026-10-28):
/// Safety / Account paused / Call rules (influencer), the fan's "Keep your call safe" sheet, and the post-call report.
/// Everything here is shown only while the public config says `hfCallRecordingEnabled` ([CallFlags.callRecording]).

const List<String> _mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "12 Oct" from epoch milliseconds, in the phone's time zone.
String safetyDate(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${d.day} ${_mon[d.month - 1]}';
}

/// What happens when the server refuses with a safety code (403 `account_paused` / `call_rules_required`) on going Online,
/// starting a call or joining a queue: open the matching screen instead of a bare error line.
abstract final class SafetyGate {
  /// True when [code] was a safety refusal and a screen was opened (the caller then skips its own error text).
  static bool handle(GoRouter go, String? code, {String surface = 'online'}) {
    if (code == 'account_paused') {
      Telemetry.event('hf_safety_gate_shown', {'code': 'account_paused', 'surface': surface});
      unawaited(go.push<void>('/safety/paused'));
      return true;
    }
    if (code == 'call_rules_required') {
      Telemetry.event('hf_safety_gate_shown', {'code': 'call_rules_required', 'surface': surface});
      unawaited(go.push<bool>('/safety/rules?gate=1'));
      return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------------------------------------------------ chrome

/// Top bar of the safety screens: a 48 dp round back button and either the title or (onboarding) a progress bar with "Step n of m".
class SafetyHeader extends StatelessWidget {
  const SafetyHeader({super.key, this.title = '', this.onBack, this.stepLabel, this.progress = 0});

  final String title;
  final VoidCallback? onBack;

  /// "Step 7 of 8": when set, the bar and this label replace the title.
  final String? stepLabel;

  /// 0..1, the filled part of the bar.
  final double progress;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 0),
      child: Row(children: [
        Semantics(
          button: true,
          label: 'Back',
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onBack ?? () => context.canPop() ? context.pop() : context.go('/me'),
            child: Container(
              width: 48,
              height: 48,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, color: C.white, border: Border.all(color: C.line)),
              child: const Icon(Icons.chevron_left_rounded, size: 28, color: C.maroon),
            ),
          ),
        ),
        const SizedBox(width: 10),
        if (stepLabel == null)
          Expanded(child: Semantics(header: true, child: Text(title, style: t(20, color: C.deep, w: FontWeight.w800))))
        else ...[
          Expanded(
            child: Container(
              height: 10,
              decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(99), border: Border.all(color: C.line)),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(99),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: FractionallySizedBox(
                    widthFactor: progress.clamp(0.0, 1.0).toDouble(),
                    heightFactor: 1,
                    child: const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(colors: [C.saffron, C.marigold]))),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          Text(stepLabel!, style: t(14, color: C.muted, w: FontWeight.w800)),
        ],
      ]),
    );
  }
}

/// The 56 dp saffron main button of the artboards ([ghost]: the 52 dp white outline button under it).
class SafetyButton extends StatelessWidget {
  const SafetyButton(this.label, {super.key, required this.onTap, this.busy = false, this.ghost = false});

  final String label;
  final VoidCallback? onTap;
  final bool busy;
  final bool ghost;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null && !busy;
    final ink = ghost ? C.maroon : desiInk(DesiTone.saffron);
    return Semantics(
      button: true,
      enabled: enabled,
      label: busy ? '$label, please wait' : label,
      excludeSemantics: true,
      onTap: enabled ? onTap : null,
      child: Opacity(
        opacity: onTap == null ? .55 : 1,
        child: Container(
          height: ghost ? 52 : 56,
          decoration: BoxDecoration(
            gradient: ghost ? null : desiFill(DesiTone.saffron),
            color: ghost ? C.white : null,
            borderRadius: BorderRadius.circular(999),
            border: ghost ? Border.all(color: C.line, width: 1.5) : null,
          ),
          child: Material(
            color: C.clear,
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: enabled ? onTap : null,
              child: Center(
                child: busy
                    ? SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3, color: ink))
                    : Text(label, textAlign: TextAlign.center, style: t(ghost ? 16 : 17, color: ink, w: FontWeight.w800)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A 26 dp tick box with its label in a row of at least 48 dp. Rani fill when ticked.
class SafetyTick extends StatelessWidget {
  const SafetyTick({super.key, required this.label, required this.on, required this.onTap, this.textSize = 15, this.minHeight = 48});

  final String label;
  final bool on;
  final VoidCallback? onTap;
  final double textSize;
  final double minHeight;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      checked: on,
      inMutuallyExclusiveGroup: false,
      label: label,
      onTap: onTap,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: minHeight),
          child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
            Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: on ? C.rani : C.white,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: on ? C.rani : C.line, width: 1.5),
              ),
              child: on ? const Icon(Icons.check_rounded, size: 18, color: C.white) : null,
            ),
            const SizedBox(width: 12),
            Expanded(child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(label, style: t(textSize, w: FontWeight.w700, h: 1.4)))),
          ]),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------------ fan notice

/// The artboard "Before you call": shown before every Call now / Book a time while [CallFlags.callRecording] is on, until the fan
/// ticks "Don't show this again" (kept per account on the phone). Returns true when the fan may go on (notice off, already hidden, or
/// "OK" tapped) and false when the sheet was dismissed. [rate] is e.g. "₹12/min" for a call, null for a booking.
Future<bool> showFanCallNotice(
  BuildContext context, {
  required String name,
  required String surface,
  String? rate,
}) async {
  if (!CallFlags.callRecording) return true;
  final uid = Services.instance.user?.id;
  if (await FanNoticePref.hidden(uid)) return true;
  if (!context.mounted) return false;
  Telemetry.event('hf_call_notice_shown', {'surface': surface});
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: C.clear,
    builder: (_) => FanCallNoticeSheet(name: name, surface: surface, rate: rate, uid: uid),
  );
  return ok == true;
}

class FanCallNoticeSheet extends StatefulWidget {
  const FanCallNoticeSheet({super.key, required this.name, required this.surface, this.rate, this.uid});

  final String name;
  final String surface;
  final String? rate;
  final String? uid;

  @override
  State<FanCallNoticeSheet> createState() => _FanCallNoticeSheetState();
}

class _FanCallNoticeSheetState extends State<FanCallNoticeSheet> {
  bool _dont = false;

  bool get _booking => widget.surface == 'booking';

  Widget _row(IconData icon, DesiTone tone, String text, {bool last = false}) => Container(
        constraints: const BoxConstraints(minHeight: 60),
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
        child: Row(children: [
          DesiIconSquare(icon, tone: tone, size: 44),
          const SizedBox(width: 14),
          Expanded(child: Text(text, style: t(15, w: FontWeight.w700, h: 1.4))),
        ]),
      );

  Future<void> _ok() async {
    Telemetry.event('hf_call_notice_ack', {'surface': widget.surface, 'dont_show_again': _dont});
    if (_dont) await FanNoticePref.setHidden(widget.uid, true);
    if (mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final first = widget.name.trim().split(' ').first;
    final eyebrow = first.isEmpty ? 'BEFORE YOU ${_booking ? 'BOOK' : 'CALL'}' : 'BEFORE YOU ${_booking ? 'BOOK' : 'CALL'} ${first.toUpperCase()}';
    final action = _booking ? 'OK, book a time' : (widget.rate == null ? 'OK, call now' : 'OK, call now · ${widget.rate}');
    return Semantics(
      scopesRoute: true,
      namesRoute: true,
      label: 'Keep your call safe',
      child: Container(
        decoration: const BoxDecoration(color: C.cream, borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
        clipBehavior: Clip.antiAlias,
        child: Stack(children: [
          const Positioned(right: -16, top: 18, child: Marigold(size: 70)),
          SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(18, 4, 18, MediaQuery.paddingOf(context).bottom + 16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const DesiMogra(),
              Padding(
                padding: const EdgeInsets.only(right: 40),
                child: Text(eyebrow, maxLines: 2, style: t(14, color: C.rani, w: FontWeight.w800, ls: .06)),
              ),
              const SizedBox(height: 2),
              Semantics(header: true, child: Text('Keep your call safe', style: t(26, color: C.deep, w: FontWeight.w800, h: 1.1))),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
                decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(22), border: Border.all(color: C.line)),
                child: Column(children: [
                  _row(Icons.verified_user_rounded, DesiTone.lav, 'Calls are recorded for safety. Nobody listens live.'),
                  _row(Icons.phone_disabled_rounded, DesiTone.tea, "Don't share your phone number, UPI ID or address."),
                  _row(Icons.currency_rupee_rounded, DesiTone.gold, 'Never pay outside ${Brand.name}. If someone asks, report it after the call.', last: true),
                ]),
              ),
              const SizedBox(height: 14),
              SafetyButton(action, onTap: () => unawaited(_ok())),
              const SizedBox(height: 4),
              Center(
                child: SafetyTick(label: "Don't show this again", on: _dont, onTap: () => setState(() => _dont = !_dont)),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}
