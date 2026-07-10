import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../profile/profile_screen.dart';
import 'identity_api.dart';
import 'identity_gate.dart';       // Stripe KYC (payouts) — a DIFFERENT gate
import 'ladder_api.dart';
import 'public_action_gate.dart';  // [AVA-IDGATE-1] liveness gate + BIPA consent

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
    // [AVA-IDGATE-1] Didit is the ONLY liveness path. The V1/V2/V3 fallbacks are
    // gone: their Worker routes now return 410, and each of them called
    // setVerifiedCache(uid,true) — i.e. each was a door that could mark a user
    // verified with no liveness check running at all.
    //
    // Goes through ensurePublicActionAllowed so the BIPA consent screen (§10.4) is
    // shown before the camera. The Worker independently 403s a capture session
    // without recorded consent, so this is belt-and-braces, not the only guard.
    final ok = await ensurePublicActionAllowed(context, 'identity_hub');
    if (ok) await _refresh();
    // NOTE: we no longer silently fall through to the Stripe document flow on
    // cancel. Stripe KYC is the PAYOUT tier (a separate project) and pushing a
    // user into a government-ID upload because they closed a camera screen was
    // never the right escalation.
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
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text('Change email', style: ZineText.cardTitle()),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineField(
              controller: emailCtrl,
              enabled: !sent,
              label: 'New email address',
              keyboardType: TextInputType.emailAddress,
            ),
            if (sent) ...[
              const SizedBox(height: 14),
              ZineField(
                controller: codeCtrl,
                label: '6-digit code from your inbox',
                keyboardType: TextInputType.number,
              ),
            ],
            if (err != null) ZineErrorMsg(err!),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(),
                child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft))),
            ZineButton(label: sent ? 'Verify' : 'Send code', variant: ZineButtonVariant.blue,
                fontSize: 15, onPressed: sent ? verify : send),
          ],
        );
      }),
    );
  }

  // [AVA-IDGATE-1] _changePhone() removed with the Phone rung. Phone verification
  // no longer exists anywhere in the app.

  Future<void> _deleteAccount() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Delete your account?', style: ZineText.cardTitle()),
        content: Text(
          'This wipes EVERYTHING after a 30-day grace period: your profile, '
          'messages, wallet, listings — and your identity verifications, '
          'including the liveness photo and all KYC records. Verification '
          'media cannot be deleted any other way.\n\n'
          'You can cancel within 30 days by signing back in.',
          style: ZineText.sub(size: 14),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false),
              child: Text('Keep my account', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(label: 'Delete everything', variant: ZineButtonVariant.coral,
              fontSize: 15, onPressed: () => Navigator.of(ctx).pop(true)),
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
    final level = _ladder?.level ?? 1;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'AvaIdentity', markWord: 'Identity', tag: 'trust ladder'),
      body: RefreshIndicator(
        onRefresh: _refresh,
        color: Zine.blueInk,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
            : ListView(padding: const EdgeInsets.all(20), children: [
                // ── Level card ────────────────────────────────────────────
                ZineCard(
                  color: Zine.blue,
                  padding: const EdgeInsets.all(18),
                  boxShadow: Zine.shadow,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold),
                          color: Zine.card, size: 42),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('Trust level $level', style: ZineText.cardTitle(size: 21)),
                          const SizedBox(height: 3),
                          Text(
                            level >= 3
                                ? 'Fully verified — payouts unlocked.'
                                : level == 2
                                    ? 'Verified human — creator features unlocked.'
                                    : 'Member — verify to unlock creator features.',
                            style: ZineText.sub(size: 13, color: Zine.ink),
                          ),
                        ]),
                      ),
                    ]),
                    const SizedBox(height: 14),
                    ZineStepPips(total: 3, active: level.clamp(1, 3).toInt()),
                  ]),
                ),
                const SizedBox(height: 22),

                // ── The ladder ────────────────────────────────────────────
                Text('YOUR IDENTITY', style: ZineText.kicker(size: 11.5)),
                const SizedBox(height: 10),
                _tick(true, PhosphorIcons.at(PhosphorIconsStyle.bold), Zine.lime,
                    'Handle', 'Your unique @handle', null),
                _tick(true, PhosphorIcons.envelope(PhosphorIconsStyle.bold), Zine.blue,
                    'Email & password', 'Tap to change your email (OTP re-verify)', _changeEmail),
                // [AVA-IDGATE-1] The 'Phone' rung is GONE. All phone verification was
                // removed 2026-07-10: a number proves nothing about identity in the
                // ~85 territories with no SIM registration, cost real money in SMS,
                // and no private company can trace a number to a person anywhere.
                // The optional PERSONAL phone number in Profile is unrelated — it is
                // unverified contact data and never a gate.
                _tick(
                    _livenessDone,
                    PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                    Zine.coral,
                    'Video verified',
                    _livenessDone
                        ? 'Verified — renewed every 90 days'
                        : 'A few seconds on camera, before you post publicly',
                    _livenessDone ? null : _startLiveness),
                _tick(
                    _stripeDone,
                    PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
                    Zine.mint,
                    'Document KYC (Stripe)',
                    _stripeDone
                        ? 'Verified by Stripe — cannot be removed (delete account to erase)'
                        : 'Government ID + selfie match — required for payouts',
                    _stripeDone ? null : _startStripe),
                const SizedBox(height: 22),

                // ── Account actions ───────────────────────────────────────
                Text('ACCOUNT', style: ZineText.kicker(size: 11.5)),
                const SizedBox(height: 10),
                _row(PhosphorIcons.userCircle(PhosphorIconsStyle.bold), Zine.blue,
                    'Profile & photo', 'Display name, bio, profile picture',
                    () => Navigator.of(context)
                        .push(MaterialPageRoute(builder: (_) => const ProfileScreen()))
                        .then((_) => _refresh())),
                _row(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), Zine.lilac,
                    'Password',
                    'Managed securely by sign-in — use "Forgot password" at sign-in to change it',
                    null),
                const SizedBox(height: 10),
                _row(PhosphorIcons.trash(PhosphorIconsStyle.bold), Zine.coral,
                    'Delete account', 'Wipes everything — including verification media',
                    _deleteAccount, danger: true),
                const SizedBox(height: 24),
              ]),
      ),
    );
  }

  /// Trust Ladder rung — zine card with a status sticker (current = ok lime,
  /// pending/locked = hint).
  Widget _tick(bool done, IconData icon, Color accent, String title, String subtitle, VoidCallback? onTap) {
    final body = Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ZineIconBadge(icon: icon, color: accent, size: 38),
      const SizedBox(width: 12),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(title, style: ZineText.cardTitle(size: 16))),
          const SizedBox(width: 6),
          done
              ? ZineSticker('done', kind: ZineStickerKind.ok,
                  icon: PhosphorIcons.check(PhosphorIconsStyle.bold))
              : const ZineSticker('to do', kind: ZineStickerKind.hint),
        ]),
        const SizedBox(height: 4),
        Text(subtitle, style: ZineText.sub(size: 12.5)),
      ])),
    ]);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: onTap == null
          ? ZineCard(radius: Zine.rSm, padding: const EdgeInsets.all(13),
              boxShadow: Zine.shadowXs, child: body)
          : ZinePressable(
              onTap: onTap,
              radius: BorderRadius.circular(Zine.rSm),
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.all(13),
              child: body,
            ),
    );
  }

  Widget _row(IconData icon, Color accent, String title, String subtitle, VoidCallback? onTap,
      {bool danger = false}) {
    final body = Row(children: [
      ZineIconBadge(icon: icon, color: accent, size: 34),
      const SizedBox(width: 12),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: ZineText.value(size: 15, color: danger ? Zine.coral : Zine.ink)),
        const SizedBox(height: 2),
        Text(subtitle, style: ZineText.sub(size: 12)),
      ])),
      if (onTap != null)
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
    ]);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: onTap == null
          ? ZineCard(radius: Zine.rSm, padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              boxShadow: Zine.shadowXs, child: body)
          : ZinePressable(
              onTap: onTap,
              radius: BorderRadius.circular(Zine.rSm),
              boxShadow: Zine.shadowXs,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: body,
            ),
    );
  }
}
