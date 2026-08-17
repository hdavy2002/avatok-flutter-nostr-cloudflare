/// [CALL-SFU-1 2026-08-06] The 1:1 media transport that runs through the
/// Cloudflare Realtime SFU instead of directly to the other phone.
///
/// WHAT THIS REPLACES, AND WHY
/// ---------------------------
/// On the P2P path the two phones negotiate with EACH OTHER over the CallRoom
/// socket: offer, answer, trickled candidates, an elected offerer, glare
/// detection, and — when the network changes — an ICE restart that both sides
/// must agree on and both must independently prove worked. On 2026-08-05 that
/// last part failed 12 times out of 12 on real devices.
///
/// Here there is no negotiation between phones at all. Each phone has exactly one
/// conversation, with a server, at a fixed publicly-routable address:
///
///     me --publish--> Cloudflare <--publish-- peer
///     me <---pull---- Cloudflare ----pull---> peer
///
/// When my network changes, only MY leg breaks. The peer keeps sending to a
/// server that has not moved. Recovery is "reconnect to a server", not "two
/// phones behind two NATs re-find each other over a signalling path that may
/// itself be broken".
///
/// THE ONE INVERSION TO REMEMBER
/// -----------------------------
/// PUBLISH: we offer, the SFU answers.
/// PULL:    the SFU offers, WE answer (delivered via PUT /renegotiate).
///
/// That is Cloudflare's contract, not ours, and it is the reason no part of the
/// P2P recovery machinery ports over: every piece of it assumes we can re-offer
/// whenever we like. On this transport there is no client-initiated re-offer at
/// all — which is also why a mid-call camera-on is a second PUBLISH here rather
/// than the renegotiation `_restartWithVideo` does on P2P.
///
/// SEQUENCE FIDELITY
/// -----------------
/// The connect/publish/pull ordering below deliberately mirrors
/// `features/conference/cloudflare_conference_controller.dart`, which has been
/// carrying group conferences in production since the LiveKit cutover. Where the
/// two differ, that one is right and this one is wrong — it is the reference, and
/// it is why (for example) the offer is published immediately after
/// `setLocalDescription` without waiting for ICE gathering to complete. Do not
/// "improve" that ordering from first principles without a two-device test.
library;

import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../ava_log.dart';
import '../audio_tuning.dart' as audio_tuning;
import 'call_sfu_api.dart';

/// Why a connect attempt gave up. Carried into `call_sfu_fallback` so a bad day
/// at Cloudflare shows up as a chart rather than as "calls are broken".
enum SfuFailure {
  /// Server said the SFU is off or unconfigured. Expected, not alarming.
  unavailable,

  /// `/join` failed — no session, nothing to build on.
  joinFailed,

  /// We built a peer connection but could not publish our own audio.
  publishFailed,

  /// The peer never registered a seat inside the window. Usually means the other
  /// side went to P2P, or never got as far as joining.
  peerNeverPublished,

  /// The peer was published but pulling their track failed.
  pullFailed,

  /// Anything unexpected. The message is carried separately.
  unknown,
}

class CallSfuResult {
  CallSfuResult.ok(this.pc, {
    required this.sessionId,
    required this.relayDegraded,
    required this.videoRequested,
    required this.peerVideoAvailable,
    required this.videoConnected,
  })
      : failure = null,
        detail = null;
  CallSfuResult.failed(this.failure, {this.detail})
      : pc = null,
        sessionId = null,
        relayDegraded = false,
        videoRequested = false,
        peerVideoAvailable = false,
        videoConnected = false;

  final RTCPeerConnection? pc;
  final String? sessionId;
  final bool relayDegraded;
  /// True when this call requested video on the SFU path.
  final bool videoRequested;
  /// True when the peer advertised a video seat. False means audio-only is a
  /// valid outcome; it is different from a failed video pull.
  final bool peerVideoAvailable;
  /// True when the SFU accepted the remote video pull negotiation. A later
  /// renderer/first-frame event is still required to prove pixels are visible.
  final bool videoConnected;
  final SfuFailure? failure;
  final String? detail;

  bool get connected => pc != null;
}

class CallSfuTransport {
  CallSfuTransport({
    required this.room,
    required this.createPeerConnection,
    this.configurePeerConnection,
    this.enableRed = false,
    this.onRedNegotiated,
    this.onStage,
    this.onStaleAudioMuted,
    this.onNegotiation,
    this.overlapPeerWait = true,
  });

  /// The same room id the P2P signalling uses. Both transports are keyed on it,
  /// so `CallRoom` stays the single authority on who is on this call.
  final String room;

  /// Creates the peer connection through CallSession's canonical `_newPC`.
  ///
  /// This exists so `CallSession` installs its OWN `onTrack`,
  /// `onConnectionState` and stats wiring, exactly as it does for P2P. The
  /// transport deliberately does not own those: the renderer, the health
  /// sampler, the media-health telemetry, mute, DTMF and the translate audio
  /// bridge all already read `_pc`, and every one of them keeps working
  /// unchanged if the SFU simply hands back a peer connection. Duplicating that
  /// wiring here would have created a second, silently diverging copy.
  final Future<RTCPeerConnection> Function(List<Map<String, dynamic>> iceServers)
      createPeerConnection;

  /// Apply codec and sender limits after SFU tracks exist, before publishing.
  final Future<void> Function(RTCPeerConnection pc)? configurePeerConnection;

  /// [CALL-MEDIA-540P-1] Opus RED (RFC 2198), passed in rather than read here
  /// so this transport stays free of RemoteConfig and both call paths are
  /// driven by the SAME `callAudioRedExperimentV1` flag. It was previously
  /// hard-coded `false` at three call sites while the P2P path honoured the
  /// flag — which is prod-`true` — so moving a call onto the SFU silently
  /// dropped the redundancy the flag was switched on to provide.
  final bool enableRed;

