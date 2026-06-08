// AvaChat identity adapter (Phase 1).
//
// 0xchat assumes "the user IS their nsec." AvaTalk assumes "the user is a Clerk
// account that OWNS a per-account-scoped Nostr keypair." This adapter bridges
// the two: it provisions/loads the keypair through Clerk, stores it under a
// per-account-scoped key (parent + each child share one phone — a raw global
// key would leak identities across accounts), and logs 0xchat in with it.
//
// Real 0xchat-core APIs used (confirmed @ 76675e7):
//   Account.sharedInstance.loginWithPriKey(privHex)  -> Future<UserDBISAR?>
//   Account.generateNewKeychain()                    -> Keychain (private/public)
//   Account.sharedInstance.logout()
//
// Storage MUST be namespaced. In the AvaTok app this is scopedKey()/AccountScope
// (app/lib/core/account_storage.dart). Here we depend on a thin interface so the
// adapter stays decoupled; the app wires the concrete implementation.

import 'package:chatcore/chat-core.dart';

import 'avachat_config.dart';

/// Minimal contract the host app implements with its real per-account scope +
/// secure storage (flutter_secure_storage in AvaTok). Keeps this library free
/// of platform plugins so it builds/tests headless.
abstract class AvaChatSecureScope {
  /// Stable id of the CURRENTLY ACTIVE account (parent or a specific child).
  String get accountId;

  /// Read a per-account-scoped secret. Returns null if absent.
  Future<String?> read(String scopedKey);

  /// Write a per-account-scoped secret.
  Future<void> write(String scopedKey, String value);

  /// Clerk session JWT for the active account (for control-plane calls).
  Future<String?> clerkJwt();
}

class AvaChatIdentity {
  AvaChatIdentity._();
  static final AvaChatIdentity instance = AvaChatIdentity._();

  AvaChatSecureScope? _scope;

  /// Host app injects its real scope/storage exactly once at startup.
  void bindScope(AvaChatSecureScope scope) => _scope = scope;

  // Per-account-scoped storage key for this account's Nostr secret key.
  String _nsecKey(String accountId) => 'avachat.nsec::$accountId';

  /// Load the account's keypair (or mint+link one on first run) and log 0xchat
  /// in with it. Called from AvaChatBootstrap.init().
  Future<UserDBISAR?> restoreOrProvision() async {
    final scope = _scope;
    if (scope == null) {
      // Fail loud: shipping without a bound scope would risk a global key.
      throw StateError(
          'AvaChatIdentity.bindScope() must be called before init(); '
          'per-account scoping is mandatory.');
    }

    final key = _nsecKey(scope.accountId);
    var privHex = await scope.read(key);

    if (privHex == null || privHex.isEmpty) {
      // First login on this account → mint a keypair, persist scoped, and link
      // it to the Clerk account server-side so it survives reinstall.
      final kc = Account.generateNewKeychain();
      privHex = kc.private;
      await scope.write(key, privHex);
      await _linkKeyToClerk(scope, kc.public);
    }

    return Account.sharedInstance.loginWithPriKey(privHex);
  }

  /// Register pubkey ↔ Clerk handle in our control plane (clerk_nostr_link).
  /// Mutation → NIP-98 signed + Clerk JWT (see AvaChatTransport).
  Future<void> _linkKeyToClerk(AvaChatSecureScope scope, String pubHex) async {
    // TODO(build): POST $apiBase/api/identity/link {pubkey} with Clerk JWT +
    // NIP-98 header via AvaChatTransport.signedPost. Endpoint exists as
    // worker/src/routes/identity.ts. No-op-safe if already linked.
  }

  /// Switch active account (parent <-> child): log out 0xchat, then re-provision
  /// under the new scope. The host app updates AccountScope BEFORE calling this.
  Future<void> switchAccount() async {
    await Account.sharedInstance.logout();
    await restoreOrProvision();
  }

  String get apiBase => AvaChatConfig.apiBase;
}
