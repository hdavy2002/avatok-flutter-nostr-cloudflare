import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/config.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../shell/shell_v2.dart' show kPstnVoicemailDid;
import '../settings/settings_registry.dart';
import 'avadial_channel.dart';
import 'avadial_theme.dart';
import 'pstn_forwarding_wizard.dart';

/// [AVA-RCPT-7] → REPLACED 2026-07-16 (owner decision, PLAN-2026-07-16
/// receptionist/guardian doc): AvaTOK will never be the Android default
/// dialer/SMS app going forward (spam can't be filtered well enough as a
/// default handler), so carrier conditional call forwarding to Vobiz's
/// voicemail line is now the ONLY voicemail path. This screen is a simple
/// three-toggle "Voicemail" settings section — no more multi-step guided
/// setup, no spam toggle (not possible without the call-screening role,
/// which AvaTOK no longer requests).
///
/// [AVA-RCPT-CONSENT-1] EXTENDED same day (owner decision): carrier voicemail
/// forwarding is now ON BY DEFAULT for every user, surfaced via an
/// informed-consent screen rather than buried here — see
/// pstn_forwarding_intro.dart. This screen stays the ongoing Settings surface
/// (toggle any of the three off/on any time) and now also owns the SHARED
/// dial+persist logic ([pstnDialAndPersist] et al. below) that the intro
/// screen reuses — do not duplicate that logic anywhere else.
///
///   • "Send missed calls to voicemail"   — ON dials `*61*<DID>#` (forward on
///     no-answer), OFF dials `##61#`.
///   • "Send declined calls to voicemail" — ON dials `*67*<DID>#` (forward on
///     busy/decline), OFF dials `##67#`.
///   • "Send calls to voicemail when your phone is off or unreachable" — ON
///     dials `*62*<DID>#` (forward on unreachable), OFF dials `##62#`.
///
/// All three dial through [AvaDialChannel.dialMmiCode] — USSD first,
/// `ACTION_CALL` fallback — never a raw dial the user has to watch and
/// interpret.
///
/// [AVA-RCPT-VERIFY-1] REPLACED AGAIN 2026-07-17 (owner decision, after the
/// rgoa/Airtel incident): the three optimistic toggles are gone. This screen
/// now embeds [PstnForwardingWizard] — sequential per-condition buttons where
/// a row only turns green after the CARRIER's status query (`*#61#` etc.)
/// confirms forwarding is registered to our DID. This file still owns the
/// shared dial/verify/persist primitives below, which the wizard drives.
///
/// Defaults ON: the first time this screen (or the intro screen) opens with
/// no stored toggle state, all three toggles show ON immediately and the
/// three enable codes are dialed once in the background; a failure on any
/// one flips that toggle back OFF and shows the carrier's raw response so the
/// user knows what happened. An existing user who already had the first two
/// toggles set (from before the third toggle shipped) gets the new
/// "unreachable" toggle defaulted ON and dialed once on next open, same as a
/// true first-run. Toggle state is persisted per-account via
/// [readScoped]/[scopedKey] (never a raw global key — one phone can be shared
/// by a parent + child accounts).
///
/// Visible only behind [RemoteConfig.pstnVoicemail]. Callers should gate on
/// the flag before navigating here; the screen also self-guards in [build] as
/// a second line of defense against a stale nav stack surviving a flag flip.
///
/// This screen only dials the carrier codes and reports what the carrier
/// said — it does NOT talk to the AvaTOK worker (consent recording, DID
/// assignment, `pstn_forwarding` state) — that is a different lane's
/// territory (worker/src/routes/pstn.ts, AVA-RCPT-2/4).

/// The three carrier-forwarding conditions AvaTOK offers. Shared by
/// [PstnForwardingSetupScreen] (one toggle at a time) and the informed-consent
/// intro screen (pstn_forwarding_intro.dart, all three sequentially).
enum PstnForwardKind { missed, declined, unreachable }

