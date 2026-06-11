import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../auth/clerk_client.dart';
import '../../core/account_restore.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

enum _Mode { signIn, signUp, verify, reset, resetCode }

/// Public entry mode for the screen. Sign-up is only reached deliberately —
/// from the AccountGate when a guest upgrades to an L1 member. The normal
/// login path never shows the email sign-up form (its "Sign up" link sends the
/// visitor back to claim a @handle instead).
enum SignInMode { signIn, signUp }

/// AvaTOK-styled auth (sign in / sign up / email-code), backed by Clerk's FAPI.
/// Visuals: AvaTOK design system ("Welcome Back" reference screen) — crest
/// hero, lime-cell fields with focus/error offset shadows, lime pill CTA,
/// "You're in!" success seal.
class SignInScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignedIn;

  /// Where the screen opens. Defaults to sign-in. The AccountGate opens it on
  /// [SignInMode.signUp] to turn a guest into a member.
  final SignInMode initialMode;

  /// When set, the sign-in footer's "Sign up" link calls this instead of
  /// switching to the in-screen email form — RootFlow uses it to send the
  /// visitor back to the handle-claim page (handle-first onboarding).
  final VoidCallback? onSignUpRequested;

  /// Optional context shown under the title when launched from a gate, e.g.
  /// "to add a contact". Surfaces WHY the account is suddenly needed.
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
  final _email = TextEditingController();
  final _pass = TextEditingController();
  final _code = TextEditingController();
  final _newPass = TextEditingController();
  late _Mode _mode =
      widget.initialMode == SignInMode.signUp ? _Mode.signUp : _Mode.signIn;
  String? _pendingId;
  String? _pendingKind;
  bool _obscure = true;
  bool _busy = false;
  bool _done = false;
  String? _error;

  void _handleStep(ClerkStep r) {
    if (r.isComplete) { _finish(); return; }
    if (r.needsCode) {
      setState(() {
        _busy = false;
        _pendingKind = r.kind;
        _pendingId = r.id;
        _mode = _Mode.verify;
        _error = null;
      });
      return;
    }
    setState(() { _busy = false; _error = r.error ?? 'Authentication failed'; });
  }

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    switch (_mode) {
      case _Mode.signIn:
        if (_email.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter your email'; });
          return;
        }
        // Keep the password in memory so a fresh install can decrypt this
        // account's server-side key backup and restore the same identity.
        AuthSession.lastPassword = _pass.text;
        _handleStep(await widget.clerk.signIn(_email.text, _pass.text));
        return;
      case _Mode.signUp:
        if (_email.text.trim().isEmpty || _pass.text.length < 8) {
          setState(() { _busy = false; _error = 'Enter an email and a password (8+ characters)'; });
          return;
        }
        // L1 member = email + password + email OTP (Trust Ladder). No phone:
        // SMS verification is a later, separate step surfaced only when needed.
        AuthSession.lastPassword = _pass.text;
        _handleStep(await widget.clerk.signUp(_email.text, _pass.text));
        return;
      case _Mode.verify:
        if (_code.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter the code we emailed you'; });
          return;
        }
        final err = await widget.clerk.verifyCode(_pendingKind!, _pendingId!, _code.text);
        if (err == null) { _finish(); return; }
        if (mounted) setState(() { _busy = false; _error = err; });
        return;
      case _Mode.reset:
        if (_email.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter your email to reset your password'; });
          return;
        }
        final step = await widget.clerk.startPasswordReset(_email.text);
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
        if (rErr == null) { AuthSession.lastPassword = _newPass.text; _finish(); return; }
        if (mounted) setState(() { _busy = false; _error = rErr; });
        return;
    }
  }

  /// Flash the "You're in!" seal, then hand off to the app.
  void _finish() {
    if (!mounted) return;
    setState(() { _busy = false; _done = true; });
    Timer(const Duration(milliseconds: 900), () {
      if (mounted) widget.onSignedIn();
    });
  }

  void _switch(_Mode m) => setState(() { _mode = m; _error = null; });

  @override
  Widget build(BuildContext context) {
    if (_done) {
      return const Scaffold(
        body: ZineSuccessOverlay(
          icon: Icons.waving_hand_rounded,
          headline: "You're in!",
          sub: 'Picking up right where you left off.',
        ),
      );
    }

    final signUpSub = widget.gateReason != null
        ? 'Create your account to ${widget.gateReason}'
        : 'Join AvaTOK — it takes a minute.';
    final (titlePre, titleMark, sub, cta, tag) = switch (_mode) {
      _Mode.signIn => ('Welcome ', 'back', 'Log in to your AvaTOK account.', 'Log in', 'log in'),
      _Mode.signUp => ('Create ', 'account', signUpSub, 'Create account', 'sign up'),
      _Mode.verify => ('Verify ', 'email', 'Enter the 6-digit code we emailed you.', 'Verify', 'verify'),
      _Mode.reset => ('Reset ', 'password', "We'll email you a reset code.", 'Send code', 'reset'),
      _Mode.resetCode => ('New ', 'password', 'Enter the code we emailed + your new password.', 'Reset password', 'reset'),
    };

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
                  Text(tag.toUpperCase(), style: ZineText.kicker()),
                ],
              ),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: 22),
                    const Center(child: ZineCrest(size: 104)),
                    const SizedBox(height: 14),
                    ZineMarkTitle(pre: titlePre, mark: titleMark, fontSize: 38),
                    const SizedBox(height: 12),
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 280),
                        child: Text(sub, style: ZineText.sub(), textAlign: TextAlign.center),
                      ),
                    ),
                    const SizedBox(height: 28),
                    ..._fields(),
                    if (_error != null) ZineErrorMsg(_error!),
                    const SizedBox(height: 22),
                  ]),
                ),
              ),
              ZineButton(
                label: cta,
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                loading: _busy,
                onPressed: _busy ? null : _submit,
              ),
              const SizedBox(height: 18),
              Center(child: _footerLink()),
              const SizedBox(height: 16),
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
    switch (_mode) {
      case _Mode.signIn:
        // Handle-first onboarding: "Sign up" sends the visitor back to claim a
        // @handle (onSignUpRequested). The email/password form is never reached
        // from here — it only appears when an action needs an account (gate).
        return Row(mainAxisSize: MainAxisSize.min, children: [
          Text('new here? ', style: ZineText.tag(size: 14, color: Zine.inkSoft)),
          ZineLink('sign up',
              underline: Zine.coral,
              fontSize: 14,
              onTap: () => widget.onSignUpRequested != null
                  ? widget.onSignUpRequested!()
                  : _switch(_Mode.signUp)),
        ]);
      case _Mode.signUp:
        return Row(mainAxisSize: MainAxisSize.min, children: [
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
