/// [CALL-PREWARM-1 2026-08-16] P1 of `Specs/PLAN-CALL-INSTANT-PICKUP-2026-08-16.md`.
///
/// The whole media stack (ICE credentials, SFU seat) is normally built AFTER
/// the callee taps Accept, serially. WhatsApp's trick is that none of that
/// work happens at pickup — both sides build their media path during the
/// ring. This is the callee half of that: the moment the incoming-call PUSH
/// lands (seconds before the ring UI can even be shown, and well before
/// Accept), [start] begins fetching ICE credentials and claiming an SFU seat
/// (`POST /api/callsfu/:room/join`) in the background. At accept time,
/// `CallSession._startSfuMedia()` calls [adopt] instead of doing that work
/// cold, so it only has to publish + pull.
///
/// [CALL-PREROLL-1 2026-08-17] Extends the above (gated on the ADDITIONAL
/// `callPrerollV1` flag, on top of `callPrewarmOnRingV1`): instead of
/// stopping at the join, also acquire the mic (track disabled), build an
/// ISOLATED peer connection, PUBLISH (silent — local track stays disabled)
/// and PULL the caller's audio (muted — remote track stays disabled), all
/// during the ring. At accept, [adopt] hands back the whole pre-built
/// transport and `CallSession` only has to flip two `enabled` flags instead
/// of running publish+pull cold — removing the SFU join AND publish AND pull
/// from the accept path, not just the join.
///
/// Privacy: the mic track and the pulled remote track BOTH stay disabled the
/// entire time this class owns them. Nothing is audible to either party and
/// nothing leaves the device until `CallSession` explicitly re-enables them,
/// which only happens once the call is genuinely being answered.
///
/// Gated entirely on `RemoteConfig.callPrewarmOnRingV1` (and, for the preroll
/// extension, additionally `RemoteConfig.callPrerollV1`): every public method
/// is a no-op — or degrades to the P1-only behaviour — while the relevant
/// flag is off, so this class does nothing beyond what already shipped on any
/// build or account until both are flipped on.
///
/// Per-account scoping (CLAUDE.md) does not apply here — this is in-memory
/// only, holds no durable or user-identifying state, and every entry lives
/// for at most tens of seconds (a ring) before being adopted or discarded.
library;

import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../analytics.dart';
import '../audio_tuning.dart' as audio_tuning;
import '../ice_cache.dart';
import '../remote_config.dart';
import 'call_sfu_api.dart';
import 'call_sfu_transport.dart';

/// What [CallPrewarm.adopt] hands back to the caller: a pre-warmed SFU join
/// (may be null if the prewarm join failed or never finished) plus whatever
/// ICE servers were fetched in parallel (falls back to an empty list, exactly
/// like a fresh [IceCache.get] would fall back to `kIceServers` upstream).
///
/// [CALL-PREROLL-1 2026-08-17] The `preroll*` fields are non-null/true only
/// when `callPrerollV1` (+ `callPrewarmOnRingV1`) produced a FULLY pre-rolled
/// media path during the ring — see [hasFullPreroll]. `CallSession` must
/// check that getter, not the individual fields, before treating this as
/// adoptable: any partial combination means the preroll did not finish in
/// time or failed, and must be treated as "P1 only" (or nothing at all).
class CallPrewarmedData {
  CallPrewarmedData({
    required this.join,
    required this.iceServers,
    this.prerollStream,
    this.prerollTransport,
    this.prerollPc,
    this.prerollEarlyTracks = const <RTCTrackEvent>[],
    this.prerollPublished = false,
    this.prerollPulled = false,
  });

  final CallSfuJoinResult? join;
  final List<Map<String, dynamic>> iceServers;

  /// [CALL-PREROLL-1] The mic stream acquired during the ring. Non-null only
  /// when the preroll got as far as `getUserMedia`. `CallSession`'s boot
  /// sequence takes ownership of this via `CallPrewarm.instance.peek` — well
  /// BEFORE this object is ever built — so by the time [adopt] runs, this is
  /// only present here for [CallPrewarm]'s own identity check (see
  /// `adopt`'s doc comment); `CallSession` should never need to read it off
  /// this object directly.
  final MediaStream? prerollStream;

  /// The isolated transport that ran `connectPublish` + `connectPull` during
  /// the ring. Non-null only when a peer connection was built for it.
  final CallSfuTransport? prerollTransport;

