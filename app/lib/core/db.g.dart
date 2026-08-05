// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'db.dart';

// ignore_for_file: type=lint
class $MessagesTable extends Messages
    with TableInfo<$MessagesTable, MessageRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MessagesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _rumorIdMeta =
      const VerificationMeta('rumorId');
  @override
  late final GeneratedColumn<String> rumorId = GeneratedColumn<String>(
      'rumor_id', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _convKeyMeta =
      const VerificationMeta('convKey');
  @override
  late final GeneratedColumn<String> convKey = GeneratedColumn<String>(
      'conv_key', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _mineMeta = const VerificationMeta('mine');
  @override
  late final GeneratedColumn<bool> mine = GeneratedColumn<bool>(
      'mine', aliasedName, false,
      type: DriftSqlType.bool,
      requiredDuringInsert: true,
      defaultConstraints:
          GeneratedColumn.constraintIsAlways('CHECK ("mine" IN (0, 1))'));
  static const VerificationMeta _payloadMeta =
      const VerificationMeta('payload');
  @override
  late final GeneratedColumn<String> payload = GeneratedColumn<String>(
      'payload', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _createdAtMeta =
      const VerificationMeta('createdAt');
  @override
  late final GeneratedColumn<int> createdAt = GeneratedColumn<int>(
      'created_at', aliasedName, false,
      type: DriftSqlType.int, requiredDuringInsert: true);
  static const VerificationMeta _kindMeta = const VerificationMeta('kind');
  @override
  late final GeneratedColumn<String> kind = GeneratedColumn<String>(
      'kind', aliasedName, true,
      type: DriftSqlType.string, requiredDuringInsert: false);
  static const VerificationMeta _senderPubMeta =
      const VerificationMeta('senderPub');
  @override
  late final GeneratedColumn<String> senderPub = GeneratedColumn<String>(
      'sender_pub', aliasedName, true,
      type: DriftSqlType.string, requiredDuringInsert: false);
  @override
  List<GeneratedColumn> get $columns =>
      [rumorId, convKey, mine, payload, createdAt, kind, senderPub];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'messages';
  @override
  VerificationContext validateIntegrity(Insertable<MessageRow> instance,
      {bool isInserting = false}) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('rumor_id')) {
      context.handle(_rumorIdMeta,
          rumorId.isAcceptableOrUnknown(data['rumor_id']!, _rumorIdMeta));
    } else if (isInserting) {
      context.missing(_rumorIdMeta);
    }
    if (data.containsKey('conv_key')) {
      context.handle(_convKeyMeta,
          convKey.isAcceptableOrUnknown(data['conv_key']!, _convKeyMeta));
    } else if (isInserting) {
      context.missing(_convKeyMeta);
    }
    if (data.containsKey('mine')) {
      context.handle(
          _mineMeta, mine.isAcceptableOrUnknown(data['mine']!, _mineMeta));
    } else if (isInserting) {
      context.missing(_mineMeta);
    }
    if (data.containsKey('payload')) {
      context.handle(_payloadMeta,
          payload.isAcceptableOrUnknown(data['payload']!, _payloadMeta));
    } else if (isInserting) {
      context.missing(_payloadMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(_createdAtMeta,
          createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta));
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('kind')) {
      context.handle(
          _kindMeta, kind.isAcceptableOrUnknown(data['kind']!, _kindMeta));
    }
    if (data.containsKey('sender_pub')) {
      context.handle(_senderPubMeta,
          senderPub.isAcceptableOrUnknown(data['sender_pub']!, _senderPubMeta));
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {rumorId};
  @override
  MessageRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return MessageRow(
      rumorId: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}rumor_id'])!,
      convKey: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}conv_key'])!,
      mine: attachedDatabase.typeMapping
          .read(DriftSqlType.bool, data['${effectivePrefix}mine'])!,
      payload: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}payload'])!,
      createdAt: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}created_at'])!,
      kind: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}kind']),
      senderPub: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}sender_pub']),
    );
  }

  @override
  $MessagesTable createAlias(String alias) {
    return $MessagesTable(attachedDatabase, alias);
  }
}