extension PstnForwardKindX on PstnForwardKind {
  /// Per-account storage base key (namespaced via [scopedKey] by every
  /// reader/writer — never read/written raw).
  String get storageKey {
    switch (this) {
      case PstnForwardKind.missed:
        return 'pstn_voicemail_missed_on';
      case PstnForwardKind.declined:
        return 'pstn_voicemail_declined_on';
      case PstnForwardKind.unreachable:
        return 'pstn_voicemail_unreachable_on';
    }
  }

  /// Analytics `kind` value — unchanged for missed/declined so existing
  /// dashboards keep working; unreachable is new.
  String get analyticsKind {
    switch (this) {
      case PstnForwardKind.missed:
        return 'missed';
      case PstnForwardKind.declined:
        return 'declined';
      case PstnForwardKind.unreachable:
        return 'unreachable';
    }
  }

  String enableCode(String did) {
    switch (this) {
      case PstnForwardKind.missed:
        return '*61*$did#';
      case PstnForwardKind.declined:
        return '*67*$did#';
      case PstnForwardKind.unreachable:
        return '*62*$did#';
    }
  }

  String get disableCode {
    switch (this) {
      case PstnForwardKind.missed:
        return '##61#';
      case PstnForwardKind.declined:
        return '##67#';
      case PstnForwardKind.unreachable:
        return '##62#';
    }
  }
}

/// [server-driven carrier codes] Per-carrier MMI code templates, resolved
/// from GET `$kApiBase/pstn/carrier-codes` (worker/src/routes/pstn.ts) with
/// [PstnCarrierCodes.defaults] as the ALWAYS-AVAILABLE fallback — those
/// defaults are byte-for-byte the GSM-standard literals this engine hardcoded
/// before this feature existed, so an unreachable endpoint, a timeout, a bad
/// response, or a device with no resolvable SIM operator all degrade to
/// EXACTLY today's behavior. `{did}` in an `*_enable` template is substituted
/// with [kPstnVoicemailDid] at dial time; disable/status templates take no
/// substitution. `cfb` = call-forward-busy (declined/busy), `cfnry` =
/// call-forward-no-reply (missed), `cfnrc` = call-forward-not-reachable
/// (unreachable) — GSM 3GPP TS 22.004 condition names.
class PstnCarrierCodes {
  final String cfbEnable;
  final String cfnryEnable;
  final String cfnrcEnable;
  final String cfbDisable;
  final String cfnryDisable;
  final String cfnrcDisable;
  final String cfbStatus;
  final String cfnryStatus;
  final String cfnrcStatus;
  /// `'default'` (server had no matching override, or the lookup failed
  /// locally) or `'override'` (a KV `pstn_carrier_codes` entry matched this
  /// device's mccmnc) — carried into analytics as `codes_source`.
  final String source;
  final String? mccmnc;
  final String? carrier;

  const PstnCarrierCodes({
    required this.cfbEnable,
    required this.cfnryEnable,
    required this.cfnrcEnable,
    required this.cfbDisable,
    required this.cfnryDisable,
    required this.cfnrcDisable,
    required this.cfbStatus,
    required this.cfnryStatus,
    required this.cfnrcStatus,
    required this.source,
    this.mccmnc,
    this.carrier,
  });

  /// The exact GSM-standard literals [PstnForwardKindX.enableCode]/
  /// [PstnForwardKindX.disableCode] hardcoded before this feature existed.
  /// This is the fallback at EVERY layer — server unreachable, malformed
  /// response, missing SIM info, whatever.
  static const PstnCarrierCodes defaults = PstnCarrierCodes(
    cfbEnable: '*67*{did}#',
    cfnryEnable: '*61*{did}#',
    cfnrcEnable: '*62*{did}#',
    cfbDisable: '##67#',
    cfnryDisable: '##61#',
    cfnrcDisable: '##62#',
    cfbStatus: '*#67#',
    cfnryStatus: '*#61#',
    cfnrcStatus: '*#62#',
    source: 'default',
  );