  /// [CALL-RED-SFU-OBS-1 2026-08-06] Reports whether RED actually ENGAGED on a
  /// publish offer — red payload first on the `m=audio` line and carrying an
  /// fmtp block list, i.e. `audio_tuning.sdpHasActiveRed`.
  ///
  /// The P2P tuner has emitted `call_audio_red_negotiated` since [CALL-RED-1];
  /// this path never has. Since `callSfuV1` is true in production, that meant
  /// RED engagement was unobservable on the ONLY path carrying real 1:1 calls,
  /// and the 2026-08-06 bandwidth investigation had to infer it from byte rates
  /// and `opus_red_active` on `call_qos_bitrate_changed`. A callback rather than
  /// a direct `Analytics.capture` keeps this transport free of the analytics and
  /// RemoteConfig imports it has deliberately avoided.
  final void Function(bool applied, String sdpType)? onRedNegotiated;

  /// [CALL-DEADAIR-1 2026-08-08] Stage marker for the connect ladder.
  ///
  /// Called once per completed step with a stable name. `CallSession` turns the
  /// sequence into the per-stage breakdown on `call_first_audio_ms`, which is
  /// the only way to tell WHICH rung of this ladder ate the 14 seconds of
  /// silence measured on avatok-17f145b5 (2026-08-07). A callback rather than a
  /// direct `Analytics.capture` for the same reason as [onRedNegotiated]: this
  /// transport stays free of the analytics and RemoteConfig imports.
  final void Function(String stage)? onStage;

  /// [CALL-SFU-DUPAUDIO-1 2026-08-09] Reports how many STALE remote audio
  /// tracks were muted after a repull replaced them.
  ///
  /// Why this exists: `_pull` adds a NEW recvonly m-section per repull and
  /// nothing client-side ever silenced the previous one — the design relied
  /// entirely on the server closing the peer's old seat. On 2026-08-08
  /// (hdavy2002 × s.rgoavilla, 12:32–12:52 UTC) a handover produced a dual
  /// rejoin + three repulls, and both phones played the peer's voice DOUBLED
  /// for the rest of the call — heard as "echo" on speaker AND earpiece, with
  /// a clean network (0% loss, MOS 4.3). The seat close runs over the network
  /// that just died, and [CALL-SFU-MBB-1] deliberately keeps the old PC
  /// publishing until the replacement exists, so "the old track goes quiet"
  /// is not a guarantee, only a hope. A callback rather than a direct
  /// `Analytics.capture` for the same reason as [onRedNegotiated].
  final void Function(int count)? onStaleAudioMuted;

  /// [CALL-VIDEO-FIX-1 2026-08-17] Reports one completed pass through
  /// [_serialize]: `op` is the operation name (`connectPublish`,
  /// `connectPull`, `publishVideo`, `pullPeerVideo`, `pullPeerAudio`),
  /// `queuedMs` is how long it waited behind a previous negotiation,
  /// `ranMs` is how long its own body took, and `ok` is false on any
  /// exception/timeout. A callback rather than a direct `Analytics.capture`
  /// for the same reason as [onRedNegotiated] — this transport stays free of
  /// the analytics import. `CallSession` turns this into
  /// `call_sfu_negotiation`.
  final void Function(String op, int queuedMs, int ranMs, bool ok)? onNegotiation;

  /// [CALL-DEADAIR-1] Run the peer-seat poll CONCURRENTLY with our own publish
  /// instead of strictly after it.
  ///
  /// Both phones run this identical ladder at the same moment, so by the time
  /// our publish round trip finishes the peer has very often already published.
  /// Serialising the two meant we always paid `publish` and THEN started looking
  /// — the poll is a pure read loop against `/peer`, it depends on nothing we do
  /// locally, and nothing in the pull below can start before the publish
  /// completes anyway. Flag-gated from `CallSession` (`callSetupParallelBootV1`)
  /// so it can be switched off in KV without a build.
  final bool overlapPeerWait;

  String? _sessionId;
  RTCPeerConnection? _pc;
  bool _disposed = false;
  Timer? _heartbeatTimer;

  /// Mids we have opened, for the close call on teardown.
  final List<String> _openMids = <String>[];

  /// [CALL-SFU-DUPAUDIO-1] Mids of the remote AUDIO m-sections we are currently
  /// pulling. Tracked separately from [_openMids] (which mixes publish, video
  /// and audio mids and only exists for the close call) so a repull can tell
  /// exactly which previous audio sections it just superseded and mute them.
  final Set<String> _pulledAudioMids = <String>{};

  /// [CALL-PREJOIN-1 2026-08-16] State held between [connectPublish] and
  /// [connectPull] so the two can run at different times (the caller
  /// publishes during the ring; the pull happens only once a peer seat
  /// exists). `true` once a publish attempt has completed successfully —
  /// [connectPull] refuses to run without it, and [dispose]/[reconnect]
  /// clear it so a stale publish can never be pulled twice.
  bool _publishDone = false;

  /// Whether the SFU room allows video AT ALL (server-side, from `/join`) —
  /// independent of whether THIS phone chose to publish a video track in
  /// [connectPublish]. [connectPull] needs this to decide whether pulling the
  /// peer's video is even worth attempting.
  bool _joinVideoAllowed = false;

  /// `join.relayDegraded`, carried from [connectPublish] into the
  /// [CallSfuResult] that [connectPull] eventually returns.
  bool _joinRelayDegraded = false;

  /// [CALL-DEADAIR-1] The overlapped peer-seat poll, started as early as
  /// possible inside [connectPublish] (see [overlapPeerWait]) and consumed by
  /// [connectPull]. Split out of the old single-method `connect()` so the
  /// caller pre-join can start this poll during the ring, well before
  /// [connectPull] ever runs.
  Future<CallSfuPeer?>? _pendingEarlyPeer;

