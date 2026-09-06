import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../auth/clerk_client.dart';
import '../../core/affiliate_bind_service.dart';
import '../../core/analytics.dart';
import '../../core/ui/illustrations.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/referral_service.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/breakpoints.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/rajasthani_motifs.dart';
import '../../core/ui/zine_widgets.dart';

/// Auth sub-modes within the screen. Two, now: ask for the email, then the code.
enum _Mode { email, verify }

/// Entry mode — kept for call-site compatibility (AccountGate / RootFlow). It no
/// longer changes the FLOW, only the words: sign-in and sign-up are the same act
/// here, so this just decides whether the screen greets you as a returning
/// person or a new one.
enum SignInMode { signIn, signUp }

/// [AVA-PWLESS-1 2026-09-06] PASSWORDLESS. Type an email, get a 6-digit code,
/// you're in — whether or not you already had an account. Or one-tap
/// "Continue with Google".
///
/// WHAT WENT AWAY: the password field, the separate sign-up form (name +
/// password), "forgot password?", the reset-code screen, and the
/// "Sign in with an email code instead" link that was the only way to reach the
/// flow that is now the whole screen. Five sub-modes became two.
///
/// WHY: owner decision 2026-09-06 — passwords are disabled on the Clerk
/// instance. Keeping a password box would not degrade gracefully; it would fail
/// at Clerk, which reads as a broken app rather than a removed feature. The
/// email-code path was ALSO broken until that day, for a reason no client code
/// could fix: "Sign-in with email → Email verification code" was switched off in
/// the Clerk dashboard, so `supported_first_factors` never contained
/// `email_code` and this screen told existing users "Sign-in is not available
/// for this account". See ClerkClient.startEmailCode.
///
/// Name and profile are collected in onboarding, AFTER the account exists —
/// Clerk no longer requires first/last name at sign-up.
///
/// Requires "Email address" enabled as a Clerk identifier (Dashboard → User &
/// Authentication → Email) — the same setting Google needs.
class SignInScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignedIn;
  final SignInMode initialMode;
  final VoidCallback? onSignUpRequested;
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
  static const _appLogoAsset = 'assets/illustrations/app-logo.png';

  final _email = TextEditingController();
  final _code = TextEditingController();
  _Mode _mode = _Mode.email;
  String? _pendingId;
  String? _pendingKind;
  String _provider = 'email_code'; // which method the in-flight attempt used
  bool _busy = false;
  bool _done = false;
  String? _error;
  DateTime? _lastOtpRequestAt;

  static const _otpResendCooldown = Duration(seconds: 60);

  bool _allowOtpRequest() {
    final last = _lastOtpRequestAt;
    if (last != null && DateTime.now().difference(last) < _otpResendCooldown) {
      final remaining = _otpResendCooldown.inSeconds -
          DateTime.now().difference(last).inSeconds;
      setState(() => _error =
          'Please wait ${remaining.clamp(1, 60)} seconds before requesting another code.');
      return false;
    }
    _lastOtpRequestAt = DateTime.now();
    return true;
  }

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    super.dispose();
  }

  // ── Google ──────────────────────────────────────────────────────────────────
  Future<void> _continueWithGoogle() async {
    if (_busy) return;
    _provider = 'google';
    setState(() {
      _busy = true;
      _error = null;
    });
    unawaited(Analytics.capture('signup_attempt', {'provider': 'google'}));
    _handleStep(await widget.clerk.signInWithGoogle());
  }

  // ── Email → code ─────────────────────────────────────────────────────────────
  // [AVA-PWLESS-1] Every code this app sends is sent from here, on a deliberate
  // tap, and lands on _Mode.verify — so a code is never mailed without a code
  // field already on screen to receive it. That rule predates passwordless
  // ([AVA-AUTH-OTP], after an OTP flood) and is worth keeping now that this is
  // the ONLY door: a resend button on a one-field screen is easy to lean on.
  // _allowOtpRequest() is the 60-second throttle.
  Future<void> _submit() async {
    // onSubmitted (keyboard Enter) bypasses the button's disabled state. This
    // guard prevents duplicate Clerk requests, especially duplicate OTP/reset
    // sends when a user taps or presses Enter repeatedly.
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    switch (_mode) {
      case _Mode.email:
        if (_email.text.trim().isEmpty) {
          setState(() {
            _busy = false;
            _error = 'Enter your email';
          });
          return;
        }
        if (!_allowOtpRequest()) {
          setState(() => _busy = false);
          return;
        }
        _provider = 'email_code';
        unawaited(Analytics.capture('email_otp_requested', {'mode': 'auto'}));
        unawaited(Analytics.capture(
            'signup_attempt', {'provider': 'email_code', 'mode': 'auto'}));
        // startEmailCode decides sign-up vs sign-in from Clerk's answer — the
        // person is never asked whether they already have an account.
        _handleStep(await widget.clerk.startEmailCode(_email.text));
        return;
      case _Mode.verify:
        if (_code.text.trim().isEmpty) {
          setState(() {
            _busy = false;
            _error = 'Enter the code we emailed you';
          });
          return;
        }
        final step =
            await widget.clerk.verifyCode(_pendingKind!, _pendingId!, _code.text);
        if (!mounted) return;
        if (step.isComplete) {
          unawaited(Analytics.capture(
              'email_otp_verify_succeeded', {'kind': _pendingKind ?? ''}));
          _succeed();
          return;
        }
        if (step.needsCode) {
          // Device Trust wants a second code. _handleStep puts the code field
          // back with the new kind; clear the old code so it isn't resubmitted.
          _code.clear();
          _handleStep(step);
          return;
        }
        final err = step.error ?? 'Verification failed';
        setState(() {
          _busy = false;
          _error = err;
        });
        unawaited(Analytics.capture('email_otp_verify_failed',
            {'kind': _pendingKind ?? '', 'shown_error': err}));
        unawaited(Analytics.capture(
            'signup_failed', {'provider': 'email_code', 'shown_error': err}));
        return;
    }
  }

  /// Resend the code for the address already on screen. Same throttle, same
  /// call — a resend is just the first request again, and `startEmailCode` is
  /// idempotent enough for that (a second sign-up attempt on a now-existing
  /// address falls through to the sign-in branch by design).
  Future<void> _resend() async {
    if (_busy) return;
    if (!_allowOtpRequest()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    unawaited(Analytics.capture('email_otp_requested', {'mode': 'resend'}));
    _handleStep(await widget.clerk.startEmailCode(_email.text));
  }

  void _handleStep(ClerkStep r) {
    if (!mounted) return;
    if (r.isComplete) {
      _succeed();
      return;
    }
    if (r.needsCode) {
      unawaited(Analytics.capture(
          'email_otp_sent', {'kind': r.kind ?? '', 'provider': _provider}));
      setState(() {
        _busy = false;
        _pendingKind = r.kind;
        _pendingId = r.id;
        _mode = _Mode.verify;
        _error = null;
      });
      return;
    }
    final shown = r.error ?? 'Authentication failed';
    unawaited(Analytics.capture(
        'signup_failed', {'provider': _provider, 'shown_error': shown}));
    setState(() {
      _busy = false;
      _error = shown;
    });
  }

  void _succeed() {
    unawaited(Analytics.capture('signup_succeeded', {'provider': _provider}));
    unawaited(_claimReferral());
    // A session is now established. Before entering the app, reconcile any pending
    // account deletion: if this account is inside the 30-day grace, tell the user
    // and let them reactivate (cancel the deletion) or stay signed out. Covers every
    // login path (Google, email-OTP, password) because they all funnel through here.
    unawaited(_reconcileDeletionThenFinish());
  }

  Future<void> _reconcileDeletionThenFinish() async {
    try {
      final res = await ApiAuth.postJson(kAccountDeletionStatusUrl, const {},
          timeout: const Duration(seconds: 12));
      if (res.statusCode == 200) {
        final m = jsonDecode(res.body) as Map<String, dynamic>;
        if (m['pending'] == true) {
          if (!mounted) return;
          final reactivate = await _showReactivateDialog(
              (m['grace_ends_at'] as num?)?.toInt());
          if (reactivate != true) {
            // User declined — keep the deletion scheduled and sign back out.
            unawaited(Analytics.capture(
                'account_deletion_reactivation_declined',
                {'provider': _provider}));
            try {
              await widget.clerk.signOut();
            } catch (_) {/* best-effort */}
            if (!mounted) return;
            setState(() {
              _busy = false;
              _error =
                  'Your account stays scheduled for deletion. Sign in again before the '
                  'grace period ends to reactivate it.';
            });
            return;
          }
          // Reactivate: cancel the pending deletion, then continue into the app.
          try {
            await ApiAuth.postJson(kAccountCancelDeleteUrl, const {},
                timeout: const Duration(seconds: 15));
            unawaited(Analytics.capture(
                'account_deletion_reactivated', {'provider': _provider}));
          } catch (_) {
            /* best-effort — server also re-checks status on cascade */
          }
        }
      }
    } catch (_) {
      /* reconcile is best-effort — never block a valid login on it */
    }
    _finish();
  }

  /// "This account is scheduled for deletion" prompt. Returns true to reactivate.
  Future<bool?> _showReactivateDialog(int? graceEndsAtMs) {
    String? whenStr;
    if (graceEndsAtMs != null) {
      final w = DateTime.fromMillisecondsSinceEpoch(graceEndsAtMs).toLocal();
      whenStr =
          '${w.year}-${w.month.toString().padLeft(2, '0')}-${w.day.toString().padLeft(2, '0')}';
    }
    return showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.card,
        shape: RoundedRectangleBorder(
          borderRadius: Msg.brLg,
          side: const BorderSide(color: AD.borderControl, width: 1),
        ),
        title: Text('This account is scheduled for deletion',
            style: ADText.threadName()),
        content: Text(
          whenStr != null
              ? 'Your account is set to be permanently deleted on $whenStr. Logging back in '
                  'will cancel the deletion and reactivate your account.\n\n'
                  'Reactivate it and continue?'
              : 'Your account is scheduled for deletion. Logging back in will cancel the '
                  'deletion and reactivate your account.\n\nReactivate it and continue?',
          style: ADText.preview(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text('Not now',
                style:
                    ADText.rowName(c: AD.textSecondary).copyWith(fontSize: 14)),
          ),
          ZineButton(
            label: 'Reactivate & continue',
            variant: ZineButtonVariant.coral,
            fontSize: 15,
            onPressed: () => Navigator.of(ctx).pop(true),
          ),
        ],
      ),
    );
  }

  Future<void> _claimReferral() async {
    // Redeem any pending invite reward for whoever referred this new user.
    try {
      await ReferralService.I.claimPendingAfterSignup();
    } catch (_) {/* best-effort */}
    try {
      await AffiliateBindService.bindPending();
    } catch (_) {/* best-effort */}
  }

  void _finish() {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _done = true;
    });
    Timer(const Duration(milliseconds: 900), () {
      if (mounted) widget.onSignedIn();
    });
  }

  void _switch(_Mode m) => setState(() {
        _mode = m;
        _error = null;
      });

  @override
  Widget build(BuildContext context) {
    if (_done) {
      return Scaffold(
        body: ZineSuccessOverlay(
          icon: PhosphorIcons.handWaving(PhosphorIconsStyle.regular),
          headline: "You're in!",
          sub: 'Setting up your account.',
        ),
      );
    }

    // [AVA-PWLESS-1] `initialMode` no longer picks a different FORM — there is
    // only one — so it picks the greeting. A gate that pushed this screen to
    // make someone sign up still says "join"; the root flow still says
    // "welcome back". Both then do exactly the same thing.
    final joining = widget.initialMode == SignInMode.signUp;
    final emailSub = widget.gateReason != null
        ? '${joining ? 'Create your account' : 'Sign in'} to ${widget.gateReason}. '
            'We’ll email you a 6-digit code — no password.'
        : 'Enter your email and we’ll send a 6-digit code. '
            'New here or not, this is the way in — no password.';
    final (titlePre, titleMark, sub, cta, tag) = switch (_mode) {
      _Mode.email => (
          joining ? 'Join ' : 'Sign in ',
          joining ? 'AvaTOK' : 'or up',
          emailSub,
          'Email me a code',
          joining ? 'Sign up' : 'Log in'
        ),
      _Mode.verify => (
          'Verify ',
          'email',
          'Enter the 6-digit code we emailed you.',
          'Verify',
          'Verify'
        ),
    };
    final showGoogle = _mode == _Mode.email;
    final canPop = Navigator.of(context).canPop();

    // RESPUI-2/3: the whole body (incl. the CTA/Google/footer, previously
    // fixed below the scroll area) now scrolls as one column so short screens
    // and an open keyboard never hide the submit button or clip the footer.
    // SafeArea + resizeToAvoidBottomInset keep the focused field above the
    // keyboard inset. Horizontal padding + hero title size key off
    // ZineBreakpoints so a <360dp phone gets tighter gutters and a smaller
    // hero instead of the same fixed 24px/36px squeezing the layout.
    final hPad = ZineBreakpoints.pagePadding(context);
    final showHeaderChrome = canPop || tag != 'Log in';
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: ZinePaper(
        child: SafeArea(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            // [RAJ-SEAMS-1] Indigo header band (wordmark + mode tag) + flush
            // 1B Squiggle seam below it — fixed chrome above the scroll area,
            // per patches.md §6 usage note ("1B/2C/2A sit flush under the
            // header Container, no border between"). NOTE: patches.md §6's
            // table assigns Sign in TURQUOISE + 1B Squiggle, but the newest
            // designer instruction for this screen says INDIGO. Built INDIGO
            // (newest instruction wins) with the table's Squiggle seam —
            // flag this conflict for the owner to confirm with the designer.
            if (showHeaderChrome) ...[
              _headerBand(hPad: hPad, canPop: canPop, tag: tag),
              const SquiggleSeam(bandColor: AD.bandIndigo),
            ],
            Expanded(
              child: SingleChildScrollView(
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                padding: EdgeInsets.fromLTRB(hPad, 0, hPad, 24),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const SizedBox(height: Msg.s4),
                      // [RAJ-SEAMS-1] On the verify step ONLY, the crest gives way
                      // to 02-sign-in-illo-1.svg — the envelope + 123456 card +
                      // chai cup art the designer drew for exactly this screen
                      // (illustrations/MANIFEST.md: "02 Sign in India", nearby
                      // text "Verify"). Decorative: the "Verify email" title and
                      // the 6-digit-code subtitle beside it carry the meaning, so
                      // it is excluded from semantics. Sign-in and sign-up keep
                      // the crest — the art is specific to the emailed code.
                      if (_mode == _Mode.verify)
                        Center(
                          child: SvgPicture.asset(
                            Illustrations.signInHero,
                            height: 200,
                            fit: BoxFit.contain,
                            excludeFromSemantics: true,
                          ),
                        )
                      else
                        Center(
                          child: Container(
                            width: 98,
                            height: 98,
                            padding: const EdgeInsets.all(1.5),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: Colors.black,
                                width: 1.5,
                              ),
                            ),
                            child: ClipOval(
                              child: Image.asset(
                                _appLogoAsset,
                                fit: BoxFit.cover,
                                excludeFromSemantics: true,
                              ),
                            ),
                          ),
                        ),
                      const SizedBox(height: Msg.s3),
                      ZineMarkTitle(
                          pre: titlePre,
                          mark: titleMark,
                          fontSize: ZineBreakpoints.heroTextSize(context)),
                      const SizedBox(height: 12),
                      Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 280),
                          child: Text(sub,
                              style: ADText.preview(),
                              textAlign: TextAlign.center),
                        ),
                      ),
                      const SizedBox(height: 24),
                      ..._fields(),
                      if (_error != null) ...[
                        const SizedBox(height: 16),
                        ZineErrorMsg(_error!),
                      ],
                      const SizedBox(height: Msg.s4),
                      ZineButton(
                        label: cta,
                        icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                        fullWidth: true,
                        fontSize: 20,
                        loading: _busy,
                        onPressed: _busy ? null : _submit,
                      ),
                      if (showGoogle) ...[
                        const SizedBox(height: 16),
                        _orDivider(),
                        const SizedBox(height: 16),
                        ZineButton(
                          label: 'Continue with Google',
                          variant: ZineButtonVariant.ghost,
                          icon:
                              PhosphorIcons.googleLogo(PhosphorIconsStyle.bold),
                          fullWidth: true,
                          fontSize: 18,
                          onPressed: _busy ? null : _continueWithGoogle,
                        ),
                      ],
                      const SizedBox(height: 16),
                      Center(child: _footerLink()),
                      const SizedBox(height: Msg.s3),
                      Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            PhosphorIcon(
                                PhosphorIcons.lockKey(PhosphorIconsStyle.fill),
                                size: 14,
                                color: Msg.accent),
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                  'Secured by Clerk · one account for everything Ava',
                                  style: ADText.sectionLabel(),
                                  textAlign: TextAlign.center),
                            ),
                          ]),
                    ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  /// Indigo header band — keeps only navigation and non-login mode context.
  /// The staging sign-in header intentionally has no wordmark or "Log in"
  /// label. Indigo is a DARK band, so every foreground element is
  /// AD.onBand(AD.bandIndigo) (cream) — contrast rule, patches.md §6.
  /// Outer SafeArea already wraps this Column, so the band itself does not
  /// add a second one.
  Widget _headerBand(
      {required double hPad, required bool canPop, required String tag}) {
    const band = AD.bandIndigo;
    final onBand = AD.onBand(band);
    final showTag = tag != 'Log in';
    if (!canPop && !showTag) return const SizedBox.shrink();
    return Container(
      color: band,
      padding: EdgeInsets.fromLTRB(hPad, 14, hPad, 14),
      child: Row(children: [
        if (canPop) ...[
          AdBackButton(color: onBand),
          const SizedBox(width: Msg.s3),
        ],
        const Spacer(),
        if (showTag)
          Flexible(
            child: Text(tag,
                style: ADText.sectionLabel(c: onBand),
                overflow: TextOverflow.ellipsis),
          ),
      ]),
    );
  }

  Widget _orDivider() => Row(children: [
        const Expanded(child: Divider(color: AD.borderHairline, thickness: 1)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text('or', style: ADText.sectionLabel()),
        ),
        const Expanded(child: Divider(color: AD.borderHairline, thickness: 1)),
      ]);

  // [AVA-PWLESS-1] Two fields exist in this whole screen now: an email, then a
  // code. No password box, no name box, no reveal-eye toggle. Do not add a
  // password field back — `password` is disabled on the Clerk instance, so it
  // would fail server-side and look like a bug rather than a removed feature.
  List<Widget> _fields() {
    return [
      if (_mode == _Mode.verify) ...[
        ZineField(
          controller: _code,
          label: 'code',
          labelIcon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
          leadIcon: PhosphorIcons.hash(PhosphorIconsStyle.bold),
          hint: '123456',
          keyboardType: TextInputType.number,
          error: _error != null,
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: Msg.s3),
        Center(
          child: ZineLink('Resend code', fontSize: 14, onTap: () => _resend()),
        ),
        const SizedBox(height: Msg.s4),
      ],
      if (_mode == _Mode.email) ...[
        ZineField(
          controller: _email,
          label: 'email',
          labelIcon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
          leadText: '@',
          hint: 'you@example.com',
          keyboardType: TextInputType.emailAddress,
          error: _error != null && _email.text.trim().isEmpty,
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: Msg.s4),
      ],
    ];
  }

  Widget _footerLink() {
    // RESPUI-5: was a Row(mainAxisSize: min) with two unconstrained Text/
    // ZineLink children inside a Center — at high textScale ("have an
    // account? " + "log in" etc.) the combined intrinsic width exceeds the
    // available width and Row has nothing to shrink, so it overflows
    // horizontally (393px @ 320x568/2.0x). Wrap lets the pieces flow onto a
    // second line instead of forcing one row wider than the screen.
    switch (_mode) {
      // [AVA-PWLESS-1] There is no "create account" link any more, because
      // there is nothing to switch to: this one box signs you up if we don't
      // know the address and signs you in if we do. The old pair of links asked
      // people to answer a question ("do I have an account?") that they often
      // could not, and that we never needed them to answer.
      case _Mode.email:
        return Text('New or returning — same box.',
            style: ADText.preview().copyWith(fontSize: 14),
            textAlign: TextAlign.center);
      case _Mode.verify:
        return ZineLink('use a different email', fontSize: 14, onTap: () {
          _code.clear();
          _switch(_Mode.email);
        });
    }
  }
}
