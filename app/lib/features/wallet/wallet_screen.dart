import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:web_socket_channel/io.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/db.dart';
import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/wallet_topup_billing.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../payout/payout_screen.dart';
import 'admin_money_screen.dart';
import 'wallet_balance_chip.dart' show WalletBalanceStore;

/// Inline dark v2 header band (replaces the light ZineAppBar): header/footer
/// surface, hairline bottom border, back button + Nunito title + optional tag.
PreferredSizeWidget _darkHeader({
  required String title,
  String? tag,
  List<Widget> actions = const [],
  bool showBack = true,
}) {
  return PreferredSize(
    preferredSize: Size.fromHeight(tag == null ? 76 : 92),
    child: Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          child: Row(children: [
            if (showBack) ...[
              const AdBackButton(),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis),
                  if (tag != null) ...[
                    const SizedBox(height: 2),
                    Text(tag.toUpperCase(), style: ADText.sectionLabel()),
                  ],
                ],
              ),
            ),
            ...actions,
          ]),
        ),
      ),
    ),
  );
}

// ── AvaWallet (Phase 2) ───────────────────────────────────────────────────────
// Balance cards + the double-entry ledger trail: infinite scroll on the server's
// keyset cursor, server-side filters (type chips / date range / search), row
// detail sheet with the fee breakdown, and the Stripe top-up flow. Local-first:
// the drift wallet_ledger_cache (per-account DB file) paints instantly, then the
// network refresh merges in.

final _kTypes = <String, ({String label, IconData icon, bool inflow})>{
  'topup': (label: 'Top-up', icon: PhosphorIcons.creditCard(PhosphorIconsStyle.bold), inflow: true),
  'purchase_hold': (label: 'Purchase', icon: PhosphorIcons.shoppingBag(PhosphorIconsStyle.bold), inflow: false),
  'escrow_release': (label: 'Earning', icon: PhosphorIcons.medal(PhosphorIconsStyle.bold), inflow: true),
  'refund': (label: 'Refund', icon: PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), inflow: true),
  'fee': (label: 'Fee', icon: PhosphorIcons.percent(PhosphorIconsStyle.bold), inflow: false),
  'payout': (label: 'Payout', icon: PhosphorIcons.bank(PhosphorIconsStyle.bold), inflow: false),
  'donation': (label: 'Donation', icon: PhosphorIcons.heart(PhosphorIconsStyle.bold), inflow: false),
  'storage_charge': (label: 'Storage', icon: PhosphorIcons.cloud(PhosphorIconsStyle.bold), inflow: false),
  'adjustment': (label: 'Adjustment', icon: PhosphorIcons.wrench(PhosphorIconsStyle.bold), inflow: true),
};

// Coin economics — CANONICAL, MUST match the server (worker/src/routes/wallet.ts
// COINS_PER_USD) and AvaPayout. 1 USD = 100 Tokens (1 coin = $0.01). Balances/
// ledger amounts are in coins; USD is derived for display only.
const int kCoinsPerUsd = 100;

/// Withdraw/payout is hidden until the marketplace + payout flow ships. Flip to
/// true to bring the Withdraw button back on the wallet hero card.
const bool _kShowWithdraw = false;

/// The Stripe publishable key we've already pushed into the SDK this run (set from
/// the server's intent response). Tracked so we don't read Stripe.publishableKey
/// before it's initialized.
String? _appliedPublishableKey;

/// Format USD from real cents — used ONLY in a top-up's detail row ("Amount
/// paid … USD"). USD must never appear anywhere else on the wallet; the wallet's
/// native unit is Tokens.
String _usdFromCents(int cents) => '\$${(cents.abs() / 100).toStringAsFixed(2)}';

