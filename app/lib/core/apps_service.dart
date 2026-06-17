import 'dart:convert';

import 'package:flutter/material.dart';

import 'api_auth.dart';
import 'ava_ai_store.dart';
import 'ava_contracts.dart';
import 'config.dart';

/// One AvaApp tile (Klavis MCP server). [server] is the Klavis server name used
/// for OAuth status keys; [name]/[icon]/[color] drive the UI.
class AvaApp {
  final String server; // Klavis server name, e.g. 'Gmail', 'Google Calendar'
  final String name;
  final IconData icon;
  final Color color;
  const AvaApp(this.server, this.name, this.icon, this.color);
}

/// The free Google set bundled into every user's Strata server (server side).
const List<AvaApp> kFreeAvaApps = [
  AvaApp('Gmail', 'Gmail', Icons.mail_outline, Color(0xFFEA4335)),
  AvaApp('Google Calendar', 'Google Calendar', Icons.event, Color(0xFF4285F4)),
  AvaApp('Google Drive', 'Google Drive', Icons.folder_open, Color(0xFF1FA463)),
  AvaApp('Google Docs', 'Google Docs', Icons.description_outlined, Color(0xFF4285F4)),
  AvaApp('Google Sheets', 'Google Sheets', Icons.grid_on, Color(0xFF0F9D58)),
  AvaApp('Google Forms', 'Google Forms', Icons.assignment_outlined, Color(0xFF7248B9)),
  AvaApp('Google Jobs', 'Google Jobs', Icons.work_outline, Color(0xFF34A853)),
  AvaApp('Google Cloud', 'Google Cloud', Icons.cloud_outlined, Color(0xFF4285F4)),
];

/// Result of a connect call: per-app OAuth URLs the user must open to authorize.
class AppsConnectResult {
  final String? strataServerUrl;
  final Map<String, String> oauthUrls; // serverName → OAuth URL
  const AppsConnectResult(this.strataServerUrl, this.oauthUrls);
}

/// Talks to the Worker's AvaApps routes. The Worker holds the Klavis key; the
/// client only forwards the user's own Gemini key (for the model) per request.
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

  /// Whether AI (Gemini key) is connected — AvaApps needs it for the model.
  Future<bool> aiConnected() => _ai.isConnected();

  /// Create/reuse the Strata server and get the OAuth URLs to open.
  Future<AppsConnectResult> connect() async {
    final res = await ApiAuth.postJsonH(_url(AvaApi.appsConnect), const {}, await _keyHeader(),
        timeout: const Duration(seconds: 30));
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final urls = <String, String>{};
    final raw = j['oauthUrls'];
    if (raw is Map) {
      raw.forEach((k, v) => urls[k.toString()] = v.toString());
    }
    return AppsConnectResult(j['strataServerUrl']?.toString(), urls);
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
