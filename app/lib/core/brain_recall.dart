/// brainRecall — the ONE unified recall API for One Brain (SPEC §6, phase B4).
///
/// This is the single client entry point the spec (§0/§6) calls out: "all memory
/// is answered through one API (`brainRecall`)". It merges the two lanes into one
/// ranked, scope-tagged list so every feature AI (ChatAVA, companion, the brain
/// AvaTool, briefing) experiences ONE brain:
///
///   • device lane   → [AvaLocalBrain.search] — `device_private` content that
///                     never leaves the phone except transiently under §6.
///   • server lane   → the Worker's `recall` op on `/api/brain/ops`
///                     (`account_private` hits: D1 + Vectorize, uid-scoped).
///
/// ── The recall→model boundary (§6, B-D6) ─────────────────────────────────────
/// A `device_private` snippet handed to a feature AI that then calls a CLOUD
/// model would leave the device transiently. That is governed HERE, so callers
/// can never forget it:
///
///   • Every hit is tagged with its [BrainHit.scope]. Feature AIs never see an
///     untagged blob.
///   • Pass `forCloud: true` whenever the hits will be assembled into a prompt
///     for a cloud model. When the per-account "Local-only answers" toggle is ON
///     (or the `cloudReasoningOverPrivate` remote kill-switch is OFF for
///     everyone), `device_private` hits are STRIPPED before they are returned —
///     the caller physically cannot include them.
///   • The FIRST time a `device_private` hit would actually go to the cloud on an
///     account (toggle OFF, kill-switch ON), a one-time, non-blocking disclosure
///     is signalled via [BrainPrivacyNotices] for the UI to surface (B-D6).
///
/// Per-account scoping (rulebook rule 1): the toggle and the one-time disclosure
/// flag are persisted under `scopedKey(...)`, and the device lane is per-account
/// by construction (`AvaLocalBrain`/`Db.I`). Nothing here is global.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'analytics.dart';
import 'api_auth.dart';
import 'brain_consent.dart';
import 'config.dart';
import 'local_brain/local_brain.dart';
import 'remote_config.dart';

/// One recall hit, from either lane, ALWAYS carrying its scope (§6).
class BrainHit {
  /// The recalled text (a snippet/excerpt, never a full document).
  final String text;

  /// The brain domain this came from ('calls', 'msg_content', 'files', …) or ''
  /// when the producer didn't tag one.
  final String domain;

  /// `account_private` (server-readable) | `device_private` (device-only, §2.1).
  final String scope;

  /// Merged relevance, normalised so higher = more relevant across both lanes.
  final double score;

  /// Event time (epoch ms) when known; 0 otherwise.
  final int ts;

  /// Which lane produced it ('server' | 'device').
  final String source;

  /// Device-lane grouping key ('1:<peer>' | 'g:<gid>' | '<domain>:<kind>') or
  /// the server conversation ref; '' when not applicable.
  final String convKey;

  /// The producer's stable id for the hit, when available.
  final String sourceId;

  const BrainHit({
    required this.text,
    required this.domain,
    required this.scope,
    required this.score,
    this.ts = 0,
    this.source = 'device',
    this.convKey = '',
    this.sourceId = '',
  });

  bool get isDevicePrivate => scope == 'device_private';

  BrainHit _withScore(double s) => BrainHit(
        text: text,
        domain: domain,
        scope: scope,
        score: s,
        ts: ts,
        source: source,
        convKey: convKey,
        sourceId: sourceId,
      );

  Map<String, dynamic> toJson() => {
        'text': text,
        'domain': domain,
        'scope': scope,
        'score': score,
        if (ts != 0) 'ts': ts,
        'source': source,
        if (convKey.isNotEmpty) 'conv': convKey,
        if (sourceId.isNotEmpty) 'ref': sourceId,
      };
}

/// Device-side brain domains — a `domains` filter that names ONLY these keeps the
/// device lane; one that names only account_private domains drops it as noise.
const Set<String> _kDeviceDomains = <String>{
  'msg_content', 'files', 'voicemail', 'notes', 'chat', 'avachat', 'device',
};

