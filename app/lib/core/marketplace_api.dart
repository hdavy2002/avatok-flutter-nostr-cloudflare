import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// AvaMarketplace client API (Specs/AVAMARKETPLACE-FINAL-PROPOSAL.md).
/// Wraps the Worker endpoints added in P3/P5/P6/P7. Listing CRUD itself reuses
/// the existing ListingsApi; this covers the marketplace-specific bits:
/// AI writing help, agent negotiation ("Call Agent") and AI search.
const String _base = 'https://$kSignalingHost/api/marketplace';

class MarketplaceApi {
  static Map<String, dynamic> _j(String body) {
    try { return jsonDecode(body) as Map<String, dynamic>; } catch (_) { return const {}; }
  }

  /// P3 — "Help me write". `want` is one of: instructions | title | description.
  /// Returns the drafted text (Claude Sonnet via OpenRouter, server-side) or null.
  static Future<String?> aiAssist({
    required String want,
    required String kind,
    Map<String, dynamic> fields = const {},
  }) async {
    final r = await ApiAuth.postJson('$_base/ai-assist', {
      'want': want, 'kind': kind, 'fields': fields,
    }, timeout: const Duration(seconds: 30));
    if (r.statusCode != 200) return null;
    final t = _j(r.body)['text'];
    return t is String && t.trim().isNotEmpty ? t.trim() : null;
  }

