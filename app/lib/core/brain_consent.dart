import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'api_auth.dart';
import 'config.dart';

/// One-Brain B0 — the AvaBrain Settings toggle list is now GENERATED from the
/// server-owned domain registry (`GET /api/brain/domains`), never hard-coded.
///
/// Server contract:
///   { "domains": [
///       {"key":"calls","consentKey":"calls","label":"Call history",
///        "default":true,"scope":"account_private"}, ... ] }
///
/// One toggle is shown per unique `consentKey` (so `calls`+`missed` collapse to
/// one "Call history" switch, and `msg_meta`+`msg_content` collapse to one
/// messages switch). The label + default come from the registry; toggle writes
/// persist under the same `consentKey` the server ingestion pipeline reads.
class BrainDomain {
  final String key; // registry domain id, e.g. 'calls', 'missed', 'msg_meta'
  final String consentKey; // the consent boolean this domain gates on
  final String label; // human label from the registry
  final bool defaultOn; // opt-out default (spec: all true)
  final String scope; // 'account_private' | 'device_private'
  const BrainDomain(this.key, this.consentKey, this.label, this.defaultOn, this.scope);

  factory BrainDomain.fromJson(Map<String, dynamic> j) => BrainDomain(
        (j['key'] ?? '').toString(),
        (j['consentKey'] ?? j['consent'] ?? j['key'] ?? '').toString(),
        (j['label'] ?? '').toString(),
        j['default'] == null ? true : j['default'] == true,
        (j['scope'] ?? 'account_private').toString(),
      );

  Map<String, dynamic> toJson() => {
        'key': key,
        'consentKey': consentKey,
        'label': label,
        'default': defaultOn,
        'scope': scope,
      };
}

/// One rendered toggle row (deduped by [consentKey]).
class BrainToggle {
  final String consentKey;
  final String label;
  final bool defaultOn;
  final String description; // friendly UI subtitle (cosmetic; not from registry)
  const BrainToggle(this.consentKey, this.label, this.defaultOn, this.description);
}

/// Offline/first-run fallback — mirrors §3 of SPEC-2026-07-17-one-brain-final.md
/// EXACTLY. Used only until the first successful `GET /api/brain/domains`; the
/// server registry always wins once fetched. Keeps Settings renderable on the
/// very first launch with no network.
const List<BrainDomain> kBrainDomainFallback = <BrainDomain>[
  BrainDomain('contacts', 'contacts', 'Contacts', true, 'account_private'),
  BrainDomain('calls', 'calls', 'Call history', true, 'account_private'),
  BrainDomain('missed', 'calls', 'Call history', true, 'account_private'),
  BrainDomain('voicemail', 'voicemail', 'Voicemails', true, 'account_private'),
  BrainDomain('msg_meta', 'messages', 'Chat activity', true, 'account_private'),
  BrainDomain('msg_content', 'messages', 'Chat content', true, 'device_private'),
  BrainDomain('listings', 'listings', 'Marketplace', true, 'account_private'),
  BrainDomain('wallet', 'wallet', 'Wallet', true, 'account_private'),
  BrainDomain('files', 'files', 'Files', true, 'account_private'),
];

/// Cosmetic subtitles keyed by consentKey (registry gives label only). Any key
/// not listed falls back to a generic line.
const Map<String, String> _kConsentBlurb = <String, String>{
  'contacts': 'Remember who your contacts are so AvaChat can answer about them',
  'calls': 'Remember your calls and missed calls (who, when) — never the audio',
  'voicemail': 'Transcribe voicemails and voice notes so you can find them by what was said',
  'messages': 'Learn from your chats so AvaChat can answer "what did X say about…". '
      'Content is only ever read on your device.',
  'listings': 'Remember your marketplace listings, buys and sells',
  'wallet': 'Remember wallet activity (top-ups, purchases) — never card details',
  'files': 'Read your files (captions, text) so you can find them later',
};

/// Legacy consumer keys → registry consentKey. Pre-B0 call sites still read old
/// keys (e.g. `BrainConsent.isOn('messaging')`); this maps them onto the new
/// unified consent so those gates keep working without a per-call-site rewrite.
/// `askava` is intentionally NOT here — it gates on-device tool use, not a brain
/// ingestion domain, so it keeps its own (default-ON) key.
const Map<String, String> _kConsentAlias = <String, String>{
  'messaging': 'messages',
  'avatok_dms': 'messages',
  'avatok_messages': 'messages',
  'group_chats': 'messages',
  'voicemails': 'voicemail',
  'receptionist': 'voicemail',
  'avawallet': 'wallet',
  'avatok_files': 'files',
  'library': 'files',
  'marketplace': 'listings',
};

String _canonical(String key) => _kConsentAlias[key] ?? key;

/// Consent model: default ON when a capability has no stored value (opt-out).
/// Persisted per-account locally for instant reads, and mirrored to the server
/// (`/api/brain/consent`) so the ingestion pipeline can gate on it. Booleans are
/// non-sensitive, so the server stores them in the clear.
class BrainConsent {
  static const _s = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _key = 'brain_consent';
  static const _domainsKey = 'brain_domains_v1';

