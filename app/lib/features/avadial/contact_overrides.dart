import 'dart:convert';

import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import 'avadial_refresh.dart';
import 'device_contacts.dart';

/// One user-defined extra field on a contact ("field name + value", owner spec
/// pic 2 — the "+" that adds LinkedIn / job title / anything).
class ContactField {
  final String label;
  final String value;
  const ContactField({required this.label, required this.value});

  Map<String, dynamic> toJson() => {'label': label, 'value': value};
  factory ContactField.fromJson(Map<String, dynamic> j) =>
      ContactField(label: '${j['label'] ?? ''}', value: '${j['value'] ?? ''}');
}

/// AVA-side metadata layered on top of the READ-ONLY device phone book (plan §4.7
/// device-data boundary — [DeviceContacts] never writes to the OS contacts
/// provider). Backs the Calls app's "Add contact" / "Edit contact" / "Remove
/// contact" / "Delete contact" screens.
///
///  - [displayName] override (used instead of the device's cached name).
///  - Rich fields (owner spec pic 2): [avatokNumber], [personalEmail],
///    [businessEmail], [linkedin] and arbitrary [customFields].
///  - [local] — an AvaTOK-only contact the user CREATED here (there is no native
///    "write to the OS phone book" channel yet, owner decision 2026-07-13: new
///    contacts are saved inside AvaTOK). Local contacts are injected into the
///    Contacts tab alongside the device phone book.
///  - [hidden] — "removed"/"deleted" numbers stop showing in the Contacts tab.
///    Best-effort delete until a native write path exists; never touches the OS
///    phone book, so unhiding always restores it.
///
/// Account-scoped via [DiskCache] (same pattern as [BlockList]), keyed by the
/// normalized suffix [DeviceContacts.normKey] uses for lookups.
class ContactOverride {
  final String number;
  final String? displayName;
  final bool hidden;
  final bool local;
  final String? avatokNumber;
  final String? personalEmail;
  final String? businessEmail;
  final String? linkedin;
  final List<ContactField> customFields;

  const ContactOverride({
    required this.number,
    this.displayName,
    this.hidden = false,
    this.local = false,
    this.avatokNumber,
    this.personalEmail,
    this.businessEmail,
    this.linkedin,
    this.customFields = const [],
  });

  /// True when this override carries anything worth showing on the detail screen
  /// beyond the raw number.
  bool get hasDetails =>
      (avatokNumber?.isNotEmpty ?? false) ||
      (personalEmail?.isNotEmpty ?? false) ||
      (businessEmail?.isNotEmpty ?? false) ||
      (linkedin?.isNotEmpty ?? false) ||
      customFields.isNotEmpty;

  ContactOverride copyWith({
    String? number,
    String? displayName,
    bool? hidden,
    bool? local,
    String? avatokNumber,
    String? personalEmail,
    String? businessEmail,
    String? linkedin,
    List<ContactField>? customFields,
  }) =>
      ContactOverride(
        number: number ?? this.number,
        displayName: displayName ?? this.displayName,
        hidden: hidden ?? this.hidden,
        local: local ?? this.local,
        avatokNumber: avatokNumber ?? this.avatokNumber,
        personalEmail: personalEmail ?? this.personalEmail,
        businessEmail: businessEmail ?? this.businessEmail,
        linkedin: linkedin ?? this.linkedin,
        customFields: customFields ?? this.customFields,
      );

  Map<String, dynamic> toJson() => {
        'number': number,
        if (displayName != null) 'displayName': displayName,
        'hidden': hidden,
        if (local) 'local': true,
        if (avatokNumber != null) 'avatokNumber': avatokNumber,
        if (personalEmail != null) 'personalEmail': personalEmail,
        if (businessEmail != null) 'businessEmail': businessEmail,
        if (linkedin != null) 'linkedin': linkedin,
        if (customFields.isNotEmpty)
          'customFields': customFields.map((f) => f.toJson()).toList(),
      };

