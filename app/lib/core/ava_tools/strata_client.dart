/// StrataClient (Phase 5 — Tool Layer).
///
/// Client wrapper for the self-hosted Klavis Strata MCP gateway, reached ONLY
/// through the AvaTok Worker ([AvaApi.toolsPrefix] = `/api/ava/tools/`). The
/// client never talks to Strata directly — the Worker holds the self-host
/// origin (`STRATA_URL`), injects the user's encrypted per-provider OAuth token,
/// and enforces the free-vs-subscription gate. Auth is the standard authed-HTTP
/// path ([ApiAuth] — NIP-98 + optional Clerk bearer), same as every other call.
///
/// ── Progressive disclosure (the anti-overload pattern) ──────────────────────
/// Ava NEVER pulls a full catalog. She walks the funnel one step at a time:
///   1. [discoverCategories]   — top-level "what kinds of things can I do?"
///   2. [getCategoryActions]   — the actions inside one category
///   3. [getActionDetails]     — the single action's schema, right before use
///   4. [executeAction]        — run that one action
/// plus [handleAuthFailure] — when an action needs the user to connect a
/// provider, returns an OAuth connect URL (opened by the MCP-connect UI).
///
/// Connection management ([connections] / [saveConnection] / [disconnect])
/// hits our own per-user token store on the Worker, not Strata.
library;

import 'dart:convert';

import '../api_auth.dart';
import '../ava_contracts.dart';
import '../config.dart';

/// A discovered category in the Strata funnel (step 1 result item).
class StrataCategory {
  final String id;
  final String title;
  final String? description;
  const StrataCategory({required this.id, required this.title, this.description});
  factory StrataCategory.fromJson(Map<String, dynamic> j) => StrataCategory(
        id: (j['id'] ?? j['category'] ?? j['name'] ?? '').toString(),
        title: (j['title'] ?? j['label'] ?? j['name'] ?? '').toString(),
        description: j['description']?.toString(),
      );
}

/// A discovered action (step 2 result item). The full parameter schema is only
/// fetched via [StrataClient.getActionDetails] — step 3 — to stay lean.
class StrataAction {
  final String id;
  final String title;
  final String? provider;
  final String? description;
  final bool paid;
  const StrataAction({
    required this.id,
    required this.title,
    this.provider,
    this.description,
    this.paid = false,
  });
  factory StrataAction.fromJson(Map<String, dynamic> j) => StrataAction(
        id: (j['id'] ?? j['action'] ?? j['name'] ?? '').toString(),
        title: (j['title'] ?? j['label'] ?? j['name'] ?? '').toString(),
        provider: (j['provider'] ?? j['server'] ?? j['connector'])?.toString(),
        description: j['description']?.toString(),
        paid: j['paid'] == true,
      );
}

/// Result of an op that needs the user to connect a provider first.
class StrataAuthRequired {
  /// The provider/connector the user must connect (e.g. 'gmail').
  final String provider;

  /// The OAuth URL the app opens in a browser to authorise.
  final String authUrl;
  const StrataAuthRequired({required this.provider, required this.authUrl});
}

class StrataClient {
  StrataClient._();
  static final StrataClient I = StrataClient._();

  /// Origin (no `/api`) so we can append the Phase-0 [AvaApi.toolsPrefix].
  static String get _origin => kApiBase.endsWith('/api')
      ? kApiBase.substring(0, kApiBase.length - '/api'.length)
      : kApiBase;

  static String _url(String op) => '$_origin${AvaApi.toolsPrefix}$op';

  /// Sentinel for "the tool layer isn't configured yet" (Worker 503 while
  /// STRATA_URL is empty). Callers surface this as "tools coming soon".
  static const String unavailableReason = 'strata_unconfigured';

  Future<Map<String, dynamic>> _post(String op, Map<String, dynamic> body) async {
    try {
      final res = await ApiAuth.postJson(_url(op), body, timeout: const Duration(seconds: 30));
      Map<String, dynamic> j;
      try {
        j = jsonDecode(res.body) as Map<String, dynamic>;
      } catch (_) {
        j = const {};
      }
      return {'_status': res.statusCode, ...j};
    } catch (e) {
      return {'_status': 0, 'error': 'network', 'detail': e.toString()};
    }
  }

  bool _ok(Map<String, dynamic> j) => (j['_status'] as int? ?? 0) == 200;

  /// True when the Worker reports the tool layer is not yet configured.
  bool isUnavailable(Map<String, dynamic> j) =>
      (j['_status'] as int? ?? 0) == 503 || j['reason'] == unavailableReason;

