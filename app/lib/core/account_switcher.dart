import 'dart:async';

import '../features/avatok/call_screen.dart' show clearCallState;
import '../identity/identity.dart';
import '../push/push_service.dart';
import '../sync/sync_hub.dart';
import 'analytics.dart';
import 'ava_log.dart';
import 'db.dart';
import 'disk_cache.dart';

/// [MULTIACCT-3] Single, idempotent orchestrator for changing the ACTIVE account
/// on a shared device (parent + kids log out/in constantly). EVERY login /
/// account-switch / logout path routes through here so no screen does its own
/// partial teardown — partial teardown is exactly what left a stale hub socket
/// pulling the old account's inbox, a stale FCM mapping (silent call fan-out
/// failure), and stale call state that auto-busied the next fresh call.
///
/// The step list is deliberately ordered and each step is best-effort so one
/// failure never strands the switch half-done:
///   1. clear in-flight call state + end any native ring (fixes autobusy race)
///   2. mark the DEPARTING account inactive on this device (token stays; server
///      stops resolving the old account to it) — only when we know who's leaving
///   3. stop the per-account hub socket (no reconnect; drops old in-memory state)
///   4. swap the drift DB via Db.reset() (next Db.I reopens the target's file)
///   5. flip AccountScope.id → this re-scopes DiskCache + media cache + identity
///      automatically on their next access (all keyed on AccountScope.id)
///   6. persist the active-account pointer for cold-boot recovery
///   7. re-register + map THIS device's push token to the target account
///
/// `switchTo(null)` is the logout form: steps 1–4 + clear the pointer, no new
/// registration. Serialized so overlapping calls can't interleave teardown.
class AccountSwitcher {
  AccountSwitcher._();

  /// Cross-launch pointer to the last active account (device-level/global — it
  /// MUST NOT be account-scoped, or boot couldn't find which account to restore).
  /// MUST match the key main.dart's boot path reads (`_MyAppState._kAcct`).
  static const String _kAcct = 'clerk_account_id';

  static Future<void>? _inFlight;

  /// Switch the active account to [accountId] (or log out when null). Returns the
  /// same future to concurrent callers so the teardown runs exactly once.
  static Future<void> switchTo(String? accountId) {
    // Coalesce: if a switch is already running, chain the new one after it so we
    // never tear down two accounts simultaneously.
    final prev = _inFlight ?? Future<void>.value();
    late final Future<void> next;
    next = prev.then((_) => _run(accountId)).whenComplete(() {
      if (identical(_inFlight, next)) _inFlight = null;
    });
    _inFlight = next;
    return next;
  }

  static Future<void> _run(String? accountId) async {
    final from = AccountScope.id;
    final to = (accountId != null && accountId.isEmpty) ? null : accountId;
    if (from == to) {
      // No-op switch (already on the target) — still re-map the push token so a
      // stale server mapping from a prior crash is healed. Cheap + idempotent.
      if (to != null) unawaited(_reRegisterPush(to));
      return;
    }
    final sw = DateTime.now().millisecondsSinceEpoch;
    final failed = <String>[];
    AvaLog.I.log('acct', 'switchTo from=$from to=$to');

    // 1. Clear any in-flight call leg + native ring BEFORE anything else, so a
    //    call from the previous account can't auto-busy the next one.
    try { await clearCallState(); } catch (e) { failed.add('call:$e'); }

    // 2. Mark the DEPARTING account inactive on this device (token untouched).
    //    Must run while `from`'s auth is still valid — callers invoke switchTo
    //    BEFORE signing the old Clerk session out.
    if (from != null && from.isNotEmpty) {
      try { await PushService.mapDevice(active: false); } catch (e) { failed.add('unmap:$e'); }
    }

    // 3. Stop the per-account hub socket (no reconnect; clears old in-memory state).
    try { SyncHub.I.stop(); } catch (e) { failed.add('hub:$e'); }

    // 4. Close the drift DB handle so the next Db.I reopens the target's file.
    try { await Db.reset(); } catch (e) { failed.add('db:$e'); }

    // 5. Flip the scope — DiskCache, media cache and IdentityStore all re-scope
    //    on their next access because every key derives from AccountScope.id.
    AccountScope.id = to;

    // 6. Persist / clear the cold-boot pointer.
    try {
      if (to != null && to.isNotEmpty) {
        await DiskCache.writeGlobal(_kAcct, to);
      } else {
        await DiskCache.deleteGlobal(_kAcct);
      }
    } catch (e) { failed.add('pointer:$e'); }

    // 7. Re-register + map THIS device's push token to the TARGET account, so the
    //    server can route calls/pushes to it immediately (the fix for "callee
    //    never rang after re-login"). Skipped on logout.
    if (to != null && to.isNotEmpty) {
      unawaited(_reRegisterPush(to));
    }

    Analytics.capture('account_switch', {
      'from': from ?? '', 'to': to ?? '',
      'duration_ms': DateTime.now().millisecondsSinceEpoch - sw,
      'steps_failed': failed,
      'logout': to == null,
    });
    AvaLog.I.log('acct', 'switchTo done (${failed.isEmpty ? "clean" : failed.join(",")})');
  }

  /// registerToken re-mints the device→account mapping with active=1 for the
  /// target (via /api/register carrying device_id). Best-effort + unawaited so a
  /// slow network never blocks the UI switch; a failure is captured by
  /// registerToken's own telemetry.
  static Future<void> _reRegisterPush(String uid) async {
    try {
      await PushService.registerToken(uid);
    } catch (e) {
      AvaLog.I.log('acct', 're-register push failed for $uid: $e');
    }
  }
}
