import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_contact_book.dart';
import 'avadial_theme.dart';

/// "Contacts backup" screen (owner request 2026-07-13). Shows the state of the
/// user's AvaTOK contact-book backup — held on AvaTOK's own servers, independent
/// of Google/Gmail, so a lost account or SIM never loses their contacts.
///
/// Upload AND restore are LIVE (server-side encrypted, R2-backed). Restore runs as
/// a resumable, batched, paginated job (see [AvaContactBook.restoreBackup]) with
/// live progress, so restoring thousands of contacts never freezes the app.
///
/// [AVADIAL-BACKUP-DAILY 2026-07-15] The opt-in SWITCH IS GONE. Backup now runs
/// automatically — a ~24h WorkManager job (contacts_daily_backup.dart) plus the
/// change-triggered sync on the Contacts tab — regardless of any user setting
/// (owner decision: people turned it off, then couldn't get their contacts back on
/// a new device). Leaving a dead switch on screen would have told the user they
/// controlled something they no longer control, so this screen now simply STATES
/// what happens. Manual "Back up now" stays: automatic ≠ on demand, and a user
/// about to wipe their phone wants a fresh backup this second, not tonight.
class ContactsBackupScreen extends StatefulWidget {
  const ContactsBackupScreen({super.key});

  @override
  State<ContactsBackupScreen> createState() => _ContactsBackupScreenState();
}

class _ContactsBackupScreenState extends State<ContactsBackupScreen> {
  int _count = 0;
  DateTime? _lastCloud;
  bool _loading = true;
  bool _busy = false;
  bool _restoring = false;
  int _rDone = 0; // restore progress: contacts processed
  int _rTotal = 0; // restore progress: total (0 until the server reports it)

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'contacts_backup');
    _load();
  }

  Future<void> _load() async {
    final count = await AvaContactBook.I.count();
    var lastCloud = await ContactBackupPrefs.I.lastServerSync();
    // Prefer the server's own timestamp when we can reach it (authoritative).
    final status = await AvaContactBook.I.serverStatus();
    if (status != null && status.updatedAt > 0) {
      lastCloud = DateTime.fromMillisecondsSinceEpoch(status.updatedAt);
    }
    if (!mounted) return;
    setState(() {
      _count = count;
      _lastCloud = lastCloud;
      _loading = false;
    });
  }

  Future<void> _backupNow() async {
    setState(() => _busy = true);
    final n = await AvaContactBook.I.uploadBackup(source: 'manual');
    Analytics.capture('avadial_contact_backup_now', {'count': _count, 'ok': n != null});
    await _load();
    if (mounted) {
      setState(() => _busy = false);
      // n == 0 means the upload was DECLINED, not that it backed up nothing:
      // [AvaContactBook.uploadBackup] refuses to send an empty book because the
      // server is latest-wins and `[]` would wipe a real backup. The honest thing
      // to say is that there was nothing to send — never "Backed up 0 contacts",
      // which reads as success and is the one message that would make a user with
      // a revoked contacts permission stop worrying.
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n == null
              ? "Couldn't back up — check your connection and try again"
              : n == 0
                  ? 'Nothing to back up yet — open Contacts first so AvaTOK can '
                      'see your contact book'
                  : 'Backed up $n contacts to AvaTOK')));
    }
  }

  Future<void> _restore() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: Text('Restore contacts?', style: ZineText.cardTitle(size: 17, color: AvaDialTheme.text)),
        content: Text(
          'This adds contacts from your AvaTOK backup that aren\'t already on this '
          'phone. Existing contacts are left as they are.',
          style: ZineText.sub(size: 13.5, color: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ZineText.value(size: 14, color: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Restore', style: ZineText.value(size: 14, color: AD.iconSearch)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() {
      _restoring = true;
      _rDone = 0;
      _rTotal = 0;
    });
    final n = await AvaContactBook.I.restoreBackup(onProgress: (done, total) {
      if (mounted) setState(() {
        _rDone = done;
        _rTotal = total;
      });
    });
    Analytics.capture('avadial_contact_restore', {'restored': n ?? -1});
    await _load();
    if (mounted) {
      setState(() => _restoring = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n == null
              ? "Couldn't restore — check your connection and try again"
              : n == 0
                  ? 'No AvaTOK backup found yet'
                  : 'Restored $n contacts to this phone')));
    }
  }

  String _lastLabel() {
    final d = _lastCloud;
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
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        title: Text('Contacts backup', style: ZineText.appbar(color: AvaDialTheme.text)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                AdCard(
                  color: AD.card,
                  child: Row(children: [
                    ZineIconBadge(
                        icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), color: AD.iconSearch),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Backed up automatically',
                            style: ZineText.cardTitle(size: 15.5, color: AvaDialTheme.text)),
                        const SizedBox(height: 2),
                        Text('AvaTOK backs your contacts up every day, on its own — '
                            'no Gmail needed, nothing to switch on.',
                            style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft)),
                      ]),
                    ),
                  ]),
                ),
                const SizedBox(height: 16),
                _stat('Contacts in your AvaTOK book', '$_count'),
                _stat('Last backed up to AvaTOK', _lastLabel()),
                const SizedBox(height: 16),
                AdButton(
                  label: 'Back up now',
                  variant: AdButtonVariant.teal,
                  trailingIcon: false,
                  loading: _busy,
                  onPressed: (_busy || _restoring) ? null : _backupNow,
                ),
                const SizedBox(height: 10),
                AdButton(
                  label: 'Restore from AvaTOK',
                  variant: AdButtonVariant.ghost,
                  trailingIcon: false,
                  loading: _restoring,
                  onPressed: (_busy || _restoring) ? null : _restore,
                ),
                if (_restoring)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(
                      _rTotal > 0
                          ? 'Restoring… $_rDone of $_rTotal contacts'
                          : (_rDone > 0
                              ? 'Restoring… $_rDone contacts'
                              : 'Preparing your backup…'),
                      style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft),
                    ),
                  ),
                const SizedBox(height: 20),
                Text('HOW IT WORKS', style: ZineText.kicker(color: AvaDialTheme.textMute)),
                const SizedBox(height: 8),
                _bullet('AvaTOK backs your contacts up once a day by itself, and again '
                    'whenever you change one. Tap Back up now if you want it done '
                    'this second.'),
                _bullet('Your AvaTOK contact book merges your phone contacts with the '
                    'extra details you add in AvaTOK (AvaTOK number, emails, LinkedIn).'),
                _bullet('Backups are encrypted on AvaTOK\'s servers and restored with '
                    'your AvaTOK login — so a lost SIM or Google account can\'t lock '
                    'you out.'),
                _bullet('On a new phone, sign in and tap Restore — AvaTOK rebuilds the '
                    'contacts that aren\'t already there. Nothing is ever duplicated.'),
              ],
            ),
    );
  }

  Widget _stat(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: AdCard(
          color: AvaDialTheme.surface2,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          child: Row(children: [
            Expanded(child: Text(label, style: ZineText.value(size: 14, color: AvaDialTheme.text))),
            Text(value, style: ZineText.cardTitle(size: 14.5, color: AD.iconSearch)),
          ]),
        ),
      );

  Widget _bullet(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(top: 3, right: 10),
            child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.online, size: 15),
          ),
          Expanded(child: Text(text, style: ZineText.sub(size: 13.5, color: AvaDialTheme.textSoft))),
        ]),
      );
}
