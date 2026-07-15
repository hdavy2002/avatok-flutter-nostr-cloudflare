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
/// ══ THE DANGEROUS PART: never shrink an existing backup ══════════════════════
/// Reclassifying a live user as a sub is DESTRUCTIVE. The server is latest-wins, so
/// the moment a sub uploads, its book replaces what's stored — and a sub's book
/// excludes the phone book. Call a real phone-owner a "sub" by mistake and their
/// backup of thousands of contacts is deleted on the next daily run. That is worse
/// than every problem this feature solves, so the whole design bends toward it:
///
///  1. **The grandfather test asks the SERVER, not this device.** The obvious
///     signal — "has this account uploaded before?" — is a local DiskCache value,
///     and it is wiped exactly when it matters most: [DiskCache.purgeAllCaches]
///     (the BAD_DECRYPT self-heal in main.dart, which fires after an OS restore or
///     device transfer — precisely the "everyone signs in again on one handset"
///     event) deletes every scope AND `_global`. Local memory would answer "no
///     prior backup" for someone who has thousands of contacts stored, and we'd
///     delete them. So we ASK the server.
///  2. **"Don't know" is not "no".** The probe is tri-state. A failed network call
///     must never read as "this account has no backup" — that is the same mistake
///     with extra steps. On [ContactBackupProbe.unknown] we return null, meaning
///     *undecided*, and the caller backs up NOTHING this run and retries later. A
///     skipped backup costs a day of freshness; a wrong "sub" costs the contacts.
///  3. **Grandfathering asks WHAT IS IN the backup, never WHEN it was made.** The
///     server reports `deviceCount` — how many stored contacts came from a
///     handset's address book. Own a full book (`deviceCount > 0`) and you are a
///     master, full stop. A timestamp test was tried first and is a trap, twice
///     over: (i) the epoch would be a LOCAL clock compared against the SERVER's,
///     and a device a few minutes slow would read a real owner's fresh backup as
///     "newer than the rule" → sub → deleted; (ii) it breaks anyone with TWO
///     phones — back up on your own phone in the morning, sign into a company
///     phone at noon, and your backup looks brand new, so you'd be called a sub
///     and your real book destroyed. Contents answer the question the rule is
///     actually asking; clocks only correlate with it.
///  4. **`deviceCount == null` means MASTER.** Null is what the server returns for
///     a book written before this rule shipped — and every such book contains the
///     whole phone book, because sub filtering did not exist when it was written.
///     Null is emphatically not zero: zero authorises a shrink, null forbids it.
///  5. **Every failure path returns master.** Master re-uploads what it already
///     had; sub deletes. The risk is not symmetric, so never guess "sub".
///
/// The whole rule in one line: **if your stored backup already contains phone-book
/// contacts, nothing about your backup changes; only an account with no phone-book
/// contacts of its own can be made a sub.** An account classed sub therefore has,
/// by construction, nothing to lose.
///
/// ══ SCOPE — what this does NOT fix ═══════════════════════════════════════════
/// Read the rule above literally: EVERY account that has ever backed up a phone
/// book, from any handset, is a master everywhere, forever. So on a shared phone
/// that is already in use, this changes NOTHING — all twenty existing users remain
/// masters, each still uploading the whole company address book, and a leaver still
/// restores it. Only accounts with NO prior backup are ever made subs. That is not
/// an edge case, it is the majority case for the existing install base, and it is
/// the deliberate price of rule #1: the only way to retrofit sub status onto an
/// established account is to shrink its stored book, which is a deletion.
///
/// So this closes the leak GOING FORWARD (new accounts on already-owned phones)
/// and leaves existing accounts exactly as they are. Genuinely fixing the existing
/// population needs a non-destructive server-side migration — splitting each stored
/// book into "device-owned" and "account-owned" halves so a shrink isn't a loss —
/// which is a much larger change and is not attempted here.
///
/// KNOWN LIMITATION (rare, not data loss): [DiskCache.purgeAllCaches] — the
/// BAD_DECRYPT self-heal in main.dart — wipes `_kMasterUid` AND every cached role.
/// If another account then reaches the shell first and claims the handset, a real
/// owner whose last upload happened to contain no device contacts (READ_CONTACTS
/// not granted at the time) probes `present, deviceCount == 0` → sub, cached
/// permanently, with no re-evaluation path. Their stored book has no device
/// contacts either, so nothing is deleted — but if they later grant contacts
/// permission, their address book silently never backs up. Recovering needs the
/// role cache cleared (reinstall today).
enum ContactBackupRole {
  /// Owns the phone book: backs up device contacts + their own additions.
  master,

  /// Backs up only the contacts they created in AvaTOK.
  sub,
}

/// Tri-state answer to "does this account already have a server-side backup?".
/// [unknown] is load-bearing — see the class docs on [ContactBackupRoles].
enum ContactBackupProbe { unknown, absent, present }

