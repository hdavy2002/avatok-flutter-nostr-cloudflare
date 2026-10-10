import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/links.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/digilocker_pending.dart';
import '../data/kyc_api.dart';
import '../data/kyc_models.dart';
import '../data/kyc_telemetry.dart';
import 'kyc_copy.dart';
import 'kyc_parts.dart';

/// How often to ask again while DigiLocker answers `202 pending`, and how many times (spec 2.13: every 3 s, up to 10).
const Duration kDigiLockerPollInterval = Duration(seconds: 3);
const int kDigiLockerMaxPolls = 10;

/// Seconds before the OTP can be asked for again.
const int kOtpResendSeconds = 30;

/// The shared Aadhaar check (HF-NATIVE-8). Used by host onboarding (`role: host`) and the lane screens
/// (`role: laneCaller`).
///
/// Flow:
///  1. **OTP**: 12-digit number plus consent, then the 6-digit code (`aadhaar/otp`, `aadhaar/verify`).
///  2. **DigiLocker** takes over when the worker says `fallback:"digilocker"` (any of `otp_unavailable`,
///     `otp_no_mobile`, `too_many`, `otp_attempts_exhausted`), or when the person taps "use DigiLocker instead".
///     DigiLocker opens in a Custom Tab. When the person is back (app resume, or the `<scheme>://` return link) the
///     widget runs `digilocker/complete` once; `202 pending` is polled every 3 s, up to 10 times.
///  3. [onVerified] runs once with what the record says (last 4 digits, gender, first name).
///
/// A DigiLocker attempt is remembered per account ([DigiLockerPendingStore], 30 minutes), so a restart, a killed app or
/// a return link that opens another screen still finishes the check here.
///
/// The Aadhaar number lives only in this widget's text field. It is never stored, logged or sent to telemetry,
/// and the field is cleared when the check is done.
class AadhaarVerifyWidget extends ConsumerStatefulWidget {
  const AadhaarVerifyWidget({
    super.key,
    required this.role,
    required this.onVerified,
    this.lane,
    this.resumeNow = false,
  });

  final KycRole role;

  /// Called once, with the record's last 4 digits and gender.
  final void Function(AadhaarResult result) onVerified;

  /// `women` or `lgbtq` when a lane join started the check (saved with the pending attempt).
  final String? lane;

  /// The person just came back from DigiLocker (`dl=return` link): run the completion call right away.
  final bool resumeNow;

  @override
  ConsumerState<AadhaarVerifyWidget> createState() => AadhaarVerifyState();
}

enum _Mode { otpNumber, otpCode, digilocker }

enum _Dl { consent, starting, waiting, checking, failed }

class AadhaarVerifyState extends ConsumerState<AadhaarVerifyWidget> with WidgetsBindingObserver {
  _Mode _mode = _Mode.otpNumber;
  _Dl _dl = _Dl.consent;

  final TextEditingController _aadhaar = TextEditingController();
  final TextEditingController _otp = TextEditingController();
  bool _otpConsent = false;
  bool _dlConsent = false;
  bool _busy = false;

  String? _numberError;
  String? _codeError;
  String? _error;
  String? _fallbackNote;
  int? _attemptsLeft;

  int _cooldown = 0;
  Timer? _cooldownTimer;
  Timer? _pollTimer;
  int _polls = 0;
  bool _completing = false;
  bool _finished = false;
  AadhaarResult? _result;

