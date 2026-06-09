import 'dart:convert';

import 'disk_cache.dart';

/// A user-defined chat-list filter (the "+" chip). Matches a keyword against
/// chat names — a lightweight version of WhatsApp's custom lists.
class ChatFilter {
  final String name;
  final String query; // lowercased substring to match on the chat name
  const ChatFilter({required this.name, required this.query});

  Map<String, dynamic> toJson() => {'name': name, 'query': query};
  factory ChatFilter.fromJson(Map<String, dynamic> j) =>
      ChatFilter(name: (j['name'] ?? '').toString(), query: (j['query'] ?? '').toString());
}

/// Bulk, non-secret → plain per-account file (DiskCache), not encrypted storage.
class FilterStore {
  static const _key = 'avatok_custom_filters';

  Future<List<ChatFilter>> load() async {
    final raw = await DiskCache.read(_key);
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List).cast<Map<String, dynamic>>().map(ChatFilter.fromJson).toList();
    } catch (_) {
      return [];
    }
  }

  Future<List<ChatFilter>> add(ChatFilter f) async {
    final list = await load();
    list.removeWhere((x) => x.name.toLowerCase() == f.name.toLowerCase());
    list.add(f);
    await DiskCache.write(_key, jsonEncode(list.map((x) => x.toJson()).toList()));
    return list;
  }

  Future<List<ChatFilter>> remove(String name) async {
    final list = await load();
    list.removeWhere((x) => x.name.toLowerCase() == name.toLowerCase());
    await DiskCache.write(_key, jsonEncode(list.map((x) => x.toJson()).toList()));
    return list;
  }
}
