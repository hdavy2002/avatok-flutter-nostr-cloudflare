import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data.dart';
import '../presence_bridge.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

// ---------------------------------------------------------------------------------------------- Join

/// Influencer sign-up (HF-REEL-2): details + page URL → consent → WhatsApp verify → dashboard.
class InfluencerJoinScreen extends StatefulWidget {
  const InfluencerJoinScreen({super.key});

  @override
  State<InfluencerJoinScreen> createState() => _InfluencerJoinScreenState();
}

class _InfluencerJoinScreenState extends State<InfluencerJoinScreen> {
  int _step = 0;
  late final _name = TextEditingController(text: demo.name);
  late final _email = TextEditingController(text: demo.email);
  final _url = TextEditingController();
  late final _wa = TextEditingController(text: demo.whatsapp);
  final _otp = TextEditingController();
  bool _consentVideos = false;
  bool _consentStats = false;
  bool _codeSent = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_name, _email, _url, _wa, _otp]) {
      c.dispose();
    }
    super.dispose();
  }

  void _next() {
    setState(() => _error = null);
    if (_step == 0) {
      if (_name.text.trim().isEmpty || !_email.text.contains('@')) {
        setState(() => _error = 'Please fill your name and a real email.');
        return;
      }
      final u = _url.text.toLowerCase();
      if (!(u.contains('instagram.com') || u.contains('youtube.com') || u.contains('youtu.be') || u.contains('facebook.com'))) {
        setState(() => _error = 'Paste your YouTube, Instagram or Facebook page link.');
        return;
      }
      setState(() => _step = 1);
    } else if (_step == 1) {
      if (!_consentVideos || !_consentStats) {
        setState(() => _error = 'Both boxes are needed so we can show your reels.');
        return;
      }
      setState(() => _step = 2);
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

  @override
  Widget build(BuildContext context) {
    const titles = ['Your page', 'Your permission', 'Your WhatsApp'];
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            PageHeader(title: 'Join as influencer', trailing: Text('${_step + 1}/3', style: t(16, color: C.tan))),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 22),
              child: Row(
                children: [
                  for (var i = 0; i < 3; i++) ...[
                    Expanded(child: Container(height: 8, decoration: BoxDecoration(color: i <= _step ? C.marigold : C.sand, borderRadius: BorderRadius.circular(999)))),
                    if (i < 2) const SizedBox(width: 6),
                  ],
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 18, 22, 16),
                children: [
                  Text(titles[_step], style: t(30, color: C.maroon)),
                  const SizedBox(height: 14),
                  if (_step == 0) ...[
                    _label('Your name'),
                    TextField(controller: _name, style: t(17, w: FontWeight.w700), decoration: const InputDecoration(hintText: 'Meera Joshi')),
                    const SizedBox(height: 12),
                    _label('Email'),
                    TextField(controller: _email, keyboardType: TextInputType.emailAddress, style: t(17, w: FontWeight.w700), decoration: const InputDecoration(hintText: 'you@example.com')),
                    const SizedBox(height: 12),
                    _label('Your YouTube, Instagram or Facebook page'),
                    TextField(controller: _url, keyboardType: TextInputType.url, style: t(16, w: FontWeight.w700), decoration: const InputDecoration(hintText: 'instagram.com/yourname')),
                    const SizedBox(height: 10),
                    Text('We show your public reels to fans. Fans can then call you at your own rate.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
                  ],
                  if (_step == 1) ...[
                    Text('To show your page here we need your OK for two things:', style: t(16, w: FontWeight.w700, h: 1.4)),
                    const SizedBox(height: 12),
                    _check('Show my videos as embeds in the Reels feed and on my profile.', _consentVideos, (v) => setState(() => _consentVideos = v)),
                    _check('Show my likes, comments and video counts.', _consentStats, (v) => setState(() => _consentStats = v)),
                    const SizedBox(height: 8),
                    Text('Only videos with your face in the first seconds go on the feed. You can remove any video later.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
                  ],
                  if (_step == 2) ...[
                    Text('We send call alerts and booking reminders here.', style: t(16, w: FontWeight.w700, h: 1.4)),
                    const SizedBox(height: 12),
                    _label('WhatsApp number'),
                    Row(
                      children: [
                        Container(
                          height: 58,
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: C.gold, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.deep, width: 3)),
                          child: Text('+91', style: t(17)),
                        ),
                        const SizedBox(width: 8),
                        Expanded(child: TextField(controller: _wa, keyboardType: TextInputType.phone, style: t(17, w: FontWeight.w700), decoration: const InputDecoration(hintText: '98765 43210'))),
                      ],
                    ),
                    if (_codeSent) ...[
                      const SizedBox(height: 14),
                      _label('6-digit code from WhatsApp'),
                      TextField(
                        controller: _otp,
                        keyboardType: TextInputType.number,
                        maxLength: 6,
                        textAlign: TextAlign.center,
                        style: t(28, ls: 0.4),
                        decoration: const InputDecoration(counterText: '', hintText: '••••••'),
                      ),
                    ],
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: t(14, color: C.ruby)),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 0, 22, 20),
              child: TicketButton(
                label: _step < 2 ? 'NEXT' : (_codeSent ? 'VERIFY & FINISH' : 'SEND CODE'),
                maroon: true,
                stubIcon: Icons.arrow_forward_rounded,
                onTap: _next,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(String s) => Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(s, style: t(15)));

  Widget _check(String label, bool v, ValueChanged<bool> on) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: InkWell(
          onTap: () => on(!v),
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: v ? C.butter : C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: v ? C.marigold : C.sand, width: 2)),
            child: Row(
              children: [
                Icon(v ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded, color: C.maroon, size: 28),
                const SizedBox(width: 10),
                Expanded(child: Text(label, style: t(15, h: 1.35))),
              ],
            ),
          ),
        ),
      );
}

