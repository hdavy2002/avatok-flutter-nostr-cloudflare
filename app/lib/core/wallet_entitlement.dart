import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../identity/identity.dart';
import 'account_storage.dart';
import 'money_api.dart';

/// [WALLET-GET-STATE-1] The wallet-entitlement state machine.
///
/// `loading`      — no read has completed yet this session (first paint only).
/// `premium`      — server CONFIRMED a topped-up/beta-premium wallet.
/// `free`         — server CONFIRMED a non-premium wallet.
/// `unavailable`  — the last GET failed (auth/server/transport/non-JSON) and
///                   nothing has ever been confirmed for this account, so
///                   there is genuinely nothing trustworthy to show.
///
/// The whole point of this type: a failed network read is its OWN state. It is
/// never silently reinterpreted as `free` (the "#ava is a paid feature" toast
/// firing for a premium user on a flaky network — Root-Cause Report §17) and
/// never as "0 tokens" (paid_call_prompt.dart / live_viewer_screen.dart
/// blocking a call the user could afford).
enum WalletEntitlementState { loading, premium, free, unavailable }

/// User-facing copy for the `.unavailable` state. Every consumer must use this
/// (or something equivalent) — never "top up", never "0 tokens": we don't
/// actually know either of those things when a GET failed.
const String kWalletUnavailableMessage = "Couldn't verify wallet — try again.";

/// A snapshot of wallet entitlement at a point in time.
@immutable
class WalletEntitlementSnapshot {
  final WalletEntitlementState state;
  /// Best-known spendable balance (free + bonus + paid, per `WalletDO.snap()`).
  /// 0 when unknown — always check [state] before trusting this as "broke".
  final int spendable;
  /// Best-known raw paid-only balance. 0 when unknown.
  final int balance;
  /// True when this snapshot was NOT produced by a fresh, successful read —
  /// either loaded from the account-scoped disk cache, or carried forward
  /// after a failed [WalletEntitlement.refresh] preserved the last confirmed
  /// state. UI may show it, but should treat it as provisional.
  final bool stale;
  /// When this state was last CONFIRMED by the server (null if never).
  final DateTime? checkedAt;

  const WalletEntitlementSnapshot({
    required this.state,
    this.spendable = 0,
    this.balance = 0,
    this.stale = false,
    this.checkedAt,
  });

  bool get isPremium => state == WalletEntitlementState.premium;
  bool get isConfirmed =>
      state == WalletEntitlementState.premium || state == WalletEntitlementState.free;

  static const WalletEntitlementSnapshot loading =
      WalletEntitlementSnapshot(state: WalletEntitlementState.loading);

  static const WalletEntitlementSnapshot unavailable =
      WalletEntitlementSnapshot(state: WalletEntitlementState.unavailable, stale: true);
}

/// Per-account entitlement cache + refresh, sitting on top of
/// [MoneyApi.balanceResult]. Singleton — one shared PROCESS per running app,
/// but every piece of STATE inside it is re-scoped to whichever account is
/// active (mirrors [_EntitlementCache]'s old per-file idiom in
/// ava_sidebar.dart, now centralized so every consumer gets the same "instant
/// last-known value, refresh in background, never downgrade on failure"
/// behavior instead of re-implementing it, inconsistently, nine times).
///
/// MANDATORY per-account scoping (CLAUDE.md rule 1): the on-disk cache is
/// namespaced via `scopedKey()`/`readScoped()` — one phone is routinely shared
/// by a parent and each child account, and a raw global key would leak one
/// account's premium status onto another's screen.
///
/// [WALLET-LEAK-B2] 2026-07-25 Opus gate finding: the FIRST version of this
/// class scoped only the on-disk cache and left the in-memory layer
/// (`_hydrated` bool + a single global `snapshot`) process-global. Switching
/// from a parent account to a child on the same phone made `hydrate()` an
/// immediate no-op (the disk read for the child's OWN scoped key never ran)
/// and left `snapshot` holding the parent's confirmed `.premium`/balance —
/// exactly what a synchronous pre-frame read (ava_sidebar.dart's initState)
/// would paint for the child. A failed `refresh()` for the child then carried
/// the PARENT's confirmed state forward instead of falling back to
/// `.unavailable`. Fixed by keying every piece of in-memory state
/// (`_mem`, `_hydratedScopes`, the notifier's current value) by
/// `AccountScope.id`, exactly like the deleted `_EntitlementCache._mem` map
/// this class replaced.
class WalletEntitlement {
  WalletEntitlement._();
  static final WalletEntitlement I = WalletEntitlement._();

