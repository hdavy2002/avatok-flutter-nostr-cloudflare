import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/features/host_onboarding/flow/onboarding_steps.dart';

OnboardingServerState state({
  Map<String, Object?>? host,
  Map<String, Object?> kyc = const {},
  bool phone = false,
}) =>
    OnboardingServerState.fromJson({'host': host, 'kyc': kyc, 'media': <Object?>[], 'job': null}, sessionPhoneVerified: phone);

const aadhaarDone = {
  'aadhaar': {'done': true, 'gender': 'F', 'last4': '1234'},
};
const selfiePending = {
  'aadhaar': {'done': true},
  'selfie': {'status': 'pending'},
};
const payoutDone = {
  'aadhaar': {'done': true},
  'selfie': {'status': 'pending'},
  'payout': {'done': true, 'accountLast4': '6789'},
};

void main() {
  group('resumeStepKey', () {
    test('a brand new person starts at the welcome step', () {
      expect(resumeStepKey(state()), 'welcome');
    });

    test('a person who started but has no phone yet resumes at phone', () {
      expect(resumeStepKey(state(host: {'status': 'draft'})), 'phone');
    });

    test('phone done: Aadhaar next', () {
      expect(resumeStepKey(state(host: {'status': 'draft'}, phone: true)), 'aadhaar');
    });

    test('Aadhaar done: selfie next', () {
      expect(resumeStepKey(state(host: {'status': 'draft'}, kyc: aadhaarDone, phone: true)), 'selfie');
    });

    test('a rejected selfie is recorded again', () {
      final s = state(
        host: {'status': 'draft'},
        phone: true,
        kyc: {
          'aadhaar': {'done': true},
          'selfie': {'status': 'rejected', 'reason': 'face_not_clear'},
        },
      );
      expect(resumeStepKey(s), 'selfie');
      expect(s.kyc.selfieReason, 'face_not_clear');
    });

    test('selfie waiting for review counts as done: payout next', () {
      expect(resumeStepKey(state(host: {'status': 'draft'}, kyc: selfiePending, phone: true)), 'payout');
    });

    test('all identity checks done and no profile yet: part B starts at avatar', () {
      expect(resumeStepKey(state(host: {'status': 'draft'}, kyc: payoutDone, phone: true)), 'avatar');
    });

    test('profile fields move the resume point forward in order', () {
      final base = <String, Object?>{'status': 'draft', 'avatarId': 'a1'};
      expect(resumeStepKey(state(host: base, kyc: payoutDone, phone: true)), 'about');
      base['displayName'] = 'Asha';
      base['about'] = 'I like to listen.';
      expect(resumeStepKey(state(host: base, kyc: payoutDone, phone: true)), 'languages');
    });

    test('generating, pending review, live, rejected', () {
      expect(resumeStepKey(state(host: {'status': 'generating'})), 'generating');
      expect(resumeStepKey(state(host: {'status': 'pending_review'})), 'done');
      expect(resumeStepKey(state(host: {'status': 'live'})), 'done');
      expect(resumeStepKey(state(host: {'status': 'rejected'})), 'preview');
      expect(resumeStepKey(state(host: {'status': 'paused'})), 'preview');
    });
  });

  group('startStepKey (the ?step= link)', () {
    final atSelfie = state(host: {'status': 'draft'}, kyc: aadhaarDone, phone: true);

    test('no link: resume', () => expect(startStepKey(atSelfie), 'selfie'));
    test('unknown key: resume', () => expect(startStepKey(atSelfie, requested: 'nonsense'), 'selfie'));
    test('a link to an earlier step is allowed (go back and edit)', () {
      expect(startStepKey(atSelfie, requested: 'aadhaar'), 'aadhaar');
      expect(startStepKey(atSelfie, requested: 'welcome'), 'welcome');
    });
    test('a link to the resume step itself is allowed', () => expect(startStepKey(atSelfie, requested: 'selfie'), 'selfie'));
    test('a link past the resume step cannot skip the checks', () {
      expect(startStepKey(atSelfie, requested: 'payout'), 'selfie');
      expect(startStepKey(atSelfie, requested: 'price'), 'selfie');
    });
  });

  group('the step list', () {
    test('keys match the web, in order', () {
      expect(kOnboardingSteps.map((s) => s.key), [
        'welcome', 'phone', 'aadhaar', 'selfie', 'payout', 'avatar', 'about', 'languages', 'topics', 'price',
        'hours', 'voice', 'review', 'generating', 'preview', 'done',
      ]);
    });

    test('onboardingStepIndex', () {
      expect(onboardingStepIndex('welcome'), 0);
      expect(onboardingStepIndex('done'), kOnboardingSteps.length - 1);
      expect(onboardingStepIndex('x'), -1);
      expect(onboardingStepIndex(null), -1);
    });
  });

  group('OnboardingServerState.fromJson', () {
    test('reads the host, kyc, media and job', () {
      final s = OnboardingServerState.fromJson({
        'host': {'status': 'draft', 'displayName': 'Asha', 'languages': ['hi', 'en'], 'pricePerMin': 12},
        'kyc': payoutDone,
        'media': [
          {'id': 'm1'}
        ],
        'job': {'id': 'j1', 'status': 'running'},
      }, phone: {'verified': true, 'phone': '+91 98765 41234'});
      expect(s.hasHost, isTrue);
      expect(s.hostString('displayName'), 'Asha');
      expect(s.hostStrings('languages'), ['hi', 'en']);
      expect(s.hostNum('pricePerMin'), 12);
      expect(s.kyc.payoutDone, isTrue);
      expect(s.kyc.payoutLast4, '6789');
      expect(s.media, hasLength(1));
      expect(s.job?['status'], 'running');
      expect(s.phoneVerified, isTrue);
      expect(s.phoneLast4, '1234');
    });

    test('an empty answer is a person with nothing yet', () {
      final s = OnboardingServerState.fromJson(const {});
      expect(s.hasHost, isFalse);
      expect(s.kyc.aadhaarDone, isFalse);
      expect(s.kyc.selfieStatus, 'none');
      expect(s.phoneVerified, isFalse);
    });
  });
}
