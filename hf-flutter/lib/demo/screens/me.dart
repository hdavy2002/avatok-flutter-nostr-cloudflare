import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/call_flags.dart'; // [HF-CALL-SAFETY-APP]
import '../../data/call_safety_store.dart'; // [HF-CALL-SAFETY-APP]
import '../../data/demo_mode.dart';
import '../../data/models/wallet.dart';
import '../../data/repos/merch_repo.dart'; // [HF-HELP-MERCH-1]
import '../../data/services.dart';
import '../../data/telemetry.dart'; // [HF-ME-SETTINGS-MOVE]
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import '../booking_kit.dart';
import '../list_kit.dart';
import '../settings_kit.dart';
import '../desi.dart';
import '../queue_kit.dart'; // [HF-ME-SETTINGS-MOVE] HostQueueSettingsRows
import 'bookings_real.dart'; // [HF-WIRE-8]
import 'call_real.dart';
import 'merch_me.dart'; // [HF-MERCH-APP-1]
import '../share_page_kit.dart'; // [HF-SHARE-APP-1]
import 'sheets.dart';
import 'my_photos.dart'; // [HF-MOD-APP-PHOTOS]
import 'onboarding/intro_onb_kit.dart'; // [HF-INTRO-A1]
import 'call_records_real.dart';
import 'settings_real.dart';
import '../../ui/strings/help_strings.dart';

/// Me — the customer dashboard: wallet ticket + menu (call records, wallet, withdrawal, bookings…).
class MeScreen extends StatelessWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListenableBuilder(
        listenable: Listenable.merge([demo, Services.instance.authAccount]),
        builder: (context, _) {
          final signedIn = DemoMode.on ? demo.signedIn : Services.instance.isSignedIn;
          return signedIn
              ? _Dashboard(key: ValueKey(DemoMode.on ? 'demo' : Services.instance.user?.id))
              : const _Guest();
        },
      ),
    );
  }
}

class _Guest extends StatelessWidget {
  const _Guest();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      bottom: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
        children: [
          DesiHero(
            eyebrow: 'Your bazaar pass',
            title: 'Aao, apna pass banao',
            sub: 'Log in or create a free account to call, book and save favourites.',
            ghost: 'Pass',
            tone: DesiTone.saffron,
            art: const SizedBox(width: 118, height: 150, child: Art('me/welcome-rangili.webp', fit: BoxFit.contain)),
            minHeight: 230,
          ),
          const SizedBox(height: 16),
          DesiCard(
            tone: DesiTone.lav,
            corner: DesiCorner.yellow,
            pattern: DesiPattern.dots,
            title: 'Shuru karo',
            note: 'Free. Takes a minute.',
            child: const AccountButtons(),
          ),
          const SizedBox(height: 12),
          DesiCard(
            tone: DesiTone.gold,
            corner: DesiCorner.hibiscus,
            title: 'How ${Brand.name} works',
            note: 'Watch reels, then talk to the influencer on a private call.',
            onTap: () => context.push('/help'),
            child: Align(alignment: Alignment.centerLeft, child: DesiChip('Read the help', tone: DesiTone.gold, icon: Icons.arrow_forward_rounded)),
          ),
          const DesiMogra(),
        ],
      ),
    );
  }
}

class _Dashboard extends StatelessWidget {
  const _Dashboard({super.key});

