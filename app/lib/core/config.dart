/// App-wide configuration.
library;

import 'feature_flags.dart';

/// Clerk publishable key (existing avatok.ai tenant) — public, ships in app.
const String kClerkPublishableKey = 'pk_live_Y2xlcmsuYXZhdG9rLmFpJA';

/// Google WEB OAuth client id used as the native `google_sign_in` serverClientId
/// (the ID-token audience the Worker `/api/auth/google` verifies). MIGRATED
/// 2026-06-30 to the healthy **avatok-e19ef** project (#1098288797441) — the same
/// project as the app's google-services.json — after the old `avatok` project
/// (#604131207750) was deleted and its restored clients no longer minted tokens
/// (Android 12500 SIGN_IN_FAILED). avatok-e19ef hosts this web client plus two
/// Android clients (package ai.avatok.avatok_call, Play app-signing + upload
/// SHA-1s); consent screen is published to Production. The Worker ALLOWED_AUD
/// accepts both this and the old id during rollout.
const String kGoogleServerClientId =
    '1098288797441-rkj7rbifn7uipi639dmhsnf7tpgq1kno.apps.googleusercontent.com';

/// Server endpoint that exchanges a native Google ID token for a Clerk sign-in
/// ticket (the app redeems it via strategy=ticket). Avoids Clerk native One Tap.
const String kGoogleAuthUrl = '$kApiBase/auth/google';

/// Worker endpoint to register a device's push token against an uid. (NIP-98)
const String kRegisterUrl = 'https://$kSignalingHost/api/register';

/// Worker endpoint to ring a callee (sends a high-priority FCM wake push). (NIP-98)
const String kCallUrl = 'https://$kSignalingHost/api/call';

/// Relay a call status (declined / busy / ended) to the caller via FCM. (NIP-98)
const String kCallStatusUrl = 'https://$kSignalingHost/api/call-status';

/// Nudge recipients that a new message arrived (content-less wake). (NIP-98)
const String kNotifyUrl = 'https://$kSignalingHost/api/notify';

/// Restore endpoint — GET the signed-in account's own saved profile (Clerk JWT)
/// so a fresh install / new phone rehydrates name, photo, birth year, bio + the
/// AvaTOK number without re-onboarding. Email-OTP account recovery (owner
/// request 2026-06-27).
const String kMeUrl = 'https://$kSignalingHost/api/me';

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

/// AvaTalk group conferencing (Phase 10 — LiveKit, ≤25 participants).
/// POST $kConferenceBase/<gid>/start|join|end · GET $kConferenceBase/<gid>/status
const String kConferenceBase = 'https://$kSignalingHost/api/conference';

/// AvaTok public directory (NIP-05-style) — find people by @handle / name / uid.
const String kProfileUrl = 'https://$kSignalingHost/api/profile'; // POST upsert (NIP-98)
// NOTE: kMeUrl is declared once above (account-recovery section) — duplicate here
// removed to fix a concurrent-edit "already declared" compile error.

const String kVaultUrl = 'https://$kSignalingHost/api/vault'; // GET/POST — encrypted cross-device blobs (contacts)
const String kKeyBackupUrl = 'https://$kSignalingHost/api/keybackup'; // GET/POST — account key escrow (durable restore)
const String kResolveUrl = 'https://$kSignalingHost/api/resolve'; // GET ?q= (public)
const String kSearchUrl = 'https://$kSignalingHost/api/search';   // GET ?q= (public)
const String kHandleCheckUrl = 'https://$kSignalingHost/api/handle/check'; // GET ?q= (DEPRECATED — handles retired)
// AvaTOK Number (Specs/AVATOK-NUMBER-FEATURE-SPEC.md) — virtual in-network number.
const String kNumberBase = 'https://$kSignalingHost/api/number';
const String kAddResolveUrl = 'https://$kSignalingHost/api/add'; // GET ?t=<share token> (public)

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
const String kStorageSummaryUrl = 'https://$kSignalingHost/api/storage/summary'; // GET summary row + 6-mo trend (Phase 4)
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
// PartyKit realtime layer (ephemeral; replaces Ably). One socket per room:
// wss://host/api/party?room=<type:id>&token=<clerk jwt>. See sync/party/party_hub.dart.
const String kPartyWsUrl = 'wss://$kSignalingHost/api/party';
const String kMsgSendUrl = 'https://$kSignalingHost/api/msg/send';
const String kMsgSyncUrl = 'https://$kSignalingHost/api/msg/sync';
const String kMsgReceiptUrl = 'https://$kSignalingHost/api/msg/receipt';
const String kMsgReadUrl = 'https://$kSignalingHost/api/msg/read';
// Owner soft-delete/Undo sync across my own devices (writes to my own InboxDO).
const String kMsgHideUrl = 'https://$kSignalingHost/api/msg/hide';
// Phase 3 (ABLY-R2): deep chat history from R2/D1 (older than Ably's window).
const String kMsgArchiveUrl = 'https://$kSignalingHost/api/msg/archive';
// P8 Stage 2 (restoreV2): page older history from the BATCHED per-user R2 jsonl
// archive. GET ?before=<InboxDO id>&conv=<optional>&limit=<n>
//   → { messages:[{id,conv,sender,kind,body,media_ref,client_id,created_at}], next_before }
const String kArchivePageUrl = 'https://$kSignalingHost/api/archive/page';
// Phase 4 (ABLY-R2): persist a per-message reaction toggle (live ride is Ably).
const String kMsgReactUrl = 'https://$kSignalingHost/api/msg/react';
const String kConversationsUrl = 'https://$kSignalingHost/api/conversations';
// Group membership management (Group Info screen).
const String kConvMembersUrl = 'https://$kSignalingHost/api/conversations/members';
const String kConvAddMembersUrl = 'https://$kSignalingHost/api/conversations/members/add';
const String kConvInvitesUrl = 'https://$kSignalingHost/api/conversations/invites'; // GET my pending group invites
const String kConvInviteRespondUrl = 'https://$kSignalingHost/api/conversations/invite/respond'; // POST {conv, accept}
const String kConvRemoveMemberUrl = 'https://$kSignalingHost/api/conversations/members/remove';
const String kConvSetRoleUrl = 'https://$kSignalingHost/api/conversations/members/role';
const String kConvLeaveUrl = 'https://$kSignalingHost/api/conversations/leave';
const String kConvDeleteUrl = 'https://$kSignalingHost/api/conversations/delete';
// Adopt a local-only (pre-server-backed) group UP to D1, preserving its id so a
// reinstall/new-device can re-pull it. Idempotent; rejects ids already on server.
const String kConvAdoptUrl = 'https://$kSignalingHost/api/conversations/adopt';

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

