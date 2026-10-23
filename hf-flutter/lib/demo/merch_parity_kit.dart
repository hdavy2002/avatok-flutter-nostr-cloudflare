import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../data/api_exception.dart';
import '../data/models/merch.dart';
import '../data/repos/merch_repo.dart';
import 'desi.dart';
import 'merch_kit.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-PARITY-MERCH-1] Merch pieces the website has and the app was missing: the GST invoice download, the order tracker, the
/// optional GSTIN box and the wording for a short wallet. Kept apart from merch_kit.dart so that file stays as it was.

// ------------------------------------------------------------------------------------------------ GST invoice

/// Downloads the GST invoice PDF of a paid order and hands it to the phone's share sheet (save to Drive or Files, open in a PDF app,
/// send by WhatsApp). The invoice needs the sign-in token, so it is fetched through the API client and written to the app's cache
/// first; a plain link would be refused. Sends `merch_receipt_opened {order_id, ok}`.
Future<void> openMerchReceipt(BuildContext context, MerchRepo repo, FanOrder o) async {
  final url = o.receiptUrl;
  if (url == null || url.isEmpty) return;
  var ok = false;
  String? problem;
  try {
    final bytes = await repo.receiptBytes(url);
    final safe = o.orderNo.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
    final file = File('${Directory.systemTemp.path}/gst-invoice-$safe.pdf');
    await file.writeAsBytes(bytes, flush: true);
    await Share.shareXFiles([XFile(file.path, mimeType: 'application/pdf')], subject: 'GST invoice ${o.orderNo}');
    ok = true;
  } on ApiException catch (e) {
    problem = e.isOffline ? e.userMessage : 'We could not get the invoice. Please try again in a little while.';
  } catch (_) {
    problem = 'We could not open the invoice. Please try again.';
  }
  merchEvent('merch_receipt_opened', {'order_id': o.id, 'ok': ok});
  if (problem != null && context.mounted) toast(context, problem);
}

// ------------------------------------------------------------------------------------------------ tracker

/// Placed, Approved, Printing, Shipped, Delivered: the five steps of the website's order tracker. Shows nothing for an order that is
/// waiting for payment, cancelled or refunded.
class MerchTracker extends StatelessWidget {
  const MerchTracker(this.status, {super.key});

  final String status;

  static const List<String> steps = ['Placed', 'Approved', 'Printing', 'Shipped', 'Delivered'];
  static const Map<String, int> _index = {'placed': 0, 'approved': 1, 'printing': 2, 'shipped': 3, 'delivered': 4};

  @override
  Widget build(BuildContext context) {
    final now = _index[status];
    if (now == null) return const SizedBox.shrink();
    return Semantics(
      label: 'Order progress: ${steps[now]}',
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (var i = 0; i < steps.length; i++)
          Expanded(
            child: Column(children: [
              Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: BoxDecoration(shape: BoxShape.circle, color: i <= now ? C.peacock : C.white, border: Border.all(color: i <= now ? C.peacock : C.line, width: 2)),
                child: i <= now ? const Icon(Icons.check_rounded, size: 18, color: C.white) : Text('${i + 1}', style: t(13, color: C.muted)),
              ),
              const SizedBox(height: 4),
              Text(steps[i], textAlign: TextAlign.center, style: t(12, color: i == now ? C.maroon : C.muted, w: i == now ? FontWeight.w800 : FontWeight.w700)),
            ]),
          ),
      ]),
    );
  }
}

// ------------------------------------------------------------------------------------------------ wallet short

/// The sentence for a 402 `insufficient_balance` / `insufficient_funds`. [otherWay] finishes it ("pay online instead").
/// When the wallet holds only test credit, say so: test credit cannot pay for merch (`testCreditNotUsable`).
String merchLowBalanceText(ApiException e, {String otherWay = 'pay online instead'}) {
  final raw = e.extra['shortPaise'];
  final short = raw is num ? raw.round() : null;
  final head = short != null && short > 0 ? 'You need ${merchRupees(short)} more. ' : '';
  final test = e.extra['testCreditNotUsable'] == true ? 'Free test credit cannot be used for merch. ' : '';
  return '$head${test}Add money to your wallet, or $otherWay.';
}

/// Plain-English text for a failed merch checkout, covering the codes the website maps too. Falls back to the worker's own sentence.
String merchCheckoutErrorText(ApiException e) {
  switch (e.code) {
    case 'checkout_off':
      return 'Buying opens soon.';
    case 'gst_not_ready':
      return 'Merch checkout opens soon. Nothing was charged.';
    case 'own_product':
      return 'You cannot buy your own product.';
    case 'gone':
      return 'An item in your bag is no longer available.';
    case 'gateway_error':
      return 'The payment page did not open. Nothing was charged. Please try again.';
    case 'payments_unavailable':
      return 'Payments are not available right now. Please try again in a little while.';
    case 'over_price_cap':
      return 'An item is priced above the allowed limit right now. Nothing was charged.';
  }
  return e.userMessage;
}

