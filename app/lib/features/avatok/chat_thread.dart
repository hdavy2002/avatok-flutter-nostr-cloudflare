import 'dart:async';
import 'dart:math' as math;
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:video_compress/video_compress.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:record/record.dart';
import 'package:share_plus/share_plus.dart';
import 'package:super_clipboard/super_clipboard.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';
import 'package:wakelock_plus/wakelock_plus.dart'; // [VOICE-REC-1] keep the screen awake while recording

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/account_storage.dart';
import '../../core/active_thread.dart'; // [PUSH-FG-BANNER-1]
import '../../core/ai_media_jobs.dart'; // [AVA-MEDIA-JOB-2] durable image/doc/audio job repository
import '../../core/api_auth.dart';
import '../../core/audio_playback_service.dart'; // [AVAVM-PLAYER-1]
import '../../core/avatar_cache.dart';
import '../../core/badge_service.dart'; // [ISSUE-BADGE-UNREAD-1]
import '../../core/ava_ai_client.dart';
import '../../core/ava_group_client.dart'; // [AVABRAIN-COMPANION-UI-1] draft-card client
import '../../core/composer_ai.dart';
import '../translation/ondevice_translate.dart';
import '../../core/ava_contracts.dart';
import '../../core/brain_consent.dart';
import '../../core/feature_flags.dart';
import '../ava_companion/companion_thread.dart';
import '../avachat/discuss_seed.dart';
import '../avachat/thread_context.dart';
import '../../core/ava_local_mode.dart';
import '../../core/ava_local_replies.dart';
import '../../core/ava_log.dart';
import '../../core/ava_ondevice_rag.dart';
import '../../core/ava_ondevice_stt.dart';
import '../../core/ui/mic_input_sheet.dart';
import '../../core/avatar.dart';
import '../../core/cached_image.dart';
import '../../core/ava_identity.dart';
import '../../core/chat_state.dart';
import '../../core/wallpaper.dart';
import '../../core/config.dart';
import '../../core/calls/call_escalation_guard.dart'; // [ADDCALL-2-UI]
import '../../core/calls/call_session_manager.dart';
import '../../core/calls/call_session.dart' show rememberCallRoomToken; // [CALL-WS-AUTH-1]
import '../../core/ice_cache.dart';
import '../../core/profile_store.dart';
import '../../core/drive_service.dart';
import '../../core/library_api.dart';
import '../../core/local_brain/local_brain.dart';
import '../library/library_picker.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/bubble_theme.dart'; // [AVAGRP-BUBBLE-1] per-sender pale bubble theming contract
import '../../core/group_store.dart';
import '../../core/message_store.dart';
import '../../identity/identity.dart';
import '../../core/db.dart';
import '../../core/device_contacts.dart';
import '../../core/disk_cache.dart'; // [AVAGRP-SENDERPUB-BACKFILL-1] per-account scoped repair marker
import '../../sync/dm.dart';
import '../../sync/outbox.dart';
import '../../sync/media_outbox.dart';
import '../../sync/group_dm.dart';
import '../../sync/party/party_hub.dart';
import '../../sync/legacy_stubs.dart';
import '../../sync/presence.dart';
import '../../sync/sync_hub.dart';
import '../../push/push_service.dart';
import '../../core/remote_config.dart';
import '../ava/ava_invoke.dart';
import '../ava/ava_doc_actions.dart'; // Phase A (Ava Copilot): doc actions + per-chat toggle
import '../ava/ava_lane.dart'; // Phase A (Ava Copilot): private Ava-lane bubble
import '../ava/ava_unread.dart'; // Phase A (Ava Copilot): per-conv ava_unread counter
import 'widgets/ai_media_job_card.dart'; // [AVA-MEDIA-JOB-2] durable job card (image/doc/audio)
import 'ava_email.dart';
import 'file_viewer_screen.dart';
import '../genui/a2ui_renderer.dart';
import '../../core/apps_service.dart';
import '../conference/cloudflare_conference_api.dart';
import '../conference/cloudflare_conference_controller.dart';
import '../conference/cloudflare_conference_screen.dart';
import '../../core/analytics.dart';
import '../../core/live_location_service.dart';
import 'call_screen.dart';
import 'contact_profile_screen.dart';
import 'contacts.dart';
import '../messaging/widgets/stranger_gate_bar.dart'; // STREAM B
import 'stranger_gate_api.dart'; // STREAM B (stranger safety gate)
import 'forward_sheet.dart';
import 'chat_media_cards.dart';
import '../messaging/widgets/link_preview_card.dart';
import '../messaging/widgets/link_viewer_sheet.dart';
import 'data.dart';
import '../ava_guardian/guardian_settings.dart'; // shield watchdog (Nemotron) per-chat toggle
import '../identity/public_action_gate.dart'; // [AVA-IDGATE-1] guardian verify → consent-first gate
import 'live_location.dart';
import 'group_info_screen.dart';
import 'media.dart';
import 'voice_note_waveform.dart';
import 'media_library_screen.dart';
import 'unknown_caller.dart';
import 'video_player_screen.dart';
import 'business_thread_widgets.dart'; // WP6: voicemail + agent-transcript bubbles (§6)
// STREAM G (AI in chats): catch-up card, smart-reply chips, inline translate.
import '../messaging/ai_chat_api.dart';
import '../messaging/widgets/catchup_card.dart';
import '../messaging/widgets/smart_reply_chips.dart';
import '../messaging/widgets/translated_text.dart';
// STREAM J (D17): auto-download policy + tap-to-download placeholder.
import '../../core/media_auto_download.dart';
import '../messaging/widgets/media_download_placeholder.dart';
// STREAM E: WhatsApp-parity input bar + emoji/GIF/sticker panel.
import '../messaging/widgets/rich_input_bar.dart';
import '../messaging/widgets/mention_text_controller.dart';
import '../messaging/widgets/gif_api.dart';
import '../messaging/widgets/picker_recents_store.dart';
import '../messaging/widgets/sticker_media.dart';

// [CHAT-THREAD-SPLIT-1] This screen is split across `part` files under
// chat_thread/. Parts share this library, so all private identifiers
// (and this file's imports) resolve across them with no renaming.
part 'chat_thread/constants.dart';
part 'chat_thread/models.dart';
part 'chat_thread/message_row.dart';
part 'chat_thread/widgets_small.dart';
part 'chat_thread/cards.dart';
part 'chat_thread/calls.dart';
part 'chat_thread/special_content.dart';
part 'chat_thread/media.dart';
part 'chat_thread/voice.dart';
part 'chat_thread/message_actions.dart';
part 'chat_thread/ai_assist.dart';
part 'chat_thread/menus.dart';
part 'chat_thread/guardian.dart';
part 'chat_thread/composer.dart';
part 'chat_thread/search.dart';
part 'chat_thread/bubbles.dart';
part 'chat_thread/formatting.dart';
part 'chat_thread/presence.dart';
part 'chat_thread/persistence.dart';
part 'chat_thread/send.dart';
part 'chat_thread/banners.dart';
part 'chat_thread/setup.dart';
part 'chat_thread/inbound.dart';

/// Bright green for the Guardian shield (on-state) + notice modal (owner request
/// 2026-07-13 — brighter than the standard AD.online presence green).
const Color kGuardianGreen = Color(0xFF7BE08C);

/// AvaTok conversation thread — bubbles, media (photo/video/file/voice),
/// long-press reactions, forward / delete, calls (1:1 or group), ⋮ overflow.
class ChatThreadScreen extends StatefulWidget {
  final Chat chat;
  const ChatThreadScreen({super.key, required this.chat});
  @override
  State<ChatThreadScreen> createState() => _ChatThreadScreenState();
}

