import 'package:flutter/material.dart';

import 'core/theme.dart';
import 'features/onboarding/welcome_screen.dart';

void main() => runApp(const AvaTalkApp());

class AvaTalkApp extends StatelessWidget {
  const AvaTalkApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AvaTOK',
      debugShowCheckedModeBanner: false,
      theme: AvaTheme.light,
      home: const WelcomeScreen(),
    );
  }
}
