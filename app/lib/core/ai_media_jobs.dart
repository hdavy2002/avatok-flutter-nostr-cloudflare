import 'dart:async';
import 'dart:convert';

import 'account_storage.dart';
import 'analytics.dart';
import 'api_auth.dart';
import 'ava_log.dart';
import 'config.dart';
import 'disk_cache.dart';

/// [AVA-MEDIA-JOB-1] Client half of the durable AI-media-job abstraction.
///
/// Root cause this replaces (Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md
/// Part VI §36-§37): image generation, PDF summarize/translate and audio
/// transcribe/translate each invented their own transient, unaddressable status
/// row. `chat_thread.dart` swept EVERY `ava_status` message on the next Ava reply
/// (`removeWhere((m) => m.special == 'ava_status')`), so a still-running image job
/// could vanish the moment an unrelated text answer arrived. This file is the
/// single source of truth for job state on the client: one record per `job_id`,
/// hydrated from a scoped on-disk cache so a pending job survives an app
/// backgrounding/restart, and reconciled against the server so a job that
/// finished while the app was away is never lost.
///
/// Server contract (worker/src/lib/ai_media_jobs.ts + worker/src/routes/ai_media_jobs.ts) —
/// VERIFIED against the real S5 implementation (this file originally guessed the
/// shapes below from the Part VII handoff spec §43 because the server files didn't
/// exist yet when it was written; [AI-FLAG-CONTRACT-1] gate finding reconciled it
/// against the actual code — see that pass's report for every mismatch found):
///   POST /api/ai/jobs                { conv, kind, source_media_id?, label?,
///                                      target_language?, estimate?, job_id? }
///                                    -> 200 { ok:true, job }
///                                    -> 402 { error:"AI_INSUFFICIENT_TOKENS", needed, balance }
///   GET  /api/ai/jobs/:job_id        -> 200 { ok:true, job }
///   POST /api/ai/jobs/:job_id/cancel -> 200 { ok:true, job }
///   GET  /api/ai/jobs?conv=...       -> 200 { ok:true, jobs:[...] } — reconnect/hydrate
///
/// IMPORTANT: create/get/cancel all wrap the job in a `{ok:true, job:{...}}`
/// ENVELOPE, never a bare job object — every one of those three call sites
/// below unwraps `body['job']` before calling [AiMediaJob.fromJson]. Only the
/// list endpoint uses a different envelope (`{ok:true, jobs:[...]}`). The
/// create-request's conversation field is `conv` (NOT `conv_id` — that name is
/// only used on the RESPONSE job object).
///
/// The route only ever returns "safe metadata" (§43.2): job id, kind, status,
/// label, progress, artifact_media_id, timestamps, error code. Never a raw
/// prompt, transcript, caption or provider error string — so this file never
/// has any of that to accidentally log, and every `Analytics` call below is
/// safe by construction.

/// Mirrors `AiMediaJobKind` in `worker/src/lib/ai_media_jobs.ts`.
enum AiMediaJobKind { imageGenerate, videoGenerate, musicGenerate, docSummarize, docTranslate, audioTranscribe, audioTranslate }

extension AiMediaJobKindWire on AiMediaJobKind {
  String get wire => switch (this) {
        AiMediaJobKind.imageGenerate => 'image_generate',
        AiMediaJobKind.videoGenerate => 'venice_video_generate',
        AiMediaJobKind.musicGenerate => 'venice_music_generate',
        AiMediaJobKind.docSummarize => 'doc_summarize',
        AiMediaJobKind.docTranslate => 'doc_translate',
        AiMediaJobKind.audioTranscribe => 'audio_transcribe',
        AiMediaJobKind.audioTranslate => 'audio_translate',
      };

  /// Display noun for generic copy ("Working on your <noun>…"). The card prefers
  /// the server's own `label` when present; this is only the fallback.
  String get displayNoun => switch (this) {
        AiMediaJobKind.imageGenerate => 'image',
        AiMediaJobKind.videoGenerate => 'video',
        AiMediaJobKind.musicGenerate => 'song',
        AiMediaJobKind.docSummarize => 'summary',
        AiMediaJobKind.docTranslate => 'translation',
        AiMediaJobKind.audioTranscribe => 'transcript',
        AiMediaJobKind.audioTranslate => 'translated audio',
      };

  static AiMediaJobKind? fromWire(String? s) => switch (s) {
        'image_generate' => AiMediaJobKind.imageGenerate,
        'venice_video_generate' => AiMediaJobKind.videoGenerate,
        'venice_music_generate' => AiMediaJobKind.musicGenerate,
        'doc_summarize' => AiMediaJobKind.docSummarize,
        'doc_translate' => AiMediaJobKind.docTranslate,
        'audio_transcribe' => AiMediaJobKind.audioTranscribe,
        'audio_translate' => AiMediaJobKind.audioTranslate,
        _ => null,
      };
}

/// Mirrors `AiMediaJobStatus` in `worker/src/lib/ai_media_jobs.ts`.
enum AiMediaJobStatus { queued, running, succeeded, failed, cancelled }

extension AiMediaJobStatusWire on AiMediaJobStatus {
  String get wire => name;

