/// App-wide configuration.

/// Clerk publishable key (existing avatok.ai tenant) — public, ships in app.
const String kClerkPublishableKey = 'pk_live_Y2xlcmsuYXZhdG9rLmFpJA';

/// Worker endpoint to register a device's push token against an npub. (NIP-98)
const String kRegisterUrl = 'https://avatok-api.getmystuffme.workers.dev/api/register';

/// Worker endpoint to ring a callee (sends a high-priority FCM wake push). (NIP-98)
const String kCallUrl = 'https://avatok-api.getmystuffme.workers.dev/api/call';

/// Relay a call status (declined / busy / ended) to the caller via FCM. (NIP-98)
const String kCallStatusUrl = 'https://avatok-api.getmystuffme.workers.dev/api/call-status';

/// Nudge recipients that a new message arrived (content-less wake). (NIP-98)
const String kNotifyUrl = 'https://avatok-api.getmystuffme.workers.dev/api/notify';

/// Signaling host (no scheme). Baked at deploy time.
const String kSignalingHost = 'avatok-api.getmystuffme.workers.dev';

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
const String kIceUrl = 'https://$kSignalingHost/api/ice';

/// AvaTok public directory (NIP-05-style) — find people by @handle / name / npub.
const String kProfileUrl = 'https://$kSignalingHost/api/profile'; // POST upsert (NIP-98)
const String kResolveUrl = 'https://$kSignalingHost/api/resolve'; // GET ?q= (public)
const String kSearchUrl = 'https://$kSignalingHost/api/search';   // GET ?q= (public)
const String kHandleCheckUrl = 'https://$kSignalingHost/api/handle/check'; // GET ?q= (public)

/// Invite link base — share to bring a contact in pre-connected.
const String kInviteBase = 'https://avatok.ai/i/';

/// Public download / join page shared in invite messages.
const String kDownloadUrl = 'https://avatok.ai/download';

/// Device address-book sync + "who's on AvaTok" matching (NIP-98).
const String kContactsSyncUrl = 'https://$kSignalingHost/api/contacts/sync';   // POST
const String kContactsMatchUrl = 'https://$kSignalingHost/api/contacts/match'; // POST
const String kContactsListUrl = 'https://$kSignalingHost/api/contacts/list';   // GET

/// Communities — create/join (NIP-98) / list (public).
const String kCommunityUrl = 'https://$kSignalingHost/api/community';          // POST upsert
const String kCommunityJoinUrl = 'https://$kSignalingHost/api/community/join'; // POST
const String kCommunitiesUrl = 'https://$kSignalingHost/api/communities';      // GET ?member= | ?id=

/// Encrypted, content-addressed chat media. POST ciphertext (NIP-98) → {hash};
/// reads are served directly by the public Blossom bucket.
const String kUploadPrivateUrl = 'https://$kSignalingHost/upload/private'; // DM ciphertext
const String kUploadPublicUrl = 'https://$kSignalingHost/upload/public';   // public posts
const String kLibraryUrl = 'https://$kSignalingHost/api/library';          // GET (NIP-98)

/// Public R2 read host (no Worker in the path) — content-addressed by sha256.
const String kBlossomBaseUrl = 'https://blossom.avatok.ai';

/// AvaTok Nostr relay (NIP-01) — real message delivery + NIP-44 encrypted DMs.
const String kNostrRelayUrl = 'wss://avatok-relay.getmystuffme.workers.dev/';

/// Account backup: export your relay data → download link (media excluded). (NIP-98)
const String kBackupUrl = 'https://$kSignalingHost/api/backup';

/// AvaBrain — the per-user AI memory/reasoning layer. All dual-auth (NIP-98 + Clerk).
const String kBrainBase = 'https://$kSignalingHost/api/brain';

// ── Platform + agentic API bases (v5.2 Phases 1-8) ──────────────────────────
const String kApiBase = 'https://$kSignalingHost/api';
const String kIdBase = '$kApiBase/id';            // AvaID verification (Phase 1)
const String kWalletBase = '$kApiBase/wallet';    // AvaWallet (Phase 2)
const String kCalendarBase = '$kApiBase/calendar';// AvaCalendar (Phase 3)
const String kPayoutBase = '$kApiBase/payout';    // AvaPayout (Phase 4)
const String kOlxBase = '$kApiBase/olx';          // AvaOLX (Phase 5)
const String kAgentBase = '$kApiBase/agent';      // AvaBrain agentic layer (Phase 7-8)

/// Right-to-erasure: server-side cascade delete of all the user's media + data. (NIP-98 + Clerk)
const String kAccountDeleteUrl = 'https://$kSignalingHost/api/account/delete';

/// In-app notification feed (system/transactional — wallet, moderation, briefings). (NIP-98 + Clerk)
const String kNotificationsUrl = 'https://$kSignalingHost/api/notifications';

/// Kind for AvaTok 1:1 chat messages (NIP-17 chat-message kind, NIP-44 content).
const int kDmKind = 14;

/// Short-video clip cap — capture auto-stops at this length.
const Duration kVideoClipMax = Duration(seconds: 30);

/// Fallback ICE servers if /ice can't be reached.
final List<Map<String, dynamic>> kIceServers = [
  {'urls': 'stun:stun.cloudflare.com:3478'},
  {'urls': 'stun:stun.l.google.com:19302'},
];
