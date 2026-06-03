import 'package:flutter/material.dart';

import '../../core/theme.dart';
import '../avatok/chat_list.dart';

/// "Stay in the loop" — notifications step of the sign-up flow.
class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  void _done(BuildContext context) => Navigator.pushAndRemoveUntil(context,
      MaterialPageRoute(builder: (_) => const ChatListScreen()), (_) => false);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(28, 16, 28, 24),
          child: Column(
            children: [
              const SizedBox(height: 8),
              _dots(0, 5),
              const Spacer(flex: 2),
              Container(
                width: 96, height: 96,
                decoration: BoxDecoration(
                    color: AvaColors.brand50, borderRadius: BorderRadius.circular(26)),
                child: const Icon(Icons.notifications_none_rounded,
                    color: AvaColors.brand, size: 46),
              ),
              const SizedBox(height: 22),
              Text('Stay in the loop',
                  style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 32)),
              const SizedBox(height: 12),
              const Text(
                'Get notified when creators you follow post, when you earn a payout, or when someone tips your work.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AvaColors.sub, fontSize: 14, height: 1.5),
              ),
              const SizedBox(height: 28),
              _row(Icons.favorite_border, 'New followers & tips'),
              const SizedBox(height: 12),
              _row(Icons.account_balance_wallet_outlined, 'Payouts & wallet activity'),
              const SizedBox(height: 12),
              _row(Icons.chat_bubble_outline, 'Replies & mentions'),
              const Spacer(flex: 3),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () => _done(context),
                  icon: const Icon(Icons.notifications_none_rounded, size: 20),
                  label: const Text('Allow Notifications'),
                ),
              ),
              const SizedBox(height: 10),
              TextButton(
                onPressed: () => _done(context),
                child: const Text('Not now',
                    style: TextStyle(color: AvaColors.sub, fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _dots(int active, int total) => Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: List.generate(total, (i) {
          final on = i == active;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            margin: const EdgeInsets.symmetric(horizontal: 3),
            width: on ? 22 : 7,
            height: 7,
            decoration: BoxDecoration(
                color: on ? AvaColors.brand : AvaColors.line,
                borderRadius: BorderRadius.circular(4)),
          );
        }),
      );

  Widget _row(IconData icon, String label) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        decoration: BoxDecoration(
            color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
        child: Row(children: [
          Icon(icon, color: AvaColors.brand, size: 22),
          const SizedBox(width: 14),
          Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        ]),
      );
}
