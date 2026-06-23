import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../auth/clerk_client.dart';
import '../../core/analytics.dart';
import '../../core/feature_flags.dart';
import '../../core/referral_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Entry mode — retained so the AccountGate (which opens this screen when a guest
/// needs an account) keeps compiling. With Google-only auth there is no separate
/// sign-up form; "sign in" and "sign up" are the same one-tap Google flow.
enum SignInMode { signIn, signUp }

/// Google-only auth (2026-06-18). One button — "Continue with Google" — backed by
/// Clerk's native OAuth flow. No passwords, no email codes. A new user's @handle
/// is chosen afterwards in the onboarding profile step.
class SignInScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignedIn;

  /// Kept for call-site compatibility (AccountGate / RootFlow). Unused under
  /// Google-only auth — there is no in-screen sign-up form to switch to.
  final SignInMode initialMode;
  final VoidCallback? onSignUpRequested;

  /// Optional context when launched from a gate, e.g. "to add a contact".
  final String? gateReason;

  const SignInScreen({
    super.key,
    required this.clerk,
    required this.onSignedIn,
    this.initialMode = SignInMode.signIn,
    this.onSignUpRequested,
    this.gateReason,
  });
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  bool _busy = false;
  bool _done = false;
  String? _error;

  Future<void> _continueWithGoogle() => _run(() => widget.clerk.signInWithGoogle(), 'Google');

  /// Shared runner for any social provider — Google today, Facebook/LinkedIn once
  /// their flags + backend are live. Keeps the success path (referral claim →
  /// _finish) identical across providers.
  Future<void> _run(Future<ClerkStep> Function() signIn, String label) async {
    final provider = label.toLowerCase();
    setState(() { _busy = true; _error = null; });
    // Captures the moment the user commits to a provider — the denominator for
    // signup success/failure rate, paired with the granular signup_step events.
    await Analytics.capture('signup_attempt', {'provider': provider});
    final step = await signIn();
    if (!mounted) return;
    if (step.isComplete) {
      await Analytics.capture('signup_succeeded', {'provider': provider});
      // Redeem any pending invite reward for whoever referred this new user.
      try { await ReferralService.I.claimPendingAfterSignup(); } catch (_) {/* best-effort */}
      _finish();
    } else {
      final shown = step.error ?? '$label sign-in failed';
      // Record EXACTLY what the user saw on screen (e.g. "could not create
      // account") so the support-reported message maps to a queryable event.
      await Analytics.capture('signup_failed', {'provider': provider, 'shown_error': shown});
      setState(() { _busy = false; _error = shown; });
    }
  }

  /// Tapped a provider that isn't enabled yet — show a gentle "coming soon"
  /// instead of attempting a half-configured sign-in.
  void _comingSoon(String label) {
    unawaited(Analytics.capture('signup_provider_unavailable', {'provider': label.toLowerCase()}));
    setState(() => _error = '$label sign-in is coming soon — continue with Google for now.');
  }

  void _finish() {
    if (!mounted) return;
    setState(() { _busy = false; _done = true; });
    Timer(const Duration(milliseconds: 900), () { if (mounted) widget.onSignedIn(); });
  }

  @override
  Widget build(BuildContext context) {
    if (_done) {
      return const Scaffold(
        body: ZineSuccessOverlay(
          icon: Icons.waving_hand_rounded,
          headline: "You're in!",
          sub: 'Setting up your account.',
        ),
      );
    }

    final sub = widget.gateReason != null
        ? 'Sign in to ${widget.gateReason}'
        : 'Sign in or sign up in one tap — no passwords, no codes.';
    final canPop = Navigator.of(context).canPop();

    return Scaffold(
      body: ZinePaper(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(
                mainAxisAlignment:
                    canPop ? MainAxisAlignment.spaceBetween : MainAxisAlignment.end,
                children: [
                  if (canPop) const ZineBackButton(),
                  Text('SIGN IN', style: ZineText.kicker()),
                ],
              ),
              const Spacer(flex: 3),
              const Center(child: ZineCrest(size: 104)),
              const SizedBox(height: 16),
              const ZineMarkTitle(pre: 'Welcome to ', mark: 'AvaTOK', fontSize: 36),
              const SizedBox(height: 12),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 290),
                  child: Text(sub, style: ZineText.sub(), textAlign: TextAlign.center),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 18),
                ZineErrorMsg(_error!),
              ],
              const Spacer(flex: 4),
              ZineButton(
                label: 'Continue with Google',
                icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 20,
                loading: _busy,
                onPressed: _busy ? null : _continueWithGoogle,
              ),
              const SizedBox(height: 12),
              ZineButton(
                label: 'Continue with Facebook',
                variant: ZineButtonVariant.blue,
                icon: PhosphorIcons.facebookLogo(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 18,
                onPressed: _busy
                    ? null
                    : (kSocialFacebookEnabled
                        ? () => _run(() => widget.clerk.signInWithProvider('facebook'), 'Facebook')
                        : () => _comingSoon('Facebook')),
              ),
              const SizedBox(height: 12),
              ZineButton(
                label: 'Continue with LinkedIn',
                variant: ZineButtonVariant.ghost,
                icon: PhosphorIcons.linkedinLogo(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 18,
                onPressed: _busy
                    ? null
                    : (kSocialLinkedInEnabled
                        ? () => _run(() => widget.clerk.signInWithProvider('linkedin'), 'LinkedIn')
                        : () => _comingSoon('LinkedIn')),
              ),
              const SizedBox(height: 18),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.fill),
                    size: 14, color: Zine.blueInk),
                const SizedBox(width: 8),
                Flexible(
                  child: Text('secured by Clerk · one account for everything Ava',
                      style: ZineText.kicker(), textAlign: TextAlign.center),
                ),
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}
