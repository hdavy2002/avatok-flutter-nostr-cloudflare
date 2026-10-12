import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/storage/account_storage.dart';
import 'call_models.dart';

/// The calls API (worker `hf_calls.ts`). Typed calls only; every failure is an [ApiError].
class CallApi {
  const CallApi(this._api);

  final ApiClient _api;

  /// `GET /api/hf/wallet/estimate?host=<slug>`.
  Future<CallEstimate> estimate(String slug) async => CallEstimate.fromJson(
    await _api.getJson('/api/hf/wallet/estimate', query: {'host': slug}),
  );

  /// `POST /api/hf/calls {hostSlug, lane?}`. [lane] is `lgbtq` only when the person came from the LGBTQ+ tab;
  /// women-lane hosts are lane-set by the server.
  Future<StartedCall> start(String slug, {String? lane}) async {
    final json = await _api.postJson(
      '/api/hf/calls',
      body: {
        'hostSlug': slug,
        if (lane != null && lane.isNotEmpty) 'lane': lane,
      },
    );
    final started = StartedCall.fromJson(json);
    if (started.callId.isEmpty) throw ApiError.badResponse(200);
    await const LastCallRateStore().save(started.rate);
    return started;
  }

  /// `GET /api/hf/calls/:id`.
  Future<CallInfo> status(String id) async {
    final info = CallInfo.fromJson(
      await _api.getJson('/api/hf/calls/${Uri.encodeComponent(id)}'),
    );
    await const LastCallRateStore().save(info.rate);
    return info;
  }

  /// `POST /api/hf/calls/:id/cancel` -> the status after the cancel. `409 already_connected` is thrown.
  Future<CallStatus> cancel(String id) async {
    final json = await _api.postJson(
      '/api/hf/calls/${Uri.encodeComponent(id)}/cancel',
    );
    return CallStatus.parse(json['status']);
  }

  /// `POST /api/hf/hosts/:slug/notify` (needs a verified WhatsApp number).
  Future<void> notifyMe(String slug) async {
    await _api.postJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/notify');
  }
}

/// The rupee-per-minute rate of the host the person last called (account-scoped), for the Wallet's
/// "About N minutes" line. Best effort: storage trouble never breaks a call.
class LastCallRateStore {
  const LastCallRateStore();

  static const String _base = 'hf.last_call_rate.v1';

  Future<num?> read() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getDouble(scopedKey(_base));
      return (v == null || v <= 0) ? null : v;
    } catch (_) {
      return null;
    }
  }

  Future<void> save(num? rate) async {
    if (rate == null || rate <= 0) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setDouble(scopedKey(_base), rate.toDouble());
    } catch (_) {
      // best effort
    }
  }
}

final callApiProvider = Provider<CallApi>(
  (ref) => CallApi(ref.watch(apiClientProvider)),
);

class CallHostVisual {
  const CallHostVisual({
    required this.name,
    this.photoUrl,
    this.status,
  });

  final String name;
  final String? photoUrl;
  final String? status;

  factory CallHostVisual.fromJson(Map<String, dynamic> json) {
    final rawPhoto = '${json['avatarUrl'] ?? ''}'.trim();
    final rawStatus = '${json['status'] ?? ''}'.trim();
    return CallHostVisual(
      name: '${json['displayName'] ?? ''}'.trim(),
      photoUrl: rawPhoto.isEmpty ? null : rawPhoto,
      status: rawStatus.isEmpty ? null : rawStatus,
    );
  }
}

/// Public host identity for call surfaces. A read failure returns an empty,
/// honest fallback instead of inventing a name, presence, or portrait.
final callHostVisualProvider =
    FutureProvider.autoDispose.family<CallHostVisual, String>(
  retry: (_, __) => null,
  (ref, slug) async {
    try {
      final json = await ref.watch(apiClientProvider).getJson(
        '/api/hosts/public/${Uri.encodeComponent(slug)}',
        auth: false,
      );
      return CallHostVisual.fromJson(json);
    } catch (_) {
      return const CallHostVisual(name: '');
    }
  },
);

