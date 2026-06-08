// AvaChat wallet adapter (Phase 4) — AvaWallet/AvaCoins replaces Cashu.
//
// Decision: do NOT import cashu-dart and do NOT enable NIP-57 zaps. Anywhere the
// 0xchat UI would surface "send ecash" / "zap", route to AvaWallet instead
// (worker/src/routes/wallet.ts + WALLET_DO). This adapter is the seam; the
// grafted UI's payment buttons call these methods.

import 'avachat_config.dart';

class AvaWalletBalance {
  final int coins; // AvaCoins (integer minor units per wallet spec)
  const AvaWalletBalance(this.coins);
}

class AvaChatWallet {
  AvaChatWallet._();
  static final AvaChatWallet instance = AvaChatWallet._();

  bool get enabled => !AvaChatConfig.cashuEnabled; // AvaWallet is the only surface

  /// Current AvaCoins balance for the active account.
  Future<AvaWalletBalance> balance() async {
    // TODO(build): GET ${AvaChatConfig.walletBase}/balance (NIP-98 + Clerk).
    return const AvaWalletBalance(0);
  }

  /// Send AvaCoins to a contact (replaces 0xchat "send ecash"/zap).
  Future<bool> sendCoins({required String toPubkey, required int amount}) async {
    if (amount <= 0) return false;
    // TODO(build): POST ${AvaChatConfig.walletBase}/transfer {to,amount}
    // with NIP-98 + Clerk via AvaChatTransport. Server enforces balance/limits.
    return false;
  }

  /// Gate any zap affordance the grafted UI tries to render.
  bool get zapsEnabled => AvaChatConfig.zapsEnabled; // false in v1
}
