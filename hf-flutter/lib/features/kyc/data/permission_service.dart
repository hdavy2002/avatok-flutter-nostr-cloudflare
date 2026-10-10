import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

/// The two permissions the host flow needs. Telemetry `kind` is the enum name (`camera`, `mic`).
enum HfPermission { camera, mic }

enum HfPermissionResult {
  granted,

  /// Said no this time. Android may ask again.
  denied,

  /// "Don't ask again", or blocked: only the system settings can change it.
  permanentlyDenied,
}

/// The one place the app touches `permission_handler`, so widget tests replace it with a fake
/// (`permissionServiceProvider.overrideWithValue(FakePermissionService())`).
abstract class PermissionService {
  const PermissionService();

  Future<bool> isGranted(HfPermission p);

  /// Shows the Android prompt (only when it can still be shown).
  Future<HfPermissionResult> request(HfPermission p);

  /// Opens this app's page in the system settings. False when nothing could open.
  Future<bool> openSettings();
}

class SystemPermissionService extends PermissionService {
  const SystemPermissionService();

  ph.Permission _map(HfPermission p) => p == HfPermission.camera ? ph.Permission.camera : ph.Permission.microphone;

  @override
  Future<bool> isGranted(HfPermission p) async => (await _map(p).status).isGranted;

  @override
  Future<HfPermissionResult> request(HfPermission p) async {
    final s = await _map(p).request();
    if (s.isGranted) return HfPermissionResult.granted;
    if (s.isPermanentlyDenied) return HfPermissionResult.permanentlyDenied;
    return HfPermissionResult.denied;
  }

  @override
  Future<bool> openSettings() => ph.openAppSettings();
}

final permissionServiceProvider = Provider<PermissionService>((ref) => const SystemPermissionService());
