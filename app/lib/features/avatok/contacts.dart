import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/api_backoff.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import '../../core/vault.dart';
import '../../core/account_key.dart';
import '../../identity/identity.dart' show AccountScope, Identity;

/// A saved AvaTok contact. `uid` holds the routing id (Clerk uid). Handles are
/// retired — the network identity shown is the AvaTOK number (or real phone).
@immutable
class Contact {
  final String uid;
  final String name;
  final String handle; // DEPRECATED (handles retired); kept for cache back-compat
  final String email;
  final String avatarUrl; // canonical blossom URL of their photo ('' = initials)
  final String phone; // E.164 (WhatsApp-style phone contacts) — '' if unknown
  final String number; // AvaTOK number display, e.g. '+233 24 555 0148' — '' if none
  const Contact({required this.uid, required this.name, this.handle = '', this.email = '', this.avatarUrl = '', this.phone = '', this.number = ''});

  /// [ISSUE-CONTACT-AVATAR-1] Field-preserving copy. Rebuilding a Contact with the
  /// positional-ish `Contact(uid:…, name:…, avatarUrl:…)` form silently DROPS every
  /// field the caller forgot — `phone` and `number` both default to ''. That is how
  /// the avatar backfill was erasing AvaTOK numbers (see refreshMissingAvatars).
  /// Always copyWith when you mean "same contact, one field changed".
  Contact copyWith({String? uid, String? name, String? handle, String? email,
          String? avatarUrl, String? phone, String? number}) =>
      Contact(
        uid: uid ?? this.uid,
        name: name ?? this.name,
        handle: handle ?? this.handle,
        email: email ?? this.email,
        avatarUrl: avatarUrl ?? this.avatarUrl,
        phone: phone ?? this.phone,
        number: number ?? this.number,
      );

  String get seed => uid; // deterministic avatar seed
  String get atHandle => handle.isEmpty ? '' : '@$handle';

  /// True when [name] is an internal/bootstrap label rather than a name a
  /// person chose. These values may be replaced by the public directory, but a
  /// real locally-saved name must never be overwritten by background hydration.
  bool get hasMachineFallbackName {
    final value = name.trim();
    if (value.isEmpty ||
        value == 'AvaTOK contact' ||
        value == 'Unknown sender') {
      return true;
    }
    if (!uid.startsWith('user_')) return false;
    return value == uid || value == machineShortName(uid);
  }

  /// Historical builds persisted this shortened Clerk id as the visible chat
  /// name. Kept only to recognise and repair those rows; new UI must never show
  /// or persist it as a label.
  static String machineShortName(String uid) => uid.length > 16
      ? '${uid.substring(0, 10)}…${uid.substring(uid.length - 4)}'
      : uid;

  /// Merge a public-directory result without destroying locally meaningful
  /// contact data. Only machine-generated names are replaceable; all other
  /// fields are filled when missing.
  Contact mergeResolvedProfile(Contact resolved) {
    final resolvedName = resolved.name.trim();
    final useResolvedName = hasMachineFallbackName &&
        resolvedName.isNotEmpty &&
        !resolved.hasMachineFallbackName;
    return copyWith(
      name: useResolvedName ? resolvedName : name,
      handle: handle.isEmpty ? resolved.handle : handle,
      email: email.isEmpty ? resolved.email : email,
      avatarUrl: avatarUrl.isEmpty ? resolved.avatarUrl : avatarUrl,
      phone: phone.isEmpty ? resolved.phone : phone,
      number: number.isEmpty ? resolved.number : number,
    );
  }

  /// A phone-only caller saved from the AI Receptionist — keyed by a synthetic
  /// `tel:<E.164>` id because they have no AvaTOK account / uid yet.
  bool get isPhoneOnly => uid.startsWith('tel:');
  /// Human-friendly subtitle — AvaTOK number first, then phone, then email.
  String get subtitle => number.isNotEmpty ? number : (phone.isNotEmpty ? phone : email);

