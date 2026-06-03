import 'package:flutter/material.dart';

import '../../auth/clerk_client.dart';
import '../../core/logo.dart';
import '../../core/theme.dart';

enum _Mode { signIn, signUp, verify }

/// AvaTOK-styled auth (sign in / sign up / email-code), backed by Clerk's FAPI.
class SignInScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignedIn;
  const SignInScreen({super.key, required this.clerk, required this.onSignedIn});
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _pass = TextEditingController();
  final _code = TextEditingController();
  _Mode _mode = _Mode.signIn;
  String? _signUpId;
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    String? err;
    switch (_mode) {
      case _Mode.signIn:
        if (_email.text.trim().isEmpty || _pass.text.isEmpty) {
          err = 'Enter your email and password';
        } else {
          err = await widget.clerk.signIn(_email.text, _pass.text);
          if (err == null) { _done(); return; }
        }
        break;
      case _Mode.signUp:
        if (_email.text.trim().isEmpty || _pass.text.length < 8) {
          err = 'Enter an email and a password (8+ characters)';
        } else {
          final r = await widget.clerk.signUp(_email.text, _pass.text);
          if (r.isComplete) { _done(); return; }
          if (r.needsCode) {
            setState(() { _busy = false; _signUpId = r.signUpId; _mode = _Mode.verify; });
            return;
          }
          err = r.error ?? 'Sign-up failed';
        }
        break;
      case _Mode.verify:
        if (_code.text.trim().isEmpty) {
          err = 'Enter the code we emailed you';
        } else {
          err = await widget.clerk.verifyEmailCode(_signUpId!, _code.text);
          if (err == null) { _done(); return; }
        }
        break;
    }
    if (mounted) setState(() { _busy = false; _error = err; });
  }

  void _done() { if (mounted) widget.onSignedIn(); }

  void _switch(_Mode m) => setState(() { _mode = m; _error = null; });

  @override
  Widget build(BuildContext context) {
    final (title, sub, cta) = switch (_mode) {
      _Mode.signIn => ('Welcome back', 'Log in to your AvaTOK account', 'Log In'),
      _Mode.signUp => ('Create account', 'Join AvaTOK', 'Create account'),
      _Mode.verify => ('Verify email', 'Enter the 6-digit code we emailed you', 'Verify'),
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
              if (_mode == _Mode.verify)
                ...[
                  _label('CODE'),
                  _box(child: TextField(
                    controller: _code, keyboardType: TextInputType.number,
                    decoration: _bare('123456'), style: const TextStyle(fontSize: 18, letterSpacing: 4),
                    onSubmitted: (_) => _submit(),
                  )),
                ]
              else
                ...[
                  _label('EMAIL'),
                  _box(child: TextField(
                    controller: _email, keyboardType: TextInputType.emailAddress, autocorrect: false,
                    decoration: _bare('you@example.com'), style: const TextStyle(fontSize: 16),
                  )),
                  const SizedBox(height: 16),
                  _label('PASSWORD'),
                  _box(child: Row(children: [
                    Expanded(child: TextField(
                      controller: _pass, obscureText: _obscure,
                      decoration: _bare('••••••••'), style: const TextStyle(fontSize: 16),
                      onSubmitted: (_) => _submit(),
                    )),
                    IconButton(
                      icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                          color: AvaColors.sub, size: 20),
                      onPressed: () => setState(() => _obscure = !_obscure),
                    ),
                  ])),
                ],
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
              const Center(child: Text('Secured by Clerk · identity is your private Nostr key',
                  textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub, fontSize: 12))),
            ],
          ),
        ),
      ),
    );
  }

  Widget _footerLink() {
    switch (_mode) {
      case _Mode.signIn:
        return TextButton(
          onPressed: () => _switch(_Mode.signUp),
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
          onPressed: () => _switch(_Mode.signUp),
          child: const Text('Back', style: TextStyle(color: AvaColors.sub)),
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
