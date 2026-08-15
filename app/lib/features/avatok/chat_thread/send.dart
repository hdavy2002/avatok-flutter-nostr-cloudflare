part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// [CHAT-THREAD-SPLIT-2] Ava stream binding, outbound send/dispatch, unfurl and scroll.
extension _ChatThreadSend on _ChatThreadScreenState {


  /// Index one labelled line into the ON-DEVICE lane (when Local Ava AI is
  /// active). Skips empty lines and @ava control lines. Fire-and-forget.
  void _ragAddLine(String who, String text) {
    final t = text.trim();
    if (t.isEmpty || t.toLowerCase().contains(_avaWakeWord)) return;
    // On-device memory: ONLY when Local Ava AI is active (model loaded) so we
    // never trigger a model download just from chatting. Makes facts said in
    // this chat findable on-device/offline — including cross-surface in AvaChat.
    if (AvaLocalMode.I.isActive) {
      // Selective embedding: only substantive lines are kept on-device (skips
      // greetings/acks + respects the episodic cap). Facts, not chatter.
      // ignore: unawaited_futures
      AvaOnDeviceRag.I.rememberMessage(who, t, name: 'chat-${widget.chat.name}');
    }
  }


  /// Render on-device `@ava` answers (Local Ava AI) for THIS conversation as a
  /// normal Ava bubble. Additive — does not touch the server message pipeline.
  void _bindLocalAva() {
    _localAvaSub?.cancel();
    final key = _convKey;
    if (key == null) return;
    _localAvaSub = AvaLocalReplies.I.stream.listen((r) {
      if (!mounted || r.convKey != key) return;
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      _mutMsgs(() {
        // [AVA-IMAGE-UX-1] The on-device answer is here — drop the transient
        // "thinking" chip ONLY. Root cause (Part VI §37): this used to be a
        // blanket `removeWhere(special == 'ava_status')`, which could also
        // wipe an UNRELATED still-running image job's placeholder chip the
        // instant any text answer landed. `_isJobStatusChip` protects any
        // status row correlated to a job (by `job_id`, or the legacy
        // image-generation marker while `ava_image.ts` still posts one) —
        // durable job cards render as `special: 'ai_job'` now anyway (a
        // different value entirely), so this guard only matters for the
        // legacy chip during the migration window (§49).
        _msgs.removeWhere((m) => m.special == 'ava_status' && !_isJobStatusChip(m));
        _msgs.add(_Msg(_seq++, false, r.text, _fmtTime(now),
            ts: now, special: 'ava'));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    });
  }


  /// A GenUI card fired a `composio` action (Rename, Delete, Schedule a
  /// meeting…). Execute it via the server-validated route; if the server renders
  /// a refreshed surface from the result (e.g. the updated list / created event),
  /// drop it into the thread as a fresh Ava bubble so the chat reflects the new
  /// state. Returns the short answer for the renderer's snackbar.
  Future<String?> _onGenuiComposio(String tool, Map<String, dynamic> args, {String? gid}) async {
    final r = await AppsService.I.genuiAction(tool, args, gid: gid);
    if (!mounted) return r.answer;
    if (r.surface != null) {
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final body = r.ok ? '' : r.answer;
      _mutMsgs(() {
        _msgs.add(_Msg(_seq++, false, body, _fmtTime(now),
            ts: now, special: 'ava', extra: {'a2ui': r.surface, 'text': body}));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    }
    return r.answer;
  }


  /// Render LIVE server `@ava` answers for THIS conversation as they stream in
  /// (cloud agent). Each delta grows a single Ava bubble keyed by `stream_id`;
  /// when the durable answer lands ([_onDm]/[_onGroupMsg]) it removes this
  /// preview so there's no duplicate. Purely additive: if no stream arrives the
  /// answer still appears whole via the normal message path.
  void _bindAvaStream() {
    _avaStreamSub?.cancel();
    final key = _convKey;
    if (key == null) return;
    _avaStreamSub = SyncHub.I.avaStream.listen((m) {
      if (!mounted || m['convKey'] != key) return;
      final phase = (m['phase'] ?? '').toString();
      final sid = (m['stream_id'] ?? '').toString();
      if (sid.isEmpty) return;
      final delta = (m['delta'] ?? '').toString();
      final evId = 'stream_$sid';
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      _mutMsgs(() {
        final i = _msgs.indexWhere((x) => x.evId == evId);
        if (phase == 'end') return; // keep the preview; durable answer replaces it
        if (i >= 0) {
          if (phase == 'delta') _msgs[i].text = _msgs[i].text + delta;
          return;
        }
        // First frame for this turn (start, or a delta if start was missed):
        // drop the "working…" chip and open the growing bubble. [AVA-IMAGE-UX-1]
        // Same job-aware guard as `_bindLocalAva` above — see that call site's
        // note; this must never remove an unrelated job's status chip.
        _msgs.removeWhere((x) => x.special == 'ava_status' && !_isJobStatusChip(x));
        _msgs.add(_Msg(_seq++, false, delta, _fmtTime(now),
            ts: now, special: 'ava', evId: evId));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    });
  }


  /// [AVA-IMAGE-UX-1] True for an `ava_status` chip that belongs to a durable
  /// job rather than this turn's own plain "Ava is thinking…" pill (Part VI
  /// §37/§49 — the root cause: a global sweep of every `ava_status` row could
  /// erase a still-running image job's placeholder just because an unrelated
  /// text answer arrived). Two cases:
  ///   1. Forward-looking: any `ava_status` row explicitly correlated to a job
  ///      via `job_id` — a real job placeholder should never share this
  ///      client's turn-scoped "thinking" chip's fate.
  ///   2. The LEGACY image-generation chip `ava_image.ts` may still post via
  ///      `postChip()`/`endChip()` (no `job_id`) until every producer fully
  ///      migrates to `createAiMediaJob()` (§44/§49) — same heuristic
  ///      `_avaStatusChip` already uses to pick the ChatGPT-style image
  ///      placeholder rendering, reused here so the two never disagree about
  ///      what "is an image chip".
  /// Once every producer of `ava_status` speaks job_id (or, for images,
  /// migrates entirely to `special: 'ai_job'`), case 2 becomes dead code —
  /// safe to delete then per §49, not before.
  bool _isJobStatusChip(_Msg m) {
    if (m.special != 'ava_status') return false;
    if ((m.extra?['job_id'] ?? '').toString().isNotEmpty) return true;
    final source = (m.extra?['source'] ?? '').toString();
    final label = (m.extra?['label'] ?? '').toString().toLowerCase();
    return source == 'image' || label.contains('generating an image');
  }


  /// Remove any live streaming preview bubble(s) once the durable Ava answer
  /// arrives. Prefers exact correlation via the answer's `meta.stream_id`; falls
  /// back to clearing all `stream_` previews (turns are sequential).
  void _clearAvaStreamPreview(Map<String, dynamic>? extra) {
    final sid = (extra?['meta'] is Map) ? (extra!['meta'] as Map)['stream_id']?.toString() : null;
    if (sid != null && sid.isNotEmpty) {
      _msgs.removeWhere((x) => x.evId == 'stream_$sid');
    } else {
      _msgs.removeWhere((x) => (x.evId ?? '').startsWith('stream_'));
    }
  }


  /// Show a transient on-device "Ava is thinking…" chip. Scheduled after the
  /// current frame so it lands below the user's own @ava message; it collapses
  /// automatically once the answer bubble arrives (the 'ava_status' transient
  /// rule keeps only the most-recent chip) or when [_bindLocalAva] clears it.
  void _showLocalAvaThinking() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      _mutMsgs(() {
        _msgs.add(_Msg(_seq++, false, 'Ava is thinking…', _fmtTime(nowS),
            ts: nowS, special: 'ava_status'));
      });
      _jump();
    });
  }


  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
    // STREAM B: replying while a thread is pending is an IMPLICIT accept — fire the
    // accept (server restores receipts) and drop the gate before the send.
    if (_strangerGatePending && _serverConv != null) {
      _strangerGatePending = false;
      _threadAcceptState = 'accepted';
      StrangerGateApi.accept(_serverConv!);
      trackStrangerGate('stranger_gate_accept', {'conv': _serverConv!, 'implicit': true});
      // G1.2: an implicit accept (replying to a stranger) also auto-enables Guardian.
      _autoEnableGuardianOnAccept();
    }
    HapticFeedback.selectionClick(); // P9: subtle send confirmation
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final expire = _disappearSecs > 0 ? now + _disappearSecs : null;

    // ----- Ava routing (fresh sends only, never edits) -----
    // `@ava` / private mode = a personal call that is NOT sent to the peer.
    // `#ava` / public mode = shared: falls through to the normal send so the peer
    // sees clean human text while Ava also replies in the thread for both.
    if (_editing == null && onSummonAva != null) {
      final lower = t.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      final avaModePublic = _avaPublicMode && !shared && !atAva;
      final privateAva = (atAva && !shared) || avaModePrivate;
      if (privateAva || shared || avaModePublic) {
        // [WALLET-GET-STATE-1] 2026-07-25, owner decision (Root-Cause Report
        // §10/§12c): Ava-in-chat TEXT (@ava private / #ava shared) is FREE for
        // everyone — never metered, never paywalled. The premium gate that used
        // to sit here (and the `ava_chat_gate_blocked` toast/event it fired) is
        // removed; a client-side GET failure can no longer misread a premium
        // user as unentitled (Root-Cause Report §17), because there is nothing
        // left to gate. Attachments remain metered, but server-side
        // (worker/src/routes/ava_gemini.ts) — a 402 there is authoritative and
        // speaks for itself; this path never blocks on it.
        // Mode-driven plain text carries no marker, so prefix only the Ava copy.
        // The human chat still receives the clean text in public mode below.
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate
            ? '$_avaWakeWord $t'
            : (avaModePublic ? '$_avaShareWord $t' : t));
        if (privateAva) {
          _ragAddLine('You', t);
          _composerFocus.requestFocus();
          _mutMsgs(() {
            // aiLocal: rendered locally only, never sent → no delivery ticks.
            _msgs.add(_Msg(_seq++, true, t, _fmtTime(now), ts: now, aiLocal: true));
            _ctrl.clear(); _hasText = false; _replyTo = null;
          });
          _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
          if (_convKey != null) DraftStore().set(_convKey!, '');
          _schedulePersist();
          return;
        }
      }
    }

    // RAG memory: index this outgoing line into the user's own File Search store
    // (full-thread indexing — incoming lines are added in the receive handlers).
    _ragAddLine('You', t);
    // Tapping the send button steals focus from the field; grab it back so the
    // keyboard stays up and the user can keep typing without re-tapping the box.
    _composerFocus.requestFocus();

    // Editing an existing message?
    if (_editing != null && _editing!.evId != null) {
      final m = _editing!;
      final target = m.evId!;
      if (_isGroup && _gdm != null) {
        _gdm!.send(jsonEncode({'t': 'gedit', 'gid': _group!.id, 'target': target, 'body': t}));
      } else if (_realMode && _dm != null) {
        _dm!.send(jsonEncode({'t': 'edit', 'target': target, 'body': t}));
      }
      _mutMsgs(() { m.text = t; m.edited = true; _editing = null; _ctrl.clear(); _hasText = false; });
      _schedulePersist();
      return;
    }

    final replyMeta = _replyTo == null
        ? null
        : {
            'id': _replyTo!.evId ?? '',
            'preview': _replyTo!.text.length > 60 ? _replyTo!.text.substring(0, 60) : _replyTo!.text,
            'who': _replyTo!.me ? 'You' : (_replyTo!.senderLabel ?? widget.chat.name),
          };

    // STREAM C [PREVIEW-2]: compose-time link unfurl. The SENDER unfurls the
    // first URL and embeds the preview in the envelope (`preview:{...}`) so
    // recipients render the card from the envelope — zero recipient fetch. The
    // dispatch is delegated to _dispatchText so we can attach the preview once it
    // resolves (fast timeout; a link with no preview just sends without one).
    if (_isGroup && _gdm != null) {
      _dispatchText(
        t: t, now: now, replyMeta: replyMeta, expire: expire, isGroup: true);
      return;
    }
    if (_realMode && _dm != null) {
      _dispatchText(
        t: t, now: now, replyMeta: replyMeta, expire: expire, isGroup: false);
      return;
    }
    _mutMsgs(() {
      _msgs.add(_Msg(_seq++, true, t, 'now', replyTo: replyMeta));
      _ctrl.clear(); _hasText = false; _replyTo = null;
    });
    _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
    _schedulePersist();
  }


  /// STREAM C [PREVIEW-2]: send a text message, optionally embedding a
  /// compose-time link preview in the envelope. The optimistic bubble appears
  /// instantly (mirrors media sends); the actual wire dispatch waits for a fast
  /// unfurl ONLY when the text contains a URL and previews are enabled — so
  /// recipients render the card straight from `preview:{...}` (zero fetch). A URL
  /// that unfurls to nothing (or times out) simply sends without a preview.
  Future<void> _dispatchText({
    required String t,
    required int now,
    required Map<String, dynamic>? replyMeta,
    required int? expire,
    required bool isGroup,
  }) async {
    // WhatsApp parity: the composer already unfurled this URL while the user was
    // typing, so grab that result and send with ZERO extra latency. Snapshot the
    // compose state before we clear it below.
    final url = RemoteConfig.linkPreviewsEnabled ? _firstUrl(t) : null;
    final composeHit =
        (url != null && url == _composePreviewUrl) ? _composePreview : null;
    final composeDismissed = url != null && _composePreviewDismissed.contains(url);

    // Optimistic local bubble first — instant feel, independent of the unfurl.
    // [CSAM-GATE-1 2026-07-11] MUST NOT be `sent: true`. This bubble is created
    // BEFORE the outbox has even attempted the POST — sending true here made every
    // message show a "SENT ✓" tick immediately, including one the server later
    // 403s as identity_required (a first message to a stranger from an unverified
    // account). `_Msg`'s own default is `sent: false` ("Sending…") for exactly this
    // reason; only `_onSendStatus()` — driven by the outbox's real HTTP 200 ACK —
    // may flip this to true. Do not reintroduce an optimistic `sent: true` here.
    final tShownStart = DateTime.now().millisecondsSinceEpoch;
    final localMsg = _Msg(_seq++, true, t, _fmtTime(now),
        ts: now, replyTo: replyMeta, expireAt: expire,
        extra: composeHit == null ? null : {'preview': composeHit})
      ..sendStartedMs = tShownStart; // [AVA-CHAT-INSTANT] round-trip anchor
    _mutMsgs(() {
      _msgs.add(localMsg);
      _ctrl.clear();
      _hasText = false;
      _replyTo = null;
    });
    // [AVA-CHAT-INSTANT] Perceived-latency telemetry: how long until the bubble
    // was on screen (email auto-attached by Analytics._base).
    Analytics.capture('msg_optimistic_shown', {
      'kind': 'text', 'conv_kind': isGroup ? 'group' : 'dm',
      'ms_to_bubble': DateTime.now().millisecondsSinceEpoch - tShownStart,
    });
    _clearComposePreview();
    _composePreviewDismissed.clear();
    _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
    if (_convKey != null) DraftStore().set(_convKey!, '');

    // [MEDIA-INSTANT-1e / F5] The recipient's delivery must NEVER wait on a
    // network unfurl fetch (up to the 6s timeout in [_unfurl]) — a preview is
    // presentation metadata, not a delivery prerequisite. Only a preview
    // already resolved at COMPOSE time (while the user was typing) rides in
    // the envelope; everything else sends with no preview now and is patched
    // into the SENDER's own bubble asynchronously below, if/when it resolves.
    // Documented limitation (no cross-device `message_patch` protocol here):
    // a recipient only ever sees a card when the compose-time cache already
    // had one — a preview that resolves AFTER dispatch is visible to the
    // sender only. Building a durable patch broadcast is out of scope for this
    // change; see F5 in the messenger audit.
    final Map<String, dynamic>? preview = (composeHit != null && !composeDismissed) ? composeHit : null;

    final env = <String, dynamic>{
      't': isGroup ? 'gtext' : 'text',
      if (isGroup) 'gid': _group!.id,
      if (isGroup) 'fromName': _fromNameTag,
      'body': t,
      if (replyMeta != null) 'replyTo': replyMeta,
      if (expire != null) 'exp': expire,
      if (preview != null) 'preview': preview,
    };
    final id = isGroup ? _gdm!.send(jsonEncode(env)) : _dm!.send(jsonEncode(env));
    _seenEv.add(id);
    localMsg.evId = id;

    if (isGroup) {
      Analytics.capture('group_message_sent', {
        'gid': _group!.id, 'member_count': _group!.members.length, 'kind': 'text',
        'has_reply': replyMeta != null, 'expiring': expire != null,
        'has_preview': preview != null,
      });
      // [PUSH-FG-BANNER-1] Group conv keys are symmetric ('g:<gid>' — line 804),
      // so my key is also every member's key.
      PushService.notifyMessage(_memberUids, _myName ?? 'AvaTOK',
          preview: t, conv: 'g:${_group!.id}');
    } else if (_peerNpub != null) {
      // [PUSH-FG-BANNER-1] DM conv keys are device-RELATIVE ('1:<the other
      // person>' — line 644). My key for this thread is '1:$_peerNpub', but the
      // recipient's key for it is '1:<MY uid>'. Send theirs, not mine.
      final meUid = _meId?.uid ?? '';
      PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK',
          preview: t, conv: meUid.isNotEmpty ? '1:$meUid' : null);
    }
    _schedulePersist();

    // [MEDIA-INSTANT-1e / F5] Fire the unfurl AFTER dispatch, never before —
    // this is the fix for "link previews gate peer dispatch up to 6s". Only
    // ever patches the SENDER's own local bubble; see the doc note above.
    if (preview == null && url != null && !composeDismissed) {
      unawaited(_unfurl(url).then((p) {
        if (p == null || !mounted) return;
        _mutMsgs(() => localMsg.extra = {...?localMsg.extra, 'preview': p});
        _schedulePersist();
      }));
    }
  }


