import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/config/flags.dart';
import '../../../core/router/deep_link_handler.dart';
import 'opt_in_policy.dart';
import 'push_gateway.dart';
import 'push_payload.dart';

/// Today's time. Tests override it to check the 14-day re-ask.
final pushClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

final pushServiceProvider = Provider<PushService>((ref) => PushService(ref));

/// Push opt-in, token registration and notification taps (spec 2.16).
///
/// Worker contract: `POST /api/hf/push/register {token, platform:'android', shell}` and
/// `DELETE /api/hf/push/register {token}` (worker/src/routes/hf_push.ts). The token is registered even while
/// `hfPushEnabled` is off, as the server allows; only the opt-in SHEET waits for the flag.
class PushService {
  PushService(this._ref);

  final Ref _ref;

  /// Device-level (not account scoped), like the 18+ acknowledgement: the answer belongs to the phone.
  static const String optInKey = 'hf.push.optin';

  /// The token the worker last accepted, so sign-out can delete exactly it, even offline-ish.
  static const String tokenKey = 'hf.push.token';

  PushGateway get _gateway => _ref.read(pushGatewayProvider);
  ApiClient get _api => _ref.read(apiClientProvider);
  DateTime _now() => _ref.read(pushClockProvider)();

  /// `native-<versionCode>` (the worker stores it as the shell version).
  String get shell => Analytics.appBuild > 0 ? 'native-${Analytics.appBuild}' : 'native';

  // ---- opt-in sheet ----------------------------------------------------------------------------

  Future<OptInRecord?> readRecord() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return OptInRecord.decode(prefs.getString(optInKey));
    } catch (_) {
      return null; // unreadable storage counts as "never asked"
    }
  }

  Future<void> _writeRecord(OptInAnswer answer) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(optInKey, OptInRecord(answer: answer, at: _now()).encode());
    } catch (_) {
      // best effort: worst case the sheet asks once more
    }
  }

  Future<bool> _flagOn() async {
    try {
      final flags = await _ref.read(flagsProvider.future).timeout(const Duration(seconds: 3));
      return flags.hfPushEnabled;
    } catch (_) {
      return false;
    }
  }

  /// Signed in, Firebase running, flag on, not allowed yet, and not asked within 14 days.
  Future<bool> shouldPrompt() async {
    if (!_ref.read(sessionProvider).isSignedIn) return false;
    if (!_gateway.available) return false;
    final flagOn = await _flagOn();
    PushPermission permission;
    try {
      permission = await _gateway.permission();
    } catch (_) {
      permission = PushPermission.notGranted;
    }
    return shouldShowOptIn(
      gatewayAvailable: true,
      flagOn: flagOn,
      permission: permission,
      record: await readRecord(),
      now: _now(),
    );
  }

  /// "Allow": the Android prompt, then the token. Returns whether notifications are now allowed.
  Future<bool> allow() async {
    PushPermission result;
    try {
      result = await _gateway.requestPermission();
    } catch (e, st) {
      await Analytics.captureException(e, st, handled: true, extra: {'where': 'hf_push_permission'});
      result = PushPermission.notGranted;
    }
    final granted = result == PushPermission.granted;
    await _writeRecord(granted ? OptInAnswer.allowed : OptInAnswer.denied);
    await Analytics.capture('hf_app_permission', {'kind': 'push', 'result': granted ? 'granted' : 'denied'});
    if (granted) await registerToken();
    return granted;
  }

  /// "Not now": remembered for 14 days. The Android prompt is never shown.
  Future<void> notNow() async {
    await _writeRecord(OptInAnswer.later);
    await Analytics.capture('hf_app_permission', {'kind': 'push', 'result': 'dismissed'});
  }

  // ---- token -----------------------------------------------------------------------------------

  /// After sign-in (and at app start while signed in): register quietly when notifications are already
  /// allowed. Never shows a prompt.
  Future<void> syncAfterSignIn() async {
    if (!_gateway.available) return;
    try {
      if (await _gateway.permission() != PushPermission.granted) return;
    } catch (_) {
      return;
    }
    await registerToken();
  }

  /// `POST /api/hf/push/register`. [token] is the refreshed token from `onTokenRefresh`, or null to ask
  /// Firebase for the current one.
  Future<void> registerToken([String? token]) async {
    if (!_ref.read(sessionProvider).isSignedIn) return;
    final sw = Stopwatch()..start();
    try {
      final t = token ?? await _gateway.token();
      if (t == null || t.isEmpty) {
        await Analytics.capture('hf_push_registered',
            {'outcome': 'failed', 'reason': 'no_token', 'ms': sw.elapsedMilliseconds, 'shell_version': shell});
        return;
      }
      await _api.postJson('/api/hf/push/register', body: {'token': t, 'platform': 'android', 'shell': shell});
      await _storeToken(t);
      await Analytics.capture(
          'hf_push_registered', {'outcome': 'ok', 'ms': sw.elapsedMilliseconds, 'shell_version': shell});
    } on ApiError catch (e) {
      await Analytics.capture('hf_push_registered', {
        'outcome': 'failed',
        'reason': e.code,
        'status': e.status,
        'ms': sw.elapsedMilliseconds,
        'shell_version': shell,
      });
    } catch (e, st) {
      await Analytics.captureException(e, st, handled: true, extra: {'where': 'hf_push_register'});
      await Analytics.capture('hf_push_registered', {
        'outcome': 'failed',
        'reason': 'error',
        'ms': sw.elapsedMilliseconds,
        'shell_version': shell,
      });
    }
  }

  /// `DELETE /api/hf/push/register {token}`: this phone stops getting this account's pushes. Runs as a
  /// sign-out hook BEFORE Clerk signs out, so the call is still authorised. Never throws.
  Future<void> unregister() async {
    String? token = await _readToken();
    if (token == null && _gateway.available) {
      try {
        token = await _gateway.token();
      } catch (_) {
        token = null;
      }
    }
    if (token == null || token.isEmpty) return;
    try {
      await _api.deleteJson('/api/hf/push/register', body: {'token': token});
    } catch (_) {
      // sign-out must not wait on this; the worker also drops tokens FCM reports as dead
    }
    await _storeToken(null);
  }

  Future<String?> _readToken() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(tokenKey);
      return (v == null || v.isEmpty) ? null : v;
    } catch (_) {
      return null;
    }
  }

  Future<void> _storeToken(String? token) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (token == null) {
        await prefs.remove(tokenKey);
      } else {
        await prefs.setString(tokenKey, token);
      }
    } catch (_) {
      // best effort
    }
  }

  // ---- taps ------------------------------------------------------------------------------------

  /// A notification was tapped (or "Open" on the in-app banner): record it and go where its path says,
  /// through the same mapper as links. A route that needs sign-in goes to `/sign-in?next=` first.
  /// Returns false when the message is not ours.
  Future<bool> open(PushMessage message, {required String launch}) async {
    final payload = message.payload;
    if (payload == null) return false;
    await Analytics.capture('hf_push_opened', {'kind': payload.kind.wire});
    await _ref.read(deepLinkHandlerProvider).handle(payload.path, source: 'push', launch: launch);
    return true;
  }
}