class MessageRow extends DataClass implements Insertable<MessageRow> {
  final String rumorId;
  final String convKey;
  final bool mine;
  final String payload;
  final int createdAt;

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
  final String? kind;

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
  final String? senderPub;
  const MessageRow(
      {required this.rumorId,
      required this.convKey,
      required this.mine,
      required this.payload,
      required this.createdAt,
      this.kind,
      this.senderPub});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['rumor_id'] = Variable<String>(rumorId);
    map['conv_key'] = Variable<String>(convKey);
    map['mine'] = Variable<bool>(mine);
    map['payload'] = Variable<String>(payload);
    map['created_at'] = Variable<int>(createdAt);
    if (!nullToAbsent || kind != null) {
      map['kind'] = Variable<String>(kind);
    }
    if (!nullToAbsent || senderPub != null) {
      map['sender_pub'] = Variable<String>(senderPub);
    }
    return map;
  }

  MessagesCompanion toCompanion(bool nullToAbsent) {
    return MessagesCompanion(
      rumorId: Value(rumorId),
      convKey: Value(convKey),
      mine: Value(mine),
      payload: Value(payload),
      createdAt: Value(createdAt),
      kind: kind == null && nullToAbsent ? const Value.absent() : Value(kind),
      senderPub: senderPub == null && nullToAbsent
          ? const Value.absent()
          : Value(senderPub),
    );
  }

  factory MessageRow.fromJson(Map<String, dynamic> json,
      {ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return MessageRow(
      rumorId: serializer.fromJson<String>(json['rumorId']),
      convKey: serializer.fromJson<String>(json['convKey']),
      mine: serializer.fromJson<bool>(json['mine']),
      payload: serializer.fromJson<String>(json['payload']),
      createdAt: serializer.fromJson<int>(json['createdAt']),
      kind: serializer.fromJson<String?>(json['kind']),
      senderPub: serializer.fromJson<String?>(json['senderPub']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'rumorId': serializer.toJson<String>(rumorId),
      'convKey': serializer.toJson<String>(convKey),
      'mine': serializer.toJson<bool>(mine),
      'payload': serializer.toJson<String>(payload),
      'createdAt': serializer.toJson<int>(createdAt),
      'kind': serializer.toJson<String?>(kind),
      'senderPub': serializer.toJson<String?>(senderPub),
    };
  }

  MessageRow copyWith(
          {String? rumorId,
          String? convKey,
          bool? mine,
          String? payload,
          int? createdAt,
          Value<String?> kind = const Value.absent(),
          Value<String?> senderPub = const Value.absent()}) =>
      MessageRow(
        rumorId: rumorId ?? this.rumorId,
        convKey: convKey ?? this.convKey,
        mine: mine ?? this.mine,
        payload: payload ?? this.payload,
        createdAt: createdAt ?? this.createdAt,
        kind: kind.present ? kind.value : this.kind,
        senderPub: senderPub.present ? senderPub.value : this.senderPub,
      );
  MessageRow copyWithCompanion(MessagesCompanion data) {
    return MessageRow(
      rumorId: data.rumorId.present ? data.rumorId.value : this.rumorId,
      convKey: data.convKey.present ? data.convKey.value : this.convKey,
      mine: data.mine.present ? data.mine.value : this.mine,
      payload: data.payload.present ? data.payload.value : this.payload,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      kind: data.kind.present ? data.kind.value : this.kind,
      senderPub: data.senderPub.present ? data.senderPub.value : this.senderPub,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MessageRow(')
          ..write('rumorId: $rumorId, ')
          ..write('convKey: $convKey, ')
          ..write('mine: $mine, ')
          ..write('payload: $payload, ')
          ..write('createdAt: $createdAt, ')
          ..write('kind: $kind, ')
          ..write('senderPub: $senderPub')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(rumorId, convKey, mine, payload, createdAt, kind, senderPub);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MessageRow &&
          other.rumorId == this.rumorId &&
          other.convKey == this.convKey &&
          other.mine == this.mine &&
          other.payload == this.payload &&
          other.createdAt == this.createdAt &&
          other.kind == this.kind &&
          other.senderPub == this.senderPub);
}

class MessagesCompanion extends UpdateCompanion<MessageRow> {
  final Value<String> rumorId;
  final Value<String> convKey;
  final Value<bool> mine;
  final Value<String> payload;
  final Value<int> createdAt;
  final Value<String?> kind;
  final Value<String?> senderPub;
  final Value<int> rowid;
  const MessagesCompanion({
    this.rumorId = const Value.absent(),
    this.convKey = const Value.absent(),
    this.mine = const Value.absent(),
    this.payload = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.kind = const Value.absent(),
    this.senderPub = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  MessagesCompanion.insert({
    required String rumorId,
    required String convKey,
    required bool mine,
    required String payload,
    required int createdAt,
    this.kind = const Value.absent(),
    this.senderPub = const Value.absent(),
    this.rowid = const Value.absent(),
  })  : rumorId = Value(rumorId),
        convKey = Value(convKey),
        mine = Value(mine),
        payload = Value(payload),
        createdAt = Value(createdAt);
  static Insertable<MessageRow> custom({
    Expression<String>? rumorId,
    Expression<String>? convKey,
    Expression<bool>? mine,
    Expression<String>? payload,
    Expression<int>? createdAt,
    Expression<String>? kind,
    Expression<String>? senderPub,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (rumorId != null) 'rumor_id': rumorId,
      if (convKey != null) 'conv_key': convKey,
      if (mine != null) 'mine': mine,
      if (payload != null) 'payload': payload,
      if (createdAt != null) 'created_at': createdAt,
      if (kind != null) 'kind': kind,
      if (senderPub != null) 'sender_pub': senderPub,
      if (rowid != null) 'rowid': rowid,
    });
  }

  MessagesCompanion copyWith(
      {Value<String>? rumorId,
      Value<String>? convKey,
      Value<bool>? mine,
      Value<String>? payload,
      Value<int>? createdAt,
      Value<String?>? kind,
      Value<String?>? senderPub,
      Value<int>? rowid}) {
    return MessagesCompanion(
      rumorId: rumorId ?? this.rumorId,
      convKey: convKey ?? this.convKey,
      mine: mine ?? this.mine,
      payload: payload ?? this.payload,
      createdAt: createdAt ?? this.createdAt,
      kind: kind ?? this.kind,
      senderPub: senderPub ?? this.senderPub,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (rumorId.present) {
      map['rumor_id'] = Variable<String>(rumorId.value);
    }
    if (convKey.present) {
      map['conv_key'] = Variable<String>(convKey.value);
    }
    if (mine.present) {
      map['mine'] = Variable<bool>(mine.value);
    }
    if (payload.present) {
      map['payload'] = Variable<String>(payload.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<int>(createdAt.value);
    }
    if (kind.present) {
      map['kind'] = Variable<String>(kind.value);
    }
    if (senderPub.present) {
      map['sender_pub'] = Variable<String>(senderPub.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MessagesCompanion(')
          ..write('rumorId: $rumorId, ')
          ..write('convKey: $convKey, ')
          ..write('mine: $mine, ')
          ..write('payload: $payload, ')
          ..write('createdAt: $createdAt, ')
          ..write('kind: $kind, ')
          ..write('senderPub: $senderPub, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ContactsTable extends Contacts
    with TableInfo<$ContactsTable, ContactRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ContactsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _uidMeta = const VerificationMeta('uid');
  @override
  late final GeneratedColumn<String> uid = GeneratedColumn<String>(
      'uid', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
      'name', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _handleMeta = const VerificationMeta('handle');
  @override
  late final GeneratedColumn<String> handle = GeneratedColumn<String>(
      'handle', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _emailMeta = const VerificationMeta('email');
  @override
  late final GeneratedColumn<String> email = GeneratedColumn<String>(
      'email', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _avatarUrlMeta =
      const VerificationMeta('avatarUrl');
  @override
  late final GeneratedColumn<String> avatarUrl = GeneratedColumn<String>(
      'avatar_url', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  @override
  List<GeneratedColumn> get $columns => [uid, name, handle, email, avatarUrl];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'contacts';
  @override
  VerificationContext validateIntegrity(Insertable<ContactRow> instance,
      {bool isInserting = false}) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('uid')) {
      context.handle(
          _uidMeta, uid.isAcceptableOrUnknown(data['uid']!, _uidMeta));
    } else if (isInserting) {
      context.missing(_uidMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
          _nameMeta, name.isAcceptableOrUnknown(data['name']!, _nameMeta));
    }
    if (data.containsKey('handle')) {
      context.handle(_handleMeta,
          handle.isAcceptableOrUnknown(data['handle']!, _handleMeta));
    }
    if (data.containsKey('email')) {
      context.handle(
          _emailMeta, email.isAcceptableOrUnknown(data['email']!, _emailMeta));
    }
    if (data.containsKey('avatar_url')) {
      context.handle(_avatarUrlMeta,
          avatarUrl.isAcceptableOrUnknown(data['avatar_url']!, _avatarUrlMeta));
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {uid};
  @override
  ContactRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ContactRow(
      uid: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}uid'])!,
      name: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}name'])!,
      handle: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}handle'])!,
      email: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}email'])!,
      avatarUrl: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}avatar_url'])!,
    );
  }

  @override
  $ContactsTable createAlias(String alias) {
    return $ContactsTable(attachedDatabase, alias);
  }
}

class ContactRow extends DataClass implements Insertable<ContactRow> {
  final String uid;
  final String name;
  final String handle;
  final String email;
  final String avatarUrl;
  const ContactRow(
      {required this.uid,
      required this.name,
      required this.handle,
      required this.email,
      required this.avatarUrl});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['uid'] = Variable<String>(uid);
    map['name'] = Variable<String>(name);
    map['handle'] = Variable<String>(handle);
    map['email'] = Variable<String>(email);
    map['avatar_url'] = Variable<String>(avatarUrl);
    return map;
  }

  ContactsCompanion toCompanion(bool nullToAbsent) {
    return ContactsCompanion(
      uid: Value(uid),
      name: Value(name),
      handle: Value(handle),
      email: Value(email),
      avatarUrl: Value(avatarUrl),
    );
  }

  factory ContactRow.fromJson(Map<String, dynamic> json,
      {ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ContactRow(
      uid: serializer.fromJson<String>(json['uid']),
      name: serializer.fromJson<String>(json['name']),
      handle: serializer.fromJson<String>(json['handle']),
      email: serializer.fromJson<String>(json['email']),
      avatarUrl: serializer.fromJson<String>(json['avatarUrl']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'uid': serializer.toJson<String>(uid),
      'name': serializer.toJson<String>(name),
      'handle': serializer.toJson<String>(handle),
      'email': serializer.toJson<String>(email),
      'avatarUrl': serializer.toJson<String>(avatarUrl),
    };
  }

  ContactRow copyWith(
          {String? uid,
          String? name,
          String? handle,
          String? email,
          String? avatarUrl}) =>
      ContactRow(
        uid: uid ?? this.uid,
        name: name ?? this.name,
        handle: handle ?? this.handle,
        email: email ?? this.email,
        avatarUrl: avatarUrl ?? this.avatarUrl,
      );
  ContactRow copyWithCompanion(ContactsCompanion data) {
    return ContactRow(
      uid: data.uid.present ? data.uid.value : this.uid,
      name: data.name.present ? data.name.value : this.name,
      handle: data.handle.present ? data.handle.value : this.handle,
      email: data.email.present ? data.email.value : this.email,
      avatarUrl: data.avatarUrl.present ? data.avatarUrl.value : this.avatarUrl,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ContactRow(')
          ..write('uid: $uid, ')
          ..write('name: $name, ')
          ..write('handle: $handle, ')
          ..write('email: $email, ')
          ..write('avatarUrl: $avatarUrl')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(uid, name, handle, email, avatarUrl);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ContactRow &&
          other.uid == this.uid &&
          other.name == this.name &&
          other.handle == this.handle &&
          other.email == this.email &&
          other.avatarUrl == this.avatarUrl);
}

class ContactsCompanion extends UpdateCompanion<ContactRow> {
  final Value<String> uid;
  final Value<String> name;
  final Value<String> handle;
  final Value<String> email;
  final Value<String> avatarUrl;
  final Value<int> rowid;
  const ContactsCompanion({
    this.uid = const Value.absent(),
    this.name = const Value.absent(),
    this.handle = const Value.absent(),
    this.email = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ContactsCompanion.insert({
    required String uid,
    this.name = const Value.absent(),
    this.handle = const Value.absent(),
    this.email = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : uid = Value(uid);
  static Insertable<ContactRow> custom({
    Expression<String>? uid,
    Expression<String>? name,
    Expression<String>? handle,
    Expression<String>? email,
    Expression<String>? avatarUrl,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (uid != null) 'uid': uid,
      if (name != null) 'name': name,
      if (handle != null) 'handle': handle,
      if (email != null) 'email': email,
      if (avatarUrl != null) 'avatar_url': avatarUrl,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ContactsCompanion copyWith(
      {Value<String>? uid,
      Value<String>? name,
      Value<String>? handle,
      Value<String>? email,
      Value<String>? avatarUrl,
      Value<int>? rowid}) {
    return ContactsCompanion(
      uid: uid ?? this.uid,
      name: name ?? this.name,
      handle: handle ?? this.handle,
      email: email ?? this.email,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (uid.present) {
      map['uid'] = Variable<String>(uid.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (handle.present) {
      map['handle'] = Variable<String>(handle.value);
    }
    if (email.present) {
      map['email'] = Variable<String>(email.value);
    }
    if (avatarUrl.present) {
      map['avatar_url'] = Variable<String>(avatarUrl.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ContactsCompanion(')
          ..write('uid: $uid, ')
          ..write('name: $name, ')
          ..write('handle: $handle, ')
          ..write('email: $email, ')
          ..write('avatarUrl: $avatarUrl, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ChatsTable extends Chats with TableInfo<$ChatsTable, ChatRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ChatsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _convKeyMeta =
      const VerificationMeta('convKey');
  @override
  late final GeneratedColumn<String> convKey = GeneratedColumn<String>(
      'conv_key', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _previewMeta =
      const VerificationMeta('preview');
  @override
  late final GeneratedColumn<String> preview = GeneratedColumn<String>(
      'preview', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _tsMeta = const VerificationMeta('ts');
  @override
  late final GeneratedColumn<int> ts = GeneratedColumn<int>(
      'ts', aliasedName, false,
      type: DriftSqlType.int,
      requiredDuringInsert: false,
      defaultValue: const Constant(0));
  static const VerificationMeta _lastMineMeta =
      const VerificationMeta('lastMine');
  @override
  late final GeneratedColumn<bool> lastMine = GeneratedColumn<bool>(
      'last_mine', aliasedName, false,
      type: DriftSqlType.bool,
      requiredDuringInsert: false,
      defaultConstraints:
          GeneratedColumn.constraintIsAlways('CHECK ("last_mine" IN (0, 1))'),
      defaultValue: const Constant(false));
  static const VerificationMeta _unreadMeta = const VerificationMeta('unread');
  @override
  late final GeneratedColumn<int> unread = GeneratedColumn<int>(
      'unread', aliasedName, false,
      type: DriftSqlType.int,
      requiredDuringInsert: false,
      defaultValue: const Constant(0));
  static const VerificationMeta _jsonMeta = const VerificationMeta('json');
  @override
  late final GeneratedColumn<String> json = GeneratedColumn<String>(
      'json', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  @override
  List<GeneratedColumn> get $columns =>
      [convKey, preview, ts, lastMine, unread, json];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'chats';
  @override
  VerificationContext validateIntegrity(Insertable<ChatRow> instance,
      {bool isInserting = false}) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('conv_key')) {
      context.handle(_convKeyMeta,
          convKey.isAcceptableOrUnknown(data['conv_key']!, _convKeyMeta));
    } else if (isInserting) {
      context.missing(_convKeyMeta);
    }
    if (data.containsKey('preview')) {
      context.handle(_previewMeta,
          preview.isAcceptableOrUnknown(data['preview']!, _previewMeta));
    }
    if (data.containsKey('ts')) {
      context.handle(_tsMeta, ts.isAcceptableOrUnknown(data['ts']!, _tsMeta));
    }
    if (data.containsKey('last_mine')) {
      context.handle(_lastMineMeta,
          lastMine.isAcceptableOrUnknown(data['last_mine']!, _lastMineMeta));
    }
    if (data.containsKey('unread')) {
      context.handle(_unreadMeta,
          unread.isAcceptableOrUnknown(data['unread']!, _unreadMeta));
    }
    if (data.containsKey('json')) {
      context.handle(
          _jsonMeta, json.isAcceptableOrUnknown(data['json']!, _jsonMeta));
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {convKey};
  @override
  ChatRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ChatRow(
      convKey: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}conv_key'])!,
      preview: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}preview'])!,
      ts: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}ts'])!,
      lastMine: attachedDatabase.typeMapping
          .read(DriftSqlType.bool, data['${effectivePrefix}last_mine'])!,
      unread: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}unread'])!,
      json: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}json'])!,
    );
  }

  @override
  $ChatsTable createAlias(String alias) {
    return $ChatsTable(attachedDatabase, alias);
  }
}

class ChatRow extends DataClass implements Insertable<ChatRow> {
  final String convKey;
  final String preview;
  final int ts;
  final bool lastMine;
  final int unread;
  final String json;
  const ChatRow(
      {required this.convKey,
      required this.preview,
      required this.ts,
      required this.lastMine,
      required this.unread,
      required this.json});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['conv_key'] = Variable<String>(convKey);
    map['preview'] = Variable<String>(preview);
    map['ts'] = Variable<int>(ts);
    map['last_mine'] = Variable<bool>(lastMine);
    map['unread'] = Variable<int>(unread);
    map['json'] = Variable<String>(json);
    return map;
  }

  ChatsCompanion toCompanion(bool nullToAbsent) {
    return ChatsCompanion(
      convKey: Value(convKey),
      preview: Value(preview),
      ts: Value(ts),
      lastMine: Value(lastMine),
      unread: Value(unread),
      json: Value(json),
    );
  }

  factory ChatRow.fromJson(Map<String, dynamic> json,
      {ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ChatRow(
      convKey: serializer.fromJson<String>(json['convKey']),
      preview: serializer.fromJson<String>(json['preview']),
      ts: serializer.fromJson<int>(json['ts']),
      lastMine: serializer.fromJson<bool>(json['lastMine']),
      unread: serializer.fromJson<int>(json['unread']),
      json: serializer.fromJson<String>(json['json']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'convKey': serializer.toJson<String>(convKey),
      'preview': serializer.toJson<String>(preview),
      'ts': serializer.toJson<int>(ts),
      'lastMine': serializer.toJson<bool>(lastMine),
      'unread': serializer.toJson<int>(unread),
      'json': serializer.toJson<String>(json),
    };
  }

  ChatRow copyWith(
          {String? convKey,
          String? preview,
          int? ts,
          bool? lastMine,
          int? unread,
          String? json}) =>
      ChatRow(
        convKey: convKey ?? this.convKey,
        preview: preview ?? this.preview,
        ts: ts ?? this.ts,
        lastMine: lastMine ?? this.lastMine,
        unread: unread ?? this.unread,
        json: json ?? this.json,
      );
  ChatRow copyWithCompanion(ChatsCompanion data) {
    return ChatRow(
      convKey: data.convKey.present ? data.convKey.value : this.convKey,
      preview: data.preview.present ? data.preview.value : this.preview,
      ts: data.ts.present ? data.ts.value : this.ts,
      lastMine: data.lastMine.present ? data.lastMine.value : this.lastMine,
      unread: data.unread.present ? data.unread.value : this.unread,
      json: data.json.present ? data.json.value : this.json,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ChatRow(')
          ..write('convKey: $convKey, ')
          ..write('preview: $preview, ')
          ..write('ts: $ts, ')
          ..write('lastMine: $lastMine, ')
          ..write('unread: $unread, ')
          ..write('json: $json')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(convKey, preview, ts, lastMine, unread, json);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ChatRow &&
          other.convKey == this.convKey &&
          other.preview == this.preview &&
          other.ts == this.ts &&
          other.lastMine == this.lastMine &&
          other.unread == this.unread &&
          other.json == this.json);
}

class ChatsCompanion extends UpdateCompanion<ChatRow> {
  final Value<String> convKey;
  final Value<String> preview;
  final Value<int> ts;
  final Value<bool> lastMine;
  final Value<int> unread;
  final Value<String> json;
  final Value<int> rowid;
  const ChatsCompanion({
    this.convKey = const Value.absent(),
    this.preview = const Value.absent(),
    this.ts = const Value.absent(),
    this.lastMine = const Value.absent(),
    this.unread = const Value.absent(),
    this.json = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ChatsCompanion.insert({
    required String convKey,
    this.preview = const Value.absent(),
    this.ts = const Value.absent(),
    this.lastMine = const Value.absent(),
    this.unread = const Value.absent(),
    this.json = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : convKey = Value(convKey);
  static Insertable<ChatRow> custom({
    Expression<String>? convKey,
    Expression<String>? preview,
    Expression<int>? ts,
    Expression<bool>? lastMine,
    Expression<int>? unread,
    Expression<String>? json,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (convKey != null) 'conv_key': convKey,
      if (preview != null) 'preview': preview,
      if (ts != null) 'ts': ts,
      if (lastMine != null) 'last_mine': lastMine,
      if (unread != null) 'unread': unread,
      if (json != null) 'json': json,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ChatsCompanion copyWith(
      {Value<String>? convKey,
      Value<String>? preview,
      Value<int>? ts,
      Value<bool>? lastMine,
      Value<int>? unread,
      Value<String>? json,
      Value<int>? rowid}) {
    return ChatsCompanion(
      convKey: convKey ?? this.convKey,
      preview: preview ?? this.preview,
      ts: ts ?? this.ts,
      lastMine: lastMine ?? this.lastMine,
      unread: unread ?? this.unread,
      json: json ?? this.json,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (convKey.present) {
      map['conv_key'] = Variable<String>(convKey.value);
    }
    if (preview.present) {
      map['preview'] = Variable<String>(preview.value);
    }
    if (ts.present) {
      map['ts'] = Variable<int>(ts.value);
    }
    if (lastMine.present) {
      map['last_mine'] = Variable<bool>(lastMine.value);
    }
    if (unread.present) {
      map['unread'] = Variable<int>(unread.value);
    }
    if (json.present) {
      map['json'] = Variable<String>(json.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ChatsCompanion(')
          ..write('convKey: $convKey, ')
          ..write('preview: $preview, ')
          ..write('ts: $ts, ')
          ..write('lastMine: $lastMine, ')
          ..write('unread: $unread, ')
          ..write('json: $json, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $WalletLedgerCacheTable extends WalletLedgerCache
    with TableInfo<$WalletLedgerCacheTable, WalletLedgerRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $WalletLedgerCacheTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
      'id', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _createdAtMeta =
      const VerificationMeta('createdAt');
  @override
  late final GeneratedColumn<int> createdAt = GeneratedColumn<int>(
      'created_at', aliasedName, false,
      type: DriftSqlType.int, requiredDuringInsert: true);
  static const VerificationMeta _typeMeta = const VerificationMeta('type');
  @override
  late final GeneratedColumn<String> type = GeneratedColumn<String>(
      'type', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _jsonMeta = const VerificationMeta('json');
  @override
  late final GeneratedColumn<String> json = GeneratedColumn<String>(
      'json', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  @override
  List<GeneratedColumn> get $columns => [id, createdAt, type, json];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'wallet_ledger_cache';
  @override
  VerificationContext validateIntegrity(Insertable<WalletLedgerRow> instance,
      {bool isInserting = false}) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(_createdAtMeta,
          createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta));
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('type')) {
      context.handle(
          _typeMeta, type.isAcceptableOrUnknown(data['type']!, _typeMeta));
    }
    if (data.containsKey('json')) {
      context.handle(
          _jsonMeta, json.isAcceptableOrUnknown(data['json']!, _jsonMeta));
    } else if (isInserting) {
      context.missing(_jsonMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  WalletLedgerRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return WalletLedgerRow(
      id: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}id'])!,
      createdAt: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}created_at'])!,
      type: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}type'])!,
      json: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}json'])!,
    );
  }

  @override
  $WalletLedgerCacheTable createAlias(String alias) {
    return $WalletLedgerCacheTable(attachedDatabase, alias);
  }
}

class WalletLedgerRow extends DataClass implements Insertable<WalletLedgerRow> {
  final String id;
  final int createdAt;
  final String type;
  final String json;
  const WalletLedgerRow(
      {required this.id,
      required this.createdAt,
      required this.type,
      required this.json});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['created_at'] = Variable<int>(createdAt);
    map['type'] = Variable<String>(type);
    map['json'] = Variable<String>(json);
    return map;
  }

  WalletLedgerCacheCompanion toCompanion(bool nullToAbsent) {
    return WalletLedgerCacheCompanion(
      id: Value(id),
      createdAt: Value(createdAt),
      type: Value(type),
      json: Value(json),
    );
  }

  factory WalletLedgerRow.fromJson(Map<String, dynamic> json,
      {ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return WalletLedgerRow(
      id: serializer.fromJson<String>(json['id']),
      createdAt: serializer.fromJson<int>(json['createdAt']),
      type: serializer.fromJson<String>(json['type']),
      json: serializer.fromJson<String>(json['json']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'createdAt': serializer.toJson<int>(createdAt),
      'type': serializer.toJson<String>(type),
      'json': serializer.toJson<String>(json),
    };
  }

  WalletLedgerRow copyWith(
          {String? id, int? createdAt, String? type, String? json}) =>
      WalletLedgerRow(
        id: id ?? this.id,
        createdAt: createdAt ?? this.createdAt,
        type: type ?? this.type,
        json: json ?? this.json,
      );
  WalletLedgerRow copyWithCompanion(WalletLedgerCacheCompanion data) {
    return WalletLedgerRow(
      id: data.id.present ? data.id.value : this.id,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      type: data.type.present ? data.type.value : this.type,
      json: data.json.present ? data.json.value : this.json,
    );
  }

  @override
  String toString() {
    return (StringBuffer('WalletLedgerRow(')
          ..write('id: $id, ')
          ..write('createdAt: $createdAt, ')
          ..write('type: $type, ')
          ..write('json: $json')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(id, createdAt, type, json);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is WalletLedgerRow &&
          other.id == this.id &&
          other.createdAt == this.createdAt &&
          other.type == this.type &&
          other.json == this.json);
}

class WalletLedgerCacheCompanion extends UpdateCompanion<WalletLedgerRow> {
  final Value<String> id;
  final Value<int> createdAt;
  final Value<String> type;
  final Value<String> json;
  final Value<int> rowid;
  const WalletLedgerCacheCompanion({
    this.id = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.type = const Value.absent(),
    this.json = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  WalletLedgerCacheCompanion.insert({
    required String id,
    required int createdAt,
    this.type = const Value.absent(),
    required String json,
    this.rowid = const Value.absent(),
  })  : id = Value(id),
        createdAt = Value(createdAt),
        json = Value(json);
  static Insertable<WalletLedgerRow> custom({
    Expression<String>? id,
    Expression<int>? createdAt,
    Expression<String>? type,
    Expression<String>? json,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (createdAt != null) 'created_at': createdAt,
      if (type != null) 'type': type,
      if (json != null) 'json': json,
      if (rowid != null) 'rowid': rowid,
    });
  }

  WalletLedgerCacheCompanion copyWith(
      {Value<String>? id,
      Value<int>? createdAt,
      Value<String>? type,
      Value<String>? json,
      Value<int>? rowid}) {
    return WalletLedgerCacheCompanion(
      id: id ?? this.id,
      createdAt: createdAt ?? this.createdAt,
      type: type ?? this.type,
      json: json ?? this.json,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<int>(createdAt.value);
    }
    if (type.present) {
      map['type'] = Variable<String>(type.value);
    }
    if (json.present) {
      map['json'] = Variable<String>(json.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('WalletLedgerCacheCompanion(')
          ..write('id: $id, ')
          ..write('createdAt: $createdAt, ')
          ..write('type: $type, ')
          ..write('json: $json, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $DeviceContactsCacheTable extends DeviceContactsCache
    with TableInfo<$DeviceContactsCacheTable, DeviceContactRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $DeviceContactsCacheTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _phoneNormMeta =
      const VerificationMeta('phoneNorm');
  @override
  late final GeneratedColumn<String> phoneNorm = GeneratedColumn<String>(
      'phone_norm', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _rawPhoneMeta =
      const VerificationMeta('rawPhone');
  @override
  late final GeneratedColumn<String> rawPhone = GeneratedColumn<String>(
      'raw_phone', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
      'name', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _uidMeta = const VerificationMeta('uid');
  @override
  late final GeneratedColumn<String> uid = GeneratedColumn<String>(
      'uid', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _handleMeta = const VerificationMeta('handle');
  @override
  late final GeneratedColumn<String> handle = GeneratedColumn<String>(
      'handle', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _avatarUrlMeta =
      const VerificationMeta('avatarUrl');
  @override
  late final GeneratedColumn<String> avatarUrl = GeneratedColumn<String>(
      'avatar_url', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _matchDisplayNameMeta =
      const VerificationMeta('matchDisplayName');
  @override
  late final GeneratedColumn<String> matchDisplayName = GeneratedColumn<String>(
      'match_display_name', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _emailMeta = const VerificationMeta('email');
  @override
  late final GeneratedColumn<String> email = GeneratedColumn<String>(
      'email', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _companyMeta =
      const VerificationMeta('company');
  @override
  late final GeneratedColumn<String> company = GeneratedColumn<String>(
      'company', aliasedName, false,
      type: DriftSqlType.string,
      requiredDuringInsert: false,
      defaultValue: const Constant(''));
  static const VerificationMeta _hasWhatsappMeta =
      const VerificationMeta('hasWhatsapp');
  @override
  late final GeneratedColumn<int> hasWhatsapp = GeneratedColumn<int>(
      'has_whatsapp', aliasedName, false,
      type: DriftSqlType.int,
      requiredDuringInsert: false,
      defaultValue: const Constant(0));
  static const VerificationMeta _matchedAtMeta =
      const VerificationMeta('matchedAt');
  @override
  late final GeneratedColumn<int> matchedAt = GeneratedColumn<int>(
      'matched_at', aliasedName, false,
      type: DriftSqlType.int,
      requiredDuringInsert: false,
      defaultValue: const Constant(0));
  static const VerificationMeta _updatedAtMeta =
      const VerificationMeta('updatedAt');
  @override
  late final GeneratedColumn<int> updatedAt = GeneratedColumn<int>(
      'updated_at', aliasedName, false,
      type: DriftSqlType.int,
      requiredDuringInsert: false,
      defaultValue: const Constant(0));
  @override
  List<GeneratedColumn> get $columns => [
        phoneNorm,
        rawPhone,
        name,
        uid,
        handle,
        avatarUrl,
        matchDisplayName,
        email,
        company,
        hasWhatsapp,
        matchedAt,
        updatedAt
      ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'device_contacts_cache';
  @override
  VerificationContext validateIntegrity(Insertable<DeviceContactRow> instance,
      {bool isInserting = false}) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('phone_norm')) {
      context.handle(_phoneNormMeta,
          phoneNorm.isAcceptableOrUnknown(data['phone_norm']!, _phoneNormMeta));
    } else if (isInserting) {
      context.missing(_phoneNormMeta);
    }
    if (data.containsKey('raw_phone')) {
      context.handle(_rawPhoneMeta,
          rawPhone.isAcceptableOrUnknown(data['raw_phone']!, _rawPhoneMeta));
    }
    if (data.containsKey('name')) {
      context.handle(
          _nameMeta, name.isAcceptableOrUnknown(data['name']!, _nameMeta));
    }
    if (data.containsKey('uid')) {
      context.handle(
          _uidMeta, uid.isAcceptableOrUnknown(data['uid']!, _uidMeta));
    }
    if (data.containsKey('handle')) {
      context.handle(_handleMeta,
          handle.isAcceptableOrUnknown(data['handle']!, _handleMeta));
    }
    if (data.containsKey('avatar_url')) {
      context.handle(_avatarUrlMeta,
          avatarUrl.isAcceptableOrUnknown(data['avatar_url']!, _avatarUrlMeta));
    }
    if (data.containsKey('match_display_name')) {
      context.handle(
          _matchDisplayNameMeta,
          matchDisplayName.isAcceptableOrUnknown(
              data['match_display_name']!, _matchDisplayNameMeta));
    }
    if (data.containsKey('email')) {
      context.handle(
          _emailMeta, email.isAcceptableOrUnknown(data['email']!, _emailMeta));
    }
    if (data.containsKey('company')) {
      context.handle(_companyMeta,
          company.isAcceptableOrUnknown(data['company']!, _companyMeta));
    }
    if (data.containsKey('has_whatsapp')) {
      context.handle(
          _hasWhatsappMeta,
          hasWhatsapp.isAcceptableOrUnknown(
              data['has_whatsapp']!, _hasWhatsappMeta));
    }
    if (data.containsKey('matched_at')) {
      context.handle(_matchedAtMeta,
          matchedAt.isAcceptableOrUnknown(data['matched_at']!, _matchedAtMeta));
    }
    if (data.containsKey('updated_at')) {
      context.handle(_updatedAtMeta,
          updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta));
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {phoneNorm};
  @override
  DeviceContactRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return DeviceContactRow(
      phoneNorm: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}phone_norm'])!,
      rawPhone: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}raw_phone'])!,
      name: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}name'])!,
      uid: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}uid'])!,
      handle: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}handle'])!,
      avatarUrl: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}avatar_url'])!,
      matchDisplayName: attachedDatabase.typeMapping.read(
          DriftSqlType.string, data['${effectivePrefix}match_display_name'])!,
      email: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}email'])!,
      company: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}company'])!,
      hasWhatsapp: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}has_whatsapp'])!,
      matchedAt: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}matched_at'])!,
      updatedAt: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}updated_at'])!,
    );
  }

  @override
  $DeviceContactsCacheTable createAlias(String alias) {
    return $DeviceContactsCacheTable(attachedDatabase, alias);
  }
}

class DeviceContactRow extends DataClass
    implements Insertable<DeviceContactRow> {
  final String phoneNorm;
  final String rawPhone;
  final String name;
  final String uid;
  final String handle;
  final String avatarUrl;
  final String matchDisplayName;
  final String email;
  final String company;
  final int hasWhatsapp;
  final int matchedAt;
  final int updatedAt;
  const DeviceContactRow(
      {required this.phoneNorm,
      required this.rawPhone,
      required this.name,
      required this.uid,
      required this.handle,
      required this.avatarUrl,
      required this.matchDisplayName,
      required this.email,
      required this.company,
      required this.hasWhatsapp,
      required this.matchedAt,
      required this.updatedAt});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['phone_norm'] = Variable<String>(phoneNorm);
    map['raw_phone'] = Variable<String>(rawPhone);
    map['name'] = Variable<String>(name);
    map['uid'] = Variable<String>(uid);
    map['handle'] = Variable<String>(handle);
    map['avatar_url'] = Variable<String>(avatarUrl);
    map['match_display_name'] = Variable<String>(matchDisplayName);
    map['email'] = Variable<String>(email);
    map['company'] = Variable<String>(company);
    map['has_whatsapp'] = Variable<int>(hasWhatsapp);
    map['matched_at'] = Variable<int>(matchedAt);
    map['updated_at'] = Variable<int>(updatedAt);
    return map;
  }

  DeviceContactsCacheCompanion toCompanion(bool nullToAbsent) {
    return DeviceContactsCacheCompanion(
      phoneNorm: Value(phoneNorm),
      rawPhone: Value(rawPhone),
      name: Value(name),
      uid: Value(uid),
      handle: Value(handle),
      avatarUrl: Value(avatarUrl),
      matchDisplayName: Value(matchDisplayName),
      email: Value(email),
      company: Value(company),
      hasWhatsapp: Value(hasWhatsapp),
      matchedAt: Value(matchedAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory DeviceContactRow.fromJson(Map<String, dynamic> json,
      {ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return DeviceContactRow(
      phoneNorm: serializer.fromJson<String>(json['phoneNorm']),
      rawPhone: serializer.fromJson<String>(json['rawPhone']),
      name: serializer.fromJson<String>(json['name']),
      uid: serializer.fromJson<String>(json['uid']),
      handle: serializer.fromJson<String>(json['handle']),
      avatarUrl: serializer.fromJson<String>(json['avatarUrl']),
      matchDisplayName: serializer.fromJson<String>(json['matchDisplayName']),
      email: serializer.fromJson<String>(json['email']),
      company: serializer.fromJson<String>(json['company']),
      hasWhatsapp: serializer.fromJson<int>(json['hasWhatsapp']),
      matchedAt: serializer.fromJson<int>(json['matchedAt']),
      updatedAt: serializer.fromJson<int>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'phoneNorm': serializer.toJson<String>(phoneNorm),
      'rawPhone': serializer.toJson<String>(rawPhone),
      'name': serializer.toJson<String>(name),
      'uid': serializer.toJson<String>(uid),
      'handle': serializer.toJson<String>(handle),
      'avatarUrl': serializer.toJson<String>(avatarUrl),
      'matchDisplayName': serializer.toJson<String>(matchDisplayName),
      'email': serializer.toJson<String>(email),
      'company': serializer.toJson<String>(company),
      'hasWhatsapp': serializer.toJson<int>(hasWhatsapp),
      'matchedAt': serializer.toJson<int>(matchedAt),
      'updatedAt': serializer.toJson<int>(updatedAt),
    };
  }

  DeviceContactRow copyWith(
          {String? phoneNorm,
          String? rawPhone,
          String? name,
          String? uid,
          String? handle,
          String? avatarUrl,
          String? matchDisplayName,
          String? email,
          String? company,
          int? hasWhatsapp,
          int? matchedAt,
          int? updatedAt}) =>
      DeviceContactRow(
        phoneNorm: phoneNorm ?? this.phoneNorm,
        rawPhone: rawPhone ?? this.rawPhone,
        name: name ?? this.name,
        uid: uid ?? this.uid,
        handle: handle ?? this.handle,
        avatarUrl: avatarUrl ?? this.avatarUrl,
        matchDisplayName: matchDisplayName ?? this.matchDisplayName,
        email: email ?? this.email,
        company: company ?? this.company,
        hasWhatsapp: hasWhatsapp ?? this.hasWhatsapp,
        matchedAt: matchedAt ?? this.matchedAt,
        updatedAt: updatedAt ?? this.updatedAt,
      );
  DeviceContactRow copyWithCompanion(DeviceContactsCacheCompanion data) {
    return DeviceContactRow(
      phoneNorm: data.phoneNorm.present ? data.phoneNorm.value : this.phoneNorm,
      rawPhone: data.rawPhone.present ? data.rawPhone.value : this.rawPhone,
      name: data.name.present ? data.name.value : this.name,
      uid: data.uid.present ? data.uid.value : this.uid,
      handle: data.handle.present ? data.handle.value : this.handle,
      avatarUrl: data.avatarUrl.present ? data.avatarUrl.value : this.avatarUrl,
      matchDisplayName: data.matchDisplayName.present
          ? data.matchDisplayName.value
          : this.matchDisplayName,
      email: data.email.present ? data.email.value : this.email,
      company: data.company.present ? data.company.value : this.company,
      hasWhatsapp:
          data.hasWhatsapp.present ? data.hasWhatsapp.value : this.hasWhatsapp,
      matchedAt: data.matchedAt.present ? data.matchedAt.value : this.matchedAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('DeviceContactRow(')
          ..write('phoneNorm: $phoneNorm, ')
          ..write('rawPhone: $rawPhone, ')
          ..write('name: $name, ')
          ..write('uid: $uid, ')
          ..write('handle: $handle, ')
          ..write('avatarUrl: $avatarUrl, ')
          ..write('matchDisplayName: $matchDisplayName, ')
          ..write('email: $email, ')
          ..write('company: $company, ')
          ..write('hasWhatsapp: $hasWhatsapp, ')
          ..write('matchedAt: $matchedAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
      phoneNorm,
      rawPhone,
      name,
      uid,
      handle,
      avatarUrl,
      matchDisplayName,
      email,
      company,
      hasWhatsapp,
      matchedAt,
      updatedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is DeviceContactRow &&
          other.phoneNorm == this.phoneNorm &&
          other.rawPhone == this.rawPhone &&
          other.name == this.name &&
          other.uid == this.uid &&
          other.handle == this.handle &&
          other.avatarUrl == this.avatarUrl &&
          other.matchDisplayName == this.matchDisplayName &&
          other.email == this.email &&
          other.company == this.company &&
          other.hasWhatsapp == this.hasWhatsapp &&
          other.matchedAt == this.matchedAt &&
          other.updatedAt == this.updatedAt);
}

class DeviceContactsCacheCompanion extends UpdateCompanion<DeviceContactRow> {
  final Value<String> phoneNorm;
  final Value<String> rawPhone;
  final Value<String> name;
  final Value<String> uid;
  final Value<String> handle;
  final Value<String> avatarUrl;
  final Value<String> matchDisplayName;
  final Value<String> email;
  final Value<String> company;
  final Value<int> hasWhatsapp;
  final Value<int> matchedAt;
  final Value<int> updatedAt;
  final Value<int> rowid;
  const DeviceContactsCacheCompanion({
    this.phoneNorm = const Value.absent(),
    this.rawPhone = const Value.absent(),
    this.name = const Value.absent(),
    this.uid = const Value.absent(),
    this.handle = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.matchDisplayName = const Value.absent(),
    this.email = const Value.absent(),
    this.company = const Value.absent(),
    this.hasWhatsapp = const Value.absent(),
    this.matchedAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  DeviceContactsCacheCompanion.insert({
    required String phoneNorm,
    this.rawPhone = const Value.absent(),
    this.name = const Value.absent(),
    this.uid = const Value.absent(),
    this.handle = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.matchDisplayName = const Value.absent(),
    this.email = const Value.absent(),
    this.company = const Value.absent(),
    this.hasWhatsapp = const Value.absent(),
    this.matchedAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : phoneNorm = Value(phoneNorm);
  static Insertable<DeviceContactRow> custom({
    Expression<String>? phoneNorm,
    Expression<String>? rawPhone,
    Expression<String>? name,
    Expression<String>? uid,
    Expression<String>? handle,
    Expression<String>? avatarUrl,
    Expression<String>? matchDisplayName,
    Expression<String>? email,
    Expression<String>? company,
    Expression<int>? hasWhatsapp,
    Expression<int>? matchedAt,
    Expression<int>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (phoneNorm != null) 'phone_norm': phoneNorm,
      if (rawPhone != null) 'raw_phone': rawPhone,
      if (name != null) 'name': name,
      if (uid != null) 'uid': uid,
      if (handle != null) 'handle': handle,
      if (avatarUrl != null) 'avatar_url': avatarUrl,
      if (matchDisplayName != null) 'match_display_name': matchDisplayName,
      if (email != null) 'email': email,
      if (company != null) 'company': company,
      if (hasWhatsapp != null) 'has_whatsapp': hasWhatsapp,
      if (matchedAt != null) 'matched_at': matchedAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  DeviceContactsCacheCompanion copyWith(
      {Value<String>? phoneNorm,
      Value<String>? rawPhone,
      Value<String>? name,
      Value<String>? uid,
      Value<String>? handle,
      Value<String>? avatarUrl,
      Value<String>? matchDisplayName,
      Value<String>? email,
      Value<String>? company,
      Value<int>? hasWhatsapp,
      Value<int>? matchedAt,
      Value<int>? updatedAt,
      Value<int>? rowid}) {
    return DeviceContactsCacheCompanion(
      phoneNorm: phoneNorm ?? this.phoneNorm,
      rawPhone: rawPhone ?? this.rawPhone,
      name: name ?? this.name,
      uid: uid ?? this.uid,
      handle: handle ?? this.handle,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      matchDisplayName: matchDisplayName ?? this.matchDisplayName,
      email: email ?? this.email,
      company: company ?? this.company,
      hasWhatsapp: hasWhatsapp ?? this.hasWhatsapp,
      matchedAt: matchedAt ?? this.matchedAt,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (phoneNorm.present) {
      map['phone_norm'] = Variable<String>(phoneNorm.value);
    }
    if (rawPhone.present) {
      map['raw_phone'] = Variable<String>(rawPhone.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (uid.present) {
      map['uid'] = Variable<String>(uid.value);
    }
    if (handle.present) {
      map['handle'] = Variable<String>(handle.value);
    }
    if (avatarUrl.present) {
      map['avatar_url'] = Variable<String>(avatarUrl.value);
    }
    if (matchDisplayName.present) {
      map['match_display_name'] = Variable<String>(matchDisplayName.value);
    }
    if (email.present) {
      map['email'] = Variable<String>(email.value);
    }
    if (company.present) {
      map['company'] = Variable<String>(company.value);
    }
    if (hasWhatsapp.present) {
      map['has_whatsapp'] = Variable<int>(hasWhatsapp.value);
    }
    if (matchedAt.present) {
      map['matched_at'] = Variable<int>(matchedAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<int>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('DeviceContactsCacheCompanion(')
          ..write('phoneNorm: $phoneNorm, ')
          ..write('rawPhone: $rawPhone, ')
          ..write('name: $name, ')
          ..write('uid: $uid, ')
          ..write('handle: $handle, ')
          ..write('avatarUrl: $avatarUrl, ')
          ..write('matchDisplayName: $matchDisplayName, ')
          ..write('email: $email, ')
          ..write('company: $company, ')
          ..write('hasWhatsapp: $hasWhatsapp, ')
          ..write('matchedAt: $matchedAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $InviteSendsTable extends InviteSends
    with TableInfo<$InviteSendsTable, InviteSend> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $InviteSendsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _phoneNormMeta =
      const VerificationMeta('phoneNorm');
  @override
  late final GeneratedColumn<String> phoneNorm = GeneratedColumn<String>(
      'phone_norm', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _channelMeta =
      const VerificationMeta('channel');
  @override
  late final GeneratedColumn<String> channel = GeneratedColumn<String>(
      'channel', aliasedName, false,
      type: DriftSqlType.string, requiredDuringInsert: true);
  static const VerificationMeta _sentAtMeta = const VerificationMeta('sentAt');
  @override
  late final GeneratedColumn<int> sentAt = GeneratedColumn<int>(
      'sent_at', aliasedName, false,
      type: DriftSqlType.int,
      requiredDuringInsert: false,
      defaultValue: const Constant(0));
  @override
  List<GeneratedColumn> get $columns => [phoneNorm, channel, sentAt];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'invite_sends';
  @override
  VerificationContext validateIntegrity(Insertable<InviteSend> instance,
      {bool isInserting = false}) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('phone_norm')) {
      context.handle(_phoneNormMeta,
          phoneNorm.isAcceptableOrUnknown(data['phone_norm']!, _phoneNormMeta));
    } else if (isInserting) {
      context.missing(_phoneNormMeta);
    }
    if (data.containsKey('channel')) {
      context.handle(_channelMeta,
          channel.isAcceptableOrUnknown(data['channel']!, _channelMeta));
    } else if (isInserting) {
      context.missing(_channelMeta);
    }
    if (data.containsKey('sent_at')) {
      context.handle(_sentAtMeta,
          sentAt.isAcceptableOrUnknown(data['sent_at']!, _sentAtMeta));
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {phoneNorm, channel};
  @override
  InviteSend map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return InviteSend(
      phoneNorm: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}phone_norm'])!,
      channel: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}channel'])!,
      sentAt: attachedDatabase.typeMapping
          .read(DriftSqlType.int, data['${effectivePrefix}sent_at'])!,
    );
  }

  @override
  $InviteSendsTable createAlias(String alias) {
    return $InviteSendsTable(attachedDatabase, alias);
  }
}

class InviteSend extends DataClass implements Insertable<InviteSend> {
  final String phoneNorm;
  final String channel;
  final int sentAt;
  const InviteSend(
      {required this.phoneNorm, required this.channel, required this.sentAt});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['phone_norm'] = Variable<String>(phoneNorm);
    map['channel'] = Variable<String>(channel);
    map['sent_at'] = Variable<int>(sentAt);
    return map;
  }

  InviteSendsCompanion toCompanion(bool nullToAbsent) {
    return InviteSendsCompanion(
      phoneNorm: Value(phoneNorm),
      channel: Value(channel),
      sentAt: Value(sentAt),
    );
  }

  factory InviteSend.fromJson(Map<String, dynamic> json,
      {ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return InviteSend(
      phoneNorm: serializer.fromJson<String>(json['phoneNorm']),
      channel: serializer.fromJson<String>(json['channel']),
      sentAt: serializer.fromJson<int>(json['sentAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'phoneNorm': serializer.toJson<String>(phoneNorm),
      'channel': serializer.toJson<String>(channel),
      'sentAt': serializer.toJson<int>(sentAt),
    };
  }

  InviteSend copyWith({String? phoneNorm, String? channel, int? sentAt}) =>
      InviteSend(
        phoneNorm: phoneNorm ?? this.phoneNorm,
        channel: channel ?? this.channel,
        sentAt: sentAt ?? this.sentAt,
      );
  InviteSend copyWithCompanion(InviteSendsCompanion data) {
    return InviteSend(
      phoneNorm: data.phoneNorm.present ? data.phoneNorm.value : this.phoneNorm,
      channel: data.channel.present ? data.channel.value : this.channel,
      sentAt: data.sentAt.present ? data.sentAt.value : this.sentAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('InviteSend(')
          ..write('phoneNorm: $phoneNorm, ')
          ..write('channel: $channel, ')
          ..write('sentAt: $sentAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(phoneNorm, channel, sentAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is InviteSend &&
          other.phoneNorm == this.phoneNorm &&
          other.channel == this.channel &&
          other.sentAt == this.sentAt);
}

class InviteSendsCompanion extends UpdateCompanion<InviteSend> {
  final Value<String> phoneNorm;
  final Value<String> channel;
  final Value<int> sentAt;
  final Value<int> rowid;
  const InviteSendsCompanion({
    this.phoneNorm = const Value.absent(),
    this.channel = const Value.absent(),
    this.sentAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  InviteSendsCompanion.insert({
    required String phoneNorm,
    required String channel,
    this.sentAt = const Value.absent(),
    this.rowid = const Value.absent(),
  })  : phoneNorm = Value(phoneNorm),
        channel = Value(channel);
  static Insertable<InviteSend> custom({
    Expression<String>? phoneNorm,
    Expression<String>? channel,
    Expression<int>? sentAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (phoneNorm != null) 'phone_norm': phoneNorm,
      if (channel != null) 'channel': channel,
      if (sentAt != null) 'sent_at': sentAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  InviteSendsCompanion copyWith(
      {Value<String>? phoneNorm,
      Value<String>? channel,
      Value<int>? sentAt,
      Value<int>? rowid}) {
    return InviteSendsCompanion(
      phoneNorm: phoneNorm ?? this.phoneNorm,
      channel: channel ?? this.channel,
      sentAt: sentAt ?? this.sentAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (phoneNorm.present) {
      map['phone_norm'] = Variable<String>(phoneNorm.value);
    }
    if (channel.present) {
      map['channel'] = Variable<String>(channel.value);
    }
    if (sentAt.present) {
      map['sent_at'] = Variable<int>(sentAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('InviteSendsCompanion(')
          ..write('phoneNorm: $phoneNorm, ')
          ..write('channel: $channel, ')
          ..write('sentAt: $sentAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$AppDb extends GeneratedDatabase {
  _$AppDb(QueryExecutor e) : super(e);
  $AppDbManager get managers => $AppDbManager(this);
  late final $MessagesTable messages = $MessagesTable(this);
  late final $ContactsTable contacts = $ContactsTable(this);
  late final $ChatsTable chats = $ChatsTable(this);
  late final $WalletLedgerCacheTable walletLedgerCache =
      $WalletLedgerCacheTable(this);
  late final $DeviceContactsCacheTable deviceContactsCache =
      $DeviceContactsCacheTable(this);
  late final $InviteSendsTable inviteSends = $InviteSendsTable(this);
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
        messages,
        contacts,
        chats,
        walletLedgerCache,
        deviceContactsCache,
        inviteSends
      ];
}

typedef $$MessagesTableCreateCompanionBuilder = MessagesCompanion Function({
  required String rumorId,
  required String convKey,
  required bool mine,
  required String payload,
  required int createdAt,
  Value<String?> kind,
  Value<String?> senderPub,
  Value<int> rowid,
});
typedef $$MessagesTableUpdateCompanionBuilder = MessagesCompanion Function({
  Value<String> rumorId,
  Value<String> convKey,
  Value<bool> mine,
  Value<String> payload,
  Value<int> createdAt,
  Value<String?> kind,
  Value<String?> senderPub,
  Value<int> rowid,
});

class $$MessagesTableFilterComposer extends Composer<_$AppDb, $MessagesTable> {
  $$MessagesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get rumorId => $composableBuilder(
      column: $table.rumorId, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get convKey => $composableBuilder(
      column: $table.convKey, builder: (column) => ColumnFilters(column));

  ColumnFilters<bool> get mine => $composableBuilder(
      column: $table.mine, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get payload => $composableBuilder(
      column: $table.payload, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get createdAt => $composableBuilder(
      column: $table.createdAt, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get kind => $composableBuilder(
      column: $table.kind, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get senderPub => $composableBuilder(
      column: $table.senderPub, builder: (column) => ColumnFilters(column));
}

class $$MessagesTableOrderingComposer
    extends Composer<_$AppDb, $MessagesTable> {
  $$MessagesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get rumorId => $composableBuilder(
      column: $table.rumorId, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get convKey => $composableBuilder(
      column: $table.convKey, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<bool> get mine => $composableBuilder(
      column: $table.mine, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get payload => $composableBuilder(
      column: $table.payload, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get createdAt => $composableBuilder(
      column: $table.createdAt, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get kind => $composableBuilder(
      column: $table.kind, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get senderPub => $composableBuilder(
      column: $table.senderPub, builder: (column) => ColumnOrderings(column));
}

class $$MessagesTableAnnotationComposer
    extends Composer<_$AppDb, $MessagesTable> {
  $$MessagesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get rumorId =>
      $composableBuilder(column: $table.rumorId, builder: (column) => column);

  GeneratedColumn<String> get convKey =>
      $composableBuilder(column: $table.convKey, builder: (column) => column);

  GeneratedColumn<bool> get mine =>
      $composableBuilder(column: $table.mine, builder: (column) => column);

  GeneratedColumn<String> get payload =>
      $composableBuilder(column: $table.payload, builder: (column) => column);

  GeneratedColumn<int> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<String> get kind =>
      $composableBuilder(column: $table.kind, builder: (column) => column);

  GeneratedColumn<String> get senderPub =>
      $composableBuilder(column: $table.senderPub, builder: (column) => column);
}

class $$MessagesTableTableManager extends RootTableManager<
    _$AppDb,
    $MessagesTable,
    MessageRow,
    $$MessagesTableFilterComposer,
    $$MessagesTableOrderingComposer,
    $$MessagesTableAnnotationComposer,
    $$MessagesTableCreateCompanionBuilder,
    $$MessagesTableUpdateCompanionBuilder,
    (MessageRow, BaseReferences<_$AppDb, $MessagesTable, MessageRow>),
    MessageRow,
    PrefetchHooks Function()> {
  $$MessagesTableTableManager(_$AppDb db, $MessagesTable table)
      : super(TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MessagesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MessagesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$MessagesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback: ({
            Value<String> rumorId = const Value.absent(),
            Value<String> convKey = const Value.absent(),
            Value<bool> mine = const Value.absent(),
            Value<String> payload = const Value.absent(),
            Value<int> createdAt = const Value.absent(),
            Value<String?> kind = const Value.absent(),
            Value<String?> senderPub = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              MessagesCompanion(
            rumorId: rumorId,
            convKey: convKey,
            mine: mine,
            payload: payload,
            createdAt: createdAt,
            kind: kind,
            senderPub: senderPub,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String rumorId,
            required String convKey,
            required bool mine,
            required String payload,
            required int createdAt,
            Value<String?> kind = const Value.absent(),
            Value<String?> senderPub = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              MessagesCompanion.insert(
            rumorId: rumorId,
            convKey: convKey,
            mine: mine,
            payload: payload,
            createdAt: createdAt,
            kind: kind,
            senderPub: senderPub,
            rowid: rowid,
          ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ));
}

typedef $$MessagesTableProcessedTableManager = ProcessedTableManager<
    _$AppDb,
    $MessagesTable,
    MessageRow,
    $$MessagesTableFilterComposer,
    $$MessagesTableOrderingComposer,
    $$MessagesTableAnnotationComposer,
    $$MessagesTableCreateCompanionBuilder,
    $$MessagesTableUpdateCompanionBuilder,
    (MessageRow, BaseReferences<_$AppDb, $MessagesTable, MessageRow>),
    MessageRow,
    PrefetchHooks Function()>;
typedef $$ContactsTableCreateCompanionBuilder = ContactsCompanion Function({
  required String uid,
  Value<String> name,
  Value<String> handle,
  Value<String> email,
  Value<String> avatarUrl,
  Value<int> rowid,
});
typedef $$ContactsTableUpdateCompanionBuilder = ContactsCompanion Function({
  Value<String> uid,
  Value<String> name,
  Value<String> handle,
  Value<String> email,
  Value<String> avatarUrl,
  Value<int> rowid,
});

class $$ContactsTableFilterComposer extends Composer<_$AppDb, $ContactsTable> {
  $$ContactsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get uid => $composableBuilder(
      column: $table.uid, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get name => $composableBuilder(
      column: $table.name, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get handle => $composableBuilder(
      column: $table.handle, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get email => $composableBuilder(
      column: $table.email, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get avatarUrl => $composableBuilder(
      column: $table.avatarUrl, builder: (column) => ColumnFilters(column));
}

class $$ContactsTableOrderingComposer
    extends Composer<_$AppDb, $ContactsTable> {
  $$ContactsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get uid => $composableBuilder(
      column: $table.uid, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get name => $composableBuilder(
      column: $table.name, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get handle => $composableBuilder(
      column: $table.handle, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get email => $composableBuilder(
      column: $table.email, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get avatarUrl => $composableBuilder(
      column: $table.avatarUrl, builder: (column) => ColumnOrderings(column));
}

class $$ContactsTableAnnotationComposer
    extends Composer<_$AppDb, $ContactsTable> {
  $$ContactsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get uid =>
      $composableBuilder(column: $table.uid, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get handle =>
      $composableBuilder(column: $table.handle, builder: (column) => column);

  GeneratedColumn<String> get email =>
      $composableBuilder(column: $table.email, builder: (column) => column);

  GeneratedColumn<String> get avatarUrl =>
      $composableBuilder(column: $table.avatarUrl, builder: (column) => column);
}

class $$ContactsTableTableManager extends RootTableManager<
    _$AppDb,
    $ContactsTable,
    ContactRow,
    $$ContactsTableFilterComposer,
    $$ContactsTableOrderingComposer,
    $$ContactsTableAnnotationComposer,
    $$ContactsTableCreateCompanionBuilder,
    $$ContactsTableUpdateCompanionBuilder,
    (ContactRow, BaseReferences<_$AppDb, $ContactsTable, ContactRow>),
    ContactRow,
    PrefetchHooks Function()> {
  $$ContactsTableTableManager(_$AppDb db, $ContactsTable table)
      : super(TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ContactsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ContactsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ContactsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback: ({
            Value<String> uid = const Value.absent(),
            Value<String> name = const Value.absent(),
            Value<String> handle = const Value.absent(),
            Value<String> email = const Value.absent(),
            Value<String> avatarUrl = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              ContactsCompanion(
            uid: uid,
            name: name,
            handle: handle,
            email: email,
            avatarUrl: avatarUrl,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String uid,
            Value<String> name = const Value.absent(),
            Value<String> handle = const Value.absent(),
            Value<String> email = const Value.absent(),
            Value<String> avatarUrl = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              ContactsCompanion.insert(
            uid: uid,
            name: name,
            handle: handle,
            email: email,
            avatarUrl: avatarUrl,
            rowid: rowid,
          ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ));
}

typedef $$ContactsTableProcessedTableManager = ProcessedTableManager<
    _$AppDb,
    $ContactsTable,
    ContactRow,
    $$ContactsTableFilterComposer,
    $$ContactsTableOrderingComposer,
    $$ContactsTableAnnotationComposer,
    $$ContactsTableCreateCompanionBuilder,
    $$ContactsTableUpdateCompanionBuilder,
    (ContactRow, BaseReferences<_$AppDb, $ContactsTable, ContactRow>),
    ContactRow,
    PrefetchHooks Function()>;
typedef $$ChatsTableCreateCompanionBuilder = ChatsCompanion Function({
  required String convKey,
  Value<String> preview,
  Value<int> ts,
  Value<bool> lastMine,
  Value<int> unread,
  Value<String> json,
  Value<int> rowid,
});
typedef $$ChatsTableUpdateCompanionBuilder = ChatsCompanion Function({
  Value<String> convKey,
  Value<String> preview,
  Value<int> ts,
  Value<bool> lastMine,
  Value<int> unread,
  Value<String> json,
  Value<int> rowid,
});

class $$ChatsTableFilterComposer extends Composer<_$AppDb, $ChatsTable> {
  $$ChatsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get convKey => $composableBuilder(
      column: $table.convKey, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get preview => $composableBuilder(
      column: $table.preview, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get ts => $composableBuilder(
      column: $table.ts, builder: (column) => ColumnFilters(column));

  ColumnFilters<bool> get lastMine => $composableBuilder(
      column: $table.lastMine, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get unread => $composableBuilder(
      column: $table.unread, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get json => $composableBuilder(
      column: $table.json, builder: (column) => ColumnFilters(column));
}

class $$ChatsTableOrderingComposer extends Composer<_$AppDb, $ChatsTable> {
  $$ChatsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get convKey => $composableBuilder(
      column: $table.convKey, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get preview => $composableBuilder(
      column: $table.preview, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get ts => $composableBuilder(
      column: $table.ts, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<bool> get lastMine => $composableBuilder(
      column: $table.lastMine, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get unread => $composableBuilder(
      column: $table.unread, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get json => $composableBuilder(
      column: $table.json, builder: (column) => ColumnOrderings(column));
}

class $$ChatsTableAnnotationComposer extends Composer<_$AppDb, $ChatsTable> {
  $$ChatsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get convKey =>
      $composableBuilder(column: $table.convKey, builder: (column) => column);

  GeneratedColumn<String> get preview =>
      $composableBuilder(column: $table.preview, builder: (column) => column);

  GeneratedColumn<int> get ts =>
      $composableBuilder(column: $table.ts, builder: (column) => column);

  GeneratedColumn<bool> get lastMine =>
      $composableBuilder(column: $table.lastMine, builder: (column) => column);

  GeneratedColumn<int> get unread =>
      $composableBuilder(column: $table.unread, builder: (column) => column);

  GeneratedColumn<String> get json =>
      $composableBuilder(column: $table.json, builder: (column) => column);
}

class $$ChatsTableTableManager extends RootTableManager<
    _$AppDb,
    $ChatsTable,
    ChatRow,
    $$ChatsTableFilterComposer,
    $$ChatsTableOrderingComposer,
    $$ChatsTableAnnotationComposer,
    $$ChatsTableCreateCompanionBuilder,
    $$ChatsTableUpdateCompanionBuilder,
    (ChatRow, BaseReferences<_$AppDb, $ChatsTable, ChatRow>),
    ChatRow,
    PrefetchHooks Function()> {
  $$ChatsTableTableManager(_$AppDb db, $ChatsTable table)
      : super(TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ChatsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ChatsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ChatsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback: ({
            Value<String> convKey = const Value.absent(),
            Value<String> preview = const Value.absent(),
            Value<int> ts = const Value.absent(),
            Value<bool> lastMine = const Value.absent(),
            Value<int> unread = const Value.absent(),
            Value<String> json = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              ChatsCompanion(
            convKey: convKey,
            preview: preview,
            ts: ts,
            lastMine: lastMine,
            unread: unread,
            json: json,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String convKey,
            Value<String> preview = const Value.absent(),
            Value<int> ts = const Value.absent(),
            Value<bool> lastMine = const Value.absent(),
            Value<int> unread = const Value.absent(),
            Value<String> json = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              ChatsCompanion.insert(
            convKey: convKey,
            preview: preview,
            ts: ts,
            lastMine: lastMine,
            unread: unread,
            json: json,
            rowid: rowid,
          ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ));
}

typedef $$ChatsTableProcessedTableManager = ProcessedTableManager<
    _$AppDb,
    $ChatsTable,
    ChatRow,
    $$ChatsTableFilterComposer,
    $$ChatsTableOrderingComposer,
    $$ChatsTableAnnotationComposer,
    $$ChatsTableCreateCompanionBuilder,
    $$ChatsTableUpdateCompanionBuilder,
    (ChatRow, BaseReferences<_$AppDb, $ChatsTable, ChatRow>),
    ChatRow,
    PrefetchHooks Function()>;
typedef $$WalletLedgerCacheTableCreateCompanionBuilder
    = WalletLedgerCacheCompanion Function({
  required String id,
  required int createdAt,
  Value<String> type,
  required String json,
  Value<int> rowid,
});
typedef $$WalletLedgerCacheTableUpdateCompanionBuilder
    = WalletLedgerCacheCompanion Function({
  Value<String> id,
  Value<int> createdAt,
  Value<String> type,
  Value<String> json,
  Value<int> rowid,
});

class $$WalletLedgerCacheTableFilterComposer
    extends Composer<_$AppDb, $WalletLedgerCacheTable> {
  $$WalletLedgerCacheTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
      column: $table.id, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get createdAt => $composableBuilder(
      column: $table.createdAt, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get type => $composableBuilder(
      column: $table.type, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get json => $composableBuilder(
      column: $table.json, builder: (column) => ColumnFilters(column));
}

class $$WalletLedgerCacheTableOrderingComposer
    extends Composer<_$AppDb, $WalletLedgerCacheTable> {
  $$WalletLedgerCacheTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
      column: $table.id, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get createdAt => $composableBuilder(
      column: $table.createdAt, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get type => $composableBuilder(
      column: $table.type, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get json => $composableBuilder(
      column: $table.json, builder: (column) => ColumnOrderings(column));
}

class $$WalletLedgerCacheTableAnnotationComposer
    extends Composer<_$AppDb, $WalletLedgerCacheTable> {
  $$WalletLedgerCacheTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<int> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<String> get type =>
      $composableBuilder(column: $table.type, builder: (column) => column);

  GeneratedColumn<String> get json =>
      $composableBuilder(column: $table.json, builder: (column) => column);
}

class $$WalletLedgerCacheTableTableManager extends RootTableManager<
    _$AppDb,
    $WalletLedgerCacheTable,
    WalletLedgerRow,
    $$WalletLedgerCacheTableFilterComposer,
    $$WalletLedgerCacheTableOrderingComposer,
    $$WalletLedgerCacheTableAnnotationComposer,
    $$WalletLedgerCacheTableCreateCompanionBuilder,
    $$WalletLedgerCacheTableUpdateCompanionBuilder,
    (
      WalletLedgerRow,
      BaseReferences<_$AppDb, $WalletLedgerCacheTable, WalletLedgerRow>
    ),
    WalletLedgerRow,
    PrefetchHooks Function()> {
  $$WalletLedgerCacheTableTableManager(
      _$AppDb db, $WalletLedgerCacheTable table)
      : super(TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$WalletLedgerCacheTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$WalletLedgerCacheTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$WalletLedgerCacheTableAnnotationComposer(
                  $db: db, $table: table),
          updateCompanionCallback: ({
            Value<String> id = const Value.absent(),
            Value<int> createdAt = const Value.absent(),
            Value<String> type = const Value.absent(),
            Value<String> json = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              WalletLedgerCacheCompanion(
            id: id,
            createdAt: createdAt,
            type: type,
            json: json,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String id,
            required int createdAt,
            Value<String> type = const Value.absent(),
            required String json,
            Value<int> rowid = const Value.absent(),
          }) =>
              WalletLedgerCacheCompanion.insert(
            id: id,
            createdAt: createdAt,
            type: type,
            json: json,
            rowid: rowid,
          ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ));
}

typedef $$WalletLedgerCacheTableProcessedTableManager = ProcessedTableManager<
    _$AppDb,
    $WalletLedgerCacheTable,
    WalletLedgerRow,
    $$WalletLedgerCacheTableFilterComposer,
    $$WalletLedgerCacheTableOrderingComposer,
    $$WalletLedgerCacheTableAnnotationComposer,
    $$WalletLedgerCacheTableCreateCompanionBuilder,
    $$WalletLedgerCacheTableUpdateCompanionBuilder,
    (
      WalletLedgerRow,
      BaseReferences<_$AppDb, $WalletLedgerCacheTable, WalletLedgerRow>
    ),
    WalletLedgerRow,
    PrefetchHooks Function()>;
typedef $$DeviceContactsCacheTableCreateCompanionBuilder
    = DeviceContactsCacheCompanion Function({
  required String phoneNorm,
  Value<String> rawPhone,
  Value<String> name,
  Value<String> uid,
  Value<String> handle,
  Value<String> avatarUrl,
  Value<String> matchDisplayName,
  Value<String> email,
  Value<String> company,
  Value<int> hasWhatsapp,
  Value<int> matchedAt,
  Value<int> updatedAt,
  Value<int> rowid,
});
typedef $$DeviceContactsCacheTableUpdateCompanionBuilder
    = DeviceContactsCacheCompanion Function({
  Value<String> phoneNorm,
  Value<String> rawPhone,
  Value<String> name,
  Value<String> uid,
  Value<String> handle,
  Value<String> avatarUrl,
  Value<String> matchDisplayName,
  Value<String> email,
  Value<String> company,
  Value<int> hasWhatsapp,
  Value<int> matchedAt,
  Value<int> updatedAt,
  Value<int> rowid,
});

class $$DeviceContactsCacheTableFilterComposer
    extends Composer<_$AppDb, $DeviceContactsCacheTable> {
  $$DeviceContactsCacheTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get phoneNorm => $composableBuilder(
      column: $table.phoneNorm, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get rawPhone => $composableBuilder(
      column: $table.rawPhone, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get name => $composableBuilder(
      column: $table.name, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get uid => $composableBuilder(
      column: $table.uid, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get handle => $composableBuilder(
      column: $table.handle, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get avatarUrl => $composableBuilder(
      column: $table.avatarUrl, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get matchDisplayName => $composableBuilder(
      column: $table.matchDisplayName,
      builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get email => $composableBuilder(
      column: $table.email, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get company => $composableBuilder(
      column: $table.company, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get hasWhatsapp => $composableBuilder(
      column: $table.hasWhatsapp, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get matchedAt => $composableBuilder(
      column: $table.matchedAt, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get updatedAt => $composableBuilder(
      column: $table.updatedAt, builder: (column) => ColumnFilters(column));
}

class $$DeviceContactsCacheTableOrderingComposer
    extends Composer<_$AppDb, $DeviceContactsCacheTable> {
  $$DeviceContactsCacheTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get phoneNorm => $composableBuilder(
      column: $table.phoneNorm, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get rawPhone => $composableBuilder(
      column: $table.rawPhone, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get name => $composableBuilder(
      column: $table.name, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get uid => $composableBuilder(
      column: $table.uid, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get handle => $composableBuilder(
      column: $table.handle, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get avatarUrl => $composableBuilder(
      column: $table.avatarUrl, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get matchDisplayName => $composableBuilder(
      column: $table.matchDisplayName,
      builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get email => $composableBuilder(
      column: $table.email, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get company => $composableBuilder(
      column: $table.company, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get hasWhatsapp => $composableBuilder(
      column: $table.hasWhatsapp, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get matchedAt => $composableBuilder(
      column: $table.matchedAt, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get updatedAt => $composableBuilder(
      column: $table.updatedAt, builder: (column) => ColumnOrderings(column));
}

class $$DeviceContactsCacheTableAnnotationComposer
    extends Composer<_$AppDb, $DeviceContactsCacheTable> {
  $$DeviceContactsCacheTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get phoneNorm =>
      $composableBuilder(column: $table.phoneNorm, builder: (column) => column);

  GeneratedColumn<String> get rawPhone =>
      $composableBuilder(column: $table.rawPhone, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get uid =>
      $composableBuilder(column: $table.uid, builder: (column) => column);

  GeneratedColumn<String> get handle =>
      $composableBuilder(column: $table.handle, builder: (column) => column);

  GeneratedColumn<String> get avatarUrl =>
      $composableBuilder(column: $table.avatarUrl, builder: (column) => column);

  GeneratedColumn<String> get matchDisplayName => $composableBuilder(
      column: $table.matchDisplayName, builder: (column) => column);

  GeneratedColumn<String> get email =>
      $composableBuilder(column: $table.email, builder: (column) => column);

  GeneratedColumn<String> get company =>
      $composableBuilder(column: $table.company, builder: (column) => column);

  GeneratedColumn<int> get hasWhatsapp => $composableBuilder(
      column: $table.hasWhatsapp, builder: (column) => column);

  GeneratedColumn<int> get matchedAt =>
      $composableBuilder(column: $table.matchedAt, builder: (column) => column);

  GeneratedColumn<int> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$DeviceContactsCacheTableTableManager extends RootTableManager<
    _$AppDb,
    $DeviceContactsCacheTable,
    DeviceContactRow,
    $$DeviceContactsCacheTableFilterComposer,
    $$DeviceContactsCacheTableOrderingComposer,
    $$DeviceContactsCacheTableAnnotationComposer,
    $$DeviceContactsCacheTableCreateCompanionBuilder,
    $$DeviceContactsCacheTableUpdateCompanionBuilder,
    (
      DeviceContactRow,
      BaseReferences<_$AppDb, $DeviceContactsCacheTable, DeviceContactRow>
    ),
    DeviceContactRow,
    PrefetchHooks Function()> {
  $$DeviceContactsCacheTableTableManager(
      _$AppDb db, $DeviceContactsCacheTable table)
      : super(TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$DeviceContactsCacheTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$DeviceContactsCacheTableOrderingComposer(
                  $db: db, $table: table),
          createComputedFieldComposer: () =>
              $$DeviceContactsCacheTableAnnotationComposer(
                  $db: db, $table: table),
          updateCompanionCallback: ({
            Value<String> phoneNorm = const Value.absent(),
            Value<String> rawPhone = const Value.absent(),
            Value<String> name = const Value.absent(),
            Value<String> uid = const Value.absent(),
            Value<String> handle = const Value.absent(),
            Value<String> avatarUrl = const Value.absent(),
            Value<String> matchDisplayName = const Value.absent(),
            Value<String> email = const Value.absent(),
            Value<String> company = const Value.absent(),
            Value<int> hasWhatsapp = const Value.absent(),
            Value<int> matchedAt = const Value.absent(),
            Value<int> updatedAt = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              DeviceContactsCacheCompanion(
            phoneNorm: phoneNorm,
            rawPhone: rawPhone,
            name: name,
            uid: uid,
            handle: handle,
            avatarUrl: avatarUrl,
            matchDisplayName: matchDisplayName,
            email: email,
            company: company,
            hasWhatsapp: hasWhatsapp,
            matchedAt: matchedAt,
            updatedAt: updatedAt,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String phoneNorm,
            Value<String> rawPhone = const Value.absent(),
            Value<String> name = const Value.absent(),
            Value<String> uid = const Value.absent(),
            Value<String> handle = const Value.absent(),
            Value<String> avatarUrl = const Value.absent(),
            Value<String> matchDisplayName = const Value.absent(),
            Value<String> email = const Value.absent(),
            Value<String> company = const Value.absent(),
            Value<int> hasWhatsapp = const Value.absent(),
            Value<int> matchedAt = const Value.absent(),
            Value<int> updatedAt = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              DeviceContactsCacheCompanion.insert(
            phoneNorm: phoneNorm,
            rawPhone: rawPhone,
            name: name,
            uid: uid,
            handle: handle,
            avatarUrl: avatarUrl,
            matchDisplayName: matchDisplayName,
            email: email,
            company: company,
            hasWhatsapp: hasWhatsapp,
            matchedAt: matchedAt,
            updatedAt: updatedAt,
            rowid: rowid,
          ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ));
}

typedef $$DeviceContactsCacheTableProcessedTableManager = ProcessedTableManager<
    _$AppDb,
    $DeviceContactsCacheTable,
    DeviceContactRow,
    $$DeviceContactsCacheTableFilterComposer,
    $$DeviceContactsCacheTableOrderingComposer,
    $$DeviceContactsCacheTableAnnotationComposer,
    $$DeviceContactsCacheTableCreateCompanionBuilder,
    $$DeviceContactsCacheTableUpdateCompanionBuilder,
    (
      DeviceContactRow,
      BaseReferences<_$AppDb, $DeviceContactsCacheTable, DeviceContactRow>
    ),
    DeviceContactRow,
    PrefetchHooks Function()>;
typedef $$InviteSendsTableCreateCompanionBuilder = InviteSendsCompanion
    Function({
  required String phoneNorm,
  required String channel,
  Value<int> sentAt,
  Value<int> rowid,
});
typedef $$InviteSendsTableUpdateCompanionBuilder = InviteSendsCompanion
    Function({
  Value<String> phoneNorm,
  Value<String> channel,
  Value<int> sentAt,
  Value<int> rowid,
});

class $$InviteSendsTableFilterComposer
    extends Composer<_$AppDb, $InviteSendsTable> {
  $$InviteSendsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get phoneNorm => $composableBuilder(
      column: $table.phoneNorm, builder: (column) => ColumnFilters(column));

  ColumnFilters<String> get channel => $composableBuilder(
      column: $table.channel, builder: (column) => ColumnFilters(column));

  ColumnFilters<int> get sentAt => $composableBuilder(
      column: $table.sentAt, builder: (column) => ColumnFilters(column));
}

class $$InviteSendsTableOrderingComposer
    extends Composer<_$AppDb, $InviteSendsTable> {
  $$InviteSendsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get phoneNorm => $composableBuilder(
      column: $table.phoneNorm, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<String> get channel => $composableBuilder(
      column: $table.channel, builder: (column) => ColumnOrderings(column));

  ColumnOrderings<int> get sentAt => $composableBuilder(
      column: $table.sentAt, builder: (column) => ColumnOrderings(column));
}

class $$InviteSendsTableAnnotationComposer
    extends Composer<_$AppDb, $InviteSendsTable> {
  $$InviteSendsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get phoneNorm =>
      $composableBuilder(column: $table.phoneNorm, builder: (column) => column);

  GeneratedColumn<String> get channel =>
      $composableBuilder(column: $table.channel, builder: (column) => column);

  GeneratedColumn<int> get sentAt =>
      $composableBuilder(column: $table.sentAt, builder: (column) => column);
}

class $$InviteSendsTableTableManager extends RootTableManager<
    _$AppDb,
    $InviteSendsTable,
    InviteSend,
    $$InviteSendsTableFilterComposer,
    $$InviteSendsTableOrderingComposer,
    $$InviteSendsTableAnnotationComposer,
    $$InviteSendsTableCreateCompanionBuilder,
    $$InviteSendsTableUpdateCompanionBuilder,
    (InviteSend, BaseReferences<_$AppDb, $InviteSendsTable, InviteSend>),
    InviteSend,
    PrefetchHooks Function()> {
  $$InviteSendsTableTableManager(_$AppDb db, $InviteSendsTable table)
      : super(TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$InviteSendsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$InviteSendsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$InviteSendsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback: ({
            Value<String> phoneNorm = const Value.absent(),
            Value<String> channel = const Value.absent(),
            Value<int> sentAt = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              InviteSendsCompanion(
            phoneNorm: phoneNorm,
            channel: channel,
            sentAt: sentAt,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String phoneNorm,
            required String channel,
            Value<int> sentAt = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              InviteSendsCompanion.insert(
            phoneNorm: phoneNorm,
            channel: channel,
            sentAt: sentAt,
            rowid: rowid,
          ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ));
}

typedef $$InviteSendsTableProcessedTableManager = ProcessedTableManager<
    _$AppDb,
    $InviteSendsTable,
    InviteSend,
    $$InviteSendsTableFilterComposer,
    $$InviteSendsTableOrderingComposer,
    $$InviteSendsTableAnnotationComposer,
    $$InviteSendsTableCreateCompanionBuilder,
    $$InviteSendsTableUpdateCompanionBuilder,
    (InviteSend, BaseReferences<_$AppDb, $InviteSendsTable, InviteSend>),
    InviteSend,
    PrefetchHooks Function()>;

class $AppDbManager {
  final _$AppDb _db;
  $AppDbManager(this._db);
  $$MessagesTableTableManager get messages =>
      $$MessagesTableTableManager(_db, _db.messages);
  $$ContactsTableTableManager get contacts =>
      $$ContactsTableTableManager(_db, _db.contacts);
  $$ChatsTableTableManager get chats =>
      $$ChatsTableTableManager(_db, _db.chats);
  $$WalletLedgerCacheTableTableManager get walletLedgerCache =>
      $$WalletLedgerCacheTableTableManager(_db, _db.walletLedgerCache);
  $$DeviceContactsCacheTableTableManager get deviceContactsCache =>
      $$DeviceContactsCacheTableTableManager(_db, _db.deviceContactsCache);
  $$InviteSendsTableTableManager get inviteSends =>
      $$InviteSendsTableTableManager(_db, _db.inviteSends);
}
