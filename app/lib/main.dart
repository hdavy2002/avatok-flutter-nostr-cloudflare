import 'package:flutter/material.dart';

import 'core/theme.dart';
import 'features/home/home_launcher.dart';
import 'features/onboarding/onboarding_page.dart';
import 'identity/identity.dart';

void main() => runApp(const AvaTalkApp());

class AvaTalkApp extends StatelessWidget {
  const AvaTalkApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AvaTalk',
      debugShowCheckedModeBanner: false,
      theme: AvaTheme.light,
      home: const RootGate(),
    );
  }
}

/// Decides between onboarding (no identity yet) and the app launcher.
class RootGate extends StatefulWidget {
  const RootGate({super.key});
  @override
  State<RootGate> createState() => _RootGateState();
}

class _RootGateState extends State<RootGate> {
  final _store = IdentityStore();
  Identity? _id;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final id = await _store.load();
    if (mounted) {
      setState(() {
        _id = id;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: AvaColors.brand)),
      );
    }
    if (_id == null) {
      return OnboardingPage(onComplete: (id) => setState(() => _id = id));
    }
    return HomeLauncher(identity: _id!);
  }
}
