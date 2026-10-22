import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/demo_mode.dart';
import '../../data/in_app_checkout.dart';
import '../../data/models/wallet.dart';
import '../../data/repos/payouts_repo.dart';
import '../../data/repos/wallet_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../../ui/async_view.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../list_kit.dart';
import '../money_kit.dart';
import '../call_kit.dart';
import 'checkout_flow.dart';
import 'me.dart' show WalletTicket;

// ---------------------------------------------------------------------------------------------- Wallet

/// Wallet — the shop counter: balance, Top up / Withdraw, history.
///
/// With [DemoMode.on] (and no [repo]) it shows the dummy numbers. Otherwise it reads `GET /api/hf/app/wallet`:
/// balance, test credits (spendable, not withdrawable), money set aside, and the history with a "Load more".
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key, this.repo});

  final WalletRepo? repo;

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  bool get _real => widget.repo != null || !DemoMode.on;
  WalletRepo get _repo => widget.repo ?? Services.instance.walletRepo;

  AsyncState<WalletSnapshot> _state = const AsyncLoading();
  bool _loadingMore = false;

  @override
  void initState() {
    super.initState();
    if (_real) _load();
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      // [HF-APP-CACHE-1] Last wallet first (balance + ledger), then the server's.
      await for (final w in _repo.watch()) {
        if (mounted) setState(() => _state = AsyncData(w));
      }
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _more() async {
    final cur = _state;
    if (cur is! AsyncData<WalletSnapshot> || cur.value.nextCursor == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final more = await _repo.fetch(cursor: cur.value.nextCursor);
      if (mounted) setState(() => _state = AsyncData(cur.value.appended(more)));
    } catch (e) {
      if (mounted) toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  static const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  static String _when(DateTime d) {
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    final m = d.minute.toString().padLeft(2, '0');
    return '${d.day} ${_months[d.month - 1]}, $h:$m ${d.hour < 12 ? 'am' : 'pm'}';
  }

  /// [HF-APP-DESI-8] approved "My wallet" layout.
  @override
  Widget build(BuildContext context) {
    if (!_real) {
      return Scaffold(
        backgroundColor: C.ivory,
        body: SafeArea(
          child: Column(children: [
            const BookHeader('My wallet'),
            Expanded(
              child: ListenableBuilder(
                listenable: demo,
                builder: (context, _) => ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    _gullak(context, inr(demo.balance)),
                    const SizedBox(height: 12),
                    const HistoryTitle(),
                    for (final x in demo.txns) LedgerRow(title: x.title, sub: x.sub, amount: x.amount, amountText: inr(x.amount, sign: true)),
                    const SizedBox(height: 8),
                    const DesiMogra(),
                  ],
                ),
              ),
            ),
          ]),
        ),
      );
    }
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(children: [
          const BookHeader('My wallet'),
          Expanded(
            child: AsyncView<WalletSnapshot>(
              state: _state,
              onRetry: _load,
              isEmpty: (_) => false,
              builder: (context, w) => RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    _gullak(context, inr(w.balancePaise / 100), chips: [
                      if (w.heldPaise > 0) ('${inr(w.heldPaise / 100)} set aside for a call or booking', true),
                      if (w.testCreditPaise > 0) ('Test credits ${inr(w.testCreditPaise / 100)} · spend on calls, cannot be withdrawn', false),
                    ]),
                    const SizedBox(height: 12),
                    const HistoryTitle(),
                    if (w.ledger.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: Text('Nothing here yet. Top up to start calling.', style: t(15, color: C.muted, w: FontWeight.w700)),
                      ),
                    for (final x in w.ledger) LedgerRow(title: x.label, sub: _when(x.at), amount: x.amountPaise / 100, amountText: inr(x.amountPaise / 100, sign: true)),
                    if (w.nextCursor != null) LoadMorePill(label: _loadingMore ? 'LOADING…' : 'LOAD MORE', onTap: _more),
                    const SizedBox(height: 12),
                    const DesiMogra(),
                  ],
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _gullak(BuildContext context, String balance, {List<(String, bool)> chips = const []}) => GullakCard(
        balance: balance,
        chips: chips,
        onTopUp: () => context.push('/topup'),
        // [HF-WIRE-13] HF-REEL-36: anyone can withdraw wallet money to UPI (after ID + UPI check). Refunds always land in the wallet.
        onWithdraw: () => context.push('/payout'),
      );
}

// ---------------------------------------------------------------------------------------------- Top up

/// Top up: any whole amount; price includes 18% GST, wallet gets paid ÷ 1.18 (HF-PAY rules).
/// The payment steps are our own screens (CheckoutFlow); the app never names the gateway.
class TopUpScreen extends StatefulWidget {
  const TopUpScreen({super.key, this.repo, this.checkout, this.profile});

  /// Pass a repository to use the real server (tests do); otherwise real unless [DemoMode.on].
  final WalletRepo? repo;

  /// [HF-WIRE-21] The in-app checkout to use (tests pass a fake); default is [Checkout.inApp].
  final InAppCheckout? checkout;

  /// The payer's profile (tests pass one); default reads the signed-in account.
  final CheckoutProfile? profile;

  @override
  State<TopUpScreen> createState() => _TopUpScreenState();
}

class _TopUpScreenState extends State<TopUpScreen> {
  final _amount = TextEditingController(text: '500');

  /// Set once the payer pressed Pay: the amount screen is then replaced by the checkout flow.
  int? _flowRupees;

  bool get _real => widget.repo != null || !DemoMode.on;
  WalletRepo get _repo => widget.repo ?? Services.instance.walletRepo;

  int get _value => int.tryParse(_amount.text.replaceAll(RegExp(r'\D'), '')) ?? 0;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _pay() async {
    final v = _value;
    if (v < 10) {
      toast(context, 'Minimum top up is ₹10.');
      return;
    }
    if (v >= 1000) {
      final ok = await hfConfirm(
        context,
        title: 'Pay ${inr(v, paise: false)}?',
        body: 'That is ₹1,000 or more. Just checking before we go on.',
        confirmLabel: 'Yes, pay',
        cancelLabel: 'Change',
      );
      if (ok != true || !mounted) return;
    }
    if (!mounted) return;
    if (!_real) {
      context.pushReplacement('/payment?amount=$v');
      return;
    }
    // [HF-WIRE-21] The whole checkout runs on our own screens (CheckoutFlow): details, UPI apps / UPI ID / card, processing. The order is
    // created there, once the payer has chosen a way to pay. The server's webhook is the only thing that credits the wallet, so every
    // finished attempt ends on the Payment screen, which asks the server.
    setState(() => _flowRupees = v);
  }

  CheckoutProfile _profile() {
    if (widget.profile != null) return widget.profile!;
    final m = Services.instance.me;
    if (m == null) return const CheckoutProfile();
    return CheckoutProfile(name: m.name, email: m.email, phoneVerified: m.whatsappVerified, phoneMasked: m.phoneMasked);
  }

  @override
  Widget build(BuildContext context) {
    final flow = _flowRupees;
    if (flow != null) {
      return Scaffold(
        body: SafeArea(
          child: CheckoutFlow(
            rupees: flow,
            repo: _repo,
            checkout: widget.checkout ?? Checkout.inApp,
            profile: _profile(),
            onFinish: (loc) {
              if (mounted) context.pushReplacement(loc);
            },
            onClose: () {
              if (mounted) setState(() => _flowRupees = null);
            },
            onProfileSaved: widget.profile == null ? () => unawaited(Services.instance.refreshMe()) : null,
            onVerifyPhone: () => context.push('/settings'),
          ),
        ),
      );
    }
    final v = _value;
    final credit = DemoState.creditFor(v.toDouble());
    final gst = v - credit;
    // [HF-APP-DESI-8] approved "Top up" layout
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Top up'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                children: [
                  const TopUpHero(),
                  const SizedBox(height: 12),
                  AmountBox(
                    controller: _amount,
                    value: v,
                    onChanged: (_) => setState(() {}),
                    onPick: (a) => setState(() => _amount.text = '$a'),
                    label: (a) => inr(a, paise: false),
                  ),
                  const SizedBox(height: 12),
                  MoneyHisaab(lines: [('You pay', inr(v)), ('GST 18%', inr(gst))], total: ('Added to wallet', inr(credit))),
                  if (v >= 1000) ...[
                    const SizedBox(height: 12),
                    const BookNotice(text: "That's ₹1,000 or more. We'll ask you to confirm once more.", icon: Icons.info_outline_rounded),
                  ],
                  const SizedBox(height: 14),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.lock_rounded, size: 18, color: C.muted),
                      const SizedBox(width: 6),
                      Flexible(child: Text('Secure payment · UPI apps, UPI ID and cards', style: t(14, color: C.muted, w: FontWeight.w700))),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const DesiMogra(),
                ],
              ),
            ),
            BookBottomButton(label: 'PAY ${inr(v, paise: false)}', onTap: _pay),
          ],
        ),
      ),
    );
  }
}