  static AiMediaJobStatus fromWire(String? s) => switch (s) {
        'queued' => AiMediaJobStatus.queued,
        'running' => AiMediaJobStatus.running,
        'succeeded' => AiMediaJobStatus.succeeded,
        'failed' => AiMediaJobStatus.failed,
        'cancelled' => AiMediaJobStatus.cancelled,
        _ => AiMediaJobStatus.queued, // unknown → treat as still-working, never drop silently
      };
}

int _nowS() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

int _epoch(dynamic v, {int? fallback}) {
  if (v == null) return fallback ?? _nowS();
  final n = v is num ? v.toInt() : int.tryParse(v.toString());
  if (n == null) return fallback ?? _nowS();
  // VERIFIED against worker/src/lib/ai_media_jobs.ts's `now()` (= `Date.now()`,
  // the sole writer of created_at/updated_at/completed_at per
  // worker/migrations/2026-07-25-ai-media-jobs.sql's plain INTEGER columns) —
  // the server always sends MILLISECONDS. Kept as an auto-detecting heuristic
  // rather than an unconditional /1000 anyway: epoch SECONDS for "now" is
  // ~1.7e9, epoch MILLISECONDS for "now" is ~1.7e12, and anything past 1e11
  // can only be a millisecond timestamp for any date this app will ever run
  // on — so a defensive fallback costs nothing and survives a hypothetical
  // future server-side unit change silently.
  return n.abs() > 100000000000 ? (n / 1000).round() : n;
}

double? _progress(dynamic v) {
  if (v == null) return null;
  final n = v is num ? v.toDouble() : double.tryParse(v.toString());
  if (n == null) return null;
  // VERIFIED against worker/migrations/2026-07-25-ai-media-jobs.sql: `progress
  // INTEGER NOT NULL DEFAULT 0` and completeAiMediaJob()'s `progress=100` —
  // the server reports a 0..100 PERCENTAGE, not a 0..1 fraction. The old
  // `v.toDouble().clamp(0.0, 1.0)` here silently mapped every mid-job value
  // (e.g. progress=50) up to 1.0 ("done"), which would have rendered every
  // in-flight doc/audio job's progress bar as already complete. Normalize to
  // the 0..1 fraction this class's API uses; treat an already-fractional
  // value (<=1) as already normalized, defensively.
  final frac = n > 1 ? n / 100 : n;
  return frac.clamp(0.0, 1.0);
}

String? _str(Map<String, dynamic> j, List<String> keys) {
  for (final k in keys) {
    final v = j[k];
    if (v != null && v.toString().isNotEmpty) return v.toString();
  }
  return null;
}

/// One durable AI media job. Immutable; every mutation goes through
/// [AiMediaJobRepository], which is the only writer of the on-disk cache.
class AiMediaJob {
  final String jobId;
  final AiMediaJobKind kind;
  final AiMediaJobStatus status;
  final String convId;
  final String? sourceMediaId;

  /// Safe, server-vetted progress copy, e.g. "Translating to Hindi…". Never a
  /// raw prompt/transcript — the server route contract guarantees this.
  final String label;
  final double? progress; // 0..1, nullable (server may not always report it)

  /// The finished artifact's media id, once `status == succeeded`. VERIFIED
  /// wire field name (worker/src/lib/ai_media_jobs.ts `AiMediaJobRecord.artifact_media_id`,
  /// worker/migrations/2026-07-25-ai-media-jobs.sql `artifact_media_id` column)
  /// — the server never sends `artifact_id`; an earlier version of this file
  /// hedged both names, which is exactly the kind of guess this reconciliation
  /// pass removes (a real rename would have silently kept "working" via the
  /// wrong fallback instead of surfacing as a missing field). A stable
  /// identity (never re-minted) — used as e.g. an audio-playback track id
  /// (see `AudioPlaybackService.playArtifact`), NEVER as a URL.
  final String? artifactMediaId;

  /// [AVA-MEDIA-JOB-2] THE field every open/download/share/play action uses.
  /// VERIFIED wire field (worker/src/lib/ai_media_jobs.ts `AiMediaJobRecord.artifact_url`,
  /// `resolveArtifactUrl`): null until `status=='succeeded'`, then either a
  /// stable public CDN URL (public artifacts) or a 900-SECOND PRESIGNED URL
  /// (private artifacts) — re-minted fresh on EVERY server read of this job
  /// (`fetchJob`/`listJobs`), never persisted server-side. This is exactly why
  /// the earlier parked attempt broke: it treated the bare `artifact_media_id`
  /// UUID as if it were a fetchable URL, so every Open/Download/Share said
  /// "still syncing" forever (nothing ever matched). Do NOT cache this value
  /// long-term or persist it as if durable — a card that has sat on screen for
  /// more than ~15 minutes must call [AiMediaJobRepository.fetch] again before
  /// using it (every action call site in chat_thread.dart does this via
  /// `_freshArtifactUrl`). Still round-tripped through the local disk cache
  /// ([toJson]/[fromCacheJson]) purely as a "last known, may already be
  /// stale" convenience for an instant repaint on hydrate — never trusted for
  /// an actual network fetch without a fresh re-read first.
  final String? artifactUrl;

  /// Optional rich-card metadata for generated music. Cover URLs follow the
  /// same short-lived presign contract as [artifactUrl].
  final String? songTitle;
  final String? songDescription;
  final String? coverMediaId;
  final String? coverUrl;
  final String? coverStatus;

