import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/api_exception.dart';
import '../../data/repos/auth_repo.dart';
import '../theme.dart';
import '../widgets.dart';
import 'sheets.dart';

enum _Stage { form, emailCode, waSend, code, noAccount, profileCheck, profile, save, age, finish }

/// [HF-APP-AUTH-WA-ONLY-1] Log in = WhatsApp number -> WhatsApp code (a number with no account is
/// sent to Create an account; nothing is created). Create account = name + email + WhatsApp number
/// -> email code -> WhatsApp code -> account made only when both are right. No Google, no email log-in.
/// After sign-in: details only for an older account that lacks a name -> 18+ tick when the server asks. Pops `true` when the person is signed in, so
/// `requireAccount` can resume what they started.
class RealSignUpSheet extends StatefulWidget {
  const RealSignUpSheet({super.key, required this.repo, this.reason, this.login = false});

  final bool login;
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
  final _emailCode = TextEditingController();

  /// The single-use proof from the email code step, and the address it belongs to.
  String? _proof;
  String? _verifiedEmail;

  late bool _login = widget.login;
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
    _emailCode.dispose();
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
        case 'invalid_email':
          return 'Please type a real email.';
        case 'email_taken':
          return e.message ?? 'This email already has an account. Log in with your WhatsApp number instead.';
        case 'email_proof_invalid':
          return 'Your email check has expired. Please verify your email again.';
        case 'too_soon':
        case 'rate_limited':
          return e.message ?? 'Please wait a little before asking for another code.';
      }
      return e.userMessage;
    }
    return ApiException.genericText;
  }

  Future<void> _sendCode() async {
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

  /// Form button. Log in: straight to the WhatsApp code. Create account: check the details, then email a code
  /// (skipped when this same email was already verified in this sheet).
  Future<void> _submitForm() async {
    if (_busy) return;
    if (_login) return _sendCode();
    final problem = AuthRepo.nameProblem(_name.text);
    if (problem != null) return setState(() => _error = problem);
    if (!AuthRepo.validEmail(_email.text)) return setState(() => _error = 'Please type a real email.');
    if (AuthRepo.e164(_wa.text) == null) return setState(() => _error = 'WhatsApp number should be 10 digits.');
    if (_proof != null && _verifiedEmail == _email.text.trim().toLowerCase()) return _sendCode();
    await _sendEmailCode();
  }

  Future<void> _sendEmailCode() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final sent = await widget.repo.sendEmailCode(_email.text);
      if (!mounted) return;
      _emailCode.clear();
      setState(() {
        _stage = _Stage.emailCode;
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
      if (wait != null && wait > 0 && _stage == _Stage.emailCode) _startTimer(wait);
    }
  }

  /// Runs the step the person is on. A failure leaves them on the same step with a plain message,
  /// and the same button tries again (a saved step is never repeated).
  Future<void> _continue() async {
    if (_busy) return;
    if (_stage == _Stage.profile) {
      final problem = AuthRepo.nameProblem(_name.text);
      if (problem != null) return setState(() => _error = problem);
      if (!AuthRepo.validEmail(_email.text)) return setState(() => _error = 'Please type a real email.');
      _stage = _Stage.save;
    }
    if (_stage == _Stage.emailCode && _emailCode.text.replaceAll(RegExp(r'\D'), '').length != 6) {
      return setState(() => _error = 'Type the 6-digit code from your email.');
    }
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
      if (_stage == _Stage.emailCode) {
        final proof = await widget.repo.verifyEmailCode(_email.text, _emailCode.text);
        if (!mounted) return;
        _proof = proof;
        _verifiedEmail = _email.text.trim().toLowerCase();
        _timer?.cancel();
        setState(() {
          _stage = _Stage.waSend;
          _busy = false;
          _resendIn = 0;
        });
        await _sendCode(); // on a failure the person stays here and the button tries again
        return;
      }
      if (_stage == _Stage.code) {
        final signup = _login ? null : SignupDetails(name: _name.text, emailProof: _proof ?? '');
        final r = await widget.repo.verifyCode(_phone, _code.text, signup: signup);
        if (!mounted) return;
        if (r.noAccount) {
          _timer?.cancel();
          setState(() {
            _stage = _Stage.noAccount;
            _busy = false;
            _resendIn = 0;
          });
          return;
        }
        _needsAge = r.needs18Plus;
        if (!_login && r.isNew) {
          // Name and verified email were stored when the account was made: no details step.
          if (_needsAge) {
            setState(() { _stage = _Stage.age; _busy = false; });
            return;
          }
          _stage = _Stage.finish;
        } else {
          _stage = _Stage.profileCheck;
        }
      }
      if (_stage == _Stage.profileCheck) {
        final profile = await widget.repo.profileAfterVerification();
        if (!mounted) return;
        // A saved display name proves the details step completed, including when
        // email collection was disabled. OTP alone never writes a display name.
        if (AuthRepo.nameProblem(profile.name ?? '') != null) {
          _name.text = profile.name ?? '';
          _email.text = profile.email ?? '';
          setState(() { _stage = _Stage.profile; _busy = false; });
          return;
        }
        _stage = _needsAge ? _Stage.age : _Stage.finish;
        if (_needsAge) {
          setState(() => _busy = false);
          return;
        }
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
        _stage = _Stage.finish;
      }
      if (_stage == _Stage.age) {
        await widget.repo.confirmAge();
        _stage = _Stage.finish;
      }
      if (_stage == _Stage.finish) {
        await widget.repo.finish();
        if (mounted) Navigator.of(context).pop(true);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _message(e);
        if (e is ApiException && (e.code == 'code_expired' || e.code == 'too_many_attempts')) _resendIn = 0;
        // The email proof is gone or the email now belongs to an account: back to the details to start the email step again.
        if (e is ApiException && (e.code == 'email_proof_invalid' || e.code == 'email_taken') && _stage == _Stage.code) {
          _proof = null;
          _verifiedEmail = null;
          _stage = _Stage.form;
        }
      });
    }
  }

  /// "Create an account" after a log-in with an unknown number: same sheet, create mode, number kept.
  void _goToCreate() {
    _timer?.cancel();
    _code.clear();
    setState(() {
      _login = false;
      _stage = _Stage.form;
      _error = null;
      _resendIn = 0;
    });
  }

  Future<void> _resend() async {
    _code.clear();
    await _sendCode();
  }

  Widget _label(String text) => Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(text, style: t(15)));

  List<Widget> _profileFields() => [
        Text("Add your details to finish creating your account.", style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
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
      ];

  List<Widget> _signupFields() => [
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
      ];

  List<Widget> _emailCodeFields() => [
        Text('We emailed a 6-digit code to ${_email.text.trim()}.', style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
        const SizedBox(height: 16),
        _label('Code from your email'),
        TextField(
          key: const Key('su-email-code'),
          controller: _emailCode,
          keyboardType: TextInputType.number,
          autofocus: true,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          style: t(28, ls: 0.3),
          decoration: const InputDecoration(hintText: '123456'),
        ),
        const SizedBox(height: 8),
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: TextButton(
                key: const Key('su-email-resend'),
                onPressed: (_resendIn > 0 || _busy) ? null : _sendEmailCode,
                child: Text(_resendIn > 0 ? 'Send a new code in ${_resendIn}s' : 'Send a new code', style: t(15, color: _resendIn > 0 ? C.muted : C.ruby)),
              ),
            ),
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: TextButton(
                key: const Key('su-email-change'),
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
                child: Text('Change email', style: t(15, color: C.maroon)),
              ),
            ),
          ],
        ),
      ];

  List<Widget> _waSendFields() => [
        Text('Your email is verified. Next we send a code to your WhatsApp number, +91 ${_wa.text.replaceAll(RegExp(r'\D'), '')}.', style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
      ];

  List<Widget> _noAccountFields() => [
        Text("We couldn't find an account with this WhatsApp number. Create an account to continue.", key: const Key('su-no-account'), style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
      ];

  List<Widget> _formFields() => [
        Text(
          _login
              ? 'We will send a code to your WhatsApp number to log you in.'
              : 'We will send a code to your email and another on WhatsApp. You need both to create your account.',
          style: t(15, h: 1.4),
        ),
        const SizedBox(height: 16),
        if (!_login) ..._signupFields(),
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
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            TextButton(
              key: const Key('su-resend'),
              onPressed: (_resendIn > 0 || _busy) ? null : _resend,
              child: Text(_resendIn > 0 ? 'Send a new code in ${_resendIn}s' : 'Send a new code', style: t(15, color: _resendIn > 0 ? C.muted : C.ruby)),
            ),
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
      _Stage.form => (_login ? 'Log in' : 'Create account', _login ? 'SEND CODE' : 'SEND EMAIL CODE'),
      _Stage.emailCode => ('Check your email', 'VERIFY EMAIL'),
      _Stage.waSend => ('Now WhatsApp', 'SEND CODE'),
      _Stage.noAccount => ('No account yet', 'CREATE AN ACCOUNT'),
      _Stage.profile => ('Create account', 'SAVE DETAILS'),
      _Stage.profileCheck => ('Checking your account', 'TRY AGAIN'),
      _Stage.finish => ('Almost there', 'TRY AGAIN'),
      _Stage.code => ('Check WhatsApp', 'VERIFY'),
      _Stage.save => ('Almost there', 'TRY AGAIN'),
      _Stage.age => ('One last thing', 'FINISH'),
    };
    final fields = switch (_stage) {
      _Stage.form => _formFields(),
      _Stage.emailCode => _emailCodeFields(),
      _Stage.waSend => _waSendFields(),
      _Stage.noAccount => _noAccountFields(),
      _Stage.profile => _profileFields(),
      _Stage.profileCheck => [Text('Checking whether your account needs any details.', style: t(15))],
      _Stage.finish => _saveFields(),
      _Stage.code => _codeFields(),
      _Stage.save => _saveFields(),
      _Stage.age => _ageFields(),
    };
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SheetFrame(
        child: Flexible(
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
                if (_stage == _Stage.form)
                  TextButton(
                    key: const Key('su-switch-mode'),
                    onPressed: _busy ? null : () => setState(() {
                      _login = !_login;
                      _error = null;
                    }),
                    child: Text(_login ? 'Create account' : 'Log in', style: t(17, color: C.maroon)),
                  ),
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
                  labelSize: button.length > 12 ? 17 : 20,
                  onTap: switch (_stage) {
                    _Stage.form => _submitForm,
                    _Stage.waSend => _sendCode,
                    _Stage.noAccount => _goToCreate,
                    _ => _continue,
                  },
                ),
              ],
            ),
          ),
          ),
        ),
      ),
    );
  }
}