  KycApi get _api => ref.read(kycApiProvider);
  DigiLockerPendingStore get _store => ref.read(digiLockerPendingStoreProvider);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_restorePending());
  }

  @override
  void didUpdateWidget(covariant AadhaarVerifyWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.resumeNow && !oldWidget.resumeNow && !_finished) unawaited(_restorePending(force: true));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _cooldownTimer?.cancel();
    _pollTimer?.cancel();
    _aadhaar.dispose();
    _otp.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from the Custom Tab (or from the DigiLocker app): check once.
    if (state == AppLifecycleState.resumed && _mode == _Mode.digilocker && _dl == _Dl.waiting && !_finished) {
      _polls = 0;
      unawaited(_complete());
    }
  }

  // --------------------------------------------------------------------------------------------
  // DigiLocker
  // --------------------------------------------------------------------------------------------

  /// Is a DigiLocker check waiting for us (saved earlier, or the return link just opened)? Then finish it.
  Future<void> _restorePending({bool force = false}) async {
    final p = await _store.read();
    if (!mounted || _finished) return;
    final mine = p != null && p.role == widget.role && (widget.lane == null || p.lane == null || p.lane == widget.lane);
    if (mine || widget.resumeNow || force) {
      setState(() {
        _mode = _Mode.digilocker;
        _dl = _Dl.waiting;
      });
      _polls = 0;
      unawaited(_complete());
    }
  }

  void _goDigiLocker({String? note}) {
    _pollTimer?.cancel();
    setState(() {
      _mode = _Mode.digilocker;
      _dl = _Dl.consent;
      _error = null;
      _numberError = null;
      _codeError = null;
      _fallbackNote = note;
      _aadhaar.clear();
      _otp.clear();
      _attemptsLeft = null;
    });
    _cooldownTimer?.cancel();
    _cooldown = 0;
  }

  void _backToOtp() {
    _pollTimer?.cancel();
    unawaited(_store.clear());
    setState(() {
      _mode = _Mode.otpNumber;
      _dl = _Dl.consent;
      _error = null;
      _fallbackNote = null;
    });
  }

  Future<void> _startDigiLocker() async {
    if (!_dlConsent || _dl == _Dl.starting) return;
    setState(() {
      _dl = _Dl.starting;
      _error = null;
    });
    try {
      final out = await _api.digilockerStart(role: widget.role);
      if (!mounted) return;
      final done = out.verified;
      if (done != null) {
        KycTelemetry.kycStep('digilocker_start', 'already_verified');
        await _finish(done);
        return;
      }
      await _store.save(DigiLockerPending(role: widget.role, at: DateTime.now(), lane: widget.lane));
      KycTelemetry.kycStep('digilocker_start', 'started');
      if (!mounted) return;
      setState(() => _dl = _Dl.waiting);
      _polls = 0;
      final opened = await LinkOpener.instance.customTab(out.url!);
      if (!opened && mounted) {
        await _store.clear();
        setState(() {
          _dl = _Dl.consent;
          _error = KycCopy.digiLockerNotOpened;
        });
      }
    } on ApiError catch (e) {
      if (!mounted) return;
      KycTelemetry.kycStep('digilocker_start', 'error', reason: e.code, status: e.status);
      setState(() {
        _dl = _Dl.consent;
        _error = e.userMessage;
      });
    }
  }

  /// `digilocker/complete`. Safe to call from several places: only one runs at a time.
  Future<void> _complete() async {
    if (_completing || _finished || !mounted) return;
    _completing = true;
    _pollTimer?.cancel();
    setState(() {
      _mode = _Mode.digilocker;
      _dl = _Dl.checking;
      _error = null;
    });
    try {
      final out = await _api.digilockerComplete();
      if (!mounted) return;
      final done = out.result;
      if (!out.pending && done != null) {
        KycTelemetry.kycStep('digilocker_complete', 'ok');
        await _store.clear();
        await _finish(done);
        return;
      }
      // 202: DigiLocker has not confirmed yet.
      KycTelemetry.kycStep('digilocker_complete', 'pending');
      _polls += 1;
      if (_polls < kDigiLockerMaxPolls) {
        setState(() {
          _dl = _Dl.waiting;
          _error = null;
        });
        _pollTimer = Timer(kDigiLockerPollInterval, () => unawaited(_complete()));
      } else {
        setState(() {
          _dl = _Dl.waiting;
          _error = out.message ?? KycCopy.digiLockerStillWaiting;
        });
      }
    } on ApiError catch (e) {
      if (!mounted) return;
      await _onCompleteError(e);
    } finally {
      _completing = false;
    }
  }

  Future<void> _onCompleteError(ApiError e) async {
    KycTelemetry.kycStep('digilocker_complete', 'error', reason: e.code, status: e.status);
    // The first call may already have finished the check (resume AND the return link both ran):
    // the worker then says there is no session. Ask the worker whether the Aadhaar is done.
    if (e.code == 'no_session' || e.code == 'session_expired') {
      final recovered = await _recoverIfVerified();
      if (recovered || !mounted) return;
    }
    // Network trouble, a server fault or "still checking": keep the attempt, let the person check again.
    final keep = e.isOffline || e.status >= 500 || e.code == 'retry_later';
    if (!keep) await _store.clear();
    if (!mounted) return;
    setState(() {
      _dl = keep ? _Dl.waiting : _Dl.failed;
      _error = e.userMessage;
    });
  }

  Future<bool> _recoverIfVerified() async {
    try {
      final s = await _api.status();
      if (s.aadhaarDone) {
        await _store.clear();
        if (!mounted) return true;
        await _finish(AadhaarResult(gender: s.gender, last4: s.last4, alreadyVerified: true, viaDigiLocker: true));
        return true;
      }
    } on ApiError {
      // fall through: the original error is shown
    }
    return false;
  }

  void _startAgain() {
    _pollTimer?.cancel();
    unawaited(_store.clear());
    setState(() {
      _dl = _Dl.consent;
      _error = null;
    });
  }

  void _checkAgain() {
    _polls = 0;
    unawaited(_complete());
  }

  // --------------------------------------------------------------------------------------------
  // OTP
  // --------------------------------------------------------------------------------------------

  static String _digits(String s) => s.replaceAll(RegExp(r'\D'), '');

  void _startCooldown() {
    _cooldownTimer?.cancel();
    setState(() => _cooldown = kOtpResendSeconds);
    _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      if (_cooldown <= 1) {
        t.cancel();
        setState(() => _cooldown = 0);
      } else {
        setState(() => _cooldown -= 1);
      }
    });
  }

  Future<void> _sendOtp() async {
    final number = _digits(_aadhaar.text);
    if (number.length != 12 || !_otpConsent || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _numberError = null;
    });
    try {
      final out = await _api.aadhaarOtp(aadhaar: number, role: widget.role);
      if (!mounted) return;
      final done = out.verified;
      if (done != null) {
        KycTelemetry.kycStep('aadhaar_otp', 'already_verified');
        await _finish(done);
        return;
      }
      KycTelemetry.kycStep('aadhaar_otp', 'sent');
      setState(() {
        _mode = _Mode.otpCode;
        _otp.clear();
        _attemptsLeft = null;
        _codeError = null;
      });
      _startCooldown();
    } on ApiError catch (e) {
      if (!mounted) return;
      _onOtpError(e, 'aadhaar_otp');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verifyOtp() async {
    final code = _digits(_otp.text);
    if (code.length != 6 || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _codeError = null;
    });
    try {
      final r = await _api.aadhaarVerify(code);
      if (!mounted) return;
      KycTelemetry.kycStep('aadhaar_verify', 'ok');
      await _finish(r);
    } on ApiError catch (e) {
      if (!mounted) return;
      _onOtpError(e, 'aadhaar_verify');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _onOtpError(ApiError e, String step) {
    // Any `fallback:"digilocker"` answer: OTP cannot work now, so DigiLocker takes over.
    if (kycFallbackOf(e)) {
      KycTelemetry.kycStep(step, 'fallback', reason: e.code, status: e.status);
      _goDigiLocker(note: e.userMessage);
      return;
    }
    KycTelemetry.kycStep(step, 'error', reason: e.code, status: e.status);
    final left = e.extra['attemptsLeft'];
    setState(() {
      if (step == 'aadhaar_otp') {
        if (e.field == 'aadhaar') {
          _numberError = e.userMessage;
        } else {
          _error = e.userMessage;
        }
      } else {
        if (e.code == 'no_otp') {
          // The code request expired: start from the number again.
          _mode = _Mode.otpNumber;
          _error = e.userMessage;
        } else {
          _codeError = e.userMessage;
        }
        _attemptsLeft = left is num ? left.toInt() : null;
        _otp.clear();
      }
    });
  }

  Future<void> _finish(AadhaarResult r) async {
    if (_finished) return;
    _finished = true;
    _pollTimer?.cancel();
    _cooldownTimer?.cancel();
    _aadhaar.clear();
    _otp.clear();
    if (mounted) setState(() => _result = r);
    widget.onVerified(r);
  }

  // --------------------------------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    if (_result != null) return _verifiedCard(_result!);
    switch (_mode) {
      case _Mode.otpNumber:
        return _numberForm();
      case _Mode.otpCode:
        return _codeForm();
      case _Mode.digilocker:
        return _digiLocker();
    }
  }

  Widget _verifiedCard(AadhaarResult r) => HfCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const DoneRow(KycCopy.aadhaarVerified),
            if (r.last4 != null) ...[
              const SizedBox(height: 8),
              Text('${KycCopy.aadhaarEnding} ${r.last4}', style: HfText.bodyText),
            ],
          ],
        ),
      );

  Widget _numberForm() {
    final number = _digits(_aadhaar.text);
    final canSend = number.length == 12 && _otpConsent && !_busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(KycCopy.otpTitle, style: HfText.title),
        const SizedBox(height: 8),
        const Text(KycCopy.otpLead, style: HfText.bodyText),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey<String>('aadhaar-number'),
          controller: _aadhaar,
          keyboardType: TextInputType.number,
          autocorrect: false,
          enableSuggestions: false,
          enableIMEPersonalizedLearning: false,
          autofillHints: const <String>[],
          inputFormatters: [_AadhaarFormatter()],
          style: HfText.bodyStrong.copyWith(letterSpacing: 1.5),
          decoration: InputDecoration(
            labelText: KycCopy.aadhaarNumberLabel,
            hintText: '0000 0000 0000',
            errorText: _numberError,
          ),
          onChanged: (_) => setState(() {
            _numberError = null;
            _error = null;
          }),
        ),
        const SizedBox(height: 12),
        ConsentRow(
          key: const ValueKey<String>('aadhaar-consent'),
          value: _otpConsent,
          onChanged: (v) => setState(() => _otpConsent = v),
          text: KycCopy.otpConsent,
        ),
        if (_error != null) InlineError(_error!),
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('aadhaar-send'),
          label: KycCopy.sendCode,
          loading: _busy,
          onPressed: canSend ? _sendOtp : null,
        ),
        const SizedBox(height: 12),
        const Text(KycCopy.noPhoneLinked, style: HfText.note),
        HfButton(
          key: const ValueKey<String>('use-digilocker'),
          label: KycCopy.useDigiLockerInstead,
          kind: HfButtonKind.text,
          onPressed: () => _goDigiLocker(),
        ),
      ],
    );
  }

  Widget _codeForm() {
    final canVerify = _digits(_otp.text).length == 6 && !_busy;
    final tries = _attemptsLeft;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(KycCopy.codeTitle, style: HfText.title),
        const SizedBox(height: 8),
        const Text(KycCopy.codeLead, style: HfText.bodyText),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey<String>('otp-code'),
          controller: _otp,
          keyboardType: TextInputType.number,
          autocorrect: false,
          enableSuggestions: false,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          style: HfText.title.copyWith(letterSpacing: 6),
          decoration: InputDecoration(labelText: KycCopy.codeLabel, hintText: '······', errorText: _codeError),
          onChanged: (_) => setState(() => _codeError = null),
        ),
        if (tries != null) ...[
          const SizedBox(height: 8),
          Text(tries == 1 ? KycCopy.oneTryLeft : '$tries ${KycCopy.triesLeft}', style: HfText.note),
        ],
        const SizedBox(height: 16),
        HfButton(
          key: const ValueKey<String>('otp-verify'),
          label: KycCopy.verify,
          loading: _busy,
          onPressed: canVerify ? _verifyOtp : null,
        ),
        const SizedBox(height: 8),
        HfButton(
          key: const ValueKey<String>('otp-resend'),
          label: _cooldown > 0 ? '${KycCopy.resendIn} $_cooldown s' : KycCopy.resend,
          kind: HfButtonKind.text,
          onPressed: _cooldown > 0 || _busy ? null : _sendOtp,
        ),
        HfButton(
          key: const ValueKey<String>('otp-change-number'),
          label: KycCopy.changeNumber,
          kind: HfButtonKind.text,
          onPressed: () {
            _cooldownTimer?.cancel();
            setState(() {
              _mode = _Mode.otpNumber;
              _cooldown = 0;
              _otp.clear();
              _attemptsLeft = null;
              _codeError = null;
            });
          },
        ),
        const SizedBox(height: 4),
        const Text(KycCopy.noPhoneLinked, style: HfText.note),
        HfButton(
          key: const ValueKey<String>('use-digilocker'),
          label: KycCopy.useDigiLockerInstead,
          kind: HfButtonKind.text,
          onPressed: () => _goDigiLocker(),
        ),
      ],
    );
  }

  Widget _digiLocker() {
    switch (_dl) {
      case _Dl.checking:
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: LoadingPanel(message: KycCopy.checkingDigiLocker),
        );
      case _Dl.waiting:
        return Column(
          key: const ValueKey<String>('dl-waiting'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(KycCopy.waitingTitle, style: HfText.title),
            const SizedBox(height: 8),
            const Text(KycCopy.waitingLead, style: HfText.bodyText),
            if (_error != null) InlineError(_error!),
            const SizedBox(height: 16),
            HfButton(key: const ValueKey<String>('dl-check'), label: KycCopy.checkAgain, onPressed: _checkAgain),
            HfButton(
              key: const ValueKey<String>('dl-restart'),
              label: KycCopy.startAgain,
              kind: HfButtonKind.text,
              onPressed: _startAgain,
            ),
          ],
        );
      case _Dl.failed:
        return Column(
          key: const ValueKey<String>('dl-failed'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(KycCopy.couldNotFinish, style: HfText.title),
            if (_error != null) InlineError(_error!),
            const SizedBox(height: 16),
            HfButton(key: const ValueKey<String>('dl-restart'), label: KycCopy.tryDigiLockerAgain, onPressed: _startAgain),
            HfButton(
              key: const ValueKey<String>('dl-back-to-otp'),
              label: KycCopy.backToOtp,
              kind: HfButtonKind.text,
              onPressed: _backToOtp,
            ),
          ],
        );
      case _Dl.consent:
      case _Dl.starting:
        return Column(
          key: const ValueKey<String>('dl-consent-screen'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_fallbackNote != null) ...[
              InfoBox(
                key: const ValueKey<String>('dl-fallback-note'),
                title: KycCopy.tryDigiLockerTitle,
                body: _fallbackNote,
              ),
              const SizedBox(height: 16),
            ],
            const Text(KycCopy.digiLockerTitle, style: HfText.title),
            const SizedBox(height: 8),
            const Text(KycCopy.digiLockerLead, style: HfText.bodyText),
            const SizedBox(height: 12),
            ConsentRow(
              key: const ValueKey<String>('dl-consent'),
              value: _dlConsent,
              onChanged: (v) => setState(() => _dlConsent = v),
              text: KycCopy.digiLockerConsent,
            ),
            if (_error != null) InlineError(_error!),
            const SizedBox(height: 16),
            HfButton(
              key: const ValueKey<String>('dl-start'),
              label: KycCopy.verifyWithDigiLocker,
              loading: _dl == _Dl.starting,
              onPressed: _dlConsent ? _startDigiLocker : null,
            ),
            HfButton(
              key: const ValueKey<String>('dl-back-to-otp'),
              label: KycCopy.backToOtp,
              kind: HfButtonKind.text,
              onPressed: _backToOtp,
            ),
          ],
        );
    }
  }
}

/// Shows the number in groups of four (`1234 5678 9012`) and allows 12 digits.
class _AadhaarFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final digits = newValue.text.replaceAll(RegExp(r'\D'), '');
    final d = digits.length > 12 ? digits.substring(0, 12) : digits;
    final b = StringBuffer();
    for (var i = 0; i < d.length; i++) {
      if (i > 0 && i % 4 == 0) b.write(' ');
      b.write(d[i]);
    }
    final text = b.toString();
    return TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
  }
}
