import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'analytics.dart';
import 'api_auth.dart';
import 'ava_ai_store.dart';
import 'ava_contracts.dart';
import 'avaapps_cache.dart';
import 'config.dart';

/// One AvaApp tile. [slug] is the Composio toolkit slug used for connect/status.
class AvaApp {
  final String slug;
  final String name;
  final IconData icon;
  final Color color;
  const AvaApp(this.slug, this.name, this.icon, this.color);
}

/// The free Google set shipped by default in AvaApps (PREMIUM feature). Order +
/// slugs mirror the Worker's GOOGLE_TOOLKITS.
const List<AvaApp> kAvaApps = [
  AvaApp('gmail', 'Gmail', Icons.mail_outline, Color(0xFFEA4335)),
  AvaApp('googledocs', 'Google Docs', Icons.description_outlined, Color(0xFF4285F4)),
  AvaApp('googlesheets', 'Google Sheets', Icons.grid_on, Color(0xFF0F9D58)),
  AvaApp('googledrive', 'Google Drive', Icons.folder_open, Color(0xFF1FA463)),
  AvaApp('googlecalendar', 'Google Calendar', Icons.event, Color(0xFF4285F4)),
];

/// Connectors the user can actually connect in the pro/live launch. Everything
/// else in the Composio catalog renders greyed with a "Soon" badge and is not
/// tappable (owner decision 2026-07-01: ship Gmail + Outlook only). Widen this
/// set (or drive it from KV) to open more connectors later.
/// NOTE: Outlook's OAuth connect still needs the Composio `outlook` toolkit +
/// the Worker connect route to accept it — enabling it here only ungreys the UI.
const Set<String> kEnabledAppSlugs = {'gmail', 'outlook'};

/// Whether [slug] is connectable now (vs greyed "coming soon"). Case-insensitive.
bool isAppEnabled(String slug) => kEnabledAppSlugs.contains(slug.toLowerCase());

/// Phase 5: use the SSE streaming `/run?stream=1` path (with automatic fallback
/// to the non-streaming call on any error). Flip to false to force non-streaming.
const bool kAvaAppsStreaming = true;

/// Talks to the Worker's AvaApps routes (Composio). The Worker holds the Composio
/// key; the client forwards the user's own Gemini key (for the model) per request.
class AppsService {
  AppsService._();
  static final AppsService I = AppsService._();

  final AvaAiStore _ai = AvaAiStore();

  static String _url(String path) {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin$path';
  }

  Future<Map<String, String>> _keyHeader() async {
    final k = await _ai.apiKey();
    return (k != null && k.isNotEmpty) ? {'X-Ava-Gemini-Key': k} : {};
  }

  Future<bool> aiConnected() => _ai.isConnected();

  /// Which toolkit slugs the user has connected (OAuth complete). [fresh] adds
  /// `?fresh=1` so the Worker bypasses its 5-min connection cache and re-reads
  /// from Composio — used right after an OAuth return so a just-connected app
  /// lights up immediately instead of waiting out the cache TTL.
  Future<Set<String>> status({bool fresh = false}) async {
    try {
      final base = _url(AvaApi.appsStatus);
      final url = fresh ? '$base?fresh=1' : base;
      final res = await ApiAuth.getSigned(url, timeout: const Duration(seconds: 20));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (j['connected'] as List?)?.map((e) => e.toString().toLowerCase()) ?? const [];
      final set = list.toSet();
      // Phase 2: persist for instant render on the next screen open (scoped).
      // ignore: unawaited_futures
      AvaAppsCache.writeStatus(set);
      return set;
    } catch (e) {
      // The chat couldn't reach the user's connected Google apps — surface it
      // (api_error already logs HTTP failures; this adds the apps-layer context).
      Analytics.appsUnavailable(endpoint: AvaApi.appsStatus, code: e.runtimeType.toString());
      return <String>{};
    }
  }

