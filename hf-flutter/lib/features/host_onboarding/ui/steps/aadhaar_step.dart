import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../widgets/step_page.dart';
import 'onboarding_copy.dart';

/// Step `aadhaar`: the shared [AadhaarVerifyWidget] with `role: host` (OTP first, DigiLocker as the fallback).
///
/// - `ctx.digiLockerReturn` (the `dl=return` link) makes the widget finish a pending DigiLocker check at once; the
///   widget also finishes one on app resume and after a restart (it remembers the attempt).
/// - Already verified: a summary and Continue.
/// - Verified earlier as a lane caller: the worker keeps the record but with `role: lane_caller`. One quiet
///   `digilocker/start` call (which answers `already_verified` before any DigiLocker session is made) moves the
///   record to `role: host`. The worker does exactly this on a repeat check.
class AadhaarStep extends ConsumerStatefulWidget {
  const AadhaarStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<AadhaarStep> createState() => _AadhaarStepState();
}

class _AadhaarStepState extends ConsumerState<AadhaarStep> {
  AadhaarResult? _just;
  bool _roleChecked = false;
  bool _upgrading = false;
  bool _roleReady = false;
  String? _upgradeError;

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void initState() {
    super.initState();
    _maybeUpgradeRole();
  }

  @override
  void didUpdateWidget(covariant AadhaarStep old) {
    super.didUpdateWidget(old);
    _maybeUpgradeRole();
  }

  void _maybeUpgradeRole() {
    final k = ctx.state.kyc;
    if (_roleChecked || !k.aadhaarDone || k.role == null || k.role == KycRole.host.wire) return;
    _roleChecked = true;
    _upgrading = true;
    unawaited(() async {
      try {
        final result = await ref.read(kycApiProvider).digilockerStart(role: KycRole.host);
        if (!mounted) return;
        setState(() {
          _roleReady = result.verified != null;
          _upgradeError = _roleReady ? null : 'We could not reuse your verification. Please try again.';
        });
      } on ApiError catch (e) {
        if (mounted) setState(() => _upgradeError = e.userMessage);
      } finally {
        if (mounted) setState(() => _upgrading = false);
      }
    }());
  }

  Future<void> _onVerified(AadhaarResult r) async {
    if (mounted) setState(() => _just = r);
    try {
      await ctx.refresh();
    } on ApiError {
      // The check is saved on the server. The summary below still shows, and Continue re-reads the state.
    }
  }

  static String _genderLabel(String? g) {
    switch (g) {
      case 'F':
        return 'Female';
      case 'M':
        return 'Male';
      case 'T':
        return 'Transgender';
    }
    return '-';
  }

  @override
  Widget build(BuildContext context) {
    final k = ctx.state.kyc;
    final done = k.aadhaarDone || _just != null;
    if (done) {
      final last4 = k.last4 ?? _just?.last4;
      final gender = k.gender ?? _just?.gender;
      return OnboardingStepPage(
      scene: HfSceneKind.verify,
        title: OnboardingCopy.aadhaarDoneTitle,
        children: [
          HfCard(
            key: const ValueKey<String>('aadhaar-done'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DoneRow(last4 == null ? KycCopy.aadhaarVerified : '${KycCopy.aadhaarEnding} $last4'),
                const SizedBox(height: 12),
                Text('Gender: ${_genderLabel(gender)}', style: HfText.bodyText),
                const SizedBox(height: 4),
                const Text(OnboardingCopy.aadhaarAge, style: HfText.bodyText),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const Text(OnboardingCopy.aadhaarKeep, style: HfText.note),
          const SizedBox(height: 24),
          if (k.role == KycRole.laneCaller.wire)
            const Text('We reuse your verified identity for hosting. Payout and profile review are separate.', style: HfText.note),
          if (_upgradeError != null) ...[
            InlineError(_upgradeError!),
            HfButton(label: 'Try again', kind: HfButtonKind.secondary, onPressed: () {
              setState(() { _roleChecked = false; _upgradeError = null; });
              _maybeUpgradeRole();
            }),
          ],
          HfButton(
            key: const ValueKey<String>('aadhaar-continue'),
            label: OnboardingCopy.continueLabel,
            loading: _upgrading,
            onPressed: k.role == KycRole.laneCaller.wire && !_roleReady ? null : () => ctx.next(),
          ),
        ],
      );
    }
    return OnboardingStepPage(
      scene: HfSceneKind.verify,
      children: [
        AadhaarVerifyWidget(
          role: KycRole.host,
          resumeNow: ctx.digiLockerReturn,
          onVerified: (r) => unawaited(_onVerified(r)),
        ),
      ],
    );
  }
}
