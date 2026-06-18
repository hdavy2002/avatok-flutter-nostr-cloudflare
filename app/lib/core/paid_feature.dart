/// Paid-feature scaffolding (Phase 0 — Foundations). Premium Ava features (MCP
/// tool execution, image/voice generation, always-on Guardian) are visibly
/// separated and gated at the point of use:
///   • [PaidBadge]   — the reusable "PAID" sticker shown on premium rows.
///   • [PaidFeature] — a wrapper that, on tap, checks the wallet via [AvaWalletHook]
///                     and either runs the action (with a cost preview) or opens a
///                     top-up sheet (minimum top-up = [kMinTopUpUsd]).
///
/// The real wallet wiring (balance reads, spend, the live top-up sheet) lands in
/// a later phase — here [AvaWalletHook] is a thin interface with a safe default
/// stub so any phase can wrap an action now and have it light up later.
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'ui/zine.dart';
import 'ui/zine_widgets.dart';

/// Minimum wallet top-up, in USD. $10 unlocks premium AI (owner decision 2026-06-18,
/// matches the server MIN_TOPUP). The alternative to topping up is adding your own
/// free AI Studio key in Settings.
const int kMinTopUpUsd = 10;

/// Wallet access contract used by [PaidFeature]. A later phase (AvaWallet wiring)
/// sets [AvaWalletHook.instance] to a real implementation backed by WalletDO /
/// /api/wallet/balance + /api/wallet/spend. Until then the default stub treats
/// the wallet as empty so premium taps route to the top-up sheet (fail-safe: we
/// never silently "spend" against an unwired wallet).
abstract class AvaWalletHook {
  /// Whether the account can spend [coins] AvaCoins right now.
  Future<bool> canSpend(int coins);

  /// Deduct [coins] for [reason]; returns true on success. TODO(wallet phase):
  /// back this with the WalletDO spend op (idempotent op_id).
  Future<bool> spend(int coins, {required String reason});

  /// Open the real top-up sheet ($5 min). Returns true if the user topped up.
  /// TODO(wallet phase): present the live Stripe/AvaCoins top-up flow.
  Future<bool> openTopUp(BuildContext context, {int? suggestedUsd});

  /// The active hook. Defaults to an empty-wallet stub.
  static AvaWalletHook instance = const _StubWallet();
}

class _StubWallet implements AvaWalletHook {
  const _StubWallet();
  @override
  Future<bool> canSpend(int coins) async => false;
  @override
  Future<bool> spend(int coins, {required String reason}) async => false;
  @override
  Future<bool> openTopUp(BuildContext context, {int? suggestedUsd}) async {
    // Stub top-up sheet — Zine styled. The wallet phase replaces this with the
    // live flow; the contract (returns true on successful top-up) is stable.
    if (!context.mounted) return false;
    final res = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.wallet(PhosphorIconsStyle.fill), color: Zine.mint, size: 36),
              const SizedBox(width: 12),
              Expanded(child: Text('Top up to use this', style: ZineText.cardTitle(size: 18))),
            ]),
            const SizedBox(height: 12),
            Text('Premium Ava features run on AvaCoins. Add coins to your wallet '
                '(minimum \$$kMinTopUpUsd) to unlock image and voice generation, '
                'MCP tools, and always-on Guardian.',
                style: ZineText.sub(size: 13.5)),
            const SizedBox(height: 18),
            ZineButton(
              label: 'Add \$$kMinTopUpUsd to wallet',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              icon: PhosphorIcons.plusCircle(PhosphorIconsStyle.bold),
              trailingIcon: false,
              // TODO(wallet phase): wire to the real top-up flow, then pop(true).
              onPressed: () => Navigator.pop(ctx, false),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft)),
            ),
          ]),
        ),
      ),
    );
    return res ?? false;
  }
}

/// Reusable "PAID" badge — mint (money) sticker with the standard ink border.
/// Drop it on any premium row/tile/button.
class PaidBadge extends StatelessWidget {
  final String label;
  const PaidBadge({super.key, this.label = 'PAID'});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Zine.mint,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 2),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.coins(PhosphorIconsStyle.fill), size: 11, color: Zine.mintInk),
          const SizedBox(width: 4),
          Text(label, style: ZineText.tag(size: 9.5, color: Zine.mintInk)),
        ]),
      );
}

/// Wraps a premium action. Tapping [child] runs [onRun] only if the wallet can
/// cover [costCoins]; otherwise it shows the cost preview and opens the top-up
/// sheet. Set [costCoins] to 0 for "subscription/feature-gated" actions that
/// just need a non-empty wallet check.
class PaidFeature extends StatelessWidget {
  final Widget child;

  /// Cost preview, e.g. "Generate image" → shown as "Generate image — 20 coins".
  final String actionLabel;
  final int costCoins;

  /// The actual premium action; invoked only after a successful balance check
  /// (and, when [costCoins] > 0, a successful spend).
  final Future<void> Function() onRun;

  /// Override the wallet hook (tests / previews). Defaults to the global instance.
  final AvaWalletHook? wallet;

  const PaidFeature({
    super.key,
    required this.child,
    required this.actionLabel,
    required this.onRun,
    this.costCoins = 0,
    this.wallet,
  });

  AvaWalletHook get _w => wallet ?? AvaWalletHook.instance;

  Future<void> _onTap(BuildContext context) async {
    final ok = await _w.canSpend(costCoins);
    if (!ok) {
      if (!context.mounted) return;
      // Show the cost preview, then route to top-up.
      if (costCoins > 0) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('$actionLabel — $costCoins coins. Top up to continue.')));
      }
      await _w.openTopUp(context, suggestedUsd: kMinTopUpUsd);
      return;
    }
    if (costCoins > 0) {
      final spent = await _w.spend(costCoins, reason: actionLabel);
      if (!spent) {
        if (context.mounted) await _w.openTopUp(context, suggestedUsd: kMinTopUpUsd);
        return;
      }
    }
    await onRun();
  }

  @override
  Widget build(BuildContext context) => GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => _onTap(context),
        child: child,
      );
}
