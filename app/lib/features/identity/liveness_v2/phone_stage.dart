import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/analytics.dart';
import '../../../core/phone_country.dart';
import '../../../core/profile_store.dart';
import '../../../core/verification_api.dart';
import 'live_theme.dart';

/// [LIVE-UI-4] The two front-of-flow verification stages added by the final mock
/// (`design/Liveliness Check final/Liveness Check.dc.html`): PHONE NUMBER (pips
/// step 1) and CONFIRM CODE (pips step 2). Both are wired to the SAME production
/// phone-verification path used everywhere else in the app
/// (`features/profile/phone_verify_card.dart` /
/// `features/onboarding/verify_identity_step.dart`): Firebase phone auth does the
/// SMS OTP client-side, then [VerificationApi.confirmPhone] records it on the
/// server (which enforces denylist / VoIP / one-phone-one-account and returns the
/// exact error we surface).
///
/// The shared business logic lives in [PhoneVerifyController] — a
/// [ChangeNotifier] so the stage widgets stay presentational and every meter /
/// pill / caret binds to REAL controller state (no simulated timers). The mock's
/// hardcoded OTP "483902" + setTimeout choreography is demo-only and NOT copied.

/// The status pill shown under the OTP boxes — exactly one is visible.
enum OtpStatus {
  /// codeSent, but no digit typed / auto-retrieved yet ("Waiting for SMS").
  waiting,

  /// digits are arriving (auto-fill or typing/paste) but not yet verified.
  filling,

  /// Firebase signInWithCredential + /phone/confirm succeeded.
  verified,
}

/// Grouped, const, English-only strings for the two new stages (kept together so
/// they can be localized in one place later — see rulebook §6/§7).
class PhoneStageStrings {
  PhoneStageStrings._();

  static const phoneHeadlineLead = 'Verify your ';
  static const phoneHeadlineMark = 'phone';
  static const phoneSub =
      "I'll text you a one-time code — no passwords, no waiting.";
  static const phoneFieldLabel = 'Phone number';
  static const phoneHint = '+1 415 555 0134';
  static const phoneCta = 'Text me a code';

  static const otpHeadlineLead = 'Enter the ';
  static const otpHeadlineMark = 'code';
  static String otpSub(String phone) => 'Sent to $phone — it fills in by itself.';
  static const statusWaiting = 'Waiting for SMS';
  static const statusFilling = 'Auto-filling';
  static const statusVerified = 'Code verified';
  static const resendPrefix = "Didn't get it?";
  static const resendAction = 'Resend code';
}

/// Shared phone-verification business logic for the liveness front stages.
///
/// Reuses the exact Firebase + backend contract from the profile/onboarding
/// cards: [FirebaseAuth.verifyPhoneNumber] for the SMS OTP, auto-retrieval on
/// Android via `verificationCompleted`, manual `signInWithCredential` on submit,
/// then [VerificationApi.confirmPhone]. Server rejections (denylist / VoIP /
/// duplicate) surface via the confirm response message. It exposes only real
/// state; the widgets never fabricate progress.
class PhoneVerifyController extends ChangeNotifier {
  PhoneVerifyController();

  static const _screen = 'liveness_phone_verify';
  static const _resendCooldownSecs = 30;
  static const _otpLen = 6;

  final TextEditingController phoneCtrl = TextEditingController(text: '+');

  // ── Public, widget-observed state ────────────────────────────────────────
  bool sending = false;
  bool codeSent = false;
  bool verifying = false;
  bool verified = false;

  /// The 6 OTP digits as they REALLY arrive (auto-retrieval, typing, or paste).
  /// Empty slots render the blinking caret / translucent box.
  String otp = '';
  String? error;

  int _attempts = 0;
  int _resends = 0;

  String? _verificationId;
  int? _forceResendToken;

  // Real resend cooldown, anchored to the last send time (not decoration).
  Timer? _cooldownTimer;
  int cooldownLeft = 0;
  bool get canResend => !sending && cooldownLeft == 0;

