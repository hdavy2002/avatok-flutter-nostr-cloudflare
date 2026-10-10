import 'package:flutter/material.dart';

import '../../../core/format/money.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/call_models.dart';

/// What the person sees when a call is over: how long they talked, what it cost, why it ended, and
/// Rate your call (when the server says [CallInfo.canReview]) or Done.
///
/// `host_declined` and `blocked` both read "This host isn't available right now." (HF-WELL-3): the app never
/// tells a caller they were refused or blocked.
class CallSummary extends StatelessWidget {
  const CallSummary({
    super.key,
    required this.info,
    required this.cancelledByMe,
    required this.onRate,
    required this.onDone,
    this.reviewed = false,
  });

  final CallInfo info;

  /// The person pressed Cancel call and the call then ended without connecting.
  final bool cancelledByMe;
  final VoidCallback onRate;
  final VoidCallback onDone;

  /// A review was just sent from this screen: hide Rate your call.
  final bool reviewed;

  String get _headline {
    final name = info.hostFirstName;
    switch (info.status) {
      case CallStatus.completed:
        return CallStrings.callEnded;
      case CallStatus.hostDeclined:
      case CallStatus.blocked:
        return CallStrings.hostUnavailable;
      case CallStatus.noAnswer:
        return cancelledByMe ? 'Call cancelled.' : "$name didn't pick up.";
      case CallStatus.callerNoAnswer:
        return "We couldn't reach your phone.";
      case CallStatus.failed:
        return cancelledByMe ? 'Call cancelled.' : "The call couldn't connect.";
      case CallStatus.ringingHost:
      case CallStatus.ringingCaller:
      case CallStatus.connected:
      case CallStatus.unknown:
        return CallStrings.callEnded;
    }
  }

  @override
  Widget build(BuildContext context) {
    final completed = info.status == CallStatus.completed;
    final charge = CallStrings.hasCharge(info);
    final reason = CallStrings.endReasonText(info.endReason, info.hostFirstName);
    // A cancelled or declined call has no end reason worth saying.
    final shownReason = (completed || info.status == CallStatus.failed) && !cancelledByMe ? reason : null;
    final showRate = completed && info.canReview && !reviewed;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(
          completed ? Icons.check_circle_outline_rounded : Icons.call_end_rounded,
          size: 72,
          color: HfColors.orchid,
        ),
        const SizedBox(height: 16),
        Semantics(
          liveRegion: true,
          child: Text(_headline, style: HfText.headline, textAlign: TextAlign.center),
        ),
        if (shownReason != null) ...[
          const SizedBox(height: 8),
          Text(shownReason, style: HfText.bodyText, textAlign: TextAlign.center),
        ],
        const SizedBox(height: 20),
        if (completed || charge)
          HfCard(
            color: HfColors.lilac,
            child: Column(
              children: [
                _Row(
                  label: CallStrings.timeTalked,
                  value: info.talkedSeconds > 0 ? Money.duration(info.talkedSeconds) : CallStrings.noTimeBilled,
                ),
                const SizedBox(height: 12),
                _Row(label: CallStrings.charged, value: charge ? CallStrings.chargedText(info) : 'No charge'),
              ],
            ),
          )
        else
          const Text('You were not charged.', style: HfText.bodyStrong, textAlign: TextAlign.center),
        const SizedBox(height: 24),
        if (showRate) ...[
          HfButton(label: CallStrings.rateYourCall, icon: Icons.star_rounded, onPressed: onRate),
          const SizedBox(height: 8),
          HfButton(label: CallStrings.done, kind: HfButtonKind.secondary, onPressed: onDone),
        ] else
          HfButton(label: CallStrings.done, onPressed: onDone),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(child: Text(label, style: HfText.bodyText)),
        const SizedBox(width: 12),
        Flexible(child: Text(value, style: HfText.subtitle, textAlign: TextAlign.end)),
      ],
    );
  }
}