  PstnCarrierCodes copyWith({String? mccmnc, String? carrier}) => PstnCarrierCodes(
        cfbEnable: cfbEnable,
        cfnryEnable: cfnryEnable,
        cfnrcEnable: cfnrcEnable,
        cfbDisable: cfbDisable,
        cfnryDisable: cfnryDisable,
        cfnrcDisable: cfnrcDisable,
        cfbStatus: cfbStatus,
        cfnryStatus: cfnryStatus,
        cfnrcStatus: cfnrcStatus,
        source: source,
        mccmnc: mccmnc ?? this.mccmnc,
        carrier: carrier ?? this.carrier,
      );

  String enableTemplate(PstnForwardKind kind) {
    switch (kind) {
      case PstnForwardKind.missed:
        return cfnryEnable;
      case PstnForwardKind.declined:
        return cfbEnable;
      case PstnForwardKind.unreachable:
        return cfnrcEnable;
    }
  }

  String disableTemplate(PstnForwardKind kind) {
    switch (kind) {
      case PstnForwardKind.missed:
        return cfnryDisable;
      case PstnForwardKind.declined:
        return cfbDisable;
      case PstnForwardKind.unreachable:
        return cfnrcDisable;
    }
  }

  String statusTemplate(PstnForwardKind kind) {
    switch (kind) {
      case PstnForwardKind.missed:
        return cfnryStatus;
      case PstnForwardKind.declined:
        return cfbStatus;
      case PstnForwardKind.unreachable:
        return cfnrcStatus;
    }
  }
}

/// In-memory cache for the lifetime of the app process — the SIM/carrier
/// can't change without a restart in any case AvaTOK cares about, so there is
/// no reason to re-hit the network on every toggle. [_carrierCodesInFlight]
/// coalesces concurrent callers (e.g. [pstnEnableAllForwarding]'s three
/// sequential dials) onto one request instead of firing three.
PstnCarrierCodes? _cachedCarrierCodes;
Future<PstnCarrierCodes>? _carrierCodesInFlight;

/// Resolve this device's per-carrier MMI code templates from the server.
/// Null-tolerant end to end: [AvaDialChannel.simOperatorCode] returning an
/// empty/partial map, no network, a slow carrier, a non-2xx response, or
/// malformed JSON all fall back to [PstnCarrierCodes.defaults] — the SAME
/// literals this engine dialed before this feature existed. Existing users
/// mid-flow must be unaffected by this endpoint's existence, so failure here
/// is never surfaced as an error to the caller.
Future<PstnCarrierCodes> pstnResolveCarrierCodes() {
  final cached = _cachedCarrierCodes;
  if (cached != null) return Future.value(cached);
  final inFlight = _carrierCodesInFlight;
  if (inFlight != null) return inFlight;
  final fut = _resolveCarrierCodesUncached().then((v) {
    _cachedCarrierCodes = v;
    _carrierCodesInFlight = null;
    return v;
  });
  _carrierCodesInFlight = fut;
  return fut;
}

