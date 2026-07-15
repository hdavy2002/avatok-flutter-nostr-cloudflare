import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'disk_cache.dart';

/// A group: stable id, name, and member pubkeys (hex, x-only). Messages are
/// fanned out to every member over the Cloudflare-native transport, routed locally by [id].
class Group {
  final String id;
  final String name;
  final List<String> members; // x-only hex pubkeys (incl. me)
  final List<String> admins;  // subset of members who can manage
  final String description;
  /// [GROUP-AVATAR-1] Canonical public (blossom) URL of the group photo — '' means
  /// none, and the UI falls back to the generated initials tile. Server-backed:
  /// `conversations.avatar_url`, returned by convList and set via
  /// POST /api/conversations/avatar (admins only).
  final String avatarUrl;
  const Group({required this.id, required this.name, required this.members, this.admins = const [], this.description = '', this.avatarUrl = ''});

  bool isAdmin(String hex) => admins.contains(hex);

  Group copyWith({String? name, List<String>? members, List<String>? admins, String? description, String? avatarUrl}) =>
      Group(id: id, name: name ?? this.name, members: members ?? this.members,
          admins: admins ?? this.admins, description: description ?? this.description,
          avatarUrl: avatarUrl ?? this.avatarUrl);

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'members': members, 'admins': admins, 'description': description, 'avatarUrl': avatarUrl};
  factory Group.fromJson(Map<String, dynamic> j) => Group(
        id: j['id'].toString(),
        name: (j['name'] ?? 'Group').toString(),
        members: ((j['members'] as List?) ?? []).map((e) => e.toString()).toList(),
        admins: ((j['admins'] as List?) ?? []).map((e) => e.toString()).toList(),
        description: (j['description'] ?? '').toString(),
        // Accept BOTH shapes: the local cache writes 'avatarUrl', the server's
        // conversation row carries 'avatar_url'. One parser, both sources.
        avatarUrl: (j['avatarUrl'] ?? j['avatar_url'] ?? '').toString(),
      );

  static String newId() {
    final r = Random.secure();
    return 'g${List<int>.generate(8, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }
}

class GroupStore {
  // Bulk, non-secret → plain per-account file (DiskCache), not encrypted storage
  // (whose reads are slow on Samsung and were part of the ~1.2s cold-start load).
  static const _key = 'avatok_groups';
  static const _legacy = FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), 
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<List<Group>> load() async {
    var raw = await DiskCache.read(_key);
    if (raw == null) {
      try { raw = await _legacy.read(key: scopedKey(_key)); } catch (_) {}
      if (raw != null && raw.isNotEmpty) await DiskCache.write(_key, raw); // migrate once
    }
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
    await DiskCache.write(_key, jsonEncode(list.map((x) => x.toJson()).toList()));
    return list;
  }

  Future<void> remove(String id) async {
    final list = await load();
    list.removeWhere((x) => x.id == id);
    await DiskCache.write(_key, jsonEncode(list.map((x) => x.toJson()).toList()));
  }

  /// Wipe ALL locally-cached groups (both the DiskCache copy and the legacy
  /// secure-storage copy). Used by the one-time "start fresh" migration that
  /// drops pre-server-backed (local-only) groups so they don't linger after an
  /// update; valid server groups are then re-pulled via GroupApi.sync().
  Future<void> clear() async {
    await DiskCache.write(_key, '[]');
    try { await _legacy.delete(key: scopedKey(_key)); } catch (_) {/* best-effort */}
  }

  Future<Group?> byId(String id) async {
    final list = await load();
    for (final g in list) {
      if (g.id == id) return g;
    }
    return null;
  }
}
