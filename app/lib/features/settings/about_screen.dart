import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/config.dart' show kSignalingHost;
import '../../core/feature_flags.dart' show kAvatokEnv, kAppBuild, kAppVersion;

/// ACCOUNT & SETTINGS → About. Shows the app version, build, environment
/// (prod/staging) and the exact git build — so a tester/owner can tell at a
/// glance which build and which backend a device is running.
class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final env = kAvatokEnv.toUpperCase(); // PROD | STAGING
    final isProd = kAvatokEnv == 'prod';
    return Scaffold(
      appBar: AppBar(title: const Text('About')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const SizedBox(height: 8),
          Row(children: [
            const Text('AvaTOK', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
            const SizedBox(width: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: isProd ? Colors.green.shade600 : Colors.orange.shade700,
                borderRadius: BorderRadius.circular(100),
              ),
              child: Text(env, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12)),
            ),
          ]),
          const SizedBox(height: 20),
          _row('Version', '$kAppVersion (build $kAppBuild)'),
          _row('Environment', env),
          _row('Backend', kSignalingHost),
          _row('Build (git)', Analytics.release),
          const SizedBox(height: 28),
          const Text(
            'Tip: testers should install the prod build to use live features. '
            'A STAGING badge means this device is talking to the staging backend.',
            style: TextStyle(color: Colors.grey, fontSize: 12),
          ),
        ],
      ),
    );
  }

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 9),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(fontSize: 12, color: Colors.grey, fontWeight: FontWeight.w600)),
            const SizedBox(height: 3),
            SelectableText(value, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          ],
        ),
      );
}
