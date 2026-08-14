// [PA-UI-2] "Phone calls" — Ava as your PA on your SIM (cell / PSTN) number.
//
// One of the two lane screens of the approved receptionist redesign. The hub
// (receptionist_section.dart, [PA-UI-1]) pushes this screen; this screen owns:
//
//   • the three "when should Ava answer?" scenario toggles for the PSTN lane
//     (recept_pstn_rejected / recept_pstn_not_picked_up / recept_pstn_unreachable),
//   • the ADVANCED "send every call to Ava" toggle (recept_pstn_redirect_all),
//   • and — the part that makes the lane actually work — CARRIER-SETUP
//     AWARENESS: a PSTN toggle only does anything if the carrier is forwarding
//     that condition to AvaTOK's voicemail DID. The confirmation state for each
//     condition lives in the per-account `pstn_voicemail_*_on` keys written by
//     the dial-and-verify wizard (pstn_forwarding_setup.dart /
//     pstn_forwarding_wizard.dart). When a toggle is ON but its carrier
//     condition is unconfirmed, we say so and offer "Fix it", which opens the
//     existing [PstnForwardingSetupScreen] (the wizard's Settings host).
//
// Toggles SAVE IMMEDIATELY. The receptionist PUT overwrites every column, so
// each flip re-sends the FULL settings payload loaded in initState with exactly
// one field changed; a failed save reverts the switch and says so.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/account_storage.dart';
import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/receptionist_api.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../avadial/pstn_forwarding_setup.dart';

/// Inline dark v2 header band — same pattern as receptionist_rules_screen.dart's
/// `_darkHeader`. Duplicated (not imported) because that one is private to its
/// file; keep the two in step if the header ever changes.
PreferredSizeWidget _paHeader({required String title, String? tag}) {
  return PreferredSize(
    preferredSize: Size.fromHeight(tag == null ? 76 : 92),
    child: Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s3, Msg.s4, Msg.s3),
          child: Row(children: [
            const AdBackButton(),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: ADText.appTitle(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                  if (tag != null) ...[
                    const SizedBox(height: 2),
                    Text(tag, style: ADText.sectionLabel()),
                  ],
                ],
              ),
            ),
          ]),
        ),
      ),
    ),
  );
}

class PaPhoneScreen extends StatefulWidget {
  const PaPhoneScreen({super.key});

  @override
  State<PaPhoneScreen> createState() => _PaPhoneScreenState();
}

class _PaPhoneScreenState extends State<PaPhoneScreen> {
  // [AVA-RCPT-CONSENT-2] `encryptedSharedPreferences: true` — MUST match the
  // options used by pstn_forwarding_setup.dart / pstn_forwarding_intro.dart, or
  // a value written by the wizard is not readable here.
  static final FlutterSecureStorage _sec = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// Server settings loaded once — every immediate save re-sends this payload
  /// with a single field replaced (the PUT overwrites every column).
  ReceptionistSettings? _settings;
  bool _loading = true;
  bool _loadFailed = false;

  /// Which backend field is mid-save (drives the small inline "Saving…" hint).
  String? _savingField;

  // Local mirrors of the four PSTN toggles.
  bool _rejected = true;
  bool _notPickedUp = true;
  bool _unreachable = false;
  bool _redirectAll = false;

  /// Carrier-confirmed state per forwarding condition, read from the
  /// per-account `pstn_voicemail_*_on` keys (only the wizard writes them).
  final Map<PstnForwardKind, bool> _carrierOn = {
    for (final k in PstnForwardKind.values) k: false,
  };

