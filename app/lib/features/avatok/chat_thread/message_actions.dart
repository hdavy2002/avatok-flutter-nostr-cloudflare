part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadActions on _ChatThreadScreenState {

  Future<void> _openGroupInfo() async {
    if (widget.chat.gid == null) return;
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    final left = await Navigator.push<bool>(context,
        MaterialPageRoute(builder: (_) => GroupInfoScreen(group: g)));
    if (left == true && mounted) Navigator.pop(context); // left/deleted → close thread
  }

  Future<void> _openVideo(_Msg m) async {
    if (m.media == null && m.localBytes == null) return;
    if (m.media != null) {
      Navigator.push(context, MaterialPageRoute(
          builder: (_) => VideoPlayerScreen(media: m.media!, bytes: m.localBytes)));
    }
  }

  /// The image URL carried by an Ava-generated image bubble (envelope
  /// `media_ref`), or '' if this message isn't one. Lets "Copy image" / viewer
  /// work on Ava images too, which have no `m.media`.
  String _imageRefOf(_Msg m) => (m.extra?['media_ref'] ?? '').toString();

  /// True when the message shows an image — a real chat photo OR an Ava image.
  bool _msgHasImage(_Msg m) =>
      m.media?.kind == MediaKind.image || _imageRefOf(m).isNotEmpty;

  // ---- Phase 5: floating reaction pill (anchored to the bubble) ----
  void _closeReactionOverlay() {
    _reactionOverlay?.remove();
    _reactionOverlay = null;
  }

  // Long-press / right-click a bubble → a floating emoji pill + compact action
  // menu anchored to the touch point (iMessage / WhatsApp style), instead of a
  // bottom sheet. "+" opens the full emoji picker; "More…" opens the full menu.
  void _onBubbleLongPressAt(_Msg m, Offset pos) {
    HapticFeedback.mediumImpact();
    // Close the keyboard before measuring the available overlay height. The old
    // menu used the full screen size while the IME still occupied its lower
    // half, hiding Edit/Delete/Info exactly when the composer had focus.
    FocusManager.instance.primaryFocus?.unfocus();
    Analytics.capture('chat_reaction_pill_open', {'group': widget.chat.group});
    _closeReactionOverlay();
    final media = MediaQuery.of(context);
    final size = media.size;
    final usableBottom = size.height - media.viewInsets.bottom - media.padding.bottom;
    const pillW = 312.0;
    final left = pos.dx.clamp(12.0, math.max(12.0, size.width - pillW - 12.0)).toDouble();
    final top = (pos.dy - 64).clamp(90.0, math.max(90.0, usableBottom - 360.0)).toDouble();
    const quick = ['❤️', '👍', '😂', '😮', '😢', '👏'];
    final hasImage = _msgHasImage(m);

    Widget pillBtn(Widget child, VoidCallback onTap) => GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: child,
          ),
        );

    Widget menuRow(IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
        InkWell(
          onTap: () { _closeReactionOverlay(); onTap(); },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            child: Row(children: [
              Icon(icon, size: 18, color: danger ? AD.danger : AD.textPrimary),
              const SizedBox(width: 12),
              Text(label, style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
            ]),
          ),
        );

    _reactionOverlay = OverlayEntry(builder: (octx) => Stack(children: [
          // Tap anywhere to dismiss.
          Positioned.fill(child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _closeReactionOverlay,
            child: Container(color: Colors.black.withOpacity(0.05)),
          )),
          Positioned(
            left: left, top: top, width: pillW,
            child: Material(
              color: Colors.transparent,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                // Floating emoji pill.
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  decoration: BoxDecoration(
                    color: AD.overlaySheet,
                    borderRadius: BorderRadius.circular(Msg.rMd),
                    border: Border.all(color: AD.borderControl, width: 2),
                    boxShadow: const [],
                  ),
                  child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    for (final e in quick)
                      pillBtn(
                        Text(e, style: TextStyle(fontSize: m.reaction == e ? 30 : 26)),
                        () { _closeReactionOverlay(); _react(m, e); },
                      ),
                    // "+" → full emoji picker.
                    pillBtn(
                      Container(
                        width: 30, height: 30, alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: AD.card, shape: BoxShape.circle,
                          border: Border.all(color: AD.borderControl, width: 1.5)),
                        child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 15, color: AD.textPrimary),
                      ),
                      () async {
                        _closeReactionOverlay();
                        final picked = await _openEmojiPicker();
                        if (picked != null) {
                          Analytics.capture('chat_react_custom_emoji', {'emoji': picked});
                          _react(m, picked);
                        }
                      },
                    ),
                  ]),
                ),
                const SizedBox(height: 8),
                // Compact action menu.
                Container(
                  decoration: BoxDecoration(
                    color: AD.overlaySheet,
                    borderRadius: BorderRadius.circular(Msg.rLg),
                    border: Border.all(color: AD.borderControl, width: 2),
                    boxShadow: const [],
                  ),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    menuRow(PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), 'Reply',
                        () => setState(() => _replyTo = m)),
                    if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                      menuRow(PhosphorIcons.copy(PhosphorIconsStyle.bold),
                          m.media != null ? 'Copy caption' : 'Copy text', () => _copyText(m)),
                    if (hasImage)
                      menuRow(PhosphorIcons.image(PhosphorIconsStyle.bold), 'Copy image',
                          () => _copyImageFromMsg(m)),
                    menuRow(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), 'Forward', () => _forward(m)),
                    menuRow(PhosphorIcons.star(m.starred ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                        m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
                    if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
                      menuRow(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', () => _startEdit(m)),
                    // [AVAGRP-BUBBLE-1 / message-info] WhatsApp only shows "Info"
                    // on YOUR OWN sent messages — never on an incoming bubble.
                    if (m.me && m.ts > 0)
                      menuRow(PhosphorIcons.info(PhosphorIconsStyle.bold), 'Info', () => _showMessageInfo(m)),
                    menuRow(PhosphorIcons.dotsThree(PhosphorIconsStyle.bold), 'More…',
                        () => _onBubbleLongPress(m)),
                  ]),
                ),
              ]),
            ),
          ),
        ]));
    Overlay.of(context).insert(_reactionOverlay!);
  }

  // ---- bubble long-press actions ----
  void _onBubbleLongPress(_Msg m) {
    HapticFeedback.mediumImpact();
    FocusManager.instance.primaryFocus?.unfocus();
    final hasImage = _msgHasImage(m);
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      // Tall menus must be able to grow + scroll; the default sheet clips its
      // child. isScrollControlled lets it size up, the ListView scrolls, and
      // SafeArea keeps the last items clear of the phone's nav bar.
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.8),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            // Fixed header: quick reactions.
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
                for (final e in ['❤️', '👍', '😂', '😮', '😢', '👏'])
                  GestureDetector(
                    onTap: () { Navigator.pop(ctx); _react(m, e); },
                    child: Text(e, style: const TextStyle(fontSize: 28)),
                  ),
              ]),
            ),
            const Divider(height: 24),
            // Scrollable action list — grows with the number of items and
            // scrolls when it can't fit, so nothing hides off-screen.
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 8),
                children: [
                  _action(ctx, PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), 'Reply', () => setState(() => _replyTo = m)),
                  if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                    _action(ctx, PhosphorIcons.copy(PhosphorIconsStyle.bold),
                        m.media != null ? 'Copy caption' : 'Copy text', () => _copyText(m)),
                  // Copy a detected link. When the bubble holds exactly one URL
                  // we copy it straight; with several we pop a small chooser.
                  if (urlSpans(m.text).isNotEmpty)
                    _action(ctx, PhosphorIcons.link(PhosphorIconsStyle.bold),
                        urlSpans(m.text).length > 1 ? 'Copy link…' : 'Copy link',
                        () => _copyLink(m)),
                  // Copy the actual IMAGE to the clipboard (paste into any app).
                  if (hasImage)
                    _action(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Copy image',
                        () => _copyImageFromMsg(m)),
                  _action(ctx, PhosphorIcons.pushPin(PhosphorIconsStyle.bold), 'Pin message', () => _pinMessage(m)),
                  _action(ctx, PhosphorIcons.star(m.starred ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                      m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
                  if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
                    _action(ctx, PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', () => _startEdit(m)),
                  // STREAM G [GROUP-AI-5]: inline translate any text bubble into the
                  // user's remembered language (added via the existing _action menu
                  // extension point — no Stream K geometry change).
                  //
                  // [LAUNCH-DARK-1 2026-09-05] `aiEnabled` added. This checked
                  // only AvaBrain consent, while its GROUP sibling in menus.dart
                  // was gated on `groupTranslationEnabled` — an inconsistency,
                  // not a design choice, and it left a live AI call in the
                  // message menu with AI nominally dark.
                  if (RemoteConfig.aiEnabled &&
                      m.text.trim().isNotEmpty &&
                      m.special != 'ava_status')
                    _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold), 'Translate',
                        () => _inlineTranslate(m)),
                  // Voice notes: transcribe the audio (cloud Whisper) and/or
                  // translate that transcript. Viewer-only, cached per message.
                  //
                  // [LAUNCH-DARK-1] Same treatment — these run Whisper and a
                  // translation model and were behind no AI flag at all.
                  if (RemoteConfig.aiEnabled && _isVoiceNote(m)) ...[
                    _action(ctx, PhosphorIcons.textAa(PhosphorIconsStyle.bold), 'Transcribe',
                        () => _transcribeVoice(m)),
                    _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold), 'Translate',
                        () => _translateVoice(m)),
                  ],
                  // [AVA-DOC-ARTIFACT-1] Ava doc actions on doc/PDF/image
                  // bubbles — Summarize ✨ · Translate ✨, in the plan's order
                  // BEFORE the download/share rows. Each now creates a durable
                  // AiMediaJob artifact (Part VI §38/§45) instead of the old
                  // inline-only dialog; "Auto-translate file" is retired since
                  // Translate itself always produces a file now. Hidden when
                  // "Ava in this chat" is off (D29) or the message has no
                  // server media ref.
                  ...AvaDocActions.menuItems(
                    sheetContext: ctx,
                    threadContext: context,
                    conv: _serverConvId,
                    mediaRef: m.media?.id,
                    name: m.media?.name,
                    show: _avaInChatOn &&
                        m.media != null &&
                        (m.media!.kind == MediaKind.file ||
                            m.media!.kind == MediaKind.image),
                    // [AVA-DOC-ARTIFACT-1] Summarize/Translate now create a
                    // durable AiMediaJob instead of an inline-only dialog; the
                    // shared outcome handler inserts the pending card (and
                    // renders the 402 "out of tokens" message, never a
                    // generic failure — see _handleJobOutcome's own note).
                    onOutcome: _handleJobOutcome,
                    prepareReadableCopy: (_) => _prepareAvaReadableCopy(m),
                  ),
                  _action(ctx, PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), 'Forward', () => _forward(m)),
                  // [AVAGRP-BUBBLE-1 / message-info] "Info" (§4, WhatsApp-style):
                  // how many members have seen my message. Own-message-only, same
                  // gate as the floating-pill menu above.
                  if (m.me && m.ts > 0)
                    _action(ctx, PhosphorIcons.info(PhosphorIconsStyle.bold), 'Info', () => _showMessageInfo(m)),
                  // Share OUT to another app (WhatsApp, Files, etc.) via the OS
                  // share sheet — works for any media, including voice notes.
                  if (m.media != null || m.localBytes != null)
                    _action(ctx, PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), 'Share to other apps', () => _shareMedia(m)),
                  if (m.media != null)
                    _action(ctx, PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.bold), 'Save to my AvaTOK Drive', () => _saveMediaToDrive(m)),
                  _action(ctx, PhosphorIcons.trash(PhosphorIconsStyle.bold), 'Delete for me', () => _deleteForMe(m)),
                  _action(ctx, PhosphorIcons.trashSimple(PhosphorIconsStyle.bold), 'Delete for everyone', () => _deleteForEveryone(m), danger: true),
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _action(BuildContext ctx, IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
      ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        leading: Icon(icon, color: danger ? AD.danger : AD.textPrimary),
        title: Text(label,
            style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
        onTap: () { Navigator.pop(ctx); onTap(); },
      );

  /// Copy a bubble's text (or a media caption) to the system clipboard — e.g.
  /// copy Ava's private reply, flip out of Ava-mode, and paste it to the person.
  void _copyText(_Msg m) {
    final text = m.text.trim();
    if (text.isEmpty) return;
    Clipboard.setData(ClipboardData(text: text));
    HapticFeedback.selectionClick();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)));
    }
  }

  /// Copy a URL detected inside a bubble to the clipboard. One link → copied
  /// straight; multiple links → a small chooser so the user picks which one.
  Future<void> _copyLink(_Msg m) async {
    final urls = urlSpans(m.text).map((s) => s.url).toList();
    if (urls.isEmpty) return;
    String url = urls.first;
    if (urls.length > 1) {
      final picked = await showModalBottomSheet<String>(
        context: context,
        backgroundColor: AD.overlaySheet,
        shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
        builder: (ctx) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('Copy which link?', style: ADText.rowName()),
              ),
            ),
            for (final u in urls)
              ListTile(
                leading: Icon(PhosphorIcons.link(PhosphorIconsStyle.bold), color: AD.textPrimary),
                title: Text(u, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.preview(c: AD.textPrimary)),
                onTap: () => Navigator.pop(ctx, u),
              ),
          ]),
        ),
      );
      if (picked == null) return;
      url = picked;
    }
    await Clipboard.setData(ClipboardData(text: url));
    HapticFeedback.selectionClick();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Link copied'), duration: Duration(seconds: 1)));
    }
    Analytics.capture('chat_link_copied', {'count': urls.length});
  }

  Future<void> _toggleStar(_Msg m) async {
    if (m.evId == null) { _mutMsgs(() => m.starred = !m.starred); return; }
    final set = await _starStore.toggle(m.evId!);
    if (mounted) _mutMsgs(() { _starred = set; m.starred = set.contains(m.evId); });
  }

  void _startEdit(_Msg m) {
    setState(() {
      _editing = m; _replyTo = null;
      _ctrl.text = m.text; _hasText = m.text.trim().isNotEmpty;
    });
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
  }

  Future<void> _pinMessage(_Msg m) async {
    if (_convKey == null) return;
    final pin = {'id': m.evId ?? '${m.id}', 'text': m.text};
    await PinnedMsgStore().set(_convKey!, jsonEncode(pin));
    if (mounted) setState(() => _pinned = pin);
  }

  Future<void> _unpin() async {
    if (_convKey == null) return;
    await PinnedMsgStore().set(_convKey!, '');
    if (mounted) setState(() => _pinned = null);
  }

  void _openInfo() {
    if (widget.chat.group) { _openGroupInfo(); return; }
    if (!widget.chat.seed.startsWith('user_')) return;
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => ContactProfileScreen(
            name: widget.chat.name, uid: widget.chat.seed,
            avatarUrl: widget.chat.avatarUrl.isEmpty ? null : widget.chat.avatarUrl,
            me: _meId)));
  }

  /// [AVA-GRP-UI] Open the full profile popup — photo, name, AvaTOK number and
  /// the QR "add me" share card — for a tapped avatar (a group member's bubble
  /// avatar, or a 1:1 peer). Reuses the existing `ContactProfileScreen`, whose
  /// own header carries a back button that returns to the chat; we do not build
  /// a bespoke sheet. Only opens for a real user id (Clerk `user_…`); Ava and
  /// unknown-number `tel:` rows have no profile and are skipped by the callers.
  /// `from` records the tap surface for telemetry (`grp_profile_popup_opened`);
  /// the viewer's email/phone are auto-stamped by `Analytics._base`.
  void _openMemberProfile({
    required String uid,
    required String name,
    String? avatarUrl,
    required String from,
  }) {
    if (uid.isEmpty || !uid.startsWith('user_')) return;
    Analytics.capture('grp_profile_popup_opened', {
      'from': from,
      'gid': widget.chat.gid ?? '',
      'group': widget.chat.group,
    });
    final url = (avatarUrl?.isNotEmpty ?? false) ? avatarUrl : _memberAvatars[uid];
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => ContactProfileScreen(
            name: name, uid: uid,
            avatarUrl: (url?.isNotEmpty ?? false) ? url : null,
            me: _meId)));
  }

  void _react(_Msg m, String emoji) {
    final adding = m.reaction != emoji;
    final prev = m.reaction;
    final myUidTag = _meId?.uid ?? 'me';
    _mutMsgs(() {
      // Maintain MY single reaction + the aggregate count shown on the bubble.
      if (prev != null) { // remove my previous emoji from the tally
        m.reactCounts[prev] = ((m.reactCounts[prev] ?? 1) - 1).clamp(0, 9999);
        if (m.reactCounts[prev] == 0) m.reactCounts.remove(prev);
        m.reactBy[prev]?.remove(myUidTag);
        if (m.reactBy[prev]?.isEmpty ?? false) m.reactBy.remove(prev);
      }
      m.reaction = adding ? emoji : null;
      if (adding) {
        m.reactCounts[emoji] = (m.reactCounts[emoji] ?? 0) + 1;
        m.reactBy.putIfAbsent(emoji, () => <String>{}).add(myUidTag);
      }
    });
    Analytics.capture('chat_reaction', {'emoji': emoji, 'op': adding ? 'add' : 'remove'});
    HapticFeedback.lightImpact();
    if (adding) {
      final file = _reactionSounds[emoji];
      if (file != null) {
        _sfx.stop();
        _sfx.play(AssetSource('sounds/$file.wav'));
      }
    }
    // PartyKit live reaction (the reaction's home now that Ably is retired).
    final p = _party;
    final mid = m.evId;
    if (p != null && mid != null) {
      if (prev != null && prev != emoji) {
        p.send(<String, dynamic>{'t': 'reaction', 'mid': mid, 'emoji': prev, 'add': false, 'whoName': _fromNameTag});
      }
      p.send(<String, dynamic>{'t': 'reaction', 'mid': mid, 'emoji': emoji, 'add': adding, 'whoName': _fromNameTag});
    }

    // [NOTIF-REACT-1 2026-08-17] Tell the SERVER about the reaction.
    //
    // Until now nothing did. `POST /api/msg/react` has existed for a while and
    // `kMsgReactUrl` was declared in core/config.dart, but no client ever called
    // either — grep found the constant referenced in exactly one file, its own
    // declaration. Reactions rode the PartyKit relay and nothing else, which
    // means two things were quietly untrue:
    //   1. reactions were NEVER persisted, so they vanished on reinstall and
    //      never reached a device that was offline when they happened, and
    //   2. the server had no idea a reaction had occurred, so there was nothing
    //      to send a notification FROM — the owner's third screenshot
    //      ("X reacted 😂 to your message") was unbuildable without this call.
    //
    // Fire-and-forget: the bubble has already updated optimistically above and
    // the party relay has already delivered it live. A failure here costs
    // durability and the peer's notification, never the tap.
    final myUid = _meId?.uid ?? '';
    final ck = _convKey;
    final serverConv = (ck != null && myUid.isNotEmpty) ? serverConvFromKey(ck, myUid) : null;
    if (mid != null && serverConv != null && ck != null) {
      // Who WROTE the message being reacted to — the one person who should be
      // notified. The server refuses to notify anyone else and drops the push
      // entirely when it cannot resolve an author, so this must be right rather
      // than merely present.
      //   mine            → me; the server sees reactor == author and sends nothing
      //   group           → senderPub, the sender's stable uid
      //   1:1 from them   → the peer, which is the tail of the '1:<peerUid>' key
      final authorUid = m.me
          ? myUid
          : (m.senderPub ?? (ck.startsWith('1:') ? ck.substring(2) : ''));
      unawaited(ApiAuth.postJson(kMsgReactUrl, <String, dynamic>{
        'conv': serverConv,
        'target': mid,
        'emoji': emoji,
        'op': adding ? 'add' : 'remove',
        if (authorUid.isNotEmpty) 'target_uid': authorUid,
      }).then((_) {}, onError: (Object _) {/* durability + notify only */}));
    }
  }

  Future<String?> _openEmojiPicker() {
    return showModalBottomSheet<String>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Align(alignment: Alignment.centerLeft,
                  child: Text('React with…', style: ADText.rowName())),
            ),
            Flexible(
              child: ListView(
                padding: const EdgeInsets.only(bottom: 12),
                children: [
                  for (final cat in _emojiCatalog.entries) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 8, 20, 4),
                      child: Align(alignment: Alignment.centerLeft,
                          child: Text(cat.key, style: ADText.statCaption(c: AD.textSecondary))),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Wrap(children: [
                        for (final e in cat.value)
                          GestureDetector(
                            onTap: () => Navigator.pop(ctx, e),
                            child: Padding(
                              padding: const EdgeInsets.all(6),
                              child: Text(e, style: const TextStyle(fontSize: 28)),
                            ),
                          ),
                      ]),
                    ),
                  ],
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  // Resolve a reactor uid to a friendly name. Mine → "You"; a learned group
  // member name (from a message or reaction that carried fromName) → that name;
  // a 1:1 peer → the chat name; otherwise a short id.
  String _reactorName(String uid) {
    if (uid == (_meId?.uid ?? 'me') || uid == 'me') return 'You';
    final known = _memberNames[uid];
    if (known != null && known.isNotEmpty && known != 'You') return known;
    if (!widget.chat.group) return widget.chat.name;
    return _shortPub(uid);
  }

  // Phase 5: "reacted by" — long-press a reaction chip to see who reacted.
  void _showReactedBy(_Msg m) {
    if (m.reactBy.isEmpty) return;
    Analytics.capture('chat_reacted_by_view', {'kinds': m.reactBy.length});
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Reactions', style: ADText.rowName())),
          ),
          for (final e in m.reactBy.entries)
            for (final uid in e.value)
              ListTile(
                dense: true,
                leading: Text(e.key, style: const TextStyle(fontSize: 22)),
                title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
              ),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  /// [AVAGRP-BUBBLE-1 / message-info §4] WhatsApp-style "Info" sheet for MY OWN
  /// message: who has read it and who it's been delivered to. Modelled EXACTLY
  /// on `_showReactedBy` above (same sheet chrome, same `_reactorName`/
  /// `_memberNames` resolution) plus the group avatars from `_memberAvatars`.
  ///
  /// [AVAGRP-BUBBLE-2] CONTRACT SEAM CLOSED: `m.readBy`/`m.deliveredTo`
  /// (`Map<uid, epochSeconds>`) are now actually populated — live, via
  /// `_applyMsgReceipt` (`{"t":"msg_receipt",...}` frames, `sync_hub.dart`
  /// `_ingestMsgReceipt`), and on cold open via `_hydrateMsgReceipts`
  /// (`GET /api/msg/seen`). Gated end-to-end on `RemoteConfig.groupReceiptsEnabled`
  /// (dark launch, default false) — while off this sheet still shows "No read
  /// receipts yet" for every group message exactly as before, by construction
  /// (nothing writes into the maps with the flag off).
  void _showMessageInfo(_Msg m) {
    // Two-sided telemetry (CLAUDE.md): this event fires on the SENDER's device
    // (Info is own-messages-only), so `Analytics.capture` auto-stamps the
    // sender's email. `mid` is the join key against the reader-side
    // `chat_group_receipt_*` events below, which tag the READER's uid — either
    // party's telemetry can be pulled and cross-referenced via `mid`.
    Analytics.capture('chat_message_info_view', {
      'group': widget.chat.group,
      'group_size': widget.chat.group ? widget.chat.members : 1,
      'read_count': m.readBy.length,
      'delivered_count': m.deliveredTo.length,
      'mid': m.evId ?? '',
      'group_receipts_enabled': RemoteConfig.groupReceiptsEnabled,
    });
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Info', style: ADText.rowName())),
          ),
          if (m.readBy.isEmpty && m.deliveredTo.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
              // [AVA-GRP-SENDSTATE] Honest empty state. With `groupReceiptsEnabled`
              // OFF nothing EVER populates readBy/deliveredTo, so the old
              // unconditional "No read receipts yet" was misleading — it implied the
              // feature was on and simply had no data, when receipts are switched
              // off entirely. Tell the truth so a "seen by everyone" message doesn't
              // look like the receipt system is broken.
              child: Text(
                RemoteConfig.groupReceiptsEnabled
                    ? 'No read receipts yet'
                    : 'Read receipts are off for group chats.',
                style: ADText.bubbleBody(c: AD.textSecondary)),
            )
          else ...[
            if (m.readBy.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
                child: Text('READ BY (${m.readBy.length})', style: ADText.sectionLabel(c: AD.iconSearch)),
              ),
              for (final uid in m.readBy.keys)
                ListTile(
                  dense: true,
                  leading: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderAvatar, width: 1.5),
                    ),
                    child: Avatar(
                      seed: uid,
                      name: _reactorName(uid),
                      size: 32,
                      avatarUrl: (_memberAvatars[uid]?.isNotEmpty ?? false) ? _memberAvatars[uid] : null,
                    ),
                  ),
                  title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
                  trailing: Text(_fmtTime(m.readBy[uid]!), style: ADText.statCaption(c: AD.textSecondary)),
                ),
            ],
            if (m.deliveredTo.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 4),
                child: Text('DELIVERED TO (${m.deliveredTo.length})', style: ADText.sectionLabel(c: AD.textSecondary)),
              ),
              for (final uid in m.deliveredTo.keys)
                ListTile(
                  dense: true,
                  leading: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderAvatar, width: 1.5),
                    ),
                    child: Avatar(
                      seed: uid,
                      name: _reactorName(uid),
                      size: 32,
                      avatarUrl: (_memberAvatars[uid]?.isNotEmpty ?? false) ? _memberAvatars[uid] : null,
                    ),
                  ),
                  title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
                  trailing: Text(_fmtTime(m.deliveredTo[uid]!), style: ADText.statCaption(c: AD.textSecondary)),
                ),
            ],
          ],
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  // "Who voted" for a poll option (group threads) — long-press an option.
  void _showPollVoters(String option, Set<String> uids) {
    if (uids.isEmpty) return;
    Analytics.capture('poll_voters_view', {'count': uids.length});
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Voted "$option"', style: ADText.rowName())),
          ),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 360), child: ListView(shrinkWrap: true, children: [
            for (final uid in uids)
              ListTile(
                dense: true,
                leading: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 20, color: AD.primaryBadge),
                title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
              ),
          ])),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  /// Ask once, then make the temporary readable copy Ava needs for document
  /// analysis. The original Messenger attachment remains encrypted and is not
  /// replaced. Returning null cancels the Ava action without creating a job.
  Future<String?> _prepareAvaReadableCopy(_Msg m) async {
    final source = m.media;
    if (source == null) return null;
    final approved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Let Ava read this file?'),
        content: const Text(
          'A temporary server-readable copy is needed to summarize or translate it. '
          'The original Messenger attachment stays encrypted, and the temporary copy is deleted within 24 hours.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Allow once')),
        ],
      ),
    );
    if (approved != true || !mounted) return null;
    try {
      final bytes = m.localBytes ?? await MediaService.downloadAndDecrypt(source);
      final copy = await MediaService.uploadReadableCopyForAva(
        bytes,
        source: source,
        kind: source.kind,
        contentType: source.contentType,
        name: source.name,
      );
      if (mounted) _capNote('Ava is reading a temporary copy…');
      return copy.id;
    } catch (e) {
      AvaLog.I.log('ava', 'readable attachment copy failed: $e');
      if (mounted) _capNote("Ava couldn't read that file.");
      return null;
    }
  }

  // Save a chat media file into the user's OWN AvaTOK Google Drive folder
  // (Hybrid: their own copy in Drive; the shared original stays on encrypted R2).
  Future<void> _saveMediaToDrive(_Msg m) async {
    if (m.media == null) return;
    _capNote('Saving to your AvaTOK Drive…');
    final bytes = m.localBytes ?? await MediaService.downloadAndDecrypt(m.media!);
    if (bytes == null) { _capNote('Could not load this file.'); return; }
    final kind = m.media!.kind;
    final bucket = kind == MediaKind.image ? 'Photos' : kind == MediaKind.video ? 'Videos' : 'Files';
    final mime = kind == MediaKind.image ? 'image/jpeg' : kind == MediaKind.video ? 'video/mp4' : 'application/octet-stream';
    final ok = await DriveService.I.upload(bucket, m.media!.name, mime, bytes);
    if (mounted) _capNote(ok ? 'Saved to your AvaTOK Drive ✓' : "Couldn't save — connect Drive in AvaStorage.");
  }

  // DELETE FOR ME — soft-hide on MY device only. The content is RETAINED (not
  // erased) so I can Undo to recover it later (copy something I lost, then re-hide).
  void _deleteForMe(_Msg m) {
    _mutMsgs(() => m.hidden = true);
    _persistHidden(m.evId, true); // durable on THIS device — survives app updates
    _schedulePersist();
    _syncHidden(m, true); // mirror the hide to my other devices
    Analytics.capture('message_deleted', {
      'scope': 'me', 'group': _group != null,
      if (m.evId != null) 'delete_id': m.evId!,
    });
  }

  // Persist a soft-delete/Undo to the durable, per-account [HiddenStore] AND the
  // in-memory map, so it's re-applied on the next cold open even if the capped
  // per-conversation message cache was cleared by an app update / OEM wipe. This
  // is the local-first source of truth; the server mirror (_syncHidden) is purely
  // for cross-device. Without this, a delete only lived in the cache + a best-
  // effort server POST, so a re-sync after an update brought the message back.
  void _persistHidden(String? evId, bool hidden) {
    if (evId == null || evId.isEmpty) return;
    _hiddenIds[evId] = hidden;
    HiddenStore().set(evId, hidden);
  }

  // Sync MY soft-delete/Undo to my OTHER devices via the InboxDO (owner-only state).
  void _syncHidden(_Msg m, bool hidden) {
    final conv = _guardianConv; // server conv id for this thread
    final target = m.evId;
    if (conv == null || target == null || target.isEmpty) {
      // The hide can't be mirrored to my other devices (no server conv / evId) —
      // this is the silent gap behind "my Mac still shows it". Make it visible.
      Analytics.capture('chat_hide_send_skipped', {
        'hidden': hidden, 'has_conv': conv != null, 'has_evid': target != null && target.isNotEmpty,
      });
      return;
    }
    // Sender-side anchor for the multi-device funnel: this hide/undo went to the
    // server (which broadcasts live + FCM-wakes my other devices). Join `target`
    // to chat_hide_fanout (worker) and chat_hide_applied (each device).
    ApiAuth.postJson(kMsgHideUrl, {'conv': conv, 'target': target, 'hidden': hidden}).then(
      (res) => Analytics.capture('chat_hide_sent', {
        'target': target, 'hidden': hidden, 'ok': res.statusCode == 200, 'status': res.statusCode,
      }),
      onError: (e) => Analytics.capture('chat_hide_sent', {
        'target': target, 'hidden': hidden, 'ok': false, 'err': e.toString(),
      }),
    );
  }

  // Apply a hide/Undo that arrived from one of my OTHER devices.
  void _applyHide(String target, bool hidden) {
    _persistHidden(target, hidden); // keep this device's durable state current
    final i = _msgs.indexWhere((x) => x.evId == target);
    if (i >= 0 && mounted) {
      _mutMsgs(() => _msgs[i].hidden = hidden);
      _schedulePersist();
    }
  }

  // DELETE FOR EVERYONE — soft-hide MY copy (retained, so I can Undo and recover my
  // own data), AND tell the peer(s) to delete on THEIR side. KEY DIFFERENCE from
  // WhatsApp: my own copy isn't destroyed. The recipient's copy IS hard-removed
  // (server tombstone + _applyDelete) — only I, the owner, can Undo to see it again.
  void _deleteForEveryone(_Msg m) {
    final target = m.evId;
    var channel = 'none';
    if (_realMode && target != null && target.isNotEmpty) {
      try {
        // [AVA-CHAT-INSTANT] An unsend is an author-verified, NON-idempotent server
        // op — it MUST NOT ride the durable Outbox (`.send`), whose at-least-once
        // retry loops `403 not_author` after the first POST tombstones the target
        // (production bug: 50× in 3 days for one tester). `sendControl` is the
        // one-shot, 403-terminal transport for these controls.
        if (_group != null && _gdm != null) {
          unawaited(_gdm!.sendControl(jsonEncode({'t': 'gdel', 'gid': _group!.id, 'target': target})));
          channel = 'gdm';
        } else if (_dm != null) {
          unawaited(_dm!.sendControl(jsonEncode({'t': 'del', 'target': target})));
          channel = 'dm';
        }
      } catch (e) {/* best-effort; local hide still applies */
        Analytics.capture('chat_delete_send_failed', {
          if (target != null) 'delete_id': target, 'group': _group != null, 'err': e.toString(),
        });
      }
    }
    _mutMsgs(() => m.hidden = true); // retained — Undo brings it back for ME only
    _persistHidden(m.evId, true); // durable on THIS device — survives app updates
    _schedulePersist();
    _syncHidden(m, true); // mirror the hide to my other devices
    Analytics.capture('message_deleted', {
      'scope': 'everyone', 'group': _group != null, 'had_evid': target != null,
      if (target != null) 'delete_id': target,
    });
    // Sender-side lifecycle anchor: join this delete_id to the worker's
    // chat_delete_delivery/fanout and the recipient's chat_delete_applied to see,
    // per delete, whether it went out live vs push and whether it ever landed.
    Analytics.capture('chat_delete_sent', {
      if (target != null) 'delete_id': target,
      'group': _group != null, 'channel': channel, 'realmode': _realMode,
    });
  }

  // Undo MY own soft-delete — restore the message in my view only (never re-sent to
  // anyone). Owner-only recovery: a peer's hard-deleted copy has no Undo.
  void _undoDelete(_Msg m) {
    _mutMsgs(() => m.hidden = false);
    _persistHidden(m.evId, false); // clear the durable hide on THIS device too
    _schedulePersist();
    _syncHidden(m, false); // mirror the Undo to my other devices
    Analytics.capture('message_delete_undo', {'group': _group != null});
  }

  // Apply a delete-for-everyone the PEER sent: HARD-remove the targeted message
  // from my view (no Undo — I'm not its owner). The server also tombstones my
  // stored copy so it never re-syncs.
  // Convert a message in place into the delete-for-everyone tombstone.
  void _tombstone(_Msg m) {
    m.text = 'This message was deleted';
    m.media = null; m.localBytes = null;
    m.reaction = null; m.special = null; m.extra = null;
    m.mediaCaption = ''; m.hidden = false;
  }

  void _applyDelete(String target) {
    if (target.isEmpty) return;
    _deletedIds.add(target);
    DeletedStore().add(target); // durable — re-applies even after the cache is rebuilt
    final i = _msgs.indexWhere((x) => x.evId == target);
    Analytics.capture('message_delete_applied', {
      'group': _group != null, 'on_screen': i >= 0,
    });
    if (i >= 0 && mounted) {
      _mutMsgs(() => _tombstone(_msgs[i]));
      _schedulePersist();
    }
  }

  // STREAM I (FWD-1): open the multi-select Forward sheet (Groups + Contacts,
  // search, checkmarks, single Send). If forwarding is flag-disabled, fall back
  // to a quiet no-op. One selected contact with editable text still gets the
  // caption editor; everything else fans out straight to the chosen targets.
  Future<void> _forward(_Msg m) async {
    if (!RemoteConfig.unlimitedForwardEnabled) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Forwarding is temporarily unavailable')));
      return;
    }
    final msgKind = m.media?.kind.name ?? 'text';
    final targets = await showForwardSheet(context, msgKind: msgKind);
    if (targets == null || targets.isEmpty || !mounted) return;
    // Preserve the single-contact caption-edit UX when it's exactly one DM.
    if (targets.length == 1 && !targets.first.isGroup) {
      final peerUid = targets.first.peerUid;
      final saved = await ContactsStore().load();
      final hit = saved.where((c) => c.uid == peerUid).toList();
      final match = hit.isNotEmpty
          ? hit.first
          : Contact(uid: peerUid, name: targets.first.label);
      if (!mounted) return;
      await _forwardWithText(m, match);
      return;
    }
    await _forwardToTargets(m, targets);
  }

  /// Fan a single message out to a MIX of DMs + groups in ONE server call
  /// (/api/msg/forward). The envelope carries `fwd:true` (Stream K renders the
  /// "↪ Forwarded" label from this) and — for privacy (FWD-1) — NOTHING about
  /// the original sender. Media re-references the SAME content-addressed R2 key
  /// via the same envelope (its per-blob AES key rides in the envelope, so no
  /// re-upload is ever needed — FWD-2, all cases including cross-context).
  Future<void> _forwardToTargets(_Msg m, List<ForwardTarget> targets,
      {String? caption}) async {
    final id = _meId;
    if (id == null) return;
    final Map<String, dynamic> payload;
    if (m.media != null) {
      // Same envelope → same media_ref → one R2 copy, never re-uploaded.
      payload = {...m.media!.toEnvelope(), 'fwd': true, 'forwarded': true};
      final cap = (caption ?? _mediaCaptionOf(m)).trim();
      if (cap.isEmpty) { payload.remove('cap'); } else { payload['cap'] = cap; }
    } else {
      payload = {'t': 'text', 'body': caption ?? m.text, 'fwd': true, 'forwarded': true};
    }
    // media_ref: the R2 content hash so the server indexes the forward against
    // the SAME object (zero duplication). For text this stays null.
    final mediaRef = m.media?.id;
    final body = jsonEncode(payload);
    final serverTargets = [
      for (final t in targets)
        t.isGroup ? {'conv': t.groupId} : {'to': t.peerUid},
    ];
    final nGroups = targets.where((t) => t.isGroup).length;
    Analytics.capture('chat_message_forwarded', {
      'has_media': m.media != null,
      'media_kind': m.media?.kind.name ?? 'text',
      'n_targets': targets.length,
      'n_groups': nGroups,
      'edited_caption': caption != null,
    });
    int status = 0;
    try {
      final res = await ApiAuth.postJson(kMsgForwardUrl, {
        'kind': 'text',
        'body': body,
        if (mediaRef != null) 'media_ref': mediaRef,
        'targets': serverTargets,
      });
      status = res.statusCode;
      // Wake the DM peers (groups fan out server-side).
      final dmUids = [for (final t in targets) if (!t.isGroup) t.peerUid];
      if (dmUids.isNotEmpty) PushService.notifyMessage(dmUids, _myName ?? 'AvaTOK');
      // FWD-4 telemetry (email auto-attached by Analytics.identify person props).
      if (status == 429) {
        Analytics.capture('forward_rate_capped', {
          'n_targets': targets.length, 'n_groups': nGroups,
        });
      } else if (status == 200) {
        Analytics.capture('forward_sent', {
          'n_targets': targets.length, 'n_groups': nGroups,
          'media_kind': m.media?.kind.name ?? 'text',
          'cross_context': true,
        });
      }
    } catch (_) {}
    if (!mounted) return;
    final n = targets.length;
    final msg = status == 429
        ? 'Slow down — too many forwards. Try again shortly.'
        : (status == 200 || status == 0)
            ? 'Forwarded to $n chat${n == 1 ? '' : 's'}'
            : "Couldn't forward — try again";
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Step between picking a recipient and sending: when the message has text
  /// associated with it (a media caption, or a plain text body), show that text
  /// in an EDITABLE box so the user can tweak or clear it before forwarding.
  /// Media with no caption forwards straight through (unchanged behaviour).
  Future<void> _forwardWithText(_Msg m, Contact c) async {
    final isMedia = m.media != null;
    final initial = (isMedia ? _mediaCaptionOf(m) : m.text).trim();
    // No associated text on a media item → nothing to edit, forward as-is.
    if (isMedia && initial.isEmpty) { await _doForward(m, c); return; }

    final edit = TextEditingController(text: initial);
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 16, right: 16, top: 16,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 16,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Forward to ${c.name}', style: ADText.threadName()),
          const SizedBox(height: 4),
          Text(isMedia ? 'Edit or remove the caption before sending'
                       : 'Edit the message before sending',
              style: ADText.preview(c: AD.textTertiary)),
          const SizedBox(height: 12),
          // For media, show a small preview chip so it's clear what rides along.
          if (isMedia) ...[
            Row(children: [
              if (m.localBytes != null && m.media!.kind == MediaKind.image)
                ClipRRect(
                  borderRadius: BorderRadius.circular(Msg.rSm),
                  child: Image.memory(m.localBytes!, width: 44, height: 44, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
                )
              else
                PhosphorIcon(
                    m.media!.kind == MediaKind.video
                        ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                        : m.media!.kind == MediaKind.image
                            ? PhosphorIcons.image(PhosphorIconsStyle.bold)
                            : PhosphorIcons.file(PhosphorIconsStyle.bold),
                    size: 26, color: AD.textPrimary),
              const SizedBox(width: 10),
              Expanded(child: Text(m.media!.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName())),
            ]),
            const SizedBox(height: 12),
          ],
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(AD.rInput),
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: edit,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ADText.rowName(),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: isMedia ? 'Add a caption…' : 'Message',
                    hintStyle: ADText.preview(c: AD.textTertiary),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, edit.text)),
          ]),
        ]),
      ),
    ).whenComplete(edit.dispose);

    if (result == null) return; // dismissed without sending
    final text = result.trim();
    // A plain text message edited down to nothing → don't forward an empty line.
    if (!isMedia && text.isEmpty) return;
    await _doForward(m, c, caption: text);
  }

  /// Really forward [m] to contact [c] over a one-off send, flagged forwarded.
  /// [caption] (when provided) overrides the carried text/caption — empty means
  /// forward the media with no caption.
  Future<void> _doForward(_Msg m, Contact c, {String? caption}) async {
    final id = _meId;
    final peerHex = c.uid;
    if (id == null || peerHex.isEmpty) return;
    final Map<String, dynamic> payload;
    // STREAM I: carry `fwd:true` (Stream K renders "↪ Forwarded") + keep the
    // legacy `forwarded` key for the existing bubble renderer. NOTHING about the
    // original sender travels (privacy, FWD-1).
    if (m.media != null) {
      payload = {...m.media!.toEnvelope(), 'fwd': true, 'forwarded': true};
      final cap = (caption ?? _mediaCaptionOf(m)).trim();
      if (cap.isEmpty) { payload.remove('cap'); } else { payload['cap'] = cap; }
    } else {
      payload = {'t': 'text', 'body': caption ?? m.text, 'fwd': true, 'forwarded': true};
    }
    Analytics.capture('chat_message_forwarded', {
      'has_media': m.media != null,
      'media_kind': m.media?.kind.name ?? 'text',
      'edited_caption': caption != null,
      'conv_kind': _isGroup ? 'group' : 'dm',
      'n_targets': 1,
      'n_groups': 0,
    });
    try {
      // STREAM I: route single-contact forwards through /api/msg/forward too, so
      // the rate cap + liveness guard apply uniformly. Media re-references the
      // SAME R2 key via media_ref (no re-upload — FWD-2, all cases).
      await ApiAuth.postJson(kMsgForwardUrl, {
        'kind': 'text', 'body': jsonEncode(payload),
        if (m.media?.id != null) 'media_ref': m.media!.id,
        'targets': [{'to': peerHex}],
      });
      PushService.notifyMessage([c.uid], _myName ?? 'AvaTOK');
    } catch (_) {}
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Forwarded to ${c.name}')));
  }
}
