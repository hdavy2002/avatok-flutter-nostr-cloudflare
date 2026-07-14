import 'dart:convert';

import 'package:flutter/material.dart';

import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import 'avadial_refresh.dart';
import 'contact_overrides.dart';

/// One colour "circle" group a contact can be filed under (Family / Office /
/// Friends / Personal, plus any user-created custom group) — used for quick
/// visual filtering of the AvaDial Contacts tab. [AVADIAL-GROUPS-1]
class ContactGroup {
  final String id;
  final String name;
  final int color;

  const ContactGroup({required this.id, required this.name, required this.color});

  Color get colorValue => Color(color);

  bool get isBuiltIn => ContactGroups.builtIns.any((g) => g.id == id);

  /// Label shown inside the small colour circle — trimmed, capped at 8 chars,
  /// no ellipsis padding.
  String get shortName {
    final trimmed = name.trim();
    if (trimmed.length <= 8) return trimmed;
    return trimmed.substring(0, 8).trimRight();
  }

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'color': color};

  factory ContactGroup.fromJson(Map<String, dynamic> j) => ContactGroup(
        id: '${j['id']}',
        name: '${j['name'] ?? ''}',
        color: (j['color'] as num?)?.toInt() ?? 0xFF999999,
      );
}

/// [AVADIAL-GROUPS-1] Account-scoped store for the colour groups ("circles")
/// users file contacts under in the AvaDial Contacts tab (Family/Office/
/// Friends/Personal, plus custom groups). Only the user-created custom groups
/// are persisted — the four built-ins are compile-time constants prepended on
/// every [load]. Backed by [DiskCache] (same account-scoped pattern as
/// [ContactOverrides] / [BlockList]).
class ContactGroups {
  ContactGroups._();
  static final ContactGroups I = ContactGroups._();

  static const _kCache = 'avadial_contact_groups';

  static const List<ContactGroup> builtIns = [
    ContactGroup(id: 'family', name: 'Family', color: 0xFF6FB6FF),
    ContactGroup(id: 'office', name: 'Office', color: 0xFFFF7B7B),
    ContactGroup(id: 'friends', name: 'Friends', color: 0xFFFFA23E),
    ContactGroup(id: 'personal', name: 'Personal', color: 0xFFFF8FC8),
  ];

  Future<List<ContactGroup>> _loadCustom() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return [];
      return (jsonDecode(raw) as List<dynamic>)
          .whereType<Map>()
          .map((m) => ContactGroup.fromJson(m.map((k, v) => MapEntry('$k', v))))
          .toList();
    } catch (e) {
      AvaLog.I.log('avadial', 'contact groups load failed: $e');
      return [];
    }
  }

  Future<void> _saveCustom(List<ContactGroup> groups) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(groups.map((g) => g.toJson()).toList()));
      bumpAvaDial();
    } catch (e) {
      AvaLog.I.log('avadial', 'contact groups save failed: $e');
    }
  }

  /// Built-ins first, then any user-created groups in creation order.
  Future<List<ContactGroup>> load() async => [...builtIns, ...await _loadCustom()];

  /// Create a custom group. Name is trimmed; a no-op (returns null) when the
  /// trimmed name is empty.
  Future<ContactGroup?> create(String name, int color) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return null;
    final custom = await _loadCustom();
    final group = ContactGroup(
      id: 'g_${DateTime.now().millisecondsSinceEpoch}',
      name: trimmed,
      color: color,
    );
    custom.add(group);
    await _saveCustom(custom);
    return group;
  }

  /// Delete a CUSTOM group (built-ins can never be deleted — no-op). Clears
  /// the groupId from every contact override that referenced it.
  Future<void> delete(String id) async {
    if (builtIns.any((g) => g.id == id)) return;
    final custom = await _loadCustom();
    final before = custom.length;
    custom.removeWhere((g) => g.id == id);
    if (custom.length == before) return;
    await _saveCustom(custom);
    await ContactOverrides.I.clearGroup(id);
  }

  /// Look up one group by id (built-ins + custom). null when unknown.
  Future<ContactGroup?> byId(String id) async {
    for (final g in builtIns) {
      if (g.id == id) return g;
    }
    final custom = await _loadCustom();
    for (final g in custom) {
      if (g.id == id) return g;
    }
    return null;
  }
}
