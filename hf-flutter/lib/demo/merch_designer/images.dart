import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'contract.dart';

/// [HF-MERCH-STUDIO-2] Pictures for the studio: finds the bytes of a tray picture (the phone's own copy, else a download of its URL)
/// and decodes them to `ui.Image` for the stage. Decoded stage images are capped at [stageMaxSide] pixels; the export decodes again
/// at the size the print needs.
class PictureUnreadable implements Exception {
  const PictureUnreadable();
  @override
  String toString() => 'Could not read the picture - please add it again.';
}

/// Decodes [bytes], shrinking so the long side is at most [maxSide] pixels. Throws when the bytes are not a picture.
Future<ui.Image> decodePicture(Uint8List bytes, {required int maxSide}) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  try {
    final desc = await ui.ImageDescriptor.encoded(buffer);
    try {
      final w = desc.width, h = desc.height;
      final side = math.max(w, h);
      final shrink = side > maxSide;
      final codec = await desc.instantiateCodec(
        targetWidth: shrink ? math.max(1, (w * maxSide / side).round()) : null,
        targetHeight: shrink ? math.max(1, (h * maxSide / side).round()) : null,
      );
      try {
        final frame = await codec.getNextFrame();
        return frame.image;
      } finally {
        codec.dispose();
      }
    } finally {
      desc.dispose();
    }
  } finally {
    buffer.dispose();
  }
}

Future<Uint8List> encodePng(ui.Image image) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  if (data == null) throw StateError('png_encode_failed');
  return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

class ImageStore {
  ImageStore(this.arts);

  static const int stageMaxSide = 1800;

  /// The tray (kept current by the owner of the store).
  List<StudioArt> arts;

  /// Bumps when a picture finished decoding, so the stage redraws.
  final ValueNotifier<int> changes = ValueNotifier<int>(0);

  final Map<String, Uint8List> _bytes = <String, Uint8List>{};
  final Map<String, ui.Image> _images = <String, ui.Image>{};
  final Map<String, Future<void>> _loading = <String, Future<void>>{};
  final Map<String, ui.Image> _overrides = <String, ui.Image>{};
  final Set<String> failed = <String>{};
  bool _disposed = false;

  /// What the stage draws for [l]: a temporary preview (like "erase plain colour") or the decoded picture.
  ui.Image? imageFor(ImageDesignLayer l) => _overrides[l.id] ?? _images[l.artId];

  /// Shows [image] for layer [layerId] instead of its picture (null clears it). The store owns and disposes the image.
  void setOverride(String layerId, ui.Image? image) {
    final old = _overrides.remove(layerId);
    if (image != null) _overrides[layerId] = image;
    if (old != null) {
      // let the frame that may still draw it finish first
      scheduleMicrotask(old.dispose);
    }
    changes.value++;
  }

  /// Remembers the bytes the phone already has for [artId] (a fresh cut-out, an uploaded composite).
  void putBytes(String artId, Uint8List bytes) => _bytes[artId] = bytes;

  /// The picture file for [artId]: the tray copy if the phone has one, else downloaded from [url].
  Future<Uint8List> bytesFor(String artId, String url) async {
    final cached = _bytes[artId];
    if (cached != null) return cached;
    for (final a in arts) {
      if (a.artId == artId && a.bytes != null && a.bytes!.isNotEmpty) {
        _bytes[artId] = a.bytes!;
        return a.bytes!;
      }
    }
    if (url.isEmpty) throw const PictureUnreadable();
    try {
      final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 60));
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) throw const PictureUnreadable();
      _bytes[artId] = res.bodyBytes;
      return res.bodyBytes;
    } on PictureUnreadable {
      rethrow;
    } catch (_) {
      throw const PictureUnreadable();
    }
  }

  /// Starts decoding the pictures the layers use (no-op for those already loaded or loading).
  void ensureLayers(List<DesignLayer> layers) {
    for (final l in layers) {
      if (l is ImageDesignLayer) unawaited(_ensure(l.artId, l.url));
    }
  }

  Future<void> _ensure(String artId, String url) {
    if (_images.containsKey(artId) || failed.contains(artId)) return Future<void>.value();
    return _loading.putIfAbsent(artId, () async {
      try {
        final bytes = await bytesFor(artId, url);
        final img = await decodePicture(bytes, maxSide: stageMaxSide);
        if (_disposed) {
          img.dispose();
          return;
        }
        _images[artId] = img;
      } catch (_) {
        failed.add(artId);
      } finally {
        _loading.remove(artId)?.ignore();
        if (!_disposed) changes.value++;
      }
    });
  }

  /// Gives a failed picture another try.
  void retry(String artId) => failed.remove(artId);

  void dispose() {
    _disposed = true;
    for (final i in _images.values) {
      i.dispose();
    }
    for (final i in _overrides.values) {
      i.dispose();
    }
    _images.clear();
    _overrides.clear();
    changes.dispose();
  }
}
