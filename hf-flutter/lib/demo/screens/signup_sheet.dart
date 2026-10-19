import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/api_exception.dart';
import '../../data/repos/auth_repo.dart';
import '../theme.dart';
import '../widgets.dart';
import 'sheets.dart';

enum _Stage { form, code, save, age }

/// Real fan sign-up (HF-WIRE-2): name, email, WhatsApp number -> 6-digit code from WhatsApp -> signed in
/// -> details saved -> 18+ tick when the server asks. Pops `true` when the person is signed in, so
/// `requireAccount` can resume what they started.
class RealSignUpSheet extends StatefulWidget {
  const RealSignUpSheet({super.key, required this.repo, this.reason});

  final AuthRepo repo;
  final String? reason;

  @override
  State<RealSignUpSheet> createState() => _RealSignUpSheetState();
}

class _RealSignUpSheetState extends State<RealSignUpSheet> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _wa = TextEditingController();
  final _code = TextEditingController();

  _Stage _stage = _Stage.form;
  bool _busy = false;
  bool _over18 = false;
  bool _needsAge = false;
  String? _error;
  int _resendIn = 0;
  Timer? _timer;

  String get _phone => AuthRepo.e164(_wa.text) ?? '';

  @override
  void dispose() {
    _timer?.cancel();
    _name.dispose();
    _email.dispose();
    _wa.dispose();
    _code.dispose();
    super.dispose();
  }

  void _startTimer(int seconds) {
    _timer?.cancel();
    setState(() => _resendIn = seconds);
    if (seconds <= 0) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _resendIn = _resendIn > 0 ? _resendIn - 1 : 0);
      if (_resendIn == 0) t.cancel();
    });
  }

  String _message(Object e) {
    if (e is AuthFailure) return e.message;
    if (e is ApiException) {
      if (e.isOffline) return ApiException.offlineText;
      switch (e.code) {
        case 'wrong_code':
          return e.message ?? "That code isn't right. Please check and try again.";
        case 'code_expired':
          return 'That code has expired. Tap "Send a new code".';
        case 'too_many_attempts':
          return 'Too many wrong tries. Tap "Send a new code".';
        case 'no_code':
          return 'Please ask for a code first.';
        case 'not_on_whatsapp':
          return e.message ?? "This number isn't on WhatsApp. Use a mobile number that has WhatsApp.";
        case 'invalid_phone':
          return 'WhatsApp number should be 10 digits.';
      }
      return e.userMessage;
    }
    return ApiException.genericText;
  }

  Future<void> _sendCode() async {
    final nameProblem = AuthRepo.nameProblem(_name.text);
    if (nameProblem != null) return setState(() => _error = nameProblem);
    if (!AuthRepo.validEmail(_email.text)) return setState(() => _error = 'Please type a real email.');
    if (AuthRepo.e164(_wa.text) == null) return setState(() => _error = 'WhatsApp number should be 10 digits.');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final sent = await widget.repo.sendCode(_phone);
      if (!mounted) return;
      _code.clear();
      setState(() {
        _stage = _Stage.code;
        _busy = false;
      });
      _startTimer(sent.resendAfterSeconds);
    } catch (e) {
      if (!mounted) return;
      final wait = e is ApiException ? e.retryAfterSeconds : null;
      setState(() {
        _busy = false;
        _error = _message(e);
      });
      if (wait != null && wait > 0 && _stage == _Stage.code) _startTimer(wait);
    }
  }

  /// Runs the step the person is on. A failure leaves them on the same step with a plain message,
  /// and the same button tries again (a saved step is never repeated).
  Future<void> _continue() async {
    if (_busy) return;
    if (_stage == _Stage.code && _code.text.replaceAll(RegExp(r'\D'), '').length != 6) {
      return setState(() => _error = 'Type the 6-digit code from WhatsApp.');
    }
    if (_stage == _Stage.age && !_over18) {
      return setState(() => _error = 'Please tick the box to continue.');
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_stage == _Stage.code) {
        final r = await widget.repo.verifyCode(_phone, _code.text);
        _needsAge = r.needs18Plus;
        _stage = _Stage.save;
      }
      if (_stage == _Stage.save) {
        await widget.repo.saveProfile(name: _name.text, email: _email.text);
        if (_needsAge) {
          if (!mounted) return;
          setState(() {
            _stage = _Stage.age;
            _busy = false;
          });
          return;
        }
        await widget.repo.finish();
        if (mounted) Navigator.of(context).pop(true);
        return;
      }
      if (_stage == _Stage.age) {
        await widget.repo.confirmAge();
        await widget.repo.finish();
        if (mounted) Navigator.of(context).pop(true);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _message(e);
        if (e is ApiException && (e.code == 'code_expired' || e.code == 'too_many_attempts')) _resendIn = 0;
      });
    }
  }

  Future<void> _resend() async {
    _code.clear();
    await _sendCode();
  }

  Widget _label(String text) => Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(text, style: t(15)));

  List<Widget> _formFields() => [
        Text("Three things, then you're in. Your number is never shown to anyone.", style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 16),
        _label('Your name'),
        TextField(
          key: const Key('su-name'),
          controller: _name,
          textCapitalization: TextCapitalization.words,
          style: t(17, w: FontWeight.w700),
          decoration: const InputDecoration(hintText: 'Tara Sharma'),
        ),
        const SizedBox(height: 12),
        _label('Email'),
        TextField(
          key: const Key('su-email'),
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          style: t(17, w: FontWeight.w700),
          decoration: const InputDecoration(hintText: 'you@example.com'),
        ),
        const SizedBox(height: 12),
        Text.rich(TextSpan(children: [
          TextSpan(text: 'WhatsApp number  ', style: t(15)),
          TextSpan(text: 'we send a code here', style: t(14, color: C.muted, w: FontWeight.w700)),
        ])),
        const SizedBox(height: 6),
        Row(
          children: [
            Container(
              height: 58,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(color: C.gold, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.deep, width: 3)),
              child: Text('+91', style: t(17)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: TextField(
                key: const Key('su-wa'),
                controller: _wa,
                keyboardType: TextInputType.phone,
                style: t(17, w: FontWeight.w700),
                decoration: const InputDecoration(hintText: '98765 43210'),
              ),
            ),
          ],
        ),
      ];

  List<Widget> _codeFields() => [
        Text('We sent a 6-digit code on WhatsApp to +91 ${_wa.text.replaceAll(RegExp(r'\D'), '')}.', style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 16),
        _label('Code from WhatsApp'),
        TextField(
          key: const Key('su-code'),
          controller: _code,
          keyboardType: TextInputType.number,
          autofocus: true,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          style: t(28, ls: 0.3),
          decoration: const InputDecoration(hintText: '123456'),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            TextButton(
              key: const Key('su-resend'),
              onPressed: (_resendIn > 0 || _busy) ? null : _resend,
              child: Text(_resendIn > 0 ? 'Send a new code in ${_resendIn}s' : 'Send a new code', style: t(15, color: _resendIn > 0 ? C.muted : C.ruby)),
            ),
            const Spacer(),
            TextButton(
              key: const Key('su-change'),
              onPressed: _busy
                  ? null
                  : () {
                      _timer?.cancel();
                      setState(() {
                        _stage = _Stage.form;
                        _error = null;
                        _resendIn = 0;
                      });
                    },
              child: Text('Change number', style: t(15, color: C.maroon)),
            ),
          ],
        ),
      ];

  List<Widget> _saveFields() => [
        Text("You're verified. One more try to save your details.", style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
      ];

  List<Widget> _ageFields() => [
        Text('Last step. This is a friendly conversation, not counselling or advice.', style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 14),
        InkWell(
          key: const Key('su-18'),
          onTap: () => setState(() => _over18 = !_over18),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Checkbox(value: _over18, activeColor: C.maroon, onChanged: (v) => setState(() => _over18 = v ?? false)),
              const SizedBox(width: 4),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text("I'm 18 or over and I agree to the terms and safety rules.", style: t(15, h: 1.35)),
                ),
              ),
            ],
          ),
        ),
      ];

  @override
  Widget build(BuildContext context) {
    final (title, button) = switch (_stage) {
      _Stage.form => ('Say hello!', 'SEND CODE'),
      _Stage.code => ('Check WhatsApp', 'VERIFY'),
      _Stage.save => ('Almost there', 'TRY AGAIN'),
      _Stage.age => ('One last thing', 'FINISH'),
    };
    final fields = switch (_stage) {
      _Stage.form => _formFields(),
      _Stage.code => _codeFields(),
      _Stage.save => _saveFields(),
      _Stage.age => _ageFields(),
    };
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SheetFrame(
        child: SingleChildScrollView(
          child: Padding(
            padding: EdgeInsets.fromLTRB(26, 8, 26, MediaQuery.paddingOf(context).bottom + 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('ONE STEP ${widget.reason == null ? 'TO CONTINUE' : widget.reason!.toUpperCase()}', style: t(14, color: C.ruby, ls: 0.14)),
                const SizedBox(height: 4),
                Text(title, style: t(32, color: C.maroon, ls: 0.03, h: 1.05)),
                const SizedBox(height: 4),
                ...fields,
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  Text(_error!, key: const Key('su-error'), style: t(14, color: C.ruby)),
                ],
                const SizedBox(height: 20),
                TicketButton(
                  label: _busy ? 'PLEASE WAIT' : button,
                  maroon: true,
                  enabled: !_busy,
                  stubIcon: Icons.arrow_forward_rounded,
                  onTap: _stage == _Stage.form ? _sendCode : _continue,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
