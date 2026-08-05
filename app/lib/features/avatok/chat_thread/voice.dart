part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadVoice on _ChatThreadScreenState {

  // ---- mic menu: record audio OR convert voice to text ----
  void _openMicMenu() {
    FocusScope.of(context).unfocus();
    showMicInputSheet(context, options: [
      MicSheetOption(
        icon: PhosphorIcons.microphone(PhosphorIconsStyle.fill),
        color: AD.danger,
        title: 'Record audio',
        subtitle: 'Record a voice note and send it',
        onTap: _toggleRecord,
      ),
      MicSheetOption(
        icon: PhosphorIcons.textT(PhosphorIconsStyle.bold),
        color: AD.online,
        title: 'Convert voice to text',
        subtitle: 'Speak and watch it type into the box',
        onTap: _startVoiceToText,
      ),
    ]);
  }

  // Start on-device Whisper dictation — text fills the composer live as you talk.
  // The Whisper model downloads on first use (the "Preparing…" note shows then).
  Future<void> _startVoiceToText() async {
    if (_sttActive || _sttPreparing) return;
    setState(() => _sttPreparing = true);
    _capNote('Preparing voice-to-text…'); // visible feedback while the model loads
    final session = await AvaOnDeviceStt.I.startDictation(
      lang: 'en',
      onText: (t) {
        if (!mounted) return;
        setState(() {
          _ctrl.text = t;
          _ctrl.selection = TextSelection.collapsed(offset: t.length);
          _hasText = t.trim().isNotEmpty;
        });
      },
    );
    if (!mounted) return;
    setState(() => _sttPreparing = false);
    if (session == null) {
      _capNote('Couldn’t start voice-to-text. Try again, or re-enable Ava Voice in Settings.');
      return;
    }
    setState(() { _sttSession = session; _sttActive = true; });
  }

  Future<void> _stopVoiceToText() async {
    final s = _sttSession;
    if (s == null) return;
    setState(() => _sttActive = false);
    final text = await s.stop();
    if (!mounted) return;
    setState(() {
      if (text.isNotEmpty) {
        _ctrl.text = text;
        _ctrl.selection = TextSelection.collapsed(offset: text.length);
        _hasText = text.trim().isNotEmpty;
      }
      _sttSession = null;
    });
    _composerFocus.requestFocus();
  }

  /// Start / stop-and-send. Kept as the mic button's single action.
  Future<void> _toggleRecord() async {
    if (_recording) { await _stopAndSendRecording(); return; }
    if (!await _recorder.hasPermission()) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Microphone permission needed for voice messages')));
      }
      return;
    }
    final dir = await getTemporaryDirectory();
    _recPath = '${dir.path}/vn_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      // Ask the platform for amplitude metering so the live waveform below has
      // something real to draw.
      const RecordConfig(),
      path: _recPath!,
    );
    // [VOICE-REC-1] Hold the screen awake for the whole recording.
    //
    // The owner hit this directly: the screen slept mid-recording, and on a
    // locked device that risks the session being torn down and the take lost.
    // The scenario he named is the one that matters — driving, speaking through
    // a headset, phone untouched in a cradle: the user is producing input
    // continuously, but from the OS's point of view the screen has had no touch
    // for 30s and is idle. It isn't. A recording in progress IS activity, so we
    // say so, exactly like a call does (see call_session.dart).
    //
    // Strictly paired with _releaseRecordingWakelock() on EVERY exit from the
    // recording state (send, cancel, pause-to-background, dispose) — a leaked
    // wakelock is a flat battery.
    try { await WakelockPlus.enable(); } catch (_) {/* unsupported platform */}
    _recAmpSub?.cancel();
    _recAmpSub = _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 80))
        .listen((amp) {
      if (!mounted) return;
      // `current` is dBFS: roughly -60 (silence) → 0 (clipping). Map to 0..1 and
      // give it a floor so a quiet room still shows a living baseline rather
      // than a flat dead line (which would read as "broken").
      final db = amp.current.isFinite ? amp.current : -60.0;
      final level = ((db + 60) / 60).clamp(0.05, 1.0);
      setState(() {
        _recLevels.add(level);
        if (_recLevels.length > _kRecMaxBars) _recLevels.removeAt(0);
      });
    });
    _recTick?.cancel();
    _recTick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || _recPaused) return;
      setState(() => _recElapsed += const Duration(seconds: 1));
    });
    setState(() {
      _recording = true;
      _recPaused = false;
      _recElapsed = Duration.zero;
      _recLevels.clear();
    });
    Analytics.capture('voice_note_record_started', _voiceTelemetry());
  }

  /// Pause / resume — the owner's "am I still recording?" control, and the
  /// mechanism behind auto-pause on backgrounding.
  Future<void> _toggleRecordPause() async {
    if (!_recording) return;
    try {
      if (_recPaused) {
        await _recorder.resume();
        try { await WakelockPlus.enable(); } catch (_) {}
      } else {
        await _recorder.pause();
        // Don't hold the screen awake for a recorder that isn't listening.
        try { await WakelockPlus.disable(); } catch (_) {}
      }
      setState(() => _recPaused = !_recPaused);
      Analytics.capture('voice_note_record_paused', {
        ..._voiceTelemetry(),
        'paused': _recPaused,
        'seconds': _recElapsed.inSeconds,
        'reason': 'user',
      });
    } catch (e) {
      AvaLog.I.log('media', 'voice pause/resume failed: $e');
    }
  }

  /// Discard the take entirely — the bin button. Deliberately does NOT send.
  Future<void> _cancelRecording({String reason = 'user'}) async {
    if (!_recording) return;
    final seconds = _recElapsed.inSeconds;
    // `cancel()` stops the recorder AND deletes the file — the correct call for
    // a discard (`stop()` would leave the abandoned take on disk).
    try { await _recorder.cancel(); } catch (_) {}
    await _endRecordingSession();
    _recPath = null;
    Analytics.capture('voice_note_record_cancelled', {
      ..._voiceTelemetry(), 'seconds': seconds, 'reason': reason,
    });
  }

  // [MEDIA-INSTANT-1d / F10] The optimistic bubble is now created the INSTANT
  // the recorder hands back a file path — the bytes are read into memory
  // asynchronously right after, not before. This is the fix for "stop-to-
  // bubble still waits for the file to be read into memory" (F10): the visual
  // contract now matches "release to send" — the bubble shows immediately.
  Future<void> _stopAndSendRecording() async {
    final seconds = _recElapsed.inSeconds;
    String? path;
    try { path = await _recorder.stop(); } catch (e) {
      AvaLog.I.log('media', 'voice stop failed: $e');
    }
    await _endRecordingSession();
    if (path == null) return;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final tShownStart = DateTime.now().millisecondsSinceEpoch;
    final msg = _Msg(_seq++, true, _caption(MediaKind.audio, 'voice.m4a'), _fmtTime(now),
        ts: now, uploading: true, pendingKind: MediaKind.audio)
      ..sendStartedMs = tShownStart
      ..pendingMime = 'audio/mp4'
      ..pendingFilename = 'voice.m4a'
      ..mediaClientId = _newMediaClientId();
    _mutMsgs(() => _msgs.add(msg));
    _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
    Analytics.capture('msg_optimistic_shown', {
      'kind': 'audio', 'conv_kind': _isGroup ? 'group' : 'dm',
      'ms_to_bubble': DateTime.now().millisecondsSinceEpoch - tShownStart,
    });
    Uint8List bytes;
    try {
      bytes = await File(path).readAsBytes();
    } catch (e) {
      AvaLog.I.log('media', 'voice read FAILED: $e');
      if (mounted) _mutMsgs(() { msg.uploading = false; msg.failed = true; });
      Analytics.capture('voice_note_record_sent', {
        ..._voiceTelemetry(), 'seconds': seconds, 'ok': false, 'error': e.toString(),
      });
      return;
    }
    if (mounted) _mutMsgs(() => msg.localBytes = bytes);
    Analytics.capture('voice_note_record_sent', {
      ..._voiceTelemetry(), 'seconds': seconds, 'bytes': bytes.length,
    });
    // [AVA-VOICE-PLAINTEXT-1] MVP voice notes (owner decision 2026-07-25):
    // while `voiceNoteEncryptionEnabled` is false (the default), a RECORDED
    // voice note uploads plaintext via the server-readable path so Ava can
    // transcribe/translate it. This is the ONLY call site that sets
    // `plaintextVoice` — a generic audio FILE picked from Files/gallery still
    // goes through the ordinary encrypted `_upload` path unaffected.
    await _upload(msg, bytes, MediaKind.audio, 'audio/mp4', 'voice.m4a',
        plaintextVoice: !RemoteConfig.voiceNoteEncryptionEnabled);
  }

  /// The single teardown path for a recording session — every exit routes here
  /// so the wakelock, the metering subscription and the tick can't be orphaned.
  Future<void> _endRecordingSession() async {
    _recAmpSub?.cancel();
    _recAmpSub = null;
    _recTick?.cancel();
    _recTick = null;
    try { await WakelockPlus.disable(); } catch (_) {}
    if (mounted) {
      setState(() {
        _recording = false;
        _recPaused = false;
        _recElapsed = Duration.zero;
        _recLevels.clear();
      });
    } else {
      _recording = false;
      _recPaused = false;
    }
  }

  /// Telemetry tag shared by every voice-note event. Per CLAUDE.md this carries
  /// BOTH ends of the conversation, so either party's email retrieves the
  /// interaction — a voice note is a two-sided event and diagnosing one from a
  /// single device is how you end up looking at the wrong phone.
  /// `Map<String, Object>` (not `dynamic`) to match `Analytics.capture`'s
  /// signature — a `Map<String, dynamic>` would need an implicit downcast, which
  /// Dart 3 rejects. `_myName` is a mutable field so it can't type-promote
  /// inside a null check; the `case final n?` pattern binds it instead.
  Map<String, Object> _voiceTelemetry() => {
        'peer': widget.chat.name,
        'is_group': _isGroup,
        if (_myName case final n?) 'from_name': n,
      };

  /// [AVAVM-PLAYER-1] Stable, globally-unique id for a voice note's playback
  /// track: the server media id once uploaded (content-addressed, matches the
  /// contract's "stable, content-addressed where possible"), else a
  /// conv-scoped fallback for the brief window before upload finishes (that
  /// note is scrubbable/playable locally but not yet resumable across a cold
  /// start under a DIFFERENT id — it gets a real one the moment the upload
  /// completes and `m.media` is set).
  String _audioTrackId(_Msg m) => m.media?.id ?? 'local_${_convKey ?? 'x'}_${m.id}';

  /// Reverse lookup: which (if any) message in THIS thread the shared
  /// service's currently-loaded track belongs to. A linear scan is fine here
  /// — it only runs on a playback-state change, not per frame, and thread
  /// message lists are not large enough for this to matter.
  int? _msgIdForTrackId(String trackId) {
    for (final m in _msgs) {
      if (_audioTrackId(m) == trackId) return m.id;
    }
    return null;
  }

  /// [AVAVM-PLAYER-1] Fired whenever `AudioPlaybackService.I.state` changes —
  /// on play/pause/resume/seek/complete/stop, AND on THIS listener's own
  /// installation (so reopening a thread whose voice note is already playing
  /// in the background — via the mini-player — immediately shows it playing
  /// here too, instead of looking idle until the next tick).
  void _onAudioStateChanged() {
    if (!mounted) return;
    final st = AudioPlaybackService.I.state.value;
    if (st == null) {
      if (_playingAudioId != null || _openAudioId != null) {
        setState(() {
          _prevAudioRowId = _playingAudioId ?? _openAudioId;
          _playingAudioId = null;
          _openAudioId = null;
          _audioTick++;
        });
      }
      return;
    }
    final msgId = _msgIdForTrackId(st.track.trackId);
    if (msgId == null) {
      // The loaded/playing track belongs to a different thread — nothing of
      // OURS is open, even if something elsewhere is playing.
      if (_playingAudioId != null || _openAudioId != null) {
        setState(() {
          _prevAudioRowId = _playingAudioId ?? _openAudioId;
          _playingAudioId = null;
          _openAudioId = null;
          _audioTick++;
        });
      }
      return;
    }
    setState(() {
      if (_openAudioId != msgId) _prevAudioRowId = _openAudioId ?? _playingAudioId;
      _openAudioId = msgId;
      _playingAudioId = st.playing ? msgId : null;
      _audioPos = st.position;
      _audioDur = st.duration;
      _audioTick++;
    });
  }

  /// [VOICE-SCRUB-1] Seek the currently-open note. Driven by a tap or drag on
  /// the bubble's waveform — this is the "I only want to hear the end" case the
  /// owner asked for, which was previously impossible: the only gesture on a
  /// voice note was play/pause, so reaching the last 5 seconds of a 3-minute
  /// note meant listening to the first 2:55 of it.
  Future<void> _seekAudio(_Msg m, Duration to) async {
    // Scrubbing works on the OPEN note, playing or paused — pausing to drag the
    // playhead around is the natural gesture, and refusing to seek while paused
    // would make the timeline feel broken exactly when you're using it most.
    if (_openAudioId != m.id) return;
    // Paint the new position immediately rather than waiting for the next
    // position callback, so the red playhead lands under the finger.
    if (mounted) setState(() { _audioPos = to; _audioTick++; });
    await AudioPlaybackService.I.seek(to);
  }

  /// [AVAVM-PLAYER-1] Voice-note play/pause, now routed through the shared
  /// `AudioPlaybackService` so playback (and the app-wide mini-player) keeps
  /// going after the user navigates away from this thread — previously this
  /// used a per-thread `AudioPlayer()` that died the instant the widget was
  /// disposed, which is exactly the "player stops when I leave the chat"
  /// report this issue fixes.
  Future<void> _playAudio(_Msg m) async {
    final trackId = _audioTrackId(m);
    if (_playingAudioId == m.id) {
      // [VOICE-SCRUB-1] Pause rather than stop — pausing holds the position
      // (including anywhere the user just scrubbed to); `stop()` would zero it.
      await AudioPlaybackService.I.pause();
      return; // _onAudioStateChanged updates _playingAudioId
    }
    // Resume the note that's already loaded in the shared player (paused, or
    // parked where the user scrubbed to) instead of re-downloading, rewriting
    // the temp file and restarting it from 0:00.
    if (_openAudioId == m.id && AudioPlaybackService.I.isCurrent(trackId)) {
      await AudioPlaybackService.I.play(
        track: AudioTrack(
          trackId: trackId,
          title: widget.chat.name,
          subtitle: 'Voice note',
          originRoute: _convKey,
        ),
        bytes: m.localBytes ?? Uint8List(0), // ignored on the resume-in-place path
        startAt: _audioPos,
      );
      await AudioPlaybackService.I.setSpeed(_audioSpeed);
      return;
    }
    try {
      final bytes = m.localBytes ?? (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (bytes == null) return;
      await AudioPlaybackService.I.play(
        track: AudioTrack(
          trackId: trackId,
          title: widget.chat.name,
          subtitle: 'Voice note',
          originRoute: _convKey,
        ),
        bytes: bytes,
      );
      // [UI-BUBBLE-3] honour the chosen playback speed for this note.
      await AudioPlaybackService.I.setSpeed(_audioSpeed);
      Analytics.capture('voice_note_played', {..._voiceTelemetry(), 'speed': _audioSpeed});
    } catch (e) {
      AvaLog.I.log('media', 'voice play failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't play this voice message")));
      }
    }
  }

  /// [UI-BUBBLE-3] Cycle the voice-note playback speed 1x → 1.5x → 2x → 1x. When a
  /// note is currently playing, apply the new rate live.
  void _cycleAudioSpeed() {
    const steps = [1.0, 1.5, 2.0];
    final next = steps[(steps.indexOf(_audioSpeed) + 1) % steps.length];
    setState(() { _audioSpeed = next; _audioTick++; });
    if (_playingAudioId != null) {
      AudioPlaybackService.I.setSpeed(next);
    }
    Analytics.capture('voice_note_speed', {'speed': next});
  }

  // ---- voice-note Transcribe + Translate ------------------------------------
  // A voice note is an audio-kind media bubble (recorded via the mic composer).
  bool _isVoiceNote(_Msg m) =>
      m.media?.kind == MediaKind.audio && m.special == null;

  /// Stable per-message cache key: the durable rumor id when present, else the
  /// local monotonic id. Matches the scheme used by inline text translation.
  String _msgCacheKey(_Msg m) => m.evId ?? '${m.id}';

  /// [AVA-AUDIO-ARTIFACT-1] SUPERSEDED by the job-based `_transcribeVoice`/
  /// `_translateVoice` above (Part VI §39/§46: the inline-only result this
  /// produced was the exact "no durable artifact" gap the audio job pipeline
  /// exists to fix). No longer called from the context menu; kept in place
  /// (not deleted — §49 "only remove after the new path is live and
  /// verified") since `m.extra['transcript']`/`extra['transcript_translated']`
  /// rendering at the voice-bubble level still reads whatever a message
  /// already has cached from before this change.
  ///
  /// Fetch the DECRYPTED voice bytes (local-first, per-account MediaService
  /// cache), POST them to the existing cloud-Whisper transcribe route, and cache
  /// the transcript per message (account-scoped). Returns '' on failure. The
  /// transcript is stashed on m.extra['transcript'] so the bubble renders it.
  Future<String> _ensureTranscript(_Msg m) async {
    final key = _msgCacheKey(m);
    // 1) Already on the message this session.
    final live = (m.extra?['transcript'] as String?)?.trim();
    if (live != null && live.isNotEmpty) return live;
    // 2) Per-account disk cache (never re-transcribe on reopen).
    final cached = await _msgStore.readTranscript(key);
    if (cached != null && cached.trim().isNotEmpty) {
      if (mounted) _mutMsgs(() => (m.extra ??= <String, dynamic>{})['transcript'] = cached);
      return cached;
    }
    // 3) Transcribe: decrypted bytes → /api/stt/transcribe (same route the
    //    composer's cloud dictation uses). Voice notes are m4a/AAC.
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      final bytes = m.localBytes ??
          (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (bytes == null || bytes.isEmpty) {
        Analytics.capture('voice_transcribe', {'ok': false, 'reason': 'no_bytes'});
        return '';
      }
      final r = await ApiAuth.postJson(
        '$kApiBase/stt/transcribe',
        {'audio': base64Encode(bytes), 'format': 'm4a'},
        timeout: const Duration(seconds: 45),
      );
      final ms = DateTime.now().millisecondsSinceEpoch - t0;
      if (r.statusCode != 200) {
        AvaLog.I.log('voice_stt', 'transcribe HTTP ${r.statusCode}: ${r.body}');
        Analytics.capture('voice_transcribe', {'ok': false, 'status': r.statusCode, 'ms': ms});
        return '';
      }
      final decoded = jsonDecode(r.body);
      final text = (decoded is Map && decoded['text'] is String)
          ? (decoded['text'] as String).trim()
          : '';
      Analytics.capture('voice_transcribe', {'ok': text.isNotEmpty, 'ms': ms, 'chars': text.length});
      if (text.isEmpty) return '';
      try { await _msgStore.writeTranscript(key, text); } catch (_) {}
      if (mounted) _mutMsgs(() => (m.extra ??= <String, dynamic>{})['transcript'] = text);
      return text;
    } catch (e) {
      final ms = DateTime.now().millisecondsSinceEpoch - t0;
      AvaLog.I.log('voice_stt', 'transcribe FAILED: $e');
      Analytics.capture('voice_transcribe', {'ok': false, 'reason': 'exception', 'ms': ms});
      return '';
    }
  }

  /// [AVA-AUDIO-ARTIFACT-1] Long-press → Transcribe: create a durable
  /// `audio_transcribe` AiMediaJob (Part VI §39/§46) instead of the old
  /// inline-only Whisper call (`_ensureTranscript`, kept above for its
  /// disk-cache helpers — SUPERSEDED, no longer called from here). The
  /// transcript lands as a downloadable/shareable artifact card that survives
  /// the app being backgrounded/reconnected. The source voice note is NEVER
  /// replaced or removed.
  ///
  /// [AVA-VOICE-PLAINTEXT-1] Defect #5 fix: an OLD voice note sent while
  /// encryption was still on (`m.media.storage != 'digital'`) is client-side
  /// AES-GCM ciphertext — the server has no way to read it, so a job created
  /// against it could only fail opaquely. Caught HERE, before spending a
  /// wallet reservation on a job that can never succeed: an honest, specific
  /// toast, never a hang or a silent no-op.
  Future<void> _transcribeVoice(_Msg m) async {
    if (m.media?.storage != 'digital') {
      _toast('This voice note was sent encrypted — ask them to resend it.');
      return;
    }
    final mediaId = m.media?.id;
    if (mediaId == null || mediaId.isEmpty) {
      _toast("This voice note hasn't finished sending yet — try again in a moment.");
      return;
    }
    final convId = _serverConvId ?? _convKey;
    if (convId == null) return;
    Analytics.capture('voice_transcribe_job_requested', {'kind': 'audio_transcribe'});
    final outcome = await AiMediaJobRepository.I.create(
      convId: convId,
      kind: AiMediaJobKind.audioTranscribe,
      sourceMediaId: mediaId,
      label: 'Converting to text…',
    );
    _handleJobOutcome(outcome);
  }

  /// [AVA-AUDIO-ARTIFACT-1] Long-press → Translate a voice note: pick a
  /// language, then create a durable `audio_translate` AiMediaJob (transcript
  /// → translated TTS audio file, Part VI §39/§46). Same job-card contract as
  /// [_transcribeVoice] — including the same honest encrypted-note guard —
  /// and the original recording is never replaced or removed.
  Future<void> _translateVoice(_Msg m) async {
    if (m.media?.storage != 'digital') {
      _toast('This voice note was sent encrypted — ask them to resend it.');
      return;
    }
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to translate.');
      return;
    }
    final mediaId = m.media?.id;
    if (mediaId == null || mediaId.isEmpty) {
      _toast("This voice note hasn't finished sending yet — try again in a moment.");
      return;
    }
    // Reuse the shared language picker sheet.
    final picked = await _pickVoiceLang();
    if (picked == null || !mounted) return;
    final convId = _serverConvId ?? _convKey;
    if (convId == null) return;
    Analytics.capture('voice_translate_job_requested', {'kind': 'audio_translate', 'lang': picked.code});
    final outcome = await AiMediaJobRepository.I.create(
      convId: convId,
      kind: AiMediaJobKind.audioTranslate,
      sourceMediaId: mediaId,
      targetLanguage: picked.code,
      label: 'Translating to ${picked.label}…',
    );
    _handleJobOutcome(outcome);
  }

  /// Language picker for voice-note translation — same list/sheet style as the
  /// composer Translate picker, but returns the chosen language instead of
  /// remembering it as the composer target.
  Future<ComposerLang?> _pickVoiceLang() => showModalBottomSheet<ComposerLang>(
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
                      onTap: () => Navigator.pop(ctx, l),
                    ),
                ],
              ),
            ),
          ]),
        ),
      );

  /// Stash the transcript translation on the message so the bubble renders it
  /// as "translated (Language)" below the voice waveform. Viewer-only.
  void _showVoiceTranslation(_Msg m, String translated, String langLabel) {
    _mutMsgs(() {
      (m.extra ??= <String, dynamic>{})['transcript_translated'] = translated;
      m.extra!['transcript_translated_lang'] = langLabel;
    });
  }
}
