import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';

/// Creator-facing commercial earnings and receipt summary.
///
/// This screen is deliberately receipt-backed. It never turns ticket counts,
/// price labels or booking counts into a payout estimate. The commercial
/// feature flags remain the outer gate until Phase 2 is activated.
class CreatorReceiptSummaryScreen extends StatefulWidget {
  final List<String> sessionIds;
  final String? serviceTitle;
  final int? reservedTickets;
  final Future<CommercialReceiptResponse?> Function(String sessionId)? loadReceipt;

  const CreatorReceiptSummaryScreen({
    super.key,
    required this.sessionIds,
    this.serviceTitle,
    this.reservedTickets,
    this.loadReceipt,
  });

  @override
  State<CreatorReceiptSummaryScreen> createState() => _CreatorReceiptSummaryScreenState();
}

class _CreatorReceiptSummaryScreenState extends State<CreatorReceiptSummaryScreen> {
  CommercialReceiptSummary? _summary;
  bool _loading = true;
  bool _failed = false;

  bool get _commercialEnabled =>
      RemoteConfig.commercialLiveListingsEnabled ||
      RemoteConfig.commercialConsultListingsEnabled;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avaexplore', 'creator_receipt_summary');
    if (!_commercialEnabled) {
      _loading = false;
    } else {
      _load();
    }
  }

  Future<void> _load() async {
    if (!_commercialEnabled) return;
    setState(() {
      _loading = true;
      _failed = false;
    });
    final loader = widget.loadReceipt ?? ListingsApi.commercialReceipt;
    final ids = widget.sessionIds.where((id) => id.isNotEmpty).toSet();
    try {
      final responses = await Future.wait(ids.map(loader));
      if (!mounted) return;
      final available = responses.whereType<CommercialReceiptResponse>().toList();
      final rows = available.expand((response) => response.receipts).toList();
      setState(() {
        _summary = CommercialReceiptSummary.fromReceipts(rows);
        _loading = false;
        _failed = available.isEmpty && ids.isNotEmpty;
      });
      Analytics.capture('commercial_receipt_summary_loaded', {
        'session_count': ids.length,
        'receipt_count': rows.length,
        'settled_count': _summary?.settledReceipts.length ?? 0,
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  String _amountLines(Map<String, int> amounts) {
    if (amounts.isEmpty) return '—';
    return amounts.entries
        .map((entry) => '${entry.value} ${entry.key}')
        .join('\n');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: 'Earnings & receipts',
        markWord: 'receipts',
        tag: widget.serviceTitle ?? 'creator studio',
      ),
      body: !_commercialEnabled
          ? _message(
              PhosphorIcons.lock(PhosphorIconsStyle.bold),
              'Commercial earnings are unavailable while services are off.')
          : _loading
              ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
              : _failed
                  ? _retry()
                  : RefreshIndicator(
                      onRefresh: _load,
                      color: AD.primaryBadge,
                      child: _body(_summary ?? CommercialReceiptSummary.fromReceipts(const [])),
                    ),
    );
  }

  Widget _body(CommercialReceiptSummary summary) {
    final hasSettled = summary.settledReceipts.isNotEmpty;
    return ListView(
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
      children: [
        if (widget.reservedTickets != null)
          _metric(
            'Reserved tickets',
            '${widget.reservedTickets}',
            PhosphorIcons.ticket(PhosphorIconsStyle.bold),
            AD.iconSearch,
          ),
        if (widget.reservedTickets != null) const SizedBox(height: Msg.s3),
        _metric(
          'Creator earnings (settled)',
          _amountLines(summary.creatorAmountByCurrency),
          PhosphorIcons.coins(PhosphorIconsStyle.bold),
          AD.online,
        ),
        const SizedBox(height: Msg.s3),
        _metric(
          'Platform fees (settled)',
          _amountLines(summary.platformFeeByCurrency),
          PhosphorIcons.scales(PhosphorIconsStyle.bold),
          AD.textSecondary,
        ),
        const SizedBox(height: Msg.s4),
        Text(
          hasSettled
              ? 'These amounts come from immutable server receipts. Reserved tickets and listing prices are not used to estimate earnings.'
              : 'No settled receipt yet. Earnings appear after signed provider evidence and settlement complete.',
          style: ADText.preview(c: AD.textSecondary),
        ),
        if (summary.reviewPendingReceiptCount > 0) ...[
          const SizedBox(height: Msg.s3),
          Text(
            '${summary.reviewPendingReceiptCount} receipt${summary.reviewPendingReceiptCount == 1 ? '' : 's'} is still pending review or has incomplete financial data.',
            style: ADText.sectionLabel(c: AD.textTertiary),
          ),
        ],
        if (summary.refundedReceiptCount > 0) ...[
          const SizedBox(height: Msg.s2),
          Text(
            '${summary.refundedReceiptCount} receipt${summary.refundedReceiptCount == 1 ? '' : 's'} refunded; refunded amounts are not included in creator earnings.',
            style: ADText.sectionLabel(c: AD.textTertiary),
          ),
        ],
        if (hasSettled) ...[
          const SizedBox(height: Msg.s5),
          Text('Settled receipts', style: ADText.appTitle()),
          const SizedBox(height: Msg.s2),
          for (final receipt in summary.settledReceipts) _receiptRow(receipt),
        ],
      ],
    );
  }

  Widget _receiptRow(CommercialReceipt receipt) => Padding(
        padding: const EdgeInsets.symmetric(vertical: Msg.s2),
        child: ZineCard(
          radius: Msg.rMd,
          padding: const EdgeInsets.all(Msg.s3),
          boxShadow: const <BoxShadow>[],
          child: Row(children: [
            PhosphorIcon(
              receipt.kind == 'live_event'
                  ? PhosphorIcons.broadcast(PhosphorIconsStyle.bold)
                  : PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
              color: AD.primaryBadge,
            ),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    receipt.kind == 'live_event' ? 'Live event' : '1:1 consultation',
                    style: ADText.rowName().copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: Msg.s1),
                  Text(
                    'Receipt ${receipt.receiptId} · ${_dateLabel(receipt.issuedAt)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ADText.sectionLabel(c: AD.textTertiary),
                  ),
                ],
              ),
            ),
            Text(
              '${receipt.creatorAmount} ${receipt.currency}',
              textAlign: TextAlign.end,
              style: ADText.rowName(c: AD.online),
            ),
          ]),
        ),
      );

  String _dateLabel(DateTime date) =>
      '${date.toLocal().day.toString().padLeft(2, '0')}/${date.toLocal().month.toString().padLeft(2, '0')}/${date.toLocal().year}';

  Widget _metric(String label, String value, IconData icon, Color color) => ZineCard(
        radius: Msg.rLg,
        padding: const EdgeInsets.all(Msg.s3),
        boxShadow: const <BoxShadow>[],
        child: Row(children: [
          PhosphorIcon(icon, color: color),
          const SizedBox(width: Msg.s3),
          Expanded(child: Text(label, style: ADText.preview())),
          Text(value, textAlign: TextAlign.end, style: ADText.rowName(c: color)),
        ]),
      );

  Widget _retry() => Center(
        child: ZineEmptyState(
          icon: PhosphorIcons.receipt(PhosphorIconsStyle.bold),
          text: 'Could not load settled receipts — pull to retry.',
        ),
      );

  Widget _message(IconData icon, String text) => Center(
        child: ZineEmptyState(icon: icon, text: text),
      );
}
