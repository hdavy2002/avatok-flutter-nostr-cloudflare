import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/db.dart';
import '../../core/device_contacts.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// AvaInvite — "invite your phone contacts to AvaTOK".
///
/// Lists the device address book (instant from the per-account SQLite cache, then
/// a background refresh folds in emails + WhatsApp flags + on-AvaTOK matches).
/// Per contact:
///   • Already on AvaTOK → a green-tick "On AvaTOK" badge (nothing to invite).
///   • Otherwise → up to three channel buttons:
///       – WhatsApp (only if the number is a WhatsApp contact) — deep-link prefill
///       – SMS (always) — deep-link prefill carrying the inviter's name
///       – Email (only if the contact has an email) — the SERVER sends it on the
///         user's behalf (Reply-To = the inviter), then the button shows "Email Sent"
/// A persistent "Sent" tag (from the InviteSends table) sits above each used icon
/// so the user always sees who they've already reached, even after a restart.
class InviteScreen extends StatefulWidget {
  const InviteScreen({super.key});
  @override
  State<InviteScreen> createState() => _InviteScreenState();
}

class _InviteScreenState extends State<InviteScreen> {
  StreamSubscription<List<DeviceContact>>? _contactsSub;
  StreamSubscription<List<InviteSend>>? _sentSub;
  final _searchCtrl = TextEditingController();

  List<DeviceContact> _all = const [];
  Set<String> _sent = {}; // '<phoneNorm>|<channel>'
  final Set<String> _sending = {}; // '<phoneNorm>|email' while the server call is in flight
  bool _loaded = false;
  bool _permDenied = false;
  bool _softAsk = false;
  bool _refreshing = false;
  String _query = '';