// [VOICE-REC-1] `WidgetsBindingObserver` (owner report 2026-07-16, pic 5): the
// thread now watches the app lifecycle so a recording in progress can pause
// itself when the user leaves. Previously nothing observed it — backgrounding
// mid-recording left `record` running and `_recording == true` with no stop, no
// save and no discard, so a take could be silently mangled by whatever the OS
// did to the mic while the app was away.
class _ChatThreadScreenState extends State<ChatThreadScreen> with WidgetsBindingObserver {
  // STREAM J (D17): whether incoming media auto-downloads on render in THIS
  // thread. Resolved once on open from MediaAutoDownload.shouldAutoFetch (mode +
  // connectivity + accept_state). Defaults to true so behavior is unchanged until
  // the async check resolves — the check runs in initState and repaints. When
  // false, media bubbles render a tap-to-download placeholder instead of eagerly
  // fetching. A manual tap always downloads regardless.
  bool _mediaAutoFetch = true;
  // Recipient thread accept-state (§B1): 'pending' | 'accepted' | 'blocked' or
  // null when unknown. Stranger-gate (Stream B) will populate this; until then it
  // stays null (treated as accepted). A 'pending' thread NEVER auto-downloads.
  String? _threadAcceptState;
  // [CHAT-MENTIONS-1] MentionTextController is a drop-in TextEditingController
  // that only overrides buildTextSpan, so `@name` / `#ava` tokens paint in
  // colour. `.text` is untouched — _send, ava_invoke's parser and the draft
  // store all keep seeing exactly what the user typed.
  final _ctrl = MentionTextController();
  final _searchCtrl = TextEditingController(); // in-thread search box (literal + AI)
  final _composerFocus = FocusNode(); // keep the keyboard up after each send
  final _scroll = ScrollController();
  // [CHAT-UI-REVERSE-1] The old `_openReveal` flag + Opacity/IgnorePointer
  // hack ("keep the list invisible until the first jump-to-end lands, so a
  // thread OPENS already pinned to the newest message instead of painting at
  // the top and visibly snapping down through history") is GONE. `_scroll`'s
  // ListView now builds with `reverse: true`, which renders the newest
  // message at scroll offset 0 NATIVELY — a freshly-opened thread is already
  // anchored on the newest message on the very first frame, with nothing to
  // jump to and nothing to hide while it lands.
  // [CHAT-UI-LIST-1e] Gated autoscroll: an inbound/Ava message only force-jumps
  // the view when the reader is already near the newest edge; otherwise it
  // bumps this counter and the scroll-to-bottom FAB appears. Cleared when the
  // FAB is tapped (which also performs the jump). Own sends always jump
  // (`_jump(force: true)`) — WhatsApp always shows you your own outgoing text.
  int _unseenCount = 0;
  // [CHAT-UI-LIST-1c] One-shot guard for the 'chat_group_sender_unresolved'
  // telemetry so it fires once per message id instead of on every rebuild of
  // `_bubble` (a keystroke/tick/reaction anywhere in the thread used to
  // re-emit it for every unresolved-sender bubble on screen).
  final Set<int> _unresolvedSenderLogged = {};
  final _picker = ImagePicker();
  // [AVAVM-PLAYER-1] Voice-note playback now goes through the shared,
  // app-wide `AudioPlaybackService` (survives navigation + backgrounding)
  // instead of a per-thread `AudioPlayer()` that died with this widget — see
  // `_playAudio`/`_seekAudio`/`_cycleAudioSpeed` and `_onAudioStateChanged`
  // below. `_sfx` is unrelated (UI sound effects) and is untouched.
  final _sfx = AudioPlayer();
  final _recorder = AudioRecorder();
  final _idStore = IdentityStore();
  final _msgStore = MessageStore();
  // F3 (restoreV2): deep-archive scroll pager. When the user scrolls PAST the
  // local hot window, older messages are paged in from /api/archive/page and
  // cached per-conversation so a page is fetched at most once (ever).
  final _archiveStore = ArchivePageStore();
  int? _archiveCursor;            // next `before` (InboxDO id); null ⇒ start at newest
  bool _archiveDone = false;      // the archive is exhausted (no older pages)
  bool _archiveLoading = false;   // a page fetch is in flight
  bool _hasArchived = false;      // ≥1 archived message shown ⇒ render the divider
  // F6: received guardian safety flags, keyed by the flagged message's client id
  // (msg_id / rumorId). Persisted per-account so the red bubble survives reopen;
  // a locally-dismissed ("This is fine") flag is kept out of this set.
  final _safetyStore = SafetyFlagStore();
  final Map<String, String> _safetyFlaggedIds = {}; // rumorId → category (active reds)
  StreamSubscription? _safetySub;
  Timer? _persistTimer;
  String? _myNpub;
  String? _myName;
  String _myAvatarUrl = ''; // my own photo, for the avatar beside my bubbles
  int _seq = 0;
  bool _hasText = false;
  // ── Compose-time link preview (WhatsApp parity) ────────────────────────────
  // Paste/type a URL → after a short debounce we unfurl it and show a small card
  // above the keyboard with an ✕ to dismiss. Sending reuses the ALREADY-fetched
  // preview, so the send is instant instead of waiting on the network.
  Timer? _composeUnfurlDebounce;
  String? _composePreviewUrl;      // url the current card belongs to
  Map<String, dynamic>? _composePreview; // resolved preview json (null = none)
  bool _composePreviewLoading = false;
  final Set<String> _composePreviewDismissed = {}; // urls the user ✕'d
  // [WALLET-GET-STATE-1] 2026-07-25: `_premium` used to gate #ava/@ava text
  // AND the composer hint below it. Owner decision (Root-Cause Report §10/
  // §12c): Ava-in-chat TEXT is free for everyone, never metered, never
  // paywalled — attachments remain metered, but that gate is server-side
  // (worker/src/routes/ava_gemini.ts), not here. With the text gate removed
  // there is no remaining consumer of a client-side premium flag in this
  // file, so it's gone rather than kept as dead state — see
  // core/wallet_entitlement.dart if a future paid action in this screen
  // needs a "warn before spending" read.
  bool _recording = false;
  String? _recPath;
  // Live voice-to-text (on-device Whisper) — types into the composer as you speak.
  SttSession? _sttSession;
  bool _sttActive = false;
  bool _sttPreparing = false; // model loading between tap and "Listening…"

  // STREAM G [GROUP-AI-1] group catch-up ("What did I miss?").
  List<CatchupBullet> _catchupBullets = const [];
  int _catchupCount = 0;
  bool _catchupDismissed = false;
  bool _catchupLoading = false;
  // [AVABRAIN-COMPANION-UI-1] Group Companion pending draft cards — group
  // threads only, shown ABOVE the composer (not in the message list, so it
  // never touches _MessageRow/list indexing). One card at a time, oldest
  // first; "+N more" for the rest.
  List<AvaGroupDraft> _companionDrafts = const [];
  bool _companionDraftBusy = false;
  // STREAM G [GROUP-AI-4] smart replies (DMs). Chips above the input bar.
  List<String> _smartReplies = const [];
  Timer? _smartReplyDebounce;
  // STREAM G [GROUP-AI-2/3] per-group "translate this group for me" toggle.
  bool _groupTranslateOn = false;
  bool _groupTranslateBusy = false;

  // Server-routed DM (Cloudflare-native transport) for contacts.
  AvaDm? _dm;
  AvaGroupDm? _gdm;
  Group? _group;
  bool _isGroup = false;
  // [AVA-GRP-SENDSTATE] Count of own group bubbles healed from a false "not sent"
  // back to "sent" on thread load (old builds persisted delivered group messages
  // as pending). Emitted once via `grp_sendstate_healed` after the cache restore.
  int _grpSendStateHealed = 0;
  NostrClient? _nostr;
  bool _realMode = false;
  final Set<String> _seenEv = {};
  int? _playingAudioId;
  // [VOICE-SCRUB-1] The note currently LOADED into the shared player — which is
  // not the same thing as the note currently playing. A paused note, or one
  // parked where the user scrubbed to, is still open: keeping this distinct is
  // what lets play resume in place instead of re-downloading and restarting
  // from 0:00, and lets the timeline stay scrubbable while paused.
  int? _openAudioId;
  // [UI-BUBBLE-3] Voice-note playback speed chip (1x / 1.5x / 2x). Applied to the
  // shared _audio player on play and when the chip is tapped mid-playback.
  double _audioSpeed = 1.0;
  // [VOICE-SCRUB-1] (owner report 2026-07-16, pic 5) Real playhead + real clip
  // length for the voice-note timeline, straight from the shared player's
  // streams. Before this the bubble ran a local 1s Timer and displayed a count
  // that started at 0:00 on every play and never knew the note's actual length
  // — so there was nothing to scrub against and nothing honest to label.
  // Keyed by the currently-playing note (`_playingAudioId`); every other bubble
  // renders at zero.
  Duration _audioPos = Duration.zero;
  Duration? _audioDur;
  // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) `_MessageRow` caches its bubble
  // on `widget.revision == _msgsRev`, but `_onAudioStateChanged`/`_seekAudio`/
  // `_cycleAudioSpeed` below only `setState()` — they never touch `_msgsRev`,
  // so once a voice note's row is cached, the playhead/duration/speed baked
  // into its `VoiceNoteBubble` froze at whatever they were the first time that
  // row built. `_audioTick` is a second, cheap counter bumped alongside those
  // `setState()`s; the itemBuilder below folds it into the row's revision ONLY
  // for the currently playing/open row (and the previously playing/open row,
  // for one extra build after a transition), so a scrub/play/pause/speed
  // change repaints just that one bubble per tick instead of routing through
  // `_mutMsgs` and invalidating (and re-filtering) the whole visible list.
  int _audioTick = 0;
  // The row that was playing/open immediately before the current change, kept
  // for exactly one extra build so the bubble that just stopped commits its
  // final (idle) state instead of staying frozen mid-scrub/mid-play forever.
  int? _prevAudioRowId;
  // [AVAVM-PLAYER-1] Bridges the shared `AudioPlaybackService.state` back onto
  // the local `_playingAudioId`/`_openAudioId`/`_audioPos`/`_audioDur` fields
  // above so every existing `_mediaContent`/`VoiceNoteBubble` call site below
  // keeps working unchanged — only WHERE the bytes actually play moved (to the
  // app-wide service), not how this screen tracks/repaints it.
  VoidCallback? _audioStateListener;

