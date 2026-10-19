import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

// ---------------------------------------------------------------------------------------------- Wallet

/// Wallet — the shop counter: balance, Top up / Withdraw, history.
class WalletScreen extends StatelessWidget {
  const WalletScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListenableBuilder(
        listenable: demo,
        builder: (context, _) => ListView(
          padding: EdgeInsets.zero,
          children: [
            Container(
              padding: EdgeInsets.fromLTRB(20, MediaQuery.paddingOf(context).top + 12, 20, 24),
              decoration: const BoxDecoration(color: C.maroon, borderRadius: BorderRadius.vertical(bottom: Radius.circular(32))),
              child: Column(
                children: [
                  Row(
                    children: [
                      const BackBtn(dark: true),
                      Expanded(child: Text('MY WALLET', textAlign: TextAlign.center, style: t(15, color: C.gold, ls: 0.2))),
                      const SizedBox(width: 44),
                    ],
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 160,
                    width: 310,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        Positioned.fill(
                          child: Art(
                            'wallet/counter-board.webp',
                            fallback: Container(
                              decoration: BoxDecoration(
                                color: C.deep,
                                border: Border.all(color: C.brass, width: 5),
                                borderRadius: const BorderRadius.vertical(top: Radius.circular(155), bottom: Radius.circular(14)),
                              ),
                            ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(top: 30),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text('YOUR BALANCE', style: t(13, color: C.gold, ls: 0.16)),
                              FittedBox(child: Text(inr(demo.balance), style: t(44, color: C.ivory, h: 1.05))),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  Row(
                    children: [
                      Expanded(child: ChunkyButton(label: 'TOP UP', icon: Icons.add_rounded, onTap: () => context.push('/topup'))),
                      const SizedBox(width: 12),
                      Expanded(child: ChunkyButton(label: 'WITHDRAW', filled: false, dark: true, onTap: () => context.push('/payout'))),
                    ],
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 22, 22, 10),
              child: Row(
                children: [
                  Expanded(child: Text('History', style: t(22, color: C.maroon))),
                  Text('Latest first', style: t(14, color: C.tan)),
                ],
              ),
            ),
            for (final x in demo.txns)
              Container(
                margin: const EdgeInsets.fromLTRB(22, 0, 22, 10),
                height: 64,
                decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(12), border: Border.all(color: C.sand, width: 2)),
                clipBehavior: Clip.antiAlias,
                child: Row(
                  children: [
                    Container(width: 10, color: x.amount < 0 ? C.ruby : C.marigold),
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(x.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16)),
                            Text(x.sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(13, color: C.muted, w: FontWeight.w700)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 2, child: DashedLine(color: C.sandLine, width: 2)),
                    SizedBox(
                      width: 108,
                      child: Center(child: Text(inr(x.amount, sign: true), style: t(15, color: x.amount < 0 ? C.ruby : C.maroon))),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Top up

/// Top up: any whole amount; price includes 18% GST, wallet gets paid ÷ 1.18 (HF-PAY rules).
/// The payment page itself is the gateway's; the app never names the gateway.
class TopUpScreen extends StatefulWidget {
  const TopUpScreen({super.key});

  @override
  State<TopUpScreen> createState() => _TopUpScreenState();
}

class _TopUpScreenState extends State<TopUpScreen> {
  final _amount = TextEditingController(text: '500');

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
      final ok = await showDialog<bool>(
        context: context,
        builder: (d) => AlertDialog(
          backgroundColor: C.ivory,
          title: Text('Pay ${inr(v, paise: false)}?', style: t(22, color: C.maroon)),
          content: Text('That is ₹1,000 or more. Just checking before we open the payment page.', style: t(15, w: FontWeight.w700, h: 1.4)),
          actions: [
            TextButton(onPressed: () => Navigator.of(d).pop(false), child: Text('Change', style: t(16, color: C.maroon))),
            TextButton(onPressed: () => Navigator.of(d).pop(true), child: Text('Yes, pay', style: t(16, color: C.maroon))),
          ],
        ),
      );
      if (ok != true || !mounted) return;
    }
    if (!mounted) return;
    context.pushReplacement('/payment?amount=$v');
  }

  @override
  Widget build(BuildContext context) {
    final v = _value;
    final credit = DemoState.creditFor(v.toDouble());
    final gst = v - credit;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const Padding(padding: EdgeInsets.fromLTRB(16, 12, 16, 0), child: Align(alignment: Alignment.centerLeft, child: BackBtn())),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 8, 22, 16),
                children: [
                  const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: Headline(solid: 'TOP', outline: 'UP', size: 50)),
                      SizedBox(width: 120, height: 110, child: Art('topup/thread-spools.webp', fallback: ArtStandIn('THREAD SPOOLS', color: C.ivory, ink: C.brassDark))),
                    ],
                  ),
                  const SizedBox(height: 18),
                  Text('How much do you want to pay?', style: t(15)),
                  const SizedBox(height: 8),
                  Container(
                    decoration: const BoxDecoration(boxShadow: [BoxShadow(color: C.deep, offset: Offset(6, 6))], borderRadius: BorderRadius.all(Radius.circular(18))),
                    child: TextField(
                      controller: _amount,
                      keyboardType: TextInputType.number,
                      onChanged: (_) => setState(() {}),
                      style: t(40, w: FontWeight.w800),
                      decoration: InputDecoration(
                        prefixIcon: Padding(padding: const EdgeInsets.only(left: 16, right: 6), child: Text('₹', style: t(38, color: C.maroon))),
                        prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(18), borderSide: const BorderSide(color: C.deep, width: 4)),
                        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(18), borderSide: const BorderSide(color: C.deep, width: 4)),
                        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(18), borderSide: const BorderSide(color: C.marigold, width: 4)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      for (final a in [100, 250, 500, 1000]) ...[
                        Expanded(
                          child: GestureDetector(
                            onTap: () => setState(() => _amount.text = '$a'),
                            child: Container(
                              height: 50,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: v == a ? C.maroon : C.paper,
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(color: C.maroon, width: 3),
                              ),
                              child: Text(inr(a, paise: false), style: t(15, color: v == a ? C.gold : C.maroon)),
                            ),
                          ),
                        ),
                        if (a != 1000) const SizedBox(width: 8),
                      ],
                    ],
                  ),
                  const SizedBox(height: 18),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(16)),
                    child: Column(
                      children: [
                        _line('You pay', inr(v), C.ivory),
                        const SizedBox(height: 8),
                        _line('GST (18%, included)', inr(gst), C.cream),
                        const SizedBox(height: 8),
                        const SizedBox(height: 2, width: double.infinity, child: DashedLine(vertical: false, color: C.brass, width: 2)),
                        const SizedBox(height: 8),
                        _line('Added to wallet', inr(credit), C.gold, big: true),
                      ],
                    ),
                  ),
                  if (v >= 1000) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(12), border: Border.all(color: C.marigold, width: 2)),
                      child: Text("That's ₹1,000 or more. We'll ask you to confirm once more.", style: t(14, h: 1.4)),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.lock_rounded, size: 18, color: C.muted),
                      const SizedBox(width: 6),
                      Text('Secure payment · UPI, cards and netbanking', style: t(14, color: C.muted, w: FontWeight.w700)),
                    ],
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 0, 22, 20),
              child: TicketButton(label: 'PAY ${inr(v, paise: false)}', stubIcon: Icons.arrow_forward_rounded, onTap: _pay),
            ),
          ],
        ),
      ),
    );
  }

  Widget _line(String a, String b, Color c, {bool big = false}) => Row(
        children: [
          Expanded(child: Text(a, style: t(16, color: c, w: FontWeight.w700))),
          Text(b, style: t(big ? 24 : 16, color: c)),
        ],
      );
}

