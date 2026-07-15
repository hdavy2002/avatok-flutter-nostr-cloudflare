import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import '../../identity/identity.dart';

/// WHO OWNS THE PHONE BOOK (owner decision 2026-07-15, [AVADIAL-BACKUP-OWNER]).
///
/// The problem: one handset is routinely shared — a company phone, a family
/// phone. Every account signed in on it sees the SAME Android address book, so
/// today every account backs up that same phone book under its own name. Twenty
/// users on one phone meant twenty copies, and worse: when someone left and
/// restored on their own device they walked away with the phone's ENTIRE address
/// book, including contacts that were never theirs.
///
/// The rule the owner chose:
///   • MASTER — the first account to use AvaTOK on this phone. Treated as the
///     phone's owner: the device phone book is theirs, so their backup holds the
///     phone book PLUS anything they add, and they restore in full on a new device.
///   • SUB — every account after that. They can freely USE the phone book (it's on
///     the device; that's Android, not us), but only the contacts THEY create in
///     AvaTOK are backed up under their name. Leave, restore elsewhere, and you get
///     your own contacts and nothing else.
///
/// Sub status is AUTOMATIC on second sign-in (owner decision): no allowlist, no
/// admin approval, no Sub Account screen. An earlier proposal had the master
/// approve emails before anyone else could sign in; it was dropped because it locks
/// people out of phones they own — the buyer of a SECOND-HAND phone would be told
/// to go ask the stranger who sold it to them, forever. Role affects BACKUP only.
/// It never gates sign-in and never restricts what anyone can do on the device.
///
/// ══ WHY THIS IS NOW SIMPLE (and was not, until 2026-07-15) ═══════════════════
/// This class used to carry an elaborate "grandfathering" system: any account whose
/// stored backup already held phone-book contacts was FORCED to stay a master, a
/// tri-state server probe decided it, and an unreachable server meant "undecided —
/// back up nothing". All of that existed for ONE reason: the server was
/// latest-wins, so a sub's smaller upload REPLACED its stored book and deleted the
/// phone book inside it. Mislabel a real owner and you destroyed their contacts.
///
/// [AVADIAL-BACKUP-MERGE] removed that: uploads now MERGE, so an account that stops
/// uploading the phone book simply stops ADDING it — whatever is stored stays put.
/// Being wrong about a role can no longer delete anything, so the machinery that
/// existed to be right about it is gone. The rule is now just: **you are the master
/// iff you claimed this handset.**
///
/// The cost of being wrong is now much smaller, but not zero: a real owner
/// mis-identified as a sub silently stops backing up NEW phone contacts (the ones
/// already stored are safe). That is why [claimMaster] exists — the "This is my
/// phone" button on the backup screen. Owner decision 2026-07-15: assignment is
/// automatic and silent (first claimer wins, no prompt — an earlier "Is this your
/// phone?" question was declined), so this button is the only escape, and on an
/// ALREADY-SHARED handset the claim genuinely is arbitrary: whoever opens the app
/// first after the update wins, and it may well be the child rather than the parent.
///
/// ══ What this does and does not fix for EXISTING shared phones ═══════════════
/// Stops the bleeding, automatically: a sub adds no more phone-book contacts.
/// Does NOT clean up what is already there — those months of uploads sit in the
/// backup, and removing them is a DELETION. That only ever happens on an explicit
/// tap (`mode:'prune_device'`, the "Remove the contacts that came from this shared
/// phone" action). Never automatically: silently pruning device contacts from an
/// account we merely GUESSED was a sub would delete a real owner's address book —
/// the precise disaster merge was introduced to end.
enum ContactBackupRole {
  /// Owns the phone book: backs up device contacts + their own additions.
  master,

  /// Backs up only the contacts they created in AvaTOK.
  sub,
}

// [AVADIAL-BACKUP-MERGE] `ContactBackupProbe` / `ContactBackupProbeResult` are GONE.
// They existed so grandfathering could ask the server "does this account already own
// a full phone book that a sub-sized upload would delete?" — a question that only
// mattered while uploads replaced. Merge answered it permanently: nothing a role
// decision does can delete a stored contact, so there is nothing to ask.

/// Resolves and remembers whether the ACTIVE account owns this phone's book.
class ContactBackupRoles {
  ContactBackupRoles._();
  static final ContactBackupRoles I = ContactBackupRoles._();

