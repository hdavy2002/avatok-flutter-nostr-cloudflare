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
import '../../identity/identity.dart' show AccountScope;

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

  String get seed => uid; // deterministic avatar seed
  String get atHandle => handle.isEmpty ? '' : '@$handle';
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

  // Account-scoped: each logged-in Clerk account keeps its OWN contact list.
  // Previously this used a single global key, so contacts leaked between
  // accounts on the same device (e.g. a contact added by one user showed up for
  // another). A fresh account starts empty and is restored from its own vault
  // via [pullAndMerge].
  Future<List<Contact>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      return list.map(Contact.fromJson).toList();
    } catch (e) {
      AvaLog.I.log('cache', 'contacts decode failed: $e');
      return [];
    }
  }

  Future<void> _save(List<Contact> cs) =>
      DiskCache.write(_key, jsonEncode(cs.map((c) => c.toJson()).toList()));

  /// Add (or update) a contact; de-dupes on uid. Returns the new list.
  Future<List<Contact>> add(Contact c) async {
    final cs = await load();
    cs.removeWhere((x) => x.uid == c.uid);
    cs.insert(0, c);
    await _save(cs);
    // [ISSUE-CONTACT-SEMANTICS-1] An explicit add un-deletes: clear any
    // tombstone (and un-hide the thread) so the contact behaves like new.
    final deleted = await deletedContacts();
    if (deleted.remove(c.uid) != null) await _saveMapKey(_kDeletedKey, deleted);
    final hidden = await hiddenThreads();
    if (hidden.remove(c.uid) != null) await _saveMapKey(_kHiddenKey, hidden);
    _changes.add(cs); // live-refresh any open chat list
    _syncUp(cs); // push encrypted copy to the cross-device vault (best-effort)
    return cs;
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

  Future<Map<String, int>> _loadMapKey(String key) async {
    try {
      final raw = await DiskCache.read(key);
      if (raw == null || raw.isEmpty) return {};
      final m = jsonDecode(raw) as Map<String, dynamic>;
      return {for (final e in m.entries) e.key: (e.value as num?)?.toInt() ?? 0};
    } catch (_) {
      return {};
    }
  }

  Future<void> _saveMapKey(String key, Map<String, int> m) =>
      DiskCache.write(key, jsonEncode(m));

  /// Tombstoned (deleted) contact uids → deleted-at ms.
  Future<Map<String, int>> deletedContacts() => _loadMapKey(_kDeletedKey);

  /// Hidden 1:1 threads: peer uid → hidden-at ms.
  Future<Map<String, int>> hiddenThreads() => _loadMapKey(_kHiddenKey);

  /// DELETE from the AvaTOK contact book, permanently (tombstoned).
  Future<List<Contact>> deleteContact(String uid) async {
    final deleted = await deletedContacts();
    deleted[uid] = DateTime.now().millisecondsSinceEpoch;
    await _saveMapKey(_kDeletedKey, deleted);
    final cs = await load();
    cs.removeWhere((x) => x.uid == uid);
    await _save(cs);
    _changes.add(cs);
    Analytics.capture('contact_deleted', const {});
    _syncUp(cs);
    return cs;
  }

  /// Hide the chat thread; the contact itself is untouched.
  Future<void> hideThread(String uid) async {
    final hidden = await hiddenThreads();
    hidden[uid] = DateTime.now().millisecondsSinceEpoch;
    await _saveMapKey(_kHiddenKey, hidden);
    Analytics.capture('thread_hidden', const {});
    _syncUp(await load());
  }

  /// LEGACY removal — kept for callers outside the chat-list menu. Now maps to
  /// the hard delete (tombstoned) since that matches the old visible effect.
  Future<List<Contact>> remove(String uid) async {
    final cs = await load();
    cs.removeWhere((x) => x.uid == uid);
    await _save(cs);
    _changes.add(cs);
    _syncUp(cs);
    return cs;
  }

  /// Promote a phone-only `tel:<e164>` contact to a real AvaTOK account once
  /// that caller is discovered to have joined. Drops the synthetic row and adds
  /// the real one, carrying the phone number across if the resolved profile
  /// didn't include it. The conv key derives from the number either way, so the
  /// thread and its receptionist cards stay intact through the merge.
  Future<List<Contact>> mergeTel(String e164, Contact real) async {
    final cs = await load();
    cs.removeWhere((x) => x.uid == 'tel:$e164');
    cs.removeWhere((x) => x.uid == real.uid);
    final merged = real.phone.isEmpty
        ? Contact(uid: real.uid, name: real.name, handle: real.handle,
            email: real.email, avatarUrl: real.avatarUrl, phone: e164, number: real.number)
        : real;
    cs.insert(0, merged);
    await _save(cs);
    _changes.add(cs);
    _syncUp(cs);
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

  /// Encrypt the contact list with the user's key and upload it so it follows
  /// the user to any device. Best-effort; never throws.
  Future<void> _syncUp(List<Contact> cs) async {
    final id = ApiAuth.identity;
    if (id == null) return;
    if (_vaultHydratedFor != _scopeKey) {
      // Never pushed-before-pulled. pullAndMerge unions local into remote and
      // pushes the superset itself, so the mutation still reaches the vault —
      // without ever being able to shrink it.
      Analytics.capture('contacts_syncup_deferred', {'reason': 'not_hydrated', 'local_count': cs.length});
      unawaited(pullAndMerge());
      return;
    }
    final keyMat = await AccountKey.I.ensureHex();
    if (keyMat == null) return; // no account key yet (offline) — the next sync carries it
    try {
      // [ISSUE-CONTACT-SEMANTICS-1] Vault blob v2: carries the deleted-contact
      // tombstones + hidden-thread map alongside the contacts, so "deleted stays
      // deleted" and "removed threads stay removed" across reinstalls/devices.
      // (v1 blobs — a bare JSON list — are still read by pullAndMerge.)
      final blob = await Vault.encrypt(
          jsonEncode({
            'v': 2,
            'contacts': cs.map((c) => c.toJson()).toList(),
            'deleted': await deletedContacts(),
            'hidden': await hiddenThreads(),
          }),
          keyMat);
      await Vault.put('contacts', blob);
    } catch (_) {/* best-effort */}
  }

  /// Pull the encrypted contact list from the vault (on login / new device) and
  /// merge it with anything saved locally (union by uid). On any failure the
  /// local list is left untouched. Returns the resulting list.
  Future<List<Contact>> pullAndMerge() async {
    final id = ApiAuth.identity;
    final local = await load();
    if (id == null) return local;
    final keyMat = await AccountKey.I.ensureHex(); // restores from escrow / mints + escrows the key
    // [ISSUE-VAULT-RESTORE-1] (2026-07-09) Tri-state fetch with retries. The old
    // `Vault.get` returned null for BOTH "no backup" and "request failed", and a
    // single 8s-timeout failure at first login left the contact list empty with
    // no retry and no telemetry — while the backup sat intact on the server.
    final fetch = await Vault.fetch('contacts');
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
      // (fresh account), so pushes may proceed from here on.
      _vaultHydratedFor = _scopeKey;
      Analytics.capture('contacts_restored', {'remote_count': 0, 'local_count': local.length, 'confirmed_empty': true});
      return local;
    }
    final blob = fetch.blob!;
    final plain = keyMat == null ? null : await Vault.decrypt(blob, keyMat);
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
    _vaultHydratedFor = _scopeKey; // pulled + decrypted — pushes are safe now
    // Merge tombstones + hidden maps (per-uid latest timestamp wins on both sides).
    final deleted = await deletedContacts();
    for (final e in remoteDeleted.entries) {
      if ((deleted[e.key] ?? 0) < e.value) deleted[e.key] = e.value;
    }
    await _saveMapKey(_kDeletedKey, deleted);
    final hidden = await hiddenThreads();
    for (final e in remoteHidden.entries) {
      if ((hidden[e.key] ?? 0) < e.value) hidden[e.key] = e.value;
    }
    await _saveMapKey(_kHiddenKey, hidden);
    final byNpub = <String, Contact>{for (final c in local) c.uid: c};
    for (final c in remote) {
      byNpub[c.uid] = c;
    }
    // Deleted contacts stay deleted — drop tombstoned uids from the merge.
    final merged = byNpub.values
        .where((c) => c.uid.isNotEmpty && !deleted.containsKey(c.uid))
        .toList();
    await _save(merged);
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
    if (merged.length != remote.length) _syncUp(merged);
    return merged;
  }

  /// Backfill profile photos for contacts saved before avatarUrl existed (or
  /// whose photo changed): resolve each one missing an avatar from the directory
  /// and persist. Best-effort, runs in the background. Returns the updated list.
  Future<List<Contact>> refreshMissingAvatars() async {
    final cs = await load();
    var changed = false;
    for (var i = 0; i < cs.length; i++) {
      final c = cs[i];
      if (c.avatarUrl.isNotEmpty || c.uid.isEmpty) continue;
      final r = await Directory.resolve(c.uid);
      if (r != null && r.avatarUrl.isNotEmpty) {
        cs[i] = Contact(uid: c.uid, name: c.name, handle: c.handle, email: c.email, avatarUrl: r.avatarUrl);
        changed = true;
      }
    }
    if (changed) await _save(cs);
    return cs;
  }
}

