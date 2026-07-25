/// [AVABRAIN-ASSET-1] AvaMemoryAsset client — upload/prepare/complete/
/// index-status for the canonical asset pipeline (Specs/
/// ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md Part VI §40/§47).
///
/// Rides the EXISTING `/api/brain/media/{prepare,complete,:id}` endpoints
/// (worker/src/routes/brain_media.ts) rather than standing up a second upload
/// path — that file already gives every kind it accepts encrypted-at-rest
/// storage, dedup-by-hash, a daily cap and per-user concurrency limits, and now
/// (this change) links each upload to a `brain_assets` row server-side.
///
/// The server NEVER returns transcript/caption/extracted-text content from
/// these endpoints (Part VI §47's "do not expose raw transcript/caption
/// content in status responses") — only job/index status — so nothing this
/// client caches is sensitive.
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'api_auth.dart';
import 'config.dart';

enum AvaAssetIndexStatus {
  pending,
  processing,
  ready,
  failed,
  // Part VI §40/§47 honesty status: the recording/file's audio (if any) may
  // still be indexed, but visual frame search was never performed. Never
  // treat this as a generic failure — it is a truthful capability boundary.
  unsupportedVisualIndexing,
  deleted,
  unknown,
}

AvaAssetIndexStatus _statusFromWire(String? s) {
  switch (s) {
    case 'pending':
      return AvaAssetIndexStatus.pending;
    case 'processing':
      return AvaAssetIndexStatus.processing;
    case 'ready':
      return AvaAssetIndexStatus.ready;
    case 'failed':
      return AvaAssetIndexStatus.failed;
    case 'unsupported_visual_indexing':
      return AvaAssetIndexStatus.unsupportedVisualIndexing;
    case 'deleted':
      return AvaAssetIndexStatus.deleted;
    default:
      return AvaAssetIndexStatus.unknown;
  }
}

/// One recording/file's job + index status. Deliberately carries NO
/// transcript/caption/extracted-text — the server never sends it here.
class AvaAssetStatus {
  final String id; // brain_media row id === media_id (the cross-surface join key)
  final String kind; // audio|video today; image/pdf once their producer ships
  final String state; // brain_media state machine: queued/transcribing/.../ready/failed/deleted
  final String? error;
  final int sizeBytes;
  final int? durationSec;
  final String? assetId;
  final AvaAssetIndexStatus indexStatus;
  final int createdAt;
  final int updatedAt;
  final int? readyAt;

  const AvaAssetStatus({
    required this.id,
    required this.kind,
    required this.state,
    this.error,
    required this.sizeBytes,
    this.durationSec,
    this.assetId,
    required this.indexStatus,
    required this.createdAt,
    required this.updatedAt,
    this.readyAt,
  });

  bool get isTerminal => state == 'ready' || state == 'failed' || state == 'deleted';

  /// True when the upload succeeded but visual search specifically is not
  /// available for it (§40/§47) — render "audio searchable, visual search not
  /// available" rather than a generic success/failure state.
  bool get visualUnsupported => indexStatus == AvaAssetIndexStatus.unsupportedVisualIndexing;

  factory AvaAssetStatus.fromJson(Map<String, dynamic> j) => AvaAssetStatus(
        id: (j['id'] ?? '').toString(),
        kind: (j['kind'] ?? '').toString(),
        state: (j['state'] ?? '').toString(),
        error: j['error']?.toString(),
        sizeBytes: (j['size_bytes'] as num?)?.toInt() ?? 0,
        durationSec: (j['duration_sec'] as num?)?.toInt(),
        assetId: j['asset_id']?.toString(),
        indexStatus: _statusFromWire(j['asset_index_status']?.toString()),
        createdAt: (j['created_at'] as num?)?.toInt() ?? 0,
        updatedAt: (j['updated_at'] as num?)?.toInt() ?? 0,
        readyAt: (j['ready_at'] as num?)?.toInt(),
      );
}

/// Prepare-call decision (mirrors worker `brainMediaPrepare`'s response shape).
class AvaAssetPrepareDecision {
  final bool allowed;
  final String decision; // ok|disabled|too_large|too_long|daily_cap_reached|duplicate
  final String? existingId;
  final String? existingState;
  const AvaAssetPrepareDecision(this.allowed, this.decision, {this.existingId, this.existingState});

  factory AvaAssetPrepareDecision.fromJson(Map<String, dynamic> j) => AvaAssetPrepareDecision(
        j['allowed'] == true,
        (j['decision'] ?? '').toString(),
        existingId: j['id']?.toString(),
        existingState: j['state']?.toString(),
      );
}

class BrainAssetsClient {
  BrainAssetsClient._();

  static const _s = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _cacheKeyBase = 'brain_assets_status_cache';

  static String get _prepareUrl => '$kBrainBase/media/prepare';
  static String get _completeUrl => '$kBrainBase/media/complete';
  static String _statusUrl(String id) => '$kBrainBase/media/$id';