  // ── Step 1: discover top-level categories ─────────────────────────────────
  Future<List<StrataCategory>> discoverCategories({String? query}) async {
    final j = await _post('discover_categories', {if (query != null) 'query': query});
    if (!_ok(j)) return const [];
    final list = (j['categories'] ?? j['results'] ?? j['items']) as List<dynamic>?;
    return [
      for (final e in list ?? const [])
        if (e is Map<String, dynamic>) StrataCategory.fromJson(e),
    ];
  }

  // ── Step 2: actions inside a category ─────────────────────────────────────
  Future<List<StrataAction>> getCategoryActions(String category, {String? provider}) async {
    final j = await _post('get_category_actions', {
      'category': category,
      if (provider != null) 'provider': provider,
    });
    if (!_ok(j)) return const [];
    final list = (j['actions'] ?? j['results'] ?? j['items']) as List<dynamic>?;
    return [
      for (final e in list ?? const [])
        if (e is Map<String, dynamic>) StrataAction.fromJson(e),
    ];
  }

  // ── Step 3: the single action's full schema (fetched right before use) ────
  Future<Map<String, dynamic>> getActionDetails(String actionId, {String? provider}) async {
    final j = await _post('get_action_details', {
      'action': actionId,
      if (provider != null) 'provider': provider,
    });
    if (!_ok(j)) return {'error': j['error'] ?? 'unavailable'};
    return j;
  }

  // ── Step 4: execute the one action ────────────────────────────────────────
  /// Returns the action result. On a 402 the account is not entitled to this
  /// (subscription) connector → caller routes to the PaidFeature top-up sheet.
  /// On a [StrataAuthRequired]-shaped result the caller kicks the connect flow.
  Future<StrataResult> executeAction(
    String actionId, {
    String? provider,
    Map<String, Object?> args = const {},
  }) async {
    final j = await _post('execute_action', {
      'action': actionId,
      if (provider != null) 'provider': provider,
      'args': args,
    });
    final status = j['_status'] as int? ?? 0;
    if (status == 402 || j['reason'] == 'paid_tool') {
      return StrataResult(ok: false, paymentRequired: true, provider: provider, raw: j);
    }
    // Strata signals an auth gap either via our handle_auth_failure flow or an
    // inline {auth_required, auth_url} on the execute response.
    if (j['auth_required'] == true || j['auth_url'] != null) {
      final url = (j['auth_url'] ?? '').toString();
      return StrataResult(
        ok: false,
        authRequired: url.isNotEmpty
            ? StrataAuthRequired(provider: provider ?? '', authUrl: url)
            : null,
        provider: provider,
        raw: j,
      );
    }
    return StrataResult(ok: _ok(j), result: j['result'] ?? j, raw: j);
  }

  // ── Per-user OAuth: get a connect URL for a provider ──────────────────────
  Future<StrataAuthRequired?> handleAuthFailure(String provider) async {
    final j = await _post('handle_auth_failure', {'provider': provider});
    if (!_ok(j)) return null;
    final url = (j['auth_url'] ?? j['url'] ?? '').toString();
    if (url.isEmpty) return null;
    return StrataAuthRequired(provider: provider, authUrl: url);
  }

  // ── Connection store (our Worker, not Strata) ─────────────────────────────
  /// Provider ids the current user has connected.
  Future<List<String>> connections() async {
    final j = await _post('connections', const {}); // POST tolerated; GET also works
    if (!_ok(j)) {
      // connections is a GET on the worker; fall back to a signed GET.
      try {
        final res = await ApiAuth.getSigned(_url('connections'));
        final g = jsonDecode(res.body) as Map<String, dynamic>;
        final list = (g['connected'] as List?)?.cast<String>() ?? const [];
        return list;
      } catch (_) {
        return const [];
      }
    }
    return (j['connected'] as List?)?.cast<String>() ?? const [];
  }

  /// Persist a per-user OAuth token for a provider (encrypted server-side).
  /// Typically called by the OAuth callback handler with the returned token.
  Future<bool> saveConnection(String provider, String token) async {
    final j = await _post('connections/save', {'provider': provider, 'token': token});
    return _ok(j);
  }

  /// Disconnect a provider (deletes the user's stored token).
  Future<bool> disconnect(String provider) async {
    try {
      final res = await ApiAuth.deleteSigned(_url('connections/$provider'));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}

/// Result of [StrataClient.executeAction].
class StrataResult {
  final bool ok;

  /// The account is not entitled to this subscription connector.
  final bool paymentRequired;

  /// The user must connect a provider first (open [StrataAuthRequired.authUrl]).
  final StrataAuthRequired? authRequired;

  final String? provider;
  final Object? result;
  final Map<String, dynamic> raw;

  const StrataResult({
    required this.ok,
    this.paymentRequired = false,
    this.authRequired,
    this.provider,
    this.result,
    this.raw = const {},
  });
}
