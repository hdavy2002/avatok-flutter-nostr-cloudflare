part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadSpecial on _ChatThreadScreenState {

  // ---- media send + retry ----
  String _caption(MediaKind k, String name) => switch (k) {
        MediaKind.image => '📷 Photo',
        MediaKind.video => '🎬 Video',
        MediaKind.audio => '🎙️ Voice message',
        MediaKind.file => '📎 $name',
      };

  // ---- special message types: location / contact card / poll / sticker ----
  String _specialCaption(String type, Map<String, dynamic> e) => switch (type) {
        'loc' => '📍 Location',
        'live' => '📍 Live location',
        'card' => '👤 ${e['name'] ?? 'Contact'}',
        'poll' => '📊 ${e['q'] ?? 'Poll'}',
        'sticker' => (e['emoji'] ?? '🙂').toString(),
        'gcall' => e['kind'] == 'audio' ? '🎙️ Audio call' : '📹 Video call',
        // Ava kinds (Phase 0 contract) — caption used for chat-list previews etc.
        'ava' || 'ava_private' => (e['text'] ?? e['body'] ?? 'Ava').toString(),
        'ava_status' => (e['label'] ?? 'Ava is working…').toString(),
        'recept' => (e['text'] ?? '📞 Ava took a message').toString(),
        'marketplace_deal' => '🤝 ${e['outcome'] == 'deal' ? 'Agents reached a deal' : 'Agents finished negotiating'}',
        // [DIALPAD-BIZ-CALLS] WP6 — voicemail/agent_transcript envelopes already
        // carry a server-composed `text` (see do/voicemail_room.ts postVoicemail /
        // do/agent_voice_room.ts finalize), so reuse it verbatim for the chat-list
        // preview instead of a generic fallback.
        'voicemail' => (e['text'] ?? '📞 New voicemail').toString(),
        'agent_transcript' => (e['text'] ?? '🤖 Ava AI Agent call').toString(),
        _ => '',
      };

  void _notifyRecipients() {
    if (_isGroup) {
      PushService.notifyMessage(_memberUids, _myName ?? 'AvaTOK');
    } else if (_peerNpub != null) {
      PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK');
    }
  }

  void _sendSpecial(String type, Map<String, dynamic> data, String caption) {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final payload = {'t': type, ...data, if (_isGroup) ...{'gid': _group!.id, 'fromName': _fromNameTag}};
    String id;
    if (_isGroup && _gdm != null) {
      id = _gdm!.send(jsonEncode(payload));
    } else if (_realMode && _dm != null) {
      id = _dm!.send(jsonEncode(payload));
    } else {
      id = 'local-${DateTime.now().microsecondsSinceEpoch}';
    }
    _seenEv.add(id);
    _mutMsgs(() => _msgs.add(_Msg(_seq++, true, caption, _fmtTime(now),
        ts: now, evId: id, special: type, extra: data)));
    _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
    _schedulePersist();
    _notifyRecipients();
  }

  // Incoming {t:'vote'} envelope (server fan-out or a peer's device). It carries
  // the voter's FULL current selection (`options`), so we REPLACE that voter's
  // rows in the local tally — idempotent for un-vote (empty options) and vote
  // change alike. Legacy single-`opt` envelopes are treated as a one-option add.
  void _applyVote(Map env) {
    final pollId = (env['poll'] ?? '').toString();
    final i = _msgs.indexWhere((x) => x.special == 'poll' && x.extra?['id'] == pollId);
    if (i < 0 || !mounted) return;
    final voter = (env['voter'] ?? '').toString();
    List<int> opts;
    if (env['options'] is List) {
      opts = (env['options'] as List).map((e) => (e as num).toInt()).toList();
    } else if (env['opt'] != null) {
      opts = [(env['opt'] as num).toInt()];
    } else {
      opts = const [];
    }
    _mutMsgs(() {
      final m = _msgs[i];
      if (voter.isEmpty) {
        // Legacy anonymous vote (no voter id) — best-effort increment only.
        for (final o in opts) m.pollVotes[o] = (m.pollVotes[o] ?? 0) + 1;
        return;
      }
      // Remove this voter from every option, then re-add their current selection.
      for (final entry in m.pollBy.entries.toList()) {
        if (entry.value.remove(voter)) {
          m.pollVotes[entry.key] = ((m.pollVotes[entry.key] ?? 1) - 1).clamp(0, 1 << 30);
        }
      }
      final myUid = _meId?.uid ?? '';
      if (voter == myUid) m.pollMine = opts.toSet();
      for (final o in opts) {
        m.pollBy.putIfAbsent(o, () => <String>{}).add(voter);
        m.pollVotes[o] = (m.pollVotes[o] ?? 0) + 1;
      }
    });
  }

  // Toggle my vote for an option and persist it server-side (survives reinstall).
  // Single-choice: tapping a new option replaces my vote; tapping my current one
  // un-votes. Multi-select: each tap toggles that option independently. The POST
  // sends my FULL selection; the server replaces my rows + fans out {t:'vote'} to
  // every member's InboxDO for live updates.
  void _vote(_Msg poll, int opt) {
    final pollId = poll.extra?['id']?.toString() ?? '';
    if (pollId.isEmpty) return;
    final multi = poll.extra?['multi'] == true;
    final mine = Set<int>.from(poll.pollMine);
    final myUid = _meId?.uid ?? '';
    if (multi) {
      if (!mine.remove(opt)) mine.add(opt);
    } else {
      if (mine.contains(opt)) { mine.clear(); } else { mine.clear(); mine.add(opt); }
    }
    // Optimistic local update (server fan-out will re-affirm).
    _mutMsgs(() {
      if (myUid.isNotEmpty) {
        for (final entry in poll.pollBy.entries.toList()) {
          if (entry.value.remove(myUid)) {
            poll.pollVotes[entry.key] = ((poll.pollVotes[entry.key] ?? 1) - 1).clamp(0, 1 << 30);
          }
        }
        for (final o in mine) {
          poll.pollBy.putIfAbsent(o, () => <String>{}).add(myUid);
          poll.pollVotes[o] = (poll.pollVotes[o] ?? 0) + 1;
        }
      }
      poll.pollMine = mine;
    });
    HapticFeedback.selectionClick();
    Analytics.capture('poll_vote', {'options': mine.length, 'cleared': mine.isEmpty, 'multi': multi, 'group': _isGroup});
    final conv = _serverConvId;
    if (conv != null) {
      // Durable, server-persisted vote + fan-out (the source of truth).
      ApiAuth.postJson(kPollVoteUrl, {
        'poll_id': pollId, 'conv': conv, 'options': mine.toList(), 'multi': multi,
      }).then((_) {}, onError: (_) {});
    } else {
      // No server conv (rare) — fall back to the legacy live-only envelope so a
      // 1:1/group device still sees the tick immediately.
      final payload = {'t': 'vote', 'poll': pollId, 'voter': myUid, 'options': mine.toList(), 'multi': multi, if (_isGroup) 'gid': _group!.id};
      if (_isGroup && _gdm != null) { _gdm!.send(jsonEncode(payload)); }
      else if (_realMode && _dm != null) { _dm!.send(jsonEncode(payload)); }
    }
  }

  Future<void> _shareLocation() async {
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Location permission needed')));
        return;
      }
      final pos = await Geolocator.getCurrentPosition();
      _sendSpecial('loc', {'lat': pos.latitude, 'lng': pos.longitude}, '📍 Location');
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't get location")));
    }
  }

  // ---- live location (WhatsApp-style) ----------------------------------------
  /// Pick a duration, grab the first fix, post the durable `t:'live'` bubble, and
  /// start streaming GPS ticks over the ephemeral presence room.
  Future<void> _shareLiveLocation() async {
    final minutes = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Share live location', style: ADText.threadName()),
            const SizedBox(height: 4),
            Text('Your real-time position updates as you move, until the time runs out or you tap Stop.',
                style: ADText.preview(c: AD.textSecondary)),
            const SizedBox(height: 12),
            for (final opt in const [
              ('15 minutes', 15),
              ('1 hour', 60),
              ('8 hours', 480),
            ])
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: PhosphorIcon(PhosphorIcons.broadcast(PhosphorIconsStyle.bold), color: AD.danger),
                title: Text(opt.$1, style: ADText.rowName()),
                onTap: () => Navigator.pop(ctx, opt.$2),
              ),
          ]),
        ),
      ),
    );
    if (minutes == null) return;

    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Location permission needed')));
        Analytics.error(domain: 'location', code: 'perm_denied', screen: 'chat_thread', action: 'live_share');
        return;
      }

      final pos = await Geolocator.getCurrentPosition();
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final id = const Uuid().v4();
      final until = now + minutes * 60;

      final me = LiveLocationSession(
        id: id,
        lat: pos.latitude,
        lng: pos.longitude,
        until: until,
        mine: true,
        name: _myName ?? 'You',
        heading: pos.heading,
        speed: pos.speed,
        lastTs: now,
      );
      _live[id] = me;

      // Durable bubble (notifies the peer, survives reconnect/history).
      _sendSpecial('live', {
        'id': id,
        'lat': pos.latitude,
        'lng': pos.longitude,
        'until': until,
        'name': _myName ?? 'Me',
      }, '📍 Live location');

      // Stream the moving pin over the ephemeral presence room.
      _liveBroadcaster?.stop('superseded');
      _liveBroadcaster = LiveLocationBroadcaster(
        id: id,
        untilEpoch: until,
        onTick: (lat, lng, hdg, spd) {
          if (!mounted) return;
          final t = DateTime.now().millisecondsSinceEpoch ~/ 1000;
          me.apply(lat, lng, t, heading: hdg, speed: spd);
          _presence?.sendLiveLoc(id, lat, lng, heading: hdg, speed: spd, until: until, ts: t);
          if (t - _liveTickTelemetryTs >= 30) {
            _liveTickTelemetryTs = t;
            Analytics.capture('live_location_tick', {
              'share_id': id,
              'is_sender': true,
              'conv_kind': _isGroup ? 'group' : 'dm',
            });
          }
        },
        onEnd: (reason) {
          me.end();
          _presence?.sendLiveStop(id);
          Analytics.capture('live_location_stopped', {
            'share_id': id,
            'reason': reason,
            'is_sender': true,
          });
          if (mounted) setState(() {});
        },
      )..start();

      Analytics.capture('live_location_started', {
        'share_id': id,
        'duration_min': minutes,
        'conv_kind': _isGroup ? 'group' : 'dm',
        'members': _groupMemberCount,
      });
      AvaLog.I.log('location', 'live share started id=${id.substring(0, 8)} dur=${minutes}m');
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't start live location")));
      Analytics.error(domain: 'location', code: 'live_start_failed', message: '$e', screen: 'chat_thread', action: 'live_share');
    }
  }

  void _stopLiveShare(String id) {
    if (_liveBroadcaster?.id == id) {
      _liveBroadcaster?.stop('manual');
    } else {
      _live[id]?.end();
      _presence?.sendLiveStop(id);
      Analytics.capture('live_location_stopped', {'share_id': id, 'reason': 'manual', 'is_sender': true});
    }
    if (mounted) setState(() {});
  }

  /// Inline live-location bubble: a small OSM preview that re-pins as ticks
  /// arrive, a live status line, and (for my own share) a STOP affordance.
  Widget _liveBubble(LiveLocationSession s) {
    return AnimatedBuilder(
      animation: s,
      builder: (context, _) {
        final active = s.isActive;
        return GestureDetector(
          onTap: () => _openLiveMap(s),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Stack(children: [
                LiveMapView(lat: s.lat, lng: s.lng, width: 220, height: 120, zoom: 15),
                if (active)
                  Positioned(
                    right: 6,
                    top: 6,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                          color: AD.danger,
                          borderRadius: Msg.brPill,
                          border: Border.all(color: AD.bubbleInInk, width: 2)),
                      child: Text('Live', style: ADText.bubbleMeta(c: Colors.white)),
                    ),
                  ),
              ]),
              const SizedBox(height: 6),
              Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(
                    active
                        ? PhosphorIcons.broadcast(PhosphorIconsStyle.fill)
                        : PhosphorIcons.mapPin(PhosphorIconsStyle.fill),
                    color: active ? AD.danger : AD.bubbleInMeta,
                    size: 16),
                const SizedBox(width: 6),
                Flexible(child: Text(s.statusLabel(), style: ADText.rowName(c: AD.iconSearch))),
              ]),
              if (s.mine && active)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: GestureDetector(
                    onTap: () => _stopLiveShare(s.id),
                    child: Text('STOP SHARING', style: ADText.bubbleMeta(c: AD.danger)),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  void _openLiveMap(LiveLocationSession s) {
    Analytics.capture('live_location_opened', {'share_id': s.id, 'is_sender': s.mine});
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => LiveMapScreen(
        session: s,
        title: s.mine ? 'Your live location' : '${s.name} · live',
        onStop: s.mine ? () => _stopLiveShare(s.id) : null,
        onTelemetry: (ev) => Analytics.capture(ev, {'share_id': s.id, 'is_sender': s.mine}),
      ),
    ));
  }

  Future<void> _shareContactCard() async {
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Share a contact', style: ADText.threadName()),
          const SizedBox(height: 8),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: ListView(shrinkWrap: true, children: [
            for (final c in contacts)
              ListTile(contentPadding: EdgeInsets.zero, leading: Avatar(seed: c.seed, name: c.name, size: 40),
                title: Text(c.name, style: ADText.rowName()),
                onTap: () { Navigator.pop(ctx); _sendSpecial('card', {'name': c.name, 'uid': c.uid, 'handle': c.handle}, '👤 ${c.name}'); }),
          ])),
        ]))));
  }

  // Create Poll sheet (zine style): question + 2–10 options + a multi-select
  // toggle. The poll DEFINITION rides the message envelope (t:'poll'); votes are
  // persisted server-side (see _vote → /api/poll/vote).
  Future<void> _createPoll() async {
    final q = TextEditingController();
    final opts = <TextEditingController>[TextEditingController(), TextEditingController()];
    var multi = false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: SafeArea(child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(PhosphorIcons.chartBar(PhosphorIconsStyle.bold), size: 20, color: AD.textPrimary),
              const SizedBox(width: 8),
              Text('Create poll', style: ADText.rowName()),
            ]),
            const SizedBox(height: 14),
            TextField(controller: q, autofocus: true, textCapitalization: TextCapitalization.sentences,
              style: ADText.rowName(),
              decoration: InputDecoration(hintText: 'Ask a question…',
                hintStyle: ADText.preview(c: AD.textSecondary),
                filled: true, fillColor: AD.card,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(Msg.rMd), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Msg.rMd), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Msg.rMd), borderSide: BorderSide(color: AD.borderControl, width: 2)))),
            const SizedBox(height: 12),
            ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: ListView(shrinkWrap: true, children: [
              for (var i = 0; i < opts.length; i++)
                Padding(padding: const EdgeInsets.only(bottom: 8), child: Row(children: [
                  Expanded(child: TextField(controller: opts[i], textCapitalization: TextCapitalization.sentences,
                    style: ADText.rowName(),
                    decoration: InputDecoration(hintText: 'Option ${i + 1}',
                      hintStyle: ADText.preview(c: AD.textSecondary),
                      isDense: true, filled: true, fillColor: AD.card,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(Msg.rSm), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Msg.rSm), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Msg.rSm), borderSide: BorderSide(color: AD.borderControl, width: 2))))),
                  if (opts.length > 2)
                    IconButton(
                      icon: Icon(PhosphorIcons.minusCircle(PhosphorIconsStyle.bold), size: 20, color: AD.textSecondary),
                      onPressed: () => setSheet(() { opts.removeAt(i).dispose(); }),
                    ),
                ])),
            ])),
            if (opts.length < 10)
              TextButton.icon(
                onPressed: () => setSheet(() => opts.add(TextEditingController())),
                icon: Icon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold), size: 18, color: AD.textPrimary),
                label: Text('Add option', style: ADText.statCaption(c: AD.textPrimary)),
              ),
            const SizedBox(height: 4),
            InkWell(
              onTap: () => setSheet(() => multi = !multi),
              borderRadius: BorderRadius.circular(Msg.rSm),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  Icon(multi ? PhosphorIcons.checkSquare(PhosphorIconsStyle.fill) : PhosphorIcons.square(PhosphorIconsStyle.bold),
                      size: 22, color: multi ? AD.primaryBadge : AD.textSecondary),
                  const SizedBox(width: 10),
                  Expanded(child: Text('Allow multiple answers', style: ADText.rowName())),
                ])),
            ),
            const SizedBox(height: 12),
            SizedBox(width: double.infinity, child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AD.textPrimary, foregroundColor: AD.overlaySheet,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Msg.rMd))),
              onPressed: () => Navigator.pop(ctx, true),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text('Create poll', style: ADText.statCaption(c: AD.overlaySheet))),
            )),
          ]),
        )),
      )),
    );
    if (ok != true) return;
    final options = opts.map((c) => c.text.trim()).where((t) => t.isNotEmpty).toList();
    if (q.text.trim().isEmpty || options.length < 2) {
      if (mounted) _toast('A poll needs a question and at least 2 options.');
      return;
    }
    Analytics.capture('poll_create', {'options': options.length, 'multi': multi, 'group': _isGroup});
    _sendSpecial('poll',
      {'id': const Uuid().v4(), 'q': q.text.trim(), 'options': options, 'multi': multi},
      '📊 ${q.text.trim()}');
  }

  void _stickerPicker() {
    const stickers = ['😀','😂','🥳','😍','😎','🤩','😭','🙏','👍','👏','🔥','❤️','🎉','💯','🚀','🌈','🍕','☕','⚡','✨'];
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.all(16),
        child: Wrap(spacing: 10, runSpacing: 10, children: [
          for (final s in stickers)
            GestureDetector(onTap: () { Navigator.pop(ctx); _sendSpecial('sticker', {'emoji': s}, s); },
                child: Text(s, style: const TextStyle(fontSize: 38))),
        ]))));
  }

  Widget _specialContent(_Msg m, BubbleTheme t) {
    final e = m.extra ?? {};
    // [AVAGRP-BUBBLE-1] Every pale bubble fill is light — text is always the
    // resolved theme's ink (§2: white text only on coral/danger).
    final fg = t.ink;
    switch (m.special) {
      case 'sticker':
        return Text((e['emoji'] ?? '🙂').toString(), style: const TextStyle(fontSize: 46));
      case 'loc':
        return GestureDetector(
          onTap: () => launchUrl(Uri.parse('https://maps.google.com/?q=${e['lat']},${e['lng']}'),
              mode: LaunchMode.externalApplication),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.mapPin(PhosphorIconsStyle.fill), color: AD.danger, size: 20),
            const SizedBox(width: 6),
            Text('Location · open in Maps', style: ADText.rowName(c: AD.iconSearch)),
          ]),
        );
      case 'live':
        {
          final id = (e['id'] ?? '').toString();
          final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
          final s = _live.putIfAbsent(
            id,
            () => LiveLocationSession(
              id: id,
              lat: (e['lat'] as num?)?.toDouble() ?? 0,
              lng: (e['lng'] as num?)?.toDouble() ?? 0,
              until: (e['until'] as num?)?.toInt() ?? now,
              mine: m.me,
              name: (e['name'] ?? widget.chat.name).toString(),
            ),
          );
          return _liveBubble(s);
        }
      case 'card':
        return Row(mainAxisSize: MainAxisSize.min, children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: t.border, width: 2),
            ),
            child: Avatar(seed: (e['uid'] ?? 'c').toString(), name: (e['name'] ?? '').toString(), size: 36),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((e['name'] ?? 'Contact').toString(), style: ADText.rowName(c: fg)),
            GestureDetector(onTap: () => _addSharedContact(e),
                child: Text('ADD CONTACT', style: ADText.bubbleMeta(c: t.play))),
          ]),
        ]);
      case 'gcall':
        // Call start/end system row — Join affordance while the call is live.
        final audio = e['kind'] == 'audio';
        return GestureDetector(
          // Join affordance on a "call started" message: joining, never starting.
          onTap: _confLive ? () => _groupCall(!audio, joinOnly: true) : null,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(
                audio
                    ? PhosphorIcons.phone(PhosphorIconsStyle.fill)
                    : PhosphorIcons.videoCamera(PhosphorIconsStyle.fill),
                size: 17, color: AD.online),
            const SizedBox(width: 6),
            Text(audio ? 'Audio call' : 'Video call', style: ADText.rowName(c: fg)),
            if (_confLive) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                    color: AD.online,
                    borderRadius: Msg.brPill,
                    border: Border.all(color: t.border, width: 2)),
                child: Text('Join', style: ADText.bubbleMeta(c: t.meta)),
              ),
            ],
          ]),
        );
      case 'poll':
        final options = (e['options'] as List?)?.map((x) => x.toString()).toList() ?? [];
        final multi = e['multi'] == true;
        // Total votes = distinct voters across options (a multi voter counts once
        // toward the "N votes" label). Percentage bars use per-option share of the
        // largest single-option count so bars stay comparable in multi polls.
        final voters = <String>{};
        for (final s in m.pollBy.values) voters.addAll(s);
        final totalVoters = voters.isNotEmpty ? voters.length : m.pollVotes.values.fold<int>(0, (a, b) => a + b);
        return ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 200),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((e['q'] ?? 'Poll').toString(), style: ADText.rowName(c: fg)),
            if (multi) Padding(padding: const EdgeInsets.only(top: 2),
              child: Text('Select one or more', style: ADText.bubbleMeta(c: t.meta))),
            const SizedBox(height: 8),
            for (var i = 0; i < options.length; i++)
              Builder(builder: (_) {
                final count = m.pollVotes[i] ?? 0;
                final maxCount = m.pollVotes.values.fold<int>(0, (a, b) => a > b ? a : b);
                final frac = maxCount > 0 ? count / maxCount : 0.0;
                final mine = m.pollMine.contains(i);
                final pct = totalVoters > 0 ? (count * 100 / totalVoters).round() : 0;
                return GestureDetector(
                  onTap: () => _vote(m, i),
                  onLongPress: (_isGroup && (m.pollBy[i]?.isNotEmpty ?? false)) ? () => _showPollVoters(options[i], m.pollBy[i]!) : null,
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 6),
                    decoration: BoxDecoration(
                        border: Border.all(color: mine ? AD.primaryBadge : t.border, width: 2),
                        borderRadius: BorderRadius.circular(Msg.rSm)),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(Msg.rSm),
                      child: Stack(children: [
                        // Percentage bar fill.
                        Positioned.fill(child: FractionallySizedBox(
                          alignment: Alignment.centerLeft, widthFactor: frac.clamp(0.0, 1.0),
                          child: Container(color: (mine ? AD.primaryBadge : t.border).withValues(alpha: 0.35)))),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          child: Row(children: [
                            if (mine) Padding(padding: const EdgeInsets.only(right: 6),
                              child: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 15, color: AD.primaryBadge)),
                            Expanded(child: Text(options[i],
                              style: ADText.bubbleBody(c: fg).copyWith(fontWeight: mine ? FontWeight.w600 : FontWeight.w400))),
                            Text('$pct%', style: ADText.bubbleMeta(c: t.meta)),
                          ]),
                        ),
                      ]),
                    ),
                  ),
                );
              }),
            Padding(padding: const EdgeInsets.only(top: 2),
              child: Text(
                totalVoters == 0 ? 'Tap to vote' : '$totalVoters ${totalVoters == 1 ? 'vote' : 'votes'}'
                    '${m.pollMine.isNotEmpty ? ' · tap again to change' : ''}',
                style: ADText.bubbleMeta(c: t.meta))),
          ]),
        );
      case 'marketplace_deal':
        return _MarketplaceDealCard(extra: e);
      case 'recept':
        return _ReceptionistCard(
          extra: e,
          sessionId: (e['session_id'] ?? e['sid'] ?? '').toString(),
        );
      // WP6 (Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §6):
      // callee-side business-call records. Caller sees none of this — these
      // envelopes are only ever synced to the callee's own thread.
      case 'voicemail':
        if (!RemoteConfig.voicemailBot) return Text(m.text, style: ADText.bubbleBody(c: fg));
        return VoicemailCard(extra: e);
      case 'agent_transcript':
        if (!RemoteConfig.voiceAgent) return Text(m.text, style: ADText.bubbleBody(c: fg));
        return AgentTranscriptCard(
          extra: e,
          onReply: (callerNumber, callerName) {
            // "Reply" (§6): this thread already IS the callee's channel to the
            // caller (business calls sync into a normal per-caller thread with
            // special bubbles) — jump into the composer to start a real
            // back-and-forth, same affordance used elsewhere in this screen.
            Analytics.capture('business_thread_reply_started', {
              'caller_number': callerNumber,
            });
            _composerFocus.requestFocus();
          },
        );
      case 'ava':
      case 'ava_private':
        // Ava's turn. The feminine bubble + "AVA" label are applied in _bubble;
        // here we render her answer as light markdown (bold, numbered lists,
        // bullets, headings) so structured results (e.g. an email digest) look
        // clean instead of showing raw ** and 1. markers.
        final body = (e['text'] ?? e['body'] ?? m.text).toString();
        // In-chat email: when the turn carried structured inbox cards, render the
        // AvaTOK email UI (View / Spam / Delete + read→reply overlay) under the
        // lead line instead of plain text.
        final inbox = AvaInboxEmail.listFrom(e['emails']);
        if (inbox.isNotEmpty) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
            EmailInboxCards(emails: inbox),
          ]);
        }
        // Generated image (e.g. "create an image of …"). The public image URL
        // rides in the envelope (media_ref) so it renders even though the
        // separate media_ref column is dropped during sync — that drop was why
        // Ava's image turns showed the caption but never the picture.
        final mediaRef = (e['media_ref'] ?? '').toString();
        if (mediaRef.isNotEmpty) {
          return _avaImageBubble(m, mediaRef, body, fg);
        }
        // GenUI/A2UI surface (generic): the agent composed a layout from our Zine
        // catalog (calendar today, any tool tomorrow). Rendered natively.
        final a2ui = e['a2ui'];
        if (a2ui is Map) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
            AvaA2uiSurface(
              surface: a2ui.cast<String, dynamic>(),
              onPrompt: (t) { if (onSummonAva != null) onSummonAva!('$_avaWakeWord $t'); },
              onComposio: _onGenuiComposio,
            ),
          ]);
        }
        return _avaRich(body, fg);
      default:
        return Text(m.text, style: ADText.bubbleBody(c: fg));
    }
  }

  /// Lightweight markdown renderer for Ava's bubbles (no extra dependency).
  /// Handles: # headings, **bold**, `code`, numbered lists (1.) and bullets
  /// (- / *), and blank-line spacing — enough to make digests/results look neat.
  Widget _avaRich(String text, Color fg) {
    // [AVA-FONT-1] (owner request 2026-07-10) Ava's replies read too small at
    // 13.5 — bumped to 15 (headings scale with it below).
    final base = ADText.bubbleBody(c: fg).copyWith(height: 1.34);
    final lines = text.replaceAll('\r\n', '\n').split('\n');
    final out = <Widget>[];
    final numRe = RegExp(r'^\s*(\d+)\.\s+(.*)$');
    final bulRe = RegExp(r'^\s*[-*]\s+(.*)$');
    final headRe = RegExp(r'^#{1,6}\s+(.*)$');
    for (final raw in lines) {
      final line = raw.trimRight();
      if (line.trim().isEmpty) { out.add(const SizedBox(height: 7)); continue; }
      final head = headRe.firstMatch(line);
      final num = numRe.firstMatch(line);
      final bul = bulRe.firstMatch(line);
      if (head != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(top: 2, bottom: 3),
          child: _avaInline(head.group(1)!, base.copyWith(fontWeight: FontWeight.w600, fontSize: 16)),
        ));
      } else if (num != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            SizedBox(width: 22, child: Text('${num.group(1)}.',
                style: base.copyWith(fontWeight: FontWeight.w600, color: AD.iconSearch))),
            Expanded(child: _avaInline(num.group(2)!, base)),
          ]),
        ));
      } else if (bul != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Padding(padding: const EdgeInsets.only(left: 2, right: 8, top: 1),
                child: Text('•', style: base.copyWith(fontWeight: FontWeight.w600, color: AD.iconSearch))),
            Expanded(child: _avaInline(bul.group(1)!, base)),
          ]),
        ));
      } else {
        out.add(_avaInline(line, base));
      }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: out);
  }

  /// Render inline **bold** and `code` spans within one line.
  Widget _avaInline(String text, TextStyle base) {
    final spans = <TextSpan>[];
    final re = RegExp(r'\*\*(.+?)\*\*|`([^`]+?)`');
    var i = 0;
    for (final mt in re.allMatches(text)) {
      if (mt.start > i) spans.add(TextSpan(text: text.substring(i, mt.start)));
      if (mt.group(1) != null) {
        spans.add(TextSpan(text: mt.group(1), style: base.copyWith(fontWeight: FontWeight.w600)));
      } else {
        spans.add(TextSpan(text: ' ${mt.group(2)} ',
            style: base.copyWith(fontFeatures: const [], backgroundColor: AD.mediaPlaceholderBg)));
      }
      i = mt.end;
    }
    if (i < text.length) spans.add(TextSpan(text: text.substring(i)));
    return RichText(text: TextSpan(style: base, children: spans.isEmpty ? [TextSpan(text: text)] : spans));
  }

  /// True when this message is one of Ava's persisted bubble kinds. Uses the
  /// Phase 0 contract (app/lib/core/ava_contracts.dart) so the kind strings stay
  /// in one place.
  bool _isAvaBubble(_Msg m) => AvaKind.isBubble(m.special);

  // [AVAGRP-BUBBLE-1] `_groupSenderTint`/`_groupTints` are GONE — they hashed
  // the display NAME (reshuffled a member's colour if they renamed themselves)
  // and only ever changed the fill, leaving the ink hardcoded to
  // `AD.bubbleInInk` with undefined contrast on most of the 6 tints. Per-sender
  // colour now comes from `resolveBubbleTheme(senderKey: m.senderPub)` in
  // `bubble_theme.dart`, keyed on the STABLE uid and carrying a matched
  // ink/meta/play/border set for every tint. See `_bubble` / `_bubbleTheme`.

  /// The inline "Ava is working…" chip row (kind 'ava_status'). Not a normal
  /// bubble — a subtle lilac pill with a tiny spinner. Generic: any phase that
  /// posts an 'ava_status' frame gets this with no extra UI work.
  Widget _avaStatusChip(_Msg m) {
    final label = (m.extra?['label'] ?? m.text).toString();
    // Image generation gets a ChatGPT-style inline placeholder (a blank, image-
    // shaped card with a spinner) instead of the small text pill. It auto-
    // collapses when the finished image (a normal ava media_ref message) arrives
    // and this transient 'ava_status' chip is dropped.
    final isImage = (m.extra?['source'] ?? '').toString() == 'image' ||
        label.toLowerCase().contains('generating an image');
    if (isImage) return _imageGeneratingCard(label);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: AD.bubbleInBg,
          borderRadius: BorderRadius.circular(Msg.rSm),
          border: Border.all(color: AD.bubbleInInk, width: 1),
          boxShadow: const [],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(width: 12, height: 12,
              child: CircularProgressIndicator(strokeWidth: 1.6, color: AD.bubbleInInk)),
          const SizedBox(width: 8),
          Text(label.isEmpty ? 'Ava is working…' : label,
              style: ADText.bubbleBody(c: AD.bubbleInInk)
                  .copyWith(fontStyle: FontStyle.italic)),
        ]),
      ),
    );
  }

  /// [CHAT-UI-COMPOSER-1] Animated three-bouncing-dots typing bubble — a
  /// synthetic last list item shown while `_peerTyping` is true, replacing the
  /// old "header text only" signal with something WhatsApp-shaped.
  Widget _typingBubble() {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: kBubbleTheirs.bg,
          borderRadius: kBubbleTheirs.radius,
          border: Border.all(color: kBubbleTheirs.border, width: 1),
        ),
        child: _TypingDots(color: kBubbleTheirs.ink),
      ),
    );
  }

  /// ChatGPT-style placeholder shown WHILE Ava generates an image: a blank,
  /// image-shaped card with a spinner and a status line. Replaced by the real
  /// picture (a normal ava media_ref bubble) when generation finishes.
  Widget _imageGeneratingCard(String label) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        width: 240,
        height: 200,
        decoration: BoxDecoration(
          color: AD.bubbleInBg,
          borderRadius: BorderRadius.circular(Msg.rMd),
          border: Border.all(color: AD.bubbleInInk, width: 1),
          boxShadow: const [],
        ),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          PhosphorIcon(PhosphorIcons.image(PhosphorIconsStyle.duotone),
              size: 34, color: AD.bubbleInInk),
          const SizedBox(height: 14),
          const SizedBox(
              width: 20, height: 20,
              child: CircularProgressIndicator(strokeWidth: 2, color: AD.bubbleInInk)),
          const SizedBox(height: 12),
          Text(label.isEmpty ? 'Generating image…' : label,
              style: ADText.bubbleBody(c: AD.bubbleInInk)
                  .copyWith(fontStyle: FontStyle.italic)),
        ]),
      ),
    );
  }

  /// A finished Ava image bubble: the picture, tappable to open full-screen, with
  /// a ⋮ overflow menu (Open / Download full-res / Download full quality / Share)
  /// in the top-right corner.
  ///
  /// [AVA-IMG-SELFHEAL-1] `mediaRef` is a PRESIGNED URL baked permanently into
  /// the message envelope (`extra.media_ref`) — it expires ~15 minutes after
  /// Ava posts it (server-side mint, never re-signed). Rendered after expiry,
  /// a bare `CachedImage(mediaRef)` was blank forever. The envelope also
  /// carries `extra.meta.job_id` (postAvaMessage's `meta:{job_id}`), which
  /// [_AvaImageBubbleImage] uses to re-mint a fresh URL via
  /// `AiMediaJobRepository.fetch` — the same durable-job contract the `ai_job`
  /// card already relies on (see media.dart's `_freshArtifactUrl`). Messages
  /// that predate that wiring simply have no `job_id` and fall back to the
  /// old (potentially-expired) behavior.
  Widget _avaImageBubble(_Msg m, String mediaRef, String body, Color fg) {
    final meta = m.extra?['meta'];
    final jobId = (meta is Map ? meta['job_id'] : null)?.toString() ?? '';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (body.isNotEmpty)
        Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
      ClipRRect(
        borderRadius: BorderRadius.circular(Msg.rMd),
        child: _AvaImageBubbleImage(
          mediaRef: mediaRef,
          jobId: jobId,
          postedTs: m.ts,
          onOpen: _openImageFull,
          onDownload: _downloadImage,
          onShare: (url) => _downloadImage(url, share: true),
        ),
      ),
    ]);
  }
}