Future<PstnCarrierCodes> _resolveCarrierCodesUncached() async {
  String? mccmnc;
  String? carrier;
  try {
    final sim = await AvaDialChannel.I.simOperatorCode();
    mccmnc = (sim['mccmnc'] as String?)?.trim();
    if (mccmnc != null && mccmnc.isEmpty) mccmnc = null;
    carrier = (sim['name'] as String?)?.trim();
    if (carrier != null && carrier.isEmpty) carrier = null;
  } catch (_) {/* sim lookup is best-effort — proceed with nulls */}

  try {
    final params = <String, String>{
      if (mccmnc != null) 'mccmnc': mccmnc,
      if (carrier != null) 'carrier': carrier,
    };
    final uri = Uri.parse('$kApiBase/pstn/carrier-codes')
        .replace(queryParameters: params.isEmpty ? null : params);
    final res = await http.get(uri).timeout(const Duration(seconds: 3));
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return PstnCarrierCodes.defaults.copyWith(mccmnc: mccmnc, carrier: carrier);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map) {
      return PstnCarrierCodes.defaults.copyWith(mccmnc: mccmnc, carrier: carrier);
    }
    final body = decoded;
    final codes = body['codes'];
    if (codes is! Map) {
      return PstnCarrierCodes.defaults.copyWith(mccmnc: mccmnc, carrier: carrier);
    }
    String pick(String key, String fallback) {
      final v = codes[key];
      return (v is String && v.trim().isNotEmpty) ? v : fallback;
    }

    return PstnCarrierCodes(
      cfbEnable: pick('cfb_enable', PstnCarrierCodes.defaults.cfbEnable),
      cfnryEnable: pick('cfnry_enable', PstnCarrierCodes.defaults.cfnryEnable),
      cfnrcEnable: pick('cfnrc_enable', PstnCarrierCodes.defaults.cfnrcEnable),
      cfbDisable: pick('cfb_disable', PstnCarrierCodes.defaults.cfbDisable),
      cfnryDisable: pick('cfnry_disable', PstnCarrierCodes.defaults.cfnryDisable),
      cfnrcDisable: pick('cfnrc_disable', PstnCarrierCodes.defaults.cfnrcDisable),
      cfbStatus: pick('cfb_status', PstnCarrierCodes.defaults.cfbStatus),
      cfnryStatus: pick('cfnry_status', PstnCarrierCodes.defaults.cfnryStatus),
      cfnrcStatus: pick('cfnrc_status', PstnCarrierCodes.defaults.cfnrcStatus),
      source: body['source'] == 'override' ? 'override' : 'default',
      mccmnc: mccmnc,
      carrier: carrier,
    );
  } catch (_) {
    // ANY failure — offline, timeout, malformed JSON, unexpected shape — is
    // the exact GSM-standard defaults this engine has always dialed.
    return PstnCarrierCodes.defaults.copyWith(mccmnc: mccmnc, carrier: carrier);
  }
}

/// Result of dialing one enable/disable MMI code — shared shape so both call
/// sites (settings screen, intro screen) render the same carrier-response /
/// error text, and now also carry the carrier-matrix analytics fields
/// ([carrier], [mccmnc], [codesSource], [dialedCode]) so callers can enrich
/// their own analytics events without re-deriving them.
class PstnDialResult {
  final bool ok;
  final String? response; // raw carrier response text, when present
  final String? error;    // user-facing error text, when !ok
  /// Machine-readable failure kind when !ok: 'no_permission' | 'no_code' |
  /// 'ussd_unavailable' | null. The wizard branches on this —
  /// 'ussd_unavailable' means "silent path impossible, ask the user before
  /// any visible dial" ([AVA-RCPT-SILENT-1]).
  final String? errorKind;
  final String? carrier;
  final String? mccmnc;
  final String? codesSource; // 'default' | 'override'
  final String? dialedCode;  // the actual code sent to the carrier
  const PstnDialResult({
    required this.ok,
    this.response,
    this.error,
    this.errorKind,
    this.carrier,
    this.mccmnc,
    this.codesSource,
    this.dialedCode,
  });
}

/// User-facing text for a failed [AvaDialChannel.dialMmiCode] call. Shared by
/// both call sites so the wording never drifts between them.
String pstnErrorFor(Map<String, dynamic> res, String code) {
  final err = res['error'] as String?;
  if (err == 'no_permission') {
    return 'AvaTOK needs call permission to dial $code — grant it, then try again.';
  }
  if (err == 'ussd_unavailable') {
    return "Your phone didn't let AvaTOK send $code in the background.";
  }
  if (err == 'no_code') return 'Something went wrong preparing $code.';
  if (res['timeout'] == true) {
    return "$code didn't get a response from your carrier — check your signal and try again.";
  }
  return "Your carrier didn't accept $code — try again, or dial it yourself from the keypad.";
}

// ── [AVA-RCPT-VERIFY-1] Carrier-confirmed verification (2026-07-17) ─────────
// Lesson from the rgoa/Airtel incident: an enable dial that "succeeds" (or
// fails) tells us almost nothing across thousands of global carriers. The only
// ground truth is the carrier's own STATUS query (`*#61#`/`*#67#`/`*#62#`,
// GSM 3GPP TS 22.004 — or a per-carrier override from /pstn/carrier-codes).
// When forwarding is registered, the status response carries the forwarding
// NUMBER — and digit-matching our DID inside it is language-agnostic, so it
// works no matter how the carrier words the reply. A toggle is now persisted
// ON only after this check confirms it.

