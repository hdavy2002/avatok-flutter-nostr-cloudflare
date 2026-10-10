import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/features/host_onboarding/part_b/data/edit_lock.dart';
import 'package:hf_app/features/host_onboarding/part_b/data/host_setup_api.dart';
import 'package:hf_app/features/host_onboarding/part_b/data/part_b_rules.dart';

void main() {
  group('first name', () {
    test('2 to 20 letters and spaces, Latin or Devanagari', () {
      expect(isValidFirstName('Neha'), isTrue);
      expect(isValidFirstName('Anu Priya'), isTrue);
      expect(isValidFirstName('नेहा'), isTrue);
      expect(isValidFirstName('N'), isFalse);
      expect(isValidFirstName('Neha123'), isFalse);
      expect(isValidFirstName('Neha_'), isFalse);
      expect(isValidFirstName('A' * 21), isFalse);
    });
  });

  group('contact leak', () {
    test('numbers, links, handles and app names are refused with a friendly line', () {
      expect(contactLeakMessage('call me 98765 43210'), 'Please remove phone numbers.');
      expect(contactLeakMessage('mail me at a@b.c'), 'Please remove emails, links or @handles.');
      expect(contactLeakMessage('see www.example.org'), 'Please remove emails, links or @handles.');
      expect(contactLeakMessage('find me on instagram'), 'Please do not mention apps or payment IDs.');
      expect(contactLeakMessage('I love old songs and chai'), isNull);
    });
  });

  group('voice length', () {
    test('30 seconds to 5 minutes', () {
      expect(checkVoiceSeconds(0), VoiceLength.tooShort);
      expect(checkVoiceSeconds(29), VoiceLength.tooShort);
      expect(checkVoiceSeconds(29.4), VoiceLength.tooShort);
      expect(checkVoiceSeconds(30), VoiceLength.ok);
      expect(checkVoiceSeconds(300), VoiceLength.ok);
      expect(checkVoiceSeconds(300.4), VoiceLength.ok);
      expect(checkVoiceSeconds(301), VoiceLength.tooLong);
    });

    test('mmss', () {
      expect(mmss(65), '1:05');
      expect(mmss(300), '5:00');
      expect(mmss(-3), '0:00');
    });
  });

  group('price', () {
    test('the host keeps 60 percent of what is above Rs 2, in whole paise', () {
      expect(hostSharePaise(20), 1080);
      expect(hostSharePaise(2), 0);
      expect(hostSharePaise(1), 0);
      expect(rupeesFromPaise(1080), '₹10.80');
      expect(rupeesFromPaise(1000), '₹10');
      expect(rupeesFromPaise(5), '₹0.05');
    });
  });

  group('hours', () {
    test('hhmm and fallback', () {
      expect(hhmm(9, 5), '09:05');
      expect(validHhmm('19:30', '10:00'), '19:30');
      expect(validHhmm('25:00', '10:00'), '10:00');
      expect(validHhmm(null, '10:00'), '10:00');
    });
  });

  group('generation status', () {
    test('stages default to waiting; finished and failed', () {
      final s = GenerationStatus.fromJson({'status': 'running', 'stages': {'text': 'done'}});
      expect(s.stage('images'), 'waiting');
      expect(s.finished, isFalse);
      expect(s.anyFailed, isFalse);
      final done = GenerationStatus.fromJson({
        'status': 'done',
        'stages': {'text': 'done', 'images': 'done', 'safety': 'skipped'},
      });
      expect(done.finished, isTrue);
      final failed = GenerationStatus.fromJson({
        'status': 'running',
        'stages': {'text': 'done', 'images': 'failed'},
        'error': 'boom',
      });
      expect(failed.anyFailed, isTrue);
      expect(failed.error, 'boom');
    });

    test('missing steps from the worker become step keys, once each', () {
      const e = ApiError(status: 409, code: 'profile_incomplete', extra: {
        'missing': ['avatar', 'displayName', 'about', 'agreements', 'nonsense'],
      });
      expect(missingSteps(e), ['avatar', 'about', 'review']);
      expect(stepForMissing('media'), 'generating');
    });
  });

  group('edit lock', () {
    test('with the team nothing changes; live keeps price, hours and voice', () {
      final team = EditLock.of('pending_review');
      expect(team.profileLocked && team.priceHoursLocked && team.voiceLocked && team.avatarLocked, isTrue);
      final live = EditLock.of('live');
      expect(live.profileLocked, isTrue);
      expect(live.priceHoursLocked, isFalse);
      expect(live.voiceLocked, isFalse);
      final draft = EditLock.of('draft');
      expect(draft.profileLocked || draft.priceHoursLocked || draft.voiceLocked, isFalse);
      expect(draft.banner(), isNull);
      expect(team.banner(), isNotNull);
    });
  });
}
