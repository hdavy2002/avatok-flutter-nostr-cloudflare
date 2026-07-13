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
import '../../core/ui/avatok_dark.dart';

/// AvaInvite — "invite your phone contacts to AvaTOK".
///
/// LAZY by design (owner decision 2026-07-01): we read a lightweight NAME-ONLY
/// list of the address book (no phones/emails loaded), render it with a lazy
/// ListView (only what fits the screen is built), and fetch a single contact's
/// number/email ON DEMAND the moment the user taps to invite them. So even a
/// 3000-contact phone opens instantly and never freezes — nothing heavy is loaded
/// up front, and the address book is only touched when THIS screen is open.
class InviteScreen extends StatefulWidget {
  const InviteScreen({super.key});
  @override
  State<InviteScreen> createState() => _InviteScreenState();
}

class _InviteScreenState extends State<InviteScreen> {
  StreamSubscription<List<InviteSend>>? _sentSub;
  final _searchCtrl = TextEditingController();

  List<ContactRef> _all = const [];
  Set<String> _sent = {}; // '<contactId>|<channel>'
  final Set<String> _sending = {}; // '<contactId>|email' while the server call is in flight
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

    // Persistent "Sent" tags (keyed by contact id).
    _sentSub = Db.I.watchInviteSends().listen((rows) {
      if (mounted) setState(() => _sent = {for (final r in rows) '${r.phoneNorm}|${r.channel}'});
    });
    final seed = await Db.I.inviteSendsOnce();
    if (mounted) setState(() => _sent = {for (final r in seed) '${r.phoneNorm}|${r.channel}'});

