import 'dart:convert';

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
}