  @override
  Widget build(BuildContext context) {
    // [HF-WIRE-12] The counts below are dummy numbers: a live build shows none (the screens behind them have the real ones).
    const live = !DemoMode.on;
    final name = live ? (Services.instance.me?.name ?? 'Friend') : demo.name;
    final isInfluencer = live ? Services.instance.me?.isHost == true : demo.influencerJoined;
    final items = <(IconData, String, String, String)>[
      (Icons.call_rounded, 'Call records', live ? '' : '${demo.calls.length} calls', '/calls'),
      (Icons.currency_rupee_rounded, 'Wallet', live ? '' : inr(demo.balance, paise: false), '/wallet'),
      (Icons.north_east_rounded, 'Withdraw', '', '/payout'), // [HF-WIRE-13] open to fans too
      (Icons.event_rounded, 'My bookings', live ? '' : '${demo.bookings.length}', '/bookings'),
      (Icons.favorite_rounded, 'Favourites', live ? '' : '${demo.favs.length}', 'tab:/favourites'),
      (Icons.settings_rounded, 'Settings', '', '/settings'),
      (Icons.help_rounded, 'Help', '', '/help'),
    ];
    final first = name.split(' ').first;
    final mine = items.where((it) => const {'/calls', '/wallet', '/payout', '/bookings', 'tab:/favourites'}.contains(it.$4)).toList();
    final acct = items.where((it) => const {'/settings', '/help'}.contains(it.$4)).toList();
    const tones = [DesiTone.rani, DesiTone.gold, DesiTone.tea, DesiTone.lav, DesiTone.rani];
    void open(String to) => to.startsWith('tab:') ? context.go(to.substring(4)) : context.push(to);
    return SafeArea(
      bottom: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
        children: [
          if (live) const MyPhotoCard(), // [HF-MOD-APP-PHOTOS] hidden while hfPhotoModerationEnabled is off
          DesiHero(
            eyebrow: 'Namaste, $first',
            title: 'Aaj kisse baat karni hai?',
            sub: live ? 'Your calls, wallet and bookings, all in one place.' : 'Aaj ka scene: ${demo.bookings.length} booking coming up and ${demo.favs.length} saved fraands.',
            ghost: 'Mera',
            tone: DesiTone.saffron,
            art: const SizedBox(width: 112, height: 132, child: Art('me/welcome-rangili.webp', fit: BoxFit.contain)),
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              DesiButton('Find someone', icon: Icons.search_rounded, kind: DesiButtonKind.rani, onTap: () => context.go('/search')),
              DesiButton('Top up', icon: Icons.add_rounded, kind: DesiButtonKind.ghost, onTap: () => unawaited(context.push('/topup').then((_) => WalletTicket.refresh.value++))),
            ]),
          ),
          if (!live) ...[
            const SizedBox(height: 12),
            DesiTicker(items: [
              'Your booking with ${demo.bookings.isEmpty ? 'an influencer' : demo.bookings.first.who.name} is coming up',
              '${demo.favs.length} of your fraands saved',
              'Rate your last call, two taps',
            ]),
          ],
          const SizedBox(height: 14),
          GestureDetector(onTap: () => unawaited(context.push('/wallet').then((_) => WalletTicket.refresh.value++)), child: const WalletTicket()),
          if (!live) ...[
            const SizedBox(height: 12),
            DesiKpiGrid(children: [
              DesiKpi(label: 'Calls', value: '${demo.calls.length}', sub: 'this month', tone: DesiTone.lav, icon: Icons.call_rounded, onTap: () => context.push('/calls')),
              DesiKpi(label: 'Bookings', value: '${demo.bookings.length}', sub: 'coming up', tone: DesiTone.rani, icon: Icons.event_rounded, onTap: () => context.push('/bookings')),
              DesiKpi(label: 'My Fraands', value: '${demo.favs.length}', sub: 'saved', tone: DesiTone.gold, icon: Icons.favorite_rounded, onTap: () => context.go('/favourites')),
              DesiKpi(label: 'Influencer', value: isInfluencer ? (demo.online ? 'Online' : 'Offline') : 'Join', sub: isInfluencer ? 'your status' : 'free to join', tone: DesiTone.tea, icon: Icons.star_rounded,
                  onTap: () => (isInfluencer && !IntroOnbEntry.pending) ? context.go('/inf/home') : context.push('/influencer/join')),
            ]),
          ],
          // [HF-ME-SETTINGS-MOVE] Influencer tools: moved here from Settings (same host-only condition).
          if (isInfluencer) ...[
            const SizedBox(height: 16),
            _MenuGroup(title: 'Influencer tools', tone: DesiTone.lav, corner: DesiCorner.yellow, children: [
              _MenuRow(icon: Icons.smart_display_rounded, label: 'Social media verification', meta: '', tone: DesiTone.lav, onTap: () => _tool(context, 'social_verification', () => context.push('/inf/channels'))),
              _MenuRow(icon: Icons.verified_user_rounded, label: 'My verifications', meta: '', tone: DesiTone.lav, onTap: () => _tool(context, 'my_verifications', () => context.push('/inf/verifications'))), // [HF-CREATOR-BADGES-1]
              // [HF-BOOK-APPROVE-5] her calendar and bookings live in her own shell, so go (not push).
              _MenuRow(icon: Icons.edit_calendar_rounded, label: 'Availability calendar', meta: '', tone: DesiTone.tea, onTap: () => _tool(context, 'availability_calendar', () => context.go('/inf/availability'))),
              _MenuRow(icon: Icons.event_note_rounded, label: 'Calls booked with me', meta: '', tone: DesiTone.gold, onTap: () => _tool(context, 'calls_booked_with_me', () => context.go('/inf/bookings'))),
            ]),
            // [HF-CALL-MODES-E2] only while the queue flag is on: who waits, and Pause / Resume.
            if (live && CallFlags.queue && SettingsBridge.real) ...[
              const SizedBox(height: 12),
              SettingsCard(title: 'Call queue', tone: DesiTone.gold, children: const [HostQueueSettingsRows()]),
            ],
          ],
          const SizedBox(height: 16),
          _MenuGroup(title: 'Mera space', tone: DesiTone.white, corner: DesiCorner.marigold, children: [
            for (var i = 0; i < mine.length; i++) _MenuRow(icon: mine[i].$1, label: mine[i].$2, meta: mine[i].$3, tone: tones[i % tones.length], onTap: () => open(mine[i].$4)),
          ]),
          const SizedBox(height: 12),
          _MenuGroup(title: 'Influencer', tone: DesiTone.lav, corner: DesiCorner.yellow, children: [
            _MenuRow(
              icon: Icons.star_rounded,
              label: isInfluencer ? 'Influencer dashboard' : 'Join as an influencer',
              meta: live ? (isInfluencer ? '' : 'Free') : (demo.influencerJoined ? (demo.online ? 'Online' : 'Offline') : 'Free'),
              tone: DesiTone.rani,
              onTap: () => (isInfluencer && !IntroOnbEntry.pending) ? context.go('/inf/home') : context.push('/influencer/join'),
            ),
            // [HF-CALL-SAFETY-APP] Safety (strikes) and Call rules; only while call recording is on.
            if (live && isInfluencer && CallFlags.callRecording) const _SafetyRows(),
          ]),
          if (live && isInfluencer) const SharePageCard(), // [HF-SHARE-APP-1]
          if (live) MerchMeSection(isInfluencer: isInfluencer), // [HF-MERCH-APP-1] hidden while hfMerchEnabled is off
          const SizedBox(height: 12),
          _MenuGroup(title: 'Account', tone: DesiTone.gold, corner: DesiCorner.hibiscus, children: [
            for (final it in acct) _MenuRow(icon: it.$1, label: it.$2, meta: it.$3, tone: DesiTone.gold, onTap: () => open(it.$4)),
          ]),
          const DesiMogra(),
          Text('Feeling low? Tele-MANAS 14416 · free, 24×7', textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w600)),
        ],
      ),
    );
  }
}