  /// Track names are ours to choose. Namespacing by session id keeps them unique
  /// across a reconnect that mints a new session, so a peer that is briefly
  /// holding a stale seat cannot pull a name that now means something else.
  String _audioTrackName(String sid) => 'audio-$sid';
  String _videoTrackName(String sid) => 'video-$sid';

  String? get sessionId => _sessionId;

  /// [CALL-VIDEO-FIX-1 2026-08-17] Serializes every negotiation-touching
  /// operation against this transport's SINGLE RTCPeerConnection.
  ///
  /// Cloudflare's SFU contract makes each publish/pull a full offer/answer
  /// (or answer/offer) round trip against the only conversation this phone
  /// has with the SFU. Before this queue, `connectPublish`, `connectPull`,
  /// `_pull`, `publishVideo`, `pullPeerVideo`, `pullPeerAudio` and
  /// `reconnect` could all mutate the same `RTCPeerConnection` concurrently —
  /// e.g. a mid-call camera-on racing a repull from network recovery — which
  /// is one of two confirmed causes of the video-switch freeze (2026-08-17
  /// postmortem; the other is [_publishVideoImpl]'s old hard-coded mid).
  ///
  /// Every public negotiation entry point below runs its body through
  /// [_serialize] so at most one is ever mutating [_pc] at a time. A per-op
  /// [_negotiationTimeout] guarantees a hung op still lets the QUEUE advance
  /// — later callers get their own failure instead of waiting forever behind
  /// a wedged network call.
  ///
  /// NESTING WARNING — do not call [_serialize] from inside a `body` that is
  /// itself already executing under [_serialize]. The inner call would await
  /// [_negotiationChain], which at that moment IS the outer call's own
  /// not-yet-completed slot — the two would wait on each other forever.
  /// [_doPull] exists precisely so [_connectPullImpl] and
  /// [_publishVideoImpl] (both already serialized) can pull without
  /// re-entering the queue; only the free-standing entry points
  /// ([pullPeerVideo], [pullPeerAudio]) serialize around it. [connect] and
  /// [reconnect] are themselves NOT wrapped for the same reason — they
  /// compose [connectPublish]/[connectPull], which are — so mutual exclusion
  /// still holds across the pair without nesting.
  Future<void> _negotiationChain = Future<void>.value();

  static const Duration _negotiationTimeout = Duration(seconds: 15);

  /// [CALL-VIDEO-FIX-2 2026-08-17] Monotonic id of the negotiation currently
  /// entitled to write shared transport state (`_pc`, `_sessionId`, `_openMids`).
  ///
  /// `Future.timeout` does NOT cancel the work it gives up on — a timed-out
  /// negotiation keeps running, and its late `_pc = pc` / `_sessionId = ...`
  /// assignment would otherwise land AFTER a newer operation's and silently
  /// clobber it. That is the same class of defect as the pre-join connection
  /// that overwrote live call state (`[CALL-PREJOIN-ISOLATE-1]`), so it gets
  /// the same treatment: each queued body carries the generation it was issued
  /// under, and [_ownsNegotiation] is the gate every shared write must pass.
  int _negotiationGeneration = 0;

  /// True while [gen] is still the newest issued negotiation. A superseded or
  /// timed-out body must read false here and abandon its writes silently.
  bool _ownsNegotiation(int gen) => gen == _negotiationGeneration && !_disposed;

  Future<T> _serialize<T>(String op, Future<T> Function() body) {
    final queuedStartMs = DateTime.now().millisecondsSinceEpoch;
    final completer = Completer<void>();
    final previous = _negotiationChain;
    _negotiationChain = completer.future;
    final gen = ++_negotiationGeneration;
    return previous.then((_) async {
      // Superseded while queued: a newer negotiation was issued behind us, so
      // running this one would race it. Skipping is correct and cheap — the
      // newer op is doing the same job with fresher inputs.
      if (gen != _negotiationGeneration) {
        onNegotiation?.call('$op:superseded', 0, 0, false);
        completer.complete();
        return Future<T>.error(
          StateError('negotiation $op superseded by a newer operation'),
        );
      }
      final queuedMs = DateTime.now().millisecondsSinceEpoch - queuedStartMs;
      final runStartMs = DateTime.now().millisecondsSinceEpoch;
      var ok = false;
      try {
        final result = await body().timeout(_negotiationTimeout);
        ok = true;
        return result;
      } finally {
        final ranMs = DateTime.now().millisecondsSinceEpoch - runStartMs;
        onNegotiation?.call(op, queuedMs, ranMs, ok);
        // Release the NEXT queued op regardless of how this one finished —
        // this is what makes a hung/timed-out body bounded rather than a
        // permanent wedge on every later negotiation.
        completer.complete();
      }
    });
  }

  /// How long to wait for the other phone to register its seat.
  ///
  /// Both phones join concurrently, so finding no peer on the first read is
  /// NORMAL, not an error. 6s is comfortably longer than a join round trip and
  /// comfortably shorter than a caller's patience; past it we assume the peer is
  /// not coming to the SFU and fall back rather than leave someone on a
  /// connected-looking call with silence.
  static const Duration _peerWait = Duration(seconds: 6);

  /// [CALL-DEADAIR-1] The window used when the poll is started BEFORE the
  /// publish (see [overlapPeerWait]). Deliberately 2s longer than [_peerWait] so
  /// the patience REMAINING after our publish completes is still at least the
  /// historical 6s — overlapping must buy latency, never spend tolerance.
  static const Duration _peerWaitOverlapped = Duration(seconds: 8);

  /// [CALL-DEADAIR-1] 400ms → 250ms. This is dead air, not a background poll:
  /// when the peer publishes just after a probe we hold silence for the whole
  /// interval for no reason. `/peer` is a cheap DO seat read.
  static const Duration _peerPoll = Duration(milliseconds: 250);

