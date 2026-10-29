import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../api_client.dart';
import '../api_exception.dart';
import '../models/page.dart';

/// [HF-PAGES-1] The policy pages (Terms, Privacy, Refunds...) shown inside the app.
///
/// `GET /api/hf/pages/:slug` is public (no sign-in needed), so a signed-out person can read the Terms too. The last answer for each
/// page is kept on the phone (shared_preferences, key `hfpage1|<slug>`) so the page opens at once and reads offline. These are public
/// texts, not account data, so the copy is not wiped at sign-out.
///
/// No ETag round trip: the API client turns a 304 into an error and reports it as a failed call. The answer is small and the server
/// caches it for 60 s, so the page is simply fetched again and the stored copy is replaced when the version moved.
class PagesRepo {
  const PagesRepo(this._api);

  final ApiClient _api;

  static String _key(String slug) => 'hfpage1|$slug';

  /// The stored copy of [slug], or null when the page was never loaded (or the stored text cannot be read).
  Future<PolicyPage?> cached(String slug) async {
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_key(slug));
      if (raw == null || raw.isEmpty) return null;
      final j = jsonDecode(raw);
      if (j is! Map) return null;
      final page = PolicyPage.fromJson(Map<String, dynamic>.from(j));
      return page.blocks.isEmpty ? null : page;
    } catch (_) {
      return null;
    }
  }

  /// Asks the server and stores the answer. Throws `ApiException` (offline, 404 `not_found`...).
  Future<PolicyPage> fetch(String slug) async {
    final j = await _api.getJson('/api/hf/pages/${Uri.encodeComponent(slug)}', auth: false);
    final page = PolicyPage.fromJson(j);
    if (page.blocks.isEmpty) throw ApiException.parse(200);
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_key(slug), jsonEncode(j));
    } catch (_) {
      // not being able to keep a copy never hides the page
    }
    return page;
  }
}
