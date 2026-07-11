import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// [DIALPAD-BIZ-CALLS] Phone-style "No answer" card shown to the CALLER when an
/// outgoing BUSINESS (dialpad) call goes unanswered — the caller stays on this
/// call-style card instead of dropping into the messenger thread. Only lands in
/// Messenger if the caller explicitly chooses to send a text elsewhere.
/// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §3 "No-answer
/// card" + §8 Phase A. Flag-gated by RemoteConfig.businessCallUx at the call
/// site (call_screen.dart); this widget itself is a pure presentation card with
/// no side effects, mirroring busy_card.dart.
class NoAnswerCard extends StatelessWidget {
  final String name;
  final String seed; // avatar seed (peer uid)
  final String avatarUrl;

  final VoidCallback onCallAgain;
  final VoidCallback onSaveContact;
  final VoidCallback onClose;

  /// "Leave a voicemail" is a Phase B feature (the server-side voice-prompt +
  /// 25s recording bot). Until [voicemailAvailable] is true (RemoteConfig
  /// `voicemailBot`), the button is shown but disabled with a tooltip — the
  /// caller sees the option exists without a dead callback.
  final bool voicemailAvailable;
  final VoidCallback? onLeaveVoicemail;

  const NoAnswerCard({
    super.key,
    required this.name,
    required this.seed,
    required this.onCallAgain,
    required this.onSaveContact,
    required this.onClose,
    this.avatarUrl = '',
    this.voicemailAvailable = false,
    this.onLeaveVoicemail,
  });

  @override
  Widget build(BuildContext context) {
    final displayName = name.trim().isEmpty ? 'They' : name.trim();
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 380),
      child: ZineCard(
        padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                decoration: BoxDecoration(shape: BoxShape.circle, border: Zine.border),
                child: Avatar(seed: seed, name: displayName, size: 88,
                    avatarUrl: avatarUrl.isEmpty ? null : avatarUrl),
              ),
            ),
            const SizedBox(height: 14),
            Text('$displayName didn’t answer', textAlign: TextAlign.center, style: ZineText.hero(size: 22)),
            const SizedBox(height: 6),
            Text('No answer', textAlign: TextAlign.center, style: ZineText.sub(size: 14.5)),
            const SizedBox(height: 22),
            ZineButton(
              label: 'Call again',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              onPressed: onCallAgain,
            ),
            const SizedBox(height: 10),
            Tooltip(
              message: voicemailAvailable ? '' : 'Voicemail is coming soon',
              child: ZineButton(
                label: 'Leave a voicemail',
                variant: ZineButtonVariant.lime,
                fullWidth: true,
                fontSize: 16,
                onPressed: voicemailAvailable ? onLeaveVoicemail : null,
              ),
            ),
            const SizedBox(height: 10),
            ZineButton(
              label: 'Save contact',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              fontSize: 16,
              onPressed: onSaveContact,
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
