// AvaChat bootstrap — the single injection seam into the 0xchat client.
//
// 0xchat exposes its relay recommendation lists as PUBLIC MUTABLE fields on the
// `Relays` singleton (see external/0xchat-core/lib/src/account/relays.dart) and
// drives all networking through the `Connect` and `Account` singletons. That
// lets us repoint the entire client onto the AvaTalk backend WITHOUT patching
// any submodule source — we just overwrite those fields before 0xchat inits.
//
// Wiring (one line in the 0xchat entrypoint, see avachat/patches/):
//     WidgetsFlutterBinding.ensureInitialized();
//     await AvaChatBootstrap.init();   // <-- add this before runApp(...)
//     runApp(const OXChatApp());
//
// Everything below targets real 0xchat-core APIs confirmed against
// 0xchat-core @ 76675e7. Lines marked TODO(build) need a compile pass to bind
// to the exact upstream symbol (we cannot run Flutter in this environment).

import 'package:chatcore/chat-core.dart';

import 'avachat_config.dart';
import 'avachat_identity.dart';
import 'avachat_secure_scope.dart';
import 'avachat_transport.dart';

class AvaChatBootstrap {
  static bool _done = false;

  /// Call once, before 0xchat's runApp(). Idempotent and crash-safe: the only
  /// critical step is repointing relays (always succeeds). The AvaChat-specific
  /// layers (Clerk identity, TURN, brain) are additive and not yet wired into
  /// 0xchat's UI, so they are best-effort — a missing scope must NOT crash the
  /// app. Until those seams are bound, the app runs as 0xchat (nsec login +
  /// gift-wrap DMs) over the AvaTok relay.
  static Future<void> init() async {
    if (_done) return;
    _done = true;

    // Critical: point the whole client at our relay.
    try {
      _repointRelays();
    } catch (_) {/* never block app start */}

    // Bind the concrete per-account secure storage so identity + transport can
    // provision/sign. Actual login happens in ensureLoggedIn() AFTER 0xchat's
    // AppInitializer (DB must be ready) — see the second injection in main().
    try {
      final scope = DeviceSecureScope();
      AvaChatIdentity.instance.bindScope(scope);
      AvaChatBootstrapScopeRef.scope = scope;
    } catch (_) {}
  }

  /// Collapse every 0xchat relay kind onto our single authenticated relay.
  /// These are public List<String> fields on the Relays singleton, so this is
  /// a pure runtime override — the submodule stays pristine.
  static void _repointRelays() {
    final one = AvaChatConfig.singleRelayList;
    final relays = Relays.sharedInstance
      ..recommendGlobalRelays = one
      ..recommendGeneralRelays = one
      ..recommendDMRelays = one
      ..recommendSecretChatRelays = one
      ..recommendSearchRelays = one;

    // Private-groups-only: do NOT advertise NIP-29 group relays. Point the group
    // relay list at our relay so any group UI that reads it stays in-ecosystem;
    // large/relay groups are gated off at the UI layer (see AvaChatFeatureGate).
    if (AvaChatConfig.privateGroupsOnly) {
      relays.recommendGroupRelays = one;
    }
  }
}