/// [AVA-IMG-SELFHEAL-1] In-memory, job_id → last known-fresh `artifact_url`.
/// Session-scoped only (never persisted) — a reopened thread re-resolves once
/// per job the first time it's needed, then reuses this so scrolling the same
/// bubble back into view doesn't refetch every rebuild. Deliberately NOT
/// account-scoped: a job_id is a server-minted opaque id with no embedded
/// secret, and the URL itself is short-lived, so there is nothing here worth
/// separating per account (mirrors `AvatarCache`'s own reasoning for its
/// shared, content-addressed pool).
final Map<String, String> _avaResolvedImageUrls = {};

/// [AVA-IMG-SELFHEAL-1] Renders an Ava-generated image and keeps it showing
/// even after its presigned `mediaRef` URL expires, by re-minting a fresh one
/// via the durable AI-media-job contract (`AiMediaJobRepository.fetch`) —
/// PROACTIVELY when the message is already older than the presign's ~15-minute
/// lifetime, and REACTIVELY whenever [CachedImage] reports a load failure
/// (`onResult(false)`) for any other reason (clock skew, a shorter-than-usual
/// mint, etc). Falls back to whatever URL is already showing if the refetch
/// itself fails — never worse than the old behavior.
class _AvaImageBubbleImage extends StatefulWidget {
  const _AvaImageBubbleImage({
    required this.mediaRef,
    required this.jobId,
    required this.postedTs,
    required this.onOpen,
    required this.onDownload,
    required this.onShare,
  });

