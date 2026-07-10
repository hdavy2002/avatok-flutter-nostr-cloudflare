import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../identity/identity.dart';

/// Master kill-switch for the AvaApps device-side cache (Phase 2). Checked at
/// EVERY read and write so the whole feature can be disabled in one line if a
/// snapshot ever misbehaves — with it off, AvaApps reverts to network-only.
const bool kAvaAppsDeviceCache = true;

/// A snapshot is considered stale after this long; the UI still renders it
/// instantly ("as of <time>") but kicks a background refresh (stale-while-
/// revalidate). Named + documented per the phase spec.
const Duration kAvaAppsSnapshotTtl = Duration(minutes: 10);

/// Max run-result snapshots kept per account (LRU by fetched_at). Keeps the
/// per-account cache dir bounded; status is a single file and not counted.
const int kAvaAppsMaxRunSnapshots = 50;

/// A cached AvaApps result read back from disk.
class AvaAppsSnapshot {
  final Object? json; // decoded payload (String answer, or List for status)
  final DateTime fetchedAt;
  const AvaAppsSnapshot(this.json, this.fetchedAt);

  bool get isStale => DateTime.now().difference(fetchedAt) > kAvaAppsSnapshotTtl;
  int get ageSeconds => DateTime.now().difference(fetchedAt).inSeconds;

  /// Human "as of" label for the SWR banner.
  String get ageLabel {
    final s = ageSeconds;
    if (s < 60) return 'just now';
    final m = s ~/ 60;
    if (m < 60) return '$m min ago';
    final h = m ~/ 60;
    if (h < 24) return '$h h ago';
    return '${h ~/ 24} d ago';
  }
}

/// Per-account, on-device cache for AvaApps snapshots (connection status +
/// read-only run results).
///
/// SCOPING (mandatory, AvaVerse rulebook): all data lives under a per-account
/// subdirectory keyed by [AccountScope.id] — `…/avaapps/<accountId>/…`. A parent
/// and a child sharing one phone therefore never see each other's cached email/
/// calendar snapshots. When no account is active the id falls back to `_device`
/// (guest, pre-login) which holds nothing sensitive.
class AvaAppsCache {
  static String get _accountId {
    final id = AccountScope.id;
    return (id == null || id.isEmpty) ? '_device' : id;
  }

  static Future<Directory> _dir({String? account}) async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/avaapps/${account ?? _accountId}');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  /// Stable, filesystem-safe key for a query. Not cryptographic — just a
  /// collision-resistant-enough FNV-1a digest for a cache filename (mixed with
  /// the length to further reduce collisions).
  static String _hash(String s) {
    final norm = s.trim().toLowerCase();
    var h = 0x811c9dc5;
    for (final c in norm.codeUnits) {
      h ^= c;
      h = (h * 0x01000193) & 0xFFFFFFFF;
    }
    return '${h.toRadixString(16)}_${norm.length}';
  }

  static File _statusFile(Directory d) => File('${d.path}/status.json');
  static File _runFile(Directory d, String query) => File('${d.path}/run_${_hash(query)}.json');

  // ---- app catalog (DEVICE-level, not per-account) -------------------------
  //
  // The Composio catalog (slug/name/logo) is PUBLIC and identical for every
  // account, so — like AppIconCache — it lives outside the per-account dir and
  // is intentionally NOT scoped. It is not user data.
  //
  // Why this exists: connection *status* was cached for instant screen open but
  // the catalog itself was fetched from the network on EVERY open. `_all` stayed
  // empty until that request landed, so the whole icon grid re-rendered from
  // nothing each visit — on a slow connection, a visibly empty screen. The icon
  // BYTES were cached on disk all along; the list they hang off wasn't.

  /// In-process copy so a second open in the same session doesn't touch disk.
  static List<Map<String, String>>? _catalogMem;

