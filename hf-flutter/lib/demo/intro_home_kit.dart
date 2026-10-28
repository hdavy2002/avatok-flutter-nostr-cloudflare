import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/intro_flags.dart';
import '../data/presence_store.dart';
import '../data/repos/intro_home_repo.dart';
import '../data/services.dart';
import '../data/telemetry.dart';
import 'call_safety_kit.dart'; // [HF-CALL-SAFETY-APP]
import 'presence_bridge.dart';
import 'theme.dart';
import 'widgets.dart';

// [HF-INTRO-A3] Influencer Home pieces of the intro-video project (Specs/HF-INTRO-VIDEO-1.md D3, D9, D18; design
// Specs/hf-intro-screens/App8Home.dc.html): the dark ACTION NEEDED intro banner and the "How do you take calls?" card.
// Each part appears only when its flag (hfIntroOnboardingEnabled, hfCallOptionEnabled) is true; with both off the Home
// shows [fallback] (the presence card it always had) and nothing else.

/// Where "Record now" / "Fix and send again" go. Lane A1 registers this route; the path is the contract between the two lanes.
const String kInfluencerOnboardingPath = '/influencer/join'; // [HF-INTRO-INT] A1 registered the new flow on this route

/// Call from a build method of the influencer shell: reads the flag, then her option, once. Quiet when the flag is off or in the demo build.
void ensureCallOptionLoaded() {
  if (!PresenceBridge.real) return;
  unawaited(IntroFlags.ensureLoaded().then((_) => CallOptionStore.instance.ensureLoaded()));
}

/// Banner + call-option card (or [fallback] when the call-option flag is off), in the order of the approved Home design.
class IntroHomeSection extends StatefulWidget {
  const IntroHomeSection({super.key, required this.fallback, this.repo});

  /// What the Home showed before this lane: the three-way mode card or the Online/Offline card.
  final Widget fallback;
  final IntroHomeRepo? repo;

  @override
  State<IntroHomeSection> createState() => _IntroHomeSectionState();
}

class _IntroHomeSectionState extends State<IntroHomeSection> {
  late final IntroHomeRepo _repo = widget.repo ?? IntroHomeRepo(Services.instance.api);
  bool _flagsReady = false;
  IntroHomeState? _state;

  @override
  void initState() {
    super.initState();
    unawaited(_init());
  }

  Future<void> _init() async {
    if (!PresenceBridge.real) return; // the demo build has no server
    await IntroFlags.ensureLoaded();
    if (!mounted) return;
    setState(() => _flagsReady = true);
    await _reload();
  }

  Future<void> _reload() async {
    if (!IntroFlags.introOnboarding && !IntroFlags.callOption) return;
    try {
      final s = await _repo.state();
      if (!mounted) return;
      if (IntroFlags.callOption) CallOptionStore.instance.seed(s.callOption);
      setState(() => _state = s);
    } catch (_) {
      // keep what is on screen; the next visit tries again
    }
  }

  Future<void> _openOnboarding(String status) async {
    Telemetry.event('hf_intro_banner_click', {'status': status});
    await context.push(kInfluencerOnboardingPath);
    if (mounted) unawaited(_reload());
  }

  @override
  Widget build(BuildContext context) {
    if (!_flagsReady) return widget.fallback;
    final s = _state;
    if (IntroFlags.callOption) CallOptionStore.instance.ensureLoaded();
    final showBanner = IntroFlags.introOnboarding && s != null && s.showsBanner;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (showBanner) ...[
          IntroBanner(
            state: s,
            onRecord: () => unawaited(_openOnboarding(s.introStatus == 'rejected' ? 'rejected' : 'none')),
            onCheckAgain: () {
              Telemetry.event('hf_intro_banner_click', {'status': 'submitted'});
              unawaited(_reload());
            },
          ),
          const SizedBox(height: 12),
        ],
        if (IntroFlags.callOption) CallOptionCard(store: CallOptionStore.instance, presence: PresenceStore.instance) else widget.fallback,
      ],
    );
  }
}

// ---------------------------------------------------------------------------------------------- Intro banner

