import 'dart:convert';
import 'dart:math';

import 'api_auth.dart';
import 'config.dart';

/// AvaVoiceApi — marketplace of creator-built AI voice agents.
/// Spec: Specs/AVAVOICE-PROPOSAL.md (approved 2026-06-11).
/// Money rules: coins are USD cents; platform keeps 50% (odd cent → platform);
/// per-minute billing rounded UP; creator-pays agents bill the CREATOR a flat
/// $5/hour platform fee (kCreatorPaysRateCoinsPerHour). Never say "credits".
const String _base = 'https://$kSignalingHost/api/avavoice';

/// Flat platform fee for creator-pays (sponsored) agents — $5/hour in coins.
const int kCreatorPaysRateCoinsPerHour = 500;

/// Hard product caps (rulebook): one hour max, 10 concurrent calls per agent.
const int kMaxSessionMinutes = 60;
const int kMaxConcurrentCalls = 10;
const List<int> kSessionLimitChoices = [5, 10, 30, 60];

String fmtCoins(int coins) =>
    coins == 0 ? 'Free' : '\$${(coins / 100).toStringAsFixed(coins % 100 == 0 ? 0 : 2)}';

/// Per-minute price (ceil) for an hourly rate, in coins.
int perMinuteCoins(int ratePerHourCoins) => (ratePerHourCoins / 60).ceil();

/// Creator's net per hour after the 50% platform fee (odd cent → platform).
int creatorNetPerHour(int ratePerHourCoins) => ratePerHourCoins ~/ 2;

class VoiceOption {
  final String name; // Gemini prebuilt voice name, e.g. "Puck"
  final String label; // display label, e.g. "Puck — upbeat"
  final String? previewUrl; // short sample clip (CDN)
  const VoiceOption(this.name, this.label, [this.previewUrl]);
  VoiceOption.fromJson(Map<String, dynamic> j)
      : name = (j['name'] ?? '').toString(),
        label = (j['label'] ?? j['name'] ?? '').toString(),
        previewUrl = j['preview_url']?.toString();
}

/// Client-side fallback so the studio works before/without the catalog fetch.
const List<VoiceOption> kFallbackVoices = [
  VoiceOption('Puck', 'Puck — upbeat (default)'),
  VoiceOption('Charon', 'Charon — informative'),
  VoiceOption('Kore', 'Kore — firm'),
  VoiceOption('Fenrir', 'Fenrir — excitable'),
  VoiceOption('Aoede', 'Aoede — breezy'),
  VoiceOption('Leda', 'Leda — youthful'),
  VoiceOption('Orus', 'Orus — firm'),
  VoiceOption('Zephyr', 'Zephyr — bright'),
];

/// Dial-time output languages (Gemini Live, 24+; spec Q8: offer all).
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

class VoiceAgent {
  final String id, name, role, systemProfile, voiceName, payerMode, status;
  final String? avatarUrl, creatorUid, creatorName;
  final List<String> images; // listing photos (1–5, public CDN URLs)
  final int ratePerHourCoins, sessionLimitMin;
  final bool visionEnabled;
  final List<AgentBrainFile> files;
  final int callsTotal;
  final double? ratingAvg;
  // live availability (joined on marketplace reads when cheap)
  final int? activeCalls;

  VoiceAgent.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        name = (j['name'] ?? '').toString(),
        role = (j['role'] ?? '').toString(),
        systemProfile = (j['system_profile'] ?? '').toString(),
        voiceName = (j['voice_name'] ?? 'Puck').toString(),
        payerMode = (j['payer_mode'] ?? 'user_pays').toString(),
        status = (j['status'] ?? 'draft').toString(),
        avatarUrl = j['avatar_url']?.toString(),
        images = ((j['images'] as List?) ?? const []).map((u) => u.toString()).toList(),
        creatorUid = j['creator_uid']?.toString(),
        creatorName = j['creator_name']?.toString(),
        ratePerHourCoins = (j['rate_per_hour'] as num?)?.toInt() ?? 0,
        sessionLimitMin = (j['session_limit_min'] as num?)?.toInt() ?? 30,
        visionEnabled = j['vision_enabled'] == true,
        files = ((j['files'] as List?) ?? const [])
            .map((f) => AgentBrainFile.fromJson((f as Map).cast<String, dynamic>()))
            .toList(),
        callsTotal = (j['calls_total'] as num?)?.toInt() ?? 0,
        ratingAvg = (j['rating_avg'] as num?)?.toDouble(),
        activeCalls = (j['active_calls'] as num?)?.toInt();

