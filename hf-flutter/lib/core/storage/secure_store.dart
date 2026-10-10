import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The small key/value surface the app needs from secure storage. A seam so tests use
/// [MemoryKeyValueStore] and never touch platform channels.
abstract interface class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
  Future<void> deleteAll();
}

/// In-memory store for tests and previews.
class MemoryKeyValueStore implements KeyValueStore {
  MemoryKeyValueStore([Map<String, String>? initial]) : _data = {...?initial};

  final Map<String, String> _data;

  Map<String, String> get snapshot => Map<String, String>.unmodifiable(_data);

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async => _data[key] = value;

  @override
  Future<void> delete(String key) async => _data.remove(key);

  @override
  Future<void> deleteAll() async => _data.clear();
}

/// flutter_secure_storage with encrypted shared preferences.
///
/// Self-heal: a corrupted store (Android Keystore key rotated, an OS backup restored onto a
/// different keystore) throws BadPaddingException / BAD_DECRYPT on read. A read that fails this way
/// deletes just that key and answers null, so the person signs in again instead of a button
/// that freezes forever. Other keys (other accounts on a shared phone) are kept.
class SecureKeyValueStore implements KeyValueStore {
  SecureKeyValueStore([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final FlutterSecureStorage _storage;

  /// Called when a read had to be healed (key name only, never the value). Wired to telemetry in main.dart.
  static void Function(String key)? onHealed;

  @override
  Future<String?> read(String key) async {
    try {
      return await _storage.read(key: key);
    } on PlatformException catch (e) {
      final text = '${e.code} ${e.message}';
      if (text.contains('BadPadding') || text.contains('BAD_DECRYPT') || text.contains('Bad') || text.contains('decrypt')) {
        onHealed?.call(key);
        try {
          await _storage.delete(key: key);
        } catch (_) {
          // best effort: the next write replaces it anyway
        }
        return null;
      }
      rethrow;
    }
  }

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);

  @override
  Future<void> deleteAll() => _storage.deleteAll();
}
