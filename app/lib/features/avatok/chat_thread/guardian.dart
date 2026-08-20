part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadGuardian on _ChatThreadScreenState {

  // Floating-emoji bursts rise + fade from the bottom. Each _BurstFx self-removes
  // after the animation (see _spawnBurst). Horizontal offset is deterministic per
  // id so concurrent bursts spread out instead of stacking.
  Widget _burstOverlay() {
    final w = MediaQuery.of(context).size.width;
    return Stack(children: [
      for (final b in _burstFx)
        TweenAnimationBuilder<double>(
          key: ValueKey(b.id),
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 2100),
          curve: Curves.easeOut,
          builder: (_, t, __) => Positioned(
            left: 24 + ((b.id * 53) % (w.toInt().clamp(120, 4000) - 80)).toDouble(),
            bottom: 90 + t * (MediaQuery.of(context).size.height * 0.5),
            child: Opacity(
              opacity: (1 - t).clamp(0.0, 1.0),
              child: Transform.scale(scale: 1 + t * 0.6, child: Text(b.emoji, style: const TextStyle(fontSize: 34))),
            ),
          ),
        ),
    ]);
  }

  // Uniform header action button — fixed 40x40 hit area, zero internal padding,
  // so the row of actions sits with even spacing and no trailing dead space.
  // ---- shield watchdog (Ava guardian) -----------------------------------------
  String? get _guardianConv {
    final key = _convKey;
    final uid = _meId?.uid;
    if (key == null || uid == null || uid.isEmpty) return null;
    return serverConvFromKey(key, uid);
  }

  // STREAM B (SAFE-GATE-1/2): gate a NEW thread from a NON-CONTACT. The contact
  // check is client-side (ContactsStore is local); the server enforces the
  // receipt suppression once the state is 'pending'. We reconcile with the
  // server (multi-device) but render the local decision instantly.
  Future<void> _initStrangerGate(String peerHex) async {
    if (!StrangerGateBar.enabled) return;
    final conv = _serverConv;
    if (conv == null || peerHex.isEmpty) return;
    try {
      // Respect an explicit stored/server decision. NOTE: 'accepted' is also the
      // DEFAULT for a fresh thread, so we do NOT early-return on accepted here —
      // the contact check + inbound/outbound guards below decide a new thread. Only
      // a blocked thread short-circuits (handled elsewhere).
      final serverState = await StrangerGateApi.state(conv);
      if (serverState == AcceptState.blocked) return;
      // If I already explicitly accepted (I have outbound below) this stays open.
      // Confirm the peer is really a non-contact before gating.
      final contacts = await ContactsStore().load();
      final isContact = contacts.any((c) => c.uid == peerHex);
      if (isContact) { if (mounted) setState(() => _threadAcceptState = 'accepted'); return; } // a saved contact is never gated
      // Only INBOUND-first threads are gated: if I already sent in this thread I
      // initiated contact (e.g. marketplace "Contact seller"), so no gate. History
      // loads async, so we re-check once (the send path also clears the gate via
      // implicit-accept). Empty thread with no inbound → nothing to gate yet.
      final hasOutbound = _msgs.any((m) => m.me);
      final hasInbound = _msgs.any((m) => !m.me);
      if (hasOutbound || !hasInbound) return;
      // Non-contact. If the server hasn't recorded a pending state yet (a brand-new
      // inbound thread reads as the 'accepted' default), DECLARE it pending so the
      // server starts suppressing our read-receipts to the stranger.
      if (serverState != AcceptState.pending) {
        await StrangerGateApi.declarePending(conv);
      }
      if (!mounted) return;
      setState(() { _strangerGatePending = true; _threadAcceptState = 'pending'; });
      StrangerGateBar.trackShown(conv, peerHex);
      // Prompt a decision up front with a modal overlay (once per open). The
      // inline StrangerGateBar remains for when the user dismisses the overlay.
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowStrangerGateSheet(peerHex));
    } catch (_) { /* fail open — no gate rather than a broken thread */ }
  }

  /// Modal overlay shown when a non-contact thread is opened: Accept, Decline
  /// (leave it in Message requests), Block or Report. Mirrors StrangerGateBar's
  /// actions/telemetry so the two entry points stay consistent. Shown once per
  /// thread open; the inline bar handles subsequent decisions.
  Future<void> _maybeShowStrangerGateSheet(String peerHex) async {
    if (!mounted || _gatePromptShown || !_strangerGatePending) return;
    if (_serverConv == null || !StrangerGateBar.enabled) return;
    _gatePromptShown = true;
    final conv = _serverConv!;
    final name = widget.chat.name.trim().isEmpty ? 'This person' : widget.chat.name.trim();
    bool busy = false;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      isDismissible: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderControl, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        Future<void> run(Future<void> Function() action, String verb) async {
          if (busy) return;
          setSheet(() => busy = true);
          try { await action(); } catch (_) {}
        }
        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                PhosphorIcon(PhosphorIcons.userCircle(PhosphorIconsStyle.bold), size: 26, color: AD.iconSearch),
                const SizedBox(width: 10),
                Expanded(child: Text('Message request', style: ADText.rowName())),
              ]),
              const SizedBox(height: 10),
              Text('$name is not in your contacts. Accept to reply, or block/report if it looks like spam. Decline keeps it under Message requests.',
                  style: ADText.preview()),
              const SizedBox(height: 18),
              // Accept — restore the composer and resume normal receipts.
              _gateSheetBtn(
                icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold),
                label: 'Accept', bg: AD.primaryBadge, fg: AD.textPrimary, busy: busy,
                onTap: () => run(() async {
                  await StrangerGateApi.accept(conv);
                  trackStrangerGate('stranger_gate_accept', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                  if (mounted) setState(() { _strangerGatePending = false; _threadAcceptState = 'accepted'; });
                  if (ctx.mounted) Navigator.of(ctx).pop();
                }, 'accept'),
              ),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: _gateSheetBtn(
                  icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                  label: 'Block', bg: AD.iconVideo, fg: AD.textPrimary, busy: busy,
                  onTap: () => run(() async {
                    await StrangerGateApi.block(conv: conv, uid: peerHex.isEmpty ? null : peerHex);
                    trackStrangerGate('stranger_gate_block', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                    if (ctx.mounted) Navigator.of(ctx).pop();
                    if (mounted) Navigator.of(context).maybePop(); // leave the thread
                  }, 'block'),
                )),
                const SizedBox(width: 10),
                Expanded(child: _gateSheetBtn(
                  icon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
                  label: 'Report', bg: AD.danger, fg: Colors.white, busy: busy,
                  onTap: () => run(() async {
                    final id = await StrangerGateApi.report(conv: conv, lastN: 10);
                    trackStrangerGate('stranger_gate_report', {'conv': conv, 'peer': peerHex, 'ok': id != null, 'via': 'overlay'});
                    if (ctx.mounted) Navigator.of(ctx).pop();
                    if (mounted) Navigator.of(context).maybePop();
                  }, 'report'),
                )),
              ]),
              const SizedBox(height: 10),
              // Decline = not now: dismiss, keep pending so it stays in Message requests.
              Center(child: TextButton(
                onPressed: busy ? null : () {
                  trackStrangerGate('stranger_gate_decline', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                  Navigator.of(ctx).pop();
                },
                child: Text('Decline', style: ADText.rowName(c: AD.textSecondary)),
              )),
            ]),
          ),
        );
      }),
    );
  }

  Widget _gateSheetBtn({
    required IconData icon, required String label, required Color bg,
    required Color fg, required bool busy, required VoidCallback onTap,
  }) => ZinePressable(
        onTap: busy ? null : onTap,
        color: bg,
        radius: BorderRadius.circular(Msg.rMd),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          PhosphorIcon(icon, size: 18, color: fg),
          const SizedBox(width: 8),
          Text(label, style: ADText.rowName(c: fg)),
        ]),
      );

  Future<void> _loadGuardian() async {
    final conv = _guardianConv;
    if (conv == null) return;
    try {
      final p = await GuardianPrefsClient.I.get(conv);
      if (mounted) setState(() => _guardian = p);
    } catch (_) {/* keep default off */}
  }

  // Tap the shield → toggle Ava watching THIS chat for scams/grooming/unsafe
  // behaviour. Green = on. Single tap toggles off with no confirmation. Long-press
  // opens the full guardian sheet. G1.3: for MINOR accounts Guardian is force-ON —
  // the shield is locked and this is a no-op (guarded in _shieldAction too).
  Future<void> _toggleGuardian() async {
    if (_isMinorAccount) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Guardian always protects this account')));
      return;
    }
    final conv = _guardianConv;
    if (conv == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Guardian isn’t available for this chat yet')));
      return;
    }
    final next = await GuardianPrefsClient.I.set(conv, secureChat: !_guardian.secureChat, source: 'tap');
    if (!mounted) return;
    setState(() => _guardian = next);
    // Turning ON pops the centered Guardian notice (design 2026-07-13); turning
    // OFF shows a quick snackbar.
    if (next.secureChat) {
      _showGuardianNotice(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Ava watch turned off for this chat')));
    }
  }

  /// Centered Guardian notice modal (design 2026-07-13): dark card, shield glyph,
  /// title + body, single "Got it" button. [on] switches between the "watching"
  /// and "not monitoring" copy/icon.
  void _showGuardianNotice(bool on) {
    showDialog<void>(
      context: context,
      barrierColor: Colors.black.withValues(alpha: 0.7),
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.symmetric(horizontal: 34),
        child: Container(
          decoration: BoxDecoration(
            color: AD.popover,
            border: Border.all(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(Msg.rLg),
            boxShadow: AD.dialogShadow,
          ),
          padding: const EdgeInsets.fromLTRB(24, 26, 24, 22),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 56, height: 56,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: kGuardianGreen.withValues(alpha: 0.15),
              ),
              child: PhosphorIcon(
                  on ? PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold)
                     : PhosphorIcons.shieldSlash(PhosphorIconsStyle.bold),
                  size: 26, color: on ? kGuardianGreen : AD.danger),
            ),
            const SizedBox(height: 12),
            Text(
              on ? 'Guardian is watching this chat'
                 : 'Guardian is not monitoring this chat',
              textAlign: TextAlign.center,
              style: ADText.threadName().copyWith(fontSize: 16.5),
            ),
            const SizedBox(height: 8),
            Text(
              on
                  ? 'Ava is now reviewing this conversation for safety. You’ll get a private heads-up if something looks unsafe.'
                  : 'Messages in this conversation aren’t being reviewed for safety. Stay alert and only share what you’re comfortable with.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary).copyWith(height: 1.55),
            ),
            const SizedBox(height: 18),
            GestureDetector(
              onTap: () => Navigator.of(ctx).pop(),
              child: Container(
                height: 40,
                padding: const EdgeInsets.symmetric(horizontal: 28),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AD.sendActiveBg,
                  borderRadius: BorderRadius.circular(Msg.rSm),
                ),
                child: Text('Got it',
                    style: ADText.rowName(c: AD.sendActiveInk)),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  // G1.2: when the user ACCEPTS a message request from a non-contact stranger,
  // auto-enable Guardian for the chat (source: 'stranger_accept') and show a brief
  // notice. Best-effort — a failed prefs write never blocks the accept. Skipped for
  // minors (already force-ON) and when the shield is already on.
  Future<void> _autoEnableGuardianOnAccept() async {
    if (_isMinorAccount || _guardian.secureChat) return;
    final conv = _guardianConv;
    if (conv == null) return;
    try {
      final next = await GuardianPrefsClient.I.set(conv, secureChat: true, source: 'stranger_accept');
      if (!mounted) return;
      setState(() => _guardian = next);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Ava Guardian is on for this chat — tap the shield to turn it off.')));
    } catch (_) {/* best-effort — never block the accept */}
  }

  void _openGuardianSheet() {
    final conv = _guardianConv;
    if (conv == null) return;
    // U1-lite: pass the peer uid for 1:1 chats so the (dark) "Require verification"
    // row can address the peer. Null for groups → the row is hidden there.
    GuardianSettingsSheet.show(context,
            conv: conv,
            chatLabel: widget.chat.name,
            peerUid: _isGroup ? null : _peerNpub)
        .then((_) => _loadGuardian());
  }

  // Header action icons (shield / search / call / video / ⋮). Bumped to 26px
  // with 46px tap targets (owner request 2026-06-24: the top-bar icons were too
  // small to read/tap comfortably).
  Widget _headerAction(IconData icon, VoidCallback onTap,
          {double size = 26, Color color = AD.textPrimary}) =>
      IconButton(
        icon: PhosphorIcon(icon, size: size, color: color),
        onPressed: onTap,
        visualDensity: VisualDensity.compact,
        padding: EdgeInsets.zero,
        splashRadius: 26,
        constraints: const BoxConstraints(minWidth: 46, minHeight: 46),
      );

  // Shield watchdog toggle: GREEN when Ava is watching this chat. Single tap
  // toggles (no confirmation); long-press opens the full guardian settings.
  // G1.3: for MINOR accounts the shield is LOCKED-ON — green, no toggle, a tooltip
  // explaining Guardian always protects the account.
  Widget _shieldAction() {
    if (_isMinorAccount) {
      return Tooltip(
        message: 'Guardian always protects this account',
        child: _headerAction(
          PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
          () => ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Guardian always protects this account'))),
          color: kGuardianGreen,
        ),
      );
    }
    final on = _guardian.secureChat;
    return GestureDetector(
      onLongPress: _openGuardianSheet,
      child: _headerAction(
        on ? PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill)
           : PhosphorIcons.shield(PhosphorIconsStyle.bold),
        _toggleGuardian,
        // [RAJ-INDIGO-1] OFF state was `AD.textSecondary` — ink at 60%, picked
        // when this sat on the pale turquoise header. The band is indigo now,
        // so that is effectively invisible. Cream at 60% keeps the exact same
        // "on = solid, off = muted" relationship on a dark band. `kGuardianGreen`
        // stays: it is a semantic state colour and it clears indigo fine.
        color: on ? kGuardianGreen : AD.onBand(AD.headerFooter).withValues(alpha: 0.6),
      ),
    );
  }

  // When a guardian warning arrives, remember WHICH message it flagged (by the
  // shared created_at ms) so that incoming message gets painted red.
  void _noteGuardianFlag(String? special, Map<String, dynamic>? extra) {
    if (special != 'ava_private' || extra == null) return;
    final meta = extra['meta'];
    if (meta is Map && (meta['guardian'] == true || meta['red_flag'] == true)) {
      final ts = meta['flagged_created_at'];
      // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) route through `_mutMsgs`
      // instead of mutating `_flaggedTs` bare — `_bubble()` paints a bubble
      // red via `_flaggedTs.contains(m.ts)`, but with the row cache in place
      // an unrouted mutation left the flagged bubble showing its stale
      // (unflagged) cached row until some UNRELATED `_msgsRev` bump happened
      // to come along later.
      if (ts is num && ts > 0) _mutMsgs(() => _flaggedTs.add(ts.toInt()));
    }
  }

  // U1-lite: a Guardian human-verification REQUEST (meta.verify_request) posted
  // privately to ME because the other participant asked Ava to confirm a human
  // is behind this account. Rendered by _verifyRequestBubble.
  bool _isVerifyRequest(_Msg m) {
    if (m.special != 'ava_private') return false;
    final meta = m.extra?['meta'];
    return meta is Map && meta['verify_request'] == true;
  }

  /// Lilac request card: warning text + "Start face check" → the existing
  /// liveness [HumanCheckPage] (source: guardian). On PASS the server-side
  /// liveness success path calls markGatePassed() → the chat's gate flips to
  /// 'passed' with no further client work; we just confirm with a toast.
  Widget _verifyRequestBubble(_Msg m) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        decoration: BoxDecoration(
          color: AD.bubbleInBg,
          border: Border.all(color: AD.bubbleInInk, width: 2),
          boxShadow: const [],
          borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), size: 14, color: AD.bubbleInInk),
            const SizedBox(width: 5),
            Text('AVA · HUMAN CHECK', style: TextStyle(color: AD.bubbleInInk, fontSize: 9.5,
                fontWeight: FontWeight.w600, letterSpacing: 0.6)),
          ]),
          const SizedBox(height: 4),
          Text(m.text, style: TextStyle(color: AD.bubbleInInk, fontSize: 13.5, height: 1.3,
              fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: AD.bubbleInInk, foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 10),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Msg.rSm)),
              ),
              onPressed: () async {
                Analytics.capture('verify_human_started', {'trigger': 'chat_prompt'});
                // [AVA-IDGATE-1] Was HumanCheckPage(guardian), which opened the camera
                // WITHOUT the BIPA consent screen and showed retention copy that
                // contradicted the published schedule. Now routes through the one
                // consent-first gate: consent (tick-box + state) → Didit → server
                // records the pass and flips the chat gate exactly as before.
                final passed = await ensurePublicActionAllowed(context, 'guardian_verify');
                if (passed && mounted) {
                  _toast('Verified — thanks for keeping chats human.');
                }
              },
              child: const Text('Start face check',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(height: 3),
          Text(m.time, style: TextStyle(color: AD.bubbleInInk.withValues(alpha: 0.55), fontSize: 10)),
        ]),
      ),
    );
  }

  // A guardian SAFETY ALERT (private warning Ava posts to the at-risk user).
  bool _isGuardianWarn(_Msg m) {
    if (m.special != 'ava_private') return false;
    final meta = m.extra?['meta'];
    return (meta is Map && (meta['guardian'] == true || meta['red_flag'] == true)) ||
        m.extra?['source'] == 'guardian';
  }

  // RED bubble: white text, shield icon — used for the safety alert AND for an
  // incoming message Ava flagged. Deliberately self-contained so it never touches
  // the normal media/special bubble path.
  // Soft-deleted (by me) pill: "You deleted this message" + an Undo that restores
  // it in MY view only. The content lives on in `m` until I tap Undo (recover) or
  // leave it hidden. onRight for my own messages, left for received ones I hid.
  // [AVAGRP-BUBBLE-2] REGRESSION FIX: this was still `AD.headerFooter`
  // (near-black, 0xFF131316) + `AD.textSecondary` (white 60%) — a hole punched
  // in the white canvas ([AVAGRP-BUBBLE-1] made the canvas white but missed
  // this bubble). Same pale/system pill treatment as `_daySeparator`/
  // `_systemBubble`, wallpaper-aware via `_sysPillBg`/`_sysPillBorder`/
  // `_sysPillMeta` — this is a system-style row (no per-sender tint applies).
  Widget _hiddenBubble(_Msg m) {
    return Align(
      alignment: m.me ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: _sysPillBg,
          border: Border.all(color: _sysPillBorder, width: 1.5),
          borderRadius: BorderRadius.circular(Msg.rMd),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), size: 14, color: _sysPillMeta),
          const SizedBox(width: 6),
          Text('You deleted this message',
              style: ADText.preview(c: _sysPillMeta)),
          const SizedBox(width: 12),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => _undoDelete(m),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), size: 13, color: AD.iconSearch),
              const SizedBox(width: 3),
              Text('UNDO', style: ADText.statCaption(c: AD.iconSearch)),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _redFlagBubble(_Msg m, String label) {
    return GestureDetector(
      onLongPress: () => _onBubbleLongPress(m),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          decoration: BoxDecoration(
            color: const Color(0xFFD32F2F), // strong red — unmistakable danger
            border: Border.all(color: AD.borderControl, width: 2),
            boxShadow: const [],
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill), size: 14, color: Colors.white),
              const SizedBox(width: 5),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 9.5,
                  fontWeight: FontWeight.w600, letterSpacing: 0.6)),
            ]),
            const SizedBox(height: 4),
            Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.3,
                fontWeight: FontWeight.w500)),
            const SizedBox(height: 3),
            Text(m.time, style: const TextStyle(color: Colors.white70, fontSize: 10)),
          ]),
        ),
      ),
    );
  }

  // ── F6: safety-flag bubble + tap-sheet ──────────────────────────────────────
  // The server posts {type:'safety_flag', conv, msg_id, category} to MY InboxDO;
  // SyncHub persists it (per-account, keyed by msg_id) and fans it out. Here the
  // flagged bubble renders red and, on tap/long-press, opens a sheet with the
  // category explanation + Block / Report / This is fine. The sender is NEVER
  // notified (block/report are one-sided; "This is fine" is a local dismiss).

  /// The active safety category for [m] (null ⇒ not flagged, or locally
  /// dismissed). Matches on the message's rumor id (evId), the flag's msg_id.
  String? _safetyCategoryFor(_Msg m) {
    final id = m.evId;
    if (id == null || id.isEmpty) return null;
    return _safetyFlaggedIds[id];
  }

  /// Plain-language explanation for a guardian category (kept generic so an
  /// unknown/new category still reads sensibly).
  String _safetyCategoryExplain(String category) {
    switch (category.toLowerCase()) {
      case 'grooming':
        return 'Ava spotted signs of grooming — an adult trying to build secret trust, '
            'move you off the app, or ask for private things. Please tell an adult you trust.';
      case 'scam':
      case 'fraud':
        return 'Ava thinks this may be a scam — an unexpected offer, a prize, or a request '
            'for money or codes. Never send money or personal details.';
      case 'sextortion':
      case 'csam':
      case 'sexual':
        return 'Ava flagged sexual or exploitative content. You do not have to reply. '
            'Block this person and tell an adult you trust — you are not in trouble.';
      case 'harassment':
      case 'bullying':
        return 'Ava flagged bullying or harassment. You can block or report this person, '
            'and it is okay to ask an adult for help.';
      case 'violence':
      case 'self_harm':
      case 'selfharm':
        return 'Ava flagged content about harm. If you or someone is in danger, please '
            'reach out to an adult you trust right away.';
      case 'spam':
        return 'Ava thinks this looks like spam or an unsolicited promo. You can ignore, '
            'block, or report it.';
      default:
        return 'Ava flagged this message as possibly unsafe. Trust your gut — you can block '
            'or report this person, or dismiss this if you know it is fine.';
    }
  }

  String _safetyCategoryLabel(String category) {
    final c = category.trim();
    if (c.isEmpty) return 'Flagged by Ava';
    return 'Flagged by Ava — ${c.replaceAll('_', ' ')}';
  }

  Widget _safetyFlagBubble(_Msg m, String category) {
    return GestureDetector(
      onTap: () => _openSafetySheet(m, category),
      onLongPress: () => _openSafetySheet(m, category),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          decoration: BoxDecoration(
            color: const Color(0xFFD32F2F), // strong red — unmistakable danger
            border: Border.all(color: AD.borderControl, width: 2),
            boxShadow: const [],
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill), size: 14, color: Colors.white),
              const SizedBox(width: 5),
              Flexible(child: Text(_safetyCategoryLabel(category),
                  style: const TextStyle(color: Colors.white, fontSize: 9.5,
                      fontWeight: FontWeight.w600, letterSpacing: 0.5))),
            ]),
            const SizedBox(height: 4),
            Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.3,
                fontWeight: FontWeight.w500)),
            const SizedBox(height: 4),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Text(m.time, style: const TextStyle(color: Colors.white70, fontSize: 10)),
              const SizedBox(width: 8),
              Text('Tap for options', style: const TextStyle(color: Colors.white70, fontSize: 10,
                  fontWeight: FontWeight.w600)),
            ]),
          ]),
        ),
      ),
    );
  }

  /// Bottom sheet for a flagged message: category explanation + Block sender /
  /// Report / This is fine. The sender is never told about any of these.
  void _openSafetySheet(_Msg m, String category) {
    HapticFeedback.mediumImpact();
    Analytics.capture('safety_flag_sheet_opened', {'category': category, 'is_group': _isGroup});
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: AD.danger, size: 40),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Ava flagged this message', style: ADText.threadName()),
                Text('From Ava — only you can see this', style: ADText.preview()),
              ])),
            ]),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: AD.headerFooter,
                borderRadius: BorderRadius.circular(Msg.rMd),
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: Text(_safetyCategoryExplain(category), style: ADText.preview()),
            ),
            const SizedBox(height: 16),
            AdButton(
              label: 'Block sender',
              variant: AdButtonVariant.danger,
              fullWidth: true,
              icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _blockSender(category); },
            ),
            const SizedBox(height: 8),
            AdButton(
              label: 'Report',
              variant: AdButtonVariant.teal,
              fullWidth: true,
              icon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _reportFlagged(m, category); },
            ),
            const SizedBox(height: 8),
            AdButton(
              label: 'This is fine',
              variant: AdButtonVariant.ghost,
              fullWidth: true,
              icon: PhosphorIcons.check(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _dismissFlag(m, category); },
            ),
          ]),
        ),
      ),
    );
  }

  Future<void> _blockSender(String category) async {
    final uid = _peerNpub;
    if (uid == null || uid.isEmpty) {
      _toast('Couldn\'t identify the sender to block.');
      return;
    }
    Analytics.capture('safety_flag_block', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (block).
    Analytics.capture('guardian_warning_actioned', {'action': 'block', 'category': category, 'is_group': _isGroup});
    try {
      // Same `blocks` table the messaging gate reads — a block silently stops all
      // future sends from this uid. The sender is not notified.
      final res = await ApiAuth.postJson('$kApiBase/creators/$uid/block', const {});
      _toast(res.statusCode == 200 ? 'Blocked. They can no longer message you.'
                                   : 'Couldn\'t block right now — try again.');
    } catch (_) {
      _toast('Couldn\'t block right now — try again.');
    }
  }

  Future<void> _reportFlagged(_Msg m, String category) async {
    Analytics.capture('safety_flag_report', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (report).
    Analytics.capture('guardian_warning_actioned', {'action': 'report', 'category': category, 'is_group': _isGroup});
    final targetId = _peerNpub ?? _convKey ?? '';
    try {
      // Generic moderation report (POST /api/report {targetType,targetId,reason}).
      // Carry the flagged message id (msg_id) so moderation can locate the row.
      final res = await ApiAuth.postJson('$kApiBase/report', {
        'targetType': 'message',
        'targetId': targetId,
        'reason': 'safety_flag:$category',
        if (m.evId != null) 'msgId': m.evId,
      });
      _toast(res.statusCode == 200 ? 'Thanks — reported to our safety team.'
                                   : 'Couldn\'t send the report — try again.');
    } catch (_) {
      _toast('Couldn\'t send the report — try again.');
    }
  }

  /// "This is fine" — local dismiss. Persists the dismissal (so it stays hidden
  /// on reopen) and removes the red state now. NO network call — the sender is
  /// never notified.
  Future<void> _dismissFlag(_Msg m, String category) async {
    final id = m.evId;
    if (id == null || id.isEmpty) return;
    Analytics.capture('safety_flag_dismissed', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (dismiss = "This is fine").
    Analytics.capture('guardian_warning_actioned', {'action': 'dismiss', 'category': category, 'is_group': _isGroup});
    setState(() => _safetyFlaggedIds.remove(id));
    await _safetyStore.dismiss(id);
    // [G2] Also push the dismissal to the server so "This is fine" reaches my OTHER
    // devices and survives a reinstall (store-and-forward). Best-effort — the local
    // dismiss above already applied; a failed round-trip reconciles on the next sync.
    unawaited(GuardianPrefsClient.I.dismissFlag(id, conv: _serverConvId ?? ''));
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }
}
