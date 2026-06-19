import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import '../../core/vault.dart';

/// A saved AvaTok contact (resolved to a Nostr npub).
@immutable
class Contact {
  final String npub;
  final String name;
  final String handle; // without leading '@', may be empty
  final String email;
  final String avatarUrl; // canonical blossom URL of their photo ('' = initials)
  final String phone; // E.164 (WhatsApp-style phone contacts) — '' if unknown
  const Contact({required this.npub, required this.name, this.handle = '', this.email = '', this.avatarUrl = '', this.phone = ''});

  String get seed => npub; // deterministic avatar seed
  String get atHandle => handle.isEmpty ? '' : '@$handle';
  /// Human-friendly subtitle — prefer phone (WhatsApp-style), then @handle/email.
  String get subtitle => phone.isNotEmpty ? phone : (atHandle.isNotEmpty ? atHandle : email);

  Map<String, dynamic> toJson() => {'npub': npub, 'name': name, 'handle': handle, 'email': email, 'avatarUrl': avatarUrl, 'phone': phone};
  factory Contact.fromJson(Map<String, dynamic> j) => Contact(
        npub: (j['npub'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        handle: (j['handle'] ?? '').toString(),
        email: (j['email'] ?? '').toString(),
        avatarUrl: (j['avatarUrl'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
      );
}

/// Persists the user's contact list locally (not secret, but reuse secure store).
class ContactsStore {
  // Bulk cache → on-disk per-account file (NOT secure storage, which is flaky on
  // some OEMs and was silently returning empty after restart → blank chat list).
  static const _key = 'avatok_contacts';

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
    _syncUp(cs); // push encrypted copy to the cross-device vault (best-effort)
    return cs;
  }

  Future<List<Contact>> remove(String npub) async {
    final cs = await load();
    cs.removeWhere((x) => x.npub == npub);
    await _save(cs);
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
    try {
      final r = await http
          .get(Uri.parse('$kResolveUrl?q=${Uri.encodeQueryComponent(q)}'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      // Cloudflare-native: the directory now returns `uid` (Clerk id) as the
      // addressing id. The Contact.npub field carries this uid value.
      final npub = j['uid'] ?? j['npub'];
      if (npub == null) return null;
      final p = j['profile'] as Map<String, dynamic>?;
      return Contact(
        npub: npub.toString(),
        name: (p?['name'] ?? '').toString().isNotEmpty
            ? p!['name'].toString()
            : ((p?['email'] ?? '').toString().isNotEmpty ? p!['email'].toString() : _short(npub.toString())),
        handle: (p?['handle'] ?? '').toString(),
        email: (p?['email'] ?? '').toString(),
        avatarUrl: (p?['avatar_url'] ?? j['avatar_url'] ?? '').toString(),
      );
    } catch (_) {
      // Even with no directory hit, a raw npub is still addable.
      if (q.startsWith('npub1')) {
        return Contact(npub: q, name: _short(q));
      }
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
  static Future<List<Contact>> search(String query) async {
    final q = query.trim();
    if (q.length < 2) return [];
    // Complete email → exact, privacy-preserving lookup (FTS never indexes email).
    if (isCompleteEmail(q)) {
      final c = await resolve(q);
      return c == null ? <Contact>[] : <Contact>[c];
    }
    try {
      final r = await http
          .get(Uri.parse('$kSearchUrl?q=${Uri.encodeQueryComponent(q)}'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final list = (j['results'] as List?)?.cast<Map<String, dynamic>>() ?? [];
      return list
          .map((p) => Contact(
                npub: (p['uid'] ?? p['npub'] ?? '').toString(),
                name: (p['name'] ?? '').toString().isNotEmpty
                    ? p['name'].toString()
                    : ((p['email'] ?? '').toString().isNotEmpty ? p['email'].toString() : _short((p['uid'] ?? p['npub'] ?? '').toString())),
                handle: (p['handle'] ?? '').toString(),
                email: (p['email'] ?? '').toString(),
                avatarUrl: (p['avatar_url'] ?? '').toString(),
              ))
          .where((c) => c.npub.isNotEmpty)
          .toList();
    } catch (_) {
      return [];
    }
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
       String? encryptedNsecBackup, String? backupMethod, String? accountKind, String? avatarUrl,
       int? birthYear}) async {
    try {
      // npub is derived server-side from the NIP-98 signature; no longer in body.
      // encrypted_nsec_backup (optional) links this key to the Clerk account so
      // the user can restore it after reinstalling / on another device.
      // account_kind persists the Single/Parent/Enterprise choice server-side
      // so it restores cross-device too.
      final res = await ApiAuth.postJson(kProfileUrl, {
        'handle': handle, 'name': name, 'email': email, 'phone': phone,
        if (encryptedNsecBackup != null) 'encrypted_nsec_backup': encryptedNsecBackup,
        if (backupMethod != null) 'backup_method': backupMethod,
        if (accountKind != null) 'account_kind': accountKind,
        if (avatarUrl != null) 'avatar_url': avatarUrl, // '' clears the photo
        // Optional — powers coarse age-group analytics only; never shown publicly.
        if (birthYear != null) 'birth_year': birthYear,
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
