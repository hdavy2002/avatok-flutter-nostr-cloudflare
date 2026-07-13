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
