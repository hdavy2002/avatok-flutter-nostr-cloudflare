import 'package:flutter/material.dart';

import '../../core/ui/zine.dart';
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
      child: ZineCard(
        padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('$displayName is busy', textAlign: TextAlign.center, style: ZineText.hero(size: 22)),
            const SizedBox(height: 10),
            Text(
              message.trim().isEmpty ? 'This line is busy. Please try again later.' : message,
              textAlign: TextAlign.center,
              style: ZineText.sub(size: 14.5),
            ),
            const SizedBox(height: 22),
            ZineButton(
              label: 'Try again',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              onPressed: onTryAgain,
            ),
            const SizedBox(height: 10),
            ZineButton(
              label: 'Close',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              fontSize: 15,
              onPressed: onClose,
            ),
          ],
        ),
      ),
    );
  }
}
