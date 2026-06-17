import 'dart:async';

import '../../core/api_auth.dart';
import '../../core/ava_ai_store.dart';
import '../../core/ava_contracts.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../identity/identity.dart';

/// AvaTurnController (Phase 3 — In-Thread Ava Spine).
///
/// Invokes an in-thread Ava turn. It does NOT render anything itself: the
/// server posts the "working…" chip and the answer back through the user's
/// InboxDO, which the existing chat pipeline (SyncHub → chat_thread.dart, both
/// frozen for Phase 3) renders as the lilac Ava bubble / working chip.
///
/// Usage from the composer hook (see ava_invoke.dart):
///   await AvaTurnController.I.summon(convKey: state._convKey, text: t);
///
/// `convKey` is the client-local key ('1:<peerUid>' for a DM, 'g:<gid>' for a
/// group) used everywhere in the chat UI. We translate it to the server
/// conversation id with [serverConvFromKey] before calling the worker; the
/// worker (ava_thread.ts) also re-derives/validates server-side.
class AvaTurnController {
  AvaTurnController._();
  static final AvaTurnController I = AvaTurnController._();

  /// Full URL for the in-thread turn route. Built from the API origin + the
  /// Phase-0 [AvaApi.threadTurn] path so the client never re-declares the path.
  static String get _turnUrl {
    // kApiBase = https://<host>/api ; AvaApi.threadTurn = /api/ava/thread/turn.
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin${AvaApi.threadTurn}';
  }

  /// True while a turn for [convKey] is in flight (so the UI/handler can avoid
  /// firing duplicate turns). The visible "working…" chip is server-driven, so
  /// this is only an in-flight guard.
  final Set<String> _inFlight = <String>{};
  bool isBusy(String convKey) => _inFlight.contains(convKey);

  /// Summon Ava in the conversation identified by [convKey].
  ///
  /// [text] is the user's message (already including the `@ava` wake word; the
  /// worker treats it as an untrusted request). When [privateReply] is true the
  /// answer comes back as `ava_private` (scope `to:<me>`) and reaches ONLY the
  /// caller — never the other participant.
  ///
  /// Fire-and-forget friendly: the answer arrives asynchronously over the
  /// InboxDO socket. Returns when the request has been accepted (or failed).
  Future<void> summon({
    required String convKey,
    required String text,
    bool privateReply = false,
  }) async {
    final body = _turnBody(convKey: convKey, text: text, privateReply: privateReply);
    if (body == null) {
      AvaLog.I.log('ava', 'summon skipped — unresolved convKey "$convKey"');
      return;
    }
    if (!_inFlight.add(convKey)) return; // a turn is already running for this conv
    try {
      // Forward the user's own Gemini key (FREE BYO tier) per-request via header,
      // same as AvaAiClient. The Worker passes it to the agent DO for THIS turn
      // only (never stored). No key → server falls back to our-keys Workers-AI.
      final extraHeaders = <String, String>{};
      final byoKey = await AvaAiStore().apiKey();
      if (byoKey != null && byoKey.isNotEmpty) {
        extraHeaders['X-Ava-Gemini-Key'] = byoKey;
      }
      final res = await ApiAuth.postJsonH(_turnUrl, body, extraHeaders,
          timeout: const Duration(seconds: 45)); // grounded search can be slow
      if (res.statusCode != 200) {
        AvaLog.I.log('ava', 'turn FAILED ${res.statusCode}: ${res.body}');
      }
    } catch (e) {
      AvaLog.I.log('ava', 'turn error: $e');
    } finally {
      _inFlight.remove(convKey);
    }
  }

  /// Build the request body, resolving the local [convKey] to the server conv id.
  /// Returns null when the key can't be resolved (no account scope / bad shape).
  Map<String, dynamic>? _turnBody({
    required String convKey,
    required String text,
    required bool privateReply,
  }) {
    final myUid = AccountScope.id;
    if (myUid == null || myUid.isEmpty) return null;
    final conv = serverConvFromKey(convKey, myUid);
    if (conv == null) return null;
    return <String, dynamic>{
      'conv': conv,
      'text': text,
      if (privateReply) 'private': true,
    };
  }
}
