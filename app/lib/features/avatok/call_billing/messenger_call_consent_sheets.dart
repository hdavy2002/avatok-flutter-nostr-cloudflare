
import '../../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import 'messenger_call_billing_models.dart';

Future<MessengerCallConsentResult?> showMessengerVideoQualitySheet(
  BuildContext context, {
  required MessengerCallPricingCatalog catalog,
  int? spendableTokens,
  MessengerCallQualitySku initialSku = MessengerCallQualitySku.videoHd,
}) {
  return showModalBottomSheet<MessengerCallConsentResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
    builder: (_) => _VideoQualitySheet(
      catalog: catalog,
      spendableTokens: spendableTokens,
      initialSku: initialSku,
    ),
  );
}

Future<MessengerCallConsentResult?> showMessengerPaidAudioSheet(
  BuildContext context, {
  required MessengerCallRate rate,
  int? spendableTokens,
}) {
  return showModalBottomSheet<MessengerCallConsentResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
    builder: (_) => _PaidAudioSheet(
      rate: rate,
      spendableTokens: spendableTokens,
    ),
  );
}

class _VideoQualitySheet extends StatefulWidget {
  const _VideoQualitySheet({
    required this.catalog,
    required this.spendableTokens,
    required this.initialSku,
  });

  final MessengerCallPricingCatalog catalog;
  final int? spendableTokens;
  final MessengerCallQualitySku initialSku;

  @override
  State<_VideoQualitySheet> createState() => _VideoQualitySheetState();
}

class _VideoQualitySheetState extends State<_VideoQualitySheet> {
  late MessengerCallQualitySku _selected;

  @override
  void initState() {
    super.initState();
    _selected = _firstAvailable(widget.catalog, widget.initialSku);
  }

  static MessengerCallQualitySku _firstAvailable(
    MessengerCallPricingCatalog catalog,
    MessengerCallQualitySku preferred,
  ) {
    if (catalog.rateFor(preferred).isAvailable) return preferred;
    for (final sku in const [
      MessengerCallQualitySku.videoSd,
      MessengerCallQualitySku.videoHd,
      MessengerCallQualitySku.video2k,
      MessengerCallQualitySku.video4k,
    ]) {
      if (catalog.rateFor(sku).isAvailable) return sku;
    }
    return preferred;
  }

