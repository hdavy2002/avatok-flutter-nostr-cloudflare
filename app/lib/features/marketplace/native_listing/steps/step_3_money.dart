
import '../../../../core/localization/ui_text.dart';
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
    UiLocaleScope.watch(context);
    if (listingDraftValue(draft, 'freeEntry', 'free_entry', false) == true) {
      return NativeStepLayout(children: [
        const NativeStepCard(child: UiText(UiMessage.m_this_is_a_free_show_92f477d5ec)),
      ]);
    }
    final price = int.tryParse('${listingDraftValue(draft, 'price', 'price', '')}') ?? 0;
    final split = _feeSplit(price);
    return NativeStepLayout(children: [
      nativeNumberField(
        label: uiCopy(UiMessage.m_price_per_hour_tokens_09f88bb0a7),
        value: '${listingDraftValue(draft, 'price', 'price', '')}',
        hint: uiCopy(UiMessage.m_min_minprice_7c85e77f6b, {'minPrice': (_minPrice).toString()}),
        onChanged: (v) => patch({'price': v}),
        error: error('price'),
      ),
      UiText(UiMessage.m_everything_is_priced_per_hour_dc2eb4fd57,
          style: ADText.preview(c: AD.textSecondary)),
      if (price > 0)
        NativeStepCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          UiText(UiMessage.m_at_price_hr_avatok_takes_fd228fe0be, params: {'price': (price).toString(), 'value2': (split.fee).toString(), 'value3': (split.creator).toString()},
              style: ADText.preview(c: AD.textPrimary)),
          const SizedBox(height: 6),
          UiText(UiMessage.m_flatfee_flat_commission_of_what_0269d1b66d, params: {'flatFee': (_flatFee).toString(), 'commission': (_commission).toString()},
              style: ADText.preview(c: AD.textSecondary)),
        ])),
      _examples(),
      nativeNumberField(
        label: uiCopy(UiMessage.m_early_bird_discount_optional_1c43c0dcee),
        value: '${listingDraftValue(draft, 'earlyBirdPct', 'early_bird_pct', '')}',
        hint: uiCopy(UiMessage.m_e_g_20_e4181cc1b9),
        onChanged: (v) => patch({'early_bird_pct': v}),
        error: error('early_bird_pct'),
      ),
      AdField(
        label: uiCopy(UiMessage.m_promo_code_optional_c620196dff),
        hint: uiCopy(UiMessage.m_e_g_friends20_b21380d68b),
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
