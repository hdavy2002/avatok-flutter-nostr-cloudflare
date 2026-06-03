import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A group: stable id, name, and member pubkeys (hex, x-only). Messages are
/// fan-out gift-wrapped to every member (NIP-17), routed locally by [id].
class Group {
  final String id;
  final String name;
  final List<String> members; // x-only hex pubkeys (incl. me)
  final List<String> admins;  // subset of members who can manage
  const Group({required this.id, required this.name, required this.members, this.admins = const []});

  bool isAdmin(String hex) => admins.contains(hex);

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'members': members, 'admins': admins};
  factory Group.fromJson(Map<String, dynamic> j) => Group(
        id: j['id'].toString(),
        name: (j['name'] ?? 'Group').toString(),
        members: ((j['members'] as List?) ?? []).map((e) => e.toString()).toList(),
        admins: ((j['admins'] as List?) ?? []).map((e) => e.toString()).toList(),
      );

  static String newId() {
    final r = Random.secure();
    return 'g${List<int>.generate(8, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }
}

class GroupStore {
  static const _key = 'avatok_groups';
  final FlutterSecureStorage _s;
  GroupStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<List<Group>> load() async {
    final raw = await _s.read(key: _key);
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List).cast<Map<String, dynamic>>().map(Group.fromJson).toList();
    } catch (_) {
      return [];
    }
  }

  Future<List<Group>> upsert(Group g) async {
    final list = await load();
    list.removeWhere((x) => x.id == g.id);
    list.insert(0, g);
    await _s.write(key: _key, value: jsonEncode(list.map((x) => x.toJson()).toList()));
    return list;
  }

  Future<void> remove(String id) async {
    final list = await load();
    list.removeWhere((x) => x.id == id);
    await _s.write(key: _key, value: jsonEncode(list.map((x) => x.toJson()).toList()));
  }

  Future<Group?> byId(String id) async {
    final list = await load();
    for (final g in list) {
      if (g.id == id) return g;
    }
    return null;
  }
}
