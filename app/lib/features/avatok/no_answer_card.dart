import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/ui/avatok_dark.dart';
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

  const NoAnswerCard({
    super.key,
    required this.name,
    required this.seed,
    required this.onCallAgain,
    required this.onSaveContact,
    required this.onClose,
    this.avatarUrl = '',
  });

  @override
  Widget build(BuildContext context) {
    final displayName = name.trim().isEmpty ? 'They' : name.trim();
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
            Center(
              child: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: AD.borderAvatar, width: 2),
                ),
                child: Avatar(seed: seed, name: displayName, size: 88,
                    avatarUrl: avatarUrl.isEmpty ? null : avatarUrl),
              ),
            ),
            const SizedBox(height: 14),
            Text('$displayName didn’t answer',
                textAlign: TextAlign.center, style: ADText.appTitle()),
            const SizedBox(height: 6),
            Text('No answer',
                textAlign: TextAlign.center,
                style: ADText.preview(c: AD.textSecondary)),
            const SizedBox(height: 22),
            _adPillButton(
              label: 'Call again',
              fill: AD.primaryBadge,
              fontSize: 16,
              onPressed: onCallAgain,
            ),
            const SizedBox(height: 10),
            _adPillButton(
              label: 'Save contact',
              fill: AD.card,
              border: AD.borderControl,
              textColor: AD.textPrimary,
              fontSize: 16,
              onPressed: onSaveContact,
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
/// fills these call-outcome cards used. Visual-only: it keeps the same
/// label / onPressed / loading contract, recolored to the AvaTOK dark tokens
/// with soft (no hard-offset) elevation. Disabled (onPressed == null or
/// loading) renders on the card surface with tertiary ink and a hairline
/// control border.
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
