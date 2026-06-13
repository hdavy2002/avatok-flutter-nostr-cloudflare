import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'api_auth.dart';
import 'config.dart';

/// AvaVisionApi — marketplace of creator-built AI *vision* coaching agents
/// (camera + voice). "AvaVoice with eyes."
///
/// Spec: Specs/AVAVISION-PROPOSAL.md + Specs/avavision-build/MASTER-PROMPT.md.
/// This client MIRRORS `avavoice_api.dart` method-for-method (master rule #4 —
/// duplicate the proven pattern, do NOT refactor a shared module). All wire
/// fields are snake_case (PHASE-1 §A is the authoritative contract). Money
/// rules are identical to AvaVoice: coins are USD cents; platform keeps 50%
/// (odd cent → platform); per-minute billing rounded UP; creator-pays agents
/// bill the CREATOR a flat $5/hour. Never say "credits".
const String _base = 'https://$kSignalingHost/api/avavision';

/// Flat platform fee for creator-pays (sponsored) agents — $5/hour in coins.
const int kCreatorPaysRateCoinsPerHour = 500;

/// Hard product caps (master §3): one hour max, 10 concurrent sessions per agent.
const int kMaxSessionMinutes = 60;
const int kMaxConcurrentCalls = 10;
const List<int> kSessionLimitChoices = [5, 10, 30, 60];

String fmtCoins(int coins) =>
    coins == 0 ? 'Free' : '\$${(coins / 100).toStringAsFixed(coins % 100 == 0 ? 0 : 2)}';

/// Per-minute price (ceil) for an hourly rate, in coins.
int perMinuteCoins(int ratePerHourCoins) => (ratePerHourCoins / 60).ceil();

/// Creator's net per hour after the 50% platform fee (odd cent → platform).
int creatorNetPerHour(int ratePerHourCoins) => ratePerHourCoins ~/ 2;

/// The platform this client runs on — used to filter the template catalog and
/// publish-time platform coherence (master §6 capability/platform table).
String visionPlatform() {
  if (kIsWeb) return 'web';
  switch (defaultTargetPlatform) {
    case TargetPlatform.iOS:
      return 'ios';
    default:
      return 'android';
  }
}

// ─── voice catalog (copied verbatim from AvaVoice to stay decoupled) ─────────

class VisionVoice {
  final String name; // Gemini prebuilt voice name, e.g. "Puck"
  final String label; // display label, e.g. "Puck — upbeat"
  final String? previewUrl; // short sample clip (CDN)
  const VisionVoice(this.name, this.label, [this.previewUrl]);
  VisionVoice.fromJson(Map<String, dynamic> j)
      : name = (j['name'] ?? '').toString(),
        label = (j['label'] ?? j['name'] ?? '').toString(),
        previewUrl = j['preview_url']?.toString();
}

const List<VisionVoice> kFallbackVoices = [
  VisionVoice('Puck', 'Puck — upbeat (default)'),
  VisionVoice('Charon', 'Charon — informative'),
  VisionVoice('Kore', 'Kore — firm'),
  VisionVoice('Fenrir', 'Fenrir — excitable'),
  VisionVoice('Aoede', 'Aoede — breezy'),
  VisionVoice('Leda', 'Leda — youthful'),
  VisionVoice('Orus', 'Orus — firm'),
  VisionVoice('Zephyr', 'Zephyr — bright'),
];

