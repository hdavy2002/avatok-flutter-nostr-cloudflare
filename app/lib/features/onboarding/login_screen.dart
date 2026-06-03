import 'package:flutter/material.dart';

import '../../core/logo.dart';
import '../../core/theme.dart';
import '../avatok/chat_list.dart';
import 'notifications_screen.dart';

/// "Welcome back" — login. (Wires to Clerk later; for now advances the flow.)
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController(text: 'ava@avatok.com');
  final _pass = TextEditingController(text: 'avatok123');
  bool _obscure = true;

  void _login() => Navigator.pushAndRemoveUntil(context,
      MaterialPageRoute(builder: (_) => const ChatListScreen()), (_) => false);

  void _signup() => Navigator.push(context,
      MaterialPageRoute(builder: (_) => const NotificationsScreen()));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 36, 28, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 30),
              const AvaLogo(size: 52),
              const SizedBox(height: 22),
              Text('Welcome back',
                  style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 36)),
              const SizedBox(height: 6),
              const Text('Log in to your AvaTOK account',
                  style: TextStyle(color: AvaColors.sub, fontSize: 15)),
              const SizedBox(height: 36),
              _fieldLabel('EMAIL OR USERNAME'),
              _softField(child: TextField(
                controller: _email,
                decoration: _bare(),
                style: const TextStyle(fontSize: 16),
              )),
              const SizedBox(height: 16),
              _fieldLabel('PASSWORD'),
              _softField(child: Row(children: [
                Expanded(child: TextField(
                  controller: _pass,
                  obscureText: _obscure,
                  decoration: _bare(),
                  style: const TextStyle(fontSize: 16, letterSpacing: 2),
                )),
                IconButton(
                  icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                      color: AvaColors.sub, size: 20),
                  onPressed: () => setState(() => _obscure = !_obscure),
                ),
              ])),
              const SizedBox(height: 14),
              Align(
                alignment: Alignment.centerRight,
                child: Text('Forgot password?',
                    style: TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w700)),
              ),
              const SizedBox(height: 18),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _login,
                  child: const Text('Log In'),
                ),
              ),
              const SizedBox(height: 16),
              Center(
                child: TextButton(
                  onPressed: _signup,
                  child: const Text('Sign Up',
                      style: TextStyle(color: AvaColors.ink, fontWeight: FontWeight.w700, fontSize: 15)),
                ),
              ),
              const SizedBox(height: 24),
              const Center(
                child: Text('New here? Signing up walks you through a quick secure setup.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AvaColors.sub, fontSize: 12)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _fieldLabel(String t) => Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 8),
        child: Text(t,
            style: const TextStyle(
                color: AvaColors.sub, fontSize: 12, letterSpacing: 1.2, fontWeight: FontWeight.w700)),
      );

  Widget _softField({required Widget child}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        decoration: BoxDecoration(
            color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
        child: child,
      );

  InputDecoration _bare() => const InputDecoration(
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        isDense: true,
        contentPadding: EdgeInsets.symmetric(vertical: 14),
        filled: false,
      );
}