/// Outcome of one carrier status query for one forwarding condition.
class PstnVerifyResult {
  /// True when the carrier answered the status code at all. False = we could
  /// not check (USSD unavailable/failed/timeout) — NOT the same as "off".
  final bool checked;
  /// Meaningful only when [checked]: carrier's response contains our DID.
  final bool verified;
  final String? response; // raw carrier response text, when present
  final String? via;      // 'ussd' | 'call_intent'
  final String? dialedCode;
  const PstnVerifyResult({
    required this.checked,
    required this.verified,
    this.response,
    this.via,
    this.dialedCode,
  });
}

/// Digits-only projection for language-agnostic number matching.
String _digitsOf(String s) => s.replaceAll(RegExp(r'[^0-9]'), '');

/// Does [response] name [did] as the forwarding target? Compares digits only
/// and accepts a suffix match on the last 8 digits, so `+91 22 7126 4209`,
/// `02271264209` and `912271264209` all match regardless of carrier
/// formatting, spacing, or 0/+91 prefixing.
bool pstnResponseNamesDid(String response, String did) {
  final respDigits = _digitsOf(response);
  final didDigits = _digitsOf(did);
  if (didDigits.length < 6 || respDigits.isEmpty) return false;
  final tail = didDigits.length > 8 ? didDigits.substring(didDigits.length - 8) : didDigits;
  return respDigits.contains(tail);
}

/// Ask the CARRIER whether [kind]'s forwarding is registered to [did] — dials
/// the status MMI code silently over USSD and digit-matches the response.
/// Never throws. `checked=false` when the carrier gave us no text to inspect
/// (e.g. the ACTION_CALL fallback fired — its response renders in the phone
/// app, outside our reach).
Future<PstnVerifyResult> pstnVerifyForwarding({
  required PstnForwardKind kind,
  required String did,
  PstnCarrierCodes? codes,
}) async {
  final resolved = codes ?? await pstnResolveCarrierCodes();
  final statusCode = resolved.statusTemplate(kind);
  // [AVA-RCPT-SILENT-1] Status queries are ALWAYS silent — a `*#61#` popping
  // up in the phone app unannounced reads as a hack attempt, not a check.
  final res = await AvaDialChannel.I.dialMmiCode(statusCode, allowFallback: false);
  final via = res['via'] as String?;
  final response = (res['response'] as String?)?.trim();
  final gotText = res['ok'] == true && via == 'ussd' && (response?.isNotEmpty ?? false);
  final verified = gotText && pstnResponseNamesDid(response!, did);
  Analytics.capture('pstn_forward_verify_result', {
    'kind': kind.analyticsKind,
    'checked': gotText,
    'verified': verified,
    'via': via ?? 'none',
    'code': statusCode,
    'codes_source': resolved.source,
    if (resolved.carrier != null) 'carrier': resolved.carrier!,
    if (resolved.mccmnc != null) 'mccmnc': resolved.mccmnc!,
    if (res['ussd_failure_code'] != null) 'ussd_failure_code': res['ussd_failure_code'],
    if (res['timeout'] == true) 'timeout': true,
  });
  return PstnVerifyResult(
    checked: gotText,
    verified: verified,
    response: response,
    via: via,
    dialedCode: statusCode,
  );
}

/// Mark [kind] carrier-confirmed ON (or off) in per-account storage. The
/// wizard calls this ONLY after [pstnVerifyForwarding] returns verified —
/// nothing else may write these keys optimistically.
Future<void> pstnPersistVerified({
  required PstnForwardKind kind,
  required bool on,
  required FlutterSecureStorage storage,
}) async {
  try {
    await storage.write(key: scopedKey(kind.storageKey), value: on ? '1' : '0');
  } catch (_) {/* best-effort */}
}

