import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

import 'auth/clerk_client.dart';
import 'core/theme.dart';
import 'features/auth/sign_in_screen.dart';
import 'features/avatok/chat_list.dart';
import 'push/push_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);
    await PushService.init();
  } catch (_) {/* push unavailable; app still works */}
  runApp(const AvaTalkApp());
}

class AvaTalkApp extends StatelessWidget {
  const AvaTalkApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AvaTOK',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: AvaTheme.light,
      home: const RootGate(),
    );
  }
}

/// Gates on the Clerk session: signed in → AvaTok, else → sign-in.
class RootGate extends StatefulWidget {
  const RootGate({super.key});
  @override
  State<RootGate> createState() => _RootGateState();
}

class _RootGateState extends State<RootGate> {
  final _clerk = ClerkClient();
  bool _loading = true;
  bool _signedIn = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    bool signed = false;
    try {
      signed = (await _clerk.currentUser()) != null;
    } catch (_) {}
    if (mounted) setState(() { _signedIn = signed; _loading = false; });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator(color: AvaColors.brand)));
    }
    if (_signedIn) {
      return ChatListScreen(
        clerk: _clerk,
        onSignOut: () => setState(() => _signedIn = false),
      );
    }
    return SignInScreen(
      clerk: _clerk,
      onSignedIn: () => setState(() => _signedIn = true),
    );
  }
}
