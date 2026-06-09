import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';

/// Local cache of a chat's messages, keyed by conversation key ('1:<peerHex>'
/// or 'g:<groupId>'), namespaced per Clerk account. The Nostr relay does not
/// re-deliver your OWN sent DMs on resubscribe, so without this a user loses
/// their sent messages every time they leave and re-open a chat. We persist a
/// compact, JSON-safe view of each message and reload it on open.
///
/// We persist a compact JSON view: text, media ENVELOPES (refs/keys only — the
/// decrypted bytes live in MediaService's on-disk cache), location/contact/poll/
/// sticker cards and their metadata. Capped to the most recent [_cap] messages
/// per chat.
class MessageStore {
  static const _prefix = 'avatok_msgs_';
  static const _cap = 300;

  final FlutterSecureStorage _s;
  MessageStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  String _key(String convKey) => '$_prefix$convKey';

  Future<List<Map<String, dynamic>>> load(String convKey) async {
    final raw = await readScoped(_s, _key(convKey));
    if (raw == null || raw.isEmpty) return const [];
    try {
      final list = jsonDecode(raw) as List;
      return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> save(String convKey, List<Map<String, dynamic>> msgs) async {
    final capped = msgs.length > _cap ? msgs.sublist(msgs.length - _cap) : msgs;
    try {
      await _s.write(key: scopedKey(_key(convKey)), value: jsonEncode(capped));
    } catch (_) {/* best-effort cache */}
  }

  Future<void> clear(String convKey) =>
      _s.delete(key: scopedKey(_key(convKey)));
}
