import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/demo_mode.dart';
import '../../data/models/me.dart';
import '../../data/repos/settings_repo.dart';
import '../../data/services.dart';
import '../../data/share.dart'; // [HF-SHARE-APP-1]
import '../share_page_kit.dart'; // [HF-SHARE-APP-1]
import '../../ui/strings/help_strings.dart';
import '../theme.dart';
import '../widgets.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../settings_kit.dart';
import '../person_avatar.dart'; // [HF-ME-SETTINGS-MOVE]

/// Real Settings and Delete account (HF-WIRE-11). While [DemoMode.on] the dummy screens in me.dart stay.
abstract final class SettingsBridge {
  /// Tests set this to exercise the real path without a dart-define.
  static bool forceReal = false;

  static bool get real => forceReal || !DemoMode.on;
}

Future<void> _defaultSignOut() => Services.instance.signOut();

/// [HF-APP-PARITY-PROFILE] Whole rupees, rounded down: payouts are made in whole rupees and anything below ₹1 is not paid out.
String _rupees(double v) => '₹${(v + 1e-9).floor()}';

/// [HF-APP-PARITY-PROFILE] Indian date and time, e.g. "24 Oct, 6:30 pm" (always shown in India time).
String inDayTime(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true).add(const Duration(hours: 5, minutes: 30));
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  final m = d.minute.toString().padLeft(2, '0');
  return '${d.day} ${_months[d.month - 1]}, $h:$m ${d.hour >= 12 ? 'pm' : 'am'}';
}

/// The plain line shown wherever money is settled (same meaning as the website's close-account page).
const kBelowRupeeNote = 'Anything below ₹1 is not paid out.';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
String _day(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${d.day} ${_months[d.month - 1]} ${d.year}';
}

// ---------------------------------------------------------------------------------------------- Settings

class RealSettingsScreen extends StatefulWidget {
  const RealSettingsScreen({super.key, this.repo, this.me, this.signOut});

  final SettingsRepo? repo;

  /// The signed-in account; defaults to `Services.instance.me`.
  final Me? me;
  final Future<void> Function()? signOut;

  @override
  State<RealSettingsScreen> createState() => _RealSettingsScreenState();
}

class _RealSettingsScreenState extends State<RealSettingsScreen> {
  NotifyPrefs _prefs = const NotifyPrefs();
  bool _prefsLoaded = false;
  bool _prefsFailed = false;
  String? _name;
  AppVersion _version = const AppVersion('', '');

  SettingsRepo get _repo => widget.repo ?? SettingsRepo(Services.instance.api);
  Me? get _me => widget.me ?? Services.instance.me;

  @override
  void initState() {
    super.initState();
    _name = _me?.name;
    unawaited(MyProfilePhoto.refresh()); // [HF-ME-SETTINGS-MOVE] the strip shows the approved profile photo
    unawaited(_loadPrefs());
    unawaited(AppVersionInfo.load().then((v) {
      if (mounted) setState(() => _version = v);
    }));
  }

