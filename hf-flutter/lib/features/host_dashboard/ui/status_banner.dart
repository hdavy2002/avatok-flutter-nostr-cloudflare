import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';
import '../data/host_dashboard_models.dart';
import 'dash_surface.dart';
import 'host_dashboard_copy.dart';

/// Where the profile is, and the one next step. `live` shows nothing.
///
/// - Setting up (draft, generating, pending_host, in review): a progress card ("Step 2 of 4" and a bar) with
///   the next-step button ("Continue setup").
/// - Rejected or paused: a blush card with the reviewer's reason and "Fix and send again".
class StatusBanner extends StatelessWidget {
  const StatusBanner({super.key, required this.status, required this.onAction});

  final HostProfileStatus status;

  /// Opens onboarding. The step is null to let onboarding resume where the host stopped, or `preview`
  /// for "Fix and send again".
  final void Function(String? step) onAction;

  static const int totalSteps = 4;

  @override
  Widget build(BuildContext context) {
    final spec = _specFor(status);
    if (spec == null) return const SizedBox.shrink();
    final dark = HfBrightness.isDark(context);
    final tint = spec.problem ? HfTint.blush : HfTint.lavender;
    final titleStyle = HfText.stat.copyWith(
      fontSize: 20,
      color: spec.problem ? tint.valueInk(context) : null,
    );
    final bodyStyle = spec.problem
        ? HfText.body.copyWith(color: tint.valueInk(context))
        : HfText.of(context, HfText.body);
    final content = Column(
      key: const ValueKey<String>('status-banner'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: dark ? HfColors.darkCard : HfColors.white,
                borderRadius: BorderRadius.circular(HfRadius.chip),
              ),
              child: Icon(
                spec.problem
                    ? Icons.edit_note_rounded
                    : Icons.hourglass_top_rounded,
                color: tint.ink(context),
                size: 24,
              ),
            ),
            const SizedBox(width: HfSpacing.lg),
            Expanded(
              child: Text(spec.title, style: HfText.of(context, titleStyle)),
            ),
          ],
        ),
        const SizedBox(height: HfSpacing.md),
        Text(
          spec.body,
          style: bodyStyle,
          key: const ValueKey<String>('status-body'),
        ),
        if (spec.progress != null) ...[
          const SizedBox(height: HfSpacing.lg),
          _ProgressBar(step: spec.progress!, of: totalSteps),
        ],
        if (spec.action != null) ...[
          const SizedBox(height: HfSpacing.xl),
          FilledButton(
            key: const ValueKey<String>('status-action'),
            onPressed: () => onAction(spec.step),
            child: Text(spec.action!, textAlign: TextAlign.center),
          ),
        ],
      ],
    );
    if (spec.problem) {
      return Container(
        padding: const EdgeInsets.all(HfSpacing.xxl),
        decoration: BoxDecoration(
          color: tint.bg(context),
          borderRadius: BorderRadius.circular(HfRadius.cardInner),
        ),
        child: content,
      );
    }
    return DashSurface(child: content);
  }

  /// Draft is step 1, building the profile 2, checking and sending it 3 (also while it waits for review), live 4.
  static _Spec? _specFor(HostProfileStatus s) {
    final note = s.reviewNote;
    switch (s.status) {
      case 'draft':
        return const _Spec(
          HostCopy.draftTitle,
          HostCopy.draftBody,
          HostCopy.draftAction,
          null,
          false,
          1,
        );
      case 'generating':
        return const _Spec(
          HostCopy.generatingTitle,
          HostCopy.generatingBody,
          HostCopy.generatingAction,
          null,
          false,
          2,
        );
      case 'pending_host':
        return const _Spec(
          HostCopy.pendingHostTitle,
          HostCopy.pendingHostBody,
          HostCopy.pendingHostAction,
          'preview',
          false,
          3,
        );
      case 'pending_review':
      case 'submitted':
        return const _Spec(
          HostCopy.reviewTitle,
          HostCopy.reviewBody,
          null,
          null,
          false,
          3,
        );
      case 'rejected':
        return _Spec(
          HostCopy.rejectedTitle,
          note ?? HostCopy.rejectedBody,
          HostCopy.fixAction,
          'preview',
          true,
          null,
        );
      case 'paused':
        return _Spec(
          HostCopy.pausedTitle,
          note ?? HostCopy.pausedBody,
          HostCopy.fixAction,
          'preview',
          true,
          null,
        );
      default:
        return null;
    }
  }
}

/// "Step 2 of 4" and a 8 px bar (lavender on the soft track).
class _ProgressBar extends StatelessWidget {
  const _ProgressBar({required this.step, required this.of});

  final int step;
  final int of;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    return Semantics(
      label: HostCopy.progressLabel(step, of),
      value: '${(step * 100 / of).round()}%',
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(HostCopy.progressLabel(step, of), style: dashMuted(context)),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: Container(
              height: 8,
              color: dark ? HfColors.darkTile : HfColors.segmentTrack,
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                widthFactor: step / of,
                child: Container(
                  color: dark ? HfColors.lavenderLight : HfColors.lavenderDeep,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Spec {
  const _Spec(
    this.title,
    this.body,
    this.action,
    this.step,
    this.problem,
    this.progress,
  );
  final String title;
  final String body;
  final String? action;
  final String? step;
  final bool problem;

  /// 1-based setup step, or null for a problem banner.
  final int? progress;
}
