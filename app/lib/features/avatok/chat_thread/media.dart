part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadMedia on _ChatThreadScreenState {

  /// Full-screen, pinch-to-zoom view of a generated image.
  void _openImageFull(String url) {
    showDialog<void>(
      context: context,
      builder: (dctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(children: [
          InteractiveViewer(
            minScale: 0.8,
            maxScale: 4,
            child: Center(
              // AI artifacts use signed private-read URLs; never send those
              // through the public Cloudflare image transformer.
              child: Image.network(url,
                  errorBuilder: (_, __, ___) => const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Image unavailable',
                          style: TextStyle(color: Colors.white)))),
            ),
          ),
          Positioned(
            top: 8, right: 8,
            child: IconButton(
              icon: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold), color: Colors.white),
              onPressed: () => Navigator.of(dctx).maybePop(),
            ),
          ),
        ]),
      ),
    );
  }

  /// Full-screen, pinch-to-zoom view of a DECRYPTED chat photo (received or
  /// sent). Tap any photo bubble to open it in-session; an X closes it and a
  /// copy button puts the image on the clipboard so it can be pasted elsewhere.
  /// [CHAT-UI-VIEWER-1] Fullscreen viewer — HARD CUT, no transition.
  ///
  /// [UI-NOMOTION-1 2026-08-06] This used to open with THREE stacked effects,
  /// and the owner's screenshot caught all three in one frame — the same photo
  /// drawn twice at different sizes with the thread's bubbles ghosting through:
  ///
  ///   1. `opaque: false` kept the chat thread route mounted and PAINTING
  ///      underneath for the whole 220ms. That is the ghosted bubbles.
  ///   2. `FadeTransition(opacity: anim)` wrapped the entire viewer page, so
  ///      the destination image was painted at partial opacity.
  ///   3. A `Hero` flight painted a THIRD copy in the Navigator overlay at an
  ///      interpolated rect — a different size again, because the thumbnail is
  ///      `fit: cover` at width 220 while the viewer is unconstrained.
  ///
  /// Now: opaque route, zero-duration both ways, no fade, no hero (the Hero
  /// wrappers are gone from `bubbles.dart` / `chat_media_cards.dart` too).
  /// [heroTag] is accepted and IGNORED so no call site breaks; do not re-wire
  /// it. Swipe-down-to-dismiss and pinch-to-zoom are unaffected — those live in
  /// `_FullscreenImageViewer` and are driven by gesture, not by a controller.
  void _openImageBytes(Uint8List bytes, {String? mime, Object? heroTag}) {
    Analytics.capture('chat_image_open', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'size': bytes.length,
    });
    Navigator.of(context).push(PageRouteBuilder<void>(
      // opaque: true (the default) — the viewer is a full black Scaffold, so
      // nothing underneath should be composited. This is what stops the thread
      // showing through.
      barrierColor: Colors.black,
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
      pageBuilder: (pctx, anim, __) => _FullscreenImageViewer(
        bytes: bytes,
        onCopy: () => _copyImageBytes(bytes, mime: mime),
        onDecodeError: () => Analytics.capture('chat_media_load_failed', {
          'kind': 'image', 'reason': 'decode_failed', 'stage': 'fullscreen_view',
          'conv_kind': _isGroup ? 'group' : 'dm',
        }),
      ),
    ));
  }

  /// Put a chat image on the system clipboard so it can be pasted into another
  /// app. Flutter's built-in Clipboard is text-only, so this uses super_clipboard
  /// (Formats.png / Formats.jpeg). Degrades gracefully where unsupported.
  Future<void> _copyImageBytes(Uint8List bytes, {String? mime}) async {
    final clipboard = SystemClipboard.instance;
    if (clipboard == null) {
      _capNote('Copying images isn’t supported on this device.');
      return;
    }
    // Label by real format: PNG magic (‰PNG) or the declared mime, else JPEG.
    final isPng = (mime?.toLowerCase().contains('png') ?? false) ||
        (bytes.length > 4 && bytes[0] == 0x89 && bytes[1] == 0x50 &&
            bytes[2] == 0x4E && bytes[3] == 0x47);
    try {
      final item = DataWriterItem();
      item.add(isPng ? Formats.png(bytes) : Formats.jpeg(bytes));
      await clipboard.write([item]);
      HapticFeedback.selectionClick();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Image copied'), duration: Duration(seconds: 1)));
      }
      Analytics.capture('chat_image_copied', {
        'mime': isPng ? 'image/png' : 'image/jpeg',
        'size': bytes.length,
      });
    } catch (e) {
      _capNote('Couldn’t copy the image.');
      Analytics.capture('chat_image_copy_failed', {'err': e.toString()});
    }
  }

  /// Load a message's image bytes and copy it to the clipboard. Handles both a
  /// real chat photo (cached or decrypt) and an Ava-generated image (fetched
  /// from its public `media_ref` URL).
  Future<void> _copyImageFromMsg(_Msg m) async {
    Uint8List? bytes = m.localBytes;
    String? mime = m.media?.contentType;
    if (bytes == null && m.media != null) {
      bytes = await MediaService.downloadAndDecrypt(m.media!);
    }
    if (bytes == null) {
      final url = _imageRefOf(m);
      if (url.isNotEmpty) {
        try {
          final res = await http.get(Uri.parse(url));
          if (res.statusCode == 200) {
            bytes = res.bodyBytes;
            mime = res.headers['content-type'] ?? mime;
          }
        } catch (_) {}
      }
    }
    if (bytes == null) { _capNote('Could not load this image.'); return; }
    if (m.media != null) m.localBytes = bytes; // cache real chat media only
    await _copyImageBytes(bytes, mime: mime);
  }

  /// Download the FULL-RESOLUTION image (the stored public URL is already the
  /// full-res PNG; the in-chat preview is just display-sized) and hand it to the
  /// OS share sheet so the user can save it to Photos or send it on.
  Future<void> _downloadImage(String url, {bool share = false}) async {
    try {
      final res = await http.get(Uri.parse(url));
      if (res.statusCode != 200) throw 'http ${res.statusCode}';
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/ava_image_${DateTime.now().millisecondsSinceEpoch}.png');
      await f.writeAsBytes(res.bodyBytes, flush: true);
      await Share.shareXFiles([XFile(f.path)], subject: 'Ava image');
      Analytics.capture('ava_image_download', {'ok': true, 'share': share});
    } catch (e, st) {
      // [AVA-MEDIA-AUTHZ-1] `url` can be a presigned artifact URL (a job's
      // imageGenerate result) — never let its signature ride in a free-text
      // `toString()`; classified type here, full scrub via captureException.
      Analytics.capture('ava_image_download', {'ok': false, 'error': e.runtimeType.toString()});
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'stage': 'download_image', 'share': share});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't download the image")));
      }
    }
  }

  /// Export a chat media message (image / video / file / voice note) to the OS
  /// share sheet so it can be sent to WhatsApp, Files, etc. Decrypts/loads the
  /// bytes on-device, writes a temp file with a sensible name + extension, and
  /// hands it to share_plus. This is what was missing for voice recordings —
  /// Forward only sent in-app; there was no way OUT to another app.
  Future<void> _shareMedia(_Msg m) async {
    try {
      Uint8List? bytes = m.localBytes;
      if (bytes == null && m.media != null) {
        bytes = await MediaService.downloadAndDecrypt(m.media!);
      }
      if (bytes == null) { _capNote('Could not load this attachment to share.'); return; }
      final ct = m.media?.contentType ?? '';
      // [AVAVM-PLAYER-1] Same guessing bug as `_mediaContent` — prefer the
      // real `pendingKind` stamped at send time over inferring `image` from
      // `localBytes != null` alone (wrong for an in-flight voice note/video).
      final kind = m.media?.kind ?? m.pendingKind ??
          (m.localBytes != null ? MediaKind.image : MediaKind.file);
      final ext = _extFor(ct, kind);
      final base = (m.media?.name ?? '').trim();
      final safe = base.isNotEmpty && base.contains('.')
          ? base
          : 'avatok_${DateTime.now().millisecondsSinceEpoch}$ext';
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/$safe');
      await f.writeAsBytes(bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: ct.isEmpty ? null : ct)]);
      Analytics.capture('chat_media_shared_out', {'kind': kind.name, 'ok': true});
    } catch (e, st) {
      // [AVA-MEDIA-AUTHZ-1] `downloadAndDecrypt` can rethrow a fetch failure
      // whose toString() carries a presigned URL (digital/plaintext storage) —
      // classified type only, full scrub via captureException.
      Analytics.capture('chat_media_shared_out', {'ok': false, 'error': e.runtimeType.toString()});
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'stage': 'share_media'});
      if (mounted) _capNote('Couldn’t share this attachment.');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [AVA-MEDIA-JOB-2] / [AVA-IMAGE-UX-1] / [AVA-DOC-ARTIFACT-1] /
  // [AVA-AUDIO-ARTIFACT-1] — durable AI media job wiring.
  //
  // Root cause (Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md Part VI
  // §36-§37): image generation, PDF summarize/translate and audio transcribe/
  // translate each invented their own transient, unaddressable status row, and
  // a global `removeWhere(special == 'ava_status')` on the next Ava answer
  // could wipe a still-running job's placeholder. Every job now renders as a
  // `special: 'ai_job'` message (see `_aiJobBubble`/`_bubble`) keyed ONLY by
  // `job_id` — a wholly different `_Msg.special` value from `'ava_status'`, so
  // the legacy sweep near `_bindLocalAva`/`_bindAvaStream` structurally cannot
  // touch it, regardless of how many other messages arrive in between.
  // ─────────────────────────────────────────────────────────────────────────

  /// Hydrate + reconcile [convId]'s jobs, then seed only work that is still in
  /// progress. Terminal jobs are restored by their original lifecycle envelope
  /// in the message timeline; injecting every historical job here creates a
  /// second, media-only timeline and buries the user's text history.
  Future<void> _openAiJobs(String convId) async {
    await AiMediaJobRepository.I.openConversation(convId);
    if (!mounted) return;
    for (final j in AiMediaJobRepository.I.jobsFor(convId).where((j) => j.isWorking)) {
      _upsertJobMessage(j);
    }
  }

  /// A server-side Venice submit/completion envelope is only a lifecycle
  /// signal. The durable job card is the single visual representation, so the
  /// text envelope itself must not create a duplicate chat bubble.
  Future<void> _hydrateAiJobFromEnvelope(Map<String, dynamic>? extra) async {
    final meta = extra?['meta'];
    if (meta is! Map) return;
    final jobId = (meta['job_id'] ?? '').toString();
    final kind = (meta['media_job_kind'] ?? '').toString();
    if (jobId.isEmpty || kind.isEmpty) return;
    final convId = _serverConvId ?? _convKey;
    if (convId == null || convId.isEmpty) return;
    // [AVA-JOB-PRESENCE-1] Put a real repository-backed card on screen before
    // waiting for the network. It is immediately persisted per account and
    // starts the normal reconciliation loop. The authoritative GET below can
    // refine/finish it, but can no longer be a single point of visual failure.
    final rawCreatedAt = meta['job_created_at'];
    final createdAtMs = rawCreatedAt is num ? rawCreatedAt.toInt() : int.tryParse('$rawCreatedAt');
    final provisional = AiMediaJobRepository.I.seedPendingFromEnvelope(
      jobId: jobId,
      kind: kind,
      convId: convId,
      label: (meta['job_label'] ?? '').toString(),
      createdAt: createdAtMs == null ? null : (createdAtMs > 100000000000 ? createdAtMs ~/ 1000 : createdAtMs),
    );
    if (!mounted) return;
    _upsertJobMessage(provisional);
    Analytics.capture('creative_job_card_seen', {
      'job_id': jobId,
      'media_kind': kind,
      'source': 'job_envelope',
    });
    _clearAvaWorking('job_card');
    final job = await AiMediaJobRepository.I.fetch(jobId);
    if (!mounted || job == null) return; // provisional card + polling stay live
    _upsertJobMessage(job);
  }

  /// Bind the app-wide job-update stream once. Filters to THIS conversation at
  /// EVENT time (`_serverConvId ?? _convKey`), so it's safe to call this before
  /// either is resolved — see `initState`.
  void _bindAiJobs() {
    _aiJobsSub?.cancel();
    _aiJobsSub = AiMediaJobRepository.I.updates.listen((u) {
      if (!mounted) return;
      final convId = _serverConvId ?? _convKey;
      if (convId == null) return;
      if (u.removed) {
        // A removal carries no job/convId — only act if WE currently have a
        // card for this job_id, so a removal for another open thread's job
        // (the repository is a single app-wide singleton) is a no-op here.
        final hadCard = _msgs.any((m) => m.special == 'ai_job' && m.extra?['job_id'] == u.jobId);
        if (hadCard) _removeJobMessage(u.jobId);
        return;
      }
      final job = u.job;
      if (job == null || job.convId != convId) return;
      // Terminal jobs may update a card already anchored by a lifecycle
      // envelope, but repository hydration must never manufacture a new row.
      final hasCard = _msgs.any(
          (m) => m.special == 'ai_job' && m.extra?['job_id'] == job.jobId);
      if (job.isTerminal && !hasCard) return;
      _upsertJobMessage(job);
    });
  }

  /// Insert a `special: 'ai_job'` placeholder message for [job], keyed ONLY by
  /// `job_id` in `extra`. The card itself always reads LIVE state via
  /// `AiMediaJobRepository.I.byId()` at render time (see `_aiJobBubble`), so
  /// there is nothing else to mutate on an update; the `_mutMsgs` wrapper
  /// alone invalidates the per-row cache and repaints the card with the job's
  /// new state.
  void _upsertJobMessage(AiMediaJob job) {
    _mutMsgs(() {
      // The legacy image producer emits an early ava_status card before the
      // durable job id exists. Once the job card is hydrated, retire that
      // duplicate so the animated job card is the only lifecycle surface.
      if (job.kind == AiMediaJobKind.imageGenerate) {
        _msgs.removeWhere((m) => m.special == 'ava_status' && (
            (m.extra?['source'] ?? '').toString() == 'image' ||
            (m.extra?['label'] ?? '').toString().toLowerCase().contains('image') ||
            m.text.toLowerCase().contains('image')));
      }
      // The old wire format also carried the completed/submitted media job as
      // an ordinary Ava reply. Remove that legacy rendering for THIS job only:
      // a durable card is now the one visual representation for image, video,
      // and music jobs alike. Non-job Ava replies and envelopes for another job
      // remain untouched, preserving normal chat history and server fallback.
      _msgs.removeWhere((m) {
        if (m.special != 'ava' && m.special != 'ava_private') return false;
        final meta = m.extra?['meta'];
        return meta is Map && (meta['job_id'] ?? '').toString() == job.jobId;
      });
      final i = _msgs.indexWhere((m) => m.special == 'ai_job' && m.extra?['job_id'] == job.jobId);
      if (i >= 0) return; // card already placed; _aiJobBubble reads fresh state every rebuild
      _msgs.add(_Msg(_seq++, false, '', _fmtTime(job.createdAt),
          ts: job.createdAt, special: 'ai_job', extra: {'job_id': job.jobId}));
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
  }

  Future<void> _prepareMusicForDisplay(AiMediaJob job) async {
    if (_musicReadyJobIds.contains(job.jobId) ||
        !_musicPreparingJobIds.add(job.jobId)) return;
    final started = DateTime.now().millisecondsSinceEpoch;
    try {
      final audioId = job.artifactMediaId;
      final coverId = job.coverMediaId;
      final audioUrl = job.artifactUrl;
      final coverUrl = job.coverUrl;
      if (audioId == null || audioId.isEmpty || coverId == null || coverId.isEmpty ||
          audioUrl == null || audioUrl.isEmpty || coverUrl == null || coverUrl.isEmpty) {
        throw StateError('music_assets_not_ready');
      }

      var audio = await MediaService.cachedBlob(audioId);
      if (audio == null) {
        final fetched = await _fetchArtifactBytes(audioUrl);
        audio = fetched.$1;
        await MediaService.writeBlob(audioId, audio);
      }
      var cover = await MediaService.cachedBlob(coverId);
      if (cover == null) {
        final fetched = await _fetchArtifactBytes(coverUrl);
        cover = fetched.$1;
        await MediaService.writeBlob(coverId, cover);
      }
      if (!mounted) return;
      _musicCoverBytes[job.jobId] = cover;
      _musicReadyJobIds.add(job.jobId);
      _musicPrepareAttempts.remove(job.jobId);
      Analytics.capture('music_card_ready_on_device', {
        'job_id': job.jobId,
        'audio_bytes': audio.length,
        'cover_bytes': cover.length,
        'prepare_ms': DateTime.now().millisecondsSinceEpoch - started,
      });
      _mutMsgs(() {});
    } catch (error) {
      final attempt = (_musicPrepareAttempts[job.jobId] ?? 0) + 1;
      _musicPrepareAttempts[job.jobId] = attempt;
      Analytics.capture('music_card_prepare_waiting', {
        'job_id': job.jobId,
        'attempt': attempt,
        'error': error.runtimeType.toString(),
      });
      if (mounted && attempt < 12) {
        Future<void>.delayed(const Duration(seconds: 5), () async {
          if (!mounted) return;
          final fresh = await AiMediaJobRepository.I.fetch(job.jobId) ?? job;
          await _prepareMusicForDisplay(fresh);
        });
      }
    } finally {
      _musicPreparingJobIds.remove(job.jobId);
    }
  }

  /// Remove the placeholder message for job [jobId] (explicit local delete —
  /// see `_deleteJobArtifact`). Never touches any other message.
  void _removeJobMessage(String jobId) {
    _mutMsgs(() => _msgs.removeWhere((m) => m.special == 'ai_job' && m.extra?['job_id'] == jobId));
  }

  /// Shared outcome handler for EVERY `AiMediaJobRepository.create()` call in
  /// this thread (image/doc/audio) — including the ones inside
  /// [AvaDocActions] (wired via its `onOutcome` param). CLAUDE.md's central
  /// lesson: an HTTP 402 must NEVER render as a generic failure or a "could
  /// not find an answer" — so it gets its own truthful copy with the
  /// server-reported needed/balance numbers, distinct from every other
  /// failure path.
  void _handleJobOutcome(AiMediaJobCreateOutcome outcome) {
    if (!mounted) return;
    if (outcome.ok) {
      _upsertJobMessage(outcome.job!);
      return;
    }
    if (outcome.insufficientTokens) {
      final needed = outcome.tokensNeeded;
      final balance = outcome.tokensBalance;
      final detail = (needed != null && balance != null) ? ' (need $needed · you have $balance)' : '';
      _toast("You're out of tokens$detail — top up to continue.");
      return;
    }
    _toast("Couldn't start that — try again in a moment.");
  }

  /// [AVA-MEDIA-JOB-2] EVERY open/download/share/save/play action re-fetches
  /// the job first (`GET /api/ai/jobs/:id`) rather than trusting whatever
  /// `artifact_url` a widget was last built with — the server contract mints a
  /// FRESH 900-second presigned URL on every read (never persists one), so a
  /// card that has sat on screen for more than ~15 minutes would otherwise
  /// hand a downloader/browser an expired link. This also sidesteps the
  /// parked attempt's defect #2 (`_msgForMedia` compared a ciphertext hash
  /// against a UUID and never matched, so every action said "still syncing"
  /// forever): there is no local-message correlation step at all any more —
  /// `artifact_url` is the one thing every action needs.
  Future<String?> _freshArtifactUrl(AiMediaJob job) async {
    final fresh = await AiMediaJobRepository.I.fetch(job.jobId);
    final url = fresh?.artifactUrl;
    if (url == null || url.isEmpty) {
      if (mounted) _toast("Couldn't load — try again in a moment.");
      return null;
    }
    return url;
  }

  /// Fetch [url]'s bytes + its real MIME type off the HTTP response's
  /// Content-Type header. The job object itself carries no filename/mime —
  /// the server sets Content-Type from the artifact's stored
  /// `user_media.mime_type` at registration time (worker/src/routes/media.ts
  /// `registerArtifactMedia`), so reading it off the response is the one
  /// reliable source rather than guessing an extension from the job kind.
  Future<(Uint8List, String)> _fetchArtifactBytes(String url) async {
    final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 60));
    if (res.statusCode != 200) throw 'http ${res.statusCode}';
    final mime = (res.headers['content-type'] ?? '').split(';').first.trim();
    // [MEDIA-CARD-SAFE-1] `bodyBytes` is ALREADY a Uint8List. The old
    // `Uint8List.fromList(...)` made a second full copy of every artifact, so a
    // 3-minute song or a generated video briefly occupied twice its size in
    // heap — on the file-share fallback path that copy sits alongside the
    // original AND the cover, which is the kind of pressure that gets an app
    // killed by Android rather than throwing a catchable Dart error.
    return (res.bodyBytes, mime);
  }

  String _extForArtifactMime(String mime) {
    final m = mime.toLowerCase();
    if (m.contains('pdf')) return 'pdf';
    if (m.contains('markdown')) return 'md';
    if (m.contains('plain')) return 'txt';
    if (m.contains('png')) return 'png';
    if (m.contains('jpeg') || m.contains('jpg')) return 'jpg';
    if (m.contains('mp4')) return 'mp4';
    if (m.contains('m4a') || m.contains('aac')) return 'm4a';
    if (m.contains('mpeg')) return 'mp3';
    if (m.contains('wav')) return 'wav';
    return 'bin';
  }

  String _artifactFileName(AiMediaJob job, String mime) {
    final shortId = job.jobId.length > 8 ? job.jobId.substring(0, 8) : job.jobId;
    return '${job.kind.wire}_$shortId.${_extForArtifactMime(mime)}';
  }

  /// Open the finished artifact for [job]. Image jobs reuse the existing
  /// full-screen viewer (`_openImageFull`, same convention `_avaImageBubble`
  /// already uses for its `media_ref`). `audio_translate` jobs play through
  /// the shared player. Doc/transcript jobs route through the SAME
  /// `FileViewerScreen`/`openFileWithOs` machinery `_openFile` uses for an
  /// ordinary chat file — just fed bytes fetched from [url] instead of a
  /// decrypted `ChatMedia`.
  Future<void> _openJobArtifact(AiMediaJob job) async {
    if (job.kind == AiMediaJobKind.audioTranslate || job.kind == AiMediaJobKind.musicGenerate) {
      await _playJobArtifact(job); return;
    }
    final url = await _freshArtifactUrl(job);
    if (url == null) return;
    if (job.kind == AiMediaJobKind.imageGenerate) { _openImageFull(url); return; }
    try {
      final (bytes, mime) = await _fetchArtifactBytes(url);
      final name = _artifactFileName(job, mime);
      if (!mounted) return;
      if (FileViewerScreen.canView(mime, name)) {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => FileViewerScreen(bytes: bytes, name: name, mime: mime),
        ));
      } else {
        final ok = await openFileWithOs(bytes, name, mime);
        if (!ok && mounted) {
          _toast('No app on this device can open $name — tap share to send it elsewhere.');
        }
      }
      Analytics.capture('ai_media_job_artifact_open', {'kind': job.kind.wire, 'job_id': job.jobId, 'ok': true});
    } catch (e, st) {
      // [AVA-MEDIA-AUTHZ-1] `url` is a 900s presigned artifact URL — a bearer
      // read credential. Never the full `e.toString()`; classified type here,
      // full scrub via captureException.
      Analytics.capture('ai_media_job_artifact_open',
          {'kind': job.kind.wire, 'job_id': job.jobId, 'ok': false, 'error': e.runtimeType.toString()});
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'stage': 'open_job_artifact', 'kind': job.kind.wire, 'job_id': job.jobId});
      if (mounted) _toast("Couldn't open this ${job.kind.displayNoun}.");
    }
  }

  /// Download the ORIGINAL artifact bytes (never a CDN thumbnail rendition —
  /// Part VI §37) to the OS share sheet. Image jobs reuse `_downloadImage`
  /// (same full-resolution-fetch convention `_avaImageBubble` already uses);
  /// every other kind fetches + writes a temp file with a real name/extension.
  Future<void> _downloadJobArtifact(AiMediaJob job) async {
    if (job.kind == AiMediaJobKind.imageGenerate) {
      final url = await _freshArtifactUrl(job);
      if (url == null) return;
      await _downloadImage(url);
      return;
    }
    final url = await _freshArtifactUrl(job);
    if (url == null) return;
    try {
      final (bytes, mime) = await _fetchArtifactBytes(url);
      final name = _artifactFileName(job, mime);
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/$name');
      await f.writeAsBytes(bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: mime.isEmpty ? null : mime)]);
      Analytics.capture('ai_media_job_artifact_download', {'kind': job.kind.wire, 'job_id': job.jobId, 'ok': true});
    } catch (e, st) {
      // [AVA-MEDIA-AUTHZ-1] See `_openJobArtifact` — `url` is a presigned
      // credential; never the full `e.toString()`.
      Analytics.capture('ai_media_job_artifact_download',
          {'kind': job.kind.wire, 'job_id': job.jobId, 'ok': false, 'error': e.runtimeType.toString()});
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'stage': 'download_job_artifact', 'kind': job.kind.wire, 'job_id': job.jobId});
      if (mounted) _toast("Couldn't download this ${job.kind.displayNoun}.");
    }
  }

  /// Same OS share-sheet affordance as Download — a job artifact has no
  /// separate "send elsewhere" mechanic to distinguish the two actions.
  Future<void> _shareJobArtifact(AiMediaJob job) async {
    // [MEDIA-CARD-SAFE-1] Rule 3 success marker: this event is emitted the
    // moment the user taps Share, BEFORE any network call, so a share that
    // never completes is visible as a `share_started` with no matching
    // `ai_media_job_artifact_share`. Until this existed, a share that died on a
    // dead network left no trace at all — which is exactly why "sharing a song
    // crashes the app" could not be told apart from "the phone was offline".
    Analytics.capture('ai_media_job_share_started', {
      'kind': job.kind.wire,
      'job_id': job.jobId,
      'has_cover': (job.coverUrl ?? '').isNotEmpty,
      'cover_status': job.coverStatus ?? 'unknown',
    });
    if (job.kind == AiMediaJobKind.videoGenerate) {
      // Never abandon the share just because the refresh round-trip failed: the
      // record we already hold is enough to publish, and `createVideoShareLink`
      // falls back to a link this session already minted.
      final fresh = await AiMediaJobRepository.I.fetch(job.jobId) ??
          AiMediaJobRepository.I.byId(job.jobId) ??
          job;
      final shareUrl = await AiMediaJobRepository.I.createVideoShareLink(fresh.jobId);
      if (shareUrl != null) {
        final rawTitle = (fresh.videoTitle ?? '').trim();
        final rawDescription = (fresh.videoDescription ?? '').trim();
        final title = rawTitle.isEmpty || rawTitle == 'AvaTOK video'
            ? 'Cinematic moment'
            : rawTitle;
        final description = rawDescription.isEmpty ||
                rawDescription == 'A short video created with AvaTOK AI.'
            ? 'A cinematic scene with its own setting, movement, and atmosphere.'
            : rawDescription;
        await Share.share(
          '$title\n$description\n$shareUrl',
          subject: title,
        );
        return;
      }
    }
    if (job.kind != AiMediaJobKind.musicGenerate) {
      await _downloadJobArtifact(job);
      return;
    }
    try {
      // Same rule as the video branch: a failed refresh must not cost the user
      // the share. `fetch` already returns the last-known record rather than
      // null when the phone is simply offline.
      final fresh = await AiMediaJobRepository.I.fetch(job.jobId) ??
          AiMediaJobRepository.I.byId(job.jobId) ??
          job;
      final audioUrl = fresh.artifactUrl;
      final title = (fresh.songTitle ?? '').trim().isEmpty ? 'Ava original' : fresh.songTitle!.trim();
      final description = (fresh.songDescription ?? '').trim().isEmpty
          ? 'An original song created with Ava.'
          : fresh.songDescription!.trim();
      final shareUrl = await AiMediaJobRepository.I.createSongShareLink(fresh.jobId);
      if (shareUrl == null && (audioUrl == null || audioUrl.isEmpty)) {
        // Nothing to hand the share sheet: no published link and no artifact
        // URL. Say what is actually wrong instead of "try again in a moment".
        Analytics.capture('ai_media_job_artifact_share', {
          'kind': fresh.kind.wire, 'job_id': fresh.jobId, 'ok': false,
          'error': 'no_link_no_artifact',
        });
        if (mounted) _toast("Can't share this song while you're offline.");
        return;
      }
      if (shareUrl != null) {
        await Share.share('$title\n$description\n$shareUrl', subject: title);
        Analytics.capture('ai_media_job_artifact_share', {
          'kind': fresh.kind.wire, 'job_id': fresh.jobId, 'ok': true,
          'share_kind': 'song_link',
        });
        return;
      }
      // Fail-soft for an older Worker or a temporary share-route outage: send
      // the audio and cover files directly instead of losing Share entirely.
      // The guard above already proved this is non-empty on this path; the
      // local re-check is what lets the compiler see it too.
      if (audioUrl == null || audioUrl.isEmpty) return;
      final (audioBytes, audioMime) = await _fetchArtifactBytes(audioUrl);
      final dir = await getTemporaryDirectory();
      final audio = File('${dir.path}/${_artifactFileName(fresh, audioMime)}');
      await audio.writeAsBytes(audioBytes, flush: true);
      final files = <XFile>[XFile(audio.path, mimeType: audioMime.isEmpty ? null : audioMime)];
      final coverUrl = fresh.coverUrl;
      if (coverUrl != null && coverUrl.isNotEmpty) {
        try {
          final (coverBytes, coverMime) = await _fetchArtifactBytes(coverUrl);
          final coverExt = switch (coverMime.toLowerCase().split(';').first.trim()) {
            'image/jpeg' => 'jpg',
            'image/webp' => 'webp',
            'image/gif' => 'gif',
            _ => 'png',
          };
          final shortId = fresh.jobId.length <= 8 ? fresh.jobId : fresh.jobId.substring(0, 8);
          final cover = File('${dir.path}/ava_song_cover_$shortId.$coverExt');
          await cover.writeAsBytes(coverBytes, flush: true);
          files.add(XFile(cover.path, mimeType: coverMime.isEmpty ? 'image/png' : coverMime));
        } catch (_) {
          // Artwork is optional. A stale/missing cover must never block the
          // user from sharing the successfully downloaded song itself.
        }
      }
      await Share.shareXFiles(files, subject: title, text: '$title\n$description');
      Analytics.capture('ai_media_job_artifact_share', {
        'kind': fresh.kind.wire, 'job_id': fresh.jobId, 'ok': true,
        'with_cover': files.length > 1,
      });
    } catch (e, st) {
      Analytics.capture('ai_media_job_artifact_share', {
        'kind': job.kind.wire, 'job_id': job.jobId, 'ok': false,
        'error': e.runtimeType.toString(),
      });
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'stage': 'share_music_job', 'job_id': job.jobId});
      if (mounted) _toast("Couldn't share this song.");
    }
  }

  /// "Save to AvaStorage" — fetch + upload to the user's AvaTOK Drive folder.
  Future<void> _saveJobArtifactToDrive(AiMediaJob job) async {
    final url = await _freshArtifactUrl(job);
    if (url == null) return;
    _capNote('Saving to your AvaTOK Drive…');
    try {
      final (bytes, mime) = await _fetchArtifactBytes(url);
      final name = _artifactFileName(job, mime);
      // DriveService's bucket set is a fixed enum (worker/src/routes/ava_drive.ts
      // BUCKETS) — an image job goes to Photos like every other picture; every
      // other kind (doc/transcript/translated-audio) goes to Files.
      final bucket = job.kind == AiMediaJobKind.imageGenerate ? 'Photos' : 'Files';
      final ok = await DriveService.I
          .upload(bucket, name, mime.isEmpty ? 'application/octet-stream' : mime, bytes);
      if (mounted) {
        _capNote(ok ? 'Saved to your AvaTOK Drive ✓' : "Couldn't save — connect Drive in AvaStorage.");
      }
      Analytics.capture('ai_media_job_artifact_save', {'kind': job.kind.wire, 'job_id': job.jobId, 'ok': ok});
    } catch (e, st) {
      // [AVA-MEDIA-AUTHZ-1] See `_openJobArtifact` — `url` is a presigned
      // credential; never the full `e.toString()`.
      Analytics.capture('ai_media_job_artifact_save',
          {'kind': job.kind.wire, 'job_id': job.jobId, 'ok': false, 'error': e.runtimeType.toString()});
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'stage': 'save_job_artifact', 'kind': job.kind.wire, 'job_id': job.jobId});
      if (mounted) _capNote("Couldn't save this ${job.kind.displayNoun}.");
    }
  }

  /// "Copy result" (§38) — text-ish artifacts only (doc summarize/translate,
  /// audio transcript); the card never wires this for image/audio_translate
  /// kinds (see `_aiJobBubble`). Decodes the artifact bytes as UTF-8 text.
  Future<void> _copyJobResult(AiMediaJob job) async {
    final url = await _freshArtifactUrl(job);
    if (url == null) return;
    try {
      final (bytes, _) = await _fetchArtifactBytes(url);
      final text = utf8.decode(bytes, allowMalformed: true);
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted) _capNote('Copied');
    } catch (e, st) {
      // [AVA-MEDIA-AUTHZ-1] See `_openJobArtifact` — `url` is a presigned
      // credential; never the full `e.toString()`.
      Analytics.capture('ai_media_job_artifact_copy',
          {'kind': job.kind.wire, 'job_id': job.jobId, 'ok': false, 'error': e.runtimeType.toString()});
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true,
          extra: {'stage': 'copy_job_artifact', 'kind': job.kind.wire, 'job_id': job.jobId});
      if (mounted) _toast("Couldn't copy this ${job.kind.displayNoun}.");
    }
  }

  /// Delete the RESULT card (never the original source media — `forget` only
  /// ever removes a row from the local job cache/UI, never a server file).
  Future<void> _deleteJobArtifact(AiMediaJob job) => AiMediaJobRepository.I.forget(job.jobId);

  /// Retry a failed/cancelled job: [AiMediaJobRepository.retry] re-submits a
  /// NEW job with the original params; once it lands (via the update stream,
  /// under its own `job_id`), drop the old failed/cancelled card.
  Future<void> _retryJobCard(AiMediaJob job) async {
    final newJob = await AiMediaJobRepository.I.retry(job.jobId);
    if (newJob != null) await AiMediaJobRepository.I.forget(job.jobId);
  }

  Future<void> _cancelJobCard(AiMediaJob job) => AiMediaJobRepository.I.cancel(job.jobId);

  /// Play a completed `audio_translate` artifact through the shared, app-wide
  /// [AudioPlaybackService] (Part VI §39/§46) — never a new, per-card player.
  /// Local-first: cached bytes (by the artifact's STABLE `artifactMediaId`,
  /// never the expiring URL — see `MediaService.cachedBlob`) are reused on
  /// replay instead of re-fetching every tap.
  Future<void> _playJobArtifact(AiMediaJob job) async {
    final artifactId = job.artifactMediaId;
    if (artifactId == null || artifactId.isEmpty) {
      if (mounted) _toast('Could not load this audio.');
      return;
    }
    try {
      Uint8List? bytes = await MediaService.cachedBlob(artifactId);
      if (bytes == null) {
        final url = await _freshArtifactUrl(job);
        if (url == null) return;
        final (fetched, _) = await _fetchArtifactBytes(url);
        bytes = fetched;
        await MediaService.writeBlob(artifactId, bytes);
      }
      await AudioPlaybackService.I.playArtifact(
        artifactMediaId: artifactId,
        bytes: bytes,
        subtitle: job.label.isNotEmpty
            ? job.label
            : (job.kind == AiMediaJobKind.musicGenerate ? 'Ava song' : 'Translated audio'),
        originRoute: _convKey,
      );
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true, extra: {
        'stage': 'play_job_artifact',
        'kind': job.kind.wire,
      });
      if (mounted) _toast('Could not play this audio.');
    }
  }

  /// Render one durable job as an [AiMediaJobCard]. Image jobs get a live
  /// thumbnail straight off `artifact_url` (a stable public CDN URL for an
  /// ordinary "make an image" job — the same convention `_avaImageBubble`'s
  /// `media_ref` already uses); doc/audio kinds render the typed row.
  Widget _aiJobBubble(AiMediaJob job) {
    final isImage = job.kind == AiMediaJobKind.imageGenerate;
    final isVideo = job.kind == AiMediaJobKind.videoGenerate;
    final isMusic = job.kind == AiMediaJobKind.musicGenerate;
    final succeeded = job.isSucceeded;
    final artifactUrl = job.artifactUrl;
    if (isMusic && succeeded && !_musicReadyJobIds.contains(job.jobId)) {
      unawaited(_prepareMusicForDisplay(job));
      return AiMediaJobPreparingCard(
        key: ValueKey('ai_media_preparing_${job.jobId}'),
        job: job,
      );
    }
    return AiMediaJobCard(
      key: AiMediaJobCard.keyFor(job.jobId),
      job: job,
      // [AVA-MEDIA-AUTHZ-1] `artifact_url` re-mints (new signature) on every
      // job read (`_freshArtifactUrl`'s doc), so keying the cache on the url
      // itself would miss every time; `artifactMediaId` is the stable id.
      thumbnailWidget: (isImage && succeeded && artifactUrl != null && artifactUrl.isNotEmpty)
          ? CachedImage(artifactUrl, width: double.infinity,
              cacheKey: job.artifactMediaId, transformUrl: false)
          : (isVideo && succeeded)
              ? _AiVideoJobPreview(
                  job: job,
                  resolveUrl: () => _freshArtifactUrl(job),
                )
              : (isMusic && succeeded)
                  ? _AiMusicJobPreview(
                      job: job,
                      coverBytes: _musicCoverBytes[job.jobId],
                      onPlay: () => _playJobArtifact(job),
                      onShare: () => _shareJobArtifact(job),
                    )
          : null,
      // Generated video owns its tap gesture and player controls inline. Do not
      // route it through `_openJobArtifact`, which is the document/OS opener.
      onTapOpen: succeeded && !isVideo ? () => _openJobArtifact(job) : null,
      onDownload: succeeded ? () => _downloadJobArtifact(job) : null,
      onShare: succeeded ? () => _shareJobArtifact(job) : null,
      onSaveToLibrary: succeeded ? () => _saveJobArtifactToDrive(job) : null,
      onCopyResult: (succeeded &&
              job.kind != AiMediaJobKind.imageGenerate &&
              job.kind != AiMediaJobKind.audioTranslate &&
              job.kind != AiMediaJobKind.videoGenerate &&
              job.kind != AiMediaJobKind.musicGenerate)
          ? () => _copyJobResult(job)
          : null,
      onDelete: job.isTerminal ? () => _deleteJobArtifact(job) : null,
      onRetry: (job.isFailed || job.isCancelled) ? () => _retryJobCard(job) : null,
      onCancel: job.isWorking ? () => _cancelJobCard(job) : null,
    );
  }

  Future<void> _addSharedContact(Map e) async {
    final uid = (e['uid'] ?? '').toString();
    if (!uid.startsWith('user_')) return;
    await ContactsStore().add(Contact(uid: uid, name: (e['name'] ?? 'Contact').toString(), handle: (e['handle'] ?? '').toString()));
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${e['name']} added')));
  }

  /// [MEDIA-INSTANT-1] Create the optimistic bubble SYNCHRONOUSLY and return it
  /// immediately — split out of `_sendMedia` so a caller sending several items
  /// at once (multi-photo) can insert every bubble FIRST, then fan uploads out
  /// through a bounded pool, instead of the old "bubble N+1 waits on upload N"
  /// sequential loop.
  _Msg _addMediaBubble(MediaKind kind, Uint8List bytes, String ct, String name,
      {String caption = '', int? pickStartMs}) {
    // Stamp the message with a real send time. Without this it defaulted to ts=0,
    // so any list re-sort floated the bubble to the very TOP of the thread and it
    // appeared to "disappear" from the bottom where it was just added.
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final tShownStart = DateTime.now().millisecondsSinceEpoch;
    final msg = _Msg(_seq++, true, _caption(kind, name), _fmtTime(now),
        ts: now, localBytes: bytes, uploading: true, mediaCaption: caption,
        pendingKind: kind) // [AVAVM-PLAYER-1] real kind, known before `media` exists
      ..sendStartedMs = tShownStart // [AVA-CHAT-INSTANT] round-trip anchor
      ..pickStartedMs = pickStartMs
      ..pendingMime = ct
      ..pendingFilename = name
      ..mediaClientId = _newMediaClientId(); // [MEDIA-OUTBOX-DURABLE-1] stable id, assigned here so the durable outbox row (added next commit) can key off the SAME id the bubble already carries.
    _mutMsgs(() => _msgs.add(msg));
    _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
    // [AVA-CHAT-INSTANT] Heavy media shows its bubble (local preview + uploading
    // clock) instantly, BEFORE the upload — record how fast (email auto-attached).
    Analytics.capture('msg_optimistic_shown', {
      'kind': kind.name, 'conv_kind': _isGroup ? 'group' : 'dm',
      'ms_to_bubble': DateTime.now().millisecondsSinceEpoch - tShownStart,
      'size': bytes.length,
    });
    // [ONEBRAIN-B3-APP] The cloud File Search push of raw file bytes
    // (RagService.ingestFileBytes) was CUT (B-D2). Server-readable file indexing
    // is the `files` domain via the AvaLibrary/upload pipeline; here we keep only
    // an ON-DEVICE descriptor so "@ava find the logo I sent" / "the video about
    // X" resolves by name offline even when the bytes aren't text-extractable
    // (video/audio) or the content lacks the words the user searches by.
    final descr = StringBuffer('Shared a ${kind.name} named "$name"');
    if (caption.trim().isNotEmpty) descr.write(' — note: ${caption.trim()}');
    // ignore: unawaited_futures
    AvaLocalBrain.I.ingest(
      domain: 'files',
      kind: 'chat_file',
      text: descr.toString(),
      meta: {'convKey': 'file:${widget.chat.name}'},
      ts: now,
      sourceId: 'chatfile_${DateTime.now().microsecondsSinceEpoch}',
    );
    return msg;
  }

  Future<void> _sendMedia(MediaKind kind, Uint8List bytes, String ct, String name,
      {String caption = '', String? sourcePath, int? pickStartMs}) async {
    final msg = _addMediaBubble(kind, bytes, ct, name, caption: caption, pickStartMs: pickStartMs);
    await _upload(msg, bytes, kind, ct, name, caption: caption, sourcePath: sourcePath);
  }

  /// [MEDIA-RETRY-KIND-1] Compact "broken media" placeholder — replaces the
  /// old `errorBuilder: (_, __, ___) => const SizedBox.shrink()` sites, which
  /// made a failed decode/load render as literally NOTHING (confirmed in prod:
  /// 4 image bubbles that "vanished" on 2026-07-23). Shows an icon + "Tap to
  /// retry" when [onRetry] is given, else "Couldn't load", and always emits
  /// `chat_media_load_failed` with a reason so it's diagnosable remotely.
  Widget _brokenMediaPlaceholder({
    required _Msg m,
    required String kind,
    required String reason,
    VoidCallback? onRetry,
    double width = 220,
    double height = 140,
  }) {
    final dedupeKey = '${m.id}_$kind';
    if (_reportedBrokenMedia.add(dedupeKey)) {
      Analytics.capture('chat_media_load_failed', {
        'kind': kind, 'reason': reason, 'client_id': m.mediaClientId ?? '',
        'conv_kind': _isGroup ? 'group' : 'dm',
      });
    }
    return GestureDetector(
      onTap: onRetry,
      child: Container(
        width: width,
        height: height,
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(Msg.rMd),
          border: Border.all(color: AD.borderControl, width: 2),
        ),
        alignment: Alignment.center,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.imageBroken(PhosphorIconsStyle.bold),
              size: 26, color: AD.textTertiary),
          const SizedBox(height: 6),
          Text(onRetry != null ? 'Tap to retry' : "Couldn't load",
              style: ADText.bubbleMeta(c: AD.textTertiary)),
        ]),
      ),
    );
  }

  /// [MEDIA-RETRY-KIND-1] Manual "retry now" for a failed media send. Reads
  /// the EXACT kind/mime/filename/caption the original attempt used off the
  /// message itself (stamped at bubble-creation time — see `_addMediaBubble`/
  /// `_stopAndSendRecording`) instead of guessing. Rejects (with telemetry, no
  /// upload attempt) a kind/mime pair that doesn't make sense together.
  void _retryMediaUpload(_Msg m) {
    if (m.localBytes == null) return;
    final kind = m.pendingKind ?? m.media?.kind ?? MediaKind.file;
    final mime = m.pendingMime ?? m.media?.contentType ?? '';
    final filename = m.pendingFilename ?? m.media?.name ?? m.text;
    final clientId = m.mediaClientId ?? '';
    if (!_kindMimeCompatible(kind, mime)) {
      Analytics.capture('chat_media_retry_failed', {
        'kind': kind.name, 'mime': mime, 'bytes': m.localBytes!.length,
        'attempt': (m.retryAttempt ?? 0) + 1, 'client_id': clientId,
        'reason': 'incompatible_kind_mime',
      });
      _capNote("Couldn't retry — this attachment's type is unknown.");
      return;
    }
    m.retryAttempt = (m.retryAttempt ?? 0) + 1;
    Analytics.capture('chat_media_retry_started', {
      'kind': kind.name, 'mime': mime, 'bytes': m.localBytes!.length,
      'attempt': m.retryAttempt ?? 0, 'client_id': clientId,
    });
    _upload(m, m.localBytes!, kind, mime, filename, caption: m.mediaCaption);
  }

  /// [MEDIA-OUTBOX-DURABLE-1] The `resumeUpload` callback [MediaOutbox.reconcile]
  /// calls for a row that never made it past `uploaded` in a PREVIOUS run of
  /// the app. Re-runs the exact same pipeline `_upload` runs for a fresh send
  /// (transcode-if-video, then encrypt+upload) from the STAGED plaintext bytes
  /// — the thread this row belonged to may not even be open, so this talks to
  /// `MediaService` directly rather than through any `_Msg`/bubble.
  Future<({String? mediaId, String toEnvelopeJson})?> _resumeMediaUpload(
      MediaOutboxRow row, Uint8List bytes) async {
    try {
      var uploadBytes = bytes;
      var uploadCt = row.mime;
      final kind = MediaKind.values.byName(row.kind);
      if (kind == MediaKind.video) {
        try {
          final dir = await getTemporaryDirectory();
          final tmp = File('${dir.path}/resume_${row.clientId}.mp4');
          await tmp.writeAsBytes(bytes, flush: true);
          final info = await VideoCompress.compressVideo(tmp.path,
              quality: VideoQuality.Res1280x720Quality, deleteOrigin: false, includeAudio: true);
          final outPath = info?.file?.path;
          if (outPath != null) {
            final out = await File(outPath).readAsBytes();
            if (out.isNotEmpty) { uploadBytes = out; uploadCt = 'video/mp4'; }
          }
        } catch (e) {
          AvaLog.I.log('media', 'resume transcode failed ${row.clientId}, using staged bytes: $e');
        }
        // [MEDIA-OUTBOX-DURABLE-1] Same cap omission as the live `_upload`
        // path (fixed above) existed here too: a reconciled video row that
        // re-transcodes over the cap uploaded anyway with nothing to reject
        // it. Fail the row TERMINALLY (not a retryable error — the bytes
        // will never get smaller on the next reconcile pass) instead of
        // silently uploading an oversized file or hanging.
        if (uploadBytes.length > _kVideoMaxBytes) {
          Analytics.capture('video_upload_rejected', {'bytes': uploadBytes.length, 'source': 'resume'});
          throw MediaOutboxTerminalReject('video_too_big');
        }
      }
      final live = CallSessionManager.instance.current;
      final inCall = live != null && !live.isEnded;
      // [AVA-VOICE-PLAINTEXT-1] Read back the mode `_upload` PERSISTED on this
      // row at staging time (`row.plaintextVoice`) — never re-derive it from
      // `kind == MediaKind.audio && !RemoteConfig.voiceNoteEncryptionEnabled`.
      // That used to be wrong two ways: (1) it ignored what was actually
      // chosen — `_upload` only goes plaintext when the CALLER explicitly set
      // `plaintextVoice` (only `_stopAndSendRecording` ever does), so a picked
      // audio FILE attachment (also `MediaKind.audio`, always encrypted per
      // `_upload`'s own doc) would incorrectly resume as plaintext whenever the
      // flag happened to be off at RESUME time; (2) it re-read the flag live
      // instead of the point-in-time decision, so a flag flip between send and
      // resume could silently change which bucket/encryption an already-queued
      // attachment ends up in. `row.plaintextVoice == null` (an older row
      // staged before this column existed) defaults to `false` — fail safe,
      // never silently downgrade an encrypted upload to plaintext.
      final plaintextVoice = row.plaintextVoice ?? false;
      final m = plaintextVoice
          ? await MediaService.uploadPlaintext(uploadBytes,
              kind: kind, contentType: uploadCt, name: row.filename, caption: row.caption)
          : await MediaService.encryptAndUpload(uploadBytes,
              kind: kind, contentType: uploadCt, name: row.filename, caption: row.caption, inCall: inCall);
      return (mediaId: m.id, toEnvelopeJson: jsonEncode(m.toEnvelope()));
    } catch (e) {
      // Let a terminal rejection (video cap) propagate to `reconcile()`,
      // which gives the row up instead of scheduling a doomed retry — see
      // [MediaOutboxTerminalReject]'s doc.
      if (e is MediaOutboxTerminalReject) rethrow;
      AvaLog.I.log('media', 'resume upload FAILED ${row.clientId}: $e');
      return null;
    }
  }

  Future<void> _upload(_Msg msg, Uint8List bytes, MediaKind kind, String ct, String name,
      {String caption = '', String? sourcePath, bool plaintextVoice = false}) async {
    _mutMsgs(() { msg.uploading = true; msg.failed = false; });
    final tUploadStart = DateTime.now().millisecondsSinceEpoch;
    int? transcodeMs;
    // [MEDIA-OUTBOX-DURABLE-1] Stage the PLAINTEXT bytes + record a `queued`
    // row BEFORE encryption/upload starts, so a kill mid-upload can resume
    // from disk instead of losing the attachment (F3/J7: previously the R2
    // object could exist with no message ever referencing it, or the bubble
    // could vanish entirely with the bytes only ever in memory).
    final mediaClientId = msg.mediaClientId ?? _newMediaClientId();
    msg.mediaClientId = mediaClientId;
    unawaited(MediaOutbox.I.stage(
      clientId: mediaClientId,
      bytes: bytes,
      convKey: _convKey ?? '',
      kind: kind.name,
      mime: ct,
      filename: name,
      caption: caption,
      toUid: _isGroup ? '' : (_peerNpub ?? ''),
      gid: _isGroup ? (_group?.id ?? '') : '',
      // [AVA-VOICE-PLAINTEXT-1] Persist the mode CHOSEN HERE so a resume after
      // an app kill (`_resumeMediaUpload`) reads back the same decision
      // instead of re-deriving it from `kind` (which can't tell a recorded
      // voice note from a picked audio file — see that method's doc).
      plaintextVoice: plaintextVoice,
    ).then((_) => MediaOutbox.I.markUploading(mediaClientId)));
    // [MEDIA-OUTBOX-DURABLE-1 / reconcile-race] Register this id as having a
    // LIVE upload for the lifetime of this call, cleared in the `finally`
    // below no matter how this exits. `MediaOutbox.reconcile()` (which can
    // run concurrently — e.g. a second thread opens while THIS upload is
    // still in flight) checks this set and skips the row, so it never
    // re-drives the same staged bytes through the pipeline with a different
    // envelope id (duplicate R2 object + duplicate delivered message).
    MediaOutbox.liveUploads.add(mediaClientId);
    try {
      var uploadBytes = bytes;
      var uploadCt = ct;
      var uploadName = name;
      // [MEDIA-INSTANT-1a] The 720p transcode now runs HERE, on the background
      // upload path — AFTER the bubble is already on screen, never before it.
      // The bubble keeps showing the ORIGINAL bytes as its local preview the
      // whole time; only the bytes actually PUT to R2 are swapped for the
      // compressed clip. `sourcePath` is only passed for a fresh video pick
      // (not for a retry, which already has whatever bytes were staged/kept).
      if (kind == MediaKind.video && sourcePath != null) {
        if (mounted) _mutMsgs(() => msg.transcoding = true);
        final tCompressStart = DateTime.now().millisecondsSinceEpoch;
        try {
          final info = await VideoCompress.compressVideo(
            sourcePath,
            quality: VideoQuality.Res1280x720Quality, // 720p H.264
            deleteOrigin: false,
            includeAudio: true,
          );
          final outPath = info?.file?.path;
          if (outPath != null) {
            final out = await File(outPath).readAsBytes();
            if (out.isNotEmpty) {
              uploadBytes = out;
              uploadCt = 'video/mp4';
              if (!uploadName.toLowerCase().endsWith('.mp4')) uploadName = '$uploadName.mp4';
            }
          }
        } catch (e) {
          AvaLog.I.log('media', 'video compress failed, using original: $e');
        }
        transcodeMs = DateTime.now().millisecondsSinceEpoch - tCompressStart;
        if (mounted) _mutMsgs(() => msg.transcoding = false);
        Analytics.capture('video_upload_compressed', {
          'in_bytes': bytes.length, 'out_bytes': uploadBytes.length, 'transcode_ms': transcodeMs,
        });
      }
      // [MEDIA-OUTBOX-DURABLE-1] The cap check used to live ONLY inside the
      // `sourcePath != null` transcode block above, so a manual retry
      // (`_retryMediaUpload` → `_upload` with `sourcePath: null`) skipped it
      // entirely and uploaded the ORIGINAL un-transcoded bytes with no size
      // cap at all. Hoisted here so it applies to EVERY video upload
      // regardless of whether this call transcoded anything.
      if (kind == MediaKind.video && uploadBytes.length > _kVideoMaxBytes) {
        if (mounted) _mutMsgs(() { msg.uploading = false; msg.failed = true; });
        _capNote(_kVideoTooBigMsg);
        Analytics.capture('video_upload_rejected', {'bytes': uploadBytes.length});
        // Permanent rejection, not a transient failure — nothing to retry.
        unawaited(MediaOutbox.I.giveUp(mediaClientId, reason: 'video_too_big'));
        return;
      }
      // [CHAT-UPLOAD-1] A live 1:1 call shares this device's uplink. Encrypt off
      // the main thread + pace the ciphertext PUT so the upload never starves
      // WebRTC (which previously forced both-sides reconnects). Full speed off-call.
      final live = CallSessionManager.instance.current;
      final inCall = live != null && !live.isEnded;
      // [AVA-VOICE-PLAINTEXT-1] MVP voice notes (owner decision 2026-07-25):
      // when the CALLER explicitly marked this a recorded voice note AND the
      // flag is off, upload PLAINTEXT via the private, server-readable path
      // instead of client-side AES — this is the only call site that ever
      // sets [plaintextVoice] (`_stopAndSendRecording`), so a generic
      // picked-audio-FILE attachment (also `MediaKind.audio`, sent through
      // this same `_upload`) is unaffected and stays encrypted.
      final m = plaintextVoice
          ? await MediaService.uploadPlaintext(uploadBytes, kind: kind, contentType: uploadCt, name: uploadName, caption: caption)
          : await MediaService.encryptAndUpload(uploadBytes, kind: kind, contentType: uploadCt, name: uploadName, caption: caption, inCall: inCall);
      // [MEDIA-OUTBOX-DURABLE-1] Ciphertext is durably on R2 now — record the
      // exact envelope reference so a kill BEFORE the message send below still
      // has something to resend from (closes the "R2 object with nothing
      // referencing it" orphan window).
      unawaited(MediaOutbox.I.markUploaded(mediaClientId, jsonEncode(m.toEnvelope())));
      if (!mounted) return;
      _mutMsgs(() { msg.media = m; msg.uploading = false; });
      // [MEDIA-INSTANT-1f] Richer chat_media_sent — kind/bytes plus the two
      // perceived-latency legs the audit asked to make measurable, and
      // transcode_ms (null when this attachment never transcoded).
      Analytics.capture('chat_media_sent', {
        'kind': kind.name,
        'has_caption': caption.trim().isNotEmpty,
        'size': uploadBytes.length,
        'bytes': uploadBytes.length,
        'conv_kind': _isGroup ? 'group' : 'dm',
        'ms_bubble_to_uploaded': DateTime.now().millisecondsSinceEpoch - tUploadStart,
        if (msg.pickStartedMs != null && msg.sendStartedMs != null)
          'ms_pick_to_bubble': msg.sendStartedMs! - msg.pickStartedMs!,
        if (transcodeMs != null) 'transcode_ms': transcodeMs,
      });
      if (msg.retryAttempt != null) {
        Analytics.capture('chat_media_retry_succeeded', {
          'kind': kind.name, 'mime': uploadCt, 'bytes': uploadBytes.length,
          'attempt': msg.retryAttempt!, 'client_id': msg.mediaClientId ?? '',
        });
      }
      final keyShort = m.id.length > 12 ? m.id.substring(m.id.length - 8) : m.id;
      // Deliver the media reference + key inside an encrypted DM / group fan-out.
      if (_isGroup && _gdm != null) {
        final id = _gdm!.send(jsonEncode({...m.toEnvelope(), 't': 'gmedia', 'gid': _group!.id, 'fromName': _fromNameTag}));
        msg.evId = id;
        _seenEv.add(id);
        // [MEDIA-OUTBOX-DURABLE-1] The envelope leg is now owned by the
        // EXISTING durable [Outbox] (`_gdm!.send` already enqueues into it) —
        // this store just watches Outbox's ACK for `id` to know when it's
        // safe to delete the staged plaintext + row. See media_outbox.dart's
        // class doc for why there's no second retry/backoff implementation
        // for this leg.
        unawaited(MediaOutbox.I.markEnvelopeSent(mediaClientId, id));
        Analytics.capture('group_message_sent', {
          'gid': _group!.id, 'member_count': _group!.members.length, 'kind': kind.name,
        });
        AvaLog.I.log('media', 'sent gmedia kind=${kind.name} ${uploadBytes.length}B key=…$keyShort rumor=${id.length >= 8 ? id.substring(0, 8) : id}');
      } else if (_realMode && _dm != null) {
        final id = _dm!.send(jsonEncode(m.toEnvelope()));
        msg.evId = id;
        _seenEv.add(id);
        unawaited(MediaOutbox.I.markEnvelopeSent(mediaClientId, id));
        AvaLog.I.log('media', 'sent dm media kind=${kind.name} ${uploadBytes.length}B key=…$keyShort rumor=${id.length >= 8 ? id.substring(0, 8) : id}');
      }
      _schedulePersist(); // cache the media message so it survives reopen
    } catch (e) {
      if (!mounted) return;
      AvaLog.I.log('media', 'send media FAILED kind=${kind.name}: $e');
      _mutMsgs(() { msg.uploading = false; msg.failed = true; msg.transcoding = false; });
      // [MEDIA-OUTBOX-DURABLE-1] Auto-retry with backoff instead of leaving
      // this ONLY as a manual tap-to-retry — [MediaOutbox.reconcile] (run on
      // the next thread open / app boot) picks a `queued` row back up. Manual
      // tap-to-retry still works too ("retry now" — see the retry sites).
      unawaited(MediaOutbox.I.scheduleRetry(mediaClientId, reason: e.toString()));
      if (msg.retryAttempt != null) {
        Analytics.capture('chat_media_retry_failed', {
          'kind': kind.name, 'mime': ct, 'bytes': bytes.length,
          'attempt': msg.retryAttempt!, 'client_id': msg.mediaClientId ?? '',
          'reason': e.toString(),
        });
      }
    } finally {
      MediaOutbox.liveUploads.remove(mediaClientId);
    }
  }

  // STREAM E — GIPHY send (Tenor→GIPHY migration). Download the full media bytes
  // from GIPHY's CDN, then push them through the SAME encrypted media pipeline as
  // any photo so the recipient fetches from R2 (never GIPHY). No fork of the
  // upload path. Routing by GIPHY content type:
  //   • clip  → video message (mp4 WITH sound)
  //   • sticker / text / emoji → bubble-less sticker (kind:"sticker" via name tag)
  //   • gif   → animated media (image/gif or webp)
  Future<void> _sendGif(GifResult g) async {
    // ignore: unawaited_futures
    PickerRecentsStore.I.pushGif(g.toRecent());
    Analytics.capture('giphy_selected', {
      'content_type': g.contentType.wire,
      'conv_kind': _isGroup ? 'group' : 'dm',
    });
    Analytics.capture('gif_sent', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'query_len': g.desc.length,
      'content_type': g.contentType.wire,
    });
    final bytes = await GifApi.download(g.url);
    if (!mounted) return;
    if (bytes == null || bytes.isEmpty) { _capNote("Couldn't send GIF"); return; }
    if (bytes.length > _kMediaMaxBytes) { _capNote('That GIF is too large'); return; }

    final lowerUrl = g.url.toLowerCase();
    switch (g.contentType) {
      case GifContentType.clip:
        // Clips = GIF WITH SOUND → send as a video message.
        await _sendMedia(
          MediaKind.video, bytes, 'video/mp4', 'giphy-${g.id}.mp4');
        return;
      case GifContentType.sticker:
      case GifContentType.text:
      case GifContentType.emoji:
        // Transparent WebP/GIF → render bubble-less at 160dp (Stream E sticker
        // path). Reuse the sticker name tag so the bubble builder detects it.
        final isGif = lowerUrl.contains('.gif');
        await _sendMedia(
          MediaKind.image,
          bytes,
          isGif ? 'image/gif' : 'image/webp',
          stickerMediaName('giphy/${g.id}.${isGif ? 'gif' : 'webp'}'),
        );
        return;
      case GifContentType.gif:
        final isMp4 = lowerUrl.contains('.mp4');
        final isWebp = lowerUrl.contains('.webp');
        await _sendMedia(
          isMp4 ? MediaKind.video : MediaKind.image,
          bytes,
          isMp4 ? 'video/mp4' : (isWebp ? 'image/webp' : 'image/gif'),
          'giphy-${g.id}.${isMp4 ? 'mp4' : (isWebp ? 'webp' : 'gif')}',
        );
        return;
    }
  }

  // STREAM E — sticker send. Load the bundled .webp bytes and send through the
  // encrypted media pipeline, tagging the media name so the message can render
  // as a bubble-less 160dp sticker (see sticker_media.dart). Reuses _sendMedia.
  Future<void> _sendStickerAsset(String assetPath) async {
    // ignore: unawaited_futures
    PickerRecentsStore.I.pushSticker(assetPath);
    Analytics.capture('sticker_sent', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'pack': assetPath.split('/').length > 2 ? assetPath.split('/')[2] : 'unknown',
    });
    try {
      final data = await rootBundle.load(assetPath);
      final bytes = data.buffer.asUint8List();
      if (!mounted) return;
      await _sendMedia(
          MediaKind.image, bytes, 'image/webp', stickerMediaName(assetPath));
    } catch (_) {
      if (mounted) _capNote("Couldn't send sticker");
    }
  }

  void _capNote(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // Camera → one photo. (Gallery multi-select uses _pickPhotos.)
  Future<void> _pickImage(ImageSource source) async {
    final x = await _picker.pickImage(source: source, imageQuality: 85);
    if (x == null) return;
    final bytes = await x.readAsBytes();
    if (bytes.length > _kMediaMaxBytes) { _capNote('That photo is over 25 MB — please pick a smaller one.'); return; }
    await _sendImageWithCaption(bytes, 'image/jpeg', x.name);
  }

  // Photo caption step: preview the picked image and let the user "say something
  // about the pic" before it goes out. WhatsApp-style: the caption rides INSIDE
  // the photo's own message envelope, so the picture + its text are ONE bubble.
  // This is what lets Ava link an "@ava send this as email" instruction to the
  // photo it refers to — previously the caption went out as a SEPARATE text
  // message, so by the time Ava processed the request the attachment wasn't tied
  // to it and she'd ask "where's the photo / what's its S3 key?".
  /// The composer text was carried into an attachment's caption — clear it so it
  /// is NOT also sent as a separate text message (the "splits into two" bug).
  void _consumeComposer(String seed) {
    if (seed.isEmpty) return;
    setState(() { _ctrl.clear(); _hasText = false; });
    if (_convKey != null) DraftStore().set(_convKey!, '');
  }

  Future<void> _sendImageWithCaption(Uint8List bytes, String ct, String name) async {
    // WhatsApp-style: if the user already typed something in the composer, carry
    // it INTO the caption field (seed) instead of sending it as a separate text
    // message. This is the fix for "my message splits into two parts" — the photo
    // and the words now travel as ONE message, so Ava can link the instruction to
    // the attachment.
    final seed = _ctrl.text.trim();
    final caption = await _captionSheet(bytes, initial: seed);
    if (caption == null) return; // user backed out
    _consumeComposer(seed);
    final c = caption.trim();
    // ONE message: photo + caption together (awaits upload + delivery so the
    // attachment is on the InboxDO before we summon Ava below).
    await _sendMedia(MediaKind.image, bytes, ct, name, caption: c);
    if (c.isNotEmpty) _ragAddLine('You', c);
    _summonAvaForReference(name: name, kind: 'image', instruction: c);
  }

  void _summonAvaForReference({required String name, required String kind, String instruction = ''}) {
    if (_editing != null || onSummonAva == null) return;
    final c = instruction.trim();
    final lower = c.toLowerCase();
    final shared = lower.contains(_avaShareWord);
    final atAva = lower.contains(_avaWakeWord);
    final privateDirected = (atAva && !shared) || (_avaMode && !shared && !atAva);
    final publicDirected = shared || (_avaPublicMode && !atAva);
    if (!privateDirected && !publicDirected) return;
    final request = c.isNotEmpty
        ? c
        : 'Use this $kind reference named "$name" in our brainstorming.';
    final ingestRequest = '__AVA_REFERENCE_INGEST__ Analyze the newly shared $kind reference "$name". '
        'Extract the useful creative details, connect them to our current discussion, and tell everyone when it is ready. $request';
    _showAvaWorking('Ava is ingesting the reference…', trigger: 'attachment');
    // ignore: unawaited_futures
    onSummonAva!(privateDirected ? '$_avaWakeWord $ingestRequest' : '$_avaShareWord $ingestRequest');
  }

  // ---- clipboard image paste into the composer ----
  /// Read an image off the system clipboard (PNG/JPEG via super_clipboard) and,
  /// if one is present, send it as a photo attachment (with the WhatsApp-style
  /// caption sheet). Returns true when an image was found and handled, so the
  /// caller can skip the normal text-paste fallback. Flutter's built-in
  /// `Clipboard` is text-only — this is what makes "copy an image elsewhere,
  /// paste it into the chat box" actually work.
  Future<bool> _tryPasteImage() async {
    final clipboard = SystemClipboard.instance;
    if (clipboard == null) return false;
    try {
      final reader = await clipboard.read();
      final fmt = reader.canProvide(Formats.png)
          ? Formats.png
          : (reader.canProvide(Formats.jpeg) ? Formats.jpeg : null);
      if (fmt == null) return false;
      final done = Completer<Uint8List?>();
      reader.getFile(fmt, (file) async {
        try {
          done.complete(await file.readAll());
        } catch (_) {
          if (!done.isCompleted) done.complete(null);
        }
      }, onError: (_) {
        if (!done.isCompleted) done.complete(null);
      });
      final bytes = await done.future;
      if (bytes == null || bytes.isEmpty) return false;
      if (bytes.length > _kMediaMaxBytes) {
        Analytics.capture('chat_image_paste_toobig', {'size': bytes.length, 'src': 'clipboard'});
        _capNote('That image is over 25 MB — please copy a smaller one.');
        return true; // we DID find an image; just too big to fall back to text
      }
      final isPng = fmt == Formats.png;
      final mime = isPng ? 'image/png' : 'image/jpeg';
      final ext = isPng ? 'png' : 'jpg';
      Analytics.capture('chat_image_pasted', {'mime': mime, 'size': bytes.length});
      await _sendImageWithCaption(
          bytes, mime, 'pasted_${DateTime.now().millisecondsSinceEpoch}.$ext');
      return true;
    } catch (e) {
      AvaLog.I.log('media', 'paste image failed: $e');
      Analytics.capture('chat_image_paste_failed', {'err': e.toString()});
      return false;
    }
  }

  /// Keyboard / system-clipboard rich-content insertion (Android commitContent).
  /// This is the path Samsung's "super paste" panel and Gboard's image/GIF paste
  /// use — distinct from the toolbar Paste button. The inserted image arrives as
  /// bytes (or a content URI the engine resolves for us), so route it straight to
  /// the photo-with-caption flow, mirroring _tryPasteImage. Falls back to a
  /// clipboard read if the payload is empty.
  Future<void> _onContentInserted(KeyboardInsertedContent content) async {
    try {
      final data = content.data;
      if (data == null || data.isEmpty) {
        // The Samsung "super paste" / blank-editor failure mode: the keyboard
        // announced an image but handed us nothing. Record it, then fall back to
        // reading the clipboard so the paste can still succeed.
        Analytics.capture('chat_image_insert_empty', {'mime': content.mimeType});
        await _tryPasteImage();
        return;
      }
      final bytes = Uint8List.fromList(data);
      if (bytes.length > _kMediaMaxBytes) {
        Analytics.capture('chat_image_paste_toobig', {'size': bytes.length, 'src': 'insert'});
        _capNote('That image is over 25 MB — please use a smaller one.');
        return;
      }
      final mime = content.mimeType.isNotEmpty ? content.mimeType : 'image/png';
      final ext = mime.contains('gif')
          ? 'gif'
          : (mime.contains('png') ? 'png' : (mime.contains('webp') ? 'webp' : 'jpg'));
      Analytics.capture('chat_image_inserted', {'mime': mime, 'size': bytes.length});
      // [CHAT-PASTE-1] keyboard/system commitContent path.
      Analytics.capture('chat_image_pasted', {'via': 'keyboard', 'mime': mime, 'size': bytes.length});
      await _sendImageWithCaption(
          bytes, mime, 'pasted_${DateTime.now().millisecondsSinceEpoch}.$ext');
    } catch (e) {
      AvaLog.I.log('media', 'content insert failed: $e');
      Analytics.capture('chat_image_insert_failed', {'err': e.toString()});
      if (mounted) _capNote("Couldn't paste that image — long-press the box to paste.");
    }
  }

  /// Composer paste entry point used by both the toolbar "Paste" button and the
  /// hardware Cmd/Ctrl+V shortcut. Tries an image first; on miss, falls back to
  /// the normal text paste (insert at the cursor / replace the selection).
  Future<void> _onComposerPaste({String via = 'context_menu'}) async {
    final started = DateTime.now().millisecondsSinceEpoch;
    Analytics.capture('composer_paste_started', {'via': via, 'private_mode': _avaMode});
    final handledImage = await _tryPasteImage();
    if (handledImage) {
      // [CHAT-PASTE-1] toolbar/context-menu Paste or hardware Cmd/Ctrl+V.
      Analytics.capture('chat_image_pasted', {'via': via});
      Analytics.uiInteraction('composer_paste',
          DateTime.now().millisecondsSinceEpoch - started,
          phase: 'interactive', source: 'clipboard', extra: {'kind': 'image', 'via': via});
      return;
    }
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) {
      Analytics.capture('composer_paste_empty', {'via': via});
      return;
    }
    final base = _ctrl.text;
    final sel = _ctrl.selection;
    final start = sel.start < 0 ? base.length : sel.start;
    final end = sel.end < 0 ? base.length : sel.end;
    final newText = base.replaceRange(start, end, text);
    _ctrl.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: start + text.length),
    );
    _onInputChanged(newText);
    Analytics.uiInteraction('composer_paste',
        DateTime.now().millisecondsSinceEpoch - started,
        phase: 'interactive', source: 'clipboard', extra: {'kind': 'text', 'via': via});
  }

  // Bottom sheet: image preview + a caption field. Returns the caption (possibly
  // empty → send with no caption) or null if dismissed without sending.
  Future<String?> _captionSheet(Uint8List bytes, {String initial = ''}) {
    final cap = TextEditingController(text: initial);
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 14, right: 14, top: 14,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 14,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(Msg.rMd),
            child: Image.memory(bytes,
                width: double.infinity,
                height: 280,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink()),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(AD.rInput),
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: cap,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ADText.rowName(),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: 'Add a caption…',
                    hintStyle: ADText.preview(c: AD.textTertiary),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, cap.text)),
          ]),
        ]),
      ),
    ).whenComplete(cap.dispose);
  }

  // Gallery → up to 8 photos in one go; each capped at 25 MB.
  Future<void> _pickPhotos() async {
    final pickStart = DateTime.now().millisecondsSinceEpoch;
    final xs = await _picker.pickMultiImage(imageQuality: 85);
    if (xs.isEmpty) return;
    final take = xs.length > _kMaxPhotosPerPick ? xs.sublist(0, _kMaxPhotosPerPick) : xs;
    if (xs.length > _kMaxPhotosPerPick) _capNote('Up to 8 photos at a time — sending the first 8.');
    // Single photo → offer the caption step ("say something about the pic").
    if (take.length == 1) {
      final bytes = await take.first.readAsBytes();
      if (bytes.length > _kMediaMaxBytes) { _capNote('That photo is over 25 MB — please pick a smaller one.'); return; }
      await _sendImageWithCaption(bytes, 'image/jpeg', take.first.name);
      return;
    }
    // Composer text rides as the caption on the FIRST photo (one bubble), so a
    // multi-pick never splits the user's words into a separate message.
    final seed = _ctrl.text.trim();
    var firstSent = true;
    var skipped = 0;
    // [MEDIA-INSTANT-1b] Insert EVERY bubble first (synchronously, pick order),
    // THEN fan the uploads out through a bounded pool — bubble N+1 must never
    // sit waiting on upload N to finish (the old sequential await-in-a-loop).
    final jobs = <({_Msg msg, Uint8List bytes, String name})>[];
    for (final x in take) {
      final bytes = await x.readAsBytes();
      if (bytes.length > _kMediaMaxBytes) { skipped++; continue; }
      final msg = _addMediaBubble(MediaKind.image, bytes, 'image/jpeg', x.name,
          caption: firstSent ? seed : '', pickStartMs: pickStart);
      jobs.add((msg: msg, bytes: bytes, name: x.name));
      firstSent = false;
    }
    _consumeComposer(seed);
    if (skipped > 0) _capNote('$skipped photo(s) skipped — over the 25 MB limit.');
    if (jobs.isEmpty) return;
    const poolSize = 3;
    var next = 0;
    Future<void> worker() async {
      while (next < jobs.length) {
        final j = jobs[next++];
        await _upload(j.msg, j.bytes, MediaKind.image, 'image/jpeg', j.name, caption: j.msg.mediaCaption);
      }
    }
    await Future.wait(List.generate(math.min(poolSize, jobs.length), (_) => worker()));
    _summonAvaForReference(
      name: jobs.map((j) => j.name).join(', '),
      kind: jobs.length == 1 ? 'image' : '${jobs.length} images',
      instruction: seed,
    );
  }

  // [MEDIA-INSTANT-1a] The transcode used to run HERE, BEFORE the bubble ever
  // appeared — a long clip meant seconds of "Optimising video…" dead UI before
  // anything showed up. It now runs on the background upload path (`_upload`)
  // AFTER the bubble is already visible; this picker only reads the ORIGINAL
  // bytes and hands them straight to the caption step + send.
  Future<void> _pickVideo(ImageSource source) async {
    final pickStart = DateTime.now().millisecondsSinceEpoch;
    // Recording auto-stops at the clip cap; gallery picks an existing clip.
    final x = await _picker.pickVideo(source: source, maxDuration: kVideoClipMax);
    if (x == null) return;
    final inBytes = await x.readAsBytes();
    await _sendVideoWithCaption(inBytes, x.name, sourcePath: x.path, pickStartMs: pickStart);
  }

  // Videos get the same caption/instruction step as photos + files, so any text
  // typed in the composer rides INSIDE the video's message (one bubble) and an
  // `@ava` instruction stays attached to the clip it refers to.
  Future<void> _sendVideoWithCaption(Uint8List bytes, String name, {String? sourcePath, int? pickStartMs}) async {
    final seed = _ctrl.text.trim();
    final caption = await _fileCaptionSheet(name, initial: seed, label: 'Video');
    if (caption == null) return;
    _consumeComposer(seed);
    final c = caption.trim();
    // [MEDIA-INSTANT-1a] Bubble goes out on the ORIGINAL bytes right away;
    // `_upload` does the 720p transcode in the background from `sourcePath`
    // and swaps in the compressed bytes for the actual upload.
    await _sendMedia(MediaKind.video, bytes, 'video/mp4', name,
        caption: c, sourcePath: sourcePath, pickStartMs: pickStartMs);
    if (c.isNotEmpty) _ragAddLine('You', c);
    _summonAvaForReference(name: name, kind: 'video', instruction: c);
  }

  Future<void> _pickFile() async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    await _sendFileWithCaption(f.bytes!, f.name);
  }

  // Files (PDFs, docs…) get the SAME "say something about it" caption step that
  // photos do, so you can explain the file — and, in Ask-Ava mode, the caption
  // is the instruction Ava acts on with the attachment in context. Previously a
  // file went out silently with no way to add text.
  Future<void> _sendFileWithCaption(Uint8List bytes, String name) async {
    final seed = _ctrl.text.trim();
    final caption = await _fileCaptionSheet(name, initial: seed);
    if (caption == null) return; // dismissed
    _consumeComposer(seed);
    final c = caption.trim();
    // ONE message: file + caption together, awaited so the attachment is on the
    // InboxDO before we summon Ava below.
    await _sendMedia(MediaKind.file, bytes, 'application/octet-stream', name, caption: c);
    if (c.isNotEmpty) _ragAddLine('You', c);
    _summonAvaForReference(name: name, kind: 'document', instruction: c);
  }

  // Compact sheet: a file chip (icon + name) + a caption/instruction field.
  // Returns the caption (possibly empty → send with no text) or null if dismissed.
  Future<String?> _fileCaptionSheet(String name, {String initial = '', String label = 'File'}) {
    final cap = TextEditingController(text: initial);
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 14, right: 14, top: 16,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 14,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AD.card,
              borderRadius: BorderRadius.circular(Msg.rMd),
              border: Border.all(color: AD.borderControl, width: 2),
            ),
            child: Row(children: [
              PhosphorIcon(
                  label == 'Video'
                      ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                      : PhosphorIcons.file(PhosphorIconsStyle.bold),
                  size: 22, color: AD.textPrimary),
              const SizedBox(width: 10),
              Expanded(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName())),
            ]),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: _avaMode ? AD.iconVideo : AD.card,
                  borderRadius: BorderRadius.circular(AD.rInput),
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: cap,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ADText.rowName(),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: _avaMode ? 'Tell Ava about this file…' : 'Add a note…',
                    hintStyle: ADText.preview(c: AD.textTertiary),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, cap.text)),
          ]),
        ]),
      ),
    ).whenComplete(cap.dispose);
  }

  MediaKind _kindFromCategory(String c) => c == 'image'
      ? MediaKind.image
      : c == 'video'
          ? MediaKind.video
          : c == 'audio'
              ? MediaKind.audio
              : MediaKind.file;

  // Browse AvaLibrary and attach an existing file into this chat. The picked
  // file is downloaded and re-sent through the normal media path (so it's
  // encrypted + shared like any attachment).
  Future<void> _addFromLibrary() async {
    final item = await Navigator.push<LibraryItem?>(
        context, MaterialPageRoute(builder: (_) => const LibraryPickerScreen()));
    if (item == null || !mounted) return;
    if (item.displayUrl.isEmpty) { _capNote('This file can\'t be attached from here.'); return; }
    _capNote('Attaching ${item.name}…');
    try {
      final resp = await http.get(Uri.parse(item.displayUrl)).timeout(const Duration(seconds: 60));
      if (resp.statusCode != 200) { _capNote('Could not load that file.'); return; }
      final bytes = resp.bodyBytes;
      final kind = _kindFromCategory(item.category);
      // VIDPOL-1: video is held to the 64 MB policy cap; photos keep the 25 MB cap.
      if (kind == MediaKind.video && bytes.length > _kVideoMaxBytes) {
        _capNote(_kVideoTooBigMsg);
        Analytics.capture('video_upload_rejected', {'bytes': bytes.length});
        return;
      }
      if (kind == MediaKind.image && bytes.length > _kMediaMaxBytes) {
        _capNote('That file is over 25 MB.'); return;
      }
      await _sendMedia(kind, bytes, item.mime, item.name);
      _summonAvaForReference(name: item.name, kind: kind.name);
    } catch (_) {
      _capNote('Could not attach from library.');
    }
  }

}

