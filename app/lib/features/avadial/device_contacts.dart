import 'dart:async';

import 'package:permission_handler/permission_handler.dart';

import '../../core/ava_log.dart';
import '../../identity/identity.dart';
import 'avadial_channel.dart';

/// One entry from the DEVICE phone book (Truecaller-style). This is OS-owned,
/// device-global data — never persisted into an account backup (plan §4.7 device-
/// data boundary).
class DeviceContact {
  final String? name;
  final String number;
  final String? photo;
  final String? id;
  const DeviceContact({this.name, required this.number, this.photo, this.id});
}

/// LIVE device-contacts reader (plan §4.1 Contacts tab + §4.3 GREEN screen).
///
/// Device-data boundary (plan §4.7): contacts are read LIVE over the platform
/// channel and cached ONLY in memory, keyed by [AccountScope.id]. The moment the
/// active account changes, the cache for the previous account is dropped before any
/// data is returned — so a parent's phone book never surfaces under a child account
/// on a shared phone. Nothing here writes contacts to disk.
class DeviceContacts {
  DeviceContacts._();
  static final DeviceContacts I = DeviceContacts._();

  List<DeviceContact>? _cache;
  String? _cacheScope;
  // number-suffix → contact, for O(1) incoming-call GREEN lookup.
  Map<String, DeviceContact> _index = const {};

  /// Reduce any dialed/stored number to a comparable key: trailing digits only.
  /// (Full E.164 normalisation needs libphonenumber — [verify on device]; the
  /// suffix match is a pragmatic stand-in that tolerates +/spacing/country-code.)
  static String normKey(String raw) {
    final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
    return digits.length <= 9 ? digits : digits.substring(digits.length - 9);
  }

  /// Drop any cache belonging to a different account (called on every access and
  /// explicitly by the account-switch teardown).
  void _guardScope() {
    if (_cacheScope != AccountScope.id) {
      _cache = null;
      _index = const {};
      _cacheScope = AccountScope.id;
    }
  }

  /// Explicit clear — wire into the account-switch path so OS data never lingers.
  void clear() {
    _cache = null;
    _index = const {};
    _cacheScope = AccountScope.id;
  }

  Future<bool> ensurePermission() async {
    try {
      final status = await Permission.contacts.request();
      return status.isGranted;
    } catch (e) {
      AvaLog.I.log('avadial', 'contacts permission failed: $e');
      return false;
    }
  }

  /// WRITE_CONTACTS is bundled with READ under the same runtime group on Android,
  /// so requesting [Permission.contacts] covers writes too.
  Future<bool> ensureWritePermission() => ensurePermission();

  /// Create a real device contact. Returns the new contact id, or null on failure
  /// / permission-denied (the caller then keeps the AVA-side override as a
  /// fallback so the user never loses the edit).
  Future<String?> write({
    required String name,
    required String number,
    String? personalEmail,
    String? businessEmail,
    String? linkedin,
    String? note,
  }) async {
    if (!await ensureWritePermission()) return null;
    final id = await AvaDialChannel.I.writeContact(
      name: name,
      number: number,
      personalEmail: personalEmail,
      businessEmail: businessEmail,
      linkedin: linkedin,
      note: note,
    );
    if (id != null) clear(); // in-memory cache is stale after a write
    return id;
  }

  /// BULK-create device contacts (contact-book RESTORE fast path). Each entry is a
  /// map with keys name/number/personalEmail/businessEmail/linkedin/note. Uses the
  /// native multi-contact batch when available (one provider transaction per ~60),
  /// and falls back to per-contact [write] on older builds / iOS. Clears the
  /// in-memory cache ONCE at the end (not per contact — the per-write clear() is a
  /// correctness+perf trap during a large restore). Returns the number written.
  Future<int> writeBatch(List<Map<String, dynamic>> contacts) async {
    if (contacts.isEmpty) return 0;
    if (!await ensureWritePermission()) return 0;
    final n = await AvaDialChannel.I.writeContactsBatch(contacts);
    if (n >= 0) {
      clear(); // invalidate stale in-memory cache once
      return n;
    }
    // Native batch unavailable — write one at a time, but DON'T clear per write.
    var ok = 0;
    for (final c in contacts) {
      final id = await AvaDialChannel.I.writeContact(
        name: (c['name'] as String?) ?? (c['number'] as String? ?? ''),
        number: (c['number'] as String?) ?? '',
        personalEmail: c['personalEmail'] as String?,
        businessEmail: c['businessEmail'] as String?,
        linkedin: c['linkedin'] as String?,
        note: c['note'] as String?,
      );
      if (id != null) ok++;
    }
    clear();
    return ok;
  }

  /// Update an existing device contact by [id]. Returns true on success.
  Future<bool> update({
    required String id,
    required String name,
    required String number,
    String? personalEmail,
    String? businessEmail,
    String? linkedin,
    String? note,
  }) async {
    if (!await ensureWritePermission()) return false;
    final ok = await AvaDialChannel.I.updateContact(
      id: id,
      name: name,
      number: number,
      personalEmail: personalEmail,
      businessEmail: businessEmail,
      linkedin: linkedin,
      note: note,
    );
    if (ok) clear();
    return ok;
  }

  /// Delete a real device contact by [id]. Returns true on success.
  Future<bool> delete(String id) async {
    if (!await ensureWritePermission()) return false;
    final ok = await AvaDialChannel.I.deleteContact(id);
    if (ok) clear();
    return ok;
  }

  /// Load the device contacts (from the in-memory cache unless [force]). Returns an
  /// empty list when permission is denied or on an unsupported platform.
  Future<List<DeviceContact>> load({bool force = false}) async {
    _guardScope();
    if (!force && _cache != null) return _cache!;
    if (!await ensurePermission()) return const [];
    final rows = await AvaDialChannel.I.readContacts();
    final list = <DeviceContact>[];
    final index = <String, DeviceContact>{};
    for (final r in rows) {
      final number = (r['number'] as String?)?.trim();
      if (number == null || number.isEmpty) continue;
      final c = DeviceContact(
        name: r['name'] as String?,
        number: number,
        photo: r['photo'] as String?,
        id: r['id'] as String?,
      );
      list.add(c);
      index[normKey(number)] = c;
    }
    // Re-guard: an account switch may have raced the async read; only commit the
    // cache if we're still on the same account it was read for.
    if (_cacheScope == AccountScope.id) {
      _cache = list;
      _index = index;
    }
    return list;
  }

  /// Fast lookup for the GREEN incoming-call screen: is this number a known
  /// contact? Uses the in-memory index built by [load]; returns null if unknown or
  /// contacts haven't been loaded for this account yet.
  DeviceContact? lookup(String number) {
    _guardScope();
    return _index[normKey(number)];
  }
}
