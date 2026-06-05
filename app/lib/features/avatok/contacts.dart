import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../../core/api_auth.dart';
import '../../core/config.dart';

/// A saved AvaTok contact (resolved to a Nostr npub).
@immutable
class Contact {
  final String npub;
  final String name;
  final String handle; // without leading '@', may be empty
  final String email;
  const Contact({required this.npub, required this.name, this.handle = '', this.email = ''});

  String get seed => npub; // deterministic avatar seed
  String get atHandle => handle.isEmpty ? '' : '@$handle';
  /// Human-friendly subtitle — prefer email, fall back to @handle.
  String get subtitle => email.isNotEmpty ? email : atHandle;

  Map<String, dynamic> toJson() => {'npub': npub, 'name': name, 'handle': handle, 'email': email};
  factory Contact.fromJson(Map<String, dynamic> j) => Contact(
        npub: (j['npub'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        handle: (j['handle'] ?? '').toString(),
        email: (j['email'] ?? '').toString(),
      );
}

/// Persists the user's contact list locally (not secret, but reuse secure store).
class ContactsStore {
  static const _key = 'avatok_contacts';
  final FlutterSecureStorage _s;
  ContactsStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<List<Contact>> load() async {
    final raw = await _s.read(key: _key);
    if (raw == null || raw.isEmpty) return [];
    final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    return list.map(Contact.fromJson).toList();
  }

  Future<void> _save(List<Contact> cs) =>
      _s.write(key: _key, value: jsonEncode(cs.map((c) => c.toJson()).toList()));

  /// Add (or update) a contact; de-dupes on npub. Returns the new list.
  Future<List<Contact>> add(Contact c) async {
    final cs = await load();
    cs.removeWhere((x) => x.npub == c.npub);
    cs.insert(0, c);
    await _save(cs);
    return cs;
  }

  Future<List<Contact>> remove(String npub) async {
    final cs = await load();
    cs.removeWhere((x) => x.npub == npub);
    await _save(cs);
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
      final npub = j['npub'];
      if (npub == null) return null;
      final p = j['profile'] as Map<String, dynamic>?;
      return Contact(
        npub: npub.toString(),
        name: (p?['name'] ?? '').toString().isNotEmpty
            ? p!['name'].toString()
            : ((p?['email'] ?? '').toString().isNotEmpty ? p!['email'].toString() : _short(npub.toString())),
        handle: (p?['handle'] ?? '').toString(),
        email: (p?['email'] ?? '').toString(),
      );
    } catch (_) {
      // Even with no directory hit, a raw npub is still addable.
      if (q.startsWith('npub1')) {
        return Contact(npub: q, name: _short(q));
      }
      return null;
    }
  }

  /// Search the public directory by handle/name (>= 2 chars).
  static Future<List<Contact>> search(String query) async {
    final q = query.trim();
    if (q.length < 2) return [];
    try {
      final r = await http
          .get(Uri.parse('$kSearchUrl?q=${Uri.encodeQueryComponent(q)}'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final list = (j['results'] as List?)?.cast<Map<String, dynamic>>() ?? [];
      return list
          .map((p) => Contact(
                npub: (p['npub'] ?? '').toString(),
                name: (p['name'] ?? '').toString().isNotEmpty
                    ? p['name'].toString()
                    : ((p['email'] ?? '').toString().isNotEmpty ? p['email'].toString() : _short((p['npub'] ?? '').toString())),
                handle: (p['handle'] ?? '').toString(),
                email: (p['email'] ?? '').toString(),
              ))
          .where((c) => c.npub.isNotEmpty)
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Publish my own profile so others can find me (by email / phone / handle).
  static Future<void> registerProfile(
      {required String npub, String handle = '', String name = '', String email = '', String phone = ''}) async {
    try {
      // npub is derived server-side from the NIP-98 signature; no longer in body.
      await ApiAuth.postJson(kProfileUrl,
          {'handle': handle, 'name': name, 'email': email, 'phone': phone});
    } catch (_) {/* best-effort */}
  }

  static String _short(String npub) =>
      npub.length > 16 ? '${npub.substring(0, 10)}…${npub.substring(npub.length - 4)}' : npub;
}
