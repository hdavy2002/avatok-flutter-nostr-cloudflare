/// AvaLocalBrain — the DEVICE LANE of One Brain (§2.1 `device_private`).
///
/// This is the single, device-only entry point for the on-device brain. It is
/// the `AvaLocalBrain.ingest(...)` API the spec (§2.1) calls out explicitly:
///
///   > `device_private` ingestion uses a **separate device-only API**
///   > (`AvaLocalBrain.ingest(...)` in the app) that has no network path at all.
///
/// It is a thin FAÇADE over [AvaLocalIndex] (FTS5 keyword + brute-force-cosine
/// vector search on the per-account drift SQLite file). It deliberately does NOT
/// re-implement the index — the goal is the MODULE BOUNDARY, not a rewrite. The
/// server lane (`account_private`) is reached elsewhere (the `brainIngest`
/// contract + the two-lane router `AvaMemory`); nothing in this file, or anywhere
/// under `core/local_brain/`, may touch the network. That is proven, not
/// promised, by `test/local_brain_networkless_test.dart` (§6.1): it walks this
/// module's imports and fails on any network-capable dependency.
///
/// ── Per-account scoping (rulebook rule 1) ────────────────────────────────────
/// Scoping is inherited, not re-derived: [AvaLocalIndex] runs on `Db.I`, the
/// per-account drift database (`avatok_<AccountScope.id>.sqlite`). When the
/// active account switches, `Db.I` rebinds to that account's file, so every
/// `ingest`/`search` here automatically reads and writes ONLY the active
/// account's index. There is no global on-device store to leak across accounts.
library;

import 'dart:convert';

import 'local_index.dart';

/// One device-lane hit. Mirrors the shape callers need without leaking the
/// index's internal [LocalHit] type across the module boundary.
class LocalBrainHit {
  /// The producer's stable id for the ingested item (== `sourceId` on ingest,
  /// == the underlying message/row id). Empty is possible for legacy rows.
  final String sourceId;

  /// The on-device grouping key ('1:<peerUid>' | 'g:<gid>' | '<domain>:<...>').
  final String convKey;

  /// Relevance, normalised so higher = better (FTS bm25-derived or cosine).
  final double score;

  /// A short human-readable excerpt, centred on the query where possible.
  final String snippet;

  const LocalBrainHit({
    required this.sourceId,
    required this.convKey,
    required this.score,
    required this.snippet,
  });
}

/// The device-private brain. Process-wide singleton; binds to the active account
/// through [AvaLocalIndex] / `Db.I`.
class AvaLocalBrain {
  AvaLocalBrain._();
  static final AvaLocalBrain I = AvaLocalBrain._();

  /// Ingest one piece of device-private content into the on-device brain.
  ///
  /// Networkless by construction (see the library doc). Mirrors the server
  /// `brainIngest` envelope shape (§3) so producers read the same on both lanes,
  /// but there is NO `uid`/network — the active-account SQLite file IS the scope.
  ///
  ///   • [domain]   — the brain domain (default `'msg_content'`, the only
  ///                  `device_private` domain in the registry, §2.1). Other
  ///                  domains (e.g. `'voicemail'`, `'files'`) may index a
  ///                  device-local copy for offline recall.
  ///   • [kind]     — the event kind ('message', 'file_ref', 'voicemail_transcript'…).
  ///   • [text]     — the searchable content. Empty/trivia is dropped by the index.
  ///   • [meta]     — optional extras. `meta['convKey']` overrides the grouping
  ///                  key; otherwise it is derived from [domain] + [kind].
  ///   • [ts]       — event time (epoch; seconds or millis — stored UNINDEXED).
  ///   • [sourceId] — the producing row/event id. Doubles as the index primary
  ///                  key, so re-ingesting the same [sourceId] is idempotent.
  Future<void> ingest({
    String domain = 'msg_content',
    required String kind,
    required String text,
    Map<String, dynamic> meta = const {},
    required int ts,
    required String sourceId,
  }) async {
    final explicit = (meta['convKey'] as String?)?.trim();
    final convKey = (explicit != null && explicit.isNotEmpty)
        ? explicit
        : '$domain:$kind';
    // Wrap as the app's text envelope so AvaLocalIndex.extractText picks up the
    // body; domain/kind ride along for future filtering without a schema change.
    final payload = jsonEncode({
      't': 'text',
      'domain': domain,
      'kind': kind,
      'body': text,
    });
    await AvaLocalIndex.I.indexMessage(
      messageId: sourceId,
      convKey: convKey,
      payload: payload,
      createdAt: ts,
    );
  }

  /// Search the device lane for [query]. Keyword (FTS5) first; brute-force
  /// vector on a miss. [convKey] restricts to one grouping. Returns up to [k].
  Future<List<LocalBrainHit>> search(
    String query, {
    int k = 5,
    String? convKey,
  }) async {
    final q = query.trim();
    if (q.isEmpty) return const [];
    var hits = await AvaLocalIndex.I.searchKeyword(q, convKey: convKey, topK: k);
    if (hits.isEmpty) {
      hits = await AvaLocalIndex.I.searchVector(q, convKey: convKey, topK: k);
    }
    return [
      for (final h in hits)
        LocalBrainHit(
          sourceId: h.messageId,
          convKey: h.convKey,
          score: h.score,
          snippet: h.snippet,
        ),
    ];
  }

  /// Warm the device-lane schema (and fold any legacy on-device store on first
  /// call). Cheap + idempotent; indexes nothing on its own.
  Future<void> ensureReady() => AvaLocalIndex.I.warm();

  /// Row count of the unified device index (for adoption/size telemetry).
  Future<int> count() => AvaLocalIndex.I.count();

  /// Backfill the device lane from the local `messages` table (device-only).
  /// Bounded by [limit]; returns the number of NEW items indexed.
  Future<int> backfill({String? convKey, int limit = 500}) =>
      AvaLocalIndex.I.backfill(convKey: convKey, limit: limit);
}
