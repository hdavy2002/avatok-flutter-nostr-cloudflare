/// AvaMemory — the two-lane memory facade (Phase 4 — Two-Lane Memory).
///
/// Phase 0 did NOT create an `AvaMemory` interface (it only reserved the name),
/// so this file DEFINES it and ships the router implementation.
///
/// ── The two lanes ────────────────────────────────────────────────────────────
///   • FREE / on-device lane  → [AvaLocalIndex] (FTS5 keyword first, brute-force
///     cosine vector on miss). Per-account by construction (the drift DB file is
///     per-account). This is the DEFAULT and the ONLY lane used for private /
///     on-device-only conversations — their content NEVER leaves the device.
///   • PREMIUM / server lane   → the Worker's Vectorize RAG (uid-scoped). Reached
///     via the existing brain surface; the worker-side query function added by
///     Phase 4 is `worker/src/lib/ava_memory.ts → brainSearch()`. The CLIENT does
///     not call Vectorize directly; the server-readable lane is for server-side
///     callers (the Ava agent spine / tools). On the client, the premium lane is
///     OPT-IN per account and gated by AvaBrain consent.
///
/// ── Privacy guarantee ────────────────────────────────────────────────────────
/// A conversation marked on-device-only (or any caller passing
/// `onDeviceOnly: true`) is searched ONLY by the local lane; its text is never
/// embedded for, indexed into, or queried against the server lane. The router
/// also refuses the server lane unless AvaBrain `avatok_messages` consent is on.
library;

import 'dart:convert';

import '../api_auth.dart';
import '../brain_consent.dart';
import '../config.dart';
import '../local_brain/embedder.dart';
import '../local_brain/local_index.dart';

/// A single memory search result. Stable shape consumed by P3 (the spine) and
/// P5 (the `brain.search` AvaTool).
class MemoryHit {
  final String messageId;
  final String convKey; // local conversation key: '1:<peerUid>' | 'g:<gid>'
  final double score; // higher = more relevant (lane-normalised, see below)
  final String snippet;

  /// Which lane produced this hit ('local' | 'server'). Useful for the UI to
  /// show a "found on this device" vs "from your cloud memory" affordance.
  final String lane;

  const MemoryHit({
    required this.messageId,
    required this.convKey,
    required this.score,
    required this.snippet,
    this.lane = 'local',
  });

  Map<String, dynamic> toJson() => {
        'messageId': messageId,
        'convKey': convKey,
        'score': score,
        'snippet': snippet,
        'lane': lane,
      };
}

/// The public memory contract. P3/P5 depend on this; the concrete router is
/// [AvaMemoryRouter] (exposed as [AvaMemory.I]).
abstract class AvaMemory {
  /// The process-wide instance. A singleton router; it binds to the active
  /// account through `Db.I` so account switches are transparent.
  static final AvaMemory I = AvaMemoryRouter._();

  /// Search memory for [query]. Restrict to one conversation with [convKey].
  ///
  /// Lane selection:
  ///   • on-device-only / private conv ([onDeviceOnly] true) → local lane ONLY.
  ///   • otherwise → local lane first; the server lane augments ONLY when
  ///     [allowServer] is true AND server memory is permitted for this account.
  Future<List<MemoryHit>> search(
    String query, {
    String? convKey,
    int topK = 5,
    bool onDeviceOnly = false,
    bool allowServer = false,
  });

  /// Index a single message into the on-device lane (lazy/selective; trivia is
  /// skipped). Always on-device — the server lane is populated server-side by
  /// the existing AvaBrain ingestion pipeline, never from here.
  Future<void> index({
    required String messageId,
    required String convKey,
    required String payload,
    required int createdAt,
  });

  /// Backfill the on-device index for a conversation (or all when null). Bounded
  /// by [limit]; returns the number of NEW messages indexed.
  Future<int> backfill({String? convKey, int limit = 500});
}

/// The router implementation. Decides the lane and merges results.
class AvaMemoryRouter implements AvaMemory {
  AvaMemoryRouter._();

  /// Pluggable server lane. Defaults to the live HTTP lane that calls the
  /// existing brain RAG surface; tests/other phases can swap it. When null the
  /// server lane is effectively disabled (local-only).
  AvaServerLane? serverLane = HttpServerLane();

