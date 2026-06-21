import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

/// Disk cache for AvaApps connector logos (the Composio app-catalog grid).
///
/// Composio serves each app's logo from a stable, per-slug URL
/// (logos.composio.dev/api/<slug>, usually SVG), so the bytes are effectively
/// immutable and safe to cache forever. Without this the grid re-downloaded
/// EVERY icon on each app open: `SvgPicture.network` / `Image.network` keep only
/// an in-memory cache that is gone after a restart. We now fetch once, persist
/// the bytes to disk, and load local-first so the grid is instant on every open.
///
/// Logos are PUBLIC and identical for all accounts, so this is a device-level
/// (global) cache — NOT per-account state — and intentionally not scoped.
class AppIconCache {
  AppIconCache._();

  /// Hot in-session cache so repeated builds (scroll / search filter) never
  /// touch disk or flash the fallback.
  static final Map<String, Uint8List> _mem = {};

  static Future<Directory> _dir() async {
    final base = await getApplicationSupportDirectory();
    final d = Directory('${base.path}/app_icons');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  static String _name(String url) {
    final safe = url.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    final tail = safe.length > 72 ? safe.substring(safe.length - 72) : safe;
    return '${tail}_${url.hashCode.toRadixString(16)}.icon';
  }

  /// Synchronous peek at the in-session cache — lets callers render instantly
  /// (no FutureBuilder placeholder) once the bytes are loaded.
  static Uint8List? cached(String url) => _mem[url];

  /// Returns the logo bytes for [url], fetching + persisting once if needed.
  /// Returns null on any failure (caller shows the monogram fallback).
  static Future<Uint8List?> get(String url) async {
    if (url.isEmpty) return null;
    final hot = _mem[url];
    if (hot != null) return hot;
    try {
      final f = File('${(await _dir()).path}/${_name(url)}');
      if (await f.exists() && await f.length() > 0) {
        final b = await f.readAsBytes();
        _mem[url] = b;
        return b;
      }
      final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        await f.writeAsBytes(res.bodyBytes, flush: true);
        _mem[url] = res.bodyBytes;
        return res.bodyBytes;
      }
    } catch (_) {/* fall through to null → monogram */}
    return null;
  }

  /// True when the bytes look like SVG (Composio's common logo format).
  static bool isSvg(Uint8List b) {
    final n = b.length < 256 ? b.length : 256;
    final head = String.fromCharCodes(b.sublist(0, n)).trimLeft().toLowerCase();
    return head.startsWith('<svg') || head.startsWith('<?xml');
  }
}
