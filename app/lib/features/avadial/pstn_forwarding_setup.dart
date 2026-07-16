import 'dart:io';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../shell/shell_v2.dart' show kPstnVoicemailDid;
import '../settings/settings_registry.dart';
import 'avadial_channel.dart';
import 'avadial_theme.dart';

/// [AVA-RCPT-7] "Setup voicemail forwarding" screen
/// (Specs/PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md, Phase 2). Plain
/// -language onboarding for carrier call-forwarding (CFB/CFNRy) to AvaTOK's
/// pool DID — the mechanism that lets a decline or a missed call reach Ava's
/// voicemail instead of the caller just hearing it ring out.
///
/// ENABLE dials `*67*<DID>#` (forward-on-busy/decline) then `*61*<DID>#`
/// (forward-on-no-answer) in sequence. DISABLE dials `##67#` then `##61#`.
/// STATUS dials `*#67#` and shows the raw carrier response text. All three
/// go through [AvaDialChannel.dialMmiCode] — USSD first, `ACTION_CALL`
/// fallback — never a raw dial the user has to watch and interpret.
///
/// Visible only behind [RemoteConfig.pstnVoicemail] (v1 ships voicemail-only,
/// dark by default — see the plan's rollout note). Callers should gate on the
/// flag before navigating here; the screen also self-guards in [build] as a
/// second line of defense against a stale nav stack surviving a flag flip.
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

  bool _busyEnable = false;
  bool _busyDisable = false;
  bool _busyStatus = false;
  String? _lastStatusResponse;
  String? _lastError;
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

  /// Dial [codes] one after another; stops at the first failure so the user
  /// gets an honest partial-result message rather than a silent second dial
  /// racing a carrier popup from the first.
  Future<bool> _dialSequence(List<String> codes) async {
    for (final code in codes) {
      final res = await AvaDialChannel.I.dialMmiCode(code);
      if (res['ok'] != true) {
        setState(() => _lastError = _errorFor(res, code));
        return false;
      }
    }
    return true;
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

  Future<void> _enable() async {
    if (_busyEnable) return;
    setState(() { _busyEnable = true; _lastError = null; });
    Analytics.capture('avadial_pstn_forwarding_enable_tapped');
    final ok = await _dialSequence(['*67*$_did#', '*61*$_did#']);
    if (!mounted) return;
    setState(() => _busyEnable = false);
    Analytics.capture('avadial_pstn_forwarding_enable_result', {'ok': ok});
    _toast(ok
        ? 'Forwarding turned on — missed and declined calls now reach your AvaTOK voicemail.'
        : (_lastError ?? "Couldn't turn on forwarding."));
  }

  Future<void> _disable() async {
    if (_busyDisable) return;
    setState(() { _busyDisable = true; _lastError = null; });
    Analytics.capture('avadial_pstn_forwarding_disable_tapped');
    final ok = await _dialSequence(['##67#', '##61#']);
    if (!mounted) return;
    setState(() => _busyDisable = false);
    Analytics.capture('avadial_pstn_forwarding_disable_result', {'ok': ok});
    _toast(ok
        ? 'Forwarding turned off — your carrier handles missed calls again.'
        : (_lastError ?? "Couldn't turn off forwarding."));
  }

  Future<void> _checkStatus() async {
    if (_busyStatus) return;
    setState(() { _busyStatus = true; _lastError = null; });
    Analytics.capture('avadial_pstn_forwarding_status_tapped');
    final res = await AvaDialChannel.I.dialMmiCode('*#67#');
    if (!mounted) return;
    setState(() {
      _busyStatus = false;
      if (res['ok'] == true) {
        _lastStatusResponse = (res['response'] as String?)?.trim().isNotEmpty == true
            ? res['response'] as String
            : 'Your carrier answered, but sent back no readable status text — check the '
                'dialer for a popup.';
      } else {
        _lastStatusResponse = null;
        _lastError = _errorFor(res, '*#67#');
      }
    });
    Analytics.capture('avadial_pstn_forwarding_status_result', {'ok': res['ok'] == true});
    if (res['ok'] != true) _toast(_lastError ?? "Couldn't check status.");
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
          title: Text('Voicemail forwarding', style: ZineText.appbar(color: AvaDialTheme.text)),
        ),
        body: const SizedBox.shrink(),
      );
    }
    final busy = _busyEnable || _busyDisable || _busyStatus;
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        title: Text('Voicemail forwarding', style: ZineText.appbar(color: AvaDialTheme.text)),
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
                  Text('When you decline or miss a call',
                      style: ZineText.cardTitle(size: 15.5, color: AvaDialTheme.text)),
                  const SizedBox(height: 4),
                  Text(
                    'Turning this on tells your carrier to send those calls to AvaTOK '
                    'instead of ringing out. The caller can leave a voicemail, and '
                    "you'll see it in your Inbox — with a transcript, so you don't "
                    'even have to listen to find out what it was about.',
                    style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft),
                  ),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 12),
          AdCard(
            color: AvaDialTheme.surface2,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Good to know', style: ZineText.cardTitle(size: 14, color: AvaDialTheme.text)),
              const SizedBox(height: 6),
              _bullet('This replaces your carrier\'s own voicemail — you can still turn it '
                  'off any time with the button below.'),
              _bullet('The call your caller ends up on is answered by AvaTOK\'s number, '
                  'not yours — some carriers bill that forwarded leg separately, same as '
                  'any call forward.'),
              _bullet('This only affects calls you decline or don\'t answer — every call '
                  'you pick up rings and connects exactly as it does today.'),
            ]),
          ),
          const SizedBox(height: 16),
          if (_simLoading)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text('Checking your SIM…',
                  style: ZineText.sub(size: 12.5, color: AvaDialTheme.textMute)),
            )
          else
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
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
          AdButton(
            label: _busyEnable ? 'Turning on…' : 'Enable',
            variant: AdButtonVariant.teal,
            trailingIcon: false,
            loading: _busyEnable,
            onPressed: busy ? null : _enable,
          ),
          const SizedBox(height: 10),
          AdButton(
            label: _busyDisable ? 'Turning off…' : 'Disable',
            variant: AdButtonVariant.ghost,
            trailingIcon: false,
            loading: _busyDisable,
            onPressed: busy ? null : _disable,
          ),
          const SizedBox(height: 10),
          AdButton(
            label: _busyStatus ? 'Checking…' : 'Check status',
            variant: AdButtonVariant.ghost,
            trailingIcon: false,
            loading: _busyStatus,
            onPressed: busy ? null : _checkStatus,
          ),
          if (_lastStatusResponse != null) ...[
            const SizedBox(height: 12),
            AdCard(
              color: AvaDialTheme.surface2,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Carrier says', style: ZineText.cardTitle(size: 13, color: AvaDialTheme.text)),
                const SizedBox(height: 4),
                Text(_lastStatusResponse!,
                    style: ZineText.sub(size: 12.5, color: AvaDialTheme.textSoft)),
              ]),
            ),
          ],
          if (_lastError != null) ...[
            const SizedBox(height: 12),
            Text(_lastError!, style: ZineText.sub(size: 12.5, color: AD.danger)),
          ],
          const SizedBox(height: 20),
          Text('HOW IT WORKS', style: ZineText.kicker(color: AvaDialTheme.textMute)),
          const SizedBox(height: 8),
          _bullet('Enable dials two short carrier codes for you, one after another — '
              'no need to type anything.'),
          _bullet('Disable reverses both, instantly.'),
          _bullet('Check status asks your carrier what\'s currently forwarded and shows '
              'you its raw reply.'),
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

/// [AVA-RCPT-7] Settings → "Voicemail forwarding" entry — a single tappable
/// row that opens [PstnForwardingSetupScreen], following the EXACT
/// registration pattern `registerDefaultDialerSection()` uses
/// (features/settings/sections/default_dialer_section.dart): a
/// [SettingsSectionRegistry.register] call, invoked once from
/// [AvaBootstrap.init]. This rides on the AvaDial telecom layer (CALL_PHONE /
/// USSD), so it stays hidden unless `avaDialer` is ALSO on, in addition to
/// this feature's own `pstnVoicemail` flag.
void registerPstnForwardingSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'pstn_forwarding',
      title: 'Voicemail forwarding',
      order: 27, // just below "Default phone & messages" (26)
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
              Text('Setup voicemail forwarding', style: ADText.rowName()),
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