  // Presence: typing + read receipts (ephemeral, over the signaling WS).
  PresenceChannel? _presence;
  // Floating-emoji bursts (live reactions + bursts ride PartyKit — see _partyJoin).
  final List<_BurstFx> _burstFx = [];       // active floating-emoji animations (PartyKit bursts)
  int _burstSeq = 0;
  // Live location (WhatsApp-style): one session per share id. The pin moves via
  // ephemeral 'liveloc' presence frames; the durable 't:'live'' bubble anchors
  // it. _liveBroadcaster is non-null only while *I* am actively sharing.
  final Map<String, LiveLocationSession> _live = {};
  LiveLocationBroadcaster? _liveBroadcaster;
  final Map<String, int> _liveViewTelemetryTs = {}; // throttle receiver views
  int _liveTickTelemetryTs = 0; // throttle sender tick telemetry
  bool _peerTyping = false;
  String? _typingWho;
  int _peerReadTs = 0;
  Timer? _typingClear;
  Timer? _myTypingOff;
  // Phase 5: live clock — refreshes relative timestamps + day separators so
  // "Today" rolls to "Yesterday" and "last seen" stays current without a reload.
  Timer? _clockTimer;
  // Phase 5: floating reaction pill (anchored to the bubble on long-press).
  OverlayEntry? _reactionOverlay;

  // Reply / edit / star.
  _Msg? _replyTo;
  _Msg? _editing;
  final _starStore = StarStore();
  Set<String> _starred = {};
  String? _peerNpub; // 1:1 recipient uid for message notifications
  List<String> _memberUids = []; // group recipient uids (excl me)
  String? _convKey; // '1:<hex>' or 'g:<gid>' for read state / unread badges
  // STREAM B (SAFE-GATE): the SERVER conv id (dm_lo__hi) + whether this thread is
  // a pending stranger gate (non-contact). When true the composer is replaced by
  // the StrangerGateBar and media/link-previews are suppressed in bubbles.
  String? _serverConv;
  bool _strangerGatePending = false;
  // Show the Accept/Decline/Block/Report overlay exactly once per thread open
  // when a pending stranger gate is detected (owner request: opening a request
  // from a non-contact must prompt a decision, not just swap the composer bar).
  bool _gatePromptShown = false;
  PartyRoom? _party;               // PartyKit live layer for this thread (ephemeral, gated)
  StreamSubscription? _partySub;
  Identity? _meId;
  // Unknown-number receptionist thread (caller has no AvaTOK account). When set,
  // the thread is a read-only voicemail record keyed by the caller's phone.
  bool _isTelThread = false;
  String _telPhone = ''; // E.164 of the caller for a tel: thread
  bool _callerSaved = true; // false ⇒ show the "Save to contacts" affordances
  bool _saveBannerDismissed = false;
  // Shield watchdog (Ava guardian) state for THIS chat. Green shield = on.
  GuardianPrefs _guardian = GuardianPrefs.off;
  // G1.3: minor accounts have Guardian force-ON (server ignores secure_chat=0 for
  // minors). The shield renders locked-on with no toggle for a minor.
  bool _isMinorAccount = false;
  // created_at (ms) of incoming messages Ava flagged as unsafe → painted RED so
  // they're an obvious red flag to the child. Populated from guardian warnings.
  final Set<int> _flaggedTs = <int>{};
  // Cross-device soft-delete flags (rumorId → hidden), seeded from the InboxDO on
  // /sync so a fresh device shows my deleted messages hidden on a cold open.
  final Map<String, bool> _hiddenIds = {};
  // HARD-delete tombstones (delete-for-everyone RECEIVED from a peer), seeded from
  // the durable [DeletedStore] so a message a peer deleted stays deleted across
  // cold opens — even if my thread was closed when the delete arrived.
  final Set<String> _deletedIds = {};
  int _disappearSecs = 0; // per-chat disappearing timer (0 = off)
  int _peerDeliveredTs = 0;
  bool _peerOnline = false;
  bool _sharePresence = true;
  Timer? _onlineClear;
  Timer? _onlineHeartbeat;           // re-announce "online" every 20s while open
  int _peerLastSeen = 0;             // unix seconds; 0 = unknown
  int _lastSeenPersistTs = 0;        // throttle last-seen disk writes
  String? _presenceMe;               // the label we announce as (ignore our echo)
  Map<String, String>? _pinned; // {id, text}
  bool _searchMode = false;
  String _searchQuery = '';
  // ---- in-thread "smart search" (semantic, over the user's own AI Search) ----
  // Literal search stays instant/offline; smart search is an EXTRA step, run only
  // when the user taps "Search with AI" (or has no literal hit). State is reset
  // whenever the query text changes so stale AI results never show for a new query.
  bool _aiSearching = false;                 // request in flight (spinner)
  String _aiSearchedQuery = '';              // the query the current hits answer
  bool _aiSearchError = false;               // last request failed
  bool _aiBrainOff = false;                  // messaging AvaBrain toggle is off
  // Phase A (Ava Copilot, D29): per-chat "Ava in this chat" switch — ON by
  // default; loaded from GET /api/ava/chat-toggle on open and flipped from the
  // header ⋮ menu (optimistic). OFF hides the Ava doc context-menu items.
  bool _avaInChatOn = true;
  bool _aiShowOther = false;                 // reveal "from your other chats" hits
  List<_AiHit> _aiHits = const [];           // matched + unmatched semantic hits
  Map<String, String> _memberNames = {}; // hex → name (group mentions)
  // [AVAGRP-BUBBLE-1] hex → photo URL, mirroring `_memberNames` (shape copied
  // from `group_info_screen.dart`'s `_avatars` map). Populated ONLY from
  // ContactsStore (`_loadChatExtras`) — the group wire envelope only ever
  // carries `fromName`, never an avatar URL, so a member's photo can only be
  // known here if the LOCAL device already has them saved as a contact. That is
  // the contract seam: a member who is a stranger (not in Contacts) will still
  // fall back to initials/short-id in `_bubbleAvatar`, never a real photo, until
  // the envelope (or a profile lookup) carries one.
  Map<String, String> _memberAvatars = {};
  String _wallpaperId = 'default';
  List<String> _mentionMatches = [];

  // Composer quick-tools (Translate · Fix grammar · Rewrite · Reply ideas).
  // Each runs ONE Ava text call (AvaAiClient.ask) and drops the result straight
  // back into the input box so the user just hits send. _aiTool is the chip
  // currently spinning (null = idle); _aiBusy locks the row to one job at a time.
  bool _aiBusy = false;
  String? _aiTool;
  final FlutterSecureStorage _aiPrefs = const FlutterSecureStorage();
  // Per-account "hide deleted messages" preference: when on, both the slim
  // "You deleted this message" pills and peer "This message was deleted"
  // tombstones are collapsed out of the thread so it stays clean. Keyed per
  // conversation so the choice is remembered for THIS chat.
  bool _hideDeleted = false;
  // Remembered translate target (account-scoped). Defaults to Spanish until the
  // saved value loads / the user picks another.
  String _transLangCode = 'Spanish';
  ComposerLang get _transLang => ComposerAi.langByCode(_transLangCode);

