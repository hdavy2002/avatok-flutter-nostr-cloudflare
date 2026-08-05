part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// [CHAT-THREAD-SPLIT-2] Presence, typing, last-seen and reaction-burst FX.
extension _ChatThreadPresence on _ChatThreadScreenState {


  void _onPresence(Map<String, dynamic> e) {
    if (!mounted) return;
    // Ignore frames the room echoes back to us — otherwise our OWN online/typing
    // frames would mark the PEER online/typing (a cause of the false "online" in
    // pic2). Compare against the exact label we announce as (_presenceMe), not
    // _myName (which later becomes the display name).
    if (_presenceMe != null && e['who']?.toString() == _presenceMe) return;
    // Peer explicitly left/backgrounded → flip to "last seen" immediately rather
    // than waiting out the 35s online window.
    if (e['type'] == 'offline') {
      // [LASTSEEN-HONEST-1] Only a REAL leave carries a ts (peer was online this
      // session). An absence frame without ts must NOT fabricate "now" — that
      // painted every offline contact (phone off all night) as "last seen just
      // now" and PERSISTED the lie via LastSeenStore. Without a ts, keep the
      // last honest value we already had.
      final ts = (e['ts'] as num?)?.toInt();
      _onlineClear?.cancel();
      if (ts != null && _convKey != null) LastSeenStore().set(_convKey!, '$ts');
      setState(() {
        _peerOnline = false;
        _peerTyping = false;
        if (ts != null) _peerLastSeen = ts;
      });
      return;
    }
    // Only an explicit peer 'online' frame marks them online — NOT read/delivered/
    // typing/liveloc frames. Inferring online from those (or from a mis-attributed
    // echo) is what made every contact look "online" (owner report 2026-06-27).
    if (e['type'] == 'online') _markPeerOnline();
    if (e['type'] == 'typing') {
      setState(() { _peerTyping = e['on'] == true; _typingWho = e['who']?.toString(); });
      _typingClear?.cancel();
      if (_peerTyping) {
        _typingClear = Timer(const Duration(seconds: 5), () {
          if (mounted) setState(() => _peerTyping = false);
        });
      }
    } else if (e['type'] == 'read') {
      final ts = (e['ts'] as num?)?.toInt() ?? 0;
      if (ts > _peerReadTs) setState(() { _peerReadTs = ts; _peerDeliveredTs = ts > _peerDeliveredTs ? ts : _peerDeliveredTs; });
    } else if (e['type'] == 'delivered') {
      final ts = (e['ts'] as num?)?.toInt() ?? 0;
      if (ts > _peerDeliveredTs) setState(() => _peerDeliveredTs = ts);
    } else if (e['type'] == 'liveloc') {
      _onLiveLocTick(e);
    } else if (e['type'] == 'livestop') {
      final id = e['id']?.toString();
      if (id != null) _live[id]?.end();
    }
  }


  /// A live-location pin update arrived from the peer. Move the existing session
  /// in place (the bubble + any open map auto-repaint via their listeners) and
  /// throttle the "viewed" telemetry to once / 30 s / share.
  void _onLiveLocTick(Map<String, dynamic> e) {
    final id = e['id']?.toString();
    final lat = (e['lat'] as num?)?.toDouble();
    final lng = (e['lng'] as num?)?.toDouble();
    if (id == null || lat == null || lng == null) return;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final ts = (e['ts'] as num?)?.toInt() ?? now;
    final until = (e['until'] as num?)?.toInt();
    final s = _live.putIfAbsent(
      id,
      () => LiveLocationSession(
        id: id,
        lat: lat,
        lng: lng,
        until: until ?? (now + 3600),
        mine: false,
        name: e['who']?.toString() ?? widget.chat.name,
      ),
    );
    s.apply(lat, lng, ts,
        heading: (e['hdg'] as num?)?.toDouble(),
        speed: (e['spd'] as num?)?.toDouble(),
        until: until);
    final last = _liveViewTelemetryTs[id] ?? 0;
    if (now - last >= 30) {
      _liveViewTelemetryTs[id] = now;
      Analytics.capture('live_location_viewed', {
        'share_id': id,
        'is_sender': false,
        'conv_kind': _isGroup ? 'group' : 'dm',
      });
    }
  }


  void _markPeerOnline() {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    _peerLastSeen = now;
    // Persist last-seen (throttled) so reopening the thread can show it before
    // any live frame arrives.
    if (_convKey != null && now - _lastSeenPersistTs >= 15) {
      _lastSeenPersistTs = now;
      LastSeenStore().set(_convKey!, '$now');
    }
    if (!_peerOnline) setState(() => _peerOnline = true);
    _onlineClear?.cancel();
    _onlineClear = Timer(const Duration(seconds: 35), () { if (mounted) setState(() => _peerOnline = false); });
  }


