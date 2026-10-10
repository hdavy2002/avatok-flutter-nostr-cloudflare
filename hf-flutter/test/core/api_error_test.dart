import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/strings.dart';

void main() {
  test('worker error shape: code, message, field, extra', () {
    final e = ApiError.fromResponse(
        400, '{"error":"invalid_code","message":"Wrong code.","field":"code","attempts_left":2}');
    expect(e.status, 400);
    expect(e.code, 'invalid_code');
    expect(e.message, 'Wrong code.');
    expect(e.field, 'code');
    expect(e.extra, {'attempts_left': 2});
    expect(e.userMessage, 'Wrong code.');
    expect(e.fromEdge, isFalse);
  });

  test('a code without a message falls back to simple English', () {
    final e = ApiError.fromResponse(402, '{"error":"low_balance"}');
    expect(e.userMessage, ApiError.fallbackMessageFor('low_balance', 402));
    expect(e.userMessage, isNotEmpty);
  });

  test('not_enabled is a calm state, not an error', () {
    final e = ApiError.fromResponse(404, '{"error":"not_enabled"}');
    expect(e.isNotEnabled, isTrue);
    expect(ApiError.fromResponse(404, '{"error":"not_found"}').isNotEnabled, isFalse);
  });

  test('rate limit reads retry_after_s or resend_after_s', () {
    expect(ApiError.fromResponse(429, '{"error":"rate_limited","retry_after_s":12.2}').retryAfterSeconds, 13);
    expect(ApiError.fromResponse(429, '{"error":"rate_limited","resend_after_s":30}').retryAfterSeconds, 30);
    expect(ApiError.fromResponse(429, '{"error":"rate_limited"}').retryAfterSeconds, isNull);
    expect(ApiError.fromResponse(429, '{"error":"rate_limited"}').isRateLimited, isTrue);
  });

  test('a non-JSON body is the edge, with a status code', () {
    final e = ApiError.fromResponse(502, '<html>Bad gateway</html>');
    expect(e.fromEdge, isTrue);
    expect(e.code, 'http_502');
    expect(e.userMessage, Strings.somethingWrong);
  });

  test('401 without a body is unauthorized', () {
    final e = ApiError.fromResponse(401, '');
    expect(e.isUnauthorized, isTrue);
    expect(e.code, ApiError.codeUnauthorized);
    expect(e.userMessage, Strings.signInAgain);
  });

  test('{error: {code, message}} is tolerated', () {
    final e = ApiError.fromResponse(400, '{"error":{"code":"blocked","message":"No."}}');
    expect(e.code, 'blocked');
    expect(e.message, 'No.');
  });

  test('network and timeout are offline', () {
    expect(ApiError.network().isOffline, isTrue);
    expect(ApiError.network().userMessage, Strings.noInternet);
    expect(ApiError.timeout().isOffline, isTrue);
    expect(ApiError.timeout().userMessage, Strings.timedOut);
    expect(ApiError.badResponse(200).isOffline, isFalse);
  });

  test('unknown 5xx falls back to something-went-wrong', () {
    expect(ApiError.fromResponse(500, '{"error":"weird"}').userMessage, Strings.somethingWrong);
  });
}
