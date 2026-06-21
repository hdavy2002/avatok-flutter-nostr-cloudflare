/// AvaLocalMode — the "keep my memory on this phone" switch.
///
/// ARCHITECTURE (2026-06-21): the on-device LLM was removed (Cactus + LFM350M).
/// All of Ava's THINKING is now the cloud (Gemini 3). What stays local is the
/// user's DATA: when this is ON, the messages/notes you send are indexed into an
/// on-device SQLite FTS5 store ([AvaOnDeviceRag]) so search/recall is private and
/// offline. There is no model to download or load — this is purely a privacy +
/// local-index toggle now.
///
/// Persisted per-account ([DiskCache], account-scoped) and resumed on boot.
library;

import 'package:flutter/foundation.dart';

import 'analytics.dart';
import 'ava_log.dart';
import 'ava_ondevice_rag.dart';
import 'disk_cache.dart';

class AvaLocalMode {
  AvaLocalMode._();
  static final AvaLocalMode I = AvaLocalMode._();

  static const String _kKey = 'ava_local_enabled';

  /// Whether on-device memory is ON. Live for the UI + chat surfaces.
  final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);

  bool _loaded = false;

  /// True when on-device memory is enabled. No model load required anymore, so
  /// this is just the persisted preference (chat surfaces gate local indexing +
  /// local search on it).
  bool get isActive => enabled.value;

  /// Load the persisted preference and warm the FTS5 index in the background.
  /// Cheap to re-call. Never throws.
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    final v = await DiskCache.read(_kKey);
    enabled.value = v == '1';
    if (enabled.value) {
      // ignore: unawaited_futures
      AvaOnDeviceRag.I.ensureReady();
    }
    // Adoption + corpus-size signal: how many users keep memory on-device, and
    // how big their local FTS5 index gets (tells us if embeddings are ever
    // needed). gen='cloud' marks the post-Cactus, cloud-generation architecture.
    // ignore: unawaited_futures
    Analytics.capture('ava_local_memory', {
      'enabled': enabled.value,
      'store': 'fts5',
      'gen': 'cloud',
      'docs': AvaOnDeviceRag.I.docCount.value,
    });
  }

  /// Turn on-device memory ON: persist + create the local index. Returns true.
  Future<bool> activate() async {
    enabled.value = true;
    await DiskCache.write(_kKey, '1');
    final ok = await AvaOnDeviceRag.I.ensureReady();
    AvaLog.I.log('ava_ondevice', 'on-device memory ON (index ready=$ok)');
    return true;
  }

  /// Turn it OFF: stop indexing new messages on-device (existing index is kept;
  /// the user can clear it separately). Cloud memory still works.
  Future<void> disconnect() async {
    enabled.value = false;
    await DiskCache.write(_kKey, '0');
    AvaLog.I.log('ava_ondevice', 'on-device memory OFF → cloud only');
  }
}
