/// AvaLocalMode — the user's "Activate Ava AI locally" switch.
///
/// When ON, Ava runs on-device (LFM2-350M via Cactus): faster, private, works
/// offline. When OFF (default), Ava uses the cloud exactly as before. The toggle
/// is persisted per-account ([DiskCache], account-scoped) and resumed on boot.
///
/// Chat surfaces (AvaChat now, AvaTok @ava next) check [isActive] to decide
/// local-first vs cloud. Disconnecting unloads the model and falls back to cloud.
library;

import 'package:flutter/foundation.dart';

import 'ava_log.dart';
import 'ava_ondevice_llm.dart';
import 'disk_cache.dart';

class AvaLocalMode {
  AvaLocalMode._();
  static final AvaLocalMode I = AvaLocalMode._();

  static const String _kKey = 'ava_local_enabled';

  /// Whether the user has turned Local Ava AI on. Live for the UI + chat surfaces.
  final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);

  bool _loaded = false;

  /// Load the persisted preference and, if enabled, warm the model in the
  /// background. Cheap to re-call. Never throws.
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    final v = await DiskCache.read(_kKey);
    enabled.value = v == '1';
    if (enabled.value) {
      // ignore: unawaited_futures
      AvaOnDeviceLlm.I.ensureReady();
    }
  }

  /// True when local Ava is enabled AND the model is loaded — i.e. chat surfaces
  /// should route through the on-device brain right now.
  bool get isActive => enabled.value && AvaOnDeviceLlm.I.isReady;

  /// Turn Local Ava AI on: persist + download/load the model. Returns true when
  /// the model is ready.
  Future<bool> activate() async {
    enabled.value = true;
    await DiskCache.write(_kKey, '1');
    final ok = await AvaOnDeviceLlm.I.ensureReady();
    AvaLog.I.log('ava_ondevice', 'local mode activate ready=$ok');
    return ok;
  }

  /// Turn it off: persist + free the model. Cloud Ava takes over.
  Future<void> disconnect() async {
    enabled.value = false;
    await DiskCache.write(_kKey, '0');
    AvaOnDeviceLlm.I.unload();
    AvaLog.I.log('ava_ondevice', 'local mode disconnected → cloud');
  }
}
