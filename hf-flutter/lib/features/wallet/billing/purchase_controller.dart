import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../data/pack_offer.dart';
import '../data/wallet_models.dart';
import '../wallet_providers.dart';
import 'billing_adapter.dart';

enum PurchasePhase {
  idle,

  /// Asking the server (account id) before the Play sheet.
  preparing,

  /// The Play sheet is open.
  awaitingSheet,

  /// Play said "purchased"; the server is confirming and crediting.
  verifying,
}

enum NoticeKind { success, pending, cancelled, error }

/// A result the Wallet shows after a purchase. [id] changes for every new notice.
class PurchaseNotice {
  const PurchaseNotice({required this.id, required this.kind, required this.message});

  final int id;
  final NoticeKind kind;
  final String message;
}

class PurchaseState {
  const PurchaseState({this.phase = PurchasePhase.idle, this.productId, this.notice});

  final PurchasePhase phase;
  final String? productId;
  final PurchaseNotice? notice;

  bool get busy => phase == PurchasePhase.preparing || phase == PurchasePhase.verifying;

  PurchaseState copyWith({PurchasePhase? phase, String? productId, PurchaseNotice? notice, bool clearNotice = false}) =>
      PurchaseState(
        phase: phase ?? this.phase,
        productId: phase == PurchasePhase.idle ? null : (productId ?? this.productId),
        notice: clearNotice ? null : (notice ?? this.notice),
      );
}

/// Copy for the purchase flow. Simple English, one place.
abstract final class PurchaseCopy {
  static const String pending = "Payment pending. We'll add your tokens when Google confirms it.";
  static const String cancelled = 'Purchase cancelled. You were not charged.';
  static const String alreadyAdded = 'These tokens were already added to your wallet.';
  static const String tokensAdded = 'Tokens added to your wallet.';
  static const String stillConfirming =
      "We're still confirming your payment. Your tokens will be added automatically. Open this screen again in a few minutes.";
  static const String paymentCanceled = 'This payment was cancelled, so no tokens were added.';
  static const String refunded = 'Google refunded this payment, so no tokens were added.';
  static const String playFailed = 'Google Play could not complete this purchase. Please try again.';
  static const String playClosed = 'Google Play could not open. Please try again.';
  static const String notAvailable = 'Buying tokens is not available right now. Please try again soon.';
  static const String packMissing = 'This pack is not available on Google Play yet.';
  static const String otherAccount = 'This purchase was made with a different account, so we cannot add it here.';

  static String added(num? tokens) => tokens == null ? tokensAdded : '${tokensPlain(tokens)} added';
}

/// Buying tokens with Google Play Billing, and finishing purchases that were never finished.
///
/// The contract (Specs/HF-PLAY-BILLING-RUNBOOK.md section 4):
///  1. `prepare {productId}` -> `obfuscatedAccountId`.
///  2. "Are you sure?" when the pack price is at or above `confirmAbovePaise`.
///  3. Open the Play sheet with that account id.
///  4. On `purchased` (or pending) -> `verify {productId, purchaseToken}`. Idempotent: the same token again is
///     `duplicate`, never a second credit.
///  5. The device never acknowledges or consumes: the server does both. So `completePurchase` is never
///     called, and a purchase whose verify did not get through stays listed by Play until it does.
///  6. Recovery: on start (signed in) and on every app resume, Play is asked for purchases it still lists
///     and each one goes through step 4 again.
class PurchaseController extends Notifier<PurchaseState> {
  StreamSubscription<StorePurchase>? _sub;
  _ResumeObserver? _observer;
  final Set<String> _inFlight = <String>{};
  final Set<String> _done = <String>{};
  final Set<String> _announcedPending = <String>{};
  int _seq = 0;

  @override
  PurchaseState build() {
    ref.onDispose(_stop);
    return const PurchaseState();
  }

  void _stop() {
    _sub?.cancel();
    _sub = null;
    final o = _observer;
    if (o != null) {
      try {
        WidgetsBinding.instance.removeObserver(o);
      } catch (_) {
        // no binding: nothing to remove
      }
      _observer = null;
    }
  }

  /// Starts listening to Play's purchase stream. Safe to call many times.
  void start() {
    if (_sub != null) return;
    try {
      _sub = ref.read(billingAdapterProvider).purchases.listen(_onPurchase, onError: (Object _) {});
    } catch (_) {
      // Billing not available on this device: nothing to listen to.
    }
    if (_observer == null) {
      final o = _ResumeObserver(_onResume);
      try {
        WidgetsBinding.instance.addObserver(o);
        _observer = o;
      } catch (_) {
        // no binding (pure unit test): resume recovery is simply off
      }
    }
  }