  Map<String, dynamic> toJson() => {'uid': uid, 'name': name, 'handle': handle, 'email': email, 'avatarUrl': avatarUrl, 'phone': phone, 'number': number};
  factory Contact.fromJson(Map<String, dynamic> j) => Contact(
        uid: (j['uid'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        handle: (j['handle'] ?? '').toString(),
        email: (j['email'] ?? '').toString(),
        avatarUrl: (j['avatarUrl'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
        number: (j['number'] ?? '').toString(),
      );
}

/// Persists the user's contact list locally (not secret, but reuse secure store).
class ContactsStore {
  // Bulk cache → on-disk per-account file (NOT secure storage, which is flaky on
  // some OEMs and was silently returning empty after restart → blank chat list).
  static const _key = 'avatok_contacts';

  // Broadcast the fresh list after EVERY mutation so live UI (the chat list) can
  // refresh the instant a contact is added/removed — e.g. a marketplace seller
  // materialised on "Contact agent". Without this, add() wrote to disk but the
  // already-open chat list held a stale in-memory snapshot and only picked it up
  // on a cold restart, so the new thread "never appeared".
  static final _changes = StreamController<List<Contact>>.broadcast();
  static Stream<List<Contact>> get changes => _changes.stream;
  static Future<void> _writeTail = Future<void>.value();

  static Future<T> _serializeWrite<T>(Future<T> Function() operation) {
    final completer = Completer<T>();
    _writeTail = _writeTail.catchError((_) {}).then((_) async {
      try {
        completer.complete(await operation());
      } catch (error, stack) {
        completer.completeError(error, stack);
      }
    });
    return completer.future;
  }

  // Account-scoped: each logged-in Clerk account keeps its OWN contact list.
  // Previously this used a single global key, so contacts leaked between
  // accounts on the same device (e.g. a contact added by one user showed up for
  // another). A fresh account starts empty and is restored from its own vault
  // via [pullAndMerge].
  Future<List<Contact>> load() => _loadForScope(AccountScope.id);

  Future<List<Contact>> _loadForScope(String? scope) async {
    final raw = await DiskCache.readForScope(_key, scope: scope);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      return list.map(Contact.fromJson).toList();
    } catch (e) {
      AvaLog.I.log('cache', 'contacts decode failed: $e');
      return [];
    }
  }

  Future<void> _saveForScope(List<Contact> cs, String? scope) =>
      DiskCache.writeForScope(_key,
          jsonEncode(cs.map((c) => c.toJson()).toList()), scope: scope);

  Future<void> _save(List<Contact> cs) {
    final scope = AccountScope.id;
    return _serializeWrite(() => _saveForScope(cs, scope));
  }

  /// EXPLICIT user add (or update); de-dupes on uid. Returns the new list.
  ///
  /// ⚠️ This UN-DELETES: it clears any tombstone for `c.uid`. Only call it when
  /// the USER deliberately added this contact. Automated/background paths that
  /// re-create contacts from restored data MUST use [addIfNotDeleted] instead —
  /// see [ISSUE-CONTACT-RESURRECT-1].
  Future<List<Contact>> add(Contact c) async {
    final scope = AccountScope.id;
    final cs = await _serializeWrite(() async {
      final latest = await _loadForScope(scope);
      latest.removeWhere((x) => x.uid == c.uid);
      latest.insert(0, c);
      // [ISSUE-CONTACT-SEMANTICS-1] An explicit add un-deletes: clear any
      // tombstone (and un-hide the thread) so the contact behaves like new.
      final deleted = await _loadMapKeyForScope(_kDeletedKey, scope);
      if (deleted.remove(c.uid) != null) {
        await _saveMapKeyForScope(_kDeletedKey, deleted, scope);
      }
      final hidden = await _loadMapKeyForScope(_kHiddenKey, scope);
      if (hidden.remove(c.uid) != null) {
        await _saveMapKeyForScope(_kHiddenKey, hidden, scope);
      }
      await _saveForScope(latest, scope);
      return latest;
    });
    if (AccountScope.id == scope) {
      _changes.add(cs); // live-refresh any open chat list
      _syncUp(cs, expectedScope: scope);
    }
    return cs;
  }

  // ── [ISSUE-CONTACT-RESURRECT-1] (owner report 2026-07-14) ──────────────────
  // Deleted test contacts came back on EVERY reinstall, forever, no matter how
  // many times the owner deleted them. Root cause: thread resurrection
  // (`_resurrectThreadsFromMessages`) re-created peers by calling `add()` — the
  // *explicit user add* entry point — which by contract clears the tombstone and
  // then `_syncUp`s a blob whose `deleted` map no longer contains the uid. So an
  // automated resurrection was indistinguishable from "the user re-added them",
  // and it destroyed the tombstone ON THE SERVER. First reinstall resurrected
  // them; that same resurrection poisoned the vault, so every later reinstall
  // resurrected them again.
  //
  // This is the restore-safe entry point: it REFUSES to re-create a tombstoned
  // contact and never touches the deleted/hidden maps. Returns the resulting
  // list, or null if the uid is tombstoned (caller should skip the row).
  //
  // NOTE the tombstone is re-read here, not passed in by the caller: the vault
  // hydrates asynchronously, so any snapshot the caller took before its own
  // network round-trips is likely stale. Read late, decide late.
  Future<List<Contact>?> addIfNotDeleted(Contact c, {String? expectedScope}) async {
    final scope = expectedScope ?? AccountScope.id;
    if (expectedScope != null && AccountScope.id != expectedScope) return null;
    final cs = await _serializeWrite<List<Contact>?>(() async {
      if (expectedScope != null && AccountScope.id != expectedScope) return null;
      final deleted = await _loadMapKeyForScope(_kDeletedKey, scope);
      if (deleted.containsKey(c.uid)) {
        // Same event name + property shape as the mergeTel guard, so PostHog can
        // segment which automated path tried to resurrect a tombstoned contact.
        Analytics.capture(
            'contact_resurrect_blocked', const {'source': 'add_if_not_deleted'});
        return null; // tombstoned — stays deleted
      }
      final latest = await _loadForScope(scope);
      latest.removeWhere((x) => x.uid == c.uid);
      latest.insert(0, c);
      await _saveForScope(latest, scope);
      return latest;
    });
    if (cs == null) return null;
    if (AccountScope.id == scope) {
      _changes.add(cs);
    }
    // Automated scope-bound repairs stay local. Normal startup/sync will carry
    // the repaired identity without risking mutable auth during an account swap.
    if (expectedScope == null && AccountScope.id == scope) {
      _syncUp(cs, expectedScope: scope);
    }
    return cs;
  }

  /// Whether this account's vault has been pulled+decrypted (or authoritatively
  /// confirmed empty) during this process lifetime. Until this is true, the
  /// local tombstone map may simply not have arrived yet — so any code that
  /// decides "is this uid deleted?" must not treat a miss as authoritative.
  static bool get vaultHydrated => _vaultHydratedFor == _scopeKey;

  /// Await vault hydration (bounded). Resolves as soon as the vault has landed,
  /// or after [timeout] regardless. [ISSUE-CONTACT-RESURRECT-1]: resurrection
  /// awaits this so it can never race ahead of the tombstones meant to stop it.
  Future<bool> ensureHydrated(
      {Duration timeout = const Duration(seconds: 12)}) async {
    if (vaultHydrated) return true;
    try {
      await pullAndMerge().timeout(timeout);
    } catch (_) {/* best-effort — fall through to the flag */}
    return vaultHydrated;
  }

  // ── [ISSUE-CONTACT-SEMANTICS-1] (owner decision 2026-07-10) ────────────────
  // Two distinct actions, both restore-proof (persisted locally AND in the
  // vault blob v2 so they survive reinstall + follow the user across devices):
  //   • DELETE contact  → gone from the AvaTOK contact book, tombstoned so no
  //     restore/resurrection can ever bring it back. Re-adding explicitly
  //     clears the tombstone.
  //   • HIDE thread ("Remove contact" in the chat-list menu) → the chat row
  //     disappears, but the contact STAYS in the AvaTOK contact book (user can
  //     look them up and message them any time). Stored as uid → hiddenAt ms;
  //     any NEWER message automatically resurrects the row, so no un-hide
  //     plumbing is needed.
  static const _kDeletedKey = 'avatok_contacts_deleted'; // JSON {uid: ms}
  static const _kHiddenKey = 'avatok_threads_hidden';    // JSON {uid: ms}
  // [CONTACT-RESOLVE-TTL] (AVA-UI-CACHE) uid → last avatar-backfill resolve
  // attempt (ms), per account. refreshMissingAvatars re-ran a directory resolve
  // for EVERY avatar-less contact on EVERY cold start, which is most of the 951
  // contact_resolve events/3d for one user. We now remember when we last tried and
  // skip a contact still inside the TTL, so a photoless contact is retried at most
  // once a day instead of once per launch.
  static const _kAvatarResolveAttemptKey = 'avatok_avatar_resolve_attempt'; // JSON {uid: ms}
  static const _avatarResolveTtlMs = 24 * 60 * 60 * 1000; // 24h

  Future<Map<String, int>> _loadMapKey(String key) =>
      _loadMapKeyForScope(key, AccountScope.id);

  Future<Map<String, int>> _loadMapKeyForScope(
      String key, String? scope) async {
    try {
      final raw = await DiskCache.readForScope(key, scope: scope);
      if (raw == null || raw.isEmpty) return {};
      final m = jsonDecode(raw) as Map<String, dynamic>;
      return {for (final e in m.entries) e.key: (e.value as num?)?.toInt() ?? 0};
    } catch (_) {
      return {};
    }
  }

  Future<void> _saveMapKey(String key, Map<String, int> m) =>
      _saveMapKeyForScope(key, m, AccountScope.id);

  Future<void> _saveMapKeyForScope(
          String key, Map<String, int> m, String? scope) =>
      DiskCache.writeForScope(key, jsonEncode(m), scope: scope);

  /// Key-set + value equality for the tombstone / hidden maps.
  /// [ISSUE-CONTACT-RESURRECT-1] — used to decide whether the local maps have
  /// drifted from the vault's copy and therefore need pushing.
  static bool _sameMap(Map<String, int> a, Map<String, int> b) {
    if (a.length != b.length) return false;
    for (final e in a.entries) {
      if (b[e.key] != e.value) return false;
    }
    return true;
  }

  /// Tombstoned (deleted) contact uids → deleted-at ms.
  Future<Map<String, int>> deletedContacts() => _loadMapKey(_kDeletedKey);

  /// Hidden 1:1 threads: peer uid → hidden-at ms.
  Future<Map<String, int>> hiddenThreads() => _loadMapKey(_kHiddenKey);

  /// DELETE from the AvaTOK contact book, permanently (tombstoned).
  Future<List<Contact>> deleteContact(String uid) async {
    final scope = AccountScope.id;
    final cs = await _serializeWrite(() async {
      final deleted = await _loadMapKeyForScope(_kDeletedKey, scope);
      deleted[uid] = DateTime.now().millisecondsSinceEpoch;
      await _saveMapKeyForScope(_kDeletedKey, deleted, scope);
      final latest = await _loadForScope(scope);
      latest.removeWhere((x) => x.uid == uid);
      await _saveForScope(latest, scope);
      return latest;
    });
    if (AccountScope.id == scope) {
      _changes.add(cs);
      _syncUp(cs, expectedScope: scope);
    }
    Analytics.capture('contact_deleted', const {});
    return cs;
  }

  /// Hide the chat thread; the contact itself is untouched.
  Future<void> hideThread(String uid) async {
    final scope = AccountScope.id;
    final cs = await _serializeWrite(() async {
      final hidden = await _loadMapKeyForScope(_kHiddenKey, scope);
      hidden[uid] = DateTime.now().millisecondsSinceEpoch;
      await _saveMapKeyForScope(_kHiddenKey, hidden, scope);
      return await _loadForScope(scope);
    });
    Analytics.capture('thread_hidden', const {});
    if (AccountScope.id == scope) _syncUp(cs, expectedScope: scope);
  }

  /// LEGACY removal — kept for callers outside the chat-list menu. Maps to the
  /// hard delete (tombstoned) since that matches the old visible effect.
  ///
  /// [ISSUE-CONTACT-RESURRECT-1] The docstring has claimed "now maps to the hard
  /// delete (tombstoned)" since 2026-07-10, but the body did NOT tombstone — it
  /// just dropped the row and pushed. AvaPhone's user-facing Delete
  /// (`ava_phone_contacts.dart`) calls this, so deleting a contact THERE
  /// resurrected on the next pullAndMerge while deleting the same contact in the
  /// chat list stayed gone. Two delete buttons, two semantics. Now it genuinely
  /// delegates, so both tombstone.
  Future<List<Contact>> remove(String uid) => deleteContact(uid);

  /// Promote a phone-only `tel:<e164>` contact to a real AvaTOK account once
  /// that caller is discovered to have joined. Drops the synthetic row and adds
  /// the real one, carrying the phone number across if the resolved profile
  /// didn't include it. The conv key derives from the number either way, so the
  /// thread and its receptionist cards stay intact through the merge.
  /// Returns null when the promotion was REFUSED because the real account is
  /// tombstoned — callers must skip their follow-up work (see
  /// `_reconcileTelContacts`, which otherwise rekeys the thread to a contact
  /// that doesn't exist).
  Future<List<Contact>?> mergeTel(String e164, Contact real) async {
    // [ISSUE-CONTACT-RESURRECT-1] AUTOMATED path (the device-contacts match sync
    // promotes tel: provisionals when it discovers the number is on AvaTOK), so
    // it must respect tombstones — same rule as _ensureContact. Without this it
    // re-inserted a deleted contact; pullAndMerge would drop the row again on
    // the next merge, but the user still saw it flash back.
    //
    // ONLY a tombstone on `real.uid` blocks: that's the identity being
    // materialised, and it's the only one pullAndMerge filters on
    // (`!deleted.containsKey(c.uid)`), so it's the only one that actually
    // sticks. A tel:-only tombstone must NOT block — the user deleted the
    // provisional row, not the person, and refusing would strand the promotion
    // forever (add() only ever clears the tombstone for the uid it was given,
    // so a stale `tel:$e164` tombstone would survive every future merge).
    final scope = AccountScope.id;
    final cs = await _serializeWrite<List<Contact>?>(() async {
      final deleted = await _loadMapKeyForScope(_kDeletedKey, scope);
      if (deleted.containsKey(real.uid)) {
        Analytics.capture(
            'contact_resurrect_blocked', const {'source': 'merge_tel'});
        return null; // refused — caller must NOT rekey the thread
      }
      final latest = await _loadForScope(scope);
      latest.removeWhere((x) => x.uid == 'tel:$e164');
      latest.removeWhere((x) => x.uid == real.uid);
      final merged = real.phone.isEmpty
          ? Contact(uid: real.uid, name: real.name, handle: real.handle,
              email: real.email, avatarUrl: real.avatarUrl, phone: e164, number: real.number)
          : real;
      latest.insert(0, merged);
      await _saveForScope(latest, scope);
      return latest;
    });
    if (cs == null) return null;
    if (AccountScope.id == scope) {
      _changes.add(cs);
      _syncUp(cs, expectedScope: scope);
    }
    return cs;
  }

  // [ISSUE-VAULT-OVERWRITE-1] (2026-07-09) Which account's vault we have
  // successfully hydrated from (pulled + decrypted, or server-confirmed empty)
  // during THIS process lifetime. Until that has happened, _syncUp must NOT
  // push: after a failed restore the local list is empty/near-empty, and one
  // add()/remove() used to encrypt that stub and OVERWRITE the user's good
  // server backup — silent, permanent data loss. Now we pull-merge-push instead.
  static String? _vaultHydratedFor;
  static String get _scopeKey => AccountScope.id ?? '_default';
  static String _scopeKeyFor(String? scope) =>
      (scope == null || scope.isEmpty) ? '_default' : scope;

  /// Encrypt the contact list with the user's key and upload it so it follows
  /// the user to any device. Best-effort; never throws.
  Future<bool> _syncUp(List<Contact> cs,
      {String? expectedScope, bool allowFirstPut = false}) async {
    final scope = expectedScope ?? AccountScope.id;
    final identity = ApiAuth.identity;
    bool scopeIsCurrent() =>
        AccountScope.id == scope && identical(ApiAuth.identity, identity);
    if (!scopeIsCurrent()) return false;
    if (identity == null) return false;
    if (_vaultHydratedFor != _scopeKeyFor(scope) && !allowFirstPut) {
      // Never pushed-before-pulled. pullAndMerge unions local into remote and
      // pushes the superset itself, so the mutation still reaches the vault —
      // without ever being able to shrink it.
      Analytics.capture('contacts_syncup_deferred',
          {'reason': 'not_hydrated', 'local_count': cs.length});
      if (scopeIsCurrent()) unawaited(pullAndMerge());
      return false;
    }
    final keyMat = await AccountKey.I.ensureHex();
    if (!scopeIsCurrent()) return false;
    if (keyMat == null) {
      return false; // no account key yet (offline) — the next sync carries it
    }
    try {
      // [ISSUE-CONTACT-SEMANTICS-1] Vault blob v2: carries the deleted-contact
      // tombstones + hidden-thread map alongside the contacts, so "deleted stays
      // deleted" and "removed threads stay removed" across reinstalls/devices.
      // (v1 blobs — a bare JSON list — are still read by pullAndMerge.)
      final deleted = await _loadMapKeyForScope(_kDeletedKey, scope);
      if (!scopeIsCurrent()) return false;
      final hidden = await _loadMapKeyForScope(_kHiddenKey, scope);
      if (!scopeIsCurrent()) return false;
      final blob = await Vault.encrypt(jsonEncode({
        'v': 2,
        'contacts': cs.map((c) => c.toJson()).toList(),
        'deleted': deleted,
        'hidden': hidden,
      }), keyMat);
      if (!scopeIsCurrent()) return false;
      // Vault.put is intentionally best-effort and swallows its HTTP result, so
      // this result-bearing path persists directly. Confirmed-empty hydration
      // may only become trusted after the server acknowledges this write.
      final put = await ApiAuth.postJson(
          kVaultUrl, {'kind': 'contacts', 'blob': blob},
          timeout: const Duration(seconds: 20));
      if (!scopeIsCurrent()) return false;
      if (put.statusCode != 200) {
        Analytics.error(
          domain: 'vault',
          code: 'vault_put_failed',
          message: 'status ${put.statusCode}',
          action: 'put',
          extra: {'kind': 'contacts', 'status': put.statusCode},
        );
        return false;
      }
      // The encrypted vault remains the restore authority. This separate,
      // privacy-minimised uid set is the server-readable call-policy index that
      // lets the edge decide whether a caller is saved without decrypting chat
      // data or trusting whichever handset happens to be awake.
      final contactUids = cs
          .map((c) => c.uid)
          .where((uid) => uid.startsWith('user_'))
          .toSet()
          .toList(growable: false);
      try {
        await ApiAuth.postJson(kContactCallPolicyUrl, {
          'contactUids': contactUids,
        });
      } catch (_) {/* vault persistence already succeeded */}
      return scopeIsCurrent();
    } catch (e) {
      Analytics.error(
        domain: 'vault',
        code: 'vault_put_failed',
        message: e.toString(),
        action: 'put',
        extra: {'kind': 'contacts', 'status': 0},
      );
      return false;
    }
  }

  /// Pull the encrypted contact list from the vault (on login / new device) and
  /// merge it with anything saved locally (union by uid). On any failure the
  /// local list is left untouched. Returns the resulting list.
  // [ISSUE-CONTACT-RESURRECT-1] In-flight guard. main.dart fires pullAndMerge()
  // unawaited from FIVE places on startup, and ensureHydrated() adds a sixth —
  // so up to six concurrent runs performed the same load-modify-write over the
  // `deleted` map and the contact list, and lost each other's updates. (This
  // codebase already documents the identical hazard for the sibling store: see
  // chat_state.dart — "calling setRead in a loop would race on the shared file".)
  // The concrete loss: the user taps Delete, and an in-flight pullAndMerge that
  // read `deleted` BEFORE that write re-saves the contact and streams it back
  // into the list — the row reappears in the user's face.
  //
  // Collapsing to one shared future also turns the five-way startup stampede
  // into a single network round-trip.
  static Future<List<Contact>>? _pullInFlight;
  static String? _pullInFlightScope;

  Future<List<Contact>> pullAndMerge() {
    final scope = AccountScope.id;
    final identity = ApiAuth.identity;
    final existing = _pullInFlight;
    if (existing != null && _pullInFlightScope == _scopeKeyFor(scope)) {
      return existing;
    }
    final fut = _pullAndMergeOnce(scope, identity);
    _pullInFlight = fut;
    _pullInFlightScope = _scopeKeyFor(scope);
    return fut.whenComplete(() {
      if (identical(_pullInFlight, fut)) {
        _pullInFlight = null;
        _pullInFlightScope = null;
      }
    });
  }

  Future<List<Contact>> _pullAndMergeOnce(
      String? scope, Identity? identity) async {
    bool scopeIsCurrent() =>
        AccountScope.id == scope && identical(ApiAuth.identity, identity);
    final local = await _loadForScope(scope);
    if (identity == null || !scopeIsCurrent()) return local;
    final keyMat = await AccountKey.I.ensureHex(); // restores from escrow / mints + escrows the key
    if (!scopeIsCurrent()) return local;
    // [ISSUE-VAULT-RESTORE-1] (2026-07-09) Tri-state fetch with retries. The old
    // `Vault.get` returned null for BOTH "no backup" and "request failed", and a
    // single 8s-timeout failure at first login left the contact list empty with
    // no retry and no telemetry — while the backup sat intact on the server.
    final fetch = await Vault.fetch('contacts');
    if (!scopeIsCurrent()) return local;
    if (fetch.failed) {
      Analytics.error(
        domain: 'account',
        code: 'contacts_restore_failed',
        message: 'vault fetch failed',
        action: 'pull_and_merge',
        extra: {'stage': 'vault_get', 'local_count': local.length},
      );
      return local; // NOT hydrated — _syncUp stays deferred, backup stays safe
    }
    if (fetch.confirmedEmpty) {
      // Server says: no backup for this account. That's an authoritative answer
      // (fresh account), so pushes may proceed from here on. Re-read under the
      // write serializer: contacts may have been added while the fetch was in
      // flight, and that exact latest snapshot must become the first backup.
      return _serializeWrite(() async {
        final latest = await _loadForScope(scope);
        if (!scopeIsCurrent()) return latest;
        // Bypass only the hydration guard for this authoritative first put; all
        // captured-scope/auth checks remain active, and no pull recursion occurs.
        // Holding the serializer prevents a later write racing this snapshot.
        final scopeKey = _scopeKeyFor(scope);
        if (_vaultHydratedFor == scopeKey) _vaultHydratedFor = null;
        final persisted = await _syncUp(latest,
            expectedScope: scope, allowFirstPut: true);
        if (persisted && scopeIsCurrent()) {
          _vaultHydratedFor = scopeKey;
          Analytics.capture('contacts_restored', {
            'remote_count': 0,
            'local_count': latest.length,
            'confirmed_empty': true,
          });
        } else if (_pullInFlightScope == scopeKey) {
          // Do not leave a completed failed restore reusable for the mutation
          // queued behind this serializer; its sync must start a fresh pull.
          _pullInFlight = null;
          _pullInFlightScope = null;
        }
        return latest;
      });
    }
    final blob = fetch.blob!;
    final plain = keyMat == null ? null : await Vault.decrypt(blob, keyMat);
    if (!scopeIsCurrent()) return local;
    if (plain == null) {
      // A backup EXISTS but we can't read it (missing/wrong key). Absolutely do
      // not allow pushes — they'd replace a real backup with a stub.
      Analytics.error(
        domain: 'account',
        code: 'contacts_restore_failed',
        message: keyMat == null ? 'no account key' : 'decrypt failed',
        action: 'pull_and_merge',
        extra: {'stage': keyMat == null ? 'key' : 'decrypt', 'local_count': local.length},
      );
      return local;
    }
    List<Contact> remote;
    var remoteDeleted = <String, int>{};
    var remoteHidden = <String, int>{};
    try {
      // [ISSUE-CONTACT-SEMANTICS-1] v2 blob = {v:2, contacts, deleted, hidden};
      // v1 blob = a bare JSON list of contacts. Read both.
      final decoded = jsonDecode(plain);
      final List<dynamic> rawContacts;
      if (decoded is Map<String, dynamic>) {
        rawContacts = (decoded['contacts'] as List?) ?? const [];
        Map<String, int> asMap(Object? o) => o is Map<String, dynamic>
            ? {for (final e in o.entries) e.key: (e.value as num?)?.toInt() ?? 0}
            : {};
        remoteDeleted = asMap(decoded['deleted']);
        remoteHidden = asMap(decoded['hidden']);
      } else {
        rawContacts = decoded as List;
      }
      remote = rawContacts.cast<Map<String, dynamic>>().map(Contact.fromJson).toList();
    } catch (_) {
      Analytics.error(
        domain: 'account',
        code: 'contacts_restore_failed',
        message: 'parse failed',
        action: 'pull_and_merge',
        extra: {'stage': 'parse', 'local_count': local.length},
      );
      return local;
    }
    final result = await _serializeWrite(() async {
      // Merge against the latest local state only after all network awaits, then
      // persist maps + contacts as one store transaction for this account.
      final latestLocal = await _loadForScope(scope);
      final deleted = await _loadMapKeyForScope(_kDeletedKey, scope);
      for (final e in remoteDeleted.entries) {
        if ((deleted[e.key] ?? 0) < e.value) deleted[e.key] = e.value;
      }
      final hidden = await _loadMapKeyForScope(_kHiddenKey, scope);
      for (final e in remoteHidden.entries) {
        if ((hidden[e.key] ?? 0) < e.value) hidden[e.key] = e.value;
      }
      final byNpub = <String, Contact>{
        for (final c in latestLocal) c.uid: c
      };
      for (final c in remote) {
        byNpub[c.uid] = c;
      }
      // Deleted contacts stay deleted — drop tombstoned uids from the merge.
      final merged = byNpub.values
          .where((c) => c.uid.isNotEmpty && !deleted.containsKey(c.uid))
          .toList();
      await _saveMapKeyForScope(_kDeletedKey, deleted, scope);
      await _saveMapKeyForScope(_kHiddenKey, hidden, scope);
      await _saveForScope(merged, scope);
      return (contacts: merged, deleted: deleted, hidden: hidden);
    });
    final merged = result.contacts;
    final deleted = result.deleted;
    final hidden = result.hidden;
    if (!scopeIsCurrent()) return merged;
    _vaultHydratedFor = _scopeKeyFor(scope); // pulled + decrypted — pushes are safe now
    _changes.add(merged); // live-refresh the chat list the moment restore lands
    // [ISSUE-VAULT-RESTORE-1] restore counter — proves in PostHog whether the
    // user's contacts actually came back (the 2026-07-09 report had no way to tell).
    Analytics.capture('contacts_restored', {
      'remote_count': remote.length,
      'local_count': local.length,
      'merged_count': merged.length,
      'deleted_count': deleted.length,
      'hidden_count': hidden.length,
    });
    // If the merge differs from the server copy, push the superset back.
    //
    // [ISSUE-CONTACT-RESURRECT-1] This used to be `merged.length != remote.length`
    // — a CONTACT-COUNT-ONLY test. It ignored the deleted/hidden maps entirely,
    // so any tombstone-only or hide-only mutation whose counts happened to match
    // was never uploaded. `hideThread` never changes the list length at all, so
    // on a non-hydrated session it was effectively never synced. Compare the
    // maps too: a tombstone that doesn't reach the vault is a tombstone that
    // dies at the next reinstall.
    final tombstonesDiffer = !_sameMap(deleted, remoteDeleted);
    final hiddenDiffer = !_sameMap(hidden, remoteHidden);
    if (merged.length != remote.length || tombstonesDiffer || hiddenDiffer) {
      _syncUp(merged, expectedScope: scope);
    }
    return merged;
  }

  /// Repair incomplete directory identity for existing contacts. Historical
  /// message ingestion persisted shortened Clerk ids as names; those rows must
  /// be hydrated even when they already have an avatar. Human-saved names are
  /// never overwritten.
  Future<List<Contact>> refreshMissingProfiles() async {
    final scope = AccountScope.id;
    bool scopeIsCurrent() => AccountScope.id == scope;
    final cs = await _loadForScope(scope);
    if (!scopeIsCurrent()) return cs;
    var changed = false;
    var skippedUnresolvable = 0;
    var skippedRecent = 0;
    var resolved = 0;
    var namesRepaired = 0;
    var unresolved = 0;
    final resolvedByUid = <String, Contact>{};
    // [CONTACT-RESOLVE-TTL] Remember which avatar-less contacts we already tried
    // recently so relaunches don't re-resolve the same ones every time.
    final attempts =
        await _loadMapKeyForScope(_kAvatarResolveAttemptKey, scope);
    if (!scopeIsCurrent()) return cs;
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    var attemptsChanged = false;
    for (var i = 0; i < cs.length; i++) {
      final c = cs[i];
      final needsName = c.hasMachineFallbackName;
      final needsAvatar = c.avatarUrl.isEmpty;
      if ((!needsName && !needsAvatar) || c.uid.isEmpty) continue;
      // [ISSUE-CONTACT-AVATAR-1] Only a real AvaTOK account can HAVE a directory
      // photo. `tel:` ids are receptionist/PSTN-only callers with no account, so
      // resolving them is a guaranteed 404 — and we re-ran it on every launch.
      // Telemetry 2026-07-12..15: 630 of 790 contact_resolve calls 404'd, all from
      // root ('/'), i.e. this loop. Skipping them removes ~80% of the calls and
      // the pointless per-launch latency.
      if (!c.uid.startsWith('user_')) {
        skippedUnresolvable++;
        continue;
      }
      // [CONTACT-RESOLVE-TTL] Skip a contact we resolved (or tried to) within the
      // TTL — a photoless account rarely gains a photo mid-day, so re-hitting the
      // directory on every launch is pure noise.
      final last = attempts[c.uid] ?? 0;
      // A visible identity fallback deserves a quick retry; a merely missing
      // photo can keep the existing low-cost daily cadence.
      final ttlMs = needsName ? 60 * 1000 : _avatarResolveTtlMs;
      if (nowMs - last < ttlMs) {
        skippedRecent++;
        continue;
      }
      attempts[c.uid] = nowMs;
      attemptsChanged = true;
      final sw = Stopwatch()..start();
      final r = await Directory.resolve(c.uid);
      sw.stop();
      if (!scopeIsCurrent()) return cs;
      if (r == null) {
        unresolved++;
        Analytics.capture('contact_identity_hydration', {
          'source': 'startup_repair',
          'outcome': 'unresolved',
          'latency_ms': sw.elapsedMilliseconds,
          'needed_name': needsName,
          'needed_avatar': needsAvatar,
          'uid_kind': 'clerk',
        });
        continue;
      }
      resolvedByUid[c.uid] = r;
      final merged = c.mergeResolvedProfile(r);
      final nameRepaired = c.name != merged.name;
      final avatarRepaired = c.avatarUrl != merged.avatarUrl;
      final detailsRepaired = c.email != merged.email ||
          c.phone != merged.phone ||
          c.number != merged.number;
      if (!nameRepaired && r.hasMachineFallbackName) unresolved++;
      if (nameRepaired || avatarRepaired || detailsRepaired) {
        cs[i] = merged;
        changed = true;
        resolved++;
        if (nameRepaired) namesRepaired++;
      }
      Analytics.capture('contact_identity_hydration', {
        'source': 'startup_repair',
        'outcome': nameRepaired || avatarRepaired || detailsRepaired
            ? (nameRepaired ? 'updated' : 'partial_profile')
            : (r.hasMachineFallbackName
                ? 'profile_missing_name'
                : 'already_current'),
        'latency_ms': sw.elapsedMilliseconds,
        'name_repaired': nameRepaired,
        'avatar_repaired': avatarRepaired,
        'details_repaired': detailsRepaired,
        'uid_kind': 'clerk',
      });
    }
    // [CONTACT-RESOLVE-TTL] Persist the attempt timestamps so the TTL survives a
    // relaunch (this is the whole point — stop re-resolving every cold start).
    if (attemptsChanged && scopeIsCurrent()) {
      await _saveMapKeyForScope(_kAvatarResolveAttemptKey, attempts, scope);
    }
    if (!scopeIsCurrent()) return cs;

    // Never save the snapshot loaded before the network awaits: another contact
    // mutation may have landed while profiles were resolving. Re-read the
    // latest list and merge only the resolved uid fields into that version.
    var output = cs;
    if (changed && resolvedByUid.isNotEmpty) {
      final result = await _serializeWrite<({List<Contact> contacts, bool changed})>(
          () async {
        final latest = await _loadForScope(scope);
        final deleted = await _loadMapKeyForScope(_kDeletedKey, scope);
        var latestChanged = false;
        latest.removeWhere((c) {
          final remove = deleted.containsKey(c.uid);
          if (remove) latestChanged = true;
          return remove;
        });
        for (var i = 0; i < latest.length; i++) {
          final resolvedProfile = resolvedByUid[latest[i].uid];
          if (resolvedProfile == null) continue;
          final merged = latest[i].mergeResolvedProfile(resolvedProfile);
          if (merged.name != latest[i].name ||
              merged.handle != latest[i].handle ||
              merged.email != latest[i].email ||
              merged.avatarUrl != latest[i].avatarUrl ||
              merged.phone != latest[i].phone ||
              merged.number != latest[i].number) {
            latest[i] = merged;
            latestChanged = true;
          }
        }
        if (latestChanged) await _saveForScope(latest, scope);
        return (contacts: latest, changed: latestChanged);
      });
      output = result.contacts;
      if (result.changed && scopeIsCurrent()) _changes.add(output);
    }
    // Proves the backfill is doing useful work rather than burning 404s, and that
    // numbers survive it (number_kept vs the old silent wipe). The owner's email is
    // auto-stamped onto every event by Analytics._base, so it stays pullable by
    // tester without being passed here.
    Analytics.capture('contact_avatar_backfill', {
      'scanned': cs.length,
      'resolved': resolved,
      'names_repaired': namesRepaired,
      'unresolved': unresolved,
      'skipped_unresolvable': skippedUnresolvable,
      'skipped_recent':
          skippedRecent, // [CONTACT-RESOLVE-TTL] re-resolves avoided
      'number_kept': cs.where((c) => c.number.isNotEmpty).length,
    });
    return output;
  }
}

/// Thin client for the AvaTok directory Worker (handle/uid resolve + search).
class Directory {
  // [AVA-DIR-NEGCACHE] Per-account negative cache for directory lookups that the
  // worker (D1) said do NOT exist. PostHog (7d prod): 1,321 of 1,544
  // contact_resolve events were reason=http_404 — the SAME not-found names being
  // re-queried against the directory endlessly, because resolve() had no memory
  // of a miss. Every caller of resolve() (avatar backfill, add-contact sheet,
  // search, DM addressing) now benefits: a query the server 404'd is remembered
  // for 24h and short-circuited to null without another round trip.
  //
  // Scoping: DiskCache.read/write are account-scoped by AccountScope.id, so each
  // account on a shared phone keeps its own miss set — no cross-account leak.
  // TTL: entries expire naturally after 24h, so a name that later registers is
  // reachable within a day. ONLY real 404s (deterministic "not found") are
  // cached — never timeouts/5xx/network errors, which are transient and a
  // negative-cache of them would wrongly hide a person during an outage.
  static const String _kNegCacheKey = 'avatok_dir_negcache_v1'; // JSON {q: attemptMs}
  static const int _negCacheTtlMs = 24 * 60 * 60 * 1000; // 24h
  static int _negCacheHitCount = 0; // process-lifetime; drives sampled telemetry

  static String _negCacheKeyFor(String q) => q.toLowerCase();

  static Future<Map<String, int>> _loadNegCache() async {
    try {
      final raw = await DiskCache.read(_kNegCacheKey);
      if (raw == null || raw.isEmpty) return {};
      final m = jsonDecode(raw) as Map<String, dynamic>;
      final now = DateTime.now().millisecondsSinceEpoch;
      // Prune expired entries on read so the map can never grow without bound.
      return {
        for (final e in m.entries)
          if (now - ((e.value as num?)?.toInt() ?? 0) < _negCacheTtlMs)
            e.key: (e.value as num?)?.toInt() ?? 0
      };
    } catch (_) {
      return {};
    }
  }

  /// Record that the directory returned a hard 404 for [q] (case-folded), so the
  /// next lookup within the TTL is answered locally. Best-effort; a write failure
  /// just means the miss isn't remembered (existing behaviour).
  static Future<void> _rememberMiss(String q) async {
    try {
      final m = await _loadNegCache(); // already pruned
      m[_negCacheKeyFor(q)] = DateTime.now().millisecondsSinceEpoch;
      await DiskCache.write(_kNegCacheKey, jsonEncode(m));
    } catch (_) {/* best-effort */}
  }

  /// True if [q] was recently 404'd by the directory and is still inside the TTL.
  static Future<bool> _isNegCached(String q) async {
    try {
      final m = await _loadNegCache();
      final ts = m[_negCacheKeyFor(q)];
      if (ts == null) return false;
      return DateTime.now().millisecondsSinceEpoch - ts < _negCacheTtlMs;
    } catch (_) {
      return false;
    }
  }

  /// Resolve `@handle`, `handle`, or `npub1…` → a Contact, or null if unknown.
  static Future<Contact?> resolve(String query) async {
    final q = query.trim();
    if (q.isEmpty) return null;
    // Classify the query so resolve telemetry can be sliced by id type — this is
    // the key signal for the "DMs stuck on waiting-to-reach-phone" bug class.
    final kind = q.startsWith('@')
        ? 'handle'
        : (q.startsWith('npub1') || q.startsWith('user_'))
            ? 'uid'
            : q.contains('@')
                ? 'email'
                : RegExp(r'^[+\d]').hasMatch(q)
                    ? 'phone'
                    : 'name';
    // [AVA-DIR-NEGCACHE] Short-circuit a lookup the directory already 404'd within
    // the last 24h — this is the fix for the 1,321 repeated http_404 resolves.
    // Telemetry is SAMPLED (at most 1 event per 50 hits) so a chatty caller can't
    // flood PostHog; the cumulative count rides along so the true rate is still
    // visible.
    if (await _isNegCached(q)) {
      _negCacheHitCount++;
      if (_negCacheHitCount % 50 == 1) {
        Analytics.capture('contact_resolve_negcache_hit',
            {'kind': kind, 'count': _negCacheHitCount});
      }
      return null;
    }
    try {
      final r = await http
          .get(Uri.parse('$kResolveUrl?q=${Uri.encodeQueryComponent(q)}'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) {
        // Only a real 404 (deterministic "not found") is negative-cached; a 5xx /
        // 429 / other is transient and must stay retriable, so it is NOT cached.
        if (r.statusCode == 404) {
          await _rememberMiss(q);
        }
        Analytics.capture('contact_resolve',
            {'kind': kind, 'found': false, 'reason': 'http_${r.statusCode}'});
        return null;
      }
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final p = j['profile'] as Map<String, dynamic>?;
      // Cloudflare-native: the directory returns `uid` (Clerk id) as the
      // addressing id. Accept it at the top level OR nested under `profile`
      // (older worker shape) so a contact ALWAYS gets a routable id — a missing
      // id here was leaving DMs stuck on "waiting to reach phone".
      final uid = j['uid'] ?? p?['uid'];
      if (uid == null) {
        // Server said found:false (or a shape we can't address) — the exact case
        // that silently broke delivery. Track it so we catch regressions early.
        Analytics.capture('contact_resolve', {
          'kind': kind,
          'found': false,
          'reason': j['found'] == false ? 'not_registered' : 'no_uid'
        });
        return null;
      }
      // A raw Clerk uid is routable even before its public profile has reached
      // the directory. Keep that routing ability, but do not call it a resolved
      // identity or turn the uid into user-facing text. The short server cache
      // lets a just-published profile repair quickly.
      if (p == null) {
        Analytics.capture('contact_resolve', {
          'kind': kind,
          'found': false,
          'reason': 'profile_missing',
          'routable': true,
          'profile_present': false,
          'name_present': false,
        });
        return Contact(uid: uid.toString(), name: 'AvaTOK contact');
      }
      final first = (p?['first_name'] ?? '').toString();
      final last = (p?['last_name'] ?? '').toString();
      final assembled =
          [first, last].where((s) => s.isNotEmpty).join(' ').trim();
      final name =
          (p?['name'] ?? p?['display_name'] ?? '').toString().isNotEmpty
          ? (p?['name'] ?? p?['display_name']).toString()
          : assembled;
      // Directory responses have historically used both the canonical `number`
      // field and the older `avatok_number_display` spelling. Keep the contact
      // routable/displayable even when an older production response is cached.
      final number = (p?['number'] ??
              p?['avatok_number_display'] ??
              p?['avatok_number'] ??
              j['number'] ??
              j['avatok_number_display'] ??
              j['avatok_number'] ??
              '')
          .toString();
      final phone =
          (p?['phone'] ?? p?['phone_number'] ?? j['phone'] ?? '').toString();
      Analytics.capture('contact_resolve', {
        'kind': kind,
        'found': true,
        'profile_present': true,
        'name_present': name.isNotEmpty,
        'avatar_present':
            (p?['avatar_url'] ?? j['avatar_url'] ?? '').toString().isNotEmpty,
        'number_present': number.isNotEmpty,
      });
      return Contact(
        uid: uid.toString(),
        name: name.isNotEmpty ? name : 'AvaTOK contact',
        email: (p?['email'] ?? '').toString(),
        avatarUrl: (p?['avatar_url'] ?? j['avatar_url'] ?? '').toString(),
        phone: phone,
        number: number,
      );
    } catch (e) {
      // Even with no directory hit, a raw uid is still addable.
      if (q.startsWith('npub1')) {
        Analytics.capture('contact_resolve',
            {'kind': 'uid', 'found': true, 'reason': 'offline_fallback'});
        return Contact(uid: q, name: _short(q));
      }
      Analytics.capture(
          'contact_resolve', {'kind': kind, 'found': false, 'reason': 'error'});
      return null;
    }
  }

  /// True when `q` is a complete email address. Email is a user's unique,
  /// privacy-preserving id: it's only stored server-side as a one-way hash, so
  /// it can never be substring-searched — but a *complete* email resolves 1:1
  /// to exactly one registered account via [resolve].
  static bool isCompleteEmail(String q) {
    final at = q.indexOf('@');
    if (at <= 0 || q.contains(' ')) return false;
    // Bounds guard: `indexOf(pattern, start)` throws RangeError when start > length.
    // For a short input like `a@` / `a@b`, `at + 2` could exceed the string length
    // → `RangeError (start): ... 0..10: 11` crashing the Add-contact sheet & header
    // search (PostHog 0.1.17). Not a complete email anyway, so bail early.
    if (at + 2 >= q.length) return false;
    final dot = q.indexOf('.', at + 2); // need at least one char between @ and .
    return dot > at && dot < q.length - 1; // and at least one char after the dot
  }

  /// Search the public directory.
  ///
  /// Names collide (many "John"s), so email is the reliable way to find a
  /// specific person. A complete email is resolved exactly (hash-based, stays
  /// private); anything else (name / @handle / partial text) uses the FTS index.
  /// Directory discovery is EXACT-KEY only (owner decision 2026-07-01): a complete
  /// email, an AvaTOK NUMBER (any format), or a raw uid. NAME search was removed —
  /// at scale a name matches thousands of people, so it's noise. A plain name query
  /// returns nothing here (device-contact matches still show separately).
  static Future<List<Contact>> search(String query) async {
    final q = query.trim();
    if (q.length < 2) return [];
    final digits = q.replaceAll(RegExp(r'[^0-9]'), '');
    final looksNumeric = digits.length >= 6 && RegExp(r'^[+0-9\s()\-]+$').hasMatch(q);
    if (isCompleteEmail(q) || q.startsWith('user_') || looksNumeric) {
      final c = await resolve(q);
      return c == null ? <Contact>[] : <Contact>[c];
    }
    return [];
  }

  /// Handle format: 3–20 chars, lowercase letters/digits/underscore, starts with
  /// a letter. Kept in sync with the worker's HANDLE_RE.
  static final RegExp _handleRe = RegExp(r'^[a-z][a-z0-9_]{2,19}$');
  static bool isValidHandle(String handle) =>
      _handleRe.hasMatch(handle.trim().toLowerCase().replaceAll('@', ''));

  /// Check whether `handle` is validly formatted and still free.
  /// `ok` is true when the handle can be claimed; `message` explains a false.
  ///
  /// Resilient by design: format is validated locally first, then the live
  /// availability endpoint is consulted for real-time "taken" detection. If that
  /// endpoint is unreachable (e.g. not yet deployed), a well-formatted handle is
  /// soft-allowed — the database's UNIQUE constraint still rejects duplicates on
  /// save, so correctness never depends on the check succeeding.
  static Future<({bool ok, String? message})> checkHandle(String handle, {String? uid}) async {
    final h = handle.trim().toLowerCase().replaceAll('@', '');
    if (h.isEmpty) return (ok: false, message: null);
    if (!isValidHandle(h)) {
      return (ok: false, message: '3–20 characters: letters, numbers or _, starting with a letter.');
    }
    try {
      // Pass our own uid so a handle we already own reads as available (yours)
      // rather than "taken" — fixes being blocked by your own handle on re-onboard.
      final mine = (uid != null && uid.isNotEmpty)
          ? '&uid=${Uri.encodeQueryComponent(uid)}'
          : '';
      final r = await http
          .get(Uri.parse('$kHandleCheckUrl?q=${Uri.encodeQueryComponent(h)}$mine'))
          .timeout(const Duration(seconds: 6));
      if (r.statusCode != 200) return (ok: true, message: null); // soft-allow; server enforces on save
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (j['valid'] != true) {
        return (ok: false, message: (j['reason'] ?? 'Invalid handle').toString());
      }
      // A handle owned by an orphaned (pre-backup, keyless) identity can be
      // reclaimed by the account proving it — treat that as claimable.
      if (j['reclaimable'] == true) {
        return (ok: true, message: 'This is your existing handle — reclaiming it');
      }
      if (j['available'] != true) return (ok: false, message: 'That handle is taken');
      return (ok: true, message: null);
    } catch (_) {
      return (ok: true, message: null); // offline / endpoint missing → soft-allow
    }
  }

  /// Publish my own profile so others can find me (by email / phone / handle).
  /// Returns whether the upsert succeeded plus the HTTP status (409 = handle
  /// taken) so callers like onboarding can react; other callers can ignore it.
  // Backoff state for /api/profile calls (prevents 422 hammering).
  static final _profileBackoff = ApiBackoffState('/api/profile');

  /// CALLFIX-R7: public reset for user-initiated saves (profile screen) so a
  /// 422 validation reject doesn't permanently block a corrected resubmission.
  static void resetProfileBackoff() => _profileBackoff.reset();
  // PERF-7: capture the /api/profile rejection body once per session so the
  // exact validation reason (e.g. moderation name_format) shows in telemetry.
  static bool _rejectCaptured = false;

  static Future<({bool ok, int status, String? error, String? field, String? message})> registerProfile(
      {required String uid, String handle = '', String name = '', String email = '', String phone = '',
       String firstName = '', String lastName = '',
       String? encryptedNsecBackup, String? backupMethod, String? accountKind, String? avatarUrl,
       int? birthYear, String? bio, String? gender}) async {
    try {
      // On 422 validation reject: don't retry this call (permanent fail).
      if (_profileBackoff.isPermanentlyFailed) {
        return (ok: false, status: 422, error: 'validation_failed_permanently', field: null, message: null);
      }

      // Handles are retired — names power the directory + contact card. `handle` is
      // accepted but no longer sent. account_kind persists the Single/Parent choice.
      final res = await ApiAuth.postJson(kProfileUrl, {
        'name': name, 'email': email, 'phone': phone,
        if (firstName.isNotEmpty) 'first_name': firstName,
        if (lastName.isNotEmpty) 'last_name': lastName,
        if (encryptedNsecBackup != null) 'encrypted_nsec_backup': encryptedNsecBackup,
        if (backupMethod != null) 'backup_method': backupMethod,
        if (accountKind != null) 'account_kind': accountKind,
        if (avatarUrl != null) 'avatar_url': avatarUrl, // '' clears the photo
        // Optional — powers coarse age-group analytics only; never shown publicly.
        if (birthYear != null) 'birth_year': birthYear,
        // Optional self-description — AvaBrain learns from it (server-side, consent-gated).
        if (bio != null) 'bio': bio,
        // Profile gender → Ava's pronouns when answering calls.
        if (gender != null && gender.isNotEmpty) 'gender': gender,
      },
        // Save-time server vetting runs AI real-name plausibility (Gemini, with a
        // multi-provider fallback chain) + avatar moderation (Rekognition), which
        // routinely exceeds the 8s postJson default — the client was aborting with a
        // status-0 "check your connection" error while the SERVER actually completed
        // and PASSED (telemetry: profile_vet_passed fired AFTER the client gave up).
        // The profile screen holds with an "Ava is checking your profile…" spinner,
        // so a longer wait is expected. 30s comfortably covers the vetting round-trip.
        timeout: const Duration(seconds: 30));
      // Track backoff state: on 422, never retry; on success, reset.
      _profileBackoff.shouldRetry(res.statusCode);

      // P11/R2-F2: surface the server's vetting error so the profile screen can show
      // it inline on the offending field (e.g. implausible_name, profile_incomplete,
      // profile_vet_rejected → { error, field, message }). Only parsed on non-200.
      String? error, field, message;
      if (res.statusCode != 200) {
        if (!_rejectCaptured) {
          _rejectCaptured = true;
          final body = res.body;
          // [ISSUE-PROFILE-PUBLISH-1] (2026-07-09) Renamed from the misleading
          // 'profile_restore_rejected' — this fires when PUBLISHING the local
          // profile to the directory is rejected (e.g. the server's completeness
          // gate 400s an empty launch publish). It has nothing to do with
          // restoring the profile FROM the server, and the old name sent the
          // 2026-07-09 missing-data investigation down the wrong path.
          Analytics.capture('profile_publish_rejected', {
            'status': res.statusCode,
            'body': body.length > 300 ? body.substring(0, 300) : body,
          });
        }
        try {
          final j = jsonDecode(res.body) as Map<String, dynamic>;
          error = (j['error'] ?? '').toString().isEmpty ? null : j['error'].toString();
          field = (j['field'] ?? '').toString().isEmpty ? null : j['field'].toString();
          message = (j['message'] ?? '').toString().isEmpty ? null : j['message'].toString();
        } catch (_) {/* non-JSON body */}
      }
      return (ok: res.statusCode == 200, status: res.statusCode, error: error, field: field, message: message);
    } catch (_) {
      return (ok: false, status: 0, error: null, field: null, message: null); // best-effort
    }
  }

  /// Upload a profile photo (plaintext PNG) to the public bucket; returns the
  /// canonical blossom URL (served + CF-transformed at display time), or null.
  static Future<String?> uploadAvatar(Uint8List bytes) async {
    try {
      // Avatars are compressed to JPEG client-side (see AvatarCropScreen) so the
      // upload — and the server-side moderation that re-fetches it on profile
      // save — stays small and fast.
      final res = await ApiAuth.postBytes(kUploadPublicUrl, bytes,
          extraHeaders: {'x-content-type': 'image/jpeg'}, timeout: const Duration(seconds: 45));
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return (j['url'] ?? '').toString().isEmpty ? null : j['url'].toString();
    } catch (_) {
      return null;
    }
  }

  static String _short(String uid) =>
      uid.length > 16 ? '${uid.substring(0, 10)}…${uid.substring(uid.length - 4)}' : uid;
}
