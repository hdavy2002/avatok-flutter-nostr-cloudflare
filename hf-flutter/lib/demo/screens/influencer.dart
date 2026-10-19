import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data.dart';
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
      context.pushReplacement('/influencer');
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

// ---------------------------------------------------------------------------------------------- Dashboard

/// Influencer dashboard: the big Online/Offline switch (HF-REEL-13), today, earnings, bookings, reels.
class InfluencerDashboardScreen extends StatelessWidget {
  const InfluencerDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) => ListView(
            padding: const EdgeInsets.fromLTRB(0, 0, 0, 24),
            children: [
              const PageHeader(title: 'Influencer'),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    GestureDetector(
                      onTap: () => demo.setOnline(!demo.online),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 250),
                        padding: const EdgeInsets.all(20),
                        decoration: BoxDecoration(
                          color: demo.online ? C.maroon : C.sand,
                          borderRadius: BorderRadius.circular(22),
                          boxShadow: const [BoxShadow(color: C.deep, offset: Offset(6, 6))],
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(demo.online ? 'YOU ARE ONLINE' : 'YOU ARE OFFLINE', style: t(22, color: demo.online ? C.gold : C.deep, ls: 0.04)),
                                  const SizedBox(height: 4),
                                  Text(
                                    demo.online ? 'Your reels are in the feed with Call now.' : 'Hidden from the feed. Fans can still book you.',
                                    style: t(14, color: demo.online ? C.ivory : C.muted, w: FontWeight.w700, h: 1.35),
                                  ),
                                ],
                              ),
                            ),
                            Transform.scale(
                              scale: 1.3,
                              child: Switch(
                                value: demo.online,
                                onChanged: demo.setOnline,
                                activeThumbColor: C.marigold,
                                activeTrackColor: C.deep,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    Row(
                      children: [
                        _stat('Calls today', '6'),
                        const SizedBox(width: 10),
                        _stat('Minutes', '41'),
                        const SizedBox(width: 10),
                        _stat('Earned today', inr(41 * demo.myRate * 0.6 - 41 * 2, paise: false)),
                      ],
                    ),
                    const SizedBox(height: 20),
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
                    const SizedBox(height: 10),
                    Text('You keep 60% of each call minus ₹2 a minute.', style: t(13, color: C.muted, w: FontWeight.w700)),
                    const SizedBox(height: 22),
                    Text('Upcoming bookings', style: t(20, color: C.maroon)),
                    const SizedBox(height: 8),
                    for (final b in influencerUpcoming)
                      Container(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sandLine, width: 2))),
                        child: Row(
                          children: [
                            const Icon(Icons.event_rounded, color: C.maroon),
                            const SizedBox(width: 12),
                            Expanded(child: Text(b.$1, style: t(16))),
                            Text(b.$2, style: t(13, color: C.tan)),
                          ],
                        ),
                      ),
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
                            gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [influencers[i % influencers.length].tones.first, C.cinema]),
                          ),
                          alignment: Alignment.topRight,
                          padding: const EdgeInsets.all(6),
                          child: Icon(i == 4 ? Icons.block_rounded : Icons.check_circle_rounded, color: i == 4 ? C.cream : C.marigold, size: 20),
                        ),
                      ),
                    ),
                    const SizedBox(height: 22),
                    _link(context, Icons.currency_rupee_rounded, 'Rate and availability', '₹${demo.myRate}/min', '/influencer/rate'),
                    _link(context, Icons.person_rounded, 'Back to fan view', '', '/me'),
                  ],
                ),
              ),
            ],
          ),
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

  Widget _link(BuildContext context, IconData icon, String label, String meta, String route) => InkWell(
        onTap: () => route == '/me' ? context.go(route) : context.push(route),
        child: Container(
          height: 60,
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sandLine, width: 2))),
          child: Row(
            children: [
              BrassKnob(label: label, size: 40, child: Icon(icon, color: C.deep, size: 20)),
              const SizedBox(width: 12),
              Expanded(child: Text(label, style: t(17))),
              if (meta.isNotEmpty) Text(meta, style: t(14, color: C.tan)),
              const Icon(Icons.chevron_right_rounded, color: C.maroon),
            ],
          ),
        ),
      );
}

// ---------------------------------------------------------------------------------------------- Rate

class RateScreen extends StatelessWidget {
  const RateScreen({super.key});

  static const _dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  static const _times = ['8:00 am', '10:00 am', '12:00 pm', '4:00 pm', '6:00 pm', '9:00 pm', '11:00 pm'];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) {
            final perMin = demo.myRate * 0.6 - 2;
            return ListView(
              padding: const EdgeInsets.fromLTRB(0, 0, 0, 24),
              children: [
                const PageHeader(title: 'Rate and availability'),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Your rate', style: t(18, color: C.maroon)),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          _round(Icons.remove_rounded, () => demo.setRate(demo.myRate - 1)),
                          Expanded(child: Center(child: Text('₹${demo.myRate}/min', style: t(36, color: C.maroon)))),
                          _round(Icons.add_rounded, () => demo.setRate(demo.myRate + 1)),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Center(child: Text('You get about ${inr(perMin < 0 ? 0 : perMin)} a minute', style: t(14, color: C.muted, w: FontWeight.w700))),
                      const SizedBox(height: 26),
                      Text('Days I take bookings', style: t(18, color: C.maroon)),
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (var d = 0; d < 7; d++)
                            FilterChip(
                              label: Text(_dayNames[d], style: t(15, color: demo.availableDays.contains(d) ? C.gold : C.maroon)),
                              selected: demo.availableDays.contains(d),
                              showCheckmark: false,
                              selectedColor: C.maroon,
                              backgroundColor: C.paper,
                              shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
                              onSelected: (_) => demo.toggleDay(d),
                            ),
                        ],
                      ),
                      const SizedBox(height: 22),
                      Text('Hours', style: t(18, color: C.maroon)),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(child: _timePick(context, 'From', demo.fromTime, (v) => demo.setHours(v, demo.toTime))),
                          const SizedBox(width: 12),
                          Expanded(child: _timePick(context, 'To', demo.toTime, (v) => demo.setHours(demo.fromTime, v))),
                        ],
                      ),
                      const SizedBox(height: 22),
                      Text('Going online for instant calls is separate: use the big switch on your dashboard.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
                      const SizedBox(height: 22),
                      SizedBox(
                        width: double.infinity,
                        child: ChunkyButton(
                          label: 'SAVE',
                          dark: true,
                          onTap: () {
                            toast(context, 'Saved (demo)');
                            context.pop();
                          },
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _round(IconData icon, VoidCallback onTap) => BrassKnob(label: icon == Icons.add_rounded ? 'Raise rate' : 'Lower rate', size: 56, onTap: onTap, child: Icon(icon, color: C.deep, size: 28));

  Widget _timePick(BuildContext context, String label, String value, ValueChanged<String> on) {
    return InputDecorator(
      decoration: InputDecoration(labelText: label, labelStyle: t(14, color: C.tan)),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: value,
          isDense: true,
          isExpanded: true,
          style: t(16),
          items: [for (final x in _times) DropdownMenuItem(value: x, child: Text(x))],
          onChanged: (v) {
            if (v != null) on(v);
          },
        ),
      ),
    );
  }
}