  /// Safe error code only (e.g. `provider_timeout`, `unsupported_format`) —
  /// NEVER a raw provider error string. The card renders a friendly message
  /// keyed off this code and always offers Retry; it never surfaces [errorCode]
  /// itself to the user as-is.
  final String? errorCode;

  final int createdAt; // epoch seconds
  final int updatedAt; // epoch seconds
  final int? completedAt; // epoch seconds

  /// LOCAL-ONLY, never sent to or read from the server: the original creation
  /// body, kept so [AiMediaJobRepository.retry] can re-submit the same
  /// request without the caller having to remember it. May legitimately
  /// contain a prompt/target-language — it is cached on-device exactly like
  /// any other message content (see DiskCache's own docs), and is never
  /// attached to an Analytics call.
  final Map<String, dynamic>? createParams;

  const AiMediaJob({
    required this.jobId,
    required this.kind,
    required this.status,
    required this.convId,
    this.sourceMediaId,
    this.label = '',
    this.progress,
    this.artifactMediaId,
    this.artifactUrl,
    this.songTitle,
    this.songDescription,
    this.coverMediaId,
    this.coverUrl,
    this.coverStatus,
    this.errorCode,
    required this.createdAt,
    required this.updatedAt,
    this.completedAt,
    this.createParams,
  });

  bool get isWorking => status == AiMediaJobStatus.queued || status == AiMediaJobStatus.running;
  bool get isTerminal => !isWorking;
  bool get isSucceeded => status == AiMediaJobStatus.succeeded;
  bool get isFailed => status == AiMediaJobStatus.failed;
  bool get isCancelled => status == AiMediaJobStatus.cancelled;

  /// A stable key for anything (widget key, cache row, list dedup) that must be
  /// addressable by job identity alone.
  String get cacheKey => jobId;

  AiMediaJob copyWith({
    AiMediaJobStatus? status,
    String? label,
    double? progress,
    String? artifactMediaId,
    String? artifactUrl,
    String? songTitle,
    String? songDescription,
    String? coverMediaId,
    String? coverUrl,
    String? coverStatus,
    String? errorCode,
    int? updatedAt,
    int? completedAt,
    Map<String, dynamic>? createParams,
  }) =>
      AiMediaJob(
        jobId: jobId,
        kind: kind,
        status: status ?? this.status,
        convId: convId,
        sourceMediaId: sourceMediaId,
        label: label ?? this.label,
        progress: progress ?? this.progress,
        artifactMediaId: artifactMediaId ?? this.artifactMediaId,
        artifactUrl: artifactUrl ?? this.artifactUrl,
        songTitle: songTitle ?? this.songTitle,
        songDescription: songDescription ?? this.songDescription,
        coverMediaId: coverMediaId ?? this.coverMediaId,
        coverUrl: coverUrl ?? this.coverUrl,
        coverStatus: coverStatus ?? this.coverStatus,
        errorCode: errorCode ?? this.errorCode,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
        completedAt: completedAt ?? this.completedAt,
        createParams: createParams ?? this.createParams,
      );

  /// Merge a freshly-received SERVER record on top of this (possibly
  /// locally-richer) record: every server-authoritative field wins, but
  /// [createParams] — which the server never returns — is preserved from the
  /// local side. This is what lets `retry()` work after a reconcile/poll cycle.
  AiMediaJob mergeServer(AiMediaJob incoming) => incoming.copyWith(createParams: createParams);

  /// [j] must be the unwrapped `job` object itself (i.e. `body['job']` for
  /// create/get/cancel, or one element of `body['jobs']` for list) — NEVER
  /// the `{ok:true, job:{...}}` envelope. Field names below are the exact
  /// `AiMediaJobRecord` column names (worker/src/lib/ai_media_jobs.ts); no
  /// camelCase/alternate-name guessing — a real server rename should fail
  /// loudly (missing job_id below throws) rather than silently match a
  /// fallback that was never actually sent.
  factory AiMediaJob.fromJson(Map<String, dynamic> j, {required String fallbackConvId}) {
    final jobId = _str(j, ['job_id']);
    if (jobId == null) {
      throw FormatException('ai_media_job payload missing job_id: keys=${j.keys.toList()}');
    }
    return AiMediaJob(
      jobId: jobId,
      kind: AiMediaJobKindWire.fromWire(_str(j, ['kind'])) ?? AiMediaJobKind.imageGenerate,
      status: AiMediaJobStatusWire.fromWire(_str(j, ['status'])),
      convId: _str(j, ['conv_id']) ?? fallbackConvId,
      sourceMediaId: _str(j, ['source_media_id']),
      label: _str(j, ['label']) ?? '',
      progress: _progress(j['progress']),
      artifactMediaId: _str(j, ['artifact_media_id']),
      artifactUrl: _str(j, ['artifact_url']),
      songTitle: _str(j, ['song_title']),
      songDescription: _str(j, ['song_description']),
      coverMediaId: _str(j, ['cover_media_id']),
      coverUrl: _str(j, ['cover_url']),
      coverStatus: _str(j, ['cover_status']),
      errorCode: _str(j, ['error_code']),
      createdAt: _epoch(j['created_at']),
      updatedAt: _epoch(j['updated_at'], fallback: _epoch(j['created_at'])),
      completedAt: j['completed_at'] == null ? null : _epoch(j['completed_at']),
    );
  }