/// The dark ACTION NEEDED card. Three states: no intro yet (Record now), waiting for approval, rejected (reasons + Fix and send again).
class IntroBanner extends StatelessWidget {
  const IntroBanner({super.key, required this.state, required this.onRecord, required this.onCheckAgain});

  final IntroHomeState state;
  final VoidCallback onRecord;
  final VoidCallback onCheckAgain;

  @override
  Widget build(BuildContext context) {
    final submitted = state.introStatus == 'submitted';
    final rejected = state.introStatus == 'rejected';
    final String eyebrow;
    final String title;
    final String body;
    final String button;
    final VoidCallback tap;
    if (submitted) {
      eyebrow = 'IN REVIEW';
      title = 'Your intro is waiting for approval';
      body = 'A person from our team will check it. We will WhatsApp you when it is done. Until then you are hidden from Reels.';
      button = 'Check again';
      tap = onCheckAgain;
    } else if (rejected) {
      eyebrow = 'ACTION NEEDED';
      title = 'Your intro video was not approved';
      body = 'Fix it and send it again. Until a person approves it, you are hidden from Reels.';
      button = 'Fix and send again';
      tap = onRecord;
    } else {
      eyebrow = 'ACTION NEEDED';
      title = 'Record your 20-second intro video';
      body = 'Fans now find you through it. Until a person approves it, you\'re hidden from Reels.';
      button = 'Record now';
      tap = onRecord;
    }
    final card = Container(
      key: const ValueKey('intro-banner'),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: C.maroon,
        borderRadius: BorderRadius.circular(24),
        boxShadow: const [BoxShadow(color: C.rani, offset: Offset(6, 6))],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(eyebrow, style: t(14, color: C.lemon, w: FontWeight.w900, ls: .16)),
        const SizedBox(height: 10),
        Text(title, style: t(22, color: C.white, w: FontWeight.w900, h: 1.15)),
        const SizedBox(height: 10),
        Text(body, style: t(15, color: C.cream, w: FontWeight.w700, h: 1.5)),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: tap,
          style: FilledButton.styleFrom(
            backgroundColor: C.lemon,
            foregroundColor: C.maroon,
            minimumSize: const Size.fromHeight(52),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          ),
          child: Text(button, style: t(17, color: C.maroon, w: FontWeight.w900)),
        ),
      ]),
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.only(right: 6, bottom: 6), child: card),
      if (rejected && (state.rejectReasons.isNotEmpty || state.rejectNote != null)) ...[
        const SizedBox(height: 8),
        Container(
          key: const ValueKey('intro-reject-reasons'),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(20), border: Border.all(color: C.saffron, width: 2.5)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Why it was not approved', style: t(15, color: C.amber, w: FontWeight.w900)),
            for (final r in state.rejectReasons)
              Padding(padding: const EdgeInsets.only(top: 6), child: Text('• $r', style: t(15, w: FontWeight.w700, h: 1.4))),
            if (state.rejectNote != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(state.rejectNote!, style: t(15, w: FontWeight.w700, h: 1.4))),
          ]),
        ),
      ],
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- Call option card

/// "How do you take calls?": Bookings only / Bookings + live. Bookings + live shows the Online bar (Go offline / Go online);
/// Bookings only shows a calm pill and a link to Availability. Online/Offline map to the existing server modes
/// `online` and `bookings_only` (PresenceStore.setMode), so the centre footer button and this card always agree.
class CallOptionCard extends StatelessWidget {
  const CallOptionCard({super.key, required this.store, required this.presence});

  final CallOptionStore store;
  final PresenceStore presence;

  Future<void> _pick(BuildContext context, String option) async {
    Telemetry.event('hf_call_option_ui', {'option': option});
    final err = await store.set(option);
    if (err != null && context.mounted) toast(context, err);
  }

