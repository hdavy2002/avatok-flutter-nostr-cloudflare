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
  final String? carrier;
  final String? mccmnc;
  final String? codesSource; // 'default' | 'override'
  final String? dialedCode;  // the actual code sent to the carrier
  const PstnDialResult({
    required this.ok,
    this.response,
    this.error,
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
  if (err == 'no_code') return 'Something went wrong preparing $code.';
  if (res['timeout'] == true) {
    return "$code didn't get a response from your carrier — check your signal and try again.";
  }
  return "Your carrier didn't accept $code — try again, or dial it yourself from the keypad.";
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
  // Caller may pass an already-resolved [PstnCarrierCodes] (e.g.
  // [pstnEnableAllForwarding] resolving once for all three dials); when
  // omitted this resolves (and caches) it itself.
  PstnCarrierCodes? codes,
}) async {
  final resolved = codes ?? await pstnResolveCarrierCodes();
  final template = wantOn ? resolved.enableTemplate(kind) : resolved.disableTemplate(kind);
  final code = wantOn ? template.replaceAll('{did}', did) : template;
  Analytics.capture('avadial_pstn_voicemail_toggle_tapped', {
    'kind': kind.analyticsKind,
    'want_on': wantOn,
    'initial_default': isInitialDefault,
  });
  final res = await AvaDialChannel.I.dialMmiCode(code);
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
    if (resolved.carrier != null) 'carrier': resolved.carrier!,
    if (resolved.mccmnc != null) 'mccmnc': resolved.mccmnc!,
  });
  if (ok) {
    try {
      await storage.write(key: scopedKey(kind.storageKey), value: wantOn ? '1' : '0');
    } catch (_) {/* best-effort */}
  }
  return PstnDialResult(
    ok: ok,
    response: response,
    error: error,
    carrier: resolved.carrier,
    mccmnc: resolved.mccmnc,
    codesSource: resolved.source,
    dialedCode: code,
  );
}

/// Dials all three enable codes (missed → declined → unreachable), in that
/// order, via [pstnDialAndPersist] — the sequential "turn everything on"
/// primitive used by the informed-consent intro screen
/// (pstn_forwarding_intro.dart) on first run / re-offer. Each code is dialed
/// even if an earlier one failed (a rejected `*67*` must not block `*61*`/
/// `*62*` from being tried); failed codes are simply left OFF by
/// [pstnDialAndPersist]. [onEach] fires after every code so the caller can
/// update a progress UI and its own analytics as it goes.
Future<List<PstnDialResult>> pstnEnableAllForwarding({
  required String did,
  required FlutterSecureStorage storage,
  void Function(PstnForwardKind kind, PstnDialResult result)? onEach,
}) async {
  // Resolve once for all three dials — [pstnDialAndPersist] would otherwise
  // resolve independently per call, but they'd share the same in-flight
  // future anyway via [pstnResolveCarrierCodes]'s cache; passing it
  // explicitly just avoids the redundant lookups being sequential.
  final codes = await pstnResolveCarrierCodes();
  final results = <PstnDialResult>[];
  for (final kind in const [
    PstnForwardKind.missed,
    PstnForwardKind.declined,
    PstnForwardKind.unreachable,
  ]) {
    final result = await pstnDialAndPersist(
      kind: kind,
      wantOn: true,
      did: did,
      storage: storage,
      isInitialDefault: true,
      codes: codes,
    );
    results.add(result);
    onEach?.call(kind, result);
  }
  return results;
}

class PstnForwardingSetupScreen extends StatefulWidget {
  const PstnForwardingSetupScreen({super.key});

  @override
  State<PstnForwardingSetupScreen> createState() => _PstnForwardingSetupScreenState();
}

class _PstnForwardingSetupScreenState extends State<PstnForwardingSetupScreen> {
  static const String _did = kPstnVoicemailDid;

  static final FlutterSecureStorage _sec = const FlutterSecureStorage();

