/// App-wide configuration.

/// Signaling host (no scheme). Baked at deploy time.
const String kSignalingHost = 'avatok-call-signaling.getmystuffme.workers.dev';

/// Calls backend — mints Cloudflare RealtimeKit participant tokens (AvaConsult).
const String kCallsJoinUrl = 'https://avatok-calls.getmystuffme.workers.dev/join';

/// AvaLive — creates/reuses a Cloudflare Stream live input, returns WHIP (publish)
/// + WHEP (play) URLs.
const String kLiveUrl = 'https://avatok-calls.getmystuffme.workers.dev/live';

/// Endpoint that returns ICE servers (Cloudflare STUN + short-lived TURN) so
/// 1:1 calls connect off-Wi-Fi / on cellular.
const String kIceUrl = 'https://$kSignalingHost/ice';

/// Fallback ICE servers if /ice can't be reached.
final List<Map<String, dynamic>> kIceServers = [
  {'urls': 'stun:stun.cloudflare.com:3478'},
  {'urls': 'stun:stun.l.google.com:19302'},
];
