import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/auth/session.dart';
import 'core/brand.dart';
import 'core/router/app_router.dart';
import 'core/router/deep_link_handler.dart';
import 'core/theme/hf_theme.dart';
import 'features/push/ui/push_overlay.dart';
import 'features/wallet/wallet_providers.dart';

/// Root widget. [listenForLinks] is false in widget tests (no platform channel).
class HfApp extends ConsumerStatefulWidget {
  const HfApp({super.key, this.listenForLinks = true});

  final bool listenForLinks;

  @override
  ConsumerState<HfApp> createState() => _HfAppState();
}

class _HfAppState extends ConsumerState<HfApp> with WidgetsBindingObserver {
  StreamSubscription<Uri>? _sub;
  String? _lastLink;
  DateTime _lastLinkAt = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.listenForLinks) _listen();
  }

  Future<void> _listen() async {
    final links = AppLinks();
    try {
      final initial = await links.getInitialLink();
      if (initial != null) _onLink(initial, launch: 'cold');
    } catch (_) {
      // no initial link
    }
    _sub = links.uriLinkStream.listen((u) => _onLink(u, launch: 'warm'), onError: (_) {});
  }

  void _onLink(Uri uri, {required String launch}) {
    final text = uri.toString();
    final now = DateTime.now();
    // The initial link can be delivered twice (getInitialLink and the stream).
    if (text == _lastLink && now.difference(_lastLinkAt) < const Duration(seconds: 2)) return;
    _lastLink = text;
    _lastLinkAt = now;
    final source = uri.scheme == Brand.scheme ? 'scheme' : 'link';
    ref.read(deepLinkHandlerProvider).handle(text, source: source, launch: launch);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final session = ref.read(sessionProvider);
    final notifier = ref.read(sessionProvider.notifier);
    if (session.isSignedIn) {
      ref.read(clerkProvider).warmSession();
    } else if (!session.isLoading) {
      notifier.restore();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // [HF-NATIVE-6] Signed in: start the Play purchase listener and finish any unfinished purchase.
    ref.watch(purchaseRecoveryProvider);
    return MaterialApp.router(
      title: Brand.name,
      debugShowCheckedModeBanner: false,
      theme: buildHfTheme(),
      routerConfig: ref.watch(appRouterProvider),
      // [HF-NATIVE-7] push banner, opt-in sheet and token registration
      builder: (context, child) => PushOverlay(child: child ?? const SizedBox.shrink()),
    );
  }
}
