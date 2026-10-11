import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/brand.dart';
import '../../../core/format/money.dart';
import '../../../core/links.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../data/wallet_models.dart';
import '../wallet_providers.dart';

abstract final class RefundCopy {
  static const String title = 'Refunds';
  static const String viaGoogle = 'Money added on Google Play is refunded by Google. Open your Google Play order history, or write to us at ';
  static const String orderHistory = 'Open Google Play order history';
  static const String nothing = 'You have no unused wallet money that can be refunded right now.';
  static const String asked = 'Refund requested. We will check it and tell you here.';
  static const String confirmTitle = 'Ask for a refund?';
  static const String confirmYes = 'Yes, ask';
  static const String back = 'Not now';
  static const String cancelAsk = 'Cancel request';
}

/// Where Google lists a person's orders (and lets them ask Google for a refund).
final Uri kPlayOrderHistory = Uri.https('play.google.com', '/store/account/orderhistory');

/// Refunds: unused wallet money can be refunded within the window (token mode), plus the Google way.
class RefundSection extends ConsumerStatefulWidget {
  const RefundSection({super.key});

  @override
  ConsumerState<RefundSection> createState() => _RefundSectionState();
}

class _RefundSectionState extends ConsumerState<RefundSection> {
  String? _busyId;
  String? _message;
  bool _messageIsError = false;