  /// Device-level (NOT account-scoped, by design — it describes the HANDSET, the
  /// same class of exception as the Clerk client token). Survives logout, so a
  /// master who signs out and back in is still the master. Cleared by an uninstall,
  /// a factory reset, or [DiskCache.purgeAllCaches] — which is what lets a wiped
  /// second-hand phone behave like a new one: the next person to sign in claims it.
  static const String _kMasterUid = 'contacts_backup_master_uid';

  // [AVADIAL-BACKUP-MERGE] The per-account `_kRole` cache is GONE. It existed to
  // freeze a grandfathering verdict that was expensive (a network probe) and
  // point-in-time. The role is now a one-line function of `_kMasterUid`, so caching
  // it would only create a second source of truth that could disagree with the
  // first — and that disagreement is what pins the wrong role onto an account.

  ContactBackupRole? _memo;
  String? _memoScope;

  /// The active account's role, claiming this handset if nobody has.
  ///
  /// Cheap and local: no network, and no "undecided" state to handle — being wrong
  /// can no longer delete anything now that uploads merge (see the class docs).
  Future<ContactBackupRole> resolve() async {
    final scope = AccountScope.id ?? '';
    if (_memo != null && _memoScope == scope) return _memo!;

    final role = await _resolve();
    // Only memoise once we're sure the scope didn't shift under us mid-resolve;
    // memoising the departing account's role under the arriving one's scope is how
    // a master starts behaving like a sub.
    if ((AccountScope.id ?? '') == scope) {
      _memo = role;
      _memoScope = scope;
    }
    return role;
  }

  Future<ContactBackupRole> _resolve() async {
    try {
      final uid = AccountScope.id;
      // No signed-in account (guest): nothing is uploaded in this state anyway.
      // Master is a claim over a real account's backup, so don't let a guest make
      // it — a guest claiming the handset would make the actual owner a sub.
      if (uid == null || uid.isEmpty) return ContactBackupRole.master;

      final master = await DiskCache.readGlobal(_kMasterUid);
      if (master == null || master.isEmpty) {
        // Unclaimed handset — first account in wins. Re-check the scope first: the
        // await above is long enough for an account switch to land, and claiming
        // the handset for whoever is NO LONGER active would hand it to the wrong
        // person permanently.
        if (AccountScope.id != uid) return ContactBackupRole.master;
        await DiskCache.writeGlobal(_kMasterUid, uid);
        AvaLog.I.log('avadial', 'contact backup: handset claimed by $uid');
        Analytics.capture('avadial_contact_backup_role_resolved',
            {'role': 'master', 'claimed_master': true});
        return ContactBackupRole.master;
      }

      final role = master == uid ? ContactBackupRole.master : ContactBackupRole.sub;
      Analytics.capture('avadial_contact_backup_role_resolved',
          {'role': role.name, 'claimed_master': false});
      return role;
    } catch (e) {
      // Fail to MASTER. The stakes are far lower than they were (merge means a sub
      // can't delete), but a wrong "sub" still silently stops backing up someone's
      // phone book, while a wrong "master" only backs up more than it strictly
      // should. Still asymmetric, still err the same way.
      AvaLog.I.log('avadial', 'contact backup role resolve failed ($e) — defaulting to master');
      return ContactBackupRole.master;
    }
  }

  /// Take ownership of this handset for the ACTIVE account — the "This is my phone"
  /// button.
  ///
  /// The escape hatch for the one thing automatic assignment gets wrong: on a phone
  /// that was already shared before this shipped, the handset goes to whoever opens
  /// the app first, which may not be its owner. Without this they'd silently stop
  /// backing up new phone contacts with no way to say otherwise (the owner declined
  /// a prompt, so a button it is).
  ///
  /// Deliberately unguarded — anyone signed in on the handset may claim it. There is
  /// nothing to protect: the previous master's stored contacts are untouched (merge
  /// never deletes), they simply stop adding new device contacts, and they can claim
  /// it straight back with the same button.
  Future<void> claimMaster() async {
    final uid = AccountScope.id;
    if (uid == null || uid.isEmpty) return;
    final prev = await DiskCache.readGlobal(_kMasterUid);
    if (AccountScope.id != uid) return; // switched mid-call
    await DiskCache.writeGlobal(_kMasterUid, uid);
    _memo = ContactBackupRole.master;
    _memoScope = uid;
    AvaLog.I.log('avadial', 'contact backup: handset re-claimed by $uid (was $prev)');
    Analytics.capture('avadial_contact_backup_master_claimed', {'had_master': prev != null});
  }

  /// Drop the in-memory memo so the next read re-derives for the new account.
  void onAccountSwitched() {
    _memo = null;
    _memoScope = null;
  }
}
