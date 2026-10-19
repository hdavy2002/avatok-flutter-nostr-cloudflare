import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/demo_mode.dart';
import '../../data/services.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import 'call_real.dart';
import 'call_records_real.dart';
import 'settings_real.dart';
import '../../ui/strings/help_strings.dart';

/// Me — the customer dashboard: wallet ticket + menu (call records, wallet, payout, bookings…).
class MeScreen extends StatelessWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListenableBuilder(
        listenable: demo,
        builder: (context, _) => demo.signedIn ? const _Dashboard() : const _Guest(),
      ),
    );
  }
}

class _Guest extends StatelessWidget {
  const _Guest();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Valance(),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const ArtMoment('me/welcome-rangili.webp', label: 'RANGILI\nwaving hello', size: 200, ring: C.butter),
                const SizedBox(height: 10),
                const Headline(solid: 'YOUR', outline: 'BAZAAR PASS', size: 40, align: TextAlign.center),
                const SizedBox(height: 14),
                Text('Make a free account to call, book and save favourites. It takes 20 seconds.', textAlign: TextAlign.center, style: t(17, w: FontWeight.w700, h: 1.45)),
                const SizedBox(height: 26),
                TicketButton(label: 'GET STARTED', maroon: true, stubIcon: Icons.arrow_forward_rounded, onTap: () => requireAccount(context, () {})),
                const SizedBox(height: 16),
                TextButton(onPressed: () => context.push('/help'), child: Text('How ${Brand.name} works', style: t(16, color: C.maroon))),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Dashboard extends StatelessWidget {
  const _Dashboard();

  @override
  Widget build(BuildContext context) {
    final items = <(IconData, String, String, String)>[
      (Icons.call_rounded, 'Call records', '${demo.calls.length} calls', '/calls'),
      (Icons.currency_rupee_rounded, 'Wallet', inr(demo.balance, paise: false), '/wallet'),
      if (Services.instance.viewerIsInfluencer) (Icons.north_east_rounded, 'Payout', '', '/payout'),
      (Icons.event_rounded, 'My bookings', '${demo.bookings.length}', '/bookings'),
      (Icons.favorite_rounded, 'Favourites', '${demo.favs.length}', 'tab:/favourites'),
      (Icons.settings_rounded, 'Settings', '', '/settings'),
      (Icons.help_rounded, 'Help', '', '/help'),
    ];
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        const Valance(height: 66),
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 8, 22, 0),
          child: Row(
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(shape: BoxShape.circle, color: C.marigold, border: Border.all(color: C.deep, width: 3)),
                alignment: Alignment.center,
                child: Text(demo.name.isEmpty ? '?' : demo.name[0].toUpperCase(), style: t(28, color: C.deep)),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('NAMASTE', style: t(13, color: C.ruby, ls: 0.14)),
                    Text(demo.name, style: t(30, color: C.maroon, h: 1.05)),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 22),
          child: GestureDetector(onTap: () => context.push('/wallet'), child: const WalletTicket()),
        ),
        const SizedBox(height: 18),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 22),
          child: Column(
            children: [
              for (final it in items)
                _MenuRow(
                  icon: it.$1,
                  label: it.$2,
                  meta: it.$3,
                  onTap: () => it.$4.startsWith('tab:') ? context.go(it.$4.substring(4)) : context.push(it.$4),
                ),
              _MenuRow(
                icon: Icons.star_rounded,
                label: demo.influencerJoined ? 'Influencer dashboard' : 'Join as an influencer',
                meta: demo.influencerJoined ? (demo.online ? 'Online' : 'Offline') : 'Free',
                onTap: () => demo.influencerJoined ? context.go('/inf/home') : context.push('/influencer/join'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 30),
      ],
    );
  }
}

/// The big pink tag with the balance and a Top up end.
class WalletTicket extends StatelessWidget {
  const WalletTicket({super.key});

