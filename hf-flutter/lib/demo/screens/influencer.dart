import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/call_flags.dart'; // [HF-CALL-MODES-E2]
import '../../data/demo_mode.dart';
import '../../data/models/channel.dart';
import '../../data/presence_store.dart';
import '../../data/repos/payouts_repo.dart';
import '../../data/repos/safety_repo.dart'; // [HF-APP-PARITY-SAFETY]
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../data.dart';
import '../my_reels_section.dart';
import '../presence_bridge.dart';
import '../share_page_kit.dart'; // [HF-SHARE-APP-1]
import '../queue_kit.dart'; // [HF-CALL-MODES-E2]
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import '../desi.dart';
import '../inf_kit.dart';
import '../channel_kit.dart';
import '../booking_kit.dart';
import 'bookings_real.dart'; // [HF-WIRE-8]
import 'channels.dart';
import 'profile_photo.dart'; // [HF-CHANNEL-APP-1]

// ---------------------------------------------------------------------------------------------- Join

/// Influencer sign-up (HF-REEL-2): details → channels (HF-WIRE-3: connect, prove ownership, follower check) → WhatsApp verify → dashboard.
class InfluencerJoinScreen extends StatefulWidget {
  const InfluencerJoinScreen({super.key, this.initialStep = 0});

  /// 0 details, 1 channels, 2 WhatsApp. The channel screens return here with `?step=`.
  final int initialStep;

  @override
  State<InfluencerJoinScreen> createState() => _InfluencerJoinScreenState();
}

class _InfluencerJoinScreenState extends State<InfluencerJoinScreen> {
  late int _step = widget.initialStep.clamp(0, 2);
  late final _name = TextEditingController(text: demo.name);
  late final _email = TextEditingController(text: demo.email);
  late final _wa = TextEditingController(text: demo.whatsapp);
  final _otp = TextEditingController();
  ChannelsList? _channels; // [HF-WIRE-3] what step 2 last loaded
  bool _codeSent = false;
  String? _error;
  bool _busy = false;

  /// [HF-WIRE-12] A live build: the person already signed in with a verified WhatsApp number, so step 3 only
  /// confirms it. The dummy code ("type any 6 digits") and the fake sign-up exist in the demo build only.
  bool get _live => !DemoMode.on;

