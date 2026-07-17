import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/db.dart';
import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/wallet_topup_billing.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../payout/payout_screen.dart';
import 'admin_money_screen.dart';

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

  // Filters (server-side).
  final Set<String> _typeFilter = {};
  DateTimeRange? _range;
  String _query = '';
  final _searchCtrl = TextEditingController();
  final _scroll = ScrollController();

  bool get _filtered => _typeFilter.isNotEmpty || _range != null || _query.isNotEmpty;

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
    await _fetchPage(reset: true);
    final b = await bal;
    if (mounted && b['balance'] is num) {
      setState(() { _balance = (b['balance'] as num).toInt(); _held = ((b['held'] as num?) ?? 0).toInt(); });
      Analytics.capture('wallet_balance_loaded', {
        'balance_coins': _balance,
        'held_coins': _held,
        'balance_usd_cents': (_balance * 100 / kCoinsPerUsd).round(),
        'entries_loaded': _entries.length,
        'has_ledger': _entries.isNotEmpty,
        'filtered': _filtered,
      });
      // DIAGNOSTIC: a positive balance with an EMPTY (unfiltered) ledger means the
      // user has coins but no transaction history — the exact "no log below my
      // recent transaction" symptom. This usually means the balance was credited
      // outside the queue→wallet_ledger path (seed/admin adjust/DO-only), or the
      // top-up's ledger row never landed. email + phone ride every event (see
      // Analytics._base), so support can pull THIS user by email/phone in PostHog
      // and reconcile the missing ledger row.
      if (_balance > 0 && _entries.isEmpty && !_filtered && !_loading) {
        Analytics.capture('wallet_balance_without_ledger', {
          'balance_coins': _balance,
          'held_coins': _held,
          'balance_usd_cents': (_balance * 100 / kCoinsPerUsd).round(),
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
      final r = await MoneyApi.ledger(
        cursor: reset ? null : _cursor,
        types: _typeFilter.toList(),
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
            (id: '${e['id']}', createdAt: ((e['created_at'] as num?) ?? 0).toInt(), type: '${e['type']}', json: jsonEncode(e)),
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
  // Flow: ask amount → server mints a PaymentIntent → present the native sheet
  // (card / Apple Pay / Google Pay) right here → poll the balance so the topped-up
  // coins + the new ledger entry land on this same page. Coins are credited
  // server-side ONLY (Stripe webhook); the client never moves money itself.
  Future<void> _topupFlow() async {
    final cents = await _askAmountCents();
    if (cents == null || !mounted) return;
    final coins = (cents * kCoinsPerUsd / 100).round();
    Analytics.capture('wallet_topup_started', {'cents': cents, 'coins': coins, 'method': 'payment_sheet'});

    // 1) Server creates the PaymentIntent and returns the client secret + the
    //    publishable key (so the app never hardcodes a Stripe key).
    Map<String, dynamic> r;
    try {
      r = await MoneyApi.topupIntent(cents);
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

  /// Amount sheet: USD entry with a live Token preview. Returns USD cents, or
  /// null if cancelled. Min $10 / max $500 (mirrors the server's top-up bounds).
  Future<int?> _askAmountCents() async {
    final ctrl = TextEditingController();
    return showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (c) => StatefulBuilder(
        builder: (c, setSheet) {
          final d = double.tryParse(ctrl.text.trim());
          final valid = d != null && d >= 10 && d <= 500;
          final previewCoins = valid ? (d * kCoinsPerUsd).round() : 0;
          return Padding(
            padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(c).viewInsets.bottom + 20),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Top up wallet', style: ADText.appTitle()),
              const SizedBox(height: 4),
              Text('Pay securely in-app. \$1 = ${_coins(kCoinsPerUsd)} Tokens.', style: ADText.preview()),
              const SizedBox(height: 16),
              AdField(
                controller: ctrl,
                autofocus: true,
                leadText: '\$',
                hint: '10.00',
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                onChanged: (_) => setSheet(() {}),
              ),
              const SizedBox(height: 8),
              Text(
                valid ? '= ${_coins(previewCoins)} Tokens' : 'Enter \$10 – \$500',
                style: ADText.rowName(c: valid ? AD.online : AD.textTertiary),
              ),
              const SizedBox(height: 12),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final v in [10, 25, 50, 100])
                  AdSticker('\$$v', onTap: () {
                    Analytics.capture('wallet_topup_preset', {'usd': v});
                    setSheet(() => ctrl.text = v.toStringAsFixed(2));
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
          Text('Charged in your local currency at Google Play’s rate.', style: ADText.preview(c: AD.textTertiary)),
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
      'types': _typeFilter.join(','), 'range': _range != null, 'q': _query.isNotEmpty,
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
        tag: 'your avacoins',
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
                    return _row(_entries[i]);
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
              Text('AVACOINS', style: ADText.statCaption(c: AD.textOnInput)),
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
        Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(child: _miniCard('This month in', '+${_coins(inn)}',
              PhosphorIcons.arrowDownLeft(PhosphorIconsStyle.bold), AD.online, AD.online)),
          const SizedBox(width: 10),
          Expanded(child: _miniCard('This month out', '−${_coins(out)}',
              PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), AD.danger, AD.danger)),
        ]),
      ]),
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
          hint: 'Search by event or consult name',
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
            for (final t in _kTypes.entries.where((e) => e.key != 'storage_charge')) ...[
              AdChip(
                label: t.value.label,
                active: _typeFilter.contains(t.key),
                onTap: () {
                  setState(() => _typeFilter.contains(t.key) ? _typeFilter.remove(t.key) : _typeFilter.add(t.key));
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

  /// Transaction row — ledger style (§7.10): label + dotted leader + value.
  /// Credits in mint-ink, debits in coral.
  Widget _row(Map<String, dynamic> e) {
    final amount = ((e['amount'] as num?) ?? 0).toInt();
    final t = _kTypes['${e['type']}'];
    final positive = amount >= 0;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _showDetail(e),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
            Flexible(
              child: Text('${e['title'] ?? t?.label ?? e['type']}',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName()),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text('·' * 80, maxLines: 1, overflow: TextOverflow.clip,
                  style: ADText.preview(c: AD.textTertiary)),
            ),
            const SizedBox(width: 6),
            Text('${positive ? '+' : '−'}${_coins(amount)}',
                style: ADText.rowName(c: positive ? AD.online : AD.danger)),
          ]),
          const SizedBox(height: 2),
          Text('${t?.label ?? e['type']} · ${_dateShort(((e['created_at'] as num?) ?? 0).toInt())}'.toUpperCase(),
              style: ADText.statCaption()),
        ]),
      ),
    );
  }
}
