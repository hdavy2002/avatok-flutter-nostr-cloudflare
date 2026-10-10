import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/app.dart';
import 'package:hf_app/core/api/api_error.dart';
import 'package:hf_app/core/auth/hf_me.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/boot.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/host_profile/data/host_profile.dart';
import 'package:hf_app/features/host_profile/data/host_profile_providers.dart';
import 'package:hf_app/features/host_profile/data/intro_player.dart';
import 'package:hf_app/features/host_profile/ui/widgets/net_image.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/app_harness.dart';
import '../support/fake_api_client.dart';

const String _profilePath = '/api/hosts/public/asha';
const String _notifyPath = '/api/hf/hosts/asha/notify';

Map<String, dynamic> profileJson({
  String status = 'online',
  bool womenOnly = false,
  bool lgbtq = false,
  bool intro = false,
  bool gallery = false,
  bool reviews = false,
}) =>
    {
      'slug': 'asha',
      'displayName': 'Asha',
      'tagline': 'A warm listener',
      'avatarUrl': 'https://media.example.test/a.webp',
      'languages': ['Hindi', 'English'],
      'style': 'calm',
      'topics': ['naye-dost', 'tension'],
      'pricePerMin': 12,
      'rating': reviews ? 4.6 : null,
      'reviewCount': reviews ? 5 : 0,
      'ratingBreakdown': reviews ? {'5': 3, '4': 2, '3': 0, '2': 0, '1': 0} : {},
      'talkedTo': reviews ? 40 : 0,
      'regulars': reviews ? 6 : 0,
      'lgbtqFriendly': lgbtq,
      'womenOnly': womenOnly,
      'introAudioUrl': intro ? 'https://media.example.test/intro.m4a' : null,
      'introSeconds': intro ? 30 : null,
      'status': status,
      'aboutPolished': 'I like a calm chat about everyday life.',
      'quote': 'Baat se baat banti hai.',
      'gallery': gallery
          ? [
              {'url': 'https://media.example.test/g1.webp', 'caption': 'Morning chai'},
              {'url': 'https://media.example.test/g2.webp', 'caption': null},
            ]
          : [],
      'reviews': reviews
          ? [
              {
                'firstName': 'Ravi',
                'stars': 5,
                'text': 'Very kind and patient.',
                'topic': 'tension',
                'minutes': 12,
                'regular': true,
                'date': '2026-10-01T10:00:00.000Z',
              },
            ]
          : [],
    };

SessionState signedIn({bool womenLane = false}) => SessionState(
      status: SessionStatus.signedIn,
      me: HfMe(uid: 'user_test', womenLane: womenLane),
    );

class FakeIntroPlayer implements IntroPlayer {
  final List<String> played = <String>[];
  int paused = 0;
  int resumed = 0;
  final StreamController<IntroPlayerState> _states = StreamController<IntroPlayerState>.broadcast(sync: true);
  final StreamController<Duration> _positions = StreamController<Duration>.broadcast(sync: true);
  final StreamController<Duration> _durations = StreamController<Duration>.broadcast(sync: true);

  @override
  Stream<IntroPlayerState> get states => _states.stream;
  @override
  Stream<Duration> get positions => _positions.stream;
  @override
  Stream<Duration> get durations => _durations.stream;

  @override
  Future<void> play(String url) async {
    played.add(url);
    _states.add(IntroPlayerState.playing);
    _durations.add(const Duration(seconds: 30));
  }

  @override
  Future<void> resume() async {
    resumed++;
    _states.add(IntroPlayerState.playing);
  }

  @override
  Future<void> pause() async {
    paused++;
    _states.add(IntroPlayerState.paused);
  }

  void emitPosition(Duration d) => _positions.add(d);

  @override
  Future<void> seek(Duration to) async {}

  @override
  Future<void> dispose() async {}
}

class _RecordingLinks extends LinkOpener {
  _RecordingLinks();
  final List<Uri> opened = <Uri>[];