  final String mediaRef;
  final String jobId; // '' for a message that predates AI-media-job wiring
  final int postedTs; // _Msg.ts — epoch seconds, 0 if unknown
  final void Function(String url) onOpen;
  final void Function(String url) onDownload;
  final void Function(String url) onShare;

  @override
  State<_AvaImageBubbleImage> createState() => _AvaImageBubbleImageState();
}

class _AvaImageBubbleImageState extends State<_AvaImageBubbleImage> {
  // Conservatively under the server's ~15-minute presign lifetime (AVA-MEDIA-JOB-2's
  // 900s), so a proactive refetch fires before the link is actually dead.
  static const _presignLifetime = Duration(minutes: 14);

  late String _url;
  bool _refetching = false;
  bool _refetched = false; // did THIS mount ever swap in a re-minted URL

  @override
  void initState() {
    super.initState();
    _url = _avaResolvedImageUrls[widget.jobId] ?? widget.mediaRef;
    if (widget.jobId.isNotEmpty &&
        !_avaResolvedImageUrls.containsKey(widget.jobId) &&
        _isStale()) {
      _refetch();
    }
  }

  bool _isStale() {
    if (widget.postedTs <= 0) return false;
    final ageSec = DateTime.now().millisecondsSinceEpoch ~/ 1000 - widget.postedTs;
    return ageSec > _presignLifetime.inSeconds;
  }

