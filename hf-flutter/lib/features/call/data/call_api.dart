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
  Future<CallEstimate> estimate(String slug) async =>
      CallEstimate.fromJson(await _api.getJson('/api/hf/wallet/estimate', query: {'host': slug}));

  /// `POST /api/hf/calls {hostSlug, lane?}`. [lane] is `lgbtq` only when the person came from the LGBTQ+ tab;
  /// women-lane hosts are lane-set by the server.
  Future<StartedCall> start(String slug, {String? lane}) async {
    final json = await _api.postJson('/api/hf/calls', body: {
      'hostSlug': slug,
      if (lane != null && lane.isNotEmpty) 'lane': lane,
    });
    final started = StartedCall.fromJson(json);
    if (started.callId.isEmpty) throw ApiError.badResponse(200);
    return started;
  }

  /// `GET /api/hf/calls/:id`.
  Future<CallInfo> status(String id) async =>
      CallInfo.fromJson(await _api.getJson('/api/hf/calls/${Uri.encodeComponent(id)}'));

  /// `POST /api/hf/calls/:id/cancel` -> the status after the cancel. `409 already_connected` is thrown.
  Future<CallStatus> cancel(String id) async {
    final json = await _api.postJson('/api/hf/calls/${Uri.encodeComponent(id)}/cancel');
    return CallStatus.parse(json['status']);
  }

  /// `POST /api/hf/hosts/:slug/notify` (needs a verified WhatsApp number).
  Future<void> notifyMe(String slug) async {
    await _api.postJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/notify');
  }
}

final callApiProvider = Provider<CallApi>((ref) => CallApi(ref.watch(apiClientProvider)));

/// A host's display name for the confirm page (`GET /api/hosts/public/:slug`, public). A host that cannot be
/// read just gives an empty name: the confirm step still works, it says "your host".
final callHostNameProvider = FutureProvider.autoDispose.family<String, String>((ref, slug) async {
  try {
    final json = await ref.watch(apiClientProvider).getJson('/api/hosts/public/${Uri.encodeComponent(slug)}', auth: false);
    return '${json['displayName'] ?? ''}'.trim();
  } catch (_) {
    return '';
  }
});

/// "Now", replaceable in tests so the connected timer is exact.
final callClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// The estimate for a host, fetched when the confirm sheet opens (never cached: money is live).
final callEstimateProvider = FutureProvider.autoDispose.family<CallEstimate, String>(
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

final activeCallStoreProvider = Provider<ActiveCallStore>((ref) => const ActiveCallStore());

/// Is there a call to resume? Returns its id when the stored call is still going, else null (and forgets it).
///
/// The splash / home screen (or the app root) reads this once after sign-in is known and, when it
/// returns an id, opens `Routes.callOf(id)`. A stored call that has ended, or that the server no longer
/// knows, is cleared. When the server cannot be reached the id is kept: the call may still be live.
final activeCallResumeProvider = FutureProvider.autoDispose<String?>((ref) async {
  final store = ref.read(activeCallStoreProvider);
  final id = await store.read();
  if (id == null) return null;
  if (!ref.read(sessionProvider).isSignedIn) return null;
  try {
    final info = await ref.read(callApiProvider).status(id);
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
});
