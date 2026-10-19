import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/demo_mode.dart';
import '../../data/models/me.dart';
import '../../data/repos/settings_repo.dart';
import '../../data/services.dart';
import '../../ui/strings/help_strings.dart';
import '../theme.dart';
import '../widgets.dart';

/// Real Settings and Delete account (HF-WIRE-11). While [DemoMode.on] the dummy screens in me.dart stay.
abstract final class SettingsBridge {
  /// Tests set this to exercise the real path without a dart-define.
  static bool forceReal = false;

  static bool get real => forceReal || !DemoMode.on;
}

Future<void> _defaultSignOut() => Services.instance.signOut();

String _rupees(double v) => '₹${v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2)}';

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

  Future<void> _editName() async {
    final ctl = TextEditingController(text: _name ?? '');
    final value = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Your name', style: t(20, color: C.maroon)),
        content: TextField(
          controller: ctl,
          autofocus: true,
          maxLength: 40,
          textCapitalization: TextCapitalization.words,
          style: t(16),
          decoration: const InputDecoration(hintText: 'Your name'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: t(15, color: C.muted))),
          TextButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: Text('Save', style: t(15, color: C.maroon))),
        ],
      ),
    );
    if (value == null || value.isEmpty || value == _name) return;
    try {
      final stored = await _repo.saveName(value);
      if (!mounted) return;
      setState(() => _name = stored);
      unawaited(Services.instance.refreshMe());
      toast(context, 'Name saved.');
    } catch (e) {
      if (mounted) toast(context, e is ApiException ? e.userMessage : 'We could not save your name. Please try again.');
    }
  }

  Future<void> _signOut() async {
    final go = GoRouter.of(context);
    await (widget.signOut ?? _defaultSignOut)();
    go.go('/reels');
  }

  Future<void> _openLink(Uri uri) async {
    final ok = await ExternalLinks.open(uri);
    if (!ok && mounted) {
      toast(context, uri.scheme == 'mailto' ? 'Write to ${HelpStrings.supportEmail}.' : 'We could not open the page. Please try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = _me;
    final email = me?.email;
    final whatsapp = me?.phoneMasked;
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
                  const SizedBox(height: 4),
                  ListTile(
                    key: const Key('settings-name'),
                    contentPadding: EdgeInsets.zero,
                    title: Text('Name', style: t(15, color: C.muted)),
                    subtitle: Text((_name ?? '').isEmpty ? 'Add your name' : _name!, style: t(16)),
                    trailing: const Icon(Icons.edit_rounded, color: C.maroon),
                    onTap: _editName,
                  ),
                  _info('Email', (email ?? '').isEmpty ? 'Not added' : email!),
                  _supportNote(HelpStrings.changeEmailNote),
                  _info('WhatsApp', (whatsapp ?? '').isEmpty ? 'Not added' : whatsapp!),
                  _supportNote(HelpStrings.changeWhatsappNote),
                  if (me?.hostStatus != null) _link('Channels', () => context.push('/inf/channels')),
                  const SizedBox(height: 18),
                  Text('WhatsApp messages', style: t(18, color: C.maroon)),
                  if (_prefsFailed)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Row(children: [
                        Expanded(child: Text('We could not load your choices.', style: t(15, color: C.muted, w: FontWeight.w700))),
                        TextButton(onPressed: _loadPrefs, child: Text('Try again', style: t(15, color: C.maroon))),
                      ]),
                    )
                  else ...[
                    _switch('Call alerts', 'notifyWhatsapp', _prefs.notifyWhatsapp),
                    _switch('Booking reminders', 'apptReminders', _prefs.apptReminders),
                    _switch('New reels from favourites', 'reelAlerts', _prefs.reelAlerts),
                  ],
                  const SizedBox(height: 18),
                  Text('About', style: t(18, color: C.maroon)),
                  const SizedBox(height: 4),
                  _link('Help and FAQ', () => context.push('/help')),
                  _link('Terms of use', () => _openLink(ExternalLinks.terms)),
                  _link('Privacy policy', () => _openLink(ExternalLinks.privacy)),
                  _info('App version', _version.version.isEmpty ? '' : _version.label),
                  const SizedBox(height: 26),
                  ChunkyButton(label: 'SIGN OUT', filled: false, onTap: _signOut),
                  const SizedBox(height: 14),
                  Center(
                    child: TextButton(
                      key: const Key('settings-delete'),
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => DeleteAccountScreen(repo: widget.repo, signOut: widget.signOut),
                      )),
                      child: Text('Delete my account', style: t(15, color: C.ruby)),
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

  Widget _info(String a, String b) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [Expanded(child: Text(a, style: t(15, color: C.muted))), Text(b, style: t(16))]),
      );

  Widget _supportNote(String lead) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: InkWell(
          onTap: () => _openLink(ExternalLinks.supportMail),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text.rich(TextSpan(
              style: t(14, color: C.muted, w: FontWeight.w700),
              children: [
                TextSpan(text: '$lead '),
                TextSpan(text: HelpStrings.supportEmail, style: t(14, color: C.maroon, w: FontWeight.w800)),
                const TextSpan(text: '.'),
              ],
            )),
          ),
        ),
      );

  Widget _switch(String label, String key, bool v) => SwitchListTile(
        key: Key('pref-$key'),
        contentPadding: EdgeInsets.zero,
        title: Text(label, style: t(16)),
        value: v,
        activeThumbColor: C.marigold,
        activeTrackColor: C.maroon,
        onChanged: _prefsLoaded ? (x) => _flip(key, x) : null,
      );

  Widget _link(String label, VoidCallback onTap) => ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(label, style: t(16)),
        trailing: const Icon(Icons.chevron_right_rounded, color: C.maroon),
        onTap: onTap,
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
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title, style: t(20, color: C.maroon)),
        content: Text(body, style: t(15, w: FontWeight.w600, h: 1.4)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text('Keep my account', style: t(15, color: C.muted))),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(yes, style: t(15, color: C.ruby))),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() => _busy = true);
    try {
      await job();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'forfeit_required') {
        // The server says some money cannot be paid out; show it and ask for a clear yes before going on.
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
      'We will first pay out your earnings. Wallet money is never sent back to your card, so withdraw it to your UPI first. Once that is settled your account is deleted after a 30-day grace period. You can stop this until a payment is approved.',
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
      'waiting_hold' => 'Your latest earnings are still in their 7-day hold. We pay them out as soon as the hold ends.',
      'waiting_payouts' => 'Your money is on its way. Once every payment is done, your account is deleted after a 30-day grace period.',
      _ => 'Almost done. Your account will be deleted after a 30-day grace period.',
    };
    return [
      Text('Closing your account', style: t(20, color: C.maroon)),
      const SizedBox(height: 10),
      _para(text),
      if (s.payout != null) _line('Earnings payout', s.payout!),
      if (s.refund != null) _line('Refund to your original payment', s.refund!),
      const SizedBox(height: 20),
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
      child: Row(children: [
        Expanded(child: Text(what, style: t(15, color: C.muted))),
        Text('${_rupees(l.amount)} · $status', style: t(15)),
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
      out.add(_bullet('Earnings of ${_rupees(s.withdrawable + s.held)} are paid to your verified bank account${s.held > 0 ? ' (${_rupees(s.held)} is still in its 7-day hold and is paid when the hold ends)' : ''}.'));
    }
    if (s.refundable + s.manualRefund > 0) {
      out.add(_bullet('Unused top-up money of ${_rupees(s.refundable + s.manualRefund)} stays in your wallet. Withdraw it to your UPI from Payouts before closing; it is never refunded to your card.'));
    }
    out.add(_bullet('Test credits are dropped. They are never paid out.'));
    if (s.forfeitRupees > 0) {
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
            s.bankOk
                ? 'I understand that ${_rupees(s.forfeitRupees)} cannot be paid out and will be lost.'
                : 'I have no verified bank account. I give up ${_rupees(s.forfeitRupees)} of earnings.',
            style: t(14, w: FontWeight.w700, h: 1.35),
          ),
        ));
    }
    out
      ..add(const SizedBox(height: 18))
      ..add(ChunkyButton(
        label: 'START CLOSING MY ACCOUNT',
        dark: true,
        onTap: (_busy || (s.forfeitRupees > 0 && !_giveUp)) ? null : () => _startClosure(s),
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
