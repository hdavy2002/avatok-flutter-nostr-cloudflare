/// AiVoiceAgentScreen — the "AI Voice Agent" home (sidebar entry). A simple dial
/// screen: tap "Call Ava" → opens the live hands-free call (Gemini Live native
/// audio). Ava greets the user by name and the 5-minute guardrail runs in-call.
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import 'voice_call_screen.dart';

class AiVoiceAgentScreen extends StatelessWidget {
  const AiVoiceAgentScreen({super.key});

  void _dial(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const VoiceCallScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(title: 'AI Voice Agent', markWord: 'Voice', tag: 'GEMINI LIVE'),
      body: ZinePaper(
        child: SafeArea(
          top: false,
          child: Column(children: [
            const Spacer(),
            // Big tappable dial orb.
            GestureDetector(
              onTap: () => _dial(context),
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
                child: Icon(Icons.phone_in_talk_rounded, size: 76, color: Zine.ink),
              ),
            ),
            const SizedBox(height: 28),
            Text('Talk to Ava', style: ZineText.value(size: 20)),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 36),
              child: Text(
                'Tap to call Ava and have a hands-free conversation. She knows your '
                'name and answers in real time.',
                textAlign: TextAlign.center,
                style: ZineText.sub(size: 13.5),
              ),
            ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.only(bottom: 30),
              child: ZineButton(
                label: 'Call Ava',
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
