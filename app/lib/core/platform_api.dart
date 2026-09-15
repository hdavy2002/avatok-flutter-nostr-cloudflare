import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_auth.dart';
import 'config.dart';

/// A JSON response together with its HTTP status.
///
/// The calendar's additive Google endpoints need the status: a 404/405 means
/// THIS DEPLOYMENT does not serve the route yet (older backend), which must
/// degrade to "unavailable" rather than being presented as a successful sync.
class PlatformResult {
  final int statusCode;
  final Map<String, dynamic> json;

  const PlatformResult(this.statusCode, this.json);

  bool get ok => statusCode >= 200 && statusCode < 300;

  /// True when the server does not implement this route at all.
  bool get routeUnavailable => statusCode == 404 || statusCode == 405;

  String? get error {
    final value = json['error'];
    if (value is Map) return value['message']?.toString() ?? value.toString();
    return value?.toString();
  }
}

/// Typed client for the v5.2 platform + agentic backend (Phases 1-8). All calls
/// are dual-auth (NIP-98 + Clerk) via [ApiAuth]; identity is derived server-side
/// from the signature. Money-in (wallet top-up) and payouts are flag-gated OFF on
/// the server pending legal — those methods surface the server's 503 reason.
class PlatformApi {
  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }
  static PlatformResult _result(http.Response response) =>
      PlatformResult(response.statusCode, _json(response.body));
  static List<Map<String, dynamic>> _list(Map<String, dynamic> j, String key) =>
      ((j[key] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();

  // ── AvaID (Phase 1) ───────────────────────────────────────────────────────
  /// Start a Rekognition Face Liveness session. Returns the SessionId for the
  /// native Amplify liveness UI (see AvaIdBridge). 503 if server AWS unconfigured.
  static Future<Map<String, dynamic>> idSession() async =>
      _json((await ApiAuth.postJson('$kIdBase/session', const {})).body);
  static Future<Map<String, dynamic>> idResult(String sessionId) async =>
      _json((await ApiAuth.postJson('$kIdBase/result', {'session_id': sessionId})).body);
  static Future<Map<String, dynamic>> idStatus() async =>
      _json((await ApiAuth.getSigned('$kIdBase/status')).body);

  // ── AvaWallet (Phase 2) ───────────────────────────────────────────────────
  static Future<Map<String, dynamic>> walletBalance() async =>
      _json((await ApiAuth.getSigned('$kWalletBase/balance')).body);
  /// Returns {checkout_url} on success, or {error, reason:'pending_legal_approval'} (503).
  static Future<Map<String, dynamic>> walletTopup(int coins) async =>
      _json((await ApiAuth.postJson('$kWalletBase/topup', {'amount': coins})).body);
  // walletSpend() REMOVED 2026-06-18 — the generic client-amount /api/wallet/spend
  // endpoint is gone (a client must never set its own charge). Purchases go through
  // their dedicated, server-priced endpoints (OLX buy, booking, vision/voice, etc.).
  static Future<List<Map<String, dynamic>>> walletTransactions() async =>
      _list(_json((await ApiAuth.getSigned('$kWalletBase/transactions')).body), 'transactions');
  static Future<Map<String, dynamic>> walletEarnings() async =>
      _json((await ApiAuth.getSigned('$kWalletBase/earnings')).body);
  /// Live balance WebSocket URL (connect with the same NIP-98 header via a header-capable socket).
  static String walletLiveUrl() => '${kWalletBase.replaceFirst('https', 'wss')}/live';

  // ── AvaCalendar (Phase 3) ─────────────────────────────────────────────────
  static Future<Map<String, dynamic>> createSlot({required String title, required int startAt, required int endAt, int priceTokens = 0, int capacity = 1, String? description}) async =>
      _json((await ApiAuth.postJson('$kCalendarBase/slots', {'title': title, 'start_at': startAt, 'end_at': endAt, 'price_coins': priceTokens, 'capacity': capacity, if (description != null) 'description': description})).body);
  static Future<List<Map<String, dynamic>>> slots({String? hostNpub}) async =>
      _list(_json((await ApiAuth.getSigned('$kCalendarBase/slots${hostNpub != null ? '?host=$hostNpub' : ''}')).body), 'slots');
  static Future<Map<String, dynamic>> book(String slotId) async =>
      _json((await ApiAuth.postJson('$kCalendarBase/book', {'slot_id': slotId})).body);
  static Future<Map<String, dynamic>> cancelBooking(String bookingId) async =>
      _json((await ApiAuth.postJson('$kCalendarBase/cancel', {'booking_id': bookingId})).body);
  static Future<List<Map<String, dynamic>>> events() async =>
      _list(_json((await ApiAuth.getSigned('$kCalendarBase/events')).body), 'events');

  // ── AvaCalendar + AvaBooking (Phase 5: conflict engine, gcal, policies) ──
  /// My cross-app occupancy (blips): avacalendar|avabooking|avalive|gcal|manual.
  static Future<List<Map<String, dynamic>>> calendarBlocks({required int from, required int to}) async =>
      _list(_json((await ApiAuth.getSigned('$kCalendarBase/blocks?from=$from&to=$to')).body), 'blocks');
  /// Computed picker grid for a creator+date. Occupied slots come back FLAGGED
  /// (available=false, reason, occupied_by) — render greyed, never hide.
  static Future<List<Map<String, dynamic>>> freeSlots({required String creator, required String date, int durMin = 0}) async =>
      _list(_json((await ApiAuth.getSigned('$kCalendarBase/slots?creator=$creator&date=$date&dur=$durMin')).body), 'slots');
  static Future<List<Map<String, dynamic>>> availabilityRules() async =>
      _list(_json((await ApiAuth.getSigned('$kCalendarBase/rules')).body), 'rules');
  static Future<Map<String, dynamic>> saveAvailabilityRules(List<Map<String, dynamic>> rules) async =>
      _json((await ApiAuth.putJson('$kCalendarBase/rules', {'rules': rules})).body);
  static Future<Map<String, dynamic>> gcalStatus() async =>
      _json((await ApiAuth.getSigned('$kCalendarBase/gcal/status')).body);
  /// Returns {url} for the Google OAuth consent flow. `?return=app` makes the
  /// Worker redirect the callback to avatokauth:// so the in-app auth sheet
  /// (flutter_web_auth_2) auto-closes instead of showing the "close this window"
  /// page — keeps Calendar connect inside the app.
  static Future<Map<String, dynamic>> gcalConnect() async =>
      _json((await ApiAuth.getSigned('$kCalendarBase/gcal/connect?return=app')).body);
  static Future<Map<String, dynamic>> gcalDisconnect() async =>
      _json((await ApiAuth.deleteSigned('$kCalendarBase/gcal')).body);
  // ── Google readiness / import (audit findings 5, 6; A8) ──────────────────
  /// Status WITH its HTTP status code, so the settings screen can distinguish
  /// "route not deployed" from "server said no" and never show a false Ready.
  static Future<PlatformResult> gcalStatusResult() async =>
      _result(await ApiAuth.getSigned('$kCalendarBase/gcal/status'));
  /// POST /api/calendar/gcal/sync — imports busy times now (bounded, rate
  /// limited server-side). Returns the same readiness payload as the status
  /// endpoint so callers can update in place.
  static Future<PlatformResult> gcalSyncResult() async =>
      _result(await ApiAuth.postJson('$kCalendarBase/gcal/sync', const {}));
  /// GET /api/calendar/gcal/calendars — refreshes the Google CALENDAR LIST.
  /// Distinct from a busy-time sync; keep the two controls separate.
  static Future<PlatformResult> gcalCalendarsResult() async =>
      _result(await ApiAuth.getSigned('$kCalendarBase/gcal/calendars'));
  /// PUT /api/calendar/gcal/calendars — which Google calendars block time and
  /// which one receives AvaTOK bookings.
  static Future<PlatformResult> gcalSaveCalendarsResult({
    required List<String> readCalendarIds,
    required String destinationCalendarId,
  }) async =>
      _result(await ApiAuth.putJson('$kCalendarBase/gcal/calendars', {
        'read_calendar_ids': readCalendarIds,
        'destination_calendar_id': destinationCalendarId,
      }));
  static Future<List<Map<String, dynamic>>> bookings({String role = 'all', String when = 'upcoming'}) async =>
      _list(_json((await ApiAuth.getSigned('$kBookingBase/list?role=$role&when=$when')).body), 'bookings');
  static Future<Map<String, dynamic>> bookingPolicies() async =>
      _json((await ApiAuth.getSigned('$kBookingBase/policies')).body);
  static Future<Map<String, dynamic>> saveBookingPolicies({int? bufferMin, int? minNoticeMin, int? maxPerDay, int? vacationUntil}) async =>
      _json((await ApiAuth.putJson('$kBookingBase/policies', {
        if (bufferMin != null) 'buffer_min': bufferMin,
        if (minNoticeMin != null) 'min_notice_min': minNoticeMin,
        if (maxPerDay != null) 'max_per_day': maxPerDay,
        'vacation_until': vacationUntil ?? 0,
      })).body);
  static Future<Map<String, dynamic>> proposeReschedule(String bookingId, {required int newStart, required int newEnd}) async =>
      _json((await ApiAuth.postJson('$kBookingBase/$bookingId/reschedule', {'new_start': newStart, 'new_end': newEnd})).body);
  static Future<Map<String, dynamic>> respondReschedule(String rescheduleId, {required bool accept}) async =>
      _json((await ApiAuth.postJson('$kBookingBase/reschedule/$rescheduleId/respond', {'accept': accept})).body);
  static Future<List<Map<String, dynamic>>> reschedules(String bookingId) async =>
      _list(_json((await ApiAuth.getSigned('$kBookingBase/reschedules?booking=$bookingId')).body), 'reschedules');

  // ── AvaPayout (Phase 4) ───────────────────────────────────────────────────
  static Future<Map<String, dynamic>> payoutSetup({required String accountHolder, required String ifsc, required String accountNumber, String? label}) async =>
      _json((await ApiAuth.postJson('$kPayoutBase/setup', {'account_holder': accountHolder, 'ifsc': ifsc, 'account_number': accountNumber, if (label != null) 'label': label})).body);
  static Future<List<Map<String, dynamic>>> payoutAccounts() async =>
      _list(_json((await ApiAuth.getSigned('$kPayoutBase/accounts')).body), 'accounts');
  static Future<Map<String, dynamic>> payoutRequest({required String accountId, required int amountTokens}) async =>
      _json((await ApiAuth.postJson('$kPayoutBase/request', {'account_id': accountId, 'amount_coins': amountTokens})).body);
  static Future<List<Map<String, dynamic>>> payoutStatus() async =>
      _list(_json((await ApiAuth.getSigned('$kPayoutBase/status')).body), 'requests');

  // ── AvaOLX (Phase 5) ──────────────────────────────────────────────────────
  static Future<List<Map<String, dynamic>>> olxBrowse({String? kind, String? category, String? seller}) async {
    final q = <String>[if (kind != null) 'kind=$kind', if (category != null) 'category=$category', if (seller != null) 'seller=$seller'];
    return _list(_json((await ApiAuth.getSigned('$kOlxBase/listings${q.isEmpty ? '' : '?${q.join('&')}'}')).body), 'listings');
  }
  static Future<Map<String, dynamic>> olxCreate({required String kind, required String title, String? notes, String? category, int? priceTokens, String? location, List<String>? imageHashes}) async =>
      _json((await ApiAuth.postJson('$kOlxBase/listings', {'kind': kind, 'title': title, if (notes != null) 'notes': notes, if (category != null) 'category': category, if (priceTokens != null) 'price_coins': priceTokens, if (location != null) 'location': location, if (imageHashes != null) 'image_hashes': imageHashes})).body);
  /// Upload the digital deliverable bytes for a digital listing (seller).
  static Future<Map<String, dynamic>> olxUploadFile(String listingId, List<int> bytes, {String fileName = 'download.bin', String mime = 'application/octet-stream'}) async =>
      _json((await ApiAuth.postBytes('$kOlxBase/listings/$listingId/file', bytes, extraHeaders: {'x-file-name': fileNameHeader(fileName), 'x-content-type': mime})).body);
  static Future<Map<String, dynamic>> olxBuy(String listingId) async =>
      _json((await ApiAuth.postJson('$kOlxBase/buy', {'listing_id': listingId})).body);
  static Future<Map<String, dynamic>> olxRefund(String purchaseId) async =>
      _json((await ApiAuth.postJson('$kOlxBase/refund', {'purchase_id': purchaseId})).body);
  static Future<List<Map<String, dynamic>>> olxDownloads() async =>
      _list(_json((await ApiAuth.getSigned('$kOlxBase/downloads')).body), 'purchases');
  /// Returns {url} (presigned) or streams bytes. Use [downloadPath] then getBytes for streamed fallback.
  static String olxDownloadPath(String purchaseId) => '$kOlxBase/downloads/$purchaseId/file';

  // ── AvaBrain agentic layer (Phases 7-8) ───────────────────────────────────
  static Future<List<Map<String, dynamic>>> personas() async =>
      _list(_json((await ApiAuth.getSigned('$kAgentBase/personas')).body), 'personas');
  static Future<Map<String, dynamic>> savePersona(String app, {required String personaPrompt, String? lookingFor, String? boundaries, bool autoApprove = false, bool enabled = true}) async =>
      _json((await ApiAuth.putJson('$kAgentBase/personas/$app', {'persona_prompt': personaPrompt, if (lookingFor != null) 'looking_for': lookingFor, if (boundaries != null) 'boundaries': boundaries, 'auto_approve': autoApprove, 'enabled': enabled})).body);
  static Future<Map<String, dynamic>> converse({required String app, required String peerNpub}) async =>
      _json((await ApiAuth.postJson('$kAgentBase/converse', {'app': app, 'peer_uid': peerNpub})).body);
  static Future<List<Map<String, dynamic>>> inbox() async =>
      _list(_json((await ApiAuth.getSigned('$kAgentBase/inbox')).body), 'inbox');
  static Future<Map<String, dynamic>> inboxItem(String id) async =>
      _json((await ApiAuth.getSigned('$kAgentBase/inbox/$id')).body);
  static Future<Map<String, dynamic>> inboxAction(String id, String action) async => // approve|dismiss|undo
      _json((await ApiAuth.postJson('$kAgentBase/approve', {'id': id, 'action': action})).body);
  static Future<Map<String, dynamic>> agentTask({required String app, required String kind, Map<String, dynamic>? payload}) async =>
      _json((await ApiAuth.postJson('$kAgentBase/task', {'app': app, 'kind': kind, if (payload != null) 'payload': payload})).body);
  /// Lazy TTS: synthesize-or-cache a conversation's audio, returns {audio_path}.
  static Future<Map<String, dynamic>> ttsListen(String conversationId) async =>
      _json((await ApiAuth.postJson('$kAgentBase/tts', {'conversation_id': conversationId}, timeout: const Duration(seconds: 40))).body);
  static String agentAudioUrl(String conversationId) => '$kAgentBase/audio/$conversationId';
}
