part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadAiAssist on _ChatThreadScreenState {

  // ---- STREAM G [GROUP-AI-2/3] per-member group translation ----
  /// Toggle "Translate this group for me". When turned ON, translate the loaded
  /// TEXT messages into the user's Stream-A language on FETCH (server caches per
  /// msg_id+lang). Voice notes are not translated (only text rows are sent).
  Future<void> _toggleGroupTranslate() async {
    if (!(widget.chat.group || widget.chat.gid != null)) return;
    final turningOn = !_groupTranslateOn;
    setState(() => _groupTranslateOn = turningOn);
    if (!turningOn) {
      // Revert: drop the translations so bubbles show the original again.
      _mutMsgs(() { for (final m in _msgs) { m.extra?.remove('translated'); m.extra?.remove('translated_lang'); } });
      Analytics.capture('group_translate_enabled', {'lang': _transLang.code, 'on': false});
      return;
    }
    Analytics.capture('group_translate_enabled', {'lang': _transLang.code, 'on': true});
    await _applyGroupTranslation();
  }

  /// Fetch translations for the currently-loaded, not-mine text messages of the
  /// group into the remembered language and stash them on each bubble's extra so
  /// the TranslatedText wrapper renders "translated · show original".
  Future<void> _applyGroupTranslation() async {
    if (!_groupTranslateOn || _groupTranslateBusy) return;
    final conv = _serverConvId;
    if (conv == null) return;
    final lang = _transLang.code;
    // Only text rows the member actually fetched, no media/voice, not mine.
    final targets = _msgs.where((m) => !m.me && m.special == null && m.media == null
        && m.text.trim().isNotEmpty && (m.extra?['translated'] == null)).toList();
    if (targets.isEmpty) return;
    setState(() => _groupTranslateBusy = true);
    final batch = <Map<String, String>>[
      for (final m in targets) {'id': m.evId ?? '${m.id}', 'text': m.text.trim()},
    ];
    final out = await AiChatApi.groupTranslate(conv, lang, batch);
    if (!mounted) { return; }
    _mutMsgs(() {
      _groupTranslateBusy = false;
      for (final m in targets) {
        final t = out[m.evId ?? '${m.id}'];
        if (t != null && t.isNotEmpty) {
          (m.extra ??= <String, dynamic>{})['translated'] = t;
          m.extra!['translated_lang'] = lang;
        }
      }
    });
  }

  // ---- STREAM G [GROUP-AI-1] group catch-up ("What did I miss?") ----
  /// Server conv id for THIS thread computed from the conv key (works for DM +
  /// group). Renamed from _serverConv to avoid clashing with the stranger-gate
  /// field `_serverConv` (both were added by concurrent streams).
  String? get _serverConvId {
    final key = _convKey;
    final myUid = _meId?.uid;
    if (key == null || myUid == null || myUid.isEmpty) return null;
    return serverConvFromKey(key, myUid);
  }

  /// Count of unread INCOMING messages currently loaded (drives the >25 gate).
  int get _unreadIncoming => _msgs.where((m) => !m.me && m.special == null).length;

  /// Whether the "What did I miss?" button should be offered: a group thread with
  /// >25 unread and the messaging AvaBrain guardrail ON.
  Future<bool> _catchupAvailable() async {
    // [PIVOT-AI-DARK-1] Master switch first — cheapest check, and it keeps the
    // "What did I miss?" affordance from being offered at all when AI is dark.
    if (!RemoteConfig.aiEnabled) return false;
    if (!(widget.chat.group || widget.chat.gid != null)) return false;
    if (_unreadIncoming <= 25) return false;
    return BrainConsent.isOn('messaging');
  }

  Future<void> _whatDidIMiss() async {
    // [PIVOT-AI-DARK-1] Belt and braces. _catchupAvailable already hides the
    // entry point, but a stale widget or a future caller must not be able to
    // POST into a server that will only answer `ai_disabled`. The pattern the
    // codebase already learned with generativeEnabled: short-circuit WITHOUT a
    // network call rather than letting every tap become a real request into a
    // guaranteed refusal.
    if (!RemoteConfig.aiEnabled) return;
    final conv = _serverConvId;
    if (conv == null) return;
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to use catch-up.');
      return;
    }
    setState(() { _catchupLoading = true; _catchupDismissed = false; });
    // since_seq 0 = summarise the whole loaded unread window; the server pulls
    // text-only from my own InboxDO and never stores the summary.
    final bullets = await AiChatApi.catchup(conv, sinceSeq: 0);
    if (!mounted) return;
    setState(() {
      _catchupLoading = false;
      _catchupBullets = bullets;
      _catchupCount = _unreadIncoming;
    });
    if (bullets.isEmpty) _toast('Nothing to catch up on.');
  }

  void _dismissCatchup() => setState(() { _catchupDismissed = true; _catchupBullets = const []; });

  // ---- [AVABRAIN-COMPANION-UI-1] Group Companion draft cards ----
  /// Fetch pending drafts for this group. Group threads only; feature-detects
  /// a 404/network failure (AvaGroupApi.listDrafts already degrades to []),
  /// so this is safe to call unconditionally on open/resume/after-decision.
  /// [LAUNCH-DARK-1 2026-09-05] Gated on `aiEnabled` at the FETCH, not just the
  /// card. This had no AI flag of any kind and was called unconditionally on
  /// every group-thread open — so with AI dark it still burned a network round
  /// trip per thread and, if the server answered, rendered an Ava-branded
  /// "AVA SUGGESTS" card with Approve/Reject. Guarding here closes both the
  /// request and the card, since the card renders off `_companionDrafts`.
  Future<void> _fetchCompanionDrafts() async {
    if (!RemoteConfig.aiEnabled) return;
    if (!_isGroup) return;
    final conv = _serverConvId;
    if (conv == null) return;
    try {
      final drafts = await AvaGroupApi.listDrafts(conv);
      if (!mounted) return;
      final hadNone = _companionDrafts.isEmpty;
      setState(() => _companionDrafts = drafts);
      if (hadNone && drafts.isNotEmpty) {
        Analytics.uiInteraction('companion_draft_shown', 0, extra: {
          'conv': conv, 'count': drafts.length, 'capability': drafts.first.capability,
        });
      }
    } catch (e, st) {
      Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'action': 'companion_drafts_fetch'});
    }
  }

  Future<void> _approveCompanionDraft(AvaGroupDraft d) async {
    if (_companionDraftBusy) return;
    setState(() => _companionDraftBusy = true);
    try {
      final ok = await AvaGroupApi.approveDraft(d.decisionId);
      if (ok) {
        Analytics.uiInteraction('companion_draft_approved', 0, extra: {
          'decision_id': d.decisionId, 'capability': d.capability, 'scope': d.scope,
        });
      } else if (mounted) {
        _toast('Could not approve — please try again.');
      }
    } catch (e, st) {
      Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'action': 'companion_draft_approve', 'decision_id': d.decisionId});
    } finally {
      if (mounted) setState(() => _companionDraftBusy = false);
      await _fetchCompanionDrafts(); // card disappears; the real message arrives via normal sync
    }
  }

  Future<void> _rejectCompanionDraft(AvaGroupDraft d) async {
    if (_companionDraftBusy) return;
    setState(() => _companionDraftBusy = true);
    try {
      final ok = await AvaGroupApi.rejectDraft(d.decisionId);
      if (ok) {
        Analytics.uiInteraction('companion_draft_rejected', 0, extra: {
          'decision_id': d.decisionId, 'capability': d.capability, 'scope': d.scope,
        });
      } else if (mounted) {
        _toast('Could not dismiss — please try again.');
      }
    } catch (e, st) {
      Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'action': 'companion_draft_reject', 'decision_id': d.decisionId});
    } finally {
      if (mounted) setState(() => _companionDraftBusy = false);
      await _fetchCompanionDrafts();
    }
  }

  /// "Ava suggests" card — rendered ABOVE the composer (never in the message
  /// list, so it can't shift `_MessageRow` indexing). Shows the oldest pending
  /// draft; Approve is disabled unless the server said `can_decide` for me.
  Widget _companionDraftCard() {
    if (_companionDrafts.isEmpty) return const SizedBox.shrink();
    final d = _companionDrafts.first;
    final more = _companionDrafts.length - 1;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
      decoration: BoxDecoration(
        color: AD.card,
        border: Border.all(color: AD.borderControl, width: 1),
        borderRadius: BorderRadius.circular(AD.rStatCard),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 15, color: AD.iconVideo),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              'AVA SUGGESTS · ${d.capability.isEmpty ? "message" : d.capability}'
                  '${d.scope == "private" ? " · only you see this" : ""}',
              style: ADText.statCaption(c: AD.textSecondary),
            ),
          ),
          if (more > 0)
            Text('+$more more', style: ADText.statCaption(c: AD.textTertiary)),
        ]),
        const SizedBox(height: 8),
        Text(d.draftText, style: ADText.preview(c: AD.textPrimary)),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: AdButton(
              label: 'Dismiss',
              variant: AdButtonVariant.ghost,
              fullWidth: true,
              trailingIcon: false,
              onPressed: _companionDraftBusy ? null : () => _rejectCompanionDraft(d),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: AdButton(
              label: d.canDecide ? 'Approve' : 'Needs admin',
              variant: AdButtonVariant.teal,
              fullWidth: true,
              trailingIcon: false,
              onPressed: (_companionDraftBusy || !d.canDecide) ? null : () => _approveCompanionDraft(d),
            ),
          ),
        ]),
      ]),
    );
  }

  // ---- STREAM G [GROUP-AI-4] smart replies (DMs) ----
  /// Debounced fetch after an incoming DM. Only fires for 1:1 threads when the
  /// screen is mounted (open + foreground). The guardrail stays server-enforced,
  /// but the FLAGS are now checked here too — [PIVOT-AI-DARK-1]. This method used
  /// to fire on every incoming DM and rely entirely on the server to refuse,
  /// which meant flipping `aiEnabled` or `smartRepliesEnabled` off silenced the
  /// chips while still generating a request per message. Server-side enforcement
  /// remains the authority; this just stops paying for a refusal.
  void _maybeFetchSmartReplies() {
    if (!RemoteConfig.aiEnabled || !RemoteConfig.smartRepliesEnabled) {
      if (_smartReplies.isNotEmpty) setState(() => _smartReplies = const []);
      return;
    }
    if (widget.chat.group || widget.chat.gid != null) return; // DMs only
    _smartReplyDebounce?.cancel();
    _smartReplyDebounce = Timer(const Duration(milliseconds: 900), () async {
      if (!mounted) return;
      // Don't suggest replies to my own last message.
      final tail = _msgs.where((m) => m.special == null && m.text.trim().isNotEmpty).toList();
      if (tail.isEmpty || tail.last.me) { if (_smartReplies.isNotEmpty) setState(() => _smartReplies = const []); return; }
      final last4 = tail.length <= 4 ? tail : tail.sublist(tail.length - 4);
      final payload = <Map<String, Object>>[
        for (final m in last4) {'me': m.me, 'text': m.text.trim()},
      ];
      final s = await AiChatApi.smartReplies(payload);
      if (!mounted) return;
      setState(() => _smartReplies = s);
    });
  }

  void _insertSmartReply(String text) {
    Analytics.capture('smart_reply_used', {'len': text.length});
    _ctrl.text = _ctrl.text.isEmpty ? text : '${_ctrl.text} $text';
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    setState(() { _hasText = _ctrl.text.trim().isNotEmpty; _smartReplies = const []; });
    _composerFocus.requestFocus();
  }

  // ---- STREAM G [GROUP-AI-5] inline translate one bubble ----
  Future<void> _inlineTranslate(_Msg m) async {
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to translate.');
      return;
    }
    final text = m.text.trim();
    if (text.isEmpty) return;
    final to = _transLang.code; // user's Stream-A / remembered language
    // Local drift cache first (scoped per account) so a re-translate is free.
    final cached = await _msgStore.readTranslation(m.evId ?? '${m.id}', to);
    if (cached != null && cached.isNotEmpty) {
      if (mounted) _showInlineTranslation(m, cached, to);
      return;
    }
    _toast('Translating…');
    final out = await AiChatApi.translate(text, to);
    if (!mounted) return;
    if (out == null) { _toast('Could not translate.'); return; }
    Analytics.capture('inline_translate_used', {'lang': to});
    try { await _msgStore.writeTranslation(m.evId ?? '${m.id}', to, out); } catch (_) {}
    _showInlineTranslation(m, out, to);
  }

  /// Stash the translation on the message's `extra` so the bubble can render it
  /// under the original (via TranslatedText) without touching Stream K geometry.
  void _showInlineTranslation(_Msg m, String translated, String lang) {
    _mutMsgs(() {
      (m.extra ??= <String, dynamic>{})['translated'] = translated;
      m.extra!['translated_lang'] = lang;
    });
  }
}
