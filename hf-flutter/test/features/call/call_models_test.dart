import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/call/data/call_models.dart';
import 'package:hf_app/features/review/data/review_api.dart';

void main() {
  group('CallStatus', () {
    test('parses every status the worker sends', () {
      for (final s in [
        'ringing_host', 'ringing_caller', 'connected', 'completed', 'host_declined', 'no_answer',
        'caller_no_answer', 'failed', 'blocked',
      ]) {
        expect(CallStatus.parse(s).wire, s);
      }
    });

    test('terminal statuses stop polling, the others keep it going', () {
      const terminal = {
        CallStatus.completed, CallStatus.hostDeclined, CallStatus.noAnswer, CallStatus.callerNoAnswer,
        CallStatus.failed, CallStatus.blocked,
      };
      for (final s in CallStatus.values) {
        expect(s.isTerminal, terminal.contains(s), reason: s.wire);
      }
    });

    test('an unknown status is not terminal (keep polling)', () {
      expect(CallStatus.parse('something_new'), CallStatus.unknown);
      expect(CallStatus.parse(null), CallStatus.unknown);
      expect(CallStatus.unknown.isTerminal, isFalse);
    });

    test('only the two ringing statuses can be cancelled', () {
      expect(CallStatus.ringingHost.isRinging, isTrue);
      expect(CallStatus.ringingCaller.isRinging, isTrue);
      expect(CallStatus.connected.isRinging, isFalse);
    });
  });

  group('CallInfo', () {
    test('old rupee call', () {
      final i = CallInfo.fromJson({
        'id': 'c1', 'status': 'completed', 'hostSlug': 'asha', 'hostName': 'Asha Verma', 'rate': 12,
        'connectedAt': 1760000000, 'endedAt': 1760000200000, 'billedMinutes': 3, 'chargedRupees': 36,
        'endReason': 'caller_hangup', 'canReview': true,
      });
      expect(i.isTokenCall, isFalse);
      expect(i.talkedSeconds, 180);
      expect(i.hostFirstName, 'Asha');
      expect(i.canReview, isTrue);
      expect(CallStrings.chargedText(i), '₹36');
      // seconds and milliseconds both become the same kind of time
      expect(i.connectedAt!.millisecondsSinceEpoch, 1760000000000);
      expect(i.endedAt!.millisecondsSinceEpoch, 1760000200000);
    });

    test('token call: exact seconds and the tokens text from the server', () {
      final i = CallInfo.fromJson({
        'id': 'c2', 'status': 'completed', 'billedMinutes': 2, 'chargedRupees': 0, 'billableSeconds': 72,
        'tokensSpent': '1.20',
      });
      expect(i.isTokenCall, isTrue);
      expect(i.talkedSeconds, 72);
      expect(CallStrings.chargedText(i), '1.20 tokens');
      expect(CallStrings.hasCharge(i), isTrue);
    });

    test('a missing host name falls back to a friendly stand-in', () {
      expect(CallInfo.fromJson({'id': 'c', 'status': 'failed'}).hostFirstName, 'your host');
    });

    test('no charge is detected for both kinds of call', () {
      expect(CallStrings.hasCharge(CallInfo.fromJson({'id': 'c', 'status': 'no_answer', 'chargedRupees': 0})), isFalse);
      expect(CallStrings.hasCharge(CallInfo.fromJson({'id': 'c', 'status': 'no_answer', 'tokensSpent': '0.00'})), isFalse);
    });
  });

  group('CallEstimate', () {
    test('token mode', () {
      final e = CallEstimate.fromJson({
        'mode': 'tokens', 'ratePerMinRupees': 12, 'tokensPerMinute': '15.00', 'aboutText': 'about 3 min 20 s',
        'affordableSeconds': 200, 'canStart': false, 'hasDebt': true, 'balance': '45.20',
      });
      expect(e.isTokens, isTrue);
      expect(e.tokensPerMinute, '15.00');
      expect(e.canStart, isFalse);
      expect(e.hasDebt, isTrue);
    });

    test('old mode can always try: the start call is the authority', () {
      final e = CallEstimate.fromJson({'mode': 'inr', 'ratePerMinRupees': 10});
      expect(e.isTokens, isFalse);
      expect(e.canStart, isTrue);
    });
  });

  group('end reasons in simple English', () {
    test('every reason the worker sends has a sentence', () {
      for (final r in ['caller_hangup', 'host_hangup', 'hash_block', 'time_limit', 'balance', 'error']) {
        expect(CallStrings.endReasonText(r, 'Asha'), isNotNull, reason: r);
      }
      expect(CallStrings.endReasonText('host_hangup', 'Asha'), 'Asha ended the call.');
      expect(CallStrings.endReasonText(null, 'Asha'), isNull);
      expect(CallStrings.endReasonText('something_new', 'Asha'), isNull);
    });
  });

  group('CallStartProblem.fromError (spec 2.8 table)', () {
    CallStartProblem map(int status, String code, [Map<String, Object?> extra = const {}]) =>
        CallStartProblem.fromError(ApiError(status: status, code: code, message: 'server text', extra: extra));

    test('each code maps to its action', () {
      expect(map(404, 'not_enabled').kind, CallProblemKind.comingSoon);
      expect(map(503, 'calls_not_ready').kind, CallProblemKind.message);
      expect(map(409, 'account_closing').kind, CallProblemKind.message);
      expect(map(409, 'host_unavailable').kind, CallProblemKind.hostUnavailable);
      expect(map(409, 'call_in_progress').kind, CallProblemKind.callInProgress);
      expect(map(403, 'not_verified').kind, CallProblemKind.signIn);
      expect(map(403, 'lane_required', {'lane': 'lgbtq'}).kind, CallProblemKind.lane);
      expect(map(403, 'lane_required', {'lane': 'lgbtq'}).lane, 'lgbtq');
      expect(map(403, 'lane_required').lane, 'women');
      expect(map(402, 'low_balance', {'needed': 24, 'balance': 5}).kind, CallProblemKind.wallet);
      expect(map(402, 'low_balance', {'shortfallTokens': '2.00', 'shortfallPaise': 200}).kind, CallProblemKind.wallet);
      expect(map(409, 'debt_open').kind, CallProblemKind.debt);
      expect(map(503, 'wallet_busy').kind, CallProblemKind.retry);
      expect(map(502, 'call_failed').kind, CallProblemKind.retry);
      expect(map(429, 'rate_limited').kind, CallProblemKind.retry);
      expect(map(429, 'something').kind, CallProblemKind.retry);
      expect(map(500, 'internal_error').kind, CallProblemKind.retry);
      expect(CallStartProblem.fromError(ApiError.network()).kind, CallProblemKind.retry);
      expect(CallStartProblem.fromError(ApiError.timeout()).kind, CallProblemKind.retry);
    });

    test('host_unavailable never uses the server text (never a rejection)', () {
      expect(map(409, 'host_unavailable').message, "This host isn't available right now.");
      expect(map(409, 'blocked').message, "This host isn't available right now.");
    });

    test('other codes show the worker message', () {
      expect(map(402, 'low_balance').message, 'server text');
    });
  });

  group('ReviewRules', () {
    test('stars are required', () {
      expect(ReviewRules.validate(stars: 0, text: ''), ReviewRules.needStars);
      expect(ReviewRules.validate(stars: 6, text: ''), ReviewRules.needStars);
    });

    test('text is optional', () {
      expect(ReviewRules.validate(stars: 5, text: ''), isNull);
      expect(ReviewRules.validate(stars: 3, text: '   \n '), isNull);
    });

    test('a few words are fine; one or two characters or a repeated character is junk', () {
      expect(ReviewRules.validate(stars: 4, text: 'Very kind and patient'), isNull);
      expect(ReviewRules.validate(stars: 4, text: 'ok'), ReviewRules.tooShort);
      expect(ReviewRules.validate(stars: 4, text: 'aaaaaa'), ReviewRules.tooShort);
      expect(ReviewRules.validate(stars: 4, text: '......'), ReviewRules.tooShort);
    });

    test('500 characters is the limit', () {
      expect(ReviewRules.validate(stars: 4, text: 'ab' * 250), isNull);
      expect(ReviewRules.validate(stars: 4, text: '${'ab' * 250}c'), ReviewRules.tooLong);
    });

    test('phone numbers, emails, links and handles are refused', () {
      for (final t in [
        'call me on 9876543210',
        'my number is 98765 43210 ok',
        'write to asha@example.com please',
        'see https://example.com now',
        'visit www.example.com',
        'find me at @ashaji',
      ]) {
        expect(ReviewRules.validate(stars: 5, text: t), ReviewRules.contact, reason: t);
      }
    });

    test('ordinary numbers in a sentence are fine', () {
      expect(ReviewRules.validate(stars: 5, text: 'We talked for 20 minutes and it was lovely'), isNull);
      expect(ReviewRules.validate(stars: 5, text: 'Gave me 5 good ideas in 10 minutes'), isNull);
    });

    test('the body sends only what is set, with the text cleaned', () {
      expect(const ReviewDraft(stars: 5).toJson(), {'stars': 5});
      expect(const ReviewDraft(stars: 4, text: '  Very   kind \n person ', topic: 'stress').toJson(),
          {'stars': 4, 'text': 'Very kind person', 'topic': 'stress'});
    });

    test('server errors map to simple messages', () {
      expect(reviewErrorMessage(const ApiError(status: 422, code: 'contact_details', message: 'x')), ReviewRules.contact);
      expect(reviewErrorMessage(const ApiError(status: 422, code: 'text_too_short', message: 'Write a few words, or leave the text empty.')),
          'Write a few words, or leave the text empty.');
      expect(reviewErrorMessage(ApiError.network()), 'No internet. Check your connection.');
    });
  });
}