// ---------------------------------------------------------------------------------------------- Shell

/// The influencer's own bottom bar (owner 2026-10-19): Home · Bookings · Online/Offline · Availability · Fan view.
class InfluencerShell extends StatelessWidget {
  const InfluencerShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    ensurePresenceLoaded();
    return ListenableBuilder(
      listenable: presenceListenable,
      builder: (context, _) {
        final items = <(IconData, String)>[
          (Icons.home_rounded, 'Home'),
          (Icons.event_note_rounded, 'Bookings'),
          (myOnline ? Icons.wifi_tethering_rounded : Icons.nightlight_round, myOnline ? 'Online' : 'Offline'),
          (Icons.edit_calendar_rounded, 'Availability'),
        ];
        return Scaffold(
          body: shell,
          bottomNavigationBar: Container(
            decoration: const BoxDecoration(color: C.paper, border: Border(top: BorderSide(color: C.turquoise, width: 3))),
            child: SafeArea(
              top: false,
              child: SizedBox(
                height: 72,
                child: Row(
                  children: [
                    for (var i = 0; i < items.length; i++)
                      Expanded(
                        child: Semantics(
                          button: true,
                          selected: shell.currentIndex == i,
                          label: items[i].$2,
                          child: InkWell(
                            onTap: () => shell.goBranch(i, initialLocation: i == shell.currentIndex),
                            child: i == 2 ? _statusTab(shell.currentIndex == i) : _tab(items[i].$1, items[i].$2, shell.currentIndex == i),
                          ),
                        ),
                      ),
                    Expanded(
                      child: Semantics(
                        button: true,
                        label: 'Switch to fan view',
                        child: InkWell(onTap: () => context.go('/me'), child: _tab(Icons.swap_horiz_rounded, 'Fan view', false)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _tab(IconData icon, String label, bool on) => Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 26, color: on ? C.maroon : C.muted),
          const SizedBox(height: 3),
          Text(label, style: t(12, color: on ? C.maroon : C.muted, w: on ? FontWeight.w800 : FontWeight.w700)),
        ],
      );

  /// The middle tab is the Online/Offline button: a big round colour dot.
  Widget _statusTab(bool on) => Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: myOnline ? C.rani : C.muted,
              border: Border.all(color: on ? C.lemon : C.paper, width: 3),
              boxShadow: myOnline ? [BoxShadow(color: C.rani.withValues(alpha: 0.4), blurRadius: 10, spreadRadius: 1)] : null,
            ),
            child: Icon(myOnline ? Icons.wifi_tethering_rounded : Icons.nightlight_round, color: C.paper, size: 22),
          ),
          const SizedBox(height: 2),
          Text(myOnline ? 'Online' : 'Offline', style: t(12, color: myOnline ? C.rani : C.muted)),
        ],
      );
}

// ---------------------------------------------------------------------------------------------- Home

class InfluencerHomeScreen extends StatelessWidget {
  const InfluencerHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: presenceListenable,
          builder: (context, _) {
            final today = dayOnly(DateTime.now());
            final todays = demo.bookingsOn(today);
            return ListView(
              padding: const EdgeInsets.fromLTRB(22, 16, 22, 24),
              children: [
                Text('NAMASTE', style: t(13, color: C.ruby, ls: 0.14)),
                Text(demo.name.isEmpty ? 'Influencer' : demo.name, style: t(30, color: C.maroon, h: 1.05)),
                const SizedBox(height: 16),
                GestureDetector(
                  onTap: () => StatefulNavigationShell.of(context).goBranch(2),
                  child: Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      color: myOnline ? C.maroon : C.deep,
                      borderRadius: BorderRadius.circular(20),
                      boxShadow: const [BoxShadow(color: C.lemon, offset: Offset(5, 5))],
                    ),
                    child: Row(
                      children: [
                        Icon(myOnline ? Icons.wifi_tethering_rounded : Icons.nightlight_round, color: C.lemon, size: 34),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(myOnline ? 'You are ONLINE' : 'You are OFFLINE', style: t(20, color: C.gold)),
                              Text(
                                myOnline ? 'Fans see your reels and can call you now.' : 'No calls now. Fans can still book you.',
                                style: t(14, color: C.cream, w: FontWeight.w700),
                              ),
                            ],
                          ),
                        ),
                        const Icon(Icons.chevron_right_rounded, color: C.gold),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                Row(
                  children: [
                    _stat('Calls today', '6'),
                    const SizedBox(width: 10),
                    _stat('Minutes', '41'),
                    const SizedBox(width: 10),
                    _stat('Earned today', inr(41 * demo.myRate * 0.6 - 41 * 2, paise: false)),
                  ],
                ),
                const SizedBox(height: 18),
                GestureDetector(
                  onTap: () => context.push('/payout'),
                  child: Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.deep, width: 3)),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('READY TO WITHDRAW', style: t(12, color: C.tan, ls: 0.12)),
                              Text(inr(demo.earningsReady, paise: false), style: t(30, color: C.maroon)),
                              Text('${inr(demo.earningsHold, paise: false)} on 7-day hold', style: t(13, color: C.muted, w: FontWeight.w700)),
                            ],
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                          decoration: BoxDecoration(color: C.marigold, borderRadius: BorderRadius.circular(12)),
                          child: Text('PAYOUT', style: t(14, ls: 0.06)),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Text('You keep 60% of each call minus ₹2 a minute.', style: t(13, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 22),
                Row(
                  children: [
                    Expanded(child: Text('Today\'s bookings', style: t(20, color: C.maroon))),
                    TextButton(onPressed: () => StatefulNavigationShell.of(context).goBranch(1), child: Text('All', style: t(15, color: C.maroon))),
                  ],
                ),
                if (todays.isEmpty) Text('No bookings today.', style: t(15, color: C.muted, w: FontWeight.w700)),
                for (final b in todays) BookingTile(b),
                const SizedBox(height: 22),
                Text('My reels', style: t(20, color: C.maroon)),
                const SizedBox(height: 4),
                Text('24 of 31 passed the face check and are in the feed.', style: t(14, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 10),
                SizedBox(
                  height: 130,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: 6,
                    separatorBuilder: (_, __) => const SizedBox(width: 8),
                    itemBuilder: (_, i) => Container(
                      width: 80,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(10),
                        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: influencers[i % influencers.length].tones),
                      ),
                      alignment: Alignment.topRight,
                      padding: const EdgeInsets.all(6),
                      child: Icon(i == 4 ? Icons.block_rounded : Icons.check_circle_rounded, color: i == 4 ? C.cream : C.lemon, size: 20),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _stat(String a, String b) => Expanded(
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
          decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(14)),
          child: Column(
            children: [
              FittedBox(child: Text(b, style: t(22, color: C.gold))),
              Text(a, textAlign: TextAlign.center, style: t(12, color: C.cream, w: FontWeight.w700)),
            ],
          ),
        ),
      );
}

/// One fan booking on the influencer side.
class BookingTile extends StatelessWidget {
  const BookingTile(this.b, {super.key, this.showDay = false});

  final InBooking b;
  final bool showDay;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.sandLine, width: 2)),
      child: Row(
        children: [
          Container(
            width: 64,
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(10)),
            child: Column(
              children: [
                Text(b.time.split(' ').first, style: t(16, color: C.maroon)),
                Text(b.time.split(' ').last, style: t(11, color: C.tan)),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(b.fan, style: t(16)),
                Text('${showDay ? '${dayLabel(b.day)} · ' : ''}${b.minutes} min${b.note.isEmpty ? '' : ' · ${b.note}'}',
                    maxLines: 2, overflow: TextOverflow.ellipsis, style: t(13, color: C.muted, w: FontWeight.w700)),
              ],
            ),
          ),
          const Icon(Icons.call_rounded, color: C.turquoise),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Online / Offline

/// Online = shown in the feed with Call now, on app and web. Offline = do not disturb, bookings still open.
class InfluencerStatusScreen extends StatelessWidget {
  const InfluencerStatusScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListenableBuilder(
        listenable: presenceListenable,
        builder: (context, _) {
          final on = myOnline;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 350),
            color: on ? C.ivory : C.deep,
            child: SafeArea(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
                children: [
                  Text(on ? 'YOU ARE' : 'YOU ARE', textAlign: TextAlign.center, style: t(16, color: on ? C.ruby : C.cream, ls: 0.14)),
                  Text(on ? 'ONLINE' : 'OFFLINE', textAlign: TextAlign.center, style: t(54, color: on ? C.maroon : C.gold, ls: 0.04, h: 1.05)),
                  const SizedBox(height: 12),
                  Center(
                    child: ArtMoment(
                      on ? 'influencer/online-mode.webp' : 'influencer/offline-mode.webp',
                      label: on ? 'RANGILI\nready to talk' : 'RANGILI\nresting',
                      size: 250,
                      ring: on ? C.butter : C.violet,
                    ),
                  ),
                  const SizedBox(height: 18),
                  Text(
                    on
                        ? 'Fans see you as Online on the app and the website. Your reels are in the feed with a Call now button.'
                        : 'We will not disturb you. Your reels leave the feed and nobody can call you now — but fans can still book a time from your calendar.',
                    textAlign: TextAlign.center,
                    style: t(16, color: on ? C.deep : C.cream, w: FontWeight.w700, h: 1.45),
                  ),
                  const SizedBox(height: 26),
                  GestureDetector(
                    onTap: () => togglePresence(context),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 300),
                      height: 84,
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: on ? C.rani : C.muted,
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(color: C.lemon, width: 3),
                      ),
                      child: Row(
                        mainAxisAlignment: on ? MainAxisAlignment.end : MainAxisAlignment.start,
                        children: [
                          if (on) Expanded(child: Center(child: Text('TAP TO GO OFFLINE', style: t(16, color: C.paper, ls: 0.06)))),
                          Container(
                            width: 64,
                            height: 64,
                            decoration: const BoxDecoration(shape: BoxShape.circle, color: C.paper),
                            child: Icon(on ? Icons.wifi_tethering_rounded : Icons.nightlight_round, color: on ? C.rani : C.deep, size: 32),
                          ),
                          if (!on) Expanded(child: Center(child: Text('TAP TO GO ONLINE', style: t(16, color: C.paper, ls: 0.06)))),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(color: on ? C.butter : C.maroon, borderRadius: BorderRadius.circular(14)),
                    child: Row(
                      children: [
                        Icon(Icons.event_available_rounded, color: on ? C.maroon : C.lemon),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            '${demo.inBookings.length} bookings coming up. They ring you at the booked time, online or offline.',
                            style: t(14, color: on ? C.deep : C.gold, h: 1.35),
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) {
            final list = demo.bookingsOn(_day);
            final upcoming = [...demo.inBookings]..sort((a, b) => a.day.compareTo(b.day));
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Expanded(child: Headline(solid: 'MY', outline: 'BOOKINGS', size: 38)),
                    SizedBox(width: 110, height: 70, child: Art('influencer/calendar-header.webp', fit: BoxFit.contain)),
                  ],
                ),
                const SizedBox(height: 14),
                MonthGrid(
                  month: _month,
                  selected: _day,
                  allowPast: true,
                  dots: {for (final b in demo.inBookings) dayKey(b.day)},
                  onPick: (d) => setState(() => _day = d),
                  onMonth: (m) => setState(() => _month = m),
                ),
                const SizedBox(height: 18),
                Text(dayLabel(_day), style: t(20, color: C.maroon)),
                if (list.isEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text('No bookings on this day.', style: t(15, color: C.muted, w: FontWeight.w700))),
                for (final b in list) BookingTile(b),
                const SizedBox(height: 22),
                Text('All upcoming', style: t(18, color: C.maroon)),
                for (final b in upcoming) BookingTile(b, showDay: true),
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) {
            final open = demo.slotsOn(_day);
            final perMin = demo.myRate * 0.6 - 2;
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
              children: [
                const Headline(solid: 'WHEN CAN', outline: 'FANS BOOK?', size: 36),
                const SizedBox(height: 6),
                Text('Tap a date, then tap the times you are free. Yellow dates are open.', style: t(14, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 14),
                MonthGrid(
                  month: _month,
                  selected: _day,
                  fill: demo.availability.keys.toSet(),
                  onPick: (d) => setState(() => _day = d),
                  onMonth: (m) => setState(() => _month = m),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(child: Text(dayLabel(_day), style: t(20, color: C.maroon))),
                    Text(open.isEmpty ? 'Closed' : 'Open', style: t(14, color: open.isEmpty ? C.muted : C.maroon)),
                    const SizedBox(width: 6),
                    Switch(
                      value: open.isNotEmpty,
                      onChanged: (v) => demo.setDayOpen(_day, v),
                      activeThumbColor: C.lemon,
                      activeTrackColor: C.maroon,
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final s in allSlots)
                      FilterChip(
                        label: Text(s, style: t(14, color: open.contains(s) ? C.gold : C.maroon)),
                        selected: open.contains(s),
                        showCheckmark: false,
                        selectedColor: C.maroon,
                        backgroundColor: C.paper,
                        shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
                        onSelected: (_) => demo.toggleSlot(_day, s),
                      ),
                  ],
                ),
                const SizedBox(height: 26),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(18)),
                  child: Column(
                    children: [
                      Text('YOUR RATE', style: t(13, color: C.gold, ls: 0.14)),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          _round(Icons.remove_rounded, 'Lower rate', () => demo.setRate(demo.myRate - 1)),
                          Expanded(child: Center(child: Text('₹${demo.myRate}/min', style: t(32, color: C.paper)))),
                          _round(Icons.add_rounded, 'Raise rate', () => demo.setRate(demo.myRate + 1)),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text('You get about ${inr(perMin < 0 ? 0 : perMin)} a minute', style: t(14, color: C.cream, w: FontWeight.w700)),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Text('Going online for instant calls is the round button in the middle of your bar.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _round(IconData icon, String label, VoidCallback onTap) => BrassKnob(label: label, size: 52, onTap: onTap, child: Icon(icon, color: C.deep, size: 26));
}