  Future<void> _refetch() async {
    if (_refetching || widget.jobId.isEmpty) return;
    _refetching = true;
    try {
      final job = await AiMediaJobRepository.I.fetch(widget.jobId);
      final fresh = job?.artifactUrl;
      if (fresh != null && fresh.isNotEmpty) {
        _avaResolvedImageUrls[widget.jobId] = fresh;
        if (mounted) setState(() { _url = fresh; _refetched = true; });
      }
    } finally {
      _refetching = false;
    }
  }

  /// A GUARANTEED-fresh url for a user-initiated action (open/download/share)
  /// — never trusts whatever is currently painted, mirroring
  /// `_freshArtifactUrl` in media.dart for the `ai_job` card. Falls back to
  /// the best URL already known ([_url]) if the job fetch itself fails.
  Future<String> _resolveForAction() async {
    if (widget.jobId.isEmpty) return _url;
    final job = await AiMediaJobRepository.I.fetch(widget.jobId);
    final fresh = job?.artifactUrl;
    if (fresh == null || fresh.isEmpty) return _url;
    _avaResolvedImageUrls[widget.jobId] = fresh;
    if (mounted && fresh != _url) setState(() { _url = fresh; _refetched = true; });
    return fresh;
  }

  void _onLoadResult(bool ok) {
    // [SRV-ERR-TRACK-1 bake-in] The presigned-URL expiry was invisible until
    // now — nothing told anyone an Ava image bubble had gone permanently
    // blank. `job_id` is included so a failure can be correlated back to the
    // job that produced it.
    Analytics.capture('ava_image_bubble_load', {
      'ok': ok, 'refetched': _refetched, 'job_id': widget.jobId,
    });
    if (!ok && widget.jobId.isNotEmpty) _refetch();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      GestureDetector(
        onTap: () async => widget.onOpen(await _resolveForAction()),
        // Disk-cached (keyed by job_id when known, so a re-minted URL with a
        // rotated signature still hits the same cache entry — see
        // CachedImage's own `cacheKey` doc) so it loads instantly on reopen.
        child: CachedImage(_url,
            width: 240,
            cacheKey: widget.jobId.isNotEmpty ? widget.jobId : null,
            onResult: _onLoadResult),
      ),
      Positioned(
        top: 6,
        right: 6,
        child: DecoratedBox(
          decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
          child: PopupMenuButton<String>(
            tooltip: 'Image options',
            icon: Icon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), size: 18, color: Colors.white),
            padding: EdgeInsets.zero,
            onSelected: (v) async {
              if (v == 'open') widget.onOpen(await _resolveForAction());
              if (v == 'download') widget.onDownload(_url);
              if (v == 'download_fresh') widget.onDownload(await _resolveForAction());
              if (v == 'share') widget.onShare(await _resolveForAction());
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'open', child: Text('Open')),
              const PopupMenuItem(value: 'download', child: Text('Download full-res')),
              // [AVA-IMG-SELFHEAL-1] Only offered when this message actually
              // carries a job_id — an old message has no durable job to
              // re-fetch from, so there is nothing "fresh" to offer beyond
              // the plain Download above.
              if (widget.jobId.isNotEmpty)
                const PopupMenuItem(value: 'download_fresh', child: Text('Download full quality')),
              const PopupMenuItem(value: 'share', child: Text('Share')),
            ],
          ),
        ),
      ),
    ]);
  }
}
