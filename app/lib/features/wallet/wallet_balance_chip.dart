import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/ui/avatok_dark.dart';
import 'wallet_screen.dart';

/// [WALLET-UX-1] Shared last-known wallet balance for lightweight header chips.
///
/// ONE app-wide ValueNotifier: loaded once from /api/wallet/balance on first
/// use, and pushed fresh values by the wallet screen whenever it refreshes
/// (top-up credited, pull-to-refresh, Play Billing landing). No polling loops —
/// the chip just listens. The number is the TOTAL SPENDABLE tokens (paid +
/// welcome bonus + daily free), i.e. the DO snap()'s `spendable`, matching the
/// wallet screen's hero balance.
class WalletBalanceStore {
  WalletBalanceStore._();

  /// null until the first balance lands (chip renders nothing meanwhile).
  static final ValueNotifier<int?> spendable = ValueNotifier<int?>(null);
  static bool _loadedOnce = false;

  /// Fetch once per app run (unless [force]); safe to call from any screen.
  static Future<void> load({bool force = false}) async {
    if (_loadedOnce && !force) return;
    _loadedOnce = true;
    try {
      final b = await MoneyApi.balance();
      final n = (b['spendable'] ?? b['balance']) as num?;
      if (n != null) spendable.value = n.toInt();
    } catch (_) {/* keep last value; header chip is best-effort */}
  }

  /// Called by the wallet screen after every balance refresh.
  static void set(int v) {
    _loadedOnce = true;
    spendable.value = v;
  }
}

/// Compact header chip: coin icon + total spendable tokens. Tapping opens the
/// wallet. Same visual family as [AdChip] (pill, hairline border, 12.5/800
/// label) so it sits naturally in the AvaTalk header band. Renders nothing
/// until the first balance is known — the header never shows a wrong "0".
class WalletBalanceChip extends StatefulWidget {
  const WalletBalanceChip({super.key});
  @override
  State<WalletBalanceChip> createState() => _WalletBalanceChipState();
}

class _WalletBalanceChipState extends State<WalletBalanceChip> {
  @override
  void initState() {
    super.initState();
    WalletBalanceStore.load();
  }

  /// Compact coin count, e.g. 10000 → "10,000" (same as the wallet screen).
  static String _coins(num coins) {
    final s = coins.abs().toInt().toString();
    final b = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
      b.write(s[i]);
    }
    return b.toString();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int?>(
      valueListenable: WalletBalanceStore.spendable,
      builder: (context, v, _) {
        if (v == null) return const SizedBox.shrink();
        return GestureDetector(
          onTap: () {
            Analytics.capture('wallet_header_chip_tapped', {'balance_coins': v});
            Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const WalletScreen()));
          },
          behavior: HitTestBehavior.opaque,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              color: AD.card,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.coins(PhosphorIconsStyle.bold),
                  size: 14, color: AD.online),
              const SizedBox(width: 5),
              Text(_coins(v),
                  style: TextStyle(
                      fontFamily: ADText.family,
                      fontWeight: FontWeight.w800,
                      fontSize: 12.5,
                      color: AD.textPrimary)),
            ]),
          ),
        );
      },
    );
  }
}