  factory ContactOverride.fromJson(Map<String, dynamic> j) => ContactOverride(
        number: '${j['number']}',
        displayName: j['displayName'] as String?,
        hidden: j['hidden'] == true,
        local: j['local'] == true,
        avatokNumber: j['avatokNumber'] as String?,
        personalEmail: j['personalEmail'] as String?,
        businessEmail: j['businessEmail'] as String?,
        linkedin: j['linkedin'] as String?,
        customFields: (j['customFields'] as List<dynamic>? ?? const [])
            .whereType<Map>()
            .map((m) => ContactField.fromJson(m.map((k, v) => MapEntry('$k', v))))
            .toList(),
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
      bumpAvaDial();
    } catch (e) {
      AvaLog.I.log('avadial', 'contact overrides save failed: $e');
    }
  }

  Future<List<ContactOverride>> load() async => (await _loadMap()).values.toList();

  Future<ContactOverride?> forNumber(String number) async =>
      (await _loadMap())[DeviceContacts.normKey(number)];

  /// AVA-only contacts the user created here (no matching device contact). Injected
  /// into the Contacts tab so a brand-new contact shows up immediately.
  Future<List<ContactOverride>> localContacts() async =>
      (await _loadMap()).values.where((o) => o.local && !o.hidden).toList();

  /// Set (or clear, when [displayName] is null) just the display-name override —
  /// used by the lightweight rename path. Preserves every other field.
  Future<void> setName(String number, String? displayName) async {
    final m = await _loadMap();
    final key = DeviceContacts.normKey(number);
    final existing = m[key] ?? ContactOverride(number: number);
    m[key] = existing.copyWith(displayName: displayName);
    await _saveMap(m);
  }

  /// Upsert the FULL record for a number — used by the Add/Edit contact screen.
  /// Preserves the [hidden] flag unless the caller overrides it.
  Future<void> save(ContactOverride o) async {
    final m = await _loadMap();
    final key = DeviceContacts.normKey(o.number);
    final existing = m[key];
    m[key] = o.copyWith(hidden: o.hidden || (existing?.hidden ?? false));
    await _saveMap(m);
  }

  /// Bulk upsert — used by contact-book RESTORE, which applies thousands of
  /// overrides at once. Calling [save] per contact re-reads + rewrites the WHOLE
  /// overrides file every time (O(n²) — a primary cause of the restore hang on
  /// large books). This loads the map ONCE, merges every record, and writes ONCE.
  /// Preserves any existing [hidden] flag per number, same as [save].
  Future<int> saveMany(Iterable<ContactOverride> items) async {
    final list = items.toList();
    if (list.isEmpty) return 0;
    final m = await _loadMap();
    for (final o in list) {
      final key = DeviceContacts.normKey(o.number);
      final existing = m[key];
      m[key] = o.copyWith(hidden: o.hidden || (existing?.hidden ?? false));
    }
    await _saveMap(m);
    return list.length;
  }

  /// Hide a number from the Contacts tab ("Remove contact" / "Delete contact").
  /// Never deletes the underlying device contact — just Ava's own view of it.
  Future<void> hide(String number) async {
    final m = await _loadMap();
    final key = DeviceContacts.normKey(number);
    final existing = m[key] ?? ContactOverride(number: number);
    m[key] = existing.copyWith(hidden: true);
    await _saveMap(m);
  }

  Future<void> unhide(String number) async {
    final m = await _loadMap();
    final key = DeviceContacts.normKey(number);
    final existing = m[key];
    if (existing == null) return;
    m[key] = existing.copyWith(hidden: false);
    await _saveMap(m);
  }
}

/// AVA-side "deleted from view" markers for individual device call-log rows. The
/// OS call log can only be WRITTEN by the default dialer (WRITE_CALL_LOG), so
/// "delete history" hides rows in AvaTOK's view without touching the device log —
/// same best-effort boundary as [ContactOverride.hidden]. Keyed by number + the
/// call timestamp so re-reading the live log won't resurrect a hidden row.
class HiddenCallLog {
  HiddenCallLog._();
  static final HiddenCallLog I = HiddenCallLog._();

  static const _kCache = 'avadial_hidden_calls';

  static String keyFor(String number, DateTime date) =>
      '${DeviceContacts.normKey(number)}@${date.millisecondsSinceEpoch}';

  Future<Set<String>> load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return {};
      return (jsonDecode(raw) as List<dynamic>).map((e) => '$e').toSet();
    } catch (e) {
      AvaLog.I.log('avadial', 'hidden calls load failed: $e');
      return {};
    }
  }

  Future<void> _save(Set<String> keys) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(keys.toList()));
      bumpAvaDial();
    } catch (e) {
      AvaLog.I.log('avadial', 'hidden calls save failed: $e');
    }
  }

  /// Hide one call row from AvaTOK's Logs view.
  Future<void> hide(String number, DateTime date) async {
    final keys = await load();
    keys.add(keyFor(number, date));
    await _save(keys);
  }

  /// Hide EVERY call currently visible for a number, or clear the whole log when
  /// [allKeys] is supplied by the caller (the Logs "Clear history" action).
  Future<void> hideAll(Iterable<String> keys) async {
    final set = await load();
    set.addAll(keys);
    await _save(set);
  }
}