  Future<void> _toggleOnline(BuildContext context) async {
    final goOnline = !presence.online;
    final go = GoRouter.of(context); // [HF-CALL-SAFETY-APP]
    final err = await presence.setMode(goOnline ? 'online' : 'bookings_only');
    if (!context.mounted) return;
    if (err != null && SafetyGate.handle(go, presence.lastErrorCode)) return;
    toast(context, err ?? (goOnline ? 'You are online. Fans can call you now.' : 'You are offline. Fans can still book a time.'));
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([store, presence]),
      builder: (context, _) {
        final option = store.active ?? 'B';
        return Container(
          key: const ValueKey('call-option-card'),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(22), border: Border.all(color: C.maroon, width: 2.5)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('How do you take calls?', style: t(18, color: C.maroon, w: FontWeight.w900)),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(14)),
              child: Row(children: [
                _seg(context, 'Bookings only', option == 'A', 'A'),
                const SizedBox(width: 6),
                _seg(context, 'Bookings + live', option == 'B', 'B'),
              ]),
            ),
            const SizedBox(height: 12),
            if (option == 'A') ..._bookingsOnly(context) else ..._live(context),
          ]),
        );
      },
    );
  }

  Widget _seg(BuildContext context, String label, bool on, String value) => Expanded(
        child: Semantics(
          button: true,
          selected: on,
          label: label,
          excludeSemantics: true,
          child: Material(
            color: on ? C.maroon : C.clear,
            borderRadius: BorderRadius.circular(11),
            child: InkWell(
              borderRadius: BorderRadius.circular(11),
              onTap: store.saving ? null : () => unawaited(_pick(context, value)),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48),
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    child: FittedBox(fit: BoxFit.scaleDown, child: Text(label, maxLines: 1, style: t(15, color: on ? C.white : C.maroon, w: FontWeight.w900))),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

  /// Bookings + live: the Online bar and the note under it.
  List<Widget> _live(BuildContext context) {
    final onCall = presence.busy;
    final online = presence.online;
    final Color fill;
    final Color line;
    final Color ink;
    final Color dot;
    final String head;
    final String sub;
    if (onCall) {
      fill = C.butter;
      line = C.lemon;
      ink = C.deep;
      dot = C.marigold;
      head = 'You are on a call';
      sub = 'New calls wait in your queue';
    } else if (online) {
      fill = C.onlineBg;
      line = C.onlineLine;
      ink = C.onlineInk;
      dot = C.onlineDot;
      head = 'You\'re Online';
      sub = 'Fans can call you now';
    } else {
      fill = C.sand;
      line = C.line;
      ink = C.maroon;
      dot = C.muted;
      head = 'You\'re Offline';
      sub = 'Fans can\'t call you now';
    }
    return [
      Container(
        key: const ValueKey('call-option-live-bar'),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(16), border: Border.all(color: line, width: 2)),
        child: Row(children: [
          Container(width: 14, height: 14, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(head, style: t(16, color: ink, w: FontWeight.w900)),
              Text(sub, style: t(14, color: ink, w: FontWeight.w700, h: 1.3)),
            ]),
          ),
          const SizedBox(width: 8),
          if (!onCall)
            OutlinedButton(
              onPressed: presence.saving || !presence.loaded ? null : () => unawaited(_toggleOnline(context)),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(48, 48),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                backgroundColor: online ? C.white : C.onlineInk,
                side: const BorderSide(color: C.onlineInk, width: 2),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: Text(online ? 'Go offline' : 'Go online', style: t(14, color: online ? C.onlineInk : C.white, w: FontWeight.w900)),
            ),
        ]),
      ),
      const SizedBox(height: 12),
      Text('Offline: hidden from Reels, fans can still book a time.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.5)),
    ];
  }

  /// Bookings only: a calm pill, one line, and the way to her calendar.
  List<Widget> _bookingsOnly(BuildContext context) => [
        Container(
          key: const ValueKey('call-option-bookings-pill'),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.deep, width: 2)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.event_available_rounded, color: C.deep, size: 22),
            const SizedBox(width: 8),
            Flexible(child: Text('Bookings only', style: t(16, color: C.deep, w: FontWeight.w900))),
          ]),
        ),
        const SizedBox(height: 10),
        Text('Fans book a time with you. There are no instant calls, online or offline.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.5)),
        TextButton(
          onPressed: () => StatefulNavigationShell.of(context).goBranch(3),
          style: TextButton.styleFrom(minimumSize: const Size(48, 48), alignment: Alignment.centerLeft, padding: EdgeInsets.zero),
          child: Text('Open Availability', style: t(15, color: C.rani, w: FontWeight.w900)),
        ),
      ];
}
