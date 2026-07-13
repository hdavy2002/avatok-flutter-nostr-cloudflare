import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';

/// [DIALPAD-BIZ-CALLS] Full-screen "busy" card shown to the CALLER when a PAID
/// (Mode B) dialpad call resolves to `routed:'busy'` (Specs/PLAN-2026-07-11-
/// dialpad-business-calls-ava-voice-agent.md §11/§15.1, owner decision
/// 2026-07-11): "PAID lines never overflow to voicemail — the caller gets a
/// BUSY tone + message." Two variants, both server-supplied verbatim in
/// [message] (`busy_kind`: `agents_full` | `human_busy`) — this widget is a
/// pure presentation card, no side effects, mirroring no_answer_card.dart. The
/// busy TONE itself is played by the call site (place_1to1_call.dart) via
/// RingbackPlayer.playBusyTone(), not by this widget.
///
/// NOTE — distinct from `busy_card.dart`: that file is the existing
/// [BUSY-CARD-1] "callee already on a call" card for ordinary friend-channel
/// calls (Notify me / Leave a message for Ava). This is a separate, dialpad
/// PAID-line-overflow card — different trigger, different copy, no "notify
/// me"/"leave a message" actions — hence the distinct file name rather than
/// overloading the existing one.
///
/// TODO(future enhancement, plan §15.1): show the callee's calendar here so
/// the caller can book a slot instead of just retrying blind.
class PaidBusyCard extends StatelessWidget {
  /// Callee display name; falls back to a neutral "This line" when empty.
  final String name;

  /// Server-supplied busy message, verbatim:
  ///   agents_full → "All agents are busy right now — please try again in a while."
  ///   human_busy  → "This line is busy. Please try again later."
  final String message;

  final VoidCallback onTryAgain;
  final VoidCallback onClose;

  const PaidBusyCard({
    super.key,
    required this.name,
    required this.message,
    required this.onTryAgain,
    required this.onClose,
  });

  @override
  Widget build(BuildContext context) {
    final displayName = name.trim().isEmpty ? 'This line' : name.trim();
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 380),
      child: AdCard(
        color: AD.card,
        radius: AD.rDialog,
        boxShadow: AD.dialogShadow,
        padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('$displayName is busy',
                textAlign: TextAlign.center, style: ADText.appTitle()),
            const SizedBox(height: 10),
            Text(
              message.trim().isEmpty ? 'This line is busy. Please try again later.' : message,
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary),
            ),
            const SizedBox(height: 22),
            _adPillButton(
              label: 'Try again',
              fill: AD.primaryBadge,
              fontSize: 16,
              onPressed: onTryAgain,
            ),
            const SizedBox(height: 10),
            _adPillButton(
              label: 'Close',
              fill: AD.card,
              border: AD.borderControl,
              textColor: AD.textPrimary,
              fontSize: 15,
              onPressed: onClose,
            ),
          ],
        ),
      ),
    );
  }
}

/// Dark v2 pill button — the AD-themed replacement for the light [ZineButton]
/// fills this card used. Visual-only: it keeps the same label / onPressed /
/// loading contract, recolored to the AvaTOK dark tokens with soft (no
/// hard-offset) elevation. Disabled (onPressed == null or loading) renders on
/// the card surface with tertiary ink and a hairline control border.
Widget _adPillButton({
  required String label,
  required VoidCallback? onPressed,
  Color fill = AD.card,
  Color? border,
  Color textColor = Colors.white,
  bool loading = false,
  double fontSize = 16,
}) {
  final bool disabled = onPressed == null || loading;
  final Color bg = disabled ? AD.card : fill;
  final Color fg = disabled ? AD.textTertiary : textColor;
  final Color bc = disabled ? AD.borderControl : (border ?? fill);
  return ZinePressable(
    onTap: loading ? null : onPressed,
    color: bg,
    pressedColor: bg,
    borderColor: bc,
    borderWidth: 1,
    boxShadow: const <BoxShadow>[],
    radius: BorderRadius.circular(100),
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
    child: Row(
      mainAxisSize: MainAxisSize.max,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(
            width: fontSize + 2,
            height: fontSize + 2,
            child: CircularProgressIndicator(strokeWidth: 2.6, color: fg),
          )
        else
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: ADText.rowName(c: fg).copyWith(fontSize: fontSize),
            ),
          ),
      ],
    ),
  );
}
