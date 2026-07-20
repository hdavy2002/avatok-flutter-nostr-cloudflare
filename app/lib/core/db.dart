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
  /// [ISSUE-BADGE-UNREAD-1] The envelope's `t` discriminator, denormalised out of
  /// [payload] at write time so "is this a real MESSAGE?" is an indexed-ish SQL
  /// predicate instead of a JSON decode per row.
  ///
  /// WHY THIS EXISTS: [Messages] is NOT a message table — SyncHub stores every
  /// non-`receipt` frame here, so `status` (story posts), `del`/`gdel`
  /// tombstones, reactions and any future control payload all land as rows with
  /// `mine = false`. The launcher badge counted them and a contact merely posting
  /// a status permanently bumped it with no row anywhere to clear — exactly the
  /// "stuck on 1 with an empty inbox" symptom. [kCountableKinds] is now the ONE
  /// definition of countable, matching `ChatListScreen`'s in-memory `_unread`.
  ///
  /// NULLABLE on purpose: rows written before schema v7 have no kind, and the
  /// v7 migration backfills them best-effort from [payload]. Anything still NULL
  /// is treated as NOT countable — the badge may under-count ancient rows, but it
  /// can never get stuck above zero, which is the failure that matters.
  TextColumn get kind => text().nullable()();
  /// [AVAGRP-DBPUB-1] The sender's stable uid, mirroring `GroupMessage.senderPub`
  /// / `_Msg.senderPub` (`chat_thread.dart`). Group bubbles resolve their avatar
  /// and per-member tint from this key (`resolveBubbleTheme`,
  /// `_memberAvatars[senderPub]`) — before this column existed the DB-replay
  /// path (`messagesFor`) had nowhere to read it from and always constructed
  /// `senderPub: ''`, so a cold open with no JSON disk cache (evicted, fresh
  /// install, cache write raced the DB read) silently regressed every history
  /// row back to the "?" placeholder / no per-sender colour bug this fixed.
  /// The disk cache (`_persistNow`/`fromJson`) is still consulted FIRST and
  /// still wins the `_seenEv` dedup race when present (`_setupGroup`) — this
  /// column is the second line of defence for when it isn't.
  ///
  /// NULLABLE, and left NULL/`''` on migration for pre-existing rows: there is
  /// no way to recover a historical sender after the fact, and an empty value
  /// degrades exactly like today (`resolveBubbleTheme`/`_bubbleAvatar` already
  /// treat empty/null as "unknown sender" and fall back safely) — never a crash.
  /// For 1:1 DMs the column is unused (the peer is already the whole `convKey`).
  TextColumn get senderPub => text().nullable()();
  @override
  Set<Column> get primaryKey => {rumorId};
}

/// Saved contacts.
@DataClassName('ContactRow')
class Contacts extends Table {
  TextColumn get uid => text()();
  TextColumn get name => text().withDefault(const Constant(''))();
  TextColumn get handle => text().withDefault(const Constant(''))();
  TextColumn get email => text().withDefault(const Constant(''))();
  TextColumn get avatarUrl => text().withDefault(const Constant(''))();
  @override
  Set<Column> get primaryKey => {uid};
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
  TextColumn get company => text().withDefault(const Constant(''))(); // first organisation/company from the device book (search-by-company)
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
  int get schemaVersion => 9;

