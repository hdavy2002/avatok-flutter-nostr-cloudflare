import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/app.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/router/routes.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/host_onboarding/flow/onboarding_steps.dart';
import 'package:hf_app/features/host_onboarding/ui/step_registry.dart';
import 'package:hf_app/features/host_onboarding/ui/steps/onboarding_copy.dart';
import 'package:hf_app/features/kyc/kyc.dart';
import 'package:hf_app/features/lanes/data/lanes_api.dart';
import 'package:hf_app/features/lanes/ui/lanes_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';
import '../../support/kyc_fakes.dart';

const _me = '/api/hosts/me';
const _phone = '/api/account/phone/status';
const _payout = '/api/hosts/payout/verify';

Map<String, Object?> hostsMe({Map<String, Object?>? host, Map<String, Object?> kyc = const {}}) =>
    {'host': host, 'kyc': kyc, 'media': <Object?>[], 'job': null};

const draft = <String, Object?>{'status': 'draft'};
const aadhaarOnly = <String, Object?>{
  'aadhaar': {'done': true, 'gender': 'F', 'last4': '1234', 'role': 'host'},
};
const selfieSent = <String, Object?>{
  'aadhaar': {'done': true, 'gender': 'F', 'last4': '1234', 'role': 'host'},
  'selfie': {'status': 'pending'},
};
const allIdentity = <String, Object?>{
  'aadhaar': {'done': true, 'gender': 'F', 'last4': '1234', 'role': 'host'},
  'selfie': {'status': 'pending'},
  'payout': {'done': true, 'accountLast4': '6789'},
};