/// [HF-ME-SETTINGS-MOVE] One tap on an Influencer tools row: telemetry first, then go.
void _tool(BuildContext context, String item, VoidCallback go) {
  Telemetry.event('hf_me_tools_open', {'item': item});
  go();
}

/// [HF-CALL-SAFETY-APP] The "Safety" row (amber "N of 3 strikes" chip, or "No strikes") and the "Call rules" row of the Influencer card
/// (artboard AppHostHome). A paused or closed account opens the paused page instead of the strikes page.
class _SafetyRows extends StatefulWidget {
  const _SafetyRows();

  @override
  State<_SafetyRows> createState() => _SafetyRowsState();
}

class _SafetyRowsState extends State<_SafetyRows> {
  @override
  void initState() {
    super.initState();
    CallSafetyStore.instance.addListener(_changed);
    unawaited(CallSafetyStore.instance.load());
  }

  @override
  void dispose() {
    CallSafetyStore.instance.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final m = CallSafetyStore.instance.me;
    final blocked = m != null && (m.isPaused || m.isBanned);
    final chip = m == null
        ? ''
        : (m.isBanned ? 'Closed' : (m.isPaused ? 'Paused' : (m.activeStrikes == 0 ? 'No strikes' : '${m.activeStrikes} of ${m.strikesToPause} strikes')));
    return Column(children: [
      _MenuRow(icon: Icons.shield_rounded, label: 'Safety', meta: chip, tone: DesiTone.gold, onTap: () => unawaited(context.push(blocked ? '/safety/paused' : '/safety'))),
      _MenuRow(icon: Icons.menu_book_rounded, label: 'Call rules', meta: '', tone: DesiTone.tea, onTap: () => unawaited(context.push('/safety/rules'))),
    ]);
  }
}