  void _onResume() {
    if (!ref.read(sessionProvider).isSignedIn) return;
    unawaited(recover());
  }

  /// Asks Play for purchases it still lists (owned and not consumed, or pending). Each one arrives on the
  /// stream and is verified. Safe to call often: a token being verified, or already done, is skipped.
  Future<void> recover() async {
    start();
    try {
      await ref.read(billingAdapterProvider).recover();
    } catch (_) {
      // Play not reachable: the next start or resume tries again.
    }
  }

  void dismissNotice() {
    state = state.copyWith(clearNotice: true);
  }

  PurchaseNotice _notice(NoticeKind kind, String message) => PurchaseNotice(id: ++_seq, kind: kind, message: message);

  void _finish(PurchaseNotice? notice) {
    state = PurchaseState(phase: PurchasePhase.idle, notice: notice ?? state.notice);
  }

  void _result(String status, {String? productId, String? reason, bool recovery = false, Map<String, Object>? extra}) {
    unawaited(Analytics.capture('hf_app_purchase_result', {
      'status': status,
      if (productId != null && productId.isNotEmpty) 'product_id': productId,
      if (reason != null) 'reason': reason,
      'source': recovery ? 'recovery' : 'buy',
      ...?extra,
    }));
  }

  /// The whole buy flow for one pack. [confirm] shows "Are you sure?" and answers yes or no; it is asked
  /// only when the pack price is at or above the server's `confirmAbovePaise`.
  Future<void> buy(
    PackOffer offer, {
    required Future<bool> Function(PreparedPurchase prepared, int? pricePaise) confirm,
  }) async {
    if (state.busy) return;
    final store = offer.store;
    final productId = offer.productId;
    if (store == null) {
      state = state.copyWith(notice: _notice(NoticeKind.error, PurchaseCopy.packMissing));
      return;
    }
    start();
    state = PurchaseState(phase: PurchasePhase.preparing, productId: productId);

    final PreparedPurchase prepared;
    try {
      prepared = await ref.read(walletApiProvider).prepare(productId);
    } on ApiError catch (e) {
      _prepareFailed(e, productId);
      return;
    } catch (_) {
      _finish(_notice(NoticeKind.error, ApiError.fallbackMessageFor('bad_response', 0)));
      _result('failed', productId: productId, reason: 'prepare');
      return;
    }
    if (prepared.obfuscatedAccountId.isEmpty) {
      _finish(_notice(NoticeKind.error, PurchaseCopy.notAvailable));
      _result('failed', productId: productId, reason: 'no_account_id');
      return;
    }

    final price = packPricePaise(offer);
    final needsConfirm = prepared.confirmAbovePaise > 0 && (price == null || price >= prepared.confirmAbovePaise);
    if (needsConfirm && !await confirm(prepared, price)) {
      _finish(null);
      _result('user_cancelled', productId: productId, reason: 'not_confirmed');
      return;
    }

    unawaited(Analytics.capture('hf_token_purchase_started', {'product_id': productId, 'tokens': offer.pack.tokens}));
    state = PurchaseState(phase: PurchasePhase.awaitingSheet, productId: productId, notice: state.notice);
    final bool opened;
    try {
      opened = await ref.read(billingAdapterProvider).buy(store, obfuscatedAccountId: prepared.obfuscatedAccountId);
    } catch (_) {
      _finish(_notice(NoticeKind.error, PurchaseCopy.playClosed));
      _result('failed', productId: productId, reason: 'launch');
      return;
    }
    if (!opened) {
      _finish(_notice(NoticeKind.error, PurchaseCopy.playClosed));
      _result('failed', productId: productId, reason: 'launch');
    }
    // Otherwise the outcome arrives on the purchase stream.
  }

  void _prepareFailed(ApiError e, String productId) {
    final off = e.status == 503 && (e.code == 'disabled' || e.code == 'unconfigured') || e.isNotEnabled;
    _finish(_notice(NoticeKind.error, off ? PurchaseCopy.notAvailable : e.userMessage));
    _result('failed', productId: productId, reason: e.code);
  }

  bool _isMine(StorePurchase p) =>
      state.phase != PurchasePhase.idle && (p.productId.isEmpty || p.productId == state.productId);

  void _onPurchase(StorePurchase p) {
    final mine = _isMine(p);
    switch (p.status) {
      case StorePurchaseStatus.canceled:
        if (!mine) return;
        _finish(_notice(NoticeKind.cancelled, PurchaseCopy.cancelled));
        _result('user_cancelled', productId: p.productId, reason: 'play_sheet');
      case StorePurchaseStatus.error:
        _result('failed', productId: p.productId, reason: 'play_error');
        if (!mine) return;
        _finish(_notice(NoticeKind.error, PurchaseCopy.playFailed));
      case StorePurchaseStatus.pending:
      case StorePurchaseStatus.purchased:
        unawaited(_verify(p, mine: mine));
    }
  }

