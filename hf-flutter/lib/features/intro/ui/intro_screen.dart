import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/brand.dart';
import '../../../core/router/startup_navigation.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/install_intro_store.dart';

class IntroScreen extends ConsumerStatefulWidget {
  const IntroScreen({super.key});

  @override
  ConsumerState<IntroScreen> createState() => _IntroScreenState();
}

class _IntroScreenState extends ConsumerState<IntroScreen> {
  static const _pages = [
    (
      title: 'Find the right person to talk to',
      body: 'Browse by language and mood. Find someone who feels right for the conversation you want.',
      image: 'find-person',
      imageLabel: 'Two adults sharing a relaxed conversation',
      note: 'Your language. Your mood. Your choice.',
    ),
    (
      title: 'Listen before you connect',
      body: 'Hear a voice intro, read ratings and see clear pricing before you call.',
      image: 'listen-first',
      imageLabel: 'A woman listening through an earbud',
      note: 'You are charged only while connected.',
    ),
    (
      title: 'Explore freely',
      body: 'Browse without an account. We will ask you to sign in when you call, open your wallet or visit your profile.',
      image: 'explore-freely',
      imageLabel: 'A man comfortably browsing on his phone',
      note: 'Take a look around. No sign-in needed.',
    ),
  ];

  final ScrollController _scroll = ScrollController();
  int _page = 0;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _trackView();
  }

  void _trackView() => unawaited(Analytics.capture('hf_app_intro_viewed', {
    'page': _page + 1,
    'intro_version': 1,
  }));

  void _show(int page) {
    if (_busy || page == _page) return;
    setState(() => _page = page);
    if (_scroll.hasClients) _scroll.jumpTo(0);
    _trackView();
  }

  Future<void> _complete({required bool skipped}) async {
    if (_busy) return;
    setState(() => _busy = true);
    final saved = await ref.read(installIntroStoreProvider).complete();
    await Analytics.capture('hf_app_intro_completed', {
      'page': _page + 1,
      'method': skipped ? 'skip' : 'explore',
      'persisted': saved,
      'intro_version': 1,
    });
    if (!mounted) return;
    await ref.read(startupNavigationProvider).openLanding();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final page = _pages[_page];
    final dark = HfBrightness.isDark(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || _busy) return;
        if (_page > 0) {
          _show(_page - 1);
        } else {
          unawaited(SystemNavigator.pop());
        }
      },
      child: Scaffold(
        backgroundColor: dark ? HfColors.darkBg : HfColors.page,
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: LayoutBuilder(builder: (context, constraints) {
                final photoHeight = (constraints.maxHeight * .40)
                    .clamp(180.0, 340.0).toDouble();
                return SingleChildScrollView(
                  controller: _scroll,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(minHeight: constraints.maxHeight),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Column(children: [
                            Row(children: [
                              Expanded(child: Text(Brand.name,
                                style: HfText.of(context, HfText.section))),
                              const SizedBox(width: 8),
                              TextButton(
                                key: const ValueKey('intro-skip'),
                                style: TextButton.styleFrom(
                                  minimumSize: const Size(48, 48)),
                                onPressed: _busy ? null
                                  : () => _complete(skipped: true),
                                child: const Text('Skip'),
                              ),
                            ]),
                            const SizedBox(height: 20),
                            Container(
                              key: ValueKey('intro-photo-${page.image}'),
                              padding: const EdgeInsets.all(5),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(32),
                                boxShadow: dark ? HfShadows.navDark : HfShadows.nav,
                              ),
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(27),
                                child: Image.asset(
                                  'assets/images/intro/${page.image}.webp',
                                  height: photoHeight,
                                  width: double.infinity,
                                  fit: BoxFit.cover,
                                  alignment: const Alignment(0, -.3),
                                  semanticLabel: page.imageLabel,
                                ),
                              ),
                            ),
                            const SizedBox(height: 28),
                            Semantics(
                              header: true,
                              liveRegion: true,
                              child: Text(page.title,
                                textAlign: TextAlign.center,
                                style: HfText.of(context, HfText.hero)),
                            ),
                            const SizedBox(height: 14),
                            Text(page.body,
                              textAlign: TextAlign.center,
                              style: HfText.of(context, HfText.body)),
                            const SizedBox(height: 16),
                            Text(page.note,
                              textAlign: TextAlign.center,
                              style: HfText.of(context, HfText.bodyStrong)),
                          ]),
                          Padding(
                            padding: const EdgeInsets.only(top: 24),
                            child: Column(children: [
                              Text('Page ${_page + 1} of 3',
                                style: HfText.of(context, HfText.note)),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [for (var i = 0; i < 3; i++)
                                  Semantics(
                                    label: 'Page ${i + 1} of 3',
                                    selected: i == _page,
                                    button: true,
                                    child: IconButton(
                                      key: ValueKey('intro-dot-$i'),
                                      tooltip: 'Go to page ${i + 1}',
                                      constraints: const BoxConstraints(
                                        minWidth: 48, minHeight: 48),
                                      onPressed: _busy ? null : () => _show(i),
                                      icon: Icon(Icons.circle,
                                        size: i == _page ? 12 : 8,
                                        color: i == _page
                                          ? (dark ? HfColors.lavenderLight : HfColors.link)
                                          : (dark ? HfColors.mutedSoft : HfColors.handle)),
                                    ),
                                  ),
                                ],
                              ),
                              HfButton(
                                key: const ValueKey('intro-next'),
                                label: _page == 2 ? 'Start exploring' : 'Next',
                                loading: _busy,
                                onPressed: _busy ? null : () {
                                  if (_page == 2) {
                                    unawaited(_complete(skipped: false));
                                  } else {
                                    _show(_page + 1);
                                  }
                                },
                              ),
                            ]),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
        ),
      ),
    );
  }
}