  /// Policy check BEFORE any bytes move (mirrors the server's "never block the
  /// composer" contract — call this in the background after the local bubble
  /// already renders, not as a blocking gate on the UI).
  static Future<AvaAssetPrepareDecision> prepare({
    required String kind, // 'audio' | 'video'
    required String mime,
    required int sizeBytes,
    int? durationSec,
    String? contentHash,
  }) async {
    final res = await ApiAuth.postJson(_prepareUrl, {
      'kind': kind,
      'mime': mime,
      'sizeBytes': sizeBytes,
      if (durationSec != null) 'durationSec': durationSec,
      if (contentHash != null) 'contentHash': contentHash,
    });
    return AvaAssetPrepareDecision.fromJson(_json(res.body));
  }

  /// Uploads the raw bytes (mirrors routes/media.ts uploadPublic's contract —
  /// this Worker IS the upload endpoint; no separate signed URL).
  static Future<AvaAssetStatus?> complete({
    required String kind,
    required String mime,
    required List<int> bytes,
    int? durationSec,
  }) async {
    final res = await ApiAuth.postBytes(
      _completeUrl,
      bytes,
      extraHeaders: {
        'x-kind': kind,
        'x-mime': mime,
        if (durationSec != null) 'x-duration-sec': durationSec.toString(),
      },
      timeout: const Duration(seconds: 90),
    );
    if (res.statusCode != 200) return null;
    final j = _json(res.body);
    final id = (j['id'] ?? '').toString();
    if (id.isEmpty) return null;
    // /complete's own response is a thin {id,state[,deduped]} shape, not the
    // full status row — fetch once so callers always see one consistent
    // AvaAssetStatus shape, and cache it.
    return status(id);
  }

  /// GET status/progress ONLY — never transcript/caption/extracted-text
  /// (Part VI §47). Falls back to the scoped local cache when offline.
  static Future<AvaAssetStatus?> status(String id) async {
    try {
      final res = await ApiAuth.getSigned(_statusUrl(id));
      if (res.statusCode != 200) return _cached(id);
      final st = AvaAssetStatus.fromJson(_json(res.body));
      await _cachePut(st);
      return st;
    } catch (_) {
      return _cached(id);
    }
  }

  /// Revoke: deletes the source recording AND every derived index (the server
  /// route enqueues the async derivative wipe — see worker/src/routes/
  /// brain_media.ts brainMediaDelete / consumers/src/brain_assets.ts
  /// deleteAssetForMedia).
  static Future<bool> delete(String id) async {
    try {
      final res = await ApiAuth.deleteSigned(_statusUrl(id));
      final ok = res.statusCode == 200;
      if (ok) await _cacheRemove(id);
      return ok;
    } catch (_) {
      return false;
    }
  }

  // ---- scoped local cache (mandatory per-account — CLAUDE.md rulebook rule 1:
  // one phone, multiple accounts, every local store MUST be namespaced) ----

  static String get _cacheKey => scopedKey(_cacheKeyBase);

  static Future<Map<String, dynamic>> _cacheAll() async {
    try {
      final raw = await _s.read(key: _cacheKey);
      if (raw == null || raw.isEmpty) return {};
      return (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      return {};
    }
  }

  static Future<void> _cachePut(AvaAssetStatus st) async {
    try {
      final all = await _cacheAll();
      all[st.id] = {
        'id': st.id,
        'kind': st.kind,
        'state': st.state,
        'error': st.error,
        'size_bytes': st.sizeBytes,
        'duration_sec': st.durationSec,
        'asset_id': st.assetId,
        'asset_index_status': st.indexStatus.name,
        'created_at': st.createdAt,
        'updated_at': st.updatedAt,
        'ready_at': st.readyAt,
      };
      await _s.write(key: _cacheKey, value: jsonEncode(all));
    } catch (_) {}
  }

  static Future<AvaAssetStatus?> _cached(String id) async {
    final all = await _cacheAll();
    final row = all[id];
    if (row is! Map) return null;
    final cast = row.cast<String, dynamic>();
    final idx = AvaAssetIndexStatus.values.firstWhere(
      (e) => e.name == cast['asset_index_status'],
      orElse: () => AvaAssetIndexStatus.unknown,
    );
    return AvaAssetStatus(
      id: (cast['id'] ?? '').toString(),
      kind: (cast['kind'] ?? '').toString(),
      state: (cast['state'] ?? '').toString(),
      error: cast['error']?.toString(),
      sizeBytes: (cast['size_bytes'] as num?)?.toInt() ?? 0,
      durationSec: (cast['duration_sec'] as num?)?.toInt(),
      assetId: cast['asset_id']?.toString(),
      indexStatus: idx,
      createdAt: (cast['created_at'] as num?)?.toInt() ?? 0,
      updatedAt: (cast['updated_at'] as num?)?.toInt() ?? 0,
      readyAt: (cast['ready_at'] as num?)?.toInt(),
    );
  }

  static Future<void> _cacheRemove(String id) async {
    try {
      final all = await _cacheAll();
      all.remove(id);
      await _s.write(key: _cacheKey, value: jsonEncode(all));
    } catch (_) {}
  }

  static Map<String, dynamic> _json(String body) {
    try {
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }
}
