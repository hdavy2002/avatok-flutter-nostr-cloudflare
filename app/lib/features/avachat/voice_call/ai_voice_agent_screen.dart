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
import '../../../core/remote_config.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/wallet_entitlement.dart';
import '../../subscribe/subscribe_screen.dart';
import 'voice_call_screen.dart';

class AiVoiceAgentScreen extends StatefulWidget {
  const AiVoiceAgentScreen({super.key});
  @override
  State<AiVoiceAgentScreen> createState() => _AiVoiceAgentScreenState();
}

class _AiVoiceAgentScreenState extends State<AiVoiceAgentScreen> {
  WalletEntitlementState _walletState = WalletEntitlementState.loading;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('aivoice', 'home');
    WalletEntitlement.I.hydrate().then((_) {
      if (mounted) setState(() => _walletState = WalletEntitlement.I.snapshot.value.state);
    });
    WalletEntitlement.I.refresh().then((snap) {
      if (mounted) setState(() => _walletState = snap.state);
    });
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
    // [WALLET-GET-STATE-1] Only a CONFIRMED free wallet routes to Subscribe.
    // `.unavailable` must not be read as "not premium" (Root-Cause Report
    // §17) — let the tap through; the call setup itself is the authoritative
    // wallet check ("Paid actions ask the server authoritatively; they must
    // not block solely because a client GET failed").
    if (_walletState == WalletEntitlementState.free) { _goSubscribe(); return; }
    Analytics.capture('aivoice_call_start', {'wallet_state': _walletState.name});
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => const VoiceCallScreen()));
  }

  void _goSubscribe() {
    Analytics.capture('aivoice_subscribe_prompt', const {});
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SubscribeScreen()));
  }

  @override
  Widget build(BuildContext context) {
    // Killed by the server switch → fully unavailable (subscribing won't help).
    // Otherwise fall back to the premium gate — but ONLY on a CONFIRMED free
    // wallet. `.loading`/`.unavailable` are deliberately NOT locked: a failed
    // client GET must never present as "you're not premium" (Root-Cause
    // Report §17); the call setup is the authoritative check either way.
    final unavailable = !_available;
    final checking = _walletState == WalletEntitlementState.loading;
    final walletUnverified = _walletState == WalletEntitlementState.unavailable;
    final locked = unavailable || _walletState == WalletEntitlementState.free;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(title: 'AvaBrain Voice', markWord: 'Voice', tag: 'AI'),
      body: ZinePaper(
        child: SafeArea(
          top: false,
          child: Column(children: [
            const Spacer(),
            // Big tappable dial orb (greyed + locked for non-subscribers).
            // `checking` gets the same dimmed look as `locked` — purely visual,
            // it does not disable the tap; see `_dial` for why loading/unverified
            // states are allowed through.
            GestureDetector(
              onTap: () => _dial(context),
              child: Opacity(
                opacity: (locked || checking) ? 0.55 : 1,
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
                    : checking
                        ? 'Checking your AvaBrain plan…'
                        : locked
                            ? 'Voice calling will use AvaBrain tokens. Add tokens to have '
                                'hands-free, real-time conversations with Ava.'
                            : walletUnverified
                                ? "Couldn't verify your wallet — you can still tap to call; "
                                    "we'll confirm when you do."
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
                  : checking
                  ? ZineButton(
                      label: 'Checking…',
                      variant: ZineButtonVariant.lime,
                      icon: PhosphorIcons.crown(PhosphorIconsStyle.fill),
                      trailingIcon: false,
                      onPressed: null,
                    )
                  : locked
                  ? ZineButton(
                      label: 'Subscribe to talk to Ava',
                      variant: ZineButtonVariant.lime,
                      icon: PhosphorIcons.crown(PhosphorIconsStyle.fill),
                      trailingIcon: false,
                      onPressed: _goSubscribe,
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