/// Inline generated-video player. Playback starts only after a tap, resolving a
/// fresh signed URL at that moment; the expiring URL is never persisted.
class _AiVideoJobPreview extends StatefulWidget {
  const _AiVideoJobPreview({required this.job, required this.resolveUrl});
  final AiMediaJob job;
  final Future<String?> Function() resolveUrl;

  @override
  State<_AiVideoJobPreview> createState() => _AiVideoJobPreviewState();
}

class _AiVideoJobPreviewState extends State<_AiVideoJobPreview> {
  VideoPlayerController? _controller;
  bool _starting = false;
  bool _failed = false;

  static String _time(Duration value) {
    final total = value.inSeconds;
    return '${total ~/ 60}:${(total % 60).toString().padLeft(2, '0')}';
  }

  Future<void> _toggle() async {
    final current = _controller;
    if (current != null && current.value.isInitialized) {
      current.value.isPlaying ? await current.pause() : await current.play();
      return;
    }
    if (_starting) return;
    setState(() {
      _starting = true;
      _failed = false;
    });
    VideoPlayerController? candidate;
    try {
      final url = await widget.resolveUrl();
      if (url == null || url.isEmpty) throw StateError('missing_video_url');
      candidate = VideoPlayerController.networkUrl(Uri.parse(url));
      await candidate.initialize();
      await candidate.setLooping(false);
      await candidate.play();
      if (!mounted) {
        await candidate.dispose();
        return;
      }
      setState(() {
        _controller = candidate;
        _starting = false;
      });
      Analytics.capture('chat_video_play_inline', {
        'kind': widget.job.kind.wire,
        'job_id': widget.job.jobId,
      });
    } catch (e, st) {
      await candidate?.dispose();
      if (mounted) {
        setState(() {
          _starting = false;
          _failed = true;
        });
      }
      await Analytics.captureException(e, st, screen: 'chat_thread', handled: true, extra: {
        'stage': 'generated_video_inline_play',
        'kind': widget.job.kind.wire,
        'job_id': widget.job.jobId,
      });
    }
  }

