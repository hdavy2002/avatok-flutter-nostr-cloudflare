import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/brand.dart';
import '../../../core/links.dart';
import '../../../core/router/deep_link_handler.dart';
import '../../../core/router/routes.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/pending_intent.dart';
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

/// Contextual, account-scoped 18+ and safety consent before a privileged action.
/// Public browsing never passes through this page.
class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key, this.next});

  final String? next;

  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends ConsumerState<WelcomeScreen> {
  bool _ticked = false;
  bool _busy = false;
  String? _error;

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
      if (!opened) {
        final router = GoRouter.of(context);
        if (router.canPop()) {
          router.pop(true);
        } else {
          final next = Routes.safeNext(widget.next);
          await ref.read(pendingIntentProvider).clear();
          if (mounted) router.go(next ?? Routes.home);
        }
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'We could not save that. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _cancel() async {
    await ref.read(pendingIntentProvider).clear();
    if (mounted) popOrHome(context);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      canPop: GoRouter.of(context).canPop(),
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) { _cancel(); }
        else if (result != true) { ref.read(pendingIntentProvider).clear(); }
      },
      child: Scaffold(
      appBar: AppBar(leading: IconButton(tooltip: 'Keep browsing', icon: const Icon(Icons.arrow_back_rounded), onPressed: _cancel), title: const Text('A safe space for a hello')),
      body: SafeArea(child: ListView(
        padding: const EdgeInsets.all(HfSpacing.page),
        children: [
          const HfScene(kind: HfSceneKind.welcome, height: 150),
          const SizedBox(height: 20),
          const Text(WelcomeCopy.title, style: HfText.headline),
          const SizedBox(height: 8),
          const Text(WelcomeCopy.intro, style: HfText.bodyText),
          const SizedBox(height: 20),
          const _RuleCard(icon: Icons.lock_outline_rounded, color: HfColors.mint,
            title: WelcomeCopy.rule1Title, body: WelcomeCopy.rule1Body),
          const SizedBox(height: 12),
          const _RuleCard(icon: Icons.tag_rounded, color: HfColors.sky,
            title: WelcomeCopy.rule2Title, body: WelcomeCopy.rule2Body),
          const SizedBox(height: 12),
          const _RuleCard(icon: Icons.favorite_border_rounded, color: HfColors.lavender,
            title: WelcomeCopy.rule3Title, body: WelcomeCopy.rule3Body),
          const SizedBox(height: 20),
          const CrisisStrip(),
          const SizedBox(height: 16),
          HfCard(child: _AcceptPanel(ticked: _ticked, busy: _busy,
            onTick: (v) => setState(() => _ticked = v), onContinue: _continue)),
          if (_error != null) Text(_error!, style: HfText.bodyText),
          const SizedBox(height: 16),
          const _LegalLinks(),
        ],
      )),
    ));
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
      color: HfColors.white,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(18)), child: Icon(icon, size: 26, color: HfColors.ink)),
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
        color: HfColors.white,
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
