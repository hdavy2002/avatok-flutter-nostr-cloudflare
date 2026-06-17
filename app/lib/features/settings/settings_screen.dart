import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../auth/clerk_client.dart';
import '../../core/admin_tools.dart';
import '../../core/api_auth.dart';
import '../../core/ava_ai_store.dart';
import '../../core/brain_consent.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../ava_ai/ava_ai_setup.dart';
import 'settings_registry.dart';

/// Account settings — Backup, Manage keys, Delete account.
class SettingsScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  final Identity? identity;
  const SettingsScreen({super.key, required this.clerk, required this.onSignOut, this.identity});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {

  bool _backingUp = false;

  final _kindStore = AccountKindStore();
  AccountKind _kind = AccountKind.personal;

  Map<String, bool> _brain = {};

  final _aiStore = AvaAiStore();
  bool _aiConnected = false;
  String? _aiEmail;

  @override
  void initState() {
    super.initState();
    _kindStore.load().then((k) { if (mounted) setState(() => _kind = k); });
    BrainConsent.pull().then((_) => BrainConsent.all()).then((m) { if (mounted) setState(() => _brain = m); });
    _refreshAi();
  }

  Future<void> _refreshAi() async {
    final connected = await _aiStore.isConnected();
    final email = await _aiStore.googleEmail();
    if (mounted) setState(() { _aiConnected = connected; _aiEmail = email; });
  }

  Future<void> _setupAi() async {
    final saved = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (_) => const AvaAiSetupScreen()));
    if (saved == true) await _refreshAi();
  }

  void _removeAi() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.rSm),
            side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Disconnect Ava AI?', style: ZineText.cardTitle()),
        content: Text(
            'This removes your Gemini API key and the linked Google account from '
            'this device. AvaTOK goes back to plain messaging. You can connect a '
            'different account anytime.',
            style: ZineText.sub(size: 13.5)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Cancel', style: ZineText.value(size: 14))),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await _aiStore.clear();
              await _refreshAi();
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Ava AI disconnected')));
              }
            },
            child: Text('Disconnect', style: ZineText.value(size: 14, color: Zine.coral)),
          ),
        ],
      ),
    );
  }

  Future<void> _setBrain(String key, bool v) async {
    setState(() => _brain[key] = v);
    await BrainConsent.set(key, v);
  }

  Future<void> _setKind(AccountKind k) async {
    await _kindStore.set(k);
    if (mounted) setState(() => _kind = k);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Account type updated — reopen the sidebar to see its tools')));
    }
  }

  void _backup() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Back up my account', style: ZineText.cardTitle()),
        content: Text(
          'We will export your AvaTOK account data (your posts and messages) and '
          'give you a download link. Media files (images, videos, voice) are not '
          'included in backups.',
          style: ZineText.sub(size: 14),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(label: 'Back up', variant: ZineButtonVariant.blue, fontSize: 15,
              onPressed: () { Navigator.pop(ctx); _runBackup(); }),
        ],
      ),
    );
  }

  Future<void> _runBackup() async {
    final id = widget.identity;
    if (id == null || _backingUp) return;
    setState(() => _backingUp = true);
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Exporting your account…')));
    try {
      // pubkey derived server-side from the NIP-98 signature.
      final res = await ApiAuth.postJson(kBackupUrl, const {},
          timeout: const Duration(seconds: 30));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final url = j['url']?.toString();
      if (!mounted) return;
      setState(() => _backingUp = false);
      if (url == null) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Backup failed — please try again')));
        return;
      }
      showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text('Backup ready', style: ZineText.cardTitle()),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${j['size'] ?? 0} bytes exported (media excluded).', style: ZineText.sub(size: 14)),
            const SizedBox(height: 10),
            SelectableText(url, style: ZineText.link(size: 12)),
          ]),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url));
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Download link copied')));
              },
              child: Text('Copy link', style: ZineText.link(size: 14)),
            ),
            ZineButton(label: 'Done', variant: ZineButtonVariant.blue, fontSize: 15,
                onPressed: () => Navigator.pop(ctx)),
          ],
        ),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _backingUp = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Backup failed — check your connection')));
    }
  }

  void _delete() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Delete account?', style: ZineText.cardTitle()),
        content: Text(
          'This permanently deletes your AvaTOK account. Your profile, settings, '
          'and data on our network are removed. This cannot be undone.',
          style: ZineText.sub(size: 14),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Keep my account', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(
            label: 'Delete',
            variant: ZineButtonVariant.coral,
            fontSize: 15,
            onPressed: () async {
              Navigator.pop(ctx);
              // Purge server-side data FIRST (needs the Clerk session that we
              // still have here), then delete the Clerk account, then sign out.
              try { await ApiAuth.postJson(kAccountDeleteUrl, const {}, timeout: const Duration(seconds: 30)); } catch (_) {}
              try { await widget.clerk.deleteAccount(); } catch (_) {}
              widget.onSignOut();
            },
          ),
        ],
      ),
    );
  }

  static const _kindLabels = {
    AccountKind.personal: 'Personal',
    AccountKind.parent: 'Parent',
    AccountKind.enterprise: 'Enterprise',
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Settings', markWord: 'Settings'),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        _section('Account type (preview)'),
        ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(14),
          boxShadow: Zine.shadowXs,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Switch product to preview its sidebar tools. Temporary — '
                'real registration will set this later.',
                style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 12),
            Row(children: [
              for (final k in _kindLabels.keys) ...[
                Expanded(child: ZineChip(
                  label: _kindLabels[k]!,
                  active: _kind == k,
                  onTap: () => _setKind(k),
                )),
                if (k != _kindLabels.keys.last) const SizedBox(width: 9),
              ],
            ]),
          ]),
        ),
        const SizedBox(height: 24),
        _section('Ava AI'),
        _aiCard(),
        const SizedBox(height: 24),
        _section('AvaBrain'),
        ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          boxShadow: Zine.shadowXs,
          child: Column(children: [
            for (final c in kBrainCapabilities)
              if (c.master || (_brain['master'] ?? true))
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  child: Row(children: [
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(c.title, style: ZineText.value(size: 14.5,
                          weight: c.master ? FontWeight.w900 : FontWeight.w800)),
                      const SizedBox(height: 2),
                      Text(c.subtitle, style: ZineText.sub(size: 12)),
                    ])),
                    const SizedBox(width: 10),
                    ZineToggle(value: _brain[c.key] ?? true, onChanged: (v) => _setBrain(c.key, v)),
                  ]),
                ),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 10, left: 4, right: 4),
          child: Text('Private and end-to-end-encrypted content is only ever read on your device — '
              'AvaBrain never sees your message keys or plaintext on our servers.',
              style: ZineText.sub(size: 11.5, color: Zine.inkMute)),
        ),
        const SizedBox(height: 24),
        _section('Backup'),
        _tile(PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), Zine.blue, 'Back up account',
            'Email yourself a download of your account (media excluded)', _backup),
        const SizedBox(height: 24),
        _section('Danger zone'),
        _tile(PhosphorIcons.trash(PhosphorIconsStyle.bold), Zine.coral, 'Delete account',
            'Permanently remove your account', _delete, danger: true),
        const SizedBox(height: 24),
        // Pluggable sections (Phase 0 contract): feature phases register a
        // SettingsSection from their own file under settings/sections/ and it
        // renders here, ordered, WITHOUT editing this screen.
        for (final s in SettingsSectionRegistry.sections) ...[
          _section(s.title),
          s.builder(context),
          const SizedBox(height: 24),
        ],
        ZineButton(
          label: 'Log out',
          variant: ZineButtonVariant.ghost,
          fullWidth: true,
          fontSize: 17,
          icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold),
          trailingIcon: false,
          onPressed: () async { await widget.clerk.signOut(); widget.onSignOut(); },
        ),
        const SizedBox(height: 18),
        Center(child: Text('AVATOK · YOU OWN IT ALL', style: ZineText.kicker(size: 10, color: Zine.inkMute))),
      ]),
    );
  }

  Widget _aiCard() {
    if (!_aiConnected) {
      return Column(children: [
        ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(14),
          boxShadow: Zine.shadowXs,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Turn AvaTOK into an AI-powered chat. Ava finds files, summarizes, '
                'translates and more — running on your own free Google Gemini key, '
                'so it stays free for you.',
                style: ZineText.sub(size: 12.5)),
            const SizedBox(height: 12),
            ZineButton(
              label: 'Set up Ava AI (free)',
              onPressed: _setupAi,
              fullWidth: true,
              fontSize: 16,
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
              trailingIcon: false,
            ),
          ]),
        ),
      ]);
    }
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              color: Zine.lilac, size: 34),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Ava AI is on', style: ZineText.value(size: 15)),
            const SizedBox(height: 2),
            Text(_aiEmail?.isNotEmpty == true ? _aiEmail! : 'Your own Gemini key',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.sub(size: 12)),
          ])),
          ZineSticker('FREE', kind: ZineStickerKind.ok,
              icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
        ]),
        const SizedBox(height: 14),
        Row(children: [
          Expanded(child: ZineButton(
            label: 'Replace key',
            onPressed: _setupAi,
            fullWidth: true,
            fontSize: 14,
            variant: ZineButtonVariant.ghost,
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
            trailingIcon: false,
          )),
          const SizedBox(width: 10),
          Expanded(child: ZineButton(
            label: 'Disconnect',
            onPressed: _removeAi,
            fullWidth: true,
            fontSize: 14,
            variant: ZineButtonVariant.coral,
            icon: PhosphorIcons.plugs(PhosphorIconsStyle.bold),
            trailingIcon: false,
          )),
        ]),
      ]),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 10, left: 4),
        child: Text(t.toUpperCase(), style: ZineText.kicker()),
      );

  Widget _tile(IconData icon, Color accent, String title, String sub, VoidCallback onTap, {bool danger = false}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZinePressable(
          onTap: onTap,
          radius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowXs,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ZineText.value(size: 15, color: danger ? Zine.coral : Zine.ink)),
              const SizedBox(height: 2),
              Text(sub, style: ZineText.sub(size: 12)),
            ])),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
          ]),
        ),
      );

}
