/// App-wide configuration.

/// Clerk publishable key (existing avatok.ai tenant) — public, ships in app.
const String kClerkPublishableKey = 'pk_live_Y2xlcmsuYXZhdG9rLmFpJA';

/// Worker endpoint to register a device's FCM token against an npub.
const String kRegisterUrl = 'https://avatok-call-signaling.getmystuffme.workers.dev/register';

/// Worker endpoint to ring a callee (sends a high-priority FCM wake push).
const String kCallUrl = 'https://avatok-call-signaling.getmystuffme.workers.dev/call';

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

/// AvaTok public directory (NIP-05-style) — find people by @handle / name / npub.
const String kProfileUrl = 'https://$kSignalingHost/profile'; // POST upsert
const String kResolveUrl = 'https://$kSignalingHost/resolve'; // GET ?q=
const String kSearchUrl = 'https://$kSignalingHost/search';   // GET ?q=

/// Invite link base — share to bring a contact in pre-connected.
const String kInviteBase = 'https://avatok.ai/i/';

/// Encrypted, content-addressed chat media. POST ciphertext → {id}; GET /media/:id.
const String kMediaUrl = 'https://$kSignalingHost/media';

/// Short-video clip cap — capture auto-stops at this length.
const Duration kVideoClipMax = Duration(seconds: 30);

/// Fallback ICE servers if /ice can't be reached.
final List<Map<String, dynamic>> kIceServers = [
  {'urls': 'stun:stun.cloudflare.com:3478'},
  {'urls': 'stun:stun.l.google.com:19302'},
];
