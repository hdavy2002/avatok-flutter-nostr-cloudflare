/// Ava in-chat CONTRACTS (Phase 0 — Foundations). Single source of truth on the
/// client for:
///   • the Ava message-kind strings (mirror of worker/src/lib/ava_kinds.ts),
///   • the JSON body shapes Ava turns carry,
///   • the Ava worker route paths (handlers are filled by later phases).
///
/// Later phases import from here so they never re-declare the wire contract.
/// Keep the string values in sync with worker/src/lib/ava_kinds.ts — they are
/// the on-the-wire contract; do NOT rename casually.
library;

/// The three Ava-authored message kinds.
class AvaKind {
  AvaKind._();

  /// Ava posts into the thread — feminine bubble, visible to all participants.
  static const String ava = 'ava';

  /// Ava posts to ONE recipient only (Guardian warning / just-for-me answer).
  static const String avaPrivate = 'ava_private';

  /// Transient "Ava is working…" chip — broadcast only, never persisted.
  static const String avaStatus = 'ava_status';

  static const Set<String> all = {ava, avaPrivate, avaStatus};

  static bool isAva(String? kind) => kind != null && all.contains(kind);

  /// True for the two kinds that render as a real (persisted) Ava bubble.
  static bool isBubble(String? kind) => kind == ava || kind == avaPrivate;
}

/// Visibility scope on a message append (mirrors MessageScope in ava_kinds.ts).
/// 'thread' = fan out to all participants; 'to:<uid>' = private to that uid.
class AvaScope {
  AvaScope._();
  static const String thread = 'thread';

  /// Build a private scope string for [uid].
  static String to(String uid) => 'to:$uid';

  /// Returns the target uid for a `to:<uid>` scope, else null.
  static String? audience(String? scope) {
    if (scope == null || scope == thread) return null;
    return scope.startsWith('to:') ? scope.substring(3) : null;
  }
}

/// Ava worker route paths. Registered in worker/src/index.ts by Phase 0;
/// handler modules are created by the owner phases (see master-plan §4).
class AvaApi {
  AvaApi._();

  /// P2 — BYO-AI / our-keys Gemini proxy (moderation gate + daily cap live here).
  static const String gemini = '/api/ava/gemini';

  /// P3 — in-thread agent turn (posts ava/ava_status into the existing conv).
  static const String threadTurn = '/api/ava/thread/turn';

  /// RAG — index the user's files + chat text into their own File Search store
  /// (under their Google key); @ava queries it automatically.
  static const String ragIngest = '/api/ava/rag/ingest';
  static const String ragStore = '/api/ava/rag/store';

  /// P5 — tool broker / Strata progressive disclosure (prefix; sub-paths vary).
  static const String toolsPrefix = '/api/ava/tools/';

  /// P8 — Guardian classifier scan (private warnings via ava_private).
  static const String guardianScan = '/api/ava/guardian/scan';

  /// P9 — generative image (Nano Banana 2), async present-in-thread.
  static const String image = '/api/ava/image';

  /// P10 — backup & sync (R2 premium sync, Drive free backup). Prefix.
  static const String backupPrefix = '/api/backup/';
}
