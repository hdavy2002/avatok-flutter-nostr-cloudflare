
import '../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_contact_book.dart';
import 'avadial_theme.dart';
import 'contact_backup_role.dart';
import '../../core/ui/messenger_theme.dart';

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
    // The role decides the wording when there's nothing to send: for a sub that's
    // normal, for a master it means we can't see their contacts.
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
              ? uiCopy(UiMessage.m_couldn_t_back_up_check_cdd8dd5a55)
              : n == 0
                  ? (role == ContactBackupRole.sub
                      // A sub with nothing of their own isn't broken — there is
                      // genuinely nothing of theirs to save yet.
                      ? uiCopy(UiMessage.m_nothing_to_back_up_yet_ac1f35ff0d)
                      : uiCopy(UiMessage.m_nothing_to_back_up_yet_795b393907))
                  : uiCopy(UiMessage.m_backed_up_n_contacts_to_c62bce1711, {'n': (n).toString()}))));
    }
  }

  /// [AVADIAL-BACKUP-OWNER] "This is my phone" — take ownership of the handset.
  ///
  /// The escape hatch for automatic, silent role assignment (owner decision: no
  /// prompt). On a phone that was already shared before this shipped, the handset
  /// goes to whoever opens the app first — which may be the child, not the parent.
  /// Without this the real owner would just silently stop backing up new phone
  /// contacts. Safe to hand to anyone: it deletes nothing, and the previous owner
  /// can take it straight back.
  Future<void> _claimPhone() async {
    await ContactBackupRoles.I.claimMaster();
    await _load();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: UiText(UiMessage.m_this_phone_is_now_yours_a29970ce44)));
  }

  /// [AVADIAL-BACKUP-OWNER] Remove the shared handset's contacts from THIS account's
  /// backup — the retrofit for someone who was using a phone that isn't theirs.
  ///
  /// Surgical, unlike [_replaceBackup]: it drops only the contacts that came from a
  /// phone's address book and keeps this account's own AvaTOK contacts, including
  /// any saved from an older handset that this phone never had. It is still a
  /// DELETION, so it only ever runs from this explicit, warned tap — never inferred
  /// from a sub role, because a role we merely guessed would take a real owner's
  /// address book with it.
  Future<void> _pruneBorrowed() async {
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: UiText(UiMessage.m_remove_this_phone_s_contacts_1a87ce9740,
            style: AvaDialTheme.title(size: 17, color: AvaDialTheme.text)),
        content: UiText(
          UiMessage.m_your_backup_keeps_the_backedup_34a9205809, params: {'backedUp': (_backedUp).toString()},
          style: AvaDialTheme.sub(size: 13, color: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: UiText(UiMessage.m_cancel_19766ed6cc, style: AvaDialTheme.value(size: 14, color: AD.iconSearch)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: UiText(UiMessage.m_remove_c3812fc4ac, style: AvaDialTheme.value(size: 14, color: AD.danger)),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final n = await AvaContactBook.I.uploadBackup(source: 'manual_prune', mode: 'prune_device');
    Analytics.capture('avadial_contact_backup_pruned', {'was': _stored, 'ok': n != null});
    await _load();
    if (mounted) {
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n == null
              ? uiCopy(UiMessage.m_couldn_t_update_your_backup_c6d5497a1f)
              : uiCopy(UiMessage.m_your_backup_now_holds_only_47d6feb761, {'n': (n).toString()}))));
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
        title: UiText(UiMessage.m_replace_your_backup_086efa3ce9,
            style: AvaDialTheme.title(size: 17, color: AvaDialTheme.text)),
        content: Text(
          // $_backedUp, not $_count: a sub only ever uploads their OWN contacts, so
          // quoting the full local book would overstate what is about to be written
          // — and understate what is about to be lost. `_stored` is 0 when the
          // status call failed, so don't assert a number we don't have.
          (_stored > 0
                  ? uiCopy(UiMessage.m_your_avatok_account_has_stored_ec23cc315c, {'stored': (_stored).toString()})
                  : uiCopy(UiMessage.m_this_throws_away_everything_saved_db819dfa99)) +
              " and saves this phone's $_backedUp instead.\n\n"
                  'Anything saved from another phone will be lost, and this cannot '
                  'be undone. Normal backups only ever add — you never need this '
                  'unless you want a clean start.',
          style: AvaDialTheme.sub(size: 13, color: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: UiText(UiMessage.m_cancel_19766ed6cc, style: AvaDialTheme.value(size: 14, color: AD.iconSearch)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: UiText(UiMessage.m_replace_95e154398a, style: AvaDialTheme.value(size: 14, color: AD.danger)),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final n = await AvaContactBook.I.uploadBackup(source: 'manual_replace', mode: 'replace');
    Analytics.capture('avadial_contact_backup_replaced',
        {'count': _backedUp, 'was': _stored, 'ok': n != null});
    await _load();
    if (mounted) {
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n == null || n == 0
              ? uiCopy(UiMessage.m_couldn_t_replace_your_backup_ab19e05012)
              : uiCopy(UiMessage.m_your_backup_now_holds_n_e2d05c2e3a, {'n': (n).toString()}))));
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
        title: UiText(UiMessage.m_restore_contacts_631be75666, style: AvaDialTheme.title(size: 17, color: AvaDialTheme.text)),
        content: UiText(
          UiMessage.m_this_adds_contacts_from_your_b3cd2eae92,
          style: AvaDialTheme.sub(size: 13, color: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: UiText(UiMessage.m_cancel_19766ed6cc, style: AvaDialTheme.value(size: 14, color: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: UiText(UiMessage.m_restore_a76e13b983, style: AvaDialTheme.value(size: 14, color: AD.iconSearch)),
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
              ? uiCopy(UiMessage.m_couldn_t_restore_check_your_3818a63b06)
              : n == 0
                  ? uiCopy(UiMessage.m_no_avatok_backup_found_yet_2f48f2bdcd)
                  : uiCopy(UiMessage.m_restored_n_contacts_to_this_23ec421ea9, {'n': (n).toString()}))));
    }
  }

  String _lastLabel() {
    final d = _lastCloud;
    if (d == null) return 'Never';
    return '${d.day}/${d.month}/${d.year} · ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        title: UiText(UiMessage.m_contacts_backup_86cadcc4ba, style: AvaDialTheme.title(size: 22, color: AvaDialTheme.text)),
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
                        UiText(UiMessage.m_backed_up_automatically_6624e80b04,
                            style: AvaDialTheme.title(size: 15, color: AvaDialTheme.text)),
                        const SizedBox(height: 2),
                        UiText(
                            UiMessage.m_avatok_backs_your_contacts_up_9e95ba4e6c,
                            style: AvaDialTheme.sub(size: 12, color: AvaDialTheme.textSoft)),
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
                      UiText(UiMessage.m_shared_phone_e05ad9a2d6,
                          style: AvaDialTheme.title(size: 14, color: AvaDialTheme.text)),
                      const SizedBox(height: 4),
                      UiText(
                        UiMessage.m_this_phone_s_contacts_belong_815ca93707,
                        style: AvaDialTheme.sub(size: 12, color: AvaDialTheme.textSoft),
                      ),
                      // Both escape hatches live here, on the one card a
                      // wrongly-classed owner would actually be looking at.
                      const SizedBox(height: 4),
                      Row(children: [
                        TextButton(
                          onPressed: _busy ? null : _claimPhone,
                          style: TextButton.styleFrom(padding: EdgeInsets.zero),
                          child: UiText(UiMessage.m_this_is_my_phone_26920b733b,
                              style: AvaDialTheme.value(size: 13, color: AD.iconSearch)),
                        ),
                        const SizedBox(width: 12),
                        if (_stored > _backedUp)
                          TextButton(
                            onPressed: _busy ? null : _pruneBorrowed,
                            style: TextButton.styleFrom(padding: EdgeInsets.zero),
                            child: UiText(UiMessage.m_remove_its_contacts_from_my_f3f43255a3,
                                style: AvaDialTheme.value(size: 13, color: AD.iconSearch)),
                          ),
                      ]),
                    ]),
                  ),
                ],
                const SizedBox(height: 16),
                AdButton(
                  label: uiCopy(UiMessage.m_back_up_now_02a2840b59),
                  variant: AdButtonVariant.teal,
                  trailingIcon: false,
                  loading: _busy,
                  onPressed: (_busy || _restoring) ? null : _backupNow,
                ),
                const SizedBox(height: Msg.s2),
                AdButton(
                  label: uiCopy(UiMessage.m_restore_from_avatok_69bff70aa8),
                  variant: AdButtonVariant.ghost,
                  trailingIcon: false,
                  loading: _restoring,
                  onPressed: (_busy || _restoring) ? null : _restore,
                ),
                if (_restoring)
                  Padding(
                    padding: const EdgeInsets.only(top: Msg.s3),
                    child: Text(
                      _rTotal > 0
                          ? uiCopy(UiMessage.m_restoring_rdone_of_rtotal_contacts_7d877882f5, {'rDone': (_rDone).toString(), 'rTotal': (_rTotal).toString()})
                          : (_rDone > 0
                              ? uiCopy(UiMessage.m_restoring_rdone_contacts_c2392e90f0, {'rDone': (_rDone).toString()})
                              : uiCopy(UiMessage.m_preparing_your_backup_9174795f8b)),
                      style: AvaDialTheme.sub(size: 12, color: AvaDialTheme.textSoft),
                    ),
                  ),
                const SizedBox(height: Msg.s4),
                UiText(UiMessage.m_how_it_works_9c870aa6e5, style: AvaDialTheme.tag(size: 11, color: AvaDialTheme.textMute)),
                const SizedBox(height: 8),
                _bullet('AvaTOK backs your contacts up once a day by itself, and again '
                    'whenever you change one. Tap Back up now if you want it done '
                    'this second.'),
                _bullet('Backing up only ever ADDS. Your phone keeps its own copy, and '
                    'your saved copy keeps everything it already had — so a backup '
                    'from one phone can never wipe out another.'),
                _bullet('Your AvaTOK contact book merges your phone contacts with the '
                    'extra details you add in AvaTOK (Saathum number, emails, LinkedIn).'),
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
                  child: UiText(
                    UiMessage.m_replace_my_backup_with_this_9d230e68cc,
                    style: AvaDialTheme.sub(size: 12, color: AvaDialTheme.textMute),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _stat(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: Msg.s2),
        child: AdCard(
          color: AvaDialTheme.surface2,
          padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s4),
          child: Row(children: [
            Expanded(child: Text(label, style: AvaDialTheme.value(size: 14, color: AvaDialTheme.text))),
            Text(value, style: AvaDialTheme.title(size: 14, color: AD.iconSearch)),
          ]),
        ),
      );

  Widget _bullet(String text) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(top: Msg.s1, right: Msg.s3),
            child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.online, size: 15),
          ),
          Expanded(child: Text(text, style: AvaDialTheme.sub(size: 13, color: AvaDialTheme.textSoft))),
        ]),
      );
}
