part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// [CHAT-THREAD-SPLIT-3] DM/group/tel thread setup, read receipts, backfills and hydration.
extension _ChatThreadSetup on _ChatThreadScreenState {

  void _markRead() {
    final key = _convKey;
    if (key == null) return;
    // [PUSH-FG-BANNER-1 2026-07-14] Claim this thread as the one on screen, so
    // the foreground FCM handler suppresses the banner for THIS conversation and
    // only this one. Hooked here rather than at each `_convKey = …` assignment
    // because `_markRead` is already the single point every thread flavour (DM,
    // group, tel/voicemail) reaches once its key is known, and it re-fires on
    // every incoming message — so the claim self-heals if anything clears it.
    // `ActiveThread` is only consulted together with `lifecycleState == resumed`,
    // so a claim left standing while the screen is off cannot silence anything.
    ActiveThread.enter(key);
    // [AVAVM-PLAYER-1] Same "single point every thread flavour reaches" logic
    // as the ActiveThread claim above — remember this convKey's Chat so the
    // shell-level mini-player can reopen this exact thread on tap.
    ChatThreadRegistry.remember(key, widget.chat);
    final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    // Local: drives unread badges on THIS device (instant).
    //
    // [ISSUE-BADGE-UNREAD-1] Reading a thread must walk the launcher badge DOWN
    // (owner: "this number should ... reduce with the number of messages read").
    // BadgeService counts messages newer than this conversation's read high-water
    // mark, so the recompute is CHAINED OFF the setRead write — kicking it off in
    // parallel would race and re-read the pre-write mark, leaving the badge stuck
    // one beat behind.
    ReadStateStore().setRead(key, nowSec).then((_) {
      _badgeTimer?.cancel();
      _badgeTimer = Timer(const Duration(milliseconds: 800),
          () => BadgeService.recompute(source: 'thread_marked_read'));
    }, onError: (Object _) {});
    // Server: persist MY read position in my own InboxDO so a fresh login or a
    // second device (e.g. desktop) restores it and stops recounting already-read
    // messages as new. Best-effort — never blocks the UI.
    //
    // COALESCE the server POST: _markRead fires on init, on every incoming
    // message, and on each Ava stream frame, so an un-debounced POST-per-call
    // turns a brief token gap (e.g. just after a backgrounded app-connect OAuth
    // round-trip) into a 401 STORM that blanks the thread. Debounce to at most
    // one POST every few seconds; only the latest read position matters anyway.
    final myUid = _meId?.uid;
    if (myUid == null || myUid.isEmpty) return;
    final conv = serverConvFromKey(key, myUid);
    if (conv == null) return;
    _markReadTimer?.cancel();
    _markReadTimer = Timer(const Duration(seconds: 3), () {
      final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      ApiAuth.postJson(kMsgReadUrl, {'conv': conv, 'read_ts': ts})
          .then((_) {}, onError: (_) {});
      // DURABLE read receipt to the PEER (1:1) so their bubbles turn blue (Read)
      // even if they're offline now — they pick it up on their next /sync. The
      // ephemeral presence read only worked when both were online at once, which
      // is why ticks were stuck on "Sent" (owner report 2026-06-27).
      if (_dm != null) _dm!.sendReceipt('read', ts);
      // [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1] "read" half of the group receipt —
      // mirrors the 1:1 `sendReceipt('read', ts)` call directly above. Group the
      // currently-rendered, not-mine, non-system messages by their ORIGINAL
      // sender (bySender) so this is one POST per distinct sender, not one per
      // message — `AvaGroupDm.sendMsgReceipt` already documents why (only the
      // author's own InboxDO needs to learn who has seen their message).
      if (_isGroup && _gdm != null && RemoteConfig.groupReceiptsEnabled) {
        final bySender = <String, List<String>>{};
        for (final msg in _msgs) {
          if (msg.me || msg.system || msg.evId == null) continue;
          final sender = msg.senderPub;
          if (sender == null || sender.isEmpty) continue;
          (bySender[sender] ??= []).add(msg.evId!);
        }
        if (bySender.isNotEmpty) {
          _gdm!.sendMsgReceipt('read', bySender);
          Analytics.capture('chat_group_receipt_sent', {
            'status': 'read', 'senders': bySender.length,
            'mids': bySender.values.fold<int>(0, (n, l) => n + l.length),
            'gid': widget.chat.gid ?? '',
          });
        }
      }
    });
  }