  /// Keep "online" truthful: re-announce every 20s while the thread is open so a
  /// peer who's actually here never lapses out of the 35s window, and a peer who
  /// left stops showing "online" within ~35s. Rides the existing Cloudflare room
  /// WS — no per-user DO wake, and nothing is sent once the thread is closed.
  void _startPresenceHeartbeat() {
    _onlineHeartbeat?.cancel();
    _onlineHeartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
      if (mounted && _sharePresence) _presence?.sendOnline();
    });
  }


  Future<void> _loadLastSeen() async {
    final key = _convKey;
    if (key == null) return;
    final v = (await LastSeenStore().load())[key];
    final ts = int.tryParse(v ?? '') ?? 0;
    if (ts > 0 && mounted && _peerLastSeen == 0) setState(() => _peerLastSeen = ts);
    // [LASTSEEN-SERVER-1] WhatsApp-style truth: the peer's InboxDO knows exactly
    // when their device was last connected — no thread has to be open, no
    // presence frame has to arrive. Server value wins over the local cache.
    if (!key.startsWith('1:')) return; // 1:1 only
    final uid = key.substring(2);
    try {
      final r = await ApiAuth.getSigned(
          'https://$kSignalingHost/api/user/last-seen?uid=${Uri.encodeComponent(uid)}');
      if (r.statusCode != 200 || !mounted) return;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final ms = (j['last_active_at'] as num?)?.toInt() ?? 0;
      final online = j['online'] == true;
      final srvTs = ms > 0 ? ms ~/ 1000 : 0;
      if (online) {
        _markPeerOnline();
      } else if (srvTs > 0) {
        LastSeenStore().set(key, '$srvTs');
        setState(() => _peerLastSeen = srvTs);
      }
    } catch (_) {/* offline / older worker — local cache already shown */}
  }


  void _onTyping() {
    if (_presence == null) return;
    _presence!.sendTyping(true);
    _myTypingOff?.cancel();
    _myTypingOff = Timer(const Duration(seconds: 2), () => _presence?.sendTyping(false));
  }



  void _spawnBurst(String emoji) {
    if (!mounted) return;
    final fx = _BurstFx(id: _burstSeq++, emoji: emoji);
    setState(() => _burstFx.add(fx));
    // Self-remove after the rise animation completes.
    Timer(const Duration(milliseconds: 2200), () {
      if (mounted) setState(() => _burstFx.removeWhere((b) => b.id == fx.id));
    });
  }


  /// [AVA-MEDIA-AUTHZ-1] Mirror a received attachment into the recipient's
  /// AvaLibrary — the single call site both `_onGroupMsg` and `_onDm` route
  /// through, since `MediaService.recordReceived` now REQUIRES a server
  /// conversation id (`conv`) the worker uses to verify both the media owner
  /// and the caller belong to it. `_serverConvId` resolves for DM AND group
  /// threads (see its own doc). If it isn't resolvable yet (e.g. `_meId` not
  /// loaded), skip rather than invent an empty string — the server would just
  /// 400 `conv_required` — and report it once so a persistent gap (not just a
  /// one-off race) is visible.
  void _recordReceivedMedia(ChatMedia media) {
    final conv = _serverConvId;
    if (conv == null || conv.isEmpty) {
      AvaLog.I.log('media', 'recordReceived skipped: no server conv id yet');
      Analytics.capture('chat_media_record_skipped', {'reason': 'no_conv'});
      return;
    }
    MediaService.recordReceived(media, conv: conv); // mirror into the recipient's AvaLibrary
  }


  // Send an ephemeral floating-emoji burst to everyone in the room + animate locally.
  void _sendBurst(String emoji) {
    HapticFeedback.lightImpact();
    _party?.send({'t': 'burst', 'emoji': emoji}); // PartyKit floating-emoji burst
    _spawnBurst(emoji); // optimistic local animation (peers see it via the burst stream)
  }


  void _pickBurstEmoji() {
    showModalBottomSheet(
      context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 12),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
            for (final e in ['🎉', '❤️', '👏', '😂', '🔥', '😮'])
              GestureDetector(
                onTap: () { Navigator.pop(ctx); _sendBurst(e); },
                child: Text(e, style: const TextStyle(fontSize: 32)),
              ),
          ]),
        ),
      ),
    );
  }
}
