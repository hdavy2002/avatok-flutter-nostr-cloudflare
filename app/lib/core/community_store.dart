import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'config.dart';

/// A community = a named hub owning a member list and one or more channels
/// (each channel is a regular AvaTok group, so messaging reuses NIP-17 fan-out).
class Community {
  final String id;
  final String name;
  final String about;
  final String owner; // owner npub
  final List<String> members; // npubs
  final List<String> groups; // channel group ids
  const Community({
    required this.id,
    required this.name,
    this.about = '',
    required this.owner,
    this.members = const [],
    this.groups = const [],
  });

  Community copyWith({String? name, String? about, List<String>? members, List<String>? groups}) =>
      Community(id: id, name: name ?? this.name, about: about ?? this.about, owner: owner,
          members: members ?? this.members, groups: groups ?? this.groups);

  Map<String, dynamic> toJson() =>
      {'id': id, 'name': name, 'about': about, 'owner': owner, 'members': members, 'groups': groups};

  factory Community.fromJson(Map<String, dynamic> j) => Community(
        id: j['id'].toString(),
        name: (j['name'] ?? 'Community').toString(),
        about: (j['about'] ?? '').toString(),
        owner: (j['owner'] ?? '').toString(),
        members: ((j['members'] as List?) ?? []).map((e) => e.toString()).toList(),
        groups: ((j['groups'] as List?) ?? []).map((e) => e.toString()).toList(),
      );

  static String newId() {
    final r = Random.secure();
    return 'c${List<int>.generate(8, (_) => r.nextInt(256)).map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }
}

class CommunityStore {
  static const _key = 'avatok_communities';
  final FlutterSecureStorage _s;
  CommunityStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<List<Community>> load() async {
    final raw = await _s.read(key: _key);
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List).cast<Map<String, dynamic>>().map(Community.fromJson).toList();
    } catch (_) {
      return [];
    }
  }

  Future<List<Community>> _saveAll(List<Community> list) async {
    await _s.write(key: _key, value: jsonEncode(list.map((x) => x.toJson()).toList()));
    return list;
  }

  Future<List<Community>> upsert(Community c) async {
    final list = await load();
    list.removeWhere((x) => x.id == c.id);
    list.insert(0, c);
    return _saveAll(list);
  }

  Future<List<Community>> remove(String id) async {
    final list = await load();
    list.removeWhere((x) => x.id == id);
    return _saveAll(list);
  }

  /// Push a community to the backend so members on other devices can list it.
  static Future<Community?> publish(Community c) async {
    try {
      final res = await http
          .post(Uri.parse(kCommunityUrl),
              headers: {'Content-Type': 'application/json'}, body: jsonEncode(c.toJson()))
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final cj = (j['community'] as Map?)?.cast<String, dynamic>();
      return cj == null ? null : Community.fromJson(cj);
    } catch (_) {
      return null;
    }
  }

  /// Join an existing community by id.
  static Future<Community?> join(String id, String npub) async {
    try {
      final res = await http
          .post(Uri.parse(kCommunityJoinUrl),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({'id': id, 'npub': npub}))
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final cj = (j['community'] as Map?)?.cast<String, dynamic>();
      return cj == null ? null : Community.fromJson(cj);
    } catch (_) {
      return null;
    }
  }

  /// Fetch all communities this member belongs to from the backend.
  static Future<List<Community>> fetchForMember(String npub) async {
    try {
      final res = await http
          .get(Uri.parse('$kCommunitiesUrl?member=${Uri.encodeQueryComponent(npub)}'))
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return [];
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return ((j['communities'] as List?) ?? [])
          .map((e) => Community.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (_) {
      return [];
    }
  }
}
