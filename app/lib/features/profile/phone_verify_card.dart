import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/phone_country.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/verification_api.dart';

/// Phone verification form — for users who skipped phone at onboarding. Firebase
/// sends/checks the SMS OTP; on success we tell the backend
/// (VerificationApi.confirmPhone), store the number locally, and attach the
/// verified phone to telemetry. Usually presented via [PhoneNudgeCard]; can also
/// be embedded directly. Every OTP event carries the number's country so support
/// can see, e.g., "verify failing for +234 (NG)" by the user's email.
class PhoneVerifyCard extends StatefulWidget {
  /// Where this card lives — rides every OTP event as `source` (profile|settings).
  final String source;
  /// Fired once the phone is verified, so a host (e.g. a nudge) can collapse.
  final VoidCallback? onVerified;
  const PhoneVerifyCard({super.key, this.source = 'profile', this.onVerified});
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

  // Country dims for the entered number — ride every OTP event so support can
  // slice failures by country without storing the raw number.
  Map<String, Object> _geo() {
    final c = PhoneCountry.fromE164(_phoneCtrl.text);
    return {
      'source': widget.source,
      if (c.dialCode.isNotEmpty) 'dial_code': c.dialCode,
      'phone_country': c.iso2,
      'phone_country_name': c.name,
    };
  }

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
    if (resend) { _resends++; Analytics.capture('otp_resend_tapped', {'resend_count': _resends, ..._geo()}); }
    Analytics.capture('otp_requested', {'channel': 'sms', ..._geo()});
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
          Analytics.error(domain: 'otp', code: 'otp_send_failed', message: e.code, screen: _screen, action: 'send', extra: {'reason': e.code, ..._geo()});
        },
        codeSent: (String verId, int? _) {
          if (!mounted) return;
          setState(() { _sending = false; _codeSent = true; _verificationId = verId; });
          Analytics.capture('otp_sent', {'provider': 'firebase', ..._geo()});
        },
        codeAutoRetrievalTimeout: (String verId) => _verificationId = verId,
      );
    } catch (e) {
      if (!mounted) return;
      setState(() { _sending = false; _error = 'Could not send the code — please try again.'; });
      Analytics.error(domain: 'otp', code: 'otp_send_exception', message: e.toString(), screen: _screen, action: 'send', extra: _geo());
    }
  }

  Future<void> _verify() async {
    final id = _verificationId;
    final code = _codeCtrl.text.trim();
    if (id == null || code.length < 6) return;
    setState(() { _verifying = true; _error = null; _attempts++; });
    Analytics.capture('otp_code_submitted', {'attempt': _attempts, ..._geo()});
    try {
      await FirebaseAuth.instance.signInWithCredential(
          PhoneAuthProvider.credential(verificationId: id, smsCode: code));
      await _onVerified();
    } on FirebaseAuthException catch (e) {
      if (!mounted) return;
      setState(() { _verifying = false; _error = _friendlyVerify(e.code); });
      Analytics.error(domain: 'otp', code: 'otp_verify_failed', message: e.code, screen: _screen, action: 'verify', extra: {'reason': e.code, ..._geo()});
    } catch (e) {
      if (!mounted) return;
      setState(() { _verifying = false; _error = 'Verification failed — please try again.'; });
      Analytics.error(domain: 'otp', code: 'otp_verify_exception', message: e.toString(), screen: _screen, action: 'verify', extra: _geo());
    }
  }

  Future<void> _onVerified({bool auto = false}) async {
    Analytics.capture('phone_verification_completed', {'auto': auto, 'attempts_used': _attempts, ..._geo()});
    await VerificationApi.confirmPhone(_phoneCtrl.text.trim());
    await _store.setPhone(_phoneCtrl.text.trim());
    // Attach the verified phone (+ country) to every future event for this person.
    Analytics.setUserKeys(phone: _phoneCtrl.text.trim());
    try { await FirebaseAuth.instance.signOut(); } catch (_) {}
    if (!mounted) return;
    setState(() { _verified = true; _verifying = false; });
    widget.onVerified?.call();
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
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.phone(PhosphorIconsStyle.bold), color: Zine.blue, size: 28),
          const SizedBox(width: 9),
          Expanded(
              child: Text('PHONE NUMBER',
                  style: ZineText.kicker(), overflow: TextOverflow.ellipsis)),
          if (_verified)
            ZineSticker('verified', kind: ZineStickerKind.ok,
                icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
        ]),
        const SizedBox(height: 12),
        if (_verified)
          Row(children: [
            PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.bold), size: 18, color: Zine.mintInk),
            const SizedBox(width: 8),
            Expanded(
                child: Text(_phoneCtrl.text.trim(),
                    style: ZineText.value(size: 15), overflow: TextOverflow.ellipsis)),
          ])
        else ...[
          ZineField(
            controller: _phoneCtrl,
            hint: '+234 800 000 0000',
            leadIcon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
            keyboardType: TextInputType.phone,
            enabled: !_codeSent,
            error: _error != null && !_codeSent,
          ),
          if (!_codeSent) ...[
            const SizedBox(height: 12),
            ZineButton(
              label: _sending ? 'Sending…' : 'Send code',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              loading: _sending,
              onPressed: _sending ? null : _send,
            ),
          ] else ...[
            const SizedBox(height: 12),
            ZineField(
              controller: _codeCtrl,
              hint: '6-digit code',
              leadIcon: PhosphorIcons.chatText(PhosphorIconsStyle.bold),
              keyboardType: TextInputType.number,
              error: _error != null,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: ZineButton(
                label: _verifying ? 'Verifying…' : 'Verify',
                variant: ZineButtonVariant.blue,
                fullWidth: true,
                fontSize: 16,
                loading: _verifying,
                onPressed: _verifying ? null : _verify,
              )),
              const SizedBox(width: 14),
              ZineLink('RESEND', onTap: _sending ? null : () => _send(resend: true)),
            ]),
          ],
          if (_error != null) ZineErrorMsg(_error!),
        ],
      ]),
    );
  }
}