  bool _disposed = false;

  final _profileStore = ProfileStore();

  /// The phone string to display in the OTP sub-text ("Sent to …").
  String get phoneDisplay {
    final p = phoneCtrl.text.trim();
    return (p.isNotEmpty && p != '+') ? p : PhoneStageStrings.phoneHint;
  }

  /// The live status pill under the OTP boxes.
  OtpStatus get status {
    if (verified) return OtpStatus.verified;
    if (otp.isEmpty) return OtpStatus.waiting;
    return OtpStatus.filling;
  }

  /// Country dims for the entered number — ride every OTP event so support can
  /// slice failures by country without storing the raw number.
  Map<String, Object> _geo() {
    final c = PhoneCountry.fromE164(phoneCtrl.text);
    return {
      if (c.dialCode.isNotEmpty) 'dial_code': c.dialCode,
      'phone_country': c.iso2,
      'phone_country_name': c.name,
    };
  }

  Future<void> loadStoredPhone() async {
    try {
      final p = await _profileStore.load();
      if (!_disposed && p.phone.isNotEmpty) {
        phoneCtrl.text = p.phone;
        _safeNotify();
      }
    } catch (_) {/* best-effort prefill */}
  }

  // ── Send / resend ────────────────────────────────────────────────────────

  Future<void> send({bool resend = false}) async {
    final phone = phoneCtrl.text.trim();
    if (phone.replaceAll(RegExp(r'[^0-9]'), '').length < 8) {
      error = 'Enter your number with country code, e.g. +234…';
      _safeNotify();
      return;
    }
    sending = true;
    error = null;
    _safeNotify();
    if (resend) {
      _resends++;
      _resetOtp();
      Analytics.capture('otp_resend', {'resend_count': _resends, ..._geo()});
    }
    Analytics.capture('otp_sent', {'channel': 'sms', 'phase': 'requested', ..._geo()});
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: phone,
        timeout: const Duration(seconds: 60),
        forceResendingToken: resend ? _forceResendToken : null,
        verificationCompleted: (PhoneAuthCredential cred) async {
          // Android instant / auto-retrieval: the digits are "auto-filling".
          final code = cred.smsCode;
          if (code != null && code.isNotEmpty) {
            otp = code.length > _otpLen ? code.substring(0, _otpLen) : code;
            _safeNotify();
          }
          try {
            await FirebaseAuth.instance.signInWithCredential(cred);
            await _onVerified(auto: true);
          } catch (_) {/* fall back to manual entry */}
        },
        verificationFailed: (FirebaseAuthException e) {
          if (_disposed) return;
          sending = false;
          error = _friendlySend(e.code);
          _safeNotify();
          // [ISSUE-OTP-DIAG-1] (2026-07-09) Carry the NATIVE message, not just the
          // code. The Android firebase_auth plugin collapses every error it can't
          // map to code=='unknown', so `e.code` alone told us nothing — diagnosing
          // the Play Integrity outage took a console session instead of one query.
          // `e.message` holds the real cause (blocked API, attestation failure, …).
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
              ..._geo(),
            },
          );
        },
        codeSent: (String verId, int? token) {
          if (_disposed) return;
          sending = false;
          codeSent = true;
          _verificationId = verId;
          _forceResendToken = token;
          _startCooldown();
          _safeNotify();
          Analytics.capture('otp_sent', {'provider': 'firebase', ..._geo()});
        },
        codeAutoRetrievalTimeout: (String verId) => _verificationId = verId,
      );
    } catch (e) {
      if (_disposed) return;
      sending = false;
      error = 'Could not send the code — please try again.';
      _safeNotify();
      Analytics.error(
        domain: 'otp',
        code: 'otp_send_exception',
        message: e.toString(),
        screen: _screen,
        action: 'send',
        extra: _geo(),
      );
    }
  }

  // ── OTP input (typing / paste) ───────────────────────────────────────────

  /// Called as the user types or pastes into the hidden OTP field. Accepts a
  /// pasted 6-digit code, keeps only digits, and auto-submits once full.
  void onOtpChanged(String raw) {
    final digits = raw.replaceAll(RegExp(r'[^0-9]'), '');
    otp = digits.length > _otpLen ? digits.substring(0, _otpLen) : digits;
    error = null;
    _safeNotify();
    if (otp.length == _otpLen && !verifying && !verified) {
      verify();
    }
  }

  Future<void> verify() async {
    final id = _verificationId;
    if (id == null || otp.length < _otpLen || verifying || verified) return;
    verifying = true;
    error = null;
    _attempts++;
    _safeNotify();
    Analytics.capture('otp_code_submitted', {'attempt': _attempts, ..._geo()});
    try {
      await FirebaseAuth.instance.signInWithCredential(
          PhoneAuthProvider.credential(verificationId: id, smsCode: otp));
      await _onVerified();
    } on FirebaseAuthException catch (e) {
      if (_disposed) return;
      verifying = false;
      final expired = e.code == 'session-expired' || e.code == 'code-expired';
      error = _friendlyVerify(e.code);
      _resetOtp(); // clear the boxes so the shake/error reads cleanly
      _safeNotify();
      Analytics.capture(expired ? 'otp_expired' : 'otp_invalid', {
        'reason': e.code,
        'attempt': _attempts,
        ..._geo(),
      });
      // [ISSUE-OTP-DIAG-1] Same reasoning as the send path — keep the native message.
      Analytics.error(
        domain: 'otp',
        code: 'otp_verify_failed',
        message: '${e.code}: ${e.message ?? "no native message"}',
        screen: _screen,
        action: 'verify',
        extra: {
          'reason': e.code,
          if (e.message != null) 'firebase_message': e.message!,
          ..._geo(),
        },
      );
    } catch (e) {
      if (_disposed) return;
      verifying = false;
      error = 'Verification failed — please try again.';
      _resetOtp();
      _safeNotify();
      Analytics.capture('otp_invalid', {'reason': 'exception', ..._geo()});
      Analytics.error(
        domain: 'otp',
        code: 'otp_verify_exception',
        message: e.toString(),
        screen: _screen,
        action: 'verify',
        extra: _geo(),
      );
    }
  }

  /// Fires when Firebase confirms the credential. Records the number server-side;
  /// a server rejection (denylist / VoIP / duplicate) surfaces its exact message
  /// and does NOT advance the flow.
  Future<void> _onVerified({bool auto = false}) async {
    final phone = phoneCtrl.text.trim();
    final res = await VerificationApi.confirmPhone(phone);
    if (!res.ok) {
      // Server refused the number — surface the exact message + let them retry.
      if (_disposed) return;
      verifying = false;
      verified = false;
      error = res.message ??
          'We could not verify this number. Please try a different one.';
      _resetOtp();
      _safeNotify();
      Analytics.capture('phone_confirm_blocked', {
        'reason': res.message ?? 'status ${res.status}',
        'status': res.status,
        'auto': auto,
        ..._geo(),
      });
      // Drop the Firebase user — the account session is Clerk, not Firebase.
      try {
        await FirebaseAuth.instance.signOut();
      } catch (_) {}
      return;
    }
    Analytics.capture('otp_verified', {
      'auto': auto,
      'attempts_used': _attempts,
      'resends': _resends,
      ..._geo(),
    });
    // Attach the verified phone (+ country) to every future event for this person.
    Analytics.setUserKeys(phone: phone);
    try {
      await _profileStore.setPhone(phone);
    } catch (_) {}
    // Firebase phone sign-in only proves ownership — drop it (session is Clerk).
    try {
      await FirebaseAuth.instance.signOut();
    } catch (_) {}
    if (_disposed) return;
    _cooldownTimer?.cancel();
    cooldownLeft = 0;
    verified = true;
    verifying = false;
    _safeNotify();
  }

  // ── Reset (restart from phone) ───────────────────────────────────────────

  /// Clears all Firebase verification state so a restart begins clean.
  void resetAll() {
    _cooldownTimer?.cancel();
    cooldownLeft = 0;
    sending = false;
    codeSent = false;
    verifying = false;
    verified = false;
    otp = '';
    error = null;
    _verificationId = null;
    _forceResendToken = null;
    _attempts = 0;
    _resends = 0;
    _safeNotify();
  }

  void _resetOtp() {
    otp = '';
  }

  void _startCooldown() {
    _cooldownTimer?.cancel();
    cooldownLeft = _resendCooldownSecs;
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (_disposed) {
        t.cancel();
        return;
      }
      cooldownLeft = (cooldownLeft - 1).clamp(0, _resendCooldownSecs);
      if (cooldownLeft == 0) t.cancel();
      _safeNotify();
    });
  }

  String _friendlySend(String c) => switch (c) {
        'invalid-phone-number' =>
          'That phone number looks invalid — check the country code.',
        'too-many-requests' => 'Too many attempts. Please wait a bit and try again.',
        'operation-not-allowed' =>
          'Phone sign-in is being enabled — please try again shortly.',
        'quota-exceeded' => 'SMS is temporarily unavailable — try again shortly.',
        // iOS APNs / reCAPTCHA config failures land here — honest, recoverable.
        'missing-client-identifier' || 'app-not-authorized' || 'internal-error' =>
          "We couldn't start phone verification on this device. Please try "
              'again, or continue and add your phone later.',
        _ => 'Could not send the code — please try again.',
      };

  String _friendlyVerify(String c) => switch (c) {
        'invalid-verification-code' => 'That code is incorrect. Check and try again.',
        'session-expired' ||
        'code-expired' =>
          'The code expired — tap Resend code to get a new one.',
        _ => 'Verification failed — please try again.',
      };

  void _safeNotify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _cooldownTimer?.cancel();
    phoneCtrl.dispose();
    super.dispose();
  }
}

