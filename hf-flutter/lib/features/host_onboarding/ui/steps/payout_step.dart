import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../widgets/step_page.dart';
import 'onboarding_copy.dart';

final RegExp _upiRe = RegExp(r'^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$');
final RegExp _ifscRe = RegExp(r'^[A-Z]{4}0[A-Z0-9]{6}$');
final RegExp _accountRe = RegExp(r'^\d{9,18}$');

/// Step `payout`: where the host is paid. UPI ID, bank account number (typed twice) and IFSC go to
/// `POST /api/hosts/payout/verify`; the worker compares the account holder's name with the Aadhaar name.
///
/// The worker needs a valid UPI ID as well as the account (`invalid_upi` otherwise), so it is required here, as on the
/// website. Only the last 4 digits of the account number come back and are shown. Match: done. No match: the masked
/// bank name is shown and the person tries another account. Field errors from the worker (`field: upi | account | ifsc`)
/// show under that field.
class PayoutStep extends ConsumerStatefulWidget {
  const PayoutStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<PayoutStep> createState() => _PayoutStepState();
}

class _PayoutStepState extends ConsumerState<PayoutStep> {
  final TextEditingController _upi = TextEditingController();
  final TextEditingController _account = TextEditingController();
  final TextEditingController _account2 = TextEditingController();
  final TextEditingController _ifsc = TextEditingController();

  bool _busy = false;
  bool _editing = false;
  PayoutResult? _result;
  String? _error;
  final Map<String, String> _fieldErrors = <String, String>{};

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void dispose() {
    _upi.dispose();
    _account.dispose();
    _account2.dispose();
    _ifsc.dispose();
    super.dispose();
  }

  bool get _upiOk => _upiRe.hasMatch(_upi.text.trim());
  bool get _accountOk => _accountRe.hasMatch(_account.text);
  bool get _sameOk => _account.text == _account2.text;
  bool get _ifscOk => _ifscRe.hasMatch(_ifsc.text);
  bool get _valid => _upiOk && _accountOk && _sameOk && _ifscOk;

  Future<void> _verify() async {
    if (!_valid || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _fieldErrors.clear();
      _result = null;
    });
    try {
      final r = await ref.read(kycApiProvider).payoutVerify(
            upi: _upi.text.trim().toLowerCase(),
            account: _account.text,
            ifsc: _ifsc.text,
          );
      if (!mounted) return;
      KycTelemetry.kycStep('payout_verify', r.match ? 'ok' : 'mismatch');
      setState(() {
        _result = r;
        if (r.match) {
          _account.clear();
          _account2.clear();
          _editing = false;
        }
      });
      if (r.match) {
        try {
          await ctx.refresh();
        } on ApiError {
          // saved on the server; Continue re-reads
        }
      }
    } on ApiError catch (e) {
      if (!mounted) return;
      KycTelemetry.kycStep('payout_verify', 'error', reason: e.code, status: e.status);
      setState(() {
        final f = e.field;
        if (f == 'upi' || f == 'account' || f == 'ifsc') {
          _fieldErrors[f!] = e.userMessage;
        } else {
          _error = e.userMessage;
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = ctx.state.kyc;
    final matched = _result?.match == true;
    final done = (k.payoutDone || matched) && !_editing;
    if (done) {
      final last4 = k.payoutLast4 ?? _result?.accountLast4;
      return OnboardingStepPage(
        title: OnboardingCopy.payoutDoneTitle,
        children: [
          HfCard(
            key: const ValueKey<String>('payout-done'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const DoneRow(OnboardingCopy.payoutDoneMatch),
                if (_result?.nameAtBank != null) ...[
                  const SizedBox(height: 12),
                  Text('${OnboardingCopy.nameAtBank}: ${_result!.nameAtBank}', style: HfText.bodyText),
                ],
                if (last4 != null) ...[
                  const SizedBox(height: 4),
                  Text('${OnboardingCopy.accountEnding} $last4', style: HfText.bodyText),
                ],
              ],
            ),
          ),
          const SizedBox(height: 24),
          HfButton(
            key: const ValueKey<String>('payout-continue'),
            label: OnboardingCopy.continueLabel,
            onPressed: () => ctx.next(),
          ),
          HfButton(
            key: const ValueKey<String>('payout-change'),
            label: OnboardingCopy.payoutChange,
            kind: HfButtonKind.text,
            onPressed: () => setState(() {
              _editing = true;
              _result = null;
            }),
          ),
        ],
      );
    }

    return OnboardingStepPage(
      title: OnboardingCopy.payoutTitle,
      lead: OnboardingCopy.payoutLead,
      children: [
        TextField(
          key: const ValueKey<String>('payout-upi'),
          controller: _upi,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.none,
          decoration: InputDecoration(
            labelText: OnboardingCopy.upiLabel,
            hintText: OnboardingCopy.upiHint,
            errorText: _fieldErrors['upi'] ?? (_upi.text.isNotEmpty && !_upiOk ? OnboardingCopy.upiFormat : null),
          ),
          onChanged: (_) => setState(() => _fieldErrors.remove('upi')),
        ),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey<String>('payout-account'),
          controller: _account,
          keyboardType: TextInputType.number,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(18)],
          decoration: InputDecoration(
            labelText: OnboardingCopy.accountLabel,
            errorText: _fieldErrors['account'] ?? (_account.text.isNotEmpty && !_accountOk ? OnboardingCopy.accountFormat : null),
          ),
          onChanged: (_) => setState(() => _fieldErrors.remove('account')),
        ),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey<String>('payout-account2'),
          controller: _account2,
          keyboardType: TextInputType.number,
          autocorrect: false,
          enableSuggestions: false,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(18)],
          decoration: InputDecoration(
            labelText: OnboardingCopy.accountConfirmLabel,
            errorText: _account2.text.isNotEmpty && !_sameOk ? OnboardingCopy.accountSame : null,
          ),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey<String>('payout-ifsc'),
          controller: _ifsc,
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9]')),
            LengthLimitingTextInputFormatter(11),
            _UpperCaseFormatter(),
          ],
          decoration: InputDecoration(
            labelText: OnboardingCopy.ifscLabel,
            hintText: OnboardingCopy.ifscHint,
            errorText: _fieldErrors['ifsc'] ?? (_ifsc.text.isNotEmpty && !_ifscOk ? OnboardingCopy.ifscFormat : null),
          ),
          onChanged: (_) => setState(() => _fieldErrors.remove('ifsc')),
        ),
        const SizedBox(height: 12),
        const Text(OnboardingCopy.payoutKeep, style: HfText.note),
        if (_result != null && !_result!.match) ...[
          const SizedBox(height: 16),
          InfoBox(
            key: const ValueKey<String>('payout-mismatch'),
            title: OnboardingCopy.payoutMismatchTitle,
            body: OnboardingCopy.payoutMismatch,
            color: HfColors.blush,
          ),
        ],
        if (_error != null) InlineError(_error!),
        const SizedBox(height: 20),
        HfButton(
          key: const ValueKey<String>('payout-verify'),
          label: OnboardingCopy.payoutVerify,
          loading: _busy,
          onPressed: _valid ? _verify : null,
        ),
      ],
    );
  }
}

class _UpperCaseFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) =>
      newValue.copyWith(text: newValue.text.toUpperCase());
}