/// Soft nudge that encourages users who SKIPPED phone verification at onboarding
/// to add it later — shown in Profile and Settings. It is intentionally gentle:
///
///  • Appears only when the phone is NOT verified (checked against the backend).
///  • Is dismissible ("Not now") and remembers the dismissal **per account**
///    (parent + child share a phone, so this is account-scoped), re-surfacing
///    only after [_snoozeDays] so we never nag.
///  • Tapping "Add phone number" expands the real [PhoneVerifyCard] inline.
///
/// Telemetry: `phone_nudge_shown` / `phone_nudge_started` / `phone_nudge_dismissed`
/// (all tagged with `source`) so we can measure how well the nudge recovers the
/// users who skipped — broken down by country once they enter a number.
class PhoneNudgeCard extends StatefulWidget {
  /// 'profile' | 'settings' — rides every nudge + OTP event.
  final String source;
  /// When true (Settings), the whole card disappears once verified or dismissed.
  /// When false (Profile), a compact "verified" row is shown instead of vanishing,
  /// and the nudge is not dismissible (the form belongs on the profile editor).
  final bool collapsible;
  const PhoneNudgeCard({super.key, this.source = 'profile', this.collapsible = true});
  @override
  State<PhoneNudgeCard> createState() => _PhoneNudgeCardState();
}

class _PhoneNudgeCardState extends State<PhoneNudgeCard> {
  static const _snoozeDays = 7;
  static const _dismissBase = 'ph_nudge_dismissed_at';
  static const FlutterSecureStorage _sec = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  bool _loading = true;
  bool _verified = false;
  bool _dismissed = false;
  bool _expanded = false;
  bool _shownLogged = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Don't re-show if dismissed within the snooze window (account-scoped).
    var dismissed = false;
    try {
      final raw = await readScoped(_sec, _dismissBase);
      final at = int.tryParse(raw ?? '');
      if (at != null) {
        final age = DateTime.now().millisecondsSinceEpoch - at;
        dismissed = age < _snoozeDays * 24 * 60 * 60 * 1000;
      }
    } catch (_) {}
    // Backend is the source of truth for "is this account's phone verified?".
    final verified = await VerificationApi.isPhoneVerified();
    if (!mounted) return;
    setState(() { _verified = verified; _dismissed = dismissed; _loading = false; });
    _maybeLogShown();
  }

  void _maybeLogShown() {
    if (_shownLogged) return;
    if (_verified || (_dismissed && widget.collapsible)) return;
    _shownLogged = true;
    Analytics.capture('phone_nudge_shown', {'source': widget.source});
  }

  void _start() {
    Analytics.capture('phone_nudge_started', {'source': widget.source});
    setState(() => _expanded = true);
  }

  Future<void> _dismiss() async {
    Analytics.capture('phone_nudge_dismissed', {'source': widget.source});
    try {
      await _sec.write(
          key: scopedKey(_dismissBase),
          value: DateTime.now().millisecondsSinceEpoch.toString());
    } catch (_) {}
    if (!mounted) return;
    setState(() => _dismissed = true);
  }

  @override
  Widget build(BuildContext context) {
    final content = _content();
    // Self-managing spacing: zero footprint when hidden, even bottom gap when shown.
    return content == null
        ? const SizedBox.shrink()
        : Padding(padding: const EdgeInsets.only(bottom: 16), child: content);
  }

  /// The visible widget, or null when the nudge should take no space at all.
  Widget? _content() {
    if (_loading) return null;

    // Verified: vanish in Settings; show a tidy confirmation in Profile.
    if (_verified) {
      if (widget.collapsible) return null;
      return _wrap(Row(children: [
        ZineIconBadge(icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), color: Zine.mint, size: 28),
        const SizedBox(width: 10),
        Expanded(
            child: Text('Phone number verified',
                style: ZineText.value(size: 14.5), overflow: TextOverflow.ellipsis)),
        ZineSticker('verified', kind: ZineStickerKind.ok,
            icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
      ]));
    }

    // Dismissed (Settings only): hide until the snooze expires.
    if (_dismissed && widget.collapsible) return null;

    // Expanded: the real verification form. Collapse on success.
    if (_expanded) {
      return PhoneVerifyCard(
        source: widget.source,
        onVerified: () { if (mounted) setState(() => _verified = true); },
      );
    }

    // The soft nudge itself.
    return _wrap(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), color: Zine.blue, size: 30),
        const SizedBox(width: 10),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Verify your phone number', style: ZineText.value(size: 15)),
          const SizedBox(height: 2),
          Text('Optional — it adds trust and helps friends find you. Takes a few seconds.',
              style: ZineText.sub(size: 12)),
        ])),
      ]),
      const SizedBox(height: 12),
      Row(children: [
        Expanded(child: ZineButton(
          label: 'Add phone number',
          variant: ZineButtonVariant.blue,
          fullWidth: true,
          fontSize: 15,
          icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
          trailingIcon: false,
          onPressed: _start,
        )),
        if (widget.collapsible) ...[
          const SizedBox(width: 14),
          ZineLink('Not now', onTap: _dismiss),
        ],
      ]),
    ]));
  }

  Widget _wrap(Widget child) => ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        boxShadow: Zine.shadowXs,
        child: child,
      );
}