  static const _cacheKey = 'wallet_entitlement_v1';
  static const _ss = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// In-memory snapshots, keyed by account scope — one entry per account this
  /// process has touched. NEVER read/write this without going through
  /// [_scopeId], for the same reason `scopedKey()` exists in
  /// account_storage.dart: a raw global slot leaks across accounts.
  final Map<String, WalletEntitlementSnapshot> _mem = {};

  /// Scopes that have already attempted their disk hydrate this process —
  /// the per-scope replacement for the old global `_hydrated` bool. Each
  /// account gets exactly one disk read attempt, not the whole app.
  final Set<String> _hydratedScopes = {};

  /// Single notifier instance (so existing `ValueListenable`/`.value`
  /// consumers keep working unchanged), but its VALUE is re-synced to the
  /// active scope on every [snapshot] access — see [snapshot].
  final ValueNotifier<WalletEntitlementSnapshot> _notifier =
      ValueNotifier(WalletEntitlementSnapshot.loading);

  /// The scope [_notifier]'s current `.value` was last published for. When
  /// this no longer matches [_scopeId], the notifier is holding a DIFFERENT
  /// account's snapshot and must be re-synced before anyone reads it.
  String? _notifierScope;

  /// Same guest-fallback idiom as `scopedKey()`/`kGuestScope` in
  /// account_storage.dart, computed locally so the in-memory map key doesn't
  /// depend on any disk I/O having happened.
  static String _scopeId() =>
      (AccountScope.id == null || AccountScope.id!.isEmpty) ? kGuestScope : AccountScope.id!;

  /// The CURRENT scope's snapshot, observable for screens that want to
  /// rebuild on change. Resets to `.loading` (or replays that scope's own
  /// last-known value) the instant the active account has changed since the
  /// last access — so a consumer that reads `.value` synchronously and
  /// pre-frame (e.g. ava_sidebar.dart's initState) can never observe another
  /// account's state, even if that account is still `.premium` in [_mem].
  ValueNotifier<WalletEntitlementSnapshot> get snapshot {
    final scope = _scopeId();
    if (_notifierScope != scope) {
      _notifierScope = scope;
      _notifier.value = _mem[scope] ?? WalletEntitlementSnapshot.loading;
    }
    return _notifier;
  }

  /// Publishes [snap] for [scope] into both the per-scope memory map and (if
  /// [scope] is STILL the active one — it may have changed while we were
  /// awaiting disk/network I/O) the live notifier.
  void _publish(String scope, WalletEntitlementSnapshot snap) {
    _mem[scope] = snap;
    if (_scopeId() == scope) {
      _notifierScope = scope;
      _notifier.value = snap;
    }
  }

  /// Fast path for first paint: loads the last CONFIRMED state for the
  /// CURRENTLY ACTIVE account from disk (marked `stale`) without hitting the
  /// network. Call this before/alongside [refresh] so a drawer/screen doesn't
  /// flash "loading" or "unavailable" every time it opens. Safe to call
  /// repeatedly — only reads disk once per process PER ACCOUNT SCOPE; later
  /// calls for a scope that already hydrated are a no-op.
  Future<void> hydrate() async {
    final scope = _scopeId();
    if (_hydratedScopes.contains(scope)) return;
    _hydratedScopes.add(scope);
    try {
      final raw = await readScoped(_ss, _cacheKey);
      if (raw == null || raw.isEmpty) return;
      final j = jsonDecode(raw) as Map<String, dynamic>;
      final st = _stateFromName(j['state'] as String?);
      if (st == null) return; // never replay 'loading'/'unavailable' from disk
      _publish(
        scope,
        WalletEntitlementSnapshot(
          state: st,
          spendable: _asInt(j['spendable']) ?? 0,
          balance: _asInt(j['balance']) ?? 0,
          stale: true,
          checkedAt: DateTime.tryParse((j['checked_at'] as String?) ?? ''),
        ),
      );
    } catch (_) {/* best-effort — cold start just falls through to refresh() */}
  }

