import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/phone_country.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/verification_api.dart';
import 'ladder_api.dart';

/// Standalone PHONE-OTP verification screen (owner decision 2026-07-07).
///
/// Reuses the exact phone-OTP UI/flow that used to live in the onboarding
/// `VerifyIdentityStep` (Firebase `verifyPhoneNumber` → SMS code → verify). It is
/// now the MARKETPLACE "sell" gate: an unverified seller confirms their phone
/// once before creating a listing. On PASS it records the number with the backend
/// (`/api/id/phone/confirm`), which flips the phone proof to 'verified' — turning
/// the phone tick GREEN in the Identity menu — then pops `true`.
///
/// Pops `true` when the phone is verified, `false`/null when the user backs out.
class PhoneVerifyScreen extends StatefulWidget {
  const PhoneVerifyScreen({super.key, this.reason = 'listing'});

  /// Telemetry `source` for the gate (e.g. 'listing').
  final String reason;

  @override
  State<PhoneVerifyScreen> createState() => _PhoneVerifyScreenState();
}

class _PhoneVerifyScreenState extends State<PhoneVerifyScreen> {
  static const _screen = 'phone_verify';

  final _phoneCtrl = TextEditingController(text: '+');
  final _codeCtrl = TextEditingController();
  String? _verificationId;
  bool _sending = false;
  bool _codeSent = false;
  bool _verifying = false;
  int _attempts = 0;
  int _resends = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    Analytics.screen(_screen);
    Analytics.capture('phone_gate_shown', {'source': widget.reason});
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    super.dispose();
  }

  // Country dimensions attached to every OTP event (no raw number stored).
  Map<String, Object> _phoneGeo() {
    final c = PhoneCountry.fromE164(_phoneCtrl.text);
    return {
      if (c.dialCode.isNotEmpty) 'dial_code': c.dialCode,
      'phone_country': c.iso2,
      'phone_country_name': c.name,
    };
  }

  Future<void> _sendCode({bool resend = false}) async {
    final phone = _phoneCtrl.text.trim();
    if (phone.replaceAll(RegExp(r'[^0-9]'), '').length < 8) {
      setState(() => _error = 'Enter your number with country code, e.g. +91…');
      return;
    }
    setState(() {
      _sending = true;
      _error = null;
    });
    if (resend) {
      _resends++;
      Analytics.capture('otp_resend_tapped', {'resend_count': _resends, 'source': widget.reason, ..._phoneGeo()});
    }
    Analytics.capture('otp_requested', {'channel': 'sms', 'source': widget.reason, ..._phoneGeo()});
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: phone,
        timeout: const Duration(seconds: 60),
        verificationCompleted: (PhoneAuthCredential cred) async {
          try {
            await FirebaseAuth.instance.signInWithCredential(cred);
            await _onVerified(auto: true);
          } catch (_) {/* fall back to manual code entry */}
        },
        verificationFailed: (FirebaseAuthException e) {
          if (!mounted) return;
          setState(() {
            _sending = false;
            _error = _friendlySend(e.code);
          });
          // [ISSUE-OTP-DIAG-2] (2026-07-09) Same fix as ISSUE-OTP-DIAG-1, which only
          // covered liveness_v2/phone_stage.dart and left THIS screen (the marketplace
          // listing gate) still logging a bare `e.code`. The Android firebase_auth
          // plugin collapses every error it can't map to code=='unknown', so the
          // listing-gate failures on 2026-07-09 (build 12374, screen 'phone_verify',
          // source 'listing') told us nothing: reason='unknown', message='unknown'.
          // `e.message` carries the real cause (blocked API, attestation failure,
          // quota, bad app-check token, …). Capture it.
          Analytics.error(
            domain: 'otp',
            code: 'otp_send_failed',
            message: '${e.code}: ${e.message ?? "no native message"}',
            screen: _screen,
            action: 'send',
            extra: {
              'reason': e.code,
              if (e.message != null) 'firebase_message': e.message!,
              if (e.plugin.isNotEmpty) 'firebase_plugin': e.plugin,
              'source': widget.reason,
              ..._phoneGeo(),
            },
          );
        },
        codeSent: (String verId, int? _) {
          if (!mounted) return;
          setState(() {
            _sending = false;
            _codeSent = true;
            _verificationId = verId;
          });
          Analytics.capture('otp_sent', {'provider': 'firebase', 'source': widget.reason, ..._phoneGeo()});
        },
        codeAutoRetrievalTimeout: (String verId) {
          _verificationId = verId;
        },
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = 'Could not send the code — please try again.';
      });
      Analytics.error(
        domain: 'otp', code: 'otp_send_exception', message: e.toString(),
        screen: _screen, action: 'send', extra: {'source': widget.reason, ..._phoneGeo()},
      );
    }
  }

  Future<void> _verifyCode() async {
    final id = _verificationId;
    final code = _codeCtrl.text.trim();
    if (id == null || code.length < 6) return;
    setState(() {
      _verifying = true;
      _error = null;
      _attempts++;
    });
    Analytics.capture('otp_code_submitted', {'attempt': _attempts, 'source': widget.reason, ..._phoneGeo()});
    try {
      final cred = PhoneAuthProvider.credential(verificationId: id, smsCode: code);
      await FirebaseAuth.instance.signInWithCredential(cred);
      await _onVerified();
    } on FirebaseAuthException catch (e) {
      if (!mounted) return;
      setState(() {
        _verifying = false;
        _error = _friendlyVerify(e.code);
      });
      Analytics.error(
        domain: 'otp', code: 'otp_verify_failed', message: e.code,
        screen: _screen, action: 'verify',
        extra: {'reason': e.code, 'attempt': _attempts, 'source': widget.reason, ..._phoneGeo()},
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _verifying = false;
        _error = 'Verification failed — please try again.';
      });
      Analytics.error(
        domain: 'otp', code: 'otp_verify_exception', message: e.toString(),
        screen: _screen, action: 'verify', extra: {'source': widget.reason, ..._phoneGeo()},
      );
    }
  }

  Future<void> _onVerified({bool auto = false}) async {
    final geo = _phoneGeo();
    Analytics.capture('phone_verification_completed',
        {'auto': auto, 'attempts_used': _attempts, 'resends': _resends, 'source': widget.reason, ...geo});
    Analytics.setUserKeys(phone: _phoneCtrl.text.trim());
    // Tell the backend the number is confirmed → flips the 'phone' proof to
    // 'verified' (green tick in the Identity menu) and lets the listing publish.
    final res = await VerificationApi.confirmPhone(_phoneCtrl.text.trim());
    if (!res.ok) {
      Analytics.error(
        domain: 'otp', code: 'phone_confirm_backend_failed',
        message: res.message ?? 'status ${res.status}',
        screen: _screen, action: 'confirm', extra: {'status': res.status, 'source': widget.reason},
      );
      if (!mounted) return;
      setState(() {
        _verifying = false;
        _error = res.status == 409
            ? 'This number is already linked to another account.'
            : (res.message ?? 'Could not confirm your number — please try again.');
      });
      return;
    }
    // Refresh the trust-ladder cache so the phone tick turns green immediately.
    await LadderApi.level();
    // Firebase sign-in was only used to prove ownership — the real session is
    // Clerk; drop the Firebase user to avoid confusion.
    try { await FirebaseAuth.instance.signOut(); } catch (_) {}
    if (!mounted) return;
    Navigator.of(context).pop(true);
  }

  String _friendlySend(String code) {
    switch (code) {
      case 'invalid-phone-number':
        return 'That phone number looks invalid — check the country code.';
      case 'too-many-requests':
        return 'Too many attempts. Please wait a bit and try again.';
      case 'quota-exceeded':
        return 'SMS is temporarily unavailable — try again shortly.';
      default:
        return 'Could not send the code — please try again.';
    }
  }

  String _friendlyVerify(String code) {
    switch (code) {
      case 'invalid-verification-code':
        return 'That code is incorrect. Check and try again.';
      case 'session-expired':
        return 'The code expired — tap Resend to get a new one.';
      default:
        return 'Verification failed — please try again.';
    }
  }

  @override
  Widget build(BuildContext context) {
    final hPad = ZineBreakpoints.pagePadding(context);
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper,
        elevation: 0,
        foregroundColor: Zine.ink,
        title: Text('Verify your phone', style: ZineText.cardTitle(size: 18)),
      ),
      body: ZineScrollBody(
        child: Padding(
          padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(
                icon: PhosphorIcons.phone(PhosphorIconsStyle.fill),
                color: Zine.blue, size: 44),
            const SizedBox(height: 16),
            ZineMarkTitle(
                pre: 'Confirm your ', mark: 'number',
                fontSize: 28, textAlign: TextAlign.left),
            const SizedBox(height: 8),
            Text(
                'To keep the marketplace trusted, sellers confirm a real mobile '
                'number before creating a listing. We\'ll text you a 6-digit code. '
                'You only do this once.',
                style: ZineText.sub(size: 14.5)),
            const SizedBox(height: 22),
            _field(
              controller: _phoneCtrl,
              hint: '+91 80000 00000',
              icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
              keyboardType: TextInputType.phone,
              enabled: !_codeSent,
            ),
            if (!_codeSent) ...[
              const SizedBox(height: 12),
              _secondary(_sending ? 'Sending…' : 'Send code', _sending ? null : _sendCode),
            ] else ...[
              const SizedBox(height: 12),
              _field(
                controller: _codeCtrl,
                hint: '6-digit code',
                icon: PhosphorIcons.chatText(PhosphorIconsStyle.bold),
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
              ),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(
                  child: _secondary(_verifying ? 'Verifying…' : 'Verify', _verifying ? null : _verifyCode),
                ),
                const SizedBox(width: 14),
                ZineLink('resend', onTap: _sending ? null : () => _sendCode(resend: true)),
              ]),
            ],
            if (_error != null) ZineErrorMsg(_error!),
          ]),
        ),
      ),
    );
  }

  Widget _field({
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    TextInputType? keyboardType,
    List<TextInputFormatter>? inputFormatters,
    bool enabled = true,
  }) =>
      Container(
        decoration: BoxDecoration(
          color: enabled ? Zine.card : Zine.paper2,
          borderRadius: BorderRadius.circular(Zine.rField),
          border: Zine.border,
          boxShadow: Zine.shadowXs,
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(children: [
          Container(
            width: 46,
            constraints: const BoxConstraints(minHeight: 52),
            decoration: const BoxDecoration(
              color: Zine.lime,
              border: Border(right: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            alignment: Alignment.center,
            child: Icon(icon, size: 20, color: Zine.ink),
          ),
          Expanded(
            child: TextField(
              controller: controller,
              enabled: enabled,
              keyboardType: keyboardType,
              inputFormatters: inputFormatters,
              cursorColor: Zine.blueInk,
              style: ZineText.input(size: 16),
              scrollPadding: const EdgeInsets.all(80),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: ZineText.input(size: 16)
                    .copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
              ),
            ),
          ),
        ]),
      );

  Widget _secondary(String text, VoidCallback? onTap) => ZineButton(
        label: text,
        onPressed: onTap,
        variant: ZineButtonVariant.blue,
        fullWidth: true,
        fontSize: 17,
      );
}
