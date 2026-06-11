import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
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
  bool _phoneSkipped = false; // phone is optional — user can skip if SMS can't be sent

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

  // Email is required; phone is optional (verified OR explicitly skipped) so a
  // user is never trapped when SMS can't be delivered for technical reasons.
  bool get _ready =>
      _ageGroup != null && _gender != null && _emailVerified && (_phoneVerified || _phoneSkipped);

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
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ZineIconBadge(
                    icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
                    color: Zine.mint, size: 44),
                const SizedBox(height: 16),
                ZineMarkTitle(
                    pre: "Verify it's ", mark: 'you',
                    fontSize: 28, textAlign: TextAlign.left),
                const SizedBox(height: 8),
                Text(
                    'A few quick details keep AvaTOK safe for everyone. We verify your '
                    'phone and email, and never share them.',
                    style: ZineText.sub(size: 14.5)),
                const SizedBox(height: 22),

                _label('Age group'),
                const SizedBox(height: 8),
                _chips(_ageGroups, _ageGroup, (v) {
                  setState(() => _ageGroup = v);
                  Analytics.capture('onboarding_age_provided', {'age_group': v});
                }),
                if (_ageGroup == 'Under 18')
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                        'Under-18 accounts may need a parent to set things up.',
                        style: ZineText.sub(size: 12)),
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
                  icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                  accent: Zine.blue,
                  verified: _phoneVerified,
                  child: _phoneSection(),
                ),
                const SizedBox(height: 16),
                _verifyCard(
                  title: 'Email address',
                  icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
                  accent: Zine.lilac,
                  verified: _emailVerified,
                  child: _emailSection(),
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
          child: ZineButton(
            label: 'Keep going',
            icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
            fullWidth: true,
            fontSize: 21,
            onPressed: _ready
                ? () {
                    if (!_phoneVerified) {
                      Analytics.capture('phone_verification_skipped',
                          {'after_error': _phoneError != null});
                    }
                    widget.onComplete(VerifyData(
                      ageGroup: _ageGroup!,
                      gender: _gender!,
                      // Only persist the number if it was actually verified.
                      phone: _phoneVerified ? _phoneCtrl.text.trim() : '',
                      phoneVerified: _phoneVerified,
                      email: _emailCtrl.text.trim(),
                      emailVerified: _emailVerified,
                    ));
                  }
                : null,
          ),
        ),
      ],
    );
  }

  Widget _phoneSection() {
    if (_phoneVerified) return _verifiedRow(_phoneCtrl.text.trim());
    if (_phoneSkipped) {
      return Row(children: [
        PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold), size: 18, color: Zine.inkSoft),
        const SizedBox(width: 8),
        Expanded(
            child: Text('Skipped — you can verify your phone later in Settings.',
                style: ZineText.sub(size: 13.5))),
        const SizedBox(width: 8),
        ZineLink('undo', onTap: () => setState(() => _phoneSkipped = false)),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Optional — verify now, or add it later in Settings.',
          style: ZineText.sub(size: 12)),
      const SizedBox(height: 8),
      _field(
        controller: _phoneCtrl,
        hint: '+234 800 000 0000',
        icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
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
          icon: PhosphorIcons.chatText(PhosphorIconsStyle.bold),
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: _secondary(_phoneVerifying ? 'Verifying…' : 'Verify', _phoneVerifying ? null : _verifyPhoneCode),
          ),
          const SizedBox(width: 14),
          ZineLink('resend',
              onTap: _phoneSending ? null : () => _sendPhoneCode(resend: true)),
        ]),
      ],
      if (_phoneError != null) _errorText(_phoneError!),
      const SizedBox(height: 10),
      Align(
        alignment: Alignment.centerLeft,
        child: ZineLink(
          _phoneError != null ? 'skip phone verification →' : 'skip for now',
          underline: Zine.coral,
          onTap: () {
            Analytics.capture('phone_verification_skip_tapped', {'after_error': _phoneError != null});
            setState(() {
              _phoneSkipped = true;
              _phoneError = null;
            });
          },
        ),
      ),
    ]);
  }

  Widget _emailSection() {
    if (_emailVerified) return _verifiedRow(_emailCtrl.text.trim());
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _field(
        controller: _emailCtrl,
        hint: 'you@example.com',
        icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
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
          icon: PhosphorIcons.hash(PhosphorIconsStyle.bold),
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(8)],
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: _secondary(_emailVerifying ? 'Verifying…' : 'Verify', _emailVerifying ? null : _verifyEmailOtp),
          ),
          const SizedBox(width: 14),
          ZineLink('resend',
              onTap: _emailSending ? null : () => _sendEmailOtp(resend: true)),
        ]),
      ],
      if (_emailError != null) _errorText(_emailError!),
    ]);
  }

  // ───────────────────────── shared UI ─────────────────────────

  Widget _label(String t) => Text(t.toUpperCase(), style: ZineText.kicker());

  Widget _chips(List<String> options, String? selected, ValueChanged<String> onPick) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: options
            .map((o) => ZineChip(label: o, active: o == selected, onTap: () => onPick(o)))
            .toList(),
      );

  Widget _verifyCard({
    required String title,
    required IconData icon,
    required Color accent,
    required bool verified,
    required Widget child,
  }) =>
      ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(16),
        boxShadow: Zine.shadowXs,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: icon, color: verified ? Zine.mint : accent, size: 30),
            const SizedBox(width: 10),
            Expanded(child: Text(title, style: ZineText.cardTitle(size: 17))),
            if (verified)
              ZineSticker('verified',
                  kind: ZineStickerKind.ok,
                  icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)),
          ]),
          const SizedBox(height: 12),
          child,
        ]),
      );

  Widget _verifiedRow(String value) => Row(children: [
        PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
            size: 18, color: Zine.mintInk),
        const SizedBox(width: 8),
        Expanded(child: Text(value, style: ZineText.value(size: 15))),
      ]);

  /// Zine field chrome with inputFormatters support (the shared ZineField
  /// doesn't expose formatters): ink border, 18px radius, hard shadow, lime
  /// lead-icon cell, Nunito 800 input.
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

  Widget _errorText(String t) => ZineErrorMsg(t);
}