  String _myHandle = '';
  String _myName = '';
  final _openedAt = DateTime.now();

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'invite');
    _boot();
  }

  Future<void> _boot() async {
    final p = await ProfileStore().load();
    _myHandle = p.handle;
    _myName = p.displayName;

    final cached = await DeviceContactsService.cached();
    if (mounted) setState(() { _all = cached; _loaded = true; });

    _contactsSub = DeviceContactsService.watch().listen((rows) {
      if (mounted) setState(() { _all = rows; _loaded = true; });
    });
    _sentSub = Db.I.watchInviteSends().listen((rows) {
      if (mounted) setState(() => _sent = {for (final r in rows) '${r.phoneNorm}|${r.channel}'});
    });
    // Seed the sent-set immediately (before the stream's first emit).
    final seed = await Db.I.inviteSendsOnce();
    if (mounted) setState(() => _sent = {for (final r in seed) '${r.phoneNorm}|${r.channel}'});

    final status = await Permission.contacts.status;
    if (!status.isGranted) {
      if (mounted) setState(() => _softAsk = true);
      Analytics.capture('contacts_soft_ask_shown', const {'source': 'invite_screen'});
      return;
    }
    await _syncNow();
  }

  Future<void> _syncNow() async {
    if (mounted) setState(() => _refreshing = true);
    await DeviceContactsService.refresh(force: true, source: 'invite_screen');
    if (!mounted) return;
    setState(() { _refreshing = false; _permDenied = false; _softAsk = false; });
    Analytics.capture('invite_screen_loaded', {
      'count': _all.length,
      'on_avatok_count': _all.where((d) => d.onAvatok).length,
      'with_email_count': _all.where((d) => !d.onAvatok && d.hasEmail).length,
      'open_ms': DateTime.now().difference(_openedAt).inMilliseconds,
    });
  }

  Future<void> _allowContacts() async {
    setState(() { _softAsk = false; _refreshing = true; });
    final res = await Permission.contacts.request();
    if (!res.isGranted) {
      if (mounted) setState(() { _permDenied = true; _refreshing = false; });
      Analytics.capture('contacts_permission', {'granted': false, 'source': 'invite_screen'});
      return;
    }
    Analytics.capture('contacts_permission', {'granted': true, 'source': 'invite_screen'});
    await _syncNow();
  }

  @override
  void dispose() {
    _contactsSub?.cancel();
    _sentSub?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  List<DeviceContact> get _filtered {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return _all.take(200).toList();
    final qDigits = q.replaceAll(RegExp(r'[^\d]'), '');
    return _all.where((d) {
      if (d.displayName.toLowerCase().contains(q)) return true;
      if (d.email.toLowerCase().contains(q)) return true;
      if (qDigits.isNotEmpty &&
          d.phoneNorm.replaceAll(RegExp(r'[^\d]'), '').contains(qDigits)) return true;
      return false;
    }).take(200).toList();
  }

  bool _isSent(DeviceContact d, String channel) => _sent.contains('${d.phoneNorm}|$channel');

  // ── send actions ──────────────────────────────────────────────────────────

  Future<void> _whatsapp(DeviceContact d) async {
    final text = DeviceContactsService.inviteText(d, myName: _myName, myHandle: _myHandle);
    final ok = await _launch(DeviceContactsService.whatsappUri(d, text));
    if (ok) await _recordSent(d, 'whatsapp');
    _track(d, 'whatsapp', ok);
  }

  Future<void> _sms(DeviceContact d) async {
    final text = DeviceContactsService.inviteText(d, myName: _myName, myHandle: _myHandle);
    final ok = await _launch(DeviceContactsService.smsUri(d, text));
    if (ok) await _recordSent(d, 'sms');
    _track(d, 'sms', ok);
  }

  Future<void> _email(DeviceContact d) async {
    final key = '${d.phoneNorm}|email';
    if (_sending.contains(key)) return;
    setState(() => _sending.add(key));
    final ok = await DeviceContactsService.sendInviteEmail(d, myName: _myName);
    if (mounted) setState(() => _sending.remove(key));
    if (ok) {
      await _recordSent(d, 'email');
    } else if (mounted) {
      Analytics.capture('invite_send_failed', {'channel': 'email', 'reason': 'server'});
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Couldn't send the email — please try again")));
    }
    _track(d, 'email', ok);
  }

  Future<bool> _launch(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (e) {
      Analytics.error(domain: 'invite', code: 'launch_failed', screen: 'invite',
          action: 'open_app', message: e.toString());
      return false;
    }
  }

  Future<void> _recordSent(DeviceContact d, String channel) async {
    await Db.I.markInviteSent(d.phoneNorm, channel);
    // The stream repaints, but seed locally so the tag is instant.
    if (mounted) setState(() => _sent = {..._sent, '${d.phoneNorm}|$channel'});
  }

  void _track(DeviceContact d, String channel, bool ok) {
    Analytics.capture('invite_sent', {
      'channel': channel,
      'ok': ok,
      'on_avatok': false,
      'has_email': d.hasEmail,
      'has_whatsapp': d.hasWhatsapp,
      'source': 'invite_screen',
    });
  }

  // ── build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Column(children: [
          Container(
            decoration: const BoxDecoration(
              color: Zine.paper2,
              border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
            child: Column(children: [
              Row(children: [
                const ZineBackButton(),
                const SizedBox(width: 12),
                Expanded(child: Text('Invite friends', style: ZineText.appbar())),
                if (_refreshing)
                  const SizedBox(width: 16, height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2)),
              ]),
              const SizedBox(height: 12),
              ZineField(
                controller: _searchCtrl,
                hint: 'Search name, email or phone',
                leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                onChanged: (v) => setState(() => _query = v),
              ),
            ]),
          ),
          Expanded(child: _body()),
        ]),
      ),
    );
  }

  Widget _body() {
    if (_softAsk && _all.isEmpty) {
      return _permissionPanel(
        title: 'Invite people you know',
        body: 'AvaTOK can check your contacts so you can invite friends by WhatsApp, '
            'text or email — and see who\'s already here. Your contacts stay on your '
            'device and sync privately.',
        cta: 'Allow contacts',
      );
    }
    if (_permDenied && _all.isEmpty) {
      return _permissionPanel(
        title: 'Contacts access is off',
        body: 'Allow AvaTOK to read your contacts so you can invite friends and see '
            'who\'s already here.',
        cta: 'Allow access',
      );
    }
    if (!_loaded) {
      return const Center(child: SizedBox(
          width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)));
    }
    final items = _filtered;
    if (items.isEmpty) {
      return Center(child: Text(
          _query.trim().isEmpty
              ? (_refreshing ? 'Loading your contacts…' : 'No contacts found on your phone')
              : 'No matches',
          style: ZineText.sub(size: 13)));
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 2),
      itemBuilder: (_, i) => _row(items[i]),
    );
  }

  Widget _row(DeviceContact d) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          Container(
            decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: 2)),
            child: Avatar(
                seed: d.onAvatok ? d.uid : d.phoneNorm,
                name: d.displayName,
                size: 42,
                avatarUrl: d.avatarUrl.isEmpty ? null : d.avatarUrl),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(d.displayName, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.value(size: 15)),
                const SizedBox(height: 2),
                Text(d.hasEmail && !d.onAvatok ? d.email : d.subtitle,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 12.5)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          d.onAvatok ? _onAvatokBadge() : _channels(d),
        ]),
      );

  // Green-tick AvaTOK badge for people already on the network (no invite icons).
  Widget _onAvatokBadge() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: Zine.mint,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 1.5),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 13, color: Zine.mintInk),
          const SizedBox(width: 4),
          Text('AvaTOK', style: ZineText.tag(size: 10)),
        ]),
      );

  Widget _channels(DeviceContact d) {
    final sendingEmail = _sending.contains('${d.phoneNorm}|email');
    return Row(mainAxisSize: MainAxisSize.min, children: [
      if (d.hasWhatsapp)
        _channelBtn(
          icon: PhosphorIcons.whatsappLogo(PhosphorIconsStyle.fill),
          color: const Color(0xFF25D366),
          sent: _isSent(d, 'whatsapp'),
          onTap: () => _whatsapp(d),
        ),
      _channelBtn(
        icon: PhosphorIcons.chatCircleText(PhosphorIconsStyle.fill),
        color: Zine.blue,
        sent: _isSent(d, 'sms'),
        onTap: () => _sms(d),
      ),
      if (d.hasEmail)
        _channelBtn(
          icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.fill),
          color: Zine.lilac,
          sent: _isSent(d, 'email'),
          busy: sendingEmail,
          sentLabel: 'Email Sent',
          onTap: () => _email(d),
        ),
    ]);
  }

  /// One circular channel button with a tiny "Sent" pill above it once used.
  Widget _channelBtn({
    required IconData icon,
    required Color color,
    required bool sent,
    required VoidCallback onTap,
    bool busy = false,
    String sentLabel = 'Sent',
  }) {
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        SizedBox(
          height: 14,
          child: sent
              ? Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                      size: 9, color: Zine.mintInk),
                  const SizedBox(width: 2),
                  Text(sentLabel, style: ZineText.tag(size: 8.5).copyWith(color: Zine.mintInk)),
                ])
              : null,
        ),
        const SizedBox(height: 3),
        GestureDetector(
          onTap: busy ? null : onTap,
          child: Opacity(
            opacity: sent ? 0.55 : 1,
            child: Container(
              width: 40, height: 40,
              decoration: BoxDecoration(
                color: color,
                shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: 2),
                boxShadow: Zine.shadowXs,
              ),
              child: busy
                  ? const Padding(
                      padding: EdgeInsets.all(11),
                      child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink))
                  : PhosphorIcon(icon, size: 19, color: Zine.ink),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _permissionPanel({required String title, required String body, required String cta}) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.usersThree(PhosphorIconsStyle.bold), color: Zine.lilac, size: 34),
            const SizedBox(width: 10),
            Expanded(child: Text(title, style: ZineText.value(size: 16))),
          ]),
          const SizedBox(height: 12),
          Text(body, style: ZineText.sub(size: 13)),
          const SizedBox(height: 16),
          ZineButton(
            label: _refreshing ? 'Loading…' : cta,
            fullWidth: true,
            fontSize: 16,
            loading: _refreshing,
            icon: PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
            trailingIcon: false,
            onPressed: _refreshing ? null : _allowContacts,
          ),
        ]),
      ),
    );
  }
}
