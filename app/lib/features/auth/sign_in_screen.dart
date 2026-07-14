import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../auth/clerk_client.dart';
import '../../core/account_restore.dart';
import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/referral_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Auth sub-modes within the screen.
enum _Mode { signIn, signUp, verify, reset, resetCode }

/// Entry mode — kept for call-site compatibility (AccountGate / RootFlow).
enum SignInMode { signIn, signUp }

/// Email + password auth (sign in / sign up / email-code verify / password
/// reset) PLUS one-tap "Continue with Google". Facebook & LinkedIn removed
/// 2026-06-23. Both methods key off email; requires "Email address" enabled as
/// a Clerk identifier (Dashboard → User & Authentication → Email, Phone,
/// Username) — the same setting Google needs.
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
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _pass = TextEditingController();
  final _code = TextEditingController();
  final _newPass = TextEditingController();
  late _Mode _mode =
      widget.initialMode == SignInMode.signUp ? _Mode.signUp : _Mode.signIn;
  String? _pendingId;
  String? _pendingKind;
  String _provider = 'password'; // which method the in-flight attempt used
  bool _obscure = true;
  bool _busy = false;
  bool _done = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _pass.dispose();
    _code.dispose();
    _newPass.dispose();
    super.dispose();
  }

  // ── Google ──────────────────────────────────────────────────────────────────
  Future<void> _continueWithGoogle() async {
    _provider = 'google';
    setState(() { _busy = true; _error = null; });
    unawaited(Analytics.capture('signup_attempt', {'provider': 'google'}));
    _handleStep(await widget.clerk.signInWithGoogle());
  }

  // ── Passwordless: email me a sign-in code ────────────────────────────────────
  // Owner decision 2026-06-27: email + email-OTP is the primary sign-in/recovery
  // path (no phone). This is the ONLY caller that passes emailCodeRequested:true —
  // i.e. the only path in the app that can cause Clerk to email a code
  // ([AVA-AUTH-OTP]). It is a deliberate user tap, and it lands on _Mode.verify,
  // so a code is never sent without a code field on screen to receive it.
  Future<void> _emailCode() async {
    if (_email.text.trim().isEmpty) {
      setState(() => _error = 'Enter your email');
      return;
    }
    setState(() { _busy = true; _error = null; });
    _provider = 'email_code';
    unawaited(Analytics.capture('email_otp_requested', {'mode': 'signin'}));
    unawaited(Analytics.capture('signup_attempt', {'provider': 'email_code', 'mode': 'signin'}));
    _handleStep(await widget.clerk.signIn(_email.text, '', emailCodeRequested: true));
  }

  // ── Email + password ─────────────────────────────────────────────────────────
  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    switch (_mode) {
      case _Mode.signIn:
        if (_email.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter your email'; });
          return;
        }
        // [AVA-AUTH-OTP] Guard here too, so an empty password never even reaches
        // Clerk. Tapping "Log in" with a blank password used to silently email a
        // code; the email-code route is now the explicit link below the field.
        if (_pass.text.isEmpty) {
          setState(() {
            _busy = false;
            _error = 'Enter your password — or use “Sign in with an email code instead”.';
          });
          return;
        }
        _provider = 'password';
        unawaited(Analytics.capture('signup_attempt', {'provider': 'password', 'mode': 'signin'}));
        AuthSession.lastPassword = _pass.text;
        _handleStep(await widget.clerk.signIn(_email.text, _pass.text));
        return;
      case _Mode.signUp:
        if (_name.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter your name'; });
          return;
        }
        if (_email.text.trim().isEmpty || _pass.text.length < 8) {
          setState(() { _busy = false; _error = 'Enter an email and a password (8+ characters)'; });
          return;
        }
        _provider = 'password';
        unawaited(Analytics.capture('signup_attempt', {'provider': 'password', 'mode': 'signup'}));
        AuthSession.lastPassword = _pass.text;
        // Clerk requires both first AND last name. Split the single name field;
        // fall back to reusing the one token so last_name is never empty.
        final parts = _name.text.trim().split(RegExp(r'\s+'));
        final first = parts.first;
        final last = parts.length > 1 ? parts.sublist(1).join(' ') : parts.first;
        _handleStep(await widget.clerk.signUp(_email.text, _pass.text, firstName: first, lastName: last));
        return;
      case _Mode.verify:
        if (_code.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter the code we emailed you'; });
          return;
        }
        final err = await widget.clerk.verifyCode(_pendingKind!, _pendingId!, _code.text);
        if (err == null) {
          unawaited(Analytics.capture('email_otp_verify_succeeded', {'kind': _pendingKind ?? ''}));
          _succeed();
          return;
        }
        if (mounted) {
          setState(() { _busy = false; _error = err; });
          unawaited(Analytics.capture('email_otp_verify_failed', {'kind': _pendingKind ?? '', 'shown_error': err}));
          unawaited(Analytics.capture('signup_failed', {'provider': 'password', 'shown_error': err}));
        }
        return;
      case _Mode.reset:
        if (_email.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter your email to reset your password'; });
          return;
        }
        final step = await widget.clerk.startPasswordReset(_email.text);
        if (!mounted) return;
        if (step.needsCode) {
          setState(() { _busy = false; _pendingId = step.id; _mode = _Mode.resetCode; _error = null; });
        } else {
          setState(() { _busy = false; _error = step.error ?? 'Could not start password reset'; });
        }
        return;
      case _Mode.resetCode:
        if (_code.text.trim().isEmpty || _newPass.text.length < 8) {
          setState(() { _busy = false; _error = 'Enter the code and a new password (8+ characters)'; });
          return;
        }
        final rErr = await widget.clerk.resetPassword(_pendingId!, _code.text, _newPass.text);
        if (rErr == null) { AuthSession.lastPassword = _newPass.text; _succeed(); return; }
        if (mounted) setState(() { _busy = false; _error = rErr; });
        return;
    }
  }

  void _handleStep(ClerkStep r) {
    if (!mounted) return;
    if (r.isComplete) { _succeed(); return; }
    if (r.needsCode) {
      unawaited(Analytics.capture('email_otp_sent', {'kind': r.kind ?? '', 'provider': _provider}));
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
    unawaited(Analytics.capture('signup_failed', {'provider': _provider, 'shown_error': shown}));
    setState(() { _busy = false; _error = shown; });
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
          final reactivate = await _showReactivateDialog((m['grace_ends_at'] as num?)?.toInt());
          if (reactivate != true) {
            // User declined — keep the deletion scheduled and sign back out.
            unawaited(Analytics.capture('account_deletion_reactivation_declined', {'provider': _provider}));
            try { await widget.clerk.signOut(); } catch (_) {/* best-effort */}
            if (!mounted) return;
            setState(() {
              _busy = false;
              _error = 'Your account stays scheduled for deletion. Sign in again before the '
                  'grace period ends to reactivate it.';
            });
            return;
          }
          // Reactivate: cancel the pending deletion, then continue into the app.
          try {
            await ApiAuth.postJson(kAccountCancelDeleteUrl, const {}, timeout: const Duration(seconds: 15));
            unawaited(Analytics.capture('account_deletion_reactivated', {'provider': _provider}));
          } catch (_) {/* best-effort — server also re-checks status on cascade */}
        }
      }
    } catch (_) {/* reconcile is best-effort — never block a valid login on it */}
    _finish();
  }

  /// "This account is scheduled for deletion" prompt. Returns true to reactivate.
  Future<bool?> _showReactivateDialog(int? graceEndsAtMs) {
    String? whenStr;
    if (graceEndsAtMs != null) {
      final w = DateTime.fromMillisecondsSinceEpoch(graceEndsAtMs).toLocal();
      whenStr = '${w.year}-${w.month.toString().padLeft(2, '0')}-${w.day.toString().padLeft(2, '0')}';
    }
    return showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('This account is scheduled for deletion', style: ZineText.cardTitle()),
        content: Text(
          whenStr != null
              ? 'Your account is set to be permanently deleted on $whenStr. Logging back in '
                  'will cancel the deletion and reactivate your account.\n\n'
                  'Reactivate it and continue?'
              : 'Your account is scheduled for deletion. Logging back in will cancel the '
                  'deletion and reactivate your account.\n\nReactivate it and continue?',
          style: ZineText.sub(size: 14),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft)),
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
    try { await ReferralService.I.claimPendingAfterSignup(); } catch (_) {/* best-effort */}
  }

  void _finish() {
    if (!mounted) return;
    setState(() { _busy = false; _done = true; });
    Timer(const Duration(milliseconds: 900), () { if (mounted) widget.onSignedIn(); });
  }

  void _switch(_Mode m) => setState(() { _mode = m; _error = null; });

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

    final signUpSub = widget.gateReason != null
        ? 'Create your account to ${widget.gateReason}'
        : 'Join AvaTOK — it takes a minute.';
    final (titlePre, titleMark, sub, cta, tag) = switch (_mode) {
      _Mode.signIn => (
          'Sign in ',
          'or up',
          widget.gateReason != null
              ? 'Sign in to ${widget.gateReason}'
              : 'Log in to your AvaTOK account — or create one below.',
          'Log in',
          'log in'
        ),
      _Mode.signUp => ('Create ', 'account', signUpSub, 'Create account', 'sign up'),
      _Mode.verify => ('Verify ', 'email', 'Enter the 6-digit code we emailed you.', 'Verify', 'verify'),
      _Mode.reset => ('Reset ', 'password', "We'll email you a reset code.", 'Send code', 'reset'),
      _Mode.resetCode =>
        ('New ', 'password', 'Enter the code we emailed + your new password.', 'Reset password', 'reset'),
    };
    final showGoogle = _mode == _Mode.signIn || _mode == _Mode.signUp;
    final canPop = Navigator.of(context).canPop();

    // RESPUI-2/3: the whole body (incl. the CTA/Google/footer, previously
    // fixed below the scroll area) now scrolls as one column so short screens
    // and an open keyboard never hide the submit button or clip the footer.
    // SafeArea + resizeToAvoidBottomInset keep the focused field above the
    // keyboard inset. Horizontal padding + hero title size key off
    // ZineBreakpoints so a <360dp phone gets tighter gutters and a smaller
    // hero instead of the same fixed 24px/36px squeezing the layout.
    final hPad = ZineBreakpoints.pagePadding(context);
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: ZinePaper(
        child: SafeArea(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 0),
              child: Row(
                mainAxisAlignment:
                    canPop ? MainAxisAlignment.spaceBetween : MainAxisAlignment.end,
                children: [
                  if (canPop) const ZineBackButton(),
                  Flexible(
                    child: Text(tag.toUpperCase(),
                        style: ZineText.kicker(), overflow: TextOverflow.ellipsis),
                  ),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                padding: EdgeInsets.fromLTRB(hPad, 0, hPad, 24),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: 18),
                    const Center(child: ZineCrest(size: 96)),
                    const SizedBox(height: 14),
                    ZineMarkTitle(pre: titlePre, mark: titleMark,
                        fontSize: ZineBreakpoints.heroTextSize(context)),
                    const SizedBox(height: 12),
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 280),
                        child: Text(sub, style: ZineText.sub(), textAlign: TextAlign.center),
                      ),
                    ),
                    const SizedBox(height: 24),
                    ..._fields(),
                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      ZineErrorMsg(_error!),
                    ],
                    const SizedBox(height: 20),
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
                        icon: PhosphorIcons.googleLogo(PhosphorIconsStyle.bold),
                        fullWidth: true,
                        fontSize: 18,
                        onPressed: _busy ? null : _continueWithGoogle,
                      ),
                    ],
                    const SizedBox(height: 16),
                    Center(child: _footerLink()),
                    const SizedBox(height: 14),
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
          ]),
        ),
      ),
    );
  }

  Widget _orDivider() => Row(children: [
        const Expanded(child: Divider(color: Zine.ink, thickness: Zine.bw)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text('or', style: ZineText.kicker()),
        ),
        const Expanded(child: Divider(color: Zine.ink, thickness: Zine.bw)),
      ]);

  List<Widget> _fields() {
    return [
      // CODE (email verify or password-reset)
      if (_mode == _Mode.verify || _mode == _Mode.resetCode) ...[
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
        const SizedBox(height: 18),
      ],
      // NEW PASSWORD (reset)
      if (_mode == _Mode.resetCode) ...[
        ZineField(
          controller: _newPass,
          label: 'new password',
          labelIcon: PhosphorIcons.lockKey(PhosphorIconsStyle.bold),
          leadIcon: PhosphorIcons.asterisk(PhosphorIconsStyle.bold),
          hint: '••••••••',
          obscureText: _obscure,
          error: _error != null,
          trailing: _eyeToggle(),
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: 18),
      ],
      // NAME (sign up only — Clerk requires first + last name)
      if (_mode == _Mode.signUp) ...[
        ZineField(
          controller: _name,
          label: 'name',
          labelIcon: PhosphorIcons.user(PhosphorIconsStyle.bold),
          leadIcon: PhosphorIcons.user(PhosphorIconsStyle.bold),
          hint: 'Jane Doe',
          keyboardType: TextInputType.name,
          textCapitalization: TextCapitalization.words,
          error: _error != null && _name.text.trim().isEmpty,
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: 18),
      ],
      // EMAIL (sign in / sign up / reset request)
      if (_mode == _Mode.signIn || _mode == _Mode.signUp || _mode == _Mode.reset) ...[
        ZineField(
          controller: _email,
          label: 'email',
          labelIcon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
          leadText: '@',
          hint: 'you@example.com',
          keyboardType: TextInputType.emailAddress,
          error: _error != null && _email.text.trim().isEmpty,
          onSubmitted: (_) { if (_mode == _Mode.reset) _submit(); },
        ),
        const SizedBox(height: 18),
      ],
      // PASSWORD (sign in / sign up)
      if (_mode == _Mode.signIn || _mode == _Mode.signUp) ...[
        ZineField(
          controller: _pass,
          label: 'password',
          labelIcon: PhosphorIcons.lockKey(PhosphorIconsStyle.bold),
          leadIcon: PhosphorIcons.asterisk(PhosphorIconsStyle.bold),
          hint: '••••••••',
          obscureText: _obscure,
          error: _error != null && _mode == _Mode.signIn && _pass.text.isEmpty,
          trailing: _eyeToggle(),
          onSubmitted: (_) => _submit(),
        ),
        if (_mode == _Mode.signIn)
          Padding(
            padding: const EdgeInsets.only(top: 11),
            child: Align(
              alignment: Alignment.centerRight,
              child: ZineLink('forgot password?', onTap: () => _switch(_Mode.reset)),
            ),
          ),
        // Passwordless: sign in with just an email code (no password / no phone).
        if (_mode == _Mode.signIn)
          Padding(
            padding: const EdgeInsets.only(top: 14),
            child: Center(
              child: ZineLink('Sign in with an email code instead',
                  fontSize: 14, onTap: () => _emailCode()),
            ),
          ),
      ],
    ];
  }

  Widget _eyeToggle() => GestureDetector(
        onTap: () => setState(() => _obscure = !_obscure),
        behavior: HitTestBehavior.opaque,
        child: PhosphorIcon(
          _obscure
              ? PhosphorIcons.eye(PhosphorIconsStyle.bold)
              : PhosphorIcons.eyeSlash(PhosphorIconsStyle.bold),
          size: 20, color: Zine.inkSoft,
        ),
      );

  Widget _footerLink() {
    // RESPUI-5: was a Row(mainAxisSize: min) with two unconstrained Text/
    // ZineLink children inside a Center — at high textScale ("have an
    // account? " + "log in" etc.) the combined intrinsic width exceeds the
    // available width and Row has nothing to shrink, so it overflows
    // horizontally (393px @ 320x568/2.0x). Wrap lets the pieces flow onto a
    // second line instead of forcing one row wider than the screen.
    switch (_mode) {
      case _Mode.signIn:
        return Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('new here? ', style: ZineText.tag(size: 14, color: Zine.inkSoft)),
          ZineLink('create account',
              underline: Zine.coral, fontSize: 14, onTap: () => _switch(_Mode.signUp)),
        ]);
      case _Mode.signUp:
        return Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('have an account? ', style: ZineText.tag(size: 14, color: Zine.inkSoft)),
          ZineLink('log in', fontSize: 14, onTap: () => _switch(_Mode.signIn)),
        ]);
      case _Mode.verify:
        return ZineLink('back',
            fontSize: 14,
            onTap: () => _switch(_pendingKind == 'signup' ? _Mode.signUp : _Mode.signIn));
      case _Mode.reset:
      case _Mode.resetCode:
        return ZineLink('back to log in', fontSize: 14, onTap: () => _switch(_Mode.signIn));
    }
  }
}