  /// Build the peer connection, publish our tracks, pull the peer's.
  ///
  /// Returns a failure rather than throwing: every caller's correct response is
  /// to fall back to P2P, and an exception crossing the call-setup path is a
  /// dropped call. `video` is a request — the server may refuse it when
  /// `callSfuAudioOnly` is on, and the returned result is still a success.
  ///
  /// [CALL-PREJOIN-1 2026-08-16] Exactly `connectPublish` then `connectPull`,
  /// composed — see those two for the actual work. Split out so a caller can
  /// run the publish half during the ring and the pull half only once a peer
  /// seat exists (`CallSession._maybeStartCallerPrejoin` /
  /// `_startSfuMedia`'s adoption of it). Every existing caller of `connect()`
  /// gets byte-for-byte the same behaviour as before the split, INCLUDING the
  /// `overlapPeerWait` early-peer optimization: the poll still starts inside
  /// the publish phase, before the offer/publish round trip, exactly as it did
  /// in the single-method version.
  ///
  /// [CALL-VIDEO-FIX-1] NOT itself wrapped in [_serialize], for the same
  /// reason [reconnect] is not: [connectPublish] awaits to completion
  /// (including its own queue slot) before [connectPull] is even called, so
  /// the two already run strictly one after the other with nothing else
  /// able to interleave — wrapping this method too would just be a nested
  /// [_serialize] call around calls that are already serialized individually.
  Future<CallSfuResult> connect({
    required MediaStream localStream,
    required List<Map<String, dynamic>> fallbackIceServers,
    required bool video,
    /// [CALL-PREWARM-1 2026-08-16] A `/join` result obtained BEFORE `connect()`
    /// was called (during the ring, via `CallPrewarm`). When non-null and
    /// carries a non-empty `sessionId`, this is used in place of the normal
    /// `CallSfuApi.join(room)` round trip and `sfu_join` is staged immediately
    /// — accept then only has to publish + pull. Left null on every path that
    /// is not the fresh callee connect (in particular [reconnect] never passes
    /// this: a network-recovery join must always be current, never a stale
    /// pre-ring seat).
    CallSfuJoinResult? prewarmedJoin,
  }) async {
    final publishFailure = await connectPublish(
      localStream: localStream,
      fallbackIceServers: fallbackIceServers,
      video: video,
      prewarmedJoin: prewarmedJoin,
    );
    if (publishFailure != null) return publishFailure;
    return connectPull(video: video);
  }

  /// [CALL-PREJOIN-1 2026-08-16] The PUBLISH half of `connect()`: join (or
  /// adopt [prewarmedJoin]), build the peer connection, add tracks, offer and
  /// publish. Returns `null` on success — the connection state (PC, session
  /// id, the overlapped peer-seat poll) is held on this object for a later
  /// [connectPull] — or a failed [CallSfuResult] on any error, in which case
  /// there is nothing to pull and the caller must not call [connectPull].
  ///
  /// `video` here controls whether OUR OWN video track is included in this
  /// publish. The caller pre-join always passes `false` — only audio is
  /// published during the ring; a video call's camera track is added later,
  /// after accept, exactly like today's mid-call camera-on
  /// (`CallSession._enableSfuVideo` → `publishVideo`). [connectPull]'s own
  /// `video` argument is independent and controls whether the PEER's video is
  /// pulled, which is unrelated to what we chose to publish.
  Future<CallSfuResult?> connectPublish({
    required MediaStream localStream,
    required List<Map<String, dynamic>> fallbackIceServers,
    required bool video,
    CallSfuJoinResult? prewarmedJoin,
  }) async {
    try {
      return await _serialize(
        'connectPublish',
        // [CALL-VIDEO-FIX-2] `_negotiationGeneration` is stamped by `_serialize`
        // BEFORE this closure runs, so reading it here yields the generation
        // this very operation was issued under.
        () => _connectPublishImpl(
          localStream: localStream,
          fallbackIceServers: fallbackIceServers,
          video: video,
          prewarmedJoin: prewarmedJoin,
          gen: _negotiationGeneration,
        ),
      );
    } on TimeoutException {
      AvaLog.I.log('call', 'connectPublish timed out in the negotiation queue');
      await _closePc();
      return CallSfuResult.failed(SfuFailure.unknown, detail: 'negotiation_timeout');
    }
  }

