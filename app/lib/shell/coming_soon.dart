import 'package:flutter/material.dart';

import '../core/theme.dart';

/// Placeholder for an app whose screens aren't built yet. Keeps the app's
/// brand header so navigation feels complete.
class ComingSoon extends StatelessWidget {
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  const ComingSoon({super.key, required this.title, required this.subtitle, required this.icon, required this.color});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        foregroundColor: AvaColors.ink,
        leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.pop(context)),
        title: Row(children: [
          Container(width: 28, height: 28,
              decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(8)),
              child: Icon(icon, color: Colors.white, size: 16)),
          const SizedBox(width: 8),
          Text(title, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 18)),
        ]),
      ),
      body: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 84, height: 84,
              decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(24)),
              child: Icon(icon, color: color, size: 40)),
          const SizedBox(height: 18),
          Text(title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 6),
          Text(subtitle, style: const TextStyle(color: AvaColors.sub)),
          const SizedBox(height: 10),
          const Text('Screens coming soon', style: TextStyle(color: AvaColors.sub, fontSize: 12)),
        ]),
      ),
    );
  }
}
