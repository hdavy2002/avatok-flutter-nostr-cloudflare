// AvaChat × 0xchat integration library — public surface.
//
// Import this from the 0xchat entrypoint and call AvaChatBootstrap.init() before
// runApp(). Everything the graft needs (config, identity, transport, calls,
// wallet, brain, feature gate) is exported here.
library avachat;

export 'src/avachat_config.dart';
export 'src/avachat_bootstrap.dart';
export 'src/avachat_identity.dart';
export 'src/avachat_transport.dart';
export 'src/avachat_calls.dart';
export 'src/avachat_wallet.dart';
export 'src/avachat_brain.dart';
export 'src/avachat_feature_gate.dart';
