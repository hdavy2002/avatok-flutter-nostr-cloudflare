import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'ava_log.dart';
import 'feature_flags.dart';
import '../identity/identity.dart';

/// Caller-side ringback + busy tone playback for the 1:1 call screen.
/// Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md
///
/// The CALLER plays this locally while the call is ringing — this is NOT carrier
/// early media. The callee's default ringtone URL (resolved at dial time) is
/// played looped; if it is empty or unreachable we fall back to the bundled
/// default ringback. The busy tone is always the bundled clip.
///
/// Caching: a fetched ringtone is cached on-device per account
/// (…/ringtones/<AccountScope.id>/<file>) per the Rulebook media-cache rule, so
/// repeat calls to the same person start instantly and work offline. One player
/// per call; [stop] on every call-end path, [dispose] in the screen's dispose().
class RingbackPlayer {
  final AudioPlayer _p = AudioPlayer();
  bool _disposed = false;

  // audioplayers AssetSource paths are relative to the `assets/` bundle prefix.
  static String _assetRel(String p) => p.startsWith('assets/') ? p.substring(7) : p;

  /// Play the callee's ringback (looped). [url] empty → bundled default.
  Future<void> playRingback(String url) async {
    try {
      await _p.setReleaseMode(ReleaseMode.loop);
      Source src;
      if (url.isEmpty) {
        src = AssetSource(_assetRel(kDefaultRingbackAsset));
      } else {
        final cached = await _cachedFile(url);
        if (cached != null && await cached.exists() && await cached.length() > 0) {
          src = DeviceFileSource(cached.path);
        } else {
          // Stream now (no delay); cache in the background for next time.
          src = UrlSource(url);
          // ignore: unawaited_futures
          _cacheInBackground(url);
        }
      }
      if (_disposed) return;
      await _p.play(src);
    } catch (e) {
      AvaLog.I.log('call', 'ringback play failed ($url): $e — using default');
      await _playDefaultRingback();
    }
  }

  Future<void> _playDefaultRingback() async {
    if (_disposed) return;
    try {
      await _p.setReleaseMode(ReleaseMode.loop);
      await _p.play(AssetSource(_assetRel(kDefaultRingbackAsset)));
    } catch (_) { /* give up silently — a missing tone must never crash a call */ }
  }

  /// Play the bundled busy tone a few cycles (does not loop forever).
  Future<void> playBusyTone() async {
    if (_disposed) return;
    try {
      await _p.setReleaseMode(ReleaseMode.release);
      await _p.play(AssetSource(_assetRel(kBusyToneAsset)));
    } catch (e) {
      AvaLog.I.log('call', 'busy tone play failed: $e');
    }
  }

  Future<void> stop() async {
    try { await _p.stop(); } catch (_) {}
  }

  Future<void> dispose() async {
    _disposed = true;
    try { await _p.stop(); } catch (_) {}
    try { await _p.dispose(); } catch (_) {}
  }

  // ---- per-account on-device cache --------------------------------------

  Future<Directory> _cacheDir() async {
    final base = await getApplicationSupportDirectory();
    final scope = (AccountScope.id == null || AccountScope.id!.isEmpty) ? '_' : AccountScope.id!;
    final d = Directory('${base.path}/ringtones/$scope');
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  // Stable filename from the URL's last path segment (server uses a uuid.mp3).
  String _fileName(String url) {
    final seg = Uri.parse(url).pathSegments;
    final last = seg.isNotEmpty ? seg.last : url.hashCode.toString();
    final safe = last.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    return safe.isEmpty ? '${url.hashCode}.mp3' : safe;
  }

  Future<File?> _cachedFile(String url) async {
    try {
      final dir = await _cacheDir();
      return File('${dir.path}/${_fileName(url)}');
    } catch (_) {
      return null;
    }
  }

  Future<void> _cacheInBackground(String url) async {
    try {
      final file = await _cachedFile(url);
      if (file == null || (await file.exists() && await file.length() > 0)) return;
      final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 20));
      if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
        await file.writeAsBytes(res.bodyBytes, flush: true);
      }
    } catch (_) { /* best-effort; streaming already covered this call */ }
  }
}