  /// The full Composio app catalog (slug, name, logo), optionally filtered.
  Future<List<AvaCatalogApp>> catalog({String? search}) async {
    try {
      final path = (search == null || search.isEmpty)
          ? AvaApi.appsCatalog
          : '${AvaApi.appsCatalog}?search=${Uri.encodeQueryComponent(search)}';
      final res = await ApiAuth.getSigned(_url(path), timeout: const Duration(seconds: 25));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final apps = (j['apps'] as List?) ?? const [];
      return apps
          .map((e) => AvaCatalogApp(
                (e['slug'] ?? '').toString(),
                (e['name'] ?? '').toString(),
                (e['logo'] ?? '').toString(),
              ))
          .where((a) => a.slug.isNotEmpty)
          .toList();
    } catch (e) {
      Analytics.appsUnavailable(endpoint: AvaApi.appsCatalog, code: e.runtimeType.toString());
      return const [];
    }
  }

  /// Connect ONE app (premium). Returns the OAuth URL to open, or '' on
  /// 'premium_required' (caller shows the top-up).
  Future<AppsActionResult> connectSlug(String slug) async {
    final res = await ApiAuth.postJsonH(_url(AvaApi.appsConnect), {'slug': slug}, const {},
        timeout: const Duration(seconds: 30));
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    if (j['reason'] == 'premium_required') return const AppsActionResult.premium();
    final raw = j['oauthUrls'];
    String url = '';
    if (raw is Map && raw.isNotEmpty) url = raw.values.first.toString();
    return AppsActionResult(url: url);
  }

  /// Disconnect one app (premium).
  Future<AppsActionResult> disconnect(String slug) async {
    final res = await ApiAuth.postJsonH(_url(AvaApi.appsDisconnect), {'slug': slug}, const {},
        timeout: const Duration(seconds: 30));
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    if (j['reason'] == 'premium_required') return const AppsActionResult.premium();
    return AppsActionResult(removed: (j['removed'] as num?)?.toInt() ?? 0);
  }

  /// Short-lived cache for READ-style app results ("check my email", "my
  /// calendar") so a repeat within the TTL is instant instead of another ~90s
  /// round-trip. Mutating actions (send/create/schedule/…) are NEVER cached.
  final Map<String, _CachedResult> _cache = {};
  static const Duration _kCacheTtl = Duration(seconds: 60);

  /// Set by [run] when the server returns a `pending_action` (a send/delete that
  /// needs the user to confirm). The screen reads it right after `run` and, if
  /// non-null, shows a confirm card then calls [confirmSend]. Null on a normal
  /// answer. Only populated when the server flag `AVAAPPS_CONFIRM_SENDS` is on.
  Map<String, dynamic>? lastPendingAction;

  /// Execute a previously-confirmed pending action by its confirm token.
  Future<String> confirmSend(String token) async {
    try {
      final res = await ApiAuth.postJsonH(_url(AvaApi.appsRun), {'confirm_token': token}, const {},
          timeout: const Duration(seconds: 90));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      if (j['reason'] == 'confirm_expired') {
        return 'That confirmation expired — please ask again.';
      }
      return (j['answer'] ?? j['error'] ?? 'Done.').toString();
    } catch (e) {
      Analytics.appsUnavailable(endpoint: AvaApi.appsRun, code: e.runtimeType.toString());
      return 'Couldn\'t reach the app just now.';
    }
  }

  /// Public read-only classifier (mirrors the private [_isReadOnly]) so callers
  /// (e.g. the streaming path) can decide whether an answer is cacheable.
  static bool isReadOnly(String q) => _isReadOnly(q.trim().toLowerCase());

  /// Phase 5: fire-and-forget prefetch. Pings `/status?warm=1` so the Worker
  /// pre-warms the connection + tool-declaration KV caches for this user before
  /// the first query. Server-side rate-limited to 1/min; never blocks the UI.
  Future<void> warm() async {
    try {
      await ApiAuth.getSigned('${_url(AvaApi.appsStatus)}?warm=1', timeout: const Duration(seconds: 20));
    } catch (_) {/* best-effort */}
  }