  /// Local cache round-trip (includes [createParams], unlike [fromJson]/the wire
  /// format, which never carries it in either direction with the server).
  Map<String, dynamic> toJson() => {
        'job_id': jobId,
        'kind': kind.wire,
        'status': status.wire,
        'conv_id': convId,
        if (sourceMediaId != null) 'source_media_id': sourceMediaId,
        'label': label,
        if (progress != null) 'progress': progress,
        if (artifactMediaId != null) 'artifact_media_id': artifactMediaId,
        // [AVA-MEDIA-JOB-2] Last-known convenience ONLY (instant repaint on
        // hydrate before the first reconcile() lands) — this presigned URL
        // expires in 900s server-side, so it may already be stale by the time
        // it's read back. Every actual open/download/share/play call site
        // re-fetches the job first; see [artifactUrl]'s own doc comment.
        if (artifactUrl != null) 'artifact_url': artifactUrl,
        if (songTitle != null) 'song_title': songTitle,
        if (songDescription != null) 'song_description': songDescription,
        if (coverMediaId != null) 'cover_media_id': coverMediaId,
        if (coverUrl != null) 'cover_url': coverUrl,
        if (coverStatus != null) 'cover_status': coverStatus,
        if (errorCode != null) 'error_code': errorCode,
        'created_at': createdAt,
        'updated_at': updatedAt,
        if (completedAt != null) 'completed_at': completedAt,
        if (createParams != null) 'create_params': createParams,
      };

  factory AiMediaJob.fromCacheJson(Map<String, dynamic> j) {
    final base = AiMediaJob.fromJson(j, fallbackConvId: (j['conv_id'] ?? '').toString());
    final params = j['create_params'];
    return base.copyWith(createParams: params is Map ? params.cast<String, dynamic>() : null);
  }
}

/// One repository update: either an upsert ([removed] == false) or an explicit
/// removal (user deleted the result, or a job was forgotten). Consumers key
/// their UI by `job.jobId`/[jobId] alone — never by list position or by
/// "clear everything", which is the exact bug this replaces.
class AiMediaJobUpdate {
  final String jobId;
  final AiMediaJob? job; // null when removed == true
  final bool removed;
  const AiMediaJobUpdate({required this.jobId, this.job, this.removed = false});
}

/// Wire-shaped RESERVE-time size hint for [AiMediaJobRepository.create] —
/// mirrors the `estimate` object in POST /api/ai/jobs's body contract exactly
/// (worker/src/routes/ai_media_jobs.ts reads `estimate.max_input_tokens` /
/// `.max_output_tokens` / `.images` / `.av_seconds`). A typed class instead of
/// a raw `Map<String, dynamic>` so a caller can't repeat this reconciliation
/// pass's own root cause — guessing a snake_case key name that the server
/// doesn't actually read. All fields optional: omit anything unknown and the
/// server's own per-kind defaults apply (worker/src/lib/ai_media_jobs.ts
/// `DEFAULT_ESTIMATE`).
class AiMediaJobEstimate {
  final int? maxInputTokens;
  final int? maxOutputTokens;
  final int? images;
  final int? avSeconds;
  const AiMediaJobEstimate({this.maxInputTokens, this.maxOutputTokens, this.images, this.avSeconds});

  Map<String, dynamic> toJson() => {
        if (maxInputTokens != null) 'max_input_tokens': maxInputTokens,
        if (maxOutputTokens != null) 'max_output_tokens': maxOutputTokens,
        if (images != null) 'images': images,
        if (avSeconds != null) 'av_seconds': avSeconds,
      };
}

/// Outcome of [AiMediaJobRepository.create]. A plain `AiMediaJob?` cannot
/// distinguish "the server rejected this for an ordinary reason" from HTTP
/// 402 `AI_INSUFFICIENT_TOKENS` — and collapsing that distinction is the
/// entire root cause this program exists to fix (CLAUDE.md: a 402 rendered to
/// a user as "Sorry, I could not find an answer"). Callers that only care
/// about the happy path can keep reading [job]; anything building a paywall/
/// top-up prompt must check [insufficientTokens] instead of inferring it from
/// a null job.
class AiMediaJobCreateOutcome {
  final AiMediaJob? job;
  final bool insufficientTokens;
  final int? tokensNeeded;
  final int? tokensBalance;
  const AiMediaJobCreateOutcome._({this.job, this.insufficientTokens = false, this.tokensNeeded, this.tokensBalance});
  const AiMediaJobCreateOutcome.success(AiMediaJob job) : this._(job: job);
  const AiMediaJobCreateOutcome.insufficient({int? needed, int? balance})
      : this._(insufficientTokens: true, tokensNeeded: needed, tokensBalance: balance);
  const AiMediaJobCreateOutcome.failure() : this._();
  bool get ok => job != null;
}

/// Repository + reconciliation engine. Singleton (`AiMediaJobRepository.I`),
/// mirroring the established `ChatHistoryService.I` idiom in this codebase.
///
/// Every read/write of the on-disk cache goes through [scopedKey] (from
/// `core/account_storage.dart`), and every cache file additionally lives inside
/// [DiskCache]'s own per-`AccountScope.id` directory — belt-and-braces scoping so
/// a parent/child pair sharing one phone can never see each other's pending jobs
/// (CLAUDE.md per-account-scoping rule; the same double-scoping style already
/// used by `AvaAiStore`/`readScoped`).
class AiMediaJobRepository {
  AiMediaJobRepository._();
  static final AiMediaJobRepository I = AiMediaJobRepository._();

