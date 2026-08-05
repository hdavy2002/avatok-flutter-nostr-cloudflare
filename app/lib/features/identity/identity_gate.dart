import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'identity_api.dart';

/// IdentityGate (Phase 3) — wrap any KYC-gated action. If the account isn't
/// verified, an explainer sheet launches the Stripe Identity flow (hosted page
/// via url_launcher today; the native `stripe_identity` SDK can swap in later
/// — the API already returns client_secret + ephemeral_key) and polls status.
///
/// Usage:
///   final ok = await IdentityGate.ensureVerified(context,
///       reason: 'add a bank account');
///   if (!ok) return; // user bailed or verification still pending
///
/// Signup, browsing, booking and top-ups NEVER pass through this gate — only
/// the creator/payout actions in the universal §5 matrix.
class IdentityGate {
  static Future<bool> ensureVerified(BuildContext context, {required String reason}) async {
    // Server truth first; cached value only paints optimism, never authorizes.
    final st = await IdentityApi.status();
    if (st?.verified == true) return true;
    if (!context.mounted) return false;

    Analytics.capture('identity_gate_shown', {'reason': reason});
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _GateSheet(reason: reason, status: st),
    );
    return ok == true;
  }
}

class _GateSheet extends StatefulWidget {
  final String reason;
  final IdentityStatus? status;
  const _GateSheet({required this.reason, this.status});
  @override
  State<_GateSheet> createState() => _GateSheetState();
}

class _GateSheetState extends State<_GateSheet> {
  bool _busy = false;
  bool _polling = false;
  String? _error;
  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final s = await IdentityApi.startStripeSession();
    if (!mounted) return;
    if (s == null || (s.url == null || s.url!.isEmpty)) {
      setState(() {
        _busy = false;
        _error = s == null
            ? 'Could not start verification. Please try again in a moment.'
            : 'Verification is not available right now.';
      });
      return;
    }
    Analytics.capture('identity_stripe_started');
    await launchUrl(Uri.parse(s.url!), mode: LaunchMode.externalApplication);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _polling = true;
    });
    // Poll status while the user completes the hosted Stripe flow.
    var ticks = 0;
    _poll = Timer.periodic(const Duration(seconds: 4), (t) async {
      ticks++;
      final st = await IdentityApi.status();
      if (!mounted) return;
      if (st?.verified == true) {
        t.cancel();
        Analytics.capture('identity_verified_via_gate');
        Navigator.of(context).pop(true);
      } else if (ticks > 75) {
        // ~5 minutes — stop polling; the user can reopen later.
        t.cancel();
        setState(() => _polling = false);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    // Dark bottom-sheet surface with a hairline top border.
    return Container(
      decoration: const BoxDecoration(
        color: AD.overlaySheet,
        borderRadius: Msg.brSheetTop,
        border: Border(top: Msg.hairline),
      ),
      padding: EdgeInsets.fromLTRB(
          Msg.s5, Msg.s4, Msg.s5, Msg.s5 + MediaQuery.of(context).viewPadding.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 38, height: 5, margin: const EdgeInsets.only(bottom: Msg.s4),
              // The sheet grabber IS one of the shapes a pill is reserved for.
              decoration: BoxDecoration(color: AD.borderControl, borderRadius: Msg.brPill),
            ),
          ),
          Center(
            child: ZineIconBadge(
              icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.regular),
              size: 56,
            ),
          ),
          const SizedBox(height: Msg.s4),
          Text('Verify your identity',
              textAlign: TextAlign.center,
              style: ADText.appTitle().copyWith(
                  fontSize: 27, height: 1.08, letterSpacing: -0.02 * 27)),
          const SizedBox(height: Msg.s3),
          Text(
            'We need to verify your identity before you can ${widget.reason}. '
            'You\'ll photograph a government ID and take a quick selfie — it '
            'usually takes under two minutes.',
            textAlign: TextAlign.center,
            style: ADText.preview().copyWith(fontSize: 14, height: 1.42),
          ),
          const SizedBox(height: Msg.s2),
          Text(
            'Your documents are processed securely by Stripe Identity. AvaTOK '
            'never stores your ID images.',
            textAlign: TextAlign.center,
            style: ADText.preview(c: AD.textTertiary).copyWith(fontSize: 12, height: 1.42),
          ),
          if (widget.status?.failureReason != null) ...[
            const SizedBox(height: Msg.s3),
            Center(
              child: ZineSticker('last try: ${widget.status!.failureReason}',
                  kind: ZineStickerKind.no,
                  icon: PhosphorIcons.warning(PhosphorIconsStyle.regular)),
            ),
          ],
          if (_error != null) ZineErrorMsg(_error!),
          const SizedBox(height: Msg.s5),
          if (_polling) ...[
            const Center(child: CircularProgressIndicator(color: Msg.accent)),
            const SizedBox(height: Msg.s3),
            Text('Waiting for verification to finish…',
                textAlign: TextAlign.center,
                style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
            const SizedBox(height: Msg.s3),
            Center(
              child: ZineLink('I’ll finish later',
                  onTap: () => Navigator.of(context).pop(false)),
            ),
          ] else ...[
            ZineButton(
              label: 'Start verification',
              fullWidth: true,
              fontSize: 19,
              loading: _busy,
              onPressed: _busy ? null : _start,
            ),
            const SizedBox(height: Msg.s3),
            ZineButton(
              label: 'Not now',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              fontSize: 16,
              onPressed: () => Navigator.of(context).pop(false),
            ),
          ],
        ],
      ),
    );
  }
}
