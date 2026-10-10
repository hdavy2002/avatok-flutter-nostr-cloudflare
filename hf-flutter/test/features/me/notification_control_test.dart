import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/features/me/data/notification_control.dart';
import 'package:hf_app/features/push/data/push_gateway.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_api_client.dart';
import '../push/push_support.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  late int settingsOpened;
  late FakeApiClient api;

  ({ProviderContainer container, NotificationControl control}) make(FakePushGateway gateway) {
    settingsOpened = 0;
    api = pushApi();
    final provider = Provider<NotificationControl>(
      (ref) => PushNotificationControl(ref, openSettings: () async => settingsOpened += 1),
    );
    final c = ProviderContainer(overrides: pushOverrides(gateway: gateway, api: api));
    addTearDown(c.dispose);
    return (container: c, control: c.read(provider));
  }

  test('on: asks Android, registers this phone and then reads as on', () async {
    final gateway = FakePushGateway(current: PushPermission.notGranted, afterPrompt: PushPermission.granted);
    final t = make(gateway);

    expect(await t.control.isEnabled(), isFalse);
    expect(await t.control.setEnabled(true), isTrue);

    expect(gateway.promptCount, 1);
    expect(api.callsTo('POST', '/api/hf/push/register'), hasLength(1));
    expect(settingsOpened, 0);
    expect(await t.control.isEnabled(), isTrue);
  });

  test('on, but Android says no: the phone settings open and the switch stays off', () async {
    final gateway = FakePushGateway(current: PushPermission.notGranted, afterPrompt: PushPermission.notGranted);
    final t = make(gateway);

    expect(await t.control.setEnabled(true), isFalse);
    expect(api.callsTo('POST', '/api/hf/push/register'), isEmpty);
    expect(settingsOpened, 1);
    expect(await t.control.isEnabled(), isFalse);
  });

  test('off: removes this phone from the account, opens the phone settings and reads as off', () async {
    final gateway = FakePushGateway(current: PushPermission.notGranted, afterPrompt: PushPermission.granted);
    final t = make(gateway);
    await t.control.setEnabled(true);
    expect(await t.control.isEnabled(), isTrue);

    expect(await t.control.setEnabled(false), isFalse);
    final deletes = api.callsTo('DELETE', '/api/hf/push/register');
    expect(deletes, hasLength(1));
    expect((deletes.single.body as Map)['token'], 'fcm-token-1');
    expect(settingsOpened, 1);
    expect(await t.control.isEnabled(), isFalse);
  });

  test('permission given but this phone never registered reads as off', () async {
    final gateway = FakePushGateway(current: PushPermission.granted);
    final t = make(gateway);
    expect(await t.control.isEnabled(), isFalse);
  });
}
