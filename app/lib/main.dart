import 'package:flutter/material.dart';

import 'core/theme.dart';
import 'features/home/home_launcher.dart';

void main() => runApp(const AvaTalkApp());

class AvaTalkApp extends StatelessWidget {
  const AvaTalkApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AvaTalk',
      debugShowCheckedModeBanner: false,
      theme: AvaTheme.light,
      home: const HomeLauncher(),
    );
  }
}
