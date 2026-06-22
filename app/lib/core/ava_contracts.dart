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

  /// AvaApps (PREMIUM) — operate the user's Google apps via Composio, driven by
  /// the user's own Gemini key. connect → OAuth URLs; status → connected apps;
  /// run → natural-language action.
  static const String appsCatalog = '/api/ava/apps/catalog';
  static const String appsConnect = '/api/ava/apps/connect';
  static const String appsDisconnect = '/api/ava/apps/disconnect';
  static const String appsStatus = '/api/ava/apps/status';
  static const String appsRun = '/api/ava/apps/run';

  /// GenUI card action (PREMIUM) — execute ONE Composio tool fired from a
  /// generative card (a `composio` action button/form: Rename, Delete, Schedule…).
  /// Server re-validates the tool against the user's connected toolkits, coerces
  /// args to the tool schema, runs it, and returns a refreshed A2UI surface.
  static const String genuiAction = '/api/ava/genui/action';

  /// AvaTOK Drive — the user's OWN files in their Google Drive AvaTOK folder
  /// (Hybrid storage; shared chat media stays on encrypted R2).
  static const String driveConnect = '/api/ava/drive/connect';
  static const String driveStatus = '/api/ava/drive/status';
  static const String driveList = '/api/ava/drive/list';
  static const String driveUpload = '/api/ava/drive/upload';
  /// FREE backup lane — a separate, user-visible "avatok-backup" Drive folder.
  static const String driveBackupEnsure = '/api/ava/drive/backup/ensure';
  static const String driveBackupUpload = '/api/ava/drive/backup/upload';
  static const String driveBackupDownload = '/api/ava/drive/backup/download';

  /// AvaChat — talk-to-Ava conversation history (cloud backup in D1).
  static const String chatHistory = '/api/ava/chat/history';
  /// AvaChat — session-list metadata mutations (rename/star/archive/delete/reorder).
  static const String chatHistoryMeta = '/api/ava/chat/history/meta';

  /// P8 — Guardian classifier scan (private warnings via ava_private).
  static const String guardianScan = '/api/ava/guardian/scan';

  /// P9 — generative image (Nano Banana 2), async present-in-thread.
  static const String image = '/api/ava/image';

  /// P10 — backup & sync (R2 premium sync, Drive free backup). Prefix.
  static const String backupPrefix = '/api/backup/';
}
