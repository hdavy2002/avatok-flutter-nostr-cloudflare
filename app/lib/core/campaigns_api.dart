import 'dart:async';
import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// CampaignsApi — outbound AI calling campaigns (Specs/
/// OUTBOUND-AI-CALLING-CAMPAIGNS.md). Talks to `/api/campaigns*` on the
/// Worker (worker/src/routes/campaigns.ts, worker/src/routes/campaign_kb.ts).
/// Mirrors receptionist_api.dart's construction: same `$kSignalingHost/api/…`
/// base + [ApiAuth] Clerk-Bearer signed requests. NOT wired into any
/// screen/router yet — this is client plumbing only for the campaign wizard.
const String _base = 'https://$kSignalingHost/api/campaigns';

/// Thrown by every [CampaignsApi] method on a non-2xx response or a transport
/// failure, so callers can distinguish "server said no" (with a reason) from
/// "couldn't reach the server" at all. [statusCode] is 0 for a network/timeout
/// failure (matches [ApiAuth]'s `status: 0` convention for transport errors).
class ApiException implements Exception {
  final int statusCode;
  final String message;
  const ApiException(this.statusCode, this.message);
  @override
  String toString() => 'ApiException($statusCode, $message)';
}

/// One outbound campaign (draft/running/paused/…). Field names/shapes mirror
/// campaignSummary() in worker/src/routes/campaigns.ts.
class Campaign {
  final String id;
  final String name;
  final String goalText;
  final String status; // draft|ready|running|pausing|paused|cancelling|window_wait|completed|cancelled|out_of_tokens
  final String? didE164;
  final int concurrency;
  final int spendCapTokens;
  final int nTotal;
  final int nDone;
  final int nAnswered;
  final int nMissed;
  final int tokensSpent;
  final bool bookingEnabled;
  final bool handoverEnabled;
  final String? handoverNumber;
  final int? createdAt; // epoch ms

  const Campaign({
    required this.id,
    required this.name,
    required this.goalText,
    required this.status,
    this.didE164,
    this.concurrency = 1,
    this.spendCapTokens = 0,
    this.nTotal = 0,
    this.nDone = 0,
    this.nAnswered = 0,
    this.nMissed = 0,
    this.tokensSpent = 0,
    this.bookingEnabled = false,
    this.handoverEnabled = false,
    this.handoverNumber,
    this.createdAt,
  });

  factory Campaign.fromJson(Map<String, dynamic> j) {
    final counters = (j['counters'] as Map?)?.cast<String, dynamic>() ?? const {};
    return Campaign(
      id: (j['id'] ?? '').toString(),
      name: (j['name'] ?? '').toString(),
      goalText: (j['goal_text'] ?? '').toString(),
      status: (j['status'] ?? 'draft').toString(),
      didE164: j['did_e164'] as String?,
      concurrency: (j['concurrency'] as num?)?.toInt() ?? 1,
      spendCapTokens: (j['spend_cap_tokens'] as num?)?.toInt() ?? 0,
      nTotal: (counters['n_total'] as num?)?.toInt() ?? 0,
      nDone: (counters['n_done'] as num?)?.toInt() ?? 0,
      nAnswered: (counters['n_answered'] as num?)?.toInt() ?? 0,
      nMissed: (counters['n_missed'] as num?)?.toInt() ?? 0,
      tokensSpent: (j['tokens_spent'] as num?)?.toInt() ?? 0,
      bookingEnabled: j['booking_enabled'] == true || j['booking_enabled'] == 1,
      handoverEnabled: j['handover_enabled'] == true || j['handover_enabled'] == 1,
      handoverNumber: j['handover_number'] as String?,
      createdAt: (j['created_at'] as num?)?.toInt(),
    );
  }
}

/// A row from `campaign_contacts` — per-contact dial status (spec §3, §6.2).
/// Not yet returned by any shipped GET route; kept here for the wizard's
/// contact-list view once one exists.
class CampaignContactStat {
  final String id;
  final String? name;
  final String? e164;
  final String status; // pending|dial_reserved|calling|done|missed|busy|voicemail|invalid|dnd_blocked|failed
  final int attempts;
  final String? lastOutcome;

  const CampaignContactStat({
    required this.id,
    this.name,
    this.e164,
    this.status = 'pending',
    this.attempts = 0,
    this.lastOutcome,
  });