/// Stand-in for the gateway's payment page: "processing" then "success".
class PaymentScreen extends StatefulWidget {
  const PaymentScreen({super.key, required this.amount});

  final double amount;

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> {
  bool _done = false;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer(const Duration(seconds: 2), () {
      demo.topUp(widget.amount);
      if (mounted) setState(() => _done = true);
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final credit = DemoState.creditFor(widget.amount);
    return PopScope(
      canPop: _done,
      child: Scaffold(
        backgroundColor: _done ? C.ivory : C.cinema,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              children: [
                const Spacer(),
                if (!_done) ...[
                  const SizedBox(width: 64, height: 64, child: CircularProgressIndicator(color: C.marigold, strokeWidth: 6)),
                  const SizedBox(height: 24),
                  Text('Opening secure payment…', style: t(20, color: C.gold)),
                  const SizedBox(height: 8),
                  Text('Demo: no real money moves.', style: t(15, color: C.cream, w: FontWeight.w700)),
                ] else ...[
                  const BrassKnob(label: 'Paid', size: 110, child: Icon(Icons.check_rounded, color: C.deep, size: 60)),
                  const SizedBox(height: 22),
                  Text('Paid ${inr(widget.amount, paise: false)}', style: t(32, color: C.maroon)),
                  const SizedBox(height: 8),
                  Text('${inr(credit)} added to your wallet', style: t(18, color: C.deep)),
                  const SizedBox(height: 6),
                  Text('Receipt sent on WhatsApp and email.', style: t(15, color: C.muted, w: FontWeight.w700)),
                ],
                const Spacer(),
                if (_done)
                  SizedBox(width: double.infinity, child: ChunkyButton(label: 'BACK TO WALLET', dark: true, onTap: () => context.pushReplacement('/wallet'))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------- Payout

/// Payout: withdraw to UPI. ₹500 minimum, 7-day hold, checked by hand, UTR on WhatsApp.
class PayoutScreen extends StatefulWidget {
  const PayoutScreen({super.key});

  @override
  State<PayoutScreen> createState() => _PayoutScreenState();
}

class _PayoutScreenState extends State<PayoutScreen> {
  late final _amount = TextEditingController(text: demo.earningsReady.toStringAsFixed(0));

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  void _request() {
    final v = double.tryParse(_amount.text.replaceAll(RegExp(r'[^0-9.]'), '')) ?? 0;
    if (v < 500) {
      toast(context, 'Minimum payout is ₹500.');
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) => Column(
            children: [
              const Padding(padding: EdgeInsets.fromLTRB(16, 12, 16, 0), child: Align(alignment: Alignment.centerLeft, child: BackBtn())),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(22, 8, 22, 16),
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Headline(solid: 'PAY', outline: 'OUT', size: 46),
                              const SizedBox(height: 4),
                              Text('Send your money to your UPI.', style: t(16, color: C.muted, w: FontWeight.w700)),
                            ],
                          ),
                        ),
                        const SizedBox(width: 110, height: 100, child: Art('payout/potli-bag.webp', fallback: ArtStandIn('POTLI BAG', color: C.ivory, ink: C.brassDark))),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(child: _box('READY TO WITHDRAW', inr(demo.earningsReady, paise: false), dark: true)),
                        const SizedBox(width: 10),
                        Expanded(child: _box('ON HOLD · 7 DAYS', inr(demo.earningsHold, paise: false))),
                      ],
                    ),
                    const SizedBox(height: 18),
                    Text('Amount (minimum ₹500)', style: t(15)),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _amount,
                      keyboardType: TextInputType.number,
                      style: t(32),
                      decoration: InputDecoration(
                        prefixText: '₹ ',
                        prefixStyle: t(30, color: C.maroon),
                        suffixIcon: Padding(
                          padding: const EdgeInsets.all(8),
                          child: TextButton(
                            style: TextButton.styleFrom(backgroundColor: C.gold, shape: const StadiumBorder()),
                            onPressed: () => _amount.text = demo.earningsReady.toStringAsFixed(0),
                            child: Text('ALL', style: t(14)),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.brass, width: 2)),
                      child: Row(
                        children: [
                          BrassKnob(label: 'UPI', size: 42, child: Text('UPI', style: t(12))),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(demo.name.isEmpty ? 'yourname@okbank' : '${demo.name.split(' ').first.toLowerCase()}@okhdfcbank', style: t(16)),
                                Text('Checked · name matches', style: t(13, color: C.muted, w: FontWeight.w700)),
                              ],
                            ),
                          ),
                          TextButton(onPressed: () => toast(context, 'Change UPI (demo)'), child: Text('Change', style: t(14, color: C.maroon))),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    for (final line in [
                      'We check every request by hand and pay it to your UPI.',
                      'You get the payment reference (UTR) on WhatsApp.',
                      'Test credits can be spent but not withdrawn.',
                    ])
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('●  ', style: t(13, color: C.ruby)),
                            Expanded(child: Text(line, style: t(14, color: C.deep, w: FontWeight.w700, h: 1.4))),
                          ],
                        ),
                      ),
                    const SizedBox(height: 14),
                    Text('Past payouts', style: t(18, color: C.maroon)),
                    const SizedBox(height: 6),
                    for (final p in demo.payouts)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Row(
                          children: [
                            Expanded(child: Text('${p.when} · ${inr(p.amount, paise: false)}', style: t(15))),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                              decoration: BoxDecoration(color: p.status.startsWith('PAID') ? C.deep : C.butter, borderRadius: BorderRadius.circular(999)),
                              child: Text(p.status, style: t(12, color: p.status.startsWith('PAID') ? C.gold : C.deep, ls: 0.06)),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 20),
                child: SizedBox(width: double.infinity, child: ChunkyButton(label: 'REQUEST PAYOUT', dark: true, height: 62, onTap: _request)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _box(String label, String value, {bool dark = false}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: dark ? C.maroon : C.paper,
        borderRadius: BorderRadius.circular(16),
        border: dark ? null : Border.all(color: C.sand, width: 3),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: t(11, color: dark ? C.gold : C.tan, ls: 0.12)),
          const SizedBox(height: 4),
          FittedBox(child: Text(value, style: t(28, color: dark ? C.ivory : C.maroon))),
        ],
      ),
    );
  }
}