/// Map a local conversation key ('1:<peerHex>' DM, 'g:<gid>' group) to the
/// server conversation id used by the InboxDO. Inverse of the convKey derivation
/// in SyncHub. Returns null for unknown shapes.
String? serverConvFromKey(String convKey, String myUid) {
  if (convKey.startsWith('1:')) return dmConvId(myUid, convKey.substring(2));
  if (convKey.startsWith('g:')) return convKey.substring(2);
  return null;
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
// Password set/change — emails the signed-in user a secure link to set a
// password (rolls out alongside email+password sign-up, beside Google sign-in).
const String kPasswordResetStartUrl = '$kIdBase/password/start'; // POST {} → emails a code (auth)
const String kPasswordSetUrl = '$kIdBase/password/set';          // POST {code, password} (auth)
const String kPhoneConfirmUrl = '$kIdBase/phone/confirm';  // POST {phone}
const String kIdStatusUrl = '$kIdBase/status';             // GET → { phone_verified, ... }
// L2 liveness — Workers AI provider (flag: workersAiLivenessEnabled).
const String kLivenessStartUrl = '$kIdBase/liveness/start';   // POST -> {session_id, challenge}
const String kLivenessUploadUrl = '$kIdBase/liveness/upload'; // POST ?session=&part= (raw bytes)
const String kLivenessVerifyUrl = '$kIdBase/liveness/verify'; // POST {session_id}

// Progressive Identity ladder (PROPOSAL-PROGRESSIVE-IDENTITY.md).
const String kIdentityBase = '$kApiBase/identity';
const String kGuestCreateUrl = '$kIdentityBase/guest';        // POST {handle} (no auth)
const String kGuestCheckUrl = '$kIdentityBase/guest/check';   // GET ?handle= (no auth)
const String kGuestUpgradeUrl = '$kIdentityBase/upgrade';     // POST {guest_token} (Clerk auth)
const String kIdentityLevelUrl = '$kIdentityBase/level';      // GET (Clerk auth)

const String kWalletBase = '$kApiBase/wallet';    // AvaWallet (Phase 2)
const String kSubscribeBase = '$kApiBase/subscribe'; // Subscriptions (Phase 1 tiers)
const String kCalendarBase = '$kApiBase/calendar';// AvaCalendar (Phase 3→5)
const String kBookingBase = '$kApiBase/booking';  // AvaBooking (Phase 5)
const String kTimeUrl = '$kApiBase/time';         // server epoch (clock skew, Phase 5 A2)
const String kPayoutBase = '$kApiBase/payout';    // AvaPayout (Phase 4)
const String kOlxBase = '$kApiBase/olx';          // AvaOLX (Phase 5)
const String kAgreementsBase = '$kApiBase/agreements'; // A1 compliance (Phase 3)
const String kAgentBase = '$kApiBase/agent';      // AvaBrain agentic layer (Phase 7-8)

/// Call-log multi-device sync (owner's own InboxDO). append on a new call; delete
/// one entry; clear the whole history — each fans out live to the owner's other
/// devices and wakes asleep ones (delete/clear) via FCM. (Clerk JWT)
const String kCallLogAppendUrl = '$kApiBase/call-log/append';
const String kCallLogDeleteUrl = '$kApiBase/call-log/delete';
const String kCallLogClearUrl = '$kApiBase/call-log/clear';

/// Right-to-erasure: server-side cascade delete of all the user's media + data. (NIP-98 + Clerk)
const String kAccountDeleteUrl = 'https://$kSignalingHost/api/account/delete';

/// In-app notification feed (system/transactional — wallet, moderation, briefings). (NIP-98 + Clerk)
const String kNotificationsUrl = 'https://$kSignalingHost/api/notifications';

/// Kind tag for AvaTok 1:1 chat messages (legacy value, retained for routing).
const int kDmKind = 14;

/// Short-video clip cap — capture auto-stops at this length.
const Duration kVideoClipMax = Duration(seconds: 30);

/// Fallback ICE servers if /ice can't be reached.
final List<Map<String, dynamic>> kIceServers = [
  {'urls': 'stun:stun.cloudflare.com:3478'},
  {'urls': 'stun:stun.l.google.com:19302'},
];