  factory CampaignContactStat.fromJson(Map<String, dynamic> j) => CampaignContactStat(
        id: (j['id'] ?? '').toString(),
        name: j['name'] as String?,
        e164: (j['e164'] ?? j['e164_raw']) as String?,
        status: (j['status'] ?? 'pending').toString(),
        attempts: (j['attempts'] as num?)?.toInt() ?? 0,
        lastOutcome: j['last_outcome'] as String?,
      );
}

/// One uploaded knowledge-base file (worker/src/routes/campaign_kb.ts
/// `campaign_kb_files` row).
class CampaignKbFile {
  final String id;
  final String name;
  final int? bytes;
  final String status; // pending|indexed|failed|deleted

  const CampaignKbFile({
    required this.id,
    required this.name,
    this.bytes,
    this.status = 'pending',
  });

  factory CampaignKbFile.fromJson(Map<String, dynamic> j) => CampaignKbFile(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        bytes: (j['bytes'] as num?)?.toInt(),
        status: (j['status'] ?? 'pending').toString(),
      );
}

/// A purchasable DID offer from the (not-yet-built) DID search endpoint.
class DidOffer {
  final String e164;
  final int? monthlyFee;
  final String? currency;
  final String? region;

  const DidOffer({required this.e164, this.monthlyFee, this.currency, this.region});

  factory DidOffer.fromJson(Map<String, dynamic> j) => DidOffer(
        e164: (j['e164'] ?? '').toString(),
        monthlyFee: (j['monthly_fee'] as num?)?.toInt(),
        currency: j['currency'] as String?,
        region: j['region'] as String?,
      );
}

/// Client for the outbound-campaigns Worker API. Auth/base-URL mechanism
/// mirrors [ReceptionistApi]: Clerk-Bearer signed requests via [ApiAuth]
/// against `https://$kSignalingHost/api/…`, JSON in/out.
class CampaignsApi {
  static Map<String, dynamic> _decodeMap(dynamic body) {
    try {
      final j = jsonDecode(body as String);
      if (j is Map) return j.cast<String, dynamic>();
    } catch (_) {/* fall through to empty map */}
    return const {};
  }

  static Never _throwFor(int status, Map<String, dynamic> j) {
    final msg = (j['error'] ?? j['reason'] ?? 'http_$status').toString();
    throw ApiException(status, msg);
  }