  /// PartyKit live layer for THIS conversation (ephemeral; gated by RemoteConfig
  /// `partyEnabled` — a dormant no-op until the PartyDO is deployed + flipped on,
  /// so this is safe to ship dark). Joins `thread:<serverConv>` and reacts to the
  /// live events the Worker broadcasts. Today it handles the marketplace
  /// `deal_ready` nudge — the instant the negotiation result lands in our InboxDO,
  /// pull it NOW (forceResync) so the card appears without waiting out the poll.
  /// Typing / receipt / reaction rendering hang off this same room next.
  void _partyJoin(String myUid) {
    final key = _convKey;
    if (key == null || myUid.isEmpty) return;
    final conv = serverConvFromKey(key, myUid);
    if (conv == null) return;
    try {
      final room = PartyHub.I.join('thread:$conv');
      _party = room;
      _partySub = room.events.listen((e) {
        final t = e['t'];
        if (t == 'new') {
          // P13-B PartyKit delivery hint: a peer just sent to this thread. Do a
          // targeted cursor sync NOW instead of waiting for the hub frame. Hint
          // only — InboxDO is the source of truth, so a missed hint is harmless.
          try { SyncHub.I.syncFromPush(); } catch (_) {}
        } else if (t == 'deal_ready') {
          try { SyncHub.I.forceResync(); } catch (_) {} // marketplace card lands instantly
        } else if (t == 'reaction') {
          _applyPartyReaction(e); // live per-message reaction (#4)
        } else if (t == 'burst') {
          final em = e['emoji']?.toString();
          if (em != null && em.isNotEmpty) _spawnBurst(em); // floating-emoji burst
        }
      });
    } catch (_) {/* party is best-effort */}
  }

  void _setupDm(Identity id) {
    if (widget.chat.gid != null) { _setupGroup(id); return; }
    if (widget.chat.group) return; // legacy local group
    final seed = widget.chat.seed;
    final tel = telPhone(seed);
    if (tel != null) { _setupTelThread(id, tel); return; } // unknown-number voicemail
    final peerHex = seed;
    if (peerHex.isEmpty) return; // no addressable peer id → keep local echo
    _realMode = true;
    _mutMsgs(() => _msgs.clear()); // drop demo seed; history loads from relay
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _dm = AvaDm(client: _nostr!, myPriv: id.uid, myPub: id.uid, peerPub: peerHex);
    _dm!.messages.listen(_onDm);
    _dm!.sendStatus.listen(_onSendStatus);
    _dm!.start();
    _presenceMe = id.shortId;
    _presence = PresenceChannel(PresenceChannel.roomFor1on1(id.uid, peerHex), id.shortId,
        convKey: '1:$peerHex', peerUid: peerHex)..connect();
    _presence!.events.listen(_onPresence);
    _presence!.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
    if (_sharePresence) _presence!.sendOnline();
    _startPresenceHeartbeat();
    _loadLastSeen();
    _peerNpub = seed; // contact uid, for message notifications
    _convKey = '1:$peerHex';
    // STREAM B (SAFE-GATE-1/2): compute the SERVER conv id (dm_lo__hi) and, for a
    // non-contact peer, gate the thread. Fire-and-forget; the gate bar renders
    // once _strangerGatePending flips true.
    _serverConv = dmConvIdFor(id.uid, peerHex);
    _initStrangerGate(peerHex);
    _partyJoin(id.uid); // PartyKit live layer (deal-ready nudge etc.); no-op until flag on
    _loadGuardian();
    onSummonAva = AvaInvoke.makeHandler(_convKey!); // Phase 11: @ava → in-thread turn
    _initAvaChatState(); // Phase A: load "Ava in this chat" + reset ava_unread
    _bindLocalAva(); // render on-device @ava answers when Local Ava AI is active
    _bindAvaStream(); // render LIVE server @ava answers as they stream in
    // Seed instantly from the shared hub's in-memory store (this session).
    for (final m in SyncHub.I.messagesFor(_convKey!)) _onDm(m, seed: true);
    // Durable history from the local SQLite DB — the source of truth. Covers
    // messages received in PAST sessions while this thread was closed (the hub
    // stored them in the DB even though no open thread cached them). _onDm dedups
    // by rumor id, so this never double-renders what's already shown.
    Db.I.messagesFor(_convKey!).then((rows) {
      if (!mounted) return;
      for (final m in rows) {
        _onDm(DmMessage(rumorId: m.rumorId, mine: m.mine, payload: m.payload, createdAt: m.createdAt), seed: true);
      }
      _jumpToEndSettled(); // open ON the latest message, not mid-thread
      // STREAM B: re-evaluate the stranger gate now that history (inbound/outbound)
      // is loaded — the initial call ran before _msgs was populated.
      _initStrangerGate(peerHex);
    });
    // Restore persisted delivery/read marks so ticks are correct immediately on
    // reopen (before any fresh receipt arrives) — survives app restarts.
    ReceiptStore().get(_convKey!).then((r) {
      if (!mounted) return;
      setState(() {
        if (r.delivered > _peerDeliveredTs) _peerDeliveredTs = r.delivered;
        if (r.read > _peerReadTs) _peerReadTs = r.read;
      });
    });
    _markRead();
    _loadChatExtras();
    _loadCachedMessages();
  }

