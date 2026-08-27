import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import 'messenger_call_billing_models.dart';

/// Caller-visible settlement receipt. It accepts only the server-produced
/// [MessengerCallReceipt]; no client timer or wallet snapshot is displayed as
/// financial truth.
class MessengerCallReceiptDetailsScreen extends StatelessWidget {
  const MessengerCallReceiptDetailsScreen({super.key, required this.receipt});

  final MessengerCallReceipt receipt;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.bg,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        title: const Text('Call receipt'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(Msg.s4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _statusCard(),
              const SizedBox(height: Msg.s3),
              _section('Connection', [
                _row('Media', receipt.media == MessengerCallMedia.video ? 'Video' : 'Audio'),
                _row('Provider', receipt.providerLabel),
                _row('Quality', receipt.qualitySku.label),
                _row('Connected time', receipt.connectedDurationLabel),
                _row('Participants', '${receipt.participantCount}'),
                _row('Participant minutes', _minutes(receipt.participantMinutes)),
                _row('Ended', _endedLabel(receipt.endedReason)),
              ]),
              const SizedBox(height: Msg.s3),
              _section('Billing', [
                _row('Free participant minutes', _minutes(receipt.freeParticipantMinutes)),
                _row('Paid participant minutes', _minutes(receipt.paidParticipantMinutes)),
                _row('Rate', '${receipt.rateCentitokensPerParticipantMinute} centitokens/min'),
                _row('Tokens charged', '${receipt.tokensCharged}'),
                _row('Price version', '${receipt.priceVersion}'),
              ]),
              const SizedBox(height: Msg.s3),
              Text(
                'You paid for the connected time of both participants. Ringing, setup and reconnect gaps are not included.',
                style: ADText.preview(),
              ),
              const SizedBox(height: Msg.s5),
              Center(
                child: TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Done'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _statusCard() {
    final free = receipt.isFree;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(Msg.s4),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: Msg.brLg,
        border: Border.all(color: AD.borderControl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            free ? PhosphorIcons.checkCircle(PhosphorIconsStyle.regular) : PhosphorIcons.wallet(PhosphorIconsStyle.regular),
            color: free ? AD.online : AD.primaryBadge,
            size: 28,
          ),
          const SizedBox(height: Msg.s2),
          Text(
            free ? 'No tokens charged' : '${receipt.tokensCharged} tokens charged',
            style: ADText.appTitle(),
          ),
          const SizedBox(height: Msg.s1),
          Text(
            receipt.settlementStatus,
            style: ADText.sectionLabel(c: free ? AD.online : AD.textSecondary),
          ),
        ],
      ),
    );
  }

  Widget _section(String title, List<Widget> rows) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(Msg.s4),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: Msg.brLg,
          border: Border.all(color: AD.borderControl),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: Msg.s2),
            ...rows,
          ],
        ),
      );

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(label, style: ADText.preview())),
            const SizedBox(width: Msg.s3),
            Flexible(
              child: Text(value, textAlign: TextAlign.right, style: ADText.rowName()),
            ),
          ],
        ),
      );
}

String _minutes(double value) => value == value.roundToDouble()
    ? '${value.toInt()} min'
    : '${value.toStringAsFixed(2)} min';

String _endedLabel(String value) => value.isEmpty ? 'Completed' : value.replaceAll('_', ' ');
