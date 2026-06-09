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
class Contacts extends Table {
  TextColumn get npub => text()();
  TextColumn get name => text().withDefault(const Constant(''))();
  TextColumn get handle => text().withDefault(const Constant(''))();
  TextColumn get email => text().withDefault(const Constant(''))();
  TextColumn get avatarUrl => text().withDefault(const Constant(''))();
  @override
  Set<Column> get primaryKey => {npub};
}

/// Per-conversation preview line + ordering + unread count (drives the list).
class Chats extends Table {
  TextColumn get convKey => text()();
  TextColumn get preview => text().withDefault(const Constant(''))();
  IntColumn get ts => integer().withDefault(const Constant(0))();
  BoolColumn get lastMine => boolean().withDefault(const Constant(false))();
  IntColumn get unread => integer().withDefault(const Constant(0))();
  @override
  Set<Column> get primaryKey => {convKey};
}

@DriftDatabase(tables: [Messages, Contacts, Chats])
class AppDb extends _$AppDb {
  AppDb() : super(_open());

  @override
  int get schemaVersion => 1;

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

  /// Reactive history for a conversation (Phase 3 binds the thread to this).
  Stream<List<Message>> watchMessages(String convKey) =>
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