  // v2: Chats gained [json]. v3: WalletLedgerCache (Phase 2 wallet). v4:
  // DeviceContactsCache (instant add-contact + on-AvaTOK match). v5: contact
  // email + hasWhatsapp columns and the InviteSends table (AvaInvite screen).
  // v6: the npub → uid column rename. v7: Messages gained [kind] (the badge's
  // countable-frame filter). v8: Messages gained [senderPub] (group bubble
  // avatar/tint survives a cold open with no JSON disk cache — AVAGRP-DBPUB-1).
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
          if (from < 6) {
            // npub → uid rename (Nostr removal). Renamed in place so existing
            // on-device contact rows are preserved across the update.
            // GUARDED (PERF-5): on devices whose tables were already created
            // with `uid`, the blind rename threw `no such column: "npub"` on
            // EVERY open — the version bump rolled back and the migration
            // re-fired forever. Check PRAGMA table_info first, and never let a
            // legacy rename brick the DB open.
            Future<void> renameIfExists(
                TableInfo table, String from_, GeneratedColumn to) async {
              try {
                final cols = await customSelect(
                        'PRAGMA table_info(${table.actualTableName})')
                    .get();
                final hasOld =
                    cols.any((r) => r.read<String>('name') == from_);
                if (hasOld) await m.renameColumn(table, from_, to);
              } catch (_) {/* never let a legacy rename brick the DB open */}
            }
            await renameIfExists(contacts, 'npub', contacts.uid);
            await renameIfExists(deviceContactsCache, 'npub', deviceContactsCache.uid);
          }
          if (from < 7) {
            // [ISSUE-BADGE-UNREAD-1] Messages.kind — the badge's countable-frame
            // filter. Added nullable so existing rows upgrade in place.
            await m.addColumn(messages, messages.kind);
            // Best-effort backfill so a phone that already HAS unread history
            // keeps a truthful badge after the update instead of dropping to 0
            // until the next inbound message. [payload] is jsonEncode output, so
            // the discriminator is the literal substring `"t":"<kind>"` — no
            // whitespace, position-independent, and no JSON1 dependency. Guarded:
            // a failed backfill must never brick the DB open (the column itself
            // is already there, and NULL simply means "not counted").
            try {
              for (final k in kCountableKinds) {
                await customUpdate(
                  'UPDATE messages SET kind = ? WHERE kind IS NULL AND payload LIKE ?',
                  variables: [Variable.withString(k), Variable.withString('%"t":"$k"%')],
                  updates: {messages},
                );
              }
            } catch (_) {/* NULL kind just means "not counted" — never fatal */}
          }
          if (from < 8) {
            // [AVAGRP-DBPUB-1] Messages.senderPub — added nullable, so existing
            // rows upgrade in place with NULL (degrades to the "unknown sender"
            // fallback the UI already handles; there is no historical sender to
            // backfill from [payload], unlike v7's [kind]).
            await m.addColumn(messages, messages.senderPub);
          }
          if (from < 9) {
            // [AVADIAL-CONTACTS-MERGE] DeviceContactsCache.company — the contact's
            // organisation, so the Contacts search can match by company name.
            // Added with a '' default so existing rows upgrade in place; the next
            // background contacts sync backfills it from the device book.
            await m.addColumn(deviceContactsCache, deviceContactsCache.company);
          }
        },
      );

  /// [ISSUE-BADGE-UNREAD-1] THE definition of "an unread thing", and the ONLY
  /// one. It must stay byte-for-byte in step with `ChatListScreen`'s inbound
  /// handler (`chat_list.dart`), which bumps its in-memory `_unread` for exactly
  /// these `t` values — `recept` (AI receptionist took a message),
  /// `marketplace_deal` (agent negotiation result) and the four real message
  /// frames. Everything else SyncHub persists here (`status`, `del`/`gdel`,
  /// reactions, future control payloads) is NOT a message the user can go and
  /// read, so counting it produces a badge with no row to clear it.
  ///
  /// If you add a countable frame to the chat list, add it here in the same
  /// commit — a mismatch is invisible until the owner's badge sticks again.
  static const List<String> kCountableKinds = <String>[
    'text', 'media', 'gtext', 'gmedia', 'recept', 'marketplace_deal',
  ];

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

  /// All saved in-network (AvaTOK) contacts — one query. Used by the Ask Ava
  /// assistant's `search_contacts` fallback lane (when the AvaDial device-book
  /// reader is off, plan §4.6). Read-only; the assistant filters the small result
  /// in Dart and only sends the matching rows into the model context.
  Future<List<ContactRow>> contactsOnce() => (select(contacts)
        ..orderBy([(t) => OrderingTerm(expression: t.name)]))
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

  /// [AVAGRP-SENDERPUB-BACKFILL-1] Repair the [Messages.senderPub] of ONE
  /// already-stored row. This exists because [upsertMessage] is
  /// `insertOrIgnore` — re-ingesting a message the DB already holds (which is
  /// exactly what a re-sync does) silently keeps the OLD row, so a row written
  /// by a build from before the v8 column existed can never learn its sender
  /// through the normal ingest path. Rows from those builds read back NULL and
  /// render as the "unknown sender" fallback (no photo, no per-member tint, the
  /// literal 'P' initial from `_bubbleAvatar`'s 'peer' fallback) forever.
  ///
  /// The WHERE clause makes this IDEMPOTENT and NON-DESTRUCTIVE: it only ever
  /// fills a NULL/empty value, so a row that already knows its sender is never
  /// overwritten (a repair racing the live ingest path cannot corrupt a good
  /// value), and re-running the backfill is a no-op. Returns the number of rows
  /// actually changed, so the caller can report a truthful `recovered` count.
  ///
  /// No schema change: [Messages.senderPub] already exists (v8, AVAGRP-DBPUB-1).
  /// This is a plain UPDATE, so there is no migration to run.
  Future<int> setSenderPub(String rumorId, String senderPub) =>
      (update(messages)
            ..where((t) =>
                t.rumorId.equals(rumorId) &
                (t.senderPub.isNull() | t.senderPub.equals(''))))
          .write(MessagesCompanion(senderPub: Value(senderPub)));

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

  /// [ISSUE-THREAD-RESTORE-1] (2026-07-09) Distinct 1:1 conversation keys in the
  /// message store with their latest message time. After a reinstall the sync
  /// hub replays the full message backlog into [messages], but the chat LIST
  /// renders from the contacts/groups stores — so conversations whose peer
  /// wasn't in the (much smaller) contacts vault stayed invisible even though
  /// their history was fully restored. The chat list uses this to resurrect
  /// those threads.
  Future<List<({String convKey, int lastTs})>> distinctDmConvs() async {
    final maxTs = messages.createdAt.max();
    final q = selectOnly(messages)
      ..addColumns([messages.convKey, maxTs])
      ..where(messages.convKey.like('1:%'))
      ..groupBy([messages.convKey]);
    final rows = await q.get();
    return [
      for (final r in rows)
        (convKey: r.read(messages.convKey) ?? '', lastTs: r.read(maxTs) ?? 0),
    ];
  }

  /// [ISSUE-BADGE-UNREAD-1] Unread count per conversation, for EVERY thread that
  /// has any, in ONE query. This lets [BadgeService] total the unread across all
  /// threads WITHOUT [ChatListScreen] being mounted — the chat list's in-memory
  /// `_unread` map only exists while that widget lives, which is exactly why the
  /// launcher badge used to get stuck when ShellV2 landed on AvaDial instead.
  ///
  /// Unread = rows that are NOT [Messages.mine], whose [Messages.kind] is in
  /// [kCountableKinds], and whose [Messages.createdAt] is newer than that
  /// conversation's read high-water mark. Both [readMarks] (a [ReadStateStore]
  /// map) and [Messages.createdAt] are epoch SECONDS — see
  /// `ChatThreadScreen._markRead`, which writes `now ~/ 1000` — so they compare
  /// directly with no conversion.
  ///
  /// The per-conversation threshold is inlined as a `CASE conv_key WHEN … THEN …`
  /// so this stays ONE round-trip. It replaced a `distinctConvKeys()` + one COUNT
  /// per conversation N+1 that ran on every resume / cold start / thread close /
  /// SMS arrival. Conversations with no read mark fall to `ELSE 0` (everything
  /// inbound is unread), which is the same default the old `lastRead[k] ?? 0` had.
  /// Only conversations with a non-zero count appear in the result.
  Future<Map<String, int>> unreadByConv(Map<String, int> readMarks) async {
    final vars = <Variable>[
      for (final k in kCountableKinds) Variable.withString(k),
    ];
    final kindPlaceholders = List<String>.filled(kCountableKinds.length, '?').join(', ');
    // Order matters: these variables bind AFTER the kind list, matching the SQL.
    final threshold = StringBuffer();
    if (readMarks.isEmpty) {
      threshold.write('0');
    } else {
      threshold.write('CASE conv_key');
      for (final e in readMarks.entries) {
        threshold.write(' WHEN ? THEN ?');
        vars.add(Variable.withString(e.key));
        vars.add(Variable.withInt(e.value));
      }
      threshold.write(' ELSE 0 END');
    }
    final rows = await customSelect(
      'SELECT conv_key AS ck, COUNT(*) AS c FROM messages '
      'WHERE mine = 0 AND kind IN ($kindPlaceholders) '
      'AND created_at > $threshold '
      'GROUP BY conv_key',
      variables: vars,
      readsFrom: {messages},
    ).get();
    return {
      for (final r in rows)
        if (r.read<String>('ck').isNotEmpty && (r.read<int>('c')) > 0)
          r.read<String>('ck'): r.read<int>('c'),
    };
  }

  /// [ISSUE-BADGE-UNREAD-1] Newest message timestamp (epoch SECONDS) per
  /// conversation, including my own sends — the same "last activity" the chat
  /// list's preview row carries. [BadgeService] needs it to apply the
  /// hidden-thread rule: a hide is undone by any NEWER message, so a hidden
  /// thread only stops counting while its newest message predates the hide.
  Future<Map<String, int>> lastTsByConv() async {
    final maxTs = messages.createdAt.max();
    final q = selectOnly(messages)
      ..addColumns([messages.convKey, maxTs])
      ..groupBy([messages.convKey]);
    final rows = await q.get();
    return {
      for (final r in rows)
        if ((r.read(messages.convKey) ?? '').isNotEmpty)
          r.read(messages.convKey)!: r.read(maxTs) ?? 0,
    };
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

  /// Close the open handle so the NEXT [I] access reopens the file fresh.
  /// Used by backup restore: the SQLite file is about to be REPLACED on disk,
  /// and writing under an open drift connection risks the old handle flushing
  /// stale pages over the restored bytes. Await this BEFORE overwriting.
  static Future<void> reset() async {
    final db = _i;
    _i = null;
    _scope = null;
    if (db != null) {
      try { await db.close(); } catch (_) {/* already closed */}
    }
  }
}