/// Dials [kind]'s MMI code toward [wantOn] against [did] and persists the
/// resulting toggle state per-account on success (never on failure — the
/// stored value must always reflect what the carrier actually confirmed).
/// Fires the same `avadial_pstn_voicemail_toggle_tapped`/`_result` analytics
/// pair the settings screen has always fired, tagged with [kind] and
/// [isInitialDefault].
///
/// THE shared enable/disable primitive — [PstnForwardingSetupScreen] and the
/// informed-consent intro screen (pstn_forwarding_intro.dart) both call this
/// instead of dialing+persisting independently. Do not duplicate this logic.
Future<PstnDialResult> pstnDialAndPersist({
  required PstnForwardKind kind,
  required bool wantOn,
  required String did,
  required FlutterSecureStorage storage,
  bool isInitialDefault = false,
  // Caller may pass an already-resolved [PstnCarrierCodes]; when omitted this
  // resolves (and caches) it itself.
  PstnCarrierCodes? codes,
  // [AVA-RCPT-SILENT-1] false (default) = fully invisible: silent USSD or a
  // not-ok result — NEVER the phone app. The wizard first tries silent, and
  // only re-dials with true after showing the user its reassurance card.
  bool allowFallback = false,
}) async {
  final resolved = codes ?? await pstnResolveCarrierCodes();
  final template = wantOn ? resolved.enableTemplate(kind) : resolved.disableTemplate(kind);
  final code = wantOn ? template.replaceAll('{did}', did) : template;
  Analytics.capture('avadial_pstn_voicemail_toggle_tapped', {
    'kind': kind.analyticsKind,
    'want_on': wantOn,
    'initial_default': isInitialDefault,
  });
  // [AVA-RCPT-VERIFY-1] Await the ACTUAL permission grant before dialing.
  // Previously dialMmiCode fired the permission dialog and instantly returned
  // no_permission — all three codes "failed" in ~150ms and the user walked
  // away believing voicemail was on (rgoa/Airtel, 2026-07-17).
  final hasPermission = await AvaDialChannel.I.ensureCallPermission();
  if (!hasPermission) {
    Analytics.capture('avadial_pstn_voicemail_toggle_result', {
      'kind': kind.analyticsKind,
      'want_on': wantOn,
      'ok': false,
      'error_kind': 'no_permission',
      'initial_default': isInitialDefault,
      'codes_source': resolved.source,
      'code': code,
      if (resolved.carrier != null) 'carrier': resolved.carrier!,
      if (resolved.mccmnc != null) 'mccmnc': resolved.mccmnc!,
    });
    return PstnDialResult(
      ok: false,
      error: 'AvaTOK needs the Phone permission to set up voicemail — '
          'allow it and try again.',
      errorKind: 'no_permission',
      carrier: resolved.carrier,
      mccmnc: resolved.mccmnc,
      codesSource: resolved.source,
      dialedCode: code,
    );
  }
  final res = await AvaDialChannel.I.dialMmiCode(code, allowFallback: allowFallback);
  final ok = res['ok'] == true;
  final response = ok
      ? ((res['response'] as String?)?.trim().isNotEmpty == true
          ? res['response'] as String
          : null)
      : null;
  final error = ok ? null : pstnErrorFor(res, code);
  Analytics.capture('avadial_pstn_voicemail_toggle_result', {
    'kind': kind.analyticsKind,
    'want_on': wantOn,
    'ok': ok,
    'initial_default': isInitialDefault,
    'codes_source': resolved.source,
    'code': code,
    // [AVA-RCPT-VERIFY-1] carry the FULL failure shape — the 2026-07-17
    // incident was undiagnosable remotely because only `ok` was captured.
    'via': (res['via'] as String?) ?? 'none',
    if (res['error'] != null) 'error_kind': res['error'],
    if (res['ussd_failure_code'] != null) 'ussd_failure_code': res['ussd_failure_code'],
    if (res['timeout'] == true) 'timeout': true,
    if (resolved.carrier != null) 'carrier': resolved.carrier!,
    if (resolved.mccmnc != null) 'mccmnc': resolved.mccmnc!,
  });
  // [AVA-RCPT-VERIFY-1] A dial's "ok" is no longer trusted as proof that
  // forwarding is ON — only [pstnVerifyForwarding] (carrier status query) may
  // set a toggle to '1', via [pstnPersistVerified]. Turning OFF still persists
  // here on an accepted disable dial (worst case: forwarding stays off-ish and
  // the wizard re-verifies next open — never the reverse lie).
  if (ok && !wantOn) {
    await pstnPersistVerified(kind: kind, on: false, storage: storage);
  }
  return PstnDialResult(
    ok: ok,
    response: response,
    error: error,
    errorKind: ok ? null : res['error'] as String?,
    carrier: resolved.carrier,
    mccmnc: resolved.mccmnc,
    codesSource: resolved.source,
    dialedCode: code,
  );
}