  /// Phase 5: streaming run over SSE (`/run?stream=1`). [onStatus] fires for each
  /// step status line ("Checking Gmail…"); [onDelta] for each answer fragment.
  /// Returns the full answer and sets [lastPendingAction]. THROWS on any transport
  /// error so the caller can fall back to the non-streaming [run].
  Future<String> runStreaming(String query, {required void Function(String) onDelta, void Function(String)? onStatus}) async {
    lastPendingAction = null;
    final url = '${_url(AvaApi.appsRun)}?stream=1';
    final bytes = utf8.encode(jsonEncode({'query': query, 'source': 'screen'}));
    final headers = await ApiAuth.signedHeaders('POST', url, body: bytes, extra: const {});
    final client = http.Client();
    final buf = StringBuffer();
    try {
      final req = http.Request('POST', Uri.parse(url))
        ..headers.addAll(headers)
        ..bodyBytes = bytes;
      final resp = await client.send(req).timeout(const Duration(seconds: 90));
      // Quota (429) comes back as JSON, not SSE — return its friendly message
      // WITHOUT throwing, so we don't fall back and double-count the quota.
      if (resp.statusCode == 429) {
        final body = await resp.stream.bytesToString();
        try { return (jsonDecode(body)['error'] ?? 'Ava needs a breather — try again shortly.').toString(); }
        catch (_) { return 'Ava needs a breather — try again shortly.'; }
      }
      if (resp.statusCode != 200) throw Exception('stream http ${resp.statusCode}');
      final lines = resp.stream.transform(utf8.decoder).transform(const LineSplitter());
      String finalAnswer = '';
      await for (final line in lines) {
        final t = line.trim();
        if (!t.startsWith('data:')) continue;
        final payload = t.substring(5).trim();
        if (payload.isEmpty || payload == '[DONE]') continue;
        try {
          final j = jsonDecode(payload) as Map<String, dynamic>;
          final status = j['status'] as String?;
          if (status != null && status.isNotEmpty) onStatus?.call(status);
          final delta = j['delta'] as String?;
          if (delta != null && delta.isNotEmpty) { buf.write(delta); onDelta(delta); }
          if (j['done'] == true) {
            finalAnswer = (j['answer'] ?? buf.toString()).toString();
            lastPendingAction = (j['pending_action'] is Map)
                ? (j['pending_action'] as Map).cast<String, dynamic>()
                : null;
          }
        } catch (_) {/* skip a malformed SSE line */}
      }
      return finalAnswer.isNotEmpty ? finalAnswer : buf.toString();
    } finally {
      client.close();
    }
  }

  /// Run a natural-language action across the connected apps (premium). Returns Ava's reply.
  Future<String> run(String query) async {
    final key = query.trim().toLowerCase();
    final cacheable = _isReadOnly(key);
    if (cacheable) {
      final hit = _cache[key];
      if (hit != null && DateTime.now().isBefore(hit.expires)) {
        // ignore: unawaited_futures
        Analytics.capture('ava_tool_cache', {'hit': true});
        return hit.answer;
      }
    }
    final res = await ApiAuth.postJsonH(_url(AvaApi.appsRun), {'query': query}, const {},
        timeout: const Duration(seconds: 90));
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    // Phase 4: capture any pending confirm-before-send action for the caller.
    lastPendingAction = (j['pending_action'] is Map)
        ? (j['pending_action'] as Map).cast<String, dynamic>()
        : null;
    if (j['reason'] == 'premium_required') {
      return (j['message'] ?? 'Top up to use AvaApps.').toString();
    }
    if (j['answer'] != null) {
      final ans = j['answer'].toString();
      if (cacheable) {
        _cache[key] = _CachedResult(ans, DateTime.now().add(_kCacheTtl));
        if (_cache.length > 32) _evictOldest();
        // ignore: unawaited_futures
        Analytics.capture('ava_tool_cache', {'hit': false});
        // Phase 2: persist read-only answers so a repeat survives app restart
        // and can render instantly (stale-while-revalidate) next time (scoped).
        // ignore: unawaited_futures
        AvaAppsCache.writeRun(query, ans);
      }
      return ans;
    }
    return (j['error'] ?? 'Something went wrong running that.').toString();
  }