/// The unified recall (SPEC §6). Searches the device lane always, the server lane
/// when permitted, merges + ranks into one scope-tagged list.
///
///   • [domains]  — optional server-side domain filter (also drops the device
///                  lane when it names only `account_private` domains).
///   • [k]        — max hits returned.
///   • [forCloud] — set TRUE when the hits feed a CLOUD model prompt. Enables the
///                  §6/B-D6 device_private strip + first-run disclosure.
///   • [deviceOnly] — skip the server lane entirely (a private/on-device conv).
///   • [convKey]  — restrict the device lane to one conversation.
Future<List<BrainHit>> brainRecall(
  String query, {
  List<String>? domains,
  int k = 6,
  bool forCloud = false,
  bool deviceOnly = false,
  String? convKey,
}) async {
  final q = query.trim();
  if (q.isEmpty) return const [];

  // 1) Device lane — always runs (private content, offline-capable).
  final wantDevice = domains == null ||
      domains.isEmpty ||
      domains.any(_kDeviceDomains.contains);
  final localHits = <BrainHit>[];
  if (wantDevice) {
    try {
      final hits = await AvaLocalBrain.I.search(q, k: k, convKey: convKey);
      for (final h in hits) {
        final text = h.snippet.trim();
        if (text.isEmpty) continue;
        localHits.add(BrainHit(
          text: text,
          domain: _deviceDomain(h.convKey),
          scope: 'device_private',
          score: h.score,
          source: 'device',
          convKey: h.convKey,
          sourceId: h.sourceId,
        ));
      }
    } catch (_) {/* device lane best-effort */}
  }

  // 2) Server lane — only when allowed for this account and not device-only.
  final serverHits = <BrainHit>[];
  if (!deviceOnly && await _serverAllowed()) {
    try {
      serverHits.addAll(await _serverRecall(q, domains, k));
    } catch (_) {/* server lane best-effort; device already answered */}
  }

  // 3) Merge + rank into one list.
  var merged = _rank(serverHits, localHits, k);

  // 4) Cloud boundary (§6, B-D6): strip device_private for cloud prompts when the
  // toggle is on (or the remote kill-switch is off for everyone). Callers can't
  // forget — the strip is HERE, gated purely on `forCloud`.
  var stripped = 0;
  if (forCloud) {
    // Kill-switch OFF behaves like the toggle ON for everyone (§6 consent key).
    final killSwitchClosed = !RemoteConfig.cloudReasoningOverPrivate;
    final localOnly = killSwitchClosed || await LocalOnlyAnswers.isOn();
    if (localOnly) {
      final before = merged.length;
      merged = merged.where((h) => !h.isDevicePrivate).toList(growable: false);
      stripped = before - merged.length;
    } else if (merged.any((h) => h.isDevicePrivate)) {
      // A private snippet IS about to be sent to a cloud model → one-time notice.
      // ignore: unawaited_futures
      BrainPrivacyNotices.signalPrivateToCloud();
    }
  }

  // ignore: unawaited_futures
  Analytics.capture('brain_recall_used', {
    if (domains != null) 'domains': domains,
    'k': k,
    'local_hits': localHits.length,
    'server_hits': serverHits.length,
    'forCloud': forCloud,
    'stripped': stripped,
    if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
  });

  return merged;
}

/// Convenience: top hits as one grounding block for a cloud prompt. Always uses
/// `forCloud: true`, so the device_private strip + disclosure apply automatically.
Future<String> brainRecallContext(String query, {int k = 4}) async {
  final hits = await brainRecall(query, k: k, forCloud: true);
  if (hits.isEmpty) return '';
  return hits.map((h) => '• ${h.text}').join('\n');
}

String _deviceDomain(String convKey) {
  if (convKey.isEmpty) return 'device';
  if (convKey.startsWith('1:') || convKey.startsWith('g:')) return 'msg_content';
  final i = convKey.indexOf(':');
  return i > 0 ? convKey.substring(0, i) : convKey;
}

/// Server recall is gated on the master AvaBrain consent (a fetch failure or an
/// opted-out account returns nothing; the device lane still answers).
Future<bool> _serverAllowed() async {
  try {
    return await BrainConsent.isOn('master');
  } catch (_) {
    return false;
  }
}

/// Call the server `recall` op. Parses DEFENSIVELY: accepts `{hits:[…]}`,
/// `{results:[…]}`, `{recall:[…]}` or a bare list; tolerates missing fields.
/// The server never returns `device_private` (§2.1); any such value is coerced.
Future<List<BrainHit>> _serverRecall(String q, List<String>? domains, int k) async {
  final res = await ApiAuth.postJson(
    // Path-style op, matching delete_all/delete_status (server routes/brain.ts
    // switches on the /api/brain/<op> path segment — there is no /ops endpoint).
    '$kBrainBase/recall',
    {
      'query': q,
      'k': k,
      if (domains != null && domains.isNotEmpty) 'domains': domains,
    },
    timeout: const Duration(seconds: 12),
  );
  if (res.statusCode != 200) return const [];
  dynamic j;
  try {
    j = jsonDecode(res.body);
  } catch (_) {
    return const [];
  }
  List raw;
  if (j is List) {
    raw = j;
  } else if (j is Map) {
    raw = (j['hits'] ?? j['results'] ?? j['recall'] ?? const []) as List? ?? const [];
  } else {
    return const [];
  }
  final out = <BrainHit>[];
  for (final e in raw) {
    if (e is! Map) continue;
    final text = (e['text'] ?? e['snippet'] ?? e['content'] ?? '').toString().trim();
    if (text.isEmpty) continue;
    final scope = (e['scope'] ?? 'account_private').toString();
    out.add(BrainHit(
      text: text,
      domain: (e['domain'] ?? '').toString(),
      // The server MUST NOT ship device_private content; coerce if it ever does.
      scope: scope == 'device_private' ? 'account_private' : scope,
      score: (e['score'] as num?)?.toDouble() ?? 0,
      ts: (e['ts'] as num?)?.toInt() ?? 0,
      source: 'server',
      convKey: (e['conv'] ?? e['convKey'] ?? '').toString(),
      sourceId: (e['ref'] ?? e['id'] ?? '').toString(),
    ));
  }
  return out;
}

