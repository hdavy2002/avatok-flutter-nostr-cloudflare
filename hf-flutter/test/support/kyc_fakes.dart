import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/auth/session.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/storage/secure_store.dart';
import 'package:hf_app/core/theme/hf_theme.dart';
import 'package:hf_app/features/kyc/kyc.dart';

import 'app_harness.dart';
import 'fake_api_client.dart';

/// A permission service that never touches the phone. `granted` is the set that is already allowed;
/// `requestResults` is what the Android prompt answers, per permission (default: granted, and it is then remembered).
class FakePermissionService extends PermissionService {
  FakePermissionService({Set<HfPermission>? granted, Map<HfPermission, HfPermissionResult>? requestResults, this.throwOnRequest = false})
      : granted = granted ?? <HfPermission>{},
        requestResults = requestResults ?? <HfPermission, HfPermissionResult>{};

  final Set<HfPermission> granted;
  final Map<HfPermission, HfPermissionResult> requestResults;
  final bool throwOnRequest;
  final List<HfPermission> requested = <HfPermission>[];
  int settingsOpened = 0;

  @override
  Future<bool> isGranted(HfPermission p) async => granted.contains(p);

  @override
  Future<HfPermissionResult> request(HfPermission p) async {
    requested.add(p);
    if (throwOnRequest) throw StateError('prompt failed');
    final r = requestResults[p] ?? HfPermissionResult.granted;
    if (r == HfPermissionResult.granted) granted.add(p);
    return r;
  }

  @override
  Future<bool> openSettings() async {
    settingsOpened += 1;
    return true;
  }
}

/// A camera that records nothing. [openError] makes `open` fail; [clip] is what `stop` returns.
class FakeSelfieRecorder implements SelfieRecorder {
  FakeSelfieRecorder({this.openError, SelfieClip? clip})
      : clip = clip ?? SelfieClip(bytes: Uint8List(64 * 1024), mime: 'video/mp4', seconds: 2);

  final SelfieRecorderException? openError;
  final SelfieClip clip;
  int opens = 0;
  int starts = 0;
  int stops = 0;
  bool disposed = false;

  @override
  Future<void> open() async {
    opens += 1;
    final e = openError;
    if (e != null) throw e;
  }

  @override
  Widget buildPreview(BuildContext context) => const SizedBox(key: ValueKey<String>('fake-preview'), height: 40);

  @override
  Future<void> start() async => starts += 1;

  @override
  Future<SelfieClip> stop() async {
    stops += 1;
    return clip;
  }

  @override
  Future<void> dispose() async => disposed = true;
}

/// Records what would open in a Custom Tab.
class FakeLinkOpener extends LinkOpener {
  FakeLinkOpener({this.result = true});

  final bool result;
  final List<Uri> tabs = <Uri>[];
  final List<String> sitePaths = <String>[];

  @override
  Future<bool> customTab(Uri uri) async {
    tabs.add(uri);
    return result;
  }

  @override
  Future<bool> site(String path) async {
    sitePaths.add(path);
    return true;
  }
}

/// An [FakeApiClient] that also keeps the request headers and content types.
class CapturingApi extends FakeApiClient {
  final List<Map<String, String>?> headersSeen = <Map<String, String>?>[];
  final List<String?> contentTypes = <String?>[];

  @override
  Future<Object?> request(
    String method,
    String path, {
    Map<String, Object?>? query,
    Object? body,
    Uint8List? bytes,
    String? contentType,
    Map<String, String>? headers,
    bool auth = true,
    String? idempotencyKey,
    void Function(int sent, int total)? onProgress,
  }) {
    headersSeen.add(headers);
    contentTypes.add(contentType);
    onProgress?.call(5, 10);
    return super.request(
      method,
      path,
      query: query,
      body: body,
      bytes: bytes,
      contentType: contentType,
      headers: headers,
      auth: auth,
      idempotencyKey: idempotencyKey,
      onProgress: onProgress,
    );
  }
}

/// Telemetry events the code under test sent.
class TelemetryLog {
  final List<(String, Map<String, Object>)> events = <(String, Map<String, Object>)>[];

  void install() {
    KycTelemetry.sink = (event, props) async => events.add((event, props));
  }

  void remove() => KycTelemetry.resetSink();

  /// All `hf_app_kyc_step` events as `step:result`.
  List<String> steps() => [for (final e in events) if (e.$1 == 'hf_app_kyc_step') '${e.$2['step']}:${e.$2['result']}'];

  List<Map<String, Object>> named(String name) => [for (final e in events) if (e.$1 == name) e.$2];
}

/// Lets timers and microphone-free futures run without waiting for every animation to stop
/// (spinners never settle, so `pumpAndSettle` is not used around them).
Future<void> settle(WidgetTester tester, [int times = 6]) async {
  for (var i = 0; i < times; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

/// Scrolls a keyed widget into view, taps it, and lets the app react.
Future<void> tapKey(WidgetTester tester, String key) async {
  final f = find.byKey(ValueKey<String>(key));
  expect(f, findsOneWidget, reason: 'no widget with key $key');
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await settle(tester);
}

/// Types into a keyed text field.
Future<void> typeKey(WidgetTester tester, String key, String text) async {
  final f = find.byKey(ValueKey<String>(key));
  expect(f, findsOneWidget, reason: 'no field with key $key');
  await tester.ensureVisible(f);
  await tester.enterText(f, text);
  await settle(tester);
}

/// Pumps one widget inside the app theme with a fake API and the given overrides.
Future<ProviderContainer> pumpWidgetUnderTest(
  WidgetTester tester,
  Widget child, {
  FakeApiClient? api,
  List<Override> overrides = const <Override>[],
}) async {
  usePhoneScreen(tester);
  final container = ProviderContainer(overrides: [
    apiClientProvider.overrideWithValue(api ?? FakeApiClient()),
    secureStoreProvider.overrideWithValue(MemoryKeyValueStore()),
    ...overrides,
  ]);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: buildHfTheme(),
      home: Scaffold(
        body: SingleChildScrollView(padding: const EdgeInsets.all(20), child: child),
      ),
    ),
  ));
  await settle(tester);
  return container;
}
