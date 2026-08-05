part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// [CHAT-THREAD-SPLIT-3] Inbound message/receipt/edit handling and send-status updates.
extension _ChatThreadInbound on _ChatThreadScreenState {

  /// Apply a peer's live reaction (PartyKit) to the aggregate count + "reacted by"
  /// set on the target bubble — same logic the retired Ably path used.
  void _applyPartyReaction(Map<String, dynamic> e) {
    final mid = e['mid']?.toString();
    final emoji = e['emoji']?.toString();
    if (mid == null || emoji == null) return;
    final add = e['add'] == true;
    final who = (e['from'] ?? '').toString();
    final whoName = (e['whoName'] ?? '').toString();
    if (whoName.isNotEmpty && who.isNotEmpty && _memberNames[who] != whoName) {
      _memberNames[who] = whoName;
    }
    final i = _msgs.indexWhere((m) => m.evId == mid);
    if (i < 0) return;
    _mutMsgs(() {
      final msg = _msgs[i];
      final c = msg.reactCounts;
      c[emoji] = ((c[emoji] ?? 0) + (add ? 1 : -1)).clamp(0, 9999);
      if (c[emoji] == 0) c.remove(emoji);
      final by = msg.reactBy.putIfAbsent(emoji, () => <String>{});
      if (add) { by.add(who); } else { by.remove(who); }
      if (by.isEmpty) msg.reactBy.remove(emoji);
    });
  }