  @override
  void dispose() {
    for (final c in [_name, _email, _wa, _otp]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _next() async {
    if (_busy) return;
    setState(() => _error = null);
    if (_step == 0) {
      if (_name.text.trim().isEmpty || !_email.text.contains('@')) {
        setState(() => _error = 'Please fill your name and a real email.');
        return;
      }
      if (_live) {
        setState(() => _busy = true);
        try {
          await Services.instance.authRepo.saveProfile(name: _name.text, email: _email.text);
          await Services.instance.refreshMe();
        } catch (e) {
          if (mounted) setState(() => _error = e is ApiException ? e.userMessage : ApiException.genericText);
          if (mounted) setState(() => _busy = false);
          return;
        }
        if (!mounted) return;
        setState(() => _busy = false);
      }
      setState(() => _step = 1);
    } else if (_step == 1) {
      final c = _channels;
      if (c == null || !c.qualified) {
        setState(() => _error = 'We need at least ${c?.minFollowers ?? ChannelsList.defaultMinFollowers} followers or subscribers on YouTube or Instagram. Add a channel and check it, or try another channel.');
        return;
      }
      setState(() => _step = 2);
    } else if (_live) {
      setState(() => _busy = true);
      await Services.instance.refreshMe();
      if (!mounted) return;
      setState(() => _busy = false);
      context.go('/inf/home');
    } else {
      if (!_codeSent) {
        if (_wa.text.replaceAll(RegExp(r'\D'), '').length != 10) {
          setState(() => _error = 'WhatsApp number should be 10 digits.');
          return;
        }
        setState(() => _codeSent = true);
        toast(context, 'Code sent on WhatsApp (demo: type any 6 digits)');
        return;
      }
      if (_otp.text.replaceAll(RegExp(r'\D'), '').length != 6) {
        setState(() => _error = 'Type the 6-digit code.');
        return;
      }
      if (!demo.signedIn) demo.signUp(_name.text, _email.text, _wa.text.replaceAll(RegExp(r'\D'), ''));
      demo.joinAsInfluencer();
      context.go('/inf/home');
    }
  }

  /// [HF-APP-DESI-13] approved "Join as influencer" layout.
  @override
  Widget build(BuildContext context) {
    const titles = ['Your details', 'Your channels', 'Your WhatsApp'];
    const subs = [
      'Fans see your name on your reels and profile.',
      'Connect your Instagram or YouTube.',
      'Call alerts and booking reminders come here.',
    ];
    const tones = [DesiTone.rani, DesiTone.lav, DesiTone.tea];
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            ChannelHeader('Join as influencer', trailing: StepBadge('${_step + 1}/3')),
            Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 0), child: JoinStepper(step: _step)),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                children: [
                  DesiHero(
                    eyebrow: 'Step ${_step + 1} of 3',
                    title: titles[_step],
                    sub: subs[_step],
                    ghost: _step == 1 ? 'Reels' : 'Manch',
                    tone: tones[_step],
                    minHeight: _step == 0 ? 150 : 110,
                    art: _step == 0 ? const SizedBox(width: 122, height: 146, child: Art('influencer/online-mode.webp', fit: BoxFit.contain)) : null,
                  ),
                  const SizedBox(height: 12),
                  if (_step == 0) ...[
                    DesiField(label: 'Your name', field: TextField(controller: _name, style: t(18, w: FontWeight.w800), decoration: const InputDecoration(hintText: 'Meera Joshi'))),
                    const SizedBox(height: 12),
                    DesiField(
                      label: 'Email',
                      field: TextField(controller: _email, keyboardType: TextInputType.emailAddress, style: t(18, w: FontWeight.w800), decoration: const InputDecoration(hintText: 'you@example.com')),
                    ),
                    const SizedBox(height: 12),
                    const DesiTip('Next you connect your Instagram or YouTube. We show your public reels to fans. Fans can then call you at your own rate.'),
                  ],
                  if (_step == 1) ...[
                    ChannelsStep(onLoaded: (l) {
                      if (mounted) setState(() => _channels = l);
                    }),
                  ],
                  if (_step == 2 && _live) ...[
                    Text('We send call alerts and booking reminders on WhatsApp. This is the number you signed in with.', style: t(16, w: FontWeight.w700, h: 1.4)),
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                      decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(20), border: Border.all(color: const Color(0xFFB9E2E5), width: 1.5)),
                      child: Row(children: [
                        const DesiIconSquare(Icons.chat_rounded, tone: DesiTone.tea, size: 40),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text('WhatsApp number', style: t(14, color: C.peacock, w: FontWeight.w800)),
                            Text(demo.whatsappDisplay.isEmpty ? 'Verified' : '${demo.whatsappDisplay}  ·  verified', style: t(17, w: FontWeight.w800)),
                          ]),
                        ),
                      ]),
                    ),
                  ],
                  if (_step == 2 && !_live) ...[
                    Text('We send call alerts and booking reminders here.', style: t(16, w: FontWeight.w700, h: 1.4)),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Container(
                          height: 58,
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(18), border: Border.all(color: const Color(0xFFF3DFB3), width: 1.5)),
                          child: Text('+91', style: t(17, color: C.amber, w: FontWeight.w900)),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: DesiField(
                            label: 'WhatsApp number',
                            field: TextField(controller: _wa, keyboardType: TextInputType.phone, style: t(17, w: FontWeight.w800), decoration: const InputDecoration(hintText: '98765 43210')),
                          ),
                        ),
                      ],
                    ),
                    if (_codeSent) ...[
                      const SizedBox(height: 12),
                      DesiField(
                        label: '6-digit code from WhatsApp',
                        field: TextField(
                          controller: _otp,
                          keyboardType: TextInputType.number,
                          maxLength: 6,
                          textAlign: TextAlign.center,
                          style: t(28, w: FontWeight.w900, ls: 0.4),
                          decoration: const InputDecoration(counterText: '', hintText: '••••••'),
                        ),
                      ),
                    ],
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: t(14, color: C.ruby, w: FontWeight.w800)),
                  ],
                  const SizedBox(height: 14),
                  const DesiMogra(),
                ],
              ),
            ),
            BookBottomButton(
              label: _busy ? 'PLEASE WAIT…' : (_step < 2 ? 'NEXT' : (_live ? 'FINISH' : (_codeSent ? 'VERIFY & FINISH' : 'SEND CODE'))),
              plum: true,
              onTap: _next,
            ),
          ],
        ),
      ),
    );
  }

}

