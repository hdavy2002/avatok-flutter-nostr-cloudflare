import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../config.dart';
import 'ui_messages.dart';

class UiCatalog {
  final String release, locale, layer;
  final Map<String, String> messages;
  const UiCatalog(this.release, this.locale, this.messages, this.layer);
}

/// Public authored UI copy only. Never sends cookies, tokens, user content or
/// requests to the paid chat/voice translation APIs.
class UiCatalogRepository {
  static const maxBytes = 2 * 1024 * 1024;
  static final _safe = RegExp(r'^[a-f0-9]{64}$');
  Map<String, dynamic>? manifest;
  int _generation = 0;
  final Map<String, UiCatalog> _memory = {};
  String _digest(String value) => sha256.convert(utf8.encode(value)).toString();

  Future<Directory> _dir(String scope) async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/ui_catalogs/v1/${_digest(kSignalingHost)}/${_digest(scope)}');
    await d.create(recursive: true);
    return d;
  }

  Future<void> _atomic(File f, String contents) async {
    final temporary = File('${f.path}.${DateTime.now().microsecondsSinceEpoch}.tmp');
    await temporary.writeAsString(contents, flush: true);
    await temporary.rename(f.path);
  }

  Future<String> _read(File file) async {
    if (await file.length() > maxBytes) throw const FormatException('Catalog too large');
    return file.readAsString();
  }

  Future<Map<String, dynamic>> _fetch(String path) async {
    final response = await http.get(Uri.https(kSignalingHost, path),
        headers: {'Accept': 'application/json'}).timeout(const Duration(seconds: 12));
    if (response.statusCode != 200 || response.bodyBytes.length > maxBytes ||
        response.headers.containsKey('set-cookie')) {
      throw const FormatException('Unpublished or invalid UI catalog');
    }
    return Map<String, dynamic>.from(jsonDecode(utf8.decode(response.bodyBytes)) as Map);
  }

  bool _validManifest(Map<String, dynamic> value) {
    if (value['schemaVersion'] != 1 || value['release'] is! String ||
        value['sourceHashes'] is! Map || (value['sourceHashes'] as Map)['app'] != uiSourceHash ||
        !_safe.hasMatch(value['release'] as String) ||
        value['locales'] is! Map || value['namespaces'] is! List) return false;
    final namespaces = value['namespaces'] as List;
    if (!namespaces.every((n) => n is String && RegExp(r'^[a-z0-9_-]{1,80}$').hasMatch(n))) return false;
    for (final entry in (value['locales'] as Map).entries) {
      if (entry.key is! String || !RegExp(r'^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$').hasMatch(entry.key as String)) return false;
      final v = entry.value;
      if (v is! Map || !const ['source', 'reviewed', 'machine'].contains(v['status']) ||
          v['namespaces'] is! List ||
          !(v['namespaces'] as List).every(namespaces.contains)) return false;
    }
    return true;
  }

  Future<void> restoreManifest(String scope) async {
    final generation = _generation;
    try {
      final dir = await _dir(scope);
      final value = Map<String, dynamic>.from(jsonDecode(
          await _read(File('${dir.path}/manifest.json'))) as Map);
      if (generation == _generation && _validManifest(value)) manifest = value;
    } catch (_) {}
  }

  Future<void> refreshManifest(String scope) async {
    final generation = _generation;
    try {
      Map<String, dynamic> next;
      try {
        next = await _fetch('/i18n/v1/sources/$uiSourceHash/manifest.json');
      } catch (_) {
        next = await _fetch('/i18n/v1/manifest.json');
      }
      if ((next['sourceHashes'] as Map?)?['app'] != uiSourceHash) {
        throw const FormatException('No compatible app catalog release');
      }
      if (!_validManifest(next)) throw const FormatException('Invalid manifest');
      if (generation != _generation) return;
      manifest = next;
      try {
        final dir = await _dir(scope);
        await _atomic(File('${dir.path}/manifest.json'), jsonEncode(next));
      } catch (_) {}
    } catch (_) {
      try {
        final dir = await _dir(scope);
        final cached = Map<String, dynamic>.from(jsonDecode(await _read(File('${dir.path}/manifest.json'))) as Map);
        if (generation == _generation && _validManifest(cached)) manifest = cached;
      } catch (_) {}
    }
  }

  bool published(String locale) {
    if (locale == 'en') return true;
    final entry = (manifest?['locales'] as Map?)?[locale];
    return entry is Map && entry['namespaces'] is List &&
        (entry['namespaces'] as List).contains('app');
  }

  UiCatalog _parse(Map<String, dynamic> value, String release, String locale, String layer) {
    if (value['schemaVersion'] != 1 || value['release'] != release ||
        value['locale'] != locale || value['namespace'] != 'app' ||
        value['sourceHash'] != uiSourceHash || value['messages'] is! Map) {
      throw const FormatException('Catalog does not match this app source');
    }
    final messages = Map<String, String>.from(value['messages'] as Map);
    if (messages.length != uiSourceMessages.length ||
        !uiSourceMessages.keys.every((key) => messages.containsKey(key))) {
      throw const FormatException('Incomplete app translation');
    }
    return UiCatalog(release, locale, Map.unmodifiable(messages), layer);
  }

  Future<UiCatalog?> load(String scope, String locale, {bool allowNetwork = true}) async {
    if (locale == 'en') return const UiCatalog('bundled', 'en', uiSourceMessages, 'bundled');
    Directory? dir;
    try { dir = await _dir(scope); } catch (_) {}
    final release = manifest?['release'] as String?;
    if (release != null && published(locale)) {
      final key = '$scope/$release/$locale';
      if (_memory.containsKey(key)) return _memory[key];
      final file = dir == null ? null : File('${dir.path}/${_digest('$release/$locale')}.json');
      try {
        if (file == null) throw const FileSystemException('Cache unavailable');
        final v = Map<String, dynamic>.from(jsonDecode(await _read(file)) as Map);
        return _memory[key] = _parse(v, release, locale, 'disk');
      } catch (_) {}
      if (allowNetwork) {
      try {
        final value = await _fetch('/i18n/v1/$release/$locale/app.json');
        final result = _parse(value, release, locale, 'network');
        try {
          if (file == null || dir == null) throw const FileSystemException('Cache unavailable');
          await _atomic(file, jsonEncode(value));
          await _atomic(File('${dir.path}/last-$locale.json'), jsonEncode(value));
          // Bound immutable release history; keep per-language last-good files.
          final files = await dir.list().where((f) => f is File &&
              RegExp(r'/[a-f0-9]{64}\.json$').hasMatch(f.path)).cast<File>().toList();
          files.sort((a, b) => a.lastModifiedSync().compareTo(b.lastModifiedSync()));
          for (final stale in files.take((files.length - 12).clamp(0, files.length).toInt())) {
            await stale.delete();
          }
        } catch (_) {}
        _memory[key] = result;
        while (_memory.length > 6) { _memory.remove(_memory.keys.first); }
        return result;
      } catch (_) {}
      }
    }
    try {
      if (dir == null) return null;
      final value = Map<String, dynamic>.from(jsonDecode(
          await _read(File('${dir.path}/last-$locale.json'))) as Map);
      final oldRelease = value['release'] as String;
      if (!_safe.hasMatch(oldRelease)) return null;
      return _parse(value, oldRelease, locale, 'last-good');
    } catch (_) { return null; }
  }

  void reset() { ++_generation; manifest = null; _memory.clear(); }
}
