/// App-wide configuration.
library;

import 'feature_flags.dart';

/// Clerk publishable key (existing avatok.ai tenant) — public, ships in app.
const String kClerkPublishableKey = 'pk_live_Y2xlcmsuYXZhdG9rLmFpJA';

/// Worker endpoint to register a device's push token against an npub. (NIP-98)
const String kRegisterUrl = 'https://$kSignalingHost/api/register';

/// Worker endpoint to ring a callee (sends a high-priority FCM wake push). (NIP-98)
const String kCallUrl = 'https://$kSignalingHost/api/call';

/// Relay a call status (declined / busy / ended) to the caller via FCM. (NIP-98)
const String kCallStatusUrl = 'https://$kSignalingHost/api/call-status';

/// Nudge recipients that a new message arrived (content-less wake). (NIP-98)
const String kNotifyUrl = 'https://$kSignalingHost/api/notify';

/// Signaling host (no scheme). Baked at compile time; the staging APK flavor
/// (--dart-define=AVATOK_ENV=staging, Phase 1 A1) talks to the staging worker.
const String kSignalingHost =
    kAvatokEnv == 'staging' ? 'api-staging.avatok.ai' : 'api.avatok.ai';

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
const String kMeUrl = 'https://$kSignalingHost/api/me'; // GET — restore my account by Clerk session
const String kVaultUrl = 'https://$kSignalingHost/api/vault'; // GET/POST — encrypted cross-device blobs (contacts)
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
const String kLibraryTreeUrl = 'https://$kSignalingHost/api/library/tree';      // GET nav skeleton
const String kLibraryFoldersUrl = 'https://$kSignalingHost/api/library/folders'; // GET/POST/PATCH/DELETE
const String kLibraryMoveUrl = 'https://$kSignalingHost/api/library/move';      // POST {id, folder_id, app?}
const String kLibraryCopyUrl = 'https://$kSignalingHost/api/library/copy';      // POST {id, folder_id, app?}
const String kLibraryFolderMoveUrl = 'https://$kSignalingHost/api/library/folders/move'; // POST {id, app?, parent_id?}
const String kLibraryFolderCopyUrl = 'https://$kSignalingHost/api/library/folders/copy'; // POST {id, app?, parent_id?}
const String kLibraryDeleteUrl = 'https://$kSignalingHost/api/library/delete';  // POST {id}
const String kLibraryRecordUrl = 'https://$kSignalingHost/api/library/record';  // POST received entry
const String kStorageUrl = 'https://$kSignalingHost/api/storage';               // GET accounting
const String kBrainConsentUrl = 'https://$kSignalingHost/api/brain/consent';    // GET/POST toggles

/// Public R2 read host (no Worker in the path) — content-addressed by sha256.
const String kBlossomBaseUrl = 'https://blossom.avatok.ai';

/// DEPRECATED (Nostr removed). Kept as a harmless constant so legacy screens that
/// still construct a NostrClient(kNostrRelayUrl) compile; the client is now a
/// compat stub and the real transport is the per-user InboxDO below.
const String kNostrRelayUrl = 'wss://relay.avatok.ai/';

// ── Cloudflare-native messaging (Nostr deprecated) ──────────────────────────
// Per-user InboxDO WebSocket + HTTP send/sync/receipt. Auth = Clerk JWT, passed
// as ?token= on the socket and as the Authorization bearer on HTTP.
const String kInboxWsUrl = 'wss://$kSignalingHost/api/inbox';
const String kMsgSendUrl = 'https://$kSignalingHost/api/msg/send';
const String kMsgSyncUrl = 'https://$kSignalingHost/api/msg/sync';
const String kMsgReceiptUrl = 'https://$kSignalingHost/api/msg/receipt';
const String kConversationsUrl = 'https://$kSignalingHost/api/conversations';

/// Deterministic 1:1 conversation id — MUST match server authz.dmConvId.
String dmConvId(String a, String b) {
  final lo = a.compareTo(b) <= 0 ? a : b;
  final hi = a.compareTo(b) <= 0 ? b : a;
  return 'dm_${lo}__$hi';
}

/// Peer uid from a dm conversation id, given my uid.
String? dmPeer(String conv, String myUid) {
  if (!conv.startsWith('dm_')) return null;
  final parts = conv.substring(3).split('__');
  if (parts.length != 2) return null;
  return parts[0] == myUid ? parts[1] : parts[0];
}

/// Account backup: export your relay data → download link (media excluded). (NIP-98)
const String kBackupUrl = 'https://$kSignalingHost/api/backup';

/// AvaBrain — the per-user AI memory/reasoning layer. All dual-auth (NIP-98 + Clerk).
const String kBrainBase = 'https://$kSignalingHost/api/brain';

// ── Platform + agentic API bases (v5.2 Phases 1-8) ──────────────────────────
const String kApiBase = 'https://$kSignalingHost/api';

/// Remote kill switches / server config (creator-marketplace Phase 1, A2).
const String kConfigUrl = '$kApiBase/config';
const String kIdBase = '$kApiBase/id';            // AvaID verification (Phase 1)

// ── Onboarding verification (age/gender + phone OTP + email OTP) ─────────────
// Phone OTP is handled client-side by Firebase Auth; these are the email-OTP
// + phone-confirm endpoints the Worker must expose (email sent via Brevo).
const String kEmailOtpStartUrl = '$kIdBase/email/start';   // POST {email}
const String kEmailOtpVerifyUrl = '$kIdBase/email/verify'; // POST {email, code}
const String kPhoneConfirmUrl = '$kIdBase/phone/confirm';  // POST {phone}
// Future: video / liveness verification (events piped now; endpoints later).
const String kLivenessStartUrl = '$kIdBase/liveness/start';   // POST -> {session_id}
const String kLivenessResultUrl = '$kIdBase/liveness/result'; // POST {session_id}

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
