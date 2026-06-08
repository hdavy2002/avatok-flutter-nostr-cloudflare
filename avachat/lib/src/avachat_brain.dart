// AvaChat AvaBrain adapter (Phase 4) — on-device DM fact extraction.
//
// AvaBrain is ON by default (opt-out). Privacy invariant: private/E2E content is
// read ON-DEVICE only. We NEVER send raw DM text anywhere — the relay explicitly
// excludes DM kinds from its BRAIN_KINDS, and DM facts are extracted client-side
// and synced as non-reversible derived data via /api/brain/remember.
//
// This adapter subscribes to 0xchat's decrypted-message stream locally, runs the
// extractor on-device, and posts only derived facts (gated by the per-app
// AvaBrain toggle + the master switch).

import 'avachat_config.dart';

abstract class AvaBrainConsent {
  /// Master AvaBrain switch AND the AvaChat per-app guardrail toggle, ANDed.
  bool get brainEnabledForChat;
}

class AvaChatBrain {
  AvaChatBrain._();
  static final AvaChatBrain instance = AvaChatBrain._();

  AvaBrainConsent? _consent;
  void bindConsent(AvaBrainConsent c) => _consent = c;

  bool get _enabled => _consent?.brainEnabledForChat ?? true; // default ON

  /// Hook into 0xchat's decrypted DM stream (on-device). Call from bootstrap.
  void attach() {
    if (!_enabled) return;
    // TODO(build): subscribe to Messages' decrypted-message callback in
    // 0xchat-core (chat/messages) and pass plaintext to _onDecryptedDm LOCALLY.
  }

  /// Runs on-device only. Extracts derived facts; raw text never leaves device.
  Future<void> onDecryptedDm(String plaintext, {required String peerPubkey}) async {
    if (!_enabled) return;
    final facts = _extractOnDevice(plaintext);
    if (facts.isEmpty) return;
    await _remember(facts, peerPubkey: peerPubkey);
  }

  List<String> _extractOnDevice(String text) {
    // TODO(build): on-device extractor (no network). Returns non-reversible
    // derived facts only.
    return const [];
  }

  Future<void> _remember(List<String> facts, {required String peerPubkey}) async {
    // TODO(build): POST ${AvaChatConfig.brainRememberUrl} {facts} (NIP-98 +
    // Clerk). Derived, non-reversible data only — never raw DM content.
  }
}