  /// First http(s) URL in [text], or null. Mirrors the worker/card regex.
  String? _firstUrl(String text) {
    final m = RegExp(r'https?://[^\s<>()]+', caseSensitive: false).firstMatch(text);
    return m?.group(0);
  }


  /// GET /api/unfurl?url=… (auth Clerk bearer). Returns the preview map or null.
  /// Best-effort with a short timeout so a slow site never delays a send much.
  Future<Map<String, dynamic>?> _unfurl(String url) async {
    try {
      final r = await ApiAuth.getSigned(
        '$kUnfurlUrl?url=${Uri.encodeQueryComponent(url)}',
        timeout: const Duration(seconds: 6),
      );
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body);
      if (j is! Map) return null;
      final type = (j['type'] ?? 'link').toString();
      Analytics.capture('unfurl_requested', {
        'type': type,
        'cached': false, // client can't see the KV hit; the server also logs it
        if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
      });
      // Only embed a preview that will actually render a card (else raw link).
      final hasCard = type == 'youtube' ||
          (type == 'link' &&
              (((j['title'] ?? '').toString().isNotEmpty) ||
                  ((j['image'] ?? '').toString().isNotEmpty)));
      return hasCard ? Map<String, dynamic>.from(j) : null;
    } catch (_) {
      return null;
    }
  }


  /// [CHAT-UI-LIST-1e] Gated autoscroll. `force:true` (every OWN send site)
  /// always jumps — WhatsApp always shows you your own outgoing message. For
  /// everything else (inbound DM/group messages, Ava replies, history loads)
  /// we only steal the reader's scroll position if they're already within
  /// ~120px of the newest edge; otherwise we count it as unseen and let the
  /// FAB (see `_scrollToBottomFab`) do the jump on tap. This replaces the old
  /// unconditional jump that fired from all 13 call sites and yanked the view
  /// out from under anyone reading back through history.
  void _jump({bool force = false}) {
    // [CHAT-UI-REVERSE-1] With reverse:true, scroll offset 0 is the newest/
    // bottom edge (it used to be maxScrollExtent) — "near bottom" is now
    // simply "near offset 0".
    if (!force && _scroll.hasClients) {
      final pos = _scroll.position;
      final nearBottom = pos.pixels <= 120;
      if (!nearBottom) {
        if (mounted) setState(() => _unseenCount++);
        return;
      }
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // [CHAT-UI-REVERSE-1] "jump to the newest message" is `jumpTo(0)` now,
      // not `jumpTo(maxScrollExtent)`.
      if (_scroll.hasClients) _scroll.jumpTo(0);
      // [CHAT-UI-LIST-1e] force:true jumps (own sends) land the reader on the
      // newest message, so any unseen badge from before the jump no longer
      // applies — clear it here too (not just on the FAB tap) so an own-send
      // jump never leaves a stale badge behind.
      if (_unseenCount != 0 && mounted) setState(() => _unseenCount = 0);
    });
  }


  /// [CHAT-UI-LIST-1e] Small circular scroll-to-bottom button with an unread
  /// badge — WhatsApp-style. Shown only while `_unseenCount > 0` (i.e. the
  /// reader was scrolled up when something new arrived). Tapping jumps to the
  /// newest message and clears the counter.
  Widget _scrollToBottomFab() {
    return GestureDetector(
      onTap: () {
        setState(() => _unseenCount = 0);
        _jump(force: true);
      },
      child: Stack(clipBehavior: Clip.none, children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: AD.sendActiveBg,
            shape: BoxShape.circle,
            boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 6, offset: Offset(0, 2))],
          ),
          child: Icon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), color: AD.sendActiveInk, size: 26),
        ),
        Positioned(
          right: -4,
          top: -4,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            constraints: const BoxConstraints(minWidth: 18),
            decoration: const BoxDecoration(color: AD.unreadAccent, shape: BoxShape.circle),
            child: Text(_unseenCount > 99 ? '99+' : '$_unseenCount',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w700)),
          ),
        ),
      ]),
    );
  }


  /// [CHAT-UI-REVERSE-1] Used to be "land on the latest message" via a
  /// post-frame `jumpTo(maxScrollExtent)` plus two settle-timer retries (rows/
  /// media still laying out could leave the view mid-thread) — all needed
  /// because a NON-reversed list opens at offset 0 (the TOP/oldest message)
  /// and had to be dragged down to the newest one, invisibly, before reveal.
  /// With `reverse: true` the newest message IS offset 0 natively, so a
  /// freshly-opened thread needs no jump at all. Kept as a no-op so the two
  /// existing call sites (history-load completion) don't need to change.
  void _jumpToEndSettled() {}
}