/// Protected-lane identity uses the same explicit lane context as discovery.
final callHostVisualInLaneProvider = FutureProvider.autoDispose
    .family<CallHostVisual, ({String slug, String lane})>(
  retry: (_, __) => null,
  (ref, key) async {
    ref.watch(sessionProvider.select((s) => s.user?.id ?? s.me?.uid));
    try {
      final json = await ref.watch(apiClientProvider).getJson(
        '/api/hosts/public/${Uri.encodeComponent(key.slug)}',
        query: {'lane': key.lane},
      );
      return CallHostVisual.fromJson(json);
    } catch (_) {
      return const CallHostVisual(name: '');
    }
  },
);

/// Kept as a narrow compatibility provider for existing callers and tests.
final callHostNameProvider = FutureProvider.autoDispose.family<String, String>(
  retry: (_, __) => null,
  (ref, slug) =>
      ref.watch(callHostVisualProvider(slug).future).then((v) => v.name),
);

final callHostNameInLaneProvider = FutureProvider.autoDispose
    .family<String, ({String slug, String lane})>(
  retry: (_, __) => null,
  (ref, key) =>
      ref.watch(callHostVisualInLaneProvider(key).future).then((v) => v.name),
);

/// "Now", replaceable in tests so the connected timer is exact.
final callClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// The estimate for a host, fetched when the confirm sheet opens (never cached: money is live).
final callEstimateProvider = FutureProvider.autoDispose
    .family<CallEstimate, String>(
      retry: (_, __) => null,
      (ref, slug) => ref.watch(callApiProvider).estimate(slug),
    );

/// The id of the call in progress, kept on the phone so reopening the app resumes the call screen.
/// The key is account-scoped (one phone, several accounts) and is wiped at sign-out with the other
/// per-account keys.
class ActiveCallStore {
  const ActiveCallStore();

  static const String _base = 'hf.active_call.v1';

  Future<String?> read() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(scopedKey(_base));
      return (v == null || v.isEmpty) ? null : v;
    } catch (_) {
      // Unreadable storage is "no active call", never an error.
      return null;
    }
  }

  Future<void> save(String id) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(scopedKey(_base), id);
    } catch (_) {
      // best effort: the call still runs, only the resume after a restart is lost
    }
  }

  /// Forget the call. With [onlyIfId], only when that is the stored one (a newer call is left alone).
  Future<void> clear({String? onlyIfId}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final key = scopedKey(_base);
      if (onlyIfId != null && prefs.getString(key) != onlyIfId) return;
      await prefs.remove(key);
    } catch (_) {
      // nothing to do
    }
  }
}

final activeCallStoreProvider = Provider<ActiveCallStore>(
  (ref) => const ActiveCallStore(),
);

/// Is there a call to resume? Returns its id when the stored call is still going, else null (and forgets it).
///
/// The splash / home screen (or the app root) reads this once after sign-in is known and, when it
/// returns an id, opens `Routes.callOf(id)`. A stored call that has ended, or that the server no longer
/// knows, is cleared. When the server cannot be reached the id is kept: the call may still be live.
final activeCallResumeProvider = FutureProvider.autoDispose<String?>(
  retry: (_, __) => null,
  (ref) async {
    // Everything the provider needs is read before the first await: the ref may be disposed after it.
    final store = ref.read(activeCallStoreProvider);
    final signedIn = ref.read(sessionProvider).isSignedIn;
    final api = ref.read(callApiProvider);
    final id = await store.read();
    if (id == null) return null;
    if (!signedIn) return null;
    try {
      final info = await api.status(id);
      if (info.status.isTerminal) {
        await store.clear(onlyIfId: id);
        return null;
      }
      return id;
    } on ApiError catch (e) {
      if (e.isOffline) return id;
      await store.clear(onlyIfId: id);
      return null;
    }
  },
);