  /// The transport's own peer connection, captured separately because
  /// `CallSession` needs it by identity to install handlers on promotion —
  /// see `CallSession._promotePrerollPc`.
  final RTCPeerConnection? prerollPc;

  /// The remote-track events this connection received DURING THE RING —
  /// muted the instant they arrived (see [CallPrewarm]'s own `onTrack`
  /// installation) so nothing was audible before accept. `CallSession`
  /// re-enables and replays each of these through its normal connect ladder
  /// at promotion, since no `onTrack` will ever fire again for a track this
  /// connection already received.
  final List<RTCTrackEvent> prerollEarlyTracks;

  final bool prerollPublished;
  final bool prerollPulled;

  /// True only when every preroll piece is present and BOTH legs succeeded —
  /// the single condition `CallSession` should branch on. Anything less must
  /// be treated as "no preroll" and fall through to the join-only or fully
  /// cold path.
  bool get hasFullPreroll =>
      prerollStream != null &&
      prerollTransport != null &&
      prerollPc != null &&
      prerollPublished &&
      prerollPulled;
}

class _PrewarmEntry {
  _PrewarmEntry(this.callId, this.startedAtMs);

  final String callId;
  final int startedAtMs;

  Future<CallSfuJoinResult?>? joinFuture;
  CallSfuJoinResult? joinResult;
  Future<List<Map<String, dynamic>>>? iceFuture;

  // ── [CALL-PREROLL-1 2026-08-17] ───────────────────────────────────────
  /// Set by [CallPrewarm.discard]/`_closeEntry` the INSTANT teardown starts,
  /// so [CallPrewarm._preroll] (which may be mid-await on a network call at
  /// that moment) notices at its very next checkpoint and stops making
  /// forward progress — never relies on `_entry` still pointing at this
  /// object, because [CallPrewarm.adopt] deliberately clears `_entry` first
  /// (its exactly-once contract) while still wanting `_preroll` to keep
  /// running to completion underneath it.
  bool discarded = false;

  /// Set the instant [CallPrewarm.peek] hands this stream to a booting
  /// `CallSession` — once true, this entry's mic stream is OWNED by that
  /// session (which will dispose it in its own teardown) and must never be
  /// touched by [CallPrewarm]'s own teardown again, even if this entry is
  /// later superseded/discarded before `adopt()` ever runs. Does not protect
  /// [transport]/[prerollPc]: those are only handed over by [CallPrewarm.adopt].
  bool peeked = false;

  MediaStream? micStream;
  CallSfuTransport? transport;
  RTCPeerConnection? prerollPc;
  final List<RTCTrackEvent> earlyTracks = <RTCTrackEvent>[];
  bool prerollPublished = false;
  bool prerollPulled = false;
  Future<void>? prerollFuture;
}

class CallPrewarm {
  CallPrewarm._();

  static final CallPrewarm instance = CallPrewarm._();

  /// [CALL-PREWARM-1] How long a prewarmed entry is considered current. Past
  /// this, `adopt` treats it as absent and tears it down instead.
  ///
  /// Bounded by the SERVER's seat lease, not by taste: `CallRoom`'s
  /// `SFU_LEASE_MS` is 45s and a pre-warmed seat sends NO heartbeats (the
  /// transport's heartbeat only starts after connect). 40s keeps every
  /// adopted seat inside its lease with margin; a slower answer simply falls
  /// back to today's cold join.
  static const int freshWindowMs = 40000;

  _PrewarmEntry? _entry;

  int _nowMs() => DateTime.now().millisecondsSinceEpoch;