void main() {
  late FakeApiClient api;
  late FakeLinkOpener links;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    api = FakeApiClient()..onJson('GET', _phone, {'verified': true, 'phone': '+91 98765 41234'});
    links = FakeLinkOpener();
    LinkOpener.instance = links;
  });

  tearDown(() => LinkOpener.instance = const LinkOpener());

  Future<void> open(WidgetTester tester, {String? step, String? location, List<Override> overrides = const []}) async {
    usePhoneScreen(tester);
    final container = ProviderContainer(overrides: [
      sessionProvider.overrideWith(() => StubSession(signedInState())),
      apiClientProvider.overrideWithValue(api),
      secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
      initialLocationProvider.overrideWithValue(location ?? Routes.hostOnboardingAt(step)),
      ...overrides,
    ]);
    addTearDown(container.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: const HfApp(listenForLinks: false),
    ));
    await settle(tester, 10);
  }

  bool onStep(String key) => find.byKey(ValueKey<String>('onboarding-step-$key')).evaluate().isNotEmpty;

  group('resume', () {
    testWidgets('a new person sees the welcome step; Start opens the phone step, passed by itself', (tester) async {
      api.onJson('GET', _me, hostsMe());
      await open(tester);
      expect(onStep('welcome'), isTrue);
      expect(find.text(OnboardingCopy.needTitle), findsOneWidget);

      await tapKey(tester, 'welcome-start');
      expect(onStep('phone'), isTrue);
      expect(find.text('+91 •••• 1234 verified'), findsOneWidget);

      await tapKey(tester, 'phone-continue');
      expect(onStep('aadhaar'), isTrue);
    });

    testWidgets('Aadhaar not done: opens at Aadhaar, with the progress header', (tester) async {
      api.onJson('GET', _me, hostsMe(host: draft));
      await open(tester);
      expect(onStep('aadhaar'), isTrue);
      expect(find.byKey(const ValueKey<String>('aadhaar-number')), findsOneWidget);
      expect(find.textContaining('Step 3 of 16'), findsOneWidget);
    });

    testWidgets('Aadhaar done, no video yet: opens at the selfie video', (tester) async {
      api
        ..onJson('GET', _me, hostsMe(host: draft, kyc: aadhaarOnly))
        ..onJson('POST', '/api/hosts/kyc/selfie/code', {'code': '5512'});
      await open(tester);
      expect(onStep('selfie'), isTrue);
      expect(find.text('5512'), findsOneWidget);
    });

    testWidgets('video sent: opens at payout', (tester) async {
      api.onJson('GET', _me, hostsMe(host: draft, kyc: selfieSent));
      await open(tester);
      expect(onStep('payout'), isTrue);
      expect(find.byKey(const ValueKey<String>('payout-upi')), findsOneWidget);
    });

    testWidgets('?step=payout cannot skip an unfinished selfie: it opens at selfie', (tester) async {
      api
        ..onJson('GET', _me, hostsMe(host: draft, kyc: aadhaarOnly))
        ..onJson('POST', '/api/hosts/kyc/selfie/code', {'code': '5512'});
      await open(tester, step: 'payout');
      expect(onStep('selfie'), isTrue);
      expect(onStep('payout'), isFalse);
    });

    testWidgets('?step=aadhaar goes back to the finished Aadhaar summary', (tester) async {
      api.onJson('GET', _me, hostsMe(host: draft, kyc: selfieSent));
      await open(tester, step: 'aadhaar');
      expect(onStep('aadhaar'), isTrue);
      expect(find.byKey(const ValueKey<String>('aadhaar-done')), findsOneWidget);
      expect(find.text('${KycCopy.aadhaarEnding} 1234'), findsOneWidget);
    });

    testWidgets('a rejected video asks for a new one and shows the reason', (tester) async {
      api
        ..onJson(
            'GET',
            _me,
            hostsMe(host: draft, kyc: {
              'aadhaar': {'done': true, 'role': 'host'},
              'selfie': {'status': 'rejected', 'reason': 'Your face was not clear.'},
            }))
        ..onJson('POST', '/api/hosts/kyc/selfie/code', {'code': '7001'});
      await open(tester);
      expect(onStep('selfie'), isTrue);
      expect(find.byKey(const ValueKey<String>('selfie-rejected')), findsOneWidget);
      expect(find.text('Your face was not clear.'), findsOneWidget);
    });

    testWidgets('a flag that is off shows Coming soon', (tester) async {
      api.onError('GET', _me, const ApiError(status: 404, code: 'not_enabled'));
      await open(tester);
      expect(find.text('Coming soon'), findsOneWidget);
    });
  });

  group('part B plugs in', () {
    testWidgets('a step nobody registered shows the calm placeholder', (tester) async {
      api.onJson('GET', _me, hostsMe(host: draft, kyc: allIdentity));
      // Part B is registered for real now (HF-NATIVE-10); only part A is given here, as if nobody had registered.
      await open(tester, overrides: [onboardingStepBuildersProvider.overrideWithValue(partAStepBuilders)]);
      expect(onStep('avatar'), isTrue);
      expect(find.text(OnboardingCopy.notBuiltTitle), findsOneWidget);
    });

    testWidgets('a registered builder is shown, gets the server state, and next() moves on', (tester) async {
      api.onJson('GET', _me, hostsMe(host: {'status': 'draft', 'displayName': 'Asha'}, kyc: allIdentity));
      String? sawName;
      await open(tester, overrides: [
        onboardingStepBuildersProvider.overrideWithValue({
          ...partAStepBuilders,
          OnboardingKeys.avatar: (context, ctx) {
            sawName = ctx.state.hostString('displayName');
            return TextButton(
              key: const ValueKey<String>('fake-avatar-next'),
              onPressed: () => ctx.next(),
              child: const Text('Avatar test step'),
            );
          },
        }),
      ]);
      expect(find.text('Avatar test step'), findsOneWidget);
      expect(sawName, 'Asha');
      await tapKey(tester, 'fake-avatar-next');
      expect(onStep('about'), isTrue);
    });
  });

  group('navigation', () {
    testWidgets('the back button goes one step back, not out of onboarding', (tester) async {
      api
        ..onJson('GET', _me, hostsMe(host: draft, kyc: aadhaarOnly))
        ..onJson('POST', '/api/hosts/kyc/selfie/code', {'code': '5512'});
      await open(tester);
      expect(onStep('selfie'), isTrue);
      await tapKey(tester, 'onboarding-back');
      expect(onStep('aadhaar'), isTrue);
      await tapKey(tester, 'onboarding-back');
      expect(onStep('phone'), isTrue);
    });

    testWidgets('an unverified number: Verify opens the website, Check again re-reads', (tester) async {
      api.onJson('GET', _phone, {'verified': false});
      api.onJson('GET', _me, hostsMe(host: draft));
      await open(tester);
      expect(onStep('phone'), isTrue);
      await tapKey(tester, 'phone-verify');
      expect(links.sitePaths, ['/sign-up?finish=1']);

      api.onJson('GET', _phone, {'verified': true, 'phone': '+91 98765 41234'});
      await tapKey(tester, 'phone-check-again');
      expect(find.byKey(const ValueKey<String>('phone-verified')), findsOneWidget);
    });
  });

  group('DigiLocker return link', () {
    testWidgets('?dl=return finishes a pending host check and shows the Aadhaar summary', (tester) async {
      await const DigiLockerPendingStore().save(DigiLockerPending(role: KycRole.host, at: DateTime.now()));
      api
        ..onJson('GET', _me, hostsMe(host: draft))
        ..onJson('POST', '/api/hosts/kyc/digilocker/complete', {'ok': true, 'gender': 'F', 'last4': '4321', 'ageOk': true});
      await open(tester, location: '${Routes.hostOnboarding}?dl=return');
      expect(onStep('aadhaar'), isTrue);
      expect(api.callsTo('POST', '/api/hosts/kyc/digilocker/complete'), hasLength(1));
      expect(find.byKey(const ValueKey<String>('aadhaar-done')), findsOneWidget);
    });

    testWidgets('?dl=return for a lane join goes to the lane screen instead', (tester) async {
      await const DigiLockerPendingStore()
          .save(DigiLockerPending(role: KycRole.laneCaller, at: DateTime.now(), lane: 'women'));
      api
        ..onJson('GET', _me, hostsMe(host: draft))
        ..onJson('GET', '/api/hf/lanes/me', {
          'whatsappVerified': true,
          'aadhaarVerified': false,
          'gender': null,
          'lanes': {
            'women': {'eligible': false, 'granted': false},
            'lgbtq': {'declared': false, 'granted': false},
          },
        })
        ..onJson('POST', '/api/hosts/kyc/digilocker/complete', {'ok': false, 'pending': true});
      await open(tester, location: '${Routes.hostOnboarding}?dl=return');
      expect(find.text(LaneCopy.titleOf(Lane.women)), findsWidgets);
      expect(find.byKey(const ValueKey<String>('lane-ack18')), findsOneWidget);
    });
  });

  group('payout', () {
    Future<void> fill(WidgetTester tester) async {
      await typeKey(tester, 'payout-upi', 'asha@okbank');
      await typeKey(tester, 'payout-account', '123456789012');
      await typeKey(tester, 'payout-account2', '123456789012');
      await typeKey(tester, 'payout-ifsc', 'HDFC0001234');
    }

    testWidgets('the button waits until every field is right', (tester) async {
      api.onJson('GET', _me, hostsMe(host: draft, kyc: selfieSent));
      await open(tester);
      await typeKey(tester, 'payout-upi', 'asha@okbank');
      await typeKey(tester, 'payout-account', '123456789012');
      await typeKey(tester, 'payout-account2', '123456789013');
      await typeKey(tester, 'payout-ifsc', 'HDFC0001234');
      expect(find.text(OnboardingCopy.accountSame), findsOneWidget);
      await tapKey(tester, 'payout-verify');
      expect(api.callsTo('POST', _payout), isEmpty);
    });

    testWidgets('the name matches: details are sent once, the result card shows, Continue moves on', (tester) async {
      var verified = false;
      api
        ..onJson('GET', '/api/hosts/avatars', <Object?>[])
        ..on('GET', _me, (_) => hostsMe(host: draft, kyc: verified ? allIdentity : selfieSent))
        ..on('POST', _payout, (_) {
          verified = true;
          return {'match': true, 'nameAtBank': 'Asha Sharma', 'accountLast4': '9012', 'upiVerified': true};
        });
      await open(tester);
      await fill(tester);
      await tapKey(tester, 'payout-verify');

      expect(api.callsTo('POST', _payout).single.body,
          {'upi': 'asha@okbank', 'account': '123456789012', 'ifsc': 'HDFC0001234'});
      expect(find.byKey(const ValueKey<String>('payout-done')), findsOneWidget);
      expect(find.text('${OnboardingCopy.nameAtBank}: Asha Sharma'), findsOneWidget);

      await tapKey(tester, 'payout-continue');
      expect(onStep('avatar'), isTrue);
    });

    testWidgets('the name does not match: a calm message, the form stays, the account number is not echoed', (tester) async {
      api
        ..onJson('GET', _me, hostsMe(host: draft, kyc: selfieSent))
        ..onJson('POST', _payout, {'match': false, 'nameAtBank': 'P**** S****', 'accountLast4': '9012'});
      await open(tester);
      await fill(tester);
      await tapKey(tester, 'payout-verify');
      expect(find.byKey(const ValueKey<String>('payout-mismatch')), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('payout-verify')), findsOneWidget);
      // The field keeps what was typed (hidden); no label or message repeats the number.
      expect(find.byWidgetPredicate((w) => w is Text && (w.data ?? '').contains('123456789012')), findsNothing);
    });

    testWidgets('a field error from the server shows under that field', (tester) async {
      api
        ..onJson('GET', _me, hostsMe(host: draft, kyc: selfieSent))
        ..onError('POST', _payout,
            const ApiError(status: 422, code: 'invalid_ifsc', message: 'That IFSC was not found.', field: 'ifsc'));
      await open(tester);
      await fill(tester);
      await tapKey(tester, 'payout-verify');
      expect(find.text('That IFSC was not found.'), findsOneWidget);
    });

    testWidgets('already done: shows the summary with the last 4 digits and a way to change', (tester) async {
      api.onJson('GET', _me, hostsMe(host: draft, kyc: allIdentity));
      await open(tester, step: 'payout');
      expect(find.byKey(const ValueKey<String>('payout-done')), findsOneWidget);
      expect(find.text('${OnboardingCopy.accountEnding} 6789'), findsOneWidget);
      await tapKey(tester, 'payout-change');
      expect(find.byKey(const ValueKey<String>('payout-upi')), findsOneWidget);
    });
  });
}