  @override
  Future<List<MemoryHit>> search(
    String query, {
    String? convKey,
    int topK = 5,
    bool onDeviceOnly = false,
    bool allowServer = false,
  }) async {
    final q = query.trim();
    if (q.isEmpty) return const [];

    // 1) Local lane — FTS5 keyword first, vector on a miss. Always runs.
    var local = await AvaLocalIndex.I.searchKeyword(q, convKey: convKey, topK: topK);
    if (local.isEmpty) {
      local = await AvaLocalIndex.I.searchVector(q, convKey: convKey, topK: topK);
    }
    final hits = <MemoryHit>[
      for (final h in local)
        MemoryHit(
          messageId: h.messageId,
          convKey: h.convKey,
          score: h.score,
          snippet: h.snippet,
          lane: 'local',
        ),
    ];

    // 2) Server lane — ONLY when explicitly allowed and never for private convs.
    if (!onDeviceOnly && allowServer && serverLane != null) {
      if (await serverLane!.permitted()) {
        try {
          final serverHits = await serverLane!.search(q, topK: topK);
          hits.addAll(serverHits);
        } catch (_) {/* server lane is best-effort; local already answered */}
      }
    }

    // De-dup by messageId (local wins), then take top-k by score.
    final seen = <String>{};
    final merged = <MemoryHit>[];
    for (final h in hits) {
      if (h.messageId.isNotEmpty && !seen.add(h.messageId)) continue;
      merged.add(h);
    }
    merged.sort((a, b) => b.score.compareTo(a.score));
    return merged.take(topK).toList(growable: false);
  }

  @override
  Future<void> index({
    required String messageId,
    required String convKey,
    required String payload,
    required int createdAt,
  }) =>
      AvaLocalIndex.I.indexMessage(
        messageId: messageId,
        convKey: convKey,
        payload: payload,
        createdAt: createdAt,
      );

  @override
  Future<int> backfill({String? convKey, int limit = 500}) =>
      AvaLocalIndex.I.backfill(convKey: convKey, limit: limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Server (premium) lane — client side. The CLIENT never talks to Vectorize
// directly; it asks the Worker, which runs the uid-scoped Vectorize RAG. We
// reuse the EXISTING, already-deployed `/api/brain/chat` surface (server-
// readable RAG over the user's own content) and map its `sources` → MemoryHit.
// The pure-retrieval worker function added by Phase 4
// (worker/src/lib/ava_memory.ts → brainSearch) is what SERVER-SIDE callers (the
// Ava agent spine / tools) use; on the client this HTTP lane is the equivalent.
// ─────────────────────────────────────────────────────────────────────────────

/// The premium/server search lane abstraction (so it can be swapped/disabled).
abstract class AvaServerLane {
  /// Whether the server lane may be used for THIS account right now (consent +
  /// premium gating live here). Checked before any content leaves the device.
  Future<bool> permitted();

  /// Query the server lane. Returns MemoryHits tagged `lane: 'server'`.
  Future<List<MemoryHit>> search(String query, {int topK = 5});
}

/// Live server lane over the existing brain RAG endpoint.
class HttpServerLane implements AvaServerLane {
  @override
  Future<bool> permitted() async {
    // Server-readable memory requires AvaBrain message-indexing consent. If the
    // user opted out, the server lane is OFF (local lane still works offline).
    try {
      return await BrainConsent.isOn('avatok_messages');
    } catch (_) {
      return false;
    }
  }

  @override
  Future<List<MemoryHit>> search(String query, {int topK = 5}) async {
    try {
      // POST /api/brain/chat {message} → {answer, sources:[{conv, ref, snippet, ...}]}.
      final res = await ApiAuth.postJson(
        '$kBrainBase/chat',
        {'message': query},
        timeout: const Duration(seconds: 12),
      );
      if (res.statusCode != 200) return const [];
      final j = jsonDecode(res.body);
      if (j is! Map) return const [];
      final sources = (j['sources'] as List?) ?? const [];
      final out = <MemoryHit>[];
      var rank = sources.length;
      for (final s in sources) {
        if (s is! Map) continue;
        final conv = (s['conv'] ?? '').toString();
        final ref = (s['ref'] ?? s['media_ref'] ?? conv).toString();
        final snippet = (s['snippet'] ?? '').toString();
        out.add(MemoryHit(
          messageId: ref,
          // Server convs are 'dm_…' / 'g_…'; the UI maps them when opening. We
          // pass the server conv through as-is (router de-dup keys on messageId).
          convKey: conv,
          // Vectorize matches arrive best-first; synthesise a descending score.
          score: rank.toDouble(),
          snippet: snippet,
          lane: 'server',
        ));
        rank--;
        if (out.length >= topK) break;
      }
      return out;
    } catch (_) {
      return const [];
    }
  }
}

/// Phase-4 bootstrap entry point. Call from `AvaBootstrap.init()` (sanctioned
/// one-line append). It is non-blocking: it wakes the embedder availability
/// check (download-on-first-use happens lazily on the first vector search) and
/// touches the router so the singleton is constructed. Never throws.
Future<void> registerAvaMemory() async {
  try {
    // Touch the singleton (constructs the router + its server lane).
    // ignore: unnecessary_statements
    AvaMemory.I;
    // Kick the embedder availability check off the boot path (fire-and-forget).
    // The hashing stub returns true instantly; a real model schedules its
    // download here without blocking boot.
    // ignore: unawaited_futures
    defaultEmbedder.ensureReady();
  } catch (_) {/* boot must never fail because of memory */}
}