/// Session output languages (Gemini Live, 24+; offer all — same list as AvaVoice).
const List<MapEntry<String, String>> kVoiceLanguages = [
  MapEntry('en-US', 'English (US)'),
  MapEntry('en-GB', 'English (UK)'),
  MapEntry('en-IN', 'English (India)'),
  MapEntry('es-ES', 'Spanish (Spain)'),
  MapEntry('es-MX', 'Spanish (Mexico)'),
  MapEntry('pt-BR', 'Portuguese (Brazil)'),
  MapEntry('fr-FR', 'French'),
  MapEntry('de-DE', 'German'),
  MapEntry('it-IT', 'Italian'),
  MapEntry('nl-NL', 'Dutch'),
  MapEntry('pl-PL', 'Polish'),
  MapEntry('ru-RU', 'Russian'),
  MapEntry('tr-TR', 'Turkish'),
  MapEntry('ar-XA', 'Arabic'),
  MapEntry('hi-IN', 'Hindi'),
  MapEntry('bn-IN', 'Bengali'),
  MapEntry('ta-IN', 'Tamil'),
  MapEntry('te-IN', 'Telugu'),
  MapEntry('mr-IN', 'Marathi'),
  MapEntry('gu-IN', 'Gujarati'),
  MapEntry('ur-PK', 'Urdu'),
  MapEntry('ja-JP', 'Japanese'),
  MapEntry('ko-KR', 'Korean'),
  MapEntry('cmn-CN', 'Mandarin Chinese'),
  MapEntry('vi-VN', 'Vietnamese'),
  MapEntry('th-TH', 'Thai'),
  MapEntry('id-ID', 'Indonesian'),
  MapEntry('uk-UA', 'Ukrainian'),
  MapEntry('ro-RO', 'Romanian'),
  MapEntry('el-GR', 'Greek'),
];

String languageLabel(String code) {
  for (final e in kVoiceLanguages) {
    if (e.key == code) return e.value;
  }
  return code;
}

// ─── capability / overlay / scoring enums → friendly labels ──────────────────

/// Short human label for a capability enum (master §6).
String capabilityLabel(String c) => switch (c) {
      'pose' => 'Body pose',
      'hand' => 'Hands',
      'face_landmark' => 'Face mesh',
      'face_detect' => 'Face box',
      'gesture' => 'Gestures',
      'object' => 'Objects',
      'image_class' => 'Image class',
      'segmentation' => 'Segmentation',
      'holistic' => 'Full body',
      'gemini_only' => 'AI vision',
      _ => c,
    };

/// Short human label for an overlay style (master §6).
String overlayLabel(String s) => switch (s) {
      'skeleton' => 'Skeleton',
      'hand_mesh' => 'Hand mesh',
      'face_mesh' => 'Face mesh',
      'bounding_box' => 'Boxes',
      'segmentation_mask' => 'Mask',
      'none' => 'No overlay',
      _ => s,
    };

/// Platform availability map for an agent/template.
class VisionPlatforms {
  final bool android, ios, web;
  const VisionPlatforms(this.android, this.ios, this.web);
  VisionPlatforms.fromJson(Map<String, dynamic>? j)
      : android = j == null ? true : j['android'] != false,
        ios = j == null ? false : j['ios'] == true,
        web = j == null ? true : j['web'] != false;

  bool runsOn(String platform) => switch (platform) {
        'ios' => ios,
        'web' => web,
        _ => android,
      };

  /// Compact display list, e.g. ["Android", "Web"].
  List<String> get labels => [
        if (android) 'Android',
        if (ios) 'iOS',
        if (web) 'Web',
      ];
}

// ─── template catalog (served by GET /avavision/templates) ───────────────────

/// One use-case template the creator can start a vision agent from. The full
/// object is returned to the form flow, which prefills the wizard from it.
class VisionTemplate {
  final String id, name, capability, visionMode;
  final String? mediapipeSolution, engineDefault, engineUpgradeAndroidWeb;
  final bool overlayEnabled;
  final String overlayStyle, scoringMode;
  final String? scoreLabel;
  final String trackedSubject, starterPrompt;
  final int freeSnapshotsPerSession;
  final List<String> safetyNotes;
  final VisionPlatforms platforms;

  VisionTemplate.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        name = (j['name'] ?? '').toString(),
        capability = (j['capability'] ?? 'gemini_only').toString(),
        visionMode = (j['vision_mode'] ?? 'live').toString(),
        mediapipeSolution = j['mediapipe_solution']?.toString(),
        engineDefault = j['engine_default']?.toString(),
        engineUpgradeAndroidWeb = j['engine_upgrade_android_web']?.toString(),
        overlayEnabled = j['overlay_enabled'] == true,
        overlayStyle = (j['overlay_style'] ?? 'none').toString(),
        scoringMode = (j['scoring_mode'] ?? 'none').toString(),
        scoreLabel = j['score_label']?.toString(),
        trackedSubject = (j['tracked_subject'] ?? '').toString(),
        starterPrompt = (j['starter_prompt'] ?? '').toString(),
        freeSnapshotsPerSession = (j['free_snapshots_per_session'] as num?)?.toInt() ?? 0,
        safetyNotes = ((j['safety_notes'] as List?) ?? const [])
            .map((s) => s.toString())
            .toList(),
        platforms = VisionPlatforms.fromJson(
            (j['platforms'] as Map?)?.cast<String, dynamic>());

