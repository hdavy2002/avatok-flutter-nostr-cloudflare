import 'package:flutter/material.dart';

import '../../auth/clerk_client.dart';
import '../../core/account_restore.dart';
import '../../core/logo.dart';
import '../../core/theme.dart';

enum _Mode { signIn, signUp, verify, reset, resetCode }

/// Public entry mode for the screen. Sign-up is only reached deliberately —
/// from the AccountGate when a guest upgrades to an L1 member. The normal
/// login path never shows the email sign-up form (its "Sign up" link sends the
/// visitor back to claim a @handle instead).
enum SignInMode { signIn, signUp }

/// AvaTOK-styled auth (sign in / sign up / email-code), backed by Clerk's FAPI.
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
  String? _error;

  void _handleStep(ClerkStep r) {
    if (r.isComplete) { _done(); return; }
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
        // Kept in memory for the session only (legacy; restore no longer needs
        // it — the Clerk sign-in is the account credential).
        AuthSession.lastPassword = _pass.text;
        _handleStep(await widget.clerk.signUp(_email.text, _pass.text));
        return;
      case _Mode.verify:
        if (_code.text.trim().isEmpty) {
          setState(() { _busy = false; _error = 'Enter the code we emailed you'; });
          return;
        }
        final err = await widget.clerk.verifyCode(_pendingKind!, _pendingId!, _code.text);
        if (err == null) { _done(); return; }
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
        if (rErr == null) { AuthSession.lastPassword = _newPass.text; _done(); return; }
        if (mounted) setState(() { _busy = false; _error = rErr; });
        return;
    }
  }

  void _done() { if (mounted) widget.onSignedIn(); }

  void _switch(_Mode m) => setState(() { _mode = m; _error = null; });

  @override
  Widget build(BuildContext context) {
    final signUpSub = widget.gateReason != null
        ? 'Create your account to ${widget.gateReason}'
        : 'Join AvaTOK';
    final (title, sub, cta) = switch (_mode) {
      _Mode.signIn => ('Welcome back', 'Log in to your AvaTOK account', 'Log In'),
      _Mode.signUp => ('Create account', signUpSub, 'Create account'),
      _Mode.verify => ('Verify email', 'Enter the 6-digit code we emailed you', 'Verify'),
      _Mode.reset => ('Reset password', 'We\'ll email you a reset code', 'Send code'),
      _Mode.resetCode => ('Set a new password', 'Enter the code we emailed + your new password', 'Reset password'),
    };
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 40, 28, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 24),
              const AvaLogo(size: 52),
              const SizedBox(height: 22),
              Text(title, style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 36)),
              const SizedBox(height: 6),
              Text(sub, style: const TextStyle(color: AvaColors.sub, fontSize: 15)),
              const SizedBox(height: 36),
              // CODE (email verify or password-reset)
              if (_mode == _Mode.verify || _mode == _Mode.resetCode) ...[
                _label('CODE'),
                _box(child: TextField(
                  controller: _code, keyboardType: TextInputType.number,
                  decoration: _bare('123456'), style: const TextStyle(fontSize: 18, letterSpacing: 4),
                  onSubmitted: (_) => _submit(),
                )),
              ],
              // NEW PASSWORD (reset)
              if (_mode == _Mode.resetCode) ...[
                const SizedBox(height: 16),
                _label('NEW PASSWORD'),
                _box(child: Row(children: [
                  Expanded(child: TextField(
                    controller: _newPass, obscureText: _obscure,
                    decoration: _bare('••••••••'), style: const TextStyle(fontSize: 16),
                    onSubmitted: (_) => _submit(),
                  )),
                  _eyeToggle(),
                ])),
              ],
              // EMAIL (sign in / sign up / reset request)
              if (_mode == _Mode.signIn || _mode == _Mode.signUp || _mode == _Mode.reset) ...[
                _label('EMAIL'),
                _box(child: TextField(
                  controller: _email, keyboardType: TextInputType.emailAddress, autocorrect: false,
                  decoration: _bare('you@example.com'), style: const TextStyle(fontSize: 16),
                  onSubmitted: (_) { if (_mode == _Mode.reset) _submit(); },
                )),
              ],
              // PASSWORD (sign in / sign up)
              if (_mode == _Mode.signIn || _mode == _Mode.signUp) ...[
                const SizedBox(height: 16),
                _label('PASSWORD'),
                _box(child: Row(children: [
                  Expanded(child: TextField(
                    controller: _pass, obscureText: _obscure,
                    decoration: _bare('••••••••'), style: const TextStyle(fontSize: 16),
                    onSubmitted: (_) => _submit(),
                  )),
                  _eyeToggle(),
                ])),
              ],
              // Forgot password (sign in only)
              if (_mode == _Mode.signIn)
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: () => _switch(_Mode.reset),
                    child: const Text('Forgot password?',
                        style: TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w700, fontSize: 13)),
                  ),
                ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 13)),
              ],
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _busy ? null : _submit,
                  child: _busy
                      ? const SizedBox(height: 20, width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(cta),
                ),
              ),
              const SizedBox(height: 18),
              Center(child: _footerLink()),
              const SizedBox(height: 16),
              const Center(child: Text('Secured by Clerk · one account for everything Ava',
                  textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub, fontSize: 12))),
            ],
          ),
        ),
      ),
    );
  }

  Widget _eyeToggle() => IconButton(
        icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
            color: AvaColors.sub, size: 20),
        onPressed: () => setState(() => _obscure = !_obscure),
      );

  Widget _footerLink() {
    switch (_mode) {
      case _Mode.signIn:
        // Handle-first onboarding: "Sign up" sends the visitor back to claim a
        // @handle (onSignUpRequested). The email/password form is never reached
        // from here — it only appears when an action needs an account (gate).
        return TextButton(
          onPressed: () => widget.onSignUpRequested != null
              ? widget.onSignUpRequested!()
              : _switch(_Mode.signUp),
          child: const Text('New here?  Sign up',
              style: TextStyle(color: AvaColors.ink, fontWeight: FontWeight.w700)),
        );
      case _Mode.signUp:
        return TextButton(
          onPressed: () => _switch(_Mode.signIn),
          child: const Text('Have an account?  Log in',
              style: TextStyle(color: AvaColors.ink, fontWeight: FontWeight.w700)),
        );
      case _Mode.verify:
        return TextButton(
          onPressed: () => _switch(_pendingKind == 'signup' ? _Mode.signUp : _Mode.signIn),
          child: const Text('Back', style: TextStyle(color: AvaColors.sub)),
        );
      case _Mode.reset:
      case _Mode.resetCode:
        return TextButton(
          onPressed: () => _switch(_Mode.signIn),
          child: const Text('Back to log in', style: TextStyle(color: AvaColors.sub)),
        );
    }
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 8),
        child: Text(t, style: const TextStyle(
            color: AvaColors.sub, fontSize: 12, letterSpacing: 1.2, fontWeight: FontWeight.w700)),
      );

  Widget _box({required Widget child}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
        child: child,
      );

  InputDecoration _bare(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Color(0xFFAAB0B8)),
        border: InputBorder.none, isDense: true,
        contentPadding: const EdgeInsets.symmetric(vertical: 14),
      );
}