/// What the server knows about an account's stored book.
///
/// [deviceCount] is nullable and the null is meaningful: it means the stored book
/// predates the master/sub rule and therefore contains the full phone book. Only a
/// definite `0` — the server telling us the book holds no handset contacts at all —
/// permits this account to be made a sub.
typedef ContactBackupProbeResult = ({ContactBackupProbe state, int? deviceCount});

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

  /// Per-account, account-scoped: the decision, cached so the common path costs no
  /// network. Losing this cache is safe — the server's `deviceCount` re-derives the
  /// same answer (a sub's own uploads never contain device contacts, so it stays a
  /// sub; a master's book always does, so it stays a master).
  static const String _kRole = 'contacts_backup_role';

  ContactBackupRole? _memo;
  String? _memoScope;

  /// The active account's role, claiming master for this handset if unclaimed.
  ///
  /// Returns NULL when it cannot safely decide (the server is unreachable and this
  /// account might have a pre-existing backup). A null role means **back up
  /// nothing this run** — never "assume sub". Callers must treat it that way.
  ///
  /// [probe] answers "does this account already have a server backup, and does it
  /// contain phone-book contacts?". Injected rather than imported so this file
  /// stays free of a dependency cycle with ava_contact_book.dart.
  Future<ContactBackupRole?> resolve({
    required Future<ContactBackupProbeResult> Function() probe,
  }) async {
    final scope = AccountScope.id ?? '';
    if (_memo != null && _memoScope == scope) return _memo!;

    final role = await _resolve(probe: probe);
    if (role != null) {
      _memo = role;
      _memoScope = scope;
    }
    return role;
  }

  Future<ContactBackupRole?> _resolve({
    required Future<ContactBackupProbeResult> Function() probe,
  }) async {
    try {
      final uid = AccountScope.id;
      // No signed-in account (guest): nothing is uploaded in this state anyway.
      // Master is a claim over a real account's backup, so don't let a guest make
      // it — a guest claiming the handset would make the actual owner a sub.
      if (uid == null || uid.isEmpty) return ContactBackupRole.master;

      final cached = await DiskCache.read(_kRole);
      // DiskCache resolves its scope AT AWAIT TIME, so a switch landing during that
      // read returns the ARRIVING account's role. Returning it to a caller acting
      // for `uid` is how a master ends up behaving like a sub. Same guard as before
      // the write below.
      if (AccountScope.id != uid) return null;
      if (cached == 'sub') return ContactBackupRole.sub;
      if (cached == 'master') return ContactBackupRole.master;

      final master = await DiskCache.readGlobal(_kMasterUid);

      ContactBackupRole role;
      bool grandfathered = false;
      if (master == null || master.isEmpty) {
        // Unclaimed handset — first account in wins.
        await DiskCache.writeGlobal(_kMasterUid, uid);
        role = ContactBackupRole.master;
      } else if (master == uid) {
        role = ContactBackupRole.master;
      } else {
        // Someone else owns this handset's phone book. Before we dare call this
        // account a sub, the SERVER must confirm it has nothing to lose.
        final p = await probe();
        if (p.state == ContactBackupProbe.unknown) {
          AvaLog.I.log('avadial',
              'contact backup role UNDECIDED (server unreachable) — backing up nothing this run');
          Analytics.capture('avadial_contact_backup_role_undecided', const {});
          return null;
        }
        // Grandfather on CONTENTS: a stored book with phone-book contacts (or one
        // whose deviceCount is null — written before this rule existed, so it holds
        // the full book) belongs to a master and must never shrink. Only a definite
        // 0, or no backup at all, permits sub.
        grandfathered = p.state == ContactBackupProbe.present &&
            (p.deviceCount == null || p.deviceCount! > 0);
        role = grandfathered ? ContactBackupRole.master : ContactBackupRole.sub;
      }

      // The awaits above (DiskCache + a network probe) are long enough for an
      // account switch to land underneath us. DiskCache resolves its scope AT AWAIT
      // TIME, so writing now would stamp THIS decision into the ARRIVING account's
      // store — and pinning 'sub' onto a master deletes their backup. Bail; the
      // next call re-derives cleanly for whoever is actually active.
      if (AccountScope.id != uid) {
        AvaLog.I.log('avadial', 'contact backup role: account switched mid-resolve — discarding');
        return null;
      }

      await DiskCache.write(_kRole, role == ContactBackupRole.sub ? 'sub' : 'master');
      AvaLog.I.log('avadial',
          'contact backup role resolved: ${role.name} (masterClaimed=${master != null}, grandfathered=$grandfathered)');
      Analytics.capture('avadial_contact_backup_role_resolved', {
        'role': role.name,
        'grandfathered': grandfathered,
        'claimed_master': master == null || master.isEmpty,
      });
      return role;
    } catch (e) {
      // Fail to MASTER, never to sub: a sub uploads a reduced book, and on a
      // latest-wins server a reduced book is a deletion. An error must never be
      // able to shrink somebody's backup. Not cached — we'll retry next time.
      AvaLog.I.log('avadial', 'contact backup role resolve failed ($e) — defaulting to master');
      return ContactBackupRole.master;
    }
  }

  /// Drop the in-memory memo so the next read re-derives for the new account.
  /// Called on account switch; the persisted decision itself is untouched.
  void onAccountSwitched() {
    _memo = null;
    _memoScope = null;
  }
}
