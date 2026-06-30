import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/marketplace_api.dart';
import 'sell_listing_flow.dart' show kMarketCurrencies;

/// AvaMarketplace P5 — "Call Agent" sheet. Captures the buyer's mandate (max
/// price + optional must-haves), then queues the agent↔agent negotiation. One
/// negotiation per buyer per listing CONTENT VERSION (the server greys repeats).
/// On a deal, both owners get a notification (and, per spec, a voice note in
/// their chat threads). Returns true if a negotiation was started.
Future<bool> showCallAgentSheet(
  BuildContext context, {
  required String listingId,
  required int contentVersion,
  required String currency,
}) async {
  final maxCtrl = TextEditingController();
  final mustCtrl = TextEditingController();
  String cur = kMarketCurrencies.contains(currency) ? currency : 'USD';
  bool busy = false;
  String? error;

  final started = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 16, left: 16, right: 16, top: 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Call the seller’s agent', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          const SizedBox(height: 4),
          const Text('Your agent will negotiate for you and drop the result in your chat.',
              style: TextStyle(fontSize: 12, color: Colors.black54)),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: TextField(
              controller: maxCtrl, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Your max price'),
            )),
            const SizedBox(width: 12),
            DropdownButton<String>(
              value: cur,
              items: [for (final c in kMarketCurrencies) DropdownMenuItem(value: c, child: Text(c))],
              onChanged: (v) => setState(() => cur = v ?? 'USD'),
            ),
          ]),
          TextField(controller: mustCtrl,
              decoration: const InputDecoration(labelText: 'Must-haves (optional)')),
          if (error != null)
            Padding(padding: const EdgeInsets.only(top: 8),
                child: Text(error!, style: const TextStyle(color: Colors.red))),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: busy ? null : () async {
              final max = int.tryParse(maxCtrl.text.trim()) ?? 0;
              if (max <= 0) { setState(() => error = 'Enter your max price.'); return; }
              setState(() { busy = true; error = null; });
              Analytics.capture('agent_call_clicked', {'listing_id': listingId, 'content_version': contentVersion});
              Analytics.capture('buyer_mandate_captured', {'max_amount': max, 'currency': cur});
              final res = await MarketplaceApi.callAgent(
                listingId: listingId, contentVersion: contentVersion,
                maxAmount: max, currency: cur, mustHaves: mustCtrl.text.trim(),
              );
              if (!ctx.mounted) return;
              if (res['already_talked'] == true) {
                setState(() { busy = false; error = 'You’ve already talked to this listing.'; });
                return;
              }
              if (res['ok'] == true) {
                Navigator.of(ctx).pop(true);
              } else {
                setState(() { busy = false; error = 'Could not start the negotiation. Try again.'; });
              }
            },
            child: Text(busy ? 'Negotiating…' : 'Start negotiation'),
          ),
        ]),
      ),
    ),
  );
  return started == true;
}
