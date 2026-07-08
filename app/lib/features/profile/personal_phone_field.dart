import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/phone_country.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/verification_api.dart';

/// A self-contained "personal phone" field with SMS OTP confirmation (owner
/// request 2026-07-08). This is the user's REAL phone number (distinct from the
/// AvaTOK number, which stays private) — collected on the profile screen, verified
/// with Firebase phone auth, and then LOCKED. Reuses the same Firebase OTP flow as
/// the onboarding verify-identity step.
///
/// On a successful verify it calls [onVerified] with the E.164 number and renders
/// a locked, read-only row. Prefill [initialPhone] (e.g. from Google sign-in) and
/// pass [initiallyVerified] to start locked for a returning user.
class PersonalPhoneField extends StatefulWidget {
  final String initialPhone;
  final bool initiallyVerified;
  final ValueChanged<String> onVerified;
  const PersonalPhoneField({
    super.key,
    this.initialPhone = '',
    this.initiallyVerified = false,
    required this.onVerified,
  });

  @override
  State<PersonalPhoneField> createState() => _PersonalPhoneFieldState();
}

class _PersonalPhoneFieldState extends State<PersonalPhoneField> {
  static const _screen = 'profile_personal_phone';
  late final TextEditingController _phoneCtrl;
  final _codeCtrl = TextEditingController();

