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

/// AvaWallet ledger cache (Phase 2) — local-first mirror of the server's
/// double-entry ledger so the wallet paints instantly on open. Per-account
/// scoping comes free: the whole DB file is per-account (avatok_<scope>.sqlite).
/// [json] is the full API entry payload; [createdAt]+[id] mirror the server's
/// keyset cursor so refreshes merge cheaply (INSERT OR REPLACE on id).
@DataClassName('WalletLedgerRow')
class WalletLedgerCache extends Table {
  TextColumn get id => text()(); // op_id (server wallet_ledger PK)
  IntColumn get createdAt => integer()();
  TextColumn get type => text().withDefault(const Constant(''))();
  TextColumn get json => text()();
  @override
  Set<Column> get primaryKey => {id};
}

/// Device address-book cache — the WhatsApp "Add contact" model. ONE row per
/// phone number read from the device, persisted per-account so the add-contact
/// sheet paints INSTANTLY (no re-reading the OS address book on every open) and
/// so "who's already on AvaTOK" survives restarts. [phoneNorm] is the E.164-ish
/// normalized number (matches the Worker's normalizePhone) and is the dedup key;
/// [rawPhone] is what we show. [uid] is non-empty ⇒ this contact is on AvaTOK —
/// then [handle]/[avatarUrl]/[matchDisplayName] carry their public profile so the
/// list can paint a badge + avatar with zero extra network calls. The background
/// sync (DeviceContactsService) rewrites this table after diffing the device book
/// and calling the match endpoint.
@DataClassName('DeviceContactRow')
class DeviceContactsCache extends Table {
  TextColumn get phoneNorm => text()(); // normalized E.164 — dedup/match key
  TextColumn get rawPhone => text().withDefault(const Constant(''))(); // display form
  TextColumn get name => text().withDefault(const Constant(''))(); // device display name
  TextColumn get uid => text().withDefault(const Constant(''))(); // non-empty ⇒ on AvaTOK
  TextColumn get handle => text().withDefault(const Constant(''))();
  TextColumn get avatarUrl => text().withDefault(const Constant(''))();
  TextColumn get matchDisplayName => text().withDefault(const Constant(''))(); // profile name
  TextColumn get email => text().withDefault(const Constant(''))(); // first email from the device book (invite-by-email)
  // 1 ⇒ this number is (likely) a WhatsApp contact. Detected from Android contact
  // accounts (`com.whatsapp`); on iOS we can't detect, so it's set to 1 (show it).
  IntColumn get hasWhatsapp => integer().withDefault(const Constant(0))();
  IntColumn get matchedAt => integer().withDefault(const Constant(0))(); // epoch ms of last match
  IntColumn get updatedAt => integer().withDefault(const Constant(0))(); // epoch ms last seen on device
  @override
  Set<Column> get primaryKey => {phoneNorm};
}

/// One "we sent an invite to this number via this channel" record (AvaInvite).
/// Lives in the per-account DB so the Invite screen can show a persistent "Sent"
/// tag next to each contact's WhatsApp / SMS / Email button across app restarts.
@DataClassName('InviteSend')
class InviteSends extends Table {
  TextColumn get phoneNorm => text()();
  TextColumn get channel => text()(); // 'whatsapp' | 'sms' | 'email'
  IntColumn get sentAt => integer().withDefault(const Constant(0))(); // epoch ms
  @override
  Set<Column> get primaryKey => {phoneNorm, channel};
}

@DriftDatabase(tables: [Messages, Contacts, Chats, WalletLedgerCache, DeviceContactsCache, InviteSends])
class AppDb extends _$AppDb {
  AppDb() : super(_open());

  @override
  int get schemaVersion => 5;

