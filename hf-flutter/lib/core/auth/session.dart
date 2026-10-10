import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../analytics/analytics.dart';
import '../api/api_client.dart';
import '../api/api_error.dart';
import '../storage/account_storage.dart';
import '../storage/cache.dart';
import '../storage/secure_store.dart';
import 'clerk_client.dart';
import 'hf_me.dart';

// ---------------------------------------------------------------------------------------------
// Core providers. Tests override these (see test/support/): `apiClientProvider` with a
// FakeApiClient, `clerkProvider` with a FakeClerk, `secureStoreProvider` with MemoryKeyValueStore.
// ---------------------------------------------------------------------------------------------

final secureStoreProvider = Provider<KeyValueStore>((ref) => SecureKeyValueStore());

final jsonCacheProvider = Provider<JsonCache>((ref) => const JsonCache());

final clerkProvider = Provider<ClerkApi>((ref) => ClerkClient(store: ref.watch(secureStoreProvider)));

/// The API client every feature uses. `ref.watch(apiClientProvider)` in a provider, then call `getJson`,
/// `postJson`, ... A persistent 401 signs the person out through [sessionProvider].
final apiClientProvider = Provider<ApiClient>((ref) {
  return HttpApiClient(
    tokens: ref.watch(clerkProvider),
    onSessionLost: () => ref.read(sessionProvider.notifier).onSessionLost(),
  );
});

/// Things to do on sign-out, in order (each in its own try/catch): unregister the push token (HF-NATIVE-7),
/// drop feature caches. A feature adds one with `ref.read(signOutHooksProvider).add(...)`.
typedef SignOutHook = Future<void> Function();
final signOutHooksProvider = Provider<List<SignOutHook>>((ref) => <SignOutHook>[]);

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

enum SessionStatus { loading, signedOut, signedIn }

class SessionState {
  const SessionState({required this.status, this.user, this.me, this.meError});

  const SessionState.loading() : this(status: SessionStatus.loading);
  const SessionState.signedOut() : this(status: SessionStatus.signedOut);

  final SessionStatus status;
  final ClerkUser? user;

  /// `GET /api/hf/me`, or null until it loaded (or while the server side is not live).
  final HfMe? me;
  final ApiError? meError;

  bool get isLoading => status == SessionStatus.loading;
  bool get isSignedIn => status == SessionStatus.signedIn;

  /// The Host tab shows when the person has a host profile.
  bool get hasHostTab => me?.hasHost ?? false;

  SessionState copyWith({HfMe? me, ApiError? meError, bool clearMeError = false}) => SessionState(
        status: status,
        user: user,
        me: me ?? this.me,
        meError: clearMeError ? null : (meError ?? this.meError),
      );
}

final sessionProvider = NotifierProvider<SessionController, SessionState>(SessionController.new);

class SessionController extends Notifier<SessionState> {
  @override
  SessionState build() => const SessionState.loading();

  ClerkApi get _clerk => ref.read(clerkProvider);
  ApiClient get _api => ref.read(apiClientProvider);

  /// Cold start (and app resume while signed out): is there an active Clerk session on this device?
  Future<void> restore() async {
    try {
      final user = await _clerk.currentUser();
      if (user == null || user.id.isEmpty) {
        _setSignedOut();
        return;
      }
      await _adopt(user);
    } catch (_) {
      // Offline at start: we cannot tell. Browse as a guest; resume re-checks.
      _setSignedOut();
    }
  }

  /// Redeem the WhatsApp ticket (HF-NATIVE-2 calls this after `/api/auth/whatsapp/verify`).
  Future<ClerkStep> signInWithTicket(String ticket, {String? phone}) async {
    final step = await _clerk.signInWithTicket(ticket);
    final user = step.user;
    if (user != null) await _adopt(user, phone: phone);
    return step;
  }

  /// Sign out: run the hooks (push unregister), Clerk sign-out, telemetry reset, clear caches.
  Future<void> signOut() async {
    for (final hook in List<SignOutHook>.of(ref.read(signOutHooksProvider))) {
      try {
        await hook();
      } catch (_) {
        // a hook failing never blocks sign-out
      }
    }
    try {
      await _clerk.signOut();
    } catch (_) {
      // offline: the device is cleared below either way
    }
    await _clearLocal();
  }

  /// The API client calls this when a 401 survives a token refresh: the session is gone.
  Future<void> onSessionLost() async {
    if (!state.isSignedIn) return;
    await _clearLocal();
  }

  /// Reload `GET /api/hf/me`. A failure keeps the previous value and records [SessionState.meError].
  Future<void> refreshMe() async {
    if (!state.isSignedIn) return;
    try {
      final json = await _api.getJson('/api/hf/me');
      state = state.copyWith(me: HfMe.fromJson(json), clearMeError: true);
    } on ApiError catch (e) {
      state = state.copyWith(meError: e);
    }
  }

  Future<void> _adopt(ClerkUser user, {String? phone}) async {
    AccountScope.id = user.id;
    state = SessionState(status: SessionStatus.signedIn, user: user, me: state.me);
    await Analytics.identify(user.id, phone: phone);
    await Analytics.aliasClerk(user.id);
    await refreshMe();
  }

  Future<void> _clearLocal() async {
    try {
      await ref.read(jsonCacheProvider).clearAll(); // while AccountScope.id is still set
    } catch (_) {
      // best effort
    }
    await Analytics.reset();
    AccountScope.id = null;
    _setSignedOut();
  }

  void _setSignedOut() {
    AccountScope.id = null;
    state = const SessionState.signedOut();
  }
}