  /// P5 — queue an agent negotiation for a listing. The buyer supplies their
  /// mandate (max price in the listing's currency). One negotiation per buyer
  /// per listing CONTENT VERSION — the server greys repeats (already_talked).
  /// Returns {ok, status, queued?|outcome?, reason?}.
  static Future<Map<String, dynamic>> callAgent({
    required String listingId,
    required int contentVersion,
    required int maxAmount,
    required String currency,
    String? mustHaves,
  }) async {
    final r = await ApiAuth.postJson('$_base/negotiate', {
      'listing_id': listingId,
      'content_version': contentVersion,
      'buyer_max': maxAmount,
      'currency': currency,
      if (mustHaves != null && mustHaves.isNotEmpty) 'must_haves': mustHaves,
    }, timeout: const Duration(seconds: 25));
    return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode == 200};
  }

  /// P7 — safety precheck before publishing. Returns {ok, reason?,
  /// cleaned_description?, pii_stripped?}. ok:false means the listing was
  /// rejected (porn / scam / disallowed text) with a user-facing reason.
  static Future<Map<String, dynamic>> precheck({
    required String title,
    required String description,
  }) async {
    final r = await ApiAuth.postJson('$_base/precheck', {
      'title': title, 'description': description,
    }, timeout: const Duration(seconds: 30));
    return {..._j(r.body), 'status': r.statusCode};
  }

  /// P5 — has this buyer already negotiated the current version of this listing?
  /// Used to grey the Call Agent button. Returns true when a repeat is blocked.
  static Future<bool> alreadyTalked(String listingId, int contentVersion) async {
    final r = await ApiAuth.getSigned('$_base/negotiate/state?listing_id=$listingId&content_version=$contentVersion');
    if (r.statusCode != 200) return false;
    return _j(r.body)['already_talked'] == true;
  }

  /// MKT-LANG-1 — fetch the user's Marketplace Agent settings (defaults if none).
  /// Returns the `settings` map, or null on failure (caller falls back to local).
  static Future<Map<String, dynamic>?> getAgentSettings() async {
    final r = await ApiAuth.getSigned('$_base/agent-settings',
        timeout: const Duration(seconds: 15));
    if (r.statusCode != 200) return null;
    final s = _j(r.body)['settings'];
    return s is Map<String, dynamic> ? s : null;
  }

  /// MKT-LANG-1 — upsert the user's Marketplace Agent settings. Returns the saved
  /// `settings` map (server-normalised) or null on failure.
  static Future<Map<String, dynamic>?> putAgentSettings(Map<String, dynamic> body) async {
    final r = await ApiAuth.putJson('$_base/agent-settings', body,
        timeout: const Duration(seconds: 15));
    if (r.statusCode != 200) return null;
    final s = _j(r.body)['settings'];
    return s is Map<String, dynamic> ? s : null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AI COMPOSE (Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md §3)
  // Server: worker/src/routes/compose.ts. Three routes, all under
  // /api/marketplace/compose, all gated on `aiComposeEnabled` (503 flag_off).
  //
  // THE RULE THIS CLIENT MUST NOT BREAK (§3.3): the server owns the draft. This
  // file never holds listing state and never decides what is missing — it posts
  // turns and renders what comes back. Publishing is a separate, explicit user
  // action; there is deliberately no publish tool and no client-side publish
  // shortcut.
  // ─────────────────────────────────────────────────────────────────────────

  static const String _composeBase = '$_base/compose';

  /// §3.3c — a fresh idempotency key for ONE logical turn.
  ///
  /// Generate this ONCE per turn and reuse the SAME value on every network
  /// retry of that turn: the server has a unique index on
  /// (session_id, idem_key) and replays the STORED response instead of
  /// re-running the model. A new key per attempt would re-run the model and
  /// double-apply the turn's tools — which is the exact bug the key exists to
  /// prevent, so never mint one inside a retry loop.
  static String newIdemKey() {
    final r = Random.secure();
    final b = List<int>.generate(16, (_) => r.nextInt(256));
    return b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  }

  /// §3.2 — open (or discover a resumable) compose session.
  ///
  /// `lang` is the DEVICE language (§3.7): we converse in the user's language
  /// and let the server store English-canonical. There is deliberately no
  /// language picker — detect and follow.
  static Future<ComposeSessionResult> composeSession({
    String vertical = 'commerce',
    String lang = 'en',
  }) async {
    try {
      final r = await ApiAuth.postJson('$_composeBase/session', {
        'vertical': vertical, 'lang': lang,
      }, timeout: const Duration(seconds: 20));
      final j = _j(r.body);
      if (r.statusCode != 200) {
        return ComposeSessionResult._(
          status: r.statusCode,
          error: j['reason']?.toString() ?? j['error']?.toString() ?? 'http_${r.statusCode}',
          message: _sessionMessage(r.statusCode, j),
        );
      }
      final sid = j['session_id']?.toString();
      if (sid == null || sid.isEmpty) {
        return const ComposeSessionResult._(
          status: 200, error: 'bad_response',
          message: 'Ava could not start a listing right now — try again?',
        );
      }
      final idj = j['identity'];
      final identity = idj is Map ? idj : const {};
      final resj = j['resume'];
      return ComposeSessionResult._(
        status: 200,
        session: ComposeSession(
          sessionId: sid,
          identityOk: identity['ok'] == true,
          identityReason: identity['reason']?.toString(),
          greeting: j['greeting']?.toString() ?? 'What are you listing today?',
          categories: _categories(j['categories']),
          resume: resj is Map ? ComposeResume._from(resj) : null,
        ),
      );
    } catch (_) {
      return const ComposeSessionResult._(
        status: 0, error: 'network',
        message: "I couldn't reach Ava — check your connection and try again.",
      );
    }
  }

  static List<ComposeCategory> _categories(Object? raw) {
    if (raw is! List) return const [];
    final out = <ComposeCategory>[];
    for (final c in raw) {
      if (c is! Map) continue;
      final cat = ComposeCategory._from(c);
      if (cat != null) out.add(cat);
    }
    return out;
  }

  static String _sessionMessage(int status, Map<String, dynamic> j) {
    if (j['reason'] == 'flag_off') {
      return "Listing with Ava isn't switched on yet.";
    }
    if (status == 401) return "You're signed out — sign in and try again.";
    if (status == 503) return "Ava is busy right now — try again in a minute.";
    return j['message']?.toString() ?? 'Ava could not start a listing right now.';
  }

  /// §3.3 — one conversational turn. SSE (`text/event-stream`).
  ///
  /// STREAMING: `package:http` CAN stream — `Client.send` returns a
  /// StreamedResponse whose `.stream` is live. So this follows the house
  /// precedent (`ava_ai_client.dart askStream`) rather than reaching for
  /// `dart:io HttpClient`, which would bypass the AvaDns HttpOverrides and
  /// break web. Frames are `data: {...}`, terminated by `data: [DONE]`.
  ///
  /// This never throws for a SERVER-reported problem — those arrive as a
  /// [ComposeError] event so the UI has one path. It DOES throw on transport
  /// failure, which is the caller's signal to retry with the SAME `idemKey`.
  static Stream<ComposeEvent> composeTurn({
    required String sessionId,
    required int turnSeq,
    required String idemKey,
    String? text,
    List<String> media = const [],
    Duration timeout = const Duration(seconds: 60),
  }) async* {
    final url = '$_composeBase/turn';
    final body = <String, dynamic>{
      'session_id': sessionId,
      'turn_seq': turnSeq,
      'idem_key': idemKey,
      if (text != null && text.isNotEmpty) 'text': text,
      if (media.isNotEmpty) 'media': media,
    };
    final bytes = utf8.encode(jsonEncode(body));
    final headers = await ApiAuth.signedHeaders('POST', url, body: bytes);

    final client = http.Client();
    try {
      final req = http.Request('POST', Uri.parse(url))
        ..headers.addAll(headers)
        ..bodyBytes = bytes;
      final resp = await client.send(req).timeout(timeout);
      if (resp.statusCode != 200) {
        // A non-SSE reply: requireUser / flag gate answer in plain JSON. The
        // streaming path bypasses ApiAuth._tracked, so report it ourselves —
        // otherwise a gated or broken compose surface is invisible in PostHog.
        var raw = '';
        try { raw = await resp.stream.bytesToString(); } catch (_) {/* no body */}
        final j = _j(raw);
        Analytics.capture('compose_turn_http_error', {
          'status': resp.statusCode,
          'reason': j['reason']?.toString() ?? j['error']?.toString() ?? '',
        });
        yield ComposeError(
          j['reason']?.toString() ?? j['error']?.toString() ?? 'http_${resp.statusCode}',
          _sessionMessage(resp.statusCode, j),
        );
        return;
      }
      final lines = resp.stream.transform(utf8.decoder).transform(const LineSplitter());
      await for (final line in lines) {
        final t = line.trim();
        if (!t.startsWith('data:')) continue;
        final payload = t.substring(5).trim();
        if (payload.isEmpty || payload == '[DONE]') continue;
        final e = _parseEvent(payload);
        if (e != null) yield e;
      }
    } finally {
      client.close();
    }
  }

  static ComposeEvent? _parseEvent(String payload) {
    try {
      final j = jsonDecode(payload);
      if (j is! Map) return null;
      switch (j['t']?.toString()) {
        case 'say':
          return ComposeSay(j['text']?.toString() ?? '');
        case 'draft':
          return ComposeDraftState(
            progress: (j['progress'] as num?)?.toDouble() ?? 0,
            missing: [for (final m in (j['missing'] as List? ?? const [])) m.toString()],
          );
        case 'chips':
          return ComposeChips([for (final c in (j['chips'] as List? ?? const [])) c.toString()]);
        case 'review':
          final card = j['card'];
          return ComposeReview(card is Map
              ? card.map((k, v) => MapEntry('$k', v))
              : <String, dynamic>{});
        case 'error':
          return ComposeError(
            j['error']?.toString() ?? 'error',
            j['message']?.toString(),
          );
        default:
          return null;
      }
    } catch (_) {
      return null; // a malformed frame loses a frame, never the draft
    }
  }

  /// §3.3 — publish. The ONLY path that creates a live listing, and only ever
  /// from an explicit user tap on the review card.
  ///
  /// Returns the parsed body plus `status`/`ok`, matching [callAgent]. Callers
  /// branch on: 200 {listing_id} · 403 identity_required · 422 {field,reason,
  /// message} · 503 moderation_unavailable · 409 stale_session.
  ///
  /// `rev` is the optimistic version from the review card (§3.3c) — send it so
  /// a draft that moved under us 409s instead of publishing a stale listing.
  static Future<Map<String, dynamic>> composePublish({
    required String sessionId,
    int? rev,
  }) async {
    try {
      final r = await ApiAuth.postJson('$_composeBase/publish', {
        'session_id': sessionId,
        if (rev != null) 'rev': rev,
      }, timeout: const Duration(seconds: 45));
      return {..._j(r.body), 'status': r.statusCode, 'ok': r.statusCode == 200};
    } catch (_) {
      return {
        'status': 0, 'ok': false, 'error': 'network',
        'message': "I couldn't reach Ava to publish that — your draft is safe. Try again?",
      };
    }
  }

  /// §3.4 — stage one listing photo mid-chat.
  ///
  /// Reuses `/upload/public` unchanged (sha256 → R2 → async moderation). The
  /// response carries `hash`, which is what the next turn's `media[]` sends:
  /// the server re-derives `u/<uid>/public/<hash>` and asserts ownership in SQL,
  /// so a hash is the whole contract — the URL is only for the local thumbnail.
  ///
  /// FIXES THE SILENT SWALLOW at sell_listing_flow.dart:115, which caught every
  /// upload error and showed NOTHING — the spinner just stopped and no photo
  /// appeared. This returns the failure so the chat can say so out loud.
  static Future<ListingPhotoUpload> uploadListingPhoto(
    List<int> bytes, {
    String contentType = 'image/jpeg',
  }) async {
    try {
      final res = await ApiAuth.postBytes(
        kUploadPublicUrl, bytes,
        extraHeaders: {'x-content-type': contentType, 'x-app': 'avamarketplace'},
        timeout: const Duration(seconds: 60),
      );
      final j = _j(res.body);
      if (res.statusCode == 200) {
        final hash = j['hash']?.toString();
        if (hash != null && hash.isNotEmpty) {
          return ListingPhotoUpload._(hash: hash, url: j['url']?.toString());
        }
        return const ListingPhotoUpload._(
          error: "That photo came back without an id — try adding it again?",
        );
      }
      return ListingPhotoUpload._(error: _uploadMessage(res.statusCode, j));
    } catch (_) {
      return const ListingPhotoUpload._(
        error: "That photo didn't reach us — check your connection and try again.",
      );
    }
  }

  static String _uploadMessage(int status, Map<String, dynamic> j) {
    final reason = j['reason']?.toString();
    switch (status) {
      case 403:
        return (reason != null && reason.isNotEmpty)
            ? "That photo was rejected: $reason."
            : 'That photo was rejected.';
      case 413:
        return "That photo is too big, or your storage is full.";
      case 401:
        return "You're signed out — sign in and add the photo again.";
      case 400:
        return "That photo looked empty — try another?";
      default:
        return "That photo didn't upload (error $status) — try again?";
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Compose wire types
// ───────────────────────────────────────────────────────────────────────────

/// A turn-0 category chip (§3.2). Comes from the taxonomy, never a hard-coded
/// client list — adding a category must stay a D1 insert, not a Play release.
class ComposeCategory {
  final String id;
  final String? label;
  final String? emoji;
  final String intent; // SELL | RENT | BOOK | LEAD | PROFILE

  const ComposeCategory({
    required this.id,
    this.label,
    this.emoji,
    this.intent = 'SELL',
  });

  /// What the chip reads as.
  String get display {
    final e = emoji?.trim() ?? '';
    final l = (label?.trim().isNotEmpty ?? false) ? label!.trim() : id;
    return e.isEmpty ? l : '$e $l';
  }

  static ComposeCategory? _from(Map j) {
    final id = j['id']?.toString();
    if (id == null || id.isEmpty) return null;
    return ComposeCategory(
      id: id,
      label: j['label']?.toString(),
      emoji: j['emoji']?.toString(),
      intent: j['intent']?.toString() ?? 'SELL',
    );
  }
}

/// §3.3 — "You were listing a 3-bed in Bandra. Carry on?"
///
/// NOTE `turnSeq`/`rev` are parsed defensively and are usually NULL: the server
/// does not currently send them. Without `turnSeq` a resumed session cannot be
/// written to, because every turn must carry `server.turn_seq + 1` and the
/// stale error reports no server-side sequence to resync from. See the resume
/// handling in compose_chat.dart.
class ComposeResume {
  final String sessionId;
  final String summary;
  final int? turnSeq;
  final int? rev;

  const ComposeResume({
    required this.sessionId,
    required this.summary,
    this.turnSeq,
    this.rev,
  });

  static ComposeResume? _from(Map j) {
    final sid = j['session_id']?.toString();
    if (sid == null || sid.isEmpty) return null;
    return ComposeResume(
      sessionId: sid,
      summary: j['summary']?.toString() ?? 'a listing',
      turnSeq: (j['turn_seq'] as num?)?.toInt(),
      rev: (j['rev'] as num?)?.toInt(),
    );
  }
}

/// The opened session (§3.2).
class ComposeSession {
  final String sessionId;

  /// §3.1 — identity is reported as STATE, not enforced here. The server gates
  /// the WRITE (publish). `false` means Ava offers the inline flow; it never
  /// means the chat is blocked.
  final bool identityOk;
  final String? identityReason;
  final String greeting;
  final List<ComposeCategory> categories;
  final ComposeResume? resume;

  const ComposeSession({
    required this.sessionId,
    required this.identityOk,
    this.identityReason,
    required this.greeting,
    this.categories = const [],
    this.resume,
  });
}

class ComposeSessionResult {
  final ComposeSession? session;
  final int status;
  final String? error;
  final String? message;

  const ComposeSessionResult._({
    this.session,
    required this.status,
    this.error,
    this.message,
  });

  bool get ok => session != null;
}

/// One SSE frame (§3.3). Sealed so a new server event cannot be silently
/// ignored by an exhaustive switch at the call site.
sealed class ComposeEvent {
  const ComposeEvent();
}

/// What Ava says, in the user's language (§3.7).
final class ComposeSay extends ComposeEvent {
  final String text;
  const ComposeSay(this.text);
}

/// Server-computed completeness. `missing` is the SERVER's answer to what still
/// blocks a publish — never recompute it client-side (§3.3).
final class ComposeDraftState extends ComposeEvent {
  final double progress; // 0..1
  final List<String> missing;
  const ComposeDraftState({required this.progress, this.missing = const []});
}

/// Tappable short replies, ≤4.
final class ComposeChips extends ComposeEvent {
  final List<String> chips;
  const ComposeChips(this.chips);
}

/// The review card — the model OFFERING to publish. It can never publish
/// itself; only a user tap on this card can (§3.3).
final class ComposeReview extends ComposeEvent {
  final Map<String, dynamic> card;
  const ComposeReview(this.card);
}

/// A server-reported problem: `flag_off` | `stale_session` | `model_unavailable`
/// | `not_found` | `bad_request` | `internal` | `compose_unavailable`.
final class ComposeError extends ComposeEvent {
  final String error;
  final String? message;
  const ComposeError(this.error, [this.message]);
}

/// The result of staging one photo (§3.4). `error` is user-facing copy — the
/// point of this type is that a failure can no longer be nothing.
class ListingPhotoUpload {
  final String? hash;
  final String? url;
  final String? error;

  const ListingPhotoUpload._({this.hash, this.url, this.error});

  bool get ok => hash != null && hash!.isNotEmpty;
}
