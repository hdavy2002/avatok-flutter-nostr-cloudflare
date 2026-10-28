import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/api_exception.dart';
import '../../data/in_app_checkout.dart';
import '../../data/models/wallet.dart';
import '../../data/repos/wallet_repo.dart';
import '../../data/telemetry.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-WIRE-21] / HF-REEL-39: the whole checkout, on our own screens. No browser, no Custom Tab, no provider page.
///
///   Your details (only if name / email / WhatsApp number is missing)
///     -> Choose how to pay: UPI apps on this phone | a UPI ID | a card
///     -> (UPI ID) Approve the request in your UPI app, with a countdown
///     -> (card)   Card form
///     -> Processing -> the Payment screen, which asks the server (the signed webhook is the only thing that credits).
///
/// Card numbers are typed into the payment SDK's own field; expiry, CVV and the name go to the SDK in the same call. None of it is
/// logged, stored or sent to our server. The UI never names the payment provider.
class CheckoutProfile {
  const CheckoutProfile({this.name, this.email, this.phoneVerified = true, this.phoneMasked});

  final String? name;
  final String? email;

  /// False only when we KNOW the WhatsApp number is not verified (a profile that failed to load must not block paying).
  final bool phoneVerified;
  final String? phoneMasked;
}

enum _Stage { details, methods, upiWait, card, processing }

class CheckoutFlow extends StatefulWidget {
  const CheckoutFlow({
    super.key,
    required this.rupees,
    required this.repo,
    required this.checkout,
    required this.profile,
    required this.onFinish,
    required this.onClose,
    this.callId,
    this.onProfileSaved,
    this.onVerifyPhone,
    this.collectWindow = const Duration(minutes: 5),
    this.pollEvery = const Duration(seconds: 3),
  });

  final int rupees;
  final String? callId;
  final WalletRepo repo;
  final InAppCheckout checkout;
  final CheckoutProfile profile;

  /// Go to the Payment screen: `/payment?amount=..&order=..&credit=..[&sdk=err]`.
  final void Function(String location) onFinish;

  /// Back to the amount screen.
  final VoidCallback onClose;
  final VoidCallback? onProfileSaved;
  final VoidCallback? onVerifyPhone;

  /// How long a UPI ID request stays open before we say it expired.
  final Duration collectWindow;

  /// How often the waiting screen asks the server whether the payment arrived.
  final Duration pollEvery;

  @override
  State<CheckoutFlow> createState() => _CheckoutFlowState();
}

class _CheckoutFlowState extends State<CheckoutFlow> {
  static const _notAvailable = 'This payment method is not available right now. Please try another way to pay.';
  static const _notCompleted = 'The payment was not completed. If money left your account, it is added to your wallet within a few minutes.';
  static const _cardDeclined = 'Your card was not accepted. Check the details, or try another card or another way to pay.';

  late _Stage _stage;
  final _nameC = TextEditingController();
  final _emailC = TextEditingController();
  final _vpaC = TextEditingController();
  final _holderC = TextEditingController();
  final _expC = TextEditingController();
  final _cvvC = TextEditingController();

  String? _name;
  String? _email;
  String? _error;
  bool _checkable = false;
  bool _busy = false;
  bool _finished = false;
  TopupOrder? _order;
  late Future<List<UpiApp>> _apps;

  // UPI ID request
  Timer? _tick;
  Timer? _poll;
  int _left = 0;
  bool _expired = false;
  int _token = 0;
  String _vpa = '';
  bool _asking = false;

  CardEntry? _card;

  /// [HF-CHECKOUT-FALLBACK-1] Set once a way of paying on our own screens is refused (the provider has not switched it on for the
  /// account). From then on every tap opens the provider's own secure checkout inside the app (UPI apps, UPI ID, cards, net
  /// banking), which hands the payer to PhonePe / GPay / Paytm and comes back to us.
  bool _hostedOnly = false;

