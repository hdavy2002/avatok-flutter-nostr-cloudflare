import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path_provider/path_provider.dart';

import '../identity/identity.dart';

part 'db.g.dart';

// ── Local SQLite (drift) — the on-device source of truth ─────────────────────
// The WhatsApp model: messages/contacts/chats live here, the UI watches the DB
// (reactive streams), and the network only syncs NEW rows in. Because the relay
// re-streams old gift-wraps on every launch, INSERT OR IGNORE on the message
// primary key (rumorId) makes those re-streams a no-op — nothing re-downloads or
// re-renders; only genuinely new rows fire a UI update.

/// One row per 1:1/group message (deduped by the gift-wrap rumor id).
@DataClassName('MessageRow')
class Messages extends Table {
  TextColumn get rumorId => text()();
  TextColumn get convKey => text()(); // '1:<peerHex>' (DM) or 'g:<gid>' (group)
  BoolColumn get mine => boolean()();
  TextColumn get payload => text()(); // the app envelope JSON (text/media/etc.)
  IntColumn get createdAt => integer()(); // epoch seconds
  @override
  Set<Column> get primaryKey => {rumorId};
}

/// Saved contacts.
@DataClassName('ContactRow')
class Contacts extends Table {
  TextColumn get npub => text()();
  TextColumn get name => text().withDefault(const Constant(''))();
  TextColumn get handle => text().withDefault(const Constant(''))();
  TextColumn get email => text().withDefault(const Constant(''))();
  TextColumn get avatarUrl => text().withDefault(const Constant(''))();
  @override
  Set<Column> get primaryKey => {npub};
}

/// Per-conversation chat-list projection — ONE persisted row per conversation
/// that already holds everything a list row needs to paint (name, avatar,
/// preview, unread, flags, group info), serialized in [json]. This is the
/// WhatsApp-style local source of truth for the chat list: on cold start the
/// list paints from a SINGLE indexed query over this table (`chatsOnce`), so it
/// is instant on any phone WITHOUT pre-loading anything into memory. [ts] is a
/// real column purely so the query can ORDER BY recency cheaply; [json] carries
/// the full display payload. The authoritative stores (contacts/previews/flags)
/// rewrite this projection in the background after each load.
@DataClassName('ChatRow')
class Chats extends Table {
  TextColumn get convKey => text()();
  TextColumn get preview => text().withDefault(const Constant(''))();
  IntColumn get ts => integer().withDefault(const Constant(0))();
  BoolColumn get lastMine => boolean().withDefault(const Constant(false))();
  IntColumn get unread => integer().withDefault(const Constant(0))();
  TextColumn get json => text().withDefault(const Constant(''))();
  @override
  Set<Column> get primaryKey => {convKey};
}

@DriftDatabase(tables: [Messages, Contacts, Chats])
class AppDb extends _$AppDb {
  AppDb() : super(_open());

  @override
  int get schemaVersion => 2;

  // The Chats projection gained a [json] column in v2. Add it in-place so an
  // existing on-device DB upgrades without wiping messages/contacts.
  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          if (from < 2) {
            await m.addColumn(chats, chats.json);
          }
        },
      );

  // ── chat-list projection (the single-query cold-start source of truth) ──
  /// All chat-list rows, most-recent first — ONE indexed query. Pinned-first
  /// ordering + filtering is applied cheaply in Dart over this small result.
  Future<List<ChatRow>> chatsOnce() => (select(chats)
        ..orderBy([(t) => OrderingTerm(expression: t.ts, mode: OrderingMode.desc)]))
      .get();

  /// Replace the whole projection in one transaction (delete-all + bulk insert).
  /// Cheap: the row count equals the number of conversations, and it runs in the
  /// background right after the authoritative stores load. Takes plain records so
  /// callers (widgets) don't need to import drift's companion/Value types.
  Future<void> replaceChatList(List<({String convKey, int ts, String json})> rows) async {
    await transaction(() async {
      await delete(chats).go();
      if (rows.isNotEmpty) {
        await batch((b) => b.insertAll(
              chats,
              [
                for (final r in rows)
                  ChatsCompanion.insert(convKey: r.convKey, ts: Value(r.ts), json: Value(r.json)),
              ],
              mode: InsertMode.insertOrReplace, // duplicate convKey can't crash the write
            ));
      }
    });
  }

  // ── writes (used now by RelayHub; reactive reads land in Phase 3) ──
  /// Store a message; re-streamed duplicates are silently ignored.
  Future<void> upsertMessage(MessagesCompanion m) =>
      into(messages).insert(m, mode: InsertMode.insertOrIgnore);

  /// How many messages we already have for a conversation (cheap count).
  Future<int> messageCount(String convKey) async {
    final c = messages.rumorId.count();
    final q = selectOnly(messages)
      ..addColumns([c])
      ..where(messages.convKey.equals(convKey));
    return (await q.getSingle()).read(c) ?? 0;
  }

  /// One-shot history for a conversation (ordered oldest→newest). The thread
  /// seeds from this on open — it's the durable, deduped source of truth, and
  /// includes messages that arrived in PAST sessions while the thread was closed.
  Future<List<MessageRow>> messagesFor(String convKey) =>
      (select(messages)
            ..where((t) => t.convKey.equals(convKey))
            ..orderBy([(t) => OrderingTerm(expression: t.createdAt)]))
          .get();

  /// Reactive history for a conversation (full reactive UI binds to this next).
  Stream<List<MessageRow>> watchMessages(String convKey) =>
      (select(messages)
            ..where((t) => t.convKey.equals(convKey))
            ..orderBy([(t) => OrderingTerm(expression: t.createdAt)]))
          .watch();
}

/// Per-account database file — a parent and each child on one phone keep
/// separate DBs (scoped by the Clerk account id, like the rest of local state).
LazyDatabase _open() => LazyDatabase(() async {
      final dir = await getApplicationSupportDirectory();
      final scope =
          (AccountScope.id == null || AccountScope.id!.isEmpty) ? 'default' : AccountScope.id!;
      return NativeDatabase(File('${dir.path}/avatok_$scope.sqlite'), logStatements: false);
    });

/// Singleton accessor. Rebuilds if the active account changes so each account
/// reads/writes its own file.
class Db {
  static String? _scope;
  static AppDb? _i;
  static AppDb get I {
    final s = AccountScope.id ?? 'default';
    if (_i == null || _scope != s) {
      _i?.close();
      _scope = s;
      _i = AppDb();
    }
    return _i!;
  }
}