/// After the payment page: waits for the server to say the money arrived.
///
/// With an [orderId] it asks `GET /api/hf/wallet/topup/:id` every [pollEvery] and shows paid, "still confirming"
/// (it keeps asking after [slowAfter]) or failed with "Try again". Without one (demo) it fakes a 2 second success.
class PaymentScreen extends StatefulWidget {
  const PaymentScreen({
    super.key,
    this.amount,
    this.orderId,
    this.creditPaise,
    this.sdkFailed = false,
    this.repo,
    this.pollEvery = const Duration(seconds: 2),
    this.slowAfter = const Duration(seconds: 60),
  });

  /// Rupees paid. Null when the screen was opened from a return link: the amount then comes from the server.
  final double? amount;

  /// The in-app checkout reported an error or the payer backed out. If the server still has no payment, the screen says so
  /// instead of waiting for a minute.
  final bool sdkFailed;
  final String? orderId;
  final int? creditPaise;
  final WalletRepo? repo;
  final Duration pollEvery;
  final Duration slowAfter;

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

enum _Pay { confirming, slow, paid, failed, notDone }

class _PaymentScreenState extends State<PaymentScreen> {
  _Pay _pay = _Pay.confirming;
  Timer? _t;
  final _since = Stopwatch()..start();
  int? _credit;
  double? _paid;
  bool _asking = false;
  int _polls = 0;

