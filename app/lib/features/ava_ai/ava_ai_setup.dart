import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/ava_ai_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Where the user mints a free key — the Google AI Studio "API Keys" page.
/// Tapping "Create API key" → naming it → "Create key" (picking "Create key in
/// a new project" when no project exists) makes a free Gemini key in seconds.
const String kAiStudioKeyUrl = 'https://aistudio.google.com/app/api-keys';

/// Reusable "bring your own free Gemini AI" body. Drop it inside an [Expanded]
/// (onboarding step) or a Scaffold body ([AvaAiSetupScreen], from Settings).
///
/// Flow: tap → opens AI Studio → user taps "Get API key / Create in new
/// project" → copies the key → pastes it back here → we store it scoped +
/// encrypted. Ava then runs on the user's own free Gemini quota ($0 to us).
class AvaAiSetupBody extends StatefulWidget {
  /// Called after a key is saved successfully.
  final VoidCallback? onSaved;

  /// Shown as a "skip / not now" link when provided (onboarding).
  final VoidCallback? onSkip;

  const AvaAiSetupBody({super.key, this.onSaved, this.onSkip});

  @override
  State<AvaAiSetupBody> createState() => _AvaAiSetupBodyState();
}

class _AvaAiSetupBodyState extends State<AvaAiSetupBody> {
  final _store = AvaAiStore();
  final _keyCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  bool _saving = false;
  bool _opened = false; // they've tapped "Open AI Studio" at least once
  String? _error;

  @override
  void initState() {
    super.initState();
    // Replace flow (Settings): prefill the linked Google account if any.
    _store.googleEmail().then((e) {
      if (e != null && e.isNotEmpty && mounted) _emailCtrl.text = e;
    });
  }

  @override
  void dispose() {
    _keyCtrl.dispose();
    _emailCtrl.dispose();
    super.dispose();
  }

  bool get _ready => AvaAiStore.looksValid(_keyCtrl.text) && !_saving;

  Future<void> _openStudio() async {
    setState(() => _opened = true);
    final ok = await launchUrl(Uri.parse(kAiStudioKeyUrl),
        mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Could not open the browser — visit aistudio.google.com/app/api-keys')));
    }
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final t = data?.text?.trim();
    if (t != null && t.isNotEmpty) {
      setState(() { _keyCtrl.text = t; _error = null; });
    }
  }

  Future<void> _save() async {
    if (!_ready) return;
    setState(() { _saving = true; _error = null; });
    await _store.save(apiKey: _keyCtrl.text, googleEmail: _emailCtrl.text);
    if (!mounted) return;
    setState(() => _saving = false);
    widget.onSaved?.call();
  }