  void _accept() {
    final rate = widget.catalog.rateFor(_selected);
    if (!rate.isAvailable) return;
    Navigator.of(context).pop(
      MessengerCallConsentResult.accepted(qualitySku: _selected),
    );
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final selectedRate = widget.catalog.rateFor(_selected);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s3, Msg.s5, Msg.s5),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(child: _handle()),
            UiText(UiMessage.m_choose_video_quality_75fd802855, style: ADText.appTitle()),
            const SizedBox(height: Msg.s2),
            UiText(
              UiMessage.m_video_calls_are_paid_from_d35b177c31,
              style: ADText.preview(),
            ),
            const SizedBox(height: Msg.s4),
            ...[
              MessengerCallQualitySku.videoSd,
              MessengerCallQualitySku.videoHd,
              MessengerCallQualitySku.video2k,
              MessengerCallQualitySku.video4k,
            ].map(_qualityRow),
            const SizedBox(height: Msg.s3),
            _estimateCard(selectedRate),
            if (widget.spendableTokens != null) ...[
              const SizedBox(height: Msg.s2),
              UiText(
                UiMessage.m_current_wallet_balance_value1_tokens_9a5107d265, params: {'value1': (_tokens(widget.spendableTokens!)).toString()},
                style: ADText.sectionLabel(),
              ),
            ],
            const SizedBox(height: Msg.s4),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: selectedRate.isAvailable ? _accept : null,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AD.primaryBadge,
                  foregroundColor: AD.tabActiveLabel,
                  disabledBackgroundColor: AD.borderControl,
                  shape: RoundedRectangleBorder(borderRadius: Msg.brMd),
                  padding: const EdgeInsets.symmetric(vertical: Msg.s3),
                ),
                child: Text(
                  selectedRate.isAvailable
                      ? uiCopy(UiMessage.m_start_paid_video_call_fe09e14497)
                      : uiCopy(UiMessage.m_video_pricing_unavailable_94108b61ab),
                ),
              ),
            ),
            Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: UiText(UiMessage.m_cancel_19766ed6cc, style: ADText.preview()),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _qualityRow(MessengerCallQualitySku sku) {
    final rate = widget.catalog.rateFor(sku);
    final selected = sku == _selected;
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s2),
      child: InkWell(
        onTap: rate.isAvailable ? () => setState(() => _selected = sku) : null,
        borderRadius: Msg.brMd,
        child: Container(
          padding: const EdgeInsets.all(Msg.s3),
          decoration: BoxDecoration(
            color: selected ? AD.cardHover : AD.card,
            borderRadius: Msg.brMd,
            border: Border.all(
              color: selected ? AD.primaryBadge : AD.borderControl,
              width: selected ? 2 : 1,
            ),
          ),
          child: Row(
            children: [
              Icon(
                selected ? PhosphorIcons.radioButton(PhosphorIconsStyle.regular) : PhosphorIcons.circle(PhosphorIconsStyle.regular),
                color: rate.isAvailable ? AD.primaryBadge : AD.textTertiary,
              ),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(sku.label, style: ADText.rowName()),
                    Text(
                      rate.isAvailable
                          ? uiCopy(UiMessage.m_value1_tokens_hour_for_two_5cbf3928f5, {'value1': (_tokens(rate.estimatedTwoPersonTokensPerHour!)).toString()})
                          : rate.unavailableReason,
                      style: ADText.preview(
                        c: rate.isAvailable ? AD.textSecondary : AD.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
              if (rate.publicCap != null && rate.publicCap!.isNotEmpty)
                Text(rate.publicCap!, style: ADText.sectionLabel()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _estimateCard(MessengerCallRate rate) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(Msg.s3),
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: Msg.brMd,
          border: Border.all(color: AD.borderControl),
        ),
        child: Text(
          rate.isAvailable
              ? uiCopy(UiMessage.m_estimated_maximum_value1_tokens_per_130bec6f5e, {'value1': (_tokens(rate.estimatedTwoPersonTokensPerHour!)).toString()})
              : uiCopy(UiMessage.m_select_an_available_quality_to_c5892fcc38),
          style: ADText.preview(),
        ),
      );

  Widget _handle() => Container(
        width: 40,
        height: 4,
        margin: const EdgeInsets.only(bottom: Msg.s4),
        decoration: BoxDecoration(color: AD.textTertiary, borderRadius: Msg.brPill),
      );
}

class _PaidAudioSheet extends StatelessWidget {
  const _PaidAudioSheet({required this.rate, required this.spendableTokens});

  final MessengerCallRate rate;
  final int? spendableTokens;

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    final available = rate.isAvailable;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s3, Msg.s5, Msg.s5),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: Msg.s4),
                decoration: BoxDecoration(
                  color: AD.textTertiary,
                  borderRadius: Msg.brPill,
                ),
              ),
            ),
            UiText(UiMessage.m_paid_audio_via_getstream_d84d79e8ca, style: ADText.appTitle()),
            const SizedBox(height: Msg.s2),
            Text(
              available
                  ? uiCopy(UiMessage.m_continue_with_paid_getstream_audio_b41294107b)
                  : uiCopy(UiMessage.m_paid_audio_pricing_is_not_934d828b41),
              style: ADText.preview(),
            ),
            const SizedBox(height: Msg.s4),
            if (available)
              _infoCard(
                '${_tokens(rate.estimatedTwoPersonTokensPerHour!)} tokens/hour',
                'Estimated for two connected participants',
              ),
            if (spendableTokens != null) ...[
              const SizedBox(height: Msg.s2),
              UiText(
                UiMessage.m_current_wallet_balance_value1_tokens_9a5107d265, params: {'value1': (_tokens(spendableTokens!)).toString()},
                style: ADText.sectionLabel(),
              ),
            ],
            const SizedBox(height: Msg.s4),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: available
                    ? () => Navigator.of(context).pop(
                          const MessengerCallConsentResult.accepted(),
                        )
                    : null,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AD.primaryBadge,
                  foregroundColor: AD.tabActiveLabel,
                  disabledBackgroundColor: AD.borderControl,
                  shape: RoundedRectangleBorder(borderRadius: Msg.brMd),
                  padding: const EdgeInsets.symmetric(vertical: Msg.s3),
                ),
                child: const UiText(UiMessage.m_continue_with_paid_getstream_audio_31a9dcb40b),
              ),
            ),
            Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: UiText(UiMessage.m_cancel_call_337754ee31, style: ADText.preview()),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _infoCard(String title, String subtitle) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(Msg.s3),
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: Msg.brMd,
          border: Border.all(color: AD.borderControl),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: Msg.s1),
            Text(subtitle, style: ADText.preview()),
          ],
        ),
      );
}

String _tokens(int value) {
  final raw = value.toString();
  final out = StringBuffer();
  for (var i = 0; i < raw.length; i++) {
    if (i > 0 && (raw.length - i) % 3 == 0) out.write(',');
    out.write(raw[i]);
  }
  return out.toString();
}
