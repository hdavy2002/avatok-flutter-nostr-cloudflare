import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;
import 'package:shared_preferences/shared_preferences.dart';

import '../../push/data/push_gateway.dart';
import '../../push/data/push_service.dart';

/// The notifications switch on the Me screen.
abstract class NotificationControl {
  const NotificationControl();

  /// Are notifications on for this phone and account right now?
  Future<bool> isEnabled();

  /// Try to turn them [on] or off. Returns true when the change happened inside the app; false when the person
  /// has to finish it in the phone's settings (which were opened for them), or it did not work.
  /// The screen asks [isEnabled] again afterwards, so it always shows the real state.
  Future<bool> setEnabled(bool on);
}

/// Opens this app's notification settings in Android.
Future<void> openNotificationSettings() async {
  try {
    await ph.openAppSettings();
  } catch (_) {
    // nothing else to try
  }
}

/// Works on the Android permission alone (no push registration). Used when Firebase never started
/// (a build without google-services.json): on asks for the permission, off opens the phone's settings.
class SystemNotificationControl extends NotificationControl {
  const SystemNotificationControl();

  @override
  Future<bool> isEnabled() async {
    try {
      return (await ph.Permission.notification.status).isGranted;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> setEnabled(bool on) async {
    try {
      if (!on) {
        // Android has no way to take a permission back from inside the app.
        await openNotificationSettings();
        return false;
      }
      var status = await ph.Permission.notification.status;
      if (status.isGranted) return true;
      status = await ph.Permission.notification.request();
      if (status.isGranted) return true;
      await openNotificationSettings();
      return false;
    } catch (_) {
      return false;
    }
  }
}

/// The real switch, on top of the push feature (HF-NATIVE-7): on is the opt-in (Android prompt, then
/// `POST /api/hf/push/register`); off is `DELETE /api/hf/push/register` for this phone, then the phone's own
/// notification settings so the permission can be taken back too.
class PushNotificationControl extends NotificationControl {
  PushNotificationControl(this._ref, {Future<void> Function()? openSettings})
      : _openSettings = openSettings ?? openNotificationSettings;

  final Ref _ref;
  final Future<void> Function() _openSettings;

  PushGateway get _gateway => _ref.read(pushGatewayProvider);
  PushService get _service => _ref.read(pushServiceProvider);

  @override
  Future<bool> isEnabled() async {
    if (!_gateway.available) return const SystemNotificationControl().isEnabled();
    try {
      if (await _gateway.permission() != PushPermission.granted) return false;
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString(PushService.tokenKey);
      return token != null && token.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> setEnabled(bool on) async {
    if (!_gateway.available) return const SystemNotificationControl().setEnabled(on);
    try {
      if (on) {
        if (await _service.allow()) return true;
        await _openSettings(); // Android will not ask again: the person must allow it there
        return false;
      }
      await _service.unregister();
      await _openSettings();
      return false;
    } catch (_) {
      return false;
    }
  }
}

final notificationControlProvider = Provider<NotificationControl>((ref) => PushNotificationControl(ref));