  /// All known jobs, keyed by job_id, regardless of conversation. This is the
  /// single write path; [jobsFor] is a filtered read view over it.
  final Map<String, AiMediaJob> _byId = {};

  final StreamController<AiMediaJobUpdate> _updatesCtl = StreamController.broadcast();

  /// Broadcast of every upsert/removal across ALL conversations. Consumers
  /// (chat_thread.dart) filter by `update.job?.convId == convId` /
  /// `update.jobId` themselves — this keeps one subscription doing the work
  /// for however many threads are mounted, instead of a stream-per-conv.
  Stream<AiMediaJobUpdate> get updates => _updatesCtl.stream;

  final Map<String, Timer> _pollTimers = {};
  static const Duration _pollInterval = Duration(seconds: 3);
  static const Duration _pollIntervalBackoff = Duration(seconds: 8); // after several empty ticks

  final Map<String, int> _pollTicks = {};

  String _cacheKey(String convId) => scopedKey('ai_media_jobs::$convId');

  /// Jobs currently known for [convId], newest first. Synchronous — reads the
  /// in-memory cache only; call [hydrate] first to seed it from disk.
  List<AiMediaJob> jobsFor(String convId) {
    final list = _byId.values.where((j) => j.convId == convId).toList()
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return List.unmodifiable(list);
  }

  AiMediaJob? byId(String jobId) => _byId[jobId];

  // ── Lifecycle: open / resume a conversation ────────────────────────────────

  /// Convenience for Wave 3: hydrate the local cache, then reconcile against
  /// the server, then start polling if anything is still working. Call this
  /// from the thread's `initState` AND from `didChangeAppLifecycleState`
  /// (resumed) — the latter is what stops a job from being "lost" while the
  /// app was backgrounded (Part VI's core defect).
  Future<void> openConversation(String convId) async {
    await hydrate(convId);
    await reconcile(convId);
  }

  /// Load cached jobs for [convId] from the scoped on-disk cache into memory
  /// and emit an upsert for each, WITHOUT hitting the network. Call this first
  /// so a reopened thread renders instantly from local state, then follow with
  /// [reconcile] to pick up anything that changed server-side.
  Future<List<AiMediaJob>> hydrate(String convId) async {
    try {
      final raw = await DiskCache.read(_cacheKey(convId));
      if (raw == null || raw.isEmpty) return jobsFor(convId);
      final list = (jsonDecode(raw) as List)
          .cast<Map<String, dynamic>>()
          .map(AiMediaJob.fromCacheJson)
          .toList();
      for (final j in list) {
        _apply(j, notify: true);
      }
      return jobsFor(convId);
    } catch (e, st) {
      // A corrupt/unreadable cache must never blank the thread's job cards —
      // fall through to whatever is already in memory (possibly nothing; the
      // subsequent reconcile() still recovers from the server).
      await Analytics.captureException(e, st, screen: 'ai_media_jobs', handled: true, extra: {
        'stage': 'hydrate',
      });
      AvaLog.I.log('ai_media_jobs', 'hydrate failed for conv: $e');
      return jobsFor(convId);
    }
  }

