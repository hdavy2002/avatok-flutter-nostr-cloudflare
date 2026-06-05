import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';

/// Typed client for the v5.2 platform + agentic backend (Phases 1-8). All calls
/// are dual-auth (NIP-98 + Clerk) via [ApiAuth]; identity is derived server-side
/// from the signature. Money-in (wallet top-up) and payouts are flag-gated OFF on
/// the server pending legal — those methods surface the server's 503 reason.
class PlatformApi {
  static Map<String, dynamic> _json(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return {}; }
  }
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
  static Future<Map<String, dynamic>> walletSpend({required int amount, required String app, String? toNpub, String? ref}) async =>
      _json((await ApiAuth.postJson('$kWalletBase/spend', {'amount': amount, 'app_name': app, if (toNpub != null) 'to_npub': toNpub, if (ref != null) 'ref': ref})).body);
  static Future<List<Map<String, dynamic>>> walletTransactions() async =>
      _list(_json((await ApiAuth.getSigned('$kWalletBase/transactions')).body), 'transactions');
  static Future<Map<String, dynamic>> walletEarnings() async =>
      _json((await ApiAuth.getSigned('$kWalletBase/earnings')).body);
  /// Live balance WebSocket URL (connect with the same NIP-98 header via a header-capable socket).
  static String walletLiveUrl() => '${kWalletBase.replaceFirst('https', 'wss')}/live';

  // ── AvaCalendar (Phase 3) ─────────────────────────────────────────────────
  static Future<Map<String, dynamic>> createSlot({required String title, required int startAt, required int endAt, int priceCoins = 0, int capacity = 1, String? description}) async =>
      _json((await ApiAuth.postJson('$kCalendarBase/slots', {'title': title, 'start_at': startAt, 'end_at': endAt, 'price_coins': priceCoins, 'capacity': capacity, if (description != null) 'description': description})).body);
  static Future<List<Map<String, dynamic>>> slots({String? hostNpub}) async =>
      _list(_json((await ApiAuth.getSigned('$kCalendarBase/slots${hostNpub != null ? '?host=$hostNpub' : ''}')).body), 'slots');
  static Future<Map<String, dynamic>> book(String slotId) async =>
      _json((await ApiAuth.postJson('$kCalendarBase/book', {'slot_id': slotId})).body);
  static Future<Map<String, dynamic>> cancelBooking(String bookingId) async =>
      _json((await ApiAuth.postJson('$kCalendarBase/cancel', {'booking_id': bookingId})).body);
  static Future<List<Map<String, dynamic>>> events() async =>
      _list(_json((await ApiAuth.getSigned('$kCalendarBase/events')).body), 'events');

  // ── AvaPayout (Phase 4) ───────────────────────────────────────────────────
  static Future<Map<String, dynamic>> payoutSetup({required String accountHolder, required String ifsc, required String accountNumber, String? label}) async =>
      _json((await ApiAuth.postJson('$kPayoutBase/setup', {'account_holder': accountHolder, 'ifsc': ifsc, 'account_number': accountNumber, if (label != null) 'label': label})).body);
  static Future<List<Map<String, dynamic>>> payoutAccounts() async =>
      _list(_json((await ApiAuth.getSigned('$kPayoutBase/accounts')).body), 'accounts');
  static Future<Map<String, dynamic>> payoutRequest({required String accountId, required int amountCoins}) async =>
      _json((await ApiAuth.postJson('$kPayoutBase/request', {'account_id': accountId, 'amount_coins': amountCoins})).body);
  static Future<List<Map<String, dynamic>>> payoutStatus() async =>
      _list(_json((await ApiAuth.getSigned('$kPayoutBase/status')).body), 'requests');

  // ── AvaOLX (Phase 5) ──────────────────────────────────────────────────────
  static Future<List<Map<String, dynamic>>> olxBrowse({String? kind, String? category, String? seller}) async {
    final q = <String>[if (kind != null) 'kind=$kind', if (category != null) 'category=$category', if (seller != null) 'seller=$seller'];
    return _list(_json((await ApiAuth.getSigned('$kOlxBase/listings${q.isEmpty ? '' : '?${q.join('&')}'}')).body), 'listings');
  }
  static Future<Map<String, dynamic>> olxCreate({required String kind, required String title, String? notes, String? category, int? priceCoins, String? location, List<String>? imageHashes}) async =>
      _json((await ApiAuth.postJson('$kOlxBase/listings', {'kind': kind, 'title': title, if (notes != null) 'notes': notes, if (category != null) 'category': category, if (priceCoins != null) 'price_coins': priceCoins, if (location != null) 'location': location, if (imageHashes != null) 'image_hashes': imageHashes})).body);
  /// Upload the digital deliverable bytes for a digital listing (seller).
  static Future<Map<String, dynamic>> olxUploadFile(String listingId, List<int> bytes, {String fileName = 'download.bin', String mime = 'application/octet-stream'}) async =>
      _json((await ApiAuth.postBytes('$kOlxBase/listings/$listingId/file', bytes, extraHeaders: {'x-file-name': fileName, 'x-content-type': mime})).body);
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
      _json((await ApiAuth.postJson('$kAgentBase/converse', {'app': app, 'peer_npub': peerNpub})).body);
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