  /// Begin warming [callId]'s media path. Fire-and-forget by design — NEVER
  /// await this from the ring/push-handling path; a slow or failed prewarm
  /// must never delay or break showing the incoming-call UI.
  ///
  /// No-op when [callId] is empty or `RemoteConfig.callPrewarmOnRingV1` is
  /// false. If a prewarm for this exact call is already running or ready,
  /// this is a no-op (idempotent — safe to call more than once per ring).
  void start(String callId) {
    if (callId.isEmpty) return;
    if (!RemoteConfig.callPrewarmOnRingV1) return;
    final existing = _entry;
    if (existing != null) {
      if (existing.callId == callId) return; // already warming/ready
      // A different call is still mid-warm — one ring at a time is the norm,
      // but never leak a seat if that assumption is ever wrong.
      unawaited(discard(existing.callId, 'superseded'));
    }
    final entry = _PrewarmEntry(callId, _nowMs());
    _entry = entry;
    try {
      Analytics.capture('call_prewarm_started', {'call_id': callId});
    } catch (_) {/* telemetry must never affect the ring path */}
    entry.iceFuture = IceCache.get();
    entry.joinFuture = _join(entry);
    // [CALL-PREROLL-1 2026-08-17] Extends the join above — inert unless the
    // owner has ALSO flipped `callPrerollV1`. Started here (not chained off
    // `joinFuture`'s completion) only because `_preroll` itself awaits the
    // join/ICE futures first; kicking it off now costs nothing and keeps
    // every future for this entry minted in one place.
    if (RemoteConfig.callPrerollV1) {
      entry.prerollFuture = _preroll(entry);
    }
  }

  Future<CallSfuJoinResult?> _join(_PrewarmEntry entry) async {
    final swStart = _nowMs();
    try {
      final result = await CallSfuApi.join(entry.callId);
      // Superseded/discarded/adopted while the join was in flight — the
      // result is still recorded on the entry object itself (adopt/discard
      // may still be awaiting this exact future), but it must not resurrect
      // an entry that has already been cleared from `_entry`.
      entry.joinResult = result;
      try {
        Analytics.capture('call_prewarm_ready', {
          'call_id': entry.callId,
          'join_ms': _nowMs() - swStart,
        });
      } catch (_) {/* telemetry must never affect the call path */}
      return result;
    } catch (_) {
      // A failed prewarm join must never surface to the user — swallow and
      // let the normal accept-time path run exactly as if this never ran.
      return null;
    }
  }