// ── Stage 0: phone number ─────────────────────────────────────────────────────

/// Stage 0 (pips step 1): centered blue disc + phone field card + lime CTA.
/// Rises above the keyboard via [MediaQuery.viewInsets] inside the existing
/// SafeArea scaffold; nothing else about the layout changes.
class PhoneNumberStage extends StatelessWidget {
  const PhoneNumberStage({super.key, required this.controller});
  final PhoneVerifyController controller;

  @override
  Widget build(BuildContext context) {
    final reduced = LiveTheme.reducedMotion(context);
    final insets = MediaQuery.of(context).viewInsets.bottom;
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    const SizedBox(height: 20),
                    // Blue disc with floating coral star + lilac dot decorations.
                    _DecoratedDisc(
                      color: LiveTheme.blue,
                      icon: Icons.smartphone_rounded,
                      reducedMotion: reduced,
                    ),
                    const SizedBox(height: 22),
                    LiveTheme.stageHeadline(PhoneStageStrings.phoneHeadlineLead,
                        markWord: PhoneStageStrings.phoneHeadlineMark),
                    const SizedBox(height: 12),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Text(PhoneStageStrings.phoneSub,
                          textAlign: TextAlign.center, style: LiveTheme.subStyle),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            // Bottom card rises above the keyboard.
            Padding(
              padding: EdgeInsets.only(bottom: insets),
              child: Container(
                padding: const EdgeInsets.all(18),
                decoration: LiveTheme.taperedCardDecoration,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(PhoneStageStrings.phoneFieldLabel.toUpperCase(),
                        style: LiveTheme.kickerOnCardStyle),
                    const SizedBox(height: 10),
                    _PhoneField(controller: controller),
                    if (controller.error != null) ...[
                      const SizedBox(height: 10),
                      _InlineError(controller.error!),
                    ],
                    const SizedBox(height: 14),
                    Semantics(
                      button: true,
                      label: PhoneStageStrings.phoneCta,
                      child: LiveTheme.limeButton(
                        label: controller.sending ? 'Sending…' : PhoneStageStrings.phoneCta,
                        icon: Icons.send_rounded,
                        onPressed: controller.sending ? null : () => controller.send(),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// The phone number field — design-system Field style (lime lead-icon cell, ink
/// border, hard shadow) matching the rest of the app's phone inputs.
class _PhoneField extends StatelessWidget {
  const _PhoneField({required this.controller});
  final PhoneVerifyController controller;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: PhoneStageStrings.phoneFieldLabel,
      textField: true,
      child: Container(
        decoration: BoxDecoration(
          color: LiveTheme.paper,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: LiveTheme.ink, width: 2),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(children: [
          Container(
            width: 46,
            constraints: const BoxConstraints(minHeight: 52),
            decoration: const BoxDecoration(
              color: LiveTheme.lime,
              border: Border(right: BorderSide(color: LiveTheme.ink, width: 2)),
            ),
            alignment: Alignment.center,
            child: const Icon(Icons.phone_rounded, size: 20, color: LiveTheme.ink),
          ),
          Expanded(
            child: TextField(
              controller: controller.phoneCtrl,
              enabled: !controller.sending,
              keyboardType: TextInputType.phone,
              cursorColor: LiveTheme.blue,
              style: const TextStyle(
                fontFamily: 'Nunito',
                fontWeight: FontWeight.w800,
                fontSize: 16,
                color: LiveTheme.ink,
              ),
              onChanged: (_) {},
              scrollPadding: const EdgeInsets.all(80),
              decoration: const InputDecoration(
                hintText: PhoneStageStrings.phoneHint,
                hintStyle: TextStyle(
                  fontFamily: 'Nunito',
                  fontWeight: FontWeight.w700,
                  fontSize: 16,
                  color: LiveTheme.inkSoft,
                ),
                border: InputBorder.none,
                isDense: true,
                contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 14),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

// ── Stage 0b: confirm code ────────────────────────────────────────────────────

/// Stage 0b (pips step 2): blue disc + 6 OTP boxes + live status pill + resend.
/// The OTP boxes render the REAL controller.otp; a hidden focused TextField
/// captures typing + paste and feeds [PhoneVerifyController.onOtpChanged].
class OtpConfirmStage extends StatefulWidget {
  const OtpConfirmStage({super.key, required this.controller});
  final PhoneVerifyController controller;

  @override
  State<OtpConfirmStage> createState() => _OtpConfirmStageState();
}

class _OtpConfirmStageState extends State<OtpConfirmStage>
    with SingleTickerProviderStateMixin {
  final _focus = FocusNode();
  // Mirror controller.otp into a hidden field so backspace/paste behave.
  final _hidden = TextEditingController();
  late final AnimationController _shake;
  String? _lastError;

  @override
  void initState() {
    super.initState();
    _shake = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 420));
    widget.controller.addListener(_sync);
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  void _sync() {
    // Keep the hidden field in step with the real OTP (e.g. cleared on error /
    // auto-retrieval populating digits).
    final otp = widget.controller.otp;
    if (_hidden.text != otp) {
      _hidden.value = TextEditingValue(
        text: otp,
        selection: TextSelection.collapsed(offset: otp.length),
      );
    }
    // Shake once when a new error appears.
    if (widget.controller.error != null &&
        widget.controller.error != _lastError &&
        !LiveTheme.reducedMotion(context)) {
      _shake.forward(from: 0);
    }
    _lastError = widget.controller.error;
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.controller.removeListener(_sync);
    _focus.dispose();
    _hidden.dispose();
    _shake.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final reduced = LiveTheme.reducedMotion(context);
    return GestureDetector(
      onTap: () => _focus.requestFocus(),
      behavior: HitTestBehavior.opaque,
      child: Stack(
        children: [
          // Hidden capture field — off-screen but focusable for typing + paste.
          Positioned(
            width: 1,
            height: 1,
            left: -100,
            child: TextField(
              controller: _hidden,
              focusNode: _focus,
              autofocus: true,
              keyboardType: TextInputType.number,
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(6),
              ],
              onChanged: c.onOtpChanged,
              showCursor: false,
              enableInteractiveSelection: false,
              decoration: const InputDecoration(border: InputBorder.none),
            ),
          ),
          SingleChildScrollView(
            child: Column(
              children: [
                const SizedBox(height: 8),
                _DecoratedDisc(
                  color: LiveTheme.blue,
                  icon: Icons.chat_bubble_rounded,
                  reducedMotion: reduced,
                  decorations: false,
                ),
                const SizedBox(height: 22),
                LiveTheme.stageHeadline(PhoneStageStrings.otpHeadlineLead,
                    markWord: PhoneStageStrings.otpHeadlineMark),
                const SizedBox(height: 10),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Text(PhoneStageStrings.otpSub(c.phoneDisplay),
                      textAlign: TextAlign.center, style: LiveTheme.subStyle),
                ),
                const SizedBox(height: 22),
                _OtpBoxes(controller: c, shake: _shake, reducedMotion: reduced),
                const SizedBox(height: 18),
                _StatusPill(status: c.status, reducedMotion: reduced),
                if (c.error != null) ...[
                  const SizedBox(height: 12),
                  _InlineError(c.error!),
                ],
                const SizedBox(height: 18),
                _ResendRow(controller: c),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The 6 OTP boxes. Filled = paper bg + ink border + pop; empty = translucent +
/// blinking lime caret at the current index. Every box binds to controller.otp.
class _OtpBoxes extends StatelessWidget {
  const _OtpBoxes({
    required this.controller,
    required this.shake,
    required this.reducedMotion,
  });
  final PhoneVerifyController controller;
  final AnimationController shake;
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    final otp = controller.otp;
    final verified = controller.verified;
    final row = Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (var i = 0; i < 6; i++) ...[
          if (i > 0) const SizedBox(width: 8),
          _box(context, i, otp, verified),
        ],
      ],
    );
    if (reducedMotion) return row;
    // Horizontal shake on error.
    return AnimatedBuilder(
      animation: shake,
      builder: (context, child) {
        final dx = shake.isAnimating
            ? 8 * (1 - shake.value) *
                ((shake.value * 6).floor().isEven ? 1 : -1)
            : 0.0;
        return Transform.translate(offset: Offset(dx, 0), child: child);
      },
      child: row,
    );
  }

  Widget _box(BuildContext context, int i, String otp, bool verified) {
    final filled = i < otp.length;
    final isCurrent = i == otp.length && !verified;
    final char = filled ? otp[i] : '';
    return Semantics(
      label: filled ? 'Digit ${i + 1} entered' : 'Digit ${i + 1} empty',
      value: char,
      child: _PopBox(
        filled: filled,
        reducedMotion: reducedMotion,
        child: SizedBox(
          width: 46,
          height: 58,
          child: Center(
            child: filled
                ? Text(char,
                    style: const TextStyle(
                      fontFamily: 'Nunito',
                      fontWeight: FontWeight.w800,
                      fontSize: 24,
                      color: LiveTheme.ink,
                    ))
                : (isCurrent
                    ? _BlinkCaret(reducedMotion: reducedMotion)
                    : const SizedBox.shrink()),
          ),
        ),
      ),
    );
  }
}

/// A single OTP box shell — pops in when it becomes filled.
class _PopBox extends StatefulWidget {
  const _PopBox({
    required this.filled,
    required this.reducedMotion,
    required this.child,
  });
  final bool filled;
  final bool reducedMotion;
  final Widget child;
  @override
  State<_PopBox> createState() => _PopBoxState();
}

class _PopBoxState extends State<_PopBox> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 200), value: 1);
  }

  @override
  void didUpdateWidget(covariant _PopBox old) {
    super.didUpdateWidget(old);
    if (widget.filled && !old.filled && !widget.reducedMotion) {
      _c.forward(from: 0.4);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final box = DecoratedBox(
      decoration: BoxDecoration(
        color: widget.filled ? LiveTheme.paper : const Color(0x1AF9F7ED),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: widget.filled ? LiveTheme.ink : const Color(0x73F9F7ED),
          width: widget.filled ? 2.5 : 2,
        ),
      ),
      child: widget.child,
    );
    if (widget.reducedMotion) return box;
    return ScaleTransition(
      scale: Tween<double>(begin: 0.85, end: 1)
          .animate(CurvedAnimation(parent: _c, curve: Curves.easeOutBack)),
      child: box,
    );
  }
}

/// Blinking lime caret shown in the current empty OTP box.
class _BlinkCaret extends StatefulWidget {
  const _BlinkCaret({required this.reducedMotion});
  final bool reducedMotion;
  @override
  State<_BlinkCaret> createState() => _BlinkCaretState();
}

class _BlinkCaretState extends State<_BlinkCaret>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 1));
    if (!widget.reducedMotion) _c.repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bar = Container(
      width: 2.5,
      height: 24,
      decoration: BoxDecoration(
        color: LiveTheme.lime,
        borderRadius: BorderRadius.circular(100),
      ),
    );
    if (widget.reducedMotion) return bar;
    return FadeTransition(
      opacity: Tween<double>(begin: 1, end: 0.12).animate(_c),
      child: bar,
    );
  }
}

/// The single live status pill (waiting / auto-filling / verified).
class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.status, required this.reducedMotion});
  final OtpStatus status;
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 34,
      child: Center(
        child: Semantics(
          liveRegion: true,
          child: switch (status) {
            OtpStatus.waiting => _pill(
                icon: reducedMotion ? Icons.autorenew : null,
                spinner: !reducedMotion,
                label: PhoneStageStrings.statusWaiting,
              ),
            OtpStatus.filling => _pill(
                icon: Icons.auto_fix_high_rounded,
                label: PhoneStageStrings.statusFilling,
              ),
            OtpStatus.verified => _pill(
                icon: Icons.check_rounded,
                label: PhoneStageStrings.statusVerified,
                fill: LiveTheme.lime,
              ),
          },
        ),
      ),
    );
  }

  Widget _pill({
    String? label,
    IconData? icon,
    bool spinner = false,
    Color? fill,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 5),
      decoration: BoxDecoration(
        color: fill ?? LiveTheme.card,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: LiveTheme.ink, width: 2),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (spinner)
            const SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(strokeWidth: 2, color: LiveTheme.ink),
            )
          else if (icon != null)
            Icon(icon, size: 13, color: LiveTheme.ink),
          const SizedBox(width: 8),
          Text(label!.toUpperCase(),
              style: const TextStyle(
                fontFamily: 'Nunito',
                fontWeight: FontWeight.w700,
                fontSize: 10.5,
                letterSpacing: 0.8,
                color: LiveTheme.ink,
              )),
        ],
      ),
    );
  }
}

