import 'package:clerk_flutter/clerk_flutter.dart';
import 'package:flutter/material.dart';

import 'core/config.dart';
import 'core/theme.dart';
import 'features/auth/auth_screen.dart';
import 'features/avatok/chat_list.dart';

void main() => runApp(const AvaTalkApp());

class AvaTalkApp extends StatelessWidget {
  const AvaTalkApp({super.key});
  @override
  Widget build(BuildContext context) {
    return ClerkAuth(
      config: ClerkAuthConfig(publishableKey: kClerkPublishableKey),
      child: MaterialApp(
        title: 'AvaTOK',
        debugShowCheckedModeBanner: false,
        theme: AvaTheme.light,
        home: ClerkErrorListener(
          child: ClerkAuthBuilder(
            signedInBuilder: (context, authState) => const ChatListScreen(),
            signedOutBuilder: (context, authState) => const AuthScreen(),
          ),
        ),
      ),
    );
  }
}
