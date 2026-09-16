
import '../../../core/localization/ui_text.dart';
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
    UiLocaleScope.watch(context);
    final renewalEnded = renewalFailure != null && renewalFailure!.isNotEmpty;
    final danger = fundsExhausted || lowBalance || renewalEnded;
    final isAudio = authorization.qualitySku == MessengerCallQualitySku.audio;
    final paidAudio = isAudio && authorization.provider == 'stream';
    final title = renewalEnded
        ? uiCopy(UiMessage.m_paid_time_could_not_be_7b20c6a710)
        : fundsExhausted
        ? (paidAudio ? uiCopy(UiMessage.m_paid_audio_time_exhausted_9fa25dc89a) : uiCopy(UiMessage.m_free_audio_allowance_exhausted_b281595cb7))
        : lowBalance
            ? uiCopy(UiMessage.m_low_wallet_balance_8c01b86070)
            : paidAudio
                ? uiCopy(UiMessage.m_paid_audio_call_1070fcaac9)
            : isAudio
                ? uiCopy(UiMessage.m_free_audio_allowance_2847569870)
                : uiCopy(UiMessage.m_value1_video_82879885c0, {'value1': (authorization.qualitySku.label).toString()});
    final detail = renewalEnded
        ? uiCopy(UiMessage.m_the_call_ended_because_paid_7bfb11e55e, {'renewalFailure': (renewalFailure).toString()})
        : fundsExhausted
        ? (paidAudio
            ? uiCopy(UiMessage.m_connected_time_has_been_settled_ba2c8a7ee8)
            : uiCopy(UiMessage.m_this_free_call_is_ending_15c1d9345f))
        : lowBalance
            ? _remainingCopy()
            : isAudio && showFreeAllowance
                ? uiCopy(UiMessage.m_value1_free_minutes_remaining_today_a6f525d1ac, {'value1': (_wallMinutes(freeParticipantSecondsRemaining ?? 0)).toString()})
                : paidAudio
                    ? uiCopy(UiMessage.m_you_pay_for_both_connected_628ec9bb6d)
                : isAudio
                    ? uiCopy(UiMessage.m_audio_is_free_while_today_c4b047a5cf)
                    : uiCopy(UiMessage.m_you_pay_for_both_connected_628ec9bb6d);

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
              child: const UiText(UiMessage.m_top_up_79f52e0ce6),
            ),
        ],
      ),
    );
  }

  String _remainingCopy() {
    final seconds = paidRemainingWallSeconds;
    if (seconds == null) return uiCopy(UiMessage.m_keep_this_call_connected_only_4cf52b2fc6);
    return uiCopy(UiMessage.m_value1_of_reserved_paid_time_00f2b62682, {'value1': (_duration(seconds)).toString()});
  }
}

String _wallMinutes(int participantSeconds) =>
    (participantSeconds / 2 / 60).floor().toString();

String _duration(int seconds) {
  final safe = seconds < 0 ? 0 : seconds;
  final m = safe ~/ 60;
  final s = safe % 60;
  if (m >= 60) return uiCopy(UiMessage.m_value1_h_value2_m_bbceabb1db, {'value1': (m ~/ 60).toString(), 'value2': (m % 60).toString()});
  if (m > 0) return uiCopy(UiMessage.m_m_m_s_s_53e203758f, {'m': (m).toString(), 's': (s).toString()});
  return uiCopy(UiMessage.m_s_s_07f67a1535, {'s': (s).toString()});
}
