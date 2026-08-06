import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/disk_cache.dart';
import '../../core/money_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../identity/identity.dart';
import 'wallet_screen.dart';

/// [WALLET-UX-1] Shared last-known wallet balance for lightweight header chips.
///
/// ONE app-wide ValueNotifier: loaded once from /api/wallet/balance on first
/// use, and pushed fresh values by the wallet screen whenever it refreshes
/// (top-up credited, pull-to-refresh, Play Billing landing). No polling loops —
/// the chip just listens. The number is the TOTAL SPENDABLE tokens (paid +
/// welcome bonus + daily free), i.e. the DO snap()'s `spendable`, matching the
/// wallet screen's hero balance.
///
/// [UI-COLDSTART-WALLET-1 2026-08-06] The value is now PERSISTED, because it
/// previously wasn't at all: `spendable` started null on every cold launch and
/// the only way to fill it was a signed network round-trip. The chip rendered
/// `SizedBox.shrink()` meanwhile, so the header painted with NO chip and then a
/// chip APPEARED a second later, shoving the status avatar / filter / bell
/// leftwards. That pop-in is a large part of the "the app settles after launch"
/// complaint. Now: hydrate the last-known number from disk (local file read, no
/// network, never awaited before a frame), render it immediately, and correct
/// it in place when the network answers.
class WalletBalanceStore {
  WalletBalanceStore._();

  /// Per-account cache file name. [DiskCache] already namespaces every entry
  /// under `cache/<AccountScope.id>/`, so two accounts on one shared phone can
  /// never read each other's balance — the repo's per-account-scoping rule
  /// applies with extra force to a money value.
  static const _cacheKey = 'wallet_balance_v1';

  /// null until the first balance lands (from disk or network).
  static final ValueNotifier<int?> spendable = ValueNotifier<int?>(null);
  static bool _loadedOnce = false;
  static bool _hydrateStarted = false;

  /// Which account the in-memory [spendable] belongs to. The notifier is a
  /// process-wide static; without this an account switch would leave the
  /// previous user's number on screen until the network answered.
  static String? _valueScope;
  static String _scope() {
    final id = AccountScope.id;
    return (id == null || id.isEmpty) ? 'guest' : id;
  }

  /// Drop everything the moment the active account changes. Cheap; called at
  /// the top of every entry point.
  static void _syncScope() {
    final s = _scope();
    if (_valueScope == s) return;
    _valueScope = s;
    spendable.value = null;
    _loadedOnce = false;
    _hydrateStarted = false;
  }

  /// Paint-path safe: reads the last-known balance off local disk and publishes
  /// it if nothing fresher has arrived. Idempotent, never throws, never
  /// networks. Callers must NOT await this before building.
  static Future<void> hydrate() async {
    _syncScope();
    if (_hydrateStarted) return;
    _hydrateStarted = true;
    final scope = _valueScope;
    try {
      final raw = await DiskCache.read(_cacheKey);
      if (raw == null) return;
      final n = int.tryParse(raw.trim());
      if (n == null) return;
      // Don't clobber a fresher value: the network reply, or a wallet-screen
      // push, may have landed while this file read was in flight. Also bail if
      // the account changed underneath us.
      if (_valueScope != scope) return;
      if (spendable.value == null) spendable.value = n;
    } catch (_) {/* a cache miss must never break the header */}
  }

  /// Fetch once per app run (unless [force]); safe to call from any screen.
  static Future<void> load({bool force = false}) async {
    _syncScope();
    if (_loadedOnce && !force) return;
    _loadedOnce = true;
    final scope = _valueScope;
    try {
      final b = await MoneyApi.balance();
      final n = (b['spendable'] ?? b['balance']) as num?;
      if (n != null && _valueScope == scope) {
        spendable.value = n.toInt();
        _persist(n.toInt());
      }
    } catch (_) {/* keep last value; header chip is best-effort */}
  }

  /// Called by the wallet screen after every balance refresh.
  static void set(int v) {
    _syncScope();
    _loadedOnce = true;
    _hydrateStarted = true; // an authoritative value beats anything on disk
    spendable.value = v;
    _persist(v);
  }

  /// Fire-and-forget write of the last-known balance. [DiskCache.write] already
  /// swallows and logs its own failures.
  static void _persist(int v) {
    unawaited(DiskCache.write(_cacheKey, '$v'));
  }
}

/// Compact header chip: coin icon + total spendable tokens (₹1 = 1 token).
/// Tapping opens the wallet. Same visual family as [AdChip] (pill, hairline
/// border, [ADText.tabLabel]) so it sits naturally in the AvaTalk header band.
///
/// [UI-COLDSTART-WALLET-1] The chip's FOOTPRINT IS FIXED ([kWalletChipWidth]).
/// It occupies exactly the same width whether the balance is unknown, 100 or
/// 100,000, so nothing to its right can ever be shoved sideways by a number
/// arriving late or growing a digit. The digits themselves scale down inside
/// the reserved box rather than widening it. There is deliberately no spinner:
/// a stale-but-present number that quietly corrects itself is the goal.
class WalletBalanceChip extends StatefulWidget {
  const WalletBalanceChip({super.key});
  @override
  State<WalletBalanceChip> createState() => _WalletBalanceChipState();
}

/// Reserved header width of [WalletBalanceChip], value present or not.
/// 24 padding + 2 border + 14 icon + 4 gap leaves ~38pt for the digits, which
/// covers up to "9,999" at full size; anything longer scales down in place.
const double kWalletChipWidth = 82.0;

class _WalletBalanceChipState extends State<WalletBalanceChip> {
  @override
  void initState() {
    super.initState();
    // Local disk first (fast, no network) so the previous number is on screen
    // essentially immediately, THEN the signed network refresh which corrects
    // it in place. Neither is awaited — this is the paint path.
    unawaited(WalletBalanceStore.hydrate());
    unawaited(WalletBalanceStore.load());
  }

  /// Compact token count, e.g. 10000 → "10,000" (same as the wallet screen).
  static String _tokens(num coins) {
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
    return SizedBox(
      width: kWalletChipWidth,
      child: ValueListenableBuilder<int?>(
        valueListenable: WalletBalanceStore.spendable,
        builder: (context, v, _) {
          // Unknown balance (first ever launch, or a wiped cache): keep the
          // reserved box EMPTY rather than showing a wrong "0". The layout is
          // already stable, so the number simply fades in where it belongs
          // instead of pushing the header around.
          if (v == null) return const SizedBox.shrink();
          return GestureDetector(
            onTap: () {
              Analytics.capture('wallet_header_chip_tapped', {'balance_coins': v});
              Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const WalletScreen()));
            },
            behavior: HitTestBehavior.opaque,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s2),
              decoration: BoxDecoration(
                color: AD.card,
                // A chip IS one of the shapes a pill is reserved for.
                borderRadius: Msg.brPill,
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              // MainAxisSize.max (the default) is deliberate: the Expanded below
              // needs the row to fill the reserved box, which is what keeps the
              // pill one constant size at every balance.
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.coins(PhosphorIconsStyle.regular),
                    size: 14, color: AD.online),
                const SizedBox(width: Msg.s1),
                // Expanded + scaleDown: a long balance shrinks its glyphs
                // instead of widening the chip and reflowing the header.
                Expanded(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(_tokens(v), maxLines: 1, style: ADText.tabLabel()),
                  ),
                ),
              ]),
            ),
          );
        },
      ),
    );
  }
}
