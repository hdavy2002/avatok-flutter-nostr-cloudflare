import 'dart:async';
import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// BusinessAgentApi — client for the Ava Business Agent (Specs/PLAN-2026-07-11-
/// dialpad-business-calls-ava-voice-agent.md §4/§8 Phase C, WP3/WP4 server work).
///
/// Two surfaces:
///   • The PRIMARY number's Mode-A agent settings: GET/PUT `$kAgentBase/settings`.
///   • Service numbers (Mode B, RemoteConfig.serviceNumbers): GET/POST
///     `$kAgentBase/services`.
/// Also the caller-side "My AI calls" history (§12.11): GET `$kAgentBase/my-calls`.
///
/// The server routes land with WP3/WP4; this client is written now and tolerates
/// a 404/501 gracefully (returns null/empty + `notAvailable:true`) so the settings
/// screen can ship ahead of the backend without crashing or showing a raw error.
class BusinessAgentApi {
  BusinessAgentApi._();

  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }

  // ── Primary number (Mode A) settings ───────────────────────────────────────

  /// Owner: read the primary-number agent config. Returns null on any failure
  /// (network, 404 "not built yet", etc.) — callers show a friendly empty state.
  static Future<BusinessAgentSettings?> getSettings() async {
    try {
      final r = await ApiAuth.getSigned('$kAgentBase/settings');
      if (r.statusCode == 404 || r.statusCode == 501) return null;
      if (r.statusCode != 200) return null;
      return BusinessAgentSettings.fromJson(_json(r.body));
    } catch (_) {
      return null;
    }
  }

  /// Owner: save the primary-number agent config (Mode A — 6 tokens/min, callee
  /// pays, max 5-min call; billing details are fixed server-side).
  static Future<bool> saveSettings(BusinessAgentSettings s) async {
    try {
      final r = await ApiAuth.putJson('$kAgentBase/settings', s.toJson());
      if (r.statusCode != 200) return false;
      return _json(r.body)['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Owner: upload a document into the agent's Grok Collection (RAG source).
  /// Stub per WP6 instructions — server route `POST /api/agent/docs` lands with
  /// WP4; until then this best-effort posts the bytes and reports failure quietly.
  // TODO(WP4): confirm the final route/shape once the Grok Collections push
  // pipeline lands server-side; this call already matches the documented shape.
  static Future<BusinessAgentDoc?> uploadDoc(String name, List<int> bytes, {String? serviceId}) async {
    try {
      final qs = serviceId != null && serviceId.isNotEmpty
          ? '?name=${Uri.encodeQueryComponent(name)}&service_id=${Uri.encodeQueryComponent(serviceId)}'
          : '?name=${Uri.encodeQueryComponent(name)}';
      final r = await ApiAuth.postBytes('$kAgentBase/docs$qs', bytes);
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      if (j.isEmpty) return null;
      return BusinessAgentDoc.fromJson(j);
    } catch (_) {
      return null;
    }
  }

  /// Owner: list uploaded documents (primary agent, or a given service).
  static Future<List<BusinessAgentDoc>> listDocs({String? serviceId}) async {
    try {
      final qs = serviceId != null && serviceId.isNotEmpty
          ? '?service_id=${Uri.encodeQueryComponent(serviceId)}'
          : '';
      final r = await ApiAuth.getSigned('$kAgentBase/docs$qs');
      if (r.statusCode != 200) return const [];
      final j = _json(r.body);
      final list = (j['docs'] as List?) ?? const [];
      return list.whereType<Map>().map((m) => BusinessAgentDoc.fromJson(m.cast<String, dynamic>())).toList();
    } catch (_) {
      return const [];
    }
  }

  /// Owner: remove a document from the Collection.
  static Future<bool> deleteDoc(String docId, {String? serviceId}) async {
    try {
      final qs = serviceId != null && serviceId.isNotEmpty
          ? '?id=${Uri.encodeQueryComponent(docId)}&service_id=${Uri.encodeQueryComponent(serviceId)}'
          : '?id=${Uri.encodeQueryComponent(docId)}';
      final r = await ApiAuth.deleteSigned('$kAgentBase/docs$qs');
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ── Service numbers (Mode B only) ──────────────────────────────────────────

  /// Owner: list this account's service numbers + their Agent Profiles.
  static Future<List<BusinessAgentService>> listServices() async {
    try {
      final r = await ApiAuth.getSigned('$kAgentBase/services');
      if (r.statusCode == 404 || r.statusCode == 501) return const [];
      if (r.statusCode != 200) return const [];
      final j = _json(r.body);
      final list = (j['services'] as List?) ?? const [];
      return list.whereType<Map>().map((m) => BusinessAgentService.fromJson(m.cast<String, dynamic>())).toList();
    } catch (_) {
      return const [];
    }
  }

  /// Owner: "Add a service" — creates a new AvaTOK service number + Agent
  /// Profile (§4 "Multiple service numbers", §12.5). Enforces
  /// MIN_SERVICE_RATE server-side; the client also warns below 20/min (§12.2).
  static Future<BusinessAgentService?> createService(BusinessAgentService s) async {
    try {
      final r = await ApiAuth.postJson('$kAgentBase/services', s.toJson());
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      if (j.isEmpty) return null;
      return BusinessAgentService.fromJson(j);
    } catch (_) {
      return null;
    }
  }

  /// Owner: update an existing service's Agent Profile fields. [number] is the
  /// service number (worker's row key — PUT /api/agent/services identifies the
  /// row via `number` in the JSON body, NOT a path/id segment).
  static Future<bool> updateService(String number, BusinessAgentService s) async {
    try {
      final body = s.toJson()..['number'] = number;
      final r = await ApiAuth.putJson('$kAgentBase/services', body);
      if (r.statusCode != 200) return false;
      return _json(r.body)['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Owner: retire a service number (never recycled — §15.3). Blocked
  /// server-side while any escrow is in flight. [number] is the service
  /// number (DELETE /api/agent/services identifies the row via `number` in
  /// the JSON body, NOT a path/id segment).
  static Future<bool> deleteService(String number) async {
    try {
      final r = await ApiAuth.deleteJson('$kAgentBase/services', {'number': number});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ── Caller-side "My AI calls" (§12.11) ─────────────────────────────────────

  /// Caller: my own AI-agent call history (NOT Messenger — channel split).
  /// Returns an empty list + [MyAiCallsResult.available]=false when the server
  /// route isn't live yet, so the screen can show "not available yet" instead
  /// of an error.
  static Future<MyAiCallsResult> myCalls({String? cursor, int limit = 30}) async {
    try {
      final qs = <String, String>{
        'limit': '$limit',
        if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
      };
      final q = qs.entries.map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}').join('&');
      final r = await ApiAuth.getSigned('$kAgentBase/my-calls?$q');
      if (r.statusCode == 404 || r.statusCode == 501) {
        return const MyAiCallsResult(calls: [], nextCursor: null, available: false);
      }
      if (r.statusCode != 200) return const MyAiCallsResult(calls: [], nextCursor: null, available: true);
      final j = _json(r.body);
      final list = (j['calls'] as List?) ?? const [];
      return MyAiCallsResult(
        calls: list.whereType<Map>().map((m) => MyAiCall.fromJson(m.cast<String, dynamic>())).toList(),
        nextCursor: (j['next_cursor'] as String?),
        available: true,
      );
    } catch (_) {
      return const MyAiCallsResult(calls: [], nextCursor: null, available: false);
    }
  }

  /// Caller: full transcript for one of my AI calls (view/download).
  static Future<MyAiCallTranscript?> myCallTranscript(String callId) async {
    try {
      final r = await ApiAuth.getSigned('$kAgentBase/my-calls/${Uri.encodeComponent(callId)}');
      if (r.statusCode != 200) return null;
      final j = _json(r.body);
      if (j.isEmpty) return null;
      return MyAiCallTranscript.fromJson(j);
    } catch (_) {
      return null;
    }
  }
}

/// Routing mode shared by the primary agent and every service Agent Profile.
enum AgentRouting { auto2Rings, manualOnly, off }

extension AgentRoutingCodec on AgentRouting {
  String get wire => switch (this) {
        AgentRouting.auto2Rings => 'auto_2_rings',
        AgentRouting.manualOnly => 'manual_only',
        AgentRouting.off => 'off',
      };
  static AgentRouting fromWire(String? v) => switch (v) {
        'auto_2_rings' => AgentRouting.auto2Rings,
        'manual_only' => AgentRouting.manualOnly,
        _ => AgentRouting.off,
      };
}

/// One day's optional business-hours window (§15.1). `null` start/end = closed
/// that day. Times are "HH:mm" 24h local strings, kept simple per §15.1.
class BusinessHoursDay {
  final bool enabled;
  final String start; // "09:00"
  final String end;   // "17:00"
  const BusinessHoursDay({this.enabled = false, this.start = '09:00', this.end = '17:00'});
  factory BusinessHoursDay.fromJson(Map<String, dynamic> j) => BusinessHoursDay(
        enabled: j['enabled'] == true,
        start: (j['start'] ?? '09:00').toString(),
        end: (j['end'] ?? '17:00').toString(),
      );
  Map<String, dynamic> toJson() => {'enabled': enabled, 'start': start, 'end': end};
  BusinessHoursDay copyWith({bool? enabled, String? start, String? end}) => BusinessHoursDay(
        enabled: enabled ?? this.enabled,
        start: start ?? this.start,
        end: end ?? this.end,
      );
}

/// Mon..Sun optional schedule. Empty/all-disabled = always-on routing (no hours
/// restriction), matching "optional" in §15.1.
class BusinessHours {
  final List<BusinessHoursDay> days; // index 0=Mon .. 6=Sun
  const BusinessHours(this.days);
  factory BusinessHours.defaults() =>
      BusinessHours(List.generate(7, (_) => const BusinessHoursDay()));
  factory BusinessHours.fromJson(dynamic j) {
    if (j is List) {
      final days = j.whereType<Map>().map((m) => BusinessHoursDay.fromJson(m.cast<String, dynamic>())).toList();
      while (days.length < 7) { days.add(const BusinessHoursDay()); }
      return BusinessHours(days.take(7).toList());
    }
    return BusinessHours.defaults();
  }
  List<dynamic> toJson() => days.map((d) => d.toJson()).toList();
  bool get anyEnabled => days.any((d) => d.enabled);
}

/// Primary-number (Mode A) Ava Business Agent settings.
class BusinessAgentSettings {
  final bool enabled;
  final String instructions;
  final AgentRouting routing;
  final BusinessHours hours;
  final int walletBalanceHint; // last-known coin balance, purely a UI hint
  const BusinessAgentSettings({
    this.enabled = false,
    this.instructions = '',
    this.routing = AgentRouting.off,
    required this.hours,
    this.walletBalanceHint = 0,
  });
  factory BusinessAgentSettings.defaults() =>
      BusinessAgentSettings(hours: BusinessHours.defaults());
  factory BusinessAgentSettings.fromJson(Map<String, dynamic> j) => BusinessAgentSettings(
        enabled: j['enabled'] == true,
        instructions: (j['instructions'] ?? '').toString(),
        routing: AgentRoutingCodec.fromWire((j['routing'] ?? '').toString()),
        hours: BusinessHours.fromJson(j['hours']),
        walletBalanceHint: (j['wallet_balance'] as num?)?.toInt() ?? 0,
      );
  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'instructions': instructions,
        'routing': routing.wire,
        'hours': hours.toJson(),
      };
  BusinessAgentSettings copyWith({
    bool? enabled, String? instructions, AgentRouting? routing, BusinessHours? hours,
  }) => BusinessAgentSettings(
        enabled: enabled ?? this.enabled,
        instructions: instructions ?? this.instructions,
        routing: routing ?? this.routing,
        hours: hours ?? this.hours,
        walletBalanceHint: walletBalanceHint,
      );
}

/// An uploaded knowledge-base document (RAG source, §5).
class BusinessAgentDoc {
  final String id;
  final String name;
  final int sizeBytes;
  final bool indexed;
  const BusinessAgentDoc({required this.id, required this.name, this.sizeBytes = 0, this.indexed = false});
  factory BusinessAgentDoc.fromJson(Map<String, dynamic> j) => BusinessAgentDoc(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        sizeBytes: (j['size'] as num?)?.toInt() ?? 0,
        indexed: j['indexed'] == true,
      );
}

/// A caller-pays service number (Mode B) + its Agent Profile (§4, §12.5).
class BusinessAgentService {
  final String id;         // service id ('' when not yet created)
  final String number;     // the AvaTOK service number, assigned by the server
  final String name;       // e.g. "US visa interview practice"
  final String ownerName;  // display name for "‹Service› by ‹owner›" (§12.10)
  final int rate;          // tokens/min the CALLER pays; server enforces MIN_SERVICE_RATE
  final List<int> lengthOptions; // minutes, e.g. [15, 45, 60]
  final String instructions;
  final AgentRouting routing;
  final BusinessHours hours;
  const BusinessAgentService({
    this.id = '',
    this.number = '',
    required this.name,
    this.ownerName = '',
    this.rate = 20,
    this.lengthOptions = const [15, 30, 60],
    this.instructions = '',
    this.routing = AgentRouting.auto2Rings,
    required this.hours,
  });
  factory BusinessAgentService.blank() =>
      BusinessAgentService(name: '', hours: BusinessHours.defaults());
  factory BusinessAgentService.fromJson(Map<String, dynamic> j) => BusinessAgentService(
        id: (j['id'] ?? '').toString(),
        number: (j['number'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        ownerName: (j['owner_name'] ?? '').toString(),
        rate: (j['rate'] as num?)?.toInt() ?? kMinServiceRate,
        lengthOptions: ((j['length_options'] as List?) ?? const [15, 30, 60])
            .map((e) => (e as num).toInt()).toList(),
        instructions: (j['instructions'] ?? '').toString(),
        routing: AgentRoutingCodec.fromWire((j['routing'] ?? '').toString()),
        hours: BusinessHours.fromJson(j['hours']),
      );
  Map<String, dynamic> toJson() => {
        if (id.isNotEmpty) 'id': id,
        'name': name,
        'rate': rate,
        'length_options': lengthOptions,
        'instructions': instructions,
        'routing': routing.wire,
        'hours': hours.toJson(),
      };
  BusinessAgentService copyWith({
    String? name, int? rate, List<int>? lengthOptions, String? instructions,
    AgentRouting? routing, BusinessHours? hours,
  }) => BusinessAgentService(
        id: id, number: number, ownerName: ownerName,
        name: name ?? this.name,
        rate: rate ?? this.rate,
        lengthOptions: lengthOptions ?? this.lengthOptions,
        instructions: instructions ?? this.instructions,
        routing: routing ?? this.routing,
        hours: hours ?? this.hours,
      );
}

/// §12.2 — proposed MIN_SERVICE_RATE (owner to confirm the exact value; UI
/// blocks below this so callee nets > 0 after the 10-admin + 3-line fees).
const int kMinServiceRate = 20;

/// One row in "My AI calls" (§12.11).
class MyAiCall {
  final String callId;
  final String serviceName; // '' for a primary-number (Mode A) call
  final String ownerName;
  final DateTime startedAt;
  final int durationSec;
  final bool resolved;
  final String summary;
  const MyAiCall({
    required this.callId, this.serviceName = '', this.ownerName = '',
    required this.startedAt, this.durationSec = 0, this.resolved = false, this.summary = '',
  });
  factory MyAiCall.fromJson(Map<String, dynamic> j) => MyAiCall(
        callId: (j['call_id'] ?? '').toString(),
        serviceName: (j['service_name'] ?? '').toString(),
        ownerName: (j['owner_name'] ?? '').toString(),
        startedAt: DateTime.fromMillisecondsSinceEpoch(
            ((j['started_at'] as num?)?.toInt() ?? 0), isUtc: true).toLocal(),
        durationSec: (j['duration_sec'] as num?)?.toInt() ?? 0,
        resolved: j['resolved'] == true,
        summary: (j['summary'] ?? '').toString(),
      );
}

class MyAiCallsResult {
  final List<MyAiCall> calls;
  final String? nextCursor;
  final bool available; // false = server route not live yet ("not available yet")
  const MyAiCallsResult({required this.calls, required this.nextCursor, required this.available});
}

/// Full transcript for one AI call, viewable/downloadable by the caller.
class MyAiCallTranscript {
  final String callId;
  final List<TranscriptTurn> turns;
  final String whatTheAgentDid; // short summary line, e.g. "Booked Room 5 for the 14th."
  const MyAiCallTranscript({required this.callId, required this.turns, this.whatTheAgentDid = ''});
  factory MyAiCallTranscript.fromJson(Map<String, dynamic> j) => MyAiCallTranscript(
        callId: (j['call_id'] ?? '').toString(),
        turns: ((j['turns'] as List?) ?? const [])
            .whereType<Map>().map((m) => TranscriptTurn.fromJson(m.cast<String, dynamic>())).toList(),
        whatTheAgentDid: (j['what_the_agent_did'] ?? '').toString(),
      );

  /// Flatten to a plain-text transcript for local download/share.
  String toPlainText() => turns.map((t) => '${t.speaker}: ${t.text}').join('\n');
}

class TranscriptTurn {
  final String speaker; // 'caller' | 'agent'
  final String text;
  const TranscriptTurn({required this.speaker, required this.text});
  factory TranscriptTurn.fromJson(Map<String, dynamic> j) =>
      TranscriptTurn(speaker: (j['speaker'] ?? 'agent').toString(), text: (j['text'] ?? '').toString());
}