// ------------------------------------------------------------------------------------------------ saved addresses

/// Asks, then removes a saved address (`DELETE /api/hf/merch/addresses/:id`). Returns true when it is gone.
Future<bool> removeSavedAddress(BuildContext context, MerchRepo repo, SavedAddress a) async {
  final yes = await hfConfirm(
    context,
    title: 'Remove this address?',
    body: '${a.name}, ${a.line1}, ${a.city} ${a.pincode} will no longer be saved.',
    confirmLabel: 'Remove',
    cancelLabel: 'Keep it',
    destructive: true,
  );
  if (!yes || !context.mounted) return false;
  try {
    await repo.deleteAddress(a.id);
    return true;
  } catch (_) {
    if (context.mounted) toast(context, 'We could not remove that address. Please try again.');
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ GSTIN

/// The influencer's OPTIONAL GSTIN (`GET|PUT /api/hf/merch/tax`). We sell the shirts and give the fan the tax invoice, so it is only
/// recorded; the royalty does not change. A small collapsible card, as on the website.
class MerchGstinCard extends StatefulWidget {
  const MerchGstinCard({super.key, required this.repo});

  final MerchRepo repo;

  /// 15 characters, for example 27ABCDE1234F1Z5 (the same pattern the server uses).
  static final RegExp pattern = RegExp(r'^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$');

  @override
  State<MerchGstinCard> createState() => _MerchGstinCardState();
}

class _MerchGstinCardState extends State<MerchGstinCard> {
  final TextEditingController _c = TextEditingController();
  bool _loaded = false;
  String? _saved;
  bool _open = false;
  bool _busy = false;
  String? _msg;
  bool _msgOk = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    String? g;
    try {
      g = await widget.repo.gstin();
    } catch (_) {
      g = null; // like the website: the box still opens, saving will say what is wrong
    }
    if (!mounted) return;
    setState(() {
      _saved = g;
      _c.text = g ?? '';
      _loaded = true;
    });
  }

  String get _g => _c.text.trim().toUpperCase().replaceAll(RegExp(r'\s+'), '');
  bool get _valid => _g.isEmpty || MerchGstinCard.pattern.hasMatch(_g);

  Future<void> _save() async {
    if (!_valid || _busy) return;
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      final kept = await widget.repo.saveGstin(_g);
      if (!mounted) return;
      merchEvent('merch_gstin_saved', {'has_gstin': kept != null});
      setState(() {
        _busy = false;
        _saved = kept;
        _c.text = kept ?? '';
        _msgOk = true;
        _msg = kept != null ? 'Saved. We keep it on file; your royalty stays the same.' : 'Removed.';
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _msgOk = false;
          _msg = merchErrorText(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded) return const SizedBox.shrink();
    final saved = _saved;
    final label = _open ? 'Hide' : (saved != null ? 'Your GSTIN: $saved' : 'Have a GSTIN? Add it (optional)');
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DesiCard(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Align(
            alignment: Alignment.centerLeft,
            child: DesiButton(label, icon: _open ? Icons.expand_less_rounded : Icons.receipt_long_rounded, kind: DesiButtonKind.ghost, onTap: () => setState(() => _open = !_open)),
          ),
          if (_open) ...[
            const SizedBox(height: 10),
            Text(
              'We sell the shirts and give the fan a tax invoice, so you do not need a GSTIN to earn your royalty. If you have one, you can add it here for our records. It does not change your payout.',
              style: t(14, color: C.muted, w: FontWeight.w700, h: 1.3),
            ),
            const SizedBox(height: 10),
            MerchField(
              label: 'GSTIN (15 characters)',
              controller: _c,
              hint: '27ABCDE1234F1Z5',
              capitalization: TextCapitalization.characters,
              formatters: [LengthLimitingTextInputFormatter(20)],
              onChanged: (_) => setState(() => _msg = null),
            ),
            if (!_valid) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('A GSTIN looks like 27ABCDE1234F1Z5. Leave it empty if you do not have one.', style: t(14, color: C.ruby, w: FontWeight.w700))),
            if (_msg != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_msg!, style: t(14, color: _msgOk ? C.muted : C.ruby, w: FontWeight.w700))),
            DesiButton(_busy ? 'Saving…' : 'Save', kind: DesiButtonKind.rani, expand: true, onTap: (!_valid || _busy || _g == (saved ?? '')) ? null : () => unawaited(_save())),
          ],
        ]),
      ),
    );
  }
}