  Future<void> _loadPrefs() async {
    setState(() => _prefsFailed = false);
    try {
      final p = await _repo.prefs();
      if (mounted) {
        setState(() {
          _prefs = p;
          _prefsLoaded = true;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _prefsFailed = true);
    }
  }

  NotifyPrefs _with(NotifyPrefs p, String key, bool v) => switch (key) {
        'notifyWhatsapp' => p.copyWith(notifyWhatsapp: v),
        'apptReminders' => p.copyWith(apptReminders: v),
        _ => p.copyWith(reelAlerts: v),
      };

  /// Optimistic: flips at once, saves, and puts the switch back with a message if the save fails.
  Future<void> _flip(String key, bool v) async {
    setState(() => _prefs = _with(_prefs, key, v));
    try {
      final saved = await _repo.savePrefs(
        notifyWhatsapp: key == 'notifyWhatsapp' ? v : null,
        apptReminders: key == 'apptReminders' ? v : null,
        reelAlerts: key == 'reelAlerts' ? v : null,
      );
      if (!mounted) return;
      final now = switch (key) {
        'notifyWhatsapp' => saved.notifyWhatsapp,
        'apptReminders' => saved.apptReminders,
        _ => saved.reelAlerts,
      };
      setState(() => _prefs = _with(_prefs, key, now));
    } catch (e) {
      if (!mounted) return;
      setState(() => _prefs = _with(_prefs, key, !v));
      toast(context, e is ApiException ? e.userMessage : 'We could not save that. Please try again.');
    }
  }

  /// [HF-APP-PARITY-PROFILE] Opens Edit profile (first and last name, the name influencers see, the permanent handle).
  Future<void> _editProfile() async {
    await context.push('/settings/profile');
    if (!mounted) return;
    setState(() => _name = _me?.name ?? _name);
  }

  Future<void> _signOut() async {
    final go = GoRouter.of(context);
    await (widget.signOut ?? _defaultSignOut)();
    MyProfilePhoto.clear(); // [HF-ME-SETTINGS-MOVE]
    go.go('/reels');
  }

  @override
  Widget build(BuildContext context) {
    final me = _me;
    final email = me?.email;
    final whatsapp = me?.phoneMasked;
    final host = me?.isHost == true;
    final slug = (me?.hostSlug ?? '').isEmpty ? null : me!.hostSlug; // [HF-SHARE-APP-1]
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
                  ValueListenableBuilder<String?>(
                    valueListenable: MyProfilePhoto.url,
                    builder: (_, photo, __) => SettingsMeStrip(
                      key: const Key('settings-name'),
                      name: _name ?? '',
                      onTap: _editProfile,
                      hint: 'Edit your profile',
                      avatarUrl: me?.avatarUrl ?? photo,
                    ),
                  ),
                  const SizedBox(height: 12),
                  SettingsCard(title: 'Account', tone: DesiTone.rani, children: [
                    SettingsRow(icon: Icons.mail_rounded, tone: DesiTone.rani, label: 'Email', sub: (email ?? '').isEmpty ? 'Not added' : email!, last: true),
                    SettingsNote(lead: HelpStrings.changeEmailNote, email: HelpStrings.supportEmail, onTap: () => context.push('/support')),
                    SettingsRow(icon: Icons.chat_rounded, tone: DesiTone.rani, label: 'WhatsApp', sub: (whatsapp ?? '').isEmpty ? 'Not added' : whatsapp!, last: true),
                    SettingsNote(lead: HelpStrings.changeWhatsappNote, email: HelpStrings.supportEmail, onTap: () => context.push('/support')),
                    // [HF-ME-SETTINGS-MOVE] Social media verification, My verifications, Availability calendar, Calls booked with me
                    // and the Call queue moved to the Me page ("Influencer tools").
                    // [HF-SHARE-APP-1] the influencer's public page: share it or copy the link
                    if (host && slug != null) ...[
                      SettingsRow(icon: Icons.share_rounded, tone: DesiTone.rani, label: 'Share my page', sub: influencerPageUrl(slug, tracked: false), onTap: () => unawaited(ShareSheet.influencer(slug, me?.name ?? slug, own: true))),
                      SettingsRow(icon: Icons.copy_rounded, tone: DesiTone.rani, label: 'Copy my page link', last: true, onTap: () => unawaited(copyMyPageLink(context, slug))),
                    ],
                  ]),
                  const SizedBox(height: 12),
                  // [HF-BLOCK-PROFILE-1] who you blocked, with Unblock
                  SettingsCard(title: 'Safety', tone: DesiTone.rani, children: [
                    SettingsRow(icon: Icons.block_rounded, tone: DesiTone.rani, label: 'Blocked people', last: true, onTap: () => context.push('/settings/blocked')),
                  ]),
                  const SizedBox(height: 12),
                  SettingsCard(title: 'WhatsApp messages', tone: DesiTone.tea, flower: true, children: [
                    if (_prefsFailed)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Row(children: [
                          Expanded(child: Text('We could not load your choices.', style: t(15, color: C.muted, w: FontWeight.w700))),
                          TextButton(onPressed: _loadPrefs, child: Text('Try again', style: t(15, color: C.maroon, w: FontWeight.w800))),
                        ]),
                      )
                    else ...[
                      _switch('Call alerts', 'notifyWhatsapp', _prefs.notifyWhatsapp, Icons.notifications_active_rounded),
                      _switch('Booking reminders', 'apptReminders', _prefs.apptReminders, Icons.alarm_rounded),
                      _switch('New reels from favourites', 'reelAlerts', _prefs.reelAlerts, Icons.movie_rounded, last: true),
                    ],
                  ]),
                  const SizedBox(height: 12),
                  SettingsCard(title: 'About', tone: DesiTone.lav, children: [
                    SettingsRow(icon: Icons.help_rounded, tone: DesiTone.lav, label: 'Help and FAQ', onTap: () => context.push('/help')),
                    SettingsRow(icon: Icons.description_rounded, tone: DesiTone.lav, label: 'Terms of use', onTap: () => context.push('/page/terms')), // [HF-SUPPORT-APP] read inside the app
                    SettingsRow(icon: Icons.lock_rounded, tone: DesiTone.lav, label: 'Privacy policy', onTap: () => context.push('/page/privacy')),
                    SettingsRow(icon: Icons.undo_rounded, tone: DesiTone.lav, label: 'Refunds and cancellations', onTap: () => context.push('/page/refunds')),
                    SettingsRow(icon: Icons.support_agent_rounded, tone: DesiTone.lav, label: 'Contact Support', onTap: () => context.push('/support')),
                    SettingsRow(icon: Icons.info_rounded, tone: DesiTone.lav, label: 'App version', value: _version.version.isEmpty ? '' : _version.label, last: true),
                  ]),
                  const SizedBox(height: 16),
                  OutlinePill(label: 'SIGN OUT', onTap: _signOut),
                  const SizedBox(height: 8),
                  Center(
                    child: TextButton(
                      key: const Key('settings-delete'),
                      style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => DeleteAccountScreen(repo: widget.repo, signOut: widget.signOut),
                      )),
                      child: Text('Delete my account', style: t(15, color: C.ruby, w: FontWeight.w800)),
                    ),
                  ),
                  const SizedBox(height: 8),
                  const DesiMogra(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _switch(String label, String key, bool v, IconData icon, {bool last = false}) => SettingsSwitch(
        switchKey: Key('pref-$key'),
        icon: icon,
        label: label,
        value: v,
        last: last,
        onChanged: _prefsLoaded ? (x) => _flip(key, x) : null,
      );
}

// ---------------------------------------------------------------------------------------------- Delete account

class DeleteAccountScreen extends StatefulWidget {
  const DeleteAccountScreen({super.key, this.repo, this.signOut});

