part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadComposer on _ChatThreadScreenState {

  // Lime circular send button — ink border, hard shadow (the screen's one
  // lime primary action).
  // [CHAT-UI-COMPOSER-1] The legacy composer also swaps mic/send instantly;
  // geometry and surrounding controls remain fixed.
  Widget _sendCircle(IconData icon, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(width: 44, height: 44,
            decoration: BoxDecoration(
                color: AD.sendActiveBg, shape: BoxShape.circle,
                border: Border.all(color: AD.borderControl, width: 1), boxShadow: const []),
            // [UI-NOMOTION-1 2026-08-06] Was an AnimatedSwitcher that scaled +
            // faded the glyph on every swap. It fired right after a thread
            // opened, because restoring a saved draft sets the controller text
            // and flips mic→send — so the composer animated as part of the
            // "settling" the owner reported. The icon now swaps instantly.
            child: Icon(icon, color: AD.sendActiveInk, size: 20)),
      );

  /// [VOICE-REC-1] (owner report 2026-07-16, pic 5) The recording bar.
  ///
  /// Replaces a single line of static text ("Recording… tap to send") with the
  /// four things the owner asked for, and that WhatsApp has:
  ///   • a LIVE waveform driven by the mic's real amplitude, so you can see it
  ///     hearing you — the whole point of his "I am not even sure if it is
  ///     listening to me";
  ///   • the elapsed time, so a long note isn't a guess;
  ///   • a bin to discard the take (there was NO way to cancel — the only
  ///     control sent it, so a fluffed sentence had to be sent and deleted);
  ///   • a pause/resume, which is also what auto-pause-on-background resumes to.
  Widget _recordingBar(BoxDecoration bandDeco) {
    final mm = _recElapsed.inMinutes.toString();
    final ss = (_recElapsed.inSeconds % 60).toString().padLeft(2, '0');
    return Container(
      decoration: bandDeco,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      // NOTE: no SafeArea here — the caller already wraps _inputBar() in one.
      child: Row(children: [
          // Discard. Sits on the far left, away from send — a destructive action
          // should never be adjacent to the one you're reaching for.
          IconButton(
            tooltip: 'Delete recording',
            icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold),
                color: AD.danger, size: 22),
            onPressed: () => _cancelRecording(),
          ),
          // Blinking dot + elapsed. The dot stops blinking while paused, so
          // "paused" is legible at a glance and not just an icon swap.
          _RecordingDot(active: !_recPaused),
          const SizedBox(width: 8),
          SizedBox(
            width: 44,
            child: Text('$mm:$ss',
                style: ADText.bubbleMeta(c: AD.textSecondary)),
          ),
          // The live waveform.
          Expanded(
            child: SizedBox(
              height: 32,
              child: _recPaused
                  ? Align(
                      alignment: Alignment.centerLeft,
                      child: Text('Paused · tap play to continue',
                          style: ADText.bubbleMeta(c: AD.textSecondary)),
                    )
                  : LiveWaveform(levels: _recLevels),
            ),
          ),
          const SizedBox(width: 4),
          IconButton(
            tooltip: _recPaused ? 'Resume recording' : 'Pause recording',
            icon: PhosphorIcon(
                _recPaused
                    ? PhosphorIcons.play(PhosphorIconsStyle.fill)
                    : PhosphorIcons.pause(PhosphorIconsStyle.fill),
                color: AD.textSecondary,
                size: 22),
            onPressed: _toggleRecordPause,
          ),
          _sendCircle(
              PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill), _toggleRecord),
      ]),
    );
  }

  Widget _inputBar() {
    // Input band: paper-2 with ink top border; field = ink-bordered pill.
    const bandDeco = BoxDecoration(
      color: AD.headerFooter,
      border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
    );
    if (_recording) return _recordingBar(bandDeco);
    // STREAM E: WhatsApp-parity rich input bar + emoji/GIF/sticker panel (flag ON
    // by default). Reuses the SAME handlers as the legacy row below (_send,
    // _attach, camera, _toggleRecord, _onInputChanged) so send/attach/camera/mic
    // behaviour is unchanged; adds the emoji/GIF/sticker panel + GIF/sticker send.
    // The reply/listening banners + quick-tools ride in `topSlot`. When the flag
    // is OFF we fall through to the legacy composer below.
    if (RemoteConfig.richInputEnabled) {
      return RichInputBar(
        controller: _ctrl,
        focusNode: _composerFocus,
        hasText: _hasText,
        hintText: _avaMode
            ? 'Ask Ava privately…'
            : (_avaPublicMode ? 'Message · Ava can join' : 'Message'),
        fieldColor: Msg.input,
        onSend: _send,
        onAttach: _attach,
        onCamera: () => _pickImage(ImageSource.camera),
        onMic: _toggleRecord,
        onChanged: _onInputChanged,
        onGif: _sendGif,
        onSticker: _sendStickerAsset,
        onMention: _openMentionPicker,
        modeControls: _avaAudienceControls(),
        topSlot: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_replyTo != null || _editing != null) _replyBanner(),
          if (_sttActive) _listeningBanner(),
          if (_showComposePreview) _composePreviewBar(),
        ]),
      );
    }
    return Container(
      decoration: bandDeco,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_replyTo != null || _editing != null) _replyBanner(),
        if (_sttActive) _listeningBanner(),
        if (_showComposePreview) _composePreviewBar(),
        _composerTools(),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 12, 10),
          // Bottom-align so the + and send controls stay pinned to the bottom
          // as the multi-line field grows upward. (The Ava-mode toggle now
          // lives in the quick-tools row above — see _avaModeChip.)
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        IconButton(
            icon: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold), color: AD.iconClipOnWhite, size: 26),
            onPressed: _attach),
        // Phase 4: tap = send a 🎉 burst to the room; long-press picks the emoji.
        if (_party != null)
          GestureDetector(
            onLongPress: _pickBurstEmoji,
            child: IconButton(
              icon: PhosphorIcon(PhosphorIcons.confetti(PhosphorIconsStyle.bold), color: AD.danger, size: 24),
              onPressed: () => _sendBurst('🎉'),
            ),
          ),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
                color: _avaMode ? AD.micIdleBg : AD.inputField,
                borderRadius: BorderRadius.circular(AD.rInput),
                border: Border.all(color: AD.borderControl, width: 1)),
            // Wrap the field so BOTH a hardware Cmd/Ctrl+V and the long-press
            // toolbar "Paste" route through _onComposerPaste — which pastes an
            // image from the clipboard (super_clipboard) when one is present and
            // otherwise pastes text as usual. Without this the box silently
            // ignores copied images (Flutter's clipboard is text-only).
            child: Actions(
              actions: {
                PasteTextIntent: CallbackAction<PasteTextIntent>(
                  onInvoke: (intent) {
                    _onComposerPaste(via: 'keyboard');
                    return null;
                  },
                ),
              },
              child: TextField(
              controller: _ctrl,
              focusNode: _composerFocus,
              onChanged: _onInputChanged,
              onSubmitted: (_) => _send(),
              // Accept images inserted by the keyboard / system clipboard (Samsung
              // "super paste", Gboard image paste, GIF insert). These arrive via
              // Android's InputConnection.commitContent — NOT PasteTextIntent — so
              // without this config the image is silently dropped (the input box
              // stays empty and the system falls back to a blank editor view).
              contentInsertionConfiguration: ContentInsertionConfiguration(
                allowedMimeTypes: const [
                  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
                ],
                onContentInserted: _onContentInserted,
              ),
              // Auto-grow upward as the user types (1 line → max 5, then it
              // scrolls internally so the text always stays in view). Enter
              // still sends — the keyboard action button is wired to send.
              minLines: 1,
              maxLines: 5,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.send,
              style: ADText.rowName(c: AD.textOnInput),
              cursorColor: AD.iconSearch,
              contextMenuBuilder: (ctx, editableState) {
                // Rebuild the default selection toolbar but re-point its "Paste"
                // button at our image-aware handler, so pasting a copied image
                // works from the toolbar too.
                final items = editableState.contextMenuButtonItems
                    .map((b) => b.type == ContextMenuButtonType.paste
                        ? ContextMenuButtonItem(
                            type: ContextMenuButtonType.paste,
                            onPressed: () {
                              editableState.hideToolbar();
                              _onComposerPaste();
                            },
                          )
                        : b)
                    .toList();
                return AdaptiveTextSelectionToolbar.buttonItems(
                  anchors: editableState.contextMenuAnchors,
                  buttonItems: items,
                );
              },
              decoration: InputDecoration(
                  hintText: _avaMode ? 'Ask Ava privately…' : 'Message',
                  hintStyle: ADText.rowName(c: AD.placeholderOnWhite).copyWith(
                      fontWeight: FontWeight.w600),
                  border: InputBorder.none, isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 12)),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        if (_sttActive)
          GestureDetector(
            onTap: _stopVoiceToText,
            child: Container(width: 44, height: 44,
                decoration: BoxDecoration(
                    color: AD.danger, shape: BoxShape.circle,
                    border: Border.all(color: AD.borderControl, width: 1), boxShadow: const []),
                child: Icon(PhosphorIcons.stop(PhosphorIconsStyle.fill), color: Colors.white, size: 22)),
          )
        else
          // Mic is now a pure voice-note record button (owner request
          // 2026-06-27): tapping it starts/stops recording a voice message.
          // The old "Record audio / Convert voice to text" chooser (_openMicMenu)
          // and the speech-to-text path are no longer surfaced.
          _sendCircle(
              _hasText
                  ? PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill)
                  : PhosphorIcons.microphone(PhosphorIconsStyle.fill),
              _hasText ? _send : _toggleRecord),
          ]),
        ),
      ]),
    );
  }

  // Thin "Listening…" banner shown above the composer during voice-to-text.
  Widget _listeningBanner() => Container(
        padding: const EdgeInsets.fromLTRB(16, 8, 12, 0),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.waveform(PhosphorIconsStyle.fill),
              color: AD.online, size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: ValueListenableBuilder<String>(
              valueListenable: AvaOnDeviceStt.I.statusLine,
              builder: (_, s, __) => Text(
                s.isEmpty ? 'Listening…' : s,
                style: ADText.sectionLabel(c: AD.online),
              ),
            ),
          ),
          Text('Tap stop to insert', style: ADText.sectionLabel()),
        ]),
      );

  // ===========================================================================
  // Composer quick-tools row (Translate · Fix grammar · Rewrite · Reply ideas)
  // ===========================================================================

  /// The little horizontally-scrolling chip bar that sits right on top of the
  /// text field. Each chip runs one Ava call and writes the result back into
  /// the input box. The whole row dims while a job is in flight.
  Widget _composerTools() {
    // Centered, evenly-spaced quick tools. Each tool gets a distinct pastel
    // fill so it's recognizable at a glance. Wrap keeps them centered and never
    // overflows on narrow screens (falls to a second centered row if needed).
    // Spread the quick-tools evenly across the FULL width of the composer with
    // bigger, better-separated touch targets — they used to be tiny and bunched
    // in the centre with empty space either side. spaceEvenly gives equal gutters
    // left, right and between, so the row breathes and each chip is easy to hit.
    // Owner request (2026-06-27): the three quick-tool chips — Talk-to-Ava (✦),
    // Translate, and Help-me-write-better — are retired from the composer. In
    // their place a tiny hint reminds people how to summon Ava inline: `@ava`
    // for a private reply, `#ava` to ask Ava in front of everyone. The old chip
    // builders below are intentionally left in place (unused) to keep this a
    // surgical, low-risk change.
    // [WALLET-GET-STATE-1] 2026-07-25: was PAID-ONLY (`if (!_premium) return
    // ...shrink()`) — owner decision (Root-Cause Report §10/§12c) made
    // Ava-in-chat text free for everyone, so the hint is no longer gated.
    //
    // [CHAT-MENTIONS-1] 2026-08-04: the hint line is RETIRED. It was a permanent
    // banner teaching a syntax that the new "@" control in the composer now does
    // for you — you pick "@ava (private)" or "#ava (public)" off a list instead
    // of remembering to type it. `_avaHintNote()` is left below (unused) so this
    // stays a one-line revert if the owner wants the text back.
    return const SizedBox.shrink();
  }

  /// Tiny reminder above the field: how to call Ava without a button.
  Widget _avaHintNote() => Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              size: 14, color: AD.iconSearch),
          const SizedBox(width: 6),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                const TextSpan(text: 'Type '),
                TextSpan(text: '@ava', style: ADText.preview(c: const Color(0xFF8FC0F5))
                    .copyWith(fontWeight: FontWeight.w600)),
                const TextSpan(text: ' for a private reply, or '),
                TextSpan(text: '#ava', style: ADText.preview(c: const Color(0xFF7BD98C))
                    .copyWith(fontWeight: FontWeight.w600)),
                const TextSpan(text: ' to ask Ava in the chat.'),
              ]),
              // White base text (was grey) so the hint reads clearly on dark.
              style: ADText.preview(c: AD.textPrimary),
            ),
          ),
        ]),
      );

  String get _avaAudienceModeKey =>
      'composer_ava_audience_v1_${_snapKey ?? widget.chat.seed}';

  Future<void> _loadAvaAudienceMode() async {
    final stored = await readScoped(_aiPrefs, _avaAudienceModeKey);
    if (!mounted) return;
    setState(() {
      _avaMode = stored == 'private';
      // Public is the default for a conversation that has never stored a choice.
      _avaPublicMode = stored == null || stored == 'public';
    });
  }

  Future<void> _persistAvaAudienceMode(String mode) async {
    try {
      await _aiPrefs.write(
        key: scopedKey(_avaAudienceModeKey),
        value: mode,
      );
    } catch (_) {
      // Preference persistence must never interrupt typing or sending.
    }
  }

  void _setAvaAudienceMode(String requested) {
    final isActive = requested == 'private' ? _avaMode : _avaPublicMode;
    final next = isActive ? 'off' : requested;
    setState(() {
      _avaMode = next == 'private';
      _avaPublicMode = next == 'public';
    });
    unawaited(_persistAvaAudienceMode(next));
    Analytics.capture('composer_ava_mode_changed', {
      'mode': next,
      'conv_kind': _isGroup ? 'group' : 'direct',
    });
    HapticFeedback.selectionClick();
    _composerFocus.requestFocus();
  }

  Widget _avaAudienceControls() => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _avaAudienceButton(
            label: '@ava',
            active: _avaMode,
            activeColor: MentionTextController.mentionBlue,
            tooltip: 'Private Ava · only you see the reply',
            modeLabel: 'Private Mode',
            onTap: () => _setAvaAudienceMode('private'),
          ),
          const SizedBox(width: Msg.s1),
          _avaAudienceButton(
            label: '#ava',
            active: _avaPublicMode,
            activeColor: MentionTextController.shareGreen,
            tooltip: 'Public Ava · everyone sees the reply',
            modeLabel: 'Public Mode',
            onTap: () => _setAvaAudienceMode('public'),
          ),
        ],
      );

  Widget _avaAudienceButton({
    required String label,
    required bool active,
    required Color activeColor,
    required String tooltip,
    required String modeLabel,
    required VoidCallback onTap,
  }) =>
      Tooltip(
        message: tooltip,
        child: Semantics(
          button: true,
          selected: active,
          label: '$label ${active ? '$modeLabel on' : 'off'}',
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onTap,
            child: Container(
              height: 36,
              constraints: const BoxConstraints(minWidth: 62),
              padding: const EdgeInsets.symmetric(horizontal: Msg.s2),
              decoration: BoxDecoration(
                color: active
                    ? activeColor.withValues(alpha: 0.18)
                    : AD.card,
                borderRadius: BorderRadius.circular(Msg.rMd),
                border: Border.all(
                  color: active ? activeColor : AD.borderControl,
                  width: active ? 2 : 1,
                ),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(
                  label,
                  style: ADText.tabLabel(
                    c: active ? activeColor : AD.textSecondary,
                  ),
                ),
                const SizedBox(width: Msg.s1),
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: active ? activeColor : AD.textTertiary,
                    shape: BoxShape.circle,
                  ),
                ),
                // Owner request (2026-08-16): the active chip must SAY what it
                // means — a tiny "Public Mode" / "Private Mode" tag on the
                // coloured chip, so nobody has to remember the @/# convention.
                if (active) ...[
                  const SizedBox(width: Msg.s1),
                  Text(
                    modeLabel,
                    style: ADText.tabLabel(c: activeColor).copyWith(
                      fontSize: 9,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ]),
            ),
          ),
        ),
      );

  /// Consolidated "Help me write better" control — replaces the separate Fix
  /// grammar / Rewrite / Reply ideas chips. Tapping opens a menu of writing
  /// actions, so the composer row stays clean (Ava · Translate · Write help).
  Widget _writeHelpChip() {
    const writeTools = {'grammar', 'rewrite', 'reply_ideas'};
    final busy = _aiTool != null && writeTools.contains(_aiTool);
    final dimmed = _aiBusy && !busy;
    return Opacity(
      opacity: dimmed ? 0.4 : 1,
      child: GestureDetector(
        onTap: _aiBusy ? null : _openWriteHelp,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: busy ? AD.primaryBadge : AD.card,
            borderRadius: BorderRadius.circular(Msg.rMd),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: const [],
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            busy
                ? const SizedBox(width: 18, height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AD.textPrimary))
                : PhosphorIcon(PhosphorIcons.magicWand(PhosphorIconsStyle.bold), size: 20, color: AD.textPrimary),
            const SizedBox(width: 8),
            Text('Help me write better', style: ADText.statCaption(c: AD.textPrimary)),
          ]),
        ),
      ),
    );
  }

  /// Menu for [_writeHelpChip]: Fix grammar, the rewrite tones (flattened so a
  /// tone is one tap), and Reply ideas.
  Future<void> _openWriteHelp() async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
        child: SafeArea(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('HELP ME WRITE BETTER', style: ADText.sectionLabel()),
          const SizedBox(height: 12),
          _writeHelpRow(ctx, PhosphorIcons.checkCircle(PhosphorIconsStyle.bold), AD.iconSearch,
              'Fix grammar', 'Spelling & grammar, same meaning', 'grammar'),
          _writeHelpRow(ctx, PhosphorIcons.smiley(PhosphorIconsStyle.bold), AD.primaryBadge,
              'Friendlier', 'Warmer, friendlier tone', 'friendly'),
          _writeHelpRow(ctx, PhosphorIcons.briefcase(PhosphorIconsStyle.bold), AD.online,
              'More formal', 'Formal and professional', 'formal'),
          _writeHelpRow(ctx, PhosphorIcons.scissors(PhosphorIconsStyle.bold), AD.iconVideo,
              'Shorter & clearer', 'Trim it down, keep the point', 'short'),
          _writeHelpRow(ctx, PhosphorIcons.lightbulb(PhosphorIconsStyle.bold), AD.danger,
              'Reply ideas', 'Suggest replies to the last message', 'reply_ideas'),
        ])),
      ),
    );
    if (action == null || !mounted) return;
    switch (action) {
      case 'grammar': _runFixGrammar(); break;
      case 'reply_ideas': _runReplyIdeas(); break;
      case 'friendly': _runRewriteStyle('Friendlier', 'warmer and friendlier'); break;
      case 'formal': _runRewriteStyle('More formal', 'more formal and professional'); break;
      case 'short': _runRewriteStyle('Shorter & clearer', 'shorter, clearer and more concise'); break;
    }
  }

  Widget _writeHelpRow(BuildContext ctx, IconData icon, Color accent, String title, String subtitle, String action) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZinePressable(
        onTap: () => Navigator.pop(ctx, action),
        radius: BorderRadius.circular(AD.rListCard),
        boxShadow: const [],
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent, size: 32),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(subtitle, style: ADText.preview()),
          ])),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
        ]),
      ),
    );
  }

  /// Translate chip — split into two tap zones: the left runs a translation
  /// into the remembered language; the trailing language + caret opens the
  /// picker to change it.
  Widget _translateChip() {
    final busy = _aiTool == 'translate';
    final dimmed = _aiBusy && !busy;
    return Opacity(
        opacity: dimmed ? 0.4 : 1,
        child: Container(
          decoration: BoxDecoration(
            color: busy ? AD.primaryBadge : AD.online,
            borderRadius: BorderRadius.circular(Msg.rMd),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: const [],
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Tooltip(
              message: 'Translate',
              child: GestureDetector(
                onTap: _aiBusy ? null : _runTranslate,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(15, 13, 12, 13),
                  child: busy
                      ? const SizedBox(
                          width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: AD.textPrimary),
                        )
                      : PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                          size: 23, color: AD.textPrimary),
                ),
              ),
            ),
            GestureDetector(
              onTap: _aiBusy ? null : _pickTransLang,
              child: Container(
                padding: const EdgeInsets.fromLTRB(9, 9, 12, 9),
                decoration: const BoxDecoration(
                  border: Border(left: BorderSide(color: AD.borderControl, width: 1)),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(_transLang.label,
                      style: ADText.statCaption(c: AD.iconSearch)),
                  const SizedBox(width: 3),
                  PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                      size: 12, color: AD.iconSearch),
                ]),
              ),
            ),
          ]),
        ),
      );
  }

  /// Shared runner: flips the busy flags, fires the [call], reports failures,
  /// and returns the trimmed answer (or null on block/empty/error).
  Future<String?> _runAiTool(String tool, Future<AvaAnswer> Function() call,
      {Map<String, Object> props = const <String, Object>{}}) async {
    if (_aiBusy) return null;
    setState(() { _aiBusy = true; _aiTool = tool; });
    final t0 = DateTime.now().millisecondsSinceEpoch;
    var retried = false;
    Analytics.capture('composer_ai_used', <String, Object>{
      'tool': tool, 'is_group': _isGroup, ...props,
    });
    // Rich latency breakdown so we can answer "why was translate/suggest slow?":
    // client_ms (round-trip the user felt), server_ms/gen_ms/setup_ms (where the
    // server spent it), tool_calls (agentic round-trips — should be 0 for these),
    // whether we retried, and the network type. Attached to ok AND failure events.
    Map<String, Object> timing(AvaAnswer a) => <String, Object>{
          'total_ms': DateTime.now().millisecondsSinceEpoch - t0,
          'retried': retried,
          if (a.clientMs != null) 'client_ms': a.clientMs!,
          if (a.serverMs != null) 'server_ms': a.serverMs!,
          if (a.genMs != null) 'gen_ms': a.genMs!,
          if (a.setupMs != null) 'setup_ms': a.setupMs!,
          if (a.toolCalls != null) 'tool_calls': a.toolCalls!,
        };
    try {
      // One silent auto-retry on a TRANSIENT failure (a dropped request or a 5xx)
      // so a single network blip doesn't make the user re-tap the chip. A real
      // block (moderation / daily cap) or a populated answer is returned as-is.
      var a = await call();
      final transient1 = a.blocked &&
          (a.reason == 'network' || (a.reason?.startsWith('http_5') ?? false));
      if (transient1) {
        retried = true;
        await Future.delayed(const Duration(milliseconds: 350));
        if (!mounted) return null;
        a = await call();
      }
      if (!mounted) return null;
      if (a.blocked) {
        // Distinct copy per cause so the user knows whether to wait, top up, or
        // check their connection — not one catch-all "couldn't help".
        final String msg;
        if (a.hitDailyCap) {
          msg = 'Daily free AI limit reached — connect your own key in Settings for unlimited.';
        } else if (a.reason == 'network') {
          msg = 'Couldn’t reach Ava — check your connection and try again.';
        } else if (a.reason?.startsWith('http_5') ?? false) {
          msg = 'Ava is busy right now — give it a moment and try again.';
        } else {
          msg = 'Ava couldn’t help with that right now.';
        }
        _toolHint(msg);
        Analytics.capture('composer_ai_blocked', <String, Object>{
          'tool': tool, 'reason': a.reason ?? 'unknown', ...timing(a),
        });
        return null;
      }
      final out = a.answer.trim();
      if (out.isEmpty) {
        _toolHint('Ava returned nothing — try again.');
        Analytics.capture('composer_ai_empty', <String, Object>{'tool': tool, ...timing(a)});
        return null;
      }
      Analytics.capture('composer_ai_ok', <String, Object>{
        'tool': tool, 'tier': a.tier ?? 'unknown', ...timing(a),
      });
      return out;
    } catch (e) {
      if (mounted) _toolHint('Something went wrong. Check your connection.');
      Analytics.capture('composer_ai_error', {
        'tool': tool, 'total_ms': DateTime.now().millisecondsSinceEpoch - t0, 'retried': retried,
      });
      return null;
    } finally {
      if (mounted) setState(() { _aiBusy = false; _aiTool = null; });
    }
  }

  /// Drop [out] into the input box (replacing the draft), cursor at the end,
  /// keyboard kept up — the user just hits send.
  void _replaceComposer(String out) {
    _ctrl.value = TextEditingValue(
      text: out,
      selection: TextSelection.collapsed(offset: out.length),
    );
    setState(() => _hasText = out.trim().isNotEmpty);
    _refreshComposePreview(out);
    _composerFocus.requestFocus();
  }

  void _toolHint(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      behavior: SnackBarBehavior.floating,
      duration: const Duration(seconds: 3),
    ));
  }

  Future<void> _runTranslate() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a message first, then tap Translate'); return; }
    if (_aiBusy) return;
    // INSTANT PATH (pic4): on-device ML Kit translation (~tens of ms, offline,
    // free). Falls through to the server (Gemini) path when the language pair
    // isn't supported on-device or the model isn't downloaded yet (the download
    // runs deferred in the background, so the next tap is instant).
    final t0 = DateTime.now().millisecondsSinceEpoch;
    setState(() { _aiBusy = true; _aiTool = 'translate'; });
    final local = await OnDeviceTranslate.I.translate(text, _transLang.code);
    if (!mounted) return;
    setState(() { _aiBusy = false; _aiTool = null; });
    if (local != null) {
      Analytics.capture('composer_ai_ok', <String, Object>{
        'tool': 'translate', 'engine': 'ondevice', 'lang': _transLang.code,
        'total_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      _replaceComposer(local);
      return;
    }
    final out = await _runAiTool('translate',
        () => ComposerAi.translate(text, _transLang.code),
        props: {'lang': _transLang.code, 'engine': 'server'});
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runFixGrammar() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a message first, then tap Fix grammar'); return; }
    final out = await _runAiTool('grammar', () => ComposerAi.fixGrammar(text));
    if (out != null) _replaceComposer(out);
  }

  /// Rewrite the draft in a fixed [style] (called from the write-help menu).
  Future<void> _runRewriteStyle(String label, String style) async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a draft first, then pick a style'); return; }
    final out = await _runAiTool('rewrite',
        () => ComposerAi.rewrite(text, style), props: {'tone': label});
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runReplyIdeas() async {
    final incoming = _lastIncomingText();
    if (incoming == null) { _toolHint('No message to reply to yet'); return; }
    final out = await _runAiTool('reply_ideas',
        () => ComposerAi.replyIdeas(incoming));
    if (out == null) return;
    final ideas = ComposerAi.parseIdeas(out);
    if (ideas.isEmpty) { _toolHint('No suggestions — try again.'); return; }
    _showReplyIdeas(ideas);
  }

  /// The most recent non-empty message FROM the other side (skips my own
  /// messages, control envelopes and special bubbles like polls/location).
  String? _lastIncomingText() {
    for (var i = _msgs.length - 1; i >= 0; i--) {
      final m = _msgs[i];
      if (m.me || m.special != null) continue;
      final t = m.text.trim();
      if (t.isEmpty || _isControlEnvelope(t)) continue;
      return t;
    }
    return null;
  }

  // ---- pickers --------------------------------------------------------------

  Future<void> _pickTransLang() async {
    final picked = await showModalBottomSheet<ComposerLang>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                  size: 20, color: AD.textPrimary),
              const SizedBox(width: 10),
              Text('Translate into…', style: ADText.threadName()),
            ]),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final l in ComposerAi.languages)
                  ListTile(
                    title: Text(l.label, style: ADText.rowName()),
                    subtitle: l.code != l.label
                        ? Text(l.code, style: ADText.preview())
                        : null,
                    trailing: l.code == _transLangCode
                        ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                            color: AD.iconSearch)
                        : null,
                    onTap: () => Navigator.pop(ctx, l),
                  ),
              ],
            ),
          ),
        ]),
      ),
    );
    if (picked == null) return;
    setState(() => _transLangCode = picked.code);
    try {
      await _aiPrefs.write(key: scopedKey(_kTransLangKey), value: picked.code);
    } catch (_) {/* preference best-effort */}
    // Translate straight away with the new choice — one tap less.
    await _runTranslate();
  }

  void _showReplyIdeas(List<String> ideas) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.lightbulb(PhosphorIconsStyle.bold),
                  size: 20, color: AD.textPrimary),
              const SizedBox(width: 10),
              Text('Reply ideas', style: ADText.threadName()),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Tap one to drop it into your message.',
                  style: ADText.preview()),
            ),
          ),
          for (final idea in ideas)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
              child: GestureDetector(
                onTap: () { Navigator.pop(ctx); _replaceComposer(idea); },
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: AD.card,
                    borderRadius: BorderRadius.circular(Msg.rMd),
                    border: Border.all(color: AD.borderControl, width: 1),
                    boxShadow: const [],
                  ),
                  child: Text(idea, style: ADText.rowName()),
                ),
              ),
            ),
          const SizedBox(height: 12),
        ]),
      ),
    );
  }

  Widget _replyBanner() {
    final isEdit = _editing != null;
    final preview = isEdit ? _editing!.text : (_replyTo?.text ?? '');
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
      child: Row(children: [
        Container(width: 3, height: 32, color: AD.iconSearch),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(isEdit ? 'Editing' : 'Replying to ${_replyTo!.me ? "yourself" : (_replyTo!.senderLabel ?? widget.chat.name)}',
                style: ADText.sectionLabel(c: AD.iconSearch)),
            Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.preview()),
          ]),
        ),
        IconButton(
          icon: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
          onPressed: () => setState(() {
            _replyTo = null;
            if (_editing != null) { _editing = null; _ctrl.clear(); _hasText = false; }
          }),
        ),
      ]),
    );
  }

  // ---- @mentions (groups) ----
  void _onInputChanged(String v) {
    setState(() => _hasText = v.trim().isNotEmpty);
    _onTyping();
    if (_isGroup) _updateMentions(v);
    _refreshComposePreview(v);
  }

  // ── Compose-time link preview ───────────────────────────────────────────────

  /// Called on every keystroke/paste. Debounced 450ms so we unfurl once the user
  /// stops typing, not per character. Cheap no-op when the text has no URL, the
  /// URL hasn't changed, previews are off, or the thread is a pending stranger
  /// thread (same gate the bubbles use).
  void _refreshComposePreview(String v) {
    if (!RemoteConfig.linkPreviewsEnabled || _threadAcceptState == 'pending') return;
    final url = _firstUrl(v);

    // URL gone (or replaced) → drop the stale card immediately.
    if (url == null) {
      _composeUnfurlDebounce?.cancel();
      if (_composePreviewUrl != null || _composePreviewLoading) {
        setState(() {
          _composePreviewUrl = null;
          _composePreview = null;
          _composePreviewLoading = false;
        });
      }
      return;
    }
    if (url == _composePreviewUrl) return;          // already showing/fetching it
    if (_composePreviewDismissed.contains(url)) return; // user ✕'d this one

    _composeUnfurlDebounce?.cancel();
    setState(() {
      _composePreviewUrl = url;
      _composePreview = null;
      _composePreviewLoading = true;
    });
    _composeUnfurlDebounce = Timer(const Duration(milliseconds: 450), () async {
      final fetched = await _unfurl(url);
      if (!mounted || _composePreviewUrl != url) return; // user moved on
      setState(() {
        _composePreview = fetched;
        _composePreviewLoading = false;
        // Nothing unfurlable → hide the bar entirely (raw link only).
        if (fetched == null) _composePreviewUrl = null;
      });
    });
  }

  void _clearComposePreview({bool remember = false}) {
    _composeUnfurlDebounce?.cancel();
    final u = _composePreviewUrl;
    setState(() {
      if (remember && u != null) _composePreviewDismissed.add(u);
      _composePreviewUrl = null;
      _composePreview = null;
      _composePreviewLoading = false;
    });
  }

  /// True when there's a compose-time card to show above the input bar.
  bool get _showComposePreview =>
      _composePreviewUrl != null &&
      (_composePreviewLoading || _composePreview != null);

  /// The card that rides above the composer while a link is in the input box.
  Widget _composePreviewBar() {
    return ComposeLinkPreview(
      loading: _composePreviewLoading,
      preview: _composePreview == null
          ? null
          : LinkPreview.fromEnvelope(_composePreview),
      onDismiss: () {
        Analytics.capture('compose_preview_dismissed', {
          if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
        });
        _clearComposePreview(remember: true);
      },
    );
  }

  void _updateMentions(String v) {
    final m = RegExp(r'@(\w*)$').firstMatch(v);
    if (m == null) { if (_mentionMatches.isNotEmpty) setState(() => _mentionMatches = []); return; }
    final q = m.group(1)!.toLowerCase();
    final names = _memberNames.values.where((n) => n != 'You' && n.toLowerCase().contains(q)).toSet().toList();
    setState(() => _mentionMatches = names.take(6).toList());
  }

  void _insertMention(String name) {
    final v = _ctrl.text.replaceFirst(RegExp(r'@\w*$'), '@$name ');
    _ctrl.text = v;
    _ctrl.selection = TextSelection.collapsed(offset: v.length);
    setState(() { _mentionMatches = []; _hasText = v.trim().isNotEmpty; });
  }

  // ---- [CHAT-MENTIONS-1] The "@" picker (owner request 2026-08-04) ----------
  //
  // Typing `@` still opens the inline `_mentionBar()` autocomplete above; this is
  // the DELIBERATE path — tap "@" in the composer and choose a CHAT MEMBER.
  // Ava private/public are dedicated persistent buttons above the input and are
  // intentionally absent here, so this sheet has one unambiguous purpose.

  /// Everything that can be mentioned in this thread, already in display order.
  List<_MentionOption> _mentionOptions() {
    final out = <_MentionOption>[];

    if (_isGroup) {
      final myUid = _meId?.uid;
      final seen = <String>{};
      for (final uid in (_group?.members ?? const <String>[])) {
        if (uid == myUid) continue;                    // you can't mention yourself
        final name = _memberNames[uid] ?? _shortPub(uid);
        if (name == 'You' || name.trim().isEmpty) continue;
        final token = _mentionToken(name);
        if (token == null || !seen.add(token.toLowerCase())) continue;
        out.add(_MentionOption(
          token: token,
          label: name,
          uid: uid,
          avatarUrl: _memberAvatars[uid] ?? '',
          kind: 'member',
        ));
      }
    } else {
      // 1:1 — the owner asked for the control in BOTH chat types. There is one
      // other person, and listing them keeps the interaction identical whichever
      // thread you're in (and saves typing a long or awkwardly-spelt name).
      final token = _mentionToken(widget.chat.name);
      if (token != null) {
        out.add(_MentionOption(
          token: token,
          label: widget.chat.name,
          avatarUrl: widget.chat.avatarUrl,
          kind: 'peer',
        ));
      }
    }
    return out;
  }

  /// `"Sonal Sharma"` → `"@Sonal"`. Deliberately FIRST WORD ONLY: a mention has
  /// to be one unbroken `@word` or it can't be highlighted, can't be re-parsed,
  /// and a trailing surname would just read as ordinary text. Returns null when
  /// nothing usable survives (e.g. an emoji-only display name).
  String? _mentionToken(String name) {
    final first = name.trim().split(RegExp(r'\s+')).first;
    final cleaned = first.replaceAll(RegExp(r'[^\w]'), '');
    if (cleaned.isEmpty) return null;
    // Guard the collision called out in the code read: a PERSON literally named
    // "Ava" would produce `@ava`, which `_send()` routes to the AI instead of to
    // them. Suffix it so the human is still mentionable and the AI is not
    // summoned by accident.
    if (cleaned.toLowerCase() == 'ava') return '@Ava_';
    return '@$cleaned';
  }

  Future<void> _openMentionPicker() async {
    final options = _mentionOptions();
    Analytics.capture('mention_picker_opened', <String, Object>{
      'is_group': _isGroup,
      'option_count': options.length,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
    final picked = await showModalBottomSheet<_MentionOption>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
        child: SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('MENTION', style: ADText.sectionLabel()),
            const SizedBox(height: 10),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: options.length,
                itemBuilder: (_, i) => _mentionOptionRow(ctx, options[i]),
              ),
            ),
          ]),
        ),
      ),
    );
    if (picked == null || !mounted) return;
    _insertMentionToken(picked);
  }

  Widget _mentionOptionRow(BuildContext ctx, _MentionOption o) {
    final isAva = o.kind.startsWith('ava');
    final tokenColour = o.token.startsWith('#')
        ? MentionTextController.shareGreen
        : MentionTextController.mentionBlue;
    // ZinePressable's default surface is PAPER, not the dark band — so the row's
    // supporting text has to be dark ink. ADText.preview()'s default is white at
    // 60%, which on this card is all but invisible (caught on the emulator).
    const onPaper = Color(0xFF17171B);
    final subStyle = ADText.preview(c: onPaper).copyWith(
      color: onPaper.withValues(alpha: 0.66),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ZinePressable(
        onTap: () => Navigator.pop(ctx, o),
        radius: BorderRadius.circular(AD.rListCard),
        boxShadow: const [],
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(children: [
          if (isAva)
            ZineIconBadge(
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              color: o.kind == 'ava_private' ? AD.iconVideo : AD.online,
              size: 36,
            )
          else
            Avatar(seed: o.uid ?? o.label, name: o.label, size: 36,
                avatarUrl: o.avatarUrl.isEmpty ? null : o.avatarUrl),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(
                  child: Text(o.token,
                      overflow: TextOverflow.ellipsis,
                      style: ADText.rowName(c: tokenColour)
                          .copyWith(fontWeight: FontWeight.w600)),
                ),
                if (o.trailing != null) ...[
                  const SizedBox(width: 6),
                  Text('(${o.trailing!.toLowerCase()})', style: subStyle),
                ],
              ]),
              if (o.subtitle != null) ...[
                const SizedBox(height: 2),
                Text(o.subtitle!, style: subStyle),
              ] else if (o.label.toLowerCase() != o.token.substring(1).toLowerCase()) ...[
                const SizedBox(height: 2),
                Text(o.label, style: subStyle),
              ],
            ]),
          ),
        ]),
      ),
    );
  }

  /// Drop the chosen token in at the cursor (not blindly at the end — people
  /// mention someone mid-sentence), collapse any half-typed `@qu` it is
  /// replacing, and keep the keyboard up so typing continues uninterrupted.
  void _insertMentionToken(_MentionOption o) {
    final text = _ctrl.text;
    final sel = _ctrl.selection;
    var start = sel.isValid ? sel.start : text.length;
    var end = sel.isValid ? sel.end : text.length;

    // If the caret sits just after a partially-typed `@abc`, swallow it so we
    // don't end up with `@so@Sonal`.
    final partial = RegExp(r'[@#]\w*$').firstMatch(text.substring(0, start));
    if (partial != null) start = partial.start;

    final before = text.substring(0, start);
    final needsLeadingSpace = before.isNotEmpty && !before.endsWith(' ') && !before.endsWith('\n');
    final insert = '${needsLeadingSpace ? ' ' : ''}${o.token} ';
    final next = text.replaceRange(start, end, insert);
    final caret = start + insert.length;

    _ctrl.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: caret),
    );
    setState(() {
      _mentionMatches = [];
      _hasText = next.trim().isNotEmpty;
    });
    _composerFocus.requestFocus();

    Analytics.capture('mention_inserted', <String, Object>{
      'kind': o.kind,
      'is_group': _isGroup,
      'via': 'picker',
      if (o.uid != null) 'target_uid': o.uid!,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
  }

  Widget _mentionBar() => Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(top: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        constraints: const BoxConstraints(maxHeight: 160),
        child: ListView(shrinkWrap: true, children: [
          for (final n in _mentionMatches)
            ListTile(
              dense: true,
              leading: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                child: Avatar(seed: n, name: n, size: 32),
              ),
              title: Text(n, style: ADText.rowName()),
              onTap: () => _insertMention(n),
            ),
        ]),
      );
}
