import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/analytics.dart';
import '../../core/config.dart' show kSignalingHost;
import '../../core/feature_flags.dart' show kAvatokEnv, kAppBuild, kAppVersion;

/// ACCOUNT & SETTINGS → About. Shows the app version, build, environment
/// (prod/staging) and the exact git build — so a tester/owner can tell at a
/// glance which build and which backend a device is running.
///
/// Version + build are read from the REAL installed package via
/// [PackageInfo] — NOT the compile-time [kAppVersion]/[kAppBuild] constants,
/// which were hardcoded and so never changed after an update (the reported
/// "build number never changes" bug). CI ships a strictly-increasing
/// versionCode via `flutter build --build-number`, which PackageInfo surfaces.
/// The constants remain only as a first-frame fallback until the async load
/// resolves.
class AboutScreen extends StatefulWidget {
  const AboutScreen({super.key});

  @override
  State<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends State<AboutScreen> {
  // Seeded with the compile-time constants so the row is never blank; replaced
  // with the real installed values as soon as PackageInfo resolves.
  String _version = kAppVersion;
  String _build = '$kAppBuild';

  @override
  void initState() {
    super.initState();
    PackageInfo.fromPlatform().then((info) {
      if (!mounted) return;
      setState(() {
        if (info.version.isNotEmpty) _version = info.version;
        if (info.buildNumber.isNotEmpty) _build = info.buildNumber;
      });
    }).catchError((_) {/* keep constant fallback */});
  }

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
          _row('Version', '$_version (build $_build)'),
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