  bool get isFreeForCallers => payerMode == 'creator_pays';
  bool get busy => (activeCalls ?? 0) >= kMaxConcurrentCalls;
  String get rateLabel =>
      isFreeForCallers ? 'Free to call' : '${fmtCoins(ratePerHourCoins)}/hr · ${fmtCoins(perMinuteCoins(ratePerHourCoins))}/min';
}

class AgentAvailability {
  final int active, max;
  AgentAvailability(this.active, this.max);
  AgentAvailability.fromJson(Map<String, dynamic> j)
      : active = (j['active'] as num?)?.toInt() ?? 0,
        max = (j['max'] as num?)?.toInt() ?? kMaxConcurrentCalls;
  bool get busy => active >= max;
}

class VoiceBooking {
  final String id, agentId, agentName, status;
  final String? agentAvatar;
  final int scheduledAt, bookedMinutes, escrowCoins;
  VoiceBooking.fromJson(Map<String, dynamic> j)
      : id = (j['id'] ?? '').toString(),
        agentId = (j['agent_id'] ?? '').toString(),
        agentName = (j['agent_name'] ?? 'Agent').toString(),
        agentAvatar = j['agent_avatar']?.toString(),
        status = (j['status'] ?? 'booked').toString(),
        scheduledAt = (j['scheduled_at'] as num?)?.toInt() ?? 0,
        bookedMinutes = (j['booked_minutes'] as num?)?.toInt() ?? 0,
        escrowCoins = (j['escrow_coins'] as num?)?.toInt() ?? 0;
}

class AgentDayStats {
  final int bookings, calls, minutes, grossCoins, netCoins, refundsCoins;
  // Audience analytics (last 30 days) — views by country / age group.
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
        views30d = (j['views_30d'] as num?)?.toInt() ?? 0,
        uniqueViewers30d = (j['unique_viewers_30d'] as num?)?.toInt() ?? 0,
        viewsByCountry = _pairs(j['views_by_country'], 'country'),
        viewsByAgeGroup = _pairs(j['views_by_age_group'], 'age_group');
}

class VoiceSessionTicket {
  final String sessionId, geminiToken, model;
  final int limitMinutes;
  VoiceSessionTicket.fromJson(Map<String, dynamic> j)
      : sessionId = (j['session_id'] ?? '').toString(),
        geminiToken = (j['token'] ?? '').toString(),
        model = (j['model'] ?? '').toString(),
        limitMinutes = (j['limit_minutes'] as num?)?.toInt() ?? kMaxSessionMinutes;
}

