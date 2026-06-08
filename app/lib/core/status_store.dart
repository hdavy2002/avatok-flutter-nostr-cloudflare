import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';

/// A received/own status post (24h ephemeral).
class StatusPost {
  final String id;        // rumor id
  final String authorPub; // x-only hex
  final String authorName;
  final String kind;      // 'text' | 'image'
  final String? text;
  final Map<String, dynamic>? media; // ChatMedia envelope for images
  final int ts;           // epoch seconds
  StatusPost({required this.id, required this.authorPub, required this.authorName,
      required this.kind, this.text, this.media, required this.ts});

  bool get expired => DateTime.now().millisecondsSinceEpoch ~/ 1000 - ts > 24 * 3600;

  Map<String, dynamic> toJson() => {
        'id': id, 'authorPub': authorPub, 'authorName': authorName,
        'kind': kind, 'text': text, 'media': media, 'ts': ts,
      };
  factory StatusPost.fromJson(Map<String, dynamic> j) => StatusPost(
        id: j['id'].toString(),
        authorPub: (j['authorPub'] ?? '').toString(),
        authorName: (j['authorName'] ?? 'Someone').toString(),
        kind: (j['kind'] ?? 'text').toString(),
        text: j['text']?.toString(),
        media: (j['media'] as Map?)?.cast<String, dynamic>(),
        ts: (j['ts'] as num?)?.toInt() ?? 0,
      );
}

/// Stores statuses locally; auto-prunes anything older than 24h.
class StatusStore {
  static const _key = 'avatok_status';
  final FlutterSecureStorage _s = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<List<StatusPost>> load() async {
    final raw = await _s.read(key: scopedKey(_key));
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>().map(StatusPost.fromJson).toList();
      final live = list.where((p) => !p.expired).toList();
      if (live.length != list.length) await _save(live);
      return live;
    } catch (_) {
      return [];
    }
  }

  Future<List<StatusPost>> add(StatusPost p) async {
    final list = await load();
    if (list.any((x) => x.id == p.id)) return list;
    list.insert(0, p);
    await _save(list);
    return list;
  }

  Future<void> _save(List<StatusPost> list) =>
      _s.write(key: scopedKey(_key), value: jsonEncode(list.map((p) => p.toJson()).toList()));
}