    final status = await Permission.contacts.status;
    if (!status.isGranted) {
      if (mounted) setState(() { _softAsk = true; _loaded = true; });
      Analytics.capture('contacts_soft_ask_shown', const {'source': 'invite_screen'});
      return;
    }
    await _loadRefs();
  }

  /// Read the lightweight name-only list (cheap, no properties). This is the ONLY
  /// address-book read; numbers are fetched per-contact on an invite tap.
  Future<void> _loadRefs() async {
    if (mounted) setState(() => _refreshing = true);
    final refs = await DeviceContactsService.listRefs();
    if (!mounted) return;
    setState(() { _all = refs; _refreshing = false; _loaded = true; _permDenied = false; _softAsk = false; });
    Analytics.capture('invite_screen_loaded', {
      'count': _all.length,
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
    await _loadRefs();
  }

  @override
  void dispose() {
    _sentSub?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  // Filter by name only (light refs carry no phone/email). ListView.builder keeps
  // rendering lazy, so we don't need to cap the list for performance.
  List<ContactRef> get _filtered {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return _all;
    return _all.where((c) => c.name.toLowerCase().contains(q)).toList();
  }

  bool _isSent(ContactRef c, String channel) => _sent.contains('${c.id}|$channel');

  // ── send actions (fetch the number/email ON DEMAND) ─────────────────────────

  /// Build a throwaway DeviceContact from an on-demand detail fetch so we can
  /// reuse the existing invite-link helpers. Returns null if the contact has no
  /// usable value for [needEmail].
  Future<DeviceContact?> _resolve(ContactRef c, {bool needEmail = false}) async {
    final det = await DeviceContactsService.contactDetail(c.id);
    if (needEmail) {
      if (det.email.isEmpty) return null;
    } else if (det.phone.isEmpty) {
      return null;
    }
    return DeviceContact(
      name: c.name,
      rawPhone: det.phone,
      phoneNorm: DeviceContactsService.normPhone(det.phone),
      email: det.email,
    );
  }

  void _snack(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _whatsapp(ContactRef c) async {
    final dc = await _resolve(c);
    if (dc == null) { _snack('No phone number saved for ${c.name}.'); return; }
    final text = DeviceContactsService.inviteText(dc, myName: _myName, myHandle: _myHandle);
    final ok = await _launch(DeviceContactsService.whatsappUri(dc, text));
    if (ok) await _recordSent(c, 'whatsapp');
    _track(c, 'whatsapp', ok);
  }

  Future<void> _sms(ContactRef c) async {
    final dc = await _resolve(c);
    if (dc == null) { _snack('No phone number saved for ${c.name}.'); return; }
    final text = DeviceContactsService.inviteText(dc, myName: _myName, myHandle: _myHandle);
    final ok = await _launch(DeviceContactsService.smsUri(dc, text));
    if (ok) await _recordSent(c, 'sms');
    _track(c, 'sms', ok);
  }

  Future<void> _email(ContactRef c) async {
    final key = '${c.id}|email';
    if (_sending.contains(key)) return;
    setState(() => _sending.add(key));
    final dc = await _resolve(c, needEmail: true);
    if (dc == null) {
      if (mounted) setState(() => _sending.remove(key));
      _snack('No email saved for ${c.name}.');
      return;
    }
    final ok = await DeviceContactsService.sendInviteEmail(dc, myName: _myName);
    if (mounted) setState(() => _sending.remove(key));
    if (ok) {
      await _recordSent(c, 'email');
    } else {
      Analytics.capture('invite_send_failed', {'channel': 'email', 'reason': 'server'});
      _snack("Couldn't send the email — please try again");
    }
    _track(c, 'email', ok);
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

  Future<void> _recordSent(ContactRef c, String channel) async {
    await Db.I.markInviteSent(c.id, channel);
    if (mounted) setState(() => _sent = {..._sent, '${c.id}|$channel'});
  }

  void _track(ContactRef c, String channel, bool ok) {
    Analytics.capture('invite_sent', {'channel': channel, 'ok': ok, 'source': 'invite_screen'});
  }

  // ── build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        bottom: false,
        child: Column(children: [
          Container(
            decoration: const BoxDecoration(
              color: AD.headerFooter,
              border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
            child: Column(children: [
              Row(children: [
                _backButton(context),
                const SizedBox(width: 6),
                Expanded(child: Text('Invite friends', style: ADText.appTitle())),
                if (_refreshing)
                  const SizedBox(width: 16, height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch)),
              ]),
              const SizedBox(height: 12),
              _searchDock(
                controller: _searchCtrl,
                hint: 'Search by name',
                onChanged: (v) => setState(() => _query = v),
              ),
            ]),
          ),
          Expanded(child: _body()),
        ]),
      ),
    );
  }

  /// Circular back button (inline dark v2 replacement for ZineBackButton).
  Widget _backButton(BuildContext context) => GestureDetector(
        onTap: () => Navigator.of(context).maybePop(),
        child: Container(
          width: 38, height: 38,
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(AD.rIconButton)),
          child: const Icon(Icons.arrow_back_rounded, size: 22, color: AD.textPrimary),
        ),
      );

  /// White search dock — dark ink text on a white field, mirrors the dark v2
  /// search idiom. Keeps controller / onChanged wiring intact.
  Widget _searchDock({
    required TextEditingController controller,
    required String hint,
    required ValueChanged<String> onChanged,
    bool autofocus = false,
    Widget? trailing,
  }) =>
      Container(
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: BorderRadius.circular(AD.rInput),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
              size: 18, color: AD.iconSearch),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              autofocus: autofocus,
              onChanged: onChanged,
              cursorColor: AD.iconSearch,
              style: ADText.rowName(c: AD.textOnInput),
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(vertical: 13),
                hintText: hint,
                hintStyle: ADText.preview(c: AD.placeholderOnWhite),
              ),
            ),
          ),
          if (trailing != null) trailing,
        ]),
      );

  Widget _body() {
    if (_softAsk && _all.isEmpty) {
      return _permissionPanel(
        title: 'Invite people you know',
        body: 'AvaTOK can check your contacts so you can invite friends by WhatsApp, '
            'text or email. Your contacts stay on your device — only the person you '
            'tap to invite is ever used.',
        cta: 'Allow contacts',
      );
    }
    if (_permDenied && _all.isEmpty) {
      return _permissionPanel(
        title: 'Contacts access is off',
        body: 'Allow AvaTOK to read your contacts so you can invite friends.',
        cta: 'Allow access',
      );
    }
    if (!_loaded) {
      return const Center(child: SizedBox(width: 22, height: 22,
          child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch)));
    }
    final items = _filtered;
    if (items.isEmpty) {
      return Center(child: Text(
          _query.trim().isEmpty
              ? (_refreshing ? 'Loading your contacts…' : 'No contacts found on your phone')
              : 'No matches',
          style: ADText.preview(c: AD.textSecondary)));
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 2),
      itemBuilder: (_, i) => _row(items[i]),
    );
  }

  Widget _row(ContactRef c) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          Container(
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: AD.borderAvatar, width: 2)),
            child: Avatar(seed: c.id, name: c.name, size: 42),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(c.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
          ),
          const SizedBox(width: 8),
          _channels(c),
        ]),
      );

  Widget _channels(ContactRef c) {
    final sendingEmail = _sending.contains('${c.id}|email');
    return Row(mainAxisSize: MainAxisSize.min, children: [
      _channelBtn(
        icon: PhosphorIcons.whatsappLogo(PhosphorIconsStyle.fill),
        color: const Color(0xFF25D366),
        sent: _isSent(c, 'whatsapp'),
        onTap: () => _whatsapp(c),
      ),
      _channelBtn(
        icon: PhosphorIcons.chatCircleText(PhosphorIconsStyle.fill),
        color: AD.iconSearch,
        sent: _isSent(c, 'sms'),
        onTap: () => _sms(c),
      ),
      _channelBtn(
        icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.fill),
        color: AD.iconVideo,
        sent: _isSent(c, 'email'),
        busy: sendingEmail,
        sentLabel: 'Email Sent',
        onTap: () => _email(c),
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
                  PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 9, color: AD.online),
                  const SizedBox(width: 2),
                  Text(sentLabel, style: ADText.statCaption(c: AD.online)),
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
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: busy
                  ? const Padding(padding: EdgeInsets.all(11),
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : PhosphorIcon(icon, size: 19, color: Colors.white),
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
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.addressBook(PhosphorIconsStyle.bold), size: 48, color: AD.textTertiary),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: ADText.threadName()),
          const SizedBox(height: 8),
          Text(body, textAlign: TextAlign.center, style: ADText.preview(c: AD.textSecondary)),
          const SizedBox(height: 20),
          _ctaButton(label: cta, onPressed: _allowContacts),
        ]),
      ),
    );
  }

  /// Inline dark v2 primary button (replaces ZineButton).
  Widget _ctaButton({required String label, required VoidCallback onPressed}) =>
      GestureDetector(
        onTap: onPressed,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 13),
          decoration: BoxDecoration(
            color: AD.primaryBadge,
            borderRadius: BorderRadius.circular(100),
          ),
          child: Text(label, style: ADText.rowName()),
        ),
      );
}