  // v2: Chats gained [json]. v3: WalletLedgerCache (Phase 2 wallet). v4:
  // DeviceContactsCache (instant add-contact + on-AvaTOK match). v5: contact
  // email + hasWhatsapp columns and the InviteSends table (AvaInvite screen).
  // All added in-place so an existing on-device DB upgrades without wiping data.
  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          if (from < 2) {
            await m.addColumn(chats, chats.json);
          }
          if (from < 3) {
            await m.createTable(walletLedgerCache);
          }
          if (from < 4) {
            await m.createTable(deviceContactsCache);
          }
          if (from < 5) {
            await m.addColumn(deviceContactsCache, deviceContactsCache.email);
            await m.addColumn(deviceContactsCache, deviceContactsCache.hasWhatsapp);
            await m.createTable(inviteSends);
          }
        },
      );

  // ── invite-sends (AvaInvite "Sent" state, per-account) ──
  /// Reactive set of every invite we've sent — the Invite screen watches this so
  /// a freshly-sent channel flips to "Sent" instantly and stays sent on reopen.
  Stream<List<InviteSend>> watchInviteSends() => select(inviteSends).watch();

  Future<List<InviteSend>> inviteSendsOnce() => select(inviteSends).get();

  /// Record that we invited [phoneNorm] via [channel] (idempotent on the PK).
  Future<void> markInviteSent(String phoneNorm, String channel, {int? sentAt}) =>
      into(inviteSends).insert(
        InviteSendsCompanion.insert(
          phoneNorm: phoneNorm,
          channel: channel,
          sentAt: Value(sentAt ?? DateTime.now().millisecondsSinceEpoch),
        ),
        mode: InsertMode.insertOrReplace,
      );

  // ── device-contacts cache (instant add-contact + on-AvaTOK match) ──
  /// All cached device contacts. On-AvaTOK first, then alphabetical — so the
  /// add-contact sheet surfaces people you can message immediately.
  Future<List<DeviceContactRow>> deviceContactsOnce() => (select(deviceContactsCache)
        ..orderBy([
          (t) => OrderingTerm(expression: t.uid, mode: OrderingMode.desc), // non-empty uid sorts first
          (t) => OrderingTerm(expression: t.name),
        ]))
      .get();

  /// Reactive device contacts — the sheet binds to this so a background sync
  /// (new contacts, freshly-resolved AvaTOK members) repaints the list live.
  Stream<List<DeviceContactRow>> watchDeviceContacts() => (select(deviceContactsCache)
        ..orderBy([
          (t) => OrderingTerm(expression: t.uid, mode: OrderingMode.desc),
          (t) => OrderingTerm(expression: t.name),
        ]))
      .watch();

  /// Upsert device-book rows (INSERT OR REPLACE on phoneNorm). Preserves nothing
  /// the caller doesn't pass, so callers merge match state themselves.
  Future<void> upsertDeviceContacts(List<DeviceContactsCacheCompanion> rows) async {
    if (rows.isEmpty) return;
    await batch((b) => b.insertAll(deviceContactsCache, rows, mode: InsertMode.insertOrReplace));
  }

  /// Drop cached numbers no longer on the device (contact deleted on the phone).
  Future<void> pruneDeviceContacts(Set<String> keepPhoneNorms) async {
    if (keepPhoneNorms.isEmpty) {
      await delete(deviceContactsCache).go();
      return;
    }
    await (delete(deviceContactsCache)..where((t) => t.phoneNorm.isNotIn(keepPhoneNorms))).go();
  }

  /// Clear AvaTOK match state on every row (call before re-applying a fresh
  /// match result, so people who left the platform stop showing the badge).
  Future<void> clearDeviceMatches() => (update(deviceContactsCache)
        ..where((t) => t.uid.isNotValue('')))
      .write(const DeviceContactsCacheCompanion(
        uid: Value(''), handle: Value(''), avatarUrl: Value(''), matchDisplayName: Value('')));

  /// Apply one match: mark [phoneNorm] as on-AvaTOK with its public profile.
  Future<void> applyDeviceMatch(
      {required String phoneNorm, required String uid, String handle = '',
       String avatarUrl = '', String displayName = '', required int matchedAt}) =>
      (update(deviceContactsCache)..where((t) => t.phoneNorm.equals(phoneNorm))).write(
        DeviceContactsCacheCompanion(
          uid: Value(uid), handle: Value(handle), avatarUrl: Value(avatarUrl),
          matchDisplayName: Value(displayName), matchedAt: Value(matchedAt)));

  // ── wallet ledger cache (Phase 2) ──
  /// Newest-first page of cached ledger entries (instant paint on open).
  Future<List<WalletLedgerRow>> walletLedgerOnce({int limit = 100}) => (select(walletLedgerCache)
        ..orderBy([(t) => OrderingTerm(expression: t.createdAt, mode: OrderingMode.desc)])
        ..limit(limit))
      .get();

  /// Merge a server page in (INSERT OR REPLACE on the op_id PK).
  Future<void> upsertWalletLedger(List<({String id, int createdAt, String type, String json})> rows) async {
    if (rows.isEmpty) return;
    await batch((b) => b.insertAll(
          walletLedgerCache,
          [
            for (final r in rows)
              WalletLedgerCacheCompanion.insert(
                  id: r.id, createdAt: r.createdAt, type: Value(r.type), json: r.json),
          ],
          mode: InsertMode.insertOrReplace,
        ));
  }

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

  // ── writes (used now by SyncHub; reactive reads land in Phase 3) ──
  /// Store a message; re-streamed duplicates are silently ignored.
  Future<void> upsertMessage(MessagesCompanion m) =>
      into(messages).insert(m, mode: InsertMode.insertOrIgnore);

  /// Move every message from one conversation key to another (used when an
  /// unknown-number receptionist thread `g:recept_…__tel:<phone>` is promoted to
  /// a real DM `1:<uid>` after the caller is discovered on AvaTOK, so the
  /// voicemail history follows the caller into their proper thread). Returns the
  /// number of rows moved.
  Future<int> rekeyConversation(String from, String to) {
    if (from == to) return Future.value(0);
    return (update(messages)..where((t) => t.convKey.equals(from)))
        .write(MessagesCompanion(convKey: Value(to)));
  }

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

  /// GLOBAL message search across ALL of my conversations (on-device, private,
  /// works for free users too). Matches the stored payload (text/caption); the
  /// caller extracts the human text + skips control/hidden/deleted envelopes.
  /// Newest first. Powers "search across all messenger chats".
  Future<List<MessageRow>> searchMessages(String query, {int limit = 60}) {
    final q = query.trim().replaceAll('%', '').replaceAll('_', '');
    if (q.length < 2) return Future.value(const <MessageRow>[]);
    return (select(messages)
          ..where((t) => t.payload.like('%$q%'))
          ..orderBy([(t) => OrderingTerm(expression: t.createdAt, mode: OrderingMode.desc)])
          ..limit(limit))
        .get();
  }

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