// [AVA-RCPT-VERIFY-1] `pstnEnableAllForwarding` (dial all three codes blind,
// no carrier confirmation) is DELETED — that optimistic sequence is exactly
// what stranded rgoa with voicemail "on" that the carrier never registered.
// The only enable path is now the sequential dial-and-verify wizard
// (pstn_forwarding_wizard.dart).

class PstnForwardingSetupScreen extends StatefulWidget {
  const PstnForwardingSetupScreen({super.key});

  @override
  State<PstnForwardingSetupScreen> createState() => _PstnForwardingSetupScreenState();
}

class _PstnForwardingSetupScreenState extends State<PstnForwardingSetupScreen> {
  static const String _did = kPstnVoicemailDid;

  // [AVA-RCPT-CONSENT-2 2026-07-17] `encryptedSharedPreferences: true` —
  // matches pstn_forwarding_intro.dart's storage instances (and
  // [IdentityStore]'s long-standing choice) for the same reason: the default
  // (legacy) Android mode was observed via PostHog to lose a confirmed toggle
  // value across a real process restart with no corruption/account-switch
  // event to explain it. All readers/writers of these `pstn_voicemail_*_on`
  // keys must use this option so a value written by one screen is reliably
  // readable by the other.
  static final FlutterSecureStorage _sec = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  String? _simLabel;
  bool _simLoading = true;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avadial', 'pstn_forwarding_setup');
    _loadSim();
  }

  Future<void> _loadSim() async {
    final info = await AvaDialChannel.I.defaultVoiceSim();
    if (!mounted) return;
    setState(() {
      _simLabel = (info['sim'] as String?)?.trim();
      _simLoading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    // Second line of defense — see class doc. Callers should already gate the
    // navigation on this flag; this just keeps a stale nav-stack entry inert
    // if the flag flips off mid-session.
    if (!RemoteConfig.pstnVoicemail) {
      return Scaffold(
        backgroundColor: AvaDialTheme.bg,
        appBar: AppBar(
          backgroundColor: AvaDialTheme.surface,
          leading: const AdBackButton(),
          iconTheme: const IconThemeData(color: AvaDialTheme.text),
          title: Text('Voicemail', style: ZineText.appbar(color: AvaDialTheme.text)),
        ),
        body: const SizedBox.shrink(),
      );
    }
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        // [AVA-VM-BACK-1] Do NOT rely on AppBar's implicit leading: it renders
        // with the ambient IconTheme, which on this dark surface came out a
        // near-invisible brown (owner report 2026-07-17). Explicit + themed.
        leading: const AdBackButton(),
        iconTheme: const IconThemeData(color: AvaDialTheme.text),
        title: Text('Voicemail', style: ZineText.appbar(color: AvaDialTheme.text)),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          AdCard(
            color: AD.card,
            child: Row(children: [
              ZineIconBadge(
                  icon: PhosphorIcons.voicemail(PhosphorIconsStyle.bold), color: AD.iconVideo),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Voicemail via your carrier',
                      style: ZineText.cardTitle(size: 15.5, color: AvaDialTheme.text)),
                  const SizedBox(height: 4),
                  Text(
                    'AvaTOK is no longer your phone or SMS app, so it can only pick up '
                    'calls your carrier hands it. Each step below tells your carrier to '
                    'send missed, declined or unreachable calls to AvaTOK instead of '
                    "ringing out — you'll see them in your Inbox with a transcript. "
                    'A step only turns green once your carrier confirms it.',
                    style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft),
                  ),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 12),
          if (_simLoading)
            Padding(
              padding: const EdgeInsets.only(bottom: 4, left: 4),
              child: Text('Checking your SIM…',
                  style: ZineText.sub(size: 12.5, color: AvaDialTheme.textMute)),
            )
          else
            Padding(
              padding: const EdgeInsets.only(bottom: 4, left: 4),
              child: Row(children: [
                Icon(PhosphorIcons.deviceMobile(PhosphorIconsStyle.bold),
                    size: 16, color: AvaDialTheme.textMute),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    (_simLabel == null || _simLabel!.isEmpty)
                        ? 'Using your default calling SIM'
                        : 'Using $_simLabel for these codes',
                    style: ZineText.sub(size: 12.5, color: AvaDialTheme.textMute),
                  ),
                ),
              ]),
            ),
          const SizedBox(height: 8),
          // [AVA-RCPT-VERIFY-1] The dial-and-verify wizard replaces the old
          // optimistic toggles — same widget the consent intro embeds, with
          // the Settings-only "Turn off" affordance on verified rows.
          PstnForwardingWizard(did: _did, storage: _sec, showTurnOff: true),
          const SizedBox(height: 20),
          Text('WHAT THIS DOES NOT DO', style: ZineText.kicker(color: AvaDialTheme.textMute)),
          const SizedBox(height: 8),
          _bullet('No spam filtering here — that needs the call-screening role, which '
              'AvaTOK no longer asks for.'),
          _bullet('Calls you answer ring and connect exactly as they do today — this '
              'only affects calls you miss, decline, or can\'t receive.'),
          _bullet('Each step dials one short carrier code for you and then asks your '
              'carrier to confirm — if your phone app opens, just come back here.'),
        ],
      ),
    );
  }

  Widget _bullet(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(top: 5, right: 8),
            child: Container(
              width: 4, height: 4,
              decoration: const BoxDecoration(color: AvaDialTheme.textMute, shape: BoxShape.circle),
            ),
          ),
          Expanded(
            child: Text(text, style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft)),
          ),
        ]),
      );
}