/// Compact coin count, e.g. 10000 → "10,000".
String _coins(num coins) {
  final s = coins.abs().toInt().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

String _dateShort(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${d.day} ${m[d.month - 1]} ${d.year != DateTime.now().year ? d.year : ''}'.trim();
}

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});
  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  int _balance = 0, _held = 0;
  final List<Map<String, dynamic>> _entries = [];
  String? _cursor;
  bool _loading = false, _exhausted = false, _admin = false;

  // [WALLET-COCKPIT-1] Cockpit aggregates from /api/wallet/summary: earned/spent
  // totals, per-feature breakdown, burn/day, runway, AI minutes. Null until the
  // first load lands (instruments render "—" placeholders meanwhile).
  Map<String, dynamic>? _summary;

  // Filters (server-side). Direction is single-select against the statement feed.
  String? _dirFilter;
  DateTimeRange? _range;
  String _query = '';
  final _searchCtrl = TextEditingController();
  final _scroll = ScrollController();

  // [WALLET-LIVE-1] Realtime balance + statement over the wallet DO's WebSocket
  // (/api/wallet/live pushes {type:"balance", spendable,...} on EVERY change — a
  // receptionist charge, top-up, refund). Without this the balance only moved on
  // reopen/re-login and a new debit never appeared until a manual refresh.
  IOWebSocketChannel? _liveWs;
  StreamSubscription<dynamic>? _liveSub;
  Timer? _liveRetry;
  bool _disposed = false;

  bool get _filtered => _dirFilter != null || _range != null || _query.isNotEmpty;

  Future<void> _startLive() async {
    if (_disposed) return;
    try {
      final b = await ApiAuth.clerkBearer?.call();
      if (b == null || b.isEmpty) { _scheduleLiveRetry(); return; }
      final uri = Uri.parse('wss://$kSignalingHost/api/wallet/live');
      final ch = IOWebSocketChannel.connect(uri, headers: {'Authorization': 'Bearer $b'});
      _liveWs = ch;
      _liveSub = ch.stream.listen(
        (data) {
          try {
            final m = (jsonDecode(data as String) as Map).cast<String, dynamic>();
            if (m['type'] == 'balance') _onLiveBalance(m);
          } catch (_) {/* ignore malformed frame */}
        },
        onDone: _scheduleLiveRetry,
        onError: (_) => _scheduleLiveRetry(),
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleLiveRetry();
    }
  }

  void _onLiveBalance(Map<String, dynamic> m) {
    if (!mounted) return;
    final spend = ((m['spendable'] ?? m['balance']) as num?)?.toInt();
    if (spend == null) return;
    final changed = spend != _balance;
    setState(() {
      _balance = spend;
      if (m['held'] is num) _held = (m['held'] as num).toInt();
    });
    WalletBalanceStore.set(_balance); // keep the header chip in sync
    // A balance change means a new transaction row landed — pull the fresh
    // statement so the debit/credit appears at the top immediately. Skip while a
    // filter is active so we don't clobber the user's filtered view.
    if (changed && !_filtered && !_loading) _refresh();
  }

  void _scheduleLiveRetry() {
    _liveSub?.cancel(); _liveSub = null;
    try { _liveWs?.sink.close(); } catch (_) {/* ignore */}
    _liveWs = null;
    if (_disposed || !mounted) return;
    _liveRetry?.cancel();
    _liveRetry = Timer(const Duration(seconds: 5), _startLive); // reconnect backoff
  }

  @override
  void initState() {
    super.initState();
    // Tag every event from here as the wallet app/screen so support can slice a
    // user's wallet telemetry (and errors) by email in PostHog.
    Analytics.screenViewed('wallet', 'wallet_main');
    Analytics.capture('wallet_viewed');
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) _loadMore();
    });
    _paintFromCache();
    _refresh();
    _startLive(); // [WALLET-LIVE-1] realtime balance + statement updates
    // [ADMIN-GATE] Reuse the admin flag RemoteConfig already resolved at app start
    // (and re-resolves per account switch) instead of firing a fresh /admin/recon
    // probe on every wallet open. PostHog (7d prod) showed ordinary users' clients
    // hammering /admin/recon with 401/403s; a non-admin's cached flag is false, so
    // this paints the admin-money entry only for the (rare) real admin without a
    // per-open network probe.
    if (RemoteConfig.isAdmin) _admin = true;
    // Bind the native Play Billing purchase stream for wallet top-ups (Android).
    // Credits land server-side; we just refresh the balance + surface a notice.
    if (Platform.isAndroid) {
      WalletTopupBilling.instance.start(
        onNotice: (m) { if (mounted) _snack(m); },
        onCredited: (_) async {
          if (!mounted) return;
          final before = _balance;
          for (var i = 0; i < 6 && mounted && _balance <= before; i++) {
            await Future.delayed(Duration(milliseconds: i == 0 ? 400 : 1000));
            await _refresh();
          }
        },
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _liveRetry?.cancel();
    _liveSub?.cancel();
    try { _liveWs?.sink.close(); } catch (_) {/* ignore */}
    _searchCtrl.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _paintFromCache() async {
    if (_filtered) return; // cache is the unfiltered trail
    try {
      final rows = await Db.I.walletLedgerOnce();
      if (!mounted || rows.isEmpty || _entries.isNotEmpty) return;
      setState(() {
        _entries.addAll(rows.map((r) => (jsonDecode(r.json) as Map).cast<String, dynamic>()));
      });
    } catch (_) {/* cache is best-effort */}
  }

  Future<void> _refresh() async {
    setState(() { _cursor = null; _exhausted = false; });
    final bal = MoneyApi.balance();
    // [WALLET-COCKPIT-1] Refresh the cockpit instruments alongside the statement.
    final sum = MoneyApi.summary(days: 30);
    await _fetchPage(reset: true);
    try {
      final s = await sum;
      if (mounted && s.containsKey('spent_total')) {
        setState(() => _summary = s);
        Analytics.capture('wallet_summary_loaded', {
          'days': s['days'],
          'spent_total_30d': s['spent_total'],
          'earned_total_30d': s['earned_total'],
          'burn_per_day': s['burn_per_day'],
          'runway_days': s['runway_days'],
          'minutes_used': s['minutes_used'],
          'spend_features': (s['by_feature'] as List?)?.length ?? 0,
          'earn_sources': (s['earn_sources'] as List?)?.length ?? 0,
        });
      } else if (mounted) {
        Analytics.capture('wallet_summary_load_failed', {'reason': '${s['error'] ?? s['status'] ?? 'unknown'}'});
      }
    } catch (e) {
      // Instruments keep their last values; email/phone ride the event so support
      // can pull this user's cockpit failures in PostHog.
      Analytics.error(domain: 'wallet', code: 'summary_fetch_error', message: '$e', screen: 'wallet_main', action: 'summary_refresh');
    }
    final b = await bal;
    if (mounted && b['balance'] is num) {
      // [WALLET-UX-1] The hero number is the TOTAL SPENDABLE tokens: paid
      // `balance` + persistent welcome `bonus` + daily free grant. The DO's
      // snap() reports that as `spendable`; binding the paid-only `balance`
      // here is exactly the bug that showed "Balance 0" to a user whose 100
      // welcome-bonus tokens live in the promo bucket. `balance` stays the
      // fallback for an old server response.
      setState(() {
        _balance = (((b['spendable'] ?? b['balance']) as num)).toInt();
        _held = ((b['held'] as num?) ?? 0).toInt();
      });
      WalletBalanceStore.set(_balance); // keep the header chip in sync
      Analytics.capture('wallet_balance_loaded', {
        'balance_coins': _balance, // displayed number = total spendable
        'paid_coins': ((b['balance'] as num?) ?? 0).toInt(),
        'bonus_coins': ((b['bonus'] as num?) ?? 0).toInt(),
        'free_coins': ((b['free'] as num?) ?? 0).toInt(),
        'held_coins': _held,
        'balance_usd_cents': (_balance * 100 / kCoinsPerUsd).round(),
        'entries_loaded': _entries.length,
        'has_ledger': _entries.isNotEmpty,
        'filtered': _filtered,
      });
      // DIAGNOSTIC: a positive PAID balance with an EMPTY (unfiltered) ledger
      // means the user has coins but no transaction history — the exact "no log
      // below my recent transaction" symptom. This usually means the balance was
      // credited outside the queue→wallet_ledger path (seed/admin adjust/
      // DO-only), or the top-up's ledger row never landed. Keyed to the PAID
      // balance (not spendable) so the daily free grant — which legitimately has
      // no statement row — doesn't fire this for every user. email + phone ride
      // every event (see Analytics._base), so support can pull THIS user by
      // email/phone in PostHog and reconcile the missing ledger row.
      final paidCoins = ((b['balance'] as num?) ?? 0).toInt();
      if (paidCoins > 0 && _entries.isEmpty && !_filtered && !_loading) {
        Analytics.capture('wallet_balance_without_ledger', {
          'balance_coins': paidCoins,
          'held_coins': _held,
          'balance_usd_cents': (paidCoins * 100 / kCoinsPerUsd).round(),
        });
      }
    } else if (mounted) {
      Analytics.capture('wallet_balance_load_failed', {'reason': '${b['error'] ?? b['status'] ?? 'unknown'}'});
    }
  }

  Future<void> _loadMore() => _fetchPage();

  Future<void> _fetchPage({bool reset = false}) async {
    if (_loading || (_exhausted && !reset)) return;
    setState(() => _loading = true);
    try {
      // [WALLET-COCKPIT-1] Statement feed: wallet_transactions with human labels
      // + feature keys (what each spend actually paid for), not the raw ledger.
      final r = await MoneyApi.statement(
        cursor: reset ? null : _cursor,
        direction: _dirFilter,
        from: _range?.start.millisecondsSinceEpoch,
        to: _range == null ? null : _range!.end.add(const Duration(days: 1)).millisecondsSinceEpoch,
        q: _query,
      );
      final list = ((r['entries'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
      // The server returns {entries, cursor}; anything else (e.g. {error}) means
      // the ledger read failed even though we didn't throw. Surface it so an empty
      // log is never silently mistaken for "no transactions". email/phone ride
      // the event, so support can pull this user in PostHog.
      final ledgerErr = r['error'] ?? (r.containsKey('entries') ? null : (r['status'] ?? 'no_entries_field'));
      if (!mounted) return;
      setState(() {
        if (reset) _entries.clear();
        _entries.addAll(list);
        _cursor = r['cursor'] as String?;
        _exhausted = _cursor == null;
      });
      if (reset) {
        Analytics.capture('wallet_ledger_loaded', {
          'count': list.length,
          'exhausted': _exhausted,
          'filtered': _filtered,
          'empty': list.isEmpty,
          if (ledgerErr != null) 'ledger_error': '$ledgerErr',
        });
        if (ledgerErr != null) {
          Analytics.error(
            domain: 'wallet', code: 'ledger_load_failed',
            message: '$ledgerErr', screen: 'wallet_main', action: 'ledger_refresh',
          );
        }
      } else {
        Analytics.capture('wallet_ledger_more', {
          'added': list.length, 'total': _entries.length, 'exhausted': _exhausted,
        });
      }
      // Local-first: merge the unfiltered head page into the per-account cache.
      if (!_filtered) {
        await Db.I.upsertWalletLedger([
          for (final e in list)
            (id: '${e['id']}', createdAt: (((e['ts'] ?? e['created_at']) as num?) ?? 0).toInt(), type: '${e['type']}', json: jsonEncode(e)),
        ]);
      }
    } catch (e) {
      // Offline / network error → on-device cache stays painted. Still report it
      // (email/phone attached) so a chronically empty log is diagnosable.
      Analytics.error(
        domain: 'wallet', code: 'ledger_fetch_error',
        message: '$e', screen: 'wallet_main', action: reset ? 'ledger_refresh' : 'ledger_more',
      );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // This-month in/out from the loaded trail (signed amounts from the server).
  (int, int) _monthInOut() {
    final now = DateTime.now();
    final lo = DateTime(now.year, now.month).millisecondsSinceEpoch;
    var inn = 0, out = 0;
    for (final e in _entries) {
      if (((e['created_at'] as num?) ?? 0) < lo) continue;
      final a = ((e['amount'] as num?) ?? 0).toInt();
      if (a >= 0) { inn += a; } else { out += -a; }
    }
    return (inn, out);
  }

  // ── top-up (in-app, native Stripe PaymentSheet — NO browser redirect) ──────
  // Flow: fetch the region-aware quote → ask amount in the user's top-up
  // currency → server mints a PaymentIntent → present the native sheet
  // (card / Apple Pay / Google Pay) right here → poll the balance so the topped-up
  // coins + the new ledger entry land on this same page. Coins are credited
  // server-side ONLY (Stripe webhook); the client never moves money itself.
  //
  // [TOKENS-FX-1] Region-aware: /api/wallet/topup-quote decides the currency —
  // India tops up in INR at the FIXED price 1 Token = ₹1 (min ₹100); everyone
  // else in USD (1 USD = 100 Tokens, min $1). The server converts money→Tokens.
  Future<void> _topupFlow() async {
    Map<String, dynamic> quote = const {};
    try {
      quote = await MoneyApi.topupQuote();
    } catch (e) {
      // Offline/failed quote → the sheet falls back to canonical USD pricing.
      Analytics.error(domain: 'wallet', code: 'topup_quote_failed', message: '$e', screen: 'wallet_main', action: 'topup');
    }
    if (!mounted) return;
    final inr = quote['currency'] == 'INR';
    final currency = inr ? 'inr' : 'usd';
    final tokensPerUnit = ((quote['tokens_per_unit'] as num?) ?? (inr ? 1 : kCoinsPerUsd)).toInt();
    final cents = await _askAmountMinor(quote); // minor units of `currency`
    if (cents == null || !mounted) return;
    final coins = (cents * tokensPerUnit / 100).round();
    Analytics.capture('wallet_topup_started', {'cents': cents, 'coins': coins, 'currency': currency, 'method': 'payment_sheet'});

    // 1) Server creates the PaymentIntent and returns the client secret + the
    //    publishable key (so the app never hardcodes a Stripe key).
    Map<String, dynamic> r;
    try {
      r = await MoneyApi.topupIntent(cents, currency: currency);
    } catch (e) {
      Analytics.error(domain: 'wallet', code: 'topup_intent_failed', message: '$e', screen: 'wallet_main', action: 'topup');
      _snack('Could not start checkout. Please try again.');
      return;
    }
    if (!mounted) return;
    final clientSecret = r['payment_intent_client_secret'] as String?;
    final pk = r['publishable_key'] as String?;
    if (clientSecret == null || clientSecret.isEmpty) {
      Analytics.capture('wallet_topup_failed', {
        'stage': 'intent',
        'reason': '${r['reason'] ?? r['error'] ?? r['status'] ?? 'unknown'}',
      });
      if (r['reason'] == 'pending_legal_approval') {
        _snack('Top-ups are not live yet — coming soon.');
      } else if (r['status'] == 429) {
        _snack('Too many top-up attempts. Try again in a little while.');
      } else {
        _snack('Top-up failed: ${r['error'] ?? 'unknown error'}');
      }
      return;
    }

    // 2) Present the native PaymentSheet in-app (no browser).
    try {
      // Set the publishable key from the server response (avoids hardcoding it).
      // Guard with a module flag — reading Stripe.publishableKey before it's set
      // can throw, so we never read it back.
      if (pk != null && pk.isNotEmpty && _appliedPublishableKey != pk) {
        Stripe.publishableKey = pk;
        await Stripe.instance.applySettings();
        _appliedPublishableKey = pk;
      }
      await Stripe.instance.initPaymentSheet(
        paymentSheetParameters: SetupPaymentSheetParameters(
          paymentIntentClientSecret: clientSecret,
          merchantDisplayName: 'AvaTOK',
          applePay: const PaymentSheetApplePay(merchantCountryCode: 'US'),
          googlePay: const PaymentSheetGooglePay(merchantCountryCode: 'US', testEnv: true),
          style: ThemeMode.light,
        ),
      );
      Analytics.capture('wallet_topup_sheet_presented', {'cents': cents, 'coins': coins});
      await Stripe.instance.presentPaymentSheet();
    } on StripeException catch (e) {
      if (e.error.code == FailureCode.Canceled) {
        Analytics.capture('wallet_topup_cancelled', {'cents': cents, 'coins': coins});
        return; // user backed out — no error, no noise
      }
      Analytics.error(
        domain: 'wallet', code: 'payment_sheet_failed',
        message: e.error.localizedMessage ?? e.error.code.name,
        screen: 'wallet_main', action: 'topup', extra: {'stripe_code': e.error.code.name},
      );
      _snack(e.error.localizedMessage ?? 'Payment failed. Please try again.');
      return;
    } catch (e) {
      Analytics.error(domain: 'wallet', code: 'payment_sheet_error', message: '$e', screen: 'wallet_main', action: 'topup');
      _snack('Payment failed. Please try again.');
      return;
    }

    // 3) Paid in-app. The webhook credits coins server-side (a few seconds); poll
    //    the balance so the user sees it land + the new log entry, without leaving.
    if (!mounted) return;
    Analytics.capture('wallet_topup_paid', {'cents': cents, 'coins': coins});
    final before = _balance;
    var credited = false;
    for (var i = 0; i < 6 && mounted && !credited; i++) {
      await Future.delayed(Duration(milliseconds: i == 0 ? 600 : 1200));
      await _refresh();
      if (_balance > before) credited = true;
    }
    if (!mounted) return;
    if (credited) {
      final added = _balance - before;
      Analytics.capture('wallet_topup_succeeded', {'cents': cents, 'coins': added});
      _snack('Added ${_coins(added)} Tokens to your wallet');
    } else {
      // Payment captured but the webhook is still settling — reassure, don't alarm.
      Analytics.capture('wallet_topup_pending_credit', {'cents': cents, 'coins': coins});
      _snack('Payment received — your Tokens will appear here shortly.');
    }
  }

  /// [TOKENS-FX-1] Amount sheet driven by the /api/wallet/topup-quote response:
  /// currency-correct presets (₹100/₹200/₹500/₹1000 for India, $1/$2/$5/$10
  /// elsewhere) each showing "= N Tokens", a custom amount field validating the
  /// quote's minimum, and clear rate copy ("1 Token = ₹1" / "1 USD = 100
  /// Tokens"). Returns the amount in MINOR units (cents/paise), or null if
  /// cancelled. Falls back to canonical USD if the quote didn't load.
  Future<int?> _askAmountMinor(Map<String, dynamic> quote) async {
    final inr = quote['currency'] == 'INR';
    final sym = inr ? '₹' : '\$';
    final tokensPerUnit = ((quote['tokens_per_unit'] as num?) ?? (inr ? 1 : kCoinsPerUsd)).toInt();
    final minUnits = ((quote['min_amount'] as num?) ?? (inr ? 100 : 1)).toInt();
    final maxUnits = inr ? 50000 : 500; // both = 50,000 tokens (server MAX_TOPUP)
    final qPresets = [
      for (final p in (quote['presets'] as List?) ?? const [])
        if (p is Map && p['amount'] is num) (p['amount'] as num).toInt(),
    ];
    final presets = qPresets.isNotEmpty ? qPresets : (inr ? const [100, 200, 500, 1000] : const [1, 2, 5, 10]);
    final rateCopy = inr ? '1 Token = ${sym}1' : '1 USD = ${_coins(kCoinsPerUsd)} Tokens';
    final ctrl = TextEditingController();
    return showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (c) => StatefulBuilder(
        builder: (c, setSheet) {
          final d = double.tryParse(ctrl.text.trim());
          final valid = d != null && d >= minUnits && d <= maxUnits;
          final previewCoins = valid ? (d * tokensPerUnit).round() : 0;
          return Padding(
            padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(c).viewInsets.bottom + 20),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Top up wallet', style: ADText.appTitle()),
              const SizedBox(height: 4),
              Text('Pay securely in-app. $rateCopy. Minimum $sym$minUnits.', style: ADText.preview()),
              const SizedBox(height: 16),
              AdField(
                controller: ctrl,
                autofocus: true,
                leadText: sym,
                hint: inr ? '100' : '1.00',
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                onChanged: (_) => setSheet(() {}),
              ),
              const SizedBox(height: 8),
              Text(
                valid ? '= ${_coins(previewCoins)} Tokens' : 'Enter $sym$minUnits – $sym${_coins(maxUnits)}',
                style: ADText.rowName(c: valid ? AD.online : AD.textTertiary),
              ),
              const SizedBox(height: 12),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final v in presets)
                  AdSticker('$sym$v · ${_coins(v * tokensPerUnit)} Tokens', onTap: () {
                    Analytics.capture('wallet_topup_preset', {'amount': v, 'currency': inr ? 'inr' : 'usd', 'tokens': v * tokensPerUnit});
                    setSheet(() => ctrl.text = inr ? '$v' : v.toStringAsFixed(2));
                  }),
              ]),
              const SizedBox(height: 18),
              AdButton(
                label: 'Continue to payment',
                fullWidth: true,
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                onPressed: !valid ? null : () => Navigator.pop(c, (d * 100).round()),
              ),
            ]),
          );
        },
      ),
    );
  }

  // ── top-up (Android — native Google Play Billing) ─────────────────────────
  // Google requires in-app digital top-ups to go through Play Billing, which only
  // sells FIXED-PRICE products — so we present tiered USD buttons ($5..$100), each
  // mapped to an `avatok_topup_*` consumable. Tapping one launches the native Play
  // sheet; the purchase lands on the stream bound in initState, is verified +
  // credited server-side, and the balance refreshes here. No browser, no cards
  // handled by us.
  Future<void> _playTopupFlow() async {
    Analytics.capture('wallet_topup_opened', {'method': 'play_billing'});
    // [TOKENS-FX-1] The quote is INFORMATIONAL on Android: the Play rail only
    // sells fixed USD-defined `avatok_topup_*` products and Google converts to
    // the local currency at Play's own rate, so India's fixed ₹1/Token pricing
    // cannot apply here until INR-priced Play products exist (deferred). We
    // still fetch the quote so an Indian user sees honest copy about that.
    String? regionNote;
    try {
      final q = await MoneyApi.topupQuote();
      if (q['currency'] == 'INR') {
        regionNote = '₹ pricing (1 Token = ₹1) is coming to Google Play — for now these '
            'tiers are charged at Google Play\'s local rate.';
      }
    } catch (_) {/* note is optional */}
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(c).viewInsets.bottom + 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Top up wallet', style: ADText.appTitle()),
          const SizedBox(height: 4),
          Text('Pay securely with Google Play. \$1 = ${_coins(kCoinsPerUsd)} Tokens.', style: ADText.preview()),
          const SizedBox(height: 16),
          for (final t in kTopupTiers) ...[
            AdButton(
              label: '\$${t.usd}   ·   ${_coins(t.tokens)} Tokens',
              fullWidth: true,
              trailingIcon: false,
              icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
              onPressed: () {
                Analytics.capture('wallet_topup_tier_selected', {'usd': t.usd, 'tokens': t.tokens, 'product': t.productId});
                Navigator.pop(c);
                WalletTopupBilling.instance.buy(t.productId);
              },
            ),
            const SizedBox(height: 10),
          ],
          const SizedBox(height: 4),
          Text(regionNote ?? 'Charged in your local currency at Google Play’s rate.',
              style: ADText.preview(c: AD.textTertiary)),
        ]),
      ),
    );
  }

  void _snack(String m) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  // ── filters ─────────────────────────────────────────────────────────────
  void _applyFilters() {
    Analytics.capture('wallet_filter_used', {
      'direction': _dirFilter ?? '', 'range': _range != null, 'q': _query.isNotEmpty,
    });
    _fetchPage(reset: true);
  }

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final r = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 3),
      lastDate: now,
      initialDateRange: _range,
    );
    if (r != null || _range != null) {
      setState(() => _range = r ?? _range);
      if (r != null) _applyFilters();
    }
  }

  // ── detail sheet ────────────────────────────────────────────────────────
  /// Human label for how a top-up was paid, from the webhook-stamped ledger meta.
  /// Returns e.g. "Visa ···· 4242", "Apple Pay", "Google Pay", or null if unknown.
  static String? _payMethod(Map<String, dynamic> meta) {
    final method = '${meta['method'] ?? ''}';
    final brand = '${meta['card_brand'] ?? ''}';
    final last4 = '${meta['card_last4'] ?? ''}';
    String cap(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
    if (brand.isNotEmpty || method == 'card') {
      final b = brand.isEmpty ? 'Card' : cap(brand);
      return last4.isEmpty ? b : '$b ···· $last4';
    }
    if (method == 'apple_pay') return 'Apple Pay';
    if (method == 'google_pay') return 'Google Pay';
    if (method == 'link') return 'Link';
    if (method.isNotEmpty) return cap(method.replaceAll('_', ' '));
    return null;
  }

  Future<void> _showDetail(Map<String, dynamic> e) async {
    final id = '${e['id']}';
    Analytics.capture('wallet_txn_opened', {'type': '${e['type']}', 'id': id});
    Map<String, dynamic> d = {'entry': e};
    try { d = await MoneyApi.ledgerDetail(id); } catch (_) {/* offline: show row */}
    if (!mounted) return;
    final entry = ((d['entry'] as Map?) ?? e).cast<String, dynamic>();
    final meta = ((entry['meta'] as Map?) ?? const {}).cast<String, dynamic>();
    final related = ((d['related'] as List?) ?? const []).map((x) => (x as Map).cast<String, dynamic>()).toList();
    final amount = ((entry['amount'] as num?) ?? 0).toInt();
    final t = _kTypes['${entry['type']}'];
    final gross = (meta['gross'] as num?)?.toInt();
    final fee = (meta['fee'] as num?)?.toInt() ?? related.where((r) => r['type'] == 'fee').fold<int>(0, (s, r) => s + ((r['amount'] as num?) ?? 0).toInt().abs());
    final net = (meta['net'] as num?)?.toInt();
    final isTopup = '${entry['type']}' == 'topup';
    final usdCents = (meta['cents'] as num?)?.toInt();      // exact USD charged (top-ups)
    final paidWith = _payMethod(meta);                       // card ···4242 / Apple Pay / …
    final createdMs = ((entry['created_at'] as num?) ?? 0).toInt();

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (c) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(
                icon: t?.icon ?? PhosphorIcons.swap(PhosphorIconsStyle.bold),
                color: amount >= 0 ? AD.online : AD.danger,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${entry['title'] ?? t?.label ?? entry['type']}',
                      style: ADText.rowName(), maxLines: 2, overflow: TextOverflow.ellipsis),
                  Text(_fullDate(((entry['created_at'] as num?) ?? 0).toInt()).toUpperCase(),
                      style: ADText.statCaption(c: AD.textTertiary)),
                ]),
              ),
              Text('${amount >= 0 ? '+' : '−'}${_coins(amount)}',
                  style: ADText.appTitle(c: amount >= 0 ? AD.online : AD.danger)),
            ]),
            const SizedBox(height: 16),
            Container(height: 1, color: AD.borderHairline),
            const SizedBox(height: 12),
            _kv('Date', _fullDate(createdMs)),
            if (isTopup && usdCents != null) _kv('Amount paid', '${_usdFromCents(usdCents)} USD'),
            _kv(isTopup ? 'Tokens credited' : 'Tokens', _coins(amount)),
            if (paidWith != null) _kv('Paid with', paidWith)
            else if (isTopup) _kv('Paid with', 'Card'),
            _kv('From', '${entry['debit'] ?? '—'}'),
            _kv('To', '${entry['credit'] ?? '—'}'),
            if (gross != null) _kv('Gross', '${_coins(gross)} Tokens'),
            if (fee > 0) _kv('Platform fee', '− ${_coins(fee)} Tokens'),
            if (net != null) _kv('Net', '${_coins(net)} Tokens'),
            if (meta['reason'] != null) _kv('Reason', '${meta['reason']}'),
            if (entry['ref'] != null) _kv('Reference', '${entry['ref']}'),
            const SizedBox(height: 16),
            AdButton(
              label: 'Email me this receipt',
              variant: AdButtonVariant.ghost,
              fullWidth: true,
              fontSize: 16,
              trailingIcon: false,
              icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
              onPressed: () async {
                final r = await MoneyApi.resendReceipt(id);
                Analytics.capture('wallet_receipt_resent', {'id': id, 'sent': r['sent'] == true});
                if (c.mounted) Navigator.pop(c);
                _snack(r['sent'] == true ? 'Receipt sent to your email.' : 'Could not send the receipt.');
              },
            ),
          ]),
        ),
      ),
    );
  }

  String _fullDate(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String p(int n) => n.toString().padLeft(2, '0');
    return '${_dateShort(ms)} ${d.year == DateTime.now().year ? d.year : ''} · ${p(d.hour)}:${p(d.minute)}'.replaceAll('  ', ' ');
  }

  /// Ledger-style key/value row (§7.10): label + dotted leader + value.
  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Text(k, style: ADText.preview()),
          const SizedBox(width: 6),
          Expanded(
            child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                style: ADText.preview(c: AD.textTertiary)),
          ),
          const SizedBox(width: 6),
          Flexible(child: Text(v, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ADText.rowName())),
        ]),
      );

  // ── build ───────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final (inn, out) = _monthInOut();
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: _darkHeader(
        title: 'AvaWallet',
        // [WALLET-UX-1] Owner decision: no "AvaCoins" branding in the UI — the
        // wallet's user-facing unit is Tokens (display copy only; code
        // identifiers and storage keys keep their historical names).
        tag: 'your tokens',
        showBack: false,
        actions: [
          if (_admin)
            AdBackButton(
              icon: PhosphorIcons.shieldStar(PhosphorIconsStyle.bold),
              onTap: () {
                Analytics.capture('wallet_admin_opened');
                Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AdminMoneyScreen()));
              },
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () { Analytics.capture('wallet_pull_refresh'); return _refresh(); },
        color: AD.iconSearch,
        child: CustomScrollView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(child: _header(inn, out)),
            // [WALLET-COCKPIT-1] Middle cockpit panel: where the tokens went +
            // what the user earned, per feature, over the summary window.
            SliverToBoxAdapter(child: _breakdown()),
            SliverToBoxAdapter(child: _filterBar()),
            if (_entries.isEmpty && !_loading)
              SliverFillRemaining(
                hasScrollBody: false,
                child: Center(
                  child: _emptyState(
                    PhosphorIcons.receipt(PhosphorIconsStyle.bold),
                    'No transactions yet — top up to get rolling.',
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(18, 4, 18, 24),
                sliver: SliverList.separated(
                  itemCount: _entries.length + (_exhausted ? 0 : 1),
                  separatorBuilder: (_, __) => const SizedBox(height: 2),
                  itemBuilder: (c, i) {
                    if (i >= _entries.length) {
                      _loadMore();
                      return const Padding(
                          padding: EdgeInsets.all(16),
                          child: Center(child: SizedBox(width: 20, height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch))));
                    }
                    return _safeRow(_entries[i]);
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Dark v2 empty state (dashed glyph tile + one reassuring line).
  Widget _emptyState(IconData icon, String text) => Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 64, height: 64,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AD.rListCard),
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Icon(icon, size: 30, color: AD.textTertiary),
        ),
        const SizedBox(height: 12),
        Text(text, style: ADText.preview(), textAlign: TextAlign.center),
      ]);

  Widget _header(int inn, int out) {
    // [WALLET-COCKPIT-1] Instrument values from the summary; the loaded-trail
    // month in/out (inn/out) is the offline fallback until the summary lands.
    final s = _summary;
    final days = ((s?['days'] as num?) ?? 30).toInt();
    final earned = ((s?['earned_total'] as num?) ?? inn).toInt();
    final spent = ((s?['spent_total'] as num?) ?? out).toInt();
    final net = ((s?['net'] as num?) ?? (earned - spent)).toInt();
    final burn = ((s?['burn_per_day'] as num?) ?? 0).toDouble();
    final runwayN = s?['runway_days'] as num?;
    final minutes = ((s?['minutes_used'] as num?) ?? 0).toInt();
    final spendable = ((s?['spendable'] as num?) ?? _balance).toInt();
    // Burn gauge: share of the runway already consumed this window.
    final burnFraction = (spent + spendable) > 0 ? spent / (spent + spendable) : 0.0;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 4),
      child: Column(children: [
        // Hero balance — vivid green money card (kept as a colored hero surface
        // with dark-legible ink on the dark v2 skin).
        AdCard(
          color: AD.online,
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Container(
                width: 34, height: 34,
                decoration: BoxDecoration(
                  color: AD.bg,
                  borderRadius: BorderRadius.circular(AD.rBadge),
                ),
                child: Icon(PhosphorIcons.wallet(PhosphorIconsStyle.bold), size: 18, color: AD.online),
              ),
              const SizedBox(width: 11),
              Expanded(child: Text('Balance', style: ADText.threadName(c: AD.textOnInput))),
              Text('TOKENS', style: ADText.statCaption(c: AD.textOnInput)),
            ]),
            const SizedBox(height: 14),
            // Hero is the Token count — coins are the wallet's native unit.
            // USD never shows on the wallet face; it only appears inside a
            // top-up's detail row ("Amount paid … USD").
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(_coins(_balance), style: ADText.appTitle(c: AD.textOnInput)),
            ),
            const SizedBox(height: 4),
            Text(
              'Tokens${_held > 0 ? '  ·  ${_coins(_held)} pending (7-day hold)' : ''}',
              style: ADText.rowName(c: AD.textOnInput),
            ),
            const SizedBox(height: 16),
            // Withdraw/payout is HIDDEN for now — no marketplace/payout flow yet.
            // Flip _kShowWithdraw back to true to restore the two-button row.
            // Android tops up via native Google Play Billing (fixed-price tiers),
            // independent of billingEnabled (that gates subscription paywalls). The
            // server-side playTopupEnabled flag + Play service account are the real
            // gate. Non-Android falls back to the Stripe rail, still hidden while
            // billing is off (everything free).
            if (!Platform.isAndroid && !RemoteConfig.billingEnabled)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: AD.bg,
                  borderRadius: BorderRadius.circular(AD.rStatCard),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: Text('Everything is free right now — no top-ups needed.',
                    style: ADText.rowName(c: AD.online)),
              )
            else
            Row(children: [
              Expanded(
                child: AdButton(
                  label: 'Top up',
                  fontSize: 17,
                  trailingIcon: false,
                  icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
                  onPressed: Platform.isAndroid ? _playTopupFlow : _topupFlow,
                ),
              ),
              if (_kShowWithdraw) ...[
                const SizedBox(width: 10),
                Expanded(
                  child: AdButton(
                    label: 'Withdraw',
                    variant: AdButtonVariant.teal,
                    fontSize: 17,
                    trailingIcon: false,
                    icon: PhosphorIcons.bank(PhosphorIconsStyle.bold),
                    onPressed: () {
                      Analytics.capture('wallet_withdraw_opened', {'balance_coins': _balance});
                      Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PayoutScreen()));
                    },
                  ),
                ),
              ],
            ]),
          ]),
        ),
        const SizedBox(height: 14),
        // ── [WALLET-COCKPIT-1] Instrument row: burn gauge · runway · net delta ──
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(child: _instrument(
            'Burn/day',
            s == null ? '—' : _rate(burn),
            PhosphorIcons.gauge(PhosphorIconsStyle.bold),
            AD.danger,
            fraction: s == null ? null : burnFraction,
          )),
          const SizedBox(width: 10),
          Expanded(child: _instrument(
            'Runway',
            s == null ? '—' : (runwayN == null ? '∞' : '~${runwayN.toInt()}d'),
            PhosphorIcons.hourglass(PhosphorIconsStyle.bold),
            AD.iconSearch,
          )),
          const SizedBox(width: 10),
          Expanded(child: _instrument(
            'Net ${days}d',
            s == null ? '—' : '${net >= 0 ? '+' : '−'}${_coins(net)}',
            PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
            net >= 0 ? AD.online : AD.danger,
          )),
        ]),
        const SizedBox(height: 10),
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(child: _miniCard('${days}d earned', '+${_coins(earned)}',
              PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold), AD.online, AD.online)),
          const SizedBox(width: 10),
          Expanded(child: _miniCard('${days}d spent', '−${_coins(spent)}',
              PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), AD.danger, AD.danger)),
          const SizedBox(width: 10),
          Expanded(child: _miniCard('AI minutes', s == null ? '—' : '$minutes m',
              PhosphorIcons.timer(PhosphorIconsStyle.bold), AD.iconSearch, AD.textPrimary)),
        ]),
      ]),
    );
  }

  /// Compact rate readout for the burn instrument (tokens/day).
  String _rate(double v) {
    if (v <= 0) return '0';
    if (v >= 100) return _coins(v.round());
    return v == v.roundToDouble() ? '${v.round()}' : v.toStringAsFixed(1);
  }

  /// [WALLET-COCKPIT-1] Instrument card: caption + big readout + optional gauge
  /// bar (fraction 0..1). Same visual family as [_miniCard], denser.
  Widget _instrument(String caption, String value, IconData icon, Color accent, {double? fraction}) => AdCard(
        radius: AD.rStatCard,
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(icon, size: 14, color: accent),
            const SizedBox(width: 5),
            Expanded(
              child: Text(caption.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.statCaption()),
            ),
          ]),
          const SizedBox(height: 8),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value, style: ADText.appTitle(c: accent)),
          ),
          if (fraction != null) ...[
            const SizedBox(height: 8),
            _bar(fraction, accent),
          ],
        ]),
      );

  /// Thin horizontal gauge/breakdown bar (fraction of the track, left-aligned).
  Widget _bar(double f, Color c) => ClipRRect(
        borderRadius: BorderRadius.circular(3),
        child: Container(
          height: 5,
          color: AD.bg,
          alignment: Alignment.centerLeft,
          child: FractionallySizedBox(
            widthFactor: f.clamp(0.02, 1.0).toDouble(),
            child: Container(color: c),
          ),
        ),
      );

  /// [WALLET-COCKPIT-1] Per-feature breakdown panel: horizontal spend bars
  /// ("where it went") + earn sources ("what you earned"), from the summary.
  Widget _breakdown() {
    final s = _summary;
    if (s == null) return const SizedBox.shrink();
    final by = ((s['by_feature'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    final earns = ((s['earn_sources'] as List?) ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    final minutes = ((s['minutes_used'] as num?) ?? 0).toInt();
    if (by.isEmpty && earns.isEmpty) return const SizedBox.shrink();
    final days = ((s['days'] as num?) ?? 30).toInt();
    int maxOf(List<Map<String, dynamic>> l) {
      var m = 1;
      for (final e in l) {
        final t = ((e['tokens'] as num?) ?? 0).toInt();
        if (t > m) m = t;
      }
      return m;
    }
    final maxSpend = maxOf(by), maxEarn = maxOf(earns);

    Widget featRow(Map<String, dynamic> f, int maxT, Color c, String sign) {
      final t = ((f['tokens'] as num?) ?? 0).toInt();
      final n = ((f['count'] as num?) ?? 0).toInt();
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text('${f['label'] ?? 'Other'}', maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName()),
            ),
            const SizedBox(width: 8),
            Text('×$n', style: ADText.statCaption()),
            const SizedBox(width: 8),
            Text('$sign${_coins(t)}', style: ADText.rowName(c: c)),
          ]),
          const SizedBox(height: 5),
          _bar(t / maxT, c),
        ]),
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
      child: AdCard(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (by.isNotEmpty) ...[
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.chartBar(PhosphorIconsStyle.bold), color: AD.danger, size: 26),
              const SizedBox(width: 8),
              Text('WHERE IT WENT · $days DAYS', style: ADText.sectionLabel()),
            ]),
            const SizedBox(height: 6),
            for (final f in by) featRow(f, maxSpend, AD.danger, '−'),
          ],
          if (by.isNotEmpty && earns.isNotEmpty) ...[
            const SizedBox(height: 8),
            Container(height: 1, color: AD.borderHairline),
            const SizedBox(height: 10),
          ],
          if (earns.isNotEmpty) ...[
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.medal(PhosphorIconsStyle.bold), color: AD.online, size: 26),
              const SizedBox(width: 8),
              Text('WHAT YOU EARNED · $days DAYS', style: ADText.sectionLabel()),
            ]),
            const SizedBox(height: 6),
            for (final f in earns) featRow(f, maxEarn, AD.online, '+'),
          ],
          if (minutes > 0) ...[
            const SizedBox(height: 6),
            Text('AI RECEPTIONIST · $minutes MIN USED', style: ADText.statCaption()),
            const SizedBox(height: 4),
          ],
        ]),
      ),
    );
  }

  /// Metric card (§7.11): icon badge + Nunito number + caption.
  Widget _miniCard(String label, String value, IconData icon, Color accent, Color valueColor) => AdCard(
        radius: AD.rStatCard,
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: icon, color: accent, size: 30),
          const SizedBox(height: 10),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value, style: ADText.appTitle(c: valueColor)),
          ),
          const SizedBox(height: 3),
          Text(label.toUpperCase(), style: ADText.statCaption()),
        ]),
      );

  Widget _filterBar() {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
        child: AdField(
          controller: _searchCtrl,
          hint: 'Search by reference or feature',
          leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
          trailing: _query.isEmpty
              ? null
              : GestureDetector(
                  onTap: () { _searchCtrl.clear(); setState(() => _query = ''); _applyFilters(); },
                  child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 18, color: AD.textOnInput),
                ),
          onSubmitted: (v) { setState(() => _query = v.trim()); _applyFilters(); },
        ),
      ),
      SizedBox(
        height: 52,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
          children: [
            AdChip(
              label: _range == null
                  ? 'Dates'
                  : '${_dateShort(_range!.start.millisecondsSinceEpoch)} – ${_dateShort(_range!.end.millisecondsSinceEpoch)}',
              active: _range != null,
              onTap: _pickRange,
            ),
            if (_range != null) ...[
              const SizedBox(width: 8),
              AdChip(
                label: 'Clear dates',
                onTap: () { setState(() => _range = null); _applyFilters(); },
              ),
            ],
            const SizedBox(width: 8),
            // [WALLET-COCKPIT-1] Direction chips against the statement feed.
            for (final d in const [('earn', 'Earned'), ('spend', 'Spent'), ('topup', 'Top-ups'), ('payout', 'Payouts'), ('refund', 'Refunds')]) ...[
              AdChip(
                label: d.$2,
                active: _dirFilter == d.$1,
                onTap: () {
                  setState(() => _dirFilter = _dirFilter == d.$1 ? null : d.$1);
                  _applyFilters();
                },
              ),
              const SizedBox(width: 8),
            ],
          ],
        ),
      ),
    ]);
  }

  /// Relative timestamp for the flight log ("2h ago"); falls back to the short
  /// date past a week.
  String _relTime(int ms) {
    if (ms <= 0) return '';
    final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes}m ago';
    if (d.inHours < 24) return '${d.inHours}h ago';
    if (d.inDays < 7) return '${d.inDays}d ago';
    return _dateShort(ms);
  }

  /// [WALLET-COCKPIT-1] Icon per feature key (spends carry the chargeFeature
  /// key in feature_key); direction icon as the fallback.
  IconData _featureIcon(String key, String direction) {
    switch (key) {
      case 'ava_receptionist_call':
      case 'ava_receptionist_minute':
        return PhosphorIcons.phoneCall(PhosphorIconsStyle.bold);
      case 'ava_voicemail':
        return PhosphorIcons.voicemail(PhosphorIconsStyle.bold);
      case 'ava_chat':
        return PhosphorIcons.chatCircleDots(PhosphorIconsStyle.bold);
      case 'ava_memory':
        return PhosphorIcons.brain(PhosphorIconsStyle.bold);
      case 'ava_image_free':
      case 'ava_image_generate':
        return PhosphorIcons.image(PhosphorIconsStyle.bold);
      case 'ava_voice_reply':
        return PhosphorIcons.microphone(PhosphorIconsStyle.bold);
      case 'ava_vision_snapshot':
        return PhosphorIcons.camera(PhosphorIconsStyle.bold);
      case 'ava_mcp_tool':
        return PhosphorIcons.plugsConnected(PhosphorIconsStyle.bold);
      case 'guardian_always_on':
        return PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold);
      case 'listing_post':
      case 'listing_post_connect':
      case 'avaolx':
        return PhosphorIcons.storefront(PhosphorIconsStyle.bold);
      case 'avalive':
        return PhosphorIcons.broadcast(PhosphorIconsStyle.bold);
      case 'translate':
        return PhosphorIcons.translate(PhosphorIconsStyle.bold);
      case 'avapayout':
        return PhosphorIcons.bank(PhosphorIconsStyle.bold);
      // [WALLET-UX-1] Welcome bonus (type=promo, app_name=welcome_bonus).
      case 'welcome_bonus':
        return PhosphorIcons.gift(PhosphorIconsStyle.bold);
    }
    switch (direction) {
      case 'topup':
        return PhosphorIcons.creditCard(PhosphorIconsStyle.bold);
      case 'earn':
        return PhosphorIcons.medal(PhosphorIconsStyle.bold);
      case 'payout':
        return PhosphorIcons.bank(PhosphorIconsStyle.bold);
      case 'refund':
        return PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold);
      case 'spend':
        return PhosphorIcons.lightning(PhosphorIconsStyle.bold);
    }
    return PhosphorIcons.swap(PhosphorIconsStyle.bold);
  }

  /// [WALLET-COCKPIT-1] Statement row — flight-log style: feature icon badge,
  /// human label, relative time, signed tokens (earn green / spend red) and the
  /// running balance when the server stored one. Tolerates both statement rows
  /// (tokens/ts/label) and legacy cached ledger rows (amount/created_at/title).
  // [WALLET-ROW-SAFE-1] A throw inside an item builder renders as a BLANK box in a
  // release build — which looks exactly like "my transactions don't show" even though
  // the rows loaded (telemetry: entries loaded, no error). So build every row behind a
  // guard: on any exception, report it (with the offending fields) AND paint a plain,
  // always-visible fallback row so the transaction is never invisible.
  Widget _safeRow(Map<String, dynamic> e) {
    try {
      return _row(e);
    } catch (err) {
      Analytics.error(
        domain: 'wallet', code: 'row_render_error',
        message: '$err | type=${e['type']} feat=${e['feature_key']} keys=${e.keys.toList()}',
        screen: 'wallet_main', action: 'row_build',
      );
      final tokens = (((e['tokens'] ?? e['amount']) as num?) ?? 0).toInt();
      final positive = tokens >= 0;
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(children: [
          Expanded(
            child: Text('${e['label'] ?? e['type'] ?? 'Transaction'}',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
          ),
          const SizedBox(width: 8),
          Text('${positive ? '+' : '−'}${tokens.abs()}',
              style: ADText.rowName(c: positive ? AD.online : AD.danger)),
        ]),
      );
    }
  }

  Widget _row(Map<String, dynamic> e) {
    final tokens = (((e['tokens'] ?? e['amount']) as num?) ?? 0).toInt();
    final ts = (((e['ts'] ?? e['created_at']) as num?) ?? 0).toInt();
    final dir = '${e['direction'] ?? (tokens >= 0 ? 'earn' : 'spend')}';
    final label = '${e['label'] ?? e['title'] ?? _kTypes['${e['type']}']?.label ?? e['type'] ?? 'Other'}';
    final positive = tokens >= 0;
    final balAfter = (e['balance_after'] as num?)?.toInt();
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _showDetail(<String, dynamic>{
        'id': e['id'], 'type': e['type'], 'amount': tokens, 'created_at': ts,
        'title': label, if (e['ref'] != null) 'ref': e['ref'],
      }),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(children: [
          ZineIconBadge(
            icon: _featureIcon('${e['feature_key'] ?? ''}', dir),
            color: positive ? AD.online : AD.danger,
            size: 34,
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.rowName()),
              const SizedBox(height: 2),
              Text(_relTime(ts).toUpperCase(), style: ADText.statCaption()),
            ]),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('${positive ? '+' : '−'}${_coins(tokens)}',
                style: ADText.rowName(c: positive ? AD.online : AD.danger)),
            if (balAfter != null) ...[
              const SizedBox(height: 2),
              Text('BAL ${_coins(balAfter)}', style: ADText.statCaption()),
            ],
          ]),
        ]),
      ),
    );
  }
}