class _MenuGroup extends StatelessWidget {
  const _MenuGroup({required this.title, required this.tone, required this.corner, required this.children});
  final String title;
  final DesiTone tone;
  final DesiCorner corner;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => DesiCard(
        title: title,
        tone: tone,
        corner: corner,
        padding: const EdgeInsets.fromLTRB(14, 16, 14, 8),
        child: Column(children: children),
      );
}

/// The big pink tag with the balance and a Top up end.
/// A live build reads the real balance from `GET /api/hf/app/wallet`; the dummy balance is for the demo build only.
class WalletTicket extends StatefulWidget {
  const WalletTicket({super.key});

  /// Bump after anything that can change the balance (top-up, call, booking) so the ticket reloads.
  static final ValueNotifier<int> refresh = ValueNotifier<int>(0);

  @override
  State<WalletTicket> createState() => _WalletTicketState();
}

class _WalletTicketState extends State<WalletTicket> {
  WalletSnapshot? _wallet;
  Object? _error; // [HF-WIRE-20] why the last read failed, so the caption can say so
  bool get _failed => _error != null;

  bool get _live => !DemoMode.on;

  @override
  void initState() {
    super.initState();
    WalletTicket.refresh.addListener(_load);
    if (_live) unawaited(_load());
  }

  @override
  void dispose() {
    WalletTicket.refresh.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    if (!_live) return;
    try {
      // [HF-APP-CACHE-1] The last balance shows at once; the server's answer (always asked) replaces it.
      await for (final w in Services.instance.walletRepo.watch(limit: 1)) {
        if (mounted) {
          setState(() {
            _wallet = w;
            _error = null;
          });
        }
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  /// [HF-WIRE-20] Specific, never a bare "could not load": offline, signed out, or our side. The repo already tried twice.
  String get _failCaption {
    final e = _error;
    if (e is ApiException) {
      if (e.isOffline) return 'No internet. Tap to try again.';
      if (e.isUnauthorized) return 'Please sign in again.';
      if (e.isTransient) return 'Our server is busy. Tap to try again.';
    }
    return 'Could not load your balance. Tap to try again.';
  }

  @override
  Widget build(BuildContext context) {
    final w = _wallet;
    final String amount;
    final String caption;
    if (!_live) {
      amount = inr(demo.balance);
      caption = '≈ ${(demo.balance / 15).floor()} minutes at ₹15/min';
    } else if (w != null) {
      amount = inr((w.balancePaise + w.testCreditPaise) / 100);
      caption = w.heldPaise > 0 ? '${inr(w.heldPaise / 100)} set aside for a booking' : 'Ready for calls and bookings';
    } else {
      amount = '—';
      caption = _failed ? _failCaption : 'Checking your balance…';
    }
    return DesiCounter(
      label: 'Wallet balance',
      value: amount,
      sub: caption,
      child: Row(children: [
        DesiButton('Add money', icon: Icons.add_rounded, kind: DesiButtonKind.gold, onTap: () => unawaited(context.push('/topup').then((_) => WalletTicket.refresh.value++))),
        if (_live && _failed) ...[
          const SizedBox(width: 8),
          DesiButton('Try again', kind: DesiButtonKind.ghost, onTap: () => unawaited(_load())),
        ],
      ]),
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, required this.meta, required this.onTap, this.tone = DesiTone.lav});

  final IconData icon;
  final String label;
  final String meta;
  final VoidCallback onTap;
  final DesiTone tone;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 58),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.line))),
          child: Row(
            children: [
              DesiIconSquare(icon, tone: tone),
              const SizedBox(width: 12),
              Expanded(child: Text(label, style: t(17, w: FontWeight.w700))),
              if (meta.isNotEmpty) DesiChip(meta, tone: tone),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right_rounded, color: C.maroon),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Call records

class CallRecordsScreen extends StatelessWidget {
  const CallRecordsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    if (CallsBridge.real) return const RealCallRecordsScreen(); // [HF-WIRE-7]
    // [HF-APP-DESI-7] approved Call records layout
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Call records'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  const ListHero(eyebrow: 'Call records', title: 'Har baat ka hisaab', sub: 'Every call, its minutes and what it cost.', ghost: 'Baat'),
                  const SizedBox(height: 12),
                  for (var i = 0; i < demo.calls.length; i++)
                    CallRecordCard(
                      index: i,
                      who: demo.calls[i].who,
                      name: demo.calls[i].who.name,
                      detail: '${demo.calls[i].when} · ${demo.calls[i].minutes} min',
                      stars: demo.calls[i].stars,
                      amount: inr(-demo.calls[i].cost, paise: false),
                      onCallAgain: () => context.push('/profile/${demo.calls[i].who.id}'),
                    ),
                  const SizedBox(height: 4),
                  const DesiMogra(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Bookings

class BookingsScreen extends StatelessWidget {
  const BookingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    if (BookingsBridge.real) return const RealBookingsScreen(); // [HF-WIRE-8]
    // [HF-APP-DESI-7] approved My bookings layout
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) => Column(
            children: [
              const BookHeader('My bookings'),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    const ListHero(eyebrow: 'My bookings', title: 'Aapke booked samay', sub: 'Cancel free until 1 hour before a call.', ghost: 'Samay', teal: true),
                    const SizedBox(height: 12),
                    if (demo.bookings.isEmpty)
                      Padding(padding: const EdgeInsets.symmetric(vertical: 40), child: Center(child: Text('No bookings yet.', style: t(17, color: C.muted, w: FontWeight.w800))))
                    else
                      for (var i = 0; i < demo.bookings.length; i++)
                        BookingTicketCard(
                          index: i,
                          stub: stubOfLabel(demo.bookings[i].day),
                          who: demo.bookings[i].who,
                          name: demo.bookings[i].who.name,
                          time: demo.bookings[i].time,
                          held: '${inr(demo.bookings[i].hold, paise: false)} held · 10 min',
                          chip: const BookingStatusChip(BookingKind.confirmed),
                          onCancel: () async {
                            final b = demo.bookings[i];
                            final ok = await hfConfirm(
                              context,
                              title: 'Cancel this booking?',
                              body: 'The ${inr(b.hold, paise: false)} hold comes back to your wallet.',
                              confirmLabel: 'Cancel',
                              cancelLabel: 'Keep it',
                              destructive: true,
                            );
                            if (ok == true) demo.cancelBooking(b);
                          },
                        ),
                    const SizedBox(height: 4),
                    const DesiMogra(),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Settings

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _callAlerts = true;
  bool _bookingReminders = true;
  bool _newReels = false;

  @override
  Widget build(BuildContext context) {
    if (SettingsBridge.real) return const RealSettingsScreen(); // [HF-WIRE-11]
    final host = demo.influencerJoined || Services.instance.me?.isHost == true;
    // [HF-APP-DESI-10] approved Settings layout
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Settings'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  SettingsMeStrip(name: demo.name, hint: 'Your name on calls and bookings'),
                  const SizedBox(height: 12),
                  SettingsCard(title: 'Account', tone: DesiTone.rani, children: [
                    SettingsRow(icon: Icons.mail_rounded, tone: DesiTone.rani, label: 'Email', sub: demo.email),
                    SettingsRow(icon: Icons.chat_rounded, tone: DesiTone.rani, label: 'WhatsApp', sub: demo.whatsappDisplay, last: !host),
                    // [HF-WIRE-3] Channels: for an influencer, or someone who has started joining.
                    if (host) SettingsRow(icon: Icons.smart_display_rounded, tone: DesiTone.lav, label: 'Social media verification', last: false, onTap: () => context.push('/inf/channels')),
                    if (host) SettingsRow(icon: Icons.verified_user_rounded, tone: DesiTone.lav, label: 'My verifications', last: true, onTap: () => context.push('/inf/verifications')), // [HF-CREATOR-BADGES-1]
                  ]),
                  const SizedBox(height: 12),
                  SettingsCard(title: 'WhatsApp messages', tone: DesiTone.tea, flower: true, children: [
                    SettingsSwitch(icon: Icons.notifications_active_rounded, label: 'Call alerts', value: _callAlerts, onChanged: (v) => setState(() => _callAlerts = v)),
                    SettingsSwitch(icon: Icons.alarm_rounded, label: 'Booking reminders', value: _bookingReminders, onChanged: (v) => setState(() => _bookingReminders = v)),
                    SettingsSwitch(icon: Icons.movie_rounded, label: 'New reels from favourites', value: _newReels, last: true, onChanged: (v) => setState(() => _newReels = v)),
                  ]),
                  const SizedBox(height: 12),
                  SettingsCard(title: 'About', tone: DesiTone.lav, children: [
                    SettingsRow(icon: Icons.help_rounded, tone: DesiTone.lav, label: 'Help and FAQ', onTap: () => context.push('/help')),
                    const SettingsRow(icon: Icons.description_rounded, tone: DesiTone.lav, label: 'Terms and privacy', sub: 'Opens the website'),
                    const SettingsRow(icon: Icons.info_rounded, tone: DesiTone.lav, label: 'App version', value: 'demo build', last: true),
                  ]),
                  const SizedBox(height: 16),
                  OutlinePill(
                    label: 'SIGN OUT',
                    onTap: () async {
                      final go = GoRouter.of(context);
                      // Real build: Clerk sign-out + forget the account (Services.signOut also resets the screen state).
                      if (DemoMode.on) {
                        demo.signOut();
                      } else {
                        await Services.instance.signOut();
                      }
                      go.go('/reels');
                    },
                  ),
                  const SizedBox(height: 12),
                  const DesiMogra(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Help

class HelpScreen extends StatelessWidget {
  const HelpScreen({super.key});

  /// [HF-APP-DESI-10] approved Help layout.
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader(HelpStrings.title),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  const DesiHero(eyebrow: 'Help', title: 'Koi sawaal?', sub: 'Quick answers about calls, money and bookings.', ghost: 'Madad', tone: DesiTone.gold, minHeight: 120),
                  const SizedBox(height: 12),
                  for (var i = 0; i < HelpStrings.faq.length; i++) FaqCard(index: i, question: HelpStrings.faq[i].$1, answer: HelpStrings.faq[i].$2, initiallyOpen: i == 0),
                  const _MerchHelpCards(), // [HF-HELP-MERCH-1] hidden while hfMerchEnabled is off
                  const SizedBox(height: 4),
                  HelpMailCard(key: const Key('help-email'), lead: HelpStrings.stillStuck, email: HelpStrings.supportEmail, onTap: () => openSupportMail(context)),
                  const SizedBox(height: 12),
                  const DesiMogra(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// [HF-HELP-MERCH-1] The T-shirt answers on Help. They appear only once `/api/config` says `hfMerchEnabled` (same switch as the Merch screens).
class _MerchHelpCards extends StatefulWidget {
  const _MerchHelpCards();

  @override
  State<_MerchHelpCards> createState() => _MerchHelpCardsState();
}

class _MerchHelpCardsState extends State<_MerchHelpCards> {
  @override
  void initState() {
    super.initState();
    MerchRepo.flags.addListener(_changed);
    unawaited(Services.instance.merchRepo.loadFlags());
  }

  @override
  void dispose() {
    MerchRepo.flags.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    if (!MerchRepo.flags.value.enabled) return const SizedBox.shrink();
    final n = HelpStrings.faq.length;
    return Column(children: [
      for (var i = 0; i < HelpStrings.merchFaq.length; i++)
        FaqCard(index: n + i, question: HelpStrings.merchFaq[i].$1, answer: HelpStrings.merchFaq[i].$2, initiallyOpen: false),
    ]);
  }
}
