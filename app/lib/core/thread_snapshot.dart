import '../identity/identity.dart' show AccountScope;

/// [CHAT-THREAD-SNAP-1] Tiny in-memory cache of the last few CONVERSATIONS'
/// rendered message lists, so reopening a thread you closed seconds ago repaints
/// synchronously instead of flashing empty while two async disk reads (SQLite +
/// the JSON `MessageStore` cache) race to refill it.
///
/// This is the per-thread sibling of [ChatListSnapshot] (`core/chat_list_snapshot.dart`)
/// and follows its reasoning deliberately:
///
///  * NOT a background pre-warm. Nothing populates this on launch; it is written
///    only by a thread that was actually open (on dispose) and is therefore empty
///    on a true cold start. Cold-start speed still comes from the persisted
///    SQLite projection + the JSON cache, which are unchanged.
///  * Bounded on purpose. At most [maxThreads] conversations and [maxMessages]
///    messages each — a working set, not a store. On a cheap phone an unbounded
///    per-thread cache is a slow memory leak that only shows up for the users who
///    can least afford it.
///  * NOT a substitute for the durable replay. The thread still runs its normal
///    hub/JSON-cache/SQLite replay on top of a restore; the restored `seenEv` set
///    is what makes that replay a cheap no-op instead of a double decode.
///
/// ## Why this is NOT a retained route
///
/// The obvious alternative — keeping the route alive with a keep-alive mixin —
/// was considered and rejected. `_ChatThreadScreenState.dispose()` does real
/// work: it releases the `ActiveThread` claim, sends presence "offline", stops
/// the DM/group listeners and flushes the message cache. A retained route would
/// keep a live presence heartbeat and an `ActiveThread` claim for a conversation
/// the user is not looking at, which suppresses foreground push banners for the
/// WRONG thread and shows you as "online" in a chat you left. Holding the plain
/// data instead has none of those side effects.
///
/// ## Per-account scoping (CLAUDE.md rule 1 — mandatory)
///
/// One phone is shared by a parent and each child account, so a message list
/// keyed by conversation alone is a cross-account leak. Every read and write
/// goes through [_ensureScope], which drops the ENTIRE cache the moment
/// `AccountScope.id` changes — the same fail-closed shape as `SyncHub.stop()`'s
/// `_byConv.clear()` and `MediaService._ensureScope`. Validating on access
/// (rather than relying on a switch hook remembering to call us) means a missed
/// hook can never surface another account's messages.
class ThreadSnapshot {
  /// Conversations retained. Three covers the real navigation pattern (bounce
  /// between two or three chats) without pinning a large working set.
  static const int maxThreads = 3;

  /// Messages retained per conversation. Matches the JSON cache's own window, so
  /// a restore never claims to hold more history than the durable cache does.
  static const int maxMessages = 300;

  static String? _scope;
  static final Map<String, ThreadSnapshotEntry> _lru = {};

  /// Drop everything if the signed-in account changed since the last access.
  static void _ensureScope() {
    final now = AccountScope.id ?? '';
    if (_scope != now) {
      _lru.clear();
      _scope = now;
    }
  }

  /// Remember a conversation's rendered list. `messages` is stored by reference
  /// and is expected to be a list the CALLER no longer mutates (a thread stores
  /// its list as it is being disposed).
  ///
  /// The caller is responsible for stripping any large in-memory payload from
  /// the entries first (see `_snapshotStore` in `chat_thread.dart`, which nulls
  /// decrypted `localBytes` — those bytes are already served from
  /// `MediaService`'s on-disk cache, which survives thread close).
  static void put({
    required String convKey,
    required List<Object> messages,
    required Set<String> seenEv,
    Map<String, bool>? hidden,
    Set<String>? deleted,
  }) {
    _ensureScope();
    if (convKey.isEmpty || messages.isEmpty) {
      _lru.remove(convKey);
      return;
    }
    // Keep the NEWEST window. `seenEv` is rebuilt from the retained slice by the
    // caller — a seen-id for a message we dropped would make the SQLite replay
    // skip a row that is no longer on screen, i.e. silently lose history.
    final kept = messages.length > maxMessages
        ? messages.sublist(messages.length - maxMessages)
        : messages;
    _lru.remove(convKey); // re-insert at the end == most-recently-used
    _lru[convKey] = ThreadSnapshotEntry(
      messages: List<Object>.unmodifiable(kept),
      seenEv: Set<String>.unmodifiable(seenEv),
      hidden: Map<String, bool>.unmodifiable(hidden ?? const <String, bool>{}),
      deleted: Set<String>.unmodifiable(deleted ?? const <String>{}),
      storedAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    while (_lru.length > maxThreads) {
      _lru.remove(_lru.keys.first); // least-recently-used
    }
  }

  /// Take (and REMOVE) a conversation's snapshot. Removing on read is
  /// deliberate: it guarantees at most one live screen owns a given set of
  /// message objects, so pushing the same thread on top of itself can never end
  /// up with two states mutating the same entries. The reopened thread writes
  /// the snapshot back on its own dispose.
  static ThreadSnapshotEntry? take(String convKey) {
    _ensureScope();
    if (convKey.isEmpty) return null;
    return _lru.remove(convKey);
  }

  /// Drop everything. Safe to call from a sign-out / account-switch path.
  static void clear() {
    _lru.clear();
    _scope = AccountScope.id ?? '';
  }
}

/// One retained conversation. `messages` is deliberately `List<Object>`: the
/// thread's message type is private to the `chat_thread` library, so this store
/// stays type-agnostic and the caller casts back with `.cast<_Msg>()`.
class ThreadSnapshotEntry {
  final List<Object> messages;

  /// Rumor ids already rendered in [messages]. Restoring this alongside the list
  /// is what makes the normal hub/cache/SQLite replay dedup itself into a no-op
  /// instead of re-decoding and double-rendering the same history.
  final Set<String> seenEv;

  /// Soft-delete (`HiddenStore`) and hard-delete (`DeletedStore`) tombstones as
  /// they were known when the thread closed, so a restore repaints the deleted
  /// pill immediately rather than flashing the original body until the async
  /// store loads finish.
  final Map<String, bool> hidden;
  final Set<String> deleted;

  final int storedAtMs;

  const ThreadSnapshotEntry({
    required this.messages,
    required this.seenEv,
    required this.hidden,
    required this.deleted,
    required this.storedAtMs,
  });
}