  /// [CALL-PREROLL-1 2026-08-17] Acquire the mic, build an isolated peer
  /// connection, publish it (silent) and pull the caller's audio (muted) —
  /// all during the ring, all best-effort. Every checkpoint below re-checks
  /// [_PrewarmEntry.discarded] rather than `identical(_entry, entry)`,
  /// because [adopt] clears `_entry` (its exactly-once contract) while this
  /// must be allowed to keep running to completion underneath it; only a
  /// genuine discard/supersede should stop it early.
  Future<void> _preroll(_PrewarmEntry entry) async {
    final swStart = _nowMs();
    try {
      Analytics.capture('call_preroll_started', {'call_id': entry.callId});
    } catch (_) {/* telemetry must never affect the ring path */}
    try {
      final join = await (entry.joinFuture ?? Future<CallSfuJoinResult?>.value(null));
      if (entry.discarded) return;
      if (join == null || join.sessionId.isEmpty) {
        // The plain P1 join already failed/degraded — nothing to build a
        // preroll on top of. Falls through to today's P1-only (or fully
        // cold) accept-time path.
        return;
      }
      final ice = await (entry.iceFuture ?? Future<List<Map<String, dynamic>>>.value(const []));
      if (entry.discarded) return;

      // a. Mic — SILENT from the instant it exists.
      MediaStream stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          'audio': audio_tuning.avaMicConstraints(),
          'video': false,
        });
      } catch (e) {
        try {
          Analytics.capture('call_preroll_failed', {
            'call_id': entry.callId,
            'stage': 'mic',
            'detail': e.toString(),
          });
        } catch (_) {/* telemetry must never affect the ring path */}
        return;
      }
      for (final t in stream.getAudioTracks()) {
        try { t.enabled = false; } catch (_) {/* best-effort silence */}
      }
      entry.micStream = stream; // visible to `_closeEntry` even if we abort below
      if (entry.discarded) return; // `_closeEntry` will dispose `stream` itself

      // b. Isolated peer connection, built through a transport with NO
      // onTrack/onConnectionState wiring beyond the passive cache below —
      // that absence of session behaviour IS the isolation: this connection
      // cannot touch a renderer, a ringback player or a phase notifier,
      // because none of those exist yet (there is no `CallSession` at all
      // while the phone is still ringing).
      RTCPeerConnection? pc;
      final transport = CallSfuTransport(
        room: entry.callId,
        createPeerConnection: (iceServers) async {
          final built = await createPeerConnection({
            'iceServers': iceServers,
            'iceCandidatePoolSize': 2,
            // [CALL-SURVIVE-1] Same jitter-buffer bounds as
            // `CallSession._newPC` — this connection is promoted to be the
            // session's live one verbatim, so its config must already match.
            'audioJitterBufferMaxPackets': 50,
            'audioJitterBufferFastAccelerate': true,
          });
          pc = built;
          entry.prerollPc = built; // visible to `_closeEntry` immediately
          built.onTrack = (e) {
            // CRITICAL: mute the instant it arrives — the callee's phone is
            // still ringing and must not play the caller's voice before
            // accept. Cached (not acted on further) for exactly the same
            // reason `CallSession._prejoinEarlyTracks` exists: nothing here
            // may touch UI/telemetry/phase state, because none of it exists
            // yet — only `CallSession`, once it adopts this connection, may
            // drive that ladder (see `CallSession._promotePrerollPc`).
            try {
              if (e.track.kind == 'audio') e.track.enabled = false;
            } catch (_) {/* best-effort mute */}
            entry.earlyTracks.add(e);
          };
          return built;
        },
        enableRed: RemoteConfig.callAudioRedExperimentV1,
        onStage: (stage) {
          try {
            Analytics.capture('call_preroll_stage', {
              'call_id': entry.callId,
              'stage': stage,
            });
          } catch (_) {/* telemetry must never affect the ring path */}
        },
      );
      entry.transport = transport; // visible to `_closeEntry` immediately
      if (entry.discarded) return; // `_closeEntry` will dispose it

      // c. Publish — silent (the track added above is already disabled).
      final publishFailure = await transport.connectPublish(
        localStream: stream,
        fallbackIceServers: ice,
        video: false,
        prewarmedJoin: join,
      );
      if (entry.discarded) return;
      if (publishFailure != null) {
        try {
          Analytics.capture('call_preroll_failed', {
            'call_id': entry.callId,
            'stage': 'publish',
            'detail': publishFailure.detail ?? publishFailure.failure?.name ?? 'unknown',
          });
        } catch (_) {/* telemetry must never affect the ring path */}
        return;
      }
      entry.prerollPublished = true;

      // d. Pull — muted the instant a track arrives (see the `onTrack` cache
      // installed above). A peer who has not published yet (still ringing on
      // their own side, or hasn't reached ring-time pre-join) is a normal,
      // expected outcome here, not a failure to alarm on.
      final pullResult = await transport.connectPull(video: false);
      if (entry.discarded) return;
      if (!pullResult.connected) {
        try {
          Analytics.capture('call_preroll_failed', {
            'call_id': entry.callId,
            'stage': 'pull',
            'detail': pullResult.detail ?? pullResult.failure?.name ?? 'unknown',
          });
        } catch (_) {/* telemetry must never affect the ring path */}
        return;
      }
      entry.prerollPulled = true;

      try {
        Analytics.capture('call_preroll_ready', {
          'call_id': entry.callId,
          'ms': _nowMs() - swStart,
          'published': true,
          'pulled': true,
        });
      } catch (_) {/* telemetry must never affect the ring path */}
    } catch (e) {
      try {
        Analytics.capture('call_preroll_failed', {
          'call_id': entry.callId,
          'stage': 'unknown',
          'detail': e.toString(),
        });
      } catch (_) {/* telemetry must never affect the ring path */}
    }
  }

  /// [CALL-PREROLL-1 2026-08-17] Peek at [callId]'s pre-rolled mic stream
  /// WITHOUT consuming the entry. `CallSession`'s boot sequence calls this
  /// BEFORE `getUserMedia` so it can skip capture entirely when a preroll
  /// stream already exists — the full entry (join/transport/pc) is still
  /// consumed exactly once, later, via [adopt] in `_startSfuMedia`.
  ///
  /// Returns null whenever there is nothing to hand back (either flag off,
  /// no entry, wrong call, or the preroll hasn't reached a mic yet) — every
  /// one of those falls through to a normal `getUserMedia` call exactly as
  /// today. Safe to call more than once; the second call for the same
  /// already-peeked stream just hands back the same object.
  MediaStream? peek(String callId) {
    if (callId.isEmpty) return null;
    if (!RemoteConfig.callPrewarmOnRingV1 || !RemoteConfig.callPrerollV1) return null;
    final entry = _entry;
    if (entry == null || entry.callId != callId || entry.discarded) return null;
    final stream = entry.micStream;
    if (stream != null) entry.peeked = true;
    return stream;
  }

  /// Returns the prewarmed data for [callId] EXACTLY ONCE — the entry is
  /// cleared on return, win or lose, so a second call can never adopt the
  /// same seat twice. The seat is NOT closed here: the caller now owns it.
  ///
  /// Returns null when there is nothing to adopt, the flag is off, or the
  /// entry is older than [freshWindowMs] — a stale entry is discarded
  /// (seat closed) instead of handed back, per the SAFETY rule.
  ///
  /// [CALL-PREROLL-1 2026-08-17] [currentStream] is `CallSession`'s OWN
  /// `_stream` at the moment it calls this (from `_startSfuMedia`, after its
  /// boot sequence has already run). The returned [CallPrewarmedData] only
  /// carries a full preroll ([CallPrewarmedData.hasFullPreroll]) when its mic
  /// stream is `identical` to [currentStream] — i.e. only when [peek] already
  /// handed this exact object to that session's boot. Any other outcome
  /// (video call, a preroll that never reached a stream, an accept that beat
  /// the preroll to `getUserMedia`) means the local audio actually being
  /// captured is NOT the one the preroll's transport published, so adopting
  /// the transport would publish the wrong track — that combination is
  /// treated as "no full preroll", and whatever preroll resources exist are
  /// disposed right here (never left for `CallSession` to discover it cannot
  /// use) while the plain P1 join/ICE are still handed back as before.
  Future<CallPrewarmedData?> adopt(String callId, {MediaStream? currentStream}) async {
    if (callId.isEmpty) return null;
    if (!RemoteConfig.callPrewarmOnRingV1) return null;
    final entry = _entry;
    if (entry == null || entry.callId != callId) return null;
    final ageMs = _nowMs() - entry.startedAtMs;
    if (ageMs > freshWindowMs) {
      _entry = null;
      unawaited(_closeEntry(entry, 'stale', ageMs));
      return null;
    }
    _entry = null; // exactly once, regardless of what happens below
    CallSfuJoinResult? join;
    final jf = entry.joinFuture;
    if (jf != null) {
      try {
        join = await jf;
      } catch (_) {
        join = null; // _join already swallows, but never let adopt() throw
      }
    }
    List<Map<String, dynamic>> ice = const [];
    final icf = entry.iceFuture;
    if (icf != null) {
      try {
        ice = await icf;
      } catch (_) {
        ice = const [];
      }
    }
    // [CALL-PREROLL-1] Give the preroll a bounded grace window to finish if
    // accept happened while it was still mid-flight — the mic/publish/pull
    // are individually fast, but an accept that lands within a second or two
    // of the push arriving can genuinely race them. Past this, proceed
    // without it exactly as if `callPrerollV1` were off; `_closeEntry`-style
    // cleanup of whatever DID finish happens in the mismatch branch below,
    // not here.
    final pf = entry.prerollFuture;
    if (pf != null) {
      try {
        await pf.timeout(const Duration(seconds: 3), onTimeout: () {});
      } catch (_) {/* adopt() must never throw */}
    }
    final fullyPrerolled = entry.prerollPublished &&
        entry.prerollPulled &&
        entry.micStream != null &&
        entry.transport != null &&
        entry.prerollPc != null;
    final streamMatches =
        fullyPrerolled && currentStream != null && identical(entry.micStream, currentStream);
    CallPrewarmedData data;
    if (streamMatches) {
      data = CallPrewarmedData(
        join: join,
        iceServers: ice,
        prerollStream: entry.micStream,
        prerollTransport: entry.transport,
        prerollPc: entry.prerollPc,
        prerollEarlyTracks: List<RTCTrackEvent>.of(entry.earlyTracks),
        prerollPublished: entry.prerollPublished,
        prerollPulled: entry.prerollPulled,
      );
    } else {
      // Either there was no full preroll, or its stream is not the one this
      // session actually booted with — dispose whatever the preroll built so
      // it is never silently orphaned. The mic stream itself is skipped here
      // ONLY when `entry.peeked` is true: that means `CallSession` already
      // took ownership of it via `peek` and will dispose it in its own
      // teardown, even though (in a video-call or lost-race scenario) the
      // TRANSPORT/PC built around it are still ours to close.
      if (entry.transport != null) {
        try { await entry.transport!.dispose(); } catch (_) {}
      }
      if (entry.prerollPc != null) {
        try { await entry.prerollPc!.close(); } catch (_) {}
      }
      if (entry.micStream != null && !entry.peeked) {
        try {
          for (final t in entry.micStream!.getTracks()) {
            try { await t.stop(); } catch (_) {}
          }
          await entry.micStream!.dispose();
        } catch (_) {}
      }
      data = CallPrewarmedData(join: join, iceServers: ice);
    }
    try {
      Analytics.capture('call_prewarm_adopted', {
        'call_id': callId,
        'age_ms': ageMs,
        'had_join': join != null && join.sessionId.isNotEmpty,
        'full_preroll': streamMatches,
      });
    } catch (_) {/* telemetry must never affect the call path */}
    return data;
  }

  /// Tear down a pre-warmed seat for [callId] because the ring ended without
  /// being adopted — decline, caller cancel, timeout, or a stale entry.
  /// Best-effort and exception-proof: never let teardown surface an error.
  Future<void> discard(String callId, String reason) async {
    if (callId.isEmpty) return;
    final entry = _entry;
    if (entry == null || entry.callId != callId) return;
    _entry = null;
    final ageMs = _nowMs() - entry.startedAtMs;
    await _closeEntry(entry, reason, ageMs);
  }

  Future<void> _closeEntry(_PrewarmEntry entry, String reason, int ageMs) async {
    try {
      Analytics.capture('call_prewarm_discarded', {
        'call_id': entry.callId,
        'reason': reason,
        'age_ms': ageMs,
      });
    } catch (_) {/* telemetry must never affect the ring path */}
    // [CALL-PREROLL-1 2026-08-17] Stop `_preroll` making further progress as
    // early as possible, then let it actually settle before we start closing
    // the resources it may still be mid-write on.
    entry.discarded = true;
    final pf = entry.prerollFuture;
    if (pf != null) {
      try {
        await pf.timeout(const Duration(seconds: 5), onTimeout: () {});
      } catch (_) {/* teardown is unconditional */}
    }
    final transport = entry.transport;
    entry.transport = null;
    if (transport != null) {
      // [CALL-PREROLL-1] The transport owns THIS session's SFU-seat close
      // (with the real mids it published) — skip the plain join-based close
      // below so the seat is closed exactly once, not raced by two
      // independent calls for the same session id.
      try { await transport.dispose(); } catch (_) {/* teardown is unconditional */}
    } else {
      try {
        var join = entry.joinResult;
        join ??= await (entry.joinFuture ?? Future<CallSfuJoinResult?>.value(null))
            .timeout(const Duration(seconds: 3), onTimeout: () => null);
        if (join != null && join.sessionId.isNotEmpty) {
          // CallSfuApi.close is itself best-effort and never throws; no
          // publish happened during prewarm, so there are no mids to report.
          await CallSfuApi.close(entry.callId, join.sessionId, const []);
        }
      } catch (_) {/* teardown is unconditional */}
    }
    // [CALL-PREROLL-1] `transport.dispose()` (above) does NOT close the raw
    // peer connection — same contract as `CallSession`'s own teardown, see
    // `CallSfuTransport.dispose`'s doc comment — so it is always closed here
    // too, in the ordering the privacy-critical teardown contract requires:
    // transport (seat) -> pc -> mic stream.
    final pc = entry.prerollPc;
    entry.prerollPc = null;
    if (pc != null) {
      try { await pc.close(); } catch (_) {/* teardown is unconditional */}
    }
    // [CALL-PREROLL-1] The mic stream is the one resource `peek()` may have
    // already handed to a booting `CallSession` — once `entry.peeked` is
    // true that session owns it and will stop/dispose it in its own
    // teardown; closing it here too would pull the mic out from under a call
    // that is still (or about to be) live. `entry.transport`/`prerollPc`
    // above are NEVER handed over by `peek()` (only `adopt()` does that, and
    // `adopt()` clears `_entry` first so this method can't run afterward),
    // so they are always ours to close regardless of `peeked`.
    final stream = entry.micStream;
    entry.micStream = null;
    if (stream != null && !entry.peeked) {
      try {
        for (final t in stream.getTracks()) {
          try { await t.stop(); } catch (_) {/* keep closing the rest */}
        }
        await stream.dispose();
      } catch (_) {/* teardown is unconditional */}
    }
  }
}
