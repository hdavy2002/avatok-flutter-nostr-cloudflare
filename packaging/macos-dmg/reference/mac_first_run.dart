// REFERENCE FILE — move to app/lib/features/onboarding/mac_first_run.dart to use.
//
// Beautiful first-launch "install pipeline" shown ONCE after the user opens the
// freshly-installed Mac app. Built entirely from the existing Zine design system
// (ZinePaper / ZineButton / ZineCard / ZineSticker / ZineCrest / ZineStepPips /
// ZineText / Zine.*), so it matches the rest of the app exactly. No new deps.
//
// Wiring (see PROPOSAL-MACOS-INSTALL-EXPERIENCE.md §4):
//   1. Gate on a "seen" flag. Recommended: device-level (the install, not the
//      account) — e.g. flutter_secure_storage with a GLOBAL key, since this is a
//      per-machine welcome, not per-account state. If you'd rather scope it per
//      account, use scopedKey('mac_first_run_seen') from core/account_storage.dart.
//   2. In main.dart, after Flutter init, BEFORE showing the shell, on macOS only:
//        if (Platform.isMacOS && !await MacFirstRun.seen()) {
//          await Navigator.push(context, MaterialPageRoute(
//              builder: (_) => MacFirstRun(onDone: () => Navigator.pop(context))));
//          await MacFirstRun.markSeen();
//        }
//
// Keep "everything the same": this is ADDITIVE and macOS-gated. It does not touch
// the existing mobile WelcomeScreen / onboarding_flow.

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

class MacFirstRun extends StatefulWidget {
  final VoidCallback onDone;
  const MacFirstRun({super.key, required this.onDone});

  // --- "seen once" flag (replace the in-memory stub with secure storage) -----
  static bool _seenMem = false;
  static Future<bool> seen() async => _seenMem;
  static Future<void> markSeen() async => _seenMem = true;

  @override
  State<MacFirstRun> createState() => _MacFirstRunState();
}

class _MacFirstRunState extends State<MacFirstRun> {
  final _pc = PageController();
  int _i = 0;
  static const _count = 4;

  void _next() {
    if (_i >= _count - 1) {
      widget.onDone();
      return;
    }
    _pc.nextPage(duration: Zine.durSlow, curve: Curves.easeOutCubic);
  }