  final SettingsRepo? repo;
  final Future<void> Function()? signOut;

  @override
  State<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends State<DeleteAccountScreen> {
  CloseState? _state;
  Object? _error;
  bool _busy = false;
  bool _giveUp = false;
  double _smallLeft = 0; // [HF-WIRE-16] wallet money below the smallest withdrawal, set by the server's forfeit_required answer

  SettingsRepo get _repo => widget.repo ?? SettingsRepo(Services.instance.api);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final s = await _repo.closeState();
      if (mounted) setState(() => _state = s);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<bool> _confirm(String title, String body, String yes) async {
    return hfConfirm(context, title: title, body: body, confirmLabel: yes, cancelLabel: 'Keep my account', destructive: true);
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() => _busy = true);
    try {
      await job();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'withdraw_first') {
        // [HF-WIRE-16] Wallet money is never refunded to the card: take it out through Withdraw first.
        await _load();
        if (mounted) {
          toast(context, e.userMessage);
          unawaited(context.push('/payout'));
        }
      } else if (e.code == 'forfeit_required') {
        // The server says some money cannot be paid out; show it and ask for a clear yes before going on.
        final r = e.extra['forfeitRupees'];
        if (r is num && mounted) setState(() => _smallLeft = r.toDouble());
        await _load();
        if (mounted) toast(context, e.userMessage);
      } else {
        toast(context, e.userMessage);
        unawaited(_load());
      }
    } catch (_) {
      if (mounted) toast(context, 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _signOutAndLeave() async {
    final go = GoRouter.of(context);
    await (widget.signOut ?? _defaultSignOut)();
    go.go('/reels');
  }

  Future<void> _deleteNow() async {
    final ok = await _confirm(
      'Delete your account?',
      'Your account is closed now and erased after 30 days. Log back in within 30 days to change your mind. After that, your profile, calls and wallet history are gone for good.',
      'Yes, delete',
    );
    if (!ok) return;
    var done = false;
    await _run(() async {
      await _repo.deleteNow();
      done = true;
    });
    if (done && mounted) await _signOutAndLeave();
  }

  Future<void> _startClosure(CloseState s) async {
    final ok = await _confirm(
      'Close your account?',
      'We will first pay out your earnings. Wallet money is never sent back to your card: withdraw it to your UPI with Withdraw first (one-time ID and UPI check). If what is left is under ₹1 (too small to pay out), you can choose to give it up. Once that is settled your account is deleted after a 30-day grace period. You can stop this until a payment is approved.',
      'Yes, start',
    );
    if (!ok) return;
    await _run(() async {
      await _repo.startClosure(forfeit: _giveUp);
      await _load();
    });
  }

  Future<void> _cancelClosure() async {
    await _run(() async {
      await _repo.cancelClosure();
      await _load();
    });
  }

  Future<void> _keepAccount() async {
    await _run(() async {
      await _repo.cancelDeletion();
      await _load();
    });
    if (mounted) toast(context, 'Your account stays open.');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Delete account'),
            Expanded(child: _body()),
          ],
        ),
      ),
    );
  }

  Widget _body() {
    final s = _state;
    if (s == null) {
      if (_error != null) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(_error is ApiException ? (_error as ApiException).userMessage : 'We could not check your account.', textAlign: TextAlign.center, style: t(16, color: C.muted)),
              const SizedBox(height: 14),
              ChunkyButton(label: 'TRY AGAIN', onTap: _load),
            ]),
          ),
        );
      }
      return const Center(child: CircularProgressIndicator(color: C.maroon));
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
      children: [
        if (s.deletionScheduled) ..._scheduled(s) else if (s.closureActive) ..._closing(s) else ..._fresh(s),
      ],
    );
  }

  List<Widget> _scheduled(CloseState s) => [
        Text('Your account is being deleted', style: t(20, color: C.maroon)),
        const SizedBox(height: 10),
        _para('It will be erased on ${_day(s.deletionScheduledAt!)}. Until then you can change your mind.'),
        const SizedBox(height: 20),
        ChunkyButton(label: 'KEEP MY ACCOUNT', onTap: _busy ? null : _keepAccount),
        const SizedBox(height: 12),
        ChunkyButton(label: 'SIGN OUT', filled: false, onTap: _busy ? null : _signOutAndLeave),
      ];

  List<Widget> _closing(CloseState s) {
    final text = switch (s.exitStatus) {
      'booking_cleanup' => 'We are settling your scheduled calls.',
      'waiting_hold' => s.heldReleaseAt == null
          ? 'Your latest earnings are still in their 7-day hold. We pay them out as soon as the hold ends.'
          : 'Your latest earnings are still in their 7-day hold. They are released on ${inDayTime(s.heldReleaseAt!)} and paid out then.',
      'waiting_payouts' => 'Your money is on its way. Once every payment is done, your account is deleted after a 30-day grace period.',
      _ => 'Almost done. Your account will be deleted after a 30-day grace period.',
    };
    return [
      Text('Closing your account', style: t(20, color: C.maroon)),
      const SizedBox(height: 10),
      _para(text),
      if (s.payout != null) _line('Earnings withdrawal', s.payout!),
      if (s.refund != null) _line('Refund (credited to your wallet)', s.refund!),
      const SizedBox(height: 10),
      _para(kBelowRupeeNote, muted: true),
      const SizedBox(height: 10),
      ChunkyButton(label: 'STOP CLOSING MY ACCOUNT', filled: false, onTap: _busy ? null : _cancelClosure),
      const SizedBox(height: 8),
      _para('You can stop only until a payment has been approved.', muted: true),
    ];
  }

  Widget _line(String what, ExitLine l) {
    final status = switch (l.status) {
      'paid' || 'refunded' => 'Done',
      'rejected' => 'Not paid${l.reason == null ? '' : ': ${l.reason}'}',
      'cancelled' => 'Cancelled',
      'requested' => 'Waiting for approval',
      _ => 'On its way',
    };
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(child: Text(what, style: t(15, color: C.muted))),
          Text('${_rupees(l.amount)} · $status', style: t(15)),
        ]),
        if (l.utr != null) Align(alignment: Alignment.centerRight, child: Text('UTR ${l.utr}', key: const Key('exit-utr'), style: t(14, color: C.muted, w: FontWeight.w700))),
      ]),
    );
  }

  List<Widget> _fresh(CloseState s) {
    final out = <Widget>[
      Text('Delete your account', style: t(20, color: C.maroon)),
      const SizedBox(height: 10),
      _para('This removes your profile, favourites, bookings and call history. It cannot be undone once the 30 days are over.'),
      _para('You have 30 days to change your mind: log back in and your account is restored.'),
    ];
    if (!s.mustSettleFirst) {
      out
        ..add(const SizedBox(height: 22))
        ..add(ChunkyButton(label: 'DELETE MY ACCOUNT', dark: true, onTap: _busy ? null : _deleteNow));
      return out;
    }
    out
      ..add(const SizedBox(height: 14))
      ..add(Text('Money first', style: t(18, color: C.maroon)))
      ..add(const SizedBox(height: 6))
      ..add(_para('Your account has money in it, so we settle it before deleting anything:'));
    if (s.withdrawable > 0 || s.held > 0) {
      out.add(_bullet('Earnings of ${_rupees(s.withdrawable + s.held)} are paid to your UPI ID${s.held > 0 ? ' (${_rupees(s.held)} is still in its 7-day hold and is paid ${s.heldReleaseAt == null ? 'when the hold ends' : 'on ${inDayTime(s.heldReleaseAt!)}'})' : ''}.'));
    }
    if (s.refundable + s.manualRefund > 0) {
      out.add(_bullet('Your wallet money of ${_rupees(s.refundable + s.manualRefund)} is never refunded to your card. Withdraw it to your UPI with Withdraw before closing (one-time ID and UPI check). If it is under ₹1 (too small to pay out) you can choose to give it up.'));
      out.add(ChunkyButton(label: 'GO TO WITHDRAW', filled: false, onTap: _busy ? null : () => context.push('/payout')));
    }
    out.add(_bullet('Test credits are dropped. They are never paid out.'));
    out.add(_bullet(kBelowRupeeNote));
    if (s.forfeitRupees > 0 || _smallLeft > 0) {
      out
        ..add(const SizedBox(height: 12))
        ..add(CheckboxListTile(
          key: const Key('give-up-money'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          activeColor: C.maroon,
          value: _giveUp,
          onChanged: (v) => setState(() => _giveUp = v == true),
          title: Text(
            s.forfeitRupees <= 0
                ? 'I understand that ${_rupees(_smallLeft)} in my wallet is too small to pay out and I give it up.'
                : s.bankOk
                ? 'I understand that ${_rupees(s.forfeitRupees)} cannot be paid out and will be lost.'
                : 'I have no UPI ID. I give up ${_rupees(s.forfeitRupees)} of earnings.',
            style: t(14, w: FontWeight.w700, h: 1.35),
          ),
        ));
    }
    out
      ..add(const SizedBox(height: 18))
      ..add(ChunkyButton(
        label: 'START CLOSING MY ACCOUNT',
        dark: true,
        onTap: (_busy || ((s.forfeitRupees > 0 || _smallLeft > 0) && !_giveUp)) ? null : () => _startClosure(s),
      ));
    return out;
  }

  Widget _para(String text, {bool muted = false}) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text, style: t(15, color: muted ? C.muted : C.deep, w: FontWeight.w600, h: 1.45)),
      );

  Widget _bullet(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 6, left: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('•  ', style: t(15, color: C.maroon)),
          Expanded(child: Text(text, style: t(15, w: FontWeight.w600, h: 1.4))),
        ]),
      );
}

// ---------------------------------------------------------------------------------------------- Help

/// Opens the mail app with the support address. Used by the Help screen.
Future<void> openSupportMail(BuildContext context) async {
  final ok = await ExternalLinks.open(ExternalLinks.supportMail);
  if (!ok && context.mounted) toast(context, 'Write to ${HelpStrings.supportEmail}.');
}
