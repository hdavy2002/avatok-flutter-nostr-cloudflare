import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../widgets/step_page.dart';
import 'onboarding_copy.dart';

/// Step `selfie`: the shared [SelfieVideoWidget]. The server keeps the latest video with a review status:
/// `pending` or `approved` is done (Continue, with "Record again" while it is still pending); `rejected` shows the
/// reviewer's reason and asks for a new video.
class SelfieStep extends StatefulWidget {
  const SelfieStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  State<SelfieStep> createState() => _SelfieStepState();
}

class _SelfieStepState extends State<SelfieStep> {
  bool _again = false;
  bool _uploaded = false;

  OnboardingStepContext get ctx => widget.ctx;

  Future<void> _onUploaded() async {
    if (mounted) setState(() => _uploaded = true);
    try {
      await ctx.refresh();
    } on ApiError {
      // The video is saved. Continue re-reads the state.
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = ctx.state.kyc;
    final status = k.selfieStatus;
    final sent = _uploaded || ((status == 'pending' || status == 'approved') && !_again);
    if (sent) {
      return OnboardingStepPage(
      scene: HfSceneKind.verify,
        children: [
          HfCard(
            key: const ValueKey<String>('selfie-step-done'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DoneRow(status == 'approved' ? 'Approved video reused' : OnboardingCopy.selfieSentTitle),
                SizedBox(height: 8),
                Text(status == 'approved' ? 'Your approved identity video is already on file. No new recording is needed.' : OnboardingCopy.selfieSentBody, style: HfText.bodyText),
              ],
            ),
          ),
          const SizedBox(height: 24),
          HfButton(
            key: const ValueKey<String>('selfie-continue'),
            label: OnboardingCopy.continueLabel,
            onPressed: () => ctx.next(),
          ),
          if (status == 'pending' && !_uploaded)
            HfButton(
              key: const ValueKey<String>('selfie-step-again'),
              label: OnboardingCopy.selfieRecordAgain,
              kind: HfButtonKind.text,
              onPressed: () => setState(() => _again = true),
            ),
        ],
      );
    }
    return OnboardingStepPage(
      scene: HfSceneKind.verify,
      children: [
        if (status == 'rejected' && !_again) ...[
          InfoBox(
            key: const ValueKey<String>('selfie-rejected'),
            title: OnboardingCopy.selfieRejectedTitle,
            body: k.selfieReason ?? OnboardingCopy.selfieRejectedFallback,
            color: HfColors.blush,
          ),
          const SizedBox(height: 16),
        ],
        SelfieVideoWidget(onUploaded: () => unawaited(_onUploaded())),
      ],
    );
  }
}