  /// Carrier forwarding is an Android-only, flagged capability. When it isn't
  /// available we simply don't talk about carrier setup at all — a "Fix it"
  /// button that opens a self-guarded empty screen would be worse than silence.
  /// [IOS-PORT-DISABLE-1] 2026-08-14: `avaDialer` removed from this gate —
  /// forwarding must survive the AvaDialer retirement (see
  /// pstn_forwarding_setup.dart registerPstnForwardingSection doc).
  bool get _carrierSupported =>
      Platform.isAndroid && RemoteConfig.pstnVoicemail;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('settings', 'pa_phone');
    _load();
  }

  Future<void> _load() async {
    final s = await ReceptionistApi.getSettings();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (s == null) {
        _loadFailed = true;
      } else {
        _settings = s;
        _loadFailed = false;
        _rejected = s.receptPstnRejected;
        _notPickedUp = s.receptPstnNotPickedUp;
        _unreachable = s.receptPstnUnreachable;
        _redirectAll = s.receptPstnRedirectAll;
      }
    });
    await _loadCarrier();
  }

  Future<void> _loadCarrier() async {
    if (!_carrierSupported) return;
    for (final kind in PstnForwardKind.values) {
      bool on = false;
      try {
        on = (await readScoped(_sec, kind.storageKey)) == '1';
      } catch (_) {/* unreadable storage — treat as not confirmed */}
      _carrierOn[kind] = on;
    }
    if (mounted) setState(() {});
  }

  // ── immediate save ─────────────────────────────────────────────────────────

  /// Flip one PSTN toggle and persist it right away. [apply] mutates the local
  /// mirror; on failure we put it back and say so, so the switch never lies
  /// about what the server has.
  Future<void> _flip(
    String field,
    bool value,
    void Function(bool) apply,
  ) async {
    final s = _settings;
    if (s == null || _savingField != null) return;
    setState(() {
      apply(value);
      _savingField = field;
    });
    Analytics.uiInteraction('pa_phone_toggle', 0,
        extra: {'toggle': field, 'value': value});
    final res = await ReceptionistApi.saveSettings(
      // ALWAYS-ON (owner decision 2026-07-07): the receptionist itself can no
      // longer be switched off per user — every save asserts enabled, exactly
      // as the old settings card did.
      enabled: true,
      instructions: s.instructions,
      displayName: s.displayName,
      personaName: s.personaName,
      languageCode: s.languageCode,
      greetingText: s.greetingText,
      customPrompt: s.customPrompt,
      answerAll: s.answerAll,
      statusPreset: s.statusPreset,
      statusCustom: s.statusCustom,
      declineToAva: s.declineToAva,
      statusNote: s.statusNote,
      statusExpiresAt: s.statusExpiresAt,
      answerLang: s.answerLang,
      answerLangSource: s.answerLang.isEmpty ? 'detected' : 'user',
      greetingStyle: s.greetingStyle,
      festivalGreeting: s.festivalGreeting,
      mode: s.mode,
      agentScope: s.agentScope,
      // This lane — the only values this screen owns.
      receptPstnNotPickedUp: _notPickedUp,
      receptPstnRejected: _rejected,
      receptPstnUnreachable: _unreachable,
      receptPstnRedirectAll: _redirectAll,
      // The other lane passes through untouched.
      receptAvatokNotPickedUp: s.receptAvatokNotPickedUp,
      receptAvatokRejected: s.receptAvatokRejected,
      receptAvatokUnreachable: s.receptAvatokUnreachable,
      receptAvatokRedirectAll: s.receptAvatokRedirectAll,
    );
    if (!mounted) return;
    setState(() => _savingField = null);
    if (res.ok) {
      Analytics.capture('pa_phone_toggle_saved', {'toggle': field, 'value': value});
      return;
    }
    setState(() => apply(!value)); // revert — the server did not take it
    AvaLog.I.log('receptionist', 'pa_phone toggle $field save FAILED (want=$value)');
    Analytics.capture('pa_phone_toggle_failed', {'toggle': field, 'value': value});
    _toast(res.blocked
        ? 'That needs a premium plan.'
        : 'Couldn’t save — check your connection and try again.');
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  // ── carrier setup ──────────────────────────────────────────────────────────

  /// Which forwarding condition backs each scenario toggle.
  ///   declined    → *67  (call-forward busy)
  ///   missed      → *61  (call-forward no-reply)
  ///   unreachable → *62  (call-forward not-reachable)
  static const Map<PstnForwardKind, String> _conditionLabel = {
    PstnForwardKind.declined: 'declined calls',
    PstnForwardKind.missed: 'missed calls',
    PstnForwardKind.unreachable: 'when your phone is off',
  };

  bool _wantsCondition(PstnForwardKind kind) => switch (kind) {
        PstnForwardKind.declined => _rejected,
        PstnForwardKind.missed => _notPickedUp,
        PstnForwardKind.unreachable => _unreachable,
      };

  /// Conditions the user has switched on that the carrier hasn't confirmed —
  /// and that the user can actually do something about. [pstnConditionLocked]
  /// conditions are a paid upgrade with no purchase flow yet, so offering
  /// "Fix it" for one would open a wizard row that cannot be actioned.
  List<PstnForwardKind> get _needsSetup => !_carrierSupported
      ? const <PstnForwardKind>[]
      : PstnForwardKind.values
          .where((k) =>
              _wantsCondition(k) &&
              !(_carrierOn[k] ?? false) &&
              !pstnConditionLocked(k))
          .toList();

  Future<void> _openFixIt() async {
    Analytics.uiInteraction('pa_fixit_open', 0, extra: {
      'pending': _needsSetup.map((k) => k.analyticsKind).join(','),
    });
    await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => const PstnForwardingSetupScreen()));
    if (!mounted) return;
    await _loadCarrier(); // the wizard may have confirmed one — refresh the banner
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _paHeader(title: 'Phone calls', tag: 'Ava PA'),
      body: _loading
          ? const Center(
              child: SizedBox(
                  width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)))
          : ListView(
              padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s6),
              children: [
                _explainer(),
                if (_loadFailed) ...[
                  const SizedBox(height: 16),
                  _loadFailedCard(),
                ],
                const SizedBox(height: 16),
                Text('WHEN SHOULD AVA ANSWER?', style: ADText.sectionLabel()),
                const SizedBox(height: Msg.s2),
                AdCard(
                  padding: const EdgeInsets.symmetric(
                      horizontal: Msg.s4, vertical: Msg.s2),
                  child: Column(children: [
                    _toggleRow(
                      title: 'I decline a call',
                      sub: 'You tap decline in your dialer',
                      field: 'recept_pstn_rejected',
                      value: _rejected,
                      apply: (v) => _rejected = v,
                    ),
                    const Divider(height: 1, color: AD.borderHairline),
                    _toggleRow(
                      title: 'I miss a call',
                      sub: 'It rings out before you answer',
                      field: 'recept_pstn_not_picked_up',
                      value: _notPickedUp,
                      apply: (v) => _notPickedUp = v,
                    ),
                    const Divider(height: 1, color: AD.borderHairline),
                    _toggleRow(
                      title: 'My phone is off',
                      sub: 'No signal or switched off',
                      field: 'recept_pstn_unreachable',
                      value: _unreachable,
                      apply: (v) => _unreachable = v,
                    ),
                  ]),
                ),
                if (_needsSetup.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  _carrierBanner(),
                ],
                const SizedBox(height: 16),
                Text('ADVANCED', style: ADText.sectionLabel()),
                const SizedBox(height: Msg.s2),
                AdCard(
                  padding: const EdgeInsets.symmetric(
                      horizontal: Msg.s4, vertical: Msg.s2),
                  child: _toggleRow(
                    title: 'Send every call to Ava',
                    sub: 'She always answers first',
                    field: 'recept_pstn_redirect_all',
                    value: _redirectAll,
                    apply: (v) => _redirectAll = v,
                  ),
                ),
              ],
            ),
    );
  }

  Widget _explainer() => AdCard(
        padding: const EdgeInsets.all(Msg.s4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(
              icon: PhosphorIcons.phone(PhosphorIconsStyle.fill),
              color: AD.online,
              size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Decline or miss a call and Ava answers it, takes the message, '
              'and sends it to your inbox with a recording.',
              style: ADText.preview(),
            ),
          ),
        ]),
      );

  Widget _loadFailedCard() => AdCard(
        padding: const EdgeInsets.all(Msg.s4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill),
                size: 18, color: AD.primaryBadge),
            const SizedBox(width: 8),
            Expanded(
                child: Text('Couldn’t load your settings',
                    style: ADText.rowName())),
          ]),
          const SizedBox(height: Msg.s1),
          Text(
            'These switches are showing defaults and can’t be changed until '
            'AvaTOK reaches the server.',
            style: ADText.preview(),
          ),
          const SizedBox(height: 12),
          AdButton(
            label: 'Try again',
            variant: AdButtonVariant.ghost,
            fullWidth: true,
            fontSize: 14,
            onPressed: () {
              setState(() => _loading = true);
              _load();
            },
          ),
        ]),
      );

  Widget _carrierBanner() {
    final pending = _needsSetup;
    final names = pending.map((k) => _conditionLabel[k] ?? '').toList();
    final joined = names.length == 1
        ? names.first
        : '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
    return AdCard(
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill),
              size: 18, color: AD.primaryBadge),
          const SizedBox(width: 8),
          Expanded(
            child: Text('Carrier setup needed for $joined',
                style: ADText.rowName(c: AD.primaryBadge)),
          ),
        ]),
        const SizedBox(height: Msg.s1),
        Text(
          'Your phone company still has to hand those calls to Ava. It takes '
          'one short code per condition and only turns green once your carrier '
          'confirms it.',
          style: ADText.preview(),
        ),
        const SizedBox(height: 12),
        AdButton(
          label: 'Fix it',
          fullWidth: true,
          fontSize: 14,
          onPressed: _openFixIt,
        ),
      ]),
    );
  }

  Widget _toggleRow({
    required String title,
    required String sub,
    required String field,
    required bool value,
    required void Function(bool) apply,
  }) {
    final saving = _savingField == field;
    final disabled = _settings == null || (_savingField != null && !saving);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Msg.s3),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(saving ? 'Saving…' : sub, style: ADText.preview()),
          ]),
        ),
        const SizedBox(width: 8),
        if (saving) ...[
          const SizedBox(
              width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: 8),
        ],
        _PaToggle(
          value: value,
          onChanged: disabled ? null : (v) => _flip(field, v, apply),
        ),
      ]),
    );
  }
}

/// Dark v2 inline toggle — track [AD.card] off / [AD.online] on, white thumb.
/// Visual copy of receptionist_section.dart's `_AdToggle` (private there, so it
/// cannot be imported). Keep the two identical if either is restyled.
class _PaToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _PaToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : Msg.fast,
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          // Toggle track — a genuine pill.
          borderRadius: Msg.brPill,
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : Msg.fast,
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
