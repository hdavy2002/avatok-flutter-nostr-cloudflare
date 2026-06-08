// AvaChat feature gate (Phase 2) — what the grafted 0xchat UI may show.
//
// 0xchat ships MORE surfaces than the AvaChat v1 scope (NIP-29 relay groups,
// NIP-28 public channels, Cashu, zaps, badges). Rather than delete 0xchat
// screens (which would fork the submodule), the UI graft consults this gate to
// decide which entry points to render. One place to flip scope decisions.

import 'avachat_config.dart';

class AvaChatFeatureGate {
  AvaChatFeatureGate._();

  /// Private NIP-17 groups (<100) — ON. Creating/joining is allowed.
  static bool get privateGroups => true;

  /// NIP-29 relay groups (large/open/closed) — OFF in v1. Hide create/join.
  static bool get relayGroups => !AvaChatConfig.privateGroupsOnly;

  /// NIP-28 public channels — OFF in v1.
  static bool get publicChannels => AvaChatConfig.publicChannelsEnabled;

  /// Cashu ecash UI — OFF (AvaWallet only).
  static bool get cashu => AvaChatConfig.cashuEnabled;

  /// NIP-57 zap buttons — OFF in v1.
  static bool get zaps => AvaChatConfig.zapsEnabled;

  /// Call button visibility for a thread (1:1 only; group threads = no call).
  static bool callButton({required bool isGroupThread}) =>
      !(AvaChatConfig.oneToOneCallsOnly && isGroupThread);
}
