import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/theme.dart';
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
    final cs = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: EdgeInsets.fromLTRB(24, 20, 24, 24 + MediaQuery.of(context).viewPadding.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 36, height: 4, margin: const EdgeInsets.only(bottom: 20),
              decoration: BoxDecoration(color: cs.outlineVariant, borderRadius: BorderRadius.circular(2)),
            ),
          ),
          const Icon(Icons.verified_user, size: 44, color: Color(0xFF7C5CFC)),
          const SizedBox(height: 14),
          Text('Verify your identity',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Text(
            'We need to verify your identity before you can ${widget.reason}. '
            'You\'ll photograph a government ID and take a quick selfie — it '
            'usually takes under two minutes.',
            textAlign: TextAlign.center,
            style: TextStyle(color: cs.onSurfaceVariant, height: 1.4),
          ),
          const SizedBox(height: 6),
          Text(
            'Your documents are processed securely by Stripe Identity. AvaTOK '
            'never stores your ID images.',
            textAlign: TextAlign.center,
            style: TextStyle(color: cs.onSurfaceVariant.withValues(alpha: .7), fontSize: 12, height: 1.4),
          ),
          if (widget.status?.failureReason != null) ...[
            const SizedBox(height: 10),
            Text('Last attempt: ${widget.status!.failureReason}',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.orange, fontSize: 12)),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: cs.error, fontSize: 13)),
          ],
          const SizedBox(height: 20),
          if (_polling) ...[
            const Center(child: CircularProgressIndicator()),
            const SizedBox(height: 10),
            Text('Waiting for verification to finish…',
                textAlign: TextAlign.center, style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13)),
            const SizedBox(height: 10),
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('I\'ll finish later'),
            ),
          ] else ...[
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: AvaColors.brand,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: _busy ? null : _start,
              child: _busy
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Start verification'),
            ),
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Not now'),
            ),
          ],
        ],
      ),
    );
  }
}