  @override
  void dispose() { _controller?.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final c = _controller;
    final posterUrl = widget.job.thumbnailUrl;
    return AspectRatio(
      aspectRatio: 1,
      child: Container(
        color: Colors.black,
        child: Stack(alignment: Alignment.center, children: [
          if (c != null && c.value.isInitialized)
            Center(
              child: AspectRatio(
                aspectRatio:
                    c.value.aspectRatio == 0 ? 16 / 9 : c.value.aspectRatio,
                child: VideoPlayer(c),
              ),
            )
          else if (posterUrl != null && posterUrl.isNotEmpty)
            Positioned.fill(
              child: CachedImage(
                posterUrl,
                width: double.infinity,
                cacheKey: widget.job.coverMediaId,
                transformUrl: false,
                fit: BoxFit.cover,
              ),
            )
          else
            const Positioned.fill(child: ColoredBox(color: Colors.black)),
          if (c == null || !c.value.isInitialized)
            IconButton.filled(
              tooltip: 'Play video',
              onPressed: _starting ? null : () => unawaited(_toggle()),
              icon: _starting
                  ? const SizedBox.square(
                      dimension: 24,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : Icon(
                      _failed
                          ? PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular)
                          : PhosphorIcons.play(PhosphorIconsStyle.fill),
                      size: 34,
                    ),
              color: Colors.white,
              style: IconButton.styleFrom(
                backgroundColor: Colors.black.withValues(alpha: 0.72),
                minimumSize: const Size(64, 64),
              ),
            ),
          if (c != null && c.value.isInitialized)
            Positioned(
              left: 10,
              right: 10,
              bottom: 8,
              child: ValueListenableBuilder<VideoPlayerValue>(
                valueListenable: c,
                builder: (context, value, _) => Container(
                  padding: const EdgeInsets.fromLTRB(8, 4, 10, 4),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.72),
                    borderRadius: BorderRadius.circular(24),
                  ),
                  child: Row(children: [
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: value.isPlaying ? 'Pause video' : 'Play video',
                      onPressed: () => unawaited(_toggle()),
                      icon: Icon(
                        value.isPlaying
                            ? PhosphorIcons.pause(PhosphorIconsStyle.fill)
                            : PhosphorIcons.play(PhosphorIconsStyle.fill),
                        color: Colors.white,
                      ),
                    ),
                    Expanded(
                      child: VideoProgressIndicator(
                        c,
                        allowScrubbing: true,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        colors: VideoProgressColors(
                          playedColor: AD.bubbleOutPlay,
                          // [UI-COLOURS-2026] Scrubber sits on the black@72%
                          // pill above, so its ink is the on-dark-band cream,
                          // not palette ink. Alphas unchanged (38%/24%).
                          bufferedColor: AD.onBandCream.withValues(alpha: 0.38),
                          backgroundColor: AD.onBandCream.withValues(alpha: 0.24),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '${_time(value.position)} / ${_time(value.duration)}',
                      style: const TextStyle(color: Colors.white, fontSize: 10),
                    ),
                  ]),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}

class _AiMusicJobPreview extends StatelessWidget {
  const _AiMusicJobPreview({
    required this.job,
    required this.onPlay,
    required this.onShare,
    this.coverBytes,
  });

  final AiMediaJob job;
  final Future<void> Function() onPlay;
  final Future<void> Function() onShare;
  final Uint8List? coverBytes;

  static String _titleFor(AiMediaJob job) {
    final songTitle = (job.songTitle ?? '').trim();
    if (songTitle.isNotEmpty) return songTitle;
    final label = job.label.trim();
    if (label.isNotEmpty &&
        !RegExp(
          r'^(generating|ava is creating|song ready|your (song|track)|theme\s*/\s*intent\s*:)',
          caseSensitive: false,
        ).hasMatch(label)) {
      return label;
    }
    return 'Ava original';
  }

  static String _time(Duration value) {
    final totalSeconds = value.inSeconds;
    final minutes = totalSeconds ~/ 60;
    final seconds = totalSeconds % 60;
    return '$minutes:${seconds.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final trackId = job.artifactMediaId ?? '';
    final title = _titleFor(job);
    final description = (job.songDescription ?? '').trim().isNotEmpty
        ? job.songDescription!.trim()
        : title == 'Ava original'
            ? 'AI-generated song\nTap play to listen'
            : 'An Ava-generated original\nReady to play or share';

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: AD.mediaPlaceholderBg,
        border: Border.all(color: AD.borderHairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AspectRatio(
            // Never derive height from an unconstrained `double.infinity` width.
            // A completed song is built inside a vertical ListView, where an
            // infinite explicit height prevents the entire message viewport from
            // laying out. AspectRatio consumes the finite cross-axis constraint
            // supplied by the thread and keeps the large square cover requested by
            // product without letting one card blank every message in the chat.
            aspectRatio: 1,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [AD.headerFooter, AD.bubbleOutPlay.withValues(alpha: 0.72)],
                ),
              ),
              child: Stack(
                children: [
                  if (coverBytes != null)
                    Positioned.fill(
                      child: Image.memory(coverBytes!, fit: BoxFit.cover),
                    )
                  else if ((job.coverUrl ?? '').isNotEmpty)
                    Positioned.fill(
                      child: LayoutBuilder(
                        builder: (context, constraints) => _AiMusicCoverImage(
                          jobId: job.jobId,
                          initialUrl: job.coverUrl!,
                          width: constraints.maxWidth,
                          cacheKey: job.coverMediaId,
                        ),
                      ),
                    ),
                  Positioned.fill(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.center,
                          colors: [Colors.black.withValues(alpha: 0.42), Colors.transparent],
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    right: -28,
                    top: -20,
                    child: Container(
                      width: 144,
                      height: 144,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.white.withValues(alpha: 0.10),
                      ),
                    ),
                  ),
                  Center(
                    child: Container(
                      width: 104,
                      height: 104,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: AD.headerFooter.withValues(alpha: 0.84),
                        border: Border.all(color: Colors.white.withValues(alpha: 0.32), width: 7),
                      ),
                      child: Center(
                        child: PhosphorIcon(
                          PhosphorIcons.musicNote(PhosphorIconsStyle.fill),
                          size: 42,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s3, Msg.s2, Msg.s3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.threadName(c: Colors.black).copyWith(fontSize: 18),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Share $title',
                      onPressed: () => unawaited(onShare()),
                      icon: Icon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.regular)),
                      color: Colors.black,
                      style: IconButton.styleFrom(
                        // [UI-COLOURS-2026] Accent yellow — the same role the
                        // sibling play button already takes from the palette
                        // (AD.bubbleOutPlay is haldi).
                        backgroundColor: AD.haldi,
                      ),
                    ),
                  ],
                ),
                Text(
                  description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  // [UI-COLOURS-2026] Body copy on the light card — palette ink
                  // at the same 87% the literal carried.
                  style: ADText.preview(c: AD.textPrimary.withValues(alpha: 0.87))
                      .copyWith(fontSize: 12, height: 1.25),
                ),
                const SizedBox(height: Msg.s2),
                ValueListenableBuilder<PlaybackState?>(
                  valueListenable: AudioPlaybackService.I.state,
                  builder: (context, state, _) {
                    final isCurrent = trackId.isNotEmpty && AudioPlaybackService.I.isCurrent(trackId);
                    final duration = isCurrent
                        ? state?.duration
                        : AudioPlaybackService.I.knownDuration(trackId);
                    final position = isCurrent
                        ? (state?.position ?? Duration.zero)
                        : (AudioPlaybackService.I.savedPosition(trackId) ?? Duration.zero);
                    final durationMs = duration?.inMilliseconds ?? 0;
                    final maxMs = durationMs > 0 ? durationMs : 1;
                    final positionMs = position.inMilliseconds.clamp(0, maxMs).toDouble();
                    final playing = isCurrent && (state?.playing ?? false);
                    final canSeek = isCurrent && durationMs > 0;

                    return Row(
                      children: [
                        IconButton.filled(
                          tooltip: playing ? 'Pause $title' : 'Play $title',
                          onPressed: trackId.isEmpty
                              ? null
                              : () => unawaited(
                                    isCurrent
                                        ? (playing
                                            ? AudioPlaybackService.I.pause()
                                            : AudioPlaybackService.I.resume())
                                        : onPlay(),
                                  ),
                          icon: Icon(playing
                              ? PhosphorIcons.pause(PhosphorIconsStyle.fill)
                              : PhosphorIcons.play(PhosphorIconsStyle.fill)),
                          color: AD.headerFooter,
                          style: IconButton.styleFrom(backgroundColor: AD.bubbleOutPlay),
                        ),
                        const SizedBox(width: Msg.s2),
                        Expanded(
                          child: Column(
                            children: [
                              SliderTheme(
                                data: SliderTheme.of(context).copyWith(
                                  trackHeight: 3,
                                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                                ),
                                child: Slider(
                                  value: positionMs,
                                  max: maxMs.toDouble(),
                                  activeColor: AD.bubbleOutPlay,
                                  inactiveColor: AD.borderHairline,
                                  onChanged: canSeek
                                      ? (value) => unawaited(
                                            AudioPlaybackService.I.seek(
                                              Duration(milliseconds: value.round()),
                                            ),
                                          )
                                      : null,
                                ),
                              ),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  // [UI-COLOURS-2026] Muted timestamp captions
                                  // on paper -> the tertiary ink token.
                                  Text(_time(position), style: ADText.statCaption(c: AD.textTertiary)),
                                  Text(
                                    duration == null ? '—:—' : _time(duration),
                                    style: ADText.statCaption(c: AD.textTertiary),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                    );
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Paints a private generated cover from its short-lived URL and re-mints the
/// URL once if that credential expired before the disk cache was populated.
class _AiMusicCoverImage extends StatefulWidget {
  const _AiMusicCoverImage({
    required this.jobId,
    required this.initialUrl,
    required this.width,
    this.cacheKey,
  });

  final String jobId;
  final String initialUrl;
  final double width;
  final String? cacheKey;

  @override
  State<_AiMusicCoverImage> createState() => _AiMusicCoverImageState();
}

class _AiMusicCoverImageState extends State<_AiMusicCoverImage> {
  late String _url = widget.initialUrl;
  bool _refetching = false;
  bool _refetched = false;

  @override
  void didUpdateWidget(covariant _AiMusicCoverImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialUrl != widget.initialUrl || oldWidget.jobId != widget.jobId) {
      _url = widget.initialUrl;
      _refetching = false;
      _refetched = false;
    }
  }

  Future<void> _onResult(bool ok) async {
    if (ok || _refetching || _refetched) return;
    _refetching = true;
    _refetched = true;
    try {
      final fresh = await AiMediaJobRepository.I.fetch(widget.jobId);
      final freshUrl = fresh?.coverUrl;
      if (mounted && freshUrl != null && freshUrl.isNotEmpty && freshUrl != _url) {
        setState(() => _url = freshUrl);
      }
    } finally {
      _refetching = false;
    }
  }

  @override
  Widget build(BuildContext context) => CachedImage(
        _url,
        width: widget.width,
        height: widget.width,
        fit: BoxFit.cover,
        cacheKey: widget.cacheKey,
        transformUrl: false,
        onResult: (ok) => unawaited(_onResult(ok)),
      );
}
