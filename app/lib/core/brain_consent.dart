import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'api_auth.dart';
import 'config.dart';

/// One AvaBrain consent capability shown in the main Settings. Apps register
/// their guardrail toggles here so they all live in one place (Golden Rule 15).
class BrainCapability {
  final String key; // e.g. 'master', 'avatok_files', 'avatok_dms'
  final String title;
  final String subtitle;
  final bool master;
  const BrainCapability(this.key, this.title, this.subtitle, {this.master = false});
}

/// The registry of AvaBrain toggles surfaced in the main app Settings. All
/// default ON (opt-out model) EXCEPT private/E2E reading, which is opt-IN.
const kBrainCapabilities = <BrainCapability>[
  BrainCapability('master', 'AvaBrain', 'Let AvaBrain learn from your activity to help you across apps', master: true),
  // Phase 9 — per-app guardrails the ingestion pipeline obeys (server-checked).
  BrainCapability('avatok_messages', 'AvaTok messages', 'Index your 1:1 messages so AvaChat can answer "what did X say about…"'),
  BrainCapability('group_chats', 'Group chats', 'Index messages from your group conversations'),
  BrainCapability('voicemails', 'Voice mails & voice notes', 'Transcribe your voice notes so you can find them by what was said'),
  BrainCapability('files', 'Files & images', 'Read your public files (captions, text) so you can find them later'),
  BrainCapability('avawallet', 'AvaWallet', 'Remember wallet activity (top-ups, purchases) — never card details'),
  BrainCapability('avacalendar', 'AvaCalendar & bookings', 'Remember your bookings and events so AvaChat knows your schedule'),
  // Pre-Phase-9 keys (kept for compatibility with already-stored rows).
  BrainCapability('avatok_files', 'Keep a tab on my files', 'AvaBrain can read your public AvaTok files (captions, text) so you can find them later'),
  BrainCapability('avatok_dms', 'Read my AvaTok DMs', 'On-device only — AvaBrain summarises chats without your messages ever leaving your phone'),
];

/// Consent model: default ON when a capability has no stored value (opt-out).
/// Persisted per-account locally for instant reads, and mirrored to the server
/// (`/api/brain/consent`) so the ingestion pipeline can gate on it. Booleans are
/// non-sensitive, so the server stores them in the clear.
class BrainConsent {
  static const _s = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _key = 'brain_consent';

  /// Local map of explicit overrides (absent key = default ON).
  static Future<Map<String, bool>> _local() async {
    try {
      final raw = await _s.read(key: scopedKey(_key));
      if (raw == null || raw.isEmpty) return {};
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), v == true));
    } catch (_) { return {}; }
  }

  /// Whether a capability is enabled. Default ON unless explicitly turned off.
  /// The master switch gates everything: if master is off, all are off.
  static Future<bool> isOn(String key) async {
    final m = await _local();
    if (key != 'master' && m['master'] == false) return false;
    return m[key] ?? true; // absent = default ON
  }

  /// Read all capabilities as a map (for the Settings UI).
  static Future<Map<String, bool>> all() async {
    final m = await _local();
    final out = <String, bool>{};
    for (final c in kBrainCapabilities) out[c.key] = m[c.key] ?? true;
    return out;
  }

  /// Set a capability and sync to the server. Best-effort on the network leg.
  static Future<void> set(String key, bool enabled) async {
    final m = await _local();
    m[key] = enabled;
    try { await _s.write(key: scopedKey(_key), value: jsonEncode(m)); } catch (_) {}
    try { await ApiAuth.postJson(kBrainConsentUrl, {'capability': key, 'enabled': enabled}); } catch (_) {}
  }

  /// Pull the server's view on login and cache it locally (server is source of
  /// truth for cross-device consistency). Absent = default ON.
  static Future<void> pull() async {
    try {
      final r = await ApiAuth.getSigned(kBrainConsentUrl);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final c = ((j['consent'] as Map?) ?? const {}).map((k, v) => MapEntry(k.toString(), v == true));
      if (c.isNotEmpty) await _s.write(key: scopedKey(_key), value: jsonEncode(c));
    } catch (_) {/* offline — keep local */}
  }
}