  /// [CALL-VIDEO-FIX-1] The actual publish logic, run under [_serialize] by
  /// [connectPublish]. See [_serialize]'s doc comment for why this is split
  /// out — this body must never call [_serialize] itself.
  Future<CallSfuResult?> _connectPublishImpl({
    required MediaStream localStream,
    required List<Map<String, dynamic>> fallbackIceServers,
    required bool video,
    CallSfuJoinResult? prewarmedJoin,
    // [CALL-VIDEO-FIX-2] The generation this body was issued under. Shared
    // state (`_sessionId`, `_pc`) is only written while it is still current —
    // a timed-out body keeps running and must not clobber its successor.
    required int gen,
  }) async {
    _peerPollAbort = false; // [CALL-DEADAIR-1] fresh attempt (reconnect reuses this object)
    _publishDone = false;
    _pendingEarlyPeer = null;
    try {
      final join = (prewarmedJoin != null && prewarmedJoin.sessionId.isNotEmpty)
          ? prewarmedJoin
          : await CallSfuApi.join(room);
      if (join.sessionId.isEmpty) {
        return CallSfuResult.failed(SfuFailure.joinFailed, detail: 'empty_session_id');
      }
      if (!_ownsNegotiation(gen)) {
        return CallSfuResult.failed(SfuFailure.unknown, detail: 'superseded_before_session');
      }
      _sessionId = join.sessionId;
      _joinVideoAllowed = join.videoAllowed;
      _joinRelayDegraded = join.relayDegraded;
      onStage?.call('sfu_join');
      if (join.relayDegraded) {
        // Loud on purpose. On the P2P path the identical condition was dropped
        // silently by ice_cache.dart and a TURN outage was indistinguishable
        // from a healthy deployment for weeks.
        AvaLog.I.log('call', 'relay degraded on join: ${join.relayReason ?? "unknown"}');
      }

      final wantVideo = video && join.videoAllowed;

      // [CALL-SFU-EARLY-SEAT-1] `/join` has registered our server-side seat,
      // and `/peer` is a read of the *other* seat only. Start that read loop
      // now rather than waiting for local PC creation, track attachment, codec
      // tuning and offer generation. The later `_pull` is still strictly after
      // our publish has completed, so this changes no SFU negotiation ordering.
      //
      // This is especially useful for the callee: both sides have already
      // joined by the time its local setup finishes, so the peer seat is often
      // available before this phone has generated its publish offer.
      final Future<CallSfuPeer?>? earlyPeer =
          overlapPeerWait ? _awaitPeerAudio(_peerWaitOverlapped) : null;
      _pendingEarlyPeer = earlyPeer;

      // [CALL-SFU-NULLPC-1 2026-08-14] Hold the PC in a LOCAL for the whole
      // connect. `_pc` is nulled by a concurrent dispose()/_closePc() (a
      // cancelled or superseded call tearing down while this join is mid-await),
      // and every `_pc!` below then threw "Null check operator used on a null
      // value" into the generic catch — a crash-shaped failure instead of the
      // clean `disposed_during_setup` result (seen on the caller of prod call
      // avatok-9f407abf, 2026-08-14). The local stays valid; the `_disposed`
      // checks remain the clean exits.
      final pc = await createPeerConnection(
        join.iceServers.isNotEmpty ? join.iceServers : fallbackIceServers,
      );
      // [CALL-VIDEO-FIX-2] Superseded while the PC was being built: close what
      // we just made and leave `_pc` alone — the newer negotiation owns it.
      if (!_ownsNegotiation(gen)) {
        try { await pc.close(); } catch (_) {/* nothing to salvage */}
        return CallSfuResult.failed(SfuFailure.unknown, detail: 'superseded_during_setup');
      }
      _pc = pc;
      if (_disposed) {
        await pc.close();
        return CallSfuResult.failed(SfuFailure.unknown, detail: 'disposed_during_setup');
      }
      onStage?.call('sfu_pc');

      // Hand it over before any track exists, so the caller's onTrack is armed
      // before the pull below can deliver remote media.
      // Track order defines the mids: audio first is mid '0', video is mid '1'.
      // The conference controller relies on the same convention. It is an
      // assumption about flutter_webrtc's addTrack ordering, not a guarantee
      // from the spec — if remote video ever lands on the wrong renderer, look
      // here first.
      final tracks = <Map<String, dynamic>>[];
      final audio = localStream.getAudioTracks();
      if (audio.isEmpty) {
        _peerPollAbort = true; // [CALL-DEADAIR-1] stop the overlapped poll
        return CallSfuResult.failed(SfuFailure.publishFailed, detail: 'no_local_audio_track');
      }
      await pc.addTrack(audio.first, localStream);
      tracks.add({'mid': '0', 'kind': 'audio', 'trackName': _audioTrackName(join.sessionId)});

      if (wantVideo) {
        final cam = localStream.getVideoTracks();
        if (cam.isNotEmpty) {
          await pc.addTrack(cam.first, localStream);
          tracks.add({'mid': '1', 'kind': 'video', 'trackName': _videoTrackName(join.sessionId)});
        }
      }

      await configurePeerConnection?.call(pc);

      // PUBLISH — we offer, the SFU answers.
      final offer = await pc.createOffer();
      final tunedOffer = RTCSessionDescription(
        audio_tuning.tuneOpusSdp(offer.sdp, enableRed: enableRed),
        offer.type,
      );
      await pc.setLocalDescription(tunedOffer);
      if (enableRed) {
        onRedNegotiated?.call(
          audio_tuning.sdpHasActiveRed(tunedOffer.sdp),
          'offer',
        );
      }
      final answer = await CallSfuApi.publish(room, join.sessionId, tunedOffer.sdp ?? '', tracks);
      if (answer == null || answer['sdp'] == null) {
        _peerPollAbort = true; // [CALL-DEADAIR-1]
        return CallSfuResult.failed(SfuFailure.publishFailed, detail: 'no_answer_sdp');
      }
      await pc.setRemoteDescription(
        RTCSessionDescription(answer['sdp'].toString(), 'answer'),
      );
      for (final t in tracks) {
        _openMids.add(t['mid'].toString());
      }
      onStage?.call('sfu_publish');
      if (_disposed) {
        _peerPollAbort = true; // [CALL-DEADAIR-1]
        return CallSfuResult.failed(SfuFailure.unknown, detail: 'disposed_after_publish');
      }
      _publishDone = true;
      return null;
    } on CallSfuException catch (e) {
      await _closePc();
      return CallSfuResult.failed(
        e.unavailable ? SfuFailure.unavailable : SfuFailure.joinFailed,
        detail: e.error,
      );
    } catch (e) {
      await _closePc();
      return CallSfuResult.failed(SfuFailure.unknown, detail: e.toString());
    }
  }

  /// [CALL-PREJOIN-1 2026-08-16] The PULL half of `connect()`: wait for the
  /// peer's seat, pull their audio (load-bearing), then their video
  /// (best-effort), and start the heartbeat. Requires a successful prior
  /// [connectPublish] on this object — calling this without one returns a
  /// failed result rather than throwing, since a caller mistake here must
  /// fall back to P2P exactly like any other SFU failure.
  ///
  /// `video`: whether to pull the PEER's video, independent of what THIS side
  /// published. Combined with the join's server-side `videoAllowed` (recorded
  /// by [connectPublish]) exactly as the old single-method `connect()` did.
  Future<CallSfuResult> connectPull({required bool video, Duration? peerWait}) async {
    if (!_publishDone || _pc == null || _sessionId == null) {
      return CallSfuResult.failed(SfuFailure.unknown, detail: 'connectPull_without_publish');
    }
    try {
      return await _serialize('connectPull', () => _connectPullImpl(video: video, peerWait: peerWait));
    } on TimeoutException {
      AvaLog.I.log('call', 'connectPull timed out in the negotiation queue');
      await _closePc();
      return CallSfuResult.failed(SfuFailure.unknown, detail: 'negotiation_timeout');
    }
  }