// ---------------------------------------------------------------------------------------------- Shell

/// The influencer's own bottom bar (owner 2026-10-19): Home · Bookings · Online/Offline · Availability · Fan view.
class InfluencerShell extends StatelessWidget {
  const InfluencerShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  /// Tabs either side of the centre Online/Offline button. Branch order in the router stays
  /// Home 0 · Bookings 1 · (Online/Offline screen 2, no longer a tab) · Availability 3.
  static const _left = <(int, IconData, String)>[
    (0, Icons.home_rounded, 'Home'),
    (1, Icons.event_note_rounded, 'Bookings'),
  ];

  /// [HF-BOOK-APPROVE-5] The centre button flips Online/Offline right here (optimistic, rolls back on error).
  Future<void> _togglePresence(BuildContext context) async {
    if (PresenceBridge.real && !PresenceStore.instance.loaded) {
      await PresenceStore.instance.load(); // first read failed: tapping tries again
      return;
    }
    // [HF-CALL-MODES-E2] Three-way Online / Bookings only / Offline instead of the two-way flip.
    if (CallFlags.modes && PresenceBridge.real) {
      await showHostModeSheet(context, surface: 'footer');
      return;
    }
    if (myBusy || mySaving) return;
    final from = myOnline;
    await togglePresence(context);
    final to = myOnline;
    if (to != from) Telemetry.event('hf_presence_toggled', {'from': from ? 'online' : 'offline', 'to': to ? 'online' : 'offline', 'surface': 'footer'});
  }

