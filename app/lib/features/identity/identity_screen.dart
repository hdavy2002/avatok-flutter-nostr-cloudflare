import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
import '../profile/phone_verify_card.dart';
import '../profile/profile_screen.dart';
import 'identity_api.dart';
import 'identity_gate.dart';
import 'ladder_api.dart';
import 'liveness_check_screen.dart';

/// AvaIdentity — the ONE-STOP identity hub (replaces the Profile sidebar
/// entry; PROPOSAL-PROGRESSIVE-IDENTITY.md §7b). Shows the Trust Ladder with
/// green ticks, and hosts every identity action: profile & photo, email
/// change (OTP re-verify), password (Clerk), phone change (SIM-only, OTP),
/// video liveness (L2) and Stripe document KYC (L3).
///
/// The liveness and Stripe KYC ticks are NOT deletable — they are trust
/// assets. The only way to remove them is full account deletion, which wipes
/// EVERYTHING (including verification media) after the 30-day grace window.
class IdentityScreen extends StatefulWidget {
  const IdentityScreen({super.key});
  @override
  State<IdentityScreen> createState() => _IdentityScreenState();
}

class _IdentityScreenState extends State<IdentityScreen> {
  IdentityStatus? _status;
  LadderState? _ladder;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    Analytics.capture('identity_hub_viewed');
    _refresh();
  }

  Future<void> _refresh() async {
    final st = await IdentityApi.status();
    final ld = await LadderApi.level();
    if (!mounted) return;
    setState(() {
      _status = st;
      _ladder = ld;
      _loading = false;
    });
  }

  bool get _livenessDone =>
      _ladder?.proofs['liveness'] == 'verified' || _status?.verified == true;
  bool get _stripeDone =>
      _ladder?.proofs['stripe_kyc'] == 'verified' ||
      (_status?.verified == true && _status?.provider == 'stripe_identity');

  Future<void> _startLiveness() async {
    final ok = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (_) => const LivenessCheckScreen()));
    if (ok == true) {
      await _refresh();
    } else if (mounted) {
      // Workers AI flow unavailable (flag off / camera) → offer the Stripe path.
      await _startStripe();
    }
  }

  Future<void> _startStripe() async {
    final ok = await IdentityGate.ensureVerified(context, reason: 'unlock verified features');
    if (ok) await _refresh();
  }

  Future<void> _changeEmail() async {
    final emailCtrl = TextEditingController();
    final codeCtrl = TextEditingController();
    var sent = false;
    String? err;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx, setS) {
        Future<void> send() async {
          final r = await ApiAuth.postJson(kEmailOtpStartUrl, {'email': emailCtrl.text.trim()});
          setS(() {
            sent = r.statusCode == 200;
            err = sent ? null : 'Could not send the code — check the address.';
          });
        }

        Future<void> verify() async {
          final r = await ApiAuth.postJson(
              kEmailOtpVerifyUrl, {'email': emailCtrl.text.trim(), 'code': codeCtrl.text.trim()});
          if (r.statusCode == 200) {
            if (ctx.mounted) Navigator.of(ctx).pop();
            await _refresh();
          } else {
            setS(() => err = 'Incorrect or expired code.');
          }
        }

        return AlertDialog(
          title: const Text('Change email'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: emailCtrl,
              enabled: !sent,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'New email address'),
            ),
            if (sent) ...[
              const SizedBox(height: 12),
              TextField(
                controller: codeCtrl,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: '6-digit code from your inbox'),
              ),
            ],
            if (err != null) ...[
              const SizedBox(height: 8),
              Text(err!, style: TextStyle(color: Theme.of(ctx).colorScheme.error, fontSize: 13)),
            ],
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Cancel')),
            FilledButton(onPressed: sent ? verify : send, child: Text(sent ? 'Verify' : 'Send code')),
          ],
        );
      }),
    );
  }

  Future<void> _changePhone() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: const Padding(padding: EdgeInsets.all(16), child: PhoneVerifyCard()),
      ),
    );
    await _refresh();
  }

  Future<void> _deleteAccount() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete your account?'),
        content: const Text(
          'This wipes EVERYTHING after a 30-day grace period: your profile, '
          'messages, wallet, listings — and your identity verifications, '
          'including the liveness photo and all KYC records. Verification '
          'media cannot be deleted any other way.\n\n'
          'You can cancel within 30 days by signing back in.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Keep my account')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Delete everything'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final r = await ApiAuth.postJson(kAccountDeleteUrl, const {});
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(r.statusCode == 200
            ? 'Deletion scheduled — everything is wiped in 30 days.'
            : 'Could not schedule deletion — try again.')));
    Analytics.capture('account_deletion_from_identity_hub', {'ok': r.statusCode == 200});
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final level = _ladder?.level ?? 1;
    return Scaffold(
      appBar: AppBar(title: const Text('AvaIdentity')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(padding: const EdgeInsets.all(20), children: [
                // ── Level card ────────────────────────────────────────────
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: AvaColors.brand.withValues(alpha: .08),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: AvaColors.brand.withValues(alpha: .3)),
                  ),
                  child: Row(children: [
                    const Icon(Icons.shield_outlined, size: 40, color: AvaColors.brand),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Trust level $level',
                            style: Theme.of(context)
                                .textTheme
                                .titleMedium
                                ?.copyWith(fontWeight: FontWeight.w800)),
                        Text(
                          level >= 3
                              ? 'Fully verified — payouts unlocked.'
                              : level == 2
                                  ? 'Verified human — creator features unlocked.'
                                  : 'Member — verify to unlock creator features.',
                          style: TextStyle(color: cs.onSurfaceVariant, fontSize: 13),
                        ),
                      ]),
                    ),
                  ]),
                ),
                const SizedBox(height: 20),

                // ── The ladder ────────────────────────────────────────────
                Text('Your identity',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                _tick(true, Icons.alternate_email, 'Handle', 'Your unique @handle', null),
                _tick(true, Icons.email_outlined, 'Email & password',
                    'Tap to change your email (OTP re-verify)', _changeEmail),
                _tick(_ladder?.proofs['phone'] == 'verified', Icons.sms_outlined, 'Phone',
                    'Real SIM numbers only — temp/VoIP numbers are rejected', _changePhone),
                _tick(
                    _livenessDone,
                    Icons.video_camera_front_outlined,
                    'Video liveness',
                    _livenessDone
                        ? 'Verified — cannot be removed (delete account to erase)'
                        : 'A 5–10 s selfie clip with random gestures',
                    _livenessDone ? null : _startLiveness),
                _tick(
                    _stripeDone,
                    Icons.badge_outlined,
                    'Document KYC (Stripe)',
                    _stripeDone
                        ? 'Verified by Stripe — cannot be removed (delete account to erase)'
                        : 'Government ID + selfie match — required for payouts',
                    _stripeDone ? null : _startStripe),
                const SizedBox(height: 20),

                // ── Account actions ───────────────────────────────────────
                Text('Account',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.person_outline),
                  title: const Text('Profile & photo'),
                  subtitle: const Text('Display name, bio, profile picture'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const ProfileScreen()))
                      .then((_) => _refresh()),
                ),
                const ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.password_outlined),
                  title: Text('Password'),
                  subtitle: Text(
                      'Managed securely by sign-in — use "Forgot password" at sign-in to change it'),
                ),
                const Divider(height: 32),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.delete_forever_outlined, color: cs.error),
                  title: Text('Delete account', style: TextStyle(color: cs.error)),
                  subtitle: const Text('Wipes everything — including verification media'),
                  onTap: _deleteAccount,
                ),
                const SizedBox(height: 24),
              ]),
      ),
    );
  }

  Widget _tick(bool done, IconData icon, String title, String subtitle, VoidCallback? onTap) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: done ? const Color(0xFF10B981) : null),
      title: Row(children: [
        Flexible(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w600))),
        const SizedBox(width: 6),
        if (done) const Icon(Icons.check_circle, size: 18, color: Color(0xFF10B981)),
      ]),
      subtitle: Text(subtitle, style: const TextStyle(fontSize: 12.5)),
      trailing: onTap != null ? const Icon(Icons.chevron_right) : null,
      onTap: onTap,
    );
  }
}