  void _onGroupMsg(GroupMessage m) {
    if (_seenEv.contains(m.rumorId)) return;
    _seenEv.add(m.rumorId);
    if (!mounted) return;
    String text = '';
    ChatMedia? media;
    Map<String, dynamic>? replyMeta;
    String? special;
    Map<String, dynamic>? extra;
    // [AVAGRP-BUBBLE-2] `GroupApi.announce()` (group_info_screen.dart's
    // photo-change / new_group_screen's "created the group" / add-member
    // copy) sends `{"t":"gtext","gid":conv,"body":text,"system":true}` — the
    // SAME envelope shape as an ordinary text message, distinguished only by
    // this flag. This has been on the wire for years; the client just never
    // read it, so every announcement rendered as an ordinary tinted bubble
    // with a sender name and avatar instead of a centered system pill.
    bool isSystem = false;
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'gedit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && (env['t'] == 'del' || env['t'] == 'gdel')) { if (!m.mine) _applyDelete(env['target'].toString()); return; }
      if (env is Map && env['t'] == 'hide') { _applyHide(env['target'].toString(), env['hidden'] == true); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env); return; }
      // [AVAGRP-BUBBLE-2] Per-message group read/delivered receipt (Agent C's
      // backend — `sync_hub.dart` `_ingestMsgReceipt`). A CONTROL frame, never a
      // chat bubble — applies to the already-rendered `_Msg` (matched by its
      // canonical mid, `_Msg.evId`, the same id already used for reactions) and
      // returns before falling into the bubble-content switch below.
      if (env is Map && env['t'] == 'msg_receipt') { _applyMsgReceipt(env.cast<String, dynamic>()); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept', 'marketplace_deal', 'voicemail', 'agent_transcript'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
        // A poll bubble just arrived — pull its server tally so late joiners /
        // reinstalled devices see any votes already cast (best-effort).
        if (special == 'poll') unawaited(_hydratePolls());
      } else if (env is Map && env['t'] == 'gmedia') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
        if (!m.mine) _recordReceivedMedia(media);
      } else if (env is Map && env['t'] == 'gtext') {
        text = (env['body'] ?? '').toString();
        isSystem = env['system'] == true;
      } else if (env is Map && env['t'] == 'deleted') {
        text = 'This message was deleted'; // server tombstone on re-sync
      } else {
        return; // ginfo/gkick etc. — not chat content
      }
      if (env is Map && env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
      // STREAM C: link preview embedded by the sender at compose time — render
      // from the envelope, never fetch on the recipient.
      if (env is Map && env['preview'] is Map) {
        extra = {...?extra, 'preview': (env['preview'] as Map).cast<String, dynamic>()};
      }
    } catch (_) {
      return;
    }
    final env2 = jsonDecode(m.payload) as Map;
    // Phase 5: learn this member's display name from the message (carried as
    // `fromName`), keyed by their uid — so bubbles AND the "reacted by" sheet can
    // show a real name instead of a short id.
    final fromName = (env2['fromName'] ?? '').toString().trim();
    if (!m.mine && fromName.isNotEmpty && m.senderPub.isNotEmpty &&
        _memberNames[m.senderPub] != fromName) {
      _memberNames[m.senderPub] = fromName;
    }
    final exp = (env2['exp'] as num?)?.toInt();
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return; // already gone
    // Safety net: any control envelope (del/gdel/receipt/…) that reached here
    // unhandled must NEVER render as a raw `{"t":...}` bubble. The explicit
    // handlers above already returned for the ones we act on; this catches the rest.
    if (_isControlEnvelope(m.payload)) {
      Analytics.capture('chat_control_filtered', {'where': 'group_live'});
      return;
    }
    // A peer deleted this for everyone (recorded durably) — render the tombstone,
    // never the original body, even though the cached/replayed envelope still has it.
    if (_deletedIds.contains(m.rumorId)) {
      text = 'This message was deleted'; media = null; special = null; extra = null; replyMeta = null;
    }
    _mutMsgs(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: env2['forwarded'] == true, expireAt: exp, special: special, extra: extra,
          starred: _starred.contains(m.rumorId), hidden: _hiddenIds[m.rumorId] == true,
          // [AVAGRP-BUBBLE-2] A system announcement carries no sender identity —
          // no name header, no avatar, no per-sender tint (`_systemBubble`
          // renders before any of that is consulted, but null these out too so
          // a future call site that reads `senderLabel`/`senderPub` directly
          // can't accidentally attribute the announcement to whoever posted it).
          senderLabel: isSystem ? null : _groupLabelFor(m.senderPub, mine: m.mine),
          // [AVAGRP-BUBBLE-1] stable identity for bubble colour + avatar lookup —
          // the previous code only kept the derived display label and threw the
          // uid away, which was the root cause of both the '?' avatar and the
          // reshuffling group tints.
          senderPub: (isSystem || m.mine) ? null : m.senderPub,
          system: isSystem));
      _noteGuardianFlag(special, extra);
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    // Full-thread RAG: index a member's LIVE group text into my own store.
    // `_ragLive` gates out the history that replays on open (avoids re-indexing).
    if (!m.mine && _ragLive && special == null && media == null) {
      _ragAddLine(_shortPub(m.senderPub), text);
    }
    // [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1] "delivered" half of the WhatsApp-style
    // two-step group receipt: the instant a peer's message is rendered on THIS
    // device it has been delivered, regardless of whether the thread is the one
    // on screen right now (that's the 'read' half — `_markRead` below fires that
    // when the thread is actually viewed). System pills and control frames never
    // get a receipt (they already `return`d above / carry no `senderPub`).
    // Gated on the dark-launch kill switch — `AvaGroupDm.sendMsgReceipt` is also
    // defense-in-depth server-side, but skip the network call entirely while off.
    if (!m.mine && !isSystem && m.senderPub.isNotEmpty && RemoteConfig.groupReceiptsEnabled) {
      _gdm?.sendMsgReceipt('delivered', {m.senderPub: [m.rumorId]});
      // Two-sided telemetry (CLAUDE.md): fires on the READER's device — tag the
      // ORIGINAL SENDER's uid (`sender_pub`) alongside the auto-stamped reader
      // email, so a report from either party's email can be joined against the
      // other side via `mid`/`sender_pub`.
      Analytics.capture('chat_group_receipt_sent', {
        'status': 'delivered', 'mid': m.rumorId, 'sender_pub': _shortPub(m.senderPub), 'gid': widget.chat.gid ?? '',
      });
    }
    _jump();
    _markRead();
    // STREAM G [GROUP-AI-4]: after an INCOMING DM, offer smart replies (debounced,
    // DM-only; the method self-gates on group/foreground and clears on my own msg).
    if (!m.mine && special == null && media == null) _maybeFetchSmartReplies(); // STREAM G
    _schedulePersist();
  }

  // The relay accepted/rejected one of our sends → flag the bubble accordingly.
  // ok=true means the event is now ON THE RELAY ("sent" / 1 tick); delivery and
  // read are reported separately by the recipient over the presence channel.
  void _onSendStatus(({String rumorId, bool ok, String message}) s) {
    if (!mounted) return;
    final idx = _msgs.indexWhere((m) => m.evId == s.rumorId);
    if (idx < 0) return;
    final m = _msgs[idx];
    final alreadySent = m.sent;
    // [AVA-GRP-SENDSTATE] The outbox only emits ok:false on a TERMINAL give-up
    // (interim retries stay silent), so `!s.ok` here is authoritative "not sent".
    // Record it so a genuine give-up survives a restart as failed, while a
    // delivered-but-un-ACKed group bubble is never mistaken for one on reopen.
    _mutMsgs(() { m.failed = !s.ok; m.sent = s.ok; m.sendGaveUp = !s.ok; });
    // [AVA-CHAT-INSTANT] Confirm/fail telemetry (email auto-attached by
    // Analytics._base). msg_send_confirmed carries the true send→ACK round-trip;
    // guard on !alreadySent so a re-emitted ACK doesn't double-count.
    if (s.ok && !alreadySent) {
      Analytics.capture('msg_send_confirmed', {
        'conv_kind': _isGroup ? 'group' : 'dm',
        if (m.sendStartedMs != null)
          'round_trip_ms': DateTime.now().millisecondsSinceEpoch - m.sendStartedMs!,
      });
    } else if (!s.ok) {
      Analytics.capture('msg_send_failed', {
        'conv_kind': _isGroup ? 'group' : 'dm',
        'has_media': m.media != null || m.localBytes != null,
        if (s.message.isNotEmpty) 'reason': s.message.length > 80 ? s.message.substring(0, 80) : s.message,
      });
    }
  }

  // [seed]=true when replaying stored history (hub memory / local DB) on open —
  // it suppresses re-sending read receipts for old messages (only genuinely
  // live, just-arrived messages should mark-read).
  void _onDm(DmMessage m, {bool seed = false}) {
    if (_seenEv.contains(m.rumorId)) return;
    _seenEv.add(m.rumorId);
    if (!mounted) return;
    // Parse our envelope: {"t":"text","body":...} or {"t":"media",...}.
    String text = m.payload;
    ChatMedia? media;
    Map<String, dynamic>? replyMeta;
    bool forwarded = false;
    int? exp;
    String? special;
    Map<String, dynamic>? extra;
    // G3 (inline two-lane scan): an incoming envelope may carry a top-level
    // `safety:{category,severity}` verdict stamped by the server's FAST lane before
    // fan-out. Treat it like a live safety_flag frame — mark the bubble red on
    // arrival via the existing SafetyFlagStore + _safetyFlags path (below), so the
    // recipient sees the red flag instantly instead of waiting for the deep lane's
    // separate safety_flag push. Only for incoming (peer) messages.
    String? inlineSafetyCat;
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'receipt') { _applyReceipt(m.mine, env); return; } // status, never a bubble
      if (env is Map && env['t'] == 'read') return; // read high-water (badge clears via the chat list) — never a bubble
      // [CHAT-RAWENV-1] (owner report 2026-07-16, pic 4) — THE bug in pic 4.
      // A status post is fanned out to every contact over the SAME inbox stream
      // that carries DMs (see status_screen._addPhoto → chat_list._startInbox,
      // which lifts it into the status ring). This thread also reads that
      // stream, had no `status` branch, and so fell through to the catch-all
      // with `text` still holding the raw payload — rendering the entire status
      // envelope, nested media descriptor and AES key included, as a text
      // bubble in the conversation. Status posts belong to the ring, never to a
      // thread: swallow it here.
      if (env is Map && env['t'] == 'status') return;
      if (env is Map && env['gid'] != null) return; // group message — not this 1:1
      if (env is Map && env['t'] == 'edit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && (env['t'] == 'del' || env['t'] == 'gdel')) { if (!m.mine) _applyDelete(env['target'].toString()); return; }
      if (env is Map && env['t'] == 'hide') { _applyHide(env['target'].toString(), env['hidden'] == true); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept', 'marketplace_deal', 'voicemail', 'agent_transcript'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
        // A poll bubble just arrived — pull its server tally so late joiners /
        // reinstalled devices see any votes already cast (best-effort).
        if (special == 'poll') unawaited(_hydratePolls());
      } else if (env is Map && env['t'] == 'media') {
        // [CHAT-RAWENV-1] Scoped try: a throw in here (an unknown MediaKind, a
        // `size` that arrived as a String, a missing key from a newer build)
        // used to escape to the outer catch with `text` still equal to the raw
        // payload — i.e. one bad field printed the AES key on screen. Now the
        // failure is reported and the frame is dropped by the backstop below.
        try {
          media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        } catch (e) {
          Analytics.capture('chat_media_envelope_parse_failed', {
            'error': e.runtimeType.toString(),
            // `?? '(absent)'` is load-bearing, not defensive padding:
            // Analytics.capture takes Map<String, Object>?, so a String? value
            // here is a compile error — and a MISSING `kind` is exactly one of
            // the failures this event exists to catch, so null is a value we
            // must expect and report, not one we can assume away.
            'kind': env['kind']?.toString() ?? '(absent)',
            'size_type': env['size'].runtimeType.toString(),
            'mine': m.mine,
            'peer': widget.chat.name,
          });
          rethrow;
        }
        text = _caption(media.kind, media.name);
        final keyShort = media.id.length > 12 ? media.id.substring(media.id.length - 8) : media.id;
        AvaLog.I.log('media', 'recv dm media kind=${media.kind.name} ${media.size}B key=…$keyShort mine=${m.mine}');
        if (!m.mine) _recordReceivedMedia(media);
      } else if (env is Map && env['t'] == 'text') {
        text = env['body'].toString();
      } else if (env is Map && env['t'] == 'deleted') {
        text = 'This message was deleted'; // server tombstone on re-sync
      }
      if (env is Map) {
        if (env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
        forwarded = env['forwarded'] == true;
        exp = (env['exp'] as num?)?.toInt();
        // G3 inline safety verdict on the envelope → red bubble on arrival.
        if (!m.mine && env['safety'] is Map) {
          final cat = ((env['safety'] as Map)['category'] ?? '').toString();
          if (cat.isNotEmpty) inlineSafetyCat = cat;
        }
        // STREAM C: sender-embedded link preview → render from the envelope.
        if (env['preview'] is Map) {
          extra = {...?extra, 'preview': (env['preview'] as Map).cast<String, dynamic>()};
        }
      }
    } catch (_) {/* legacy/plain text */}
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return;
    // Safety net: a control envelope (del/gdel/receipt/…) must NEVER render as a raw
    // `{"t":...}` bubble. Explicit handlers above already returned for handled ones;
    // this stops any unhandled/older-format control from leaking into the chat.
    if (_isControlEnvelope(m.payload)) {
      Analytics.capture('chat_control_filtered', {'where': 'dm_live'});
      return;
    }
    // [CHAT-RAWENV-1] Backstop: if we got all the way here with `text` still
    // byte-identical to the wire payload AND that payload is one of our
    // envelopes, then no branch above understood it and we are one line away
    // from drawing raw JSON at the user. Drop the frame — a missing bubble is a
    // bug we can chase; a bubble full of ciphertext keys is one the user has to
    // look at, and (via _persistNow) keeps looking at forever.
    //
    // This path was previously SILENT — the outer `catch (_)` swallowed every
    // cause with no log and no event, which is why pic 4 had to be reported by
    // hand from a screenshot instead of showing up in telemetry. Tag both ends
    // so either party's email retrieves it.
    if (text == m.payload && _isAppEnvelope(m.payload)) {
      String? envT;
      try { envT = (jsonDecode(m.payload) as Map)['t']?.toString(); } catch (_) {}
      Analytics.capture('chat_raw_envelope_dropped', {
        'where': seed ? 'dm_seed' : 'dm_live',
        'envelope_t': envT ?? 'unparsed',
        'mine': m.mine,
        'peer': widget.chat.name,
        'bytes': m.payload.length,
      });
      AvaLog.I.log('media', 'dropped unrenderable envelope t=$envT mine=${m.mine}');
      return;
    }
    // A peer deleted this for everyone (recorded durably) — render the tombstone,
    // never the original body, even though the cached/replayed envelope still has it.
    if (_deletedIds.contains(m.rumorId)) {
      text = 'This message was deleted'; media = null; special = null; extra = null; replyMeta = null;
    }
    _mutMsgs(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: forwarded, expireAt: exp, special: special, extra: extra,
          sent: m.mine, // my own messages reaching here are already on the relay
          starred: _starred.contains(m.rumorId), hidden: _hiddenIds[m.rumorId] == true));
      _noteGuardianFlag(special, extra);
      // G3: an inline fast-lane safety verdict paints THIS bubble red immediately,
      // exactly like a live safety_flag frame (keyed by the message's rumor id).
      if (inlineSafetyCat != null && !_safetyFlaggedIds.containsKey(m.rumorId)) {
        _safetyFlaggedIds[m.rumorId] = inlineSafetyCat!;
      }
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    // Persist the inline flag so the red bubble survives reopen (mirrors how the
    // deep-lane safety_flag frame is persisted). Best-effort.
    if (inlineSafetyCat != null) {
      unawaited(_safetyStore.put(m.rumorId,
          conv: _serverConvId ?? _convKey ?? '', category: inlineSafetyCat!));
    }
    // Full-thread RAG: index a peer's LIVE text into my own store (not seeded
    // history, not media/special envelopes).
    if (!m.mine && !seed && special == null && media == null) {
      _ragAddLine(widget.chat.name, text);
    }
    _jump();
    if (!m.mine && !seed) {
      // Live (just-arrived) message I'm looking at → tell the sender it's read,
      // both the live (presence) way and the durable (gift-wrapped) way.
      _presence?.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
      _dm?.sendReceipt('read', m.createdAt);
    }
    _markRead();
    _schedulePersist();
  }

  /// Apply a peer's delivery/read receipt for MY messages: advance the in-memory
  /// high-water marks (drives the ticks live) and persist them so the status is
  /// still correct after the thread/app is reopened. A 'read' implies delivered.
  void _applyReceipt(bool mine, Map env) {
    if (mine) return; // my own copy (shouldn't occur — receipts use wrapTo)
    final rts = (env['ts'] as num?)?.toInt() ?? 0;
    if (rts <= 0 || !mounted) return;
    final read = (env['status'] ?? '').toString() == 'read';
    setState(() {
      if (read && rts > _peerReadTs) _peerReadTs = rts;
      if (rts > _peerDeliveredTs) _peerDeliveredTs = rts;
    });
    if (_convKey != null) {
      ReceiptStore().bump(_convKey!, delivered: read ? 0 : rts, read: read ? rts : 0);
    }
  }

  void _applyEdit(String target, String body) {
    final i = _msgs.indexWhere((x) => x.evId == target);
    if (i >= 0 && mounted) { _mutMsgs(() { _msgs[i].text = body; _msgs[i].edited = true; }); _schedulePersist(); }
  }

  /// [AVAGRP-BUBBLE-2] Apply an incoming per-message group receipt
  /// (`{"t":"msg_receipt","mid":...,"uid":...,"status":"read"|"delivered","ts":...}`,
  /// `sync_hub.dart` `_ingestMsgReceipt`) onto the matching `_Msg`, keyed by its
  /// canonical mid (`_Msg.evId` — the same id `_onGroupMsg` already stamps from
  /// `GroupMessage.rumorId`, and the same one reactions key off). A message not
  /// currently rendered (scrolled out, not yet replayed) is a no-op — the next
  /// `GET /api/msg/seen` hydrate on open will backfill it once it IS rendered.
  /// A 'read' receipt also counts as 'delivered' (you can't read what didn't
  /// arrive) so `_statusFor`'s delivered-vs-read gates never desync.
  void _applyMsgReceipt(Map<String, dynamic> env) {
    final mid = (env['mid'] ?? '').toString();
    final uid = (env['uid'] ?? '').toString();
    final status = (env['status'] ?? '').toString();
    final ts = (env['ts'] as num?)?.toInt() ?? 0;
    if (mid.isEmpty || uid.isEmpty || (status != 'read' && status != 'delivered')) return;
    final i = _msgs.indexWhere((x) => x.evId == mid);
    if (i < 0 || !mounted) return;
    _mutMsgs(() {
      if (status == 'read') {
        _msgs[i].readBy[uid] = ts;
        _msgs[i].deliveredTo.putIfAbsent(uid, () => ts);
      } else {
        _msgs[i].deliveredTo[uid] = ts;
      }
    });
    _schedulePersist();
    // Two-sided telemetry (CLAUDE.md): fires on the ORIGINAL SENDER's device —
    // auto-stamped with the sender's own email; `reader_pub` identifies the
    // OTHER party so this event joins with that reader's own
    // `chat_group_receipt_sent` event via `mid`.
    Analytics.capture('chat_group_receipt_received', {
      'status': status, 'mid': mid, 'reader_pub': _shortPub(uid), 'gid': widget.chat.gid ?? '',
    });
  }
}
