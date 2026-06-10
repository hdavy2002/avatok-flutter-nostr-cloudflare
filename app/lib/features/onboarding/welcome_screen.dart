import 'package:flutter/material.dart';

import '../../core/logo.dart';
import '../../core/theme.dart';

/// "Everything you do, one account." — pre-auth welcome (dark ink, super-app).
class WelcomeScreen extends StatelessWidget {
  final VoidCallback onContinue;
  const WelcomeScreen({super.key, required this.onContinue});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: AvaColors.welcomeGradient),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(28, 0, 28, 24),
            child: Column(
              children: [
                const Spacer(flex: 3),
                Container(
                  width: 96, height: 96,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.35),
                        blurRadius: 28, offset: const Offset(0, 12))],
                  ),
                  // The mark fills the card (was a small A floating in white).
                  child: const Center(child: AvaLogo(size: 76)),
                ),
                const SizedBox(height: 22),
                Text('A V A T O K',
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.9),
                        fontSize: 13, letterSpacing: 6, fontWeight: FontWeight.w600)),
                const SizedBox(height: 18),
                Text('Everything you do,\none account.', textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.displayLarge?.copyWith(
                        color: Colors.white, fontSize: 38, height: 1.08)),
                const SizedBox(height: 16),
                Text(
                  'Calls, chat, social, market and storage —\none app, in sync on every device.\nSign in and everything follows you.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.78), fontSize: 14, height: 1.5),
                ),
                const SizedBox(height: 22),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: Colors.white.withValues(alpha: 0.28)),
                  ),
                  child: const Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(Icons.apps_rounded, color: AvaColors.brand, size: 15),
                    SizedBox(width: 6),
                    Text('ALL YOUR APPS · ONE ACCOUNT',
                        style: TextStyle(color: Colors.white, fontSize: 11,
                            letterSpacing: 1, fontWeight: FontWeight.w700)),
                  ]),
                ),
                const Spacer(flex: 4),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: Colors.white, foregroundColor: AvaColors.ink,
                      padding: const EdgeInsets.symmetric(vertical: 18),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    ),
                    onPressed: onContinue,
                    child: const Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Text('Continue', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                      SizedBox(width: 8), Icon(Icons.arrow_forward, size: 18),
                    ]),
                  ),
                ),
                const SizedBox(height: 14),
                Text('By continuing you agree to our Terms & Privacy',
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.8), fontSize: 12)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
