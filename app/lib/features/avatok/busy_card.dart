import 'package:flutter/material.dart';

import '../../core/ui/zine.dart';
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
      child: ZineCard(
        padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(_title, textAlign: TextAlign.center, style: ZineText.hero(size: 22)),
            const SizedBox(height: 10),
            Text(_subtitle,
                textAlign: TextAlign.center, style: ZineText.sub(size: 14.5)),
            const SizedBox(height: 22),
            // "Leave a message for Ava" — the differentiator. Only when the
            // callee's receptionist is enabled (§3.1). It is the primary action
            // (lime) because it's the one thing WhatsApp can't do.
            if (receptionistEnabled) ...[
              ZineButton(
                label: 'Leave a message for Ava',
                variant: ZineButtonVariant.lime,
                fullWidth: true,
                fontSize: 16,
                onPressed: onLeaveMessage,
              ),
              const SizedBox(height: 10),
            ],
            ZineButton(
              label: notifyRegistered ? "We'll notify you" : 'Notify me',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              loading: notifyInFlight,
              // Disable once registered so a confirmed waiter isn't re-added.
              onPressed:
                  (notifyInFlight || notifyRegistered) ? null : onNotifyMe,
            ),
            const SizedBox(height: 10),
            ZineButton(
              label: 'Cancel',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              fontSize: 16,
              onPressed: onCancel,
            ),
          ],
        ),
      ),
    );
  }
}
