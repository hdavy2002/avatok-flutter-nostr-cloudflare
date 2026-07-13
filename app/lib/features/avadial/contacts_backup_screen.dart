import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_contact_book.dart';
import 'avadial_theme.dart';

/// "Contacts backup" screen (owner request 2026-07-13). Lets the user opt IN to
/// backing their AvaTOK contact book up to AvaTOK's own servers — independent of
/// Google/Gmail, so a lost account or SIM never loses their contacts.
///
/// Phase 1 (this build): consent switch + a local snapshot of the contact book,
/// server-side-encrypted backup chosen (owner decision). The actual upload/restore
/// to AvaTOK's servers ships in the next update; the UI says so plainly.
class ContactsBackupScreen extends StatefulWidget {
  const ContactsBackupScreen({super.key});

  @override
  State<ContactsBackupScreen> createState() => _ContactsBackupScreenState();
}

class _ContactsBackupScreenState extends State<ContactsBackupScreen> {
  bool _enabled = false;
  int _count = 0;
  DateTime? _last;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final enabled = await ContactBackupPrefs.I.enabled();
    final count = await AvaContactBook.I.count();
    final last = await ContactBackupPrefs.I.lastSnapshot();
    if (!mounted) return;
    setState(() {
      _enabled = enabled;
      _count = count;
      _last = last;
      _loading = false;
    });
  }

  Future<void> _toggle(bool on) async {
    setState(() => _enabled = on);
    await ContactBackupPrefs.I.setEnabled(on);
    Analytics.capture('avadial_contact_backup_toggled', {'enabled': on});
  }

  Future<void> _backupNow() async {
    setState(() => _busy = true);
    // Phase 1: refresh the local snapshot timestamp (the book itself is captured
    // on every Contacts-tab load). Phase 2 uploads it to AvaTOK's servers here.
    await ContactBackupPrefs.I.markSnapshot();
    Analytics.capture('avadial_contact_backup_now', {'count': _count});
    await _load();
    if (mounted) {
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Contact book snapshot saved on this device')));
    }
  }

  String _lastLabel() {
    final d = _last;
    if (d == null) return 'Never';
    return '${d.day}/${d.month}/${d.year} · ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: Zine.bw)),
        title: Text('Contacts backup', style: ZineText.appbar(color: AvaDialTheme.text)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                ZineCard(
                  color: Zine.blueMark,
                  child: Row(children: [
                    ZineIconBadge(
                        icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), color: Zine.blue),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Back up to AvaTOK',
                            style: ZineText.cardTitle(size: 15.5, color: AvaDialTheme.text)),
                        const SizedBox(height: 2),
                        Text('Keep your contacts safe on AvaTOK — no Gmail needed.',
                            style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft)),
                      ]),
                    ),
                    Switch(
                      value: _enabled,
                      activeColor: Zine.blue,
                      onChanged: _toggle,
                    ),
                  ]),
                ),
                const SizedBox(height: 16),
                _stat('Contacts in your AvaTOK book', '$_count'),
                _stat('Last snapshot on this device', _lastLabel()),
                const SizedBox(height: 16),
                if (_enabled)
                  ZineButton(
                    label: 'Back up now',
                    variant: ZineButtonVariant.blue,
                    trailingIcon: false,
                    loading: _busy,
                    onPressed: _busy ? null : _backupNow,
                  ),
                const SizedBox(height: 20),
                Text('HOW IT WORKS', style: ZineText.kicker(color: AvaDialTheme.textMute)),
                const SizedBox(height: 8),
                _bullet('Your AvaTOK contact book merges your phone contacts with the '
                    'extra details you add in AvaTOK (AvaTOK number, emails, LinkedIn).'),
                _bullet('Backups are encrypted on AvaTOK\'s servers and restored with '
                    'your AvaTOK login — so a lost SIM or Google account can\'t lock '
                    'you out.'),
                _bullet('Restore on a new device — and the cloud upload itself — arrive '
                    'in the next update. For now your book is snapshotted safely on '
                    'this device.'),
              ],
            ),
    );
  }

  Widget _stat(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: ZineCard(
          color: AvaDialTheme.surface2,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          child: Row(children: [
            Expanded(child: Text(label, style: ZineText.value(size: 14, color: AvaDialTheme.text))),
            Text(value, style: ZineText.cardTitle(size: 14.5, color: Zine.blue)),
          ]),
        ),
      );

  Widget _bullet(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(top: 3, right: 10),
            child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: Zine.mint, size: 15),
          ),
          Expanded(child: Text(text, style: ZineText.sub(size: 13.5, color: AvaDialTheme.textSoft))),
        ]),
      );
}
