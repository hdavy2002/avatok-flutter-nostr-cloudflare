import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/auth/data/auth_messages.dart';

void main() {
  group('normalizeIndianMobile', () {
    test('keeps 10 digits and understands pasted forms', () {
      expect(normalizeIndianMobile('9876543210'), '9876543210');
      expect(normalizeIndianMobile('+91 98765 43210'), '9876543210');
      expect(normalizeIndianMobile('919876543210'), '9876543210');
      expect(normalizeIndianMobile('09876543210'), '9876543210');
      expect(normalizeIndianMobile('98765-43210'), '9876543210');
      expect(normalizeIndianMobile('abc'), '');
      expect(normalizeIndianMobile('98765432109999'), '9876543210');
    });

    test('a partial number is left alone', () {
      expect(normalizeIndianMobile('98765'), '98765');
      expect(normalizeIndianMobile('91'), '91');
    });
  });

  test('isValidIndianMobile is ^[6-9]\\d{9}\$', () {
    expect(isValidIndianMobile('9876543210'), isTrue);
    expect(isValidIndianMobile('6000000000'), isTrue);
    expect(isValidIndianMobile('5876543210'), isFalse);
    expect(isValidIndianMobile('987654321'), isFalse);
    expect(isValidIndianMobile('98765432100'), isFalse);
    expect(isValidIndianMobile(''), isFalse);
  });

  test('toE164India adds +91', () => expect(toE164India('9876543210'), '+919876543210'));

  test('the input formatter strips a pasted prefix', () {
    const f = IndianMobileFormatter();
    final out = f.formatEditUpdate(TextEditingValue.empty, const TextEditingValue(text: '+91 98765 43210'));
    expect(out.text, '9876543210');
    expect(out.selection.baseOffset, 10);
  });

  group('mapSignInError', () {
    // Every code the two calls can answer (worker/src/routes/whatsapp_auth.ts), with and without the worker's words.
    const codes = <String>[
      'invalid_phone',
      'not_on_whatsapp',
      'rate_limited',
      'otp_unavailable',
      'provider_error',
      'invalid_code',
      'no_code',
      'wrong_code',
      'code_expired',
      'too_many_attempts',
      'verify_failed',
      'signin_failed',
      'signup_failed',
      'signup_in_progress',
      'banned',
      'suspended',
      'account_closing',
    ];

    for (final stage in SignInStage.values) {
      for (final code in codes) {
        test('$code at ${stage.name} has a friendly line even with no message from the server', () {
          final f = mapSignInError(ApiError(status: 400, code: code), stage);
          expect(f.message, isNotEmpty);
          expect(f.message, isNot(contains('_')), reason: 'a code leaked into the message: ${f.message}');
          expect(f.reason, code);
        });
      }
    }

    test('an unknown code uses the worker words, then a calm default', () {
      final withWords = mapSignInError(
          const ApiError(status: 400, code: 'brand_new', message: 'Something specific.'), SignInStage.verify);
      expect(withWords.message, 'Something specific.');
      final without = mapSignInError(const ApiError(status: 500, code: 'http_500'), SignInStage.verify);
      expect(without.message, 'Something went wrong. Please try again.');
    });

    test('rate_limited with retry_after_s becomes a countdown', () {
      final f = mapSignInError(
          const ApiError(status: 429, code: 'rate_limited', extra: {'retry_after_s': 1}), SignInStage.send);
      expect(f.retryAfterSeconds, 1);
      expect(f.message, 'Please wait 1 second before asking for another code.');
    });

    test('wrong_code reads the tries left, and the last one allows a new code', () {
      final two = mapSignInError(
          const ApiError(status: 400, code: 'wrong_code', extra: {'attempts_left': 2}), SignInStage.verify);
      expect(two.message, 'That code is not right. 2 tries left.');
      expect(two.allowResend, isFalse);
      final none = mapSignInError(
          const ApiError(status: 400, code: 'wrong_code', extra: {'attempts_left': 0}), SignInStage.verify);
      expect(none.allowResend, isTrue);
    });

    test('dead codes allow asking for a new one at once', () {
      for (final code in ['code_expired', 'too_many_attempts', 'no_code']) {
        expect(mapSignInError(ApiError(status: 400, code: code), SignInStage.verify).allowResend, isTrue, reason: code);
      }
    });

    test('offline and slow answers say so', () {
      expect(mapSignInError(ApiError.network(), SignInStage.send).message, 'No internet. Check your connection.');
      expect(mapSignInError(ApiError.timeout(), SignInStage.verify).message, 'That took too long. Please try again.');
    });
  });
}
