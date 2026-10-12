import 'package:flutter/material.dart';

import '../../../core/format/money.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/call_models.dart';
import 'call_avatar.dart';

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
    this.notifying = false,
    this.notified = false,
    this.notifyMessage,
    this.onNotify,
    this.photoUrl,
  });

  final CallInfo info;

  /// The person pressed Cancel call and the call then ended without connecting.
  final bool cancelledByMe;
  final VoidCallback onRate;
  final VoidCallback onDone;

  /// A review was just sent from this screen: hide Rate your call.
  final bool reviewed;

  /// Post-miss Notify me state. A null callback means this terminal status is
  /// not eligible; [notified] hides the one-shot action after success.
  final bool notifying;
  final bool notified;
  final String? notifyMessage;
  final VoidCallback? onNotify;
  final String? photoUrl;

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
    final hostView = info.isHostView;
    final tierLines = <CallTierLine>[
      for (final tier in info.tiers)
        if (tier.seconds > 0) tier,
    ];
    final reason = CallStrings.endReasonText(
      info.endReason,
      info.hostFirstName,
    );
    // A cancelled or declined call has no end reason worth saying.
    final shownReason =
        (completed || info.status == CallStatus.failed) && !cancelledByMe
        ? reason
        : null;
    final showRate = completed && info.canReview && !reviewed;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Center(
          child: HfCallAvatar(
            name: info.hostFirstName == 'your host' ? '' : info.hostFirstName,
            size: 96,
            radius: 48,
            photoUrl: photoUrl,
            borderColor: HfBrightness.isDark(context)
                ? HfColors.darkBg
                : HfColors.white,
            borderWidth: 4,
          ),
        ),
        const SizedBox(height: HfSpacing.xl),
        Semantics(
          liveRegion: true,
          child: Text(
            _headline,
            style: HfText.of(context, HfText.headline),
            textAlign: TextAlign.center,
          ),
        ),
        if (shownReason != null) ...[
          const SizedBox(height: HfSpacing.sm),
          Text(
            shownReason,
            style: HfText.of(context, HfText.note),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: HfSpacing.section),
        if (completed || charge || hostView)
          HfCard(
            child: Column(
              children: [
                _Row(
                  label: CallStrings.timeTalked,
                  value: info.talkedSeconds > 0
                      ? Money.duration(info.talkedSeconds)
                      : CallStrings.noTimeBilled,
                ),
                if (hostView) ...[
                  const SizedBox(height: HfSpacing.lg),
                  _Row(
                    label: CallStrings.earned,
                    value: CallStrings.earningText(info) ?? formatPaise(0),
                  ),
                ] else ...[
                  for (final tier in tierLines) ...[
                    const SizedBox(height: HfSpacing.lg),
                    _Row(
                      label:
                          '${tier.bandLabel} · ${Money.duration(tier.seconds)} at ${tier.tier.rateLabel}',
                      value: formatPaise(tier.amountPaise),
                    ),
                  ],
                  const SizedBox(height: HfSpacing.lg),
                  _Row(
                    label: CallStrings.charged,
                    value: charge
                        ? CallStrings.chargedText(info)
                        : 'No charge',
                  ),
                ],
              ],
            ),
          )
        else
          HfCard(
            child: Text(
              'You were not charged.',
              style: HfText.of(context, HfText.bodyStrong),
              textAlign: TextAlign.center,
            ),
          ),
        if (notifyMessage != null) ...[
          const SizedBox(height: HfSpacing.lg),
          Semantics(
            liveRegion: true,
            child: Text(
              notifyMessage!,
              style: HfText.of(context, HfText.note),
              textAlign: TextAlign.center,
            ),
          ),
        ],
        const SizedBox(height: HfSpacing.section),
        if (onNotify != null && !notified) ...[
          HfButton(
            label: CallStrings.notifyMe,
            icon: Icons.notifications_active_rounded,
            loading: notifying,
            onPressed: onNotify,
          ),
          const SizedBox(height: HfSpacing.sm),
          HfButton(
            label: CallStrings.done,
            kind: HfButtonKind.text,
            onPressed: onDone,
          ),
        ] else if (showRate) ...[
          HfButton(label: CallStrings.rateYourCall, onPressed: onRate),
          const SizedBox(height: HfSpacing.sm),
          HfButton(
            label: CallStrings.done,
            kind: HfButtonKind.text,
            onPressed: onDone,
          ),
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
        Flexible(child: Text(label, style: HfText.of(context, HfText.note))),
        const SizedBox(width: HfSpacing.lg),
        Flexible(
          child: Text(
            value,
            style: HfText.of(context, HfText.subsection),
            textAlign: TextAlign.end,
          ),
        ),
      ],
    );
  }
}
