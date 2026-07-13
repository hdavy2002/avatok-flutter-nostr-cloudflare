import 'dart:async';
import 'dart:convert';

import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
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

  /// Serialized book (uploaded to AvaTOK's backup endpoint).
  Future<String> exportJson() async =>
      jsonEncode((await load()).map((e) => e.toJson()).toList());

  /// Upload the local book to AvaTOK's servers (server-side encrypted). Returns
  /// the count on success, or null on failure. Callers gate on user consent.
  Future<int?> uploadBackup() async {
    try {
      final contacts = await load();
      final payload = contacts.map((e) => e.toJson()).toList();
      final body = jsonEncode(payload);
      final resp = await ApiAuth.postJson(kContactBookUrl, {'contacts': payload});
      if (resp.statusCode == 200) {
        await ContactBackupPrefs.I.markServerSync();
        // Remember what we uploaded so auto-sync won't re-send identical data.
        await ContactBackupPrefs.I.setSyncedSig(_sig(body));
        return contacts.length;
      }
      AvaLog.I.log('avadial', 'contact book upload http ${resp.statusCode}');
      return null;
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book upload failed: $e');
      return null;
    }
  }

  Timer? _debounce;

  /// Auto-backup hook — called after the contact book is (re)captured. When the
  /// user has backup ON and the book has actually CHANGED since the last upload,
  /// it uploads in the background, debounced so a burst of edits sends once.
  Future<void> autoSyncIfNeeded() async {
    if (!await ContactBackupPrefs.I.enabled()) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(seconds: 4), _runAutoSync);
  }

  Future<void> _runAutoSync() async {
    try {
      if (!await ContactBackupPrefs.I.enabled()) return;
      final body = await exportJson();
      if (_sig(body) == await ContactBackupPrefs.I.syncedSig()) return; // no change
      await uploadBackup();
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book auto-sync failed: $e');
    }
  }

  /// Cheap, stable content signature (FNV-1a) — persisted to detect real changes
  /// without re-uploading identical data. (String.hashCode isn't stable across
  /// runs, so we can't use it here.)
  static String _sig(String s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.codeUnitAt(i);
      h = (h * 0x01000193) & 0xFFFFFFFF;
    }
    return h.toRadixString(16);
  }

  /// Restore the book from AvaTOK's servers onto THIS device: rebuilds any missing
  /// device contacts (new phone / lost SIM) and re-applies the AvaTOK extras.
  /// Returns the number of contacts restored, or null on failure. Existing device
  /// contacts (matched by number) are left untouched — no duplicates.
  Future<int?> restoreBackup() async {
    try {
      final resp = await ApiAuth.getSigned(kContactBookUrl);
      if (resp.statusCode != 200) {
        AvaLog.I.log('avadial', 'contact book restore http ${resp.statusCode}');
        return null;
      }
      final body = jsonDecode(resp.body) as Map<String, dynamic>;
      if (body['found'] != true) return 0;
      final list = (body['contacts'] as List<dynamic>? ?? const [])
          .whereType<Map>()
          .map((m) => AvaBookContact.fromJson(m.map((k, v) => MapEntry('$k', v))))
          .toList();
      await DeviceContacts.I.load(); // warm the dedupe index
      var restored = 0;
      for (final c in list) {
        if (c.number.isEmpty) continue;
        final onDevice = DeviceContacts.I.lookup(c.number) != null;
        String? id;
        if (!onDevice) {
          id = await DeviceContacts.I.write(
            name: c.name.isEmpty ? c.number : c.name,
            number: c.number,
            personalEmail: c.personalEmail,
            businessEmail: c.businessEmail,
            linkedin: c.linkedin,
            note: _noteFor(c),
          );
        }
        await ContactOverrides.I.save(ContactOverride(
          number: c.number,
          displayName: c.name.isEmpty ? null : c.name,
          local: !onDevice && id == null,
          avatokNumber: c.avatokNumber,
          personalEmail: c.personalEmail,
          businessEmail: c.businessEmail,
          linkedin: c.linkedin,
          customFields: c.customFields,
        ));
        restored++;
      }
      return restored;
    } catch (e) {
      AvaLog.I.log('avadial', 'contact book restore failed: $e');
      return null;
    }
  }

  String? _noteFor(AvaBookContact c) {
    final lines = <String>[
      if (c.avatokNumber != null && c.avatokNumber!.isNotEmpty) 'AvaTOK: ${c.avatokNumber}',
      for (final f in c.customFields)
        if (f.value.isNotEmpty) '${f.label.isEmpty ? 'Note' : f.label}: ${f.value}',
    ];
    return lines.isEmpty ? null : lines.join('\n');
  }

  /// Server-side backup metadata (count + last-updated ms), or null when there is
  /// no backup / the call failed.
  Future<({int count, int updatedAt})?> serverStatus() async {
    try {
      final resp = await ApiAuth.getSigned(kContactBookStatusUrl);
      if (resp.statusCode != 200) return null;
      final b = jsonDecode(resp.body) as Map<String, dynamic>;
      if (b['found'] != true) return null;
      return (
        count: (b['count'] as num?)?.toInt() ?? 0,
        updatedAt: (b['updatedAt'] as num?)?.toInt() ?? 0,
      );
    } catch (e) {
      return null;
    }
  }
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
  static const _kServerTs = 'ava_contact_backup_server_ts';
  static const _kSyncedSig = 'ava_contact_backup_sig';

  Future<bool> enabled() async => (await DiskCache.read(_kEnabled)) == 'true';

  /// Content signature of the last successfully-uploaded book (change detection).
  Future<String> syncedSig() async => (await DiskCache.read(_kSyncedSig)) ?? '';
  Future<void> setSyncedSig(String sig) async => DiskCache.write(_kSyncedSig, sig);

  Future<void> setEnabled(bool on) async {
    await DiskCache.write(_kEnabled, on ? 'true' : 'false');
  }

  Future<DateTime?> lastSnapshot() async => _readTs(_kLastTs);
  Future<void> markSnapshot() async => _writeNow(_kLastTs);

  /// Last successful upload to AvaTOK's servers.
  Future<DateTime?> lastServerSync() async => _readTs(_kServerTs);
  Future<void> markServerSync() async => _writeNow(_kServerTs);

  Future<DateTime?> _readTs(String key) async {
    final ms = int.tryParse(await DiskCache.read(key) ?? '');
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  Future<void> _writeNow(String key) async =>
      DiskCache.write(key, '${DateTime.now().millisecondsSinceEpoch}');
}