  static Future<File> _catalogFile() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/avaapps');
    if (!await d.exists()) await d.create(recursive: true);
    return File('${d.path}/catalog.json');
  }

  /// Persist the catalog (list of {slug,name,logo}).
  static Future<void> writeCatalog(List<Map<String, String>> apps) async {
    if (!kAvaAppsDeviceCache || apps.isEmpty) return;
    _catalogMem = apps;
    try {
      await (await _catalogFile()).writeAsString(jsonEncode({
        'json': apps,
        'fetched_at': DateTime.now().millisecondsSinceEpoch,
      }), flush: true);
    } catch (_) {/* best-effort */}
  }

  /// Last-known catalog, or null. Served local-first; the caller still
  /// revalidates in the background (stale-while-revalidate).
  static Future<AvaAppsSnapshot?> readCatalog() async {
    if (!kAvaAppsDeviceCache) return null;
    try {
      final f = await _catalogFile();
      if (!await f.exists()) return null;
      final m = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      final list = (m['json'] as List?)
              ?.map((e) => (e as Map).map(
                  (k, v) => MapEntry(k.toString(), v?.toString() ?? '')))
              .toList() ??
          const <Map<String, String>>[];
      if (list.isEmpty) return null;
      _catalogMem = list;
      return AvaAppsSnapshot(list, _at(m));
    } catch (_) {
      return null;
    }
  }

  /// Synchronous peek for the hot path (same-session reopen → zero await).
  static List<Map<String, String>>? get catalogMem => _catalogMem;

  // ---- connection status --------------------------------------------------

  /// Persist the last-known connected toolkit slugs for instant screen open.
  static Future<void> writeStatus(Iterable<String> slugs) async {
    if (!kAvaAppsDeviceCache) return;
    try {
      final d = await _dir();
      await _statusFile(d).writeAsString(jsonEncode({
        'json': slugs.toList(),
        'fetched_at': DateTime.now().millisecondsSinceEpoch,
      }), flush: true);
    } catch (_) {/* best-effort */}
  }

  /// Read the last-known connected slugs (null if none / disabled).
  static Future<AvaAppsSnapshot?> readStatus() async {
    if (!kAvaAppsDeviceCache) return null;
    try {
      final f = _statusFile(await _dir());
      if (!await f.exists()) return null;
      final m = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      final list = (m['json'] as List?)?.map((e) => e.toString()).toList() ?? const <String>[];
      return AvaAppsSnapshot(list, _at(m));
    } catch (_) {
      return null;
    }
  }

  // ---- read-only run results ---------------------------------------------

  /// Persist a read-only run answer keyed by the normalized query hash, then
  /// enforce the LRU cap.
  static Future<void> writeRun(String query, String answer) async {
    if (!kAvaAppsDeviceCache) return;
    try {
      final d = await _dir();
      await _runFile(d, query).writeAsString(jsonEncode({
        'json': answer,
        'fetched_at': DateTime.now().millisecondsSinceEpoch,
      }), flush: true);
      await _evict(d);
    } catch (_) {/* best-effort */}
  }

  /// Read a cached run answer for [query] (null if none / disabled).
  static Future<AvaAppsSnapshot?> readRun(String query) async {
    if (!kAvaAppsDeviceCache) return null;
    try {
      final f = _runFile(await _dir(), query);
      if (!await f.exists()) return null;
      final m = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      return AvaAppsSnapshot(m['json']?.toString() ?? '', _at(m));
    } catch (_) {
      return null;
    }
  }

  // ---- eviction / cleanup -------------------------------------------------

  /// Keep only the newest [kAvaAppsMaxRunSnapshots] run_* files (LRU by
  /// fetched_at, falling back to file mtime).
  static Future<void> _evict(Directory d) async {
    try {
      final runs = (await d.list().toList())
          .whereType<File>()
          .where((f) => f.uri.pathSegments.last.startsWith('run_'))
          .toList();
      if (runs.length <= kAvaAppsMaxRunSnapshots) return;
      final stamped = <MapEntry<File, int>>[];
      for (final f in runs) {
        stamped.add(MapEntry(f, await _fetchedAtOf(f)));
      }
      stamped.sort((a, b) => b.value.compareTo(a.value)); // newest first
      for (final e in stamped.skip(kAvaAppsMaxRunSnapshots)) {
        try { await e.key.delete(); } catch (_) {/* best-effort */}
      }
    } catch (_) {/* best-effort */}
  }

  static Future<int> _fetchedAtOf(File f) async {
    try {
      final m = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      final v = m['fetched_at'];
      if (v is int) return v;
    } catch (_) {/* fall through to mtime */}
    try { return (await f.lastModified()).millisecondsSinceEpoch; } catch (_) { return 0; }
  }

  static DateTime _at(Map<String, dynamic> m) {
    final v = m['fetched_at'];
    return DateTime.fromMillisecondsSinceEpoch(v is int ? v : 0);
  }

  /// Wipe the cache for the CURRENT account — call on sign-out so a signed-out
  /// user's cached email/calendar snapshots don't linger on the device.
  static Future<void> clearCurrentAccount() => clearForAccount(_accountId);

  /// Wipe the cache directory for a specific account id.
  static Future<void> clearForAccount(String accountId) async {
    try {
      final base = await getApplicationSupportDirectory();
      final d = Directory('${base.path}/avaapps/$accountId');
      if (await d.exists()) await d.delete(recursive: true);
    } catch (_) {/* best-effort */}
  }
}