  @override
  Future<bool> customTab(Uri uri) async {
    opened.add(uri);
    return true;
  }
}

class _Rig {
  _Rig(this.container, this.opened);
  final ProviderContainer container;

  /// Slugs the call confirm opener was asked to open.
  final List<String> opened;

  String get location => container.read(appRouterProvider).routeInformationProvider.value.uri.toString();
}

/// Pumps the whole app at `/h/asha`. The picture builder, audio player and call confirm opener are faked.
Future<_Rig> pumpProfile(
  WidgetTester tester, {
  required FakeApiClient api,
  SessionState? session,
  FakeIntroPlayer? player,
  bool settle = true,
}) async {
  usePhoneScreen(tester);
  // A pulsing status dot never settles: switch animations off like the phone setting does.
  tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
  final opened = <String>[];
  final container = ProviderContainer(overrides: [
    sessionProvider.overrideWith(() => StubSession(session ?? signedOutState())),
    apiClientProvider.overrideWithValue(api),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    initialLocationProvider.overrideWithValue('/h/asha'),
    hostImageBuilderProvider.overrideWithValue(
      (context, url, {BoxFit fit = BoxFit.cover}) => const ColoredBox(color: Colors.white),
    ),
    introPlayerFactoryProvider.overrideWithValue(() => player ?? FakeIntroPlayer()),
    callConfirmOpenerProvider.overrideWithValue((context, slug) async => opened.add(slug)),
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: const HfApp(listenForLinks: false),
  ));
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump();
  }
  return _Rig(container, opened);
}

FakeApiClient apiWith(Map<String, dynamic> profile, {bool notifySubscribed = false}) {
  return FakeApiClient()
    ..onJson('GET', _profilePath, profile)
    ..onJson('GET', '/api/hf/options', {
      'topics': [
        {'slug': 'naye-dost', 'label': 'Naye dost', 'group': 'naye-dost'},
        {'slug': 'tension', 'label': 'Tension', 'group': 'tension'},
      ],
    })
    ..onJson('GET', _notifyPath, {'subscribed': notifySubscribed});
}

