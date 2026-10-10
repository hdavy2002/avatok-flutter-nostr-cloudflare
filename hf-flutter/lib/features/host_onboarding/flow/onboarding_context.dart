import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import 'onboarding_steps.dart';

/// Everything a step screen gets from the onboarding shell. A step is a plain widget:
///
/// ```dart
/// Widget buildAvatarStep(BuildContext context, OnboardingStepContext ctx) => AvatarStep(ctx: ctx);
/// ```
/// and it registers in `part_b/part_b_steps.dart` under its key. See README.md in `lib/features/host_onboarding/`.
class OnboardingStepContext {
  const OnboardingStepContext({
    required this.state,
    required this.next,
    required this.goTo,
    required this.refresh,
    this.digiLockerReturn = false,
  });

  /// What the server knows right now (profile fields in [OnboardingServerState.host]).
  final OnboardingServerState state;

  /// Re-reads the server state, then opens the following step. Call it when the step's own work is saved.
  final Future<void> Function() next;

  /// Opens another step by key (see [OnboardingKeys]) without waiting for the server.
  final void Function(String key) goTo;

  /// Re-reads `GET /api/hosts/me` and returns it. The shell shows the new state to the step.
  final Future<OnboardingServerState> Function() refresh;

  /// The person just came back from DigiLocker (`dl=return`): the Aadhaar step finishes the check.
  final bool digiLockerReturn;
}

/// How a step is built.
typedef OnboardingStepBuilder = Widget Function(BuildContext context, OnboardingStepContext ctx);

/// `GET /api/hosts/me` plus `GET /api/account/phone/status`. A `404 not_enabled` (flag `hostOnboardingEnabled` off)
/// arrives as an `ApiError` and the shell shows "Coming soon". Part B calls `ref.invalidate(onboardingStateProvider)`
/// only through [OnboardingStepContext.refresh].
final onboardingStateProvider = FutureProvider.autoDispose<OnboardingServerState>(retry: _noAutoRetry, (ref) async {
  final api = ref.watch(apiClientProvider);
  final me = await api.getJson('/api/hosts/me');
  Map<String, dynamic>? phone;
  try {
    phone = await api.getJson('/api/account/phone/status');
  } on ApiError {
    phone = null; // the sign-in already verified the WhatsApp number; the session copy is used instead
  }
  final session = ref.read(sessionProvider);
  return OnboardingServerState.fromJson(
    me,
    phone: phone,
    sessionPhoneVerified: session.me?.whatsappVerified ?? false,
    sessionPhoneMasked: session.me?.phoneMasked,
  );
});

/// A failed read shows its message with a Try again button; it is not retried behind the person's back.
Duration? _noAutoRetry(int retryCount, Object error) => null;
