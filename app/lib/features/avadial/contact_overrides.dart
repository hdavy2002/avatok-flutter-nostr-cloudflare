import 'dart:convert';

import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import 'device_contacts.dart';

/// AVA-side metadata layered on top of the READ-ONLY device phone book (plan §4.7
/// device-data boundary — [DeviceContacts] never writes to the OS contacts
/// provider; there is no native "write contact" channel yet). Backs the Calls
/// app's "Edit contact" / "Remove contact" / "Delete contact" row actions:
///
///  - A [displayName] override (used instead of the device's cached name).
///  - A [hidden] flag — "removed"/"deleted" numbers stop showing up in the
///    Contacts tab. This is the best-effort equivalent of deleting a device
///    contact until a native write path exists; it never touches the OS phone
///    book, so unhiding is always possible (nothing is destroyed).
///
/// Account-scoped via [DiskCache] (same pattern as [BlockList]), keyed by the
/// same normalized suffix [DeviceContacts.normKey] uses for lookups.
class ContactOverride {
  final String number;
  final String? displayName;
  final bool hidden;
  const ContactOverride({required this.number, this.displayName, this.hidden = false});

  Map<String, dynamic> toJson() => {
        'number': number,
        if (displayName != null) 'displayName': displayName,
        'hidden': hidden,
      };

  factory ContactOverride.fromJson(Map<String, dynamic> j) => ContactOverride(
        number: '${j['number']}',
        displayName: j['displayName'] as String?,
        hidden: j['hidden'] == true,
      );
}

class ContactOverrides {
  ContactOverrides._();
  static final ContactOverrides I = ContactOverrides._();

  static const _kCache = 'avadial_contact_overrides';

  Future<Map<String, ContactOverride>> _loadMap() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return {};
      final list = (jsonDecode(raw) as List<dynamic>)
          .whereType<Map>()
          .map((m) => ContactOverride.fromJson(m.map((k, v) => MapEntry('$k', v))));
      return {for (final o in list) DeviceContacts.normKey(o.number): o};
    } catch (e) {
      AvaLog.I.log('avadial', 'contact overrides load failed: $e');
      return {};
    }
  }

  Future<void> _saveMap(Map<String, ContactOverride> m) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(m.values.map((o) => o.toJson()).toList()));
    } catch (e) {
      AvaLog.I.log('avadial', 'contact overrides save failed: $e');
    }
  }

  Future<List<ContactOverride>> load() async => (await _loadMap()).values.toList();

  Future<ContactOverride?> forNumber(String number) async =>
      (await _loadMap())[DeviceContacts.normKey(number)];

  /// Set (or clear, when [displayName] is null and not [hidden]) the override for
  /// a number — used by the Edit-contact screen.
  Future<void> setName(String number, String? displayName) async {
    final m = await _loadMap();
    final key = DeviceContacts.normKey(number);
    final existing = m[key];
    m[key] = ContactOverride(number: number, displayName: displayName, hidden: existing?.hidden ?? false);
    await _saveMap(m);
  }

  /// Hide a number from the Contacts tab ("Remove contact" / "Delete contact").
  /// Never deletes the underlying device contact — just Ava's own view of it.
  Future<void> hide(String number) async {
    final m = await _loadMap();
    final key = DeviceContacts.normKey(number);
    final existing = m[key];
    m[key] = ContactOverride(number: number, displayName: existing?.displayName, hidden: true);
    await _saveMap(m);
  }

  Future<void> unhide(String number) async {
    final m = await _loadMap();
    final key = DeviceContacts.normKey(number);
    final existing = m[key];
    if (existing == null) return;
    m[key] = ContactOverride(number: number, displayName: existing.displayName, hidden: false);
    await _saveMap(m);
  }
}
