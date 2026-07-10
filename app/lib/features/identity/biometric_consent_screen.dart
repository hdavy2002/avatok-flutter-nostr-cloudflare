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
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import 'liveness_v2/live_theme.dart';

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
    // LiveTheme has no `bg`. `stage` is the dark camera backdrop, which would make
    // this screen's default-black body text invisible. `paper` is the light surface
    // the rest of the Zine UI uses.
    return Scaffold(
      backgroundColor: LiveTheme.paper,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(icon: const Icon(Icons.close), onPressed: _decline),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Quick check before you post',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, height: 1.2)),
              const SizedBox(height: 20),

              const _Para(
                title: 'A real person',
                body: 'AvaTok asks everyone to verify they are a real person before '
                    'posting publicly. It takes a few seconds, and you will only be '
                    'asked again every few months.',
              ),
              const SizedBox(height: 16),

              // [AVA-IDGATE-1] Softened copy (owner 2026-07-10): gentle + informative,
              // no harsh/child-harm language. Still accurate about the lawful-request
              // path (required for BIPA transparency) without the confrontational tone.
              const _Para(
                title: 'A safer community',
                body: 'Tying each account to a quick liveness check helps keep AvaTok a '
                    'safe, friendly place for everyone. We keep it private and never '
                    'share it — the only exception is if a court or law enforcement ever '
                    'legally requires it.',
              ),
              const SizedBox(height: 28),

              // ---- State of residence. Drives the retention track (spec §10.2). ----
              const Text('State of residence',
                  style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: _state,
                isExpanded: true,
                decoration: const InputDecoration(
                  border: OutlineInputBorder(),
                  contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  hintText: 'Select your state',
                ),
                items: [
                  ..._kUsStates.map((s) => DropdownMenuItem(value: s, child: Text(s))),
                  const DropdownMenuItem(value: _kOutsideUs, child: Text('I live outside the US')),
                ],
                onChanged: _submitting ? null : (v) => setState(() => _state = v),
              ),
              const SizedBox(height: 24),

              // ---- BIPA §15(b) consent. NEVER pre-ticked. ----
              InkWell(
                onTap: _submitting ? null : () => setState(() => _agreed = !_agreed),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Checkbox(
                      value: _agreed,
                      onChanged: _submitting ? null : (v) => setState(() => _agreed = v ?? false),
                    ),
                    const Expanded(
                      child: Padding(
                        padding: EdgeInsets.only(top: 12),
                        // Names WHAT is collected, WHY, and HOW LONG — all three are
                        // required by BIPA §15(b). The "up to" wording is exact: on the
                        // protective track the scan is destroyed immediately at deletion,
                        // so 256 days is a ceiling, never a promise to keep it that long.
                        child: Text(
                          'I agree that AvaTOK may collect and store a scan of my facial '
                          'geometry to verify I am a real person, and may keep it for up '
                          'to $_kRetentionDays days after I delete my account.',
                          style: TextStyle(height: 1.4),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 6),
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
                  child: const Text(
                    'Read our biometric retention schedule',
                    style: TextStyle(decoration: TextDecoration.underline, fontSize: 13),
                  ),
                ),
              ),
              const SizedBox(height: 16),

              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                ),

              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _canSubmit ? _submit : null,
                  child: _submitting
                      ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('Verify with camera'),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: TextButton(
                  onPressed: _submitting ? null : _decline,
                  child: const Text('Not now'),
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
        const SizedBox(height: 6),
        Text(body, style: const TextStyle(height: 1.45)),
      ],
    );
  }
}
