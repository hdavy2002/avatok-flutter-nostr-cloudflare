import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../auth/clerk_client.dart';
import '../../core/admin_tools.dart';
import '../../core/api_auth.dart';
import '../../core/brain_consent.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
import '../../identity/identity.dart';

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
  bool _revealKey = false;

  bool _backingUp = false;

  final _kindStore = AccountKindStore();
  AccountKind _kind = AccountKind.personal;

  Map<String, bool> _brain = {};

  @override
  void initState() {
    super.initState();
    _kindStore.load().then((k) { if (mounted) setState(() => _kind = k); });
    BrainConsent.pull().then((_) => BrainConsent.all()).then((m) { if (mounted) setState(() => _brain = m); });
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
        title: const Text('Back up my account'),
        content: const Text(
          'We will export your AvaTOK account data from the Nostr network (your posts and '
          'your encrypted messages) and give you a download link. Media files (images, '
          'videos, voice) are not included in backups.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () { Navigator.pop(ctx); _runBackup(); },
            child: const Text('Back up'),
          ),
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
          title: const Text('Backup ready'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${j['size'] ?? 0} bytes exported (media excluded).'),
            const SizedBox(height: 10),
            SelectableText(url, style: const TextStyle(fontSize: 12, color: AvaColors.brand)),
          ]),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url));
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Download link copied')));
              },
              child: const Text('Copy link'),
            ),
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done')),
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
        title: const Text('Delete account?'),
        content: const Text(
          'This permanently deletes your AvaTOK account. Your Nostr key stays yours, but your '
          'profile, settings, and data on our network are removed. This cannot be undone.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AvaColors.danger),
            onPressed: () async {
              Navigator.pop(ctx);
              // Purge server-side data FIRST (needs the Nostr key + Clerk session
              // that we still have here), then delete the Clerk account, then sign out.
              try { await ApiAuth.postJson(kAccountDeleteUrl, const {}, timeout: const Duration(seconds: 30)); } catch (_) {}
              try { await widget.clerk.deleteAccount(); } catch (_) {}
              widget.onSignOut();
            },
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.identity;
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('Settings'),
      ),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        _section('Account type (preview)'),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Switch product to preview its sidebar tools. Temporary — '
                'real registration will set this later.',
                style: TextStyle(color: AvaColors.sub, fontSize: 12)),
            const SizedBox(height: 10),
            SegmentedButton<AccountKind>(
              segments: const [
                ButtonSegment(value: AccountKind.personal, label: Text('Personal')),
                ButtonSegment(value: AccountKind.parent, label: Text('Parent')),
                ButtonSegment(value: AccountKind.enterprise, label: Text('Enterprise')),
              ],
              selected: {_kind},
              showSelectedIcon: false,
              onSelectionChanged: (s) => _setKind(s.first),
            ),
          ]),
        ),
        const SizedBox(height: 20),
        _section('AvaBrain'),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
          child: Column(children: [
            for (final c in kBrainCapabilities)
              if (c.master || (_brain['master'] ?? true)) SwitchListTile(
                activeColor: AvaColors.brand,
                value: _brain[c.key] ?? true,
                onChanged: (v) => _setBrain(c.key, v),
                title: Text(c.title, style: TextStyle(fontWeight: c.master ? FontWeight.w800 : FontWeight.w700, color: AvaColors.ink)),
                subtitle: Text(c.subtitle, style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
              ),
          ]),
        ),
        const Padding(
          padding: EdgeInsets.only(top: 8, left: 6, right: 6),
          child: Text('Private and end-to-end-encrypted content is only ever read on your device — '
              'AvaBrain never sees your message keys or plaintext on our servers.',
              style: TextStyle(color: AvaColors.sub, fontSize: 11)),
        ),
        const SizedBox(height: 20),
        _section('Backup'),
        _tile(Icons.cloud_upload_outlined, 'Back up account',
            'Email yourself a download of your account (media excluded)', _backup),
        const SizedBox(height: 20),
        _section('Your keys'),
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Public key (npub)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.brand)),
            const SizedBox(height: 4),
            _copyRow(id?.npub ?? '—'),
            const Divider(height: 24),
            const Text('Private key (nsec) — never share', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AvaColors.danger)),
            const SizedBox(height: 4),
            if (!_revealKey)
              TextButton.icon(
                style: TextButton.styleFrom(padding: EdgeInsets.zero),
                icon: const Icon(Icons.visibility, size: 16),
                label: const Text('Reveal & re-download'),
                onPressed: () => setState(() => _revealKey = true))
            else
              _copyRow(id?.nsec ?? '—'),
          ]),
        ),
        const SizedBox(height: 20),
        _section('Danger zone'),
        _tile(Icons.delete_outline, 'Delete account', 'Permanently remove your account', _delete, danger: true),
        const SizedBox(height: 20),
        SizedBox(width: double.infinity, child: OutlinedButton.icon(
          style: OutlinedButton.styleFrom(foregroundColor: AvaColors.danger,
              side: const BorderSide(color: Color(0xFFE0E2E6)), padding: const EdgeInsets.symmetric(vertical: 14)),
          onPressed: () async { await widget.clerk.signOut(); widget.onSignOut(); },
          icon: const Icon(Icons.logout), label: const Text('Log out'))),
      ]),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 10, left: 4),
        child: Text(t, style: const TextStyle(color: AvaColors.sub, fontSize: 12, letterSpacing: 1, fontWeight: FontWeight.w700)),
      );

  Widget _tile(IconData icon, String title, String sub, VoidCallback onTap, {bool danger = false}) => Container(
        margin: const EdgeInsets.only(bottom: 10),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
        child: ListTile(
          leading: Icon(icon, color: danger ? AvaColors.danger : AvaColors.ink),
          title: Text(title, style: TextStyle(fontWeight: FontWeight.w700, color: danger ? AvaColors.danger : AvaColors.ink)),
          subtitle: Text(sub, style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
          onTap: onTap,
        ),
      );

  Widget _copyRow(String value) => Row(children: [
        Expanded(child: SelectableText(value, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
        IconButton(icon: const Icon(Icons.copy, size: 18), onPressed: () {
          Clipboard.setData(ClipboardData(text: value));
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
        }),
      ]);
}
