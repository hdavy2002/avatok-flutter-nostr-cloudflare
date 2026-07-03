import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ladder_api.dart';
import 'liveness_check_screen.dart';

/// STREAM H (AI Messenger Batch) — the onboarding "human check" hard gate.
///
/// Used in TWO places (see [HumanCheckSource]):
///   1. SIGNUP  — inserted into the AccountGate signup flow AFTER credentials are
///      created and BEFORE the app landing (D12 hard gate at account creation).
///   2. REDIRECT — a full-screen, NON-DISMISSIBLE route pushed on app open for
///      existing unverified users when livenessOnboardingGate is ON (D13: no back,
///      no skip, no grace).
///
/// The primary button launches the existing Rekognition Amplify Face Liveness UI
/// (the shared L2 [LivenessCheckScreen]; provider is server-selected — Rekognition
/// by default, Workers AI when its flag is on — D14). On PASS we continue; on FAIL
/// the liveness screen shows a friendly retry with attempts-remaining (the existing
/// 3/24h budget). The "Why are we asking this?" sheet carries the D15 retention
/// sentence and MUST NOT be removed.
enum HumanCheckSource { signup, redirect }

class HumanCheckPage extends StatefulWidget {
  const HumanCheckPage({
    super.key,
    required this.source,
    this.onVerified,
  });

  /// Where this gate was shown — drives telemetry `source` and back-button policy.
  final HumanCheckSource source;

  /// Called once the user is verified human. For the SIGNUP flow this typically
  /// pops with `true`; for the REDIRECT flow the host (RootFlow) swaps back to the
  /// app shell. If null, the page pops itself with `true`.
  final VoidCallback? onVerified;

  @override
  State<HumanCheckPage> createState() => _HumanCheckPageState();
}

class _HumanCheckPageState extends State<HumanCheckPage> {
  bool _busy = false;

  String get _source => widget.source == HumanCheckSource.signup ? 'signup' : 'redirect';

  @override
  void initState() {
    super.initState();
    // [LIVE-GATE-6] telemetry (auto-stamps email + uid via Analytics._base).
    Analytics.capture('liveness_gate_shown', {'source': _source});
  }

  Future<void> _startCheck() async {
    if (_busy) return;
    setState(() => _busy = true);
    Analytics.capture('liveness_started', {'provider': 'workersai', 'source': _source});

    // Launch the Cloudflare-native Face Liveness UI. Returns true on PASS.
    // LIVENESS-ONLY onboarding: we do NOT ask for government ID here (owner
    // decision 2026-07-03 — don't scare users). A failed check just lets them
    // retry; no document/KYC fallback.
    bool ok = false;
    try {
      ok = await Navigator.of(context).push<bool>(
            MaterialPageRoute(builder: (_) => const LivenessCheckScreen()),
          ) ==
          true;
    } catch (_) {
      ok = false;
    }
    if (!mounted) return;
    setState(() => _busy = false);

    if (ok) {
      // Confirm with the server truth before letting the user through (the
      // liveness screen already flipped kyc_status; this refreshes the cache).
      await LadderApi.level();
      // country/ip/device_model/os/app_version are authoritatively stamped
      // server-side on the liveness_audit row (edge geo + verify body); the
      // client doesn't geo-locate, so those props ride the SERVER events.
      Analytics.capture('liveness_passed', {'provider': 'workersai', 'source': _source});
      // Person-props on pass (D-spec [LIVE-GATE-6]).
      await Analytics.setPersonProps({'liveness_verified': true});
      if (!mounted) return;
      await _showVerified();
    }
    // On failure the LivenessCheckScreen already emitted liveness_failed and its
    // own friendly retry UI; the user lands back here and can tap start again.
  }

  Future<void> _showVerified() async {
    // Full-screen success (ZineSuccessOverlay renders its own ZinePaper page).
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (ctx) => ZineSuccessOverlay(
          icon: PhosphorIcons.sealCheck(PhosphorIconsStyle.fill),
          headline: 'You\'re verified human ✅',
          sub: 'Thanks — that keeps AvaTOK free of AI bots.',
          ctaLabel: 'Continue',
          onCta: () => Navigator.of(ctx).pop(),
        ),
      ),
    );
    if (!mounted) return;
    if (widget.onVerified != null) {
      widget.onVerified!();
    } else {
      Navigator.of(context).pop(true);
    }
  }

  void _openWhy() {
    Analytics.capture('liveness_why_opened', {'source': _source});
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r)),
        side: BorderSide(color: Zine.ink, width: Zine.bwLg),
      ),
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Center(
            child: Container(
              width: 46, height: 5,
              decoration: BoxDecoration(color: Zine.ink.withValues(alpha: .2), borderRadius: BorderRadius.circular(3)),
            ),
          ),
          const SizedBox(height: 18),
          Text('Why are we asking this?', style: ZineText.hero(size: 24)),
          const SizedBox(height: 14),
          Text(
            'AvaTOK is for real people, not AI agents. Sophisticated bots keep trying '
            'to create fake accounts to send spam, run scams, and impersonate others. '
            'A quick liveness check — a short selfie video with a couple of random '
            'gestures — proves there\'s a genuine human behind the account. It takes '
            'about 15 seconds and you only do it once.',
            style: ZineText.sub(size: 15),
          ),
          const SizedBox(height: 14),
          // D15 — retention sentence. DO NOT REMOVE.
          Text(
            'Your verification video is stored securely and used only for safety review.',
            style: ZineText.sub(size: 15).copyWith(fontWeight: FontWeight.w700, color: Zine.ink),
          ),
          const SizedBox(height: 24),
          ZineButton(
            label: 'Got it',
            fullWidth: true,
            onPressed: () => Navigator.of(context).pop(),
          ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // D13: the redirect variant is non-dismissible — swallow the system back
    // gesture so an unverified user can't escape the gate.
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: Zine.paper,
        body: ZineScrollBody(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Spacer(),
            Center(
              child: Container(
                width: 108, height: 108,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: Zine.lilac,
                  border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bwLg)),
                  boxShadow: Zine.shadow,
                ),
                child: PhosphorIcon(PhosphorIcons.userFocus(PhosphorIconsStyle.bold), size: 48, color: Zine.ink),
              ),
            ),
            const SizedBox(height: 24),
            Text('Quick human check', textAlign: TextAlign.center, style: ZineText.hero(size: 30)),
            const SizedBox(height: 14),
            Text(
              'Let our AI check that you\'re a real person — AI bots keep '
              'trying to sign up! No AI agents allowed on AvaTOK. This takes about '
              '15 seconds.',
              textAlign: TextAlign.center,
              style: ZineText.sub(size: 15),
            ),
            const SizedBox(height: 20),
            Center(child: ZineLink('Why are we asking this?', onTap: _openWhy)),
            const Spacer(),
            ZineButton(
              label: 'I\'m human — start check',
              fullWidth: true,
              fontSize: 19,
              loading: _busy,
              icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: _busy ? null : _startCheck,
            ),
            const SizedBox(height: 8),
          ]),
        ),
        ),
      ),
    );
  }
}