void main() {
  late _RecordingLinks links;

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    links = _RecordingLinks();
    LinkOpener.instance = links;
  });
  tearDown(() => LinkOpener.instance = const LinkOpener());

  group('states', () {
    testWidgets('loading shows plain text and a spinner, then the profile', (tester) async {
      final gate = Completer<Object?>();
      final api = FakeApiClient()..on('GET', _profilePath, (_) => gate.future);
      await pumpProfile(tester, api: api, settle: false);
      expect(find.text('Loading profile…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      gate.complete(profileJson());
      await tester.pumpAndSettle();
      expect(find.text('Asha'), findsOneWidget);
    });

    testWidgets('content: name, tagline, price, topics with labels, languages, about and quote', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson(lgbtq: true)));
      expect(find.text('Asha'), findsOneWidget);
      expect(find.text('A warm listener'), findsOneWidget);
      expect(find.text('Online now'), findsOneWidget);
      expect(find.text('₹12/min'), findsOneWidget);
      expect(find.textContaining('₹120'), findsOneWidget);
      expect(find.text('New host'), findsOneWidget);
      expect(find.text('Naye dost'), findsOneWidget);
      expect(find.text('Hindi, English'), findsOneWidget);
      expect(find.text('Calm listener'), findsOneWidget);
      expect(find.text('LGBTQ+ friendly'), findsOneWidget);
      expect(find.text('I like a calm chat about everyday life.'), findsOneWidget);
      expect(find.textContaining('Baat se baat banti hai.'), findsOneWidget);
    });

    testWidgets('not found shows "This profile isn\'t available." and a way back', (tester) async {
      final api = FakeApiClient()
        ..onError('GET', _profilePath, const ApiError(status: 404, code: 'not_found', message: 'not_found'));
      await pumpProfile(tester, api: api);
      expect(find.text("This profile isn't available."), findsOneWidget);
      expect(find.text('Explore hosts'), findsOneWidget);
      expect(find.text('Call'), findsNothing);
    });

    testWidgets('error shows the message and Try again loads it again', (tester) async {
      var attempts = 0;
      final api = FakeApiClient()
        ..on('GET', _profilePath, (_) {
          attempts++;
          if (attempts == 1) throw const ApiError(status: 500, code: 'http_500');
          return profileJson();
        });
      await pumpProfile(tester, api: api);
      expect(find.text('Something went wrong. Please try again.'), findsOneWidget);
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(attempts, 2);
      expect(find.text('Asha'), findsOneWidget);
    });

    testWidgets('offline shows the saved profile of the last visit with a pill', (tester) async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        hostProfileCacheKey('asha'): jsonEncode({'at': DateTime.now().toIso8601String(), 'data': profileJson()}),
      });
      final api = FakeApiClient()..onError('GET', _profilePath, ApiError.network());
      await pumpProfile(tester, api: api);
      expect(find.text('Showing saved profile'), findsOneWidget);
      expect(find.text('Asha'), findsOneWidget);
    });

    testWidgets('offline with nothing saved shows the no-internet panel', (tester) async {
      final api = FakeApiClient()..onError('GET', _profilePath, ApiError.network());
      await pumpProfile(tester, api: api);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('AI labels', () {
    testWidgets('avatar, gallery section and every gallery picture are labelled at 14 sp or more', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson(gallery: true, intro: true)));
      for (final label in ['AI avatar chosen by the host', 'AI images', 'AI image', 'Recorded by the host']) {
        final texts = tester.widgetList<Text>(find.text(label)).toList();
        expect(texts, isNotEmpty, reason: label);
        for (final t in texts) {
          expect(t.style?.fontSize, isNotNull, reason: label);
          expect(t.style!.fontSize!, greaterThanOrEqualTo(14), reason: label);
        }
      }
    });

    testWidgets('no text on the profile is smaller than 14 sp', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson(gallery: true, intro: true, reviews: true, womenOnly: true)));
      for (final t in tester.widgetList<Text>(find.byType(Text))) {
        final size = t.style?.fontSize;
        if (size != null) expect(size, greaterThanOrEqualTo(14), reason: '"${t.data}"');
      }
    });
  });

  group('action bar', () {
    testWidgets('online + signed in: Call opens the call confirm step for this host', (tester) async {
      final rig = await pumpProfile(tester, api: apiWith(profileJson()), session: signedIn());
      expect(find.text('Call'), findsOneWidget);
      expect(find.text('Notify me when online'), findsNothing);
      await tester.tap(find.text('Call'));
      await tester.pumpAndSettle();
      expect(rig.opened, ['asha']);
    });

    testWidgets('online + signed out: Call asks for sign-in first', (tester) async {
      final rig = await pumpProfile(tester, api: apiWith(profileJson()));
      await tester.tap(find.text('Call'));
      await tester.pumpAndSettle();
      expect(rig.opened, isEmpty);
      expect(rig.location, startsWith('/sign-in'));
      expect(rig.location, contains('next='));
    });

    testWidgets('busy: "Notify me when free" and a note, no Call', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson(status: 'busy')), session: signedIn());
      expect(find.text('On a call'), findsOneWidget);
      expect(find.text('Notify me when free'), findsOneWidget);
      expect(find.text('Asha is on a call right now.'), findsOneWidget);
      expect(find.text('Call'), findsNothing);
    });

    testWidgets('offline: "Notify me when online" and a note, no Call', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson(status: 'offline')), session: signedIn());
      expect(find.text('Offline'), findsOneWidget);
      expect(find.text('Notify me when online'), findsOneWidget);
      expect(find.text('Asha is offline right now.'), findsOneWidget);
      expect(find.text('Call'), findsNothing);
    });

    testWidgets('women-only host, caller not in the lane: Verify to call explains the space and opens lanes', (tester) async {
      final rig = await pumpProfile(
        tester,
        api: apiWith(profileJson(womenOnly: true)),
        session: signedIn(),
      );
      expect(find.text('Women-only space'), findsOneWidget);
      expect(find.text('This is a women-only space. Verify once to call hosts here.'), findsOneWidget);
      expect(find.text('Call'), findsNothing);
      await tester.tap(find.text('Verify to call'));
      await tester.pumpAndSettle();
      expect(rig.opened, isEmpty);
      expect(rig.location, '/lanes?lane=women');
    });

    testWidgets('women-only host, caller already in the lane: Call', (tester) async {
      final rig = await pumpProfile(
        tester,
        api: apiWith(profileJson(womenOnly: true)),
        session: signedIn(womenLane: true),
      );
      expect(find.text('Verify to call'), findsNothing);
      await tester.tap(find.text('Call'));
      await tester.pumpAndSettle();
      expect(rig.opened, ['asha']);
    });

    testWidgets('calls flag off: a disabled "Calls open soon"', (tester) async {
      final api = apiWith(profileJson())
        ..onJson('GET', '/api/config', {'hostsPublicEnabled': true, 'hfCallsEnabled': false});
      await pumpProfile(tester, api: api, session: signedIn());
      expect(find.text('Calls open soon'), findsOneWidget);
      expect(find.text('Call'), findsNothing);
      final button = tester.widget<ElevatedButton>(
        find.ancestor(of: find.text('Calls open soon'), matching: find.byType(ElevatedButton)),
      );
      expect(button.onPressed, isNull);
    });

    testWidgets('token estimate shows when signed in and in token mode', (tester) async {
      final api = apiWith(profileJson())
        ..onJson('GET', '/api/hf/wallet/estimate', {
          'mode': 'tokens',
          'ratePerMinRupees': 12,
          'tokensPerMinute': '14.63',
          'aboutText': 'about 8 min 12 s',
          'canStart': true,
        });
      await pumpProfile(tester, api: api, session: signedIn());
      expect(find.text('14.63 tokens/min · about 8 min 12 s'), findsOneWidget);
    });

    testWidgets('no token estimate when signed out', (tester) async {
      final api = apiWith(profileJson());
      await pumpProfile(tester, api: api);
      expect(api.callsTo('GET', '/api/hf/wallet/estimate'), isEmpty);
      expect(find.textContaining('tokens/min'), findsNothing);
    });
  });

  group('notify me', () {
    testWidgets('signed out: asks for sign-in, sends nothing', (tester) async {
      final api = apiWith(profileJson(status: 'offline'));
      final rig = await pumpProfile(tester, api: api);
      await tester.tap(find.text('Notify me when online'));
      await tester.pumpAndSettle();
      expect(rig.location, startsWith('/sign-in'));
      expect(api.callsTo('POST', _notifyPath), isEmpty);
    });

    testWidgets('success: POST and "We\'ll WhatsApp you when they\'re online."', (tester) async {
      final api = apiWith(profileJson(status: 'offline'))
        ..onJson('POST', _notifyPath, {'ok': true, 'subscribed': true});
      await pumpProfile(tester, api: api, session: signedIn());
      await tester.tap(find.text('Notify me when online'));
      await tester.pumpAndSettle();
      expect(api.callsTo('POST', _notifyPath), hasLength(1));
      expect(find.text("We'll WhatsApp you when they're online."), findsOneWidget);
      expect(find.text('Stop notifying me'), findsOneWidget);
    });

    testWidgets('error: the worker message is shown and the button stays', (tester) async {
      final api = apiWith(profileJson(status: 'busy'))
        ..onError(
          'POST',
          _notifyPath,
          const ApiError(status: 403, code: 'not_verified', message: 'Verify your WhatsApp number first.'),
        );
      await pumpProfile(tester, api: api, session: signedIn());
      await tester.tap(find.text('Notify me when free'));
      await tester.pumpAndSettle();
      expect(find.text('Verify your WhatsApp number first.'), findsOneWidget);
      expect(find.text("We'll WhatsApp you when they're online."), findsNothing);
      expect(find.text('Notify me when free'), findsOneWidget);
    });

    testWidgets('already subscribed: Stop notifying me sends DELETE', (tester) async {
      final api = apiWith(profileJson(status: 'offline'), notifySubscribed: true)
        ..onJson('DELETE', _notifyPath, {'ok': true, 'subscribed': false});
      await pumpProfile(tester, api: api, session: signedIn());
      expect(find.text('Stop notifying me'), findsOneWidget);
      await tester.tap(find.text('Stop notifying me'));
      await tester.pumpAndSettle();
      expect(api.callsTo('DELETE', _notifyPath), hasLength(1));
      expect(find.text('Notify me when online'), findsOneWidget);
    });
  });

  group('voice intro', () {
    testWidgets('hidden when the host has none', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson()));
      expect(find.text('Recorded by the host'), findsNothing);
      expect(find.byTooltip('Play introduction'), findsNothing);
    });

    testWidgets('play, progress and pause', (tester) async {
      final player = FakeIntroPlayer();
      await pumpProfile(tester, api: apiWith(profileJson(intro: true)), player: player);
      expect(find.text('Recorded by the host'), findsOneWidget);
      expect(find.text('00:00 / 00:30'), findsOneWidget);
      await tester.tap(find.byTooltip('Play introduction'));
      await tester.pumpAndSettle();
      expect(player.played, ['https://media.example.test/intro.m4a']);
      expect(find.byTooltip('Pause introduction'), findsOneWidget);
      player.emitPosition(const Duration(seconds: 12));
      await tester.pump();
      expect(find.text('00:12 / 00:30'), findsOneWidget);
      await tester.tap(find.byTooltip('Pause introduction'));
      await tester.pumpAndSettle();
      expect(player.paused, 1);
      expect(find.byTooltip('Play introduction'), findsOneWidget);
    });
  });

  group('reviews, gallery, report', () {
    testWidgets('reviews show first name, stars and text', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson(reviews: true)));
      expect(find.text('Ravi'), findsOneWidget);
      expect(find.text('Very kind and patient.'), findsOneWidget);
      expect(find.text('4.6'), findsNWidgets(2)); // header and summary
      expect(find.text('5 reviews'), findsOneWidget);
      expect(find.text('Talked to 40 people · 6 regulars'), findsOneWidget);
    });

    testWidgets('gallery swipes to the next picture and shows its caption', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson(gallery: true)));
      expect(find.text('Morning chai'), findsOneWidget);
      await tester.drag(find.byType(PageView), const Offset(-500, 0));
      await tester.pumpAndSettle();
      expect(find.text('Morning chai'), findsNothing);
    });

    testWidgets('Report opens the web report page for this host', (tester) async {
      await pumpProfile(tester, api: apiWith(profileJson()));
      await tester.ensureVisible(find.text('Report this profile'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Report this profile'));
      await tester.pumpAndSettle();
      expect(links.opened, hasLength(1));
      expect(links.opened.single.path, '/report');
      expect(links.opened.single.queryParameters['profile'], 'asha');
    });
  });

  group('parsing', () {
    test('a sparse body gets safe defaults', () {
      final p = HostProfile.fromJson({'slug': 'x', 'displayName': 'X'});
      expect(p.status.name, 'offline');
      expect(p.gallery, isEmpty);
      expect(p.reviews, isEmpty);
      expect(p.pricePerMin, 0);
      expect(p.hasIntro, isFalse);
    });

    test('review dates read ISO text and epoch milliseconds', () {
      expect(formatReviewDate('not a date'), '');
      expect(formatReviewDate(null), '');
      expect(formatReviewDate('2026-10-01T10:00:00.000Z'), matches(RegExp(r'^\d{1,2} Oct 2026$')));
      expect(formatReviewDate(1790000000000), isNotEmpty);
    });

    test('topicLabel falls back to readable text', () {
      expect(topicLabel(const {'a': 'Alpha'}, 'a'), 'Alpha');
      expect(topicLabel(const {}, 'naye-dost'), 'Naye dost');
    });
  });
}