  /// Set up a READ-ONLY unknown-number receptionist thread. The caller has no
  /// AvaTOK account, so there is no live peer to message — this is purely the
  /// owner's voicemail record. We load the stored receptionist cards from the
  /// hub + local DB under the deterministic `g:recept_<me>__tel:<phone>` key and
  /// decide whether to show the "Save to contacts" affordances.
  void _setupTelThread(Identity id, String phone) {
    _realMode = true;
    _isTelThread = true;
    _telPhone = phone;
    _convKey = receptTelConvKey(id.uid, phone);
    _mutMsgs(() => _msgs.clear());
    // Seed from the in-memory hub store, then durable history from SQLite.
    for (final m in SyncHub.I.messagesFor(_convKey!)) _onDm(m, seed: true);
    Db.I.messagesFor(_convKey!).then((rows) {
      if (!mounted) return;
      for (final m in rows) {
        _onDm(DmMessage(rumorId: m.rumorId, mine: m.mine, payload: m.payload, createdAt: m.createdAt), seed: true);
      }
      _jumpToEndSettled();
    });
    // Is this caller already a saved contact? (A provisional `tel:` row counts
    // as "in the list" but NOT as saved until the owner names them.)
    ContactsStore().load().then((cs) {
      if (!mounted) return;
      setState(() => _callerSaved = callerIsSaved(cs, phone));
    });
    _markRead();
    _loadChatExtras();
  }

  Future<void> _loadChatExtras() async {
    final key = _convKey;
    if (key == null) return;
    // [AVA-MEDIA-JOB-2] Hydrate + reconcile this conversation's durable AI
    // media jobs (image/doc/audio) now that a conv id is known, then
    // explicitly seed a card for every job already known — required even
    // though [_bindAiJobs]'s update stream ALSO fires on hydrate/reconcile,
    // because a job whose state hasn't changed since a prior visit this
    // session is a no-op in the repository's dedup (`_apply` only notifies on
    // a VISIBLE change) and would otherwise never get a card in a freshly
    // rebuilt `_msgs` list. Fire-and-forget: never blocks the rest of this
    // thread's setup.
    unawaited(_openAiJobs(_serverConvId ?? key));
    final draft = (await DraftStore().load())[key];
    final timer = (await ChatTimerStore().load())[key];
    final pin = (await PinnedMsgStore().load())[key];
    final wp = await WallpaperStore().load();
    if (!mounted) return;
    setState(() {
      if (draft != null && draft.isNotEmpty && _ctrl.text.isEmpty) { _ctrl.text = draft; _hasText = true; }
      _disappearSecs = int.tryParse(timer ?? '') ?? 0;
      _wallpaperId = wp[key] ?? wp['global'] ?? 'default';
      try { _pinned = pin != null ? (jsonDecode(pin) as Map).cast<String, String>() : null; } catch (_) {}
    });
    if (_isGroup) {
      final contacts = await ContactsStore().load();
      final names = <String, String>{};
      final avatars = <String, String>{}; // [AVAGRP-BUBBLE-1] uid → photo URL
      for (final c in contacts) {
        names[c.uid] = c.name;
        if (c.avatarUrl.isNotEmpty) avatars[c.uid] = c.avatarUrl;
      }
      if (_meId != null) names[_meId!.uid] = 'You';
      // Merge (don't replace): keep any names/avatars already learned from
      // early live reactions / messages (keyed by uid) — Phase 5.
      // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) bump `_msgsRev` here too:
      // `_memberNames`/`_memberAvatars` are read inside `_bubble()` (sender
      // name/avatar), but `_MessageRow` only re-invokes `_bubble()` when
      // `_msgsRev` changes — a plain `setState()` left every already-cached
      // group row showing the placeholder initial/uid forever, even after
      // resolution completed. This is coarse (invalidates every cached row,
      // same as any other `_msgsRev` bump) but cheap and rare — it fires once
      // per thread open, not per message.
      if (mounted) setState(() { _memberNames.addAll(names); _memberAvatars.addAll(avatars); _msgsRev++; });
      // [AVA-GRP-UI] Members you haven't saved as contacts have no local photo,
      // so their bubbles showed a bare initial. Resolve their profile photo from
      // the directory in the background and load it via the cached Avatar pipeline.
      unawaited(_backfillMemberAvatars());
    }
    // 2026-07-04: hydrate server-persisted poll tallies for this conversation so
    // a reinstalled / new device shows correct counts + my selection + who-voted.
    unawaited(_hydratePolls());
  }