/// Merge two lanes whose raw scores are on different scales. We normalise EACH
/// lane to 0..1 by rank order, then merge, de-dup by text, and take the top [k].
List<BrainHit> _rank(List<BrainHit> serverHits, List<BrainHit> localHits, int k) {
  List<BrainHit> norm(List<BrainHit> hits) {
    final sorted = [...hits]..sort((a, b) => b.score.compareTo(a.score));
    final n = sorted.length;
    return [
      for (var i = 0; i < n; i++) sorted[i]._withScore((n - i) / n),
    ];
  }

  final merged = <BrainHit>[...norm(serverHits), ...norm(localHits)];
  merged.sort((a, b) => b.score.compareTo(a.score));

  final seen = <String>{};
  final out = <BrainHit>[];
  for (final h in merged) {
    final key = h.text.toLowerCase();
    if (!seen.add(key)) continue; // identical text from either lane → keep first
    out.add(h);
    if (out.length >= k) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// "Local-only answers" toggle (B-D6 / §6). Per-account, DEFAULT OFF (cloud
// reasoning allowed — owner decision 2026-07-18). When ON, brainRecall strips
// device_private hits from any `forCloud` recall (device search still works).
// ─────────────────────────────────────────────────────────────────────────────

class LocalOnlyAnswers {
  LocalOnlyAnswers._();

  static const _s = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _key = 'brain_local_only_answers';

  /// Live value for the Settings UI; updated on [set].
  static final ValueNotifier<bool> value = ValueNotifier<bool>(false);

  /// Whether local-only answers is ON for the active account (default OFF).
  static Future<bool> isOn() async {
    try {
      final raw = await _s.read(key: scopedKey(_key));
      final on = raw == '1';
      value.value = on;
      return on;
    } catch (_) {
      return false;
    }
  }

  /// Persist the toggle (scoped) and emit telemetry.
  static Future<void> set(bool on) async {
    value.value = on;
    try {
      await _s.write(key: scopedKey(_key), value: on ? '1' : '0');
    } catch (_) {}
    // ignore: unawaited_futures
    Analytics.capture('local_only_toggled', {
      'value': on,
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// First-run disclosure (B-D6). The first time a device_private snippet would be
// sent to a cloud model on an account, surface a one-time, NON-BLOCKING notice.
// Decoupled from core: brainRecall only SIGNALS; the UI listens to [pending] and
// calls [markShown] once it has displayed it (so a late-mounting listener still
// catches it, and we never mark it shown without actually showing it).
// ─────────────────────────────────────────────────────────────────────────────

class BrainPrivacyNotices {
  BrainPrivacyNotices._();

  static const _s = FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _shownKey = 'brain_private_cloud_disclosure_shown';

  /// The exact copy for the notice (B-D6).
  static const String disclosureText =
      'Ava may send small excerpts of on-device content to the cloud to answer — '
      'no retention. You can turn this off.';

  /// TRUE while a disclosure is waiting to be shown. A UI host listens and clears
  /// it via [markShown] after displaying. A ValueNotifier (not a one-shot stream)
  /// so a listener mounted AFTER the signal still sees the pending notice.
  static final ValueNotifier<bool> pending = ValueNotifier<bool>(false);

  static bool _resolved = false; // in-memory cache of "already shown this account"

  /// Called by brainRecall on the forCloud private-hit path. If this account has
  /// never seen the notice, raises [pending]. Idempotent + cheap.
  static Future<void> signalPrivateToCloud() async {
    if (_resolved || pending.value) return;
    try {
      final raw = await _s.read(key: scopedKey(_shownKey));
      if (raw == '1') {
        _resolved = true;
        return;
      }
    } catch (_) {/* if storage is unreadable, err toward showing it once */}
    pending.value = true;
  }

  /// The UI calls this once it has surfaced the notice: persist per-account,
  /// clear [pending], emit telemetry. Safe to call more than once.
  static Future<void> markShown() async {
    if (!pending.value && _resolved) return;
    _resolved = true;
    pending.value = false;
    try {
      await _s.write(key: scopedKey(_shownKey), value: '1');
    } catch (_) {}
    // ignore: unawaited_futures
    Analytics.capture('private_cloud_disclosure_shown', {
      if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
    });
  }

  /// Reset the in-memory cache on account switch so the next account re-resolves
  /// its own scoped flag (the persisted key is already scoped).
  static void onAccountSwitched() {
    _resolved = false;
    pending.value = false;
  }
}
