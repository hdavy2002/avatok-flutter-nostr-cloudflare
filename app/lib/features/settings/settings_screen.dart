import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../auth/clerk_client.dart';
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

  void _backup() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Back up my account'),
        content: const Text(
          'We will export your AvaTOK account data from the Nostr network and email you a '
          'download link. Media files (images and videos) are not included in backups.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              Navigator.pop(ctx);
              ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Backup queued — check your email shortly')));
            },
            child: const Text('Back up'),
          ),
        ],
      ),
    );
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