  /// [AVA-GRP-UI] Backfill group-member profile PHOTOS for members the local
  /// user hasn't saved as a contact. `_memberAvatars` is otherwise seeded only
  /// from `ContactsStore`, so a member not in your contacts rendered a bare
  /// initial ("P") in their bubble instead of their photo. Resolve each missing
  /// member through the directory (Clerk uid → profile photo) and merge the URL
  /// in; the `Avatar` widget (`core/avatar.dart`) then loads it through the
  /// normal cached Cloudflare-AVIF pipeline like every other avatar. Best-effort
  /// and cheap: `Directory.resolve` has a 24h per-account negative cache, so a
  /// member with no directory photo is queried at most once a day. State is
  /// in-memory only (`_memberAvatars`/`_memberNames`), so no per-account
  /// persisted store to scope here.
  Future<void> _backfillMemberAvatars() async {
    final members = _group?.members;
    if (members == null || members.isEmpty) return;
    final myUid = _meId?.uid;
    for (final uid in members) {
      if (uid.isEmpty || uid == myUid) continue;
      if (_memberAvatars[uid]?.isNotEmpty ?? false) continue; // already have a photo
      Contact? c;
      try {
        c = await Directory.resolve(uid);
      } catch (_) {
        c = null; // transient — leave the initial fallback, try again next open
      }
      if (!mounted) return;
      if (c == null) continue;
      final gotPhoto = c.avatarUrl.isNotEmpty && !(_memberAvatars[uid]?.isNotEmpty ?? false);
      final gotName = c.name.isNotEmpty &&
          (_memberNames[uid] == null || _memberNames[uid]!.isEmpty);
      if (gotPhoto || gotName) {
        // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) same reasoning as the
        // `_loadChatExtras` merge above — bump `_msgsRev` so cached rows for
        // this member re-render with the resolved photo/name.
        setState(() {
          if (gotPhoto) _memberAvatars[uid] = c!.avatarUrl;
          if (gotName) _memberNames[uid] = c!.name;
          _msgsRev++;
        });
      }
    }
  }