  /// [CALL-VIDEO-FIX-1] The actual pull logic, run under [_serialize] by
  /// [connectPull]. Calls [_doPull] directly (never [pullPeerVideo] /
  /// [pullPeerAudio] / another [_serialize]) — see [_serialize]'s nesting
  /// warning.
  Future<CallSfuResult> _connectPullImpl({required bool video, Duration? peerWait}) async {
    final pc = _pc;
    final sid = _sessionId;
    if (!_publishDone || pc == null || sid == null) {
      return CallSfuResult.failed(SfuFailure.unknown, detail: 'connectPull_without_publish');
    }
    try {
      final wantVideo = video && _joinVideoAllowed;
      // Wait for the peer's seat. Not an error until the window expires.
      // [CALL-DEADAIR-1] When overlapped, this has been running since just after
      // the peer connection was built (inside `connectPublish`) and is
      // frequently already resolved by the time `connectPull` runs.
      final earlyPeer = _pendingEarlyPeer;
      _pendingEarlyPeer = null;
      final peer = await (earlyPeer ?? _awaitPeerAudio(peerWait ?? _peerWait));
      if (peer == null) {
        return CallSfuResult.failed(SfuFailure.peerNeverPublished);
      }
      onStage?.call('sfu_peer_seat');

      // PULL audio — the SFU offers, we answer. `_doPull`, not `_pull`: this
      // body is already running under `_serialize` (see that method's
      // nesting warning).
      final pulledAudio = await _doPull('audio');
      if (!pulledAudio) {
        return CallSfuResult.failed(SfuFailure.pullFailed, detail: 'audio');
      }
      onStage?.call('sfu_pull_audio');

      // Video is best-effort even when we want it: the peer may simply not have
      // their camera on yet. A failure here must never fail the CALL — an
      // audio-only connection is a working call, and camera-on later is just
      // another pull.
      final peerVideoAvailable = peer.hasVideo;
      var videoConnected = false;
      if (wantVideo && peerVideoAvailable) {
        videoConnected = await _doPull('video');
      }

      _startHeartbeat();
      onStage?.call('sfu_ready');
      return CallSfuResult.ok(
        pc,
        sessionId: sid,
        relayDegraded: _joinRelayDegraded,
        videoRequested: wantVideo,
        peerVideoAvailable: peerVideoAvailable,
        videoConnected: videoConnected,
      );
    } catch (e) {
      await _closePc();
      return CallSfuResult.failed(SfuFailure.unknown, detail: e.toString());
    }
  }

  /// Rejoin Cloudflare after this phone's network leg changes. The peer's SFU
  /// session is intentionally left alone; only this side mints a new session
  /// and re-publishes its tracks.
  ///
  /// [CALL-VIDEO-FIX-1] NOT itself wrapped in [_serialize] — it composes
  /// [connect] (i.e. [connectPublish] then [connectPull]), both of which
  /// already are, so wrapping this too would be a nested [_serialize] call
  /// (see that method's warning) awaiting a slot that only frees once THIS
  /// call returns: a guaranteed deadlock. Mutual exclusion still holds
  /// end-to-end because every op it eventually runs goes through the same
  /// queue individually.
  Future<CallSfuResult> reconnect({
    required MediaStream localStream,
    required List<Map<String, dynamic>> fallbackIceServers,
    required bool video,
  }) async {
    // Close the old Cloudflare seat/session before minting the replacement.
    // Clearing _sessionId first leaks the old Realtime session and leaves the
    // peer holding a stale seat on every network recovery.
    await dispose();
    _disposed = false;
    _sessionId = null;
    _openMids.clear();
    _pulledAudioMids.clear(); // [CALL-SFU-DUPAUDIO-1] fresh PC, no stale sections
    return connect(
      localStream: localStream,
      fallbackIceServers: fallbackIceServers,
      video: video,
    );
  }

  /// [CALL-DEADAIR-1] Set when a connect attempt gives up while an overlapped
  /// peer poll is still running, so the loop stops instead of hammering `/peer`
  /// for the rest of its window on a call that has already fallen back to P2P.
  bool _peerPollAbort = false;

  /// Poll until the peer has registered an audio track, or the window expires.
  Future<CallSfuPeer?> _awaitPeerAudio(Duration wait) async {
    final deadline = DateTime.now().add(wait);
    while (!_disposed && !_peerPollAbort && DateTime.now().isBefore(deadline)) {
      try {
        final p = await CallSfuApi.peer(room);
        if (p.hasAudio) return p;
      } catch (_) {/* transient; keep polling until the deadline */}
      await Future<void>.delayed(_peerPoll);
    }
    return null;
  }