  /// Execute ONE Composio tool fired from a GenUI card (a `composio` action:
  /// Rename, Delete, Schedule a meeting…). Returns the short answer + any
  /// refreshed A2UI surface the server rendered from the result. This is a
  /// MUTATING action — never cached. The server re-validates the tool against
  /// the user's connected toolkits and coerces args to the tool schema.
  Future<GenuiActionResult> genuiAction(String tool, Map<String, dynamic> args, {String? request, String? gid}) async {
    final t0 = DateTime.now();
    try {
      final body = <String, dynamic>{
        'tool': tool, 'args': args,
        if (request != null) 'request': request,
        if (gid != null && gid.isNotEmpty) 'gid': gid,
      };
      final res = await ApiAuth.postJsonH(_url(AvaApi.genuiAction), body, const {},
          timeout: const Duration(seconds: 60));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final reqMs = DateTime.now().difference(t0).inMilliseconds;
      if (j['reason'] == 'premium_required') {
        Analytics.capture('genui_action_client', {'gid': gid ?? '', 'tool': tool, 'ok': false, 'reason': 'premium_required', 'request_ms': reqMs});
        return GenuiActionResult(ok: false, answer: (j['message'] ?? 'Top up to use this.').toString());
      }
      final ok = j['ok'] == true;
      final answer = (j['answer'] ?? j['error'] ?? (ok ? 'Done.' : 'That didn\'t go through.')).toString();
      final surface = j['a2ui'] is Map ? (j['a2ui'] as Map).cast<String, dynamic>() : null;
      // Round-trip latency + whether the server returned a refreshed surface —
      // pairs with the server `genui_action_exec` (same gid) to split network vs.
      // server time.
      Analytics.capture('genui_action_client', {
        'gid': (gid ?? j['gid'] ?? '').toString(), 'tool': tool, 'ok': ok,
        'rendered': surface != null, 'status': res.statusCode, 'request_ms': reqMs,
      });
      return GenuiActionResult(ok: ok, answer: answer, surface: surface);
    } catch (e) {
      Analytics.capture('genui_action_client', {'gid': gid ?? '', 'tool': tool, 'ok': false, 'error': e.runtimeType.toString(), 'request_ms': DateTime.now().difference(t0).inMilliseconds});
      Analytics.appsUnavailable(endpoint: AvaApi.genuiAction, code: e.runtimeType.toString());
      return GenuiActionResult(ok: false, answer: 'Couldn\'t reach the app just now.');
    }
  }

  /// Only cache reads. If the request looks like it CHANGES something, always
  /// hit the server so we never skip a real send/create/delete.
  static bool _isReadOnly(String q) {
    const mutating = [
      'send', 'create', 'schedule', 'reply', 'add ', 'delete', 'remove',
      'post', 'draft', 'update', 'move', 'cancel', 'forward', 'invite',
    ];
    return !mutating.any((m) => q.contains(m));
  }

  void _evictOldest() {
    String? oldestKey;
    DateTime? oldest;
    _cache.forEach((k, v) {
      if (oldest == null || v.expires.isBefore(oldest!)) {
        oldest = v.expires;
        oldestKey = k;
      }
    });
    if (oldestKey != null) _cache.remove(oldestKey);
  }
}

class _CachedResult {
  final String answer;
  final DateTime expires;
  const _CachedResult(this.answer, this.expires);
}

/// Result of a GenUI card action: the short answer + any refreshed A2UI surface.
class GenuiActionResult {
  final bool ok;
  final String answer;
  final Map<String, dynamic>? surface;
  const GenuiActionResult({required this.ok, required this.answer, this.surface});
}

/// One app in the Composio catalog grid.
class AvaCatalogApp {
  final String slug;
  final String name;
  final String logo;
  const AvaCatalogApp(this.slug, this.name, this.logo);
}

/// Result of a connect/disconnect attempt.
class AppsActionResult {
  final String url;     // OAuth URL to open (connect)
  final int removed;    // count removed (disconnect)
  final bool premium;   // true → free user, show top-up
  const AppsActionResult({this.url = '', this.removed = 0}) : premium = false;
  const AppsActionResult.premium() : url = '', removed = 0, premium = true;
}
