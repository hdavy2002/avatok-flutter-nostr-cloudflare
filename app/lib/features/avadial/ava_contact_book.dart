import 'dart:convert';

import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import 'contact_overrides.dart';
import 'device_contacts.dart';

/// One entry in the **AvaTOK contact book** — a local, AvaTOK-owned snapshot of a
/// contact (owner request 2026-07-13). This is what makes AvaTOK independent of
/// Google/Gmail: contacts live locally here AND (Phase 2) get backed up to AvaTOK's
/// own servers, so losing a Google account or a SIM never locks the user out.
///
/// It merges the device phone book with AvaTOK's own extra fields (AvaTOK number,
/// emails, LinkedIn, custom fields) into one portable record.
class AvaBookContact {
  final String name;
  final String number;
  final String? avatokNumber;
  final String? personalEmail;
  final String? businessEmail;
  final String? linkedin;
  final List<ContactField> customFields;
  final String source; // 'device' | 'avatok'

  const AvaBookContact({
    required this.name,
    required this.number,
    this.avatokNumber,
    this.personalEmail,
    this.businessEmail,
    this.linkedin,
    this.customFields = const [],
    this.source = 'device',
  });

  Map<String, dynamic> toJson() => {
        'name': name,
        'number': number,
        if (avatokNumber != null) 'avatokNumber': avatokNumber,
        if (personalEmail != null) 'personalEmail': personalEmail,
        if (businessEmail != null) 'businessEmail': businessEmail,
        if (linkedin != null) 'linkedin': linkedin,
        if (customFields.isNotEmpty)
          'customFields': customFields.map((f) => f.toJson()).toList(),
        'source': source,
      };

  factory AvaBookContact.fromJson(Map<String, dynamic> j) => AvaBookContact(
        name: '${j['name'] ?? ''}',
        number: '${j['number'] ?? ''}',
        avatokNumber: j['avatokNumber'] as String?,
        personalEmail: j['personalEmail'] as String?,
        businessEmail: j['businessEmail'] as String?,
        linkedin: j['linkedin'] as String?,
        customFields: (j['customFields'] as List<dynamic>? ?? const [])
            .whereType<Map>()
            .map((m) => ContactField.fromJson(m.map((k, v) => MapEntry('$k', v))))
            .toList(),
        source: '${j['source'] ?? 'device'}',
      );
}

/// Local AvaTOK contact book — a single account-scoped snapshot persisted via
/// [DiskCache]. Rebuilt from the merged device+AvaTOK view whenever the Contacts
/// tab loads. Phase 2 pushes/pulls this exact blob to AvaTOK's servers for
/// backup/restore (server-side encrypted, owner decision 2026-07-13).
class AvaContactBook {
  AvaContactBook._();
  static final AvaContactBook I = AvaContactBook._();

  static const _kCache = 'ava_contact_book';

  /// Rebuild + persist the book from the current merged Contacts view.
  Future<void> capture(
      List<DeviceContact> device, Map<String, ContactOverride> overrides) async {
    try {
      final out = <AvaBookContact>[];
      final seen = <String>{};
      for (final c in device) {
        final key = DeviceContacts.normKey(c.number);
        final o = overrides[key];
        if (o?.hidden == true) continue;
        seen.add(key);
        out.add(AvaBookContact(
          name: o?.displayName ?? c.name ?? c.number,
          number: c.number,
          avatokNumber: o?.avatokNumber,
          personalEmail: o?.personalEmail,
          businessEmail: o?.businessEmail,
          linkedin: o?.linkedin,
          customFields: o?.customFields ?? const [],
          source: (o?.local ?? false) ? 'avatok' : 'device',
        ));
      }
      // Any AvaTOK-only overrides not represented by a device row.
      for (final o in overrides.values) {
        final key = DeviceContacts.normKey(o.number);
        if (o.hidden || seen.contains(key)) continue;
        out.add(AvaBookContact(
          name: o.displayName ?? o.number,
          number: o.number,
          avatokNumber: o.avatokNumber,
          personalEmail: o.personalEmail,
          businessEmail: o.businessEmail,
          linkedin: o.linkedin,
          customFields: o.customFields,
          source: 'avatok',
        ));
      }
      await DiskCache.write(_kCache, jsonEncode(out.map((e) => e.toJson()).toList()));
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book capture failed: $e');
    }
  }

  Future<List<AvaBookContact>> load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return [];
      return (jsonDecode(raw) as List<dynamic>)
          .whereType<Map>()
          .map((m) => AvaBookContact.fromJson(m.map((k, v) => MapEntry('$k', v))))
          .toList();
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book load failed: $e');
      return [];
    }
  }

  Future<int> count() async => (await load()).length;

  /// Serialized book (what Phase 2 will upload to AvaTOK's backup endpoint).
  Future<String> exportJson() async =>
      jsonEncode((await load()).map((e) => e.toJson()).toList());
}

/// User consent + status for backing the contact book up to AvaTOK's servers
/// (owner request 2026-07-13 — opt-in, "take permission to back up"). The actual
/// server sync lands in Phase 2; Phase 1 records consent and the local snapshot so
/// the switch is honest and the data is ready to upload.
class ContactBackupPrefs {
  ContactBackupPrefs._();
  static final ContactBackupPrefs I = ContactBackupPrefs._();

  static const _kEnabled = 'ava_contact_backup_enabled';
  static const _kLastTs = 'ava_contact_backup_last_ts';

  Future<bool> enabled() async => (await DiskCache.read(_kEnabled)) == 'true';

  Future<void> setEnabled(bool on) async {
    await DiskCache.write(_kEnabled, on ? 'true' : 'false');
  }

  Future<DateTime?> lastSnapshot() async {
    final raw = await DiskCache.read(_kLastTs);
    final ms = int.tryParse(raw ?? '');
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  Future<void> markSnapshot() async {
    await DiskCache.write(_kLastTs, '${DateTime.now().millisecondsSinceEpoch}');
  }
}
