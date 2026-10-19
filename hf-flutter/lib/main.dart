import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'core/brand.dart';
import 'demo/router.dart';
import 'demo/theme.dart';

/// DEMO FRONTEND (owner, 2026-10-19).
/// Screens only, dummy data, every tap wired to the right screen. The backend is wired
/// screen by screen once the owner approves the experience on his phone.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Color(0x00000000),
      systemNavigationBarColor: Color(0x00000000),
    ),
  );
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  runApp(const HfDemoApp());
}

class HfDemoApp extends StatelessWidget {
  const HfDemoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: Brand.name,
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      routerConfig: router,
    );
  }
}
