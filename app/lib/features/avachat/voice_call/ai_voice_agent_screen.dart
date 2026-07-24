/// AiVoiceAgentScreen — the AvaBrain voice-conversation screen. A simple dial
/// screen: tap "Call AvaBrain" → opens the live hands-free call (Gemini Live native
/// audio). Ava greets the user by name and the 5-minute guardrail runs in-call.
///
/// PREMIUM-GATED (owner decision 2026-06-27): talking to Ava by voice requires a
/// paid plan / topped-up wallet. Non-subscribers see the call disabled and a
/// prompt to subscribe.
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/money_api.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../subscribe/subscribe_screen.dart';
import 'voice_call_screen.dart';

class AiVoiceAgentScreen extends StatefulWidget {
  const AiVoiceAgentScreen({super.key});
  @override
  State<AiVoiceAgentScreen> createState() => _AiVoiceAgentScreenState();
}

class _AiVoiceAgentScreenState extends State<AiVoiceAgentScreen> {
  bool _premium = false;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('aivoice', 'home');
    MoneyApi.balance().then((b) {
      if (mounted) setState(() { _premium = b['premium'] == 1 || b['premium'] == true; _loaded = true; });
    }).catchError((_) { if (mounted) setState(() => _loaded = true); });
  }

  /// Server kill switch — when off, the feature is fully unavailable regardless
  /// of premium status (premium is reported true for everyone during beta, so it
  /// can't gate this on its own).
  bool get _available => RemoteConfig.aiVoiceCallEnabled;

  void _dial(BuildContext context) {
    if (!_available) {
      Analytics.capture('aivoice_call_start', const {'blocked': 'kill_switch'});
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Voice calling with Ava is currently unavailable.')));
      return;
    }
    if (!_premium) { _goSubscribe(); return; }
    Analytics.capture('aivoice_call_start', const {});
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => const VoiceCallScreen()));
  }

  void _goSubscribe() {
    Analytics.capture('aivoice_subscribe_prompt', const {});
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SubscribeScreen()));
  }

  @override
  Widget build(BuildContext context) {
    // Killed by the server switch → fully unavailable (subscribing won't help).
    // Otherwise fall back to the premium gate.
    final unavailable = !_available;
    final locked = unavailable || !_premium;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(title: 'AvaBrain Voice', markWord: 'Voice', tag: 'AI'),
      body: ZinePaper(
        child: SafeArea(
          top: false,
          child: Column(children: [
            const Spacer(),
            // Big tappable dial orb (greyed + locked for non-subscribers).
            GestureDetector(
              onTap: () => _dial(context),
              child: Opacity(
                opacity: locked ? 0.55 : 1,
                child: Container(
                  width: 200, height: 200,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const RadialGradient(colors: [Zine.mint, Zine.blue]),
                    border: Border.all(color: Zine.ink, width: Zine.bwLg),
                    boxShadow: const [
                      BoxShadow(color: Zine.mint, blurRadius: 40, spreadRadius: 6),
                      BoxShadow(color: Zine.ink, offset: Offset(6, 7)),
                    ],
                  ),
                  child: Icon(locked ? Icons.lock_rounded : Icons.phone_in_talk_rounded,
                      size: 76, color: Zine.ink),
                ),
              ),
            ),
            const SizedBox(height: 28),
            Text('Talk to AvaBrain', style: ZineText.value(size: 20)),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 36),
              child: Text(
                unavailable
                    ? 'Voice calling with Ava is currently unavailable. Please check '
                        'back soon.'
                    : locked
                        ? 'Voice calling will use AvaBrain tokens. Add tokens to have '
                            'hands-free, real-time conversations with Ava.'
                        : 'Tap to call AvaBrain and have a hands-free conversation. It knows your '
                            'name and answers in real time.',
                textAlign: TextAlign.center,
                style: ZineText.sub(size: 13.5),
              ),
            ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.only(bottom: 30),
              child: unavailable
                  ? ZineButton(
                      label: 'Unavailable',
                      variant: ZineButtonVariant.lime,
                      icon: PhosphorIcons.prohibit(PhosphorIconsStyle.fill),
                      trailingIcon: false,
                      onPressed: null,
                    )
                  : locked
                  ? ZineButton(
                      label: _loaded ? 'Subscribe to talk to Ava' : 'Checking…',
                      variant: ZineButtonVariant.lime,
                      icon: PhosphorIcons.crown(PhosphorIconsStyle.fill),
                      trailingIcon: false,
                      onPressed: _loaded ? _goSubscribe : null,
                    )
                  : ZineButton(
                      label: 'Call AvaBrain',
                      icon: PhosphorIcons.phoneCall(PhosphorIconsStyle.fill),
                      trailingIcon: false,
                      onPressed: () => _dial(context),
                    ),
            ),
          ]),
        ),
      ),
    );
  }
}
