import 'package:flutter/material.dart';

import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/host_dashboard_models.dart';
import 'host_dashboard_copy.dart';

/// The profile status banner: what is going on with the host's profile and the one next step.
/// `live` shows no banner. Waiting and revision states retain a distinct, readable accent.
class StatusBanner extends StatelessWidget {
  const StatusBanner({super.key, required this.status, required this.onAction});

  final HostProfileStatus status;

  /// Opens onboarding. The step is null to let onboarding resume where the host stopped, or `preview`
  /// for "Fix and send again".
  final void Function(String? step) onAction;

  @override
  Widget build(BuildContext context) {
    final spec = _specFor(status);
    if (spec == null) return const SizedBox.shrink();
    return Container(
      key: const ValueKey<String>('status-banner'),
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: HfColors.white,
        boxShadow: HfShadows.card,
        borderRadius: BorderRadius.circular(HfRadius.card),
        border: Border.all(color: spec.problem ? HfColors.rose : HfColors.butterDeep),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: spec.problem ? HfColors.blush : HfColors.butter, borderRadius: BorderRadius.circular(18)),
            child: Icon(spec.problem ? Icons.edit_note_rounded : Icons.hourglass_top_rounded, color: HfColors.ink, size: 30)),
          const SizedBox(height: 16),
          Text(spec.title, style: HfText.subtitle),
          const SizedBox(height: 6),
          Text(spec.body, style: HfText.bodyText, key: const ValueKey<String>('status-body')),
          if (spec.action != null) ...[
            const SizedBox(height: 14),
            HfButton(
              key: const ValueKey<String>('status-action'),
              label: spec.action!,
              onPressed: () => onAction(spec.step),
            ),
          ],
        ],
      ),
    );
  }

  static _Spec? _specFor(HostProfileStatus s) {
    final note = s.reviewNote;
    switch (s.status) {
      case 'draft':
        return const _Spec(HostCopy.draftTitle, HostCopy.draftBody, HostCopy.draftAction, null, false);
      case 'generating':
        return const _Spec(HostCopy.generatingTitle, HostCopy.generatingBody, HostCopy.generatingAction, null, false);
      case 'pending_host':
        return const _Spec(HostCopy.pendingHostTitle, HostCopy.pendingHostBody, HostCopy.pendingHostAction, 'preview', false);
      case 'pending_review':
      case 'submitted':
        return const _Spec(HostCopy.reviewTitle, HostCopy.reviewBody, null, null, false);
      case 'rejected':
        return _Spec(HostCopy.rejectedTitle, note ?? HostCopy.rejectedBody, HostCopy.fixAction, 'preview', true);
      case 'paused':
        return _Spec(HostCopy.pausedTitle, note ?? HostCopy.pausedBody, HostCopy.fixAction, 'preview', true);
      default:
        return null;
    }
  }
}

class _Spec {
  const _Spec(this.title, this.body, this.action, this.step, this.problem);
  final String title;
  final String body;
  final String? action;
  final String? step;
  final bool problem;
}