  bool get agenticSnapshotEnabled =>
      visionMode == 'both' || visionMode == 'agentic_snapshot' || visionMode == 'snapshot';
  bool get hasOverlay => overlayEnabled && overlayStyle != 'none';
  bool get hasScore => scoringMode != 'none' && (scoreLabel != null && scoreLabel!.isNotEmpty);
}

/// A category of templates (the first grid the creator sees).
class VisionCategory {
  final String id, name, tagline, capability;
  final List<VisionTemplate> templates;
  VisionCategory.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        name = (j['name'] ?? '').toString(),
        tagline = (j['tagline'] ?? '').toString(),
        capability = (j['capability'] ?? 'gemini_only').toString(),
        templates = ((j['templates'] as List?) ?? const [])
            .map((t) => VisionTemplate.fromJson((t as Map).cast<String, dynamic>()))
            .toList();
}

// ─── agent model ─────────────────────────────────────────────────────────────

class AgentBrainFile {
  final String id, filename;
  final int size;
  final bool indexed;
  AgentBrainFile.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        filename = (j['filename'] ?? '').toString(),
        size = (j['size'] as num?)?.toInt() ?? 0,
        indexed = j['indexed'] == true;
}

/// A published / draft vision agent (PHASE-1 §A `VisionAgent` object).
class VisionAgent {
  final String id, name, role, systemProfile, voiceName, payerMode, status;
  final String? avatarUrl, creatorUid, creatorName;
  final List<String> images; // listing photos (1–5, public CDN URLs)
  final int ratePerHourCoins, sessionLimitMin;
  final List<AgentBrainFile> files;
  final int callsTotal;
  final double? ratingAvg;

  // vision additions (PHASE-1 §A)
  final String templateId, capability, overlayStyle, scoringMode, visionMode, mediaResolution;
  final String? mediapipeSolution, engineDefault, engineUpgradeAndroidWeb, scoreLabel;
  final bool overlayEnabled, agenticSnapshotEnabled, saveSnapshots;
  final int freeSnapshotsPerSession;
  final VisionPlatforms platforms;

  // live availability (joined on marketplace reads when cheap)
  final int? activeCalls;
  final int maxCalls;

  VisionAgent.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        name = (j['name'] ?? '').toString(),
        role = (j['role'] ?? '').toString(),
        systemProfile = (j['system_profile'] ?? '').toString(),
        voiceName = (j['voice_name'] ?? 'Puck').toString(),
        payerMode = (j['payer_mode'] ?? 'user_pays').toString(),
        status = (j['status'] ?? 'draft').toString(),
        avatarUrl = j['avatar_url']?.toString(),
        images = ((j['images'] as List?) ?? const []).map((u) => u.toString()).toList(),
        creatorUid = (j['creator_id'] ?? j['creator_uid'])?.toString(),
        creatorName = j['creator_name']?.toString(),
        ratePerHourCoins = (j['rate_per_hour'] as num?)?.toInt() ?? 0,
        sessionLimitMin = (j['session_limit_min'] as num?)?.toInt() ?? 30,
        files = ((j['files'] as List?) ?? const [])
            .map((f) => AgentBrainFile.fromJson((f as Map).cast<String, dynamic>()))
            .toList(),
        callsTotal = (j['calls_total'] as num?)?.toInt() ?? 0,
        ratingAvg = (j['rating_avg'] as num?)?.toDouble(),
        templateId = (j['template_id'] ?? '').toString(),
        capability = (j['capability'] ?? 'gemini_only').toString(),
        overlayStyle = (j['overlay_style'] ?? 'none').toString(),
        scoringMode = (j['scoring_mode'] ?? 'none').toString(),
        visionMode = (j['vision_mode'] ?? 'live').toString(),
        mediaResolution = (j['media_resolution'] ?? 'LOW').toString(),
        mediapipeSolution = j['mediapipe_solution']?.toString(),
        engineDefault = j['engine_default']?.toString(),
        engineUpgradeAndroidWeb = j['engine_upgrade_android_web']?.toString(),
        scoreLabel = j['score_label']?.toString(),
        overlayEnabled = j['overlay_enabled'] == true,
        agenticSnapshotEnabled = j['agentic_snapshot_enabled'] == true,
        saveSnapshots = j['save_snapshots'] == true,
        freeSnapshotsPerSession = (j['free_snapshots_per_session'] as num?)?.toInt() ?? 0,
        platforms = VisionPlatforms.fromJson(
            (j['platforms'] as Map?)?.cast<String, dynamic>()),
        activeCalls = ((j['availability'] as Map?)?['active'] as num?)?.toInt() ??
            (j['active_calls'] as num?)?.toInt(),
        maxCalls = ((j['availability'] as Map?)?['max'] as num?)?.toInt() ?? kMaxConcurrentCalls;

