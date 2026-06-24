// moderation_service.dart — client for POST /api/moderate (Nemotron content
// safety via OpenRouter, server-side). Used to gate Save buttons: the UI asks
// "is this text OK?" and disables Save / shows a reason when it isn't.
//
// IMPORTANT: this is a UX gate only. The Worker ALSO re-checks every field on the
// write route (Specs §4.2), so a failure here fails OPEN (allow) — we never block
// the user because the moderation endpoint was unreachable; the server enforces.
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'config.dart';
import 'api_auth.dart';

/// Field types the server understands (must match worker ModField).
class ModField {
  static const name = 'name';
  static const handle = 'handle';
  static const personaName = 'persona_name';
  static const bio = 'bio';
  static const persona = 'persona';
  static const prompt = 'prompt';
  static const listingTitle = 'listing_title';
  static const listingDesc = 'listing_desc';
  static const greeting = 'greeting';
  static const status = 'status';
  static const message = 'message';
  static const generic = 'generic';
}

class ModerationResult {
  final bool allow;
  final String reason;
  final List<String> categories;
  const ModerationResult(this.allow, this.reason, this.categories);
  static const ok = ModerationResult(true, '', <String>[]);
}

class ModerationService {
  static final String _url = 'https://$kSignalingHost/api/moderate';

  // Per-session cache so identical text isn't re-checked (the model is free but
  // this avoids latency + needless calls while the user edits around a value).
  static final Map<String, ModerationResult> _cache = <String, ModerationResult>{};

  /// Check [text] for [fieldType]. Returns [ModerationResult.ok] on any error
  /// (fail open — the server is the real gate).
  static Future<ModerationResult> check(String text, String fieldType, {String? locale}) async {
    final t = text.trim();
    if (t.isEmpty) return ModerationResult.ok;
    final key = '$fieldType|$t';
    final cached = _cache[key];
    if (cached != null) return cached;
    try {
      final http.Response r = await ApiAuth.postJson(_url, {
        'text': t,
        'field_type': fieldType,
        if (locale != null) 'locale': locale,
      });
      if (r.statusCode != 200) return ModerationResult.ok;
      final m = jsonDecode(r.body) as Map<String, dynamic>;
      final res = ModerationResult(
        (m['verdict'] ?? 'allow') == 'allow',
        (m['reason'] ?? '').toString(),
        ((m['categories'] as List?)?.map((e) => e.toString()).toList()) ?? const <String>[],
      );
      _cache[key] = res;
      return res;
    } catch (_) {
      return ModerationResult.ok; // fail open; server enforces
    }
  }
}