  @override
  void initState() {
    super.initState();
    final p = widget.profile;
    _name = (p.name ?? '').trim().isEmpty ? null : p.name!.trim();
    _email = (p.email ?? '').trim().isEmpty ? null : p.email!.trim();
    _nameC.text = _name ?? '';
    _emailC.text = _email ?? '';
    final complete = _name != null && isValidPersonName(_name!) && _email != null && isValidEmail(_email!) && p.phoneVerified;
    _stage = complete ? _Stage.methods : _Stage.details;
    _apps = widget.checkout.upiApps().catchError((Object _) => <UpiApp>[]);
  }

  @override
  void dispose() {
    _stopTimers();
    _cvvC.clear();
    for (final c in [_nameC, _emailC, _vpaC, _holderC, _expC, _cvvC]) {
      c.dispose();
    }
    _card?.dispose();
    super.dispose();
  }

  // ------------------------------------------------------------------------------------------- helpers

  String _next(TopupOrder o) => '/payment?amount=${widget.rupees}&order=${o.orderId}&credit=${o.creditPaise}'
      '${widget.callId == null ? '' : '&callId=${Uri.encodeQueryComponent(widget.callId!)}'}';

  void _go(String location) {
    if (_finished) return;
    _finished = true;
    _stopTimers();
    setState(() => _stage = _Stage.processing);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onFinish(location);
    });
  }

  void _fail(String message, {bool check = false}) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = message;
      _checkable = check;
    });
  }

  void _stopTimers() {
    _tick?.cancel();
    _poll?.cancel();
    _tick = null;
    _poll = null;
  }

  void _back() {
    switch (_stage) {
      case _Stage.details:
      case _Stage.methods:
        widget.onClose();
      case _Stage.upiWait:
        _leaveWait();
      case _Stage.card:
        setState(() {
          _stage = _Stage.methods;
          _error = null;
          _cvvC.clear();
        });
      case _Stage.processing:
        break;
    }
  }

  Future<TopupOrder?> _ensureOrder() async {
    final cur = _order;
    if (cur != null) return cur;
    try {
      final o = await widget.repo.createTopup(widget.rupees, name: _name, email: _email, callId: widget.callId);
      if (!mounted) return null;
      Telemetry.event('hf_topup_started', {'amount_rupees': widget.rupees, 'order': o.orderId});
      if (o.orderId.isEmpty) {
        _fail('We could not start the payment. Please try again.');
        return null;
      }
      if (!o.isNative) {
        await _hosted(o);
        return null;
      }
      final sid = o.paymentSessionId;
      if (sid == null || sid.isEmpty) {
        _fail(_notAvailable);
        return null;
      }
      _order = o;
      return o;
    } on ApiException catch (e) {
      _fail(e.code == 'topup_below_call_minimum'
          ? 'The amount needed for this call changed. Go back and check the amount again.'
          : e.code == 'call_not_active' && widget.callId != null
              ? 'This call is no longer active. Return to the call to check its status.'
              : e.userMessage);
      return null;
    }
  }

  /// Only when the server flag `hfCheckoutMode` is "web" (kept in case the seamless modes are not enabled for the merchant).
  Future<void> _hosted(TopupOrder o) async {
    final next = _next(o);
    final sid = o.paymentSessionId;
    if (sid != null && sid.isNotEmpty) {
      final out = await widget.checkout.payHosted(orderId: o.orderId, paymentSessionId: sid, sandbox: o.environment == 'sandbox');
      Telemetry.event('hf_topup_result', {
        'order': o.orderId,
        'result': 'hosted_${out.result.name}',
        'method': 'hosted',
        if (out.message != null) 'detail': out.message!.length > 120 ? out.message!.substring(0, 120) : out.message!,
      });
      if (out.result != PayResult.unavailable) {
        _go(out.result == PayResult.completed ? next : '$next&sdk=err');
        return;
      }
    }
    final url = o.checkoutUrl;
    if (url == null || !await Checkout.open(url)) {
      _fail('We could not open the payment page. Please try again.');
      return;
    }
    _go(next);
  }

  void _outcome(String method, PayOutcome out, TopupOrder o) {
    Telemetry.event('hf_topup_checkout', {'order': o.orderId, 'method': method, 'result': out.result.name});
    switch (out.result) {
      case PayResult.completed:
        _go(_next(o));
      case PayResult.failed:
        if (method == 'card') {
          _fail(_cardDeclined);
        } else {
          _fail(_notCompleted, check: true);
        }
      case PayResult.unavailable:
      case PayResult.notEnabled:
        unawaited(_switchToHosted(o, method, out));
    }
  }

  /// [HF-CHECKOUT-FALLBACK-1] Our own screen could not pay this way, so open the provider's secure checkout for the SAME order inside
  /// the app instead of showing an error. Only if that cannot open either does the payer see "not available right now".
  Future<void> _switchToHosted(TopupOrder o, String from, [PayOutcome? why]) async {
    _hostedOnly = true;
    Telemetry.event('hf_topup_result', {
      'order': o.orderId,
      'result': 'native_refused',
      'method': from,
      'reason': why?.result.name ?? 'no_entry',
      if (why?.message != null) 'detail': why!.message!.length > 120 ? why.message!.substring(0, 120) : why.message!,
    });
    if (!mounted) return;
    setState(() {
      _busy = true;
      _error = null;
      _checkable = false;
      if (_stage == _Stage.card || _stage == _Stage.upiWait) _stage = _Stage.methods;
    });
    final sid = o.paymentSessionId;
    if (sid == null || sid.isEmpty) {
      _fail(_notAvailable);
      return;
    }
    final out = await widget.checkout.payHosted(orderId: o.orderId, paymentSessionId: sid, sandbox: o.environment == 'sandbox');
    if (!mounted) return;
    Telemetry.event('hf_topup_result', {
      'order': o.orderId,
      'result': 'hosted_${out.result.name}',
      'method': 'hosted',
      if (out.message != null) 'detail': out.message!.length > 120 ? out.message!.substring(0, 120) : out.message!,
    });
    switch (out.result) {
      case PayResult.completed:
        _go(_next(o));
      case PayResult.failed:
        _go('${_next(o)}&sdk=err');
      case PayResult.unavailable:
      case PayResult.notEnabled:
        _fail(_notAvailable);
    }
  }

  // ------------------------------------------------------------------------------------------- details

  bool get _detailsOk => isValidPersonName(_nameC.text) && isValidEmail(_emailC.text) && widget.profile.phoneVerified;

  Future<void> _saveDetails() async {
    if (_busy || !_detailsOk) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    _name = _nameC.text.trim().replaceAll(RegExp(r'\s+'), ' ');
    _email = _emailC.text.trim().toLowerCase();
    await widget.repo.saveDetails(name: _name, email: _email);
    widget.onProfileSaved?.call();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _stage = _Stage.methods;
    });
  }

  // ------------------------------------------------------------------------------------------- UPI app

  Future<void> _payWithApp(UpiApp app) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _checkable = false;
    });
    final o = await _ensureOrder();
    if (o == null || !mounted) return;
    if (_hostedOnly) return _switchToHosted(o, 'upi_app');
    final out = await widget.checkout.payWithUpiApp(
      orderId: o.orderId,
      paymentSessionId: o.paymentSessionId!,
      sandbox: o.environment == 'sandbox',
      appId: app.id,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    _outcome('upi_app', out, o);
  }

  // ------------------------------------------------------------------------------------------- UPI ID

  Future<void> _sendRequest() async {
    if (_busy) return;
    final vpa = _vpaC.text.trim();
    if (!isValidUpiId(vpa)) {
      setState(() => _error = 'Enter a UPI ID like name@bank.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _checkable = false;
    });
    final o = await _ensureOrder();
    if (o == null || !mounted) return;
    if (_hostedOnly) return _switchToHosted(o, 'upi_id');
    final token = ++_token;
    setState(() {
      _busy = false;
      _vpa = vpa;
      _expired = false;
      _left = widget.collectWindow.inSeconds;
      _stage = _Stage.upiWait;
    });
    _stopTimers();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || token != _token) return;
      if (_left <= 1) {
        _expire();
      } else {
        setState(() => _left--);
      }
    });
    _poll = Timer.periodic(widget.pollEvery, (_) => _ask(o, token));
    final out = await widget.checkout.payWithUpiId(
      orderId: o.orderId,
      paymentSessionId: o.paymentSessionId!,
      sandbox: o.environment == 'sandbox',
      vpa: vpa,
    );
    if (!mounted || token != _token) return;
    Telemetry.event('hf_topup_checkout', {'order': o.orderId, 'method': 'upi_id', 'result': out.result.name});
    switch (out.result) {
      case PayResult.completed:
        // The SDK says the request went through / was approved; only the server can say money arrived, so ask now.
        unawaited(_ask(o, token));
      case PayResult.failed:
        _stopTimers();
        _order = null;
        _token++;
        setState(() {
          _stage = _Stage.methods;
          _error = 'The request was declined or could not be sent. Check the UPI ID, or try another way to pay.';
        });
      case PayResult.unavailable:
      case PayResult.notEnabled:
        _stopTimers();
        _token++;
        await _switchToHosted(o, 'upi_id', out);
    }
  }

  Future<void> _ask(TopupOrder o, int token) async {
    if (_asking || !mounted || token != _token) return;
    _asking = true;
    try {
      final st = await widget.repo.status(o.orderId);
      if (!mounted || token != _token) return;
      if (st.state == TopupState.paid) {
        _go(_next(o));
      } else if (st.state == TopupState.failed) {
        _stopTimers();
        _order = null;
        _token++;
        setState(() {
          _stage = _Stage.methods;
          _error = 'The payment did not go through. No money was taken.';
        });
      }
    } catch (_) {
      // a failed look is not a failed payment: keep waiting
    } finally {
      _asking = false;
    }
  }

  void _expire() {
    _stopTimers();
    _token++;
    if (mounted) {
      setState(() {
        _left = 0;
        _expired = true;
      });
    }
  }

  void _leaveWait() {
    _stopTimers();
    _token++;
    setState(() {
      _stage = _Stage.methods;
      _error = null;
    });
  }

  Future<void> _sendAgain() async {
    _order = null;
    await _sendRequest();
  }

  // ------------------------------------------------------------------------------------------- card

  Future<void> _openCard() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _checkable = false;
    });
    final o = await _ensureOrder();
    if (o == null || !mounted) return;
    if (_hostedOnly) return _switchToHosted(o, 'card');
    final entry = widget.checkout.cardEntry(orderId: o.orderId, paymentSessionId: o.paymentSessionId!, sandbox: o.environment == 'sandbox');
    if (entry == null) {
      await _switchToHosted(o, 'card');
      return;
    }
    _card?.dispose();
    _card = entry;
    if (_holderC.text.trim().isEmpty) _holderC.text = _name ?? '';
    setState(() {
      _busy = false;
      _stage = _Stage.card;
    });
  }

  bool get _cardFormOk => parseCardExpiry(_expC.text) != null && isValidCvv(_cvvC.text) && isValidPersonName(_holderC.text);

  Future<void> _payCard() async {
    final card = _card;
    final exp = parseCardExpiry(_expC.text);
    final o = _order;
    if (_busy || card == null || exp == null || o == null || !_cardFormOk) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final out = await card.pay(holder: _holderC.text.trim(), mm: exp.mm, yy: exp.yy, cvv: _cvvC.text);
    _cvvC.clear();
    if (!mounted) return;
    setState(() => _busy = false);
    _outcome('card', out, o);
  }

  // ------------------------------------------------------------------------------------------- build

  InputDecoration _dec(String label, {String? hint}) => InputDecoration(
        labelText: label,
        hintText: hint,
        labelStyle: t(15, color: C.muted, w: FontWeight.w700),
        hintStyle: t(15, color: C.muted, w: FontWeight.w600),
        filled: true,
        fillColor: C.paper,
        counterText: '',
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: C.deep, width: 3)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: C.deep, width: 3)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: C.marigold, width: 3)),
      );

  Widget _label(String s) => Padding(
        padding: const EdgeInsets.fromLTRB(2, 18, 0, 8),
        child: Text(s, style: t(14, color: C.tan, ls: 0.08)),
      );

  Widget _errorBox() {
    final e = _error;
    if (e == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Container(
        key: const Key('checkout-error'),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: C.sand, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.ruby, width: 2)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(e, style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
            if (_checkable && _order != null) ...[
              const SizedBox(height: 10),
              ChunkyButton(
                key: const Key('check-payment'),
                label: 'CHECK MY PAYMENT',
                filled: false,
                height: 48,
                onTap: () => _go('${_next(_order!)}&sdk=err'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _shell({required Widget title, required List<Widget> children, bool showBack = true}) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Column(
        children: [
          if (showBack)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Semantics(
                  button: true,
                  label: 'Back',
                  child: GestureDetector(
                    key: const Key('checkout-back'),
                    onTap: _back,
                    behavior: HitTestBehavior.opaque,
                    child: const SizedBox(
                      width: 48,
                      height: 48,
                      child: Center(
                        child: DecoratedBox(
                          decoration: BoxDecoration(shape: BoxShape.circle, color: C.sand),
                          child: SizedBox(width: 44, height: 44, child: Icon(Icons.arrow_back_rounded, color: C.deep)),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
              children: [title, ...children],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    switch (_stage) {
      case _Stage.details:
        return _detailsView();
      case _Stage.methods:
        return _methodsView();
      case _Stage.upiWait:
        return _waitView();
      case _Stage.card:
        return _cardView();
      case _Stage.processing:
        return _processingView();
    }
  }

  Widget _detailsView() {
    final p = widget.profile;
    return _shell(
      title: const Headline(solid: 'YOUR', outline: 'DETAILS', size: 44),
      children: [
        const SizedBox(height: 10),
        Text('Your receipt needs your name, email and phone number.', style: t(15, w: FontWeight.w700, h: 1.4)),
        _label('NAME'),
        TextField(
          key: const Key('details-name'),
          controller: _nameC,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.next,
          autofillHints: const [AutofillHints.name],
          onChanged: (_) => setState(() {}),
          style: t(17, w: FontWeight.w700),
          decoration: _dec('Your full name'),
        ),
        _label('EMAIL'),
        TextField(
          key: const Key('details-email'),
          controller: _emailC,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          onChanged: (_) => setState(() {}),
          style: t(17, w: FontWeight.w700),
          decoration: _dec('Your email address'),
        ),
        _label('PHONE'),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.sandLine, width: 2)),
          child: Row(
            children: [
              Icon(p.phoneVerified ? Icons.verified_rounded : Icons.info_outline_rounded, color: p.phoneVerified ? C.brassDark : C.ruby),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  p.phoneVerified
                      ? 'WhatsApp number ${p.phoneMasked ?? 'verified'}'
                      : 'Your WhatsApp number is not verified yet. Verify it to add money.',
                  key: const Key('details-phone'),
                  style: t(15, w: FontWeight.w700, h: 1.35),
                ),
              ),
            ],
          ),
        ),
        if (!p.phoneVerified && widget.onVerifyPhone != null) ...[
          const SizedBox(height: 10),
          ChunkyButton(key: const Key('verify-phone'), label: 'VERIFY MY NUMBER', filled: false, height: 48, onTap: widget.onVerifyPhone),
        ],
        _errorBox(),
        const SizedBox(height: 22),
        ChunkyButton(
          key: const Key('details-continue'),
          label: _busy ? 'PLEASE WAIT…' : 'CONTINUE',
          dark: true,
          onTap: (_detailsOk && !_busy) ? _saveDetails : null,
        ),
      ],
    );
  }

  Widget _methodsView() {
    return _shell(
      title: const Headline(solid: 'CHOOSE HOW', outline: 'TO PAY', size: 40),
      children: [
        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: C.deep, borderRadius: BorderRadius.circular(14)),
          child: Row(
            children: [
              Expanded(child: Text('You pay', style: t(16, color: C.cream, w: FontWeight.w700))),
              Text(inr(widget.rupees, paise: false), key: const Key('pay-amount'), style: t(24, color: C.gold)),
            ],
          ),
        ),
        _label('UPI APPS ON THIS PHONE'),
        FutureBuilder<List<UpiApp>>(
          future: _apps,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Padding(
                padding: EdgeInsets.symmetric(vertical: 14),
                child: Center(child: SizedBox(width: 28, height: 28, child: CircularProgressIndicator(color: C.marigold, strokeWidth: 4))),
              );
            }
            final apps = snap.data ?? const <UpiApp>[];
            if (apps.isEmpty) {
              return Text(
                'No UPI app found on this phone. You can pay with a UPI ID or a card below.',
                key: const Key('no-upi-apps'),
                style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4),
              );
            }
            return Column(children: [for (final a in apps) _appTile(a)]);
          },
        ),
        _label('PAY WITH UPI ID'),
        TextField(
          key: const Key('upi-id-field'),
          controller: _vpaC,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _sendRequest(),
          style: t(17, w: FontWeight.w700),
          decoration: _dec('UPI ID', hint: 'name@bank'),
        ),
        const SizedBox(height: 10),
        ChunkyButton(key: const Key('send-request'), label: 'SEND PAYMENT REQUEST', filled: false, height: 52, onTap: _busy ? null : _sendRequest),
        _label('CARD'),
        _tile(
          key: const Key('pay-card-tile'),
          leading: const Icon(Icons.credit_card_rounded, color: C.maroon, size: 30),
          title: 'Debit or credit card',
          onTap: _busy ? null : _openCard,
        ),
        _errorBox(),
        if (_busy)
          const Padding(
            padding: EdgeInsets.only(top: 18),
            child: Center(child: SizedBox(width: 30, height: 30, child: CircularProgressIndicator(color: C.marigold, strokeWidth: 4))),
          ),
        const SizedBox(height: 18),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.lock_rounded, size: 18, color: C.muted),
            const SizedBox(width: 6),
            Flexible(child: Text('Secure payment. Your card details never touch our servers.', textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700))),
          ],
        ),
      ],
    );
  }

  Widget _tile({Key? key, required Widget leading, required String title, required VoidCallback? onTap}) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Material(
          key: key,
          color: C.paper,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: C.deep, width: 3)),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 60),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                child: Row(
                  children: [
                    SizedBox(width: 40, height: 40, child: Center(child: leading)),
                    const SizedBox(width: 12),
                    Expanded(child: Text(title, style: t(17))),
                    const Icon(Icons.arrow_forward_rounded, color: C.maroon),
                  ],
                ),
              ),
            ),
          ),
        ),
      );

  Widget _appTile(UpiApp a) => _tile(
        key: Key('upi-app-${a.id}'),
        leading: a.icon != null
            ? Image.memory(a.icon!, width: 38, height: 38, errorBuilder: (_, __, ___) => const Icon(Icons.account_balance_wallet_rounded, color: C.maroon, size: 30))
            : const Icon(Icons.account_balance_wallet_rounded, color: C.maroon, size: 30),
        title: a.name,
        onTap: _busy ? null : () => _payWithApp(a),
      );

  String get _clock {
    final m = _left ~/ 60;
    final s = (_left % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  Widget _waitView() {
    return _shell(
      title: const Headline(solid: 'APPROVE', outline: 'IT', size: 44),
      children: [
        const SizedBox(height: 14),
        if (!_expired) ...[
          const Center(child: SizedBox(width: 64, height: 64, child: CircularProgressIndicator(color: C.marigold, strokeWidth: 6))),
          const SizedBox(height: 22),
          Text('Approve the request in your UPI app', key: const Key('wait-title'), textAlign: TextAlign.center, style: t(22, color: C.maroon, h: 1.3)),
          const SizedBox(height: 10),
          Text(
            'We sent a request for ${inr(widget.rupees, paise: false)} to $_vpa. Open your UPI app and approve it.',
            textAlign: TextAlign.center,
            style: t(16, w: FontWeight.w700, h: 1.45),
          ),
          const SizedBox(height: 18),
          Center(child: Text('Time left $_clock', key: const Key('wait-left'), style: t(20, color: C.deep))),
          const SizedBox(height: 28),
          ChunkyButton(key: const Key('wait-cancel'), label: 'CANCEL', filled: false, onTap: _leaveWait),
        ] else ...[
          const Icon(Icons.timer_off_rounded, color: C.maroon, size: 64),
          const SizedBox(height: 16),
          Text('The request expired', key: const Key('wait-expired'), textAlign: TextAlign.center, style: t(22, color: C.maroon, h: 1.3)),
          const SizedBox(height: 10),
          Text(
            'No money was taken. If you approved it just now, your wallet is updated within a few minutes.',
            textAlign: TextAlign.center,
            style: t(16, w: FontWeight.w700, h: 1.45),
          ),
          const SizedBox(height: 28),
          ChunkyButton(key: const Key('wait-again'), label: 'SEND AGAIN', onTap: _sendAgain),
          const SizedBox(height: 10),
          ChunkyButton(key: const Key('wait-other'), label: 'CHOOSE ANOTHER WAY', filled: false, onTap: _leaveWait),
        ],
      ],
    );
  }

  Widget _cardView() {
    final card = _card;
    final numberOk = card?.numberOk;
    return _shell(
      title: const Headline(solid: 'PAY BY', outline: 'CARD', size: 44),
      children: [
        const SizedBox(height: 10),
        Text('Pay ${inr(widget.rupees, paise: false)} with your debit or credit card.', style: t(16, w: FontWeight.w700, h: 1.4)),
        _label('CARD NUMBER'),
        if (card != null)
          card.field(decoration: _dec('Card number'), style: t(17, w: FontWeight.w700)),
        const SizedBox(height: 4),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: TextField(
                key: const Key('card-expiry'),
                controller: _expC,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, _ExpiryFormatter()],
                onChanged: (_) => setState(() {}),
                style: t(17, w: FontWeight.w700),
                decoration: _dec('Expiry', hint: 'MM/YY'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                key: const Key('card-cvv'),
                controller: _cvvC,
                keyboardType: TextInputType.number,
                obscureText: true,
                enableSuggestions: false,
                autocorrect: false,
                maxLength: 4,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                onChanged: (_) => setState(() {}),
                style: t(17, w: FontWeight.w700),
                decoration: _dec('CVV'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        TextField(
          key: const Key('card-holder'),
          controller: _holderC,
          textCapitalization: TextCapitalization.words,
          autocorrect: false,
          onChanged: (_) => setState(() {}),
          style: t(17, w: FontWeight.w700),
          decoration: _dec('Name on card'),
        ),
        _errorBox(),
        const SizedBox(height: 20),
        if (numberOk != null)
          ValueListenableBuilder<bool>(
            valueListenable: numberOk,
            builder: (context, ok, _) => ChunkyButton(
              key: const Key('card-pay'),
              label: _busy ? 'PLEASE WAIT…' : 'PAY ${inr(widget.rupees, paise: false)}',
              dark: true,
              onTap: (ok && _cardFormOk && !_busy) ? _payCard : null,
            ),
          ),
        const SizedBox(height: 14),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.lock_rounded, size: 18, color: C.muted),
            const SizedBox(width: 6),
            Flexible(child: Text('Your card details are not stored on our servers.', textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700))),
          ],
        ),
      ],
    );
  }

  Widget _processingView() => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(width: 64, height: 64, child: CircularProgressIndicator(color: C.marigold, strokeWidth: 6)),
              const SizedBox(height: 24),
              Text('Processing your payment…', key: const Key('processing'), textAlign: TextAlign.center, style: t(20, color: C.maroon)),
            ],
          ),
        ),
      );
}

/// Types "1227" as "12/27".
class _ExpiryFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    var d = newValue.text.replaceAll(RegExp(r'\D'), '');
    if (d.length > 4) d = d.substring(0, 4);
    final text = d.length > 2 ? '${d.substring(0, 2)}/${d.substring(2)}' : d;
    return TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
  }
}
