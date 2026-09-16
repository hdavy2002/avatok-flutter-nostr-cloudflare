
import '../../core/localization/ui_text.dart';

// [AVA-IDGATE-1] Biometric consent — shown BEFORE the camera ever opens.
// Spec: Specs/SPEC-2026-07-10-identity-gating.md §5.1, §10.4
//
// THIS SCREEN IS A LEGAL REQUIREMENT, NOT A COURTESY.
//
// Illinois BIPA (740 ILCS 14 §15(b)) requires informed WRITTEN consent before a
// private entity collects a scan of facial geometry. An electronic signature
// satisfies "written" (Public Act 103-0769, effective 2024-08-02). BIPA is the only
// biometric statute with a PRIVATE RIGHT OF ACTION — $1,000 per negligent violation,
// $5,000 per intentional — and it applies to Illinois residents regardless of where
// AvaTok is incorporated.
//
// Therefore, and non-negotiably:
//   • The checkbox is NEVER pre-ticked.
//   • It names what is collected (a scan of facial geometry), the purpose, and the
//     retention period. A buried ToS link does not satisfy the statute.
//   • It appears BEFORE capture. The Worker independently 403s a capture session
//     without recorded consent, so a client that skips this screen still cannot
//     open a camera.
//   • Declining is a NORMAL outcome, not an error. Nothing is captured.
//
// The safety paragraph is not a compliance tax — it IS the deterrent. A record
// nobody knows about deters nobody. Do not soften it. Equally, do not add claims we
// cannot support: we do not say "we will report you to the police", and we never
// imply we can identify a person from their face. We cannot.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';

/// US states + DC. Used to route the user's retention track (spec §10.2).
/// Deliberately a plain list — no geolocation, no IP inference.
const List<String> _kUsStates = <String>[
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
  'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY',
];

const String _kOutsideUs = 'OUTSIDE_US';

/// Retention period we disclose. MUST match `biometricConsentVersion` on the server
/// and the published retention schedule on the website. If any of the three drift,
/// the consent is defective.
const int _kRetentionDays = 256;

class BiometricConsentScreen extends StatefulWidget {
  const BiometricConsentScreen({super.key, required this.action});

  /// The public action that triggered the gate — 'post', 'listing', 'live',
  /// 'dm_stranger', 'group_post', 'upload', 'comment'.
  final String action;

  @override
  State<BiometricConsentScreen> createState() => _BiometricConsentScreenState();
}

