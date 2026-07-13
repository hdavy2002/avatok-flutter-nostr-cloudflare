import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/marketplace_api.dart';
import '../../core/ui/avatok_dark.dart';
import 'sell_listing_flow.dart' show kMarketCurrencies;

/// AvaMarketplace P5 — "Call Agent" sheet (Zine-styled). Captures the buyer's
/// mandate (max price + optional must-haves), then queues the agent↔agent
/// negotiation which runs in the BACKGROUND (the server renders the voice note
/// and drops it into both chat threads). One negotiation per buyer per listing
/// CONTENT VERSION. Returns true if a negotiation was started.
Future<bool> showCallAgentSheet(
  BuildContext context, {
  required String listingId,
  required int contentVersion,
  required String currency,
  VoidCallback? onMessageSeller, // P5: wired to the owner-DM path on daily-limit
}) async {
  final maxCtrl = TextEditingController();
  final mustCtrl = TextEditingController();
  String cur = kMarketCurrencies.contains(currency) ? currency : 'USD';
  bool busy = false;
  String? error;
  bool dailyLimited = false; // P5: hit the 10/day agent-conversation cap

  InputDecoration box(String? hint) => InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(color: AD.placeholderOnWhite),
        filled: true,
        fillColor: AD.inputField,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.borderControl, width: 1)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.borderControl, width: 1)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AD.rInput), borderSide: BorderSide(color: AD.iconSearch, width: 1)),
      );
  Widget label(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 6, top: 2),
        child: Text(t, style: TextStyle(fontFamily: ADText.family, fontSize: 14, fontWeight: FontWeight.w700, color: AD.textPrimary)),
      );

  final started = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => Container(
        decoration: BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        // Bottom inset = keyboard + system nav bar, so the lime button is never
        // hidden behind the navigation bar (pic 10).
        padding: EdgeInsets.fromLTRB(20, 16, 20,
            20 + MediaQuery.of(ctx).viewInsets.bottom + MediaQuery.of(ctx).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Center(child: Container(width: 40, height: 5, margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(color: AD.borderControl, borderRadius: BorderRadius.circular(3)))),
          Text('Call the seller’s agent', style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800, fontSize: 19, color: AD.textPrimary)),
          const SizedBox(height: 6),
          Text('Your agent negotiates in the background — you can keep browsing. The result lands in your chat as a voice note.',
              style: TextStyle(fontFamily: ADText.family, fontSize: 13, color: AD.textSecondary)),
          const SizedBox(height: 16),
          label('Your max price'),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: TextField(
              controller: maxCtrl, keyboardType: TextInputType.number,
              decoration: box('e.g. 35000'),
            )),
            const SizedBox(width: 12),
            SizedBox(width: 110, child: DropdownButtonFormField<String>(
              value: cur, isExpanded: true, decoration: box(null),
              items: [for (final c in kMarketCurrencies) DropdownMenuItem(value: c, child: Text(c))],
              onChanged: (v) => setState(() => cur = v ?? 'USD'),
            )),
          ]),
          const SizedBox(height: 14),
          label('Must-haves (optional)'),
          TextField(controller: mustCtrl, decoration: box('e.g. must include warranty, pickup this week')),
          if (error != null)
            Padding(padding: const EdgeInsets.only(top: 10),
                child: AdErrorMsg(error!)),
          const SizedBox(height: 18),
          if (dailyLimited)
            AdButton(
              label: 'Message seller',
              fullWidth: true,
              fontSize: 17,
              onPressed: () { Navigator.of(ctx).pop(false); onMessageSeller?.call(); },
            )
          else
          AdButton(
              label: busy ? 'Starting…' : 'Start negotiation',
              fullWidth: true,
              fontSize: 17,
              loading: busy,
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
                  setState(() { busy = false; error = 'Your agent has already talked to this listing. Use Message to reach the seller.'; });
                  return;
                }
                // P5: per-user daily cap of 10 agent conversations. The server is
                // the truth (a client counter would break across devices).
                if (res['status'] == 429 || res['error'] == 'agent_daily_limit') {
                  final cap = (res['cap'] as num?)?.toInt() ?? 10;
                  setState(() {
                    busy = false;
                    dailyLimited = true;
                    error = "You've chatted with $cap listing agents today — that's the daily limit. "
                        "It resets at midnight UTC. You can still message the seller directly.";
                  });
                  Analytics.capture('agent_daily_limit_shown', {'listing_id': listingId, 'cap': cap});
                  return;
                }
                if (res['ok'] == true) {
                  Navigator.of(ctx).pop(true);
                } else {
                  setState(() { busy = false; error = 'Could not start the negotiation. Try again.'; });
                }
              },
            ),
        ]),
      ),
    ),
  );
  return started == true;
}