  Timer? _markReadTimer;
  // [ISSUE-BADGE-UNREAD-1] Separate debounce for the launcher-badge recompute —
  // _markRead fires on init, on every incoming message and on each Ava stream
  // frame, and the badge recompute touches the DB + the OS SMS provider, so it
  // must not run per-call.
  Timer? _badgeTimer;

  @override
  void initState() {
    super.initState();
    // [CHAT-UI-TELEMETRY-1] This screen never called screenViewed, so every
    // `ui_frame_stats` window from the thread rolled up under `screen:
    // 'unknown'` (PerfMonitor keys its flush off `Analytics.currentScreen`) —
    // the single highest-traffic screen in the app was invisible to the jank
    // dashboard by name.
    Analytics.screenViewed('avatok', 'chat_thread');
    WidgetsBinding.instance.addObserver(this); // [VOICE-REC-1] recorder auto-pause
    // [AVA-MEDIA-JOB-2] Bind the durable AI-media-job stream now — filtering
    // happens at EVENT time against `_serverConvId`/`_convKey` inside
    // [_bindAiJobs], so it's safe to subscribe before either is resolved.
    // Hydration/reconcile + explicit seeding happens once the conv id is
    // known, from `_loadChatExtras` (see that method's own note).
    _bindAiJobs();
    // [CHAT-UI-REVERSE-1] The old 450ms "reveal unconditionally" safety-net
    // timer for `_openReveal` is gone along with the field itself — the
    // reverse:true list has nothing to reveal; see the `_scroll` field doc.
    // Opening a thread nudges a catch-up sync: a server-injected message (e.g. a
    // marketplace agent-deal card, or a receptionist card) is appended directly to
    // the InboxDO and only arrives on a fresh sync — if the socket wasn't connected
    // when it landed, the thread would look empty. This probes/reconnects so the
    // missing message pulls in right as you open the chat.
    try { SyncHub.I.onAppResumed(); } catch (_) {}
    // [MEDIA-OUTBOX-DURABLE-1] Resume any media upload/envelope-send left
    // mid-flight by a previous run (app kill, crash, force-close). Mirrors
    // Outbox's own "a thread open is also a retry trigger" pattern
    // (`AvaDm.start`/`AvaGroupDm.start`) — best-effort, never blocks open.
    unawaited(MediaOutbox.I.reconcile(resumeUpload: _resumeMediaUpload).catchError((e) {
      AvaLog.I.log('media_outbox', 'reconcile failed: $e');
    }));
    // STREAM J (D17): resolve whether incoming media should auto-download in this
    // thread (mode + connectivity + accept_state). Non-blocking; repaints once
    // known so media bubbles render either the real preview or a tap-to-download
    // placeholder. A 'pending' stranger thread never auto-downloads in any mode.
    MediaAutoDownload.shouldAutoFetch(acceptState: _threadAcceptState).then((v) {
      if (mounted && v != _mediaAutoFetch) setState(() => _mediaAutoFetch = v);
      else _mediaAutoFetch = v;
    });
    // STREAM E: load the account-scoped picker recents (emoji/GIF/sticker) +
    // last-known keyboard height so the rich input panel opens instantly.
    // ignore: unawaited_futures
    PickerRecentsStore.I.load().then((_) { if (mounted) setState(() {}); });
    // Phase 5: tick a lightweight clock so the day separators and the "last
    // seen" header stay live without the user reloading the thread. (Message
    // timestamps no longer need this — [CHAT-TS-ABS-1] made them absolute — but
    // a thread open across midnight still has to roll "Today" over to
    // "Yesterday", and the header's relative last-seen is still relative.)
    _clockTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
    // F6: restore persisted guardian safety flags (red bubbles) + subscribe to
    // live safety_flag frames pushed to me over the shared InboxDO socket.
    _safetyStore.load().then((all) {
      if (!mounted || all.isEmpty) return;
      setState(() {
        for (final e in all.entries) {
          if (e.value['dismissed'] == true) continue; // "This is fine" — stay hidden
          _safetyFlaggedIds[e.key] = (e.value['category'] ?? '').toString();
        }
      });
    });
    _safetySub = SyncHub.I.safetyFlags.listen((f) {
      if (!mounted) return;
      // Only flags for THIS conversation repaint here (the store already persisted
      // it for every conv). Match on the derived convKey the hub emits.
      if (_convKey != null && f['convKey'] != _convKey) return;
      final msgId = (f['msg_id'] ?? '').toString();
      if (msgId.isEmpty) return;
      setState(() => _safetyFlaggedIds[msgId] = (f['category'] ?? '').toString());
    });
    // F3 (restoreV2): pull older history a page at a time as the user scrolls to
    // the top of the hot window. Guarded by the flag inside _maybePageArchive.
    _scroll.addListener(_maybePageArchive);
    // [WALLET-GET-STATE-1] 2026-07-25: the old `MoneyApi.balance()` read here
    // only fed the paywall/hint this file no longer has — removed rather than
    // left as an unused wallet fetch on every thread open.
    // [AVAVM-PLAYER-1] Bridge the shared AudioPlaybackService's state back
    // onto this thread's local voice-note fields (see `_onAudioStateChanged`)
    // — replaces the old per-thread `_audio.onPlayerComplete` /
    // `onPositionChanged` / `onDurationChanged` listeners now that playback
    // itself lives at the service layer, not on a player owned by this widget.
    _audioStateListener = _onAudioStateChanged;
    AudioPlaybackService.I.state.addListener(_audioStateListener!);
    _onAudioStateChanged(); // pick up an already-playing track on reopen
    // Load cross-device soft-delete flags, then re-apply to anything already shown.
    HiddenStore().load().then((m) {
      if (!mounted || m.isEmpty) return;
      _hiddenIds.addAll(m);
      _mutMsgs(() {
        for (final msg in _msgs) {
          if (msg.evId != null && m[msg.evId] == true) msg.hidden = true;
        }
      });
    });
    // Re-apply peer hard-deletes (delete-for-everyone) on a cold open, then tombstone
    // anything already on screen that a peer deleted while this thread was closed.
    DeletedStore().load().then((s) {
      if (!mounted || s.isEmpty) return;
      _deletedIds.addAll(s);
      _mutMsgs(() {
        for (final msg in _msgs) {
          if (msg.evId != null && s.contains(msg.evId)) _tombstone(msg);
        }
      });
    });
    _idStore.load().then((id) {
      if (!mounted || id == null) return;
      setState(() { _myNpub = id.uid; _myName = id.shortId; _meId = id; });
      _setupDm(id);
    });
    ProfileStore().load().then((p) {
      if (!mounted) return;
      setState(() { if (p.displayName.isNotEmpty) _myName = p.displayName; _sharePresence = p.sharePresence; _myAvatarUrl = p.avatarUrl; _isMinorAccount = p.isMinor; });
    });
    _starStore.load().then((s) { if (mounted) setState(() => _starred = s); });
    // Restore the remembered translate target (account-scoped — a parent and a
    // child sharing the phone keep separate defaults).
    readScoped(_aiPrefs, _kTransLangKey).then((code) {
      if (mounted && code != null && code.isNotEmpty) {
        setState(() => _transLangCode = code);
        // Deferred: warm the on-device model for the remembered language in the
        // background so the first Translate tap is already instant (pic4).
        OnDeviceTranslate.I.prefetch(code);
      }
    }).catchError((_) {});
    // Restore the per-conversation "hide deleted messages" choice.
    readScoped(_aiPrefs, '${_kHideDeletedKey}_${widget.chat.seed}').then((v) {
      if (mounted && v == '1') setState(() => _hideDeleted = true);
    }).catchError((_) {});
    _pruneTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      if (mounted && _msgs.any((m) => m.expireAt != null && m.expireAt! < nowS)) {
        _mutMsgs(() => _msgs.removeWhere((m) => m.expireAt != null && m.expireAt! < nowS));
      }
    });
    // Group conferencing (Phase 10, Cloudflare Realtime A/V as of CF-CALL-007):
    // poll for an ongoing call so the "tap to join" banner appears/disappears
    // while the thread is open.
    if (widget.chat.gid != null || widget.chat.group) _startConfPolling();
  }

  Timer? _pruneTimer;

  // ---- [GRP-W3-REACTIVE] keep an OPEN group thread's membership current --------
  //
  // `_group` / `_memberUids` were read once at setup and never looked at again,
  // so a member added while this thread was open stayed invisible until the app
  // was force-closed. That staleness also fed the seen-by thresholds, the notify
  // recipients, and — since Wave 1 — the ≤25 group-call gate, which could refuse
  // or allow a call on a member count that no longer existed.
  StreamSubscription<String>? _groupChangeSub;

  final List<_Msg> _msgs = [];
  // [CHAT-UI-VISIBLE-MEMO-1] Bumped by _mutMsgs on every `_msgs` collection
  // mutation (add/addAll/removeWhere/sort/clear) AND every in-place `_Msg`
  // field mutation that affects rendering (text/hidden/failed/uploading/
  // transcoding/media/reaction/receipts/poll votes/evId/...). The Builder in
  // build() memoizes its computed `visible` list keyed on
  // (_msgsRev, search query, filter toggles) so an UNRELATED setState
  // (composer keystroke, clock tick, audio position, typing indicator) does
  // NOT re-filter/re-sort/re-day-separate the entire history — only an actual
  // message mutation invalidates the memo.
  int _msgsRev = 0;
  // Fallback safety net for [_mutMsgs]: a few async media closures deep in
  // upload/retry code (`_upload`, `_stopAndSendRecording`, the retry-tap
  // GestureDetector inside `_bubble`) mutate a captured `_Msg` reference many
  // frames after the widget tree that created it — auditing every one of
  // those with full confidence is not realistic, so the memo below ALSO
  // recomputes whenever `_msgs.length` changes or the identity of the last
  // element changes, even if a caller forgot to route through `_mutMsgs`.
  List<_Msg>? _visibleCache;
  int _visibleCacheRev = -1;
  int _visibleCacheLen = -1;
  int _visibleCacheLastHash = 0;
  String _visibleCacheQuery = '';
  bool _visibleCacheHideDeleted = false;

  /// [CHAT-UI-VISIBLE-MEMO-1] Route EVERY `_msgs` collection mutation (add/
  /// addAll/removeWhere/sort/clear) and every in-place `_Msg` field mutation
  /// that affects rendering through here instead of a bare `setState`. `fn`
  /// performs the actual mutation; this then bumps `_msgsRev` (invalidating
  /// the visible-list memo built in `build()`) and repaints — a mechanical,
  /// same-semantics drop-in for `setState(() { ...mutate _msgs/_Msg... })`.
  void _mutMsgs(void Function() fn) {
    fn();
    _msgsRev++;
    if (mounted) setState(() {});
  }

  /// [VOICE-REC-1] (owner report 2026-07-16, pic 5) Auto-pause a recording when
  /// the app leaves the foreground, and let the user resume when they come back.
  ///
  /// The owner asked for exactly WhatsApp's behaviour: "if the phone screen
  /// comes up or user navigates to another app, the recorder pauses on its own
  /// and then when the user comes back, he can unpause it and continue".
  ///
  /// Pause — not stop-and-send, and not discard. Both of those decide something
  /// on the user's behalf that they haven't said yet: auto-sending ships a
  /// half-finished thought to another person and can't be taken back, and
  /// discarding throws away a take they may have spent a minute on. Pausing is
  /// the only option that's reversible in both directions. The take survives on
  /// disk; when they come back the bar is still there, paused, with their
  /// waveform and elapsed time intact, and they choose.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    // [AVABRAIN-COMPANION-UI-1] Re-check pending Companion drafts on resume —
    // no periodic timer, just thread-open + resume + post-decision refetch.
    if (state == AppLifecycleState.resumed && _isGroup) {
      unawaited(_fetchCompanionDrafts());
    }
    // [AVA-MEDIA-JOB-2] Re-reconcile this conversation's AI media jobs on
    // resume — the specific defect Part VI exists to fix: a job that finished
    // (or failed) while the app was backgrounded must not be lost/stuck
    // "working" forever just because no poll timer was running while paused.
    if (state == AppLifecycleState.resumed) {
      final convId = _serverConvId ?? _convKey;
      if (convId != null) unawaited(AiMediaJobRepository.I.reconcile(convId));
    }
    if (!_recording || _recPaused) return;
    // `inactive` also covers the transient states (a call banner, the app
    // switcher, the screen locking) — precisely the cases the owner hit.
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      // Flip the flag SYNCHRONOUSLY, before the await. Backgrounding delivers
      // `inactive` then `paused` back-to-back, so an async-only guard lets the
      // second event re-enter and call pause() on an already-paused recorder.
      setState(() => _recPaused = true);
      unawaited(() async {
        try {
          await _recorder.pause();
          // Backgrounded: stop holding the screen awake. It's re-enabled if the
          // user resumes (see _toggleRecordPause).
          try { await WakelockPlus.disable(); } catch (_) {}
          Analytics.capture('voice_note_record_paused', {
            ..._voiceTelemetry(),
            'paused': true,
            'seconds': _recElapsed.inSeconds,
            'reason': 'backgrounded',
          });
        } catch (e) {
          // The recorder refused to pause, so it is STILL CAPTURING. Put the
          // flag back: leaving it true would show "Paused" over a live mic and
          // freeze the elapsed timer, so the user would get a take longer than
          // the UI claimed and Resume would fire at a recorder that never
          // paused. Better to under-promise (bar still says recording) than to
          // lie about the state of a microphone.
          if (mounted) setState(() => _recPaused = false);
          AvaLog.I.log('media', 'voice auto-pause failed: $e');
          Analytics.capture('voice_note_record_pause_failed', {
            ..._voiceTelemetry(), 'reason': 'backgrounded',
          });
        }
      }());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this); // [VOICE-REC-1]
    // [VOICE-REC-1] Leaving the thread mid-recording must not strand the take,
    // the metering subscription, or (worst) the wakelock — a leaked wakelock
    // silently drains the battery with nothing on screen to explain why.
    // `_recorder.dispose()` below stops the hardware; this releases everything
    // hanging off it.
    _recAmpSub?.cancel();
    _recTick?.cancel();
    if (_recording) { try { WakelockPlus.disable(); } catch (_) {} }
    // [AVAVM-PLAYER-1] Unhook from the shared service — playback itself must
    // NOT stop here (that's the whole point: it survives this dispose).
    if (_audioStateListener != null) {
      AudioPlaybackService.I.state.removeListener(_audioStateListener!);
    }
    // [PUSH-FG-BANNER-1] Release the on-screen-thread claim. Guarded by key
    // inside `leave` — pushing thread B over A runs B's enter BEFORE A's dispose,
    // so an unconditional clear here would wipe B's claim and B would then get
    // banners for the thread the user is actually reading.
    ActiveThread.leave(_convKey);
    _localAvaSub?.cancel();
    _avaStreamSub?.cancel();
    _aiJobsSub?.cancel();              // [AVA-MEDIA-JOB-2]
    // [AVA-MEDIA-JOB-2] Stop polling for this conv; the on-disk job cache is
    // untouched, so a reopen still hydrates instantly (see
    // `AiMediaJobRepository.closeConversation`'s own doc comment).
    { final convId = _serverConvId ?? _convKey; if (convId != null) AiMediaJobRepository.I.closeConversation(convId); }
    _safetySub?.cancel();              // F6: live safety_flag frames
    _groupChangeSub?.cancel();         // [GRP-W3-REACTIVE] live membership changes
    _scroll.removeListener(_maybePageArchive); // F3: archive pager
    _clockTimer?.cancel();              // Phase 5: live clock
    _reactionOverlay?.remove();        // Phase 5: tear down a floating reaction pill if open
    _reactionOverlay = null;
    _partySub?.cancel();               // PartyKit live layer
    _party?.leave();
    _ctrl.dispose();
    _searchCtrl.dispose();
    _composerFocus.dispose();
    _scroll.dispose();
    _sfx.dispose();
    _recorder.dispose();
    _sttSession?.cancel();
    if (_convKey != null) DraftStore().set(_convKey!, _ctrl.text.trim());
    _dm?.stop();
    _gdm?.stop();
    _liveBroadcaster?.stop('disposed');
    for (final s in _live.values) {
      s.dispose();
    }
    if (_sharePresence) {
      try { _presence?.sendOffline(DateTime.now().millisecondsSinceEpoch ~/ 1000); } catch (_) { /* best-effort */ }
    }
    _onlineHeartbeat?.cancel();
    _presence?.dispose();
    _typingClear?.cancel();
    _myTypingOff?.cancel();
    _onlineClear?.cancel();
    _confTimer?.cancel();
    _pruneTimer?.cancel();
    _persistTimer?.cancel();
    _markReadTimer?.cancel();
    // [ISSUE-BADGE-UNREAD-1] The debounce above dies with the widget, so a user
    // who reads a thread and immediately backs out would leave the badge stale
    // (and under ShellV2 no chat-list resume hook is guaranteed to fix it). Fire
    // one final, widget-independent reconcile; the short delay lets the last
    // setRead write land first. BadgeService is static, so this is safe here.
    _badgeTimer?.cancel();
    unawaited(Future<void>.delayed(const Duration(milliseconds: 300),
        () => BadgeService.recompute(source: 'thread_closed')));
    _smartReplyDebounce?.cancel(); // STREAM G smart replies
    _composeUnfurlDebounce?.cancel(); // compose-time link preview
    LinkViewer.close(); // tear down the in-app video/article viewer overlay
    _persistNow(); // flush any pending message-cache write on exit
    // NOTE: do NOT dispose _nostr — it's the shared SyncHub client owned by the
    // whole app. _dm.stop()/_gdm.stop() above already cancel this screen's
    // listeners; the socket stays alive so returning to a chat is instant.
    super.dispose();
  }

  // Phase 3 fills this: a hook to summon Ava from the composer. When non-null
  // and the outgoing text mentions @ava (see [_avaWakeWord]), Phase 3 routes the
  // turn to the in-thread agent (POST AvaApi.threadTurn) instead of / in addition
  // to sending the human message. Phase 0 only wires the hook + detection point;
  // it does NOT implement any behavior. Leave null here.
  Future<void> Function(String text)? onSummonAva;

  /// Subscription to on-device Ava answers for THIS conversation (Local Ava AI).
  StreamSubscription<AvaLocalReply>? _localAvaSub;

  /// Subscription to LIVE `@ava` token streaming from the server (cloud agent).
  /// Grows an Ava bubble as deltas arrive; the durable answer replaces it.
  StreamSubscription<Map<String, dynamic>>? _avaStreamSub;

  /// [AVA-MEDIA-JOB-2] Subscription to every AiMediaJob upsert/removal across
  /// the whole app; filtered to THIS conversation in [_bindAiJobs]. Bound once
  /// in `initState` (event-time filtering means it's safe to bind before
  /// `_convKey`/`_serverConvId` are known — see [_bindAiJobs]), cancelled in
  /// `dispose`.
  StreamSubscription<AiMediaJobUpdate>? _aiJobsSub;


  /// Composer "Ava mode": when ON, every message you send is a PRIVATE @ava call
  /// (no need to type @ava) — handy for quietly drafting a reply with Ava, then
  /// flipping back to message the person. Toggled by the ✦ button in the composer.
  bool _avaMode = false;

  /// `_ragLive` gates incoming messages so reopening a chat doesn't re-index
  /// already-seen history. [ONEBRAIN-B3-APP] The former per-member RAG BATCH
  /// (buffer conversation lines → flush to the user's Gemini File Search store
  /// via RagService) was CUT (B-D2): it was a second, unaudited brain shipping
  /// chat content server-side. Chat content is device_private (§2.1) and stays
  /// on-device (the AvaOnDeviceRag lane below, when Local Ava AI is active).
  bool _ragLive = false;

  // ---- calls ----
  // 1:1 = P2P (CallRoom DO) via _call(). Groups = Cloudflare Realtime A/V
  // conference via _groupCall() — RULE CHANGE 2026-06-10 (Phase 10): group
  // conferences are allowed, ≤25 participants. The CallRoom DO 2-peer cap
  // stays untouched.
  bool _dialing = false; // debounce: blocks a second call_started while dialing

  // ---- group conferencing (Phase 10, ≤25 participants — Cloudflare Realtime
  // A/V only as of CF-CALL-007) ----
  Timer? _confTimer;
  bool _confLive = false;
  int _confCount = 0;
  // [GCALL-W1-STATUS] Last known backend verdict, so the greyed-icon notice can
  // name the real reason instead of always blaming group size, and so the
  // ongoing-call banner can join with the call's actual media kind.
  bool _confBackendAvailable = true;
  String? _confUnavailableReason;
  String? _confMediaKind;



  /// [MEDIA-RETRY-KIND-1] Dedup guard so a broken bubble that rebuilds
  /// repeatedly (list scroll, setState elsewhere) only reports
  /// `chat_media_load_failed` ONCE per message+kind instead of on every build.
  final Set<String> _reportedBrokenMedia = {};


  // Upload caps (owner rule): photos/videos ≤ 25 MB each; ≤ 8 photos per pick.

  // VIDPOL-1: chat videos are transcoded to 720p H.264 on-device, then held to a
  // hard 64 MB cap. Source clips off a modern phone are often 200+ MB; the
  // transcode brings a typical 3–5 min clip well under the cap, and anything
  // still over is rejected with the owner-mandated notice below.

  // ---- voice note record ----
  // ── [VOICE-REC-1] Voice recorder (owner report 2026-07-16, pic 5) ──────────
  //
  // The recorder used to be a two-state tap toggle whose entire UI was the word
  // "Recording… tap to send". That gave the user no way to know the mic was
  // actually live, no elapsed time, no way to pause, no way to discard a bad
  // take, no protection from the screen locking mid-sentence, and no handling
  // of the app being backgrounded. This block adds all of it.

  /// Rolling amplitude samples (0..1), newest last — the live waveform in the
  /// recording bar. Sampled at 12Hz from the recorder's own metering.
  ///
  /// Why this exists: the bar previously just said "Recording". The owner's
  /// complaint is exactly right — a static word is indistinguishable from a
  /// recorder that has silently died (a revoked mic permission, another app
  /// holding the input, a Bluetooth headset that dropped). A waveform that
  /// moves when you speak is the ONLY affordance that proves the mic is hearing
  /// you, which is why WhatsApp draws one.
  final List<double> _recLevels = [];
  StreamSubscription<Amplitude>? _recAmpSub;
  Timer? _recTick;
  Duration _recElapsed = Duration.zero;
  bool _recPaused = false;


  // Phase 5: a curated, categorized emoji picker. Returns the chosen emoji (or
  // null). Kept package-free (a scrollable grid of common emoji) so it builds in
  // CI without a new dependency.

  // [CHAT-PASTE-1] One-time tip (per account) shown the first time the attach
  // menu is opened, now that the redundant 'Paste image' tile is gone: it tells
  // users the message box itself pastes images via long-press.

  @override
  Widget build(BuildContext context) {
    final c = widget.chat;
    return Scaffold(
      // [AVA-GRP-UI] Near-black Scaffold backdrop — the thread canvas is dark
      // again for the 'default' wallpaper (`_threadGradient` → `AD.bg`) and the
      // 5 selectable presets are all near-black tints too, so `AD.bg` behind the
      // overscroll bounce matches every canvas instead of flashing white.
      backgroundColor: AD.bg,
      body: Stack(children: [
      SafeArea(
        bottom: false,
        child: Column(
          children: [
            // Thread header — paper-2 band with ink bottom border (§8).
            Container(
              height: 58,
              decoration: const BoxDecoration(
                color: AD.headerFooter,
                border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
              ),
              padding: const EdgeInsets.only(left: 4, right: 6),
              child: _searchMode ? _searchBar() : Row(children: [
                IconButton(
                  icon: PhosphorIcon(PhosphorIcons.caretLeft(PhosphorIconsStyle.bold), size: 22, color: AD.textPrimary),
                  onPressed: () => Navigator.pop(context),
                ),
                // [AVA-GRP-UI] Tapping the header avatar opens the full profile:
                // group info for a group, the peer's profile popup for a 1:1.
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    if (c.group) {
                      _openInfo();
                    } else {
                      _openMemberProfile(
                        uid: c.seed,
                        name: c.name,
                        avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl,
                        from: 'header_avatar',
                      );
                    }
                  },
                  child: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderAvatar, width: 2),
                    ),
                    child: Avatar(seed: c.seed, name: c.name, size: 38, avatarUrl: c.avatarUrl.isEmpty ? null : c.avatarUrl),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: GestureDetector(
                    onTap: _openInfo,
                    behavior: HitTestBehavior.opaque,
                    child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(c.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ADText.threadName()),
                      Text(
                          (_peerTyping
                              ? (c.group ? '${_typingWho ?? "Someone"} is typing…' : 'Typing…')
                              : (c.group ? '${c.members} members · tap to manage'
                                  : (_peerOnline ? 'Online' : _relLastSeen()))),
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: ADText.statCaption(c: (_peerTyping || _peerOnline)
                                  ? (_peerOnline && !_peerTyping ? AD.online : AD.iconSearch)
                                  : AD.textTertiary)),
                    ],
                  ),
                  ),
                ),
                // Header actions — uniform 40px compact targets so they sit with
                // EVEN spacing and don't leave a big gap after the last icon.
                // Shield watchdog — green when Ava is watching this chat.
                // Hidden when Guardian is switched off (pro/live launch, KV
                // `guardianEnabled:false`).
                if (RemoteConfig.guardianEnabled) _shieldAction(),
                _headerAction(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                    () => setState(() { _searchMode = true; _searchQuery = ''; }),
                    color: AD.iconSearch),
                if (_isTelThread) ...[
                  // Unknown-number voicemail record — no live peer to call. Offer
                  // a quick "save contact" shortcut in the header instead.
                  if (!_callerSaved)
                    _headerAction(PhosphorIcons.userPlus(PhosphorIconsStyle.bold),
                        () => _saveUnknownContact(source: 'thread_header'), color: AD.iconVideo),
                ] else if (!c.group) ...[
                  _headerAction(PhosphorIcons.phone(PhosphorIconsStyle.bold), () => _call('voice'), color: AD.iconPhone),
                  _headerAction(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), () => _call('video'), color: AD.iconVideo),
                ] else if (RemoteConfig.conferenceEnabled) ...[
                  // Phase 10 RULE CHANGE: group conferences (Cloudflare Realtime A/V, ≤25).
                  // >25 members → greyed icons; tapping pops the limit notice.
                  _headerAction(PhosphorIcons.phone(PhosphorIconsStyle.bold),
                      () => _confAllowed ? _groupCall(false) : _confLimitNotice(false),
                      color: _confAllowed ? AD.textPrimary : AD.textTertiary),
                  _headerAction(PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
                      () => _confAllowed ? _groupCall(true) : _confLimitNotice(true),
                      color: _confAllowed ? AD.textPrimary : AD.textTertiary),
                  if (!_confAllowed)
                    _headerAction(PhosphorIcons.info(PhosphorIconsStyle.bold),
                        () => _confLimitNotice(true), size: 22, color: AD.textTertiary),
                ],
                _headerAction(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold), _overflow, color: AD.iconVideo),
              ]),
            ),
            if (_pinned != null) _pinBanner(),
            // Unknown-number receptionist thread — invite the owner to save the
            // caller (dismissible). Hidden once saved or dismissed.
            if (_isTelThread && !_callerSaved && !_saveBannerDismissed) _saveContactBanner(),
            // Ongoing group conference (Phase 10) — joinable, not ringing.
            if (widget.chat.gid != null && _confLive && RemoteConfig.conferenceEnabled) _confBanner(),
            // STREAM G [GROUP-AI-1]: the catch-up summary card, pinned above the
            // thread (dismissible). Rendered only when we have bullets to show.
            if (!_catchupDismissed && _catchupBullets.isNotEmpty)
              CatchupCard(bullets: _catchupBullets, msgCount: _catchupCount, onDismiss: _dismissCatchup),
            Expanded(
              child: DecoratedBox(
                decoration: BoxDecoration(gradient: _threadGradient),
                child: Builder(builder: (_) {
                final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
                final searching = _searchMode && _searchQuery.trim().isNotEmpty;
                // [CHAT-UI-VISIBLE-MEMO-1] Memoize the filtered/sorted visible
                // list instead of recomputing (.where/.toList chains + the
                // ava_status collapse + hideDeleted + search filter) on EVERY
                // rebuild — a bare keystroke, clock tick, or typing-indicator
                // flip used to re-walk the entire message history. Only
                // recompute when something that can actually change the
                // result changed: an `_mutMsgs`-tracked message mutation
                // (`_msgsRev`), the search query/mode, or the hideDeleted
                // toggle — plus the fallback safety net documented on
                // `_visibleCache` above (`_msgs.length` / last-element
                // identity) for any mutation that slipped past `_mutMsgs`.
                final cacheQueryKey = searching ? _searchQuery : '';
                final lastHash = _msgs.isEmpty ? 0 : identityHashCode(_msgs.last);
                List<_Msg> visible;
                final cacheValid = _visibleCache != null &&
                    _visibleCacheRev == _msgsRev &&
                    _visibleCacheQuery == cacheQueryKey &&
                    _visibleCacheHideDeleted == _hideDeleted &&
                    _visibleCacheLen == _msgs.length &&
                    _visibleCacheLastHash == lastHash;
                if (cacheValid) {
                  visible = _visibleCache!;
                } else {
                  visible = _msgs
                      .where((m) => m.expireAt == null || m.expireAt! >= nowS)
                      // Never render control envelopes (read/delivered/typing
                      // receipts) as chat bubbles — they leaked through as raw
                      // JSON "{t:read,…}" green messages that multiplied on reopen.
                      .where((m) => !_isControlEnvelope(m.text))
                      .toList();
                  // "Ava is working…" chips are transient: only the MOST RECENT
                  // message may be one. A real reply (or anything later) makes
                  // earlier chips stale, so they collapse instead of sticking.
                  if (visible.isNotEmpty) {
                    final lastIdx = visible.length - 1;
                    visible = [
                      for (var i = 0; i < visible.length; i++)
                        if (visible[i].special != 'ava_status' || i == lastIdx) visible[i],
                    ];
                  }
                  // "Hide deleted messages" — drop my soft-deleted pills and peer
                  // "This message was deleted" tombstones so they don't clutter.
                  if (_hideDeleted) {
                    visible = visible
                        .where((m) => !m.hidden && m.text != 'This message was deleted')
                        .toList();
                  }
                  if (searching) {
                    final q = _foldSearch(_searchQuery);
                    visible = visible.where((m) => _foldSearch(m.text).contains(q)).toList();
                  }
                  _visibleCache = visible;
                  _visibleCacheRev = _msgsRev;
                  _visibleCacheQuery = cacheQueryKey;
                  _visibleCacheHideDeleted = _hideDeleted;
                  _visibleCacheLen = _msgs.length;
                  _visibleCacheLastHash = lastHash;
                }
                if (searching) {
                  // No literal hit → keep the user IN the thread and offer BOTH the
                  // on-device "Discuss with Ava" find AND the server-side smart
                  // (semantic) search over their own consented index.
                  if (visible.isEmpty) return _searchEmptyState(_searchQuery.trim());
                }
                // Smart-search footer: below the literal hits, offer "Search with
                // AI" (or render the AI results/spinner once run). Only in search
                // mode with a query, and only when there ARE literal hits (the
                // empty-state path renders its own AI section).
                final showAiFooter = searching;
                // F3 (restoreV2): a leading "Older messages" divider sits above
                // the oldest loaded row once we've paged (or are paging) the deep
                // archive, so the extra rows read as history from the backup.
                final showArchiveHeader = RemoteConfig.restoreV2 &&
                    !searching &&
                    (_hasArchived || _archiveLoading);
                final headerCount = showArchiveHeader ? 1 : 0;
                final footerCount = showAiFooter ? 1 : 0;
                // [CHAT-UI-COMPOSER-1] Animated three-dot typing bubble as a
                // synthetic last list item — replaces the header's plain
                // "typing…" text with something that actually reads as "someone
                // is composing a message" (search mode never shows it; the two
                // trailing-item cases are mutually exclusive).
                final showTyping = _peerTyping && !searching;
                final typingCount = showTyping ? 1 : 0;
                // [CHAT-UI-TELEMETRY-1] A genuinely empty, non-searching thread
                // (no messages, nothing left to page in from the archive) used to
                // render a blank white canvas — indistinguishable from "still
                // loading" or a bug. WhatsApp-style nudge instead.
                // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) `!showTyping` guard
                // added: if the peer is mid-typing in an otherwise-empty thread,
                // the list (with its synthetic typing bubble item) must render
                // instead of the empty-state nudge — without this the FIRST
                // message of a new conversation could start with the peer typing
                // and the thread would show "no messages yet" while it happened.
                if (visible.isEmpty && !searching && !showArchiveHeader && !_archiveLoading && !showTyping) {
                  return _emptyThreadState();
                }
                // [AVA-CHAT-INSTANT] Keep the list laid out but invisible + inert
                // until the first jump-to-end lands, so the thread opens already
                // anchored on the newest message (no visible scroll-through).
                // [CHAT-UI-REVERSE-1] `reverse:true` renders list index 0 at the
                // visual BOTTOM (nearest/newest edge) and grows UPWARD from
                // there — this is what gives a thread an open-at-bottom start
                // for free, natively, at scroll offset 0. It replaces the old
                // `_openReveal` Opacity/IgnorePointer "stay invisible until the
                // first jump-to-end lands" hack (deleted — see `_jumpToEndSettled`
                // and the removed `_openReveal` field) — there is no jump to
                // wait for anymore, so there is nothing to hide while it lands.
                final listView = ListView.builder(
                  controller: _scroll,
                  reverse: true,
                  // [UI-BUBBLE-1] Symmetric 12dp horizontal thread padding for both
                  // incoming & outgoing (bubbles cap at 78% of the thread width).
                  // Note: EdgeInsets sides are PHYSICAL (top/bottom of the
                  // viewport), not affected by `reverse` — top:16 still sits
                  // above the visually-topmost item (archive header / oldest
                  // message) and bottom:8 still sits below the visually-bottom
                  // item (typing bubble / newest message), exactly as before.
                  padding: const EdgeInsets.fromLTRB(12, 16, 12, 8),
                  itemCount: visible.length + headerCount + footerCount + typingCount,
                  itemBuilder: (c, i) {
                    // [CHAT-UI-REVERSE-1] Trailing synthetic items (typing
                    // bubble / AI search footer) used to be appended AFTER the
                    // last message — visually the very bottom in the old
                    // non-reversed list. With reverse:true the visual bottom is
                    // index 0, so they move there. They're mutually exclusive
                    // (never both showing at once), so trailingCount is 0 or 1.
                    final trailingCount = footerCount + typingCount;
                    if (trailingCount == 1 && i == 0) {
                      return showAiFooter ? _aiSearchFooter() : _typingBubble();
                    }
                    // msgSlot: 0 = newest message row, increasing toward the
                    // visual top (older messages).
                    final msgSlot = i - trailingCount;
                    // The archive-header divider used to be prepended BEFORE
                    // the first (oldest) message — visually the very top. With
                    // reverse:true the visual top is the LAST index, i.e. the
                    // slot right after the oldest message row.
                    if (showArchiveHeader && msgSlot == visible.length) {
                      return _olderMessagesDivider();
                    }
                    final vi = visible.length - 1 - msgSlot;
                    final m = visible[vi];
                    // Phase 5: insert a "Today / Yesterday / date" separator
                    // ABOVE the first message of each new calendar day, in
                    // CHRONOLOGICAL terms — compare against the message one
                    // position EARLIER in the (still ascending-by-ts) `visible`
                    // array. This formula is UNCHANGED by reverse:true: which
                    // ListView index a message renders at changed (`vi` above),
                    // but which message chronologically precedes it did not,
                    // and the separator lives inside THIS row's own Column
                    // (Column itself is never reversed), so it still paints
                    // directly above this row's bubble on screen.
                    final needsSep = m.ts != 0 &&
                        (vi == 0 || !_sameDay(visible[vi - 1].ts, m.ts));
                    // [CHAT-UI-GESTURES-1] Swipe-to-reply on any normal bubble
                    // (mirrors the long-press menu's 'Reply' action). System
                    // pills / soft-deleted / the transient "Ava is thinking…"
                    // chip don't get it — they have no long-press menu either.
                    // [AVA-MEDIA-JOB-2] Job placeholder cards get no swipe-to-reply
                    // either — same reasoning as the 'ava_status' chip they replace.
                    final canSwipeReply =
                        !m.system && !m.hidden && m.special != 'ava_status' && m.special != 'ai_job';
                    // [CHAT-UI-ROW-EXTRACT-1] The actual `_bubble(m)` build is
                    // deferred into `_MessageRow`'s own State, keyed by message
                    // id below, so an unrelated rebuild (typing indicator,
                    // clock tick, keystroke) reuses the cached bubble instead
                    // of re-running the ~900-line bubble builder for every row.
                    // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) Fold `_audioTick`
                    // into ONLY this row's revision when it's the currently
                    // playing/open voice note (or was, for one extra build after
                    // it stopped) — every other row's revision stays exactly
                    // `_msgsRev`, so a scrub/play/pause/speed tick repaints at
                    // most one bubble instead of the whole visible window.
                    final isAudioTickRow = m.id == _playingAudioId ||
                        m.id == _openAudioId ||
                        m.id == _prevAudioRowId;
                    final rowRevision = isAudioTickRow ? _msgsRev + _audioTick : _msgsRev;
                    final bubble = _SwipeToReply(
                      mine: m.me,
                      onReply: canSwipeReply ? () => setState(() => _replyTo = m) : null,
                      child: _MessageRow(
                        key: ValueKey('row_${m.id}'),
                        msg: m,
                        revision: rowRevision,
                        buildBubble: _bubble,
                      ),
                    );
                    // [CHAT-UI-LIST-1b] Stable key per item (message id) so a
                    // single new/changed message doesn't force Flutter to rebind
                    // every row below it.
                    if (!needsSep) {
                      return KeyedSubtree(key: ValueKey('msg_${m.id}'), child: bubble);
                    }
                    return Column(
                      key: ValueKey('msg_${m.id}'),
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [_daySeparator(_dayLabel(m.ts)), bubble],
                    );
                  },
                );
                return Stack(children: [
                  listView,
                  // [CHAT-UI-LIST-1e] Scroll-to-bottom FAB — appears once an
                  // inbound/Ava message was gated (reader was scrolled up), so
                  // they never lose their place but can still jump to the new
                  // content with one tap. Small unread-count badge, WhatsApp-style.
                  if (_unseenCount > 0)
                    Positioned(
                      right: 12,
                      bottom: 12,
                      child: _scrollToBottomFab(),
                    ),
                ]);
              }),
              ),
            ),
            if (_mentionMatches.isNotEmpty) _mentionBar(),
            // [AVABRAIN-COMPANION-UI-1] Ava's pending suggestion — group threads
            // only, ABOVE the composer (never inside the message list).
            if (_isGroup && _companionDrafts.isNotEmpty) _companionDraftCard(),
            // Unknown-number threads are a one-way voicemail record (no live peer
            // to reply to), so the composer is replaced with a read-only note.
            // STREAM G [GROUP-AI-4]: smart-reply chips above the input (DMs only).
            if (!_isTelThread && _smartReplies.isNotEmpty)
              SmartReplyChips(suggestions: _smartReplies, onTap: _insertSmartReply),
            // STREAM B (SAFE-GATE-2): a pending stranger thread replaces the
            // composer with the safety gate bar (Safety/Block/Report/Accept).
            // Message list stays scrollable above; no typing indicator/composer.
            if (_isTelThread) SafeArea(top: false, child: _telFooter())
            else if (_strangerGatePending && StrangerGateBar.enabled && _serverConv != null)
              SafeArea(top: false, child: StrangerGateBar(
                conv: _serverConv!,
                peerUid: _peerNpub ?? widget.chat.seed,
                peerName: widget.chat.name,
                onAccepted: () {
                  setState(() { _strangerGatePending = false; _threadAcceptState = 'accepted'; });
                  // G1.2: accepting a stranger auto-enables Guardian for this chat.
                  _autoEnableGuardianOnAccept();
                },
                onBlockedOrReported: () { if (mounted) Navigator.of(context).maybePop(); },
              ))
            else SafeArea(top: false, child: _inputBar()),
          ],
        ),
      ),
      // Phase 4: floating-emoji burst overlay (ignores touches; pure delight).
      if (_burstFx.isNotEmpty) Positioned.fill(child: IgnorePointer(child: _burstOverlay())),
      ]),
    );
  }
}
