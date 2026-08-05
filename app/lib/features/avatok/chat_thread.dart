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

  void _markRead() {
    final key = _convKey;
    if (key == null) return;
    // [PUSH-FG-BANNER-1 2026-07-14] Claim this thread as the one on screen, so
    // the foreground FCM handler suppresses the banner for THIS conversation and
    // only this one. Hooked here rather than at each `_convKey = …` assignment
    // because `_markRead` is already the single point every thread flavour (DM,
    // group, tel/voicemail) reaches once its key is known, and it re-fires on
    // every incoming message — so the claim self-heals if anything clears it.
    // `ActiveThread` is only consulted together with `lifecycleState == resumed`,
    // so a claim left standing while the screen is off cannot silence anything.
    ActiveThread.enter(key);
    // [AVAVM-PLAYER-1] Same "single point every thread flavour reaches" logic
    // as the ActiveThread claim above — remember this convKey's Chat so the
    // shell-level mini-player can reopen this exact thread on tap.
    ChatThreadRegistry.remember(key, widget.chat);
    final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    // Local: drives unread badges on THIS device (instant).
    //
    // [ISSUE-BADGE-UNREAD-1] Reading a thread must walk the launcher badge DOWN
    // (owner: "this number should ... reduce with the number of messages read").
    // BadgeService counts messages newer than this conversation's read high-water
    // mark, so the recompute is CHAINED OFF the setRead write — kicking it off in
    // parallel would race and re-read the pre-write mark, leaving the badge stuck
    // one beat behind.
    ReadStateStore().setRead(key, nowSec).then((_) {
      _badgeTimer?.cancel();
      _badgeTimer = Timer(const Duration(milliseconds: 800),
          () => BadgeService.recompute(source: 'thread_marked_read'));
    }, onError: (Object _) {});
    // Server: persist MY read position in my own InboxDO so a fresh login or a
    // second device (e.g. desktop) restores it and stops recounting already-read
    // messages as new. Best-effort — never blocks the UI.
    //
    // COALESCE the server POST: _markRead fires on init, on every incoming
    // message, and on each Ava stream frame, so an un-debounced POST-per-call
    // turns a brief token gap (e.g. just after a backgrounded app-connect OAuth
    // round-trip) into a 401 STORM that blanks the thread. Debounce to at most
    // one POST every few seconds; only the latest read position matters anyway.
    final myUid = _meId?.uid;
    if (myUid == null || myUid.isEmpty) return;
    final conv = serverConvFromKey(key, myUid);
    if (conv == null) return;
    _markReadTimer?.cancel();
    _markReadTimer = Timer(const Duration(seconds: 3), () {
      final ts = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      ApiAuth.postJson(kMsgReadUrl, {'conv': conv, 'read_ts': ts})
          .then((_) {}, onError: (_) {});
      // DURABLE read receipt to the PEER (1:1) so their bubbles turn blue (Read)
      // even if they're offline now — they pick it up on their next /sync. The
      // ephemeral presence read only worked when both were online at once, which
      // is why ticks were stuck on "Sent" (owner report 2026-06-27).
      if (_dm != null) _dm!.sendReceipt('read', ts);
      // [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1] "read" half of the group receipt —
      // mirrors the 1:1 `sendReceipt('read', ts)` call directly above. Group the
      // currently-rendered, not-mine, non-system messages by their ORIGINAL
      // sender (bySender) so this is one POST per distinct sender, not one per
      // message — `AvaGroupDm.sendMsgReceipt` already documents why (only the
      // author's own InboxDO needs to learn who has seen their message).
      if (_isGroup && _gdm != null && RemoteConfig.groupReceiptsEnabled) {
        final bySender = <String, List<String>>{};
        for (final msg in _msgs) {
          if (msg.me || msg.system || msg.evId == null) continue;
          final sender = msg.senderPub;
          if (sender == null || sender.isEmpty) continue;
          (bySender[sender] ??= []).add(msg.evId!);
        }
        if (bySender.isNotEmpty) {
          _gdm!.sendMsgReceipt('read', bySender);
          Analytics.capture('chat_group_receipt_sent', {
            'status': 'read', 'senders': bySender.length,
            'mids': bySender.values.fold<int>(0, (n, l) => n + l.length),
            'gid': widget.chat.gid ?? '',
          });
        }
      }
    });
  }

  /// PartyKit live layer for THIS conversation (ephemeral; gated by RemoteConfig
  /// `partyEnabled` — a dormant no-op until the PartyDO is deployed + flipped on,
  /// so this is safe to ship dark). Joins `thread:<serverConv>` and reacts to the
  /// live events the Worker broadcasts. Today it handles the marketplace
  /// `deal_ready` nudge — the instant the negotiation result lands in our InboxDO,
  /// pull it NOW (forceResync) so the card appears without waiting out the poll.
  /// Typing / receipt / reaction rendering hang off this same room next.
  void _partyJoin(String myUid) {
    final key = _convKey;
    if (key == null || myUid.isEmpty) return;
    final conv = serverConvFromKey(key, myUid);
    if (conv == null) return;
    try {
      final room = PartyHub.I.join('thread:$conv');
      _party = room;
      _partySub = room.events.listen((e) {
        final t = e['t'];
        if (t == 'new') {
          // P13-B PartyKit delivery hint: a peer just sent to this thread. Do a
          // targeted cursor sync NOW instead of waiting for the hub frame. Hint
          // only — InboxDO is the source of truth, so a missed hint is harmless.
          try { SyncHub.I.syncFromPush(); } catch (_) {}
        } else if (t == 'deal_ready') {
          try { SyncHub.I.forceResync(); } catch (_) {} // marketplace card lands instantly
        } else if (t == 'reaction') {
          _applyPartyReaction(e); // live per-message reaction (#4)
        } else if (t == 'burst') {
          final em = e['emoji']?.toString();
          if (em != null && em.isNotEmpty) _spawnBurst(em); // floating-emoji burst
        }
      });
    } catch (_) {/* party is best-effort */}
  }

  /// Apply a peer's live reaction (PartyKit) to the aggregate count + "reacted by"
  /// set on the target bubble — same logic the retired Ably path used.
  void _applyPartyReaction(Map<String, dynamic> e) {
    final mid = e['mid']?.toString();
    final emoji = e['emoji']?.toString();
    if (mid == null || emoji == null) return;
    final add = e['add'] == true;
    final who = (e['from'] ?? '').toString();
    final whoName = (e['whoName'] ?? '').toString();
    if (whoName.isNotEmpty && who.isNotEmpty && _memberNames[who] != whoName) {
      _memberNames[who] = whoName;
    }
    final i = _msgs.indexWhere((m) => m.evId == mid);
    if (i < 0) return;
    _mutMsgs(() {
      final msg = _msgs[i];
      final c = msg.reactCounts;
      c[emoji] = ((c[emoji] ?? 0) + (add ? 1 : -1)).clamp(0, 9999);
      if (c[emoji] == 0) c.remove(emoji);
      final by = msg.reactBy.putIfAbsent(emoji, () => <String>{});
      if (add) { by.add(who); } else { by.remove(who); }
      if (by.isEmpty) msg.reactBy.remove(emoji);
    });
  }

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

  void _setupDm(Identity id) {
    if (widget.chat.gid != null) { _setupGroup(id); return; }
    if (widget.chat.group) return; // legacy local group
    final seed = widget.chat.seed;
    final tel = telPhone(seed);
    if (tel != null) { _setupTelThread(id, tel); return; } // unknown-number voicemail
    final peerHex = seed;
    if (peerHex.isEmpty) return; // no addressable peer id → keep local echo
    _realMode = true;
    _mutMsgs(() => _msgs.clear()); // drop demo seed; history loads from relay
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _dm = AvaDm(client: _nostr!, myPriv: id.uid, myPub: id.uid, peerPub: peerHex);
    _dm!.messages.listen(_onDm);
    _dm!.sendStatus.listen(_onSendStatus);
    _dm!.start();
    _presenceMe = id.shortId;
    _presence = PresenceChannel(PresenceChannel.roomFor1on1(id.uid, peerHex), id.shortId,
        convKey: '1:$peerHex', peerUid: peerHex)..connect();
    _presence!.events.listen(_onPresence);
    _presence!.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
    if (_sharePresence) _presence!.sendOnline();
    _startPresenceHeartbeat();
    _loadLastSeen();
    _peerNpub = seed; // contact uid, for message notifications
    _convKey = '1:$peerHex';
    // STREAM B (SAFE-GATE-1/2): compute the SERVER conv id (dm_lo__hi) and, for a
    // non-contact peer, gate the thread. Fire-and-forget; the gate bar renders
    // once _strangerGatePending flips true.
    _serverConv = dmConvIdFor(id.uid, peerHex);
    _initStrangerGate(peerHex);
    _partyJoin(id.uid); // PartyKit live layer (deal-ready nudge etc.); no-op until flag on
    _loadGuardian();
    onSummonAva = AvaInvoke.makeHandler(_convKey!); // Phase 11: @ava → in-thread turn
    _initAvaChatState(); // Phase A: load "Ava in this chat" + reset ava_unread
    _bindLocalAva(); // render on-device @ava answers when Local Ava AI is active
    _bindAvaStream(); // render LIVE server @ava answers as they stream in
    // Seed instantly from the shared hub's in-memory store (this session).
    for (final m in SyncHub.I.messagesFor(_convKey!)) _onDm(m, seed: true);
    // Durable history from the local SQLite DB — the source of truth. Covers
    // messages received in PAST sessions while this thread was closed (the hub
    // stored them in the DB even though no open thread cached them). _onDm dedups
    // by rumor id, so this never double-renders what's already shown.
    Db.I.messagesFor(_convKey!).then((rows) {
      if (!mounted) return;
      for (final m in rows) {
        _onDm(DmMessage(rumorId: m.rumorId, mine: m.mine, payload: m.payload, createdAt: m.createdAt), seed: true);
      }
      _jumpToEndSettled(); // open ON the latest message, not mid-thread
      // STREAM B: re-evaluate the stranger gate now that history (inbound/outbound)
      // is loaded — the initial call ran before _msgs was populated.
      _initStrangerGate(peerHex);
    });
    // Restore persisted delivery/read marks so ticks are correct immediately on
    // reopen (before any fresh receipt arrives) — survives app restarts.
    ReceiptStore().get(_convKey!).then((r) {
      if (!mounted) return;
      setState(() {
        if (r.delivered > _peerDeliveredTs) _peerDeliveredTs = r.delivered;
        if (r.read > _peerReadTs) _peerReadTs = r.read;
      });
    });
    _markRead();
    _loadChatExtras();
    _loadCachedMessages();
  }

  /// Set up a READ-ONLY unknown-number receptionist thread. The caller has no
  /// AvaTOK account, so there is no live peer to message — this is purely the
  /// owner's voicemail record. We load the stored receptionist cards from the
  /// hub + local DB under the deterministic `g:recept_<me>__tel:<phone>` key and
  /// decide whether to show the "Save to contacts" affordances.
  void _setupTelThread(Identity id, String phone) {
    _realMode = true;
    _isTelThread = true;
    _telPhone = phone;
    _convKey = receptTelConvKey(id.uid, phone);
    _mutMsgs(() => _msgs.clear());
    // Seed from the in-memory hub store, then durable history from SQLite.
    for (final m in SyncHub.I.messagesFor(_convKey!)) _onDm(m, seed: true);
    Db.I.messagesFor(_convKey!).then((rows) {
      if (!mounted) return;
      for (final m in rows) {
        _onDm(DmMessage(rumorId: m.rumorId, mine: m.mine, payload: m.payload, createdAt: m.createdAt), seed: true);
      }
      _jumpToEndSettled();
    });
    // Is this caller already a saved contact? (A provisional `tel:` row counts
    // as "in the list" but NOT as saved until the owner names them.)
    ContactsStore().load().then((cs) {
      if (!mounted) return;
      setState(() => _callerSaved = callerIsSaved(cs, phone));
    });
    _markRead();
    _loadChatExtras();
  }

  Future<void> _loadChatExtras() async {
    final key = _convKey;
    if (key == null) return;
    // [AVA-MEDIA-JOB-2] Hydrate + reconcile this conversation's durable AI
    // media jobs (image/doc/audio) now that a conv id is known, then
    // explicitly seed a card for every job already known — required even
    // though [_bindAiJobs]'s update stream ALSO fires on hydrate/reconcile,
    // because a job whose state hasn't changed since a prior visit this
    // session is a no-op in the repository's dedup (`_apply` only notifies on
    // a VISIBLE change) and would otherwise never get a card in a freshly
    // rebuilt `_msgs` list. Fire-and-forget: never blocks the rest of this
    // thread's setup.
    unawaited(_openAiJobs(_serverConvId ?? key));
    final draft = (await DraftStore().load())[key];
    final timer = (await ChatTimerStore().load())[key];
    final pin = (await PinnedMsgStore().load())[key];
    final wp = await WallpaperStore().load();
    if (!mounted) return;
    setState(() {
      if (draft != null && draft.isNotEmpty && _ctrl.text.isEmpty) { _ctrl.text = draft; _hasText = true; }
      _disappearSecs = int.tryParse(timer ?? '') ?? 0;
      _wallpaperId = wp[key] ?? wp['global'] ?? 'default';
      try { _pinned = pin != null ? (jsonDecode(pin) as Map).cast<String, String>() : null; } catch (_) {}
    });
    if (_isGroup) {
      final contacts = await ContactsStore().load();
      final names = <String, String>{};
      final avatars = <String, String>{}; // [AVAGRP-BUBBLE-1] uid → photo URL
      for (final c in contacts) {
        names[c.uid] = c.name;
        if (c.avatarUrl.isNotEmpty) avatars[c.uid] = c.avatarUrl;
      }
      if (_meId != null) names[_meId!.uid] = 'You';
      // Merge (don't replace): keep any names/avatars already learned from
      // early live reactions / messages (keyed by uid) — Phase 5.
      // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) bump `_msgsRev` here too:
      // `_memberNames`/`_memberAvatars` are read inside `_bubble()` (sender
      // name/avatar), but `_MessageRow` only re-invokes `_bubble()` when
      // `_msgsRev` changes — a plain `setState()` left every already-cached
      // group row showing the placeholder initial/uid forever, even after
      // resolution completed. This is coarse (invalidates every cached row,
      // same as any other `_msgsRev` bump) but cheap and rare — it fires once
      // per thread open, not per message.
      if (mounted) setState(() { _memberNames.addAll(names); _memberAvatars.addAll(avatars); _msgsRev++; });
      // [AVA-GRP-UI] Members you haven't saved as contacts have no local photo,
      // so their bubbles showed a bare initial. Resolve their profile photo from
      // the directory in the background and load it via the cached Avatar pipeline.
      unawaited(_backfillMemberAvatars());
    }
    // 2026-07-04: hydrate server-persisted poll tallies for this conversation so
    // a reinstalled / new device shows correct counts + my selection + who-voted.
    unawaited(_hydratePolls());
  }

  /// [AVA-GRP-UI] Backfill group-member profile PHOTOS for members the local
  /// user hasn't saved as a contact. `_memberAvatars` is otherwise seeded only
  /// from `ContactsStore`, so a member not in your contacts rendered a bare
  /// initial ("P") in their bubble instead of their photo. Resolve each missing
  /// member through the directory (Clerk uid → profile photo) and merge the URL
  /// in; the `Avatar` widget (`core/avatar.dart`) then loads it through the
  /// normal cached Cloudflare-AVIF pipeline like every other avatar. Best-effort
  /// and cheap: `Directory.resolve` has a 24h per-account negative cache, so a
  /// member with no directory photo is queried at most once a day. State is
  /// in-memory only (`_memberAvatars`/`_memberNames`), so no per-account
  /// persisted store to scope here.
  Future<void> _backfillMemberAvatars() async {
    final members = _group?.members;
    if (members == null || members.isEmpty) return;
    final myUid = _meId?.uid;
    for (final uid in members) {
      if (uid.isEmpty || uid == myUid) continue;
      if (_memberAvatars[uid]?.isNotEmpty ?? false) continue; // already have a photo
      Contact? c;
      try {
        c = await Directory.resolve(uid);
      } catch (_) {
        c = null; // transient — leave the initial fallback, try again next open
      }
      if (!mounted) return;
      if (c == null) continue;
      final gotPhoto = c.avatarUrl.isNotEmpty && !(_memberAvatars[uid]?.isNotEmpty ?? false);
      final gotName = c.name.isNotEmpty &&
          (_memberNames[uid] == null || _memberNames[uid]!.isEmpty);
      if (gotPhoto || gotName) {
        // [CHAT-UI-ROW-EXTRACT-1] (Opus gate-A fix) same reasoning as the
        // `_loadChatExtras` merge above — bump `_msgsRev` so cached rows for
        // this member re-render with the resolved photo/name.
        setState(() {
          if (gotPhoto) _memberAvatars[uid] = c!.avatarUrl;
          if (gotName) _memberNames[uid] = c!.name;
          _msgsRev++;
        });
      }
    }
  }

  // ── [AVAGRP-SENDERPUB-BACKFILL-1] historical `senderPub` repair ─────────────
  //
  // THE BUG: group bubbles from Tue 2026-07-14 → Thu 2026-07-16 render the
  // letter "P" instead of the sender's photo. `_bubbleAvatar`'s fallback chain
  // ends in the literal 'peer' → `Avatar` draws its initial. That branch is only
  // reachable when `m.senderPub` is empty (`_groupLabelFor` returns null for an
  // empty uid, so `senderLabel` is null too, and `_memberAvatars[pub]` can never
  // be keyed).
  //
  // WHY THOSE ROWS ARE EMPTY: `[AVAGRP-DBPUB-1]` only STARTED persisting
  // `senderPub` (Messages column v8). Rows written by earlier builds read back
  // NULL → ''. The JSON disk cache has the same hole (caches written by older
  // builds carry no `senderPub` key), so BOTH local replay sources are blank and
  // no amount of reopening fixes it. The server is fine — `inbox.ts` has stored
  // `sender` on every row all along.
  //
  // WHY RE-SYNCING CANNOT FIX IT (the trap): `Db.upsertMessage` is
  // `insertOrIgnore`. Re-ingesting a message the DB already holds keeps the OLD
  // row, so `senderPub` stays NULL. `_onGroupMsg` likewise returns early on
  // `_seenEv`, so re-feeding a repaired frame would not re-render either. The
  // repair therefore has to UPDATE the row (`Db.setSenderPub`) and mutate the
  // already-rendered `_Msg` in place — which is why those two fields lost their
  // `final`.
  //
  // THE SOURCE: `GET /api/msg/sync?cursor=0` (worker `syncMsg` →
  // `InboxDO.syncPayload`) returns this account's own backlog with `sender` on
  // every row. It is ALREADY reachable from the client with no worker change —
  // `inbox_api.dart` (AvaDial) calls the same route. Deliberately NOT the WS
  // `SyncHub` cursor: that is shared app-lifetime state, and rewinding it to 0
  // would re-drive every listener (unread recount, preview bumps, delete
  // re-application) for the whole account. This is a plain read-only HTTP GET
  // that touches nothing but the rows it repairs.
  //
  // NO KILL SWITCH, deliberately. The FAKE-FLAG rule in CLAUDE.md means a real
  // flag needs a `config.ts` DEFAULTS entry + a worker deploy to be flippable,
  // and this repair does not warrant one: it is read-only on the server, runs at
  // most once per conversation, only ever fills empty fields, cannot duplicate a
  // bubble (`_seenEv`), cannot lose one (it never deletes or reorders), and
  // degrades to today's exact behaviour on any failure. The self-limiting guards
  // below ARE the brake.
  //
  // State is a per-account DiskCache key: `DiskCache` writes under
  // `cache/<AccountScope.id>/`, so the marker is namespaced per account by
  // construction and cannot leak between the parent/child accounts sharing a
  // phone (CLAUDE.md rule 1).

  Future<Set<String>> _senderPubRepairedConvs() async {
    try {
      final raw = await DiskCache.read(_kSenderPubRepairKey);
      if (raw == null || raw.isEmpty) return {};
      final l = jsonDecode(raw);
      if (l is List) return l.map((e) => e.toString()).toSet();
    } catch (_) { /* unreadable marker ⇒ treat as unrepaired; worst case one extra GET */ }
    return {};
  }

  Future<void> _markSenderPubRepaired(String gid) async {
    try {
      final s = await _senderPubRepairedConvs();
      if (!s.add(gid)) return;
      await DiskCache.write(_kSenderPubRepairKey, jsonEncode(s.toList()));
    } catch (_) { /* best-effort; a lost marker only costs one repeat GET */ }
  }

  /// One-shot, per-conversation, best-effort repair of blank `senderPub` on
  /// historical group bubbles. Never blocks the thread opening (fired via
  /// `unawaited` after both replay sources have landed), never throws.
  Future<void> _backfillSenderPubs() async {
    if (!_isGroup || !mounted) return;
    final gid = _group?.id;
    if (gid == null || gid.isEmpty) return;

    // Cheapest guard FIRST: a healthy thread does zero I/O and never marks
    // itself, so this stays inert for every user who has no damaged rows.
    final stuck = _msgs
        .where((m) =>
            !m.me &&
            !m.system &&
            (m.senderPub?.isEmpty ?? true) &&
            (m.evId?.isNotEmpty ?? false))
        .toList();
    if (stuck.isEmpty) return;

    // One-shot per conversation: rows the server can no longer show us (older
    // than the DO's 500-row SYNC_LIMIT window, or purged) would otherwise re-ask
    // on every single open, forever.
    if ((await _senderPubRepairedConvs()).contains(gid)) return;
    if (!mounted) return;

    final scanned = stuck.length;
    var recovered = 0;
    final resolvedUids = <String>{};
    try {
      final res = await ApiAuth.getSigned('$kMsgSyncUrl?cursor=0');
      if (res.statusCode != 200 || !mounted) return; // transient → retry next open, stay unmarked
      final body = jsonDecode(res.body);
      final rows = (body is Map ? body['messages'] : null);
      if (rows is! List) return;

      // rumorId is derived EXACTLY as `SyncHub._ingestMsg` and
      // `_ingestArchiveRow` derive it, so these keys line up with `_Msg.evId`.
      final byRumor = <String, String>{};
      for (final r in rows) {
        if (r is! Map) continue;
        if ((r['conv'] ?? '').toString() != gid) continue; // this thread only
        final sender = (r['sender'] ?? '').toString();
        if (sender.isEmpty) continue;
        final clientId = (r['client_id'] ?? '').toString();
        final id = (r['id'] as num?)?.toInt() ?? 0;
        byRumor[clientId.isNotEmpty ? clientId : 'srv_$id'] = sender;
      }

      final myUid = _meId?.uid ?? '';
      final patch = <String, String>{};
      for (final m in stuck) {
        final sender = byRumor[m.evId];
        // `sender == myUid` ⇒ my own row misfiled as inbound. Leave it: every
        // consumer keys "is this mine" off `mine`, and the whole codebase's
        // convention is `senderPub: ''` for own rows.
        if (sender == null || sender.isEmpty || sender == myUid) continue;
        patch[m.evId!] = sender;
      }

      if (patch.isNotEmpty) {
        _mutMsgs(() {
          for (final m in stuck) {
            final s = patch[m.evId];
            if (s == null) continue;
            m.senderPub = s;
            // Recompute the label the same way `_onGroupMsg` does — it was null
            // only because the uid behind it was missing.
            m.senderLabel ??= _groupLabelFor(s);
            recovered++;
            resolvedUids.add(s);
          }
        });
        // Durable half: UPDATE (not upsert — see `Db.setSenderPub`) so the fix
        // survives a restart even if the JSON cache is later evicted.
        for (final e in patch.entries) {
          try { await Db.I.setSenderPub(e.key, e.value); } catch (_) { /* row repaired in memory regardless */ }
        }
        _schedulePersist(); // rewrite the JSON cache WITH senderPub this time
        // Members whose photo we never fetched (they aren't saved contacts) can
        // now be resolved — the map is keyed by uid, which we finally have.
        unawaited(_backfillMemberAvatars());
      }
      await _markSenderPubRepaired(gid);
    } catch (_) {
      return; // degrade silently — the bubbles look exactly as they do today
    }

    // Two-sided by design: a group thread is a conversation, so the resolved
    // sender uids are tagged here to let EITHER party's telemetry retrieve the
    // interaction. The viewer's own email/platform is auto-stamped by
    // `Analytics._base` — never hand-add it (CLAUDE.md).
    Analytics.capture('grp_senderpub_backfill', {
      'gid': gid,
      'scanned': scanned,
      'recovered': recovered,
      'skipped_unresolvable': scanned - recovered,
      'sender_uids': resolvedUids.take(25).toList(),
      'sender_count': resolvedUids.length,
    });
  }

  /// Batch-fetch every poll's tally for THIS conversation from the server and
  /// merge it into the loaded poll bubbles. Runs on open (after cache load) and
  /// again when a new poll bubble arrives. Server is the source of truth — this
  /// replaces the local tally rather than adding to it, so reinstalled devices
  /// converge to the real counts. Best-effort; a failure leaves live-only tallies.
  Future<void> _hydratePolls() async {
    final conv = _serverConvId;
    if (conv == null) return;
    try {
      final res = await ApiAuth.getSigned('$kPollStateUrl?conv=${Uri.encodeComponent(conv)}');
      if (res.statusCode != 200 || !mounted) return;
      final polls = (jsonDecode(res.body)['polls'] as Map?) ?? const {};
      if (polls.isEmpty) return;
      final myUid = _meId?.uid ?? '';
      _mutMsgs(() {
        for (final m in _msgs) {
          if (m.special != 'poll') continue;
          final id = m.extra?['id']?.toString();
          if (id == null) continue;
          final p = polls[id];
          if (p is! Map) continue;
          final counts = (p['counts'] as Map?) ?? const {};
          final voters = (p['voters'] as Map?) ?? const {};
          m.pollVotes = {};
          m.pollBy = {};
          m.pollMine = {};
          counts.forEach((k, v) {
            final idx = int.tryParse(k.toString());
            if (idx != null) m.pollVotes[idx] = (v as num).toInt();
          });
          voters.forEach((k, v) {
            final idx = int.tryParse(k.toString());
            if (idx == null || v is! List) return;
            final set = v.map((e) => e.toString()).toSet();
            m.pollBy[idx] = set;
            if (myUid.isNotEmpty && set.contains(myUid)) m.pollMine.add(idx);
          });
        }
      });
    } catch (_) { /* best-effort; live-only tallies remain */ }
  }

  // ---- [GRP-W3-REACTIVE] keep an OPEN group thread's membership current --------
  //
  // `_group` / `_memberUids` were read once at setup and never looked at again,
  // so a member added while this thread was open stayed invisible until the app
  // was force-closed. That staleness also fed the seen-by thresholds, the notify
  // recipients, and — since Wave 1 — the ≤25 group-call gate, which could refuse
  // or allow a call on a member count that no longer existed.
  StreamSubscription<String>? _groupChangeSub;

  void _watchGroupChanges(String myUid) {
    _groupChangeSub ??= GroupStore.changes.listen((changedId) async {
      final gid = widget.chat.gid;
      if (gid == null || !mounted) return;
      if (changedId != gid && changedId != GroupStore.anyGroup) return;
      final g = await GroupStore().byId(gid);
      if (!mounted || g == null) return;
      setState(() {
        _group = g;
        _memberUids = g.members.where((m) => m != myUid).toList();
      });
    });
  }

  Future<void> _setupGroup(Identity id) async {
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    _realMode = true;
    _isGroup = true;
    _group = g;
    Analytics.capture('group_thread_opened', {'gid': g.id, 'member_count': g.members.length});
    _mutMsgs(() => _msgs.clear());
    _nostr = SyncHub.I.ensure(id.uid, id.uid); // shared app-lifetime client (no per-thread socket/REQ)
    _gdm = AvaGroupDm(group: g);
    _gdm!.messages.listen(_onGroupMsg);
    // [AVA-GRP-SENDSTATE] Bridge the outbox ACK/give-up stream to the same handler
    // the DM path uses, so a group bubble flips "Sending…" → "Sent" on the real
    // HTTP-200 ACK (and "Not sent" only on a terminal give-up). Without this a
    // delivered group message never left the pending state and was later mis-shown
    // as "NOT SENT · tap to retry" on reopen.
    _gdm!.sendStatus.listen(_onSendStatus);
    _gdm!.start();
    _presenceMe = id.shortId;
    _presence = PresenceChannel(PresenceChannel.roomForGroup(g.id), id.shortId,
        convKey: 'g:${g.id}')..connect();
    _presence!.events.listen(_onPresence);
    _startPresenceHeartbeat();
    _memberUids = g.members.where((m) => m != id.uid).toList();
    _convKey = 'g:${g.id}';
    _watchGroupChanges(id.uid);
    // [AVABRAIN-COMPANION-UI-1] Group Companion draft cards — group threads
    // only, fetched once on open (feature-detects a 404 → does nothing if the
    // server route/flag isn't live).
    unawaited(_fetchCompanionDrafts());
    _loadGuardian();
    onSummonAva = AvaInvoke.makeHandler(_convKey!); // Phase 11: @ava → in-thread turn
    _initAvaChatState(); // Phase A: load "Ava in this chat" + reset ava_unread
    _bindLocalAva(); // render on-device @ava answers when Local Ava AI is active
    _bindAvaStream(); // render LIVE server @ava answers as they stream in
    _markRead();
    _loadChatExtras();
    // [AVAGRP-BUBBLE-2 §6] SEQUENCED, not fire-and-forget: the JSON cache below
    // carries a correct `senderPub` per message (persisted since [AVAGRP-BUBBLE-1]
    // — see `_persistNow`/`fromJson`), and both calls dedup via `_seenEv`/
    // `_onGroupMsg`'s `if (_seenEv.contains(rumorId)) return`, so WHICHEVER ONE
    // RUNS FIRST for a given message wins and the second is silently skipped.
    // [AVAGRP-DBPUB-1] The DB replay below now ALSO carries a real `senderPub`
    // (persisted on `Messages` — see the column doc in `db.dart`), so the race
    // this comment used to warn about no longer has a losing side: whichever
    // source wins, the rendered bubble gets the correct avatar/tint. The cache
    // is still awaited first on purpose — it carries fields the DB doesn't
    // (readBy/deliveredTo/pending/etc.), not because it's the only correct
    // source of `senderPub` anymore. Do not remove this sequencing.
    _loadCachedMessages().then((_) {
      if (!mounted) return;
      // Durable group history from local SQLite — the source of truth that
      // survives restarts WITHOUT re-downloading the backlog (cursor sync).
      // [AVAGRP-DBPUB-1] `senderPub` now comes from the DB column (populated by
      // `SyncHub._ingestMsg`); pre-migration rows read back NULL and fall
      // through to `''`, which every consumer already treats as "unknown
      // sender" (no avatar/tint, not a crash). _onGroupMsg dedups by rumor id,
      // so this never double-renders what's already shown by the cache.
      Db.I.messagesFor(_convKey!).then((rows) {
        if (!mounted) return;
        for (final m in rows) {
          // [AVAGRP-DBPUB-1] Same convention as the live/`_ingestArchiveRow`
          // paths ([GroupMessage] is always constructed with `senderPub: ''`
          // for `mine` rows) — the UI already keys "is this my own bubble" off
          // `mine`, not `senderPub`, so blanking it here just avoids handing a
          // real uid through a field every downstream reader treats as "not
          // mine ⇒ look up avatar/tint".
          _onGroupMsg(GroupMessage(
              rumorId: m.rumorId, senderPub: m.mine ? '' : (m.senderPub ?? ''), mine: m.mine,
              payload: m.payload, createdAt: m.createdAt));
        }
        // [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1 §Hydrate] Backfill the Info sheet
        // for already-rendered OWN messages on cold open — otherwise a message
        // sent in a past session shows "No read receipts yet" until a NEW live
        // receipt happens to arrive, even if every peer read it while the
        // thread was closed. Runs after BOTH replay sources have landed so the
        // mid list is complete. Best-effort; never blocks the thread opening.
        if (RemoteConfig.groupReceiptsEnabled) unawaited(_hydrateMsgReceipts());
        // [AVAGRP-SENDERPUB-BACKFILL-1] Repair history rows whose `senderPub`
        // predates the v8 column (they render as the 'P' initial with no photo
        // and no per-member tint). Must run HERE — after BOTH the JSON cache and
        // the DB replay have landed — so it sees the complete `_msgs` list and
        // doesn't ask the server about rows the cache was about to resolve.
        // `unawaited` + fully self-guarded: never blocks the thread opening.
        unawaited(_backfillSenderPubs());
      });
    });
    // Let replayed group history settle before indexing LIVE messages into RAG.
    Future.delayed(const Duration(seconds: 3), () { if (mounted) _ragLive = true; });
  }

  /// [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1 §Hydrate] `GET /api/msg/seen` for every
  /// currently-rendered message I SENT in this group — the Info sheet only
  /// applies to my own messages (§4/WhatsApp-parity), so that's the only set
  /// worth hydrating. Server contract: `{receipts:[{msg_id,peer,status,ts},...]}`.
  Future<void> _hydrateMsgReceipts() async {
    if (!_isGroup || !mounted) return;
    final conv = _group?.id;
    if (conv == null) return;
    final mids = _msgs.where((m) => m.me && m.evId != null).map((m) => m.evId!).toSet().toList();
    if (mids.isEmpty) return;
    try {
      final res = await ApiAuth.getSigned(
          '$kApiBase/msg/seen?conv=${Uri.encodeComponent(conv)}&mids=${Uri.encodeComponent(mids.join(','))}');
      if (res.statusCode != 200 || !mounted) return;
      final body = jsonDecode(res.body);
      final receipts = (body is Map ? body['receipts'] : null);
      if (receipts is! List) return;
      _mutMsgs(() {
        for (final r in receipts) {
          if (r is! Map) continue;
          final mid = (r['msg_id'] ?? '').toString();
          final peer = (r['peer'] ?? '').toString();
          final status = (r['status'] ?? '').toString();
          final ts = (r['ts'] as num?)?.toInt() ?? 0;
          if (mid.isEmpty || peer.isEmpty) continue;
          final i = _msgs.indexWhere((m) => m.evId == mid);
          if (i < 0) continue;
          if (status == 'read') {
            _msgs[i].readBy[peer] = ts;
            _msgs[i].deliveredTo.putIfAbsent(peer, () => ts);
          } else if (status == 'delivered') {
            _msgs[i].deliveredTo[peer] = ts;
          }
        }
      });
      _schedulePersist();
    } catch (e) {
      // [AVA-GRP-SENDSTATE] Surface hydration failures instead of swallowing them
      // silently — an empty Info sheet on a message everyone has read is exactly
      // the symptom the owner hit, and a failing `GET /api/msg/seen` is one cause
      // that was previously invisible. Best-effort still: live receipts keep
      // arriving over the wire regardless. Email auto-attached by Analytics._base.
      Analytics.capture('grp_receipt_hydrate_failed', {
        'gid': widget.chat.gid ?? '',
        'err': e.toString().length > 120 ? e.toString().substring(0, 120) : e.toString(),
      });
    }
  }

  void _onPresence(Map<String, dynamic> e) {
    if (!mounted) return;
    // Ignore frames the room echoes back to us — otherwise our OWN online/typing
    // frames would mark the PEER online/typing (a cause of the false "online" in
    // pic2). Compare against the exact label we announce as (_presenceMe), not
    // _myName (which later becomes the display name).
    if (_presenceMe != null && e['who']?.toString() == _presenceMe) return;
    // Peer explicitly left/backgrounded → flip to "last seen" immediately rather
    // than waiting out the 35s online window.
    if (e['type'] == 'offline') {
      // [LASTSEEN-HONEST-1] Only a REAL leave carries a ts (peer was online this
      // session). An absence frame without ts must NOT fabricate "now" — that
      // painted every offline contact (phone off all night) as "last seen just
      // now" and PERSISTED the lie via LastSeenStore. Without a ts, keep the
      // last honest value we already had.
      final ts = (e['ts'] as num?)?.toInt();
      _onlineClear?.cancel();
      if (ts != null && _convKey != null) LastSeenStore().set(_convKey!, '$ts');
      setState(() {
        _peerOnline = false;
        _peerTyping = false;
        if (ts != null) _peerLastSeen = ts;
      });
      return;
    }
    // Only an explicit peer 'online' frame marks them online — NOT read/delivered/
    // typing/liveloc frames. Inferring online from those (or from a mis-attributed
    // echo) is what made every contact look "online" (owner report 2026-06-27).
    if (e['type'] == 'online') _markPeerOnline();
    if (e['type'] == 'typing') {
      setState(() { _peerTyping = e['on'] == true; _typingWho = e['who']?.toString(); });
      _typingClear?.cancel();
      if (_peerTyping) {
        _typingClear = Timer(const Duration(seconds: 5), () {
          if (mounted) setState(() => _peerTyping = false);
        });
      }
    } else if (e['type'] == 'read') {
      final ts = (e['ts'] as num?)?.toInt() ?? 0;
      if (ts > _peerReadTs) setState(() { _peerReadTs = ts; _peerDeliveredTs = ts > _peerDeliveredTs ? ts : _peerDeliveredTs; });
    } else if (e['type'] == 'delivered') {
      final ts = (e['ts'] as num?)?.toInt() ?? 0;
      if (ts > _peerDeliveredTs) setState(() => _peerDeliveredTs = ts);
    } else if (e['type'] == 'liveloc') {
      _onLiveLocTick(e);
    } else if (e['type'] == 'livestop') {
      final id = e['id']?.toString();
      if (id != null) _live[id]?.end();
    }
  }

  /// A live-location pin update arrived from the peer. Move the existing session
  /// in place (the bubble + any open map auto-repaint via their listeners) and
  /// throttle the "viewed" telemetry to once / 30 s / share.
  void _onLiveLocTick(Map<String, dynamic> e) {
    final id = e['id']?.toString();
    final lat = (e['lat'] as num?)?.toDouble();
    final lng = (e['lng'] as num?)?.toDouble();
    if (id == null || lat == null || lng == null) return;
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final ts = (e['ts'] as num?)?.toInt() ?? now;
    final until = (e['until'] as num?)?.toInt();
    final s = _live.putIfAbsent(
      id,
      () => LiveLocationSession(
        id: id,
        lat: lat,
        lng: lng,
        until: until ?? (now + 3600),
        mine: false,
        name: e['who']?.toString() ?? widget.chat.name,
      ),
    );
    s.apply(lat, lng, ts,
        heading: (e['hdg'] as num?)?.toDouble(),
        speed: (e['spd'] as num?)?.toDouble(),
        until: until);
    final last = _liveViewTelemetryTs[id] ?? 0;
    if (now - last >= 30) {
      _liveViewTelemetryTs[id] = now;
      Analytics.capture('live_location_viewed', {
        'share_id': id,
        'is_sender': false,
        'conv_kind': _isGroup ? 'group' : 'dm',
      });
    }
  }

  void _markPeerOnline() {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    _peerLastSeen = now;
    // Persist last-seen (throttled) so reopening the thread can show it before
    // any live frame arrives.
    if (_convKey != null && now - _lastSeenPersistTs >= 15) {
      _lastSeenPersistTs = now;
      LastSeenStore().set(_convKey!, '$now');
    }
    if (!_peerOnline) setState(() => _peerOnline = true);
    _onlineClear?.cancel();
    _onlineClear = Timer(const Duration(seconds: 35), () { if (mounted) setState(() => _peerOnline = false); });
  }

  /// Keep "online" truthful: re-announce every 20s while the thread is open so a
  /// peer who's actually here never lapses out of the 35s window, and a peer who
  /// left stops showing "online" within ~35s. Rides the existing Cloudflare room
  /// WS — no per-user DO wake, and nothing is sent once the thread is closed.
  void _startPresenceHeartbeat() {
    _onlineHeartbeat?.cancel();
    _onlineHeartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
      if (mounted && _sharePresence) _presence?.sendOnline();
    });
  }

  Future<void> _loadLastSeen() async {
    final key = _convKey;
    if (key == null) return;
    final v = (await LastSeenStore().load())[key];
    final ts = int.tryParse(v ?? '') ?? 0;
    if (ts > 0 && mounted && _peerLastSeen == 0) setState(() => _peerLastSeen = ts);
    // [LASTSEEN-SERVER-1] WhatsApp-style truth: the peer's InboxDO knows exactly
    // when their device was last connected — no thread has to be open, no
    // presence frame has to arrive. Server value wins over the local cache.
    if (!key.startsWith('1:')) return; // 1:1 only
    final uid = key.substring(2);
    try {
      final r = await ApiAuth.getSigned(
          'https://$kSignalingHost/api/user/last-seen?uid=${Uri.encodeComponent(uid)}');
      if (r.statusCode != 200 || !mounted) return;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final ms = (j['last_active_at'] as num?)?.toInt() ?? 0;
      final online = j['online'] == true;
      final srvTs = ms > 0 ? ms ~/ 1000 : 0;
      if (online) {
        _markPeerOnline();
      } else if (srvTs > 0) {
        LastSeenStore().set(key, '$srvTs');
        setState(() => _peerLastSeen = srvTs);
      }
    } catch (_) {/* offline / older worker — local cache already shown */}
  }

  /// Human "last seen <time>" label from the tracked unix-seconds timestamp.
  String _relLastSeen() {
    if (_peerLastSeen <= 0) return 'tap for contact info';
    final dt = DateTime.fromMillisecondsSinceEpoch(_peerLastSeen * 1000);
    final diff = DateTime.now().difference(dt);
    if (diff.inSeconds < 60) return 'last seen just now';
    if (diff.inMinutes < 60) return 'last seen ${diff.inMinutes}m ago';
    if (diff.inHours < 24) return 'last seen ${diff.inHours}h ago';
    if (diff.inDays == 1) return 'last seen yesterday';
    if (diff.inDays < 7) return 'last seen ${diff.inDays}d ago';
    return 'last seen ${dt.day}/${dt.month}/${dt.year}';
  }

  void _onTyping() {
    if (_presence == null) return;
    _presence!.sendTyping(true);
    _myTypingOff?.cancel();
    _myTypingOff = Timer(const Duration(seconds: 2), () => _presence?.sendTyping(false));
  }


  void _spawnBurst(String emoji) {
    if (!mounted) return;
    final fx = _BurstFx(id: _burstSeq++, emoji: emoji);
    setState(() => _burstFx.add(fx));
    // Self-remove after the rise animation completes.
    Timer(const Duration(milliseconds: 2200), () {
      if (mounted) setState(() => _burstFx.removeWhere((b) => b.id == fx.id));
    });
  }

  /// [AVA-MEDIA-AUTHZ-1] Mirror a received attachment into the recipient's
  /// AvaLibrary — the single call site both `_onGroupMsg` and `_onDm` route
  /// through, since `MediaService.recordReceived` now REQUIRES a server
  /// conversation id (`conv`) the worker uses to verify both the media owner
  /// and the caller belong to it. `_serverConvId` resolves for DM AND group
  /// threads (see its own doc). If it isn't resolvable yet (e.g. `_meId` not
  /// loaded), skip rather than invent an empty string — the server would just
  /// 400 `conv_required` — and report it once so a persistent gap (not just a
  /// one-off race) is visible.
  void _recordReceivedMedia(ChatMedia media) {
    final conv = _serverConvId;
    if (conv == null || conv.isEmpty) {
      AvaLog.I.log('media', 'recordReceived skipped: no server conv id yet');
      Analytics.capture('chat_media_record_skipped', {'reason': 'no_conv'});
      return;
    }
    MediaService.recordReceived(media, conv: conv); // mirror into the recipient's AvaLibrary
  }

  // Send an ephemeral floating-emoji burst to everyone in the room + animate locally.
  void _sendBurst(String emoji) {
    HapticFeedback.lightImpact();
    _party?.send({'t': 'burst', 'emoji': emoji}); // PartyKit floating-emoji burst
    _spawnBurst(emoji); // optimistic local animation (peers see it via the burst stream)
  }

  void _pickBurstEmoji() {
    showModalBottomSheet(
      context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 12),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
            for (final e in ['🎉', '❤️', '👏', '😂', '🔥', '😮'])
              GestureDetector(
                onTap: () { Navigator.pop(ctx); _sendBurst(e); },
                child: Text(e, style: const TextStyle(fontSize: 32)),
              ),
          ]),
        ),
      ),
    );
  }

  void _onGroupMsg(GroupMessage m) {
    if (_seenEv.contains(m.rumorId)) return;
    _seenEv.add(m.rumorId);
    if (!mounted) return;
    String text = '';
    ChatMedia? media;
    Map<String, dynamic>? replyMeta;
    String? special;
    Map<String, dynamic>? extra;
    // [AVAGRP-BUBBLE-2] `GroupApi.announce()` (group_info_screen.dart's
    // photo-change / new_group_screen's "created the group" / add-member
    // copy) sends `{"t":"gtext","gid":conv,"body":text,"system":true}` — the
    // SAME envelope shape as an ordinary text message, distinguished only by
    // this flag. This has been on the wire for years; the client just never
    // read it, so every announcement rendered as an ordinary tinted bubble
    // with a sender name and avatar instead of a centered system pill.
    bool isSystem = false;
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'gedit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && (env['t'] == 'del' || env['t'] == 'gdel')) { if (!m.mine) _applyDelete(env['target'].toString()); return; }
      if (env is Map && env['t'] == 'hide') { _applyHide(env['target'].toString(), env['hidden'] == true); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env); return; }
      // [AVAGRP-BUBBLE-2] Per-message group read/delivered receipt (Agent C's
      // backend — `sync_hub.dart` `_ingestMsgReceipt`). A CONTROL frame, never a
      // chat bubble — applies to the already-rendered `_Msg` (matched by its
      // canonical mid, `_Msg.evId`, the same id already used for reactions) and
      // returns before falling into the bubble-content switch below.
      if (env is Map && env['t'] == 'msg_receipt') { _applyMsgReceipt(env.cast<String, dynamic>()); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept', 'marketplace_deal', 'voicemail', 'agent_transcript'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
        // A poll bubble just arrived — pull its server tally so late joiners /
        // reinstalled devices see any votes already cast (best-effort).
        if (special == 'poll') unawaited(_hydratePolls());
      } else if (env is Map && env['t'] == 'gmedia') {
        media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        text = _caption(media.kind, media.name);
        if (!m.mine) _recordReceivedMedia(media);
      } else if (env is Map && env['t'] == 'gtext') {
        text = (env['body'] ?? '').toString();
        isSystem = env['system'] == true;
      } else if (env is Map && env['t'] == 'deleted') {
        text = 'This message was deleted'; // server tombstone on re-sync
      } else {
        return; // ginfo/gkick etc. — not chat content
      }
      if (env is Map && env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
      // STREAM C: link preview embedded by the sender at compose time — render
      // from the envelope, never fetch on the recipient.
      if (env is Map && env['preview'] is Map) {
        extra = {...?extra, 'preview': (env['preview'] as Map).cast<String, dynamic>()};
      }
    } catch (_) {
      return;
    }
    final env2 = jsonDecode(m.payload) as Map;
    // Phase 5: learn this member's display name from the message (carried as
    // `fromName`), keyed by their uid — so bubbles AND the "reacted by" sheet can
    // show a real name instead of a short id.
    final fromName = (env2['fromName'] ?? '').toString().trim();
    if (!m.mine && fromName.isNotEmpty && m.senderPub.isNotEmpty &&
        _memberNames[m.senderPub] != fromName) {
      _memberNames[m.senderPub] = fromName;
    }
    final exp = (env2['exp'] as num?)?.toInt();
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return; // already gone
    // Safety net: any control envelope (del/gdel/receipt/…) that reached here
    // unhandled must NEVER render as a raw `{"t":...}` bubble. The explicit
    // handlers above already returned for the ones we act on; this catches the rest.
    if (_isControlEnvelope(m.payload)) {
      Analytics.capture('chat_control_filtered', {'where': 'group_live'});
      return;
    }
    // A peer deleted this for everyone (recorded durably) — render the tombstone,
    // never the original body, even though the cached/replayed envelope still has it.
    if (_deletedIds.contains(m.rumorId)) {
      text = 'This message was deleted'; media = null; special = null; extra = null; replyMeta = null;
    }
    _mutMsgs(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: env2['forwarded'] == true, expireAt: exp, special: special, extra: extra,
          starred: _starred.contains(m.rumorId), hidden: _hiddenIds[m.rumorId] == true,
          // [AVAGRP-BUBBLE-2] A system announcement carries no sender identity —
          // no name header, no avatar, no per-sender tint (`_systemBubble`
          // renders before any of that is consulted, but null these out too so
          // a future call site that reads `senderLabel`/`senderPub` directly
          // can't accidentally attribute the announcement to whoever posted it).
          senderLabel: isSystem ? null : _groupLabelFor(m.senderPub, mine: m.mine),
          // [AVAGRP-BUBBLE-1] stable identity for bubble colour + avatar lookup —
          // the previous code only kept the derived display label and threw the
          // uid away, which was the root cause of both the '?' avatar and the
          // reshuffling group tints.
          senderPub: (isSystem || m.mine) ? null : m.senderPub,
          system: isSystem));
      _noteGuardianFlag(special, extra);
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    // Full-thread RAG: index a member's LIVE group text into my own store.
    // `_ragLive` gates out the history that replays on open (avoids re-indexing).
    if (!m.mine && _ragLive && special == null && media == null) {
      _ragAddLine(_shortPub(m.senderPub), text);
    }
    // [AVAGRP-BUBBLE-2 / AVAGRP-SEENBY-1] "delivered" half of the WhatsApp-style
    // two-step group receipt: the instant a peer's message is rendered on THIS
    // device it has been delivered, regardless of whether the thread is the one
    // on screen right now (that's the 'read' half — `_markRead` below fires that
    // when the thread is actually viewed). System pills and control frames never
    // get a receipt (they already `return`d above / carry no `senderPub`).
    // Gated on the dark-launch kill switch — `AvaGroupDm.sendMsgReceipt` is also
    // defense-in-depth server-side, but skip the network call entirely while off.
    if (!m.mine && !isSystem && m.senderPub.isNotEmpty && RemoteConfig.groupReceiptsEnabled) {
      _gdm?.sendMsgReceipt('delivered', {m.senderPub: [m.rumorId]});
      // Two-sided telemetry (CLAUDE.md): fires on the READER's device — tag the
      // ORIGINAL SENDER's uid (`sender_pub`) alongside the auto-stamped reader
      // email, so a report from either party's email can be joined against the
      // other side via `mid`/`sender_pub`.
      Analytics.capture('chat_group_receipt_sent', {
        'status': 'delivered', 'mid': m.rumorId, 'sender_pub': _shortPub(m.senderPub), 'gid': widget.chat.gid ?? '',
      });
    }
    _jump();
    _markRead();
    // STREAM G [GROUP-AI-4]: after an INCOMING DM, offer smart replies (debounced,
    // DM-only; the method self-gates on group/foreground and clears on my own msg).
    if (!m.mine && special == null && media == null) _maybeFetchSmartReplies(); // STREAM G
    _schedulePersist();
  }

  String _shortPub(String hex) => hex.length > 8 ? '${hex.substring(0, 6)}…' : hex;

  // Phase 5: my display name, stamped onto outgoing group messages + reactions so
  // peers can show "Reacted by <name>" and a real sender label (not a short id).
  String get _fromNameTag =>
      (_myName != null && _myName!.trim().isNotEmpty) ? _myName!.trim() : 'Member';

  // Resolve a sender/reactor uid to a friendly group label: my uid → "You", a
  // learned name (from a message or reaction that carried fromName) → that name,
  // else a short id. Empty uid → null (no label).
  String? _groupLabelFor(String uid, {bool mine = false}) {
    if (mine) return null;
    if (uid.isEmpty) return null;
    return _memberNames[uid] ?? _shortPub(uid);
  }

  // The relay accepted/rejected one of our sends → flag the bubble accordingly.
  // ok=true means the event is now ON THE RELAY ("sent" / 1 tick); delivery and
  // read are reported separately by the recipient over the presence channel.
  void _onSendStatus(({String rumorId, bool ok, String message}) s) {
    if (!mounted) return;
    final idx = _msgs.indexWhere((m) => m.evId == s.rumorId);
    if (idx < 0) return;
    final m = _msgs[idx];
    final alreadySent = m.sent;
    // [AVA-GRP-SENDSTATE] The outbox only emits ok:false on a TERMINAL give-up
    // (interim retries stay silent), so `!s.ok` here is authoritative "not sent".
    // Record it so a genuine give-up survives a restart as failed, while a
    // delivered-but-un-ACKed group bubble is never mistaken for one on reopen.
    _mutMsgs(() { m.failed = !s.ok; m.sent = s.ok; m.sendGaveUp = !s.ok; });
    // [AVA-CHAT-INSTANT] Confirm/fail telemetry (email auto-attached by
    // Analytics._base). msg_send_confirmed carries the true send→ACK round-trip;
    // guard on !alreadySent so a re-emitted ACK doesn't double-count.
    if (s.ok && !alreadySent) {
      Analytics.capture('msg_send_confirmed', {
        'conv_kind': _isGroup ? 'group' : 'dm',
        if (m.sendStartedMs != null)
          'round_trip_ms': DateTime.now().millisecondsSinceEpoch - m.sendStartedMs!,
      });
    } else if (!s.ok) {
      Analytics.capture('msg_send_failed', {
        'conv_kind': _isGroup ? 'group' : 'dm',
        'has_media': m.media != null || m.localBytes != null,
        if (s.message.isNotEmpty) 'reason': s.message.length > 80 ? s.message.substring(0, 80) : s.message,
      });
    }
  }

  /// Per-message delivery status for MY 1:1 messages (WhatsApp-style). Returns
  /// the tick icon, its colour, and a tiny human label; null when status doesn't
  /// apply (received messages, groups, demo mode). Drives both the ticks and the
  /// little caption under each of my bubbles so the sender always knows where a
  /// message is: still sending → on the relay but not yet on the phone →
  /// delivered to the phone → actually read.
  ({IconData icon, Color color, String label})? _statusFor(_Msg m) {
    if (m.aiLocal) return null; // private @ava question — never sent, so no ticks
    if (!m.me || !_realMode || m.ts <= 0) return null;
    // My bubbles are lime (ink text), so status ticks read in ink tones:
    // read = blue-ink, everything in-flight = ink-soft, failed = coral.
    if (m.failed) {
      return (icon: PhosphorIcons.warningCircle(PhosphorIconsStyle.bold), color: AD.danger, label: 'Not sent · tap to retry');
    }
    // [CHAT-UI-MEDIA-1] Background video transcode (moved off the pre-bubble
    // path by [MEDIA-INSTANT-1]) is otherwise invisible — the bubble just sits
    // there. Surface it explicitly instead of a bare "Sending…".
    if (m.transcoding) {
      return (icon: PhosphorIcons.filmSlate(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Processing video…');
    }
    if (m.uploading) {
      return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sending…');
    }
    // [AVAGRP-BUBBLE-1 / message-info] Groups were hard-gated out above
    // (`_isGroup` in the old guard) because only the 1:1 thread-level
    // high-water marks (`_peerReadTs`/`_peerDeliveredTs`) existed. Now that
    // `_Msg` carries per-member `readBy`/`deliveredTo` (Agent C's backend,
    // `worker/src/do/inbox.ts` + `sync_hub.dart`), a group message can report a
    // real status too: read once EVERY other member has read it, delivered once
    // EVERY other member has it. `_memberUids` is "every member except me" —
    // set in `_setupGroup`. [AVAGRP-BUBBLE-2] The wire-up is LIVE, gated on
    // `RemoteConfig.groupReceiptsEnabled` (dark launch, default false) — while
    // off, `readBy`/`deliveredTo` stay `{}` for every group message (nothing
    // populates them), so this still falls through to "Sent" exactly as before.
    if (_isGroup) {
      if (_memberUids.isNotEmpty && m.readBy.length >= _memberUids.length) {
        return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.iconSearch, label: 'Read');
      }
      if (_memberUids.isNotEmpty && m.deliveredTo.length >= _memberUids.length) {
        return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Delivered');
      }
      if (m.sent) {
        return (icon: PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sent');
      }
      return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sending…');
    }
    if (_peerReadTs > 0 && m.ts <= _peerReadTs) {
      return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.iconSearch, label: 'Read'); // 2 blue ticks
    }
    if (_peerDeliveredTs > 0 && m.ts <= _peerDeliveredTs) {
      return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Delivered'); // 2 grey ticks
    }
    if (m.sent) {
      // 1 tick = left this device / accepted. We deliberately DON'T claim
      // "waiting to reach phone" here — that contradicted the peer showing as
      // online (pic2). Truthful escalation: Sent → Delivered → Read.
      return (icon: PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sent'); // 1 tick
    }
    return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sending…');
  }

  // [seed]=true when replaying stored history (hub memory / local DB) on open —
  // it suppresses re-sending read receipts for old messages (only genuinely
  // live, just-arrived messages should mark-read).
  void _onDm(DmMessage m, {bool seed = false}) {
    if (_seenEv.contains(m.rumorId)) return;
    _seenEv.add(m.rumorId);
    if (!mounted) return;
    // Parse our envelope: {"t":"text","body":...} or {"t":"media",...}.
    String text = m.payload;
    ChatMedia? media;
    Map<String, dynamic>? replyMeta;
    bool forwarded = false;
    int? exp;
    String? special;
    Map<String, dynamic>? extra;
    // G3 (inline two-lane scan): an incoming envelope may carry a top-level
    // `safety:{category,severity}` verdict stamped by the server's FAST lane before
    // fan-out. Treat it like a live safety_flag frame — mark the bubble red on
    // arrival via the existing SafetyFlagStore + _safetyFlags path (below), so the
    // recipient sees the red flag instantly instead of waiting for the deep lane's
    // separate safety_flag push. Only for incoming (peer) messages.
    String? inlineSafetyCat;
    try {
      final env = jsonDecode(m.payload);
      if (env is Map && env['t'] == 'receipt') { _applyReceipt(m.mine, env); return; } // status, never a bubble
      if (env is Map && env['t'] == 'read') return; // read high-water (badge clears via the chat list) — never a bubble
      // [CHAT-RAWENV-1] (owner report 2026-07-16, pic 4) — THE bug in pic 4.
      // A status post is fanned out to every contact over the SAME inbox stream
      // that carries DMs (see status_screen._addPhoto → chat_list._startInbox,
      // which lifts it into the status ring). This thread also reads that
      // stream, had no `status` branch, and so fell through to the catch-all
      // with `text` still holding the raw payload — rendering the entire status
      // envelope, nested media descriptor and AES key included, as a text
      // bubble in the conversation. Status posts belong to the ring, never to a
      // thread: swallow it here.
      if (env is Map && env['t'] == 'status') return;
      if (env is Map && env['gid'] != null) return; // group message — not this 1:1
      if (env is Map && env['t'] == 'edit') { _applyEdit(env['target'].toString(), (env['body'] ?? '').toString()); return; }
      if (env is Map && (env['t'] == 'del' || env['t'] == 'gdel')) { if (!m.mine) _applyDelete(env['target'].toString()); return; }
      if (env is Map && env['t'] == 'hide') { _applyHide(env['target'].toString(), env['hidden'] == true); return; }
      if (env is Map && env['t'] == 'vote') { _applyVote(env); return; }
      if (env is Map && const ['loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'ava', 'ava_private', 'ava_status', 'recept', 'marketplace_deal', 'voicemail', 'agent_transcript'].contains(env['t'])) {
        special = env['t'].toString(); extra = env.cast<String, dynamic>();
        text = _specialCaption(special!, extra!);
        // A poll bubble just arrived — pull its server tally so late joiners /
        // reinstalled devices see any votes already cast (best-effort).
        if (special == 'poll') unawaited(_hydratePolls());
      } else if (env is Map && env['t'] == 'media') {
        // [CHAT-RAWENV-1] Scoped try: a throw in here (an unknown MediaKind, a
        // `size` that arrived as a String, a missing key from a newer build)
        // used to escape to the outer catch with `text` still equal to the raw
        // payload — i.e. one bad field printed the AES key on screen. Now the
        // failure is reported and the frame is dropped by the backstop below.
        try {
          media = ChatMedia.fromEnvelope(env.cast<String, dynamic>());
        } catch (e) {
          Analytics.capture('chat_media_envelope_parse_failed', {
            'error': e.runtimeType.toString(),
            // `?? '(absent)'` is load-bearing, not defensive padding:
            // Analytics.capture takes Map<String, Object>?, so a String? value
            // here is a compile error — and a MISSING `kind` is exactly one of
            // the failures this event exists to catch, so null is a value we
            // must expect and report, not one we can assume away.
            'kind': env['kind']?.toString() ?? '(absent)',
            'size_type': env['size'].runtimeType.toString(),
            'mine': m.mine,
            'peer': widget.chat.name,
          });
          rethrow;
        }
        text = _caption(media.kind, media.name);
        final keyShort = media.id.length > 12 ? media.id.substring(media.id.length - 8) : media.id;
        AvaLog.I.log('media', 'recv dm media kind=${media.kind.name} ${media.size}B key=…$keyShort mine=${m.mine}');
        if (!m.mine) _recordReceivedMedia(media);
      } else if (env is Map && env['t'] == 'text') {
        text = env['body'].toString();
      } else if (env is Map && env['t'] == 'deleted') {
        text = 'This message was deleted'; // server tombstone on re-sync
      }
      if (env is Map) {
        if (env['replyTo'] is Map) replyMeta = (env['replyTo'] as Map).cast<String, dynamic>();
        forwarded = env['forwarded'] == true;
        exp = (env['exp'] as num?)?.toInt();
        // G3 inline safety verdict on the envelope → red bubble on arrival.
        if (!m.mine && env['safety'] is Map) {
          final cat = ((env['safety'] as Map)['category'] ?? '').toString();
          if (cat.isNotEmpty) inlineSafetyCat = cat;
        }
        // STREAM C: sender-embedded link preview → render from the envelope.
        if (env['preview'] is Map) {
          extra = {...?extra, 'preview': (env['preview'] as Map).cast<String, dynamic>()};
        }
      }
    } catch (_) {/* legacy/plain text */}
    if (exp != null && exp < DateTime.now().millisecondsSinceEpoch ~/ 1000) return;
    // Safety net: a control envelope (del/gdel/receipt/…) must NEVER render as a raw
    // `{"t":...}` bubble. Explicit handlers above already returned for handled ones;
    // this stops any unhandled/older-format control from leaking into the chat.
    if (_isControlEnvelope(m.payload)) {
      Analytics.capture('chat_control_filtered', {'where': 'dm_live'});
      return;
    }
    // [CHAT-RAWENV-1] Backstop: if we got all the way here with `text` still
    // byte-identical to the wire payload AND that payload is one of our
    // envelopes, then no branch above understood it and we are one line away
    // from drawing raw JSON at the user. Drop the frame — a missing bubble is a
    // bug we can chase; a bubble full of ciphertext keys is one the user has to
    // look at, and (via _persistNow) keeps looking at forever.
    //
    // This path was previously SILENT — the outer `catch (_)` swallowed every
    // cause with no log and no event, which is why pic 4 had to be reported by
    // hand from a screenshot instead of showing up in telemetry. Tag both ends
    // so either party's email retrieves it.
    if (text == m.payload && _isAppEnvelope(m.payload)) {
      String? envT;
      try { envT = (jsonDecode(m.payload) as Map)['t']?.toString(); } catch (_) {}
      Analytics.capture('chat_raw_envelope_dropped', {
        'where': seed ? 'dm_seed' : 'dm_live',
        'envelope_t': envT ?? 'unparsed',
        'mine': m.mine,
        'peer': widget.chat.name,
        'bytes': m.payload.length,
      });
      AvaLog.I.log('media', 'dropped unrenderable envelope t=$envT mine=${m.mine}');
      return;
    }
    // A peer deleted this for everyone (recorded durably) — render the tombstone,
    // never the original body, even though the cached/replayed envelope still has it.
    if (_deletedIds.contains(m.rumorId)) {
      text = 'This message was deleted'; media = null; special = null; extra = null; replyMeta = null;
    }
    _mutMsgs(() {
      // Durable Ava answer landed — drop any live streaming preview for this turn.
      if (special == 'ava' || special == 'ava_private') _clearAvaStreamPreview(extra);
      _msgs.add(_Msg(_seq++, m.mine, text, _fmtTime(m.createdAt),
          ts: m.createdAt, evId: m.rumorId, media: media, replyTo: replyMeta,
          forwarded: forwarded, expireAt: exp, special: special, extra: extra,
          sent: m.mine, // my own messages reaching here are already on the relay
          starred: _starred.contains(m.rumorId), hidden: _hiddenIds[m.rumorId] == true));
      _noteGuardianFlag(special, extra);
      // G3: an inline fast-lane safety verdict paints THIS bubble red immediately,
      // exactly like a live safety_flag frame (keyed by the message's rumor id).
      if (inlineSafetyCat != null && !_safetyFlaggedIds.containsKey(m.rumorId)) {
        _safetyFlaggedIds[m.rumorId] = inlineSafetyCat!;
      }
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    // Persist the inline flag so the red bubble survives reopen (mirrors how the
    // deep-lane safety_flag frame is persisted). Best-effort.
    if (inlineSafetyCat != null) {
      unawaited(_safetyStore.put(m.rumorId,
          conv: _serverConvId ?? _convKey ?? '', category: inlineSafetyCat!));
    }
    // Full-thread RAG: index a peer's LIVE text into my own store (not seeded
    // history, not media/special envelopes).
    if (!m.mine && !seed && special == null && media == null) {
      _ragAddLine(widget.chat.name, text);
    }
    _jump();
    if (!m.mine && !seed) {
      // Live (just-arrived) message I'm looking at → tell the sender it's read,
      // both the live (presence) way and the durable (gift-wrapped) way.
      _presence?.sendRead(DateTime.now().millisecondsSinceEpoch ~/ 1000);
      _dm?.sendReceipt('read', m.createdAt);
    }
    _markRead();
    _schedulePersist();
  }

  /// Apply a peer's delivery/read receipt for MY messages: advance the in-memory
  /// high-water marks (drives the ticks live) and persist them so the status is
  /// still correct after the thread/app is reopened. A 'read' implies delivered.
  void _applyReceipt(bool mine, Map env) {
    if (mine) return; // my own copy (shouldn't occur — receipts use wrapTo)
    final rts = (env['ts'] as num?)?.toInt() ?? 0;
    if (rts <= 0 || !mounted) return;
    final read = (env['status'] ?? '').toString() == 'read';
    setState(() {
      if (read && rts > _peerReadTs) _peerReadTs = rts;
      if (rts > _peerDeliveredTs) _peerDeliveredTs = rts;
    });
    if (_convKey != null) {
      ReceiptStore().bump(_convKey!, delivered: read ? 0 : rts, read: read ? rts : 0);
    }
  }

  void _applyEdit(String target, String body) {
    final i = _msgs.indexWhere((x) => x.evId == target);
    if (i >= 0 && mounted) { _mutMsgs(() { _msgs[i].text = body; _msgs[i].edited = true; }); _schedulePersist(); }
  }

  /// [AVAGRP-BUBBLE-2] Apply an incoming per-message group receipt
  /// (`{"t":"msg_receipt","mid":...,"uid":...,"status":"read"|"delivered","ts":...}`,
  /// `sync_hub.dart` `_ingestMsgReceipt`) onto the matching `_Msg`, keyed by its
  /// canonical mid (`_Msg.evId` — the same id `_onGroupMsg` already stamps from
  /// `GroupMessage.rumorId`, and the same one reactions key off). A message not
  /// currently rendered (scrolled out, not yet replayed) is a no-op — the next
  /// `GET /api/msg/seen` hydrate on open will backfill it once it IS rendered.
  /// A 'read' receipt also counts as 'delivered' (you can't read what didn't
  /// arrive) so `_statusFor`'s delivered-vs-read gates never desync.
  void _applyMsgReceipt(Map<String, dynamic> env) {
    final mid = (env['mid'] ?? '').toString();
    final uid = (env['uid'] ?? '').toString();
    final status = (env['status'] ?? '').toString();
    final ts = (env['ts'] as num?)?.toInt() ?? 0;
    if (mid.isEmpty || uid.isEmpty || (status != 'read' && status != 'delivered')) return;
    final i = _msgs.indexWhere((x) => x.evId == mid);
    if (i < 0 || !mounted) return;
    _mutMsgs(() {
      if (status == 'read') {
        _msgs[i].readBy[uid] = ts;
        _msgs[i].deliveredTo.putIfAbsent(uid, () => ts);
      } else {
        _msgs[i].deliveredTo[uid] = ts;
      }
    });
    _schedulePersist();
    // Two-sided telemetry (CLAUDE.md): fires on the ORIGINAL SENDER's device —
    // auto-stamped with the sender's own email; `reader_pub` identifies the
    // OTHER party so this event joins with that reader's own
    // `chat_group_receipt_sent` event via `mid`.
    Analytics.capture('chat_group_receipt_received', {
      'status': status, 'mid': mid, 'reader_pub': _shortPub(uid), 'gid': widget.chat.gid ?? '',
    });
  }

  // ---- local message persistence ----
  // The relay doesn't re-deliver your OWN sent DMs on resubscribe, so cache the
  // thread locally and reload it on open. (Media messages aren't cached.)
  Future<void> _loadCachedMessages() async {
    final key = _convKey;
    if (key == null) return;
    // F3 (restoreV2): restore any previously-paged deep-archive rows for THIS
    // conversation + the pager cursor, so older history reappears instantly on
    // reopen without a second /api/archive/page round-trip. Independent of the
    // hot cache below (which may be empty on a fresh device).
    unawaited(_restoreArchiveCache());
    // [MSG-OUTBOX-1] Load the durable outbox first so isPending() below is accurate
    // when we restore not-yet-ACKed bubbles (sending… vs not-sent affordance).
    await Outbox.I.ensureLoaded();
    final cached = await _msgStore.load(key);
    if (cached.isEmpty || !mounted) return;
    final loaded = <_Msg>[];
    for (final j in cached) {
      final ev = j['evId'] as String?;
      if (ev != null) {
        if (_seenEv.contains(ev)) continue;
        _seenEv.add(ev);
      }
      // Drop any control envelope an older build wrongly cached as a text bubble
      // (e.g. a leaked `{"t":"del",...}`), so it never reappears on reopen.
      if (_isControlEnvelope((j['text'] ?? '').toString())) {
        Analytics.capture('chat_control_filtered', {'where': 'cache'});
        continue;
      }
      // [CHAT-RAWENV-1] Purge a bubble a previous build cached as raw envelope
      // JSON (pic 4). This is the half of the fix that actually reaches the
      // people already affected: `_persistNow` wrote the raw payload into
      // `text` with no `media` key, and this loader restores `text` verbatim
      // and NEVER re-parses it — so without this the JSON bubble would survive
      // the fix and sit in their thread forever. Same precedent, and the same
      // reasoning, as the control-envelope purge directly above.
      if (j['media'] == null && _isAppEnvelope((j['text'] ?? '').toString())) {
        Analytics.capture('chat_raw_envelope_dropped', {'where': 'cache'});
        continue;
      }
      final ts = (j['ts'] as num?)?.toInt() ?? 0;
      // Media messages ARE cached now (the envelope/refs — never the bytes; the
      // decrypted bytes live in MediaService's on-disk cache). So on reopen the
      // image/voice bubble reappears instantly and loads local-first, instead of
      // waiting on a full relay re-sync + re-download.
      ChatMedia? media;
      final mj = j['media'];
      if (mj is Map) { try { media = ChatMedia.fromEnvelope(mj.cast<String, dynamic>()); } catch (_) {} }
      final msg = _Msg(
        _seq++, j['me'] == true, (j['text'] ?? '').toString(),
        _fmtTime(ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : ts),
        ts: ts, evId: ev, media: media,
        sent: j['me'] == true, // my persisted history was already accepted by the relay
        special: j['special'] as String?,
        extra: (j['extra'] as Map?)?.cast<String, dynamic>(),
        replyTo: (j['replyTo'] as Map?)?.cast<String, dynamic>(),
        edited: j['edited'] == true,
        forwarded: j['forwarded'] == true,
        expireAt: (j['expireAt'] as num?)?.toInt(),
        senderLabel: j['senderLabel'] as String?,
        senderPub: j['senderPub'] as String?, // [AVAGRP-BUBBLE-1]
        reaction: j['reaction'] as String?,
        starred: j['starred'] == true,
        hidden: j['hidden'] == true || _hiddenIds[ev] == true,
        system: j['system'] == true, // [AVAGRP-BUBBLE-2]
        // [AVAGRP-BUBBLE-2 §6] Restore per-member receipts so the Info sheet /
        // group ticks survive an app restart instead of resetting to "no
        // receipts yet" every cold open. `(j['readBy'] as Map?)` is JSON-decoded
        // as `Map<String, dynamic>` — cast each value back to int explicitly
        // rather than a blind `.cast<String, int>()`, which throws on a `num`
        // that decoded as double.
        readBy: (j['readBy'] as Map?)?.map((k, v) => MapEntry(k.toString(), (v as num).toInt())),
        deliveredTo: (j['deliveredTo'] as Map?)?.map((k, v) => MapEntry(k.toString(), (v as num).toInt())),
      );
      // [MSG-OUTBOX-1] Restore a NOT-yet-ACKed send with the right affordance so it
      // never silently vanishes (the original bug). If its clientId (=evId) is STILL
      // queued in the durable outbox, it's genuinely in flight → show "sending…"
      // and let the outbox status flip it to sent/failed. If it's no longer queued
      // (gave up, or a media upload that can't auto-resume), show the failed
      // "not sent · tap to retry" affordance so the user can re-send manually.
      if (j['pending'] == true && msg.me) {
        final stillQueued = ev != null && Outbox.I.isPending(ev);
        final mediaPending = j['mediaPending'] == true;
        final gaveUp = j['gaveUp'] == true;
        if (stillQueued && !mediaPending) {
          msg.sent = false; msg.failed = false; // "sending…" — outbox is retrying
        } else if (_isGroup && !mediaPending && !gaveUp) {
          // [AVA-GRP-SENDSTATE] Self-heal the owner's bug. Old builds had NO
          // outbox-ACK listener for groups, so EVERY own group message was
          // persisted `pending` even after the outbox delivered it (the entry
          // cleared on echo, so `isPending` is false now). Those builds also never
          // recorded a genuine give-up (`gaveUp`), so a non-queued, non-media,
          // non-give-up group pending bubble is a DELIVERED message mis-persisted
          // as pending — restore it as "sent", never the false "not sent · tap to
          // retry" the owner saw on messages his group had already replied to. A
          // real terminal failure carries `gaveUp:true` (written since this fix)
          // and falls through to the failed branch below.
          msg.sent = true; msg.failed = false;
          _grpSendStateHealed++;
        } else {
          msg.sent = false; msg.failed = true;   // "not sent · tap to retry"
        }
      }
      // A peer hard-deleted this for everyone (durable tombstone) — collapse the
      // stale cached body/media to the deleted pill before showing it.
      if (ev != null && _deletedIds.contains(ev)) _tombstone(msg);
      loaded.add(msg);
    }
    if (loaded.isEmpty || !mounted) return;
    _mutMsgs(() {
      _msgs.addAll(loaded);
      _msgs.sort((a, b) => a.ts.compareTo(b.ts));
    });
    _jump();
    // If any cached poll bubbles were restored, pull their server tallies so a
    // reinstalled device shows real counts + my selection (survives reinstall).
    if (loaded.any((m) => m.special == 'poll')) unawaited(_hydratePolls());
    // [AVA-GRP-SENDSTATE] Report + re-persist the one-time heal so the corrected
    // "sent" state sticks (this reopen won't re-heal them) and the fleet-wide
    // blast radius of the old false-failure bug is measurable. Email auto-attached
    // by Analytics._base.
    if (_grpSendStateHealed > 0) {
      Analytics.capture('grp_sendstate_healed', {
        'count': _grpSendStateHealed,
        'gid': widget.chat.gid ?? '',
        'conv_kind': 'group',
      });
      _schedulePersist();
    }
  }

  void _schedulePersist() {
    _persistTimer?.cancel();
    _persistTimer = Timer(const Duration(milliseconds: 400), _persistNow);
  }

  Future<void> _persistNow() async {
    final key = _convKey;
    if (key == null) return;
    final out = <Map<String, dynamic>>[];
    for (final m in _msgs) {
      if (m.text.contains('"t":"receipt"')) continue; // never cache a stray receipt
      // [MSG-OUTBOX-1] PERSIST failed / still-sending messages instead of dropping
      // them. The old `if (m.uploading || m.failed) continue;` is exactly why a DM
      // that failed to POST silently vanished from the sender's own thread on
      // reopen (the warm cache excluded it). We now cache them WITH their state:
      //   • text that isn't ACKed yet (failed, or my bubble not `sent`) → the
      //     durable outbox is still retrying it, so restore it as pending and let
      //     the outbox status update the bubble; a tap re-enqueues.
      //   • uploading/failed MEDIA → restore as a failed placeholder so it doesn't
      //     disappear. NOTE: the raw bytes live only in memory (never cached), so a
      //     media upload interrupted by a restart cannot auto-resume — the user
      //     re-sends via the failed-bubble tap. Text sends DO auto-resume via the
      //     outbox. (Media-upload resume is out of scope here — see report.)
      final notAcked = m.me && !m.hidden && (m.failed || m.uploading || (!m.sent && m.evId != null));
      out.add({
        'me': m.me, 'text': m.text, 'ts': m.ts,
        if (m.evId != null) 'evId': m.evId,
        if (m.media != null) 'media': m.media!.toEnvelope(), // refs only — bytes are in MediaService's disk cache
        if (m.special != null) 'special': m.special,
        if (m.extra != null) 'extra': m.extra,
        if (m.replyTo != null) 'replyTo': m.replyTo,
        if (m.edited) 'edited': true,
        if (m.forwarded) 'forwarded': true,
        if (m.expireAt != null) 'expireAt': m.expireAt,
        if (m.senderLabel != null) 'senderLabel': m.senderLabel,
        if (m.senderPub != null) 'senderPub': m.senderPub, // [AVAGRP-BUBBLE-1]
        if (m.reaction != null) 'reaction': m.reaction,
        if (m.starred) 'starred': true,
        if (m.hidden) 'hidden': true, // soft-delete survives reopen; data retained for Undo
        if (m.system) 'system': true, // [AVAGRP-BUBBLE-2]
        // [AVAGRP-BUBBLE-2 §6] Per-member receipts — see the `fromJson` restore
        // side for why these survive an app restart now instead of resetting.
        if (m.readBy.isNotEmpty) 'readBy': m.readBy,
        if (m.deliveredTo.isNotEmpty) 'deliveredTo': m.deliveredTo,
        // Restore hint: this bubble was NOT yet confirmed on the server. `mediaPending`
        // distinguishes a stuck media upload (no auto-resume) from a text send the
        // outbox will keep retrying.
        if (notAcked) 'pending': true,
        if (notAcked && (m.uploading || m.media != null)) 'mediaPending': true,
        // [AVA-GRP-SENDSTATE] Record a TERMINAL give-up so it restores as a real
        // "not sent" — the only case a group pending bubble should reopen failed.
        if (m.sendGaveUp) 'gaveUp': true,
      });
    }
    await _msgStore.save(key, out);
    // Keep the chat-list preview + ordering in sync with the latest line here,
    // for both messages I sent and ones I received while this thread was open.
    if (_msgs.isNotEmpty) {
      final last = _msgs.reduce((a, b) => b.ts >= a.ts ? b : a);
      final preview = last.hidden
          ? 'You deleted this message' // never leak hidden content into the list
          : (last.text.isNotEmpty
              ? last.text
              : (last.media != null ? _caption(last.media!.kind, last.media!.name) : ''));
      final ts = last.ts == 0 ? DateTime.now().millisecondsSinceEpoch ~/ 1000 : last.ts;
      // [CHAT-RAWENV-1] Never let an envelope become the chat-list preview line —
      // the raw-JSON bubble in pic 4 poisoned the list row too, so the user met
      // it twice.
      if (preview.isNotEmpty && !_isAppEnvelope(preview)) {
        await ChatPreviewStore().record(key, preview, ts, last.me);
      }
    }
  }

  // ── F3: deep-archive scroll pager (restoreV2) ───────────────────────────────
  // When the user scrolls PAST the local hot window, page older messages in from
  // /api/archive/page (batched per-user R2 jsonl), render them above with a subtle
  // "older messages" divider, and CACHE each fetched page per-conversation so a
  // page is fetched at most once — ever, across restarts. All dark unless
  // RemoteConfig.restoreV2 is on (no behaviour change when false).

  /// Feed one archive server row ({id,conv,sender,kind,body,media_ref,client_id,
  /// created_at}) into the thread as seeded history. Dedup + envelope parsing are
  /// handled by the normal _onDm/_onGroupMsg path (via _seenEv), so a row already
  /// in the hot window never double-renders.
  void _ingestArchiveRow(Map<String, dynamic> r) {
    final myUid = _meId?.uid ?? _myNpub ?? '';
    final id = (r['id'] as num?)?.toInt() ?? 0;
    final clientId = (r['client_id'] ?? '').toString();
    final rumorId = clientId.isNotEmpty ? clientId : 'srv_$id';
    final sender = (r['sender'] ?? '').toString();
    final mine = myUid.isNotEmpty && sender == myUid;
    final body = (r['body'] ?? '').toString();
    final createdMs = (r['created_at'] as num?)?.toInt() ??
        DateTime.now().millisecondsSinceEpoch;
    final createdSec = createdMs > 2000000000 ? createdMs ~/ 1000 : createdMs; // ms→s
    if (_isGroup) {
      _onGroupMsg(GroupMessage(
          rumorId: rumorId, senderPub: mine ? '' : sender, mine: mine,
          payload: body, createdAt: createdSec));
    } else {
      _onDm(DmMessage(rumorId: rumorId, mine: mine, payload: body, createdAt: createdSec),
          seed: true);
    }
  }

  /// Restore previously-paged archive rows + the pager cursor from the per-account
  /// cache. Silent + safe when restoreV2 is off (we still restore what was already
  /// cached so history the user already saw doesn't vanish, but never fetch).
  Future<void> _restoreArchiveCache() async {
    final key = _convKey;
    if (key == null) return;
    final cur = await _archiveStore.load(key);
    if (!mounted) return;
    final rows = (cur['rows'] as List).cast<Map<String, dynamic>>();
    if (rows.isNotEmpty) {
      for (final r in rows) _ingestArchiveRow(r);
      setState(() => _hasArchived = true);
    }
    _archiveCursor = cur['cursor'] as int?;
    _archiveDone = cur['done'] == true;
  }

  /// Scroll listener: when the viewport nears the TOP of the loaded thread (older
  /// end), pull the next archive page. Guarded by restoreV2 + one-in-flight.
  void _maybePageArchive() {
    // [CHAT-UI-LIST-1e] Cheap piggyback on this existing scroll listener: if
    // the reader has manually scrolled back within ~120px of the newest
    // message, the unseen badge no longer reflects reality — clear it here
    // too (not just on a force:true jump / FAB tap) so scrolling down by
    // hand also dismisses the badge, WhatsApp-style.
    // [CHAT-UI-REVERSE-1] "near the newest message" is now "near offset 0"
    // (see `_jump`).
    if (_unseenCount != 0 && _scroll.hasClients) {
      final pos = _scroll.position;
      if (pos.pixels <= 120 && mounted) {
        setState(() => _unseenCount = 0);
      }
    }
    if (!RemoteConfig.restoreV2 || _archiveDone || _archiveLoading) return;
    if (!_scroll.hasClients) return;
    // [CHAT-UI-REVERSE-1] The oldest loaded message used to sit at the TOP of
    // a non-reversed list (near scroll offset 0 / `extentBefore`). With
    // reverse:true it sits at the FAR end of the scroll range instead — near
    // `maxScrollExtent`, i.e. `extentAfter` near 0 — so the "load older when
    // close to the oldest loaded edge" trigger now watches `extentAfter`.
    if (_scroll.position.extentAfter <= 240) {
      unawaited(_fetchArchivePage());
    }
  }

  Future<void> _fetchArchivePage() async {
    if (!RemoteConfig.restoreV2 || _archiveDone || _archiveLoading) return;
    final key = _convKey;
    final myUid = _meId?.uid ?? _myNpub ?? '';
    if (key == null || myUid.isEmpty) return;
    final serverConv = serverConvFromKey(key, myUid);
    if (serverConv == null) return;
    setState(() => _archiveLoading = true);
    // [CHAT-UI-REVERSE-1] The old beforeMax/beforePix + post-frame jumpTo
    // dance ("preserve the scroll position across the prepend so the view
    // doesn't jump") is DELETED. It existed because a non-reversed ListView
    // PREPENDS older messages at index 0 (the TOP), which physically shifts
    // every already-rendered row down and yanks the viewport unless the
    // offset is manually corrected. With reverse:true, older archive rows are
    // appended to `_msgs` and land at the FAR end of the index range (see the
    // `vi`/`msgSlot` mapping in the itemBuilder) — i.e. the far/oldest visual
    // edge, away from the current viewport. Extending a sliver list at the
    // far end never moves the pixels already on screen, so there is nothing
    // to restore.
    try {
      final before = _archiveCursor; // null ⇒ start from newest segment
      final uri = '$kArchivePageUrl?conv=$serverConv&limit=30'
          '${before != null ? '&before=$before' : ''}';
      final res = await ApiAuth.getSigned(uri);
      if (!mounted) { _archiveLoading = false; return; }
      if (res.statusCode != 200) {
        Analytics.capture('archive_page_failed', {'status': res.statusCode});
        setState(() => _archiveLoading = false);
        return;
      }
      final body = jsonDecode(res.body);
      final rows = (body is Map ? (body['messages'] as List? ?? const []) : const [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      final nextBefore = (body is Map ? body['next_before'] : null) as num?;
      // Cache the page (dedup at most-once is via the cursor: a fetched `before`
      // is never re-requested — nextBefore always strictly decreases).
      await _archiveStore.appendPage(
        key,
        newRows: rows,
        nextBefore: nextBefore?.toInt(),
        done: nextBefore == null,
      );
      if (!mounted) { _archiveLoading = false; return; }
      for (final r in rows) _ingestArchiveRow(r);
      setState(() {
        _archiveCursor = nextBefore?.toInt();
        _archiveDone = nextBefore == null;
        if (rows.isNotEmpty) _hasArchived = true;
        _archiveLoading = false;
      });
      Analytics.capture('archive_page_loaded', {'rows': rows.length, 'done': _archiveDone});
    } catch (e) {
      if (mounted) setState(() => _archiveLoading = false);
      Analytics.capture('archive_page_error', {'error': e.toString()});
    }
  }

  // [AVAGRP-BUBBLE-2] Wallpaper-aware system/day-pill colours.
  //
  // REASONING (owner asked for a white DEFAULT canvas, 2026-07-17; see the
  // SANITY CHECK left in `wallpaper.dart`): `kChatSysPillBg`/`kChatCanvasMeta`
  // ([AVAGRP-BUBBLE-1]) are tuned for `kChatCanvas` (white) and read fine there
  // — but 5 SELECTABLE presets (teal/sunset/forest/lavender/sky) stay near-black
  // tints, and a near-white opaque pill floating on one of those is exactly the
  // "hole punched in the page" class of bug this pass is fixing elsewhere (see
  // `_hiddenBubble`), just inverted. Deriving from the ACTIVE wallpaper (rather
  // than hardcoding one pair) fixes both cases with one bubble/pill system
  // instead of a parallel dark theme. This is a minimal contrast fix, not a
  // vote to keep the presets — if the owner later retires them, delete
  // `wallpaperIsDark`/`kDarkWallpaperIds` (`wallpaper.dart`) and these getters
  // collapse back to the single pale-on-white pair.
  // [AVA-GRP-UI] Owner reversed the 2026-07-17 white-canvas decision (his
  // screenshot showed a white thread background he did not want): the 'default'
  // thread canvas is DARK/near-black again. `wallpaper.dart`/`bubble_theme.dart`
  // are owned elsewhere and left untouched, so the reversal lives here in the UI
  // layer — 'default' now counts as a dark wallpaper for every system/day-pill
  // and canvas-ink getter above, exactly like the 5 selectable dark presets, so
  // pills and separators invert to their dark-readable variants automatically.
  bool get _wallpaperDark => _wallpaperId == 'default' || wallpaperIsDark(_wallpaperId);

  /// [AVA-GRP-UI] The thread canvas gradient. 'default' resolves to near-black
  /// (`AD.bg`) rather than the white `kChatCanvas` that `wallpaperGradient`
  /// would return — the owner wants a dark background with the pale bubbles +
  /// hairline borders sitting on top (they read fine on dark; see
  /// `bubble_theme.dart`). The 5 selectable presets keep their own tints.
  LinearGradient _gradientFor(String id) => id == 'default'
      ? const LinearGradient(
          colors: [AD.bg, AD.bg],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter)
      : wallpaperGradient(id);
  LinearGradient get _threadGradient => _gradientFor(_wallpaperId);
  Color get _sysPillBg => _wallpaperDark ? const Color(0xB3202024) : kChatSysPillBg;
  Color get _sysPillBorder => _wallpaperDark ? Colors.white.withValues(alpha: 0.14) : kChatCanvasMeta.withValues(alpha: 0.35);
  // Day-separator / older-messages caption tone (grey on light, pale-white on dark).
  Color get _sysPillMeta => _wallpaperDark ? Colors.white.withValues(alpha: 0.82) : kChatCanvasMeta;
  // The group-photo-change / "X created the group" announcement ink. Owner
  // instruction (2026-07-17): "Use small fonts in black" — literal black is
  // the light-canvas case; a dark wallpaper needs the inverse (white) or the
  // text is unreadable, which the instruction didn't anticipate (it predates
  // the dark-preset sanity check).
  Color get _sysAnnounceInk => _wallpaperDark ? Colors.white : Colors.black;
  // Text painted DIRECTLY on the canvas (no pill behind it) — day separators
  // already had their own pill so they're covered by `_sysPillMeta` above; this
  // pair is for canvas-level chrome like the in-thread search empty state.
  Color get _canvasInk => _wallpaperDark ? AD.textPrimary : kChatCanvasInk;
  Color get _canvasMeta => _wallpaperDark ? AD.textSecondary : kChatCanvasMeta;
  Color get _canvasTertiary => _wallpaperDark ? AD.textTertiary : kChatCanvasMeta.withValues(alpha: 0.7);

  // A subtle divider rendered above the oldest loaded messages once we've paged
  // (or are paging) deep archive, so the user understands they're now looking at
  // history pulled from the cloud backup.
  // [AVAGRP-BUBBLE-1] `AD.textPrimary`/`AD.textSecondary` are white/near-white —
  // tuned for the OLD dark thread canvas. On the new white `kChatCanvas` a
  // white-at-18%-alpha divider and white-60% caption are both close to
  // invisible. Use the pale-on-white pair from `bubble_theme.dart` instead.
  // [AVAGRP-BUBBLE-2] Now wallpaper-aware (`_sysPillMeta`) rather than
  // hardcoded to the pale-on-white pair — see the reasoning above.
  Widget _olderMessagesDivider() => Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 10),
        child: Row(children: [
          Expanded(child: Divider(color: _sysPillMeta.withValues(alpha: 0.35), thickness: 1)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: _archiveLoading
                ? Row(mainAxisSize: MainAxisSize.min, children: [
                    SizedBox(width: 12, height: 12,
                        child: CircularProgressIndicator(strokeWidth: 1.6, color: _sysPillMeta)),
                    const SizedBox(width: 7),
                    Text('Loading older messages…', style: ADText.statCaption(c: _sysPillMeta)),
                  ])
                : Text(_archiveDone ? 'Start of conversation' : 'Older messages',
                    style: ADText.statCaption(c: _sysPillMeta)),
          ),
          Expanded(child: Divider(color: _sysPillMeta.withValues(alpha: 0.35), thickness: 1)),
        ]),
      );

  String _fmtTime(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  // [CHAT-TS-ABS-1] (owner report 2026-07-16, pic 2): message bubbles now ALWAYS
  // carry the wall-clock HH:MM they were sent at.
  //
  // This used to return a relative age ("now" / "2m" / "4h") for anything under
  // 6 hours old, which is why a thread of voice notes and tombstones read as a
  // column of "4h" with no timestamp anywhere. Relative ages are fine on a chat
  // LIST (one row, "when did this thread last move"), but inside a thread the
  // question is "what time was this said", and only a clock answers that — every
  // other messenger (see WhatsApp, pic 5) shows the clock. The day a message
  // belongs to is carried by the day separator chip, so HH:MM is unambiguous.
  String _relTime(int epochSecs) {
    if (epochSecs <= 0) return '';
    return _fmtTime(epochSecs);
  }

  // A day-separator label: Today / Yesterday / weekday (this week) / d Mon.
  String _dayLabel(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    final now = DateTime.now();
    final day = DateTime(d.year, d.month, d.day);
    final today = DateTime(now.year, now.month, now.day);
    final delta = today.difference(day).inDays;
    if (delta == 0) return 'Today';
    if (delta == 1) return 'Yesterday';
    const wk = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (delta < 7) return wk[d.weekday - 1];
    final y = d.year == now.year ? '' : ' ${d.year}';
    return '${d.day} ${mo[d.month - 1]}$y';
  }

  bool _sameDay(int a, int b) {
    if (a == 0 && b == 0) return true; // both demo/unknown ts → no separator
    // [CHAT-TS-ABS-1] Exactly one side has no timestamp (a legacy/demo bubble):
    // it can't be proven to share a day with a real one, so treat it as a day
    // boundary. Previously this returned true, which meant a single ts-less
    // message sitting between two days silently swallowed the day chip for the
    // whole run of messages after it.
    if (a == 0 || b == 0) return false;
    final da = DateTime.fromMillisecondsSinceEpoch(a * 1000);
    final db = DateTime.fromMillisecondsSinceEpoch(b * 1000);
    return da.year == db.year && da.month == db.month && da.day == db.day;
  }

  // A centered "Today / Yesterday / date" chip rendered between day groups.
  // [AVAGRP-BUBBLE-1] `AD.card` (near-black) + `AD.borderControl` were tuned
  // for the old dark canvas; on white they'd read as a hard black pill. Use
  // the pale system-pill pair (`kChatSysPillBg`/`kChatCanvasMeta`) instead.
  // [AVAGRP-BUBBLE-2] Now wallpaper-aware (`_sysPillBg`/`_sysPillBorder`/
  // `_sysPillMeta`) instead of hardcoded — see the reasoning above `_sysPillBg`.
  Widget _daySeparator(String label) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(
              color: _sysPillBg,
              borderRadius: Msg.brPill,
              border: Border.all(color: _sysPillBorder, width: 1.5),
              boxShadow: const [],
            ),
            child: Text(label,
                style: ADText.statCaption(c: _sysPillMeta)),
          ),
        ),
      );

  /// [AVAGRP-BUBBLE-2] Centered system-announcement pill for a group ("Humphrey
  /// Davy created the group", "X added Y", "X changed the group photo" —
  /// `GroupApi.announce()`, wire envelope `{"t":"gtext","system":true,...}`).
  /// Modelled on `_daySeparator` immediately above (same pale pill), but with:
  ///   * NO avatar, NO sender-name header, NO bubble tail, NO per-sender tint —
  ///     a system row belongs to no one.
  ///   * Literal small BLACK text on the default white canvas, per the owner's
  ///     explicit "Use small fonts in black" instruction (2026-07-17) — NOT
  ///     `_sysPillMeta`'s grey caption tone, which `_daySeparator`/
  ///     `_olderMessagesDivider` use instead. `_sysAnnounceInk` inverts to
  ///     white on a dark wallpaper preset so it stays readable there too (see
  ///     the wallpaper reasoning above).
  ///   * Full-sentence casing (not the day-pill's uppercase) — this is a
  ///     readable announcement, not a date-chip label.
  Widget _systemBubble(_Msg m) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: Container(
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
            decoration: BoxDecoration(
              color: _sysPillBg,
              borderRadius: Msg.brMd,
              border: Border.all(color: _sysPillBorder, width: 1),
              boxShadow: const [],
            ),
            child: Text(m.text,
                textAlign: TextAlign.center,
                style: ADText.statCaption(c: _sysAnnounceInk)),
          ),
        ),
      );

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

  /// Index one labelled line into the ON-DEVICE lane (when Local Ava AI is
  /// active). Skips empty lines and @ava control lines. Fire-and-forget.
  void _ragAddLine(String who, String text) {
    final t = text.trim();
    if (t.isEmpty || t.toLowerCase().contains(_avaWakeWord)) return;
    // On-device memory: ONLY when Local Ava AI is active (model loaded) so we
    // never trigger a model download just from chatting. Makes facts said in
    // this chat findable on-device/offline — including cross-surface in AvaChat.
    if (AvaLocalMode.I.isActive) {
      // Selective embedding: only substantive lines are kept on-device (skips
      // greetings/acks + respects the episodic cap). Facts, not chatter.
      // ignore: unawaited_futures
      AvaOnDeviceRag.I.rememberMessage(who, t, name: 'chat-${widget.chat.name}');
    }
  }

  /// Render on-device `@ava` answers (Local Ava AI) for THIS conversation as a
  /// normal Ava bubble. Additive — does not touch the server message pipeline.
  void _bindLocalAva() {
    _localAvaSub?.cancel();
    final key = _convKey;
    if (key == null) return;
    _localAvaSub = AvaLocalReplies.I.stream.listen((r) {
      if (!mounted || r.convKey != key) return;
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      _mutMsgs(() {
        // [AVA-IMAGE-UX-1] The on-device answer is here — drop the transient
        // "thinking" chip ONLY. Root cause (Part VI §37): this used to be a
        // blanket `removeWhere(special == 'ava_status')`, which could also
        // wipe an UNRELATED still-running image job's placeholder chip the
        // instant any text answer landed. `_isJobStatusChip` protects any
        // status row correlated to a job (by `job_id`, or the legacy
        // image-generation marker while `ava_image.ts` still posts one) —
        // durable job cards render as `special: 'ai_job'` now anyway (a
        // different value entirely), so this guard only matters for the
        // legacy chip during the migration window (§49).
        _msgs.removeWhere((m) => m.special == 'ava_status' && !_isJobStatusChip(m));
        _msgs.add(_Msg(_seq++, false, r.text, _fmtTime(now),
            ts: now, special: 'ava'));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    });
  }

  /// A GenUI card fired a `composio` action (Rename, Delete, Schedule a
  /// meeting…). Execute it via the server-validated route; if the server renders
  /// a refreshed surface from the result (e.g. the updated list / created event),
  /// drop it into the thread as a fresh Ava bubble so the chat reflects the new
  /// state. Returns the short answer for the renderer's snackbar.
  Future<String?> _onGenuiComposio(String tool, Map<String, dynamic> args, {String? gid}) async {
    final r = await AppsService.I.genuiAction(tool, args, gid: gid);
    if (!mounted) return r.answer;
    if (r.surface != null) {
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final body = r.ok ? '' : r.answer;
      _mutMsgs(() {
        _msgs.add(_Msg(_seq++, false, body, _fmtTime(now),
            ts: now, special: 'ava', extra: {'a2ui': r.surface, 'text': body}));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    }
    return r.answer;
  }

  /// Render LIVE server `@ava` answers for THIS conversation as they stream in
  /// (cloud agent). Each delta grows a single Ava bubble keyed by `stream_id`;
  /// when the durable answer lands ([_onDm]/[_onGroupMsg]) it removes this
  /// preview so there's no duplicate. Purely additive: if no stream arrives the
  /// answer still appears whole via the normal message path.
  void _bindAvaStream() {
    _avaStreamSub?.cancel();
    final key = _convKey;
    if (key == null) return;
    _avaStreamSub = SyncHub.I.avaStream.listen((m) {
      if (!mounted || m['convKey'] != key) return;
      final phase = (m['phase'] ?? '').toString();
      final sid = (m['stream_id'] ?? '').toString();
      if (sid.isEmpty) return;
      final delta = (m['delta'] ?? '').toString();
      final evId = 'stream_$sid';
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      _mutMsgs(() {
        final i = _msgs.indexWhere((x) => x.evId == evId);
        if (phase == 'end') return; // keep the preview; durable answer replaces it
        if (i >= 0) {
          if (phase == 'delta') _msgs[i].text = _msgs[i].text + delta;
          return;
        }
        // First frame for this turn (start, or a delta if start was missed):
        // drop the "working…" chip and open the growing bubble. [AVA-IMAGE-UX-1]
        // Same job-aware guard as `_bindLocalAva` above — see that call site's
        // note; this must never remove an unrelated job's status chip.
        _msgs.removeWhere((x) => x.special == 'ava_status' && !_isJobStatusChip(x));
        _msgs.add(_Msg(_seq++, false, delta, _fmtTime(now),
            ts: now, special: 'ava', evId: evId));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    });
  }

  /// [AVA-IMAGE-UX-1] True for an `ava_status` chip that belongs to a durable
  /// job rather than this turn's own plain "Ava is thinking…" pill (Part VI
  /// §37/§49 — the root cause: a global sweep of every `ava_status` row could
  /// erase a still-running image job's placeholder just because an unrelated
  /// text answer arrived). Two cases:
  ///   1. Forward-looking: any `ava_status` row explicitly correlated to a job
  ///      via `job_id` — a real job placeholder should never share this
  ///      client's turn-scoped "thinking" chip's fate.
  ///   2. The LEGACY image-generation chip `ava_image.ts` may still post via
  ///      `postChip()`/`endChip()` (no `job_id`) until every producer fully
  ///      migrates to `createAiMediaJob()` (§44/§49) — same heuristic
  ///      `_avaStatusChip` already uses to pick the ChatGPT-style image
  ///      placeholder rendering, reused here so the two never disagree about
  ///      what "is an image chip".
  /// Once every producer of `ava_status` speaks job_id (or, for images,
  /// migrates entirely to `special: 'ai_job'`), case 2 becomes dead code —
  /// safe to delete then per §49, not before.
  bool _isJobStatusChip(_Msg m) {
    if (m.special != 'ava_status') return false;
    if ((m.extra?['job_id'] ?? '').toString().isNotEmpty) return true;
    final source = (m.extra?['source'] ?? '').toString();
    final label = (m.extra?['label'] ?? '').toString().toLowerCase();
    return source == 'image' || label.contains('generating an image');
  }

  /// Remove any live streaming preview bubble(s) once the durable Ava answer
  /// arrives. Prefers exact correlation via the answer's `meta.stream_id`; falls
  /// back to clearing all `stream_` previews (turns are sequential).
  void _clearAvaStreamPreview(Map<String, dynamic>? extra) {
    final sid = (extra?['meta'] is Map) ? (extra!['meta'] as Map)['stream_id']?.toString() : null;
    if (sid != null && sid.isNotEmpty) {
      _msgs.removeWhere((x) => x.evId == 'stream_$sid');
    } else {
      _msgs.removeWhere((x) => (x.evId ?? '').startsWith('stream_'));
    }
  }

  /// Show a transient on-device "Ava is thinking…" chip. Scheduled after the
  /// current frame so it lands below the user's own @ava message; it collapses
  /// automatically once the answer bubble arrives (the 'ava_status' transient
  /// rule keeps only the most-recent chip) or when [_bindLocalAva] clears it.
  void _showLocalAvaThinking() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final nowS = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      _mutMsgs(() {
        _msgs.add(_Msg(_seq++, false, 'Ava is thinking…', _fmtTime(nowS),
            ts: nowS, special: 'ava_status'));
      });
      _jump();
    });
  }

  void _send() {
    final t = _ctrl.text.trim();
    if (t.isEmpty) return;
    // STREAM B: replying while a thread is pending is an IMPLICIT accept — fire the
    // accept (server restores receipts) and drop the gate before the send.
    if (_strangerGatePending && _serverConv != null) {
      _strangerGatePending = false;
      _threadAcceptState = 'accepted';
      StrangerGateApi.accept(_serverConv!);
      trackStrangerGate('stranger_gate_accept', {'conv': _serverConv!, 'implicit': true});
      // G1.2: an implicit accept (replying to a stranger) also auto-enables Guardian.
      _autoEnableGuardianOnAccept();
    }
    HapticFeedback.selectionClick(); // P9: subtle send confirmation
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final expire = _disappearSecs > 0 ? now + _disappearSecs : null;

    // ----- Ava routing (fresh sends only, never edits) -----
    // `@ava` (or Ava-mode) = a PRIVATE personal call: the question is NOT sent to
    // the peer (so it's instant — no "waiting to reach phone") and the reply comes
    // back privately. `#ava` = SHARED: falls through to a normal send so the peer
    // sees the question, and Ava replies in the thread for both.
    if (_editing == null && onSummonAva != null) {
      final lower = t.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      final privateAva = (atAva && !shared) || avaModePrivate;
      if (privateAva || shared) {
        // [WALLET-GET-STATE-1] 2026-07-25, owner decision (Root-Cause Report
        // §10/§12c): Ava-in-chat TEXT (@ava private / #ava shared) is FREE for
        // everyone — never metered, never paywalled. The premium gate that used
        // to sit here (and the `ava_chat_gate_blocked` toast/event it fired) is
        // removed; a client-side GET failure can no longer misread a premium
        // user as unentitled (Root-Cause Report §17), because there is nothing
        // left to gate. Attachments remain metered, but server-side
        // (worker/src/routes/ava_gemini.ts) — a 402 there is authoritative and
        // speaks for itself; this path never blocks on it.
        // Ava-mode plain text carries no marker → prefix so AvaInvoke parses it
        // as a private @ava call.
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $t' : t);
        if (privateAva) {
          _ragAddLine('You', t);
          _composerFocus.requestFocus();
          _mutMsgs(() {
            // aiLocal: rendered locally only, never sent → no delivery ticks.
            _msgs.add(_Msg(_seq++, true, t, _fmtTime(now), ts: now, aiLocal: true));
            _ctrl.clear(); _hasText = false; _replyTo = null;
          });
          _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
          if (_convKey != null) DraftStore().set(_convKey!, '');
          _schedulePersist();
          return;
        }
      }
    }

    // RAG memory: index this outgoing line into the user's own File Search store
    // (full-thread indexing — incoming lines are added in the receive handlers).
    _ragAddLine('You', t);
    // Tapping the send button steals focus from the field; grab it back so the
    // keyboard stays up and the user can keep typing without re-tapping the box.
    _composerFocus.requestFocus();

    // Editing an existing message?
    if (_editing != null && _editing!.evId != null) {
      final m = _editing!;
      final target = m.evId!;
      if (_isGroup && _gdm != null) {
        _gdm!.send(jsonEncode({'t': 'gedit', 'gid': _group!.id, 'target': target, 'body': t}));
      } else if (_realMode && _dm != null) {
        _dm!.send(jsonEncode({'t': 'edit', 'target': target, 'body': t}));
      }
      _mutMsgs(() { m.text = t; m.edited = true; _editing = null; _ctrl.clear(); _hasText = false; });
      _schedulePersist();
      return;
    }

    final replyMeta = _replyTo == null
        ? null
        : {
            'id': _replyTo!.evId ?? '',
            'preview': _replyTo!.text.length > 60 ? _replyTo!.text.substring(0, 60) : _replyTo!.text,
            'who': _replyTo!.me ? 'You' : (_replyTo!.senderLabel ?? widget.chat.name),
          };

    // STREAM C [PREVIEW-2]: compose-time link unfurl. The SENDER unfurls the
    // first URL and embeds the preview in the envelope (`preview:{...}`) so
    // recipients render the card from the envelope — zero recipient fetch. The
    // dispatch is delegated to _dispatchText so we can attach the preview once it
    // resolves (fast timeout; a link with no preview just sends without one).
    if (_isGroup && _gdm != null) {
      _dispatchText(
        t: t, now: now, replyMeta: replyMeta, expire: expire, isGroup: true);
      return;
    }
    if (_realMode && _dm != null) {
      _dispatchText(
        t: t, now: now, replyMeta: replyMeta, expire: expire, isGroup: false);
      return;
    }
    _mutMsgs(() {
      _msgs.add(_Msg(_seq++, true, t, 'now', replyTo: replyMeta));
      _ctrl.clear(); _hasText = false; _replyTo = null;
    });
    _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
    _schedulePersist();
  }

  /// STREAM C [PREVIEW-2]: send a text message, optionally embedding a
  /// compose-time link preview in the envelope. The optimistic bubble appears
  /// instantly (mirrors media sends); the actual wire dispatch waits for a fast
  /// unfurl ONLY when the text contains a URL and previews are enabled — so
  /// recipients render the card straight from `preview:{...}` (zero fetch). A URL
  /// that unfurls to nothing (or times out) simply sends without a preview.
  Future<void> _dispatchText({
    required String t,
    required int now,
    required Map<String, dynamic>? replyMeta,
    required int? expire,
    required bool isGroup,
  }) async {
    // WhatsApp parity: the composer already unfurled this URL while the user was
    // typing, so grab that result and send with ZERO extra latency. Snapshot the
    // compose state before we clear it below.
    final url = RemoteConfig.linkPreviewsEnabled ? _firstUrl(t) : null;
    final composeHit =
        (url != null && url == _composePreviewUrl) ? _composePreview : null;
    final composeDismissed = url != null && _composePreviewDismissed.contains(url);

    // Optimistic local bubble first — instant feel, independent of the unfurl.
    // [CSAM-GATE-1 2026-07-11] MUST NOT be `sent: true`. This bubble is created
    // BEFORE the outbox has even attempted the POST — sending true here made every
    // message show a "SENT ✓" tick immediately, including one the server later
    // 403s as identity_required (a first message to a stranger from an unverified
    // account). `_Msg`'s own default is `sent: false` ("Sending…") for exactly this
    // reason; only `_onSendStatus()` — driven by the outbox's real HTTP 200 ACK —
    // may flip this to true. Do not reintroduce an optimistic `sent: true` here.
    final tShownStart = DateTime.now().millisecondsSinceEpoch;
    final localMsg = _Msg(_seq++, true, t, _fmtTime(now),
        ts: now, replyTo: replyMeta, expireAt: expire,
        extra: composeHit == null ? null : {'preview': composeHit})
      ..sendStartedMs = tShownStart; // [AVA-CHAT-INSTANT] round-trip anchor
    _mutMsgs(() {
      _msgs.add(localMsg);
      _ctrl.clear();
      _hasText = false;
      _replyTo = null;
    });
    // [AVA-CHAT-INSTANT] Perceived-latency telemetry: how long until the bubble
    // was on screen (email auto-attached by Analytics._base).
    Analytics.capture('msg_optimistic_shown', {
      'kind': 'text', 'conv_kind': isGroup ? 'group' : 'dm',
      'ms_to_bubble': DateTime.now().millisecondsSinceEpoch - tShownStart,
    });
    _clearComposePreview();
    _composePreviewDismissed.clear();
    _jump(force: true); // [CHAT-UI-LIST-1e] own send — always jump
    if (_convKey != null) DraftStore().set(_convKey!, '');

    // [MEDIA-INSTANT-1e / F5] The recipient's delivery must NEVER wait on a
    // network unfurl fetch (up to the 6s timeout in [_unfurl]) — a preview is
    // presentation metadata, not a delivery prerequisite. Only a preview
    // already resolved at COMPOSE time (while the user was typing) rides in
    // the envelope; everything else sends with no preview now and is patched
    // into the SENDER's own bubble asynchronously below, if/when it resolves.
    // Documented limitation (no cross-device `message_patch` protocol here):
    // a recipient only ever sees a card when the compose-time cache already
    // had one — a preview that resolves AFTER dispatch is visible to the
    // sender only. Building a durable patch broadcast is out of scope for this
    // change; see F5 in the messenger audit.
    final Map<String, dynamic>? preview = (composeHit != null && !composeDismissed) ? composeHit : null;

    final env = <String, dynamic>{
      't': isGroup ? 'gtext' : 'text',
      if (isGroup) 'gid': _group!.id,
      if (isGroup) 'fromName': _fromNameTag,
      'body': t,
      if (replyMeta != null) 'replyTo': replyMeta,
      if (expire != null) 'exp': expire,
      if (preview != null) 'preview': preview,
    };
    final id = isGroup ? _gdm!.send(jsonEncode(env)) : _dm!.send(jsonEncode(env));
    _seenEv.add(id);
    localMsg.evId = id;

    if (isGroup) {
      Analytics.capture('group_message_sent', {
        'gid': _group!.id, 'member_count': _group!.members.length, 'kind': 'text',
        'has_reply': replyMeta != null, 'expiring': expire != null,
        'has_preview': preview != null,
      });
      // [PUSH-FG-BANNER-1] Group conv keys are symmetric ('g:<gid>' — line 804),
      // so my key is also every member's key.
      PushService.notifyMessage(_memberUids, _myName ?? 'AvaTOK',
          preview: t, conv: 'g:${_group!.id}');
    } else if (_peerNpub != null) {
      // [PUSH-FG-BANNER-1] DM conv keys are device-RELATIVE ('1:<the other
      // person>' — line 644). My key for this thread is '1:$_peerNpub', but the
      // recipient's key for it is '1:<MY uid>'. Send theirs, not mine.
      final meUid = _meId?.uid ?? '';
      PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK',
          preview: t, conv: meUid.isNotEmpty ? '1:$meUid' : null);
    }
    _schedulePersist();

    // [MEDIA-INSTANT-1e / F5] Fire the unfurl AFTER dispatch, never before —
    // this is the fix for "link previews gate peer dispatch up to 6s". Only
    // ever patches the SENDER's own local bubble; see the doc note above.
    if (preview == null && url != null && !composeDismissed) {
      unawaited(_unfurl(url).then((p) {
        if (p == null || !mounted) return;
        _mutMsgs(() => localMsg.extra = {...?localMsg.extra, 'preview': p});
        _schedulePersist();
      }));
    }
  }

  /// First http(s) URL in [text], or null. Mirrors the worker/card regex.
  String? _firstUrl(String text) {
    final m = RegExp(r'https?://[^\s<>()]+', caseSensitive: false).firstMatch(text);
    return m?.group(0);
  }

  /// GET /api/unfurl?url=… (auth Clerk bearer). Returns the preview map or null.
  /// Best-effort with a short timeout so a slow site never delays a send much.
  Future<Map<String, dynamic>?> _unfurl(String url) async {
    try {
      final r = await ApiAuth.getSigned(
        '$kUnfurlUrl?url=${Uri.encodeQueryComponent(url)}',
        timeout: const Duration(seconds: 6),
      );
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body);
      if (j is! Map) return null;
      final type = (j['type'] ?? 'link').toString();
      Analytics.capture('unfurl_requested', {
        'type': type,
        'cached': false, // client can't see the KV hit; the server also logs it
        if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
      });
      // Only embed a preview that will actually render a card (else raw link).
      final hasCard = type == 'youtube' ||
          (type == 'link' &&
              (((j['title'] ?? '').toString().isNotEmpty) ||
                  ((j['image'] ?? '').toString().isNotEmpty)));
      return hasCard ? Map<String, dynamic>.from(j) : null;
    } catch (_) {
      return null;
    }
  }

  /// [CHAT-UI-LIST-1e] Gated autoscroll. `force:true` (every OWN send site)
  /// always jumps — WhatsApp always shows you your own outgoing message. For
  /// everything else (inbound DM/group messages, Ava replies, history loads)
  /// we only steal the reader's scroll position if they're already within
  /// ~120px of the newest edge; otherwise we count it as unseen and let the
  /// FAB (see `_scrollToBottomFab`) do the jump on tap. This replaces the old
  /// unconditional jump that fired from all 13 call sites and yanked the view
  /// out from under anyone reading back through history.
  void _jump({bool force = false}) {
    // [CHAT-UI-REVERSE-1] With reverse:true, scroll offset 0 is the newest/
    // bottom edge (it used to be maxScrollExtent) — "near bottom" is now
    // simply "near offset 0".
    if (!force && _scroll.hasClients) {
      final pos = _scroll.position;
      final nearBottom = pos.pixels <= 120;
      if (!nearBottom) {
        if (mounted) setState(() => _unseenCount++);
        return;
      }
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // [CHAT-UI-REVERSE-1] "jump to the newest message" is `jumpTo(0)` now,
      // not `jumpTo(maxScrollExtent)`.
      if (_scroll.hasClients) _scroll.jumpTo(0);
      // [CHAT-UI-LIST-1e] force:true jumps (own sends) land the reader on the
      // newest message, so any unseen badge from before the jump no longer
      // applies — clear it here too (not just on the FAB tap) so an own-send
      // jump never leaves a stale badge behind.
      if (_unseenCount != 0 && mounted) setState(() => _unseenCount = 0);
    });
  }

  /// [CHAT-UI-LIST-1e] Small circular scroll-to-bottom button with an unread
  /// badge — WhatsApp-style. Shown only while `_unseenCount > 0` (i.e. the
  /// reader was scrolled up when something new arrived). Tapping jumps to the
  /// newest message and clears the counter.
  Widget _scrollToBottomFab() {
    return GestureDetector(
      onTap: () {
        setState(() => _unseenCount = 0);
        _jump(force: true);
      },
      child: Stack(clipBehavior: Clip.none, children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: AD.sendActiveBg,
            shape: BoxShape.circle,
            boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 6, offset: Offset(0, 2))],
          ),
          child: Icon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), color: AD.sendActiveInk, size: 26),
        ),
        Positioned(
          right: -4,
          top: -4,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            constraints: const BoxConstraints(minWidth: 18),
            decoration: const BoxDecoration(color: AD.unreadAccent, shape: BoxShape.circle),
            child: Text(_unseenCount > 99 ? '99+' : '$_unseenCount',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w700)),
          ),
        ),
      ]),
    );
  }

  /// [CHAT-UI-REVERSE-1] Used to be "land on the latest message" via a
  /// post-frame `jumpTo(maxScrollExtent)` plus two settle-timer retries (rows/
  /// media still laying out could leave the view mid-thread) — all needed
  /// because a NON-reversed list opens at offset 0 (the TOP/oldest message)
  /// and had to be dragged down to the newest one, invisibly, before reveal.
  /// With `reverse: true` the newest message IS offset 0 natively, so a
  /// freshly-opened thread needs no jump at all. Kept as a no-op so the two
  /// existing call sites (history-load completion) don't need to change.
  void _jumpToEndSettled() {}

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



  void _pickWallpaper() {
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Msg.rLg))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Chat wallpaper', style: ADText.threadName()),
          const SizedBox(height: 12),
          Wrap(spacing: 12, runSpacing: 12, children: [
            for (final id in kWallpaperOrder)
              GestureDetector(
                onTap: () async {
                  await WallpaperStore().set(_convKey!, id == 'default' ? '' : id);
                  if (mounted) { setState(() => _wallpaperId = id); Navigator.pop(ctx); }
                },
                child: Container(
                  width: 64, height: 64,
                  decoration: BoxDecoration(
                      gradient: _gradientFor(id), borderRadius: BorderRadius.circular(Msg.rMd),
                      border: Border.all(
                          color: _wallpaperId == id ? AD.textPrimary : AD.textTertiary,
                          width: _wallpaperId == id ? 3 : 2)),
                ),
              ),
          ]),
        ]))));
  }

  /// Open the "Save to contacts" sheet for an unknown caller, prefilled with
  /// their number. On success the affordances disappear and the header repaints
  /// with the chosen name.
  Future<void> _saveUnknownContact({String source = 'thread_menu'}) async {
    if (_telPhone.isEmpty) return;
    final saved = await showSavePhoneContactSheet(context, phone: _telPhone, source: source);
    if (saved != null && mounted) {
      setState(() => _callerSaved = true);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Saved ${saved.name}'),
        duration: const Duration(seconds: 2),
      ));
    }
  }

  /// Dismissible banner shown atop an unknown-number thread inviting the owner
  /// to save the caller as a contact.
  Widget _saveContactBanner() => Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 16, color: AD.iconVideo),
          const SizedBox(width: 8),
          Expanded(child: Text('Unknown number · ${formatTelDisplay(_telPhone)}',
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ADText.preview(c: AD.textPrimary))),
          GestureDetector(
            onTap: () => _saveUnknownContact(source: 'thread_banner'),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: AD.card,
                borderRadius: BorderRadius.circular(Msg.rSm),
                border: Border.all(color: AD.borderControl, width: 2),
              ),
              child: Text('Save', style: ADText.statCaption()),
            ),
          ),
          const SizedBox(width: 6),
          GestureDetector(onTap: () => setState(() => _saveBannerDismissed = true),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 15, color: AD.textSecondary)),
          const SizedBox(width: 8),
        ]),
      );

  /// Read-only footer for an unknown-number voicemail thread.
  Widget _telFooter() => Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(top: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(PhosphorIcons.voicemail(PhosphorIconsStyle.fill), size: 15, color: AD.textTertiary),
          const SizedBox(width: 8),
          Flexible(child: Text(
              _callerSaved
                  ? 'Voicemail record · this caller isn’t on AvaTOK'
                  : 'Voicemail record from an unknown number',
              style: ADText.preview(c: AD.textSecondary))),
          if (!_callerSaved) ...[
            const SizedBox(width: 10),
            GestureDetector(
              onTap: () => _saveUnknownContact(source: 'thread_footer'),
              child: Text('Save contact', style: ADText.statCaption(c: AD.iconSearch)),
            ),
          ],
        ]),
      );

  Widget _pinBanner() => Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.pushPin(PhosphorIconsStyle.fill), size: 15, color: AD.iconSearch),
          const SizedBox(width: 8),
          Expanded(child: Text('Pinned: ${_pinned!['text'] ?? ''}',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.preview(c: AD.textPrimary))),
          GestureDetector(onTap: _unpin,
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 15, color: AD.textSecondary)),
          const SizedBox(width: 8),
        ]),
      );
}
