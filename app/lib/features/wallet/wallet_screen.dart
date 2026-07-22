import 'dart:async';
import 'dart:convert';
import 'dart:io' show File, Platform;

import 'package:flutter/material.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:web_socket_channel/io.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/db.dart';
import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/wallet_topup_billing.dart';
import '../../core/ui/avatok_dark.dart';
import '../payout/payout_screen.dart';
import 'admin_money_screen.dart';
import 'wallet_balance_chip.dart' show WalletBalanceStore;
import 'wallet_theme.dart';
import 'wallet_widgets.dart';

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

// ── AvaWallet ─────────────────────────────────────────────────────────────────
// [WALLET-REDESIGN-1] The presentation layer is the poster/zine wallet skin
// (`wallet_theme.dart` + `wallet_widgets.dart`): balance hero, period chips,
// money in/out, daily-spend bars, where-it-went donut, day-grouped history with
// search + inline calendar, a full-height transaction detail sheet and a CSV
// export sheet. Data plumbing (live WS balance, drift cache, keyset pagination,
// Stripe / Play Billing top-ups) is unchanged.

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

const List<String> _kMonShort = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const List<String> _kMonLong = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

String _dateShort(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${d.day} ${_kMonShort[d.month - 1]} ${d.year != DateTime.now().year ? d.year : ''}'.trim();
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

  // [WALLET-REDESIGN-1] Summary window driven by the 7D/30D chip track.
  int _days = 30;

  // Filters (server-side). Direction is single-select against the statement feed.
  // null = all, 'in' = money in, 'out' = money out.
  String? _dirFilter;
  DateTimeRange? _range;
  String _query = '';
  final _searchCtrl = TextEditingController();
  final _scroll = ScrollController();

  // [WALLET-REDESIGN-1] Inline day picker state (rendered under the search row).
  DateTime _calMonth = DateTime.now();
  int? _selDay;
  bool _showCal = false;

  // [WALLET-LIVE-1] Realtime balance + statement over the wallet DO's WebSocket
  // (/api/wallet/live pushes {type:"balance", spendable,...} on EVERY change — a
  // receptionist charge, top-up, refund). Without this the balance only moved on
  // reopen/re-login and a new debit never appeared until a manual refresh.
  IOWebSocketChannel? _liveWs;
  StreamSubscription<dynamic>? _liveSub;
  Timer? _liveRetry;
  bool _disposed = false;

  bool get _filtered => _dirFilter != null || _range != null || _query.isNotEmpty;

  /// [WALLET-REDESIGN-1] The statement endpoint now understands coarse `in` /
  /// `out` buckets (in = earn|donation|gift|hold_release|promo|topup|refund,
  /// out = spend|payout), so both chips filter SERVER-side. Filtering "in" on
  /// the client used to break keyset pagination — a page of pure spend rendered
  /// as an empty list until more pages loaded. 'all' sends no filter.
  String? get _serverDirection =>
      (_dirFilter == 'in' || _dirFilter == 'out') ? _dirFilter : null;

  List<Map<String, dynamic>> get _visibleEntries => _entries;

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
    // [WALLET-REDESIGN-1] Post-first-frame render confirmation → lets us verify
    // server-side that the list actually painted N rows (fast troubleshooting).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Analytics.capture('wallet_screen_rendered',
          {'entries': _entries.length, 'balance': _balance, 'loading': _loading});
    });
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
    // [WALLET-REDESIGN-1] The window follows the 7D/30D chips, and the tz offset
    // makes daily_spend buckets line up with the user's local days.
    final sum = MoneyApi.summary(days: _days, tzOffsetMin: DateTime.now().timeZoneOffset.inMinutes);
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
          'daily_points': (s['daily_spend'] as List?)?.length ?? 0,
          'categories': (s['by_category'] as List?)?.length ?? 0,
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
        direction: _serverDirection,
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

  /// Legacy full-range picker. Kept as the fallback date UI (the inline
  /// [WalletCalendar] is the primary path now).
  // ignore: unused_element
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

  String _fullDate(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String p(int n) => n.toString().padLeft(2, '0');
    return '${_dateShort(ms)} ${d.year == DateTime.now().year ? d.year : ''} · ${p(d.hour)}:${p(d.minute)}'.replaceAll('  ', ' ');
  }

  /// Relative timestamp for the flight log ("2h ago"); falls back to the short
  /// date past a week.
  // ignore: unused_element
  String _relTime(int ms) {
    if (ms <= 0) return '';
    final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes}m ago';
    if (d.inHours < 24) return '${d.inHours}h ago';
    if (d.inDays < 7) return '${d.inDays}d ago';
    return _dateShort(ms);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [WALLET-REDESIGN-1] Category helpers — the eight coarse categories the
  // server folds every feature key into (worker/src/routes/wallet_statement.ts
  // CATEGORY_LABELS). Keep the three switches in lockstep.
  // ══════════════════════════════════════════════════════════════════════════

  IconData _catIcon(String key) {
    switch (key) {
      case 'call':
        return PhosphorIcons.phone(PhosphorIconsStyle.fill);
      case 'agent':
        return PhosphorIcons.sparkle(PhosphorIconsStyle.fill);
      case 'transcribe':
        return PhosphorIcons.textAa(PhosphorIconsStyle.fill);
      case 'ava':
        return PhosphorIcons.chatCircle(PhosphorIconsStyle.fill);
      case 'video':
        return PhosphorIcons.videoCamera(PhosphorIconsStyle.fill);
      case 'market':
        return PhosphorIcons.storefront(PhosphorIconsStyle.fill);
      case 'topup':
        return PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold);
      case 'payout':
        return PhosphorIcons.handCoins(PhosphorIconsStyle.fill);
    }
    return PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold);
  }

  Color _catColor(String key) {
    switch (key) {
      case 'call':
        return AW.blue;
      case 'agent':
        return AW.lilac;
      case 'transcribe':
        return AW.mint;
      case 'ava':
        return AW.lilac;
      case 'video':
        return AW.blue;
      case 'market':
        return AW.lime;
      case 'topup':
        return AW.mint;
      case 'payout':
        return AW.mint;
    }
    return AW.mint;
  }

  String _catLabel(String key) {
    switch (key) {
      case 'call':
        return 'Phone call';
      case 'agent':
        return 'AI agent';
      case 'transcribe':
        return 'Transcription';
      case 'ava':
        return 'Ava AI chat';
      case 'video':
        return 'Video call';
      case 'market':
        return 'Marketplace';
      case 'topup':
        return 'Top up';
      case 'payout':
        return 'Affiliate payout';
    }
    return 'Transaction';
  }

  /// Category for a row, tolerating legacy cached rows that predate the
  /// server's `category` field.
  String _catOf(Map<String, dynamic> e) {
    final c = '${e['category'] ?? ''}';
    if (c.isNotEmpty && c != 'null') return c;
    final t = '${e['type'] ?? ''}';
    if (t == 'topup') return 'topup';
    if (t == 'payout') return 'payout';
    return 'agent';
  }

  // ── small formatters ─────────────────────────────────────────────────────

  int _tsOf(Map<String, dynamic> e) => (((e['ts'] ?? e['created_at']) as num?) ?? 0).toInt();

  int _tokensOf(Map<String, dynamic> e) => (((e['tokens'] ?? e['amount']) as num?) ?? 0).toInt();

  String _titleOf(Map<String, dynamic> e) =>
      '${e['label'] ?? e['title'] ?? e['type'] ?? 'Transaction'}';

  /// "2:30 PM" from an epoch-ms timestamp (local).
  String _clock(int ms) {
    if (ms <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final h12 = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '$h12:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  /// Day-group heading: TODAY / YESTERDAY / "JUL 4".
  String _groupLabel(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    final day = DateTime(d.year, d.month, d.day);
    final today = DateTime(now.year, now.month, now.day);
    final diff = today.difference(day).inDays;
    if (diff == 0) return 'TODAY';
    if (diff == 1) return 'YESTERDAY';
    return '${_kMonShort[d.month - 1].toUpperCase()} ${d.day}';
  }

  static const List<String> _kDowLetter = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  /// [WALLET-REDESIGN-1] Bars from `daily_spend`. One bar per day reads well at
  /// 7 days but 30 columns cannot fit across a phone, so longer windows are
  /// folded into equal consecutive buckets (labelled with the bucket's last
  /// day-of-month) — the totals stay honest, only the resolution drops.
  List<({String label, num value})> _spendBars(List<Map<String, dynamic>> daily) {
    if (daily.isEmpty) return const [];
    DateTime? parse(String s) => DateTime.tryParse(s);
    if (daily.length <= 14) {
      return [
        for (final d in daily)
          (
            label: () {
              final dt = parse('${d['day']}');
              return dt == null ? '' : _kDowLetter[dt.weekday - 1];
            }(),
            value: ((d['tokens'] as num?) ?? 0),
          ),
      ];
    }
    const buckets = 10;
    final size = (daily.length / buckets).ceil();
    final out = <({String label, num value})>[];
    for (var i = 0; i < daily.length; i += size) {
      final end = (i + size) > daily.length ? daily.length : (i + size);
      num sum = 0;
      for (var j = i; j < end; j++) {
        sum += ((daily[j]['tokens'] as num?) ?? 0);
      }
      final dt = parse('${daily[end - 1]['day']}');
      out.add((label: dt == null ? '' : '${dt.day}', value: sum));
    }
    return out;
  }

  // ── build ───────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final (inn, out) = _monthInOut();
    final s = _summary;
    final earned = ((s?['earned_total'] as num?) ?? inn).toInt();
    final spent = ((s?['spent_total'] as num?) ?? out).toInt();
    final daily = ((s?['daily_spend'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .toList();
    final byCat = ((s?['by_category'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .toList();
    final bars = _spendBars(daily);
    final rows = _visibleEntries;

    return Scaffold(
      backgroundColor: AW.bg,
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
      // [WALLET-LIST-REWRITE-1] A plain ListView, deliberately NOT slivers: the
      // previous CustomScrollView rendered loaded transactions invisibly on-device
      // (data present, no exception). A flat ListView lays out EVERY child
      // normally, so rows cannot be swallowed by sliver-viewport quirks.
      body: RefreshIndicator(
        onRefresh: () { Analytics.capture('wallet_pull_refresh'); return _refresh(); },
        color: AW.lime,
        backgroundColor: AW.surf,
        child: ListView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(22, 18, 22, 36),
          children: [
            // 1 — balance hero
            _balanceHero(),
            const SizedBox(height: 20),

            // 2 — period row
            Row(children: [
              Text('LAST $_days DAYS', style: AWText.caption(c: AW.txMute)),
              const Spacer(),
              WalletChipTrack(
                labels: const ['7D', '30D'],
                activeIndex: _days == 7 ? 0 : 1,
                onPick: (i) {
                  final d = i == 0 ? 7 : 30;
                  if (d == _days) return;
                  setState(() => _days = d);
                  Analytics.capture('wallet_period_changed', {'days': d});
                  _refresh();
                },
              ),
            ]),
            const SizedBox(height: 12),

            // 3 — money in / money out
            Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Expanded(child: _moneyTile(true, earned)),
              const SizedBox(width: 12),
              Expanded(child: _moneyTile(false, spent)),
            ]),

            // 4 — daily spend
            if (bars.isNotEmpty) ...[
              const SizedBox(height: 14),
              WalletCard(
                radius: 20,
                padding: const EdgeInsets.all(18),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Text('Daily spend', style: AWText.sectionHead()),
                    const Spacer(),
                    Flexible(
                      child: Text(
                        'last $_days days · ${_coins(spent)} out',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.right,
                        style: AWText.cardMeta(),
                      ),
                    ),
                  ]),
                  const SizedBox(height: 16),
                  WalletBarChart(bars: bars),
                ]),
              ),
            ],

            // 5 — where it went
            if (byCat.isNotEmpty) ...[
              const SizedBox(height: 14),
              WalletCard(
                radius: 20,
                padding: const EdgeInsets.all(18),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Text('Where it went', style: AWText.sectionHead()),
                    const Spacer(),
                    Text('last $_days days', style: AWText.cardMeta()),
                  ]),
                  const SizedBox(height: 14),
                  Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                    WalletDonut(
                      segments: [
                        for (final c in byCat)
                          (color: _catColor('${c['key']}'), value: ((c['tokens'] as num?) ?? 0)),
                      ],
                      centerValue: _coins(spent),
                    ),
                    const SizedBox(width: 18),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (var i = 0; i < byCat.length; i++) ...[
                            if (i > 0) const SizedBox(height: 9),
                            WalletLegendRow(
                              color: _catColor('${byCat[i]['key']}'),
                              label: '${byCat[i]['label'] ?? _catLabel('${byCat[i]['key']}')}',
                              value: _coins(((byCat[i]['tokens'] as num?) ?? 0)),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ]),
                ]),
              ),
            ],

            // 6 — history header
            const SizedBox(height: 26),
            Row(children: [
              Text('History', style: AWText.sectionTitle()),
              const Spacer(),
              WalletChipTrack(
                labels: const ['All', 'In', 'Out'],
                activeIndex: _dirFilter == null ? 0 : (_dirFilter == 'in' ? 1 : 2),
                onPick: (i) {
                  final next = i == 0 ? null : (i == 1 ? 'in' : 'out');
                  if (next == _dirFilter) return;
                  setState(() => _dirFilter = next);
                  _applyFilters();
                },
              ),
            ]),
            const SizedBox(height: 12),

            // 7 — search + calendar + export
            Row(children: [
              Expanded(
                child: WalletSearchField(
                  controller: _searchCtrl,
                  onSubmitted: (v) { setState(() => _query = v.trim()); _applyFilters(); },
                  onClear: _query.isEmpty
                      ? null
                      : () { _searchCtrl.clear(); setState(() => _query = ''); _applyFilters(); },
                ),
              ),
              const SizedBox(width: 8),
              WalletCircleButton(
                icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
                onTap: () => setState(() => _showCal = !_showCal),
              ),
              const SizedBox(width: 8),
              WalletCircleButton(
                icon: PhosphorIcons.export(PhosphorIconsStyle.bold),
                onTap: _showExportSheet,
              ),
            ]),

            // Inline day picker (deliberately NOT an absolute popover — a plain
            // ListView child always paints).
            if (_showCal) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: WalletCalendar(
                  month: _calMonth,
                  selectedDay: _selDay,
                  onPrev: () => setState(() => _calMonth = DateTime(_calMonth.year, _calMonth.month - 1)),
                  onNext: () => setState(() => _calMonth = DateTime(_calMonth.year, _calMonth.month + 1)),
                  onPick: _onPickDay,
                ),
              ),
            ],
            if (_range != null) ...[
              const SizedBox(height: 10),
              Row(children: [
                Expanded(
                  child: Text(
                    'SHOWING ${_dateShort(_range!.start.millisecondsSinceEpoch).toUpperCase()}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AWText.caption(c: AW.txSoft),
                  ),
                ),
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    setState(() { _range = null; _selDay = null; });
                    _applyFilters();
                  },
                  child: Text('CLEAR', style: AWText.caption(c: AW.coral)),
                ),
              ]),
            ],

            // 8 — transaction list
            const SizedBox(height: 18),
            Text(
              (_loading && rows.isEmpty) ? 'TRANSACTIONS · loading…' : 'TRANSACTIONS · ${rows.length}',
              style: AWText.caption(c: AW.txMute),
            ),
            const SizedBox(height: 10),
            if (rows.isEmpty && !_loading)
              _emptyState()
            else
              ..._dayGroups(rows),
            if (!_exhausted && rows.isNotEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Center(
                  child: SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AW.lime),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  // ── pieces ──────────────────────────────────────────────────────────────

  Widget _balanceHero() {
    final usd = (_balance / kCoinsPerUsd).toStringAsFixed(2);
    return WalletCard(
      color: AW.mint,
      radius: 24,
      padding: const EdgeInsets.all(20),
      hardBorder: true,
      shadow: const Offset(6, 7),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(11),
            ),
            child: Icon(PhosphorIcons.wallet(PhosphorIconsStyle.fill), size: 19, color: AW.glyph),
          ),
          const SizedBox(width: 10),
          Text('BALANCE', style: AWText.cardLabel()),
        ]),
        const SizedBox(height: 12),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Flexible(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(_coins(_balance), style: AWText.balanceHuge()),
            ),
          ),
          const SizedBox(width: 8),
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text('tokens', style: AWText.balanceUnit()),
          ),
        ]),
        const SizedBox(height: 7),
        Text(
          '≈ \$$usd value · refills monthly'
          '${_held > 0 ? ' · ${_coins(_held)} on hold' : ''}',
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: AWText.balanceSub(),
        ),
        const SizedBox(height: 16),
        // Android tops up via native Google Play Billing (fixed-price tiers),
        // independent of billingEnabled (that gates subscription paywalls). The
        // server-side playTopupEnabled flag + Play service account are the real
        // gate. Non-Android falls back to the Stripe rail, still hidden while
        // billing is off (everything free).
        if (!Platform.isAndroid && !RemoteConfig.billingEnabled)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            decoration: BoxDecoration(
              color: AW.bg,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AW.ink, width: 2),
            ),
            child: Text('Everything is free right now — no top-ups needed.',
                style: AWText.rowTitle(c: AW.mint)),
          )
        else
          _heroButton(
            label: 'Top up',
            icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
            fill: AW.coral,
            ink: Colors.white,
            onTap: Platform.isAndroid ? _playTopupFlow : _topupFlow,
          ),
        // Withdraw/payout is HIDDEN for now — no marketplace/payout flow yet.
        // Flip _kShowWithdraw back to true to restore the button.
        if (_kShowWithdraw) ...[
          const SizedBox(height: 10),
          _heroButton(
            label: 'Withdraw',
            icon: PhosphorIcons.handCoins(PhosphorIconsStyle.fill),
            fill: AW.lime,
            ink: AW.glyph,
            onTap: () {
              Analytics.capture('wallet_withdraw_opened', {'balance_coins': _balance});
              Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PayoutScreen()));
            },
          ),
        ],
      ]),
    );
  }

  /// Full-width 54-high poster button (flat fill, black border, hard shadow).
  Widget _heroButton({
    required String label,
    required IconData icon,
    required Color fill,
    required Color ink,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        height: 54,
        width: double.infinity,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(15),
          border: Border.all(color: AW.ink, width: 2.5),
          boxShadow: const [BoxShadow(color: AW.ink, offset: Offset(4, 5), blurRadius: 0)],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 18, color: ink),
          const SizedBox(width: 9),
          Text(label, style: AWText.sectionHead(c: ink)),
        ]),
      ),
    );
  }

  Widget _moneyTile(bool isIn, int tokens) {
    final color = isIn ? AW.mint : AW.coral;
    return WalletCard(
      radius: 18,
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        WalletBadge(
          icon: isIn
              ? PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold)
              : PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold),
          color: color,
          size: 36,
          radius: 11,
        ),
        const SizedBox(height: 12),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text('${isIn ? '+' : '−'}${_coins(tokens)}', style: AWText.statBig(c: color)),
        ),
        const SizedBox(height: 2),
        Text(isIn ? 'MONEY IN' : 'MONEY OUT', style: AWText.caption(c: AW.txMute)),
      ]),
    );
  }

  Widget _emptyState() => Padding(
        padding: const EdgeInsets.fromLTRB(0, 26, 0, 26),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 64,
            height: 64,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: AW.hair, width: 2),
            ),
            child: Icon(PhosphorIcons.receipt(PhosphorIconsStyle.bold), size: 28, color: AW.txMute),
          ),
          const SizedBox(height: 12),
          Text(
            _filtered
                ? 'Nothing matches those filters.'
                : 'No transactions yet — top up to get rolling.',
            textAlign: TextAlign.center,
            style: AWText.rowSub(c: AW.txMute),
          ),
        ]),
      );

  /// Day-grouped transaction cards (TODAY / YESTERDAY / MMM D).
  List<Widget> _dayGroups(List<Map<String, dynamic>> rows) {
    final groups = <({String label, List<Map<String, dynamic>> items})>[];
    String? cur;
    for (final e in rows) {
      final label = _groupLabel(_tsOf(e));
      if (label != cur) {
        groups.add((label: label, items: <Map<String, dynamic>>[]));
        cur = label;
      }
      groups.last.items.add(e);
    }

    final out = <Widget>[];
    for (final g in groups) {
      out.add(Padding(
        padding: const EdgeInsets.fromLTRB(0, 16, 0, 2),
        child: Text(g.label, style: AWText.caption()),
      ));
      out.add(WalletCard(
        radius: 18,
        padding: EdgeInsets.zero,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < g.items.length; i++) _txnRow(g.items[i], first: i == 0),
          ],
        ),
      ));
    }
    return out;
  }

  /// [WALLET-ROW-SAFE-1] A throw inside a row builder renders as a BLANK box in a
  /// release build — indistinguishable from "my transactions don't show". Every
  /// row is therefore built behind a guard that reports the failure AND paints a
  /// plain fallback, so a transaction is never invisible.
  Widget _txnRow(Map<String, dynamic> e, {required bool first}) {
    try {
      final tokens = _tokensOf(e);
      final ts = _tsOf(e);
      final cat = _catOf(e);
      return WalletTxnRow(
        icon: _catIcon(cat),
        color: _catColor(cat),
        title: _titleOf(e),
        sub: _catLabel(cat),
        amountLabel: '${tokens >= 0 ? '+' : '−'}${_coins(tokens.abs())}',
        isIn: tokens >= 0,
        time: _clock(ts),
        showDivider: !first,
        onTap: () => _showDetail(e),
      );
    } catch (err) {
      Analytics.error(
        domain: 'wallet', code: 'row_render_error',
        message: '$err | type=${e['type']} cat=${e['category']} keys=${e.keys.toList()}',
        screen: 'wallet_main', action: 'row_build',
      );
      final tokens = _tokensOf(e);
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 14),
        child: Row(children: [
          Expanded(
            child: Text(_titleOf(e), maxLines: 1, overflow: TextOverflow.ellipsis, style: AWText.rowTitle()),
          ),
          const SizedBox(width: 8),
          Text('${tokens >= 0 ? '+' : '−'}${_coins(tokens.abs())}',
              style: AWText.amount(c: tokens >= 0 ? AW.mint : AW.coral)),
        ]),
      );
    }
  }

  /// A calendar day pick narrows the statement to that single local day.
  void _onPickDay(int day) {
    final start = DateTime(_calMonth.year, _calMonth.month, day);
    setState(() {
      _selDay = day;
      // _fetchPage widens `to` by a day, so start==end covers 00:00 → 23:59:59.
      _range = DateTimeRange(start: start, end: start);
      _showCal = false;
    });
    Analytics.capture('wallet_day_filtered', {'day': start.toIso8601String()});
    _applyFilters();
  }

  // ── transaction detail ───────────────────────────────────────────────────

  Future<void> _showDetail(Map<String, dynamic> row) async {
    final id = '${row['id']}';
    Analytics.capture('wallet_txn_opened', {'type': '${row['type']}', 'id': id});
    Map<String, dynamic> detail = const {};
    try {
      final d = await MoneyApi.ledgerDetail(id);
      detail = ((d['entry'] as Map?) ?? const {}).cast<String, dynamic>();
    } catch (_) {/* offline: show the row we already have */}
    if (!mounted) return;

    final entry = <String, dynamic>{...row, ...detail};
    final meta = ((entry['meta'] as Map?) ?? const {}).cast<String, dynamic>();
    final tokens = _tokensOf(entry);
    final ts = _tsOf(entry);
    final cat = _catOf(entry);
    final isIn = tokens >= 0;
    final amountLabel = '${isIn ? '+' : '−'}${_coins(tokens.abs())}';

    // Cost maths — only rendered when BOTH a duration and a per-minute rate are
    // present; a half-filled equation is worse than none.
    final durSec = ((meta['duration_seconds'] ?? meta['duration_sec'] ?? entry['duration_seconds']) as num?)?.toInt();
    final mins = (meta['minutes'] as num?)?.toDouble();
    final rate = (meta['rate_per_min'] ?? entry['rate_per_min']) as num?;
    String? durLabel;
    if (durSec != null && durSec > 0) {
      durLabel = '${(durSec / 60).floor()}:${(durSec % 60).toString().padLeft(2, '0')}';
    } else if (mins != null && mins > 0) {
      durLabel = mins == mins.roundToDouble() ? '${mins.round()} min' : '${mins.toStringAsFixed(1)} min';
    }

    final usdCents = (meta['cents'] as num?)?.toInt();
    final usdLabel = '${entry['usd'] ?? ''}'.trim().isNotEmpty
        ? '${entry['usd']}'
        : (usdCents != null ? _usdFromCents(usdCents) : '');
    final paidWith = _payMethod(meta) ?? '';
    final status = '${entry['status'] ?? 'completed'}';
    final balAfter = (entry['balance_after'] as num?)?.toInt();
    final ref = '${entry['ref'] ?? ''}'.trim();

    final infoRows = <({String label, String value})>[
      (label: 'Date', value: _fullDate(ts)),
      (label: 'Type', value: _catLabel(cat)),
      (label: 'Reference', value: ref),
      (label: 'Paid', value: usdLabel),
      (label: 'Paid with', value: paidWith),
      (label: 'Status', value: status.isEmpty ? '' : status[0].toUpperCase() + status.substring(1)),
      (label: 'Balance after', value: balAfter == null ? '' : '${_coins(balAfter)} tokens'),
    ].where((r) => r.value.trim().isNotEmpty).toList();

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AW.bg,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
      ),
      builder: (c) => SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(c).size.height * 0.9),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 14, 22, 26),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Center(
                child: Container(
                  width: 44, height: 5,
                  decoration: BoxDecoration(color: AW.hair, borderRadius: BorderRadius.circular(100)),
                ),
              ),
              const SizedBox(height: 22),
              WalletBadge(icon: _catIcon(cat), color: _catColor(cat), size: 66, radius: 20, glyph: 32),
              const SizedBox(height: 20),
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(amountLabel, style: AWText.detailAmount(c: isIn ? AW.mint : AW.coral)),
              ),
              const SizedBox(height: 4),
              Text('tokens · ${_catLabel(cat)}',
                  textAlign: TextAlign.center, style: AWText.sectionHead(c: AW.txMute)),
              const SizedBox(height: 14),
              WalletStatusPill(status: status.isEmpty ? 'completed' : status),
              const SizedBox(height: 22),
              Text(_titleOf(entry),
                  textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: AWText.rowTitle()),
              const SizedBox(height: 16),
              if (durLabel != null && rate != null) ...[
                WalletBreakdownBox(
                  duration: durLabel,
                  rate: _coins(rate),
                  total: _coins(tokens.abs()),
                  totalColor: isIn ? AW.mint : AW.coral,
                ),
                const SizedBox(height: 14),
              ],
              WalletCard(
                radius: 18,
                padding: EdgeInsets.zero,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (var i = 0; i < infoRows.length; i++)
                      WalletInfoRow(
                        label: infoRows[i].label,
                        value: infoRows[i].value,
                        showDivider: i != 0,
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 18),
              _heroButton(
                label: 'Get receipt',
                icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold),
                fill: AW.blue,
                ink: AW.glyph,
                onTap: () async {
                  final r = await MoneyApi.resendReceipt(id);
                  Analytics.capture('wallet_receipt_resent', {'id': id, 'sent': r['sent'] == true});
                  if (c.mounted) Navigator.pop(c);
                  _snack(r['sent'] == true ? 'Receipt sent to your email.' : 'Could not send the receipt.');
                },
              ),
              const SizedBox(height: 6),
              Center(
                child: TextButton(
                  onPressed: () {
                    Analytics.capture('wallet_txn_reported', {'id': id, 'type': '${entry['type']}'});
                    if (c.mounted) Navigator.pop(c);
                    _snack('Thanks — we\'ll look into it.');
                  },
                  child: Text('Report an issue', style: AWText.rowTitle(c: AW.coral)),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  // ── export ───────────────────────────────────────────────────────────────

  void _showExportSheet() {
    final now = DateTime.now();
    Analytics.capture('wallet_export_sheet_opened');
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AW.surf,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
      ),
      builder: (c) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Center(
              child: Container(
                width: 44, height: 5,
                decoration: BoxDecoration(color: AW.hair, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            const SizedBox(height: 18),
            Text('Export statement', style: AWText.sectionTitle()),
            const SizedBox(height: 4),
            Text('Your ${_kMonLong[now.month - 1]} ${now.year} transaction history',
                style: AWText.rowSub(c: AW.txMute)),
            const SizedBox(height: 18),
            _exportTile(c, 'share', 'Share', 'Send via AvaTalk or apps',
                PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), AW.blue),
            const SizedBox(height: 10),
            _exportTile(c, 'save', 'Save to phone', 'Download CSV statement',
                PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold), AW.lime),
            const SizedBox(height: 10),
            _exportTile(c, 'email', 'Email', 'Send a copy to yourself',
                PhosphorIcons.envelopeSimple(PhosphorIconsStyle.bold), AW.lilac),
            const SizedBox(height: 8),
            Center(
              child: TextButton(
                onPressed: () => Navigator.pop(c),
                child: Text('Cancel', style: AWText.rowTitle(c: AW.txMute)),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _exportTile(BuildContext sheetCtx, String mode, String label, String sub, IconData icon, Color color) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _runExport(sheetCtx, mode),
      child: WalletCard(
        color: AW.surf2,
        radius: 16,
        hardBorder: true,
        shadow: const Offset(3, 3),
        padding: const EdgeInsets.fromLTRB(15, 13, 15, 13),
        child: Row(children: [
          WalletBadge(icon: icon, color: color, size: 38, radius: 11),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: AWText.rowTitle()),
              const SizedBox(height: 2),
              Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: AWText.rowSub(c: AW.txMute)),
            ]),
          ),
          Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AW.txMute),
        ]),
      ),
    );
  }

  /// Builds the current month's CSV server-side, then shares / saves it. All
  /// three modes hit the same endpoint; only the disposal differs.
  Future<void> _runExport(BuildContext sheetCtx, String mode) async {
    final now = DateTime.now();
    final from = DateTime(now.year, now.month).millisecondsSinceEpoch;
    Analytics.capture('wallet_statement_export', {'mode': mode, 'month': now.month, 'year': now.year});
    String? csv;
    try {
      csv = await MoneyApi.statementCsv(
        from: from,
        to: now.millisecondsSinceEpoch,
        tzOffsetMin: now.timeZoneOffset.inMinutes,
      );
    } catch (e) {
      Analytics.error(
        domain: 'wallet', code: 'statement_export_failed',
        message: '$e', screen: 'wallet_main', action: 'export_$mode',
      );
    }
    if (sheetCtx.mounted) Navigator.pop(sheetCtx);
    final body = csv?.trim() ?? '';
    // A JSON error envelope means the endpoint rejected the window.
    if (body.isEmpty || body.startsWith('{')) {
      _snack('Could not build the statement.');
      return;
    }
    final lines = body.split('\n');
    final count = lines.length > 1 ? lines.length - 1 : 0;
    try {
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/avatok_statement_${now.year}_${now.month.toString().padLeft(2, '0')}.csv');
      await f.writeAsString(body, flush: true);
      if (mode != 'save') {
        await Share.shareXFiles(
          [XFile(f.path, mimeType: 'text/csv')],
          subject: 'AvaWallet statement — ${_kMonLong[now.month - 1]} ${now.year}',
        );
      }
    } catch (e) {
      Analytics.error(
        domain: 'wallet', code: 'statement_share_failed',
        message: '$e', screen: 'wallet_main', action: 'export_$mode',
      );
      _snack('Could not build the statement.');
      return;
    }
    _snack('Statement ready ($count rows).');
  }
}