  /// One pull + the answer it requires. Returns false on any failure so the
  /// caller can decide whether that kind was load-bearing (audio) or not
  /// (video).
  ///
  /// [CALL-VIDEO-FIX-1] Deliberately UNSERIALIZED — this is the shared
  /// implementation [_connectPullImpl] and [_publishVideoImpl] call while
  /// already running under [_serialize]. Do not call [_serialize] from
  /// inside this method. The two free-standing public pull entry points
  /// ([pullPeerVideo], [pullPeerAudio]) are what apply the queue for callers
  /// outside an already-serialized op.
  Future<bool> _doPull(String kind) async {
    final sid = _sessionId;
    final pc = _pc;
    if (sid == null || pc == null) return false;
    try {
      final r = await CallSfuApi.pull(room, sessionId: sid, kind: kind);
      if (_disposed || !identical(pc, _pc)) return false;
      final sdp = r.offer?['sdp']?.toString();
      if (sdp == null) return false;
      if (!r.renegotiate) {
        // The SFU says nothing needs answering. Nothing to do, and answering
        // anyway would desynchronise the session.
        return true;
      }
      await pc.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
      if (_disposed || !identical(pc, _pc)) return false;
      final answer = await pc.createAnswer();
      // [CALL-MEDIA-540P-1] `enableRed: false` here is deliberate and is NOT an
      // oversight to be "fixed" for symmetry with the two publish sites. This
      // is the PULL answer: these m-sections are recvonly, carrying the PEER's
      // media. RED is a sender-side choice, and the RED branch of the tuner
      // promotes the red payload type to the front of the m=audio line — doing
      // that on a recvonly section asks the SFU to forward a payload type the
      // publisher is not producing, which is a way to get silence, not
      // redundancy. The fmtp cap still applies as a receive-side hint.
      final tunedAnswer = RTCSessionDescription(
        audio_tuning.tuneOpusSdp(answer.sdp, enableRed: false),
        answer.type,
      );
      await pc.setLocalDescription(tunedAnswer);
      if (_disposed || !identical(pc, _pc)) return false;
      await CallSfuApi.renegotiate(room, sid, tunedAnswer.sdp ?? '');
      final newMids = <String>{};
      for (final t in r.tracks) {
        final mid = (t as Map?)?['mid']?.toString();
        if (mid != null) {
          _openMids.add(mid);
          newMids.add(mid);
        }
      }
      if (kind == 'audio' && newMids.isNotEmpty) {
        // [CALL-SFU-DUPAUDIO-1] This pull SUPERSEDES any audio m-section we were
        // pulling before — mute the old ones client-side instead of trusting
        // the server to have closed the peer's previous seat. On 2026-08-08 that
        // trust was misplaced during handover churn and both phones played the
        // peer's voice doubled ("echo" in every route) for the rest of the call.
        // Mute (`track.enabled = false`), NOT `transceiver.stop()`: stopping
        // rewrites SDP state on a transport whose renegotiation is exclusively
        // server-driven, and this must stay reversible if a future pull reuses
        // the section.
        final stale = _pulledAudioMids.difference(newMids);
        var muted = 0;
        if (stale.isNotEmpty) {
          try {
            final transceivers = await pc.getTransceivers();
            for (final tr in transceivers) {
              if (!stale.contains(tr.mid)) continue;
              final track = tr.receiver.track;
              if (track == null || track.kind != 'audio') continue;
              if (track.enabled) {
                track.enabled = false;
                muted++;
              }
            }
          } catch (e) {
            AvaLog.I.log('call', 'stale audio mute failed: $e');
          }
        }
        _pulledAudioMids
          ..clear()
          ..addAll(newMids);
        if (muted > 0) onStaleAudioMuted?.call(muted);
      }
      return true;
    } catch (e) {
      AvaLog.I.log('call', 'pull $kind failed: $e');
      return false;
    }
  }

  /// Mid-call camera-on.
  ///
  /// On P2P this is `_restartWithVideo`: add the track, create an offer, send it.
  /// There is no equivalent here because the SFU accepts no client-initiated
  /// re-offer — so it is a SECOND publish of the new mid, followed by a pull of
  /// the peer's video if they have any. Everything else about the call is
  /// untouched; the audio connection is not renegotiated or interrupted.
  ///
  /// [CALL-VIDEO-FIX-1] Serialized via [_serialize] — this is a real
  /// offer/answer round trip against the same `RTCPeerConnection` every other
  /// negotiation on this transport touches.
  Future<bool> publishVideo(MediaStreamTrack videoTrack, MediaStream stream) async {
    try {
      return await _serialize('publishVideo', () => _publishVideoImpl(videoTrack, stream));
    } on TimeoutException {
      AvaLog.I.log('call', 'publishVideo timed out in the negotiation queue');
      return false;
    }
  }