  bool _loading = true;
  bool? _missedOn;   // null only transiently while loading
  bool? _declinedOn;
  bool? _unreachableOn;
  bool _busyMissed = false;
  bool _busyDeclined = false;
  bool _busyUnreachable = false;
  String? _lastResponse; // last raw carrier response shown to the user
  String? _lastError;
  String? _simLabel;
  bool _simLoading = true;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avadial', 'pstn_forwarding_setup');
    _loadSim();
    _init();
  }

  Future<void> _loadSim() async {
    final info = await AvaDialChannel.I.defaultVoiceSim();
    if (!mounted) return;
    setState(() {
      _simLabel = (info['sim'] as String?)?.trim();
      _simLoading = false;
    });
  }

  Future<void> _init() async {
    final storedMissed = await readScoped(_sec, PstnForwardKind.missed.storageKey);
    final storedDeclined = await readScoped(_sec, PstnForwardKind.declined.storageKey);
    final storedUnreachable = await readScoped(_sec, PstnForwardKind.unreachable.storageKey);
    final firstOpen = storedMissed == null && storedDeclined == null && storedUnreachable == null;
    if (!mounted) return;
    if (firstOpen) {
      // True first run — show all three ON right away, then dial the three
      // enable codes once in the background; a failure flips the affected
      // toggle back OFF.
      setState(() {
        _missedOn = true;
        _declinedOn = true;
        _unreachableOn = true;
        _loading = false;
      });
      await _dialAndPersist(PstnForwardKind.missed, wantOn: true, isInitialDefault: true);
      await _dialAndPersist(PstnForwardKind.declined, wantOn: true, isInitialDefault: true);
      await _dialAndPersist(PstnForwardKind.unreachable, wantOn: true, isInitialDefault: true);
      return;
    }
    setState(() {
      _missedOn = storedMissed == '1';
      _declinedOn = storedDeclined == '1';
      _unreachableOn = storedUnreachable == '1';
      _loading = false;
    });
    if (storedUnreachable == null) {
      // Existing user from before the third toggle shipped — default the new
      // condition ON too, and dial it once, same as a true first-run would
      // have for all three.
      setState(() => _unreachableOn = true);
      await _dialAndPersist(PstnForwardKind.unreachable, wantOn: true, isInitialDefault: true);
    }
  }

  bool _valueFor(PstnForwardKind kind) {
    switch (kind) {
      case PstnForwardKind.missed:
        return _missedOn ?? false;
      case PstnForwardKind.declined:
        return _declinedOn ?? false;
      case PstnForwardKind.unreachable:
        return _unreachableOn ?? false;
    }
  }

  bool _busyFor(PstnForwardKind kind) {
    switch (kind) {
      case PstnForwardKind.missed:
        return _busyMissed;
      case PstnForwardKind.declined:
        return _busyDeclined;
      case PstnForwardKind.unreachable:
        return _busyUnreachable;
    }
  }

  void _setBusy(PstnForwardKind kind, bool busy) {
    switch (kind) {
      case PstnForwardKind.missed:
        _busyMissed = busy;
        return;
      case PstnForwardKind.declined:
        _busyDeclined = busy;
        return;
      case PstnForwardKind.unreachable:
        _busyUnreachable = busy;
        return;
    }
  }

  void _setValue(PstnForwardKind kind, bool value) {
    switch (kind) {
      case PstnForwardKind.missed:
        _missedOn = value;
        return;
      case PstnForwardKind.declined:
        _declinedOn = value;
        return;
      case PstnForwardKind.unreachable:
        _unreachableOn = value;
        return;
    }
  }

  /// Dials [kind]'s MMI code toward [wantOn] via the shared
  /// [pstnDialAndPersist] helper, then updates this screen's own busy/value/
  /// error UI state from the result. Used both for user-driven toggles and
  /// the one-time initial-default dial.
  Future<void> _dialAndPersist(
    PstnForwardKind kind, {
    required bool wantOn,
    bool isInitialDefault = false,
  }) async {
    setState(() {
      _setBusy(kind, true);
      _lastError = null;
    });
    final result = await pstnDialAndPersist(
      kind: kind,
      wantOn: wantOn,
      did: _did,
      storage: _sec,
      isInitialDefault: isInitialDefault,
    );
    if (!mounted) return;
    setState(() {
      _setBusy(kind, false);
      if (result.ok) {
        _lastResponse = result.response;
        _setValue(kind, wantOn);
      } else {
        _lastError = result.error;
        // Revert — the toggle must always reflect reality, never an
        // optimistic guess of what the carrier did with the code we sent it.
        _setValue(kind, !wantOn);
      }
    });
    if (!result.ok && !isInitialDefault) {
      _toast(result.error ?? "Couldn't reach your carrier.");
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
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
        title: Text('Voicemail', style: ZineText.appbar(color: AvaDialTheme.text)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : ListView(
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
                          'calls your carrier hands it. Turning these on tells your carrier to '
                          'send missed, declined or unreachable calls to AvaTOK instead of '
                          "ringing out — you'll see them in your Inbox with a transcript.",
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
                AdCard(
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    _toggleRow(
                      title: 'Send missed calls to voicemail',
                      sub: "No answer within your carrier's ring window",
                      kind: PstnForwardKind.missed,
                    ),
                    const Divider(height: 22, thickness: 1, color: AD.borderHairline),
                    _toggleRow(
                      title: 'Send declined calls to voicemail',
                      sub: 'You decline, or your line is busy',
                      kind: PstnForwardKind.declined,
                    ),
                    const Divider(height: 22, thickness: 1, color: AD.borderHairline),
                    _toggleRow(
                      title: 'Send calls to voicemail when your phone is off or unreachable',
                      sub: 'No signal, airplane mode, or powered off',
                      kind: PstnForwardKind.unreachable,
                    ),
                  ]),
                ),
                if (_lastResponse != null) ...[
                  const SizedBox(height: 12),
                  AdCard(
                    color: AvaDialTheme.surface2,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Carrier says', style: ZineText.cardTitle(size: 13, color: AvaDialTheme.text)),
                      const SizedBox(height: 4),
                      Text(_lastResponse!,
                          style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft)),
                    ]),
                  ),
                ],
                if (_lastError != null) ...[
                  const SizedBox(height: 12),
                  Text(_lastError!, style: ZineText.sub(size: 12.5, color: AD.danger)),
                ],
                const SizedBox(height: 20),
                Text('WHAT THIS DOES NOT DO', style: ZineText.kicker(color: AvaDialTheme.textMute)),
                const SizedBox(height: 8),
                _bullet('No spam filtering here — that needs the call-screening role, which '
                    'AvaTOK no longer asks for.'),
                _bullet('Calls you answer ring and connect exactly as they do today — this '
                    'only affects calls you miss, decline, or can\'t receive.'),
                _bullet('Each toggle dials one short carrier code for you — no need to type '
                    'anything yourself.'),
              ],
            ),
    );
  }

  Widget _toggleRow({
    required String title,
    required String sub,
    required PstnForwardKind kind,
  }) {
    final busy = _busyFor(kind);
    return Row(children: [
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: ZineText.cardTitle(size: 14.5, color: AvaDialTheme.text)),
          const SizedBox(height: 3),
          Text(sub, style: ZineText.sub(size: 12, color: AvaDialTheme.textMute)),
        ]),
      ),
      const SizedBox(width: 10),
      if (busy)
        const SizedBox(
            width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))
      else
        _VoicemailToggle(
          value: _valueFor(kind),
          onChanged: (v) => _dialAndPersist(kind, wantOn: v),
        ),
    ]);
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

/// Dark v2 inline toggle — track [AD.card] off / [AD.online] on, white thumb.
/// Matches the style previously used by the retired default-dialer section
/// (features/settings/sections/default_dialer_section.dart) so Calls' dark
/// toggles stay visually consistent.
class _VoicemailToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _VoicemailToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 22, height: 22,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
          ),
        ),
      ),
    );
  }
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