  // ── [AVAGRP-SENDERPUB-BACKFILL-1] historical `senderPub` repair ─────────────
  //
  // THE BUG: group bubbles from Tue 2026-07-14 → Thu 2026-07-16 render the
  // letter "P" instead of the sender's photo. `_bubbleAvatar`'s fallback chain
  // ends in the literal 'peer' → `Avatar` draws its initial. That branch is only
  // reachable when `m.senderPub` is empty (`_groupLabelFor` returns null for an
  // empty uid, so `senderLabel` is null too, and `_memberAvatars[pub]` can never
  // be keyed).
  //
  // WHY THOSE ROWS ARE EMPTY: `[AVAGRP-DBPUB-1]` only STARTED persisting
  // `senderPub` (Messages column v8). Rows written by earlier builds read back
  // NULL → ''. The JSON disk cache has the same hole (caches written by older
  // builds carry no `senderPub` key), so BOTH local replay sources are blank and
  // no amount of reopening fixes it. The server is fine — `inbox.ts` has stored
  // `sender` on every row all along.
  //
  // WHY RE-SYNCING CANNOT FIX IT (the trap): `Db.upsertMessage` is
  // `insertOrIgnore`. Re-ingesting a message the DB already holds keeps the OLD
  // row, so `senderPub` stays NULL. `_onGroupMsg` likewise returns early on
  // `_seenEv`, so re-feeding a repaired frame would not re-render either. The
  // repair therefore has to UPDATE the row (`Db.setSenderPub`) and mutate the
  // already-rendered `_Msg` in place — which is why those two fields lost their
  // `final`.
  //
  // THE SOURCE: `GET /api/msg/sync?cursor=0` (worker `syncMsg` →
  // `InboxDO.syncPayload`) returns this account's own backlog with `sender` on
  // every row. It is ALREADY reachable from the client with no worker change —
  // `inbox_api.dart` (AvaDial) calls the same route. Deliberately NOT the WS
  // `SyncHub` cursor: that is shared app-lifetime state, and rewinding it to 0
  // would re-drive every listener (unread recount, preview bumps, delete
  // re-application) for the whole account. This is a plain read-only HTTP GET
  // that touches nothing but the rows it repairs.
  //
  // NO KILL SWITCH, deliberately. The FAKE-FLAG rule in CLAUDE.md means a real
  // flag needs a `config.ts` DEFAULTS entry + a worker deploy to be flippable,
  // and this repair does not warrant one: it is read-only on the server, runs at
  // most once per conversation, only ever fills empty fields, cannot duplicate a
  // bubble (`_seenEv`), cannot lose one (it never deletes or reorders), and
  // degrades to today's exact behaviour on any failure. The self-limiting guards
  // below ARE the brake.
  //
  // State is a per-account DiskCache key: `DiskCache` writes under
  // `cache/<AccountScope.id>/`, so the marker is namespaced per account by
  // construction and cannot leak between the parent/child accounts sharing a
  // phone (CLAUDE.md rule 1).

  Future<Set<String>> _senderPubRepairedConvs() async {
    try {
      final raw = await DiskCache.read(_kSenderPubRepairKey);
      if (raw == null || raw.isEmpty) return {};
      final l = jsonDecode(raw);
      if (l is List) return l.map((e) => e.toString()).toSet();
    } catch (_) { /* unreadable marker ⇒ treat as unrepaired; worst case one extra GET */ }
    return {};
  }

  Future<void> _markSenderPubRepaired(String gid) async {
    try {
      final s = await _senderPubRepairedConvs();
      if (!s.add(gid)) return;
      await DiskCache.write(_kSenderPubRepairKey, jsonEncode(s.toList()));
    } catch (_) { /* best-effort; a lost marker only costs one repeat GET */ }
  }