  /// POST /api/campaigns — create a draft.
  static Future<Campaign> createCampaign({
    required String name,
    required String goalText,
    required int spendCapTokens,
    String? didE164,
    String? languageHint,
    String? voicePersona,
    int? concurrency,
    int? windowStartMin,
    int? windowEndMin,
  }) async {
    final body = <String, dynamic>{
      'name': name,
      'goal_text': goalText,
      'spend_cap_tokens': spendCapTokens,
      if (didE164 != null) 'did_e164': didE164,
      if (languageHint != null) 'language_hint': languageHint,
      if (voicePersona != null) 'voice_persona': voicePersona,
      if (concurrency != null) 'concurrency': concurrency,
      if (windowStartMin != null) 'window_start_min': windowStartMin,
      if (windowEndMin != null) 'window_end_min': windowEndMin,
    };
    try {
      final r = await ApiAuth.postJson(_base, body, timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 201 && r.statusCode != 200) _throwFor(r.statusCode, j);
      // create returns {ok, id, status, max_contacts} — not the full summary
      // shape — so synthesize a minimal Campaign from what we sent + got back.
      return Campaign(
        id: (j['id'] ?? '').toString(),
        name: name,
        goalText: goalText,
        status: (j['status'] ?? 'draft').toString(),
        didE164: didE164,
        concurrency: concurrency ?? 1,
        spendCapTokens: spendCapTokens,
      );
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// GET /api/campaigns — list the caller's campaigns.
  static Future<List<Campaign>> listCampaigns() async {
    try {
      final r = await ApiAuth.getSigned(_base, timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      final list = (j['campaigns'] as List?) ?? const [];
      return list
          .whereType<Map>()
          .map((e) => Campaign.fromJson(e.cast<String, dynamic>()))
          .toList();
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// GET /api/campaigns/:id
  static Future<Campaign> getCampaign(String id) async {
    try {
      final r = await ApiAuth.getSigned('$_base/${Uri.encodeComponent(id)}',
          timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      return Campaign.fromJson((j['campaign'] as Map).cast<String, dynamic>());
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// POST /api/campaigns/:id/launch — freezes the compiled prompt and starts
  /// dialing. Returns the updated status string (e.g. "running").
  static Future<String> launchCampaign(String id) => _controlOp(id, 'launch');

  /// POST /api/campaigns/:id/pause
  static Future<String> pauseCampaign(String id) => _controlOp(id, 'pause');

  /// POST /api/campaigns/:id/resume
  static Future<String> resumeCampaign(String id) => _controlOp(id, 'resume');

  /// POST /api/campaigns/:id/cancel
  static Future<String> cancelCampaign(String id) => _controlOp(id, 'cancel');

  static Future<String> _controlOp(String id, String op) async {
    try {
      final r = await ApiAuth.postJson(
          '$_base/${Uri.encodeComponent(id)}/$op', const {},
          timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      return (j['status'] ?? '').toString();
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// POST /api/campaigns/:id/kb?name=<filename> — raw-bytes KB upload
  /// (worker/src/routes/campaign_kb.ts). Returns the new file's id.
  static Future<String> uploadKbFile(String id, String filename, List<int> bytes) async {
    try {
      final url =
          '$_base/${Uri.encodeComponent(id)}/kb?name=${Uri.encodeQueryComponent(filename)}';
      final r = await ApiAuth.postBytes(url, bytes, timeout: const Duration(seconds: 60));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      return (j['fileId'] ?? '').toString();
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// GET /api/campaigns/:id/kb — list uploaded knowledge-base files.
  static Future<List<CampaignKbFile>> listKbFiles(String id) async {
    try {
      final r = await ApiAuth.getSigned('$_base/${Uri.encodeComponent(id)}/kb',
          timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      final list = (j['files'] as List?) ?? const [];
      return list
          .whereType<Map>()
          .map((e) => CampaignKbFile.fromJson(e.cast<String, dynamic>()))
          .toList();
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// DELETE /api/campaigns/:id/kb — clear the campaign's knowledge base
  /// (deletes the Gemini File Search store, soft-deletes the D1 rows).
  static Future<bool> deleteKb(String id) async {
    try {
      final r = await ApiAuth.deleteSigned('$_base/${Uri.encodeComponent(id)}/kb',
          timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      return j['ok'] == true;
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  // ---------------------------------------------------------------------
  // TODO(backend): the routes below have no Worker route yet — Contact
  // upload and DID search/buy are later phases per
  // Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §11/§17. Client methods point at
  // the INTENDED paths so the wizard can be built now and wired for real the
  // moment the backend ships; they will 404 until then. Do not call from a
  // production screen path without a feature-flag/try-catch fallback.
  // ---------------------------------------------------------------------

  /// TODO(backend): POST /api/campaigns/:id/contacts — raw file (CSV/XLSX)
  /// upload, contact ingestion (spec §6.2 "Contact ingestion"). Returns the
  /// number of contacts ingested.
  static Future<int> uploadContacts(String id, List<int> bytes, String filename) async {
    try {
      final url =
          '$_base/${Uri.encodeComponent(id)}/contacts?name=${Uri.encodeQueryComponent(filename)}';
      final r = await ApiAuth.postBytes(url, bytes, timeout: const Duration(seconds: 60));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      return (j['count'] as num?)?.toInt() ?? 0;
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// TODO(backend): GET /api/dids/search?country=&contains= — DID inventory
  /// search (spec §5 "DID acquisition"). Not mounted on the Worker yet.
  static Future<List<DidOffer>> searchDids({String? country, String? contains}) async {
    try {
      final origin = kApiBase; // https://$kSignalingHost/api
      final qp = <String, String>{
        if (country != null && country.isNotEmpty) 'country': country,
        if (contains != null && contains.isNotEmpty) 'contains': contains,
      };
      final uri = Uri.parse('$origin/dids/search').replace(queryParameters: qp.isEmpty ? null : qp);
      final r = await ApiAuth.getSigned(uri.toString(), timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      final list = (j['offers'] as List?) ?? const [];
      return list
          .whereType<Map>()
          .map((e) => DidOffer.fromJson(e.cast<String, dynamic>()))
          .toList();
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }

  /// TODO(backend): POST /api/dids/buy — purchase a DID from the shared pool
  /// (`user_dids`, spec §5). Not mounted on the Worker yet. Returns the
  /// purchased E.164 number.
  static Future<String> buyDid(String e164) async {
    try {
      final origin = kApiBase;
      final r = await ApiAuth.postJson('$origin/dids/buy', {'e164': e164},
          timeout: const Duration(seconds: 20));
      final j = _decodeMap(r.body);
      if (r.statusCode != 200) _throwFor(r.statusCode, j);
      return (j['e164'] ?? e164).toString();
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(0, e.toString());
    }
  }
}
