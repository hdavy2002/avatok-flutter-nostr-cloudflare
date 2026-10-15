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
      case CallStatus.ending:
      case CallStatus.finalizing:
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
    // HF-MOTION-C: a finished call that really talked gets the celebration (ribbon, thumbs-up beaver, numbers
    // counting up). Missed, declined and cancelled calls stay calm.
    final celebrate = completed && info.talkedSeconds > 0;
    final tint = celebrate ? HfTint.butter : HfTint.lavender;
    final disc = Container(
      width: 142,
      height: 142,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: tint.bg(context),
        shape: BoxShape.circle,
        border: Border.all(
          color: tint.ink(context).withValues(alpha: 0.12),
          width: 12,
        ),
      ),
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
    );
    final chargeCount = _chargeCount(info);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (celebrate) ...[
          const _GreatChatRibbon(),
          const SizedBox(height: HfSpacing.md),
          Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  disc,
                  const SizedBox(width: HfSpacing.sm),
                  const BeaverGuide(pose: BeaverPose.thumbs, size: 96),
                ],
              ),
            ),
          ),
        ] else
          Center(child: disc),
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
                  count: info.talkedSeconds > 0
                      ? (
                          info.talkedSeconds,
                          (num v) => Money.duration(v.round()),
                        )
                      : null,
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
                    count: charge ? chargeCount : null,
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

/// A display-only count-up: the end value and how to show it. The formatter gives the API's own text at the end.
typedef _Count = (num value, String Function(num value) format);

/// How the charged amount counts up: the same source [CallStrings.chargedText] shows (paise first, then the
/// rupee figure). Server labels and token texts are shown as they are, without counting.
_Count? _chargeCount(CallInfo info) {
  final paise = info.chargedPaise;
  if (paise != null) {
    return (
      paise,
      (num v) => v == paise ? formatPaise(paise) : formatPaise(v.round()),
    );
  }
  if (info.chargedLabel != null || info.tokensSpent != null) return null;
  final rupees = info.chargedRupees;
  return (
    rupees,
    (num v) => v == rupees ? formatRupees(rupees) : formatRupees(v),
  );
}

/// "Great chat!" on an orange ribbon that sweeps across once (Strava style). Reduced motion: drawn at once.
class _GreatChatRibbon extends StatelessWidget {
  const _GreatChatRibbon();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 96,
      child: RibbonSweep(
        thickness: 54,
        child: PopIn(
          delay: const Duration(milliseconds: 420),
          child: Semantics(
            header: true,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                CallStrings.greatChat,
                style: HfText.of(context, HfText.headline).copyWith(
                  color: HfColors.white,
                  fontWeight: FontWeight.w800,
                  shadows: const [
                    Shadow(
                      color: Color(0x55A33A00),
                      offset: Offset(0, 2),
                      blurRadius: 6,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.count});

  final String label;
  final String value;

  /// When set, the value counts up from zero to [value] (display only).
  final _Count? count;

  @override
  Widget build(BuildContext context) {
    final style = HfText.of(context, HfText.subsection);
    final c = count;
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(child: Text(label, style: HfText.of(context, HfText.note))),
        const SizedBox(width: HfSpacing.lg),
        Flexible(
          child: c == null
              ? Text(value, style: style, textAlign: TextAlign.end)
              : CountUpText(
                  value: c.$1,
                  from: 0,
                  formatter: c.$2,
                  duration: const Duration(milliseconds: 900),
                  style: style,
                  textAlign: TextAlign.end,
                ),
        ),
      ],
    );
  }
}
