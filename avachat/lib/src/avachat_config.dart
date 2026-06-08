// AvaChat × 0xchat — central configuration.
//
// Single source of truth for every endpoint and feature flag that the
// 0xchat client must be pointed at to run inside the AvaTalk ecosystem.
// Values mirror app/lib/core/config.dart (the existing AvaTok client) so the
// grafted UI and our native shell talk to the same backend.
//
// NOTE: this file is build-independent (no Flutter imports) so it can be unit
// tested and referenced from CI without a device.

class AvaChatConfig {
  AvaChatConfig._();

  // --- Nostr relay (single Cloudflare DO relay; collapses 0xchat's multi-relay
  // model onto our one authenticated relay). Trailing slash matches app config.
  static const String relayUrl = 'wss://avatok-relay.getmystuffme.workers.dev/';

  // --- HTTP control plane (NIP-98 signed mutations + Clerk JWT).
  static const String apiBase = 'https://avatok-api.getmystuffme.workers.dev';
  static const String signalingBase = 'https://avatok-calls.getmystuffme.workers.dev';

  // ICE/TURN credential mint for WebRTC (Cloudflare Realtime TURN).
  static const String iceUrl = '$signalingBase/api/ice';

  // AvaBrain: on-device DM fact extraction sync endpoint (never sends raw DM).
  static const String brainRememberUrl = '$apiBase/api/brain/remember';

  // AvaWallet (AvaCoins) — replaces 0xchat's Cashu/zap surfaces.
  static const String walletBase = '$apiBase/api/wallet';

  // Media: 0xchat speaks Blossom/NIP-96 natively → point at our Blossom host.
  static const String blossomMediaServer = 'https://blossom.avatok.ai';

  // --- Feature flags locked by the 2026-06-08 decisions -------------------
  /// Private NIP-17 groups only (<100). NIP-29 relay groups disabled for v1.
  static const bool privateGroupsOnly = true;

  /// Do NOT import/enable Cashu ecash. AvaWallet is the only payment surface.
  static const bool cashuEnabled = false;

  /// No NIP-57 zaps in v1.
  static const bool zapsEnabled = false;

  /// Calls are strictly 1:1 P2P (AvaTOK rule). Group calling lives in AvaConsult.
  static const bool oneToOneCallsOnly = true;

  /// Public Nostr channels (NIP-28) off by default for the ecosystem build.
  static const bool publicChannelsEnabled = false;

  /// The single relay, expressed as the only entry for every 0xchat relay kind.
  static List<String> get singleRelayList => const [relayUrl];
}