  void _back() {
    if (_i == 0) return;
    _pc.previousPage(duration: Zine.durSlow, curve: Curves.easeOutCubic);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ZinePaper(
        child: SafeArea(
          child: Center(
            // Desktop: keep content in a comfortable centered column, not edge-to-edge.
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(32, 24, 32, 28),
                child: Column(children: [
                  // top bar: back + step pips
                  Row(children: [
                    Opacity(
                      opacity: _i == 0 ? 0 : 1,
                      child: ZineBackButton(onTap: _back),
                    ),
                    const Spacer(),
                    ZineStepPips(count: _count, index: _i),
                    const Spacer(),
                    const SizedBox(width: 44), // balance the back button
                  ]),
                  Expanded(
                    child: PageView(
                      controller: _pc,
                      onPageChanged: (v) => setState(() => _i = v),
                      children: const [
                        _WelcomePanel(),
                        _FeaturesPanel(),
                        _PermissionsPanel(),
                        _ReadyPanel(),
                      ],
                    ),
                  ),
                  ZineButton(
                    label: _i == _count - 1 ? 'Open AvaTok' : 'Continue',
                    icon: _i == _count - 1
                        ? PhosphorIcons.check(PhosphorIconsStyle.bold)
                        : PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                    fullWidth: true,
                    fontSize: 20,
                    onPressed: _next,
                  ),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Panel 1 — Welcome
class _WelcomePanel extends StatelessWidget {
  const _WelcomePanel();
  @override
  Widget build(BuildContext context) {
    return Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      const ZineCrest(),
      const SizedBox(height: 20),
      Text.rich(
        TextSpan(
          style: const TextStyle(
              fontFamily: ZineText.display,
              fontWeight: FontWeight.w700,
              fontSize: 26,
              letterSpacing: -0.4,
              color: Zine.ink),
          children: const [
            TextSpan(text: 'Ava'),
            TextSpan(text: 'TOK', style: TextStyle(color: Zine.blueInk)),
            TextSpan(text: '  for Mac'),
          ],
        ),
      ),
      const SizedBox(height: 14),
      const ZineMarkTitle(
        pre: 'Your whole world,\nnow on the ',
        mark: 'big',
        post: ' screen.',
        fontSize: 32,
      ),
      const SizedBox(height: 16),
      ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: Text(
          'Same account, same chats and calls — synced to your Mac and laid out '
          'for a full desktop window.',
          style: ZineText.sub(),
          textAlign: TextAlign.center,
        ),
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Panel 2 — What you can do (feature grid)
class _FeaturesPanel extends StatelessWidget {
  const _FeaturesPanel();
  @override
  Widget build(BuildContext context) {
    final items = <(IconData, String, String, Color)>[
      (PhosphorIcons.chatCircle(PhosphorIconsStyle.fill), 'Chat & calls',
          'Messages, voice & video — side by side.', Zine.blue),
      (PhosphorIcons.storefront(PhosphorIconsStyle.fill), 'Marketplace',
          'Browse & sell with room to breathe.', Zine.lime),
      (PhosphorIcons.cloud(PhosphorIconsStyle.fill), 'Storage',
          'Your files, one pool, every device.', Zine.lilac),
      (PhosphorIcons.wallet(PhosphorIconsStyle.fill), 'Wallet',
          'AvaCoins & payouts at a glance.', Zine.mint),
    ];
    return Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      const ZineMarkTitle(pre: 'Everything, ', mark: 'unfolded', post: '.', fontSize: 30),
      const SizedBox(height: 20),
      GridView.count(
        shrinkWrap: true,
        crossAxisCount: 2,
        mainAxisSpacing: 14,
        crossAxisSpacing: 14,
        childAspectRatio: 1.5,
        physics: const NeverScrollableScrollPhysics(),
        children: [
          for (final (icon, title, sub, c) in items)
            ZineCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                ZineIconBadge(icon: icon, color: c),
                const SizedBox(height: 10),
                Text(title, style: ZineText.cardTitle()),
                const SizedBox(height: 4),
                Text(sub, style: ZineText.sub()),
              ]),
            ),
        ],
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Panel 3 — Permissions (macOS asks on first use; this sets expectations)
class _PermissionsPanel extends StatelessWidget {
  const _PermissionsPanel();
  @override
  Widget build(BuildContext context) {
    final perms = <(IconData, String, String)>[
      (PhosphorIcons.microphone(PhosphorIconsStyle.fill), 'Microphone',
          'For voice notes and calls.'),
      (PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), 'Camera',
          'For video calls.'),
      (PhosphorIcons.bell(PhosphorIconsStyle.fill), 'Notifications',
          'So you never miss a message or call.'),
    ];
    return Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      const ZineMarkTitle(pre: 'A couple of ', mark: 'asks', post: '.', fontSize: 30),
      const SizedBox(height: 10),
      ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: Text(
          'macOS will pop these up the first time you use each feature — just hit Allow.',
          style: ZineText.sub(),
          textAlign: TextAlign.center,
        ),
      ),
      const SizedBox(height: 18),
      for (final (icon, title, sub) in perms)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: ZineCard(
            child: Row(children: [
              ZineIconBadge(icon: icon, color: Zine.blue),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: ZineText.cardTitle()),
                  Text(sub, style: ZineText.sub()),
                ]),
              ),
            ]),
          ),
        ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Panel 4 — Ready
class _ReadyPanel extends StatelessWidget {
  const _ReadyPanel();
  @override
  Widget build(BuildContext context) {
    return Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      ZineIconBadge(
        icon: PhosphorIcons.confetti(PhosphorIconsStyle.fill),
        color: Zine.lime,
        size: 64,
      ),
      const SizedBox(height: 20),
      const ZineMarkTitle(pre: "You're all ", mark: 'set', post: '.', fontSize: 34),
      const SizedBox(height: 14),
      ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 340),
        child: Text(
          'Sign in with your AvaTok account and pick up right where you left off.',
          style: ZineText.sub(),
          textAlign: TextAlign.center,
        ),
      ),
      const SizedBox(height: 18),
      const ZineSticker('WELCOME TO THE DESKTOP'),
    ]);
  }
}