  bool get isFreeForCallers => payerMode == 'creator_pays';
  bool get busy => (activeCalls ?? 0) >= maxCalls;
  bool get hasOverlay => overlayEnabled && overlayStyle != 'none';
  bool get hasScore => scoringMode != 'none' && (scoreLabel != null && scoreLabel!.isNotEmpty);
  String get rateLabel => isFreeForCallers
      ? 'Free to call'
      : '${fmtCoins(ratePerHourCoins)}/hr · ${fmtCoins(perMinuteCoins(ratePerHourCoins))}/min';
}

class AgentAvailability {
  final int active, max;
  final String state;
  AgentAvailability(this.active, this.max, [this.state = 'available']);
  AgentAvailability.fromJson(Map<String, dynamic> j)
      : active = (j['active'] as num?)?.toInt() ?? 0,
        max = (j['max'] as num?)?.toInt() ?? kMaxConcurrentCalls,
        state = (j['state'] ?? 'available').toString();
  bool get busy => state == 'busy' || active >= max;
}

class VisionBooking {
  final String id, agentId, agentName, status;
  final String? agentAvatar;
  final int scheduledAt, bookedMinutes, escrowCoins;
  VisionBooking.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        agentId = (j['agent_id'] ?? '').toString(),
        agentName = (j['agent_name'] ?? 'Agent').toString(),
        agentAvatar = j['agent_avatar']?.toString(),
        status = (j['status'] ?? 'booked').toString(),
        scheduledAt = (j['scheduled_at'] as num?)?.toInt() ?? 0,
        bookedMinutes = (j['booked_minutes'] as num?)?.toInt() ?? 0,
        escrowCoins = (j['escrow_coins'] as num?)?.toInt() ?? 0;
}

/// Dashboard stats — AvaVoice numbers plus avg/peak score + snapshot usage.
class AgentDayStats {
  final int bookings, calls, minutes, grossCoins, netCoins, refundsCoins;
  // vision additions
  final double? avgScore;
  final int? peakScore;
  final int snapshotCalls;
  // audience analytics (last 30 days)
  final int views30d, uniqueViewers30d;
  final List<MapEntry<String, int>> viewsByCountry, viewsByAgeGroup;

  static List<MapEntry<String, int>> _pairs(dynamic v, String key) =>
      ((v as List?) ?? const [])
          .map((e) => MapEntry((e[key] ?? '?').toString(), ((e['views'] as num?) ?? 0).toInt()))
          .toList();

  AgentDayStats.fromJson(Map<String, dynamic> j)
      : bookings = (j['bookings'] as num?)?.toInt() ?? 0,
        calls = (j['calls'] as num?)?.toInt() ?? 0,
        minutes = (j['minutes'] as num?)?.toInt() ?? 0,
        grossCoins = (j['gross_coins'] as num?)?.toInt() ?? 0,
        netCoins = (j['net_coins'] as num?)?.toInt() ?? 0,
        refundsCoins = (j['refunds_coins'] as num?)?.toInt() ?? 0,
        avgScore = (j['avg_score'] as num?)?.toDouble(),
        peakScore = (j['peak_score'] as num?)?.toInt(),
        snapshotCalls = (j['snapshot_calls'] as num?)?.toInt() ?? 0,
        views30d = (j['views_30d'] as num?)?.toInt() ?? 0,
        uniqueViewers30d = (j['unique_viewers_30d'] as num?)?.toInt() ?? 0,
        viewsByCountry = _pairs(j['views_by_country'], 'country'),
        viewsByAgeGroup = _pairs(j['views_by_age_group'], 'age_group');
}

