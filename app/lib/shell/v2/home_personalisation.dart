import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/account_storage.dart';
import '../../core/ui/zine.dart';
import '../../identity/identity.dart';

/// Home personalisation (plan §3 / §D): font size, accent theme and wallpaper —
/// all PER-ACCOUNT scoped (rulebook rule 1) so a parent + child on one phone keep
/// independent looks. Prefs persist under a scopedKey; the wallpaper image lives in
/// a per-account subdir of the app support dir. Applies to the Home surface only.
class HomePersonalisation {
  HomePersonalisation._();

  static const _key = 'shellv2_home_look_v1';
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// Bumps whenever a value changes so an open Home repaints live.
  static final ValueNotifier<int> revision = ValueNotifier(0);

  // ── Font size ──────────────────────────────────────────────────────────────
  static const fontScales = <String, double>{'small': 0.9, 'default': 1.0, 'large': 1.18};

  // ── Accent presets (chrome only) ─────────────────────────────────────────────
  static const accents = <String, Color>{
    'lime': Zine.lime,
    'blue': Zine.blue,
    'coral': Zine.coral,
  };

  static String _fontKey = 'default';
  static String _accentKey = 'lime';
  static String? _wallpaperPath;
  static bool _loaded = false;

  static double get fontScale => fontScales[_fontKey] ?? 1.0;
  static String get fontKey => _fontKey;
  static String get accentKey => _accentKey;
  static Color get accentColor => accents[_accentKey] ?? Zine.lime;
  static String? get wallpaperPath => _wallpaperPath;

  /// Load the per-account look. Idempotent; call from HomeRoot's initState.
  static Future<void> load() async {
    try {
      final raw = await readScoped(_ss, _key);
      _fontKey = 'default';
      _accentKey = 'lime';
      _wallpaperPath = null;
      if (raw != null && raw.isNotEmpty) {
        final m = jsonDecode(raw);
        if (m is Map) {
          if (fontScales.containsKey(m['font'])) _fontKey = m['font'] as String;
          if (accents.containsKey(m['accent'])) _accentKey = m['accent'] as String;
          final wp = m['wallpaper'];
          if (wp is String && wp.isNotEmpty && await File(wp).exists()) _wallpaperPath = wp;
        }
      }
    } catch (_) {/* first run / corrupt → defaults */}
    _loaded = true;
    revision.value++;
  }

  static bool get isLoaded => _loaded;

  static Future<void> _persist() async {
    try {
      await _ss.write(
        key: scopedKey(_key),
        value: jsonEncode({'font': _fontKey, 'accent': _accentKey, 'wallpaper': _wallpaperPath}),
      );
    } catch (_) {/* best-effort */}
    revision.value++;
  }

  static Future<void> setFont(String key) async {
    if (!fontScales.containsKey(key)) return;
    _fontKey = key;
    await _persist();
  }

  static Future<void> setAccent(String key) async {
    if (!accents.containsKey(key)) return;
    _accentKey = key;
    await _persist();
  }

  /// Per-account wallpaper directory (`<appSupport>/home_wallpaper/<scope>/`).
  static Future<Directory> _wallpaperDir() async {
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
    final dir = Directory('${(await getApplicationSupportDirectory()).path}/home_wallpaper/$scope');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  /// Pick a wallpaper from the gallery, copy it into the per-account dir, persist
  /// the path. Returns true on success.
  static Future<bool> pickWallpaper() async {
    try {
      final x = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 88);
      if (x == null) return false;
      final dir = await _wallpaperDir();
      final dest = File('${dir.path}/wallpaper_${DateTime.now().millisecondsSinceEpoch}.jpg');
      await File(x.path).copy(dest.path);
      // Drop any previous wallpaper file to avoid orphan growth.
      final old = _wallpaperPath;
      _wallpaperPath = dest.path;
      await _persist();
      if (old != null && old != dest.path) {
        try { await File(old).delete(); } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<void> clearWallpaper() async {
    final old = _wallpaperPath;
    _wallpaperPath = null;
    await _persist();
    if (old != null) {
      try { await File(old).delete(); } catch (_) {}
    }
  }
}