/// [AVA-RCPT-7] Settings → "Voicemail" entry — a single tappable row that
/// opens [PstnForwardingSetupScreen]. Registration hook name
/// (`registerPstnForwardingSection`) and section id (`pstn_forwarding`) are
/// UNCHANGED from the original multi-step guided-setup version — only the
/// title and the screen behind it changed (2026-07-16 default-dialer
/// retirement, see class doc above). This rides on the AvaDial telecom layer
/// (CALL_PHONE / USSD), so it stays hidden unless `avaDialer` is ALSO on, in
/// addition to this feature's own `pstnVoicemail` flag.
void registerPstnForwardingSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'pstn_forwarding',
      title: 'Voicemail',
      order: 26, // AVA-DIAL-6's "Default phone & messages" (26) is retired —
      // Voicemail takes its slot in the settings order.
      visible: () =>
          Platform.isAndroid && RemoteConfig.avaDialer && RemoteConfig.pstnVoicemail,
      builder: (context) => const _PstnForwardingRow(),
    ),
  );
}

class _PstnForwardingRow extends StatelessWidget {
  const _PstnForwardingRow();

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        Analytics.capture('settings_pstn_forwarding_opened');
        Navigator.of(context).push(MaterialPageRoute<void>(
            builder: (_) => const PstnForwardingSetupScreen()));
      },
      behavior: HitTestBehavior.opaque,
      child: AdCard(
        padding: const EdgeInsets.all(14),
        child: Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.voicemail(PhosphorIconsStyle.fill),
              color: AD.iconVideo,
              size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Voicemail', style: ADText.rowName()),
              const SizedBox(height: 2),
              Text('Send missed, declined and unreachable calls to your AvaTOK Inbox.',
                  style: ADText.preview()),
            ]),
          ),
          const Icon(Icons.chevron_right, color: AD.textSecondary),
        ]),
      ),
    );
  }
}