/// "Didn't get it? Resend code" — real cooldown countdown from the controller.
class _ResendRow extends StatelessWidget {
  const _ResendRow({required this.controller});
  final PhoneVerifyController controller;

  @override
  Widget build(BuildContext context) {
    final cooling = controller.cooldownLeft > 0;
    final canResend = controller.canResend;
    final label = cooling
        ? 'Resend in ${controller.cooldownLeft}s'
        : PhoneStageStrings.resendAction;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Text(PhoneStageStrings.resendPrefix,
            style: TextStyle(
              fontFamily: 'Nunito',
              fontWeight: FontWeight.w700,
              fontSize: 12.5,
              color: Color(0x8CF9F7ED),
            )),
        const SizedBox(width: 6),
        Semantics(
          button: true,
          enabled: canResend,
          label: PhoneStageStrings.resendAction,
          child: GestureDetector(
            onTap: canResend ? () => controller.send(resend: true) : null,
            child: Text(label.toUpperCase(),
                style: TextStyle(
                  fontFamily: 'Nunito',
                  fontWeight: FontWeight.w700,
                  fontSize: 12,
                  letterSpacing: 0.8,
                  color: canResend ? LiveTheme.blue : const Color(0x66F9F7ED),
                  decoration: canResend ? TextDecoration.underline : null,
                  decorationColor: LiveTheme.blue,
                )),
          ),
        ),
      ],
    );
  }
}