  @override
  Widget build(BuildContext context) {
    ensurePresenceLoaded();
    return ListenableBuilder(
      listenable: presenceListenable,
      builder: (context, _) {
        // [HF-APP-DESI-11] white bar like the fan bar: pink highlight on the current tab, Online/Offline pill in the middle.
        return Scaffold(
          body: shell,
          bottomNavigationBar: Container(
            decoration: const BoxDecoration(
              color: C.white,
              border: Border(top: BorderSide(color: C.line)),
              boxShadow: [BoxShadow(color: Color(0x664A1747), offset: Offset(0, -8), blurRadius: 24, spreadRadius: -16)],
            ),
            child: SafeArea(
              top: false,
              // Big system fonts must not push the bar out of shape: the bar stops growing at 130%.
              child: MediaQuery.withClampedTextScaling(
                maxScaleFactor: 1.3,
                child: Padding(
                  padding: const EdgeInsets.all(6),
                  child: SizedBox(
                    height: 62,
                    child: Row(
                      children: [
                        for (final it in _left)
                          Expanded(
                            flex: 10,
                            child: Semantics(
                              button: true,
                              selected: shell.currentIndex == it.$1,
                              label: it.$3,
                              child: InkWell(
                                borderRadius: BorderRadius.circular(14),
                                onTap: () => shell.goBranch(it.$1, initialLocation: it.$1 == shell.currentIndex),
                                child: _tab(it.$2, it.$3, shell.currentIndex == it.$1),
                              ),
                            ),
                          ),
                        Expanded(flex: 14, child: _presencePill(context)),
                        Expanded(
                          flex: 10,
                          child: Semantics(
                            button: true,
                            selected: shell.currentIndex == 3,
                            label: 'Availability',
                            child: InkWell(
                              borderRadius: BorderRadius.circular(14),
                              onTap: () => shell.goBranch(3, initialLocation: shell.currentIndex == 3),
                              child: _tab(Icons.edit_calendar_rounded, 'Availability', shell.currentIndex == 3),
                            ),
                          ),
                        ),
                        Expanded(
                          flex: 10,
                          child: Semantics(
                            button: true,
                            label: 'Switch to fan view',
                            child: InkWell(borderRadius: BorderRadius.circular(14), onTap: () => context.go('/me'), child: _tab(Icons.swap_horiz_rounded, 'Fan view', false)),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _tab(IconData icon, String label, bool on) => Container(
        margin: const EdgeInsets.symmetric(horizontal: 1),
        decoration: BoxDecoration(color: on ? C.blush : C.clear, borderRadius: BorderRadius.circular(14)),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 22, color: on ? C.rani : C.muted),
            const SizedBox(height: 2),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(label, maxLines: 1, style: t(14, color: on ? C.rani : C.muted, w: on ? FontWeight.w800 : FontWeight.w700)),
              ),
            ),
          ],
        ),
      );

  /// The centre Online/Offline pill: icon AND words (never colour alone). Online = green fill with white text,
  /// Offline = white with an indigo outline, On a call = soft marigold and not tappable.
  Widget _presencePill(BuildContext context) {
    final waiting = PresenceBridge.real && !PresenceStore.instance.loaded;
    final modes = CallFlags.modes && PresenceBridge.real; // [HF-CALL-MODES-E2]
    final busy = myBusy;
    final online = myOnline;
    final IconData icon;
    final String label;
    final String spoken;
    final Color fill;
    final Color ink;
    final Color edge;
    if (waiting) {
      icon = Icons.sync_rounded;
      label = 'Status';
      spoken = 'Your online status has not loaded. Tap to try again';
      fill = C.paper;
      ink = C.muted;
      edge = C.muted;
    } else if (busy) {
      icon = Icons.call_rounded;
      label = 'On a call';
      spoken = modes ? 'You are on a call. Tap to change your mode' : 'You are on a call. The online and offline button is paused';
      fill = C.marigold;
      ink = C.deep;
      edge = C.deep;
    } else if (modes && PresenceStore.instance.mode == 'bookings_only') {
      icon = Icons.event_available_rounded;
      label = 'Bookings only';
      spoken = 'You take bookings only. Tap to change your mode';
      fill = C.butter;
      ink = C.deep;
      edge = C.deep;
    } else if (online) {
      icon = Icons.wifi_tethering_rounded;
      label = 'Online';
      spoken = modes ? 'You are online. Tap to change your mode' : 'You are online. Tap to go offline';
      fill = C.onlineBg;
      ink = C.onlineInk;
      edge = C.onlineInk;
    } else {
      icon = Icons.nightlight_round;
      label = 'Offline';
      spoken = modes ? 'You are offline. Tap to change your mode' : 'You are offline. Tap to go online';
      fill = C.white;
      ink = C.maroon;
      edge = C.maroon;
    }
    return Center(
      child: Semantics(
        button: true,
        enabled: !busy || modes,
        label: spoken,
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Material(
            key: const ValueKey('footer-presence'),
            color: fill,
            shape: StadiumBorder(side: BorderSide(color: edge, width: 2.5)),
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: (busy && !modes) ? null : () => unawaited(_togglePresence(context)),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 50, minWidth: 48),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(icon, color: ink, size: 20),
                        const SizedBox(width: 6),
                        Text(label, maxLines: 1, style: t(15, color: ink, w: FontWeight.w900)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Home

class InfluencerHomeScreen extends StatelessWidget {
  const InfluencerHomeScreen({super.key});

  /// [HF-APP-DESI-11] approved influencer home layout.
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: presenceListenable,
          builder: (context, _) {
            final today = dayOnly(DateTime.now());
            final todays = demo.bookingsOn(today);
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              children: [
                InfHero(name: demo.name.isEmpty ? 'Influencer' : demo.name),
                const SizedBox(height: 12),
                // [HF-CALL-MODES-E2] with call modes on, the card shows her mode and opens the three-way choice
                if (CallFlags.modes && PresenceBridge.real && PresenceStore.instance.loaded)
                  HostModeCard(store: PresenceStore.instance)
                else
                  PresenceCard(online: myOnline, onTap: () => StatefulNavigationShell.of(context).goBranch(2)),
                const SizedBox(height: 12),
                if (CallFlags.queue && PresenceBridge.real && PresenceStore.instance.loaded && PresenceStore.instance.mode == 'online') ...[
                  const HostQueueCard(),
                  const SizedBox(height: 12),
                ],
                // [HF-WIRE-12] Dummy numbers: shown in the demo build only (no "today" summary route exists yet).
                if (DemoMode.on) ...[
                  InfTodayTiles(calls: '6', minutes: '41', earned: inr(41 * demo.myRate * 0.6 - 41 * 2, paise: false)),
                  const SizedBox(height: 12),
                ],
                const _EarningsCard(), // [HF-WIRE-10]
                if (PresenceBridge.real) ...[
                  const SizedBox(height: 12),
                  const FraandsCountTiles(), // [HF-APP-PARITY-SAFETY]
                ],
                if (PresenceBridge.real) const SharePageCard(), // [HF-SHARE-APP-1]
                if (PresenceBridge.real) const ProfilePhotoCard(), // [HF-CHANNEL-APP-1]
                const SizedBox(height: 16),
                InfSectionHead(title: 'Today\'s bookings', action: 'All', onAction: () => StatefulNavigationShell.of(context).goBranch(1)),
                if (BookingsBridge.real) const RealTodaysBookings() else ...[ // [HF-WIRE-8]
                  if (todays.isEmpty) Text('No bookings today.', style: t(15, color: C.muted, w: FontWeight.w700)),
                  for (var i = 0; i < todays.length; i++) BookingTile(todays[i], index: i),
                ],
                const SizedBox(height: 16),
                if (PresenceBridge.real) const MyReelsSection() else ...[
                  InfSectionHead(title: 'My reels', action: 'Manage channels', onAction: () => context.push('/inf/channels')),
                  Text('24 of 31 passed the face check and are in the feed.', style: t(14, color: C.muted, w: FontWeight.w700)),
                  const SizedBox(height: 10),
                  SizedBox(
                    height: 130,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: 6,
                      separatorBuilder: (_, __) => const SizedBox(width: 8),
                      itemBuilder: (_, i) {
                        final who = influencers[i % influencers.length];
                        return InfReelThumb(
                          index: i,
                          ok: i != 4,
                          child: DecoratedBox(
                            decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: who.tones)),
                            child: who.portrait == null ? null : Art(who.portrait!, fit: BoxFit.cover, alignment: Alignment.topCenter),
                          ),
                        );
                      },
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                const DesiMogra(),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// One fan booking on the influencer side.
class BookingTile extends StatelessWidget {
  const BookingTile(this.b, {super.key, this.showDay = false, this.index = 0});

  final InBooking b;
  final bool showDay;
  final int index;

  @override
  Widget build(BuildContext context) => InfBookingCard(
        index: index,
        time: b.time,
        fan: b.fan,
        line: '${showDay ? '${dayLabel(b.day)} · ' : ''}${b.minutes} min${b.note.isEmpty ? '' : ' · ${b.note}'}',
      );
}

// ---------------------------------------------------------------------------------------------- Online / Offline

/// Online = shown in the feed with Call now, on app and web. Offline = do not disturb, bookings still open.
class InfluencerStatusScreen extends StatelessWidget {
  const InfluencerStatusScreen({super.key});

  /// [HF-APP-DESI-11] approved Online (cream) / Offline (dark plum) layout.
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListenableBuilder(
        listenable: presenceListenable,
        builder: (context, _) {
          final on = myOnline;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 350),
            decoration: BoxDecoration(
              color: on ? C.ivory : null,
              gradient: on ? null : const RadialGradient(center: Alignment(0, -.64), radius: 1.2, colors: [Color(0xFF6B2468), Color(0xFF4A1747), Color(0xFF2B1530)], stops: [0, .45, 1]),
            ),
            child: SafeArea(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                children: [
                  const FlowerString(),
                  const SizedBox(height: 10),
                  Text('YOU ARE', textAlign: TextAlign.center, style: t(16, color: on ? C.onlineInk : const Color(0xFFF7E6F0), w: FontWeight.w800, ls: .12)),
                  Text(on ? 'ONLINE' : 'OFFLINE', textAlign: TextAlign.center, style: t(54, color: on ? C.maroon : C.lemon, w: FontWeight.w900, h: 1.05)),
                  const SizedBox(height: 12),
                  Center(
                    child: SizedBox(
                      width: 250,
                      height: 250,
                      child: Stack(clipBehavior: Clip.none, alignment: Alignment.center, children: [
                        Container(
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            gradient: RadialGradient(colors: on ? const [C.goldtint, Color(0xFFFFE2B8)] : const [Color(0xFF6B2468), Color(0xFF4A1747)]),
                          ),
                        ),
                        Art(on ? 'influencer/online-mode.webp' : 'influencer/offline-mode.webp', width: 240, height: 240, fit: BoxFit.contain),
                        const Positioned(left: -10, bottom: 10, child: Marigold(size: 54)),
                        const Positioned(right: -6, top: 20, child: Hibiscus(size: 44)),
                      ]),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Text(
                    on
                        ? 'Fans see you as Online on the app and the website. Your reels are in the feed with a Call now button.'
                        : 'We will not disturb you. Your reels leave the feed and nobody can call you now — but fans can still book a time from your calendar.',
                    textAlign: TextAlign.center,
                    style: t(16, color: on ? C.deep : const Color(0xFFF7E6F0), w: FontWeight.w700, h: 1.45),
                  ),
                  const SizedBox(height: 22),
                  Semantics(
                    button: true,
                    child: GestureDetector(
                      onTap: () => togglePresence(context),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 300),
                        height: 84,
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          gradient: on ? const LinearGradient(colors: [C.onlineInk, Color(0xFF2E8B57)]) : null,
                          color: on ? null : const Color(0x1FFFFFFF),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: C.lemon, width: 3),
                        ),
                        child: Row(
                          children: [
                            if (on) Expanded(child: Center(child: Text('TAP TO GO OFFLINE', style: t(16, color: C.white, w: FontWeight.w900, ls: .04)))),
                            Container(
                              width: 64,
                              height: 64,
                              decoration: const BoxDecoration(shape: BoxShape.circle, color: C.white),
                              child: Icon(on ? Icons.wifi_tethering_rounded : Icons.nightlight_round, color: on ? C.onlineInk : C.maroon, size: 30),
                            ),
                            if (!on) Expanded(child: Center(child: Text('TAP TO GO ONLINE', style: t(16, color: C.white, w: FontWeight.w900, ls: .04)))),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(20),
                      gradient: on ? const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.goldtint]) : null,
                      color: on ? null : const Color(0x24FBBF24),
                      border: Border.all(color: on ? const Color(0xFFF3DFB3) : const Color(0x66FBBF24), width: 1.5),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.event_available_rounded, color: on ? C.amber : C.lemon),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            // [HF-WIRE-12] the count is the dummy list, so a live build says it without a number
                            DemoMode.on
                                ? '${demo.inBookings.length} bookings coming up. They ring you at the booked time, online or offline.'
                                : 'Booked calls ring you at the booked time, online or offline.',
                            style: t(14, color: on ? C.deep : const Color(0xFFFDE68A), w: FontWeight.w800, h: 1.35),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Bookings calendar

/// Who booked the influencer, by date: month calendar with dots, then the day's list.
class InfluencerBookingsScreen extends StatefulWidget {
  const InfluencerBookingsScreen({super.key});

  @override
  State<InfluencerBookingsScreen> createState() => _InfluencerBookingsScreenState();
}

class _InfluencerBookingsScreenState extends State<InfluencerBookingsScreen> {
  DateTime _month = dayOnly(DateTime.now());
  DateTime _day = dayOnly(DateTime.now());

  /// [HF-APP-DESI-12] approved "Booked with me" layout (demo: no approval feature).
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) {
            final list = demo.bookingsOn(_day);
            final upcoming = [...demo.inBookings]..sort((a, b) => a.day.compareTo(b.day));
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              children: [
                const BookedWithMeHero(),
                const SizedBox(height: 12),
                CalendarCard(
                  child: BookMonth(
                    month: _month,
                    selected: _day,
                    allowPast: true,
                    fill: const {},
                    dots: {for (final b in demo.inBookings) dayKey(b.day)},
                    onPick: (d) => setState(() => _day = d),
                    onMonth: (m) => setState(() => _month = m),
                  ),
                ),
                const SizedBox(height: 14),
                Text(dayLabel(_day), style: t(18, color: C.maroon, w: FontWeight.w900)),
                if (list.isEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('No bookings on this day.', style: t(15, color: C.muted, w: FontWeight.w700))),
                for (var i = 0; i < list.length; i++) BookingTile(list[i], index: i),
                const SizedBox(height: 18),
                const InfSectionHead(title: 'All upcoming'),
                for (var i = 0; i < upcoming.length; i++) BookingTile(upcoming[i], showDay: true, index: i + 1),
                const SizedBox(height: 12),
                const DesiMogra(),
              ],
            );
          },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Availability

/// The influencer sets which dates and times fans can book, plus their rate.
class AvailabilityScreen extends StatefulWidget {
  const AvailabilityScreen({super.key});

  @override
  State<AvailabilityScreen> createState() => _AvailabilityScreenState();
}

class _AvailabilityScreenState extends State<AvailabilityScreen> {
  DateTime _month = dayOnly(DateTime.now());
  DateTime _day = dayOnly(DateTime.now());

  /// [HF-APP-DESI-12] approved "Availability" layout (demo).
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) {
            final open = demo.slotsOn(_day);
            final perMin = demo.myRate * 0.6 - 2;
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              children: [
                const DesiHero(eyebrow: 'Availability', title: 'When can fans book?', sub: 'Open days and times, India time.', ghost: 'Kab', tone: DesiTone.lav, minHeight: 120),
                const SizedBox(height: 8),
                Text('Tap a date, then tap the times you are free. Yellow dates are open.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
                const SizedBox(height: 12),
                CalendarCard(
                  white: true,
                  child: BookMonth(
                    month: _month,
                    selected: _day,
                    fill: demo.availability.keys.toSet(),
                    onPick: (d) => setState(() => _day = d),
                    onMonth: (m) => setState(() => _month = m),
                  ),
                ),
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                  decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: const Color(0xFFB9E2E5), width: 1.5)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text(dayLabel(_day), style: t(18, color: C.maroon, w: FontWeight.w900))),
                      Text(open.isEmpty ? 'Closed' : 'Open', style: t(14, color: open.isEmpty ? C.muted : C.peacock, w: FontWeight.w800)),
                      const SizedBox(width: 6),
                      DesiSwitch(value: open.isNotEmpty, onChanged: (v) => demo.setDayOpen(_day, v)),
                    ]),
                    const SizedBox(height: 6),
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      for (final s in allSlots) availabilityChip(label: s, selected: open.contains(s), onSelected: (_) => demo.toggleSlot(_day, s)),
                    ]),
                  ]),
                ),
                const SizedBox(height: 12),
                RateCard(
                  rate: '₹${demo.myRate}/min',
                  line: 'You get about ${inr(perMin < 0 ? 0 : perMin)} a minute',
                  onLower: () => demo.setRate(demo.myRate - 1),
                  onRaise: () => demo.setRate(demo.myRate + 1),
                ),
                const SizedBox(height: 12),
                Text('Going online for instant calls is the round button in the middle of your bar.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
                const SizedBox(height: 12),
                const DesiMogra(),
              ],
            );
          },
        ),
      ),
    );
  }
}


/// READY TO WITHDRAW and the 7-day hold on the influencer Home (HF-WIRE-10). Real numbers come from
/// `GET /api/hf/payouts/summary`; a failed or switched-off read shows dashes, never made-up money.
/// The split text matches HF-REEL-30.
class _EarningsCard extends StatefulWidget {
  const _EarningsCard();

  @override
  State<_EarningsCard> createState() => _EarningsCardState();
}

class _EarningsCardState extends State<_EarningsCard> {
  bool get _real => !DemoMode.on;
  PayoutSummary? _summary;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    if (_real) _load();
  }

  Future<void> _load() async {
    try {
      final s = await Services.instance.payoutsRepo.summary();
      if (mounted) setState(() => _summary = s);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final String ready;
    final String hold;
    if (!_real) {
      ready = inr(demo.earningsReady, paise: false);
      hold = '${inr(demo.earningsHold, paise: false)} on 7-day hold';
    } else if (_summary != null) {
      ready = inr(_summary!.readyPaise / 100, paise: false);
      hold = '${inr(_summary!.onHoldPaise / 100, paise: false)} on 7-day hold';
    } else {
      ready = '—';
      hold = _failed ? 'Could not load. Tap to open Withdraw.' : 'Loading…';
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        EarningsGullak(
          ready: ready,
          hold: hold,
          onTap: () async {
            await context.push('/payout');
            if (_real && mounted) _load();
          },
        ),
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text('We keep ₹2 a minute plus 40% of your rate above ₹2. The rest is yours.', style: t(14, color: C.muted, w: FontWeight.w700)),
        ),
      ],
    );
  }
}


/// [HF-APP-PARITY-SAFETY] "Hearts" (people who saved you) and "Waiting for you online" (people who asked Notify me),
/// from `GET /api/hf/me/summary` -> fraands.hearts / fraands.waiting. A failed read shows dashes, never made-up numbers.
class FraandsCountTiles extends StatefulWidget {
  const FraandsCountTiles({super.key, this.repo});

  final SafetyRepo? repo;

  @override
  State<FraandsCountTiles> createState() => _FraandsCountTilesState();
}

class _FraandsCountTilesState extends State<FraandsCountTiles> {
  FraandsCounts? _counts;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final c = await (widget.repo ?? Services.instance.safetyRepo).fraandsCounts();
      if (mounted) setState(() => _counts = c);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  String _n(int? v) => v != null ? '$v' : (_failed || _counts != null ? '—' : '…');

  @override
  Widget build(BuildContext context) {
    final c = _counts;
    return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Expanded(child: DesiKpi(label: 'Hearts', value: _n(c?.hearts), sub: 'People who saved you', tone: DesiTone.rani, icon: Icons.favorite_rounded)),
      const SizedBox(width: 12),
      Expanded(child: DesiKpi(label: 'Waiting for you online', value: _n(c?.waiting), sub: 'Asked Notify me', tone: DesiTone.gold, icon: Icons.notifications_active_rounded)),
    ]);
  }
}
