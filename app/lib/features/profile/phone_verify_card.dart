import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/analytics.dart';
import '../../core/profile_store.dart';
import '../../core/theme.dart';
import '../../core/verification_api.dart';

/// Phone verification card for the Profile screen — for users who skipped phone
/// at onboarding. Firebase sends/checks the SMS OTP; on success we tell the
/// backend (VerificationApi.confirmPhone) and store the number locally.
class PhoneVerifyCard extends StatefulWidget {
  const PhoneVerifyCard({super.key});
  @override
  State<PhoneVerifyCard> createState() => _PhoneVerifyCardState();
}

class _PhoneVerifyCardState extends State<PhoneVerifyCard> {
  static const _screen = 'profile_phone_verify';
  final _store = ProfileStore();
  final _phoneCtrl = TextEditingController(text: '+');
  final _codeCtrl = TextEditingController();
  String? _verificationId;
  bool _sending = false, _codeSent = false, _verifying = false, _verified = false;
  int _attempts = 0, _resends = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    _store.load().then((p) {
      if (mounted && p.phone.isNotEmpty) setState(() => _phoneCtrl.text = p.phone);
    });
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    super.dispose();
  }

  Future<void> _send({bool resend = false}) async {
    final phone = _phoneCtrl.text.trim();
    if (phone.replaceAll(RegExp(r'[^0-9]'), '').length < 8) {
      setState(() => _error = 'Enter your number with country code, e.g. +234…');
      return;
    }
    setState(() { _sending = true; _error = null; });
    if (resend) { _resends++; Analytics.capture('otp_resend_tapped', {'resend_count': _resends, 'source': 'profile'}); }
    Analytics.capture('otp_requested', {'channel': 'sms', 'source': 'profile'});
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: phone,
        timeout: const Duration(seconds: 60),
        verificationCompleted: (PhoneAuthCredential cred) async {
          try {
            await FirebaseAuth.instance.signInWithCredential(cred);
            await _onVerified(auto: true);
          } catch (_) {}
        },
        verificationFailed: (FirebaseAuthException e) {
          if (!mounted) return;
          setState(() { _sending = false; _error = _friendlySend(e.code); });
          Analytics.error(domain: 'otp', code: 'otp_send_failed', message: e.code, screen: _screen, action: 'send', extra: {'reason': e.code});
        },
        codeSent: (String verId, int? _) {
          if (!mounted) return;
          setState(() { _sending = false; _codeSent = true; _verificationId = verId; });
          Analytics.capture('otp_sent', {'provider': 'firebase', 'source': 'profile'});
        },
        codeAutoRetrievalTimeout: (String verId) => _verificationId = verId,
      );
    } catch (e) {
      if (!mounted) return;
      setState(() { _sending = false; _error = 'Could not send the code — please try again.'; });
      Analytics.error(domain: 'otp', code: 'otp_send_exception', message: e.toString(), screen: _screen, action: 'send');
    }
  }

  Future<void> _verify() async {
    final id = _verificationId;
    final code = _codeCtrl.text.trim();
    if (id == null || code.length < 6) return;
    setState(() { _verifying = true; _error = null; _attempts++; });
    Analytics.capture('otp_code_submitted', {'attempt': _attempts, 'source': 'profile'});
    try {
      await FirebaseAuth.instance.signInWithCredential(
          PhoneAuthProvider.credential(verificationId: id, smsCode: code));
      await _onVerified();
    } on FirebaseAuthException catch (e) {
      if (!mounted) return;
      setState(() { _verifying = false; _error = _friendlyVerify(e.code); });
      Analytics.error(domain: 'otp', code: 'otp_verify_failed', message: e.code, screen: _screen, action: 'verify', extra: {'reason': e.code});
    } catch (e) {
      if (!mounted) return;
      setState(() { _verifying = false; _error = 'Verification failed — please try again.'; });
      Analytics.error(domain: 'otp', code: 'otp_verify_exception', message: e.toString(), screen: _screen, action: 'verify');
    }
  }

  Future<void> _onVerified({bool auto = false}) async {
    Analytics.capture('phone_verification_completed', {'auto': auto, 'attempts_used': _attempts, 'source': 'profile'});
    await VerificationApi.confirmPhone(_phoneCtrl.text.trim());
    await _store.setPhone(_phoneCtrl.text.trim());
    try { await FirebaseAuth.instance.signOut(); } catch (_) {}
    if (!mounted) return;
    setState(() { _verified = true; _verifying = false; });
  }

  String _friendlySend(String c) => switch (c) {
        'invalid-phone-number' => 'That phone number looks invalid — check the country code.',
        'too-many-requests' => 'Too many attempts. Please wait a bit and try again.',
        'operation-not-allowed' => 'Phone sign-in is being enabled — please try again shortly.',
        'quota-exceeded' => 'SMS is temporarily unavailable — try again shortly.',
        _ => 'Could not send the code — please try again.',
      };
  String _friendlyVerify(String c) => switch (c) {
        'invalid-verification-code' => 'That code is incorrect. Check and try again.',
        'session-expired' => 'The code expired — tap Resend to get a new one.',
        _ => 'Verification failed — please try again.',
      };

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AvaColors.soft,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _verified ? AvaColors.success : Colors.transparent, width: 1.4),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Icon(Icons.phone_outlined, size: 16, color: AvaColors.brand),
          const SizedBox(width: 6),
          const Text('Phone number', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
          const Spacer(),
          if (_verified)
            Row(children: const [
              Icon(Icons.check_circle, size: 16, color: AvaColors.success),
              SizedBox(width: 4),
              Text('Verified', style: TextStyle(color: AvaColors.success, fontSize: 12.5, fontWeight: FontWeight.w700)),
            ]),
        ]),
        const SizedBox(height: 10),
        if (_verified)
          Row(children: [
            const Icon(Icons.check_circle, size: 18, color: AvaColors.success),
            const SizedBox(width: 8),
            Expanded(child: Text(_phoneCtrl.text.trim(), style: const TextStyle(fontWeight: FontWeight.w600))),
          ])
        else ...[
          _field(_phoneCtrl, '+234 800 000 0000', Icons.phone_outlined, TextInputType.phone, enabled: !_codeSent),
          if (!_codeSent) ...[
            const SizedBox(height: 10),
            _btn(_sending ? 'Sending…' : 'Send code', _sending ? null : _send),
          ] else ...[
            const SizedBox(height: 10),
            _field(_codeCtrl, '6-digit code', Icons.sms_outlined, TextInputType.number,
                formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)]),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: _btn(_verifying ? 'Verifying…' : 'Verify', _verifying ? null : _verify)),
              const SizedBox(width: 10),
              TextButton(onPressed: _sending ? null : () => _send(resend: true), child: const Text('Resend')),
            ]),
          ],
          if (_error != null)
            Padding(padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 12.5))),
        ],
      ]),
    );
  }

  Widget _field(TextEditingController c, String hint, IconData icon, TextInputType kb,
      {List<TextInputFormatter>? formatters, bool enabled = true}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Icon(icon, size: 18, color: const Color(0xFF9AA1AC)),
        const SizedBox(width: 8),
        Expanded(child: TextField(
          controller: c, enabled: enabled, keyboardType: kb, inputFormatters: formatters,
          decoration: const InputDecoration(border: InputBorder.none, isDense: true,
              contentPadding: EdgeInsets.symmetric(vertical: 13)),
        )),
      ]),
    );
  }

  Widget _btn(String text, VoidCallback? onTap) => SizedBox(
        width: double.infinity,
        child: FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 13)),
          onPressed: onTap, child: Text(text),
        ),
      );
}