  Future<void> _ask({String? lotId, required String confirmText}) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text(RefundCopy.confirmTitle),
        content: Text(confirmText, style: HfText.bodyText),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text(RefundCopy.back)),
          ElevatedButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text(RefundCopy.confirmYes)),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      _busyId = lotId ?? 'all';
      _message = null;
    });
    final sw = Stopwatch()..start();
    try {
      await ref.read(walletApiProvider).requestRefund(lotId: lotId);
      unawaited(Analytics.capture('hf_app_refund_requested', {'outcome': 'ok', 'ms': sw.elapsedMilliseconds, 'kind': lotId == null ? 'money' : 'tokens'}));
      if (!mounted) return;
      setState(() {
        _message = RefundCopy.asked;
        _messageIsError = false;
      });
      ref.invalidate(refundsProvider);
      ref.invalidate(walletProvider);
    } on ApiError catch (e) {
      unawaited(Analytics.capture('hf_app_refund_requested', {'outcome': 'error', 'reason': e.code, 'status': e.status, 'ms': sw.elapsedMilliseconds}));
      if (!mounted) return;
      setState(() {
        _message = e.userMessage;
        _messageIsError = true;
      });
    } catch (_) {
      unawaited(Analytics.capture('hf_app_refund_requested', {'outcome': 'error', 'reason': 'unknown', 'ms': sw.elapsedMilliseconds}));
      if (!mounted) return;
      setState(() {
        _message = ApiError.fallbackMessageFor('bad_response', 0);
        _messageIsError = true;
      });
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _cancel(RefundRequest r) async {
    setState(() {
      _busyId = r.id;
      _message = null;
    });
    try {
      await ref.read(walletApiProvider).cancelRefund(r.id);
      ref.invalidate(refundsProvider);
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _message = e.userMessage;
          _messageIsError = true;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _message = ApiError.fallbackMessageFor('bad_response', 0);
          _messageIsError = true;
        });
      }
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final refunds = ref.watch(refundsProvider);
    // A refunds route that is off or unreachable still leaves the Google Play help below.
    final info = valueOf(refunds) ?? RefundsInfo.off;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(RefundCopy.title, style: HfText.title),
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Wrap(spacing: 8, children: [Icon(Icons.receipt_long_rounded, color: HfColors.ink), Text('Payments & refunds', style: HfText.subtitle)]),
              const SizedBox(height: 12),
              const Text('${RefundCopy.viaGoogle}${Brand.supportEmail}.', style: HfText.bodyText),
              const SizedBox(height: 12),
              HfButton(
                key: const ValueKey<String>('play-order-history'),
                label: RefundCopy.orderHistory,
                kind: HfButtonKind.secondary,
                icon: Icons.open_in_new_rounded,
                onPressed: () => LinkOpener.instance.customTab(kPlayOrderHistory),
              ),
            ],
          ),
        ),
        if (_message != null) ...[
          const SizedBox(height: HfSpacing.gap),
          HfCard(
            key: const ValueKey<String>('refund-message'),
            color: _messageIsError ? HfColors.blush : HfColors.lilac,
            child: Text(_message!, style: HfText.bodyStrong),
          ),
        ],
        if (info.enabled && info.tokenMode) ..._lots(info),
        if (info.enabled && !info.tokenMode && info.refundableRupees > 0) ..._oldMoney(info),
        if (info.enabled && info.requests.isNotEmpty) ..._requests(info),
      ],
    );
  }

  List<Widget> _lots(RefundsInfo info) {
    if (info.lots.isEmpty) {
      return [
        const SizedBox(height: HfSpacing.gap),
        const Text(RefundCopy.nothing, style: HfText.note),
      ];
    }
    return [
      const SizedBox(height: HfSpacing.gap),
      Text('You can ask for a refund of unused wallet money within ${info.windowDays} days of buying them.', style: HfText.note),
      for (final l in info.lots) ...[
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          key: ValueKey<String>('lot-${l.lotId}'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.replay_rounded, color: HfColors.ink),
              const SizedBox(height: 12),
              Text('Bought ${shortDate(l.boughtAt)}', style: HfText.bodyStrong),
              const SizedBox(height: 4),
              Text('₹${l.tokens} unused', style: HfText.bodyText),
              Text(
                l.wholeOrder
                    ? 'You paid ${Money.rupees(l.paidRupees)}. Refund: ${Money.rupees(l.refundRupees)}'
                    : 'You paid ${Money.rupees(l.paidRupees)}. Refund for the unused part: ${Money.rupees(l.refundRupees)}',
                style: HfText.note,
              ),
              const SizedBox(height: 12),
              HfButton(
                key: ValueKey<String>('refund-${l.lotId}'),
                label: 'Ask for a refund',
                kind: HfButtonKind.secondary,
                loading: _busyId == l.lotId,
                onPressed: _busyId == null
                    ? () => _ask(
                          lotId: l.lotId,
                          confirmText: 'We will refund ${Money.rupees(l.refundRupees)} for the unused ₹${l.tokens} from this purchase, and remove it from your wallet.',
                        )
                    : null,
              ),
            ],
          ),
        ),
      ],
    ];
  }

  List<Widget> _oldMoney(RefundsInfo info) => [
        const SizedBox(height: HfSpacing.gap),
        HfCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Unused money that can go back: ${Money.rupees(info.refundableRupees)}', style: HfText.bodyStrong),
              const SizedBox(height: 12),
              HfButton(
                key: const ValueKey<String>('refund-money'),
                label: 'Ask for a refund',
                kind: HfButtonKind.secondary,
                loading: _busyId == 'all',
                onPressed: _busyId == null
                    ? () => _ask(confirmText: 'We will refund ${Money.rupees(info.refundableRupees)} of unused money to the way you paid.')
                    : null,
              ),
            ],
          ),
        ),
      ];

  List<Widget> _requests(RefundsInfo info) => [
        const SizedBox(height: HfSpacing.gapLarge),
        const Text('Your refund requests', style: HfText.subtitle),
        for (final r in info.requests) ...[
          const SizedBox(height: HfSpacing.gap),
          HfCard(
            key: ValueKey<String>('request-${r.id}'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${Money.rupees(r.amountRupees)} · ${r.statusText}', style: HfText.bodyStrong),
                if (r.createdAt != null) Text('Asked on ${shortDate(r.createdAt)}', style: HfText.note),
                if (r.reason != null) Text(r.reason!, style: HfText.note),
                if (r.canCancel) ...[
                  const SizedBox(height: 8),
                  HfButton(
                    label: RefundCopy.cancelAsk,
                    kind: HfButtonKind.text,
                    expand: false,
                    loading: _busyId == r.id,
                    onPressed: _busyId == null ? () => _cancel(r) : null,
                  ),
                ],
              ],
            ),
          ),
        ],
      ];
}