class _BiometricConsentScreenState extends State<BiometricConsentScreen> {
  bool _agreed = false;
  String? _state;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    Analytics.capture('liveness_consent_shown', {
      'action': widget.action,
      'policy_version': 'client',
    });
  }

  /// The user can proceed only with BOTH an explicit tick and a declared state.
  /// The state drives the retention track; unknown ⇒ the server assigns the
  /// PROTECTIVE track (video deleted at account deletion). Failing that direction
  /// is deliberate: IP geolocation tells you where a device is, not where a person
  /// resides, and one misgeolocated Illinois resident is a live BIPA claim.
  bool get _canSubmit => _agreed && _state != null && !_submitting;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() { _submitting = true; _error = null; });
    try {
      final r = await ApiAuth.postJson(kLivenessConsentUrl, {
        'consent': true,
        // OUTSIDE_US is sent as null: we make no claim about a non-US residency,
        // so the server defaults to the protective track.
        if (_state != _kOutsideUs) 'residency_state': _state,
      });
      if (r.statusCode != 200) {
        setState(() { _submitting = false; _error = 'Could not save your choice. Please try again.'; });
        return;
      }
      final j = jsonDecode(r.body);
      final track = (j is Map ? j['retention_track'] : null)?.toString();
      // Analytics.capture takes Map<String, Object> — NOT Object?. A null value is a
      // compile error, so coerce. '' reads as "unknown" in PostHog, which is exactly
      // what an absent residency means, and what the server assumed (protective track).
      Analytics.capture('liveness_consent_granted', {
        'action': widget.action,
        'residency_state': _state ?? '',
        'retention_track': track ?? '',
      });
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (_) {
      setState(() { _submitting = false; _error = 'Network problem. Please try again.'; });
    }
  }

  void _decline() {
    // A refusal is a legitimate answer. Record it — this is the truest measure of
    // how people feel about handing over a face scan, and it is a number a
    // regulator may one day ask about. Nothing is captured.
    Analytics.capture('liveness_consent_declined', {'action': widget.action});
    Navigator.of(context).pop(false);
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
            icon: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.regular),
                color: AD.textPrimary),
            onPressed: _decline),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s2, Msg.s5, Msg.s6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              UiText(UiMessage.m_quick_check_before_you_post_1f5aec365c,
                  style: ADText.appTitle().copyWith(fontSize: 26, height: 1.2)),
              const SizedBox(height: Msg.s5),

               _Para(
                title: uiCopy(UiMessage.m_a_real_person_ec2e692d86),
                body: 'AvaTok asks everyone to verify they are a real person before '
                    'posting publicly. It takes a few seconds, and you will only be '
                    'asked again every few months.',
              ),
              const SizedBox(height: Msg.s4),

              // [AVA-IDGATE-1] Softened copy (owner 2026-07-10): gentle + informative,
              // no harsh/child-harm language. Still accurate about the lawful-request
              // path (required for BIPA transparency) without the confrontational tone.
               _Para(
                title: uiCopy(UiMessage.m_a_safer_community_572499c143),
                body: 'Tying each account to a quick liveness check helps keep AvaTok a '
                    'safe, friendly place for everyone. We keep it private and never '
                    'share it — the only exception is if a court or law enforcement ever '
                    'legally requires it.',
              ),
              const SizedBox(height: Msg.s6),

              // ---- State of residence. Drives the retention track (spec §10.2). ----
              UiText(UiMessage.m_state_of_residence_df43dd3142,
                  style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                      color: AD.textSecondary)),
              const SizedBox(height: Msg.s2),
              DropdownButtonFormField<String>(
                initialValue: _state,
                isExpanded: true,
                dropdownColor: AD.menu,
                iconEnabledColor: AD.textSecondary,
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w400,
                    fontSize: 15, color: AD.textPrimary),
                decoration: InputDecoration(
                  filled: true,
                  fillColor: AD.card,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AD.rInput),
                    borderSide: const BorderSide(color: AD.borderControl, width: 1),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AD.rInput),
                    borderSide: const BorderSide(color: AD.borderControl, width: 1),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AD.rInput),
                    borderSide: const BorderSide(color: AD.iconSearch, width: 1),
                  ),
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
                  hintText: uiCopy(UiMessage.m_select_your_state_25b2865960),
                  hintStyle: TextStyle(fontFamily: ADText.family, color: AD.textTertiary),
                ),
                items: [
                  ..._kUsStates.map((s) => DropdownMenuItem(value: s, child: Text(s))),
                  const DropdownMenuItem(value: _kOutsideUs, child: UiText(UiMessage.m_i_live_outside_the_us_3ebcc91fb0)),
                ],
                onChanged: _submitting ? null : (v) => setState(() => _state = v),
              ),
              const SizedBox(height: Msg.s5),

              // ---- BIPA §15(b) consent. NEVER pre-ticked. ----
              InkWell(
                onTap: _submitting ? null : () => setState(() => _agreed = !_agreed),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Checkbox(
                      value: _agreed,
                      activeColor: AD.online,
                      checkColor: Colors.white,
                      side: const BorderSide(color: AD.borderControl, width: 1.5),
                      onChanged: _submitting ? null : (v) => setState(() => _agreed = v ?? false),
                    ),
                     Expanded(
                      child: Padding(
                        padding: EdgeInsets.only(top: 12),
                        // Names WHAT is collected, WHY, and HOW LONG — all three are
                        // required by BIPA §15(b). The "up to" wording is exact: on the
                        // protective track the scan is destroyed immediately at deletion,
                        // so 256 days is a ceiling, never a promise to keep it that long.
                        child: UiText(
                          UiMessage.m_i_agree_that_avatok_may_c4a09d034d, params: {'kRetentionDays': (_kRetentionDays).toString()},
                          style: TextStyle(
                              fontFamily: ADText.family,
                              fontWeight: FontWeight.w400,
                              height: 1.4,
                              color: AD.textPrimary),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: Msg.s2),
              // [AVA-IDGATE-1] BIPA §15(a): the retention & destruction schedule must be
              // PUBLICLY AVAILABLE. Published at web/src/pages/biometric-retention.astro.
              // The periods on that page and _kRetentionDays above must never diverge —
              // a published schedule we do not follow is evidence against us, not a defence.
              Padding(
                padding: const EdgeInsets.only(left: 48),
                child: InkWell(
                  onTap: () => launchUrl(
                    Uri.parse('https://avatok.ai/biometric-retention'),
                    mode: LaunchMode.externalApplication,
                  ),
                  child: UiText(
                    UiMessage.m_read_our_biometric_retention_schedule_37e432e382,
                    style: TextStyle(fontFamily: ADText.family,
                        fontWeight: FontWeight.w400,
                        decoration: TextDecoration.underline, fontSize: 13, color: AD.iconSearch),
                  ),
                ),
              ),
              const SizedBox(height: Msg.s4),

              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: Msg.s3),
                  child: AdErrorMsg(_error!),
                ),

              AdButton(
                label: uiCopy(UiMessage.m_verify_with_camera_75098e2258),
                fullWidth: true,
                loading: _submitting,
                onPressed: _canSubmit ? _submit : null,
              ),
              const SizedBox(height: Msg.s2),
              SizedBox(
                width: double.infinity,
                child: TextButton(
                  onPressed: _submitting ? null : _decline,
                  child: UiText(UiMessage.m_not_now_a0e63d7c71, style: ADText.preview(c: AD.textSecondary)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Para extends StatelessWidget {
  const _Para({required this.title, required this.body});
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: ADText.threadName()),
        const SizedBox(height: Msg.s2),
        Text(body, style: TextStyle(fontFamily: ADText.family,
            fontWeight: FontWeight.w400, height: 1.45, color: AD.textSecondary)),
      ],
    );
  }
}