  bool get _real => widget.orderId != null && (widget.repo != null || !DemoMode.on);
  WalletRepo get _repo => widget.repo ?? Services.instance.walletRepo;

  @override
  void initState() {
    super.initState();
    _credit = widget.creditPaise;
    _paid = widget.amount;
    if (_real) {
      _t = Timer.periodic(widget.pollEvery, (_) => _ask());
    } else {
      _t = Timer(const Duration(seconds: 2), () {
        demo.topUp(widget.amount ?? 0);
        if (mounted) setState(() => _pay = _Pay.paid);
      });
    }
  }

  Future<void> _ask() async {
    if (_asking) return;
    _asking = true;
    _polls++;
    try {
      final st = await _repo.status(widget.orderId!);
      if (!mounted) return;
      if (st.state == TopupState.paid) {
        _t?.cancel();
        if (st.creditPaise != null) _credit = st.creditPaise;
        if (st.paidPaise != null) _paid = st.paidPaise! / 100;
        Telemetry.event('hf_topup_result', {'order': widget.orderId, 'result': 'paid', 'ms': _since.elapsedMilliseconds});
        // [HF-WIRE-20] Back from the checkout: refresh Me and the balance tag on its own.
        unawaited(Services.instance.refreshMe());
        WalletTicket.refresh.value++;
        setState(() => _pay = _Pay.paid);
      } else if (st.state == TopupState.failed) {
        _t?.cancel();
        Telemetry.event('hf_topup_result', {'order': widget.orderId, 'result': 'failed', 'ms': _since.elapsedMilliseconds});
        setState(() => _pay = _Pay.failed);
      } else if (widget.sdkFailed && st.state == TopupState.pending) {
        // The checkout said it did not finish and the server has no payment for this order.
        _t?.cancel();
        Telemetry.event('hf_topup_result', {'order': widget.orderId, 'result': 'not_done'});
        setState(() => _pay = _Pay.notDone);
      } else if (_pay == _Pay.confirming && widget.pollEvery * _polls >= widget.slowAfter) {
        Telemetry.event('hf_topup_result', {'order': widget.orderId, 'result': 'slow'});
        setState(() => _pay = _Pay.slow);
      }
    } catch (_) {
      // a failed look is not a failed payment: keep asking
    } finally {
      _asking = false;
    }
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final done = _pay == _Pay.paid;
    final failed = _pay == _Pay.failed;
    final notDone = _pay == _Pay.notDone;
    final paid = _paid;
    final creditText = _credit != null ? inr(_credit! / 100) : inr(DemoState.creditFor(paid ?? 0));
    final waiting = _pay == _Pay.confirming || _pay == _Pay.slow;
    // [HF-APP-DESI-8] approved "Payment received" card; waiting / failed / not completed use the same card.
    return PopScope(
      canPop: done || failed || notDone,
      child: Scaffold(
        backgroundColor: C.ivory,
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
            children: [
              if (waiting)
                PaymentCard(
                  mark: const PaymentMark(spinning: true),
                  title: _real ? 'Confirming your payment…' : 'Opening secure payment…',
                  line: _pay == _Pay.slow
                      ? 'We are still confirming your payment.'
                      : _real
                          ? 'This usually takes a few seconds. Please keep the app open.'
                          : 'Demo: no real money moves.',
                )
              else if (notDone)
                const PaymentCard(
                  mark: PaymentMark(icon: Icons.info_outline_rounded),
                  title: 'Payment was not completed.',
                  line: 'If money left your account, it is added to your wallet within a few minutes.',
                )
              else if (failed)
                const PaymentCard(mark: PaymentMark(icon: Icons.priority_high_rounded), title: 'Payment did not go through. No money was taken.')
              else
                PaymentCard(
                  mark: const PaymentMark(),
                  title: paid == null ? 'Payment received' : 'Paid ${inr(paid, paise: false)}',
                  stub: '$creditText added to your wallet',
                  line: 'Receipt sent on WhatsApp and email.',
                ),
              const SizedBox(height: 14),
              if (done) MoneyPill(label: 'BACK TO WALLET', onTap: () => context.pushReplacement('/wallet')),
              if (failed || notDone) ...[
                MoneyPill(label: 'TRY AGAIN', gold: true, onTap: () => context.pushReplacement('/topup')),
                const SizedBox(height: 10),
                Semantics(
                  button: true,
                  child: TextButton(
                    onPressed: () => context.pushReplacement('/wallet'),
                    style: TextButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    child: Text('BACK TO WALLET', style: t(16, color: C.maroon, w: FontWeight.w900)),
                  ),
                ),
              ],
              const SizedBox(height: 12),
              const DesiMogra(),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Payout

/// Payout: withdraw to UPI (HF-WIRE-10). Open to everyone (HF-REEL-36) with no minimum (HF-REEL-38; the server's `minPaise` is 0 unless the
/// owner sets one). Influencer earnings keep the 7-day hold. Paid to UPI, UTR on WhatsApp. The ID check happens once, before the first payout.
///
/// With [DemoMode.on] (and no [repo]) it shows the dummy numbers. Otherwise it reads `GET /api/hf/payouts/summary`.
class PayoutScreen extends StatefulWidget {
  const PayoutScreen({super.key, this.repo});

  final PayoutsRepo? repo;

  @override
  State<PayoutScreen> createState() => _PayoutScreenState();
}

class _PayoutScreenState extends State<PayoutScreen> {
  bool get _real => widget.repo != null || !DemoMode.on;
  PayoutsRepo get _repo => widget.repo ?? Services.instance.payoutsRepo;

  AsyncState<PayoutSummary> _state = const AsyncLoading();
  final _amount = TextEditingController();
  bool _busy = false;
  // One key per intended request, kept while the same amount is retried after a lost answer.
  String? _key;
  int? _keyAmount;

  @override
  void initState() {
    super.initState();
    if (_real) {
      _load();
    } else {
      _amount.text = demo.earningsReady.toStringAsFixed(0);
    }
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _load({bool keepAmount = false}) async {
    if (!keepAmount) setState(() => _state = const AsyncLoading());
    try {
      final s = await _repo.summary();
      if (!mounted) return;
      setState(() {
        _state = AsyncData(s);
        if (!keepAmount || _amount.text.isEmpty) _amount.text = '${s.readyRupees}';
      });
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  int get _typedRupees => int.tryParse(_amount.text.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0;

  Future<void> _request() async {
    if (!_real) return _requestDemo();
    final s = (_state as AsyncData<PayoutSummary>).value;
    final v = _typedRupees;
    if (s.upi == null) {
      toast(context, 'Add your UPI first.');
      return;
    }
    if (v <= 0) {
      toast(context, 'Enter the amount you want to withdraw.');
      return;
    }
    if (s.minPaise > 0 && v * 100 < s.minPaise) {
      toast(context, 'Minimum payout is ${inr(s.minPaise / 100, paise: false)}.');
      return;
    }
    if (v * 100 > s.readyPaise) {
      toast(context, 'You can withdraw up to ${inr(s.readyPaise / 100, paise: false)}.');
      return;
    }
    if (_busy) return;
    if (_keyAmount != v || _key == null) {
      _key = PayoutsRepo.newKey();
      _keyAmount = v;
    }
    setState(() => _busy = true);
    try {
      await _repo.request(v * 100, key: _key!);
      _key = null;
      if (!mounted) return;
      toast(context, 'Requested ${inr(v, paise: false)}. We will WhatsApp you the UTR once paid.');
      _amount.clear();
      await _load(keepAmount: true);
    } catch (e) {
      final kyc = PayoutsRepo.kycStep(e);
      if (e is ApiException && e.kind == ApiFailure.http) _key = null; // a clear answer: the next tap is a new request
      if (!mounted) return;
      if (kyc != null) {
        _key = null;
        await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PayoutKycScreen(step: kyc)));
        if (mounted) await _load(keepAmount: true);
      } else {
        toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _requestDemo() {
    final v = double.tryParse(_amount.text.replaceAll(RegExp(r'[^0-9.]'), '')) ?? 0;
    if (v <= 0) {
      toast(context, 'Enter the amount you want to withdraw.');
      return;
    }
    if (v > demo.earningsReady) {
      toast(context, 'You can withdraw up to ${inr(demo.earningsReady, paise: false)}.');
      return;
    }
    demo.requestPayout(v);
    _amount.text = demo.earningsReady.toStringAsFixed(0);
    toast(context, 'Requested ${inr(v, paise: false)}. We will WhatsApp you the UTR once paid.');
  }

  Future<void> _editUpi(String? current) async {
    final saved = await showModalBottomSheet<PayoutUpi>(
      context: context,
      isScrollControlled: true,
      backgroundColor: C.clear,
      builder: (_) => _UpiSheet(repo: _repo, current: current),
    );
    if (saved != null && mounted) await _load(keepAmount: true);
  }

  @override
  Widget build(BuildContext context) {
    if (!_real) {
      return ListenableBuilder(
        listenable: demo,
        builder: (context, _) => _frame(
          ready: demo.earningsReady,
          hold: demo.earningsHold,
          vpa: demo.name.isEmpty ? 'yourname@okbank' : '${demo.name.split(' ').first.toLowerCase()}@okhdfcbank',
          checkedLine: 'Checked · name matches',
          minRupees: 0,
          history: [for (final p in demo.payouts) (p.when, p.amount, p.status, p.status.startsWith('PAID'))],
          canAsk: true,
        ),
      );
    }
    return AsyncView<PayoutSummary>(
      state: _state,
      onRetry: _load,
      isEmpty: (_) => false,
      builder: (context, s) => _frame(
        ready: s.readyPaise / 100,
        hold: s.onHoldPaise / 100,
        vpa: s.upi?.vpa,
        checkedLine: s.upi == null ? null : (s.upi!.nameMatched == true ? 'Checked · name matches' : 'We check the name when we pay'),
        minRupees: s.minPaise ~/ 100,
        history: [for (final h in s.history) (_when(h.at), h.amountPaise / 100, _label(h), h.status == PayoutStatus.paid)],
        canAsk: s.upi != null,
        onChangeUpi: () => _editUpi(s.upi?.vpa),
      ),
    );
  }

  static const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  static String _when(DateTime d) => '${d.day} ${_months[d.month - 1]}';
  static String _label(PayoutItem h) => switch (h.status) {
        PayoutStatus.paid => h.utr == null ? 'PAID' : 'PAID · UTR ${h.utr}',
        PayoutStatus.rejected => 'NOT PAID',
        PayoutStatus.checking => 'BEING CHECKED',
      };

  /// [HF-APP-DESI-9] approved "Withdraw" layout.
  Widget _frame({
    required double ready,
    required double hold,
    required String? vpa,
    required String? checkedLine,
    required int minRupees,
    required List<(String, double, String, bool)> history,
    required bool canAsk,
    VoidCallback? onChangeUpi,
  }) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('Withdraw'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                children: [
                  const PayoutHero(),
                  const SizedBox(height: 12),
                  PayoutTiles(ready: inr(ready, paise: false), hold: inr(hold, paise: false)),
                  const SizedBox(height: 12),
                  PayoutAmountBox(
                    controller: _amount,
                    label: minRupees > 0 ? 'Amount (minimum ${inr(minRupees, paise: false)})' : 'Amount (no minimum)',
                    onAll: () => _amount.text = ready.floor().toString(),
                  ),
                  const SizedBox(height: 12),
                  UpiCard(vpa: vpa, checkedLine: checkedLine, onTap: onChangeUpi ?? () => toast(context, 'Change UPI (demo)')),
                  const SizedBox(height: 12),
                  const RulesCard(lines: [
                    'We pay every request to your UPI.',
                    'You get the payment reference (UTR) on WhatsApp.',
                    'We check your ID once, before your first payout.',
                    'Test credits can be spent but not withdrawn.',
                  ]),
                  const SizedBox(height: 14),
                  Text('Past payouts', style: t(18, color: C.maroon, w: FontWeight.w900)),
                  const SizedBox(height: 8),
                  if (history.isEmpty) Text('No payouts yet.', style: t(15, color: C.muted, w: FontWeight.w700)),
                  for (final p in history)
                    PayoutRow(
                      amount: inr(p.$2, paise: false),
                      when: p.$1,
                      label: p.$3,
                      kind: p.$4 ? PayoutKind.paid : (p.$3.startsWith('NOT') ? PayoutKind.notPaid : PayoutKind.checking),
                    ),
                  const SizedBox(height: 8),
                  const DesiMogra(),
                ],
              ),
            ),
            BookBottomButton(
              label: _busy ? 'SENDING…' : (canAsk ? 'REQUEST PAYOUT' : 'ADD UPI TO START'),
              plum: true,
              icon: null,
              onTap: canAsk ? _request : (onChangeUpi ?? () {}),
            ),
          ],
        ),
      ),
    );
  }
}

/// Add or change the UPI. The server checks the format again and clears any earlier name check.
class _UpiSheet extends StatefulWidget {
  const _UpiSheet({required this.repo, this.current});

  final PayoutsRepo repo;
  final String? current;

  @override
  State<_UpiSheet> createState() => _UpiSheetState();
}

class _UpiSheetState extends State<_UpiSheet> {
  late final _vpa = TextEditingController(text: widget.current ?? '');
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _vpa.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final v = _vpa.text.trim().toLowerCase();
    if (!PayoutsRepo.validUpi(v)) {
      setState(() => _error = 'Enter a valid UPI ID, like name@bank.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final u = await widget.repo.setUpi(v);
      if (mounted) Navigator.of(context).pop(u);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException ? e.userMessage : ApiException.genericText;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // [HF-APP-DESI-9] cream sheet like the call confirm sheet
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: CallSheetFrame(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(widget.current == null ? 'Add your UPI' : 'Change your UPI', style: t(24, color: C.maroon, w: FontWeight.w900)),
              const SizedBox(height: 6),
              Text('Your payouts go here. Use a UPI ID in your own name.', style: t(14, color: C.muted, w: FontWeight.w700, h: 1.35)),
              const SizedBox(height: 12),
              TextField(
                controller: _vpa,
                autofocus: true,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                style: t(20, w: FontWeight.w800),
                decoration: const InputDecoration(hintText: 'name@bank'),
              ),
              if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: t(14, color: C.ruby, w: FontWeight.w700))),
              const SizedBox(height: 16),
              MoneyPill(label: _busy ? 'SAVING…' : 'SAVE UPI', onTap: _busy ? null : _save),
            ],
          ),
        ),
      ),
    );
  }
}

