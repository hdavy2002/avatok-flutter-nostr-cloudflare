import 'package:flutter/material.dart';

import '../../auth/clerk_client.dart';
import '../../core/logo.dart';
import '../../core/theme.dart';

/// AvaTOK-styled email/password sign-in, backed by Clerk's Frontend API.
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
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  Future<void> _signIn() async {
    if (_email.text.trim().isEmpty || _pass.text.isEmpty) {
      setState(() => _error = 'Enter your email and password');
      return;
    }
    setState(() { _busy = true; _error = null; });
    final err = await widget.clerk.signIn(_email.text, _pass.text);
    if (!mounted) return;
    setState(() => _busy = false);
    if (err == null) {
      widget.onSignedIn();
    } else {
      setState(() => _error = err);
    }
  }

  @override
  Widget build(BuildContext context) {
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
              Text('Welcome back',
                  style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 36)),
              const SizedBox(height: 6),
              const Text('Log in to your AvaTOK account',
                  style: TextStyle(color: AvaColors.sub, fontSize: 15)),
              const SizedBox(height: 36),
              _label('EMAIL'),
              _field(child: TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: _bare('you@example.com'),
                style: const TextStyle(fontSize: 16),
              )),
              const SizedBox(height: 16),
              _label('PASSWORD'),
              _field(child: Row(children: [
                Expanded(child: TextField(
                  controller: _pass,
                  obscureText: _obscure,
                  decoration: _bare('••••••••'),
                  style: const TextStyle(fontSize: 16),
                  onSubmitted: (_) => _signIn(),
                )),
                IconButton(
                  icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                      color: AvaColors.sub, size: 20),
                  onPressed: () => setState(() => _obscure = !_obscure),
                ),
              ])),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 13)),
              ],
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _busy ? null : _signIn,
                  child: _busy
                      ? const SizedBox(height: 20, width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Log In'),
                ),
              ),
              const SizedBox(height: 24),
              const Center(
                child: Text('Secured by Clerk · identity is your private Nostr key',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AvaColors.sub, fontSize: 12)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 8),
        child: Text(t, style: const TextStyle(
            color: AvaColors.sub, fontSize: 12, letterSpacing: 1.2, fontWeight: FontWeight.w700)),
      );

  Widget _field({required Widget child}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
        child: child,
      );

  InputDecoration _bare(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Color(0xFFAAB0B8)),
        border: InputBorder.none,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(vertical: 14),
      );
}