  /// [CALL-VIDEO-FIX-1] The actual publish-video logic, run under
  /// [_serialize] by [publishVideo]. Calls [_doPull] directly at the end
  /// (never [pullPeerVideo]/another [_serialize]) — see [_serialize]'s
  /// nesting warning.
  Future<bool> _publishVideoImpl(MediaStreamTrack videoTrack, MediaStream stream) async {
    final sid = _sessionId;
    final pc = _pc;
    if (sid == null || pc == null) return false;
    try {
      await pc.addTrack(videoTrack, stream);
      if (_disposed || !identical(pc, _pc)) return false;
      // [CALL-MEDIA-540P-1] Configure BEFORE the offer, not after. This is the
      // first moment a video sender exists on this connection, so the limits
      // applied during `connect()` never saw it — a camera turned on mid-call
      // published with no bitrate ceiling, no BALANCED degradation and no codec
      // preference. Codec preference in particular only takes effect if it is
      // set before `createOffer`; applying it afterwards would look correct in
      // the diff and do nothing on the wire until some later renegotiation that
      // this transport, by design, never performs.
      await configurePeerConnection?.call(pc);
      final offer = await pc.createOffer();
      final tunedOffer = RTCSessionDescription(
        audio_tuning.tuneOpusSdp(offer.sdp, enableRed: enableRed),
        offer.type,
      );
      await pc.setLocalDescription(tunedOffer);
      if (_disposed || !identical(pc, _pc)) return false;
      if (enableRed) {
        onRedNegotiated?.call(
          audio_tuning.sdpHasActiveRed(tunedOffer.sdp),
          'offer_video',
        );
      }
      // [CALL-VIDEO-FIX-1] REAL mid, not a hard-coded '1'. By the time a
      // mid-call camera-on publishes, mid '1' has very often already been
      // claimed by something pulled earlier (most commonly the peer's
      // audio, added on THIS connection during `connectPull`) — sending a
      // literal '1' here told Cloudflare to attach the new video track to
      // whatever m-section already owns that mid, which is how a video
      // upgrade silently corrupted an unrelated (frequently audio) media
      // section and froze the call. `setLocalDescription` just ran, so
      // every transceiver's `mid` is now assigned; find the one whose
      // SENDER holds `videoTrack` — that is unambiguously the video
      // m-section this offer just created, regardless of what mid libwebrtc
      // gave it.
      String? resolvedMid;
      try {
        final transceivers = await pc.getTransceivers();
        for (final t in transceivers) {
          if (t.sender.track?.id == videoTrack.id) {
            resolvedMid = t.mid;
            break;
          }
        }
      } catch (e) {
        AvaLog.I.log('call', 'publishVideo mid resolution threw: $e');
      }
      if (resolvedMid == null || resolvedMid.isEmpty) {
        // Never guess. Sending a wrong-but-plausible mid is exactly the bug
        // this replaces — abort the upgrade instead and let the caller
        // report a clean failure. Nothing has been sent to the SFU yet, so
        // there is nothing to unwind server-side; the caller is responsible
        // for stopping/removing the local track it acquired.
        AvaLog.I.log('call', 'publishVideo aborted: could not resolve the real mid for the new video track');
        return false;
      }
      if (_disposed || !identical(pc, _pc)) return false;
      final answer = await CallSfuApi.publish(room, sid, tunedOffer.sdp ?? '', [
        {'mid': resolvedMid, 'kind': 'video', 'trackName': _videoTrackName(sid)},
      ]);
      if (answer == null || answer['sdp'] == null) return false;
      if (_disposed || !identical(pc, _pc)) return false;
      await pc.setRemoteDescription(RTCSessionDescription(answer['sdp'].toString(), 'answer'));
      if (_disposed || !identical(pc, _pc)) return false;
      _openMids.add(resolvedMid);
      // [CALL-VIDEO-FIX-1] Awaited, not `unawaited(...)`. Firing a second,
      // untracked negotiation the instant this one finishes was the other
      // confirmed cause of the freeze — two negotiations on the same PC with
      // nothing stopping them overlapping. This call is `_doPull`, not the
      // public `pullPeerVideo`, because we are already inside this op's
      // `_serialize` slot; the peer's video (if any) is pulled before
      // `publishVideo` reports success, and any later camera-on from the
      // peer goes through the normal `pullPeerVideo` queue entry instead.
      await _doPull('video');
      return true;
    } catch (e) {
      AvaLog.I.log('call', 'publishVideo failed: $e');
      return false;
    }
  }

  /// Pull the peer's video when they turn their camera on mid-call.
  ///
  /// [CALL-VIDEO-FIX-1] Serialized — a free-standing entry point, not called
  /// from inside another [_serialize]d op, so it is safe for it to queue.
  Future<bool> pullPeerVideo() async {
    try {
      return await _serialize('pullPeerVideo', () => _doPull('video'));
    } on TimeoutException {
      AvaLog.I.log('call', 'pullPeerVideo timed out in the negotiation queue');
      return false;
    }
  }

  /// [CALL-SFU-REPULL-1 2026-08-06] Re-pull the peer's AUDIO after they rejoined
  /// the SFU with a new session id.
  ///
  /// Their track name is `audio-<their new sid>`; the one we are currently
  /// pulling is `audio-<their old sid>` and no longer resolves to anything. The
  /// SFU does not tell us that — the pull simply goes quiet — so the peer's
  /// `sfu-rejoined` signal is the only trigger there is. Without it a network
  /// recovery that "succeeded" leaves that direction permanently silent.
  ///
  /// [CALL-VIDEO-FIX-1] Serialized for the same reason as [pullPeerVideo].
  Future<bool> pullPeerAudio() async {
    try {
      return await _serialize('pullPeerAudio', () => _doPull('audio'));
    } on TimeoutException {
      AvaLog.I.log('call', 'pullPeerAudio timed out in the negotiation queue');
      return false;
    }
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 15), (_) async {
      final sid = _sessionId;
      if (_disposed || sid == null) return;
      try {
        await CallSfuApi.heartbeat(room, sid);
      } catch (e) {
        AvaLog.I.log('call', 'SFU lease heartbeat failed: $e');
      }
    });
  }

  Future<void> _closePc() async {
    try { await _pc?.close(); } catch (_) {}
    _pc = null;
  }

  /// Teardown. Clearing the seat matters as much as closing the tracks: a stale
  /// seat leaves the peer pulling a dead session id, which produces silence with
  /// no error on either side.
  ///
  /// [CALL-VIDEO-FIX-1] Deliberately NEVER routed through [_serialize] — it
  /// must be able to run immediately even while a negotiation is queued or
  /// in flight, or a call end/`reconnect` would sit blocked behind whatever
  /// is currently occupying the chain (bounded by [_negotiationTimeout], but
  /// still up to 15s of a call that should have ended instantly). Safety
  /// against a concurrently-running op is instead the pre-existing
  /// `_disposed` / `identical(pc, _pc)` guards already threaded through
  /// [_connectPublishImpl], [_connectPullImpl], [_doPull] and
  /// [_publishVideoImpl] — every one of them notices a dispose that happened
  /// underneath it and backs out cleanly instead of touching a closed `pc`.
  Future<void> dispose() async {
    _disposed = true;
    _peerPollAbort = true; // [CALL-DEADAIR-1]
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    final sid = _sessionId;
    if (sid != null) {
      await CallSfuApi.close(room, sid, List<String>.from(_openMids));
    }
    _openMids.clear();
    _pulledAudioMids.clear(); // [CALL-SFU-DUPAUDIO-1]
    _sessionId = null;
    _publishDone = false; // [CALL-PREJOIN-1]
    _pendingEarlyPeer = null; // [CALL-PREJOIN-1]
    // The peer connection itself belongs to CallSession once handed over — it
    // closes it in its own teardown, in its own order. Closing it here too would
    // race that.
    _pc = null;
  }
}
