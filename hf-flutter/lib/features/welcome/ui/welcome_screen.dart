import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/brand.dart';
import '../../../core/links.dart';
import '../../../core/router/deep_link_handler.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/ack_service.dart';

/// Copy of the Welcome screen. Simple English; the tick text is the rulebook's Appendix B wording.
abstract final class WelcomeCopy {
  static const String title = 'Before you start';
  static const String intro = 'A few simple rules keep everyone safe and comfortable.';

  static const String rule1Title = "Don't share phone numbers or links";
  static const String rule1Body =
      'Calls keep both numbers private. Sharing contact details can end the call.';
  static const String rule2Title = 'Press # to end and block';
  static const String rule2Body =
      'Press # on your phone at any time. The call ends and that person is blocked.';
  static const String rule3Title = 'A friendly chat, not counselling';
  static const String rule3Body =
      'Hosts are real people. They are not doctors, therapists or counsellors.';

  static const String tick =
      'I understand ${Brand.name} is friendly conversation, not counselling, therapy or a relationship '
      'service. Hosts are independent people and are not mental-health professionals. If I am in crisis I '
      'will call Tele-MANAS 14416 or 112. I am 18 or older.';

  static const String button = 'Continue';
  static const String linksTitle = 'Read more';
  static const String terms = 'Terms';
  static const String privacy = 'Privacy';
  static const String guidelines = 'Community guidelines';
  static const String safety = 'Safety';
}

/// `/welcome`: 18+ and safety rules, one screen, shown first on a device (or account) that has not accepted
/// the current version. Browse-before-sign-in: nothing here asks for an account. The acceptance is kept on the
/// device and sent to the server (`POST /api/hf/me/ack`) once the person is signed in.
class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key});

  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends ConsumerState<WelcomeScreen> {
  bool _ticked = false;
  bool _busy = false;

  Future<void> _continue() async {
    if (!_ticked || _busy) return;
    setState(() => _busy = true);
    try {
      final version = await ref.read(ackServiceProvider).accept();
      await Analytics.capture('hf_app_welcome_accepted', {
        'outcome': 'ok',
        'version': version,
        'signed_in': ref.read(sessionProvider).isSignedIn,
      });
      if (!mounted) return;
      // Links that arrived during start were held until now (the splash does not release them for Welcome).
      ref.read(bootDoneProvider.notifier).markDone();
      final opened = await ref.read(deepLinkHandlerProvider).flushPending();
      if (!mounted) return;
      if (!opened) context.go(Routes.home);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(HfSpacing.page, 24, HfSpacing.page, HfSpacing.page),
                children: [
                  Row(
                    children: [
                      Image.asset(
                        'assets/images/logo.png',
                        width: 56,
                        height: 56,
                        errorBuilder: (_, __, ___) => const SizedBox(width: 56, height: 56),
                      ),
                      const SizedBox(width: 12),
                      const Expanded(child: Text(Brand.name, style: HfText.headline)),
                    ],
                  ),
                  const SizedBox(height: 8),
                  const Text(Brand.slogan, style: HfText.note),
                  const SizedBox(height: HfSpacing.gapLarge),
                  const Text(WelcomeCopy.title, style: HfText.title),
                  const SizedBox(height: 6),
                  const Text(WelcomeCopy.intro, style: HfText.bodyText),
                  const SizedBox(height: HfSpacing.gap),
                  const _RuleCard(
                    icon: Icons.lock_outline_rounded,
                    color: HfColors.lilac,
                    title: WelcomeCopy.rule1Title,
                    body: WelcomeCopy.rule1Body,
                  ),
                  const SizedBox(height: HfSpacing.gap),
                  const _RuleCard(
                    icon: Icons.tag_rounded,
                    color: HfColors.blush,
                    title: WelcomeCopy.rule2Title,
                    body: WelcomeCopy.rule2Body,
                  ),
                  const SizedBox(height: HfSpacing.gap),
                  const _RuleCard(
                    icon: Icons.favorite_border_rounded,
                    color: HfColors.butter,
                    title: WelcomeCopy.rule3Title,
                    body: WelcomeCopy.rule3Body,
                  ),
                  const SizedBox(height: HfSpacing.gapLarge),
                  const CrisisStrip(),
                  const SizedBox(height: HfSpacing.gap),
                  const _LegalLinks(),
                ],
              ),
            ),
            _AcceptPanel(
              ticked: _ticked,
              busy: _busy,
              onTick: (v) => setState(() => _ticked = v),
              onContinue: _continue,
            ),
          ],
        ),
      ),
    );
  }
}

class _RuleCard extends StatelessWidget {
  const _RuleCard({required this.icon, required this.color, required this.title, required this.body});

  final IconData icon;
  final Color color;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return HfCard(
      color: color,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 28, color: HfColors.orchid),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: HfText.subtitle),
                const SizedBox(height: 4),
                Text(body, style: HfText.bodyText),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Terms, Privacy, Community guidelines and Safety open the website in a Custom Tab.
class _LegalLinks extends StatelessWidget {
  const _LegalLinks();

  @override
  Widget build(BuildContext context) {
    Widget link(String label, String path) => TextButton(
          onPressed: () => LinkOpener.instance.site(path),
          child: Text(label),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(WelcomeCopy.linksTitle, style: HfText.label),
        Wrap(
          children: [
            link(WelcomeCopy.terms, '/terms'),
            link(WelcomeCopy.privacy, '/privacy'),
            link(WelcomeCopy.guidelines, '/community-guidelines'),
            link(WelcomeCopy.safety, '/safety'),
          ],
        ),
      ],
    );
  }
}

/// The tick and the Continue button, pinned to the bottom so they are always in reach.
class _AcceptPanel extends StatelessWidget {
  const _AcceptPanel({required this.ticked, required this.busy, required this.onTick, required this.onContinue});

  final bool ticked;
  final bool busy;
  final ValueChanged<bool> onTick;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(HfSpacing.page, 8, HfSpacing.page, 16),
      decoration: const BoxDecoration(
        color: HfColors.cream,
        border: Border(top: BorderSide(color: HfColors.line)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            key: const ValueKey<String>('welcome-tick'),
            borderRadius: BorderRadius.circular(HfRadius.control),
            onTap: () => onTick(!ticked),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: HfSpacing.tap),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Checkbox(
                    value: ticked,
                    onChanged: (v) => onTick(v ?? false),
                    activeColor: HfColors.plum,
                    checkColor: HfColors.cream,
                  ),
                  const Expanded(
                    child: Padding(
                      padding: EdgeInsets.only(top: 12),
                      child: Text(WelcomeCopy.tick, style: HfText.note),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          HfButton(
            label: WelcomeCopy.button,
            loading: busy,
            onPressed: ticked ? onContinue : null,
          ),
        ],
      ),
    );
  }
}
