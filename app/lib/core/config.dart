/// App-wide configuration.

/// Clerk publishable key (existing avatok.ai tenant) — public, ships in app.
const String kClerkPublishableKey = 'pk_live_Y2xlcmsuYXZhdG9rLmFpJA';

/// Worker endpoint to register a device's FCM token against an npub.
const String kRegisterUrl = 'https://avatok-call-signaling.getmystuffme.workers.dev/register';

/// Worker endpoint to ring a callee (sends a high-priority FCM wake push).
const String kCallUrl = 'https://avatok-call-signaling.getmystuffme.workers.dev/call';

/// Relay a call status (declined / busy / ended) to the caller via FCM.
const String kCallStatusUrl = 'https://avatok-call-signaling.getmystuffme.workers.dev/call-status';

/// Nudge recipients that a new message arrived (content-less wake).
const String kNotifyUrl = 'https://avatok-call-signaling.getmystuffme.workers.dev/notify';

/// Signaling host (no scheme). Baked at deploy time.
const String kSignalingHost = 'avatok-call-signaling.getmystuffme.workers.dev';

/// Calls backend — mints Cloudflare RealtimeKit participant tokens (AvaConsult).
const String kCallsJoinUrl = 'https://avatok-calls.getmystuffme.workers.dev/join';

/// AvaLive — creates/reuses a Cloudflare Stream live input, returns WHIP (publish)
/// + WHEP (play) URLs.
const String kLiveUrl = 'https://avatok-calls.getmystuffme.workers.dev/live';

/// AvaLive discovery — list announced live streams / end a stream.
const String kLiveListUrl = 'https://avatok-calls.getmystuffme.workers.dev/live/list';
const String kLiveEndUrl = 'https://avatok-calls.getmystuffme.workers.dev/live/end';

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

/// AvaTok Nostr relay (NIP-01) — real message delivery + NIP-44 encrypted DMs.
const String kNostrRelayUrl = 'wss://avatok-relay.getmystuffme.workers.dev/';

/// Account backup: export your relay data → download link (media excluded).
const String kBackupUrl = 'https://$kSignalingHost/backup';

/// Kind for AvaTok 1:1 chat messages (NIP-17 chat-message kind, NIP-44 content).
const int kDmKind = 14;

/// Short-video clip cap — capture auto-stops at this length.
const Duration kVideoClipMax = Duration(seconds: 30);

/// Fallback ICE servers if /ice can't be reached.
final List<Map<String, dynamic>> kIceServers = [
  {'urls': 'stun:stun.cloudflare.com:3478'},
  {'urls': 'stun:stun.l.google.com:19302'},
];