  /// One-shot, per-conversation, best-effort repair of blank `senderPub` on
  /// historical group bubbles. Never blocks the thread opening (fired via
  /// `unawaited` after both replay sources have landed), never throws.
  Future<void> _backfillSenderPubs() async {
    if (!_isGroup || !mounted) return;
    final gid = _group?.id;
    if (gid == null || gid.isEmpty) return;

    // Cheapest guard FIRST: a healthy thread does zero I/O and never marks
    // itself, so this stays inert for every user who has no damaged rows.
    final stuck = _msgs
        .where((m) =>
            !m.me &&
            !m.system &&
            (m.senderPub?.isEmpty ?? true) &&
            (m.evId?.isNotEmpty ?? false))
        .toList();
    if (stuck.isEmpty) return;

    // One-shot per conversation: rows the server can no longer show us (older
    // than the DO's 500-row SYNC_LIMIT window, or purged) would otherwise re-ask
    // on every single open, forever.
    if ((await _senderPubRepairedConvs()).contains(gid)) return;
    if (!mounted) return;

    final scanned = stuck.length;
    var recovered = 0;
    final resolvedUids = <String>{};
    try {
      final res = await ApiAuth.getSigned('$kMsgSyncUrl?cursor=0');
      if (res.statusCode != 200 || !mounted) return; // transient → retry next open, stay unmarked
      final body = jsonDecode(res.body);
      final rows = (body is Map ? body['messages'] : null);
      if (rows is! List) return;

      // rumorId is derived EXACTLY as `SyncHub._ingestMsg` and
      // `_ingestArchiveRow` derive it, so these keys line up with `_Msg.evId`.
      final byRumor = <String, String>{};
      for (final r in rows) {
        if (r is! Map) continue;
        if ((r['conv'] ?? '').toString() != gid) continue; // this thread only
        final sender = (r['sender'] ?? '').toString();
        if (sender.isEmpty) continue;
        final clientId = (r['client_id'] ?? '').toString();
        final id = (r['id'] as num?)?.toInt() ?? 0;
        byRumor[clientId.isNotEmpty ? clientId : 'srv_$id'] = sender;
      }

      final myUid = _meId?.uid ?? '';
      final patch = <String, String>{};
      for (final m in stuck) {
        final sender = byRumor[m.evId];
        // `sender == myUid` ⇒ my own row misfiled as inbound. Leave it: every
        // consumer keys "is this mine" off `mine`, and the whole codebase's
        // convention is `senderPub: ''` for own rows.
        if (sender == null || sender.isEmpty || sender == myUid) continue;
        patch[m.evId!] = sender;
      }

      if (patch.isNotEmpty) {
        _mutMsgs(() {
          for (final m in stuck) {
            final s = patch[m.evId];
            if (s == null) continue;
            m.senderPub = s;
            // Recompute the label the same way `_onGroupMsg` does — it was null
            // only because the uid behind it was missing.
            m.senderLabel ??= _groupLabelFor(s);
            recovered++;
            resolvedUids.add(s);
          }
        });
        // Durable half: UPDATE (not upsert — see `Db.setSenderPub`) so the fix
        // survives a restart even if the JSON cache is later evicted.
        for (final e in patch.entries) {
          try { await Db.I.setSenderPub(e.key, e.value); } catch (_) { /* row repaired in memory regardless */ }
        }
        _schedulePersist(); // rewrite the JSON cache WITH senderPub this time
        // Members whose photo we never fetched (they aren't saved contacts) can
        // now be resolved — the map is keyed by uid, which we finally have.
        unawaited(_backfillMemberAvatars());
      }
      await _markSenderPubRepaired(gid);
    } catch (_) {
      return; // degrade silently — the bubbles look exactly as they do today
    }

    // Two-sided by design: a group thread is a conversation, so the resolved
    // sender uids are tagged here to let EITHER party's telemetry retrieve the
    // interaction. The viewer's own email/platform is auto-stamped by
    // `Analytics._base` — never hand-add it (CLAUDE.md).
    Analytics.capture('grp_senderpub_backfill', {
      'gid': gid,
      'scanned': scanned,
      'recovered': recovered,
      'skipped_unresolvable': scanned - recovered,
      'sender_uids': resolvedUids.take(25).toList(),
      'sender_count': resolvedUids.length,
    });
  }

  /// Batch-fetch every poll's tally for THIS conversation from the server and
  /// merge it into the loaded poll bubbles. Runs on open (after cache load) and
  /// again when a new poll bubble arrives. Server is the source of truth — this
  /// replaces the local tally rather than adding to it, so reinstalled devices
  /// converge to the real counts. Best-effort; a failure leaves live-only tallies.
  Future<void> _hydratePolls() async {
    final conv = _serverConvId;
    if (conv == null) return;
    try {
      final res = await ApiAuth.getSigned('$kPollStateUrl?conv=${Uri.encodeComponent(conv)}');
      if (res.statusCode != 200 || !mounted) return;
      final polls = (jsonDecode(res.body)['polls'] as Map?) ?? const {};
      if (polls.isEmpty) return;
      final myUid = _meId?.uid ?? '';
      _mutMsgs(() {
        for (final m in _msgs) {
          if (m.special != 'poll') continue;
          final id = m.extra?['id']?.toString();
          if (id == null) continue;
          final p = polls[id];
          if (p is! Map) continue;
          final counts = (p['counts'] as Map?) ?? const {};
          final voters = (p['voters'] as Map?) ?? const {};
          m.pollVotes = {};
          m.pollBy = {};
          m.pollMine = {};
          counts.forEach((k, v) {
            final idx = int.tryParse(k.toString());
            if (idx != null) m.pollVotes[idx] = (v as num).toInt();
          });
          voters.forEach((k, v) {
            final idx = int.tryParse(k.toString());
            if (idx == null || v is! List) return;
            final set = v.map((e) => e.toString()).toSet();
            m.pollBy[idx] = set;
            if (myUid.isNotEmpty && set.contains(myUid)) m.pollMine.add(idx);
          });
        }
      });
    } catch (_) { /* best-effort; live-only tallies remain */ }
  }

