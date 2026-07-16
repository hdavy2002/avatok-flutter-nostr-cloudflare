import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
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
/// two-toggle "Voicemail" settings section — no more multi-step guided setup,
/// no spam toggle (not possible without the call-screening role, which AvaTOK
/// no longer requests).
///
///   • "Send missed calls to voicemail"   — ON dials `*61*<DID>#` (forward on
///     no-answer), OFF dials `##61#`.
///   • "Send declined calls to voicemail" — ON dials `*67*<DID>#` (forward on
///     busy/decline), OFF dials `##67#`.
///
/// Both dial through [AvaDialChannel.dialMmiCode] — USSD first, `ACTION_CALL`
/// fallback — never a raw dial the user has to watch and interpret.
///
/// Defaults ON: the first time this screen opens with no stored toggle state,
/// both toggles show ON immediately and the two enable codes are dialed once
/// in the background; a failure on either flips that toggle back OFF and shows
/// the carrier's raw response so the user knows what happened. Toggle state is
/// persisted per-account via [readScoped]/[scopedKey] (never a raw global key
/// — one phone can be shared by a parent + child accounts).
///
/// Visible only behind [RemoteConfig.pstnVoicemail]. Callers should gate on
/// the flag before navigating here; the screen also self-guards in [build] as
/// a second line of defense against a stale nav stack surviving a flag flip.
///
/// This screen only dials the carrier codes and reports what the carrier
/// said — it does NOT talk to the AvaTOK worker (consent recording, DID
/// assignment, `pstn_forwarding` state) — that is a different lane's
/// territory (worker/src/routes/pstn.ts, AVA-RCPT-2/4).
class PstnForwardingSetupScreen extends StatefulWidget {
  const PstnForwardingSetupScreen({super.key});

  @override
  State<PstnForwardingSetupScreen> createState() => _PstnForwardingSetupScreenState();
}

class _PstnForwardingSetupScreenState extends State<PstnForwardingSetupScreen> {
  static const String _did = kPstnVoicemailDid;

  // Per-account persisted toggle state. Base keys namespaced via [scopedKey]
  // in every read/write (see core/account_storage.dart — MANDATORY).
  static const String _missedKey = 'pstn_voicemail_missed_on';
  static const String _declinedKey = 'pstn_voicemail_declined_on';
  static final FlutterSecureStorage _sec = const FlutterSecureStorage();

  bool _loading = true;
  bool? _missedOn;   // null only transiently while loading
  bool? _declinedOn;
  bool _busyMissed = false;
  bool _busyDeclined = false;
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
    final storedMissed = await readScoped(_sec, _missedKey);
    final storedDeclined = await readScoped(_sec, _declinedKey);
    final firstOpen = storedMissed == null && storedDeclined == null;
    if (!mounted) return;
    if (firstOpen) {
      // Defaults ON — show both ON right away, then dial the enable codes once
      // in the background; a failure flips the affected toggle back OFF.
      setState(() {
        _missedOn = true;
        _declinedOn = true;
        _loading = false;
      });
      await _dialAndPersist(missed: true, wantOn: true, isInitialDefault: true);
      await _dialAndPersist(missed: false, wantOn: true, isInitialDefault: true);
      return;
    }
    setState(() {
      _missedOn = storedMissed == '1';
      _declinedOn = storedDeclined == '1';
      _loading = false;
    });
  }

  String _errorFor(Map<String, dynamic> res, String code) {
    final err = res['error'] as String?;
    if (err == 'no_permission') {
      return "AvaTOK needs call permission to dial $code — grant it, then try again.";
    }
    if (err == 'no_code') return 'Something went wrong preparing $code.';
    if (res['timeout'] == true) {
      return "$code didn't get a response from your carrier — check your signal and try again.";
    }
    return "Your carrier didn't accept $code — try again, or dial it yourself from the keypad.";
  }

  /// Dials the MMI code for [missed] (true = the `*61*`/`##61#` no-answer
  /// pair, false = the `*67*`/`##67#` busy/decline pair) toward [wantOn], then
  /// persists the toggle on success or reverts it on failure. Used both for
  /// user-driven toggles and the one-time initial-default dial.
  Future<void> _dialAndPersist({
    required bool missed,
    required bool wantOn,
    bool isInitialDefault = false,
  }) async {
    final key = missed ? _missedKey : _declinedKey;
    final code = wantOn
        ? (missed ? '*61*$_did#' : '*67*$_did#')
        : (missed ? '##61#' : '##67#');
    setState(() {
      if (missed) {
        _busyMissed = true;
      } else {
        _busyDeclined = true;
      }
      _lastError = null;
    });
    Analytics.capture('avadial_pstn_voicemail_toggle_tapped', {
      'kind': missed ? 'missed' : 'declined',
      'want_on': wantOn,
      'initial_default': isInitialDefault,
    });
    final res = await AvaDialChannel.I.dialMmiCode(code);
    if (!mounted) return;
    final ok = res['ok'] == true;
    setState(() {
      if (missed) {
        _busyMissed = false;
      } else {
        _busyDeclined = false;
      }
      if (ok) {
        _lastResponse = (res['response'] as String?)?.trim().isNotEmpty == true
            ? res['response'] as String
            : null;
        if (missed) {
          _missedOn = wantOn;
        } else {
          _declinedOn = wantOn;
        }
      } else {
        _lastError = _errorFor(res, code);
        // Revert — the toggle must always reflect reality, never an optimistic
        // guess of what the carrier did with the code we sent it.
        if (missed) {
          _missedOn = !wantOn;
        } else {
          _declinedOn = !wantOn;
        }
      }
    });
    Analytics.capture('avadial_pstn_voicemail_toggle_result', {
      'kind': missed ? 'missed' : 'declined',
      'want_on': wantOn,
      'ok': ok,
      'initial_default': isInitialDefault,
    });
    if (ok) {
      try { await _sec.write(key: scopedKey(key), value: wantOn ? '1' : '0'); } catch (_) {/* best-effort */}
    } else if (!isInitialDefault) {
      _toast(_lastError ?? "Couldn't reach your carrier.");
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
                          'send missed or declined calls to AvaTOK instead of ringing out — '
                          "you'll see them in your Inbox with a transcript.",
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
                      value: _missedOn ?? false,
                      busy: _busyMissed,
                      onChanged: _busyMissed
                          ? null
                          : (v) => _dialAndPersist(missed: true, wantOn: v),
                    ),
                    const Divider(height: 22, thickness: 1, color: AD.borderHairline),
                    _toggleRow(
                      title: 'Send declined calls to voicemail',
                      sub: 'You decline, or your line is busy',
                      value: _declinedOn ?? false,
                      busy: _busyDeclined,
                      onChanged: _busyDeclined
                          ? null
                          : (v) => _dialAndPersist(missed: false, wantOn: v),
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
                    'only affects calls you miss or decline.'),
                _bullet('Each toggle dials one short carrier code for you — no need to type '
                    'anything yourself.'),
              ],
            ),
    );
  }

  Widget _toggleRow({
    required String title,
    required String sub,
    required bool value,
    required bool busy,
    required ValueChanged<bool>? onChanged,
  }) {
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
        _VoicemailToggle(value: value, onChanged: onChanged),
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
              Text('Send missed and declined calls to your AvaTOK Inbox.',
                  style: ADText.preview()),
            ]),
          ),
          const Icon(Icons.chevron_right, color: AD.textSecondary),
        ]),
      ),
    );
  }
}
