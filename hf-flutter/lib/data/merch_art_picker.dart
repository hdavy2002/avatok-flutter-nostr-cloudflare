import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';

/// A picture the influencer chose from the gallery.
class PickedArt {
  const PickedArt({required this.bytes, required this.name, required this.mime});

  final Uint8List bytes;
  final String name;

  /// `image/png` or `image/jpeg`.
  final String mime;
}

/// [HF-MERCH-APP-1] Opens the phone's own picture chooser (Android `ACTION_GET_CONTENT`, no permission needed) through the
/// `hf/merch_art` channel in MainActivity.kt, which copies the chosen file into the app cache and answers its path.
/// No image_picker package: the pubspec keeps its fixed list of packages. Tests replace [picker].
abstract final class MerchArtPicker {
  static const MethodChannel _channel = MethodChannel('hf/merch_art');

  /// Largest file the server takes (15 MB).
  static const int maxBytes = 15 * 1024 * 1024;

  static Future<PickedArt?> Function() picker = _pick;

  static Future<PickedArt?> pick() => picker();

  static Future<PickedArt?> _pick() async {
    final r = await _channel.invokeMapMethod<String, Object?>('pickImage');
    if (r == null) return null;
    final path = r['path'];
    if (path is! String || path.isEmpty) return null;
    final file = File(path);
    try {
      final bytes = await file.readAsBytes();
      final mime = r['mime'] is String ? r['mime'] as String : '';
      final name = r['name'] is String ? r['name'] as String : 'art';
      return PickedArt(bytes: bytes, name: name, mime: _mimeOf(bytes, mime));
    } finally {
      try {
        await file.delete();
      } catch (_) {
        // the cache is cleaned by Android anyway
      }
    }
  }

  /// PNG or JPEG by the file's first bytes (the chooser's own mime type is only a hint).
  static String _mimeOf(Uint8List b, String hint) {
    if (b.length > 3 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return 'image/png';
    if (b.length > 2 && b[0] == 0xFF && b[1] == 0xD8) return 'image/jpeg';
    return hint == 'image/png' ? 'image/png' : 'image/jpeg';
  }
}