  void _watchGroupChanges(String myUid) {
    _groupChangeSub ??= GroupStore.changes.listen((changedId) async {
      final gid = widget.chat.gid;
      if (gid == null || !mounted) return;
      if (changedId != gid && changedId != GroupStore.anyGroup) return;
      final g = await GroupStore().byId(gid);
      if (!mounted || g == null) return;
      setState(() {
        _group = g;
        _memberUids = g.members.where((m) => m != myUid).toList();
      });
    });
  }

  Future<void> _setupGroup(Identity id) async {
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    _realMode = true;
    _isGroup = true;
    _group = g;
    Analytics.capture('group_thread_opened', {'gid': g.id, 'member_count': g.members.length});
    _mutMsgs(() => _msgs.clear());
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _gdm = AvaGroupDm(group: g);
    _gdm!.messages.listen(_onGroupMsg);
    // [AVA-GRP-SENDSTATE] Bridge the outbox ACK/give-up stream to the same handler
    // the DM path uses, so a group bubble flips "Sending…" → "Sent" on the real
    // HTTP-200 ACK (and "Not sent" only on a terminal give-up). Without this a
    // delivered group message never left the pending state and was later mis-shown
    // as "NOT SENT · tap to retry" on reopen.
    _gdm!.sendStatus.listen(_onSendStatus);
    _gdm!.start();
    _presenceMe = id.shortId;
    _presence = PresenceChannel(PresenceChannel.roomForGroup(g.id), id.shortId,
        convKey: 'g:${g.id}')..connect();
    _presence!.events.listen(_onPresence);
    _startPresenceHeartbeat();
    _memberUids = g.members.where((m) => m != id.uid).toList();
    _convKey = 'g:${g.id}';
    _watchGroupChanges(id.uid);
    // [AVABRAIN-COMPANION-UI-1] Group Companion draft cards — group threads
    // only, fetched once on open (feature-detects a 404 → does nothing if the
    // server route/flag isn't live).
    unawaited(_fetchCompanionDrafts());
    _loadGuardian();
    onSummonAva = AvaInvoke.makeHandler(_convKey!); // Phase 11: @ava → in-thread turn
    _initAvaChatState(); // Phase A: load "Ava in this chat" + reset ava_unread
    _bindLocalAva(); // render on-device @ava answers when Local Ava AI is active
    _bindAvaStream(); // render LIVE server @ava answers as they stream in
    _markRead();
    _loadChatExtras();
    // [AVAGRP-BUBBLE-2 §6] SEQUENCED, not fire-and-forget: the JSON cache below
    // carries a correct `senderPub` per message (persisted since [AVAGRP-BUBBLE-1]
    // — see `_persistNow`/`fromJson`), and both calls dedup via `_seenEv`/
    // `_onGroupMsg`'s `if (_seenEv.contains(rumorId)) return`, so WHICHEVER ONE
    // RUNS FIRST for a given message wins and the second is silently skipped.
    // [AVAGRP-DBPUB-1] The DB replay below now ALSO carries a real `senderPub`
    // (persisted on `Messages` — see the column doc in `db.dart`), so the race
    // this comment used to warn about no longer has a losing side: whichever
    // source wins, the rendered bubble gets the correct avatar/tint. The cache
    // is still awaited first on purpose — it carries fields the DB doesn't
    // (readBy/deliveredTo/pending/etc.), not because it's the only correct
    // source of `senderPub` anymore. Do not remove this sequencing.
    _loadCachedMessages().then((_) {
      if (!mounted) return;
      // Durable group history from local SQLite — the source of truth that
      // survives restarts WITHOUT re-downloading the backlog (cursor sync).
      // [AVAGRP-DBPUB-1] `senderPub` now comes from the DB column (populated by
      // `SyncHub._ingestMsg`); pre-migration rows read back NULL and fall
      // through to `''`, which every consumer already treats as "unknown
      // sender" (no avatar/tint, not a crash). _onGroupMsg dedups by rumor id,
      // so this never double-renders what's already shown by the cache.
      Db.I.messagesFor(_convKey!).then((rows) {
        if (!mounted) return;
        for (final m in rows) {
          // [AVAGRP-DBPUB-1] Same convention as the live/`_ingestArchiveRow`
          // paths ([GroupMessage] is always constructed with `senderPub: ''`
          // for `mine` rows) — the UI already keys "is this my own bubble" off
          // `mine`, not `senderPub`, so blanking it here just avoids handing a
          // real uid through a field every downstream reader treats as "not
          // mine ⇒ look up avatar/tint".
          _onGroupMsg(GroupMessage(
              rumorId: m.rumorId, senderPub: m.mine ? '' : (m.senderPub ?? ''), mine: m.mine,
              payload: m.payload, createdAt: m.createdAt));
        }
        // [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1 §Hydrate] Backfill the Info sheet
        // for already-rendered OWN messages on cold open — otherwise a message
        // sent in a past session shows "No read receipts yet" until a NEW live
        // receipt happens to arrive, even if every peer read it while the
        // thread was closed. Runs after BOTH replay sources have landed so the
        // mid list is complete. Best-effort; never blocks the thread opening.
        if (RemoteConfig.groupReceiptsEnabled) unawaited(_hydrateMsgReceipts());
        // [AVAGRP-SENDERPUB-BACKFILL-1] Repair history rows whose `senderPub`
        // predates the v8 column (they render as the 'P' initial with no photo
        // and no per-member tint). Must run HERE — after BOTH the JSON cache and
        // the DB replay have landed — so it sees the complete `_msgs` list and
        // doesn't ask the server about rows the cache was about to resolve.
        // `unawaited` + fully self-guarded: never blocks the thread opening.
        unawaited(_backfillSenderPubs());
      });
    });
    // Let replayed group history settle before indexing LIVE messages into RAG.
    Future.delayed(const Duration(seconds: 3), () { if (mounted) _ragLive = true; });
  }

