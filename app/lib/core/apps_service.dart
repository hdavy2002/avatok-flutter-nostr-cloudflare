import 'dart:convert';

import 'package:flutter/material.dart';

import 'analytics.dart';
import 'api_auth.dart';
import 'ava_ai_store.dart';
import 'ava_contracts.dart';
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

  /// Which toolkit slugs the user has connected (OAuth complete).
  Future<Set<String>> status() async {
    try {
      final res = await ApiAuth.getSigned(_url(AvaApi.appsStatus), timeout: const Duration(seconds: 20));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (j['connected'] as List?)?.map((e) => e.toString().toLowerCase()) ?? const [];
      return list.toSet();
    } catch (_) {
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
    } catch (_) {
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
      }
      return ans;
    }
    return (j['error'] ?? 'Something went wrong running that.').toString();
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
