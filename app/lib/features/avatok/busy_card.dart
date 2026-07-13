import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';

/// [BUSY-CARD-1] The personalized "busy card" shown to the CALLER when a call
/// resolves to `busy` AND the server told us WHY (`busy_reason`). Instead of the
/// cold "User is busy" line (the WhatsApp behaviour), the caller gets a warm,
/// name-personalized card with up to three choices — Cancel, Notify me, and
/// (only when the callee has their receptionist enabled) Leave a message for Ava.
///
/// Design + wording: Specs/CALL-MESSAGING-RECEPTIONIST-REMEDIATION-PLAN.md §3.1.
/// This is a pure presentation widget: it renders text + buttons and calls back.
/// All wiring (the notify-register POST, the receptionist voicemail start, the
/// telemetry) lives in [CallSession] / [CallScreen] — the card owns no state and
/// no side effects, so it stays trivial to test and reuse.
///
/// Additive + field-gated: the caller only ever builds this when the busy status
/// carried a `busy_reason` from the server. When the server sends no reason (old
/// behaviour / kill switch off), the plain busy sticker renders instead and this
/// widget is never constructed — existing call UX is unchanged.
class BusyCard extends StatelessWidget {
  /// Callee display name (from the callee's profile / the call config title).
  final String name;

  /// Why the callee is busy, as reported by the server on the busy status.
  /// One of: `active_call`, `receptionist`, `do_not_disturb`. Anything else
  /// falls back to the generic "is busy right now." title.
  final String busyReason;

  /// The callee's pronoun subject ('he' | 'she' | 'they'), best-effort from the
  /// server. Defaults to the neutral "they" when unknown so the copy never
  /// misgenders.
  final String pronoun;

  /// Show the "Leave a message for Ava" action only when the callee has their
  /// receptionist enabled (`receptionist_enabled` from the server).
  final bool receptionistEnabled;

  /// True once the caller has tapped "Notify me" and the register call is in
  /// flight — the button shows a spinner and disables to prevent double-taps.
  final bool notifyInFlight;

  /// True once "Notify me" succeeded — the button flips to a confirmed state.
  final bool notifyRegistered;

  final VoidCallback onCancel;
  final VoidCallback onNotifyMe;
  final VoidCallback onLeaveMessage;

  const BusyCard({
    super.key,
    required this.name,
    required this.busyReason,
    required this.receptionistEnabled,
    required this.onCancel,
    required this.onNotifyMe,
    required this.onLeaveMessage,
    this.pronoun = 'they',
    this.notifyInFlight = false,
    this.notifyRegistered = false,
  });

  String get _title {
    final n = name.trim().isEmpty ? 'They' : name.trim();
    switch (busyReason) {
      case 'active_call':
        return '$n is on another call.';
      case 'do_not_disturb':
        return "$n isn't taking calls right now.";
      case 'receptionist':
        return '$n is busy right now.';
      default:
        return '$n is busy right now.';
    }
  }

  String get _subtitle {
    // "them" for the neutral pronoun reads better than "they's" in the
    // possessive-ish "when {pronoun}'s available" slot.
    final p = switch (pronoun) {
      'he' => "he's",
      'she' => "she's",
      _ => "they're",
    };
    return 'We can notify you when $p available.';
  }

  @override
  Widget build(BuildContext context) {
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
            Text(_title,
                textAlign: TextAlign.center, style: ADText.appTitle()),
            const SizedBox(height: 10),
            Text(_subtitle,
                textAlign: TextAlign.center,
                style: ADText.preview(c: AD.textSecondary)),
            const SizedBox(height: 22),
            // "Leave a message for Ava" — the differentiator. Only when the
            // callee's receptionist is enabled (§3.1). It is the primary action
            // (accent fill) because it's the one thing WhatsApp can't do.
            if (receptionistEnabled) ...[
              _adPillButton(
                label: 'Leave a message for Ava',
                fill: AD.primaryBadge,
                fontSize: 16,
                onPressed: onLeaveMessage,
              ),
              const SizedBox(height: 10),
            ],
            _adPillButton(
              label: notifyRegistered ? "We'll notify you" : 'Notify me',
              fill: AD.iconSearch,
              fontSize: 16,
              loading: notifyInFlight,
              // Disable once registered so a confirmed waiter isn't re-added.
              onPressed:
                  (notifyInFlight || notifyRegistered) ? null : onNotifyMe,
            ),
            const SizedBox(height: 10),
            _adPillButton(
              label: 'Cancel',
              fill: AD.card,
              border: AD.borderControl,
              textColor: AD.textPrimary,
              fontSize: 16,
              onPressed: onCancel,
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