  /// Hit `GET /api/ai/jobs?conv=...` and merge the result into the cache.
  /// Duplicate-safe: [_apply] only notifies listeners when a record actually
  /// changed, so a poll landing right after a push (or another poll) is a
  /// harmless no-op rather than a second card. Auto-manages polling: if any
  /// job for [convId] is still working after this call, a poll loop is
  /// (re)armed; if none are, any existing loop is stopped.
  Future<void> reconcile(String convId) async {
    try {
      final url = '$kApiBase/ai/jobs?conv=${Uri.encodeQueryComponent(convId)}';
      final res = await ApiAuth.getSigned(url, timeout: const Duration(seconds: 12));
      if (res.statusCode != 200) {
        Analytics.capture('ai_media_job_reconcile_failed', {
          'status': res.statusCode,
        });
        return;
      }
      // VERIFIED envelope: `{ok:true, jobs:[...]}` (worker/src/routes/ai_media_jobs.ts
      // aiMediaJobsList) — always a Map with a `jobs` array, never a bare array.
      final decoded = jsonDecode(res.body);
      if (decoded is! Map || decoded['jobs'] is! List) return;
      for (final r in decoded['jobs'] as List) {
        if (r is Map<String, dynamic>) {
          _apply(AiMediaJob.fromJson(r, fallbackConvId: convId), notify: true);
        }
      }
      await _persist(convId);
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'ai_media_jobs', handled: true, extra: {
        'stage': 'reconcile',
      });
      AvaLog.I.log('ai_media_jobs', 'reconcile failed: $e');
    } finally {
      _rearmPolling(convId);
    }
  }

  /// `{ok:true, job:{...}}` -> the unwrapped job map, or null if the body isn't
  /// that shape. create/get/cancel all use this ONE envelope (VERIFIED against
  /// worker/src/routes/ai_media_jobs.ts — every one of those three handlers
  /// returns `json({ ok: true, job })`, never a bare job object).
  Map<String, dynamic>? _unwrapJob(String rawBody) {
    try {
      final decoded = jsonDecode(rawBody);
      if (decoded is Map && decoded['job'] is Map) {
        return (decoded['job'] as Map).cast<String, dynamic>();
      }
    } catch (_) {
      // fall through to null
    }
    return null;
  }

  /// Fetch exactly one job by id (`GET /api/ai/jobs/:job_id`) and merge it in.
  /// Used for a targeted refresh (e.g. a push notification names a job_id but
  /// carries no full payload).
  Future<AiMediaJob?> fetch(String jobId) async {
    try {
      final url = '$kApiBase/ai/jobs/${Uri.encodeComponent(jobId)}';
      final res = await ApiAuth.getSigned(url, timeout: const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      final j = _unwrapJob(res.body);
      if (j == null) return null;
      final existing = _byId[jobId];
      final job = AiMediaJob.fromJson(j, fallbackConvId: existing?.convId ?? '');
      _apply(job, notify: true);
      await _persist(job.convId);
      return _byId[jobId];
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'ai_media_jobs', handled: true, extra: {
        'stage': 'fetch',
      });
      return null;
    }
  }

  /// Explicitly publish a completed generated song and return its opaque
  /// share page URL. The server does not create this token until this method
  /// is called, so private generated audio is not public by default.
  Future<String?> createSongShareLink(String jobId) async {
    try {
      final res = await ApiAuth.postJson(
        '$kApiBase/ai/jobs/${Uri.encodeComponent(jobId)}/share',
        const <String, dynamic>{},
        timeout: const Duration(seconds: 12),
      );
      if (res.statusCode != 200) return null;
      final decoded = jsonDecode(res.body);
      if (decoded is! Map) return null;
      final url = (decoded['url'] ?? '').toString().trim();
      return url.isEmpty ? null : url;
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'ai_media_jobs', handled: true,
          extra: {'stage': 'create_song_share_link'});
      return null;
    }
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  /// Create a new job (`POST /api/ai/jobs`). VERIFIED request contract
  /// (worker/src/routes/ai_media_jobs.ts aiMediaJobsCreate): the conversation
  /// field is `conv` (NOT `conv_id` — that name only appears on the RESPONSE
  /// job object). [label]/[targetLanguage]/[estimate]/[jobId] are the server's
  /// real optional fields, sent explicitly rather than guessed; [params] stays
  /// available for forward-compat/passthrough (e.g. [retry] replays a prior
  /// call's exact body through it) and is merged in last, so it can still
  /// override the typed args if a caller deliberately sets both.
  ///
  /// Returns an [AiMediaJobCreateOutcome], NOT a bare `AiMediaJob?` — HTTP 402
  /// `AI_INSUFFICIENT_TOKENS` is surfaced as [AiMediaJobCreateOutcome.insufficientTokens],
  /// distinct from every other failure. This is a deliberate signature change
  /// from the version of this file S6 originally wrote (a plain `Future<AiMediaJob?>`
  /// could not tell a paywall apart from a real error — exactly the CLAUDE.md
  /// "402 rendered as 'could not find an answer'" lesson this program exists
  /// to fix). On success the new job is upserted into the cache (status
  /// `queued`) and polling for [convId] is armed immediately, so the caller
  /// can render a pending card the instant this returns — no separate "local
  /// pending" state needed (Part VII §44's `image_tool.dart` note: "Remove any
  /// independent 'image pending' state that cannot survive reconnect").
  Future<AiMediaJobCreateOutcome> create({
    required String convId,
    required AiMediaJobKind kind,
    String? sourceMediaId,
    String? label,
    String? targetLanguage,
    AiMediaJobEstimate? estimate,
    String? jobId,
    Map<String, dynamic>? params,
  }) async {
    final body = <String, dynamic>{
      'kind': kind.wire,
      'conv': convId,
      if (sourceMediaId != null) 'source_media_id': sourceMediaId,
      if (label != null) 'label': label,
      if (targetLanguage != null) 'target_language': targetLanguage,
      if (estimate != null) 'estimate': estimate.toJson(),
      if (jobId != null) 'job_id': jobId,
      ...?params,
    };
    try {
      final res = await ApiAuth.postJson('$kApiBase/ai/jobs', body, timeout: const Duration(seconds: 15));
      if (res.statusCode == 402) {
        Map<String, dynamic>? err;
        try {
          err = jsonDecode(res.body) as Map<String, dynamic>;
        } catch (_) {
          err = null;
        }
        final needed = err?['needed'] is num ? (err!['needed'] as num).toInt() : null;
        final balance = err?['balance'] is num ? (err!['balance'] as num).toInt() : null;
        // -1 means "not reported by the server", distinct from a real 0.
        // Analytics.capture takes Map<String, Object> (non-nullable value type),
        // so a bare int? here is a compile error.
        Analytics.capture('ai_media_job_insufficient_tokens', {
          'kind': kind.wire,
          'needed': needed ?? -1,
          'balance': balance ?? -1,
        });
        return AiMediaJobCreateOutcome.insufficient(needed: needed, balance: balance);
      }
      if (res.statusCode != 200 && res.statusCode != 201) {
        Analytics.capture('ai_media_job_create_failed', {
          'kind': kind.wire,
          'status': res.statusCode,
        });
        return const AiMediaJobCreateOutcome.failure();
      }
      final j = _unwrapJob(res.body);
      if (j == null) {
        Analytics.capture('ai_media_job_create_failed', {
          'kind': kind.wire,
          'status': res.statusCode,
          'reason': 'bad_envelope',
        });
        return const AiMediaJobCreateOutcome.failure();
      }
      var job = AiMediaJob.fromJson(j, fallbackConvId: convId);
      // Store EXACTLY what we sent (minus `conv`, redundant with convId, and
      // `job_id`, which retry() must never replay — see retry()'s own note)
      // rather than hand-reconstructing a subset, so retry() can never drift
      // out of sync with what create() actually accepts.
      final storedParams = Map<String, dynamic>.from(body)
        ..remove('conv')
        ..remove('job_id');
      job = job.copyWith(createParams: storedParams);
      _apply(job, notify: true);
      await _persist(convId);
      _rearmPolling(convId);
      Analytics.capture('ai_media_job_created', {'kind': kind.wire, 'job_id': job.jobId});
      return AiMediaJobCreateOutcome.success(_byId[job.jobId]!);
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'ai_media_jobs', handled: true, extra: {
        'stage': 'create',
        'kind': kind.wire,
      });
      return const AiMediaJobCreateOutcome.failure();
    }
  }

  /// Owner-authorized cancel (`POST /api/ai/jobs/:job_id/cancel`). Optimistic:
  /// flips the local record to `cancelled` immediately (so the card updates
  /// without waiting on the round-trip), then reconciles with whatever the
  /// server actually recorded.
  Future<bool> cancel(String jobId) async {
    final existing = _byId[jobId];
    if (existing != null && existing.isTerminal) return true; // already done, nothing to cancel
    if (existing != null) {
      _apply(existing.copyWith(status: AiMediaJobStatus.cancelled, updatedAt: _nowS()), notify: true);
      unawaited(_persist(existing.convId));
    }
    try {
      final url = '$kApiBase/ai/jobs/${Uri.encodeComponent(jobId)}/cancel';
      final res = await ApiAuth.postJson(url, const {}, timeout: const Duration(seconds: 10));
      if (res.statusCode != 200) {
        Analytics.capture('ai_media_job_cancel_failed', {'job_id': jobId, 'status': res.statusCode});
        // Server disagreed (e.g. already succeeded) — pull the real state back.
        await fetch(jobId);
        return false;
      }
      final j = _unwrapJob(res.body);
      if (j == null) return false;
      final job = AiMediaJob.fromJson(j, fallbackConvId: existing?.convId ?? '');
      _apply(job, notify: true);
      await _persist(job.convId);
      return true;
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'ai_media_jobs', handled: true, extra: {
        'stage': 'cancel',
        'job_id': jobId,
      });
      return false;
    }
  }

  /// Retry a failed/cancelled job: there is no server-side retry endpoint in
  /// the contract (§43.2 lists only create/get/cancel/list), so this re-submits
  /// a NEW job with the ORIGINAL creation params cached in [AiMediaJob.createParams]
  /// (see [mergeServer] for why that survives a reconcile). Returns the new job;
  /// the caller (Wave 3) is responsible for swapping which `job_id` the card on
  /// screen is keyed to — see `AiMediaJobCard.keyFor`. Returns null (and reports
  /// via Analytics) if the original params were never cached locally, which can
  /// only happen for a job hydrated from a fresh install/other device.
  ///
  /// [create] now returns a structured [AiMediaJobCreateOutcome] (to carry the
  /// 402 AI_INSUFFICIENT_TOKENS case), but this method's own return type stays
  /// `Future<AiMediaJob?>` — it is on [AiMediaJobRepository]'s protected public
  /// surface. A retry that hits 402 is never silently folded into the generic
  /// `null` case: it gets its own distinct Analytics event
  /// (`ai_media_job_retry_insufficient_tokens`) before returning null, so the
  /// 402-as-generic-failure bug this program exists to fix can't recur here
  /// even though the return type itself can't carry the detail.
  Future<AiMediaJob?> retry(String jobId) async {
    final existing = _byId[jobId];
    final params = existing?.createParams;
    if (existing == null || params == null) {
      Analytics.capture('ai_media_job_retry_unavailable', {'job_id': jobId});
      return null;
    }
    final kind = AiMediaJobKindWire.fromWire(params['kind'] as String?) ?? existing.kind;
    final sourceMediaId = params['source_media_id'] as String?;
    // `job_id` must never be replayed — createAiMediaJob() treats an existing
    // job_id as an idempotent replay and hands back the SAME (failed/cancelled)
    // row untouched rather than actually retrying. create() already strips it
    // from what it stores in createParams, but remove it here too defensively
    // in case a job was hydrated from an older on-disk cache written before
    // that fix.
    final rest = Map<String, dynamic>.from(params)
      ..remove('kind')
      ..remove('source_media_id')
      ..remove('job_id');
    Analytics.capture('ai_media_job_retry', {'kind': kind.wire, 'original_job_id': jobId});
    final outcome = await create(convId: existing.convId, kind: kind, sourceMediaId: sourceMediaId, params: rest);
    if (!outcome.ok) {
      if (outcome.insufficientTokens) {
        Analytics.capture('ai_media_job_retry_insufficient_tokens', {
          'original_job_id': jobId,
          'needed': outcome.tokensNeeded ?? -1,
          'balance': outcome.tokensBalance ?? -1,
        });
      }
      return null;
    }
    return outcome.job;
  }

  /// Explicit local removal — e.g. the user deleted a succeeded artifact's
  /// card. NOT called automatically on terminal state; a finished job is kept
  /// (and stays visible) until the user acts on it, per Part VI §37 ("must
  /// remain in the scrollback while later messages arrive").
  Future<void> forget(String jobId) async {
    final existing = _byId.remove(jobId);
    if (existing == null) return;
    _updatesCtl.add(AiMediaJobUpdate(jobId: jobId, removed: true));
    await _persist(existing.convId);
  }

  // ── Push-event ingestion (duplicate-suppressed, same path as reconcile) ────

  /// Feed a job update that arrived out-of-band (e.g. a future InboxDO
  /// WebSocket push carrying a job envelope) through the SAME upsert/dedup path
  /// as polling. This is what makes "poll delivers it, then the push for the
  /// same transition arrives a moment later" a no-op instead of a duplicate
  /// card: [_apply] compares `updated_at`/status/progress/artifact/error and
  /// only notifies when something actually changed.
  void ingestPushEvent(Map<String, dynamic> json) {
    try {
      final existing = json['job_id'] != null ? _byId[json['job_id'].toString()] : null;
      final job = AiMediaJob.fromJson(json, fallbackConvId: existing?.convId ?? (json['conv_id'] ?? '').toString());
      _apply(job, notify: true);
      unawaited(_persist(job.convId));
    } catch (e, st) {
      Analytics.captureException(e, st, screen: 'ai_media_jobs', handled: true, extra: {'stage': 'ingest_push'});
    }
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  void stopPolling(String convId) {
    _pollTimers.remove(convId)?.cancel();
    _pollTicks.remove(convId);
  }

  /// Stop polling and drop no in-memory state — call from the thread's
  /// `dispose()`. The on-disk cache is untouched, so a reopen still hydrates
  /// instantly.
  void closeConversation(String convId) => stopPolling(convId);

  void _rearmPolling(String convId) {
    final anyWorking = jobsFor(convId).any((j) => j.isWorking);
    if (!anyWorking) {
      stopPolling(convId);
      return;
    }
    if (_pollTimers.containsKey(convId)) return; // already looping
    _pollTicks[convId] = 0;
    _pollTimers[convId] = Timer(_pollInterval, () => _pollTick(convId));
  }

  Future<void> _pollTick(String convId) async {
    _pollTimers.remove(convId);
    final anyWorking = jobsFor(convId).any((j) => j.isWorking);
    if (!anyWorking) return; // reconcile()'s finally will have stopped us already, but be safe
    await reconcile(convId);
    // reconcile() re-arms via _rearmPolling; back off slightly on repeated
    // still-working ticks so a long doc/audio job doesn't hammer the route.
    final ticks = (_pollTicks[convId] ?? 0) + 1;
    _pollTicks[convId] = ticks;
    if (ticks > 5 && _pollTimers.containsKey(convId)) {
      _pollTimers.remove(convId)?.cancel();
      _pollTimers[convId] = Timer(_pollIntervalBackoff, () => _pollTick(convId));
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /// Upsert with duplicate suppression. Returns true if the record VISIBLY
  /// changed (and a notification was emitted) — [artifactUrl] is deliberately
  /// EXCLUDED from that comparison (see below) even though it is always
  /// refreshed in [_byId].
  bool _apply(AiMediaJob incoming, {required bool notify}) {
    final existing = _byId[incoming.jobId];
    if (existing != null) {
      final unchanged = existing.status == incoming.status &&
          existing.updatedAt >= incoming.updatedAt &&
          existing.progress == incoming.progress &&
          existing.artifactMediaId == incoming.artifactMediaId &&
          existing.errorCode == incoming.errorCode &&
          existing.label == incoming.label;
      // [AVA-MEDIA-JOB-2] `artifact_url` is RE-MINTED by the server on every
      // read (a fresh 900s presign), so it legitimately differs between two
      // polls even when nothing else about the job changed. Always take the
      // freshest one into `_byId` regardless of `unchanged` — otherwise this
      // dedup would pin whatever URL happened to be cached first and every
      // action taken more than ~15 minutes later would silently hand out an
      // expired link. This does NOT count as a "visible" change on its own
      // (no notify, no card rebuild) because every action call site
      // (`_freshArtifactUrl` in chat_thread.dart) re-fetches the job directly
      // before using the URL rather than trusting whatever this stream last
      // delivered — see [artifactUrl]'s own doc comment.
      _byId[incoming.jobId] = existing.mergeServer(incoming);
      if (unchanged) return false; // exact duplicate (poll + push race) — no-op
    } else {
      _byId[incoming.jobId] = incoming;
    }
    if (notify) {
      _updatesCtl.add(AiMediaJobUpdate(jobId: incoming.jobId, job: _byId[incoming.jobId]));
    }
    return true;
  }

  Future<void> _persist(String convId) async {
    try {
      final list = jobsFor(convId).map((j) => j.toJson()).toList();
      await DiskCache.write(_cacheKey(convId), jsonEncode(list));
    } catch (e) {
      AvaLog.I.log('ai_media_jobs', 'persist failed for conv: $e');
      // Not analytics-worthy on its own — DiskCache.write already logs/reports
      // internally and a cache-write miss just means the NEXT hydrate() is a
      // network round-trip instead of instant; it does not lose the job (the
      // server remains the source of truth).
    }
  }
}
