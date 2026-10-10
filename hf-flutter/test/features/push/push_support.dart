import 'dart:async';

import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/config/flags.dart';
import 'package:hf_app/core/router/deep_link_handler.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/features/push/data/push_gateway.dart';
import 'package:hf_app/features/push/data/push_payload.dart';
import 'package:hf_app/features/push/data/push_service.dart';

import '../../support/app_harness.dart';
import '../../support/fake_api_client.dart';

/// A [PushGateway] with no Firebase. Drive it with [emitForeground], [emitOpened], [emitRefresh].
class FakePushGateway extends PushGateway {
  FakePushGateway({
    this.isAvailable = true,
    this.current = PushPermission.notGranted,
    this.afterPrompt = PushPermission.granted,
    this.tokenValue = 'fcm-token-1',
    this.initial,
  });

  final bool isAvailable;
  PushPermission current;

  /// What the Android prompt answers.
  PushPermission afterPrompt;
  String? tokenValue;
  PushMessage? initial;

  int promptCount = 0;
  final StreamController<String> _refresh = StreamController<String>.broadcast();
  final StreamController<PushMessage> _foreground = StreamController<PushMessage>.broadcast();
  final StreamController<PushMessage> _opened = StreamController<PushMessage>.broadcast();

  void emitRefresh(String t) => _refresh.add(t);
  void emitForeground(PushMessage m) => _foreground.add(m);
  void emitOpened(PushMessage m) => _opened.add(m);

  @override
  bool get available => isAvailable;

  @override
  Future<PushPermission> permission() async => current;

  @override
  Future<PushPermission> requestPermission() async {
    promptCount++;
    current = afterPrompt;
    return current;
  }

  @override
  Future<String?> token() async => tokenValue;

  @override
  Stream<String> get onTokenRefresh => _refresh.stream;

  @override
  Stream<PushMessage> get onForeground => _foreground.stream;

  @override
  Stream<PushMessage> get onOpened => _opened.stream;

  @override
  Future<PushMessage?> initialMessage() async => initial;
}

/// Records what the app was asked to open instead of moving a router.
class RecordingLinkHandler extends DeepLinkHandler {
  RecordingLinkHandler(super.ref);

  final List<({String input, String source, String launch})> handled = [];

  @override
  Future<void> handle(String input, {required String source, String launch = 'warm'}) async {
    handled.add((input: input, source: source, launch: launch));
  }
}

/// A push message the way the worker builds it (`buildHfPayload`).
PushMessage workerPush(String kind, String path, {String title = 'Hello', String body = 'Something happened'}) =>
    PushMessage(title: title, body: body, data: {'type': 'hf_push', 'kind': kind, 'path': path});

/// The seven kinds and the paths the worker sends for them (hf_push_pure.ts).
const Map<String, String> kindPaths = {
  'notify_me': '/h/asha',
  'host_approved': '/hosts/dashboard',
  'host_changes': '/hosts/dashboard',
  'withdrawal_approved': '/hosts/dashboard',
  'withdrawal_paid': '/hosts/dashboard',
  'low_balance': '/wallet',
  'review_request': '/review/tok123',
};

/// Overrides for a signed-in (or signed-out) person with push wired to fakes.
List<Override> pushOverrides({
  required FakePushGateway gateway,
  required FakeApiClient api,
  bool signedIn = true,
  bool flagOn = true,
  DateTime Function()? clock,
  bool recordLinks = true,
}) =>
    <Override>[
      sessionProvider.overrideWith(() => StubSession(signedIn ? signedInState() : signedOutState())),
      apiClientProvider.overrideWithValue(api),
      secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
      pushGatewayProvider.overrideWithValue(gateway),
      flagsProvider.overrideWith((ref) => HfFlags.fromJson({'hfPushEnabled': flagOn})),
      if (clock != null) pushClockProvider.overrideWithValue(clock),
      if (recordLinks) deepLinkHandlerProvider.overrideWith((ref) => RecordingLinkHandler(ref)),
    ];

FakeApiClient pushApi() => FakeApiClient()
  ..onJson('POST', '/api/hf/push/register', {'ok': true})
  ..onJson('DELETE', '/api/hf/push/register', {'ok': true});
