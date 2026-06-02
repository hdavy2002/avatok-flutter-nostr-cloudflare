/// App-wide configuration.

/// Signaling host (no scheme). Baked at deploy time.
const String kSignalingHost = 'avatok-call-signaling.getmystuffme.workers.dev';

/// Calls backend — mints Cloudflare RealtimeKit participant tokens (SFU group
/// calls + AvaLive livestream).
const String kCallsJoinUrl = 'https://avatok-calls.getmystuffme.workers.dev/join';

/// ICE servers — Cloudflare + Google STUN. Same-network calls work with STUN
/// alone; cross-network needs TURN (Stage 5, via Cloudflare Calls).
final List<Map<String, dynamic>> kIceServers = [
  {'urls': 'stun:stun.cloudflare.com:3478'},
  {'urls': 'stun:stun.l.google.com:19302'},
];