  @override
  Widget build(BuildContext context) {
    // RESPUI (onboarding pass): hardcoded 24px gutter/hero-size → ZineBreakpoints,
    // matching the pattern used by sign_in_screen.dart / onboarding_flow.dart
    // (tighter gutter + smaller hero on <360dp phones).
    final hPad = ZineBreakpoints.pagePadding(context);
    return Column(children: [
      Expanded(
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(hPad, 12, hPad, 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(
                icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                color: Zine.lilac, size: 44),
            const SizedBox(height: 16),
            ZineMarkTitle(
                pre: 'Add ', mark: 'Ava', post: ', your AI',
                fontSize: ZineBreakpoints.heroTextSize(context, regular: 28),
                textAlign: TextAlign.left),
            const SizedBox(height: 8),
            Text(
                'Ava can find files, summarize chats, translate, generate images and '
                'more — right inside your conversations. She runs on your own free '
                'Google Gemini key, so it stays free for you.',
                style: ZineText.sub(size: 14.5)),
            const SizedBox(height: 20),

            // 1-2-3 steps, each with the matching AI Studio screenshot.
            _shot(1, 'assets/ai_studio/step1.png',
                'Tap the button below to open Google AI Studio and sign in. '
                'On the API Keys page, tap "Create API key" (top-right).'),
            _shot(2, 'assets/ai_studio/step2.png',
                'Name your key, then pick a project. No project yet? Open the '
                'dropdown and choose "Create key in a new project".'),
            _shot(3, 'assets/ai_studio/step3.png',
                'Tap "Copy key" (your key starts with "AQ.…"), come back here, '
                'and paste it below.'),
            const SizedBox(height: 18),

            ZineButton(
              label: _opened ? 'Open AI Studio again' : 'Open Google AI Studio',
              onPressed: _openStudio,
              fullWidth: true,
              fontSize: 17,
              variant: _opened ? ZineButtonVariant.ghost : ZineButtonVariant.lime,
              icon: PhosphorIcons.arrowSquareOut(PhosphorIconsStyle.bold),
              trailingIcon: true,
            ),
            const SizedBox(height: 22),

            Text('PASTE YOUR KEY', style: ZineText.kicker()),
            const SizedBox(height: 9),
            _field(
              controller: _keyCtrl,
              hint: 'AQ.… or AIza…',
              leadIcon: PhosphorIcons.key(PhosphorIconsStyle.bold),
              onChanged: (_) => setState(() => _error = null),
              error: _error != null,
              trailing: ZineLink('paste', fontSize: 13, onTap: _paste),
            ),
            const SizedBox(height: 10),
            if (_error != null)
              ZineSticker(_error!, kind: ZineStickerKind.no,
                  icon: PhosphorIcons.xCircle(PhosphorIconsStyle.fill))
            else
              ZineSticker('Your key is stored encrypted on your device only.',
                  kind: ZineStickerKind.hint,
                  icon: PhosphorIcons.lockKey(PhosphorIconsStyle.fill)),
            const SizedBox(height: 18),

            Text('GOOGLE ACCOUNT (OPTIONAL)', style: ZineText.kicker()),
            const SizedBox(height: 9),
            _field(
              controller: _emailCtrl,
              hint: 'you@gmail.com',
              leadIcon: PhosphorIcons.at(PhosphorIconsStyle.bold),
              onChanged: (_) {},
              keyboardType: TextInputType.emailAddress,
            ),
            const SizedBox(height: 6),
            Text('So you remember which account this key belongs to. You can remove '
                'it and connect another account anytime in Settings.',
                style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
            const SizedBox(height: 14),
            Text('Heads up: Google may use free-tier requests to improve their '
                'products, and the free tier is rate-limited. Keep sensitive chats '
                'in a private chat.',
                style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
          ]),
        ),
      ),
      Padding(
        padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 20),
        child: Column(children: [
          ZineButton(
            label: 'Save & turn on Ava',
            onPressed: _ready ? _save : null,
            fullWidth: true,
            fontSize: 20,
            loading: _saving,
            icon: PhosphorIcons.check(PhosphorIconsStyle.bold),
          ),
          if (widget.onSkip != null) ...[
            const SizedBox(height: 14),
            ZineLink('Skip — use AvaTOK without AI', fontSize: 14, onTap: widget.onSkip!),
          ],
        ]),
      ),
    ]);
  }

  /// A numbered step with its matching Google AI Studio screenshot below the
  /// caption, so the user sees exactly what each screen looks like.
  Widget _shot(int n, String asset, String text) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 26, height: 26,
              decoration: BoxDecoration(
                color: Zine.lime, shape: BoxShape.circle, border: Zine.border,
              ),
              alignment: Alignment.center,
              child: Text('$n', style: ZineText.value(size: 13)),
            ),
            const SizedBox(width: 12),
            Expanded(child: Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(text, style: ZineText.sub(size: 13.5)),
            )),
          ]),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(Zine.rSm),
            child: Container(
              decoration: BoxDecoration(
                border: Zine.border,
                borderRadius: BorderRadius.circular(Zine.rSm),
              ),
              clipBehavior: Clip.antiAlias,
              child: Image.asset(asset, fit: BoxFit.fitWidth, width: double.infinity),
            ),
          ),
        ]),
      );

  Widget _field({
    required TextEditingController controller,
    required String hint,
    required ValueChanged<String> onChanged,
    IconData? leadIcon,
    Widget? trailing,
    bool error = false,
    TextInputType? keyboardType,
  }) {
    return Container(
      decoration: BoxDecoration(
        color: Zine.card,
        borderRadius: BorderRadius.circular(Zine.rField),
        border: Zine.border,
        boxShadow: error ? Zine.shadowError : Zine.shadowSm,
      ),
      clipBehavior: Clip.antiAlias,
      child: Row(children: [
        if (leadIcon != null)
          Container(
            width: 50,
            constraints: const BoxConstraints(minHeight: 56),
            decoration: const BoxDecoration(
              color: Zine.lime,
              border: Border(right: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            alignment: Alignment.center,
            child: Icon(leadIcon, size: 22, color: Zine.ink),
          ),
        Expanded(
          child: TextField(
            controller: controller,
            onChanged: onChanged,
            keyboardType: keyboardType,
            autocorrect: false,
            enableSuggestions: false,
            cursorColor: Zine.blueInk,
            style: ZineText.input(),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: ZineText.input()
                  .copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
              border: InputBorder.none,
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
            ),
          ),
        ),
        if (trailing != null)
          Padding(padding: const EdgeInsets.only(right: 14), child: trailing),
      ]),
    );
  }
}

/// Full-screen wrapper used from Settings ("Set up" / "Replace key").
class AvaAiSetupScreen extends StatelessWidget {
  const AvaAiSetupScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Ava AI', markWord: 'Ava'),
      body: SafeArea(
        child: AvaAiSetupBody(
          onSaved: () {
            ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Ava AI is on — your Gemini key is connected')));
            Navigator.of(context).pop(true);
          },
        ),
      ),
    );
  }
}
