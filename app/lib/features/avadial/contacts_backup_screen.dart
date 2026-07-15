import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_contact_book.dart';
import 'avadial_theme.dart';
import 'contact_backup_role.dart';

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

  /// [AVADIAL-BACKUP-OWNER] How many of [_count] this account actually backs up.
  /// For a MASTER the two are equal. For a SUB (a second account on a shared
  /// phone) only their own AvaTOK contacts are theirs to back up, so this is
  /// smaller — and the screen must SAY so. Showing a sub "1,240 contacts" next to
  /// "backed up automatically" would be a straight lie: the phone book isn't in
  /// their backup and won't be there when they restore on a new phone.
  int _backedUp = 0;
  bool _isSub = false;

  /// [AVADIAL-BACKUP-MERGE] How many contacts are saved in the account right now,
  /// per the server. Since backups MERGE, this can legitimately exceed the number on
  /// this phone — e.g. contacts from an old handset that this one never had. Showing
  /// it is the honest way to explain why "Replace" would lose something.
  int _stored = 0;
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
    // Resolve the role FIRST: it may probe the server, and once it has, the result
    // is memoised so backupContacts() below costs nothing extra. Only claim "shared
    // phone" when we KNOW — an undecided role (null) must not render as sub, or an
    // offline second account would be told the phone book isn't theirs before we
    // have established that it isn't.
    final isSub = (await AvaContactBook.I.backupRole()) == ContactBackupRole.sub;
    final backedUp = (await AvaContactBook.I.backupContacts()).length;
    // Prefer the server's own timestamp when we can reach it (authoritative).
    final status = await AvaContactBook.I.serverStatus();
    if (status != null && status.updatedAt > 0) {
      lastCloud = DateTime.fromMillisecondsSinceEpoch(status.updatedAt);
    }
    if (!mounted) return;
    setState(() {
      _count = count;
      _backedUp = backedUp;
      _isSub = isSub;
      _stored = status?.count ?? 0;
      _lastCloud = lastCloud;
      _loading = false;
    });
  }

  /// [AVADIAL-BACKUP-MERGE] Plain manual backup. No warning, no confirmation, and
  /// nothing to be careful about: the server MERGES, so this can only ever add. The
  /// scary "Replace your backup?" dialog that used to guard this path moved to
  /// [_replaceBackup], which is the only thing that can still remove anything.
  Future<void> _backupNow() async {
    setState(() => _busy = true);
    // Capture the role for the message below. Null = we couldn't reach the server
    // to establish who owns this phone's book, which is a DIFFERENT failure from
    // "you have no contacts" and must not be reported as one.
    final role = await AvaContactBook.I.backupRole();
    final n = await AvaContactBook.I.uploadBackup(source: 'manual');
    Analytics.capture('avadial_contact_backup_now', {'count': _count, 'ok': n != null});
    await _load();
    if (mounted) {
      setState(() => _busy = false);
      // n == 0 means the upload was DECLINED, not that it backed up nothing:
      // [AvaContactBook.uploadBackup] still refuses to SEND an empty book. That
      // guard is now belt-and-braces rather than load-bearing (merge means an empty
      // upload couldn't delete anything anyway), but sending nothing and reporting
      // success would still be a lie. Never "Backed up 0 contacts" — that reads as
      // success and is the one message that would make a user with a revoked
      // contacts permission stop worrying.
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n == null
              ? "Couldn't back up — check your connection and try again"
              : n == 0
                  ? (role == null
                      // Undecided: we couldn't reach the server, so we refused to
                      // guess whether this phone's contacts are this account's to
                      // back up. Telling a user with 1,200 contacts to "open
                      // Contacts first" would send them to fix a permission that
                      // is perfectly fine.
                      ? "Couldn't check your account just now — try again when "
                          "you're back online"
                      : role == ContactBackupRole.sub
                          // A sub with nothing of their own isn't broken — there
                          // is genuinely nothing of theirs to save yet.
                          ? 'Nothing to back up yet — contacts you add in AvaTOK '
                              'will be saved to your account'
                          : 'Nothing to back up yet — open Contacts first so '
                              'AvaTOK can see your contact book')
                  : 'Backed up $n contacts to AvaTOK')));
    }
  }

  /// [AVADIAL-BACKUP-MERGE] The ONLY path that can remove anything from a backup.
  ///
  /// Merge means a backup can only grow — which is what the owner asked for, but it
  /// has a sharp edge: be the first to sign in on a borrowed or work handset and
  /// that phone's contacts merge into YOUR account permanently, with no way back.
  /// This is the way back. It is deliberately not a headline action — it sits below
  /// Restore, states exactly what will be lost, and defaults to Cancel.
  Future<void> _replaceBackup() async {
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: Text('Replace your backup?',
            style: ZineText.cardTitle(size: 17, color: AvaDialTheme.text)),
        content: Text(
          // $_backedUp, not $_count: a sub only ever uploads their OWN contacts, so
          // quoting the full local book would overstate what is about to be written
          // — and understate what is about to be lost. `_stored` is 0 when the
          // status call failed, so don't assert a number we don't have.
          (_stored > 0
                  ? 'Your AvaTOK account has $_stored contacts saved. This throws all '
                      'of them away'
                  : 'This throws away everything saved in your AvaTOK account') +
              " and saves this phone's $_backedUp instead.\n\n"
                  'Anything saved from another phone will be lost, and this cannot '
                  'be undone. Normal backups only ever add — you never need this '
                  'unless you want a clean start.',
          style: ZineText.sub(size: 13.5, color: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ZineText.value(size: 14, color: AD.iconSearch)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Replace', style: ZineText.value(size: 14, color: AD.danger)),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final n = await AvaContactBook.I.uploadBackup(source: 'manual_replace', replace: true);
    Analytics.capture('avadial_contact_backup_replaced',
        {'count': _backedUp, 'was': _stored, 'ok': n != null});
    await _load();
    if (mounted) {
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n == null || n == 0
              ? "Couldn't replace your backup — try again"
              : 'Your backup now holds $n contacts')));
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
                        Text(
                            'AvaTOK backs your contacts up every day, on its own — '
                            'no Gmail needed, nothing to switch on. Backups only '
                            'ever add, so nothing you saved is overwritten.',
                            style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft)),
                      ]),
                    ),
                  ]),
                ),
                const SizedBox(height: 16),
                _stat('Contacts in your AvaTOK book', '$_count'),
                if (_isSub) _stat('Backed up under your account', '$_backedUp'),
                // Since backups merge, the saved total can exceed what's on this
                // phone (contacts from an old handset it never had). Only shown
                // when it actually differs, so it explains itself rather than
                // raising a question nobody asked.
                if (_stored > _backedUp) _stat('Saved in your account', '$_stored'),
                _stat('Last backed up to AvaTOK', _lastLabel()),
                if (_isSub) ...[
                  const SizedBox(height: 12),
                  AdCard(
                    color: AvaDialTheme.surface2,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Shared phone',
                          style: ZineText.cardTitle(size: 14, color: AvaDialTheme.text)),
                      const SizedBox(height: 4),
                      Text(
                        "This phone's contacts belong to the account that set it up. "
                        'You can use them here, but only the contacts YOU add in '
                        'AvaTOK are saved to your account — those are the ones that '
                        'follow you to a new phone.',
                        style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft),
                      ),
                    ]),
                  ),
                ],
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
                _bullet('Backing up only ever ADDS. Your phone keeps its own copy, and '
                    'your saved copy keeps everything it already had — so a backup '
                    'from one phone can never wipe out another.'),
                _bullet('Your AvaTOK contact book merges your phone contacts with the '
                    'extra details you add in AvaTOK (AvaTOK number, emails, LinkedIn).'),
                _bullet('Backups are encrypted on AvaTOK\'s servers and restored with '
                    'your AvaTOK login — so a lost SIM or Google account can\'t lock '
                    'you out.'),
                _bullet('On a new phone, sign in and tap Restore — AvaTOK rebuilds the '
                    'contacts that aren\'t already there. Nothing is ever duplicated.'),
                // The escape hatch from merge-only: a backup can otherwise only
                // grow, so someone who was first to sign in on a borrowed handset
                // would carry its contacts forever. Kept plain text at the very
                // bottom — findable when wanted, never mistaken for "Back up now".
                // Always shown, never gated on `_stored > 0`: this is the ONLY way
                // out of a backup that can't be merged into (a blob that won't
                // decrypt → 409, or a merged book over the size cap → 413), and
                // `_stored` reads 0 whenever the status call fails — i.e. the escape
                // hatch would disappear in exactly the situations that need it.
                // Harmless when there's no backup: it just writes one.
                const SizedBox(height: 8),
                TextButton(
                  onPressed: (_busy || _restoring) ? null : _replaceBackup,
                  child: Text(
                    "Replace my backup with this phone's contacts",
                    style: ZineText.sub(size: 12.5, color: AvaDialTheme.textMute),
                  ),
                ),
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