  String? _verificationId;
  bool _sending = false;
  bool _codeSent = false;
  bool _verifying = false;
  bool _verified = false;
  int _attempts = 0;
  int _resends = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    _phoneCtrl = TextEditingController(
        text: widget.initialPhone.isNotEmpty ? widget.initialPhone : '+');
    _verified = widget.initiallyVerified && widget.initialPhone.isNotEmpty;
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    super.dispose();
  }

  Map<String, Object> _geo() {
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
      setState(() => _error = 'Enter your number with country code, e.g. +234…');
      return;
    }
    setState(() { _sending = true; _error = null; });
    if (resend) { _resends++; Analytics.capture('otp_resend_tapped', {'resend_count': _resends, 'field': 'personal_phone', ..._geo()}); }
    Analytics.capture('otp_requested', {'channel': 'sms', 'field': 'personal_phone', ..._geo()});
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
          setState(() { _sending = false; _error = _friendlySend(e.code); });
          Analytics.error(domain: 'otp', code: 'otp_send_failed', message: e.code, screen: _screen, action: 'send', extra: {'reason': e.code, ..._geo()});
        },
        codeSent: (String verId, int? _) {
          if (!mounted) return;
          setState(() { _sending = false; _codeSent = true; _verificationId = verId; });
          Analytics.capture('otp_sent', {'provider': 'firebase', 'field': 'personal_phone', ..._geo()});
        },
        codeAutoRetrievalTimeout: (String verId) { _verificationId = verId; },
      );
    } catch (e) {
      if (!mounted) return;
      setState(() { _sending = false; _error = 'Could not send the code — please try again.'; });
      Analytics.error(domain: 'otp', code: 'otp_send_exception', message: e.toString(), screen: _screen, action: 'send', extra: _geo());
    }
  }

  Future<void> _verifyCode() async {
    final id = _verificationId;
    final code = _codeCtrl.text.trim();
    if (id == null || code.length < 6) return;
    setState(() { _verifying = true; _error = null; _attempts++; });
    Analytics.capture('otp_code_submitted', {'attempt': _attempts, 'field': 'personal_phone', ..._geo()});
    try {
      final cred = PhoneAuthProvider.credential(verificationId: id, smsCode: code);
      await FirebaseAuth.instance.signInWithCredential(cred);
      await _onVerified();
    } on FirebaseAuthException catch (e) {
      if (!mounted) return;
      setState(() { _verifying = false; _error = _friendlyVerify(e.code); });
      Analytics.error(domain: 'otp', code: 'otp_verify_failed', message: e.code, screen: _screen, action: 'verify', extra: {'reason': e.code, 'attempt': _attempts, ..._geo()});
    } catch (e) {
      if (!mounted) return;
      setState(() { _verifying = false; _error = 'Verification failed — please try again.'; });
      Analytics.error(domain: 'otp', code: 'otp_verify_exception', message: e.toString(), screen: _screen, action: 'verify', extra: _geo());
    }
  }

  Future<void> _onVerified({bool auto = false}) async {
    final phone = _phoneCtrl.text.trim();
    Analytics.capture('personal_phone_verified', {'auto': auto, 'attempts_used': _attempts, 'resends': _resends, ..._geo()});
    Analytics.setUserKeys(phone: phone);
    // Best-effort: tell the backend the number is confirmed.
    final res = await VerificationApi.confirmPhone(phone);
    if (!res.ok) {
      Analytics.error(domain: 'otp', code: 'phone_confirm_backend_failed', message: res.message ?? 'status ${res.status}', screen: _screen, action: 'confirm', extra: {'status': res.status});
    }
    // Firebase phone sign-in only proves ownership — the real session is Clerk, so
    // drop the Firebase user to avoid confusion.
    try { await FirebaseAuth.instance.signOut(); } catch (_) {}
    if (!mounted) return;
    setState(() { _verified = true; _verifying = false; });
    widget.onVerified(phone);
  }

  String _friendlySend(String code) {
    switch (code) {
      case 'invalid-phone-number': return 'That phone number looks invalid — check the country code.';
      case 'too-many-requests': return 'Too many attempts. Please wait a bit and try again.';
      case 'quota-exceeded': return 'SMS is temporarily unavailable — try again shortly.';
      default: return 'Could not send the code — please try again.';
    }
  }

  String _friendlyVerify(String code) {
    switch (code) {
      case 'invalid-verification-code': return 'That code is incorrect. Check and try again.';
      case 'session-expired': return 'The code expired — tap resend to get a new one.';
      default: return 'Verification failed — please try again.';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('PERSONAL PHONE (PRIVATE)', style: ZineText.kicker()),
      const SizedBox(height: 9),
      if (_verified)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          decoration: BoxDecoration(
            color: Zine.card,
            borderRadius: BorderRadius.circular(Zine.rField),
            border: Zine.border,
            boxShadow: Zine.shadowXs,
          ),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 18, color: Zine.mintInk),
            const SizedBox(width: 10),
            Expanded(child: Text(_phoneCtrl.text.trim(), style: ZineText.value(size: 15), overflow: TextOverflow.ellipsis)),
            PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.fill), size: 16, color: Zine.inkSoft),
          ]),
        )
      else ...[
        _field(controller: _phoneCtrl, hint: '+234 800 000 0000', icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
            keyboardType: TextInputType.phone, enabled: !_codeSent),
        if (!_codeSent) ...[
          const SizedBox(height: 10),
          _btn(_sending ? 'Sending…' : 'Send code', _sending ? null : _sendCode),
        ] else ...[
          const SizedBox(height: 10),
          _field(controller: _codeCtrl, hint: '6-digit code', icon: PhosphorIcons.chatText(PhosphorIconsStyle.bold),
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)]),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(child: _btn(_verifying ? 'Verifying…' : 'Verify & lock', _verifying ? null : _verifyCode)),
            const SizedBox(width: 14),
            ZineLink('resend', onTap: _sending ? null : () => _sendCode(resend: true)),
          ]),
        ],
        if (_error != null) ZineErrorMsg(_error!),
      ],
      const SizedBox(height: 4),
      Text('Your real number, kept private. We send a one-time code to confirm it, '
          'then lock it. Optional — you can add it later in Settings.',
          style: ZineText.sub(size: 12)),
    ]);
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
                hintStyle: ZineText.input(size: 16).copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
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

  Widget _btn(String text, VoidCallback? onTap) => ZineButton(
        label: text,
        onPressed: onTap,
        variant: ZineButtonVariant.blue,
        fullWidth: true,
        fontSize: 17,
      );
}
