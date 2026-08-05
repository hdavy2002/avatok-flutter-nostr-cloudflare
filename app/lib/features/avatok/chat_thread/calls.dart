part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadCalls on _ChatThreadScreenState {

  Future<void> _call(String kind) async {
    // This path is 1:1 P2P ONLY — group threads route through _groupCall()
    // (Cloudflare Realtime A/V) and must NEVER reach the CallRoom DO.
    if (widget.chat.group || widget.chat.gid != null) return;
    // Debounce double-taps / re-entrancy: a single video-button tap was firing
    // TWO POST /api/call + two CallScreens ~1s apart, and the colliding second
    // call busied out the first right after it connected — so the connected
    // call tore down and video never rendered ("audio worked, no video came
    // through"). One dial in flight, and none while already on a call.
    if (!_dialing && gLiveCallScreens > 0) {
      // [CALL-MENU-TEARDOWN-1] A terminal outcome menu is intentionally kept
      // alive for Talk to Ava. Reap it before evaluating the one-call guard so
      // Call again from a chat can never inherit a dead session's lock.
      await CallSessionManager.instance.reapOutcomeSessions();
    }
    if (_dialing || gLiveCallScreens > 0) {
      // [AVATOK-DIAL-GUARD-1] gLiveCallScreens has no staleness bound like its
      // siblings gInCallSince/gOutgoingSince, so a leaked CallSession teardown
      // sticks it >0 forever and every future dial silently no-ops (13
      // suppressed call-back taps in the 2026-07-15 incident). Give it a
      // chance to self-heal before trusting it — never touches `_dialing`,
      // only `gLiveCallScreens` (see selfHealStaleLiveCallScreens in
      // call_screen.dart; interim fix, Specs/FIXPLAN-2026-07-15-avadial-incoming-call-ui.md FIX 5).
      if (!_dialing && gLiveCallScreens > 0 && selfHealStaleLiveCallScreens()) {
        // Healed: the counter was stale and no session is genuinely live.
        // Fall through and place the call normally instead of suppressing it.
      } else {
        final reason = _dialing ? 'already_dialing' : 'already_in_call';
        Analytics.capture('call_dial_suppressed', {
          'reason': reason,
          'kind': kind,
          'user_notified': reason == 'already_in_call',
        });
        // [AVATOK-DIAL-GUARD-1] Never silent: a suppressed dial used to be a
        // dead call button with zero feedback. Tell the user so they have an
        // escape hatch (force-close) if the guard is wrong.
        if (reason == 'already_in_call' && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Already on a call — force-close the app if this is wrong')));
        }
        return;
      }
    }
    // CALLFIX-14: glare detection — if an incoming call from the same peer is
    // currently ringing, accept it instead of dialing (resolves simultaneous dials).
    final to = widget.chat.seed; // the peer's uid
    if (gIncomingRingingFrom == to && gIncomingRingingCallId != null) {
      Analytics.capture('call_glare_autoaccept', {
        'call_id': gIncomingRingingCallId!,
        'kind': kind,
      });
      // Accept the incoming call (dismiss ring UI + open the call like a normal accept)
      await PushService.acceptRingingCall(gIncomingRingingCallId!);
      return;
    }
    _dialing = true;
    IceCache.prefetch(); // warm TURN creds in parallel with the FCM ring
    final video = kind == 'video';
    final room = 'avatok-${const Uuid().v4().substring(0, 8)}';
    // [TRACE-ID-1] Mint ONE correlation id at this dial boundary. It rides the
    // /api/call POST header (→ Worker → push payload → callee → RTC telemetry)
    // and is handed to the CallSession so every call event on BOTH devices
    // stitches under one trace_id in PostHog.
    final traceId = TraceContext.mint();
    // (`to` already declared above in the CALLFIX-14 glare block)
    AvaLog.I.log('call', 'placing ${video ? "video" : "audio"} call callId=$room to=${to.length > 12 ? to.substring(0, 12) : to}…');
    // [INSTANT-CALL-MOUNT-1] Optimistic mount: show the CallScreen the INSTANT
    // the user tapped, then run POST /api/call in the BACKGROUND. The old flow
    // AWAITED that POST (Worker + FCM fan-out — routinely seconds, up to the ~8s
    // timeout on a flaky link) BEFORE Navigator.push, so the call screen took
    // seconds to appear (PostHog: call_place_ok → call_started was only ~30ms, so
    // the wait was entirely the POST, not the render). The optimistic session
    // runs the HONEST guard flow (deferRing → connecting + searching tone, never
    // a fake ringback) and _placeCallInBackground feeds the reachability/glare/
    // failure outcome back into it via notePlaceResult / notePlaceFailed — so an
    // unreachable callee still never hears ringback into the void ([MULTIACCT-4]
    // guarantee preserved). Kill switch: RemoteConfig.instantCallMountEnabled.
    // Only for real uid contacts (the ones a POST actually rings).
    if (RemoteConfig.instantCallMountEnabled && to.startsWith('user_')) {
      if (!mounted) { _dialing = false; return; }
      Analytics.capture('call_mount_optimistic', {'call_id': room, 'kind': kind});
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => CallScreen(
            room: room, title: widget.chat.name, seed: to, video: video,
            avatarUrl: widget.chat.avatarUrl,
            traceId: traceId, // [TRACE-ID-1]
            deferRing: true,  // [INSTANT-CALL-MOUNT-1] honest guard flow until placed
            onRetry: () {
              Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': kind});
              // ignore: unawaited_futures
              _call(kind);
            },
          ),
        ),
      );
      // The screen is mounted; start() will bump gLiveCallScreens to guard re-entry.
      _dialing = false;
      // ignore: unawaited_futures
      _placeCallInBackground(room: room, to: to, video: video, traceId: traceId, kind: kind);
      return;
    }
    // The callee's default ringtone (AI Ringback) — comes back on the /api/call
    // response so the caller hears it locally while ringing.
    String ringbackUrl = '';
    // [MULTIACCT-4] When the server tells us the callee is UNREACHABLE (no
    // registered device / all tokens stale after a re-login), we must NOT open the
    // CallScreen — opening it plays fake ringback into a call that can never ring
    // (the exact "endless ringback, callee never rings" symptom). This flag short-
    // circuits the dial: show a clear message and stop, no ringback.
    bool unreachable = false;
    String? initialRouted;
    Map<String, dynamic>? initialRoutingStart;
    // Ring the callee's phone via FCM wake (real uid contacts only).
    if (to.startsWith('user_')) {
      try {
        // 'from' is derived server-side from the NIP-98 signature.
        final res = await ApiAuth.postJsonH(kCallUrl, {
          'to': to,
          'fromName': _myName ?? 'AvaTOK',
          'callId': room,
          'kind': video ? 'video' : 'audio',
        }, {'x-trace-id': traceId}); // [TRACE-ID-1] propagate to Worker + push
        AvaLog.I.log('call', 'POST /api/call -> HTTP ${res.statusCode}${res.statusCode != 200 ? " body=${res.body.length > 120 ? res.body.substring(0, 120) : res.body}" : ""}');
        final callKind = video ? 'video' : 'audio';
        // [MULTIACCT-4] Parse the distinct reachability signal the server now
        // returns (`reachable:false` on both the zero-token 404 and — via a later
        // ring-ack — the all-tokens-pruned case). A 404 is always unreachable.
        bool reachableFalse = false;
        try {
          final decoded = jsonDecode(res.body);
          reachableFalse = decoded['reachable'] == false;
          if (decoded['routed'] == 'receptionist') {
            initialRouted = 'receptionist';
            final start = decoded['start'];
            if (start is Map) initialRoutingStart = start.cast<String, dynamic>();
          }
        } catch (_) {}
        // [CALL-GLARE-2] Server-side mutual-dial resolution. The callee was ALREADY
        // dialing us within the glare window, so the server folded both dials into
        // the already-registered reciprocal call instead of ringing a second room. Join
        // that winning room deterministically instead of mounting a new outgoing
        // CallScreen — no busy dead-end. Both devices compute the same winner.
        String glareJoin = '';
        try {
          final jb = jsonDecode(res.body);
          if (jb is Map && jb['glare'] == true) {
            glareJoin = (jb['join_call_id'] ?? '').toString();
          }
        } catch (_) {}
        if (glareJoin.isNotEmpty) {
          try {
            final rt = (jsonDecode(res.body)['roomToken'] ?? '').toString();
            if (rt.isNotEmpty) rememberCallRoomToken(glareJoin, rt);
          } catch (_) {}
          Analytics.capture('call_glare_autoconnect', {
            'winner_call_id': glareJoin,
            'my_call_id': room,
            'kind': video ? 'video' : 'audio',
          });
          _dialing = false;
          if (!mounted) return;
          final outgoingWon = glareJoin == room;
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => CallScreen(
                room: glareJoin, title: widget.chat.name, seed: to, video: video,
                avatarUrl: widget.chat.avatarUrl,
                // The winner's placer keeps dialing (outgoing); the loser joins the
                // winning room as the answering side so exactly one room forms.
                outgoing: outgoingWon,
                traceId: traceId,
              ),
            ),
          );
          return;
        }
        if (res.statusCode == 200 && initialRouted == 'receptionist') {
          Analytics.capture('call_server_receptionist_routed', {
            'call_id': room, 'reason': 'unknown_caller', 'mount': 'awaited',
          });
        } else if (res.statusCode == 200 && !reachableFalse) {
          try { ringbackUrl = (jsonDecode(res.body)['ringbackUrl'] ?? '').toString(); } catch (_) {}
          Analytics.capture('call_place_ok', {'kind': callKind, 'has_ringback': ringbackUrl.isNotEmpty});
        } else if (res.statusCode == 404 || reachableFalse) {
          // The callee has NO reachable device (0 push tokens, or every token went
          // stale after a re-login). Capture it so call reachability is queryable
          // per-callee, and DON'T open the ringing CallScreen — tell the caller.
          unreachable = true;
          Analytics.capture('call_no_device', {
            'to': to.length > 40 ? to.substring(0, 40) : to,
            'kind': callKind,
            'reason': res.statusCode == 404 ? 'http_404' : 'reachable_false',
          });
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text('${widget.chat.name} is unreachable right now — ask them to open AvaTOK')));
          }
        } else {
          // Any other non-200 (auth, 5xx, rate-limit) — capture so a failed call
          // placement isn't silent.
          Analytics.capture('call_place_failed', {'status': res.statusCode, 'kind': callKind});
        }
      } catch (e) {
        // [CALL-DIAL-FAIL-1] The place-call POST itself threw (network error,
        // DNS failure, or the ~8s ApiAuth.postJson timeout on a flaky
        // connection) — PostHog calls avatok-536eaa7a/c85ed3b7/2810780b: the
        // callee's phone NEVER rang, yet the old code fell through to
        // Navigator.push(CallScreen(...)) below and let the caller sit through
        // a full fake ringback window before dying with timeout-ringing. Treat
        // this exactly like the server-side "unreachable" signal — abort the
        // dial before the CallScreen ever mounts so no ringback plays into the
        // void, and offer an immediate Retry.
        AvaLog.I.log('call', 'POST /api/call FAILED: $e');
        final err = e.toString();
        Analytics.capture('call_place_failed', {
          'call_id': room,
          'kind': video ? 'video' : 'audio',
          'error': err.length > 160 ? err.substring(0, 160) : err,
        });
        unreachable = true;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: const Text("Can't reach the network — check your connection"),
            action: SnackBarAction(
              label: 'Retry',
              onPressed: () {
                Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': video ? 'video' : 'audio'});
                // ignore: unawaited_futures
                _call(kind);
              },
            ),
          ));
        }
      }
    } else {
      AvaLog.I.log('call', 'NOT ringing — contact seed is not an uid ($to)');
    }
    if (!mounted) { _dialing = false; return; }
    // [MULTIACCT-4] Unreachable callee → abort the dial before mounting CallScreen
    // so no ringback plays. The snackbar above already told the user why.
    if (unreachable) { _dialing = false; return; }
    // From here the CallScreen mounts (gLiveCallScreens > 0 guards re-entry),
    // so the in-flight debounce flag can be released.
    _dialing = false;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CallScreen(
          room: room, title: widget.chat.name, seed: to, video: video,
          avatarUrl: widget.chat.avatarUrl, ringbackUrl: ringbackUrl,
          traceId: traceId, // [TRACE-ID-1]
          initialRouted: initialRouted,
          initialRoutingStart: initialRoutingStart,
          // [CALL-DIAL-FAIL-1] Retry affordance on the 'network-error' terminal
          // state: re-runs this exact dial flow (fresh room id, fresh POST)
          // instead of leaving the user stuck on a dead call screen.
          onRetry: () {
            Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': kind});
            // ignore: unawaited_futures
            _call(kind);
          },
        ),
      ),
    );
  }

  // [INSTANT-CALL-MOUNT-1] Runs POST /api/call AFTER the CallScreen is already on
  // screen (optimistic mount) and feeds the outcome to the live session. This is
  // the same POST the awaited path did — just off the critical path — so the ring
  // push still fires immediately; only the UI no longer waits on it. Outcomes:
  //   • reachable        → notePlaceResult(true)  → full ring window (honest)
  //   • unreachable/404  → notePlaceResult(false) → Ava, no fake ringback shown
  //   • server folded a mutual dial (glare) into a different room → supersede the
  //     optimistic room and open the deterministic winner
  //   • identity gate    → interceptor opened liveness → tear the screen down
  //   • hard network fail → notePlaceFailed() → 'network-error' + Retry
  Future<void> _placeCallInBackground({
    required String room,
    required String to,
    required bool video,
    required String traceId,
    required String kind,
  }) async {
    final callKind = video ? 'video' : 'audio';
    try {
      final res = await ApiAuth.postJsonH(kCallUrl, {
        'to': to,
        'fromName': _myName ?? 'AvaTOK',
        'callId': room,
        'kind': callKind,
      }, {'x-trace-id': traceId}); // [TRACE-ID-1] propagate to Worker + push
      AvaLog.I.log('call', 'POST /api/call (bg) -> HTTP ${res.statusCode}${res.statusCode != 200 ? " body=${res.body.length > 120 ? res.body.substring(0, 120) : res.body}" : ""}');

      // [CALL-GLARE-2] Server folded a simultaneous mutual dial into one winning
      // room. Both devices compute the same winner. If it isn't our optimistic
      // room, supersede: end this room's (peer-less) session and open the winner.
      String glareJoin = '';
      try {
        final jb = jsonDecode(res.body);
        if (jb is Map && jb['glare'] == true) glareJoin = (jb['join_call_id'] ?? '').toString();
      } catch (_) {}
      if (glareJoin.isNotEmpty && glareJoin != room) {
        try {
          final rt = (jsonDecode(res.body)['roomToken'] ?? '').toString();
          if (rt.isNotEmpty) rememberCallRoomToken(glareJoin, rt);
        } catch (_) {}
        Analytics.capture('call_glare_autoconnect', {
          'winner_call_id': glareJoin, 'my_call_id': room, 'kind': callKind, 'mount': 'optimistic',
        });
        CallSessionManager.instance.liveSessionFor(room)?.hangup('glare-superseded');
        if (!mounted) return;
        // Push the winner AFTER the superseded screen has popped (post-frame) so
        // the pop can never remove the winner route instead.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => CallScreen(
                room: glareJoin, title: widget.chat.name, seed: to, video: video,
                avatarUrl: widget.chat.avatarUrl,
                // We lost the glare (our room != winner) → join as the answering side.
                outgoing: false,
                traceId: traceId,
              ),
            ),
          );
        });
        return;
      }

      bool reachableFalse = false;
      String serverRoute = '';
      try {
        final body = jsonDecode(res.body);
        reachableFalse = body['reachable'] == false;
        serverRoute = (body['routed'] ?? '').toString();
      } catch (_) {}

      // [CALL-WS-AUTH-1 2026-08-03] Deposit the CALLER's CallRoom join credential
      // as early as possible: the optimistic mount has already opened (or is
      // about to open) the signalling socket, and it waits briefly for exactly
      // this value before connecting. Deliberately outside every status branch —
      // a token is worth keeping even on a response we otherwise treat as a
      // failure, because the session may still be live and reconnecting.
      try {
        final rt = (jsonDecode(res.body)['roomToken'] ?? '').toString();
        if (rt.isNotEmpty) rememberCallRoomToken(room, rt);
      } catch (_) {/* older server: no token, join stays un-credentialed */}
      final session = CallSessionManager.instance.liveSessionFor(room);
      if (res.statusCode == 200 && serverRoute == 'receptionist') {
        Analytics.capture('call_server_receptionist_routed', {
          'call_id': room, 'reason': 'unknown_caller', 'mount': 'optimistic',
        });
        session?.noteServerReceptionistRoute();
      } else if (res.statusCode == 200 && !reachableFalse) {
        bool hasRingback = false;
        try { hasRingback = (jsonDecode(res.body)['ringbackUrl'] ?? '').toString().isNotEmpty; } catch (_) {}
        Analytics.capture('call_place_ok', {'kind': callKind, 'has_ringback': hasRingback, 'mount': 'optimistic'});
        // Reachable — release the honest guard flow into the full ring window.
        session?.notePlaceResult(true);
      } else if (res.statusCode == 404 || reachableFalse) {
        Analytics.capture('call_no_device', {
          'to': to.length > 40 ? to.substring(0, 40) : to,
          'kind': callKind,
          'reason': res.statusCode == 404 ? 'http_404' : 'reachable_false',
          'mount': 'optimistic',
        });
        // No reachable device → honest unreachable → Ava. No fake ringback ever
        // played (guard flow only showed connecting + searching tone).
        session?.notePlaceResult(false);
      } else if (res.statusCode == 403 && res.body.contains('identity_required')) {
        // The global 403 interceptor already opened the consent/liveness flow —
        // tear down the optimistic call screen so it isn't stuck behind the gate.
        Analytics.capture('call_blocked_identity', {'kind': callKind, 'mount': 'optimistic'});
        session?.hangup('identity-gate');
      } else {
        // Auth/5xx/rate-limit that isn't a reachability signal — let the guard
        // flow run; it self-heals via the 12s device-ring timeout → Ava if no
        // peer ever joins. Captured so it isn't silent.
        Analytics.capture('call_place_failed', {'status': res.statusCode, 'kind': callKind, 'mount': 'optimistic'});
        session?.notePlaceResult(true);
      }
    } catch (e) {
      // The place-call POST threw (network/DNS error or timeout). Drive the honest
      // 'network-error' terminal + Retry instead of a hung screen — same outcome
      // the old awaited path gave, just applied to the already-mounted screen.
      AvaLog.I.log('call', 'POST /api/call (bg) FAILED: $e');
      final err = e.toString();
      Analytics.capture('call_place_failed', {
        'call_id': room,
        'kind': callKind,
        'error': err.length > 160 ? err.substring(0, 160) : err,
        'mount': 'optimistic',
      });
      CallSessionManager.instance.liveSessionFor(room)?.notePlaceFailed();
    }
  }

  int get _groupMemberCount => _group?.members.length ?? widget.chat.members;
  bool get _confAllowed =>
      RemoteConfig.conferenceEnabled && RemoteConfig.cloudflareConferenceEnabled && _groupMemberCount <= 25;
  bool get _confOngoingHere =>
      CloudflareConferenceController.activeGid == widget.chat.gid && widget.chat.gid != null;

  void _startConfPolling() {
    if (!_isGroup && widget.chat.gid == null) return;
    _confTimer ??= Timer.periodic(const Duration(seconds: 25), (_) => _refreshConfStatus());
    _refreshConfStatus();
  }

  /// [CF-CALL-007] Cloudflare Realtime status probe (drives the in-chat
  /// "ongoing call" banner). LiveKit/SFU/mesh status probes are gone with
  /// those transports.
  Future<void> _refreshConfStatus() async {
    final gid = widget.chat.gid;
    if (gid == null || !RemoteConfig.conferenceEnabled || !RemoteConfig.cloudflareConferenceEnabled) return;
    final s = await CloudflareConferenceApi.status(gid);
    if (mounted) {
      setState(() {
        _confLive = s.live;
        _confCount = s.count;
        _confBackendAvailable = s.available;
        _confUnavailableReason = s.unavailableReason;
        _confMediaKind = s.mediaKind;
      });
    }
  }

  /// [CF-CALL-007] Group-call launch — Cloudflare Realtime A/V is the ONLY
  /// transport now. LiveKit (ConferenceScreen), the legacy audio-only SFU path
  /// (SfuGroupCallScreen, gated by the now-removed groupAudioSfuEnabled), and
  /// the free-tier P2P mesh fallback (MeshCallScreen) are all removed —
  /// Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md.
  /// When cloudflareConferenceEnabled is off, group calls are simply
  /// unavailable (the same notice as the pre-existing conferenceEnabled-off
  /// case) — this never falls back to any legacy transport.
  /// [GCALL-W2-JOINGUARD] `joinOnly` marks the entry points whose intent is
  /// "get me into the call that is happening" — the ongoing-call banner and the
  /// Join affordance on a "call started" message — as opposed to the header
  /// buttons, whose intent is "start a call". The distinction matters because
  /// tapping Join on a call that has since ENDED used to silently start a brand
  /// new one, post a fresh "call started" message to the whole group, and never
  /// tell the person that what they tried to join was over.
  Future<void> _groupCall(bool video, {bool joinOnly = false}) async {
    final gid = widget.chat.gid;
    if (gid == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('This group needs to sync once before it can hold calls')));
      return;
    }
    // Both refusals route through the same notice, which now names the actual
    // reason rather than reporting a flag outage as a group-size problem.
    if (!RemoteConfig.conferenceEnabled || !RemoteConfig.cloudflareConferenceEnabled) {
      _confLimitNotice(video);
      return;
    }
    if (_groupMemberCount > 25) { _confLimitNotice(video); return; }
    await _cfGroupCall(video, joinOnly: joinOnly);
  }

  /// [CF-CALL-004] Cloudflare Realtime A/V group call launch site (audio OR
  /// video, ≤25). The ONLY group-call transport as of CF-CALL-007.
  Future<void> _cfGroupCall(bool video, {bool joinOnly = false}) async {
    final gid = widget.chat.gid;
    if (gid == null) return;
    if (CloudflareConferenceController.activeGid != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are already in a call — leave it first')));
      return;
    }
    // [GCALL-W4-BUSY] …and a 1:1 call counts too. This guarded conference vs
    // conference only, so someone already on a one-to-one call could tap into a
    // group call and end up nominally in both with one microphone.
    if (callIsGenuinelyActive()) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are on another call — finish it first')));
      Analytics.capture('groupcall_blocked_busy', {'reason': 'in_1to1_call'});
      return;
    }
    final s = await CloudflareConferenceApi.status(gid);
    if (!mounted) return;
    // [GCALL-W2-JOINGUARD] `status()` fails OPEN to live:false, so an unreachable
    // backend is indistinguishable from "no call in progress" — and `starting`
    // is derived from exactly that. Refuse to start a call on the back of a
    // status we could not actually read.
    if (!s.available) {
      _confLimitNotice(video);
      return;
    }
    final starting = !s.live;
    if (starting && joinOnly) {
      // They asked to JOIN. There is nothing to join — say so, and refresh the
      // banner rather than starting a call nobody asked for.
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('That call has already ended')));
      unawaited(_refreshConfStatus());
      return;
    }
    if (starting) {
      _sendSpecial('gcall', {'state': 'start', 'kind': video ? 'video' : 'audio', 'gid': gid, 'cf': true},
          video ? '📹 Video call started — tap 📞 to join' : '🎙️ Audio call started — tap 📞 to join');
    }
    if (!mounted) return;
    await Navigator.push(context, MaterialPageRoute(
        builder: (_) => CloudflareConferenceScreen(gid: gid, title: widget.chat.name, video: video, starter: starting)));
    _refreshConfStatus();
  }

  /// [GCALL-W1-NOTICE] Why the call icons are greyed out — branched three ways.
  ///
  /// This always said "this group has more than 25 members", including when the
  /// real cause was a kill switch or an unreachable backend. Owners chasing a
  /// group of six were told to remove members. The >25 wording is preserved
  /// verbatim for the case it actually describes (PHASE-10 acceptance
  /// criteria); the other two branches are new.
  void _confLimitNotice(bool video) {
    final what = video ? 'video' : 'audio';
    final tooBig = _groupMemberCount > 25;
    final flagsOff = !RemoteConfig.conferenceEnabled ||
        !RemoteConfig.cloudflareConferenceEnabled ||
        _confUnavailableReason == 'flags';

    final String title;
    final String body;
    if (tooBig) {
      title = '${video ? 'Video' : 'Audio'} calls disabled';
      body = 'This group has more than 25 members, so $what calls are '
          'disabled. You need fewer than 25 people to have a $what conference.';
    } else if (flagsOff) {
      title = 'Group calls are off';
      body = 'Group $what calls are switched off right now. This is a setting on '
          'our side, not something wrong with your group — please try again later.';
    } else if (!_confBackendAvailable) {
      title = 'Group calls unavailable';
      body = _confUnavailableReason == 'network'
          ? 'We couldn\'t reach the call service. Check your connection and try again.'
          : 'The call service isn\'t responding right now. Please try again in a moment.';
    } else {
      title = '${video ? 'Video' : 'Audio'} calls unavailable';
      body = 'Group $what calls can\'t start in this chat right now. Please try again shortly.';
    }

    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
  }

  /// "Ongoing call · 6 — tap to join" banner.
  ///
  /// [GCALL-W1-KIND] Joins with the call's ACTUAL media kind (from /status).
  /// It used to hardcode `_groupCall(true)` — a video join into whatever was
  /// running. A video publish into an audio call is rejected by the Worker
  /// outright, so joining an audio call from this banner failed the entire
  /// join, not just the camera. Falls back to audio when the backend hasn't
  /// told us (an older Worker), because audio is the safe request: an audio
  /// publish is legal in every call kind.
  ///
  /// (There is no PiP/minimize for conferences — leaving the screen leaves the
  /// call, so tapping while already in it says "leave it first". The previous
  /// comment here claimed otherwise.)
  bool get _confIsVideo => _confMediaKind == 'audio_video' || _confMediaKind == 'video';

  Widget _confBanner() => GestureDetector(
        onTap: () => _groupCall(_confIsVideo, joinOnly: true),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.online,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 2)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(children: [
            PhosphorIcon(
                _confIsVideo
                    ? PhosphorIcons.videoCamera(PhosphorIconsStyle.fill)
                    : PhosphorIcons.phone(PhosphorIconsStyle.fill),
                color: AD.textPrimary, size: 17),
            const SizedBox(width: 8),
            Expanded(child: Text(
              _confOngoingHere
                  ? 'Ongoing call · $_confCount — tap to return'
                  : 'Ongoing call · $_confCount — tap to join',
              style: ADText.rowName(),
            )),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textPrimary),
          ]),
        ),
      );
}
