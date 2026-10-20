import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/telemetry.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-REELS-FAV-1] Catch-all for any location the router does not know. Never shows the raw GoException.
class PageMovedScreen extends StatefulWidget {
  const PageMovedScreen({super.key, required this.location});

  final String location;

  @override
  State<PageMovedScreen> createState() => _PageMovedScreenState();
}

class _PageMovedScreenState extends State<PageMovedScreen> {
  @override
  void initState() {
    super.initState();
    // the path only: no query string, so nothing personal rides along
    Telemetry.event('hf_page_not_found', {'path': Uri.tryParse(widget.location)?.path ?? ''});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.cream,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.explore_off_rounded, size: 64, color: C.maroon),
                const SizedBox(height: 16),
                Text('This page moved', textAlign: TextAlign.center, style: t(28, color: C.maroon, ls: 0.03)),
                const SizedBox(height: 8),
                Text('We could not find that page. Let us take you back to the reels.', textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w700, h: 1.4)),
                const SizedBox(height: 24),
                SizedBox(
                  width: 220,
                  child: ChunkyButton(key: const ValueKey('page-moved-home'), label: 'HOME', icon: Icons.home_rounded, onTap: () => context.go('/reels')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// GoRouter `errorBuilder`.
Widget hfErrorPage(BuildContext context, GoRouterState state) => PageMovedScreen(location: state.uri.toString());
