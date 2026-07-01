import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import '../../core/vault.dart';

/// A saved AvaTok contact. `npub` holds the routing id (Clerk uid). Handles are
/// retired — the network identity shown is the AvaTOK number (or real phone).
@immutable
class Contact {
  final String npub;
  final String name;
  final String handle; // DEPRECATED (handles retired); kept for cache back-compat
  final String email;
  final String avatarUrl; // canonical blossom URL of their photo ('' = initials)
  final String phone; // E.164 (WhatsApp-style phone contacts) — '' if unknown
  final String number; // AvaTOK number display, e.g. '+233 24 555 0148' — '' if none
  const Contact({required this.npub, required this.name, this.handle = '', this.email = '', this.avatarUrl = '', this.phone = '', this.number = ''});

  String get seed => npub; // deterministic avatar seed
  String get atHandle => handle.isEmpty ? '' : '@$handle';
  /// A phone-only caller saved from the AI Receptionist — keyed by a synthetic
  /// `tel:<E.164>` id because they have no AvaTOK account / npub yet.
  bool get isPhoneOnly => npub.startsWith('tel:');
  /// Human-friendly subtitle — AvaTOK number first, then phone, then email.
  String get subtitle => number.isNotEmpty ? number : (phone.isNotEmpty ? phone : email);

  Map<String, dynamic> toJson() => {'npub': npub, 'name': name, 'handle': handle, 'email': email, 'avatarUrl': avatarUrl, 'phone': phone, 'number': number};
  factory Contact.fromJson(Map<String, dynamic> j) => Contact(
        npub: (j['npub'] ?? '').toString(),
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

  /// Add (or update) a contact; de-dupes on npub. Returns the new list.
  Future<List<Contact>> add(Contact c) async {
    final cs = await load();
    cs.removeWhere((x) => x.npub == c.npub);
    cs.insert(0, c);
    await _save(cs);
    _changes.add(cs); // live-refresh any open chat list
    _syncUp(cs); // push encrypted copy to the cross-device vault (best-effort)
    return cs;
  }

  Future<List<Contact>> remove(String npub) async {
    final cs = await load();
    cs.removeWhere((x) => x.npub == npub);
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
    cs.removeWhere((x) => x.npub == 'tel:$e164');
    cs.removeWhere((x) => x.npub == real.npub);
    final merged = real.phone.isEmpty
        ? Contact(npub: real.npub, name: real.name, handle: real.handle,
            email: real.email, avatarUrl: real.avatarUrl, phone: e164, number: real.number)
        : real;
    cs.insert(0, merged);
    await _save(cs);
    _changes.add(cs);
    _syncUp(cs);
    return cs;
  }

  /// Encrypt the contact list with the user's key and upload it so it follows
  /// the user to any device. Best-effort; never throws.
  Future<void> _syncUp(List<Contact> cs) async {
    final id = ApiAuth.identity;
    if (id == null) return;
    try {
      final blob = await Vault.encrypt(
          jsonEncode(cs.map((c) => c.toJson()).toList()), id.privHex);
      await Vault.put('contacts', blob);
    } catch (_) {/* best-effort */}
  }

  /// Pull the encrypted contact list from the vault (on login / new device) and
  /// merge it with anything saved locally (union by npub). On any failure the
  /// local list is left untouched. Returns the resulting list.
  Future<List<Contact>> pullAndMerge() async {
    final id = ApiAuth.identity;
    final local = await load();
    if (id == null) return local;
    final blob = await Vault.get('contacts');
    if (blob == null) return local;
    final plain = await Vault.decrypt(blob, id.privHex);
    if (plain == null) return local;
    List<Contact> remote;
    try {
      remote = (jsonDecode(plain) as List)
          .cast<Map<String, dynamic>>()
          .map(Contact.fromJson)
          .toList();
    } catch (_) {
      return local;
    }
    final byNpub = <String, Contact>{for (final c in local) c.npub: c};
    for (final c in remote) {
      byNpub[c.npub] = c;
    }
    final merged = byNpub.values.where((c) => c.npub.isNotEmpty).toList();
    await _save(merged);
    // If the merge added anything the server didn't have, push the superset back.
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
      if (c.avatarUrl.isNotEmpty || c.npub.isEmpty) continue;
      final r = await Directory.resolve(c.npub);
      if (r != null && r.avatarUrl.isNotEmpty) {
        cs[i] = Contact(npub: c.npub, name: c.name, handle: c.handle, email: c.email, avatarUrl: r.avatarUrl);
        changed = true;
      }
    }
    if (changed) await _save(cs);
    return cs;
  }
}

/// Thin client for the AvaTok directory Worker (handle/npub resolve + search).
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
            ? 'npub'
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
      final npub = j['uid'] ?? j['npub'] ?? p?['uid'];
      if (npub == null) {
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
        npub: npub.toString(),
        name: name.isNotEmpty
            ? name
            : ((p?['email'] ?? '').toString().isNotEmpty ? p!['email'].toString() : _short(npub.toString())),
        email: (p?['email'] ?? '').toString(),
        avatarUrl: (p?['avatar_url'] ?? j['avatar_url'] ?? '').toString(),
        number: (p?['number'] ?? '').toString(),
      );
    } catch (e) {
      // Even with no directory hit, a raw npub is still addable.
      if (q.startsWith('npub1')) {
        Analytics.capture('contact_resolve', {'kind': 'npub', 'found': true, 'reason': 'offline_fallback'});
        return Contact(npub: q, name: _short(q));
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
  static Future<({bool ok, String? message})> checkHandle(String handle, {String? npub}) async {
    final h = handle.trim().toLowerCase().replaceAll('@', '');
    if (h.isEmpty) return (ok: false, message: null);
    if (!isValidHandle(h)) {
      return (ok: false, message: '3–20 characters: letters, numbers or _, starting with a letter.');
    }
    try {
      // Pass our own npub so a handle we already own reads as available (yours)
      // rather than "taken" — fixes being blocked by your own handle on re-onboard.
      final mine = (npub != null && npub.isNotEmpty)
          ? '&npub=${Uri.encodeQueryComponent(npub)}'
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
  static Future<({bool ok, int status})> registerProfile(
      {required String npub, String handle = '', String name = '', String email = '', String phone = '',
       String firstName = '', String lastName = '',
       String? encryptedNsecBackup, String? backupMethod, String? accountKind, String? avatarUrl,
       int? birthYear, String? bio, String? gender}) async {
    try {
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
      });
      return (ok: res.statusCode == 200, status: res.statusCode);
    } catch (_) {
      return (ok: false, status: 0); // best-effort for non-onboarding callers
    }
  }

  /// Upload a profile photo (plaintext PNG) to the public bucket; returns the
  /// canonical blossom URL (served + CF-transformed at display time), or null.
  static Future<String?> uploadAvatar(Uint8List bytes) async {
    try {
      final res = await ApiAuth.postBytes(kUploadPublicUrl, bytes,
          extraHeaders: {'x-content-type': 'image/png'}, timeout: const Duration(seconds: 45));
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return (j['url'] ?? '').toString().isEmpty ? null : j['url'].toString();
    } catch (_) {
      return null;
    }
  }

  static String _short(String npub) =>
      npub.length > 16 ? '${npub.substring(0, 10)}…${npub.substring(npub.length - 4)}' : npub;
}
