import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/links.dart';
import '../../../core/router/routes.dart';
import '../../../core/storage/account_storage.dart';
import '../../../core/widgets/widgets.dart';
import '../../auth/ui/identity_header.dart';
import '../data/kyc_api.dart';
import '../data/kyc_models.dart';
import 'aadhaar_verify.dart';
import 'selfie_video.dart';

/// Identity is complete only after both the Aadhaar and video review authorities
/// confirm it. Uploading a video never grants creator or protected-space access.
class IdentityKycScreen extends ConsumerStatefulWidget {
  const IdentityKycScreen({super.key, this.creator = false, this.digiLockerReturn = false});
  final bool creator;
  final bool digiLockerReturn;
  @override
  ConsumerState<IdentityKycScreen> createState() => _IdentityKycScreenState();
}

class _IdentityKycScreenState extends ConsumerState<IdentityKycScreen> {
  int _step = 1;
  bool _loading = true;
  bool _retry = false;
  KycStatus? _status;
  String? _error;
  late final String? _owner;
  bool get _mine => _owner != null && AccountScope.id == _owner;

  @override
  void initState() {
    super.initState(); _owner = AccountScope.id;
    if (widget.digiLockerReturn) _step = 2;
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    if (!_mine) return;
    setState(() { _loading = true; _error = null; });
    try {
      final status = await ref.read(kycApiProvider).status();
      if (!mounted || !_mine) return;
      setState(() {
        _status = status;
        if (status.aadhaarDone) {
          _step = status.selfieStatus == 'none' ? 4 : 8;
        }
      });
    } on ApiError catch (e) { if (mounted && _mine) setState(() => _error = e.userMessage); }
    finally { if (mounted) setState(() => _loading = false); }
  }

  Future<void> _uploaded() async {
    if (!_mine) return;
    setState(() { _step = 8; _retry = false; });
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(sessionProvider);
    if (!_mine) return Scaffold(appBar: AppBar(title: const Text('Identity verification')),
      body: const Center(child: Text('Your account changed. Reopen verification to continue.')));
    final s = _status;
    final approved = s?.aadhaarDone == true && s?.selfieStatus == 'approved';
    final rejected = s?.selfieStatus == 'rejected';
    return Scaffold(appBar: AppBar(title: Text(widget.creator ? 'Creator verification' : 'Identity verification')),
      body: SafeArea(child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 520),
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 32), children: [
          if (_loading) const LinearProgressIndicator(),
          if (_error != null) ...[Text(_error!), HfButton(label: 'Check again', onPressed: _refresh)],
          if (_step == 1) ...[
            IdentityHeader(title: widget.creator ? 'Become an Influencer or Celebrity' : 'Complete your KYC',
              subtitle: 'Verify once to unlock more conversations and protected spaces.', step: 1, total: 8),
            HfCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const ListTile(leading: Icon(Icons.badge_outlined), title: Text('Aadhaar')),
              const ListTile(leading: Icon(Icons.phone_android), title: Text('Phone linked to Aadhaar')),
              const ListTile(leading: Icon(Icons.camera_alt_outlined), title: Text('Camera and microphone')),
              const Text('Usually takes 3–5 minutes. Video approval follows a review.'),
              if (widget.creator) const Padding(padding: EdgeInsets.symmetric(vertical: 12),
                child: Text('Influencer and Celebrity eligibility requires complete identity and video verification. Your category is confirmed by the team after review.')),
              HfButton(label: 'Start verification', onPressed: _loading ? null : () => setState(() => _step = 2)),
              HfButton(label: 'Maybe later', kind: HfButtonKind.secondary, onPressed: () => Navigator.of(context).pop()),
            ])),
          ],
          if (_step == 2 && !_loading) AadhaarVerifyWidget(role: widget.creator ? KycRole.host : KycRole.laneCaller,
            next: widget.creator ? '${Routes.identityKyc}?creator=1' : Routes.identityKyc,
            resumeNow: widget.digiLockerReturn,
            onVerified: (result) {
              if (!_mine) return;
              setState(() {
                _status = KycStatus(aadhaarDone: true, last4: result.last4, gender: result.gender,
                  selfieStatus: _status?.selfieStatus ?? 'none');
                _step = 4;
              });
            }),
          if (_step == 4) ...[
            const IdentityHeader(title: 'Aadhaar verified', subtitle: 'Your identity check is confirmed.', step: 4, total: 8),
            HfCard(child: Column(children: [
              const ListTile(leading: Icon(Icons.check_circle, color: Colors.green), title: Text('Age: 18+ confirmed')),
              if (s?.last4 != null) ListTile(leading: const Icon(Icons.check_circle, color: Colors.green),
                title: Text('Aadhaar ending •••• ${s!.last4}')),
              const ListTile(leading: Icon(Icons.check_circle, color: Colors.green), title: Text('Full number not stored')),
            ])),
            const SizedBox(height: 16),
            HfButton(label: 'Continue to selfie', onPressed: () => setState(() => _step = 5)),
          ],
          if (_step == 5 || _retry) SelfieVideoWidget(onUploaded: () => unawaited(_uploaded())),
          if (_step == 8 && !_retry) ...[
            IdentityHeader(title: approved ? 'KYC complete' : rejected ? 'Please record again' : 'Verification in review',
              subtitle: approved ? 'Identity and video verified.' : rejected ? 'Your video needs another attempt.' : 'Your access opens after approval.', step: 8, total: 8),
            HfCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              ListTile(leading: Icon(approved ? Icons.verified_user : rejected ? Icons.error_outline : Icons.schedule),
                title: Text(approved ? 'Identity verified' : rejected ? 'Review needs a new video' : 'Review pending'),
                subtitle: Text(approved ? 'Your verification can be reused for eligible spaces.'
                  : rejected ? (s?.selfieReason ?? 'Keep your whole face in frame, use brighter light, and say every digit clearly.')
                  : 'You can browse the public marketplace while we check.')),
              if (rejected) HfButton(label: 'Record again', onPressed: () => setState(() => _retry = true)),
              HfButton(label: 'Check status', loading: _loading, onPressed: _refresh),
              HfButton(label: 'Browse marketplace', kind: HfButtonKind.secondary, onPressed: () => context.go(Routes.explore)),
              if (rejected) HfButton(label: 'Get help', kind: HfButtonKind.text, onPressed: () => LinkOpener.instance.site('/help')),
            ])),
          ],
        ])))));
  }
}