class AvaVoiceApi {
  static Map<String, dynamic> _j(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  static String _uuid() {
    final r = Random.secure();
    String h(int n) => List<int>.generate(n, (_) => r.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${h(4)}-${h(2)}-${h(2)}-${h(2)}-${h(6)}';
  }

  /// Money mutation: Idempotency-Key + one safe retry with the SAME key.
  static Future<Map<String, dynamic>> _money(String url, Map<String, dynamic> body) async {
    final key = _uuid();
    for (var attempt = 0; ; attempt++) {
      try {
        final res = await ApiAuth.postJsonH(url, body, {'Idempotency-Key': key},
            timeout: const Duration(seconds: 20));
        final j = _j(res.body);
        if (j.isEmpty && res.statusCode >= 400) return {'error': 'http ${res.statusCode}', 'status': res.statusCode};
        return {...j, 'status': res.statusCode};
      } catch (_) {
        if (attempt >= 1) return {'error': 'network', 'status': 0};
      }
    }
  }

  static List<VoiceAgent> _agents(Map<String, dynamic> j) =>
      ((j['agents'] as List?) ?? const [])
          .map((a) => VoiceAgent.fromJson((a as Map).cast<String, dynamic>()))
          .toList();

  // ── voices catalog ──────────────────────────────────────────────────────
  static Future<List<VoiceOption>> voices() async {
    try {
      final r = await ApiAuth.getSigned('$_base/voices');
      final list = ((_j(r.body)['voices'] as List?) ?? const [])
          .map((v) => VoiceOption.fromJson((v as Map).cast<String, dynamic>()))
          .toList();
      return list.isEmpty ? kFallbackVoices : list;
    } catch (_) {
      return kFallbackVoices;
    }
  }

  // ── marketplace ─────────────────────────────────────────────────────────
  static Future<List<VoiceAgent>> marketplace({String? q}) async {
    final qs = q != null && q.trim().isNotEmpty ? '?q=${Uri.encodeQueryComponent(q.trim())}' : '';
    final r = await ApiAuth.getSigned('$_base/marketplace$qs');
    return _agents(_j(r.body));
  }

  static Future<VoiceAgent?> agent(String id) async {
    final r = await ApiAuth.getSigned('$_base/agents/$id');
    if (r.statusCode != 200) return null;
    final j = _j(r.body);
    final a = (j['agent'] as Map?)?.cast<String, dynamic>();
    return a == null ? null : VoiceAgent.fromJson(a);
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
  static Future<List<VoiceAgent>> mine() async {
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

  /// {} on success; {error/detail, status} on failure.
  static Future<Map<String, dynamic>> publish(String id) async {
    final r = await ApiAuth.postJson('$_base/agents/$id/publish', {});
    return r.statusCode == 200 ? {} : {..._j(r.body), 'status': r.statusCode};
  }

  static Future<bool> unpublish(String id) async =>
      (await ApiAuth.postJson('$_base/agents/$id/unpublish', {})).statusCode == 200;

  static Future<bool> deleteAgent(String id) async =>
      (await ApiAuth.deleteSigned('$_base/agents/$id')).statusCode == 200;

  /// Upload a brain file (knowledge). Returns the file record or null.
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
  /// Book a slot. 402 → insufficient Tokens (response carries `needed`).
  static Future<Map<String, dynamic>> book(String agentId,
          {required int scheduledAt, required int minutes, required String language}) =>
      _money('$_base/bookings', {
        'agent_id': agentId,
        'scheduled_at': scheduledAt,
        'minutes': minutes,
        'language': language,
      });

  static Future<List<VoiceBooking>> myBookings() async {
    final r = await ApiAuth.getSigned('$_base/bookings/mine');
    return ((_j(r.body)['bookings'] as List?) ?? const [])
        .map((b) => VoiceBooking.fromJson((b as Map).cast<String, dynamic>()))
        .toList();
  }

  static Future<Map<String, dynamic>> cancelBooking(String id) =>
      _money('$_base/bookings/$id/cancel', const {});

  /// Instant call. 409 → AGENT_BUSY; 402 → insufficient Tokens.
  static Future<Map<String, dynamic>> callNow(String agentId, {required String language}) =>
      _money('$_base/calls/now', {'agent_id': agentId, 'language': language});

  // ── live session lifecycle ──────────────────────────────────────────────
  static Future<Map<String, dynamic>> sessionStart(
          {String? bookingId, String? callId, required String language}) =>
      _money('$_base/sessions/start', {
        if (bookingId != null) 'booking_id': bookingId,
        if (callId != null) 'call_id': callId,
        'language': language,
      });

  static Future<Map<String, dynamic>> sessionHeartbeat(String sessionId) =>
      _money('$_base/sessions/heartbeat', {'session_id': sessionId});

  static Future<Map<String, dynamic>> sessionStop(String sessionId, {String? reason}) =>
      _money('$_base/sessions/stop',
          {'session_id': sessionId, if (reason != null) 'reason': reason});
}
