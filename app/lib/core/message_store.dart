import 'dart:convert';

import 'disk_cache.dart';

/// Local cache of a chat's messages, keyed by conversation key ('1:<peerHex>'
/// or 'g:<groupId>'). Stored as a plain per-account file via [DiskCache] (NOT
/// flutter_secure_storage, whose Android backend is unreliable on some OEMs and
/// was wiping this cache on restart → the chat re-downloaded its whole history
/// from the relay every open).
///
/// We persist a compact JSON view: text, media ENVELOPES (refs/keys only — the
/// decrypted bytes live in MediaService's on-disk cache), location/contact/poll/
/// sticker cards and their metadata. Capped to the most recent [_cap] messages.
class MessageStore {
  static const _prefix = 'avatok_msgs_';
  static const _cap = 300;

  String _name(String convKey) => '$_prefix$convKey';

  Future<List<Map<String, dynamic>>> load(String convKey) async {
    final raw = await DiskCache.read(_name(convKey));
    if (raw == null || raw.isEmpty) return const [];
    try {
      final list = jsonDecode(raw) as List;
      return list
          .map((e) => (e as Map).cast<String, dynamic>())
          // Defensive: a receipt is a control-message, never a bubble. An older
          // build cached some as raw JSON ({"t":"receipt",...}); drop them so they
          // don't reappear as grey JSON messages after the user updates.
          .where((m) => !(m['text'] ?? '').toString().contains('"t":"receipt"'))
          .toList();
    } catch (_) {
      return const [];
    }
  }

  Future<void> save(String convKey, List<Map<String, dynamic>> msgs) async {
    final capped = msgs.length > _cap ? msgs.sublist(msgs.length - _cap) : msgs;
    await DiskCache.write(_name(convKey), jsonEncode(capped));
  }

  Future<void> clear(String convKey) => DiskCache.delete(_name(convKey));
}