  // ── Registry (domain list) ────────────────────────────────────────────────

  /// Fetch the server registry and cache it per-account (scoped). Returns the
  /// parsed domains, or null on any failure (caller falls back to the cache).
  static Future<List<BrainDomain>?> refreshDomains() async {
    try {
      final r = await ApiAuth.getSigned(kBrainDomainsUrl);
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final raw = (j['domains'] as List?) ?? const [];
      final list = raw
          .whereType<Map>()
          .map((e) => BrainDomain.fromJson(e.cast<String, dynamic>()))
          .where((d) => d.key.isNotEmpty && d.consentKey.isNotEmpty)
          .toList();
      if (list.isEmpty) return null;
      try {
        await _s.write(
            key: scopedKey(_domainsKey),
            value: jsonEncode(list.map((d) => d.toJson()).toList()));
      } catch (_) {}
      return list;
    } catch (_) {
      return null; // offline — caller uses cache/fallback
    }
  }

  /// The cached registry for this account, or the spec fallback if none cached.
  static Future<List<BrainDomain>> domains() async {
    try {
      final raw = await _s.read(key: scopedKey(_domainsKey));
      if (raw != null && raw.isNotEmpty) {
        final list = (jsonDecode(raw) as List)
            .whereType<Map>()
            .map((e) => BrainDomain.fromJson(e.cast<String, dynamic>()))
            .where((d) => d.key.isNotEmpty && d.consentKey.isNotEmpty)
            .toList();
        if (list.isNotEmpty) return list;
      }
    } catch (_) {}
    return kBrainDomainFallback;
  }

  /// The deduped toggle rows (one per unique consentKey), in registry order.
  static Future<List<BrainToggle>> toggles() async {
    final ds = await domains();
    final seen = <String>{};
    final out = <BrainToggle>[];
    for (final d in ds) {
      if (!seen.add(d.consentKey)) continue; // first label/default per consentKey wins
      out.add(BrainToggle(
        d.consentKey,
        d.label.isEmpty ? d.consentKey : d.label,
        d.defaultOn,
        _kConsentBlurb[d.consentKey] ?? 'Let AvaBrain learn from this so it can help you later',
      ));
    }
    return out;
  }

  // ── Consent state ─────────────────────────────────────────────────────────

  /// Local map of explicit overrides (absent key = default ON).
  static Future<Map<String, bool>> _local() async {
    try {
      final raw = await _s.read(key: scopedKey(_key));
      if (raw == null || raw.isEmpty) return {};
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), v == true));
    } catch (_) {
      return {};
    }
  }

  /// Effective value for a consentKey: OFF if the consentKey itself is explicitly
  /// off, OR any legacy key that aliases onto it is explicitly off (so a pre-B0
  /// opt-out survives the key rename). Otherwise the stored value, else default.
  static bool _effective(Map<String, bool> m, String consentKey, {bool def = true}) {
    if (m[consentKey] == false) return false;
    for (final e in _kConsentAlias.entries) {
      if (e.value == consentKey && m[e.key] == false) return false;
    }
    return m[consentKey] ?? def;
  }

  /// Whether a capability is enabled. Default ON unless explicitly turned off.
  /// The master switch gates everything: if master is off, all are off. Accepts
  /// either a registry consentKey or a legacy consumer key (mapped internally).
  static Future<bool> isOn(String key) async {
    final ck = _canonical(key);
    final m = await _local();
    if (ck != 'master' && m['master'] == false) return false;
    return _effective(m, ck);
  }

  /// Read the current toggle state keyed by consentKey (for the Settings UI).
  static Future<Map<String, bool>> all() async {
    final m = await _local();
    final out = <String, bool>{'master': _effective(m, 'master')};
    for (final t in await toggles()) {
      out[t.consentKey] = _effective(m, t.consentKey, def: t.defaultOn);
    }
    return out;
  }

  /// Set a capability (registry consentKey, or 'master') and sync to the server.
  /// Best-effort on the network leg.
  static Future<void> set(String key, bool enabled) async {
    final ck = _canonical(key);
    final m = await _local();
    m[ck] = enabled;
    try {
      await _s.write(key: scopedKey(_key), value: jsonEncode(m));
    } catch (_) {}
    try {
      await ApiAuth.postJson(kBrainConsentUrl, {'capability': ck, 'enabled': enabled});
    } catch (_) {}
  }

  /// Pull the server's view on login and cache it locally (server is source of
  /// truth for cross-device consistency). Absent = default ON.
  static Future<void> pull() async {
    try {
      final r = await ApiAuth.getSigned(kBrainConsentUrl);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final c = ((j['consent'] as Map?) ?? const {})
          .map((k, v) => MapEntry(k.toString(), v == true));
      if (c.isNotEmpty) await _s.write(key: scopedKey(_key), value: jsonEncode(c));
    } catch (_) {/* offline — keep local */}
  }
}