/// Result of a successful "Analyze my form" snapshot (NEW vision media path).
class VisionSnapshotResult {
  final String annotatedImage; // base64 JPEG
  final int score;
  final String breakdown;
  final int snapshotCalls, freeSnapshotsPerSession, status;
  VisionSnapshotResult.fromJson(Map<String, dynamic> j)
      : annotatedImage = (j['annotated_image'] ?? '').toString(),
        score = (j['score'] as num?)?.toInt() ?? 0,
        breakdown = (j['breakdown'] ?? '').toString(),
        snapshotCalls = (j['snapshot_calls'] as num?)?.toInt() ?? 0,
        freeSnapshotsPerSession = (j['free_snapshots_per_session'] as num?)?.toInt() ?? 0,
        status = (j['status'] as num?)?.toInt() ?? 200;
}

class AvaVisionApi {
  static Map<String, dynamic> _j(String body) {
    try {
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  static String _uuid() {
    final r = Random.secure();
    String h(int n) => List<int>.generate(n, (_) => r.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${h(4)}-${h(2)}-${h(2)}-${h(2)}-${h(6)}';
  }

  /// Money/counter mutation: Idempotency-Key + one safe retry with the SAME key.
  /// (PHASE-1 §B — clients WILL retry; server keys escrow by order_id.)
  static Future<Map<String, dynamic>> _money(String url, Map<String, dynamic> body) async {
    final key = _uuid();
    for (var attempt = 0;; attempt++) {
      try {
        final res = await ApiAuth.postJsonH(url, body, {'Idempotency-Key': key},
            timeout: const Duration(seconds: 20));
        final j = _j(res.body);
        if (j.isEmpty && res.statusCode >= 400) {
          return {'error': 'http ${res.statusCode}', 'status': res.statusCode};
        }
        return {...j, 'status': res.statusCode};
      } catch (_) {
        if (attempt >= 1) return {'error': 'network', 'status': 0};
      }
    }
  }

  static List<VisionAgent> _agents(Map<String, dynamic> j) =>
      ((j['agents'] as List?) ?? const [])
          .map((a) => VisionAgent.fromJson((a as Map).cast<String, dynamic>()))
          .toList();

  // ── template catalog (NEW) ───────────────────────────────────────────────
  /// Category → use-case catalog, filtered server-side by platform. We also
  /// belt-and-braces filter client-side so a template never shows on a client
  /// that can't run its capability.
  static Future<List<VisionCategory>> templates({String? platform}) async {
    final p = platform ?? visionPlatform();
    try {
      final r = await ApiAuth.getSigned('$_base/templates?platform=$p');
      final cats = ((_j(r.body)['categories'] as List?) ?? const [])
          .map((c) => VisionCategory.fromJson((c as Map).cast<String, dynamic>()))
          .toList();
      // Drop any template that can't run here, and any now-empty category.
      for (final c in cats) {
        c.templates.removeWhere((t) => !t.platforms.runsOn(p));
      }
      cats.removeWhere((c) => c.templates.isEmpty);
      return cats;
    } catch (_) {
      return const [];
    }
  }

  // ── voices catalog ────────────────────────────────────────────────────────
  static Future<List<VisionVoice>> voices() async {
    try {
      final r = await ApiAuth.getSigned('$_base/voices');
      final list = ((_j(r.body)['voices'] as List?) ?? const [])
          .map((v) => VisionVoice.fromJson((v as Map).cast<String, dynamic>()))
          .toList();
      return list.isEmpty ? kFallbackVoices : list;
    } catch (_) {
      return kFallbackVoices;
    }
  }

  // ── marketplace ─────────────────────────────────────────────────────────
  static Future<List<VisionAgent>> marketplace({String? q}) async {
    final qs = q != null && q.trim().isNotEmpty ? '?q=${Uri.encodeQueryComponent(q.trim())}' : '';
    final r = await ApiAuth.getSigned('$_base/marketplace$qs');
    return _agents(_j(r.body));
  }

  static Future<VisionAgent?> agent(String id) async {
    final r = await ApiAuth.getSigned('$_base/agents/$id');
    if (r.statusCode != 200) return null;
    final j = _j(r.body);
    final a = (j['agent'] as Map?)?.cast<String, dynamic>();
    return a == null ? null : VisionAgent.fromJson(a);
  }

  static Future<AgentAvailability> availability(String id) async {
    try {
      final r = await ApiAuth.getSigned('$_base/agents/$id/availability');
      return AgentAvailability.fromJson(_j(r.body));
    } catch (_) {
      return AgentAvailability(0, kMaxConcurrentCalls);
    }
  }

  // ── creator pipeline ────────────────────────────────────────────────────
  static Future<List<VisionAgent>> mine() async {
    final r = await ApiAuth.getSigned('$_base/agents/mine');
    return _agents(_j(r.body));
  }

  static Future<String?> createAgent(Map<String, dynamic> fields) async {
    final r = await ApiAuth.postJson('$_base/agents', fields,
        timeout: const Duration(seconds: 15));
    return r.statusCode == 200 ? _j(r.body)['agent_id']?.toString() : null;
  }

  static Future<bool> updateAgent(String id, Map<String, dynamic> fields) async =>
      (await ApiAuth.putJson('$_base/agents/$id', fields)).statusCode == 200;

  /// {} on success; {error/detail/field, status} on failure (PHASE-1 §A
  /// publish validation errors carry `field` + `detail`).
  static Future<Map<String, dynamic>> publish(String id) async {
    final r = await ApiAuth.postJson('$_base/agents/$id/publish', {});
    return r.statusCode == 200 ? {} : {..._j(r.body), 'status': r.statusCode};
  }

  static Future<bool> unpublish(String id) async =>
      (await ApiAuth.postJson('$_base/agents/$id/unpublish', {})).statusCode == 200;

  static Future<bool> deleteAgent(String id) async =>
      (await ApiAuth.deleteSigned('$_base/agents/$id')).statusCode == 200;

  /// Upload a brain file (optional File-Search knowledge). Returns the record.
  static Future<AgentBrainFile?> uploadBrainFile(
      String agentId, String filename, List<int> bytes) async {
    final r = await ApiAuth.postBytes(
      '$_base/agents/$agentId/files?name=${Uri.encodeQueryComponent(filename)}',
      bytes,
      timeout: const Duration(seconds: 120),
    );
    if (r.statusCode != 200) return null;
    final f = (_j(r.body)['file'] as Map?)?.cast<String, dynamic>();
    return f == null ? null : AgentBrainFile.fromJson(f);
  }

  static Future<bool> deleteBrainFile(String agentId, String fileId) async =>
      (await ApiAuth.deleteSigned('$_base/agents/$agentId/files/$fileId')).statusCode == 200;

  static Future<AgentDayStats?> stats(String agentId) async {
    final r = await ApiAuth.getSigned('$_base/agents/$agentId/stats');
    if (r.statusCode != 200) return null;
    return AgentDayStats.fromJson(_j(r.body));
  }

  // ── booking + instant calls (money: escrow held, settled per minute) ────
  /// Book a slot. 402 → insufficient AvaCoins (response carries `needed`).
  static Future<Map<String, dynamic>> book(String agentId,
          {required int scheduledAt, required int minutes, required String language}) =>
      _money('$_base/bookings', {
        'agent_id': agentId,
        'scheduled_at': scheduledAt,
        'minutes': minutes,
        'language': language,
      });

  static Future<List<VisionBooking>> myBookings() async {
    final r = await ApiAuth.getSigned('$_base/bookings/mine');
    return ((_j(r.body)['bookings'] as List?) ?? const [])
        .map((b) => VisionBooking.fromJson((b as Map).cast<String, dynamic>()))
        .toList();
  }

  static Future<Map<String, dynamic>> cancelBooking(String id) =>
      _money('$_base/bookings/$id/cancel', const {});

  /// Instant call. 409 → AGENT_BUSY; 402 → insufficient AvaCoins.
  static Future<Map<String, dynamic>> callNow(String agentId, {required String language}) =>
      _money('$_base/calls/now', {'agent_id': agentId, 'language': language});

  // ── live session lifecycle (Phase 3 drives these from the session screen) ─
  static Future<Map<String, dynamic>> sessionStart(
          {String? bookingId, String? callId, required String language}) =>
      _money('$_base/sessions/start', {
        if (bookingId != null) 'booking_id': bookingId,
        if (callId != null) 'call_id': callId,
        'language': language,
      });

  static Future<Map<String, dynamic>> heartbeat(String sessionId) =>
      _money('$_base/sessions/heartbeat', {'session_id': sessionId});

  static Future<Map<String, dynamic>> sessionStop(String sessionId,
          {String? reason,
          int? framesStreamed,
          int? snapshotCalls,
          int? avgScore,
          int? peakScore}) =>
      _money('$_base/sessions/stop', {
        'session_id': sessionId,
        if (reason != null) 'reason': reason,
        if (framesStreamed != null) 'frames_streamed': framesStreamed,
        if (snapshotCalls != null) 'snapshot_calls': snapshotCalls,
        if (avgScore != null) 'avg_score': avgScore,
        if (peakScore != null) 'peak_score': peakScore,
      });

  /// "Analyze my form" — the ONLY new media path. Sends one hi-res JPEG frame;
  /// returns the annotated image + score + breakdown. 429 → SNAPSHOT_CAP_REACHED
  /// (friendly, no charge). Mirrors the snake_case contract in PHASE-1 §A.
  static Future<VisionSnapshotResult> snapshot(String sessionId, List<int> jpegBytes) async {
    final r = await _money('$_base/snapshot', {
      'session_id': sessionId,
      'image': base64Encode(jpegBytes),
    });
    return VisionSnapshotResult.fromJson(r);
  }

  // ── session surface used by the live session engine (Phase 3) ─────────────
  /// Alias of [heartbeat] — the session screen calls `sessionHeartbeat`.
  static Future<Map<String, dynamic>> sessionHeartbeat(String sessionId) =>
      heartbeat(sessionId);

  /// Mint a FRESH ephemeral Gemini token for an already-active session. Gemini
  /// Live sockets cap at ~10 min, so the engine reconnects mid-session without
  /// re-billing or taking a new slot. Returns the raw map ({token, status, …}).
  static Future<Map<String, dynamic>> sessionToken(String sessionId) =>
      _money('$_base/sessions/token', {'session_id': sessionId});

  /// "Analyze my form" — raw-map variant the engine uses so it can branch on the
  /// HTTP status itself (429 SNAPSHOT_CAP_REACHED / 402 / capture errors) before
  /// the screen builds a [VisionSnapshotResult]. Takes a pre-encoded base64 JPEG.
  static Future<Map<String, dynamic>> snapshotRaw(String sessionId, String base64Jpeg) =>
      _money('$_base/snapshot', {'session_id': sessionId, 'image': base64Jpeg});
}

/// Mirror of the `sessions/start` response (master §4) — the session ticket the
/// live engine consumes. (Moved here from the Phase-3 stub during Phase Z glue.)
class VisionSessionTicket {
  final String sessionId, geminiToken, model, capability, overlayStyle, scoringMode, scoreLabel;
  final int limitMinutes, freeSnapshotsPerSession, tokenExpiresAt;
  final bool agenticSnapshotEnabled;

  VisionSessionTicket.fromJson(Map<String, dynamic> j)
      : sessionId = (j['session_id'] ?? j['sessionId'] ?? '').toString(),
        geminiToken = (j['token'] ?? '').toString(),
        model = (j['model'] ?? '').toString(),
        capability = (j['capability'] ?? 'pose').toString(),
        overlayStyle = (j['overlay_style'] ?? 'skeleton').toString(),
        scoringMode = (j['scoring_mode'] ?? 'geometry').toString(),
        scoreLabel = (j['score_label'] ?? 'Score').toString(),
        limitMinutes = (j['limit_minutes'] as num?)?.toInt() ?? kMaxSessionMinutes,
        freeSnapshotsPerSession = (j['free_snapshots_per_session'] as num?)?.toInt() ?? 0,
        tokenExpiresAt = (j['token_expires_at'] as num?)?.toInt() ?? 0,
        agenticSnapshotEnabled = j['agentic_snapshot_enabled'] == true;
}
