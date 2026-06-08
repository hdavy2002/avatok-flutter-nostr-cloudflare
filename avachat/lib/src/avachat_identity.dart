// AvaChat identity adapter (Phase: identity).
//
// Bridges 0xchat's "you are your nsec" model to AvaTalk's "a Clerk account owns a
// per-account-scoped Nostr key." On first run we mint a keypair, store it under a
// per-account-scoped secure key, and log 0xchat in with it — so the user lands
// straight in chat with a stable identity, no raw-nsec screen. Clerk linkage is
// additive (the backend gates on NIP-98 alone until Clerk JWKS is set).
//
// Real APIs used (verified against the vendored 0xchat @ 0a674a3):
//   Account.generateNewKeychain()                 -> Keychain(.private/.public)
//   Keychain.getPublicKey(privHex)                -> pubHex
//   Account.sharedInstance.loginWithPriKey(priv)  -> Future<UserDBISAR?>
//   OXUserInfoManager.sharedInstance.{isLogin, currentUserInfo, initDB,
//     handleSwitchFailures, loginSuccess}

import 'package:chatcore/chat-core.dart';
import 'package:nostr_core_dart/nostr.dart';
import 'package:ox_common/utils/ox_userinfo_manager.dart';

import 'avachat_config.dart';

/// Contract the host implements with real per-account scope + secure storage.
/// (DeviceSecureScope is the concrete flutter_secure_storage implementation.)
abstract class AvaChatSecureScope {
  String get accountId;
  Future<String?> read(String scopedKey);
  Future<void> write(String scopedKey, String value);
  Future<String?> clerkJwt();
}

class AvaChatIdentity {
  AvaChatIdentity._();
  static final AvaChatIdentity instance = AvaChatIdentity._();

  AvaChatSecureScope? _scope;

  void bindScope(AvaChatSecureScope scope) => _scope = scope;
  bool get hasScope => _scope != null;

  String _nsecKey(String accountId) => 'avachat.nsec::$accountId';

  /// The active account's private key (hex), or null if not provisioned/loaded.
  String? activePrivHex;

  /// Ensure a key exists for the active account; mint + persist on first run.
  /// Returns the private key hex.
  Future<String> _loadOrMintKey() async {
    final scope = _scope!;
    final key = _nsecKey(scope.accountId);
    var priv = await scope.read(key);
    if (priv == null || priv.isEmpty) {
      final kc = Account.generateNewKeychain();
      priv = kc.private;
      await scope.write(key, priv);
    }
    activePrivHex = priv;
    return priv;
  }

  /// Called AFTER 0xchat's AppInitializer has run (DB ready). If 0xchat already
  /// auto-restored a session, do nothing. Otherwise provision the scoped key and
  /// complete a real 0xchat login with it. Crash-safe.
  Future<void> ensureLoggedIn() async {
    try {
      if (_scope == null) return;
      final mgr = OXUserInfoManager.sharedInstance;
      if (mgr.isLogin) {
        // Keep our cached key in sync for NIP-98 signing of REST calls.
        activePrivHex ??= await _scope!.read(_nsecKey(_scope!.accountId));
        return;
      }

      final priv = await _loadOrMintKey();
      final pubkey = Keychain.getPublicKey(priv);
      final currentUserPubKey = mgr.currentUserInfo?.pubKey ?? '';

      await mgr.initDB(pubkey);
      var userDB = await Account.sharedInstance.loginWithPriKey(priv);
      userDB = await mgr.handleSwitchFailures(userDB, currentUserPubKey);
      if (userDB == null) return;
      await mgr.loginSuccess(userDB);

      await _linkKeyToClerk(pubkey);
    } catch (_) {
      // Never block app start; user can still use 0xchat's own login screen.
    }
  }

  /// Register pubkey <-> Clerk handle in our control plane (best-effort).
  Future<void> _linkKeyToClerk(String pubHex) async {
    // TODO(next): POST $apiBase/api/identity/link via AvaChatTransport (NIP-98 +
    // optional Clerk bearer). No-op-safe if already linked.
  }

  String get apiBase => AvaChatConfig.apiBase;
}