// ── Shared bits ───────────────────────────────────────────────────────────────

/// The centered blue disc with pop-in + (optional) floating coral star + lilac
/// dot decorations, matching the two mock stages.
class _DecoratedDisc extends StatefulWidget {
  const _DecoratedDisc({
    required this.color,
    required this.icon,
    required this.reducedMotion,
    this.decorations = true,
  });
  final Color color;
  final IconData icon;
  final bool reducedMotion;
  final bool decorations;
  @override
  State<_DecoratedDisc> createState() => _DecoratedDiscState();
}

class _DecoratedDiscState extends State<_DecoratedDisc>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pop;
  @override
  void initState() {
    super.initState();
    _pop = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 400));
    if (widget.reducedMotion) {
      _pop.value = 1;
    } else {
      _pop.forward();
    }
  }

  @override
  void dispose() {
    _pop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final disc = ScaleTransition(
      scale: CurvedAnimation(parent: _pop, curve: Curves.elasticOut),
      child: Container(
        width: 104,
        height: 104,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: widget.color,
          border: Border.all(color: LiveTheme.ink, width: 3),
          boxShadow: const [BoxShadow(color: LiveTheme.ink, offset: Offset(6, 7))],
        ),
        child: Icon(widget.icon, size: 46, color: LiveTheme.ink),
      ),
    );
    if (!widget.decorations) return disc;
    return SizedBox(
      width: 220,
      height: 150,
      child: Stack(
        alignment: Alignment.center,
        children: [
          if (!widget.reducedMotion) ...[
            Positioned(
              top: 6,
              right: 30,
              child: _Float(
                delayMs: 0,
                child: const Icon(Icons.star_rounded, size: 20, color: LiveTheme.coral),
              ),
            ),
            Positioned(
              top: 44,
              left: 24,
              child: _Float(
                delayMs: 300,
                child: Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: LiveTheme.lilac,
                    shape: BoxShape.circle,
                    border: Border.all(color: LiveTheme.ink, width: 2),
                  ),
                ),
              ),
            ),
          ],
          disc,
        ],
      ),
    );
  }
}

/// A gently floating decoration (mirrors the mock's avaFloat).
class _Float extends StatefulWidget {
  const _Float({required this.child, required this.delayMs});
  final Widget child;
  final int delayMs;
  @override
  State<_Float> createState() => _FloatState();
}

class _FloatState extends State<_Float> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 1600));
    Future.delayed(Duration(milliseconds: widget.delayMs), () {
      if (mounted) _c.repeat(reverse: true);
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) =>
          Transform.translate(offset: Offset(0, -9 * _c.value), child: child),
      child: widget.child,
    );
  }
}

/// Inline error text used on both stages (coral, matches the dark stage).
class _InlineError extends StatelessWidget {
  const _InlineError(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.error_outline, size: 16, color: LiveTheme.coral),
        const SizedBox(width: 6),
        Flexible(
          child: Text(text,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: 'Nunito',
                fontWeight: FontWeight.w700,
                fontSize: 12.5,
                color: LiveTheme.coral,
              )),
        ),
      ],
    );
  }
}
