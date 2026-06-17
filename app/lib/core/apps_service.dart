import 'dart:convert';

import 'package:flutter/material.dart';

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

  /// Start OAuth for any not-yet-connected Google app; returns slug → OAuth URL.
  Future<Map<String, String>> connect() async {
    final res = await ApiAuth.postJsonH(_url(AvaApi.appsConnect), const {}, await _keyHeader(),
        timeout: const Duration(seconds: 30));
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final urls = <String, String>{};
    final raw = j['oauthUrls'];
    if (raw is Map) raw.forEach((k, v) => urls[k.toString()] = v.toString());
    return urls;
  }

  /// Run a natural-language action across the connected apps. Returns Ava's reply.
  Future<String> run(String query) async {
    final headers = await _keyHeader();
    if (headers.isEmpty) return 'Connect Google AI Studio in Settings first.';
    final res = await ApiAuth.postJsonH(_url(AvaApi.appsRun), {'query': query}, headers,
        timeout: const Duration(seconds: 90));
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    if (j['answer'] != null) return j['answer'].toString();
    return (j['error'] ?? 'Something went wrong running that.').toString();
  }
}