  /// [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1 §Hydrate] `GET /api/msg/seen` for every
  /// currently-rendered message I SENT in this group — the Info sheet only
  /// applies to my own messages (§4/WhatsApp-parity), so that's the only set
  /// worth hydrating. Server contract: `{receipts:[{msg_id,peer,status,ts},...]}`.
  Future<void> _hydrateMsgReceipts() async {
    if (!_isGroup || !mounted) return;
    final conv = _group?.id;
    if (conv == null) return;
    final mids = _msgs.where((m) => m.me && m.evId != null).map((m) => m.evId!).toSet().toList();
    if (mids.isEmpty) return;
    try {
      final res = await ApiAuth.getSigned(
          '$kApiBase/msg/seen?conv=${Uri.encodeComponent(conv)}&mids=${Uri.encodeComponent(mids.join(','))}');
      if (res.statusCode != 200 || !mounted) return;
      final body = jsonDecode(res.body);
      final receipts = (body is Map ? body['receipts'] : null);
      if (receipts is! List) return;
      _mutMsgs(() {
        for (final r in receipts) {
          if (r is! Map) continue;
          final mid = (r['msg_id'] ?? '').toString();
          final peer = (r['peer'] ?? '').toString();
          final status = (r['status'] ?? '').toString();
          final ts = (r['ts'] as num?)?.toInt() ?? 0;
          if (mid.isEmpty || peer.isEmpty) continue;
          final i = _msgs.indexWhere((m) => m.evId == mid);
          if (i < 0) continue;
          if (status == 'read') {
            _msgs[i].readBy[peer] = ts;
            _msgs[i].deliveredTo.putIfAbsent(peer, () => ts);
          } else if (status == 'delivered') {
            _msgs[i].deliveredTo[peer] = ts;
          }
        }
      });
      _schedulePersist();
    } catch (e) {
      // [AVA-GRP-SENDSTATE] Surface hydration failures instead of swallowing them
      // silently — an empty Info sheet on a message everyone has read is exactly
      // the symptom the owner hit, and a failing `GET /api/msg/seen` is one cause
      // that was previously invisible. Best-effort still: live receipts keep
      // arriving over the wire regardless. Email auto-attached by Analytics._base.
      Analytics.capture('grp_receipt_hydrate_failed', {
        'gid': widget.chat.gid ?? '',
        'err': e.toString().length > 120 ? e.toString().substring(0, 120) : e.toString(),
      });
    }
  }
}
