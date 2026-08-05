part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// [CHAT-THREAD-SPLIT-2] Local message cache, debounced persist and archive paging.
extension _ChatThreadPersistence on _ChatThreadScreenState {


  // ---- local message persistence ----
  // The relay doesn't re-deliver your OWN sent DMs on resubscribe, so cache the
  // thread locally and reload it on open. (Media messages aren't cached.)
  Future<void> _loadCachedMessages() async {
    final key = _convKey;
    if (key == null) return;
    // F3 (restoreV2): restore any previously-paged deep-archive rows for THIS
    // conversation + the pager cursor, so older history reappears instantly on
    // reopen without a second /api/archive/page round-trip. Independent of the
    // hot cache below (which may be empty on a fresh device).
    unawaited(_restoreArchiveCache());
    // [MSG-OUTBOX-1] Load the durable outbox first so isPending() below is accurate
    // when we restore not-yet-ACKed bubbles (sending… vs not-sent affordance).
    await Outbox.I.ensureLoaded();
    final cached = await _msgStore.load(key);
    if (cached.isEmpty || !mounted) return;
    final loaded = <_Msg>[];
    for (final j in cached) {
      final ev = j['evId'] as String?;
      if (ev != null) {
        if (_seenEv.contains(ev)) continue;
        _seenEv.add(ev);
      }
      // Drop any control envelope an older build wrongly cached as a text bubble
      // (e.g. a leaked `{"t":"del",...}`), so it never reappears on reopen.
      if (_isControlEnvelope((j['text'] ?? '').toString())) {
        Analytics.capture('chat_control_filtered', {'where': 'cache'});
        continue;
      }
      // [CHAT-RAWENV-1] Purge a bubble a previous build cached as raw envelope
      // JSON (pic 4). This is the half of the fix that actually reaches the
      // people already affected: `_persistNow` wrote the raw payload into
      // `text` with no `media` key, and this loader restores `text` verbatim
      // and NEVER re-parses it — so without this the JSON bubble would survive
      // the fix and sit in their thread forever. Same precedent, and the same
      // reasoning, as the control-envelope purge directly above.
      if (j['media'] == null && _isAppEnvelope((j['text'] ?? '').toString())) {
        Analytics.capture('chat_raw_envelope_dropped', {'where': 'cache'});
        continue;
      }
      final ts = (j['ts'] as num?)?.toInt() ?? 0;
      // Media messages ARE cached now (the envelope/refs — never the bytes; the
      // decrypted bytes live in MediaService's on-disk cache). So on reopen the
      // image/voice bubble reappears instantly and loads local-first, instead of
      // waiting on a full relay re-sync + re-download.
      ChatMedia? media;
      final mj = j['media'];
      if (mj is Map) { try { media = ChatMedia.fromEnvelope(mj.cast<String, dynamic>()); } catch (_) {} }
      final msg = _Msg(
        _seq++, j['me'] == true, (j['text'] ?? '').toString(),
        _fmtTime(ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : ts),
        ts: ts, evId: ev, media: media,
        sent: j['me'] == true, // my persisted history was already accepted by the relay
        special: j['special'] as String?,
        extra: (j['extra'] as Map?)?.cast<String, dynamic>(),
        replyTo: (j['replyTo'] as Map?)?.cast<String, dynamic>(),
        edited: j['edited'] == true,
        forwarded: j['forwarded'] == true,
        expireAt: (j['expireAt'] as num?)?.toInt(),
        senderLabel: j['senderLabel'] as String?,
        senderPub: j['senderPub'] as String?, // [AVAGRP-BUBBLE-1]
        reaction: j['reaction'] as String?,
        starred: j['starred'] == true,
        hidden: j['hidden'] == true || _hiddenIds[ev] == true,
        system: j['system'] == true, // [AVAGRP-BUBBLE-2]
        // [AVAGRP-BUBBLE-2 §6] Restore per-member receipts so the Info sheet /
        // group ticks survive an app restart instead of resetting to "no
        // receipts yet" every cold open. `(j['readBy'] as Map?)` is JSON-decoded
        // as `Map<String, dynamic>` — cast each value back to int explicitly
        // rather than a blind `.cast<String, int>()`, which throws on a `num`
        // that decoded as double.
        readBy: (j['readBy'] as Map?)?.map((k, v) => MapEntry(k.toString(), (v as num).toInt())),
        deliveredTo: (j['deliveredTo'] as Map?)?.map((k, v) => MapEntry(k.toString(), (v as num).toInt())),
      );
      // [MSG-OUTBOX-1] Restore a NOT-yet-ACKed send with the right affordance so it
      // never silently vanishes (the original bug). If its clientId (=evId) is STILL
      // queued in the durable outbox, it's genuinely in flight → show "sending…"
      // and let the outbox status flip it to sent/failed. If it's no longer queued
      // (gave up, or a media upload that can't auto-resume), show the failed
      // "not sent · tap to retry" affordance so the user can re-send manually.
      if (j['pending'] == true && msg.me) {
        final stillQueued = ev != null && Outbox.I.isPending(ev);
        final mediaPending = j['mediaPending'] == true;
        final gaveUp = j['gaveUp'] == true;
        if (stillQueued && !mediaPending) {
          msg.sent = false; msg.failed = false; // "sending…" — outbox is retrying
        } else if (_isGroup && !mediaPending && !gaveUp) {
          // [AVA-GRP-SENDSTATE] Self-heal the owner's bug. Old builds had NO
          // outbox-ACK listener for groups, so EVERY own group message was
          // persisted `pending` even after the outbox delivered it (the entry
          // cleared on echo, so `isPending` is false now). Those builds also never
          // recorded a genuine give-up (`gaveUp`), so a non-queued, non-media,
          // non-give-up group pending bubble is a DELIVERED message mis-persisted
          // as pending — restore it as "sent", never the false "not sent · tap to
          // retry" the owner saw on messages his group had already replied to. A
          // real terminal failure carries `gaveUp:true` (written since this fix)
          // and falls through to the failed branch below.
          msg.sent = true; msg.failed = false;
          _grpSendStateHealed++;
        } else {
          msg.sent = false; msg.failed = true;   // "not sent · tap to retry"
        }
      }
      // A peer hard-deleted this for everyone (durable tombstone) — collapse the
      // stale cached body/media to the deleted pill before showing it.
      if (ev != null && _deletedIds.contains(ev)) _tombstone(msg);
      loaded.add(msg);
    }
    if (loaded.isEmpty || !mounted) return;
    _mutMsgs(() {
      _msgs.addAll(loaded);
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    _jump();
    // If any cached poll bubbles were restored, pull their server tallies so a
    // reinstalled device shows real counts + my selection (survives reinstall).
    if (loaded.any((m) => m.special == 'poll')) unawaited(_hydratePolls());
    // [AVA-GRP-SENDSTATE] Report + re-persist the one-time heal so the corrected
    // "sent" state sticks (this reopen won't re-heal them) and the fleet-wide
    // blast radius of the old false-failure bug is measurable. Email auto-attached
    // by Analytics._base.
    if (_grpSendStateHealed > 0) {
      Analytics.capture('grp_sendstate_healed', {
        'count': _grpSendStateHealed,
        'gid': widget.chat.gid ?? '',
        'conv_kind': 'group',
      });
      _schedulePersist();
    }
  }


  void _schedulePersist() {
    _persistTimer?.cancel();
    _persistTimer = Timer(const Duration(milliseconds: 400), _persistNow);
  }


  Future<void> _persistNow() async {
    final key = _convKey;
    if (key == null) return;
    final out = <Map<String, dynamic>>[];
    for (final m in _msgs) {
      if (m.text.contains('"t":"receipt"')) continue; // never cache a stray receipt
      // [MSG-OUTBOX-1] PERSIST failed / still-sending messages instead of dropping
      // them. The old `if (m.uploading || m.failed) continue;` is exactly why a DM
      // that failed to POST silently vanished from the sender's own thread on
      // reopen (the warm cache excluded it). We now cache them WITH their state:
      //   • text that isn't ACKed yet (failed, or my bubble not `sent`) → the
      //     durable outbox is still retrying it, so restore it as pending and let
      //     the outbox status update the bubble; a tap re-enqueues.
      //   • uploading/failed MEDIA → restore as a failed placeholder so it doesn't
      //     disappear. NOTE: the raw bytes live only in memory (never cached), so a
      //     media upload interrupted by a restart cannot auto-resume — the user
      //     re-sends via the failed-bubble tap. Text sends DO auto-resume via the
      //     outbox. (Media-upload resume is out of scope here — see report.)
      final notAcked = m.me && !m.hidden && (m.failed || m.uploading || (!m.sent && m.evId != null));
      out.add({
        'me': m.me, 'text': m.text, 'ts': m.ts,
        if (m.evId != null) 'evId': m.evId,
        if (m.media != null) 'media': m.media!.toEnvelope(), // refs only — bytes are in MediaService's disk cache
        if (m.special != null) 'special': m.special,
        if (m.extra != null) 'extra': m.extra,
        if (m.replyTo != null) 'replyTo': m.replyTo,
        if (m.edited) 'edited': true,
        if (m.forwarded) 'forwarded': true,
        if (m.expireAt != null) 'expireAt': m.expireAt,
        if (m.senderLabel != null) 'senderLabel': m.senderLabel,
        if (m.senderPub != null) 'senderPub': m.senderPub, // [AVAGRP-BUBBLE-1]
        if (m.reaction != null) 'reaction': m.reaction,
        if (m.starred) 'starred': true,
        if (m.hidden) 'hidden': true, // soft-delete survives reopen; data retained for Undo
        if (m.system) 'system': true, // [AVAGRP-BUBBLE-2]
        // [AVAGRP-BUBBLE-2 §6] Per-member receipts — see the `fromJson` restore
        // side for why these survive an app restart now instead of resetting.
        if (m.readBy.isNotEmpty) 'readBy': m.readBy,
        if (m.deliveredTo.isNotEmpty) 'deliveredTo': m.deliveredTo,
        // Restore hint: this bubble was NOT yet confirmed on the server. `mediaPending`
        // distinguishes a stuck media upload (no auto-resume) from a text send the
        // outbox will keep retrying.
        if (notAcked) 'pending': true,
        if (notAcked && (m.uploading || m.media != null)) 'mediaPending': true,
        // [AVA-GRP-SENDSTATE] Record a TERMINAL give-up so it restores as a real
        // "not sent" — the only case a group pending bubble should reopen failed.
        if (m.sendGaveUp) 'gaveUp': true,
      });
    }
    await _msgStore.save(key, out);
    // Keep the chat-list preview + ordering in sync with the latest line here,
    // for both messages I sent and ones I received while this thread was open.
    if (_msgs.isNotEmpty) {
      final last = _msgs.reduce((a, b) => b.ts >= a.ts ? b : a);
      final preview = last.hidden
          ? 'You deleted this message' // never leak hidden content into the list
          : (last.text.isNotEmpty
              ? last.text
              : (last.media != null ? _caption(last.media!.kind, last.media!.name) : ''));
      final ts = last.ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : last.ts;
      // [CHAT-RAWENV-1] Never let an envelope become the chat-list preview line —
      // the raw-JSON bubble in pic 4 poisoned the list row too, so the user met
      // it twice.
      if (preview.isNotEmpty && !_isAppEnvelope(preview)) {
        await ChatPreviewStore().record(key, preview, ts, last.me);
      }
    }
  }


  // ── F3: deep-archive scroll pager (restoreV2) ───────────────────────────────
  // When the user scrolls PAST the local hot window, page older messages in from
  // /api/archive/page (batched per-user R2 jsonl), render them above with a subtle
  // "older messages" divider, and CACHE each fetched page per-conversation so a
  // page is fetched at most once — ever, across restarts. All dark unless
  // RemoteConfig.restoreV2 is on (no behaviour change when false).

  /// Feed one archive server row ({id,conv,sender,kind,body,media_ref,client_id,
  /// created_at}) into the thread as seeded history. Dedup + envelope parsing are
  /// handled by the normal _onDm/_onGroupMsg path (via _seenEv), so a row already
  /// in the hot window never double-renders.
  void _ingestArchiveRow(Map<String, dynamic> r) {
    final myUid = _meId?.uid ?? _myNpub ?? '';
    final id = (r['id'] as num?)?.toInt() ?? 0;
    final clientId = (r['client_id'] ?? '').toString();
    final rumorId = clientId.isNotEmpty ? clientId : 'srv_$id';
    final sender = (r['sender'] ?? '').toString();
    final mine = myUid.isNotEmpty && sender == myUid;
    final body = (r['body'] ?? '').toString();
    final createdMs = (r['created_at'] as num?)?.toInt() ??
        DateTime.now().millisecondsSinceEpoch;
    final createdSec = createdMs > 2000000000 ? createdMs ~/ 1000 : createdMs; // ms→s
    if (_isGroup) {
      _onGroupMsg(GroupMessage(
          rumorId: rumorId, senderPub: mine ? '' : sender, mine: mine,
          payload: body, createdAt: createdSec));
    } else {
      _onDm(DmMessage(rumorId: rumorId, mine: mine, payload: body, createdAt: createdSec),
          seed: true);
    }
  }


  /// Restore previously-paged archive rows + the pager cursor from the per-account
  /// cache. Silent + safe when restoreV2 is off (we still restore what was already
  /// cached so history the user already saw doesn't vanish, but never fetch).
  Future<void> _restoreArchiveCache() async {
    final key = _convKey;
    if (key == null) return;
    final cur = await _archiveStore.load(key);
    if (!mounted) return;
    final rows = (cur['rows'] as List).cast<Map<String, dynamic>>();
    if (rows.isNotEmpty) {
      for (final r in rows) _ingestArchiveRow(r);
      setState(() => _hasArchived = true);
    }
    _archiveCursor = cur['cursor'] as int?;
    _archiveDone = cur['done'] == true;
  }


  /// Scroll listener: when the viewport nears the TOP of the loaded thread (older
  /// end), pull the next archive page. Guarded by restoreV2 + one-in-flight.
  void _maybePageArchive() {
    // [CHAT-UI-LIST-1e] Cheap piggyback on this existing scroll listener: if
    // the reader has manually scrolled back within ~120px of the newest
    // message, the unseen badge no longer reflects reality — clear it here
    // too (not just on a force:true jump / FAB tap) so scrolling down by
    // hand also dismisses the badge, WhatsApp-style.
    // [CHAT-UI-REVERSE-1] "near the newest message" is now "near offset 0"
    // (see `_jump`).
    if (_unseenCount != 0 && _scroll.hasClients) {
      final pos = _scroll.position;
      if (pos.pixels <= 120 && mounted) {
        setState(() => _unseenCount = 0);
      }
    }
    if (!RemoteConfig.restoreV2 || _archiveDone || _archiveLoading) return;
    if (!_scroll.hasClients) return;
    // [CHAT-UI-REVERSE-1] The oldest loaded message used to sit at the TOP of
    // a non-reversed list (near scroll offset 0 / `extentBefore`). With
    // reverse:true it sits at the FAR end of the scroll range instead — near
    // `maxScrollExtent`, i.e. `extentAfter` near 0 — so the "load older when
    // close to the oldest loaded edge" trigger now watches `extentAfter`.
    if (_scroll.position.extentAfter <= 240) {
      unawaited(_fetchArchivePage());
    }
  }


  Future<void> _fetchArchivePage() async {
    if (!RemoteConfig.restoreV2 || _archiveDone || _archiveLoading) return;
    final key = _convKey;
    final myUid = _meId?.uid ?? _myNpub ?? '';
    if (key == null || myUid.isEmpty) return;
    final serverConv = serverConvFromKey(key, myUid);
    if (serverConv == null) return;
    setState(() => _archiveLoading = true);
    // [CHAT-UI-REVERSE-1] The old beforeMax/beforePix + post-frame jumpTo
    // dance ("preserve the scroll position across the prepend so the view
    // doesn't jump") is DELETED. It existed because a non-reversed ListView
    // PREPENDS older messages at index 0 (the TOP), which physically shifts
    // every already-rendered row down and yanks the viewport unless the
    // offset is manually corrected. With reverse:true, older archive rows are
    // appended to `_msgs` and land at the FAR end of the index range (see the
    // `vi`/`msgSlot` mapping in the itemBuilder) — i.e. the far/oldest visual
    // edge, away from the current viewport. Extending a sliver list at the
    // far end never moves the pixels already on screen, so there is nothing
    // to restore.
    try {
      final before = _archiveCursor; // null ⇒ start from newest segment
      final uri = '$kArchivePageUrl?conv=$serverConv&limit=30'
          '${before != null ? '&before=$before' : ''}';
      final res = await ApiAuth.getSigned(uri);
      if (!mounted) { _archiveLoading = false; return; }
      if (res.statusCode != 200) {
        Analytics.capture('archive_page_failed', {'status': res.statusCode});
        setState(() => _archiveLoading = false);
        return;
      }
      final body = jsonDecode(res.body);
      final rows = (body is Map ? (body['messages'] as List? ?? const []) : const [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      final nextBefore = (body is Map ? body['next_before'] : null) as num?;
      // Cache the page (dedup at most-once is via the cursor: a fetched `before`
      // is never re-requested — nextBefore always strictly decreases).
      await _archiveStore.appendPage(
        key,
        newRows: rows,
        nextBefore: nextBefore?.toInt(),
        done: nextBefore == null,
      );
      if (!mounted) { _archiveLoading = false; return; }
      for (final r in rows) _ingestArchiveRow(r);
      setState(() {
        _archiveCursor = nextBefore?.toInt();
        _archiveDone = nextBefore == null;
        if (rows.isNotEmpty) _hasArchived = true;
        _archiveLoading = false;
      });
      Analytics.capture('archive_page_loaded', {'rows': rows.length, 'done': _archiveDone});
    } catch (e) {
      if (mounted) setState(() => _archiveLoading = false);
      Analytics.capture('archive_page_error', {'error': e.toString()});
    }
  }
}
