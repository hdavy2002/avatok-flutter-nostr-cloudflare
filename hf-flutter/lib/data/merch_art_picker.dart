import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

/// A picture the influencer chose from the gallery.
class PickedArt {
  const PickedArt({required this.bytes, required this.name, required this.mime, this.problem});

  final Uint8List bytes;
  final String name;

  /// `image/png`, `image/jpeg`, or `image/webp` (only when the chooser was asked to allow WebP).
  final String mime;

  /// Set instead of [bytes] when this one picture could not be taken (for example it is over 15 MB). Plain words for the person.
  final String? problem;
}

/// [HF-MERCH-APP-1] Opens the phone's own picture chooser (Android `ACTION_GET_CONTENT`, no permission needed) through the
/// `hf/merch_art` channel in MainActivity.kt, which copies the chosen file into the app cache and answers its path.
/// No image_picker package: the pubspec keeps its fixed list of packages. Tests replace [picker] (one picture) and [manyPicker].
abstract final class MerchArtPicker {
  static const MethodChannel _channel = MethodChannel('hf/merch_art');

  /// Largest file the server takes (15 MB).
  static const int maxBytes = 15 * 1024 * 1024;

  static Future<PickedArt?> _pickPlain() => _pick(allowWebp: false);

  /// Test hook for the one-picture chooser. Assign a function that answers a [PickedArt] (or null).
  static Future<PickedArt?> Function() picker = _pickPlain;

  static bool get _hooked => !identical(picker, _pickPlain);

  /// One picture. [allowWebp] also lets the chooser show WebP files (used by the problem-photo screen); a replaced [picker] wins.
  static Future<PickedArt?> pick({bool allowWebp = false}) {
    if (allowWebp && !_hooked) return _pick(allowWebp: true);
    return picker();
  }

  /// Test hook for the many-pictures chooser. Gets the most pictures allowed.
  static Future<List<PickedArt>> Function(int max) manyPicker = _pickMany;

  /// Up to [max] pictures at once (PNG or JPEG). Empty when she backs out. A picture that cannot be taken comes back with [PickedArt.problem].
  static Future<List<PickedArt>> pickMany({int max = 5}) async {
    if (_hooked) {
      final one = await picker();
      return one == null ? const <PickedArt>[] : <PickedArt>[one];
    }
    return manyPicker(max);
  }

  static Future<PickedArt?> _pick({required bool allowWebp}) async {
    final r = await _channel.invokeMapMethod<String, Object?>('pickImage', <String, Object?>{'allowWebp': allowWebp});
    if (r == null) return null;
    return _read(r);
  }

  static Future<List<PickedArt>> _pickMany(int max) async {
    final r = await _channel.invokeListMethod<Object?>('pickImages', <String, Object?>{'max': max, 'allowWebp': false});
    if (r == null) return const <PickedArt>[];
    final out = <PickedArt>[];
    for (final e in r) {
      if (e is! Map) continue;
      final one = await _read(Map<String, Object?>.from(e));
      if (one != null) out.add(one);
    }
    return out;
  }

  /// Reads one answer of the channel ({path, name, mime} or {name, error}) and removes the cache copy.
  static Future<PickedArt?> _read(Map<String, Object?> r) async {
    final name = r['name'] is String ? r['name'] as String : 'art';
    final error = r['error'];
    if (error is String && error.isNotEmpty) {
      final text = error == 'too_large' ? 'The picture must be 15 MB or smaller.' : 'Could not open that picture. Try another one.';
      return PickedArt(bytes: Uint8List(0), name: name, mime: 'image/jpeg', problem: '$name: $text');
    }
    final path = r['path'];
    if (path is! String || path.isEmpty) return null;
    final file = File(path);
    try {
      final bytes = await file.readAsBytes();
      final mime = r['mime'] is String ? r['mime'] as String : '';
      return PickedArt(bytes: bytes, name: name, mime: _mimeOf(bytes, mime));
    } finally {
      try {
        await file.delete();
      } catch (_) {
        // the cache is cleaned by Android anyway
      }
    }
  }

  /// PNG, WebP or JPEG by the file's first bytes (the chooser's own mime type is only a hint).
  static String _mimeOf(Uint8List b, String hint) {
    if (b.length > 3 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return 'image/png';
    if (b.length > 2 && b[0] == 0xFF && b[1] == 0xD8) return 'image/jpeg';
    // RIFF....WEBP
    if (b.length > 11 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) {
      return 'image/webp';
    }
    return hint == 'image/png' ? 'image/png' : 'image/jpeg';
  }

  /// Test hook for [softEdgePercent].
  static Future<double> Function(Uint8List bytes) edgeCheck = _softEdgePercent;

  /// Share (0 to 100) of the visible pixels that are only part see-through, like the website's check
  /// (web artAnalysis `soft_edge_pct`). 0 for pictures without see-through pixels and when the picture cannot be read.
  static Future<double> softEdgePercent(Uint8List bytes) => edgeCheck(bytes);

  static Future<double> _softEdgePercent(Uint8List bytes) async {
    ui.ImmutableBuffer? buffer;
    ui.ImageDescriptor? desc;
    ui.Codec? codec;
    ui.Image? image;
    try {
      buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
      desc = await ui.ImageDescriptor.encoded(buffer);
      final longest = math.max(desc.width, desc.height);
      if (longest <= 0) return 0;
      final k = longest > 700 ? 700 / longest : 1.0;
      codec = await desc.instantiateCodec(targetWidth: math.max(1, (desc.width * k).round()), targetHeight: math.max(1, (desc.height * k).round()));
      final frame = await codec.getNextFrame();
      image = frame.image;
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) return 0;
      var visible = 0;
      var soft = 0;
      for (var i = 3; i < data.lengthInBytes; i += 4) {
        final a = data.getUint8(i);
        if (a > 0) {
          visible++;
          if (a < 255) soft++;
        }
      }
      return visible == 0 ? 0 : soft * 100 / visible;
    } catch (_) {
      return 0;
    } finally {
      image?.dispose();
      codec?.dispose();
      desc?.dispose();
      buffer?.dispose();
    }
  }
}
