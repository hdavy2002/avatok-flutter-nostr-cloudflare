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
    final selectedRate = widget.catalog.rateFor(_selected);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s3, Msg.s5, Msg.s5),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(child: _handle()),
            Text('Choose video quality', style: ADText.appTitle()),
            const SizedBox(height: Msg.s2),
            Text(
              'Video calls are paid from the first connected second. You pay for both participants.',
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
              Text(
                'Current wallet balance: ${_tokens(widget.spendableTokens!)} tokens',
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
                      ? 'Start paid video call'
                      : 'Video pricing unavailable',
                ),
              ),
            ),
            Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: Text('Cancel', style: ADText.preview()),
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
                          ? '${_tokens(rate.estimatedTwoPersonTokensPerHour!)} tokens/hour for two people'
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
              ? 'Estimated maximum: ${_tokens(rate.estimatedTwoPersonTokensPerHour!)} tokens per hour. Final billing uses connected participant time only.'
              : 'Select an available quality to see the estimate.',
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
            Text('Paid audio via GetStream', style: ADText.appTitle()),
            const SizedBox(height: Msg.s2),
            Text(
              available
                  ? 'Continue with paid GetStream audio? You pay for both participants once today’s free allowance is exhausted.'
                  : 'Paid audio pricing is not available yet. The call cannot continue without your confirmation and a configured rate.',
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
              Text(
                'Current wallet balance: ${_tokens(spendableTokens!)} tokens',
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
                child: const Text('Continue with paid GetStream audio'),
              ),
            ),
            Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: Text('Cancel call', style: ADText.preview()),
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