/// Shown when a first payout needs the ID check: "We check your ID once, before your first payout."
/// The check itself lives on the website (no in-app KYC route yet), so the button opens it in a Custom Tab.
class PayoutKycScreen extends StatelessWidget {
  const PayoutKycScreen({super.key, required this.step});

  final KycNextStep step;

  /// [HF-APP-DESI-9] approved "ID check" layout.
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.ivory,
      body: SafeArea(
        child: Column(
          children: [
            const BookHeader('ID check'),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                children: [
                  KycHero(title: step.title),
                  const SizedBox(height: 12),
                  for (final (i, line) in const [
                    'You only do this once. Joining and getting calls never needed it.',
                    'It takes a few minutes. Keep your Aadhaar mobile number handy.',
                    'When it is done, come back and request your payout again.',
                  ].indexed)
                    KycStep(n: i + 1, text: line),
                  const SizedBox(height: 8),
                  const DesiMogra(),
                ],
              ),
            ),
            BookBottomButton(
              label: 'CHECK MY ID',
              plum: true,
              icon: null,
              onTap: () async {
                final url = step.url;
                final ok = url != null && await Checkout.open(url);
                if (!ok && context.mounted) toast(context, 'Could not open the page. Please try again.');
              },
            ),
          ],
        ),
      ),
    );
  }
}
