part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadMenus on _ChatThreadScreenState {

  // ---- header overflow ----
  /// Phase A (Ava Copilot, D29/§6): on thread open, reset this conv's private
  /// Ava-lane unread counter (the user is looking at the lane now) and load the
  /// per-chat "Ava in this chat" switch state from the worker. Best-effort —
  /// failures leave the D29 default (ON) in place.
  void _initAvaChatState() {
    final key = _convKey;
    if (key == null) return;
    // ignore: unawaited_futures
    AvaUnread.clear(key);
    final conv = _serverConvId;
    if (conv == null) return;
    // ignore: unawaited_futures
    AvaChatToggle.fetch(conv).then((on) {
      if (mounted && on != _avaInChatOn) setState(() => _avaInChatOn = on);
    });
  }

  /// Flip "Ava in this chat" (D29) — optimistic local state, server write via
  /// POST /api/ava/chat-toggle. In groups only admins may flip it; the server
  /// enforces that, and a rejection quietly reverts the switch here.
  Future<void> _setAvaInChat(bool on) async {
    final conv = _serverConvId;
    if (conv == null) return;
    setState(() => _avaInChatOn = on);
    Analytics.capture('ava_chat_toggle', {
      'on': on, 'conv': conv, 'conv_kind': _isGroup ? 'group' : 'dm',
    });
    final ok = await AvaChatToggle.set(conv, on);
    if (!ok && mounted) {
      setState(() => _avaInChatOn = !on);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(_isGroup
            ? 'Only group admins can change Ava for this group.'
            : "Couldn't update Ava for this chat — try again."),
        duration: const Duration(seconds: 2),
      ));
    }
  }

  void _overflow() {
    // [PIVOT-AI-DARK-1] Observation point for the AI-dark flip. The thread menu
    // is user-initiated and low-volume, which makes it a far better place to
    // measure than the per-message smart-reply path. It records the flag state
    // AT THE MOMENT the AI rows would have been drawn, so a prod flip can be
    // verified by a property VALUE (ai_enabled=false) rather than by the absence
    // of some other event — absence is also what "nobody opened a chat" looks
    // like, and that ambiguity is what let three fixes ship dead on 2026-08-08.
    Analytics.capture('chat_thread_menu_opened', {
      'ai_enabled': RemoteConfig.aiEnabled,
      'discuss_with_ava_enabled': RemoteConfig.discussWithAvaEnabled,
      'is_group': widget.chat.group || widget.chat.gid != null,
    });
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      // This sheet grows to ~14 rows depending on thread type (group, tel
      // thread, unsaved caller, flags). Without isScrollControlled the sheet is
      // capped near half-screen and the tail items (Mute / Block / Delete) were
      // clipped off the bottom with no way to scroll to them.
      isScrollControlled: true,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          if (_isTelThread && !_callerSaved)
            _action(ctx, PhosphorIcons.userPlus(PhosphorIconsStyle.bold), 'Save to contacts',
                () { Navigator.pop(ctx); _saveUnknownContact(source: 'thread_menu'); }),
          // [PIVOT-AI-SWITCHES-1] RemoteConfig.discussWithAvaEnabled falls back to
          // kDiscussWithAvaEnabled on a config-fetch failure, so this reads the
          // server flag first and the compile const only as a safety net. It used
          // to read the const alone, which meant disabling this AI surface needed
          // a new APK and a store rollout.
          // [PIVOT-AI-DARK-1] aiEnabled is the master; discussWithAvaEnabled is
          // the per-surface switch. Both must be on.
          if (RemoteConfig.aiEnabled &&
              RemoteConfig.discussWithAvaEnabled &&
              _convKey != null)
            _action(ctx, PhosphorIcons.sparkle(PhosphorIconsStyle.bold), 'Discuss with Ava',
                _discussWithAva),
          // Phase A (Ava Copilot, D29): per-chat "Ava in this chat" switch —
          // ON by default. 1:1 = your own Ava only; groups = admins only (the
          // server enforces; a rejected flip reverts quietly). OFF hides the
          // Ava doc context-menu items and stops copilot processing here.
          // [PIVOT-AI-DARK-1] The per-chat "Ava in this chat" switch is itself an
          // AI affordance — offering the user a toggle for a feature the platform
          // has turned off is worse than offering nothing.
          if (RemoteConfig.aiEnabled && _convKey != null)
            StatefulBuilder(builder: (sctx, setSheet) => SwitchListTile(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                  secondary: Icon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: AD.textPrimary),
                  title: Text('Ava in this chat', style: ADText.rowName(c: AD.textPrimary)),
                  subtitle: Text(
                      _avaInChatOn ? 'Ava can help in this chat' : 'Ava is off for this chat',
                      style: ADText.preview(c: AD.textTertiary)),
                  value: _avaInChatOn,
                  activeColor: AD.textPrimary,
                  onChanged: (v) async {
                    await _setAvaInChat(v);
                    if (sctx.mounted) setSheet(() {});
                  },
                )),
          // STREAM G [GROUP-AI-1]: catch-up on a busy group thread. Shown only for
          // a group with >25 unread; the guardrail is re-checked in _whatDidIMiss.
          //
          // [LAUNCH-DARK-1 2026-09-05] `aiEnabled` added. The gated helper
          // `_catchupAvailable()` already existed in ai_assist.dart and already
          // checked this — it was simply never called here, so the row rendered
          // on the raw unread count while the engine refused, i.e. a visible
          // dead button.
          if (RemoteConfig.aiEnabled &&
              (widget.chat.group || widget.chat.gid != null) &&
              _unreadIncoming > 25)
            _action(ctx, PhosphorIcons.sparkle(PhosphorIconsStyle.bold), 'What did I miss?',
                () { Navigator.pop(ctx); _whatDidIMiss(); }),
          // STREAM G [GROUP-AI-2/3]: per-member "translate this group for me".
          // Hidden while the groupTranslationEnabled flag (cost watch) is OFF.
          if ((widget.chat.group || widget.chat.gid != null) && RemoteConfig.groupTranslationEnabled)
            _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold),
                _groupTranslateOn ? 'Stop translating this group' : 'Translate this group for me',
                () { Navigator.pop(ctx); _toggleGroupTranslate(); }),
          _action(ctx, PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), 'Search',
              () { Navigator.pop(ctx); setState(() { _searchMode = true; _searchQuery = ''; }); }),
          _action(ctx, PhosphorIcons.images(PhosphorIconsStyle.bold), 'Media, links & docs',
              () { Navigator.pop(ctx); _openMediaLibrary(); }),
          _action(
              ctx,
              _hideDeleted
                  ? PhosphorIcons.eye(PhosphorIconsStyle.bold)
                  : PhosphorIcons.eyeSlash(PhosphorIconsStyle.bold),
              _hideDeleted ? 'Show deleted messages' : 'Hide deleted messages',
              () { Navigator.pop(ctx); _toggleHideDeleted(); }),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.timer(PhosphorIconsStyle.bold),
                _disappearSecs == 0 ? 'Disappearing messages' : 'Disappearing: ${_disappearLabel(_disappearSecs)}',
                _pickDisappear),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.paintRoller(PhosphorIconsStyle.bold), 'Chat theme', _pickWallpaper),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.archive(PhosphorIconsStyle.bold), 'Archive chat', () async {
              await ChatFlagsStore().toggle('archived', _convKey!);
              if (mounted) Navigator.pop(context);
            }),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.bellSlash(PhosphorIconsStyle.bold), 'Mute chat',
                () => ChatFlagsStore().toggle('muted', _convKey!)),
          if (_convKey != null && !widget.chat.group)
            _action(ctx, PhosphorIcons.prohibit(PhosphorIconsStyle.bold), 'Block user', () async {
              await ChatFlagsStore().toggle('blocked', _convKey!);
              if (mounted) Navigator.pop(context);
            }, danger: true),
          // [DELETE-CHAT-1 2026-08-17] This used to be `() => Navigator.pop(context)`:
          // the button closed the sheet and did NOTHING. No wipe, no server call,
          // no confirmation — so a "deleted" chat was simply re-materialised from
          // the server on the next launch, which is the owner's "old deleted
          // messages come back" report. It now actually clears the thread.
          _action(ctx, PhosphorIcons.broom(PhosphorIconsStyle.bold), 'Delete chat', () async {
            // NO Navigator.pop here — `_action`'s own wrapper already closed the
            // sheet. A second pop closed the THREAD route, so the confirm dialog
            // opened on a dying route and `mounted` was false by the time the
            // user tapped Delete: the cursor was written but the on-screen wipe
            // and the telemetry were both skipped.
            final ck = _convKey;
            if (ck == null || ck.isEmpty) return;
            // Destructive and (for now) local-only — ask first.
            final ok = await showDialog<bool>(
              context: context,
              builder: (dctx) => AlertDialog(
                backgroundColor: AD.overlaySheet,
                title: Text('Delete this chat?', style: ADText.rowName()),
                content: Text(
                  'Messages in this chat will be removed from all your devices. '
                  'This does not delete them for the other person.',
                  style: ADText.preview(),
                ),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(dctx, false),
                      child: Text('Cancel', style: ADText.rowName())),
                  TextButton(onPressed: () => Navigator.pop(dctx, true),
                      child: Text('Delete', style: ADText.rowName(c: AD.danger))),
                ],
              ),
            );
            if (ok != true) return;
            // [DELETE-CHAT-XDEV-1] One cursor, used for both halves, so the
            // local view and every other device agree on exactly where the
            // clear line sits.
            final cursorMid = ThreadClearStore.nowCursorMid();
            final cut = ThreadClearStore.tsSecFromMid(cursorMid);
            await ThreadClearStore().clearThrough(ck, cut);
            // Tell the server, so my OTHER devices clear too. The server keeps a
            // monotonic per-conversation cursor in my own InboxDO, wakes my other
            // devices with a silent push, and replays the cursor in every /sync —
            // all of which already existed and had no client calling it.
            // SELF-SCOPED by construction: it touches only my own InboxDO and
            // never writes to or pushes at the peer.
            final srvConv = _serverConvId;
            if (srvConv != null && srvConv.isNotEmpty) {
              // Same cursor under the SERVER key too — that is the namespace the
              // /sync snapshot and the wake push come back in.
              await ThreadClearStore().clearThrough(srvConv, cut);
              unawaited(ApiAuth.postJson(kMsgHideUrl, {
                'clear': true,
                'conv': srvConv,
                'cursor_mid': cursorMid,
                'op_id': const Uuid().v4(),
              }).then(
                (res) => Analytics.capture('chat_thread_clear_sent', {
                  'ok': res.statusCode == 200, 'status': res.statusCode,
                }),
                onError: (Object e) => Analytics.capture('chat_thread_clear_sent', {
                  'ok': false, 'err': e.toString(),
                }),
              ));
            }
            // Also drop the chat-list subtitle, or the row keeps showing the last
            // message of a chat the user just deleted.
            await ChatPreviewStore().remove(ck);
            if (!mounted) return;
            _clearedThroughTs = cut;
            // Drop what is on screen now. The cursor is what keeps it gone: sync
            // re-inserts these rows unconditionally, and the render filters in
            // persistence.dart / the cold-open pass are what hide them again.
            _mutMsgs(() => _msgs.removeWhere((m) => m.ts > 0 && m.ts <= cut));
            Analytics.capture('chat_thread_cleared', {
              'group': widget.chat.group,
              'cut_ts': cut,
              // Scope marker. 'all_my_devices' when the server accepted the
              // cursor; 'local_only' for a tel/voicemail thread, which has no
              // server conv id and therefore nothing to sync.
              //
              // KNOWN LIMIT: the cursor is stored in whole SECONDS (matching
              // _Msg.ts), so a message arriving later in the same wall-clock
              // second as the delete is hidden too. The server compares the same
              // cursor at millisecond precision, so the two can disagree inside
              // that one-second window.
              'scope': (_serverConvId ?? '').isEmpty ? 'local_only' : 'all_my_devices',
            });
          }, danger: true),
          ]),
        ),
      ),
    );
  }

  /// Toggle (and remember, per-conversation) whether deleted-message pills and
  /// tombstones are hidden from the thread.
  Future<void> _toggleHideDeleted() async {
    final next = !_hideDeleted;
    setState(() => _hideDeleted = next);
    try {
      await _aiPrefs.write(
          key: scopedKey('${_kHideDeletedKey}_${widget.chat.seed}'),
          value: next ? '1' : '0');
    } catch (_) {/* preference best-effort */}
    Analytics.capture('chat_hide_deleted_toggled', {'on': next});
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(next ? 'Deleted messages hidden' : 'Deleted messages shown'),
        duration: const Duration(seconds: 2),
      ));
    }
  }

  /// "Discuss with Ava" — open ChatAVA (the Companion thread) pointed at THIS
  /// conversation. The transcript is assembled on-device from the already-decoded
  /// bubbles and passed transiently as grounding context; it is never indexed
  /// server-side (DM/group content stays on the phone). Gated at use by the
  /// matching AvaBrain consent toggle.
  Future<void> _discussWithAva() async {
    final isGroup = widget.chat.group || widget.chat.gid != null;
    // Consent gate: DMs use 'avatok_dms' (on-device only), groups 'group_chats'.
    final allowed = await BrainConsent.isOn(isGroup ? 'group_chats' : 'avatok_dms');
    if (!mounted) return;
    if (!allowed) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Turn on AvaBrain for your messages in Settings to discuss '
            'a chat with Ava. Your messages stay on this device.'),
      ));
      return;
    }
    // Build the transcript from the visible bubbles (skip Ava/system/special).
    final turns = <DiscussTurn>[];
    for (final m in _msgs) {
      if (m.special != null) continue; // ava bubbles, receipts, calls, etc.
      final text = m.text.trim();
      if (text.isEmpty) continue;
      // Groups: attribute each non-mine bubble to its sender so Ava can tell
      // participants apart. 1:1 falls back to the peer label.
      turns.add(DiscussTurn(me: m.me, text: text, speaker: m.me ? null : m.senderLabel));
    }
    // Long threads need a summarisation pass — let the user know we're reading.
    if (turns.length > ThreadContext.kRawTailTurns * 4) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        duration: Duration(seconds: 2),
        content: Text('Reading your chat for Ava…'),
      ));
    }
    // Assemble the grounding block on-device. Short threads come back verbatim;
    // long ones are map-reduce summarised (recent tail kept raw) to stay lean.
    final transcript = await ThreadContext.buildSmart(
      peerLabel: widget.chat.name,
      turns: turns,
      isGroup: isGroup,
      summarize: (chunk) async {
        final ans = await AvaAiClient.I.ask(
          message: 'Summarise these chat messages in 2-3 sentences. Preserve who '
              'said what and any decisions, plans, questions, or feelings:\n\n$chunk',
        );
        return ans.answer;
      },
    );
    if (!mounted) return;
    if (transcript.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Not enough messages here yet for Ava to weigh in.'),
      ));
      return;
    }
    Analytics.capture('discuss_with_ava_opened', {
      'surface': 'thread',
      'is_group': isGroup,
      'turns': turns.length,
      'chars': transcript.length,
      'summarized': transcript.contains('(summarised)'),
    });
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CompanionThreadScreen(
        persona: discussPersona(widget.chat.name, isGroup: isGroup),
        discussContext: transcript,
        initialTitle: 'Chat with ${widget.chat.name}',
        onUseDraft: _prefillComposer,
      ),
    ));
  }

  /// Pre-fill the composer with a draft Ava handed back from "Discuss with Ava".
  /// We never auto-send — the user reviews/edits before it goes to the peer.
  void _prefillComposer(String text) {
    _ctrl.text = text;
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    _composerFocus.requestFocus();
  }

  /// Open the chat library — every photo, video, link and doc shared here.
  void _openMediaLibrary() {
    final media = <ChatMedia>[];
    final docs = <ChatMedia>[];
    final links = <LinkItem>[];
    final linkRe = RegExp(r'(https?://[^\s]+)', caseSensitive: false);
    for (final m in _msgs) {
      if (m.media != null) {
        final k = m.media!.kind;
        if (k == MediaKind.image || k == MediaKind.video) {
          media.add(m.media!);
        } else {
          docs.add(m.media!); // file + audio/voice
        }
      }
      for (final match in linkRe.allMatches(m.text)) {
        final url = match.group(1);
        if (url != null) links.add(LinkItem(url: url, ts: m.ts, me: m.me));
      }
    }
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => MediaLibraryScreen(
            title: widget.chat.name, media: media, docs: docs, links: links)));
  }

  String _disappearLabel(int s) => s == 0 ? 'Off' : (s >= 604800 ? '1 week' : (s >= 86400 ? '1 day' : '1 hour'));

  void _pickDisappear() {
    showModalBottomSheet(
      context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.all(14),
            child: Text('Disappearing messages', style: ADText.threadName())),
        for (final opt in [['Off', 0], ['1 hour', 3600], ['1 day', 86400], ['1 week', 604800]])
          ListTile(
            title: Text(opt[0] as String),
            trailing: _disappearSecs == opt[1]
                ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.iconSearch)
                : null,
            onTap: () async {
              final secs = opt[1] as int;
              await ChatTimerStore().set(_convKey!, secs == 0 ? '' : '$secs');
              if (mounted) { setState(() => _disappearSecs = secs); Navigator.pop(ctx); }
            },
          ),
      ])),
    );
  }
  Future<void> _maybeShowPasteHint() async {
    try {
      final seen = await readScoped(_aiPrefs, _kPasteHintKey);
      if (seen == '1') return;
      await _aiPrefs.write(key: scopedKey(_kPasteHintKey), value: '1');
      if (mounted) _capNote('Tip: long-press the message box to paste images');
    } catch (_) {/* best-effort */}
  }

  // ---- attach menu (+) ----
  void _attach() {
    // ignore: unawaited_futures
    _maybeShowPasteHint();
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(spacing: 18, runSpacing: 18, children: [
            _attachItem(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Photos', AD.iconSearch, _pickPhotos),
            // [CHAT-PASTE-1] 'Paste image' removed — the message box already pastes
            // images natively (keyboard commitContent + context-menu Paste). A
            // one-time hint (below) points users at the long-press paste instead.
            _attachItem(ctx, PhosphorIcons.camera(PhosphorIconsStyle.bold), 'Camera', AD.primaryBadge, () => _pickImage(ImageSource.camera)),
            _attachItem(ctx, PhosphorIcons.folderOpen(PhosphorIconsStyle.bold), 'Library', AD.online, _addFromLibrary),
            _attachItem(ctx, PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), 'Video', AD.danger, () => _pickVideo(ImageSource.camera)),
            _attachItem(ctx, PhosphorIcons.file(PhosphorIconsStyle.bold), 'File', AD.iconVideo, _pickFile),
            _attachItem(ctx, PhosphorIcons.mapPin(PhosphorIconsStyle.bold), 'Location', AD.online, _shareLocation),
            _attachItem(ctx, PhosphorIcons.broadcast(PhosphorIconsStyle.bold), 'Live location', AD.danger, _shareLiveLocation),
            _attachItem(ctx, PhosphorIcons.user(PhosphorIconsStyle.bold), 'Contact', AD.iconSearch, _shareContactCard),
            _attachItem(ctx, PhosphorIcons.chartBar(PhosphorIconsStyle.bold), 'Poll', AD.primaryBadge, _createPoll),
            _attachItem(ctx, PhosphorIcons.smiley(PhosphorIconsStyle.bold), 'Sticker', AD.iconVideo, _stickerPicker),
          ]),
        ),
      ),
    );
  }

  // Attachment tile — zine icon badge (flat accent fill, ink border, hard
  // shadow) + mono label. Accents rotate per tile (§6).
  Widget _attachItem(BuildContext ctx, IconData icon, String label, Color color, VoidCallback onTap) =>
      GestureDetector(
        onTap: () { Navigator.pop(ctx); onTap(); },
        child: SizedBox(
          width: 72,
          child: Column(children: [
            Container(width: 56, height: 56,
                decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(AD.rListCard),
                    border: Border.all(color: AD.borderControl, width: 1),
                    boxShadow: const []),
                child: Icon(icon, color: color == AD.danger ? Colors.white : AD.textPrimary, size: 24)),
            const SizedBox(height: 8),
            Text(label, style: ADText.statCaption(c: AD.textSecondary)),
          ]),
        ),
      );
}
