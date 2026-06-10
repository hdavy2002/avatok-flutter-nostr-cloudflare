import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import 'identity_api.dart';
import 'identity_gate.dart';

/// AvaIdentity app screen (Phase 3): current verification status, restart
/// button, and a what-we-check explainer. The strong doc-KYC (Stripe Identity)
/// sits on top of the onboarding age/phone/email checks — it is only required
/// for the creator/payout actions in the universal §5 gating matrix.
class IdentityScreen extends StatefulWidget {
  const IdentityScreen({super.key});
  @override
  State<IdentityScreen> createState() => _IdentityScreenState();
}

class _IdentityScreenState extends State<IdentityScreen> {
  IdentityStatus? _status;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    Analytics.capture('identity_screen_viewed');
    _refresh();
  }

  Future<void> _refresh() async {
    final s = await IdentityApi.status();
    if (!mounted) return;
    setState(() {
      _status = s;
      _loading = false;
    });
  }

  Future<void> _verify() async {
    final ok = await IdentityGate.ensureVerified(context, reason: 'use creator features');
    if (ok) await _refresh();
  }

  ({IconData icon, Color color, String title, String subtitle}) _stateUi() {
    final s = _status;
    if (s == null) {
      return (icon: Icons.cloud_off, color: Colors.grey, title: 'Status unavailable', subtitle: 'Could not reach the server. Pull to retry.');
    }
    if (s.verified) {
      return (icon: Icons.verified, color: const Color(0xFF10B981), title: 'Verified ✓', subtitle: 'Your identity is verified${s.provider != null ? ' (${s.provider == 'stripe_identity' ? 'document + selfie' : 'selfie video'})' : ''}. Creator features are unlocked.');
    }
    switch (s.status) {
      case 'pending':
        return (icon: Icons.hourglass_top, color: Colors.amber, title: 'Pending', subtitle: 'Your verification is being processed. This usually takes a few minutes.');
      case 'pending_input':
        return (icon: Icons.error_outline, color: Colors.orange, title: 'More input needed', subtitle: s.failureReason ?? 'Stripe needs you to retry part of the check.');
      case 'rejected':
        return (icon: Icons.cancel_outlined, color: Colors.redAccent, title: 'Failed', subtitle: s.failureReason ?? 'Verification did not pass. You can try again.');
      default:
        return (icon: Icons.shield_outlined, color: const Color(0xFF7C5CFC), title: 'Not started', subtitle: 'Verify once to unlock creator payouts, paid listings and live selling.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final ui = _stateUi();
    final verified = _status?.verified == true;
    return Scaffold(
      appBar: AppBar(title: const Text('AvaIdentity')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Container(
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      color: ui.color.withValues(alpha: .09),
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: ui.color.withValues(alpha: .35)),
                    ),
                    child: Column(children: [
                      Icon(ui.icon, size: 52, color: ui.color),
                      const SizedBox(height: 12),
                      Text(ui.title, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                      const SizedBox(height: 6),
                      Text(ui.subtitle, textAlign: TextAlign.center, style: TextStyle(color: cs.onSurfaceVariant, height: 1.4)),
                    ]),
                  ),
                  const SizedBox(height: 16),
                  if (!verified)
                    FilledButton.icon(
                      onPressed: _verify,
                      icon: const Icon(Icons.badge_outlined),
                      label: Text(_status?.status == 'rejected' || _status?.status == 'pending_input'
                          ? 'Restart verification'
                          : 'Verify my identity'),
                      style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                    ),
                  const SizedBox(height: 28),
                  Text('What we check', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  const _CheckRow(Icons.badge_outlined, 'Government ID',
                      'A photo of your passport, driving licence or national ID card.'),
                  const _CheckRow(Icons.face_retouching_natural, 'Selfie match',
                      'A short live selfie, matched against your document.'),
                  const _CheckRow(Icons.lock_outline, 'Privacy',
                      'Documents are processed by Stripe Identity. AvaTOK stores only the verification result — never your ID images.'),
                  const _CheckRow(Icons.workspace_premium_outlined, 'What it unlocks',
                      'Withdrawing earnings, paid consult listings and live selling. Browsing, chatting and buying never need this.'),
                ],
              ),
      ),
    );
  }
}

class _CheckRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  const _CheckRow(this.icon, this.title, this.body);
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 22, color: const Color(0xFF7C5CFC)),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            Text(body, style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13, height: 1.35)),
          ]),
        ),
      ]),
    );
  }
}
