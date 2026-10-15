import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/router/routes.dart';
import '../../../../core/theme/hf_theme.dart';
import '../../../../core/widgets/widgets.dart';
import '../../flow/onboarding_context.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Step `done`: "Sent for review!" (or "You are live!" for a host who is already live), what happens next, and a
/// button to the host dashboard. A profile that is with the team stays locked here: this page only reads.
///
/// HF-MOTION-D: the warm yellow moment. The page turns sunshine-to-butter, the beaver celebrates, the heading is
/// big and confetti bursts once when the step opens (nothing with reduced motion).
class DoneStep extends StatefulWidget {
  const DoneStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  State<DoneStep> createState() => _DoneStepState();
}

class _DoneStepState extends State<DoneStep> {
  final ConfettiController _confetti = ConfettiController();

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _confetti.fire();
    });
  }

  @override
  void dispose() {
    _confetti.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final live = ctx.state.hostStatus == 'live';
    return ConfettiBurst(
      controller: _confetti,
      particleCount: 60,
      origin: const Alignment(0, -0.6),
      child: PartBStep(
      scene: HfClusterKind.success,
      title: live ? PartBCopy.liveTitle : PartBCopy.doneTitle,
      lead: live ? PartBCopy.liveLead : PartBCopy.doneLead,
      beaverPose: BeaverPose.celebrate,
      warm: true,
      heroTitle: true,
      bottom: [
        HfButton(
          key: const ValueKey<String>('done-dashboard'),
          label: PartBCopy.goDashboard,
          onPressed: () => context.go(Routes.host),
        ),
        HfButton(
          key: const ValueKey<String>('done-home'),
          label: PartBCopy.goHome,
          kind: HfButtonKind.text,
          onPressed: () => context.go(Routes.home),
        ),
      ],
      children: [
        PopIn(
          delay: const Duration(milliseconds: 250),
          beginScale: 0.5,
          child: Center(
            child: Container(
              width: 96,
            height: 96,
            margin: const EdgeInsets.symmetric(vertical: 16),
            decoration: const BoxDecoration(
              color: HfColors.blush,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.favorite_rounded,
              size: 48,
              color: HfColors.rose,
            ),
          ),
        ),
        ),
        HfCard(
          key: const ValueKey<String>('done-next'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text(
                  PartBCopy.nextTitle,
                  style: HfText.of(context, HfText.subsection),
                ),
              ),
              const SizedBox(height: 8),
              const _NextRow(Icons.schedule_rounded, PartBCopy.nextOnline),
              const _NextRow(Icons.phone_rounded, PartBCopy.nextCalls),
              const _NextRow(Icons.shield_outlined, PartBCopy.nextDecline),
            ],
          ),
        ),
      ],
      ),
    );
  }
}

class _NextRow extends StatelessWidget {
  const _NextRow(this.icon, this.text);

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 24, color: HfColors.lavenderDeep),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: HfText.of(context, HfText.body))),
        ],
      ),
    );
  }
}
