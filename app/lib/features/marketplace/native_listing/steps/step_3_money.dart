import 'package:flutter/material.dart';

import '../../../../core/ui/avatok_dark.dart';
import 'step_widgets.dart';

class Step3Money extends StatelessWidget {
  const Step3Money({
    super.key,
    required this.draft,
    required this.patch,
    this.error = _noError,
  });

  final dynamic draft;
  final NativeListingPatch patch;
  final NativeListingError error;

  static String? _noError(String field) => null;
  static const _minPrice = 49;
  static const _flatFee = 25;
  static const _commission = 20;

  ({int fee, int creator}) _feeSplit(int input) {
    final price = input < 0 ? 0 : input;
    if (price <= _flatFee) return (fee: price, creator: 0);
    final fee = _flatFee + ((price - _flatFee) * _commission / 100).round();
    return (fee: fee, creator: price - fee);
  }

  @override
  Widget build(BuildContext context) {
    if (listingDraftValue(draft, 'freeEntry', 'free_entry', false) == true) {
      return NativeStepLayout(children: [
        const NativeStepCard(child: Text('This is a free show — attendees pay nothing.')),
      ]);
    }
    final price = int.tryParse('${listingDraftValue(draft, 'price', 'price', '')}') ?? 0;
    final split = _feeSplit(price);
    return NativeStepLayout(children: [
      nativeNumberField(
        label: 'Price per hour (Tokens = ₹)',
        value: '${listingDraftValue(draft, 'price', 'price', '')}',
        hint: 'min $_minPrice',
        onChanged: (v) => patch({'price': v}),
        error: error('price'),
      ),
      Text('Everything is priced per hour. A session shorter than an hour still bills the full hour.',
          style: ADText.preview(c: AD.textSecondary)),
      if (price > 0)
        NativeStepCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('At ₹$price/hr, avaTOK takes ₹${split.fee} and you keep ₹${split.creator}.',
              style: ADText.preview(c: AD.textPrimary)),
          const SizedBox(height: 6),
          Text('₹$_flatFee flat + $_commission% of what’s left. A 2-hour booking bills the flat fee twice.',
              style: ADText.preview(c: AD.textSecondary)),
        ])),
      _examples(),
      nativeNumberField(
        label: 'Early-bird discount % (optional)',
        value: '${listingDraftValue(draft, 'earlyBirdPct', 'early_bird_pct', '')}',
        hint: 'e.g. 20',
        onChanged: (v) => patch({'early_bird_pct': v}),
        error: error('early_bird_pct'),
      ),
      AdField(
        label: 'Promo code (optional)',
        hint: 'e.g. FRIENDS20',
        onChanged: (v) => patch({'promo_code': v.toUpperCase().substring(0, v.length > 24 ? 24 : v.length)}),
      ),
    ]);
  }

  Widget _examples() {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const NativeStepLabel('Worked examples'),
      const SizedBox(height: 8),
      NativeStepCard(child: Column(children: [
        _row('Creator sets', 'avaTOK takes', 'Creator keeps', header: true),
        for (final price in [_minPrice, 100, 500]) ...[
          const Divider(height: 18),
          _row('₹$price/hr', '₹${_feeSplit(price).fee}', '₹${_feeSplit(price).creator}'),
        ],
      ])),
    ]);
  }

  Widget _row(String a, String b, String c, {bool header = false}) => Row(children: [
        Expanded(child: Text(a, style: ADText.preview(c: header ? AD.textSecondary : AD.textPrimary))),
        Expanded(child: Text(b, style: ADText.preview(c: header ? AD.textSecondary : AD.textPrimary))),
        Expanded(child: Text(c, style: ADText.preview(c: header ? AD.textSecondary : AD.textPrimary))),
      ]);
}
