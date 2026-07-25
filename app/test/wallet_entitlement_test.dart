// [WALLET-GET-STATE-1] Root-Cause Report §17/§53: every GET helper in
// money_api.dart used to drop the HTTP status entirely — a 401, a 500, a
// gateway timeout, or a non-JSON error page all silently became `{}`, and
// callers coalesced the missing field to a plausible-but-wrong default
// ("not premium", "0 tokens"). These tests pin down the fix: MoneyApi._get
// (via balanceResult) must classify every outcome correctly, and
// WalletEntitlement must never let a failed read masquerade as a confirmed
// answer — in particular, it must never demote a confirmed `.premium` to
// `.free`.
//
// Uses `MoneyApi.debugGetOverride` — a test-only network seam (mirrors the
// `ApiAuth.clerkBearer` function-pointer injection pattern already used in
// this codebase) — so these run with no live network, no plugins, matching
// the "Pure functions only" convention of the existing test suite
// (widget_test.dart).
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:avatok_call/core/money_api.dart';
import 'package:avatok_call/core/wallet_entitlement.dart';
import 'package:avatok_call/identity/identity.dart';

void main() {
  setUp(() {
    // WalletEntitlement.I is a process-wide singleton — reset ALL of its
    // per-scope state before every test so cases can't leak "last confirmed
    // state" into each other, whether they're in the same account scope or
    // (for the [WALLET-LEAK-B2] tests below) different ones. Also reset
    // AccountScope.id itself, since it's a bare global static and several
    // tests below flip it to simulate an account switch.
    //
    // (WalletEntitlement's persistence layer is secure-storage
    // best-effort/try-catch, so it's safe to exercise with no platform
    // channel registered — a failed disk read/write here is swallowed
    // exactly like it is in production.)
    WalletEntitlement.I.debugResetAllScopes();
    AccountScope.id = null;
  });

  tearDown(() {
    MoneyApi.debugGetOverride = null;
    AccountScope.id = null;
  });

  void mockBalance({required int status, String? body}) {
    MoneyApi.debugGetOverride = (url) async => http.Response(body ?? '', status);
  }

  void mockTransportFailure() {
    MoneyApi.debugGetOverride = (url) async =>
        throw Exception('simulated transport failure (DNS/timeout)');
  }

  group('MoneyApi.balanceResult — status/error-class classification', () {
    test('200 + JSON → ok, .none', () async {
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': true, 'spendable': 42, 'balance': 10}),
      );
      final r = await MoneyApi.balanceResult();
      expect(r.ok, isTrue);
      expect(r.status, 200);
      expect(r.errorClass, MoneyApiErrorClass.none);
      expect(r.data['premium'], true);
      expect(r.data['spendable'], 42);
    });

    test('200 + JSON with a genuine zero balance is NOT an error', () async {
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': false, 'spendable': 0, 'balance': 0}),
      );
      final r = await MoneyApi.balanceResult();
      expect(r.ok, isTrue);
      expect(r.errorClass, MoneyApiErrorClass.none);
      expect(r.data['spendable'], 0);
    });

    test('401 → not ok, .auth (never coerced to an empty-but-successful body)', () async {
      mockBalance(status: 401, body: jsonEncode({'error': 'unauthorized'}));
      final r = await MoneyApi.balanceResult();
      expect(r.ok, isFalse);
      expect(r.status, 401);
      expect(r.errorClass, MoneyApiErrorClass.auth);
    });

    test('500 → not ok, .server', () async {
      mockBalance(status: 500, body: jsonEncode({'error': 'internal'}));
      final r = await MoneyApi.balanceResult();
      expect(r.ok, isFalse);
      expect(r.status, 500);
      expect(r.errorClass, MoneyApiErrorClass.server);
    });

    test('HTML gateway/edge error page (non-JSON body) → not ok, .server, '
        'never read as a trustworthy empty success', () async {
      // A Cloudflare/edge error page: status can even be 200 from the edge's
      // point of view while the body is garbage — the OLD `_json` helper
      // would have swallowed the parse failure and returned `{}` as if the
      // server had legitimately answered "nothing".
      mockBalance(status: 502, body: '<html><body>502 Bad Gateway</body></html>');
      final r = await MoneyApi.balanceResult();
      expect(r.ok, isFalse);
      expect(r.errorClass, MoneyApiErrorClass.server);
      expect(r.data, isEmpty);
    });

    test('transport failure (timeout/DNS/thrown exception) → not ok, status 0, .transport', () async {
      mockTransportFailure();
      final r = await MoneyApi.balanceResult();
      expect(r.ok, isFalse);
      expect(r.status, 0);
      expect(r.errorClass, MoneyApiErrorClass.transport);
      expect(r.data, isEmpty);
    });
  });

  group('WalletEntitlement — state machine', () {
    test('a confirmed 200 premium response resolves to .premium, not stale', () async {
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': true, 'spendable': 50, 'balance': 50}),
      );
      final snap = await WalletEntitlement.I.refresh();
      expect(snap.state, WalletEntitlementState.premium);
      expect(snap.isPremium, isTrue);
      expect(snap.stale, isFalse);
      expect(snap.spendable, 50);
    });

    test('a confirmed 200 free response resolves to .free, not stale', () async {
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': false, 'spendable': 3, 'balance': 0}),
      );
      final snap = await WalletEntitlement.I.refresh();
      expect(snap.state, WalletEntitlementState.free);
      expect(snap.isPremium, isFalse);
      expect(snap.stale, isFalse);
    });

    test('401 on the very first read (nothing ever confirmed) → .unavailable, '
        'never .free and never a 0 balance', () async {
      mockBalance(status: 401, body: '');
      final snap = await WalletEntitlement.I.refresh();
      expect(snap.state, WalletEntitlementState.unavailable);
      expect(snap.state, isNot(WalletEntitlementState.free));
      expect(snap.stale, isTrue);
    });

    test('500 on the very first read → .unavailable', () async {
      mockBalance(status: 500, body: 'internal error');
      final snap = await WalletEntitlement.I.refresh();
      expect(snap.state, WalletEntitlementState.unavailable);
    });

    test('an HTML gateway response on the very first read → .unavailable', () async {
      mockBalance(status: 502, body: '<html>502</html>');
      final snap = await WalletEntitlement.I.refresh();
      expect(snap.state, WalletEntitlementState.unavailable);
    });

    test('a timeout on the very first read → .unavailable', () async {
      mockTransportFailure();
      final snap = await WalletEntitlement.I.refresh();
      expect(snap.state, WalletEntitlementState.unavailable);
    });

    test('THE core regression test: a network error must NEVER downgrade a '
        'confirmed .premium to .free — Root-Cause Report §17 ("#ava is a paid '
        'feature" toast firing for a premium user on a flaky network)', () async {
      // First read: server confirms premium.
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': true, 'spendable': 95, 'balance': 0}),
      );
      final confirmed = await WalletEntitlement.I.refresh();
      expect(confirmed.state, WalletEntitlementState.premium);

      // Second read, same account, same session: the network drops the ball.
      for (final failure in <void Function()>[
        () => mockBalance(status: 401, body: ''),
        () => mockBalance(status: 500, body: 'boom'),
        () => mockBalance(status: 502, body: '<html>gateway</html>'),
        () => mockTransportFailure(),
      ]) {
        failure();
        final afterFailure = await WalletEntitlement.I.refresh();
        expect(afterFailure.state, WalletEntitlementState.premium,
            reason: 'a failed GET must preserve the last CONFIRMED state, never flip it to free');
        expect(afterFailure.isPremium, isTrue);
        expect(afterFailure.stale, isTrue, reason: 'a carried-forward state must be marked stale');
        expect(afterFailure.spendable, 95, reason: 'the last known number should ride along too');
      }
    });

    test('a network error also never downgrades a confirmed .free — it just '
        'carries the confirmed .free forward, marked stale', () async {
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': false, 'spendable': 3, 'balance': 0}),
      );
      final confirmed = await WalletEntitlement.I.refresh();
      expect(confirmed.state, WalletEntitlementState.free);

      mockBalance(status: 500, body: 'boom');
      final afterFailure = await WalletEntitlement.I.refresh();
      expect(afterFailure.state, WalletEntitlementState.free);
      expect(afterFailure.stale, isTrue);
    });

    test('a later successful read clears staleness and can move .free → .premium '
        '(e.g. right after a top-up)', () async {
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': false, 'spendable': 0, 'balance': 0}),
      );
      await WalletEntitlement.I.refresh();

      mockBalance(
        status: 200,
        body: jsonEncode({'premium': true, 'spendable': 1000, 'balance': 1000}),
      );
      final afterTopup = await WalletEntitlement.I.refresh();
      expect(afterTopup.state, WalletEntitlementState.premium);
      expect(afterTopup.stale, isFalse);
    });
  });

  group('[WALLET-LEAK-B2] per-account scoping — cross-account leak fix', () {
    test('account A confirms .premium; switching AccountScope to B must NOT let B '
        'observe it — not via a synchronous snapshot read, not via hydrate(), and '
        'not via a failed refresh() carrying A\'s state forward', () async {
      // --- Account A confirms premium. ---
      AccountScope.id = 'acct_A';
      mockBalance(
        status: 200,
        body: jsonEncode({'premium': true, 'spendable': 500, 'balance': 500}),
      );
      final confirmedA = await WalletEntitlement.I.refresh();
      expect(confirmedA.state, WalletEntitlementState.premium);
      expect(WalletEntitlement.I.snapshot.value.isPremium, isTrue);

      // --- Switch to account B (e.g. a child account on the same shared phone). ---
      AccountScope.id = 'acct_B';

      // (1) A bare, SYNCHRONOUS read — exactly what ava_sidebar.dart's initState
      // does pre-frame, before any hydrate()/refresh() has resolved — must never
      // see A's confirmed premium. This is the exact leak the Opus gate caught.
      final syncSnap = WalletEntitlement.I.snapshot.value;
      expect(syncSnap.isPremium, isFalse,
          reason: "a bare scope switch must not carry A's confirmed premium into B");
      expect(syncSnap.state, isNot(WalletEntitlementState.premium));

      // (2) hydrate() must not short-circuit on a global "already hydrated"
      // flag — B has never hydrated in this process, so it must attempt (and
      // fail, since no platform channel is registered in this test) its OWN
      // scoped disk read rather than silently leaving A's state in place.
      await WalletEntitlement.I.hydrate();
      expect(WalletEntitlement.I.snapshot.value.isPremium, isFalse);

      // (3) A failed refresh() for B — nothing has ever been confirmed for B —
      // must fall back to .unavailable, NEVER to A's carried-forward .premium.
      mockBalance(status: 500, body: 'boom');
      final afterFailureB = await WalletEntitlement.I.refresh();
      expect(afterFailureB.state, WalletEntitlementState.unavailable);
      expect(afterFailureB.isPremium, isFalse);
      expect(WalletEntitlement.I.snapshot.value.isPremium, isFalse);

      // --- Sanity: switching back to A must still show A's OWN confirmed
      // premium untouched — the fix must not have evicted or corrupted it. ---
      AccountScope.id = 'acct_A';
      final backToA = WalletEntitlement.I.snapshot.value;
      expect(backToA.state, WalletEntitlementState.premium);
      expect(backToA.isPremium, isTrue);
    });

    test('B confirming its own .free is unaffected by A\'s .premium, and a later '
        'failed refresh for B carries forward B\'s OWN confirmed .free — not '
        'A\'s .premium and not .unavailable', () async {
      AccountScope.id = 'acct_A';
      mockBalance(status: 200, body: jsonEncode({'premium': true, 'spendable': 500, 'balance': 500}));
      await WalletEntitlement.I.refresh();

      AccountScope.id = 'acct_B';
      mockBalance(status: 200, body: jsonEncode({'premium': false, 'spendable': 2, 'balance': 0}));
      final confirmedB = await WalletEntitlement.I.refresh();
      expect(confirmedB.state, WalletEntitlementState.free);

      mockBalance(status: 500, body: 'boom');
      final afterFailureB = await WalletEntitlement.I.refresh();
      expect(afterFailureB.state, WalletEntitlementState.free,
          reason: "B's own confirmed .free must carry forward, never A's .premium and never .unavailable");
      expect(afterFailureB.isPremium, isFalse);
      expect(afterFailureB.stale, isTrue);
    });

    test('invalidate() only clears the CURRENTLY active scope, not other '
        'accounts\' confirmed state', () async {
      AccountScope.id = 'acct_A';
      mockBalance(status: 200, body: jsonEncode({'premium': true, 'spendable': 500, 'balance': 500}));
      await WalletEntitlement.I.refresh();

      AccountScope.id = 'acct_B';
      mockBalance(status: 200, body: jsonEncode({'premium': false, 'spendable': 1, 'balance': 0}));
      await WalletEntitlement.I.refresh();

      // Invalidate while B is active (e.g. right after a top-up attempt for B).
      WalletEntitlement.I.invalidate();
      expect(WalletEntitlement.I.snapshot.value.state, WalletEntitlementState.loading);

      // A's confirmed premium must be completely unaffected.
      AccountScope.id = 'acct_A';
      expect(WalletEntitlement.I.snapshot.value.isPremium, isTrue);
    });
  });

  group('.unavailable copy contract', () {
    test('the shared unavailable message never says "top up" or claims a zero balance', () {
      final lower = kWalletUnavailableMessage.toLowerCase();
      expect(lower.contains('top up'), isFalse);
      expect(lower.contains('0 token'), isFalse);
      expect(lower.contains('0 coin'), isFalse);
      // Must read as a retry prompt, not a balance claim.
      expect(lower.contains('try again') || lower.contains('retry'), isTrue);
    });

    test('WalletEntitlementSnapshot.unavailable never carries a fabricated balance', () {
      const snap = WalletEntitlementSnapshot.unavailable;
      expect(snap.state, WalletEntitlementState.unavailable);
      expect(snap.spendable, 0); // 0 here means "unknown", callers must gate on `state`, not this
      expect(snap.stale, isTrue);
      expect(snap.isPremium, isFalse);
      expect(snap.isConfirmed, isFalse);
    });
  });
}
