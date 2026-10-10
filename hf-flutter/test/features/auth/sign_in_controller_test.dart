import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/clerk_client.dart';
import 'package:hf_app/features/auth/data/sign_in_controller.dart';

import '../../support/fake_api_client.dart';

const _send = '/api/auth/whatsapp/send';
const _verify = '/api/auth/whatsapp/verify';

class _Env {
  _Env({bool acked = true, FakeApiClient? api}) : api = api ?? FakeApiClient() {
    this.api
      ..onJson('POST', _send, {'ok': true, 'phone_masked': '+91 ******3210', 'resend_after_s': 30})
      ..onJson('POST', _verify, {'ok': true, 'status': 'signed_in', 'ticket': 't1', 'isNew': true});
    controller = SignInController(
      api: this.api,
      redeem: (ticket, {String? phone}) async {
        tickets.add(ticket);
        redeemedPhone = phone;
        return redeemResult ?? ClerkStep.complete(const ClerkUser(id: 'user_1'));
      },
      afterSignIn: ({required bool tickedNow}) async => afterCalls.add(tickedNow),
      readAcked: () async => acked,
      telemetry: (e, p) => events.add((e, p)),
    );
  }

  final FakeApiClient api;
  late final SignInController controller;
  final List<String> tickets = [];
  final List<bool> afterCalls = [];
  final List<(String, Map<String, Object>)> events = [];
  ClerkStep? redeemResult;
  String? redeemedPhone;

  Map<String, Object> eventProps(String name) => events.firstWhere((e) => e.$1 == name).$2;
  List<String> get names => events.map((e) => e.$1).toList();
}

Future<_Env> ready({bool acked = true, FakeApiClient? api}) async {
  final env = _Env(acked: acked, api: api);
  addTearDown(env.controller.dispose);
  await env.controller.init();
  return env;
}

void main() {
  test('a full sign-in emits started, code_sent and success {is_new}', () async {
    final env = await ready();
    final c = env.controller;
    c.trackStarted('/wallet');
    c.setDigits('9876543210');
    await c.sendCode();
    expect(c.step, SignInStep.code);
    expect(c.resendIn, 30);
    expect(await c.verify('123456'), isTrue);
    expect(env.tickets, ['t1']);
    expect(env.redeemedPhone, '+919876543210');
    expect(env.names, ['hf_app_signin_started', 'hf_app_signin_code_sent', 'hf_app_signin_success']);
    expect(env.eventProps('hf_app_signin_started'), {'from': '/wallet'});
    expect(env.eventProps('hf_app_signin_code_sent'), containsPair('outcome', 'ok'));
    expect(env.eventProps('hf_app_signin_success'), containsPair('is_new', true));
    expect(env.afterCalls, [false]);
    expect(c.signedIn, isTrue);
  });

  test('success without isNew reports is_new false', () async {
    final env = await ready();
    env.api.onJson('POST', _verify, {'ok': true, 'status': 'signed_in', 'ticket': 't1'});
    env.controller.setDigits('9876543210');
    await env.controller.sendCode();
    await env.controller.verify('123456');
    expect(env.eventProps('hf_app_signin_success'), containsPair('is_new', false));
  });

  test('every failure emits hf_app_signin_failed with reason, step and status', () async {
    final env = await ready();
    final c = env.controller;
    c.setDigits('9876543210');
    env.api.onError('POST', _send, const ApiError(status: 400, code: 'not_on_whatsapp'));
    await c.sendCode();
    expect(env.eventProps('hf_app_signin_failed'),
        allOf(containsPair('reason', 'not_on_whatsapp'), containsPair('step', 'send'), containsPair('status', 400)));
    env.events.clear();
    env.api.onJson('POST', _send, {'ok': true, 'resend_after_s': 30});
    await c.sendCode();
    env.events.clear();
    env.api.onError('POST', _verify, const ApiError(status: 400, code: 'wrong_code', extra: {'attempts_left': 3}));
    expect(await c.verify('000000'), isFalse);
    expect(env.eventProps('hf_app_signin_failed'),
        allOf(containsPair('reason', 'wrong_code'), containsPair('step', 'verify')));
    expect(c.attemptsLeft, 3);
  });

  test('no event carries the phone number or the code', () async {
    final env = await ready();
    env.controller.setDigits('9876543210');
    await env.controller.sendCode();
    await env.controller.verify('123456');
    for (final e in env.events) {
      final text = e.$2.toString();
      expect(text, isNot(contains('9876543210')));
      expect(text, isNot(contains('123456')));
    }
  });

  test('a ticket that Clerk refuses is a failure at step ticket and signs nobody in', () async {
    final env = await ready();
    env.redeemResult = ClerkStep.error('nope');
    env.controller.setDigits('9876543210');
    await env.controller.sendCode();
    expect(await env.controller.verify('123456'), isFalse);
    expect(env.eventProps('hf_app_signin_failed'),
        allOf(containsPair('reason', 'ticket_redeem'), containsPair('step', 'ticket')));
    expect(env.controller.signedIn, isFalse);
    expect(env.afterCalls, isEmpty);
  });

  test('age_confirmed is sent only when the person ticked (Welcome earlier, or the tick here)', () async {
    final acked = await ready(acked: true);
    acked.controller.setDigits('9876543210');
    await acked.controller.sendCode();
    await acked.controller.verify('123456');
    expect(acked.api.callsTo('POST', _verify).single.body, containsPair('age_confirmed', true));

    final fresh = await ready(acked: false);
    fresh.controller.setDigits('9876543210');
    expect(fresh.controller.needsTick, isTrue);
    expect(fresh.controller.canSend, isFalse);
    await fresh.controller.sendCode();
    expect(fresh.controller.error, isNotNull, reason: 'refused until ticked');
    expect(fresh.api.callsTo('POST', _send), isEmpty);
    fresh.controller.setAgeTick(true);
    await fresh.controller.sendCode();
    await fresh.controller.verify('123456');
    expect(fresh.api.callsTo('POST', _verify).single.body, containsPair('age_confirmed', true));
    expect(fresh.afterCalls, [true]);
  });

  test('a code that is not six digits is refused without calling the server', () async {
    final env = await ready();
    env.controller.setDigits('9876543210');
    await env.controller.sendCode();
    expect(await env.controller.verify('123'), isFalse);
    expect(env.api.callsTo('POST', _verify), isEmpty);
  });

  test('a second tap while sending does not send twice', () async {
    final env = await ready();
    env.controller.setDigits('9876543210');
    final a = env.controller.sendCode();
    final b = env.controller.sendCode();
    await Future.wait([a, b]);
    expect(env.api.callsTo('POST', _send), hasLength(1));
  });

  test('the server resend gap is honoured, and a missing one falls back to 30 s', () async {
    final env = await ready();
    env.api.onJson('POST', _send, {'ok': true, 'resend_after_s': 45});
    env.controller.setDigits('9876543210');
    await env.controller.sendCode();
    expect(env.controller.resendIn, 45);
    env.api.onJson('POST', _send, {'ok': true});
    await env.controller.sendCode(resend: true);
    expect(env.controller.resendIn, 30);
  });

  test('an answer with neither a ticket nor needs_email is a calm failure', () async {
    final env = await ready();
    env.api.onJson('POST', _verify, {'ok': true});
    env.controller.setDigits('9876543210');
    await env.controller.sendCode();
    expect(await env.controller.verify('123456'), isFalse);
    expect(env.eventProps('hf_app_signin_failed'), containsPair('reason', 'bad_response'));
  });
}
