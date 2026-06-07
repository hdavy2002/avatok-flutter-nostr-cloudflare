import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/analytics.dart';
import '../../core/theme.dart';
import '../../core/verification_api.dart';

/// Data collected on the verification step.
class VerifyData {
  final String ageGroup;
  final String gender;
  final String phone; // E.164, '' if skipped
  final bool phoneVerified;
  final String email;
  final bool emailVerified;
  const VerifyData({
    required this.ageGroup,
    required this.gender,
    required this.phone,
    required this.phoneVerified,
    required this.email,
    required this.emailVerified,
  });
}

/// Onboarding step: collect age group + gender, verify a phone number via
/// Firebase phone OTP, and verify an email via a backend OTP. Every action and
/// failure is sent to PostHog (`screen=verify_identity`) so we can see exactly
/// where users get stuck — especially OTP and email verification errors.
class VerifyIdentityStep extends StatefulWidget {
  final String? initialEmail;
  final ValueChanged<VerifyData> onComplete;
  const VerifyIdentityStep({super.key, this.initialEmail, required this.onComplete});

  @override
  State<VerifyIdentityStep> createState() => _VerifyIdentityStepState();
}

class _VerifyIdentityStepState extends State<VerifyIdentityStep> {
  static const _screen = 'verify_identity';
  static const _ageGroups = ['Under 18', '18–24', '25–34', '35–44', '45–54', '55–64', '65+'];
  static const _genders = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];

  String? _ageGroup;
  String? _gender;

  // ---- phone (Firebase OTP) ----
  final _phoneCtrl = TextEditingController(text: '+');
  final _phoneCodeCtrl = TextEditingController();
  String? _verificationId;
  bool _phoneSending = false;
  bool _phoneCodeSent = false;
  bool _phoneVerifying = false;
  bool _phoneVerified = false;
  int _phoneAttempts = 0;
  int _phoneResends = 0;
  String? _phoneError;

  // ---- email (backend OTP) ----
  final _emailCtrl = TextEditingController();
  final _emailCodeCtrl = TextEditingController();
  bool _emailSending = false;
  bool _emailCodeSent = false;
  bool _emailVerifying = false;
  bool _emailVerified = false;
  int _emailResends = 0;
  String? _emailError;

  @override
  void initState() {
    super.initState();
    if (widget.initialEmail != null) _emailCtrl.text = widget.initialEmail!;
    Analytics.screen(_screen);
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _phoneCodeCtrl.dispose();
    _emailCtrl.dispose();
    _emailCodeCtrl.dispose();
    super.dispose();
  }

  bool get _ready => _ageGroup != null && _gender != null && _phoneVerified && _emailVerified;

  // ───────────────────────── phone ─────────────────────────

  Future<void> _sendPhoneCode({bool resend = false}) async {
    final phone = _phoneCtrl.text.trim();
    if (phone.replaceAll(RegExp(r'[^0-9]'), '').length < 8) {
      setState(() => _phoneError = 'Enter your number with country code, e.g. +234…');
      return;
    }
    setState(() {
      _phoneSending = true;
      _phoneError = null;
    });
    if (resend) {
      _phoneResends++;
      Analytics.capture('otp_resend_tapped', {'resend_count': _phoneResends});
    }
    Analytics.capture('otp_requested', {'channel': 'sms'});
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: phone,
        timeout: const Duration(seconds: 60),
        verificationCompleted: (PhoneAuthCredential cred) async {
          // Android instant / auto-retrieval — sign in then mark verified.
          try {
            await FirebaseAuth.instance.signInWithCredential(cred);
            await _onPhoneVerified(auto: true);
          } catch (_) {/* fall back to manual code entry */}
        },
        verificationFailed: (FirebaseAuthException e) {
          if (!mounted) return;
          setState(() {
            _phoneSending = false;
            _phoneError = _friendlyPhoneSend(e.code);
          });
          Analytics.error(
            domain: 'otp',
            code: 'otp_send_failed',
            message: e.code,
            screen: _screen,
            action: 'send',
            extra: {'reason': e.code},
          );
        },
        codeSent: (String verId, int? _) {
          if (!mounted) return;
          setState(() {
            _phoneSending = false;
            _phoneCodeSent = true;
            _verificationId = verId;
          });
          Analytics.capture('otp_sent', {'provider': 'firebase'});
        },
        codeAutoRetrievalTimeout: (String verId) {
          _verificationId = verId;
        },
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phoneSending = false;
        _phoneError = 'Could not send the code — please try again.';
      });
      Analytics.error(
        domain: 'otp',
        code: 'otp_send_exception',
        message: e.toString(),
        screen: _screen,
        action: 'send',
      );
    }
  }

  Future<void> _verifyPhoneCode() async {
    final id = _verificationId;
    final code = _phoneCodeCtrl.text.trim();
    if (id == null || code.length < 6) return;
    setState(() {
      _phoneVerifying = true;
      _phoneError = null;
      _phoneAttempts++;
    });
    Analytics.capture('otp_code_submitted', {'attempt': _phoneAttempts});
    try {
      final cred = PhoneAuthProvider.credential(verificationId: id, smsCode: code);
      await FirebaseAuth.instance.signInWithCredential(cred);
      await _onPhoneVerified();
    } on FirebaseAuthException catch (e) {
      if (!mounted) return;
      setState(() {
        _phoneVerifying = false;
        _phoneError = _friendlyPhoneVerify(e.code);
      });
      Analytics.error(
        domain: 'otp',
        code: 'otp_verify_failed',
        message: e.code,
        screen: _screen,
        action: 'verify',
        extra: {'reason': e.code, 'attempt': _phoneAttempts},
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phoneVerifying = false;
        _phoneError = 'Verification failed — please try again.';
      });
      Analytics.error(
        domain: 'otp',
        code: 'otp_verify_exception',
        message: e.toString(),
        screen: _screen,
        action: 'verify',
      );
    }
  }

  Future<void> _onPhoneVerified({bool auto = false}) async {
    Analytics.capture('phone_verification_completed', {'auto': auto, 'attempts_used': _phoneAttempts});
    // Tell the backend the number is confirmed (best-effort).
    final res = await VerificationApi.confirmPhone(_phoneCtrl.text.trim());
    if (!res.ok) {
      Analytics.error(
        domain: 'otp',
        code: 'phone_confirm_backend_failed',
        message: res.message ?? 'status ${res.status}',
        screen: _screen,
        action: 'confirm',
        extra: {'status': res.status},
      );
    }
    // Firebase phone sign-in is only used to prove ownership — the real session
    // is Clerk + Nostr, so drop the Firebase user to avoid confusion.
    try {
      await FirebaseAuth.instance.signOut();
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _phoneVerified = true;
      _phoneVerifying = false;
    });
  }

  String _friendlyPhoneSend(String code) {
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

  String _friendlyPhoneVerify(String code) {
    switch (code) {
      case 'invalid-verification-code':
        return 'That code is incorrect. Check and try again.';
      case 'session-expired':
        return 'The code expired — tap Resend to get a new one.';
      default:
        return 'Verification failed — please try again.';
    }
  }

  // ───────────────────────── email ─────────────────────────

  Future<void> _sendEmailOtp({bool resend = false}) async {
    final email = _emailCtrl.text.trim();
    if (!email.contains('@') || !email.contains('.')) {
      setState(() => _emailError = 'Enter a valid email address.');
      return;
    }
    setState(() {
      _emailSending = true;
      _emailError = null;
    });
    if (resend) {
      _emailResends++;
      Analytics.capture('email_verification_resend_tapped', {'resend_count': _emailResends});
    }
    final res = await VerificationApi.sendEmailOtp(email);
    if (!mounted) return;
    if (res.ok) {
      setState(() {
        _emailSending = false;
        _emailCodeSent = true;
      });
      Analytics.capture('email_verification_sent', const {});
    } else {
      setState(() {
        _emailSending = false;
        _emailError = res.message ?? 'Could not send the email — please try again.';
      });
      Analytics.error(
        domain: 'email_verification',
        code: 'email_send_failed',
        message: res.message ?? 'status ${res.status}',
        screen: _screen,
        action: 'send',
        extra: {'status': res.status},
      );
    }
  }

  Future<void> _verifyEmailOtp() async {
    final code = _emailCodeCtrl.text.trim();
    if (code.length < 4) return;
    setState(() {
      _emailVerifying = true;
      _emailError = null;
    });
    Analytics.capture('email_verification_submitted', const {});
    final res = await VerificationApi.verifyEmailOtp(_emailCtrl.text.trim(), code);
    if (!mounted) return;
    if (res.ok) {
      setState(() {
        _emailVerified = true;
        _emailVerifying = false;
      });
      Analytics.capture('email_verified', const {});
    } else {
      setState(() {
        _emailVerifying = false;
        _emailError = res.status == 400
            ? 'That code is incorrect or expired.'
            : (res.message ?? 'Verification failed — please try again.');
      });
      Analytics.error(
        domain: 'email_verification',
        code: 'email_verify_failed',
        message: res.message ?? 'status ${res.status}',
        screen: _screen,
        action: 'verify',
        extra: {'status': res.status},
      );
    }
  }

  // ───────────────────────── build ─────────────────────────

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(28, 12, 28, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _iconTile(Icons.verified_user_outlined),
                const SizedBox(height: 16),
                Text('Verify it\'s you',
                    style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 28)),
                const SizedBox(height: 6),
                const Text(
                    'A few quick details keep AvaTOK safe for everyone. We verify your '
                    'phone and email, and never share them.',
                    style: TextStyle(color: AvaColors.sub, fontSize: 14, height: 1.5)),
                const SizedBox(height: 22),

                _label('Age group'),
                const SizedBox(height: 8),
                _chips(_ageGroups, _ageGroup, (v) {
                  setState(() => _ageGroup = v);
                  Analytics.capture('onboarding_age_provided', {'age_group': v});
                }),
                if (_ageGroup == 'Under 18')
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text(
                        'Under-18 accounts may need a parent to set things up.',
                        style: TextStyle(color: AvaColors.sub, fontSize: 12)),
                  ),
                const SizedBox(height: 20),

                _label('Gender'),
                const SizedBox(height: 8),
                _chips(_genders, _gender, (v) {
                  setState(() => _gender = v);
                  Analytics.capture('onboarding_gender_provided', {'gender': v});
                }),
                const SizedBox(height: 24),

                _verifyCard(
                  title: 'Phone number',
                  verified: _phoneVerified,
                  child: _phoneSection(),
                ),
                const SizedBox(height: 16),
                _verifyCard(
                  title: 'Email address',
                  verified: _emailVerified,
                  child: _emailSection(),
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: _ready
                  ? () => widget.onComplete(VerifyData(
                        ageGroup: _ageGroup!,
                        gender: _gender!,
                        phone: _phoneCtrl.text.trim(),
                        phoneVerified: _phoneVerified,
                        email: _emailCtrl.text.trim(),
                        emailVerified: _emailVerified,
                      ))
                  : null,
              child: const Text('Continue'),
            ),
          ),
        ),
      ],
    );
  }

  Widget _phoneSection() {
    if (_phoneVerified) return _verifiedRow(_phoneCtrl.text.trim());
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _field(
        controller: _phoneCtrl,
        hint: '+234 800 000 0000',
        icon: Icons.phone_outlined,
        keyboardType: TextInputType.phone,
        enabled: !_phoneCodeSent,
      ),
      if (!_phoneCodeSent) ...[
        const SizedBox(height: 10),
        _secondary(_phoneSending ? 'Sending…' : 'Send code', _phoneSending ? null : _sendPhoneCode),
      ] else ...[
        const SizedBox(height: 10),
        _field(
          controller: _phoneCodeCtrl,
          hint: '6-digit code',
          icon: Icons.sms_outlined,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: _secondary(_phoneVerifying ? 'Verifying…' : 'Verify', _phoneVerifying ? null : _verifyPhoneCode),
          ),
          const SizedBox(width: 10),
          TextButton(
            onPressed: _phoneSending ? null : () => _sendPhoneCode(resend: true),
            child: const Text('Resend'),
          ),
        ]),
      ],
      if (_phoneError != null) _errorText(_phoneError!),
    ]);
  }

  Widget _emailSection() {
    if (_emailVerified) return _verifiedRow(_emailCtrl.text.trim());
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _field(
        controller: _emailCtrl,
        hint: 'you@example.com',
        icon: Icons.mail_outline,
        keyboardType: TextInputType.emailAddress,
        enabled: !_emailCodeSent,
      ),
      if (!_emailCodeSent) ...[
        const SizedBox(height: 10),
        _secondary(_emailSending ? 'Sending…' : 'Send code', _emailSending ? null : _sendEmailOtp),
      ] else ...[
        const SizedBox(height: 10),
        _field(
          controller: _emailCodeCtrl,
          hint: 'code from your inbox',
          icon: Icons.confirmation_number_outlined,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(8)],
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: _secondary(_emailVerifying ? 'Verifying…' : 'Verify', _emailVerifying ? null : _verifyEmailOtp),
          ),
          const SizedBox(width: 10),
          TextButton(
            onPressed: _emailSending ? null : () => _sendEmailOtp(resend: true),
            child: const Text('Resend'),
          ),
        ]),
      ],
      if (_emailError != null) _errorText(_emailError!),
    ]);
  }

  // ───────────────────────── shared UI ─────────────────────────

  Widget _label(String t) => Text(t, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13));

  Widget _chips(List<String> options, String? selected, ValueChanged<String> onPick) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: options.map((o) {
          final on = o == selected;
          return GestureDetector(
            onTap: () => onPick(o),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              decoration: BoxDecoration(
                color: on ? AvaColors.brand.withValues(alpha: 0.10) : AvaColors.soft,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: on ? AvaColors.brand : Colors.transparent, width: 1.4),
              ),
              child: Text(o,
                  style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                      color: on ? AvaColors.brand : AvaColors.ink)),
            ),
          );
        }).toList(),
      );

  Widget _verifyCard({required String title, required bool verified, required Widget child}) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AvaColors.soft,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: verified ? AvaColors.success : Colors.transparent, width: 1.4),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
            const Spacer(),
            if (verified)
              Row(children: const [
                Icon(Icons.check_circle, size: 16, color: AvaColors.success),
                SizedBox(width: 4),
                Text('Verified',
                    style: TextStyle(color: AvaColors.success, fontSize: 12.5, fontWeight: FontWeight.w700)),
              ]),
          ]),
          const SizedBox(height: 12),
          child,
        ]),
      );

  Widget _verifiedRow(String value) => Row(children: [
        const Icon(Icons.check_circle, size: 18, color: AvaColors.success),
        const SizedBox(width: 8),
        Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w600))),
      ]);

  Widget _field({
    required TextEditingController controller,
    required String hint,
    required IconData icon,
    TextInputType? keyboardType,
    List<TextInputFormatter>? inputFormatters,
    bool enabled = true,
  }) =>
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
        child: Row(children: [
          Icon(icon, size: 18, color: const Color(0xFF9AA1AC)),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              enabled: enabled,
              keyboardType: keyboardType,
              inputFormatters: inputFormatters,
              decoration: InputDecoration(
                hintText: hint,
                border: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 13),
                hintStyle: const TextStyle(color: Color(0xFF9AA1AC)),
              ),
            ),
          ),
        ]),
      );

  Widget _secondary(String text, VoidCallback? onTap) => SizedBox(
        width: double.infinity,
        child: FilledButton(
          style: FilledButton.styleFrom(
              backgroundColor: AvaColors.brand, padding: const EdgeInsets.symmetric(vertical: 13)),
          onPressed: onTap,
          child: Text(text),
        ),
      );

  Widget _errorText(String t) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(t, style: const TextStyle(color: AvaColors.danger, fontSize: 12.5)),
      );

  Widget _iconTile(IconData icon) => Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(color: AvaColors.brand50, borderRadius: BorderRadius.circular(16)),
      child: Icon(icon, color: AvaColors.brand, size: 26));
}