  /// Authoritative refresh from the server, FOR WHICHEVER ACCOUNT IS ACTIVE
  /// when this is called. Always resolves — never throws.
  ///
  /// A failed GET (401/500/timeout/non-JSON — see [MoneyApiResult]) NEVER
  /// flips a confirmed `.premium` to `.free`. At worst it falls back to the
  /// last confirmed state for THIS account (re-marked `stale`), or
  /// `.unavailable` if nothing has ever been confirmed for THIS account —
  /// never another account's carried-forward state.
  Future<WalletEntitlementSnapshot> refresh() async {
    final scope = _scopeId();
    final r = await MoneyApi.balanceResult();
    if (r.ok) {
      final premium = r.data['premium'] == 1 || r.data['premium'] == true;
      final spendable = _asInt(r.data['spendable']) ?? _asInt(r.data['balance']) ?? 0;
      final balance = _asInt(r.data['balance']) ?? 0;
      final now = DateTime.now();
      final st = premium ? WalletEntitlementState.premium : WalletEntitlementState.free;
      final snap = WalletEntitlementSnapshot(
        state: st, spendable: spendable, balance: balance, stale: false, checkedAt: now);
      _publish(scope, snap);
      unawaited(_persist(scope, snap));
      return snap;
    }
    // GET failed. Never invent `.free` (or a zero balance) from a failure —
    // that is precisely the phantom-paywall / phantom-"0 tokens" bug this
    // type exists to kill (Root-Cause Report §17). Fall back to THIS scope's
    // own last confirmed value ([_mem], not the shared notifier) so a
    // just-switched-to account can never inherit a DIFFERENT account's
    // confirmed premium via this path.
    final last = _mem[scope];
    final snap = (last != null && last.isConfirmed)
        ? WalletEntitlementSnapshot(
            state: last.state,
            spendable: last.spendable,
            balance: last.balance,
            stale: true,
            checkedAt: last.checkedAt,
          )
        : WalletEntitlementSnapshot.unavailable;
    _publish(scope, snap);
    return snap;
  }

  Future<void> _persist(String scope, WalletEntitlementSnapshot snap) async {
    try {
      // Built directly from the CAPTURED scope rather than re-deriving via
      // scopedKey()/AccountScope.id at write time — refresh() awaits a
      // network round-trip before calling this, and AccountScope.id may have
      // changed again in that window (another account switch mid-flight).
      // Format matches scopedKey(_cacheKey) exactly so readScoped() finds it.
      await _ss.write(
        key: '${_cacheKey}_$scope',
        value: jsonEncode({
          'state': snap.state.name,
          'spendable': snap.spendable,
          'balance': snap.balance,
          'checked_at': snap.checkedAt?.toIso8601String(),
        }),
      );
    } catch (_) {/* best-effort */}
  }

  /// Call right after a successful top-up/purchase, or right after an account
  /// switch, so the very next read for the CURRENTLY ACTIVE scope is forced
  /// to hit the network instead of briefly replaying a stale value.
  void invalidate() {
    final scope = _scopeId();
    _hydratedScopes.remove(scope);
    _publish(scope, WalletEntitlementSnapshot.loading);
  }

  /// Test-only: wipes ALL scopes' in-memory state (map + hydrated set +
  /// notifier), for test isolation between cases that use different
  /// `AccountScope.id` values. Production code never calls this.
  @visibleForTesting
  void debugResetAllScopes() {
    _mem.clear();
    _hydratedScopes.clear();
    _notifierScope = null;
    _notifier.value = WalletEntitlementSnapshot.loading;
  }

  static WalletEntitlementState? _stateFromName(String? n) {
    switch (n) {
      case 'premium': return WalletEntitlementState.premium;
      case 'free': return WalletEntitlementState.free;
      default: return null;
    }
  }

  static int? _asInt(Object? v) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    return null;
  }
}