  @override
  Widget build(BuildContext context) {
    final minutes = (demo.balance / 15).floor();
    return Container(
      height: 112,
      decoration: const BoxDecoration(boxShadow: [BoxShadow(color: C.deep, offset: Offset(6, 6))], borderRadius: BorderRadius.all(Radius.circular(18))),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: Row(
          children: [
            Expanded(
              child: Container(
                color: C.maroon,
                padding: const EdgeInsets.symmetric(horizontal: 18),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('WALLET BALANCE', style: t(12, color: C.gold, ls: 0.16)),
                    FittedBox(child: Text(inr(demo.balance), style: t(36, color: C.ivory, h: 1.1))),
                    Text('≈ $minutes minutes at ₹15/min', style: t(13, color: C.cream, w: FontWeight.w700)),
                  ],
                ),
              ),
            ),
            Container(color: C.maroon, width: 3, child: const DashedLine(color: C.gold)),
            Semantics(
              button: true,
              label: 'Top up',
              child: GestureDetector(
                onTap: () => context.push('/topup'),
                child: Container(
                  width: 92,
                  color: C.marigold,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.add_rounded, color: C.deep, size: 30),
                      Text('TOP UP', style: t(13, color: C.deep, ls: 0.08)),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, required this.meta, required this.onTap});

  final IconData icon;
  final String label;
  final String meta;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        height: 62,
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sandLine, width: 2))),
        child: Row(
          children: [
            BrassKnob(label: label, size: 42, child: Icon(icon, color: C.deep, size: 20)),
            const SizedBox(width: 14),
            Expanded(child: Text(label, style: t(18))),
            if (meta.isNotEmpty) Text(meta, style: t(14, color: C.tan)),
            const SizedBox(width: 6),
            const Icon(Icons.chevron_right_rounded, color: C.maroon),
          ],
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
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Call records'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                children: [
                  for (final c in demo.calls)
                    Container(
                      margin: const EdgeInsets.only(bottom: 10),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.sand, width: 2)),
                      child: Row(
                        children: [
                          Avatar(c.who, size: 50, ring: false),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(c.who.name, style: t(16)),
                                Text('${c.when} · ${c.minutes} min', style: t(13, color: C.muted, w: FontWeight.w700)),
                                if (c.stars > 0) Text('★' * c.stars, style: t(14, color: C.marigold)),
                              ],
                            ),
                          ),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(inr(-c.cost, paise: false), style: t(16, color: C.ruby)),
                              const SizedBox(height: 4),
                              GestureDetector(
                                onTap: () => context.push('/profile/${c.who.id}'),
                                child: Text('Call again', style: t(13, color: C.maroon)),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
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
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) => Column(
            children: [
              const PageHeader(title: 'My bookings'),
              Expanded(
                child: demo.bookings.isEmpty
                    ? Center(child: Text('No bookings yet.', style: t(17, color: C.muted)))
                    : ListView(
                        padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                        children: [
                          for (final b in demo.bookings)
                            Container(
                              margin: const EdgeInsets.only(bottom: 12),
                              decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.deep, width: 3)),
                              child: IntrinsicHeight(
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.stretch,
                                  children: [
                                    Expanded(
                                      child: Padding(
                                        padding: const EdgeInsets.all(14),
                                        child: Row(
                                          children: [
                                            Avatar(b.who, size: 50, ring: false),
                                            const SizedBox(width: 12),
                                            Expanded(
                                              child: Column(
                                                crossAxisAlignment: CrossAxisAlignment.start,
                                                children: [
                                                  Text(b.who.name, style: t(17)),
                                                  Text('${b.day} · ${b.time}', style: t(15, color: C.maroon)),
                                                  Text('${inr(b.hold, paise: false)} held · 10 min', style: t(13, color: C.muted, w: FontWeight.w700)),
                                                ],
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 3, child: DashedLine()),
                                    SizedBox(
                                      width: 90,
                                      child: TextButton(
                                        onPressed: () async {
                                          final ok = await showDialog<bool>(
                                            context: context,
                                            builder: (d) => AlertDialog(
                                              title: Text('Cancel this booking?', style: t(20, color: C.maroon)),
                                              content: Text('The ${inr(b.hold, paise: false)} hold comes back to your wallet.', style: t(15, w: FontWeight.w700)),
                                              actions: [
                                                TextButton(onPressed: () => Navigator.of(d).pop(false), child: Text('Keep it', style: t(16, color: C.maroon))),
                                                TextButton(onPressed: () => Navigator.of(d).pop(true), child: Text('Cancel', style: t(16, color: C.ruby))),
                                              ],
                                            ),
                                          );
                                          if (ok == true) demo.cancelBooking(b);
                                        },
                                        child: Text('Cancel', style: t(14, color: C.ruby)),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
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
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Settings'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                children: [
                  Text('Account', style: t(18, color: C.maroon)),
                  const SizedBox(height: 8),
                  _info('Name', demo.name),
                  _info('Email', demo.email),
                  _info('WhatsApp', demo.whatsappDisplay),
                  // [HF-WIRE-3] Channels: for an influencer, or someone who has started joining.
                  if (demo.influencerJoined || Services.instance.me?.hostStatus != null) _link(context, 'Channels', '/inf/channels'),
                  const SizedBox(height: 18),
                  Text('WhatsApp messages', style: t(18, color: C.maroon)),
                  _switch('Call alerts', _callAlerts, (v) => setState(() => _callAlerts = v)),
                  _switch('Booking reminders', _bookingReminders, (v) => setState(() => _bookingReminders = v)),
                  _switch('New reels from favourites', _newReels, (v) => setState(() => _newReels = v)),
                  const SizedBox(height: 18),
                  Text('About', style: t(18, color: C.maroon)),
                  const SizedBox(height: 8),
                  _link(context, 'Help and FAQ', '/help'),
                  _plain('Terms and privacy (opens the website)'),
                  _plain('App version: demo build'),
                  const SizedBox(height: 26),
                  ChunkyButton(
                    label: 'SIGN OUT',
                    filled: false,
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
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _info(String a, String b) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [Expanded(child: Text(a, style: t(15, color: C.muted))), Text(b, style: t(16))]),
      );

  Widget _switch(String label, bool v, ValueChanged<bool> on) => SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(label, style: t(16)),
        value: v,
        activeThumbColor: C.marigold,
        activeTrackColor: C.maroon,
        onChanged: on,
      );

  Widget _link(BuildContext context, String label, String route) => ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(label, style: t(16)),
        trailing: const Icon(Icons.chevron_right_rounded, color: C.maroon),
        onTap: () => context.push(route),
      );

  Widget _plain(String label) => ListTile(contentPadding: EdgeInsets.zero, title: Text(label, style: t(16, color: C.muted, w: FontWeight.w700)));
}

// ---------------------------------------------------------------------------------------------- Help

class HelpScreen extends StatelessWidget {
  const HelpScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: HelpStrings.title),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: [
                  for (final f in HelpStrings.faq)
                    Card(
                      color: C.paper,
                      elevation: 0,
                      margin: const EdgeInsets.only(bottom: 10),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: C.sand, width: 2)),
                      child: ExpansionTile(
                        shape: const Border(),
                        title: Text(f.$1, style: t(16)),
                        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                        children: [Text(f.$2, style: t(15, w: FontWeight.w600, h: 1.45))],
                      ),
                    ),
                  const SizedBox(height: 10),
                  InkWell(
                    key: const Key('help-email'),
                    onTap: () => openSupportMail(context),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text.rich(
                        TextSpan(style: t(15, color: C.muted, w: FontWeight.w700), children: [
                          const TextSpan(text: '${HelpStrings.stillStuck} '),
                          TextSpan(text: HelpStrings.supportEmail, style: t(15, color: C.maroon, w: FontWeight.w800)),
                        ]),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
