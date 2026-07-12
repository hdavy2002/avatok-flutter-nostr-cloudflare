import 'dart:io';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/update_service.dart';
import '../shell_v2.dart';
import 'app_order_screen.dart';
import 'card_manager_screen.dart';
import 'home_app_switcher.dart';
import 'home_appearance_screen.dart';
import 'home_cards.dart';
import 'home_personalisation.dart';
import 'root_order_store.dart';
import 'shell_chrome.dart';
import 'shell_destinations.dart';

/// Home root (plan §3) — a scrollable dashboard of cards, with the footer acting
/// as the app switcher (Home · AvaDial · AvaTalk · Services · AI). AI is a GLOBAL
/// ACTION (opens the universal Ask Ava assistant), NOT a navigator root.
///
/// Personalisation (§D): the per-account [HomePersonalisation] look (font size,
/// accent, wallpaper) applies to THIS surface only — the body is wrapped in a
/// textScaler + optional wallpaper, and the footer indicator takes the accent.
class HomeRoot extends StatefulWidget {
  const HomeRoot({super.key});

  @override
  State<HomeRoot> createState() => _HomeRootState();
}

class _HomeRootState extends State<HomeRoot> {
  @override
  void initState() {
    super.initState();
    HomePersonalisation.load(); // per-account look; repaints via its revision notifier
    _maybeShowReorderHint();
  }

  /// One-time, per-account nudge that the footer icons can be rearranged and the
  /// first one is the landing app (AVA-SHELL-8, rule 1).
  Future<void> _maybeShowReorderHint() async {
    if (await RootOrderPrefs.hintSeen()) return;
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('Hold an icon to rearrange — the first one opens at launch'),
          backgroundColor: Zine.ink,
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 5),
        ),
      );
      RootOrderPrefs.markHintSeen();
    });
  }

  @override
  Widget build(BuildContext context) {
    final scope = ShellScope.of(context);

    return ValueListenableBuilder<int>(
      valueListenable: HomePersonalisation.revision,
      builder: (context, _, __) {
        final wallpaper = HomePersonalisation.wallpaperPath;
        final scale = HomePersonalisation.fontScale;
        Widget body = const HomeCards();
        // Wallpaper renders behind the cards; a soft scrim keeps the ink text legible.
        if (wallpaper != null) {
          body = Stack(children: [
            Positioned.fill(
              child: Image.file(File(wallpaper), fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => const SizedBox.shrink()),
            ),
            Positioned.fill(child: Container(color: Zine.paper.withValues(alpha: 0.82))),
            body,
          ]);
        }
        return Scaffold(
          backgroundColor: Zine.paper,
          drawer: ShellSidebar(
            current: RootId.home,
            extra: [
              Padding(
                padding: const EdgeInsets.fromLTRB(6, 8, 6, 4),
                child: Text('THIS DEVICE', style: ZineText.kicker()),
              ),
              ShellMenuRow(
                icon: PhosphorIcons.squaresFour(PhosphorIconsStyle.bold),
                color: Zine.lime,
                title: 'Cards',
                subtitle: 'Choose what shows on Home',
                onTap: () {
                  Navigator.of(context).maybePop();
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const HomeCardsManagerScreen()));
                },
              ),
              ShellMenuRow(
                icon: PhosphorIcons.listNumbers(PhosphorIconsStyle.bold),
                color: Zine.lilac,
                title: 'App order',
                subtitle: 'Reorder apps & pick your landing app',
                onTap: () {
                  Navigator.of(context).maybePop();
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const AppOrderScreen()));
                },
              ),
              ShellMenuRow(
                icon: PhosphorIcons.paintBrush(PhosphorIconsStyle.bold),
                color: Zine.coral,
                title: 'Appearance',
                subtitle: 'Font, accent & wallpaper',
                onTap: () {
                  Navigator.of(context).maybePop();
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const HomeAppearanceScreen()));
                },
              ),
              ShellMenuRow(
                icon: PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
                color: Zine.blue,
                title: 'Identity',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'identity');
                },
              ),
              ShellMenuRow(
                icon: PhosphorIcons.chartPieSlice(PhosphorIconsStyle.bold),
                color: Zine.mint,
                title: 'Backup',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'avastorage');
                },
              ),
              ShellMenuRow(
                icon: PhosphorIcons.info(PhosphorIconsStyle.bold),
                color: Zine.lilac,
                title: 'About',
                onTap: () {
                  Navigator.of(context).maybePop();
                  openShellDestination(context, 'about');
                },
              ),
              ShellMenuRow(
                icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
                color: Zine.coral,
                title: 'Update',
                onTap: () {
                  Navigator.of(context).maybePop();
                  UpdateService.runManual();
                },
              ),
            ],
          ),
          appBar: AppBar(
            backgroundColor: Zine.paper2,
            surfaceTintColor: Colors.transparent,
            elevation: 0,
            shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
            leading: Builder(
              builder: (ctx) => IconButton(
                icon: PhosphorIcon(PhosphorIcons.list(PhosphorIconsStyle.bold), color: Zine.ink),
                onPressed: () => Scaffold.of(ctx).openDrawer(),
              ),
            ),
            title: Text('Home', style: ZineText.appbar()),
          ),
          // Draggable app switcher (AVA-SHELL-8): the four root icons in the
          // user's chosen order (long-press to rearrange → order.first = landing
          // app), plus a FIXED AI action pinned at the far right.
          bottomNavigationBar: HomeAppSwitcherBar(
            order: scope.rootOrder,
            activeRoot: scope.activeRoot,
            onSelect: scope.switchRoot,
            onReorder: scope.setRootOrder,
            onAskAva: scope.askAva,
            indicatorColor: HomePersonalisation.accentColor,
          ),
          body: SafeArea(
            top: false,
            child: MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: body,
            ),
          ),
        );
      },
    );
  }
}
