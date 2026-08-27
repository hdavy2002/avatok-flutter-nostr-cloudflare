import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import 'messenger_call_billing_models.dart';

/// Compact in-call billing status. The caller supplies server-authoritative
/// usage/reservation values; this widget never charges or predicts a debit.
class MessengerCallBillingHud extends StatelessWidget {
  const MessengerCallBillingHud({
    super.key,
    required this.authorization,
    this.freeParticipantSecondsRemaining,
    this.paidRemainingWallSeconds,
    this.showFreeAllowance = false,
    this.lowBalance = false,
    this.fundsExhausted = false,
    this.renewalFailure,
    this.onTopUp,
  });

  final MessengerCallAuthorization authorization;
  final int? freeParticipantSecondsRemaining;
  final int? paidRemainingWallSeconds;
  final bool showFreeAllowance;
  final bool lowBalance;
  final bool fundsExhausted;
  final String? renewalFailure;
  final VoidCallback? onTopUp;

  @override
  Widget build(BuildContext context) {
    final renewalEnded = renewalFailure != null && renewalFailure!.isNotEmpty;
    final danger = fundsExhausted || lowBalance || renewalEnded;
    final isAudio = authorization.qualitySku == MessengerCallQualitySku.audio;
    final paidAudio = isAudio && authorization.provider == 'stream';
    final title = renewalEnded
        ? 'Paid time could not be renewed'
        : fundsExhausted
        ? (paidAudio ? 'Paid audio time exhausted' : 'Free audio allowance exhausted')
        : lowBalance
            ? 'Low wallet balance'
            : paidAudio
                ? 'Paid audio call'
            : isAudio
                ? 'Free audio allowance'
                : '${authorization.qualitySku.label} video';
    final detail = renewalEnded
        ? 'The call ended because paid time could not be renewed: $renewalFailure'
        : fundsExhausted
        ? (paidAudio
            ? 'Connected time has been settled. Add tokens to make another paid call.'
            : 'This free call is ending. Continue with paid GetStream audio to keep talking.')
        : lowBalance
            ? _remainingCopy()
            : isAudio && showFreeAllowance
                ? '${_wallMinutes(freeParticipantSecondsRemaining ?? 0)} free minutes remaining today'
                : paidAudio
                    ? 'You pay for both connected participants.'
                : isAudio
                    ? 'Audio is free while today’s allowance remains.'
                    : 'You pay for both connected participants.';

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: Msg.s4),
      padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
      decoration: BoxDecoration(
        color: danger ? AD.destructiveBg : AD.card,
        borderRadius: Msg.brMd,
        border: Border.all(
          color: danger ? AD.destructiveBg : AD.borderControl,
        ),
      ),
      child: Row(
        children: [
          Icon(
            danger ? PhosphorIcons.wallet(PhosphorIconsStyle.regular) : PhosphorIcons.info(PhosphorIconsStyle.regular),
            size: 18,
            color: danger ? AD.destructiveInk : AD.textSecondary,
          ),
          const SizedBox(width: Msg.s2),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: ADText.rowName(c: danger ? AD.destructiveInk : AD.textPrimary),
                ),
                const SizedBox(height: Msg.s1),
                Text(
                  detail,
                  style: ADText.preview(c: danger ? AD.destructiveInk : AD.textSecondary),
                ),
              ],
            ),
          ),
          if (paidRemainingWallSeconds != null && !fundsExhausted)
            Text(
              _duration(paidRemainingWallSeconds!),
              style: ADText.sectionLabel(c: danger ? AD.destructiveInk : AD.textTertiary),
            ),
          if (fundsExhausted && onTopUp != null)
            TextButton(
              onPressed: onTopUp,
              style: TextButton.styleFrom(foregroundColor: AD.destructiveInk),
              child: const Text('Top up'),
            ),
        ],
      ),
    );
  }

  String _remainingCopy() {
    final seconds = paidRemainingWallSeconds;
    if (seconds == null) return 'Keep this call connected only while you want to spend tokens.';
    return '${_duration(seconds)} of reserved paid time remains. The call will end cleanly if renewal fails.';
  }
}

String _wallMinutes(int participantSeconds) =>
    (participantSeconds / 2 / 60).floor().toString();

String _duration(int seconds) {
  final safe = seconds < 0 ? 0 : seconds;
  final m = safe ~/ 60;
  final s = safe % 60;
  if (m >= 60) return '${m ~/ 60}h ${m % 60}m';
  if (m > 0) return '${m}m ${s}s';
  return '${s}s';
}
