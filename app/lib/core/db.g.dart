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
  @override
  List<GeneratedColumn> get $columns =>
      [rumorId, convKey, mine, payload, createdAt];
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
  const MessageRow(
      {required this.rumorId,
      required this.convKey,
      required this.mine,
      required this.payload,
      required this.createdAt});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['rumor_id'] = Variable<String>(rumorId);
    map['conv_key'] = Variable<String>(convKey);
    map['mine'] = Variable<bool>(mine);
    map['payload'] = Variable<String>(payload);
    map['created_at'] = Variable<int>(createdAt);
    return map;
  }

  MessagesCompanion toCompanion(bool nullToAbsent) {
    return MessagesCompanion(
      rumorId: Value(rumorId),
      convKey: Value(convKey),
      mine: Value(mine),
      payload: Value(payload),
      createdAt: Value(createdAt),
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
    };
  }

  MessageRow copyWith(
          {String? rumorId,
          String? convKey,
          bool? mine,
          String? payload,
          int? createdAt}) =>
      MessageRow(
        rumorId: rumorId ?? this.rumorId,
        convKey: convKey ?? this.convKey,
        mine: mine ?? this.mine,
        payload: payload ?? this.payload,
        createdAt: createdAt ?? this.createdAt,
      );
  MessageRow copyWithCompanion(MessagesCompanion data) {
    return MessageRow(
      rumorId: data.rumorId.present ? data.rumorId.value : this.rumorId,
      convKey: data.convKey.present ? data.convKey.value : this.convKey,
      mine: data.mine.present ? data.mine.value : this.mine,
      payload: data.payload.present ? data.payload.value : this.payload,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MessageRow(')
          ..write('rumorId: $rumorId, ')
          ..write('convKey: $convKey, ')
          ..write('mine: $mine, ')
          ..write('payload: $payload, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(rumorId, convKey, mine, payload, createdAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MessageRow &&
          other.rumorId == this.rumorId &&
          other.convKey == this.convKey &&
          other.mine == this.mine &&
          other.payload == this.payload &&
          other.createdAt == this.createdAt);
}

class MessagesCompanion extends UpdateCompanion<MessageRow> {
  final Value<String> rumorId;
  final Value<String> convKey;
  final Value<bool> mine;
  final Value<String> payload;
  final Value<int> createdAt;
  final Value<int> rowid;
  const MessagesCompanion({
    this.rumorId = const Value.absent(),
    this.convKey = const Value.absent(),
    this.mine = const Value.absent(),
    this.payload = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  MessagesCompanion.insert({
    required String rumorId,
    required String convKey,
    required bool mine,
    required String payload,
    required int createdAt,
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
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (rumorId != null) 'rumor_id': rumorId,
      if (convKey != null) 'conv_key': convKey,
      if (mine != null) 'mine': mine,
      if (payload != null) 'payload': payload,
      if (createdAt != null) 'created_at': createdAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  MessagesCompanion copyWith(
      {Value<String>? rumorId,
      Value<String>? convKey,
      Value<bool>? mine,
      Value<String>? payload,
      Value<int>? createdAt,
      Value<int>? rowid}) {
    return MessagesCompanion(
      rumorId: rumorId ?? this.rumorId,
      convKey: convKey ?? this.convKey,
      mine: mine ?? this.mine,
      payload: payload ?? this.payload,
      createdAt: createdAt ?? this.createdAt,
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
  static const VerificationMeta _npubMeta = const VerificationMeta('npub');
  @override
  late final GeneratedColumn<String> npub = GeneratedColumn<String>(
      'npub', aliasedName, false,
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
  List<GeneratedColumn> get $columns => [npub, name, handle, email, avatarUrl];
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
    if (data.containsKey('npub')) {
      context.handle(
          _npubMeta, npub.isAcceptableOrUnknown(data['npub']!, _npubMeta));
    } else if (isInserting) {
      context.missing(_npubMeta);
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
  Set<GeneratedColumn> get $primaryKey => {npub};
  @override
  ContactRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ContactRow(
      npub: attachedDatabase.typeMapping
          .read(DriftSqlType.string, data['${effectivePrefix}npub'])!,
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
  final String npub;
  final String name;
  final String handle;
  final String email;
  final String avatarUrl;
  const ContactRow(
      {required this.npub,
      required this.name,
      required this.handle,
      required this.email,
      required this.avatarUrl});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['npub'] = Variable<String>(npub);
    map['name'] = Variable<String>(name);
    map['handle'] = Variable<String>(handle);
    map['email'] = Variable<String>(email);
    map['avatar_url'] = Variable<String>(avatarUrl);
    return map;
  }

  ContactsCompanion toCompanion(bool nullToAbsent) {
    return ContactsCompanion(
      npub: Value(npub),
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
      npub: serializer.fromJson<String>(json['npub']),
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
      'npub': serializer.toJson<String>(npub),
      'name': serializer.toJson<String>(name),
      'handle': serializer.toJson<String>(handle),
      'email': serializer.toJson<String>(email),
      'avatarUrl': serializer.toJson<String>(avatarUrl),
    };
  }

  ContactRow copyWith(
          {String? npub,
          String? name,
          String? handle,
          String? email,
          String? avatarUrl}) =>
      ContactRow(
        npub: npub ?? this.npub,
        name: name ?? this.name,
        handle: handle ?? this.handle,
        email: email ?? this.email,
        avatarUrl: avatarUrl ?? this.avatarUrl,
      );
  ContactRow copyWithCompanion(ContactsCompanion data) {
    return ContactRow(
      npub: data.npub.present ? data.npub.value : this.npub,
      name: data.name.present ? data.name.value : this.name,
      handle: data.handle.present ? data.handle.value : this.handle,
      email: data.email.present ? data.email.value : this.email,
      avatarUrl: data.avatarUrl.present ? data.avatarUrl.value : this.avatarUrl,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ContactRow(')
          ..write('npub: $npub, ')
          ..write('name: $name, ')
          ..write('handle: $handle, ')
          ..write('email: $email, ')
          ..write('avatarUrl: $avatarUrl')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(npub, name, handle, email, avatarUrl);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ContactRow &&
          other.npub == this.npub &&
          other.name == this.name &&
          other.handle == this.handle &&
          other.email == this.email &&
          other.avatarUrl == this.avatarUrl);
}

class ContactsCompanion extends UpdateCompanion<ContactRow> {
  final Value<String> npub;
  final Value<String> name;
  final Value<String> handle;
  final Value<String> email;
  final Value<String> avatarUrl;
  final Value<int> rowid;
  const ContactsCompanion({
    this.npub = const Value.absent(),
    this.name = const Value.absent(),
    this.handle = const Value.absent(),
    this.email = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ContactsCompanion.insert({
    required String npub,
    this.name = const Value.absent(),
    this.handle = const Value.absent(),
    this.email = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : npub = Value(npub);
  static Insertable<ContactRow> custom({
    Expression<String>? npub,
    Expression<String>? name,
    Expression<String>? handle,
    Expression<String>? email,
    Expression<String>? avatarUrl,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (npub != null) 'npub': npub,
      if (name != null) 'name': name,
      if (handle != null) 'handle': handle,
      if (email != null) 'email': email,
      if (avatarUrl != null) 'avatar_url': avatarUrl,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ContactsCompanion copyWith(
      {Value<String>? npub,
      Value<String>? name,
      Value<String>? handle,
      Value<String>? email,
      Value<String>? avatarUrl,
      Value<int>? rowid}) {
    return ContactsCompanion(
      npub: npub ?? this.npub,
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
    if (npub.present) {
      map['npub'] = Variable<String>(npub.value);
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
          ..write('npub: $npub, ')
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
  @override
  List<GeneratedColumn> get $columns =>
      [convKey, preview, ts, lastMine, unread];
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
  const ChatRow(
      {required this.convKey,
      required this.preview,
      required this.ts,
      required this.lastMine,
      required this.unread});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['conv_key'] = Variable<String>(convKey);
    map['preview'] = Variable<String>(preview);
    map['ts'] = Variable<int>(ts);
    map['last_mine'] = Variable<bool>(lastMine);
    map['unread'] = Variable<int>(unread);
    return map;
  }

  ChatsCompanion toCompanion(bool nullToAbsent) {
    return ChatsCompanion(
      convKey: Value(convKey),
      preview: Value(preview),
      ts: Value(ts),
      lastMine: Value(lastMine),
      unread: Value(unread),
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
    };
  }

  ChatRow copyWith(
          {String? convKey,
          String? preview,
          int? ts,
          bool? lastMine,
          int? unread}) =>
      ChatRow(
        convKey: convKey ?? this.convKey,
        preview: preview ?? this.preview,
        ts: ts ?? this.ts,
        lastMine: lastMine ?? this.lastMine,
        unread: unread ?? this.unread,
      );
  ChatRow copyWithCompanion(ChatsCompanion data) {
    return ChatRow(
      convKey: data.convKey.present ? data.convKey.value : this.convKey,
      preview: data.preview.present ? data.preview.value : this.preview,
      ts: data.ts.present ? data.ts.value : this.ts,
      lastMine: data.lastMine.present ? data.lastMine.value : this.lastMine,
      unread: data.unread.present ? data.unread.value : this.unread,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ChatRow(')
          ..write('convKey: $convKey, ')
          ..write('preview: $preview, ')
          ..write('ts: $ts, ')
          ..write('lastMine: $lastMine, ')
          ..write('unread: $unread')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(convKey, preview, ts, lastMine, unread);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ChatRow &&
          other.convKey == this.convKey &&
          other.preview == this.preview &&
          other.ts == this.ts &&
          other.lastMine == this.lastMine &&
          other.unread == this.unread);
}

class ChatsCompanion extends UpdateCompanion<ChatRow> {
  final Value<String> convKey;
  final Value<String> preview;
  final Value<int> ts;
  final Value<bool> lastMine;
  final Value<int> unread;
  final Value<int> rowid;
  const ChatsCompanion({
    this.convKey = const Value.absent(),
    this.preview = const Value.absent(),
    this.ts = const Value.absent(),
    this.lastMine = const Value.absent(),
    this.unread = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ChatsCompanion.insert({
    required String convKey,
    this.preview = const Value.absent(),
    this.ts = const Value.absent(),
    this.lastMine = const Value.absent(),
    this.unread = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : convKey = Value(convKey);
  static Insertable<ChatRow> custom({
    Expression<String>? convKey,
    Expression<String>? preview,
    Expression<int>? ts,
    Expression<bool>? lastMine,
    Expression<int>? unread,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (convKey != null) 'conv_key': convKey,
      if (preview != null) 'preview': preview,
      if (ts != null) 'ts': ts,
      if (lastMine != null) 'last_mine': lastMine,
      if (unread != null) 'unread': unread,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ChatsCompanion copyWith(
      {Value<String>? convKey,
      Value<String>? preview,
      Value<int>? ts,
      Value<bool>? lastMine,
      Value<int>? unread,
      Value<int>? rowid}) {
    return ChatsCompanion(
      convKey: convKey ?? this.convKey,
      preview: preview ?? this.preview,
      ts: ts ?? this.ts,
      lastMine: lastMine ?? this.lastMine,
      unread: unread ?? this.unread,
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
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities =>
      [messages, contacts, chats];
}

typedef $$MessagesTableCreateCompanionBuilder = MessagesCompanion Function({
  required String rumorId,
  required String convKey,
  required bool mine,
  required String payload,
  required int createdAt,
  Value<int> rowid,
});
typedef $$MessagesTableUpdateCompanionBuilder = MessagesCompanion Function({
  Value<String> rumorId,
  Value<String> convKey,
  Value<bool> mine,
  Value<String> payload,
  Value<int> createdAt,
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
            Value<int> rowid = const Value.absent(),
          }) =>
              MessagesCompanion(
            rumorId: rumorId,
            convKey: convKey,
            mine: mine,
            payload: payload,
            createdAt: createdAt,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String rumorId,
            required String convKey,
            required bool mine,
            required String payload,
            required int createdAt,
            Value<int> rowid = const Value.absent(),
          }) =>
              MessagesCompanion.insert(
            rumorId: rumorId,
            convKey: convKey,
            mine: mine,
            payload: payload,
            createdAt: createdAt,
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
  required String npub,
  Value<String> name,
  Value<String> handle,
  Value<String> email,
  Value<String> avatarUrl,
  Value<int> rowid,
});
typedef $$ContactsTableUpdateCompanionBuilder = ContactsCompanion Function({
  Value<String> npub,
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
  ColumnFilters<String> get npub => $composableBuilder(
      column: $table.npub, builder: (column) => ColumnFilters(column));

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
  ColumnOrderings<String> get npub => $composableBuilder(
      column: $table.npub, builder: (column) => ColumnOrderings(column));

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
  GeneratedColumn<String> get npub =>
      $composableBuilder(column: $table.npub, builder: (column) => column);

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
            Value<String> npub = const Value.absent(),
            Value<String> name = const Value.absent(),
            Value<String> handle = const Value.absent(),
            Value<String> email = const Value.absent(),
            Value<String> avatarUrl = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              ContactsCompanion(
            npub: npub,
            name: name,
            handle: handle,
            email: email,
            avatarUrl: avatarUrl,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String npub,
            Value<String> name = const Value.absent(),
            Value<String> handle = const Value.absent(),
            Value<String> email = const Value.absent(),
            Value<String> avatarUrl = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              ContactsCompanion.insert(
            npub: npub,
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
  Value<int> rowid,
});
typedef $$ChatsTableUpdateCompanionBuilder = ChatsCompanion Function({
  Value<String> convKey,
  Value<String> preview,
  Value<int> ts,
  Value<bool> lastMine,
  Value<int> unread,
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
            Value<int> rowid = const Value.absent(),
          }) =>
              ChatsCompanion(
            convKey: convKey,
            preview: preview,
            ts: ts,
            lastMine: lastMine,
            unread: unread,
            rowid: rowid,
          ),
          createCompanionCallback: ({
            required String convKey,
            Value<String> preview = const Value.absent(),
            Value<int> ts = const Value.absent(),
            Value<bool> lastMine = const Value.absent(),
            Value<int> unread = const Value.absent(),
            Value<int> rowid = const Value.absent(),
          }) =>
              ChatsCompanion.insert(
            convKey: convKey,
            preview: preview,
            ts: ts,
            lastMine: lastMine,
            unread: unread,
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

class $AppDbManager {
  final _$AppDb _db;
  $AppDbManager(this._db);
  $$MessagesTableTableManager get messages =>
      $$MessagesTableTableManager(_db, _db.messages);
  $$ContactsTableTableManager get contacts =>
      $$ContactsTableTableManager(_db, _db.contacts);
  $$ChatsTableTableManager get chats =>
      $$ChatsTableTableManager(_db, _db.chats);
}