  bool _retryable(ApiError e) {
    if (e.isOffline) return true;
    if (e.status >= 500) return true;
    return e.extra['retry'] == true;
  }

  Future<void> _verify(StorePurchase p, {required bool mine}) async {
    final token = p.purchaseToken;
    if (token.isEmpty || _done.contains(token) || !_inFlight.add(token)) return;
    final recovery = !mine;
    if (mine) state = PurchaseState(phase: PurchasePhase.verifying, productId: p.productId, notice: state.notice);
    try {
      VerifyResult? res;
      ApiError? failure;
      final delays = ref.read(purchaseRetryDelaysProvider);
      for (var i = 0;; i++) {
        try {
          res = await ref.read(walletApiProvider).verify(p.productId, token);
          break;
        } on ApiError catch (e) {
          failure = e;
          if (!_retryable(e) || i >= delays.length) break;
        } catch (_) {
          failure = const ApiError(status: 0, code: ApiError.codeBadResponse);
          if (i >= delays.length) break;
        }
        await Future<void>.delayed(delays[i]);
      }

      if (res == null) {
        _verifyFailed(failure, p, mine: mine);
        return;
      }
      _verified(res, p, mine: mine, recovery: recovery);
    } finally {
      _inFlight.remove(token);
    }
  }

  void _verified(VerifyResult res, StorePurchase p, {required bool mine, required bool recovery}) {
    final token = p.purchaseToken;
    switch (res.status) {
      case VerifyStatus.consumed:
      case VerifyStatus.credited:
        _done.add(token);
        _refreshWallet();
        final announce = !res.duplicate || mine;
        final notice = announce
            ? _notice(NoticeKind.success, res.duplicate ? PurchaseCopy.alreadyAdded : PurchaseCopy.added(res.tokens))
            : null;
        _result(res.duplicate ? 'duplicate' : 'credited',
            productId: p.productId, recovery: recovery, extra: {if (res.tokens != null) 'tokens': res.tokens!});
        if (mine) {
          _finish(notice);
        } else if (notice != null) {
          state = state.copyWith(notice: notice);
        }
      case VerifyStatus.pending:
      case VerifyStatus.unknown:
        // Nothing is credited yet; the purchase stays listed by Play and is verified again on the next start.
        final first = _announcedPending.add(token);
        final notice = (mine || first) ? _notice(NoticeKind.pending, PurchaseCopy.pending) : null;
        _result('pending', productId: p.productId, recovery: recovery);
        if (mine) {
          _finish(notice);
        } else if (notice != null) {
          state = state.copyWith(notice: notice);
        }
      case VerifyStatus.canceled:
      case VerifyStatus.refunded:
        _done.add(token);
        final refunded = res.status == VerifyStatus.refunded;
        _result(refunded ? 'refunded' : 'payment_canceled', productId: p.productId, recovery: recovery);
        if (mine) _finish(_notice(NoticeKind.error, refunded ? PurchaseCopy.refunded : PurchaseCopy.paymentCanceled));
    }
  }

  void _verifyFailed(ApiError? e, StorePurchase p, {required bool mine}) {
    final code = e?.code ?? 'unknown';
    _result('failed', productId: p.productId, reason: code, recovery: !mine);
    final permanent = e != null &&
        !_retryable(e) &&
        (const {'unknown_product', 'invalid_purchase', 'bad_token', 'account_mismatch', 'bad_product'}.contains(code) ||
            (e.status >= 400 && e.status < 500 && !e.isUnauthorized && e.status != 429));
    if (permanent) {
      _done.add(p.purchaseToken); // do not retry a purchase the server will never accept
      if (mine) {
        _finish(_notice(
          NoticeKind.error,
          code == 'account_mismatch' ? PurchaseCopy.otherAccount : e.userMessage,
        ));
      }
      return;
    }
    // Temporary: the purchase stays unconsumed in Play, so the next start or resume verifies it again.
    if (mine) _finish(_notice(NoticeKind.pending, PurchaseCopy.stillConfirming));
  }

  void _refreshWallet() {
    try {
      ref.invalidate(walletProvider);
      ref.invalidate(refundsProvider);
    } catch (_) {
      // nothing is watching
    }
  }
}

class _ResumeObserver with WidgetsBindingObserver {
  _ResumeObserver(this._onResume);

  final VoidCallback _onResume;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _onResume();
  }
}