/// Thin client for the AvaTok directory Worker (handle/uid resolve + search).
class Directory {
  /// Resolve `@handle`, `handle`, or `npub1…` → a Contact, or null if unknown.
  static Future<Contact?> resolve(String query) async {
    final q = query.trim();
    if (q.isEmpty) return null;
    // Classify the query so resolve telemetry can be sliced by id type — this is
    // the key signal for the "DMs stuck on waiting-to-reach-phone" bug class.
    final kind = q.startsWith('@')
        ? 'handle'
        : q.startsWith('npub1')
            ? 'uid'
            : q.contains('@')
                ? 'email'
                : RegExp(r'^[+\d]').hasMatch(q)
                    ? 'phone'
                    : 'name';
    try {
      final r = await http
          .get(Uri.parse('$kResolveUrl?q=${Uri.encodeQueryComponent(q)}'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) {
        Analytics.capture('contact_resolve', {'kind': kind, 'found': false, 'reason': 'http_${r.statusCode}'});
        return null;
      }
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final p = j['profile'] as Map<String, dynamic>?;
      // Cloudflare-native: the directory returns `uid` (Clerk id) as the
      // addressing id. Accept it at the top level OR nested under `profile`
      // (older worker shape) so a contact ALWAYS gets a routable id — a missing
      // id here was leaving DMs stuck on "waiting to reach phone".
      final uid = j['uid'] ?? j['uid'] ?? p?['uid'];
      if (uid == null) {
        // Server said found:false (or a shape we can't address) — the exact case
        // that silently broke delivery. Track it so we catch regressions early.
        Analytics.capture('contact_resolve',
            {'kind': kind, 'found': false, 'reason': j['found'] == false ? 'not_registered' : 'no_uid'});
        return null;
      }
      Analytics.capture('contact_resolve', {'kind': kind, 'found': true});
      final first = (p?['first_name'] ?? '').toString();
      final last = (p?['last_name'] ?? '').toString();
      final assembled = [first, last].where((s) => s.isNotEmpty).join(' ').trim();
      final name = (p?['name'] ?? p?['display_name'] ?? '').toString().isNotEmpty
          ? (p?['name'] ?? p?['display_name']).toString()
          : assembled;
      return Contact(
        uid: uid.toString(),
        name: name.isNotEmpty
            ? name
            : ((p?['email'] ?? '').toString().isNotEmpty ? p!['email'].toString() : _short(uid.toString())),
        email: (p?['email'] ?? '').toString(),
        avatarUrl: (p?['avatar_url'] ?? j['avatar_url'] ?? '').toString(),
        number: (p?['number'] ?? '').toString(),
      );
    } catch (e) {
      // Even with no directory hit, a raw uid is still addable.
      if (q.startsWith('npub1')) {
        Analytics.capture('contact_resolve', {'kind': 'uid', 'found': true, 'reason': 'offline_fallback'});
        return Contact(uid: q, name: _short(q));
      }
      Analytics.capture('contact_resolve', {'kind': kind, 'found': false, 'reason': 'error'});
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
