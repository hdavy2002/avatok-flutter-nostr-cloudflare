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
import '../../core/api_auth.dart';
import '../../core/audio_playback_service.dart'; // [AVAVM-PLAYER-1]
import '../../core/avatar_cache.dart';
import '../../core/badge_service.dart'; // [ISSUE-BADGE-UNREAD-1]
import '../../core/ava_ai_client.dart';
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
import '../../core/ice_cache.dart';
import '../../core/profile_store.dart';
import '../../core/drive_service.dart';
import '../../core/library_api.dart';
import '../../core/local_brain/local_brain.dart';
import '../library/library_picker.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/avatok_dark.dart';
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
import 'ava_email.dart';
import 'file_viewer_screen.dart';
import '../genui/a2ui_renderer.dart';
import '../../core/apps_service.dart';
import '../conference/conference_api.dart';
import '../conference/conference_screen.dart';
import '../conference/mesh_api.dart';
import '../conference/mesh_call_screen.dart';
import '../conference/sfu_group_call_api.dart';
import '../conference/sfu_group_call_screen.dart';
import '../../core/analytics.dart';
import '../../core/money_api.dart';
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
import '../messaging/widgets/gif_api.dart';
import '../messaging/widgets/picker_recents_store.dart';
import '../messaging/widgets/sticker_media.dart';

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

class _Msg {
  final int id;
  final bool me;
  String text;
  final String time;
  final int ts; // sort key (epoch seconds; 0 for demo)
  String? evId; // rumor id (real DMs) — set after media upload too
  // [AVAGRP-SENDERPUB-BACKFILL-1] `senderLabel`/`senderPub` were `final`; they
  // are now mutable (like `evId` above, which is likewise stamped after the
  // fact) so `_backfillSenderPubs` can REPAIR an already-rendered history bubble
  // in place. Nothing else assigns them after construction — the live ingest
  // path (`_onGroupMsg`) still sets both in the constructor, and the repair only
  // ever fills a value that is currently null/empty, never rewrites a good one.
  String? senderLabel; // group: who sent (null for mine / 1:1)
  // [AVAGRP-BUBBLE-1] The sender's STABLE uid (`GroupMessage.senderPub`), kept
  // alongside the display-name `senderLabel`. This is the identity that must
  // drive both per-sender bubble colour (`resolveBubbleTheme`) and the group
  // avatar lookup (`_memberAvatars`) — `senderLabel` is a display NAME that can
  // change (a member renames themselves) or arrive null before the name is
  // learned, and hashing/keying off it is exactly why the group tint reshuffled
  // mid-thread and the avatar fell back to a bare '?'. Null for mine / 1:1.
  // [AVAGRP-SENDERPUB-BACKFILL-1] No longer `final` — see `senderLabel` above.
  String? senderPub;
  String? reaction;
  Map<String, int> reactCounts = {}; // Phase 4: aggregate live reactions (emoji → count)
  Map<String, Set<String>> reactBy = {}; // Phase 5: who reacted (emoji → set of uids) for the "reacted by" sheet
  ChatMedia? media;
  // [AVAVM-PLAYER-1] The REAL media kind, stamped at optimistic-bubble
  // creation (`_sendMedia`) — BEFORE `media` exists. `_mediaContent` used to
  // guess the kind from `localBytes != null` alone while a message was
  // uploading, which always guessed `image` (the audio-bubble-renders-blank
  // bug: `Image.memory()` on raw .m4a bytes fails to decode and the
  // `errorBuilder` returned nothing). Once `media` arrives post-upload, ITS
  // kind is authoritative again; this field only matters for the in-flight
  // window.
  MediaKind? pendingKind;
  String mediaCaption; // caption shown UNDER the photo in the SAME bubble (WhatsApp-style)
  Uint8List? localBytes; // instant preview of self-sent media
  bool uploading;
  bool fileOpening = false; // [CHAT-PDFVIEW-1] tap→download/decrypt in progress (bubble spinner)
  bool failed;
  bool sent; // relay ACKed this event (["OK", id, true]) — it's on the relay
  Map<String, dynamic>? replyTo; // {id, preview, who}
  bool edited;
  bool starred;
  bool forwarded;
  bool hidden; // soft-deleted on MY device: shown as "deleted" + Undo; data retained
  int? expireAt; // epoch secs after which the message disappears
  String? special; // 'loc' | 'card' | 'poll' | 'sticker'
  Map<String, dynamic>? extra;
  bool aiLocal; // a PRIVATE @ava question — local-only, never sent to the peer (no delivery ticks)
  // Poll tallies (2026-07-04) — server-persisted (survive reinstall). Hydrated
  // from GET /api/poll/state on open and kept live via {t:'vote'} envelopes.
  Map<int, int> pollVotes = {}; // option index → vote count (server-authoritative)
  Map<int, Set<String>> pollBy = {}; // option index → set of voter uids (who-voted)
  Set<int> pollMine = {}; // option indices I currently voted for (drives highlight)
  // [AVAGRP-BUBBLE-1 / message-info] Per-message, per-member receipts for the
  // WhatsApp-style "Info" sheet (§4). uid → epoch-seconds. Default {}.
  // [AVAGRP-BUBBLE-2] LIVE as of this change, gated on
  // `RemoteConfig.groupReceiptsEnabled` (dark launch, default false): populated
  // by `_applyMsgReceipt` (live `{"t":"msg_receipt",...}` frames) and
  // `_hydrateMsgReceipts` (`GET /api/msg/seen` on cold open), and persisted
  // across restarts via `toJson`/`fromJson`. While the flag is off nothing
  // writes into these maps, so the Info sheet still shows "No read receipts
  // yet" exactly as before this change.
  Map<String, int> readBy = {};
  Map<String, int> deliveredTo = {};
  // [AVA-GRP-SENDSTATE] True only when the durable outbox has TERMINALLY given up
  // on this send (50 attempts / 24h) — the single honest signal for "not sent".
  // Persisted so a genuine give-up stays "not sent · tap to retry" across restarts,
  // while a group message that merely lacks an in-memory ACK (delivered, echoed,
  // outbox entry already removed) is NOT confused for a failure on reopen.
  bool sendGaveUp = false;
  // [AVAGRP-BUBBLE-2] A group SYSTEM announcement ("X created the group", "X
  // added Y", "X changed the group photo" — `GroupApi.announce()`, wire
  // envelope `{"t":"gtext","gid":conv,"body":text,"system":true}`). Renders as
  // a centered pill (`_systemBubble`) with NO avatar, NO sender-name header,
  // and NO per-sender tint — never routed through the normal `_bubble` path.
  final bool system;
  // [AVA-CHAT-INSTANT] Epoch ms when this optimistic outgoing bubble was created,
  // so the send→server-ACK round-trip can be reported (msg_send_confirmed). Null
  // for received/system/AI-local bubbles that never go through the send pipeline.
  int? sendStartedMs;
  _Msg(this.id, this.me, this.text, this.time,
      {this.ts = 0, this.evId, this.senderLabel, this.senderPub, this.reaction, this.media, this.pendingKind, this.mediaCaption = '', this.localBytes,
       this.uploading = false, this.failed = false, this.sent = false, this.replyTo, this.edited = false,
       this.starred = false, this.forwarded = false, this.hidden = false, this.expireAt, this.special, this.extra,
       this.aiLocal = false, Map<String, int>? readBy, Map<String, int>? deliveredTo, this.system = false})
      : readBy = readBy ?? {}, deliveredTo = deliveredTo ?? {};
}

/// [AVAVM-PLAYER-1] Best-effort, in-memory registry of the [Chat] behind every
/// conversation key opened THIS app session, so the app-wide
/// [MiniAudioPlayerBar] (mounted at the shell root) can reopen the right
/// thread when its "now playing" bar is tapped for a voice note whose
/// `AudioTrack.originRoute` is that thread's `convKey`.
///
/// Not persisted — deliberately: it only needs to answer "have we been here
/// this session", and the bar can only ever be showing a track for a thread
/// that WAS opened this session (playback has to have started somewhere).
/// Installs itself once as [AudioPlaybackService.onTapOrigin]; other surfaces
/// (e.g. the AvaDial voicemail inbox) can compose with or override that hook
/// for their own `originRoute` scheme without needing anything from this file.
///
/// [AVAVM-PLAYER-2] COMPOSES rather than clobbers — mirrors
/// `InboxThreadRegistry._ensureHook()` (features/avadial/inbox/inbox_thread_screen.dart):
/// captures whatever `AudioPlaybackService.onTapOrigin` was already installed
/// and falls through to it for any track this registry doesn't recognise
/// (i.e. not one of `_byConvKey`'s keys). Previously this unconditionally
/// OVERWROTE the hook the first time any chat thread opened, so if a chat
/// thread happened to open AFTER the Inbox lane had already installed its own
/// hook, chat's install silently discarded Inbox's — tapping the mini-player
/// after a voicemail could then navigate to the wrong place (or no-op)
/// depending purely on which thread type was opened first (AVAINBOX-1
/// handover report, confirmed). Capturing+chaining `previous` here fixes the
/// reverse ordering that report flagged as NOT fixed by the Inbox side alone;
/// combined with `InboxThreadRegistry`'s existing capture-and-chain, BOTH
/// installation orders now compose correctly. `AudioPlaybackService
/// .onTapOrigin` itself is untouched (still a single nullable field) — no
/// public API change, so `InboxThreadRegistry` (owned by a different agent)
/// keeps compiling unchanged.
abstract class ChatThreadRegistry {
  static final Map<String, Chat> _byConvKey = {};
  static bool _installed = false;

  static void remember(String convKey, Chat chat) {
    _byConvKey[convKey] = chat;
    _ensureNavHook();
  }

  static void _ensureNavHook() {
    if (_installed) return;
    _installed = true;
    final previous = AudioPlaybackService.onTapOrigin;
    AudioPlaybackService.onTapOrigin = (context, track) async {
      final route = track.originRoute;
      final chat = route != null ? _byConvKey[route] : null;
      if (chat != null) {
        await Navigator.of(context, rootNavigator: true).push(
          MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)),
        );
        return;
      }
      // Not a chat-thread track (or not opened this session yet) — fall
      // through to whatever was installed before us (e.g. Inbox's hook).
      await previous?.call(context, track);
    };
  }
}

/// One semantic ("smart search") hit returned by /api/brain/thread-search and
/// resolved against the local transcript. [localId] is the matched `_Msg.id` when
/// the snippet fuzzy-matches a message loaded in THIS thread (tappable → scrolls
/// to it); null means the hit is "from your other chats" (hidden by default).
class _AiHit {
  final String snippet;   // server snippet (may carry a "Me: "/"Them: " label)
  final bool inThread;    // server's coarse this-conversation guess
  final int? localId;     // matched local _Msg.id, else null
  final String localText; // the matched local message text (for display)
  _AiHit(this.snippet, this.inThread, this.localId, this.localText);
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
  final _ctrl = TextEditingController();
  final _searchCtrl = TextEditingController(); // in-thread search box (literal + AI)
  final _composerFocus = FocusNode(); // keep the keyboard up after each send
  final _scroll = ScrollController();
  // [AVA-CHAT-INSTANT] The message list is laid out but kept invisible until the
  // first jump-to-end lands, so a thread OPENS already pinned to the newest
  // message instead of painting at the top and then visibly snapping down through
  // history (owner: "it scrolls from the top to the last message"). Flipped true by
  // [_jumpToEndSettled]'s first post-frame jump, with a hard safety-net in
  // initState so a thread that never calls it (demo / edge paths) can never stay
  // blank. jumpTo needs a laid-out viewport, so we gate VISIBILITY (Opacity), not
  // layout (Offstage) — the extent is measurable while hidden.
  bool _openReveal = false;
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
  // Premium = topped-up wallet / active subscription. Gates the @ava·#ava
  // composer hint (paid users only) — loaded in initState via MoneyApi.
  bool _premium = false;
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
  static const _kTransLangKey = 'composer_translate_lang';
  // Per-account "hide deleted messages" preference: when on, both the slim
  // "You deleted this message" pills and peer "This message was deleted"
  // tombstones are collapsed out of the thread so it stays clean. Keyed per
  // conversation so the choice is remembered for THIS chat.
  static const _kHideDeletedKey = 'chat_hide_deleted';
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
    setState(() {
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
    WidgetsBinding.instance.addObserver(this); // [VOICE-REC-1] recorder auto-pause
    // [AVA-CHAT-INSTANT] Safety net for the open-at-bottom reveal gate: normally
    // _jumpToEndSettled reveals the list the instant it lands on the newest
    // message, but a thread that never reaches that path (demo / non-real modes)
    // must still become visible. Reveal unconditionally after a short beat.
    Future.delayed(const Duration(milliseconds: 450), () {
      if (mounted && !_openReveal) setState(() => _openReveal = true);
    });
    // Opening a thread nudges a catch-up sync: a server-injected message (e.g. a
    // marketplace agent-deal card, or a receptionist card) is appended directly to
    // the InboxDO and only arrives on a fresh sync — if the socket wasn't connected
    // when it landed, the thread would look empty. This probes/reconnects so the
    // missing message pulls in right as you open the chat.
    try { SyncHub.I.onAppResumed(); } catch (_) {}
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
    // Paid status — drives the paid-only @ava·#ava composer hint.
    MoneyApi.balance().then((b) {
      if (mounted) setState(() => _premium = b['premium'] == 1 || b['premium'] == true);
    }).catchError((_) {});
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
      setState(() {
        _hiddenIds.addAll(m);
        for (final msg in _msgs) {
          if (msg.evId != null && m[msg.evId] == true) msg.hidden = true;
        }
      });
    });
    // Re-apply peer hard-deletes (delete-for-everyone) on a cold open, then tombstone
    // anything already on screen that a peer deleted while this thread was closed.
    DeletedStore().load().then((s) {
      if (!mounted || s.isEmpty) return;
      setState(() {
        _deletedIds.addAll(s);
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
        setState(() => _msgs.removeWhere((m) => m.expireAt != null && m.expireAt! < nowS));
      }
    });
    // Group conferencing (Phase 10): poll for an ongoing LiveKit call so the
    // "tap to join" banner appears/disappears while the thread is open.
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
    setState(() => _msgs.clear()); // drop demo seed; history loads from relay
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
    setState(() => _msgs.clear());
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
      if (mounted) setState(() { _memberNames.addAll(names); _memberAvatars.addAll(avatars); });
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
        setState(() {
          if (gotPhoto) _memberAvatars[uid] = c!.avatarUrl;
          if (gotName) _memberNames[uid] = c!.name;
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
  static const String _kSenderPubRepairKey = 'grp_senderpub_repaired_v1';

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
        setState(() {
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
      setState(() {
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

  Future<void> _setupGroup(Identity id) async {
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    _realMode = true;
    _isGroup = true;
    _group = g;
    Analytics.capture('group_thread_opened', {'gid': g.id, 'member_count': g.members.length});
    setState(() => _msgs.clear());
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
      setState(() {
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

  // Send an ephemeral floating-emoji burst to everyone in the room + animate locally.
  void _sendBurst(String emoji) {
    HapticFeedback.lightImpact();
    _party?.send({'t': 'burst', 'emoji': emoji}); // PartyKit floating-emoji burst
    _spawnBurst(emoji); // optimistic local animation (peers see it via the burst stream)
  }

  void _pickBurstEmoji() {
    showModalBottomSheet(
      context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
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
        if (!m.mine) MediaService.recordReceived(media); // mirror into the recipient's AvaLibrary
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
    setState(() {
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
    setState(() { m.failed = !s.ok; m.sent = s.ok; m.sendGaveUp = !s.ok; });
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
        if (!m.mine) MediaService.recordReceived(media); // mirror into the recipient's AvaLibrary
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
    setState(() {
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
    if (i >= 0 && mounted) { setState(() { _msgs[i].text = body; _msgs[i].edited = true; }); _schedulePersist(); }
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
    setState(() {
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
    setState(() {
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
    if (!RemoteConfig.restoreV2 || _archiveDone || _archiveLoading) return;
    if (!_scroll.hasClients) return;
    // extentBefore is how much is scrolled off the TOP; near 0 ⇒ at the oldest
    // message currently loaded → fetch older history.
    if (_scroll.position.extentBefore <= 240) {
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
    // Preserve the scroll position across the prepend so the view doesn't jump:
    // remember distance-from-bottom, restore it after the new rows lay out.
    final beforeMax = _scroll.hasClients ? _scroll.position.maxScrollExtent : 0.0;
    final beforePix = _scroll.hasClients ? _scroll.position.pixels : 0.0;
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
      // Restore the scroll offset so the freshly-prepended history doesn't yank
      // the user away from where they were reading.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) return;
        final grew = _scroll.position.maxScrollExtent - beforeMax;
        if (grew > 0) _scroll.jumpTo((beforePix + grew).clamp(0.0, _scroll.position.maxScrollExtent));
      });
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
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: _sysPillBorder, width: 1.5),
              boxShadow: const [],
            ),
            child: Text(label.toUpperCase(),
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
              borderRadius: BorderRadius.circular(100),
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
    _safetySub?.cancel();              // F6: live safety_flag frames
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

  /// The wake words the composer watches for. `@ava` = a PRIVATE personal call
  /// to Ava (never sent to the peer, private reply). `#ava` = a SHARED call (both
  /// parties see the question + reply).
  static const String _avaWakeWord = '@ava';
  static const String _avaShareWord = '#ava';

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
      setState(() {
        // The on-device answer is here — drop the transient "thinking" chip.
        _msgs.removeWhere((m) => m.special == 'ava_status');
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
      setState(() {
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
      setState(() {
        final i = _msgs.indexWhere((x) => x.evId == evId);
        if (phase == 'end') return; // keep the preview; durable answer replaces it
        if (i >= 0) {
          if (phase == 'delta') _msgs[i].text = _msgs[i].text + delta;
          return;
        }
        // First frame for this turn (start, or a delta if start was missed):
        // drop the "working…" chip and open the growing bubble.
        _msgs.removeWhere((x) => x.special == 'ava_status');
        _msgs.add(_Msg(_seq++, false, delta, _fmtTime(now),
            ts: now, special: 'ava', evId: evId));
        _msgs.sort((a, b) => a.ts.compareTo(b.ts));
      });
      _jump();
    });
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
      setState(() {
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
        // Ava-in-chat (@ava / #ava) AND connected-app/composio actions (email,
        // image generation, etc.) are a PAID feature (owner request 2026-06-27).
        // Free users get a one-line upsell instead of an Ava turn.
        if (!_premium) {
          Analytics.capture('ava_chat_gate_blocked', <String, Object>{
            'mode': privateAva ? 'private' : 'shared', 'is_group': _isGroup,
          });
          if (privateAva) {
            // Private @ava is never sent to the peer — show the upsell and stop.
            _composerFocus.requestFocus();
            _capNote('Asking Ava is a paid feature — subscribe to use @ava (private) '
                'and #ava (in chat), plus connected apps like email and image generation.');
            setState(() { _ctrl.clear(); _hasText = false; });
            if (_convKey != null) DraftStore().set(_convKey!, '');
            return;
          }
          // #ava: the literal message still sends to the peer (below); Ava just
          // won't reply for free users.
          _capNote('Ava in chat is a paid feature — subscribe to get an Ava reply to #ava.');
        } else {
          // Ava-mode plain text carries no marker → prefix so AvaInvoke parses it
          // as a private @ava call.
          // ignore: unawaited_futures
          onSummonAva!(avaModePrivate ? '$_avaWakeWord $t' : t);
          if (privateAva) {
            _ragAddLine('You', t);
            _composerFocus.requestFocus();
            setState(() {
              // aiLocal: rendered locally only, never sent → no delivery ticks.
              _msgs.add(_Msg(_seq++, true, t, _fmtTime(now), ts: now, aiLocal: true));
              _ctrl.clear(); _hasText = false; _replyTo = null;
            });
            _jump();
            if (_convKey != null) DraftStore().set(_convKey!, '');
            _schedulePersist();
            return;
          }
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
      setState(() { m.text = t; m.edited = true; _editing = null; _ctrl.clear(); _hasText = false; });
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
    setState(() {
      _msgs.add(_Msg(_seq++, true, t, 'now', replyTo: replyMeta));
      _ctrl.clear(); _hasText = false; _replyTo = null;
    });
    _jump();
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
    setState(() {
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
    _jump();
    if (_convKey != null) DraftStore().set(_convKey!, '');

    // Preview resolution order:
    //   1. the compose-time card the user just saw (instant, already fetched)
    //   2. the user explicitly ✕'d it → send with no preview
    //   3. no compose card (e.g. sent before the debounce fired) → unfurl now
    Map<String, dynamic>? preview = composeHit;
    if (preview == null && url != null && !composeDismissed) {
      preview = await _unfurl(url);
      if (preview != null && mounted) {
        // Show the card on the sender's own bubble too.
        setState(() => localMsg.extra = {...?localMsg.extra, 'preview': preview});
      }
    }

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

  void _jump() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });

  /// Robust "land on the latest message" used when a thread first opens. A single
  /// post-frame jump can miss because rows/media are still laying out (the extent
  /// grows after the first frame), leaving the view mid-thread. So we jump after
  /// the frame AND again after a short settle so we reliably end at the bottom.
  void _jumpToEndSettled() {
    void toEnd() { if (mounted && _scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent); }
    // [AVA-CHAT-INSTANT] Jump to the newest message on the first frame, THEN reveal
    // the (until now invisible) list — so the thread appears already anchored at the
    // bottom with no visible top-to-bottom scroll-through of history. The later
    // settle-jumps only nudge the offset if media grows the extent after reveal.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      toEnd();
      if (mounted && !_openReveal) setState(() => _openReveal = true);
    });
    Future.delayed(const Duration(milliseconds: 250), toEnd);
    Future.delayed(const Duration(milliseconds: 600), toEnd);
  }

  // ---- calls ----
  // 1:1 = P2P (CallRoom DO) via _call(). Groups = LiveKit conference via
  // _groupCall() — RULE CHANGE 2026-06-10 (Phase 10): group conferences are
  // allowed, ≤25 participants. The CallRoom DO 2-peer cap stays untouched.
  bool _dialing = false; // debounce: blocks a second call_started while dialing

  Future<void> _call(String kind) async {
    // This path is 1:1 P2P ONLY — group threads route through _groupCall()
    // (LiveKit) and must NEVER reach the CallRoom DO.
    if (widget.chat.group || widget.chat.gid != null) return;
    // Debounce double-taps / re-entrancy: a single video-button tap was firing
    // TWO POST /api/call + two CallScreens ~1s apart, and the colliding second
    // call busied out the first right after it connected — so the connected
    // call tore down and video never rendered ("audio worked, no video came
    // through"). One dial in flight, and none while already on a call.
    if (_dialing || gLiveCallScreens > 0) {
      // [AVATOK-DIAL-GUARD-1] gLiveCallScreens has no staleness bound like its
      // siblings gInCallSince/gOutgoingSince, so a leaked CallSession teardown
      // sticks it >0 forever and every future dial silently no-ops (13
      // suppressed call-back taps in the 2026-07-15 incident). Give it a
      // chance to self-heal before trusting it — never touches `_dialing`,
      // only `gLiveCallScreens` (see selfHealStaleLiveCallScreens in
      // call_screen.dart; interim fix, Specs/FIXPLAN-2026-07-15-avadial-incoming-call-ui.md FIX 5).
      if (!_dialing && gLiveCallScreens > 0 && selfHealStaleLiveCallScreens()) {
        // Healed: the counter was stale and no session is genuinely live.
        // Fall through and place the call normally instead of suppressing it.
      } else {
        final reason = _dialing ? 'already_dialing' : 'already_in_call';
        Analytics.capture('call_dial_suppressed', {
          'reason': reason,
          'kind': kind,
          'user_notified': reason == 'already_in_call',
        });
        // [AVATOK-DIAL-GUARD-1] Never silent: a suppressed dial used to be a
        // dead call button with zero feedback. Tell the user so they have an
        // escape hatch (force-close) if the guard is wrong.
        if (reason == 'already_in_call' && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Already on a call — force-close the app if this is wrong')));
        }
        return;
      }
    }
    // CALLFIX-14: glare detection — if an incoming call from the same peer is
    // currently ringing, accept it instead of dialing (resolves simultaneous dials).
    final to = widget.chat.seed; // the peer's uid
    if (gIncomingRingingFrom == to && gIncomingRingingCallId != null) {
      Analytics.capture('call_glare_autoaccept', {
        'call_id': gIncomingRingingCallId!,
        'kind': kind,
      });
      // Accept the incoming call (dismiss ring UI + open the call like a normal accept)
      await PushService.acceptRingingCall(gIncomingRingingCallId!);
      return;
    }
    _dialing = true;
    IceCache.prefetch(); // warm TURN creds in parallel with the FCM ring
    final video = kind == 'video';
    final room = 'avatok-${const Uuid().v4().substring(0, 8)}';
    // [TRACE-ID-1] Mint ONE correlation id at this dial boundary. It rides the
    // /api/call POST header (→ Worker → push payload → callee → RTC telemetry)
    // and is handed to the CallSession so every call event on BOTH devices
    // stitches under one trace_id in PostHog.
    final traceId = TraceContext.mint();
    // (`to` already declared above in the CALLFIX-14 glare block)
    AvaLog.I.log('call', 'placing ${video ? "video" : "audio"} call callId=$room to=${to.length > 12 ? to.substring(0, 12) : to}…');
    // [INSTANT-CALL-MOUNT-1] Optimistic mount: show the CallScreen the INSTANT
    // the user tapped, then run POST /api/call in the BACKGROUND. The old flow
    // AWAITED that POST (Worker + FCM fan-out — routinely seconds, up to the ~8s
    // timeout on a flaky link) BEFORE Navigator.push, so the call screen took
    // seconds to appear (PostHog: call_place_ok → call_started was only ~30ms, so
    // the wait was entirely the POST, not the render). The optimistic session
    // runs the HONEST guard flow (deferRing → connecting + searching tone, never
    // a fake ringback) and _placeCallInBackground feeds the reachability/glare/
    // failure outcome back into it via notePlaceResult / notePlaceFailed — so an
    // unreachable callee still never hears ringback into the void ([MULTIACCT-4]
    // guarantee preserved). Kill switch: RemoteConfig.instantCallMountEnabled.
    // Only for real uid contacts (the ones a POST actually rings).
    if (RemoteConfig.instantCallMountEnabled && to.startsWith('user_')) {
      if (!mounted) { _dialing = false; return; }
      Analytics.capture('call_mount_optimistic', {'call_id': room, 'kind': kind});
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => CallScreen(
            room: room, title: widget.chat.name, seed: to, video: video,
            avatarUrl: widget.chat.avatarUrl,
            traceId: traceId, // [TRACE-ID-1]
            deferRing: true,  // [INSTANT-CALL-MOUNT-1] honest guard flow until placed
            onRetry: () {
              Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': kind});
              // ignore: unawaited_futures
              _call(kind);
            },
          ),
        ),
      );
      // The screen is mounted; start() will bump gLiveCallScreens to guard re-entry.
      _dialing = false;
      // ignore: unawaited_futures
      _placeCallInBackground(room: room, to: to, video: video, traceId: traceId, kind: kind);
      return;
    }
    // The callee's default ringtone (AI Ringback) — comes back on the /api/call
    // response so the caller hears it locally while ringing.
    String ringbackUrl = '';
    // [MULTIACCT-4] When the server tells us the callee is UNREACHABLE (no
    // registered device / all tokens stale after a re-login), we must NOT open the
    // CallScreen — opening it plays fake ringback into a call that can never ring
    // (the exact "endless ringback, callee never rings" symptom). This flag short-
    // circuits the dial: show a clear message and stop, no ringback.
    bool unreachable = false;
    // Ring the callee's phone via FCM wake (real uid contacts only).
    if (to.startsWith('user_')) {
      try {
        // 'from' is derived server-side from the NIP-98 signature.
        final res = await ApiAuth.postJsonH(kCallUrl, {
          'to': to,
          'fromName': _myName ?? 'AvaTOK',
          'callId': room,
          'kind': video ? 'video' : 'audio',
        }, {'x-trace-id': traceId}); // [TRACE-ID-1] propagate to Worker + push
        AvaLog.I.log('call', 'POST /api/call -> HTTP ${res.statusCode}${res.statusCode != 200 ? " body=${res.body.length > 120 ? res.body.substring(0, 120) : res.body}" : ""}');
        final callKind = video ? 'video' : 'audio';
        // [MULTIACCT-4] Parse the distinct reachability signal the server now
        // returns (`reachable:false` on both the zero-token 404 and — via a later
        // ring-ack — the all-tokens-pruned case). A 404 is always unreachable.
        bool reachableFalse = false;
        try { reachableFalse = jsonDecode(res.body)['reachable'] == false; } catch (_) {}
        // [CALL-GLARE-2] Server-side mutual-dial resolution. The callee was ALREADY
        // dialing us within the glare window, so the server folded both dials into
        // one winning call (smaller callId) instead of ringing a second room. Join
        // that winning room deterministically instead of mounting a new outgoing
        // CallScreen — no busy dead-end. Both devices compute the same winner.
        String glareJoin = '';
        try {
          final jb = jsonDecode(res.body);
          if (jb is Map && jb['glare'] == true) {
            glareJoin = (jb['join_call_id'] ?? '').toString();
          }
        } catch (_) {}
        if (glareJoin.isNotEmpty) {
          Analytics.capture('call_glare_autoconnect', {
            'winner_call_id': glareJoin,
            'my_call_id': room,
            'kind': video ? 'video' : 'audio',
          });
          _dialing = false;
          if (!mounted) return;
          final outgoingWon = glareJoin == room;
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => CallScreen(
                room: glareJoin, title: widget.chat.name, seed: to, video: video,
                avatarUrl: widget.chat.avatarUrl,
                // The winner's placer keeps dialing (outgoing); the loser joins the
                // winning room as the answering side so exactly one room forms.
                outgoing: outgoingWon,
                traceId: traceId,
              ),
            ),
          );
          return;
        }
        if (res.statusCode == 200 && !reachableFalse) {
          try { ringbackUrl = (jsonDecode(res.body)['ringbackUrl'] ?? '').toString(); } catch (_) {}
          Analytics.capture('call_place_ok', {'kind': callKind, 'has_ringback': ringbackUrl.isNotEmpty});
        } else if (res.statusCode == 404 || reachableFalse) {
          // The callee has NO reachable device (0 push tokens, or every token went
          // stale after a re-login). Capture it so call reachability is queryable
          // per-callee, and DON'T open the ringing CallScreen — tell the caller.
          unreachable = true;
          Analytics.capture('call_no_device', {
            'to': to.length > 40 ? to.substring(0, 40) : to,
            'kind': callKind,
            'reason': res.statusCode == 404 ? 'http_404' : 'reachable_false',
          });
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text('${widget.chat.name} is unreachable right now — ask them to open AvaTOK')));
          }
        } else {
          // Any other non-200 (auth, 5xx, rate-limit) — capture so a failed call
          // placement isn't silent.
          Analytics.capture('call_place_failed', {'status': res.statusCode, 'kind': callKind});
        }
      } catch (e) {
        // [CALL-DIAL-FAIL-1] The place-call POST itself threw (network error,
        // DNS failure, or the ~8s ApiAuth.postJson timeout on a flaky
        // connection) — PostHog calls avatok-536eaa7a/c85ed3b7/2810780b: the
        // callee's phone NEVER rang, yet the old code fell through to
        // Navigator.push(CallScreen(...)) below and let the caller sit through
        // a full fake ringback window before dying with timeout-ringing. Treat
        // this exactly like the server-side "unreachable" signal — abort the
        // dial before the CallScreen ever mounts so no ringback plays into the
        // void, and offer an immediate Retry.
        AvaLog.I.log('call', 'POST /api/call FAILED: $e');
        final err = e.toString();
        Analytics.capture('call_place_failed', {
          'call_id': room,
          'kind': video ? 'video' : 'audio',
          'error': err.length > 160 ? err.substring(0, 160) : err,
        });
        unreachable = true;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: const Text("Can't reach the network — check your connection"),
            action: SnackBarAction(
              label: 'Retry',
              onPressed: () {
                Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': video ? 'video' : 'audio'});
                // ignore: unawaited_futures
                _call(kind);
              },
            ),
          ));
        }
      }
    } else {
      AvaLog.I.log('call', 'NOT ringing — contact seed is not an uid ($to)');
    }
    if (!mounted) { _dialing = false; return; }
    // [MULTIACCT-4] Unreachable callee → abort the dial before mounting CallScreen
    // so no ringback plays. The snackbar above already told the user why.
    if (unreachable) { _dialing = false; return; }
    // From here the CallScreen mounts (gLiveCallScreens > 0 guards re-entry),
    // so the in-flight debounce flag can be released.
    _dialing = false;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => CallScreen(
          room: room, title: widget.chat.name, seed: to, video: video,
          avatarUrl: widget.chat.avatarUrl, ringbackUrl: ringbackUrl,
          traceId: traceId, // [TRACE-ID-1]
          // [CALL-DIAL-FAIL-1] Retry affordance on the 'network-error' terminal
          // state: re-runs this exact dial flow (fresh room id, fresh POST)
          // instead of leaving the user stuck on a dead call screen.
          onRetry: () {
            Analytics.capture('call_retry_pressed', {'call_id': room, 'kind': kind});
            // ignore: unawaited_futures
            _call(kind);
          },
        ),
      ),
    );
  }

  // [INSTANT-CALL-MOUNT-1] Runs POST /api/call AFTER the CallScreen is already on
  // screen (optimistic mount) and feeds the outcome to the live session. This is
  // the same POST the awaited path did — just off the critical path — so the ring
  // push still fires immediately; only the UI no longer waits on it. Outcomes:
  //   • reachable        → notePlaceResult(true)  → full ring window (honest)
  //   • unreachable/404  → notePlaceResult(false) → Ava, no fake ringback shown
  //   • server folded a mutual dial (glare) into a different room → supersede the
  //     optimistic room and open the deterministic winner
  //   • identity gate    → interceptor opened liveness → tear the screen down
  //   • hard network fail → notePlaceFailed() → 'network-error' + Retry
  Future<void> _placeCallInBackground({
    required String room,
    required String to,
    required bool video,
    required String traceId,
    required String kind,
  }) async {
    final callKind = video ? 'video' : 'audio';
    try {
      final res = await ApiAuth.postJsonH(kCallUrl, {
        'to': to,
        'fromName': _myName ?? 'AvaTOK',
        'callId': room,
        'kind': callKind,
      }, {'x-trace-id': traceId}); // [TRACE-ID-1] propagate to Worker + push
      AvaLog.I.log('call', 'POST /api/call (bg) -> HTTP ${res.statusCode}${res.statusCode != 200 ? " body=${res.body.length > 120 ? res.body.substring(0, 120) : res.body}" : ""}');

      // [CALL-GLARE-2] Server folded a simultaneous mutual dial into one winning
      // room. Both devices compute the same winner. If it isn't our optimistic
      // room, supersede: end this room's (peer-less) session and open the winner.
      String glareJoin = '';
      try {
        final jb = jsonDecode(res.body);
        if (jb is Map && jb['glare'] == true) glareJoin = (jb['join_call_id'] ?? '').toString();
      } catch (_) {}
      if (glareJoin.isNotEmpty && glareJoin != room) {
        Analytics.capture('call_glare_autoconnect', {
          'winner_call_id': glareJoin, 'my_call_id': room, 'kind': callKind, 'mount': 'optimistic',
        });
        CallSessionManager.instance.liveSessionFor(room)?.hangup('glare-superseded');
        if (!mounted) return;
        // Push the winner AFTER the superseded screen has popped (post-frame) so
        // the pop can never remove the winner route instead.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => CallScreen(
                room: glareJoin, title: widget.chat.name, seed: to, video: video,
                avatarUrl: widget.chat.avatarUrl,
                // We lost the glare (our room != winner) → join as the answering side.
                outgoing: false,
                traceId: traceId,
              ),
            ),
          );
        });
        return;
      }

      bool reachableFalse = false;
      try { reachableFalse = jsonDecode(res.body)['reachable'] == false; } catch (_) {}

      final session = CallSessionManager.instance.liveSessionFor(room);
      if (res.statusCode == 200 && !reachableFalse) {
        bool hasRingback = false;
        try { hasRingback = (jsonDecode(res.body)['ringbackUrl'] ?? '').toString().isNotEmpty; } catch (_) {}
        Analytics.capture('call_place_ok', {'kind': callKind, 'has_ringback': hasRingback, 'mount': 'optimistic'});
        // Reachable — release the honest guard flow into the full ring window.
        session?.notePlaceResult(true);
      } else if (res.statusCode == 404 || reachableFalse) {
        Analytics.capture('call_no_device', {
          'to': to.length > 40 ? to.substring(0, 40) : to,
          'kind': callKind,
          'reason': res.statusCode == 404 ? 'http_404' : 'reachable_false',
          'mount': 'optimistic',
        });
        // No reachable device → honest unreachable → Ava. No fake ringback ever
        // played (guard flow only showed connecting + searching tone).
        session?.notePlaceResult(false);
      } else if (res.statusCode == 403 && res.body.contains('identity_required')) {
        // The global 403 interceptor already opened the consent/liveness flow —
        // tear down the optimistic call screen so it isn't stuck behind the gate.
        Analytics.capture('call_blocked_identity', {'kind': callKind, 'mount': 'optimistic'});
        session?.hangup('identity-gate');
      } else {
        // Auth/5xx/rate-limit that isn't a reachability signal — let the guard
        // flow run; it self-heals via the 12s device-ring timeout → Ava if no
        // peer ever joins. Captured so it isn't silent.
        Analytics.capture('call_place_failed', {'status': res.statusCode, 'kind': callKind, 'mount': 'optimistic'});
        session?.notePlaceResult(true);
      }
    } catch (e) {
      // The place-call POST threw (network/DNS error or timeout). Drive the honest
      // 'network-error' terminal + Retry instead of a hung screen — same outcome
      // the old awaited path gave, just applied to the already-mounted screen.
      AvaLog.I.log('call', 'POST /api/call (bg) FAILED: $e');
      final err = e.toString();
      Analytics.capture('call_place_failed', {
        'call_id': room,
        'kind': callKind,
        'error': err.length > 160 ? err.substring(0, 160) : err,
        'mount': 'optimistic',
      });
      CallSessionManager.instance.liveSessionFor(room)?.notePlaceFailed();
    }
  }

  // ---- group conferencing (Phase 10 — LiveKit, ≤25 participants) ----
  Timer? _confTimer;
  bool _confLive = false;
  bool _confIsMesh = false; // the live call's transport: true=P2P mesh, false=SFU
  int _confCount = 0;

  int get _groupMemberCount => _group?.members.length ?? widget.chat.members;
  bool get _confAllowed => RemoteConfig.conferenceEnabled && _groupMemberCount <= 25;
  bool get _confOngoingHere => OngoingConference.active?.gid == widget.chat.gid && widget.chat.gid != null;

  void _startConfPolling() {
    if (!_isGroup && widget.chat.gid == null) return;
    _confTimer ??= Timer.periodic(const Duration(seconds: 25), (_) => _refreshConfStatus());
    _refreshConfStatus();
  }

  Future<void> _refreshConfStatus() async {
    final gid = widget.chat.gid;
    if (gid == null || !RemoteConfig.conferenceEnabled) return;
    if (_confOngoingHere) {
      // We're connected to the SFU room — count comes straight from it, no HTTP.
      final n = OngoingConference.active!.participantCount;
      if (mounted) setState(() { _confLive = true; _confCount = n; _confIsMesh = false; });
      return;
    }
    final s = await ConferenceApi.status(gid);
    if (s.live) {
      if (mounted) setState(() { _confLive = true; _confCount = s.count; _confIsMesh = false; });
      return;
    }
    // No SFU call live → check for a free-tier P2P mesh call so its banner shows.
    final m = await MeshApi.status(gid);
    if (mounted) setState(() { _confLive = m.live; _confCount = m.count; _confIsMesh = m.live; });
  }

  Future<void> _groupCall(bool video) async {
    final gid = widget.chat.gid;
    if (gid == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('This group needs to sync once before it can hold calls')));
      return;
    }
    if (!RemoteConfig.conferenceEnabled) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Group calls are temporarily unavailable')));
      return;
    }
    // FREE LAUNCH: when the CF Realtime SFU group-audio path is enabled, AUDIO
    // group calls run on Cloudflare Realtime SFU (≤32, active-speaker). Video
    // group calls and the dormant (flag-off) case fall through to LiveKit/mesh.
    if (RemoteConfig.groupAudioSfuEnabled && !video) {
      await _sfuGroupCall();
      return;
    }
    if (_groupMemberCount > 25) { _confLimitNotice(video); return; }

    // Already in THIS group's call (minimized) → just re-open the room screen.
    if (_confOngoingHere) {
      await Navigator.push(context, MaterialPageRoute(
          builder: (_) => ConferenceScreen.resume(OngoingConference.active!)));
      _refreshConfStatus();
      return;
    }
    // In a DIFFERENT call → one call at a time.
    if (OngoingConference.active != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are already in a call — leave it first')));
      return;
    }

    // ONE live call per group. Joiners follow whatever transport is already
    // running, so a free P2P-mesh call and a paid SFU call can never run in
    // parallel for the same group — only the STARTER picks the transport.
    await _refreshConfStatus();
    if (_confLive && _confIsMesh) {
      await _meshCall(video); // a mesh call is live → everyone joins the mesh
      return;
    }

    try {
      final live = _confLive; // an SFU call is live (mesh case handled above)
      final ticket = live
          ? await ConferenceApi.join(gid)
          : await ConferenceApi.start(gid, video: video);
      // In-thread system row so the group sees the call started (the worker
      // webhook also posts rows for server-registered groups).
      if (!live) {
        _sendSpecial('gcall', {'state': 'start', 'kind': ticket.kind, 'gid': gid},
            ticket.kind == 'audio' ? '🎙️ Audio call started — tap 📞 to join' : '📹 Video call started — tap 📞 to join');
      }
      if (!mounted) return;
      await Navigator.push(context, MaterialPageRoute(
          builder: (_) => ConferenceScreen.connect(
              ticket: ticket, gid: gid, title: widget.chat.name, starter: !live)));
      _refreshConfStatus();
    } on MeshRequiredException catch (_) {
      // Server refused this user an SFU seat (free / no Tokens).
      if (_confLive) {
        // An SFU call is already live → do NOT fork a separate mesh call.
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('This call needs Tokens to join — top up your wallet or wait for your daily free Tokens')));
        }
      } else {
        // Nobody is in a call → start a FREE P2P mesh call (≤5).
        await _meshCall(video);
      }
    } on ConferenceException catch (e) {
      if (!mounted) return;
      if (e.status == 403 && e.message.contains('25')) { _confLimitNotice(video); return; }
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (e) {
      AvaLog.I.log('conference', 'group call failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not start the call')));
      }
    }
  }

  /// FREE LAUNCH group AUDIO via Cloudflare Realtime SFU (≤32, active-speaker).
  /// Reached from _groupCall when RemoteConfig.groupAudioSfuEnabled is ON and the
  /// call is audio. Audio-only by design (no group video on this path).
  Future<void> _sfuGroupCall() async {
    final gid = widget.chat.gid;
    if (gid == null) return;
    if (_groupMemberCount > SfuGroupCallApi.maxParticipants) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(
          'This group has more than ${SfuGroupCallApi.maxParticipants} members, '
          'so group audio is not available')));
      return;
    }
    if (OngoingConference.active != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are already in a call — leave it first')));
      return;
    }
    final s = await SfuGroupCallApi.status(gid);
    final starting = !s.live;
    if (starting) {
      _sendSpecial('gcall', {'state': 'start', 'kind': 'audio', 'gid': gid, 'sfu': true},
          '🎙️ Audio call started — tap 📞 to join');
    }
    if (!mounted) return;
    await Navigator.push(context, MaterialPageRoute(
        builder: (_) => SfuGroupCallScreen(gid: gid, title: widget.chat.name, starter: starting)));
    _refreshConfStatus();
  }

  /// FREE-tier group call: P2P mesh (≤5) via MeshCallScreen. Reached when the SFU
  /// endpoint refuses a token with `mode:"mesh"` (the caller is on the Free plan).
  Future<void> _meshCall(bool video) async {
    final gid = widget.chat.gid;
    if (gid == null) return;
    // One call at a time (the SFU minimize-holder also blocks here).
    if (OngoingConference.active != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('You are already in a call — leave it first')));
      return;
    }
    final s = await MeshApi.status(gid);
    if (s.live && s.count >= MeshApi.maxMesh) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('This free call is full (max 5) — upgrade for larger calls')));
      }
      return;
    }
    final starting = !s.live;
    if (starting) {
      _sendSpecial('gcall', {'state': 'start', 'kind': video ? 'video' : 'audio', 'gid': gid, 'mesh': true},
          video ? '📹 Video call started — tap 📞 to join' : '🎙️ Audio call started — tap 📞 to join');
    }
    if (!mounted) return;
    await Navigator.push(context, MaterialPageRoute(
        builder: (_) => MeshCallScreen(gid: gid, title: widget.chat.name, video: video, starter: starting)));
    _refreshConfStatus();
  }

  /// Exact copy required by PHASE-10 acceptance criteria.
  void _confLimitNotice(bool video) {
    final what = video ? 'video' : 'audio';
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${video ? 'Video' : 'Audio'} calls disabled'),
        content: Text('This group has more than 25 members, so $what calls are '
            'disabled. You need fewer than 25 people to have a $what conference.'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
  }

  /// "Ongoing call · 6 — tap to join" banner (PiP return-to-call included:
  /// if we're connected-but-minimized, tapping re-attaches to the live room).
  Widget _confBanner() => GestureDetector(
        onTap: () => _groupCall(true),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.online,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 2)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), color: AD.textPrimary, size: 17),
            const SizedBox(width: 8),
            Expanded(child: Text(
              _confOngoingHere
                  ? 'Ongoing call · $_confCount — tap to return'
                  : 'Ongoing call · $_confCount — tap to join',
              style: ADText.rowName(),
            )),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textPrimary),
          ]),
        ),
      );

  // ---- media send + retry ----
  String _caption(MediaKind k, String name) => switch (k) {
        MediaKind.image => '📷 Photo',
        MediaKind.video => '🎬 Video',
        MediaKind.audio => '🎙️ Voice message',
        MediaKind.file => '📎 $name',
      };

  // ---- special message types: location / contact card / poll / sticker ----
  String _specialCaption(String type, Map<String, dynamic> e) => switch (type) {
        'loc' => '📍 Location',
        'live' => '📍 Live location',
        'card' => '👤 ${e['name'] ?? 'Contact'}',
        'poll' => '📊 ${e['q'] ?? 'Poll'}',
        'sticker' => (e['emoji'] ?? '🙂').toString(),
        'gcall' => e['kind'] == 'audio' ? '🎙️ Audio call' : '📹 Video call',
        // Ava kinds (Phase 0 contract) — caption used for chat-list previews etc.
        'ava' || 'ava_private' => (e['text'] ?? e['body'] ?? 'Ava').toString(),
        'ava_status' => (e['label'] ?? 'Ava is working…').toString(),
        'recept' => (e['text'] ?? '📞 Ava took a message').toString(),
        'marketplace_deal' => '🤝 ${e['outcome'] == 'deal' ? 'Agents reached a deal' : 'Agents finished negotiating'}',
        // [DIALPAD-BIZ-CALLS] WP6 — voicemail/agent_transcript envelopes already
        // carry a server-composed `text` (see do/voicemail_room.ts postVoicemail /
        // do/agent_voice_room.ts finalize), so reuse it verbatim for the chat-list
        // preview instead of a generic fallback.
        'voicemail' => (e['text'] ?? '📞 New voicemail').toString(),
        'agent_transcript' => (e['text'] ?? '🤖 Ava AI Agent call').toString(),
        _ => '',
      };

  void _notifyRecipients() {
    if (_isGroup) {
      PushService.notifyMessage(_memberUids, _myName ?? 'AvaTOK');
    } else if (_peerNpub != null) {
      PushService.notifyMessage([_peerNpub!], _myName ?? 'AvaTOK');
    }
  }

  void _sendSpecial(String type, Map<String, dynamic> data, String caption) {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final payload = {'t': type, ...data, if (_isGroup) ...{'gid': _group!.id, 'fromName': _fromNameTag}};
    String id;
    if (_isGroup && _gdm != null) {
      id = _gdm!.send(jsonEncode(payload));
    } else if (_realMode && _dm != null) {
      id = _dm!.send(jsonEncode(payload));
    } else {
      id = 'local-${DateTime.now().microsecondsSinceEpoch}';
    }
    _seenEv.add(id);
    setState(() => _msgs.add(_Msg(_seq++, true, caption, _fmtTime(now),
        ts: now, evId: id, special: type, extra: data)));
    _jump();
    _schedulePersist();
    _notifyRecipients();
  }

  // Incoming {t:'vote'} envelope (server fan-out or a peer's device). It carries
  // the voter's FULL current selection (`options`), so we REPLACE that voter's
  // rows in the local tally — idempotent for un-vote (empty options) and vote
  // change alike. Legacy single-`opt` envelopes are treated as a one-option add.
  void _applyVote(Map env) {
    final pollId = (env['poll'] ?? '').toString();
    final i = _msgs.indexWhere((x) => x.special == 'poll' && x.extra?['id'] == pollId);
    if (i < 0 || !mounted) return;
    final voter = (env['voter'] ?? '').toString();
    List<int> opts;
    if (env['options'] is List) {
      opts = (env['options'] as List).map((e) => (e as num).toInt()).toList();
    } else if (env['opt'] != null) {
      opts = [(env['opt'] as num).toInt()];
    } else {
      opts = const [];
    }
    setState(() {
      final m = _msgs[i];
      if (voter.isEmpty) {
        // Legacy anonymous vote (no voter id) — best-effort increment only.
        for (final o in opts) m.pollVotes[o] = (m.pollVotes[o] ?? 0) + 1;
        return;
      }
      // Remove this voter from every option, then re-add their current selection.
      for (final entry in m.pollBy.entries.toList()) {
        if (entry.value.remove(voter)) {
          m.pollVotes[entry.key] = ((m.pollVotes[entry.key] ?? 1) - 1).clamp(0, 1 << 30);
        }
      }
      final myUid = _meId?.uid ?? '';
      if (voter == myUid) m.pollMine = opts.toSet();
      for (final o in opts) {
        m.pollBy.putIfAbsent(o, () => <String>{}).add(voter);
        m.pollVotes[o] = (m.pollVotes[o] ?? 0) + 1;
      }
    });
  }

  // Toggle my vote for an option and persist it server-side (survives reinstall).
  // Single-choice: tapping a new option replaces my vote; tapping my current one
  // un-votes. Multi-select: each tap toggles that option independently. The POST
  // sends my FULL selection; the server replaces my rows + fans out {t:'vote'} to
  // every member's InboxDO for live updates.
  void _vote(_Msg poll, int opt) {
    final pollId = poll.extra?['id']?.toString() ?? '';
    if (pollId.isEmpty) return;
    final multi = poll.extra?['multi'] == true;
    final mine = Set<int>.from(poll.pollMine);
    final myUid = _meId?.uid ?? '';
    if (multi) {
      if (!mine.remove(opt)) mine.add(opt);
    } else {
      if (mine.contains(opt)) { mine.clear(); } else { mine.clear(); mine.add(opt); }
    }
    // Optimistic local update (server fan-out will re-affirm).
    setState(() {
      if (myUid.isNotEmpty) {
        for (final entry in poll.pollBy.entries.toList()) {
          if (entry.value.remove(myUid)) {
            poll.pollVotes[entry.key] = ((poll.pollVotes[entry.key] ?? 1) - 1).clamp(0, 1 << 30);
          }
        }
        for (final o in mine) {
          poll.pollBy.putIfAbsent(o, () => <String>{}).add(myUid);
          poll.pollVotes[o] = (poll.pollVotes[o] ?? 0) + 1;
        }
      }
      poll.pollMine = mine;
    });
    HapticFeedback.selectionClick();
    Analytics.capture('poll_vote', {'options': mine.length, 'cleared': mine.isEmpty, 'multi': multi, 'group': _isGroup});
    final conv = _serverConvId;
    if (conv != null) {
      // Durable, server-persisted vote + fan-out (the source of truth).
      ApiAuth.postJson(kPollVoteUrl, {
        'poll_id': pollId, 'conv': conv, 'options': mine.toList(), 'multi': multi,
      }).then((_) {}, onError: (_) {});
    } else {
      // No server conv (rare) — fall back to the legacy live-only envelope so a
      // 1:1/group device still sees the tick immediately.
      final payload = {'t': 'vote', 'poll': pollId, 'voter': myUid, 'options': mine.toList(), 'multi': multi, if (_isGroup) 'gid': _group!.id};
      if (_isGroup && _gdm != null) { _gdm!.send(jsonEncode(payload)); }
      else if (_realMode && _dm != null) { _dm!.send(jsonEncode(payload)); }
    }
  }

  Future<void> _shareLocation() async {
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Location permission needed')));
        return;
      }
      final pos = await Geolocator.getCurrentPosition();
      _sendSpecial('loc', {'lat': pos.latitude, 'lng': pos.longitude}, '📍 Location');
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't get location")));
    }
  }

  // ---- live location (WhatsApp-style) ----------------------------------------
  /// Pick a duration, grab the first fix, post the durable `t:'live'` bubble, and
  /// start streaming GPS ticks over the ephemeral presence room.
  Future<void> _shareLiveLocation() async {
    final minutes = await showModalBottomSheet<int>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Share live location', style: ADText.threadName()),
            const SizedBox(height: 4),
            Text('Your real-time position updates as you move, until the time runs out or you tap Stop.',
                style: ADText.preview(c: AD.textSecondary)),
            const SizedBox(height: 12),
            for (final opt in const [
              ('15 minutes', 15),
              ('1 hour', 60),
              ('8 hours', 480),
            ])
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: PhosphorIcon(PhosphorIcons.broadcast(PhosphorIconsStyle.bold), color: AD.danger),
                title: Text(opt.$1, style: ADText.rowName()),
                onTap: () => Navigator.pop(ctx, opt.$2),
              ),
          ]),
        ),
      ),
    );
    if (minutes == null) return;

    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Location permission needed')));
        Analytics.error(domain: 'location', code: 'perm_denied', screen: 'chat_thread', action: 'live_share');
        return;
      }

      final pos = await Geolocator.getCurrentPosition();
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final id = const Uuid().v4();
      final until = now + minutes * 60;

      final me = LiveLocationSession(
        id: id,
        lat: pos.latitude,
        lng: pos.longitude,
        until: until,
        mine: true,
        name: _myName ?? 'You',
        heading: pos.heading,
        speed: pos.speed,
        lastTs: now,
      );
      _live[id] = me;

      // Durable bubble (notifies the peer, survives reconnect/history).
      _sendSpecial('live', {
        'id': id,
        'lat': pos.latitude,
        'lng': pos.longitude,
        'until': until,
        'name': _myName ?? 'Me',
      }, '📍 Live location');

      // Stream the moving pin over the ephemeral presence room.
      _liveBroadcaster?.stop('superseded');
      _liveBroadcaster = LiveLocationBroadcaster(
        id: id,
        untilEpoch: until,
        onTick: (lat, lng, hdg, spd) {
          if (!mounted) return;
          final t = DateTime.now().millisecondsSinceEpoch ~/ 1000;
          me.apply(lat, lng, t, heading: hdg, speed: spd);
          _presence?.sendLiveLoc(id, lat, lng, heading: hdg, speed: spd, until: until, ts: t);
          if (t - _liveTickTelemetryTs >= 30) {
            _liveTickTelemetryTs = t;
            Analytics.capture('live_location_tick', {
              'share_id': id,
              'is_sender': true,
              'conv_kind': _isGroup ? 'group' : 'dm',
            });
          }
        },
        onEnd: (reason) {
          me.end();
          _presence?.sendLiveStop(id);
          Analytics.capture('live_location_stopped', {
            'share_id': id,
            'reason': reason,
            'is_sender': true,
          });
          if (mounted) setState(() {});
        },
      )..start();

      Analytics.capture('live_location_started', {
        'share_id': id,
        'duration_min': minutes,
        'conv_kind': _isGroup ? 'group' : 'dm',
        'members': _groupMemberCount,
      });
      AvaLog.I.log('location', 'live share started id=${id.substring(0, 8)} dur=${minutes}m');
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't start live location")));
      Analytics.error(domain: 'location', code: 'live_start_failed', message: '$e', screen: 'chat_thread', action: 'live_share');
    }
  }

  void _stopLiveShare(String id) {
    if (_liveBroadcaster?.id == id) {
      _liveBroadcaster?.stop('manual');
    } else {
      _live[id]?.end();
      _presence?.sendLiveStop(id);
      Analytics.capture('live_location_stopped', {'share_id': id, 'reason': 'manual', 'is_sender': true});
    }
    if (mounted) setState(() {});
  }

  /// Inline live-location bubble: a small OSM preview that re-pins as ticks
  /// arrive, a live status line, and (for my own share) a STOP affordance.
  Widget _liveBubble(LiveLocationSession s) {
    return AnimatedBuilder(
      animation: s,
      builder: (context, _) {
        final active = s.isActive;
        return GestureDetector(
          onTap: () => _openLiveMap(s),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Stack(children: [
                LiveMapView(lat: s.lat, lng: s.lng, width: 220, height: 120, zoom: 15),
                if (active)
                  Positioned(
                    right: 6,
                    top: 6,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                          color: AD.danger,
                          borderRadius: BorderRadius.circular(100),
                          border: Border.all(color: AD.bubbleInInk, width: 2)),
                      child: Text('LIVE', style: ADText.bubbleMeta(c: Colors.white)),
                    ),
                  ),
              ]),
              const SizedBox(height: 6),
              Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(
                    active
                        ? PhosphorIcons.broadcast(PhosphorIconsStyle.fill)
                        : PhosphorIcons.mapPin(PhosphorIconsStyle.fill),
                    color: active ? AD.danger : AD.bubbleInMeta,
                    size: 16),
                const SizedBox(width: 6),
                Flexible(child: Text(s.statusLabel(), style: ADText.rowName(c: AD.iconSearch))),
              ]),
              if (s.mine && active)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: GestureDetector(
                    onTap: () => _stopLiveShare(s.id),
                    child: Text('STOP SHARING', style: ADText.bubbleMeta(c: AD.danger)),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  void _openLiveMap(LiveLocationSession s) {
    Analytics.capture('live_location_opened', {'share_id': s.id, 'is_sender': s.mine});
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => LiveMapScreen(
        session: s,
        title: s.mine ? 'Your live location' : '${s.name} · live',
        onStop: s.mine ? () => _stopLiveShare(s.id) : null,
        onTelemetry: (ev) => Analytics.capture(ev, {'share_id': s.id, 'is_sender': s.mine}),
      ),
    ));
  }

  Future<void> _shareContactCard() async {
    final contacts = await ContactsStore().load();
    if (!mounted) return;
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Share a contact', style: ADText.threadName()),
          const SizedBox(height: 8),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: ListView(shrinkWrap: true, children: [
            for (final c in contacts)
              ListTile(contentPadding: EdgeInsets.zero, leading: Avatar(seed: c.seed, name: c.name, size: 40),
                title: Text(c.name, style: ADText.rowName()),
                onTap: () { Navigator.pop(ctx); _sendSpecial('card', {'name': c.name, 'uid': c.uid, 'handle': c.handle}, '👤 ${c.name}'); }),
          ])),
        ]))));
  }

  // Create Poll sheet (zine style): question + 2–10 options + a multi-select
  // toggle. The poll DEFINITION rides the message envelope (t:'poll'); votes are
  // persisted server-side (see _vote → /api/poll/vote).
  Future<void> _createPoll() async {
    final q = TextEditingController();
    final opts = <TextEditingController>[TextEditingController(), TextEditingController()];
    var multi = false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: SafeArea(child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(PhosphorIcons.chartBar(PhosphorIconsStyle.bold), size: 20, color: AD.textPrimary),
              const SizedBox(width: 8),
              Text('Create poll', style: ADText.rowName()),
            ]),
            const SizedBox(height: 14),
            TextField(controller: q, autofocus: true, textCapitalization: TextCapitalization.sentences,
              style: ADText.rowName(),
              decoration: InputDecoration(hintText: 'Ask a question…',
                hintStyle: ADText.preview(c: AD.textSecondary),
                filled: true, fillColor: AD.card,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: AD.borderControl, width: 2)))),
            const SizedBox(height: 12),
            ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: ListView(shrinkWrap: true, children: [
              for (var i = 0; i < opts.length; i++)
                Padding(padding: const EdgeInsets.only(bottom: 8), child: Row(children: [
                  Expanded(child: TextField(controller: opts[i], textCapitalization: TextCapitalization.sentences,
                    style: ADText.rowName(),
                    decoration: InputDecoration(hintText: 'Option ${i + 1}',
                      hintStyle: ADText.preview(c: AD.textSecondary),
                      isDense: true, filled: true, fillColor: AD.card,
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: AD.borderControl, width: 2)),
                      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: AD.borderControl, width: 2))))),
                  if (opts.length > 2)
                    IconButton(
                      icon: Icon(PhosphorIcons.minusCircle(PhosphorIconsStyle.bold), size: 20, color: AD.textSecondary),
                      onPressed: () => setSheet(() { opts.removeAt(i).dispose(); }),
                    ),
                ])),
            ])),
            if (opts.length < 10)
              TextButton.icon(
                onPressed: () => setSheet(() => opts.add(TextEditingController())),
                icon: Icon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold), size: 18, color: AD.textPrimary),
                label: Text('Add option', style: ADText.statCaption(c: AD.textPrimary)),
              ),
            const SizedBox(height: 4),
            InkWell(
              onTap: () => setSheet(() => multi = !multi),
              borderRadius: BorderRadius.circular(10),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  Icon(multi ? PhosphorIcons.checkSquare(PhosphorIconsStyle.fill) : PhosphorIcons.square(PhosphorIconsStyle.bold),
                      size: 22, color: multi ? AD.primaryBadge : AD.textSecondary),
                  const SizedBox(width: 10),
                  Expanded(child: Text('Allow multiple answers', style: ADText.rowName())),
                ])),
            ),
            const SizedBox(height: 12),
            SizedBox(width: double.infinity, child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AD.textPrimary, foregroundColor: AD.overlaySheet,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
              onPressed: () => Navigator.pop(ctx, true),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text('Create poll', style: ADText.statCaption(c: AD.overlaySheet))),
            )),
          ]),
        )),
      )),
    );
    if (ok != true) return;
    final options = opts.map((c) => c.text.trim()).where((t) => t.isNotEmpty).toList();
    if (q.text.trim().isEmpty || options.length < 2) {
      if (mounted) _toast('A poll needs a question and at least 2 options.');
      return;
    }
    Analytics.capture('poll_create', {'options': options.length, 'multi': multi, 'group': _isGroup});
    _sendSpecial('poll',
      {'id': const Uuid().v4(), 'q': q.text.trim(), 'options': options, 'multi': multi},
      '📊 ${q.text.trim()}');
  }

  void _stickerPicker() {
    const stickers = ['😀','😂','🥳','😍','😎','🤩','😭','🙏','👍','👏','🔥','❤️','🎉','💯','🚀','🌈','🍕','☕','⚡','✨'];
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Padding(padding: const EdgeInsets.all(16),
        child: Wrap(spacing: 10, runSpacing: 10, children: [
          for (final s in stickers)
            GestureDetector(onTap: () { Navigator.pop(ctx); _sendSpecial('sticker', {'emoji': s}, s); },
                child: Text(s, style: const TextStyle(fontSize: 38))),
        ]))));
  }

  Widget _specialContent(_Msg m, BubbleTheme t) {
    final e = m.extra ?? {};
    // [AVAGRP-BUBBLE-1] Every pale bubble fill is light — text is always the
    // resolved theme's ink (§2: white text only on coral/danger).
    final fg = t.ink;
    switch (m.special) {
      case 'sticker':
        return Text((e['emoji'] ?? '🙂').toString(), style: const TextStyle(fontSize: 46));
      case 'loc':
        return GestureDetector(
          onTap: () => launchUrl(Uri.parse('https://maps.google.com/?q=${e['lat']},${e['lng']}'),
              mode: LaunchMode.externalApplication),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.mapPin(PhosphorIconsStyle.fill), color: AD.danger, size: 20),
            const SizedBox(width: 6),
            Text('Location · open in Maps', style: ADText.rowName(c: AD.iconSearch)),
          ]),
        );
      case 'live':
        {
          final id = (e['id'] ?? '').toString();
          final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
          final s = _live.putIfAbsent(
            id,
            () => LiveLocationSession(
              id: id,
              lat: (e['lat'] as num?)?.toDouble() ?? 0,
              lng: (e['lng'] as num?)?.toDouble() ?? 0,
              until: (e['until'] as num?)?.toInt() ?? now,
              mine: m.me,
              name: (e['name'] ?? widget.chat.name).toString(),
            ),
          );
          return _liveBubble(s);
        }
      case 'card':
        return Row(mainAxisSize: MainAxisSize.min, children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: t.border, width: 2),
            ),
            child: Avatar(seed: (e['uid'] ?? 'c').toString(), name: (e['name'] ?? '').toString(), size: 36),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((e['name'] ?? 'Contact').toString(), style: ADText.rowName(c: fg)),
            GestureDetector(onTap: () => _addSharedContact(e),
                child: Text('ADD CONTACT', style: ADText.bubbleMeta(c: t.play))),
          ]),
        ]);
      case 'gcall':
        // Call start/end system row — Join affordance while the call is live.
        final audio = e['kind'] == 'audio';
        return GestureDetector(
          onTap: _confLive ? () => _groupCall(!audio) : null,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(
                audio
                    ? PhosphorIcons.phone(PhosphorIconsStyle.fill)
                    : PhosphorIcons.videoCamera(PhosphorIconsStyle.fill),
                size: 17, color: AD.online),
            const SizedBox(width: 6),
            Text(audio ? 'Audio call' : 'Video call', style: ADText.rowName(c: fg)),
            if (_confLive) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                    color: AD.online,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: t.border, width: 2)),
                child: Text('JOIN', style: ADText.bubbleMeta(c: t.meta)),
              ),
            ],
          ]),
        );
      case 'poll':
        final options = (e['options'] as List?)?.map((x) => x.toString()).toList() ?? [];
        final multi = e['multi'] == true;
        // Total votes = distinct voters across options (a multi voter counts once
        // toward the "N votes" label). Percentage bars use per-option share of the
        // largest single-option count so bars stay comparable in multi polls.
        final voters = <String>{};
        for (final s in m.pollBy.values) voters.addAll(s);
        final totalVoters = voters.isNotEmpty ? voters.length : m.pollVotes.values.fold<int>(0, (a, b) => a + b);
        return ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 200),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((e['q'] ?? 'Poll').toString(), style: ADText.rowName(c: fg)),
            if (multi) Padding(padding: const EdgeInsets.only(top: 2),
              child: Text('Select one or more', style: ADText.bubbleMeta(c: t.meta))),
            const SizedBox(height: 8),
            for (var i = 0; i < options.length; i++)
              Builder(builder: (_) {
                final count = m.pollVotes[i] ?? 0;
                final maxCount = m.pollVotes.values.fold<int>(0, (a, b) => a > b ? a : b);
                final frac = maxCount > 0 ? count / maxCount : 0.0;
                final mine = m.pollMine.contains(i);
                final pct = totalVoters > 0 ? (count * 100 / totalVoters).round() : 0;
                return GestureDetector(
                  onTap: () => _vote(m, i),
                  onLongPress: (_isGroup && (m.pollBy[i]?.isNotEmpty ?? false)) ? () => _showPollVoters(options[i], m.pollBy[i]!) : null,
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 6),
                    decoration: BoxDecoration(
                        border: Border.all(color: mine ? AD.primaryBadge : t.border, width: 2),
                        borderRadius: BorderRadius.circular(10)),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Stack(children: [
                        // Percentage bar fill.
                        Positioned.fill(child: FractionallySizedBox(
                          alignment: Alignment.centerLeft, widthFactor: frac.clamp(0.0, 1.0),
                          child: Container(color: (mine ? AD.primaryBadge : t.border).withValues(alpha: 0.35)))),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          child: Row(children: [
                            if (mine) Padding(padding: const EdgeInsets.only(right: 6),
                              child: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 15, color: AD.primaryBadge)),
                            Expanded(child: Text(options[i],
                              style: ADText.bubbleBody(c: fg).copyWith(fontWeight: mine ? FontWeight.w700 : FontWeight.w500))),
                            Text('$pct%', style: ADText.bubbleMeta(c: t.meta)),
                          ]),
                        ),
                      ]),
                    ),
                  ),
                );
              }),
            Padding(padding: const EdgeInsets.only(top: 2),
              child: Text(
                totalVoters == 0 ? 'Tap to vote' : '$totalVoters ${totalVoters == 1 ? 'vote' : 'votes'}'
                    '${m.pollMine.isNotEmpty ? ' · tap again to change' : ''}',
                style: ADText.bubbleMeta(c: t.meta))),
          ]),
        );
      case 'marketplace_deal':
        return _MarketplaceDealCard(extra: e);
      case 'recept':
        return _ReceptionistCard(
          extra: e,
          sessionId: (e['session_id'] ?? e['sid'] ?? '').toString(),
        );
      // WP6 (Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §6):
      // callee-side business-call records. Caller sees none of this — these
      // envelopes are only ever synced to the callee's own thread.
      case 'voicemail':
        if (!RemoteConfig.voicemailBot) return Text(m.text, style: ADText.bubbleBody(c: fg));
        return VoicemailCard(extra: e);
      case 'agent_transcript':
        if (!RemoteConfig.voiceAgent) return Text(m.text, style: ADText.bubbleBody(c: fg));
        return AgentTranscriptCard(
          extra: e,
          onReply: (callerNumber, callerName) {
            // "Reply" (§6): this thread already IS the callee's channel to the
            // caller (business calls sync into a normal per-caller thread with
            // special bubbles) — jump into the composer to start a real
            // back-and-forth, same affordance used elsewhere in this screen.
            Analytics.capture('business_thread_reply_started', {
              'caller_number': callerNumber,
            });
            _composerFocus.requestFocus();
          },
        );
      case 'ava':
      case 'ava_private':
        // Ava's turn. The feminine bubble + "AVA" label are applied in _bubble;
        // here we render her answer as light markdown (bold, numbered lists,
        // bullets, headings) so structured results (e.g. an email digest) look
        // clean instead of showing raw ** and 1. markers.
        final body = (e['text'] ?? e['body'] ?? m.text).toString();
        // In-chat email: when the turn carried structured inbox cards, render the
        // AvaTOK email UI (View / Spam / Delete + read→reply overlay) under the
        // lead line instead of plain text.
        final inbox = AvaInboxEmail.listFrom(e['emails']);
        if (inbox.isNotEmpty) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
            EmailInboxCards(emails: inbox),
          ]);
        }
        // Generated image (e.g. "create an image of …"). The public image URL
        // rides in the envelope (media_ref) so it renders even though the
        // separate media_ref column is dropped during sync — that drop was why
        // Ava's image turns showed the caption but never the picture.
        final mediaRef = (e['media_ref'] ?? '').toString();
        if (mediaRef.isNotEmpty) {
          return _avaImageBubble(mediaRef, body, fg);
        }
        // GenUI/A2UI surface (generic): the agent composed a layout from our Zine
        // catalog (calendar today, any tool tomorrow). Rendered natively.
        final a2ui = e['a2ui'];
        if (a2ui is Map) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (body.isNotEmpty)
              Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
            AvaA2uiSurface(
              surface: a2ui.cast<String, dynamic>(),
              onPrompt: (t) { if (onSummonAva != null) onSummonAva!('$_avaWakeWord $t'); },
              onComposio: _onGenuiComposio,
            ),
          ]);
        }
        return _avaRich(body, fg);
      default:
        return Text(m.text, style: ADText.bubbleBody(c: fg));
    }
  }

  /// Lightweight markdown renderer for Ava's bubbles (no extra dependency).
  /// Handles: # headings, **bold**, `code`, numbered lists (1.) and bullets
  /// (- / *), and blank-line spacing — enough to make digests/results look neat.
  Widget _avaRich(String text, Color fg) {
    // [AVA-FONT-1] (owner request 2026-07-10) Ava's replies read too small at
    // 13.5 — bumped to 15 (headings scale with it below).
    final base = ADText.bubbleBody(c: fg).copyWith(height: 1.34);
    final lines = text.replaceAll('\r\n', '\n').split('\n');
    final out = <Widget>[];
    final numRe = RegExp(r'^\s*(\d+)\.\s+(.*)$');
    final bulRe = RegExp(r'^\s*[-*]\s+(.*)$');
    final headRe = RegExp(r'^#{1,6}\s+(.*)$');
    for (final raw in lines) {
      final line = raw.trimRight();
      if (line.trim().isEmpty) { out.add(const SizedBox(height: 7)); continue; }
      final head = headRe.firstMatch(line);
      final num = numRe.firstMatch(line);
      final bul = bulRe.firstMatch(line);
      if (head != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(top: 2, bottom: 3),
          child: _avaInline(head.group(1)!, base.copyWith(fontWeight: FontWeight.w800, fontSize: 16)),
        ));
      } else if (num != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            SizedBox(width: 22, child: Text('${num.group(1)}.',
                style: base.copyWith(fontWeight: FontWeight.w800, color: AD.iconSearch))),
            Expanded(child: _avaInline(num.group(2)!, base)),
          ]),
        ));
      } else if (bul != null) {
        out.add(Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Padding(padding: const EdgeInsets.only(left: 2, right: 8, top: 1),
                child: Text('•', style: base.copyWith(fontWeight: FontWeight.w800, color: AD.iconSearch))),
            Expanded(child: _avaInline(bul.group(1)!, base)),
          ]),
        ));
      } else {
        out.add(_avaInline(line, base));
      }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: out);
  }

  /// Render inline **bold** and `code` spans within one line.
  Widget _avaInline(String text, TextStyle base) {
    final spans = <TextSpan>[];
    final re = RegExp(r'\*\*(.+?)\*\*|`([^`]+?)`');
    var i = 0;
    for (final mt in re.allMatches(text)) {
      if (mt.start > i) spans.add(TextSpan(text: text.substring(i, mt.start)));
      if (mt.group(1) != null) {
        spans.add(TextSpan(text: mt.group(1), style: base.copyWith(fontWeight: FontWeight.w800)));
      } else {
        spans.add(TextSpan(text: ' ${mt.group(2)} ',
            style: base.copyWith(fontFeatures: const [], backgroundColor: AD.mediaPlaceholderBg)));
      }
      i = mt.end;
    }
    if (i < text.length) spans.add(TextSpan(text: text.substring(i)));
    return RichText(text: TextSpan(style: base, children: spans.isEmpty ? [TextSpan(text: text)] : spans));
  }

  /// True when this message is one of Ava's persisted bubble kinds. Uses the
  /// Phase 0 contract (app/lib/core/ava_contracts.dart) so the kind strings stay
  /// in one place.
  bool _isAvaBubble(_Msg m) => AvaKind.isBubble(m.special);

  // [AVAGRP-BUBBLE-1] `_groupSenderTint`/`_groupTints` are GONE — they hashed
  // the display NAME (reshuffled a member's colour if they renamed themselves)
  // and only ever changed the fill, leaving the ink hardcoded to
  // `AD.bubbleInInk` with undefined contrast on most of the 6 tints. Per-sender
  // colour now comes from `resolveBubbleTheme(senderKey: m.senderPub)` in
  // `bubble_theme.dart`, keyed on the STABLE uid and carrying a matched
  // ink/meta/play/border set for every tint. See `_bubble` / `_bubbleTheme`.

  /// The inline "Ava is working…" chip row (kind 'ava_status'). Not a normal
  /// bubble — a subtle lilac pill with a tiny spinner. Generic: any phase that
  /// posts an 'ava_status' frame gets this with no extra UI work.
  Widget _avaStatusChip(_Msg m) {
    final label = (m.extra?['label'] ?? m.text).toString();
    // Image generation gets a ChatGPT-style inline placeholder (a blank, image-
    // shaped card with a spinner) instead of the small text pill. It auto-
    // collapses when the finished image (a normal ava media_ref message) arrives
    // and this transient 'ava_status' chip is dropped.
    final isImage = (m.extra?['source'] ?? '').toString() == 'image' ||
        label.toLowerCase().contains('generating an image');
    if (isImage) return _imageGeneratingCard(label);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: AD.bubbleInBg,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.bubbleInInk, width: 1),
          boxShadow: const [],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(width: 12, height: 12,
              child: CircularProgressIndicator(strokeWidth: 1.6, color: AD.bubbleInInk)),
          const SizedBox(width: 8),
          Text(label.isEmpty ? 'Ava is working…' : label,
              style: ADText.bubbleBody(c: AD.bubbleInInk)
                  .copyWith(fontStyle: FontStyle.italic)),
        ]),
      ),
    );
  }

  /// ChatGPT-style placeholder shown WHILE Ava generates an image: a blank,
  /// image-shaped card with a spinner and a status line. Replaced by the real
  /// picture (a normal ava media_ref bubble) when generation finishes.
  Widget _imageGeneratingCard(String label) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        width: 240,
        height: 200,
        decoration: BoxDecoration(
          color: AD.bubbleInBg,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AD.bubbleInInk, width: 1),
          boxShadow: const [],
        ),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          PhosphorIcon(PhosphorIcons.image(PhosphorIconsStyle.duotone),
              size: 34, color: AD.bubbleInInk),
          const SizedBox(height: 14),
          const SizedBox(
              width: 20, height: 20,
              child: CircularProgressIndicator(strokeWidth: 2, color: AD.bubbleInInk)),
          const SizedBox(height: 12),
          Text(label.isEmpty ? 'Generating image…' : label,
              style: ADText.bubbleBody(c: AD.bubbleInInk)
                  .copyWith(fontStyle: FontStyle.italic)),
        ]),
      ),
    );
  }

  /// A finished Ava image bubble: the picture, tappable to open full-screen, with
  /// a ⋮ overflow menu (Open / Download full-res / Share) in the top-right corner.
  Widget _avaImageBubble(String mediaRef, String body, Color fg) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (body.isNotEmpty)
        Padding(padding: const EdgeInsets.only(bottom: 8), child: _avaRich(body, fg)),
      ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(children: [
          GestureDetector(
            onTap: () => _openImageFull(mediaRef),
            // Disk-cached so it loads instantly on reopen (no re-download).
            child: CachedImage(mediaRef, width: 240),
          ),
          Positioned(
            top: 6,
            right: 6,
            child: DecoratedBox(
              decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
              child: PopupMenuButton<String>(
                tooltip: 'Image options',
                icon: const Icon(Icons.more_vert, size: 18, color: Colors.white),
                padding: EdgeInsets.zero,
                onSelected: (v) {
                  if (v == 'open') _openImageFull(mediaRef);
                  if (v == 'download') _downloadImage(mediaRef);
                  if (v == 'share') _downloadImage(mediaRef, share: true);
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'open', child: Text('Open')),
                  PopupMenuItem(value: 'download', child: Text('Download full-res')),
                  PopupMenuItem(value: 'share', child: Text('Share')),
                ],
              ),
            ),
          ),
        ]),
      ),
    ]);
  }

  /// Full-screen, pinch-to-zoom view of a generated image.
  void _openImageFull(String url) {
    showDialog<void>(
      context: context,
      builder: (dctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(children: [
          InteractiveViewer(
            minScale: 0.8,
            maxScale: 4,
            child: Center(
              child: Image.network(AvatarCache.sizedUrl(url, 1600),
                  errorBuilder: (_, __, ___) => const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Image unavailable',
                          style: TextStyle(color: Colors.white)))),
            ),
          ),
          Positioned(
            top: 8, right: 8,
            child: IconButton(
              icon: const Icon(Icons.close, color: Colors.white),
              onPressed: () => Navigator.of(dctx).maybePop(),
            ),
          ),
        ]),
      ),
    );
  }

  /// Full-screen, pinch-to-zoom view of a DECRYPTED chat photo (received or
  /// sent). Tap any photo bubble to open it in-session; an X closes it and a
  /// copy button puts the image on the clipboard so it can be pasted elsewhere.
  void _openImageBytes(Uint8List bytes, {String? mime}) {
    Analytics.capture('chat_image_open', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'size': bytes.length,
    });
    showDialog<void>(
      context: context,
      barrierColor: Colors.black,
      builder: (dctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: EdgeInsets.zero,
        child: Stack(children: [
          Positioned.fill(
            child: InteractiveViewer(
              minScale: 0.8,
              maxScale: 5,
              child: Center(child: Image.memory(bytes, errorBuilder: (_, __, ___) => const SizedBox.shrink())),
            ),
          ),
          // X — close the viewer.
          Positioned(
            top: 40, right: 8,
            child: _viewerButton(Icons.close, 'Close',
                () => Navigator.of(dctx).maybePop()),
          ),
          // Copy the image to the system clipboard (paste into any app).
          Positioned(
            top: 40, left: 8,
            child: _viewerButton(Icons.copy, 'Copy',
                () => _copyImageBytes(bytes, mime: mime)),
          ),
        ]),
      ),
    );
  }

  Widget _viewerButton(IconData icon, String tooltip, VoidCallback onTap) =>
      DecoratedBox(
        decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
        child: IconButton(
          tooltip: tooltip,
          icon: Icon(icon, color: Colors.white),
          onPressed: onTap,
        ),
      );

  /// Put a chat image on the system clipboard so it can be pasted into another
  /// app. Flutter's built-in Clipboard is text-only, so this uses super_clipboard
  /// (Formats.png / Formats.jpeg). Degrades gracefully where unsupported.
  Future<void> _copyImageBytes(Uint8List bytes, {String? mime}) async {
    final clipboard = SystemClipboard.instance;
    if (clipboard == null) {
      _capNote('Copying images isn’t supported on this device.');
      return;
    }
    // Label by real format: PNG magic (‰PNG) or the declared mime, else JPEG.
    final isPng = (mime?.toLowerCase().contains('png') ?? false) ||
        (bytes.length > 4 && bytes[0] == 0x89 && bytes[1] == 0x50 &&
            bytes[2] == 0x4E && bytes[3] == 0x47);
    try {
      final item = DataWriterItem();
      item.add(isPng ? Formats.png(bytes) : Formats.jpeg(bytes));
      await clipboard.write([item]);
      HapticFeedback.selectionClick();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Image copied'), duration: Duration(seconds: 1)));
      }
      Analytics.capture('chat_image_copied', {
        'mime': isPng ? 'image/png' : 'image/jpeg',
        'size': bytes.length,
      });
    } catch (e) {
      _capNote('Couldn’t copy the image.');
      Analytics.capture('chat_image_copy_failed', {'err': e.toString()});
    }
  }

  /// Load a message's image bytes and copy it to the clipboard. Handles both a
  /// real chat photo (cached or decrypt) and an Ava-generated image (fetched
  /// from its public `media_ref` URL).
  Future<void> _copyImageFromMsg(_Msg m) async {
    Uint8List? bytes = m.localBytes;
    String? mime = m.media?.contentType;
    if (bytes == null && m.media != null) {
      bytes = await MediaService.downloadAndDecrypt(m.media!);
    }
    if (bytes == null) {
      final url = _imageRefOf(m);
      if (url.isNotEmpty) {
        try {
          final res = await http.get(Uri.parse(url));
          if (res.statusCode == 200) {
            bytes = res.bodyBytes;
            mime = res.headers['content-type'] ?? mime;
          }
        } catch (_) {}
      }
    }
    if (bytes == null) { _capNote('Could not load this image.'); return; }
    if (m.media != null) m.localBytes = bytes; // cache real chat media only
    await _copyImageBytes(bytes, mime: mime);
  }

  /// Download the FULL-RESOLUTION image (the stored public URL is already the
  /// full-res PNG; the in-chat preview is just display-sized) and hand it to the
  /// OS share sheet so the user can save it to Photos or send it on.
  Future<void> _downloadImage(String url, {bool share = false}) async {
    try {
      final res = await http.get(Uri.parse(url));
      if (res.statusCode != 200) throw 'http ${res.statusCode}';
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/ava_image_${DateTime.now().millisecondsSinceEpoch}.png');
      await f.writeAsBytes(res.bodyBytes, flush: true);
      await Share.shareXFiles([XFile(f.path)], subject: 'Ava image');
      Analytics.capture('ava_image_download', {'ok': true, 'share': share});
    } catch (e) {
      Analytics.capture('ava_image_download', {'ok': false, 'error': e.toString()});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't download the image")));
      }
    }
  }

  /// Export a chat media message (image / video / file / voice note) to the OS
  /// share sheet so it can be sent to WhatsApp, Files, etc. Decrypts/loads the
  /// bytes on-device, writes a temp file with a sensible name + extension, and
  /// hands it to share_plus. This is what was missing for voice recordings —
  /// Forward only sent in-app; there was no way OUT to another app.
  Future<void> _shareMedia(_Msg m) async {
    try {
      Uint8List? bytes = m.localBytes;
      if (bytes == null && m.media != null) {
        bytes = await MediaService.downloadAndDecrypt(m.media!);
      }
      if (bytes == null) { _capNote('Could not load this attachment to share.'); return; }
      final ct = m.media?.contentType ?? '';
      // [AVAVM-PLAYER-1] Same guessing bug as `_mediaContent` — prefer the
      // real `pendingKind` stamped at send time over inferring `image` from
      // `localBytes != null` alone (wrong for an in-flight voice note/video).
      final kind = m.media?.kind ?? m.pendingKind ??
          (m.localBytes != null ? MediaKind.image : MediaKind.file);
      final ext = _extFor(ct, kind);
      final base = (m.media?.name ?? '').trim();
      final safe = base.isNotEmpty && base.contains('.')
          ? base
          : 'avatok_${DateTime.now().millisecondsSinceEpoch}$ext';
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/$safe');
      await f.writeAsBytes(bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: ct.isEmpty ? null : ct)]);
      Analytics.capture('chat_media_shared_out', {'kind': kind.name, 'ok': true});
    } catch (e) {
      Analytics.capture('chat_media_shared_out', {'ok': false, 'error': e.toString()});
      if (mounted) _capNote('Couldn’t share this attachment.');
    }
  }

  /// Pick a file extension from a content type, falling back to the media kind.
  static String _extFor(String contentType, MediaKind kind) {
    final ct = contentType.toLowerCase();
    if (ct.contains('png')) return '.png';
    if (ct.contains('jpeg') || ct.contains('jpg')) return '.jpg';
    if (ct.contains('gif')) return '.gif';
    if (ct.contains('webp')) return '.webp';
    if (ct.contains('mp4') && kind == MediaKind.audio) return '.m4a';
    if (ct.contains('mp4')) return '.mp4';
    if (ct.contains('quicktime') || ct.contains('mov')) return '.mov';
    if (ct.contains('wav')) return '.wav';
    if (ct.contains('mpeg') && kind == MediaKind.audio) return '.mp3';
    if (ct.contains('mp3')) return '.mp3';
    if (ct.contains('ogg') || ct.contains('opus')) return '.ogg';
    if (ct.contains('pdf')) return '.pdf';
    switch (kind) {
      case MediaKind.image: return '.jpg';
      case MediaKind.video: return '.mp4';
      case MediaKind.audio: return '.m4a';
      case MediaKind.file: return '';
    }
  }

  Future<void> _addSharedContact(Map e) async {
    final uid = (e['uid'] ?? '').toString();
    if (!uid.startsWith('user_')) return;
    await ContactsStore().add(Contact(uid: uid, name: (e['name'] ?? 'Contact').toString(), handle: (e['handle'] ?? '').toString()));
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${e['name']} added')));
  }

  Future<void> _sendMedia(MediaKind kind, Uint8List bytes, String ct, String name, {String caption = ''}) async {
    // Stamp the message with a real send time. Without this it defaulted to ts=0,
    // so any list re-sort floated the bubble to the very TOP of the thread and it
    // appeared to "disappear" from the bottom where it was just added.
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final tShownStart = DateTime.now().millisecondsSinceEpoch;
    final msg = _Msg(_seq++, true, _caption(kind, name), _fmtTime(now),
        ts: now, localBytes: bytes, uploading: true, mediaCaption: caption,
        pendingKind: kind) // [AVAVM-PLAYER-1] real kind, known before `media` exists
      ..sendStartedMs = tShownStart; // [AVA-CHAT-INSTANT] round-trip anchor
    setState(() => _msgs.add(msg));
    _jump();
    // [AVA-CHAT-INSTANT] Heavy media shows its bubble (local preview + uploading
    // clock) instantly, BEFORE the upload — record how fast (email auto-attached).
    Analytics.capture('msg_optimistic_shown', {
      'kind': kind.name, 'conv_kind': _isGroup ? 'group' : 'dm',
      'ms_to_bubble': DateTime.now().millisecondsSinceEpoch - tShownStart,
      'size': bytes.length,
    });
    // [ONEBRAIN-B3-APP] The cloud File Search push of raw file bytes
    // (RagService.ingestFileBytes) was CUT (B-D2). Server-readable file indexing
    // is the `files` domain via the AvaLibrary/upload pipeline; here we keep only
    // an ON-DEVICE descriptor so "@ava find the logo I sent" / "the video about
    // X" resolves by name offline even when the bytes aren't text-extractable
    // (video/audio) or the content lacks the words the user searches by.
    final descr = StringBuffer('Shared a ${kind.name} named "$name"');
    if (caption.trim().isNotEmpty) descr.write(' — note: ${caption.trim()}');
    // ignore: unawaited_futures
    AvaLocalBrain.I.ingest(
      domain: 'files',
      kind: 'chat_file',
      text: descr.toString(),
      meta: {'convKey': 'file:${widget.chat.name}'},
      ts: now,
      sourceId: 'chatfile_${DateTime.now().microsecondsSinceEpoch}',
    );
    Analytics.capture('chat_media_sent', {
      'kind': kind.name,
      'has_caption': caption.trim().isNotEmpty,
      'size': bytes.length,
      'conv_kind': _isGroup ? 'group' : 'dm',
    });
    await _upload(msg, bytes, kind, ct, name, caption: caption);
  }

  Future<void> _upload(_Msg msg, Uint8List bytes, MediaKind kind, String ct, String name, {String caption = ''}) async {
    setState(() { msg.uploading = true; msg.failed = false; });
    try {
      // [CHAT-UPLOAD-1] A live 1:1 call shares this device's uplink. Encrypt off
      // the main thread + pace the ciphertext PUT so the upload never starves
      // WebRTC (which previously forced both-sides reconnects). Full speed off-call.
      final live = CallSessionManager.instance.current;
      final inCall = live != null && !live.isEnded;
      final m = await MediaService.encryptAndUpload(bytes, kind: kind, contentType: ct, name: name, caption: caption, inCall: inCall);
      if (!mounted) return;
      setState(() { msg.media = m; msg.uploading = false; });
      final keyShort = m.id.length > 12 ? m.id.substring(m.id.length - 8) : m.id;
      // Deliver the media reference + key inside an encrypted DM / group fan-out.
      if (_isGroup && _gdm != null) {
        final id = _gdm!.send(jsonEncode({...m.toEnvelope(), 't': 'gmedia', 'gid': _group!.id, 'fromName': _fromNameTag}));
        msg.evId = id;
        _seenEv.add(id);
        Analytics.capture('group_message_sent', {
          'gid': _group!.id, 'member_count': _group!.members.length, 'kind': kind.name,
        });
        AvaLog.I.log('media', 'sent gmedia kind=${kind.name} ${bytes.length}B key=…$keyShort rumor=${id.length >= 8 ? id.substring(0, 8) : id}');
      } else if (_realMode && _dm != null) {
        final id = _dm!.send(jsonEncode(m.toEnvelope()));
        msg.evId = id;
        _seenEv.add(id);
        AvaLog.I.log('media', 'sent dm media kind=${kind.name} ${bytes.length}B key=…$keyShort rumor=${id.length >= 8 ? id.substring(0, 8) : id}');
      }
      _schedulePersist(); // cache the media message so it survives reopen
    } catch (e) {
      if (!mounted) return;
      AvaLog.I.log('media', 'send media FAILED kind=${kind.name}: $e');
      setState(() { msg.uploading = false; msg.failed = true; });
    }
  }

  // STREAM E — GIPHY send (Tenor→GIPHY migration). Download the full media bytes
  // from GIPHY's CDN, then push them through the SAME encrypted media pipeline as
  // any photo so the recipient fetches from R2 (never GIPHY). No fork of the
  // upload path. Routing by GIPHY content type:
  //   • clip  → video message (mp4 WITH sound)
  //   • sticker / text / emoji → bubble-less sticker (kind:"sticker" via name tag)
  //   • gif   → animated media (image/gif or webp)
  Future<void> _sendGif(GifResult g) async {
    // ignore: unawaited_futures
    PickerRecentsStore.I.pushGif(g.toRecent());
    Analytics.capture('giphy_selected', {
      'content_type': g.contentType.wire,
      'conv_kind': _isGroup ? 'group' : 'dm',
    });
    Analytics.capture('gif_sent', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'query_len': g.desc.length,
      'content_type': g.contentType.wire,
    });
    final bytes = await GifApi.download(g.url);
    if (!mounted) return;
    if (bytes == null || bytes.isEmpty) { _capNote("Couldn't send GIF"); return; }
    if (bytes.length > _kMediaMaxBytes) { _capNote('That GIF is too large'); return; }

    final lowerUrl = g.url.toLowerCase();
    switch (g.contentType) {
      case GifContentType.clip:
        // Clips = GIF WITH SOUND → send as a video message.
        await _sendMedia(
          MediaKind.video, bytes, 'video/mp4', 'giphy-${g.id}.mp4');
        return;
      case GifContentType.sticker:
      case GifContentType.text:
      case GifContentType.emoji:
        // Transparent WebP/GIF → render bubble-less at 160dp (Stream E sticker
        // path). Reuse the sticker name tag so the bubble builder detects it.
        final isGif = lowerUrl.contains('.gif');
        await _sendMedia(
          MediaKind.image,
          bytes,
          isGif ? 'image/gif' : 'image/webp',
          stickerMediaName('giphy/${g.id}.${isGif ? 'gif' : 'webp'}'),
        );
        return;
      case GifContentType.gif:
        final isMp4 = lowerUrl.contains('.mp4');
        final isWebp = lowerUrl.contains('.webp');
        await _sendMedia(
          isMp4 ? MediaKind.video : MediaKind.image,
          bytes,
          isMp4 ? 'video/mp4' : (isWebp ? 'image/webp' : 'image/gif'),
          'giphy-${g.id}.${isMp4 ? 'mp4' : (isWebp ? 'webp' : 'gif')}',
        );
        return;
    }
  }

  // STREAM E — sticker send. Load the bundled .webp bytes and send through the
  // encrypted media pipeline, tagging the media name so the message can render
  // as a bubble-less 160dp sticker (see sticker_media.dart). Reuses _sendMedia.
  Future<void> _sendStickerAsset(String assetPath) async {
    // ignore: unawaited_futures
    PickerRecentsStore.I.pushSticker(assetPath);
    Analytics.capture('sticker_sent', {
      'conv_kind': _isGroup ? 'group' : 'dm',
      'pack': assetPath.split('/').length > 2 ? assetPath.split('/')[2] : 'unknown',
    });
    try {
      final data = await rootBundle.load(assetPath);
      final bytes = data.buffer.asUint8List();
      if (!mounted) return;
      await _sendMedia(
          MediaKind.image, bytes, 'image/webp', stickerMediaName(assetPath));
    } catch (_) {
      if (mounted) _capNote("Couldn't send sticker");
    }
  }

  // Upload caps (owner rule): photos/videos ≤ 25 MB each; ≤ 8 photos per pick.
  static const int _kMediaMaxBytes = 25 * 1024 * 1024;
  static const int _kMaxPhotosPerPick = 8;

  void _capNote(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // Camera → one photo. (Gallery multi-select uses _pickPhotos.)
  Future<void> _pickImage(ImageSource source) async {
    final x = await _picker.pickImage(source: source, imageQuality: 85);
    if (x == null) return;
    final bytes = await x.readAsBytes();
    if (bytes.length > _kMediaMaxBytes) { _capNote('That photo is over 25 MB — please pick a smaller one.'); return; }
    await _sendImageWithCaption(bytes, 'image/jpeg', x.name);
  }

  // Photo caption step: preview the picked image and let the user "say something
  // about the pic" before it goes out. WhatsApp-style: the caption rides INSIDE
  // the photo's own message envelope, so the picture + its text are ONE bubble.
  // This is what lets Ava link an "@ava send this as email" instruction to the
  // photo it refers to — previously the caption went out as a SEPARATE text
  // message, so by the time Ava processed the request the attachment wasn't tied
  // to it and she'd ask "where's the photo / what's its S3 key?".
  /// The composer text was carried into an attachment's caption — clear it so it
  /// is NOT also sent as a separate text message (the "splits into two" bug).
  void _consumeComposer(String seed) {
    if (seed.isEmpty) return;
    setState(() { _ctrl.clear(); _hasText = false; });
    if (_convKey != null) DraftStore().set(_convKey!, '');
  }

  Future<void> _sendImageWithCaption(Uint8List bytes, String ct, String name) async {
    // WhatsApp-style: if the user already typed something in the composer, carry
    // it INTO the caption field (seed) instead of sending it as a separate text
    // message. This is the fix for "my message splits into two parts" — the photo
    // and the words now travel as ONE message, so Ava can link the instruction to
    // the attachment.
    final seed = _ctrl.text.trim();
    final caption = await _captionSheet(bytes, initial: seed);
    if (caption == null) return; // user backed out
    _consumeComposer(seed);
    final c = caption.trim();
    // ONE message: photo + caption together (awaits upload + delivery so the
    // attachment is on the InboxDO before we summon Ava below).
    await _sendMedia(MediaKind.image, bytes, ct, name, caption: c);
    if (c.isEmpty) return;
    // Index the caption into the user's own RAG store (same as a normal line),
    // but skip @ava control lines.
    _ragAddLine('You', c);
    // If the caption summons Ava (@ava / #ava / Ava-mode), fire the in-thread
    // turn now — the photo (with this caption) is already on the InboxDO, so the
    // server's recentWindow sees the attachment AND the instruction together.
    if (_editing == null && onSummonAva != null) {
      final lower = c.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      if (atAva || shared || avaModePrivate) {
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $c' : c);
      }
    }
  }

  // ---- clipboard image paste into the composer ----
  /// Read an image off the system clipboard (PNG/JPEG via super_clipboard) and,
  /// if one is present, send it as a photo attachment (with the WhatsApp-style
  /// caption sheet). Returns true when an image was found and handled, so the
  /// caller can skip the normal text-paste fallback. Flutter's built-in
  /// `Clipboard` is text-only — this is what makes "copy an image elsewhere,
  /// paste it into the chat box" actually work.
  Future<bool> _tryPasteImage() async {
    final clipboard = SystemClipboard.instance;
    if (clipboard == null) return false;
    try {
      final reader = await clipboard.read();
      final fmt = reader.canProvide(Formats.png)
          ? Formats.png
          : (reader.canProvide(Formats.jpeg) ? Formats.jpeg : null);
      if (fmt == null) return false;
      final done = Completer<Uint8List?>();
      reader.getFile(fmt, (file) async {
        try {
          done.complete(await file.readAll());
        } catch (_) {
          if (!done.isCompleted) done.complete(null);
        }
      }, onError: (_) {
        if (!done.isCompleted) done.complete(null);
      });
      final bytes = await done.future;
      if (bytes == null || bytes.isEmpty) return false;
      if (bytes.length > _kMediaMaxBytes) {
        Analytics.capture('chat_image_paste_toobig', {'size': bytes.length, 'src': 'clipboard'});
        _capNote('That image is over 25 MB — please copy a smaller one.');
        return true; // we DID find an image; just too big to fall back to text
      }
      final isPng = fmt == Formats.png;
      final mime = isPng ? 'image/png' : 'image/jpeg';
      final ext = isPng ? 'png' : 'jpg';
      Analytics.capture('chat_image_pasted', {'mime': mime, 'size': bytes.length});
      await _sendImageWithCaption(
          bytes, mime, 'pasted_${DateTime.now().millisecondsSinceEpoch}.$ext');
      return true;
    } catch (e) {
      AvaLog.I.log('media', 'paste image failed: $e');
      Analytics.capture('chat_image_paste_failed', {'err': e.toString()});
      return false;
    }
  }

  /// Keyboard / system-clipboard rich-content insertion (Android commitContent).
  /// This is the path Samsung's "super paste" panel and Gboard's image/GIF paste
  /// use — distinct from the toolbar Paste button. The inserted image arrives as
  /// bytes (or a content URI the engine resolves for us), so route it straight to
  /// the photo-with-caption flow, mirroring _tryPasteImage. Falls back to a
  /// clipboard read if the payload is empty.
  Future<void> _onContentInserted(KeyboardInsertedContent content) async {
    try {
      final data = content.data;
      if (data == null || data.isEmpty) {
        // The Samsung "super paste" / blank-editor failure mode: the keyboard
        // announced an image but handed us nothing. Record it, then fall back to
        // reading the clipboard so the paste can still succeed.
        Analytics.capture('chat_image_insert_empty', {'mime': content.mimeType});
        await _tryPasteImage();
        return;
      }
      final bytes = Uint8List.fromList(data);
      if (bytes.length > _kMediaMaxBytes) {
        Analytics.capture('chat_image_paste_toobig', {'size': bytes.length, 'src': 'insert'});
        _capNote('That image is over 25 MB — please use a smaller one.');
        return;
      }
      final mime = content.mimeType.isNotEmpty ? content.mimeType : 'image/png';
      final ext = mime.contains('gif')
          ? 'gif'
          : (mime.contains('png') ? 'png' : (mime.contains('webp') ? 'webp' : 'jpg'));
      Analytics.capture('chat_image_inserted', {'mime': mime, 'size': bytes.length});
      // [CHAT-PASTE-1] keyboard/system commitContent path.
      Analytics.capture('chat_image_pasted', {'via': 'keyboard', 'mime': mime, 'size': bytes.length});
      await _sendImageWithCaption(
          bytes, mime, 'pasted_${DateTime.now().millisecondsSinceEpoch}.$ext');
    } catch (e) {
      AvaLog.I.log('media', 'content insert failed: $e');
      Analytics.capture('chat_image_insert_failed', {'err': e.toString()});
      if (mounted) _capNote("Couldn't paste that image — long-press the box to paste.");
    }
  }

  /// Composer paste entry point used by both the toolbar "Paste" button and the
  /// hardware Cmd/Ctrl+V shortcut. Tries an image first; on miss, falls back to
  /// the normal text paste (insert at the cursor / replace the selection).
  Future<void> _onComposerPaste({String via = 'context_menu'}) async {
    final handledImage = await _tryPasteImage();
    if (handledImage) {
      // [CHAT-PASTE-1] toolbar/context-menu Paste or hardware Cmd/Ctrl+V.
      Analytics.capture('chat_image_pasted', {'via': via});
      return;
    }
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    final base = _ctrl.text;
    final sel = _ctrl.selection;
    final start = sel.start < 0 ? base.length : sel.start;
    final end = sel.end < 0 ? base.length : sel.end;
    final newText = base.replaceRange(start, end, text);
    _ctrl.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: start + text.length),
    );
    _onInputChanged(newText);
  }

  // Bottom sheet: image preview + a caption field. Returns the caption (possibly
  // empty → send with no caption) or null if dismissed without sending.
  Future<String?> _captionSheet(Uint8List bytes, {String initial = ''}) {
    final cap = TextEditingController(text: initial);
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 14, right: 14, top: 14,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 14,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: Image.memory(bytes,
                width: double.infinity,
                height: 280,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink()),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(AD.rInput),
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: cap,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ADText.rowName(),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: 'Add a caption…',
                    hintStyle: ADText.preview(c: AD.textTertiary),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, cap.text)),
          ]),
        ]),
      ),
    ).whenComplete(cap.dispose);
  }

  // Gallery → up to 8 photos in one go; each capped at 25 MB.
  Future<void> _pickPhotos() async {
    final xs = await _picker.pickMultiImage(imageQuality: 85);
    if (xs.isEmpty) return;
    final take = xs.length > _kMaxPhotosPerPick ? xs.sublist(0, _kMaxPhotosPerPick) : xs;
    if (xs.length > _kMaxPhotosPerPick) _capNote('Up to 8 photos at a time — sending the first 8.');
    // Single photo → offer the caption step ("say something about the pic").
    if (take.length == 1) {
      final bytes = await take.first.readAsBytes();
      if (bytes.length > _kMediaMaxBytes) { _capNote('That photo is over 25 MB — please pick a smaller one.'); return; }
      await _sendImageWithCaption(bytes, 'image/jpeg', take.first.name);
      return;
    }
    // Composer text rides as the caption on the FIRST photo (one bubble), so a
    // multi-pick never splits the user's words into a separate message.
    final seed = _ctrl.text.trim();
    var firstSent = true;
    var skipped = 0;
    for (final x in take) {
      final bytes = await x.readAsBytes();
      if (bytes.length > _kMediaMaxBytes) { skipped++; continue; }
      await _sendMedia(MediaKind.image, bytes, 'image/jpeg', x.name,
          caption: firstSent ? seed : '');
      firstSent = false;
    }
    _consumeComposer(seed);
    if (skipped > 0) _capNote('$skipped photo(s) skipped — over the 25 MB limit.');
  }

  // VIDPOL-1: chat videos are transcoded to 720p H.264 on-device, then held to a
  // hard 64 MB cap. Source clips off a modern phone are often 200+ MB; the
  // transcode brings a typical 3–5 min clip well under the cap, and anything
  // still over is rejected with the owner-mandated notice below.
  static const int _kVideoMaxBytes = 64 * 1024 * 1024; // 64 MB (VIDPOL-1/2)
  static const String _kVideoTooBigMsg =
      'Videos are limited to 64 MB (about 3–5 minutes). Trim it and try again.';

  Future<void> _pickVideo(ImageSource source) async {
    // Recording auto-stops at the clip cap; gallery picks an existing clip.
    final x = await _picker.pickVideo(source: source, maxDuration: kVideoClipMax);
    if (x == null) return;
    final inBytes = await x.readAsBytes();
    final inLen = inBytes.length;

    // Compress to 720p H.264 via the platform encoder. Best-effort: if the
    // transcode fails/returns nothing, fall back to the original bytes and let
    // the 64 MB cap below decide.
    Uint8List bytes = inBytes;
    String name = x.name;
    double? durationS;
    if (mounted) _capNote('Optimising video…');
    try {
      final info = await VideoCompress.compressVideo(
        x.path,
        quality: VideoQuality.Res1280x720Quality, // 720p H.264
        deleteOrigin: false,
        includeAudio: true,
      );
      durationS = info?.duration == null ? null : (info!.duration! / 1000.0);
      final outPath = info?.file?.path;
      if (outPath != null) {
        final out = await File(outPath).readAsBytes();
        if (out.isNotEmpty) {
          bytes = out;
          if (!name.toLowerCase().endsWith('.mp4')) name = '$name.mp4';
        }
      }
    } catch (e) {
      AvaLog.I.log('media', 'video compress failed, using original: $e');
    }

    if (bytes.length > _kVideoMaxBytes) {
      _capNote(_kVideoTooBigMsg);
      // Email rides in the envelope (Analytics._base); support can pull why a
      // video never sent, keyed by user + byte size. (VIDPOL telemetry)
      Analytics.capture('video_upload_rejected', {'bytes': bytes.length});
      return;
    }
    Analytics.capture('video_upload_compressed', {
      'in_bytes': inLen,
      'out_bytes': bytes.length,
      if (durationS != null) 'duration_s': durationS,
    });
    await _sendVideoWithCaption(bytes, name);
  }

  // Videos get the same caption/instruction step as photos + files, so any text
  // typed in the composer rides INSIDE the video's message (one bubble) and an
  // `@ava` instruction stays attached to the clip it refers to.
  Future<void> _sendVideoWithCaption(Uint8List bytes, String name) async {
    final seed = _ctrl.text.trim();
    final caption = await _fileCaptionSheet(name, initial: seed, label: 'Video');
    if (caption == null) return;
    _consumeComposer(seed);
    final c = caption.trim();
    await _sendMedia(MediaKind.video, bytes, 'video/mp4', name, caption: c);
    if (c.isEmpty) return;
    _ragAddLine('You', c);
    if (_editing == null && onSummonAva != null) {
      final lower = c.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      if (atAva || shared || avaModePrivate) {
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $c' : c);
      }
    }
  }

  Future<void> _pickFile() async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    await _sendFileWithCaption(f.bytes!, f.name);
  }

  // Files (PDFs, docs…) get the SAME "say something about it" caption step that
  // photos do, so you can explain the file — and, in Ask-Ava mode, the caption
  // is the instruction Ava acts on with the attachment in context. Previously a
  // file went out silently with no way to add text.
  Future<void> _sendFileWithCaption(Uint8List bytes, String name) async {
    final seed = _ctrl.text.trim();
    final caption = await _fileCaptionSheet(name, initial: seed);
    if (caption == null) return; // dismissed
    _consumeComposer(seed);
    final c = caption.trim();
    // ONE message: file + caption together, awaited so the attachment is on the
    // InboxDO before we summon Ava below.
    await _sendMedia(MediaKind.file, bytes, 'application/octet-stream', name, caption: c);
    if (c.isEmpty) return;
    _ragAddLine('You', c);
    if (_editing == null && onSummonAva != null) {
      final lower = c.toLowerCase();
      final shared = lower.contains(_avaShareWord);
      final atAva = lower.contains(_avaWakeWord);
      final avaModePrivate = _avaMode && !shared && !atAva;
      if (atAva || shared || avaModePrivate) {
        // ignore: unawaited_futures
        onSummonAva!(avaModePrivate ? '$_avaWakeWord $c' : c);
      }
    }
  }

  // Compact sheet: a file chip (icon + name) + a caption/instruction field.
  // Returns the caption (possibly empty → send with no text) or null if dismissed.
  Future<String?> _fileCaptionSheet(String name, {String initial = '', String label = 'File'}) {
    final cap = TextEditingController(text: initial);
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 14, right: 14, top: 16,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 14,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AD.card,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AD.borderControl, width: 2),
            ),
            child: Row(children: [
              PhosphorIcon(
                  label == 'Video'
                      ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                      : PhosphorIcons.file(PhosphorIconsStyle.bold),
                  size: 22, color: AD.textPrimary),
              const SizedBox(width: 10),
              Expanded(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName())),
            ]),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: _avaMode ? AD.iconVideo : AD.card,
                  borderRadius: BorderRadius.circular(AD.rInput),
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: cap,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ADText.rowName(),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: _avaMode ? 'Tell Ava about this file…' : 'Add a note…',
                    hintStyle: ADText.preview(c: AD.textTertiary),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, cap.text)),
          ]),
        ]),
      ),
    ).whenComplete(cap.dispose);
  }

  MediaKind _kindFromCategory(String c) => c == 'image'
      ? MediaKind.image
      : c == 'video'
          ? MediaKind.video
          : c == 'audio'
              ? MediaKind.audio
              : MediaKind.file;

  // Browse AvaLibrary and attach an existing file into this chat. The picked
  // file is downloaded and re-sent through the normal media path (so it's
  // encrypted + shared like any attachment).
  Future<void> _addFromLibrary() async {
    final item = await Navigator.push<LibraryItem?>(
        context, MaterialPageRoute(builder: (_) => const LibraryPickerScreen()));
    if (item == null || !mounted) return;
    if (item.displayUrl.isEmpty) { _capNote('This file can\'t be attached from here.'); return; }
    _capNote('Attaching ${item.name}…');
    try {
      final resp = await http.get(Uri.parse(item.displayUrl)).timeout(const Duration(seconds: 60));
      if (resp.statusCode != 200) { _capNote('Could not load that file.'); return; }
      final bytes = resp.bodyBytes;
      final kind = _kindFromCategory(item.category);
      // VIDPOL-1: video is held to the 64 MB policy cap; photos keep the 25 MB cap.
      if (kind == MediaKind.video && bytes.length > _kVideoMaxBytes) {
        _capNote(_kVideoTooBigMsg);
        Analytics.capture('video_upload_rejected', {'bytes': bytes.length});
        return;
      }
      if (kind == MediaKind.image && bytes.length > _kMediaMaxBytes) {
        _capNote('That file is over 25 MB.'); return;
      }
      await _sendMedia(kind, bytes, item.mime, item.name);
    } catch (_) {
      _capNote('Could not attach from library.');
    }
  }

  // ---- mic menu: record audio OR convert voice to text ----
  void _openMicMenu() {
    FocusScope.of(context).unfocus();
    showMicInputSheet(context, options: [
      MicSheetOption(
        icon: PhosphorIcons.microphone(PhosphorIconsStyle.fill),
        color: AD.danger,
        title: 'Record audio',
        subtitle: 'Record a voice note and send it',
        onTap: _toggleRecord,
      ),
      MicSheetOption(
        icon: PhosphorIcons.textT(PhosphorIconsStyle.bold),
        color: AD.online,
        title: 'Convert voice to text',
        subtitle: 'Speak and watch it type into the box',
        onTap: _startVoiceToText,
      ),
    ]);
  }

  // Start on-device Whisper dictation — text fills the composer live as you talk.
  // The Whisper model downloads on first use (the "Preparing…" note shows then).
  Future<void> _startVoiceToText() async {
    if (_sttActive || _sttPreparing) return;
    setState(() => _sttPreparing = true);
    _capNote('Preparing voice-to-text…'); // visible feedback while the model loads
    final session = await AvaOnDeviceStt.I.startDictation(
      lang: 'en',
      onText: (t) {
        if (!mounted) return;
        setState(() {
          _ctrl.text = t;
          _ctrl.selection = TextSelection.collapsed(offset: t.length);
          _hasText = t.trim().isNotEmpty;
        });
      },
    );
    if (!mounted) return;
    setState(() => _sttPreparing = false);
    if (session == null) {
      _capNote('Couldn’t start voice-to-text. Try again, or re-enable Ava Voice in Settings.');
      return;
    }
    setState(() { _sttSession = session; _sttActive = true; });
  }

  Future<void> _stopVoiceToText() async {
    final s = _sttSession;
    if (s == null) return;
    setState(() => _sttActive = false);
    final text = await s.stop();
    if (!mounted) return;
    setState(() {
      if (text.isNotEmpty) {
        _ctrl.text = text;
        _ctrl.selection = TextSelection.collapsed(offset: text.length);
        _hasText = text.trim().isNotEmpty;
      }
      _sttSession = null;
    });
    _composerFocus.requestFocus();
  }

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
  static const int _kRecMaxBars = 46;

  /// Start / stop-and-send. Kept as the mic button's single action.
  Future<void> _toggleRecord() async {
    if (_recording) { await _stopAndSendRecording(); return; }
    if (!await _recorder.hasPermission()) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Microphone permission needed for voice messages')));
      }
      return;
    }
    final dir = await getTemporaryDirectory();
    _recPath = '${dir.path}/vn_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      // Ask the platform for amplitude metering so the live waveform below has
      // something real to draw.
      const RecordConfig(),
      path: _recPath!,
    );
    // [VOICE-REC-1] Hold the screen awake for the whole recording.
    //
    // The owner hit this directly: the screen slept mid-recording, and on a
    // locked device that risks the session being torn down and the take lost.
    // The scenario he named is the one that matters — driving, speaking through
    // a headset, phone untouched in a cradle: the user is producing input
    // continuously, but from the OS's point of view the screen has had no touch
    // for 30s and is idle. It isn't. A recording in progress IS activity, so we
    // say so, exactly like a call does (see call_session.dart).
    //
    // Strictly paired with _releaseRecordingWakelock() on EVERY exit from the
    // recording state (send, cancel, pause-to-background, dispose) — a leaked
    // wakelock is a flat battery.
    try { await WakelockPlus.enable(); } catch (_) {/* unsupported platform */}
    _recAmpSub?.cancel();
    _recAmpSub = _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 80))
        .listen((amp) {
      if (!mounted) return;
      // `current` is dBFS: roughly -60 (silence) → 0 (clipping). Map to 0..1 and
      // give it a floor so a quiet room still shows a living baseline rather
      // than a flat dead line (which would read as "broken").
      final db = amp.current.isFinite ? amp.current : -60.0;
      final level = ((db + 60) / 60).clamp(0.05, 1.0);
      setState(() {
        _recLevels.add(level);
        if (_recLevels.length > _kRecMaxBars) _recLevels.removeAt(0);
      });
    });
    _recTick?.cancel();
    _recTick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || _recPaused) return;
      setState(() => _recElapsed += const Duration(seconds: 1));
    });
    setState(() {
      _recording = true;
      _recPaused = false;
      _recElapsed = Duration.zero;
      _recLevels.clear();
    });
    Analytics.capture('voice_note_record_started', _voiceTelemetry());
  }

  /// Pause / resume — the owner's "am I still recording?" control, and the
  /// mechanism behind auto-pause on backgrounding.
  Future<void> _toggleRecordPause() async {
    if (!_recording) return;
    try {
      if (_recPaused) {
        await _recorder.resume();
        try { await WakelockPlus.enable(); } catch (_) {}
      } else {
        await _recorder.pause();
        // Don't hold the screen awake for a recorder that isn't listening.
        try { await WakelockPlus.disable(); } catch (_) {}
      }
      setState(() => _recPaused = !_recPaused);
      Analytics.capture('voice_note_record_paused', {
        ..._voiceTelemetry(),
        'paused': _recPaused,
        'seconds': _recElapsed.inSeconds,
        'reason': 'user',
      });
    } catch (e) {
      AvaLog.I.log('media', 'voice pause/resume failed: $e');
    }
  }

  /// Discard the take entirely — the bin button. Deliberately does NOT send.
  Future<void> _cancelRecording({String reason = 'user'}) async {
    if (!_recording) return;
    final seconds = _recElapsed.inSeconds;
    // `cancel()` stops the recorder AND deletes the file — the correct call for
    // a discard (`stop()` would leave the abandoned take on disk).
    try { await _recorder.cancel(); } catch (_) {}
    await _endRecordingSession();
    _recPath = null;
    Analytics.capture('voice_note_record_cancelled', {
      ..._voiceTelemetry(), 'seconds': seconds, 'reason': reason,
    });
  }

  Future<void> _stopAndSendRecording() async {
    final seconds = _recElapsed.inSeconds;
    String? path;
    try { path = await _recorder.stop(); } catch (e) {
      AvaLog.I.log('media', 'voice stop failed: $e');
    }
    await _endRecordingSession();
    if (path == null) return;
    final bytes = await File(path).readAsBytes();
    Analytics.capture('voice_note_record_sent', {
      ..._voiceTelemetry(), 'seconds': seconds, 'bytes': bytes.length,
    });
    await _sendMedia(MediaKind.audio, bytes, 'audio/mp4', 'voice.m4a');
  }

  /// The single teardown path for a recording session — every exit routes here
  /// so the wakelock, the metering subscription and the tick can't be orphaned.
  Future<void> _endRecordingSession() async {
    _recAmpSub?.cancel();
    _recAmpSub = null;
    _recTick?.cancel();
    _recTick = null;
    try { await WakelockPlus.disable(); } catch (_) {}
    if (mounted) {
      setState(() {
        _recording = false;
        _recPaused = false;
        _recElapsed = Duration.zero;
        _recLevels.clear();
      });
    } else {
      _recording = false;
      _recPaused = false;
    }
  }

  /// Telemetry tag shared by every voice-note event. Per CLAUDE.md this carries
  /// BOTH ends of the conversation, so either party's email retrieves the
  /// interaction — a voice note is a two-sided event and diagnosing one from a
  /// single device is how you end up looking at the wrong phone.
  /// `Map<String, Object>` (not `dynamic`) to match `Analytics.capture`'s
  /// signature — a `Map<String, dynamic>` would need an implicit downcast, which
  /// Dart 3 rejects. `_myName` is a mutable field so it can't type-promote
  /// inside a null check; the `case final n?` pattern binds it instead.
  Map<String, Object> _voiceTelemetry() => {
        'peer': widget.chat.name,
        'is_group': _isGroup,
        if (_myName case final n?) 'from_name': n,
      };

  /// [AVAVM-PLAYER-1] Stable, globally-unique id for a voice note's playback
  /// track: the server media id once uploaded (content-addressed, matches the
  /// contract's "stable, content-addressed where possible"), else a
  /// conv-scoped fallback for the brief window before upload finishes (that
  /// note is scrubbable/playable locally but not yet resumable across a cold
  /// start under a DIFFERENT id — it gets a real one the moment the upload
  /// completes and `m.media` is set).
  String _audioTrackId(_Msg m) => m.media?.id ?? 'local_${_convKey ?? 'x'}_${m.id}';

  /// Reverse lookup: which (if any) message in THIS thread the shared
  /// service's currently-loaded track belongs to. A linear scan is fine here
  /// — it only runs on a playback-state change, not per frame, and thread
  /// message lists are not large enough for this to matter.
  int? _msgIdForTrackId(String trackId) {
    for (final m in _msgs) {
      if (_audioTrackId(m) == trackId) return m.id;
    }
    return null;
  }

  /// [AVAVM-PLAYER-1] Fired whenever `AudioPlaybackService.I.state` changes —
  /// on play/pause/resume/seek/complete/stop, AND on THIS listener's own
  /// installation (so reopening a thread whose voice note is already playing
  /// in the background — via the mini-player — immediately shows it playing
  /// here too, instead of looking idle until the next tick).
  void _onAudioStateChanged() {
    if (!mounted) return;
    final st = AudioPlaybackService.I.state.value;
    if (st == null) {
      if (_playingAudioId != null || _openAudioId != null) {
        setState(() {
          _playingAudioId = null;
          _openAudioId = null;
        });
      }
      return;
    }
    final msgId = _msgIdForTrackId(st.track.trackId);
    if (msgId == null) {
      // The loaded/playing track belongs to a different thread — nothing of
      // OURS is open, even if something elsewhere is playing.
      if (_playingAudioId != null || _openAudioId != null) {
        setState(() {
          _playingAudioId = null;
          _openAudioId = null;
        });
      }
      return;
    }
    setState(() {
      _openAudioId = msgId;
      _playingAudioId = st.playing ? msgId : null;
      _audioPos = st.position;
      _audioDur = st.duration;
    });
  }

  /// [VOICE-SCRUB-1] Seek the currently-open note. Driven by a tap or drag on
  /// the bubble's waveform — this is the "I only want to hear the end" case the
  /// owner asked for, which was previously impossible: the only gesture on a
  /// voice note was play/pause, so reaching the last 5 seconds of a 3-minute
  /// note meant listening to the first 2:55 of it.
  Future<void> _seekAudio(_Msg m, Duration to) async {
    // Scrubbing works on the OPEN note, playing or paused — pausing to drag the
    // playhead around is the natural gesture, and refusing to seek while paused
    // would make the timeline feel broken exactly when you're using it most.
    if (_openAudioId != m.id) return;
    // Paint the new position immediately rather than waiting for the next
    // position callback, so the red playhead lands under the finger.
    if (mounted) setState(() => _audioPos = to);
    await AudioPlaybackService.I.seek(to);
  }

  /// [AVAVM-PLAYER-1] Voice-note play/pause, now routed through the shared
  /// `AudioPlaybackService` so playback (and the app-wide mini-player) keeps
  /// going after the user navigates away from this thread — previously this
  /// used a per-thread `AudioPlayer()` that died the instant the widget was
  /// disposed, which is exactly the "player stops when I leave the chat"
  /// report this issue fixes.
  Future<void> _playAudio(_Msg m) async {
    final trackId = _audioTrackId(m);
    if (_playingAudioId == m.id) {
      // [VOICE-SCRUB-1] Pause rather than stop — pausing holds the position
      // (including anywhere the user just scrubbed to); `stop()` would zero it.
      await AudioPlaybackService.I.pause();
      return; // _onAudioStateChanged updates _playingAudioId
    }
    // Resume the note that's already loaded in the shared player (paused, or
    // parked where the user scrubbed to) instead of re-downloading, rewriting
    // the temp file and restarting it from 0:00.
    if (_openAudioId == m.id && AudioPlaybackService.I.isCurrent(trackId)) {
      await AudioPlaybackService.I.play(
        track: AudioTrack(
          trackId: trackId,
          title: widget.chat.name,
          subtitle: 'Voice note',
          originRoute: _convKey,
        ),
        bytes: m.localBytes ?? Uint8List(0), // ignored on the resume-in-place path
        startAt: _audioPos,
      );
      await AudioPlaybackService.I.setSpeed(_audioSpeed);
      return;
    }
    try {
      final bytes = m.localBytes ?? (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (bytes == null) return;
      await AudioPlaybackService.I.play(
        track: AudioTrack(
          trackId: trackId,
          title: widget.chat.name,
          subtitle: 'Voice note',
          originRoute: _convKey,
        ),
        bytes: bytes,
      );
      // [UI-BUBBLE-3] honour the chosen playback speed for this note.
      await AudioPlaybackService.I.setSpeed(_audioSpeed);
      Analytics.capture('voice_note_played', {..._voiceTelemetry(), 'speed': _audioSpeed});
    } catch (e) {
      AvaLog.I.log('media', 'voice play failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't play this voice message")));
      }
    }
  }

  /// [UI-BUBBLE-3] Cycle the voice-note playback speed 1x → 1.5x → 2x → 1x. When a
  /// note is currently playing, apply the new rate live.
  void _cycleAudioSpeed() {
    const steps = [1.0, 1.5, 2.0];
    final next = steps[(steps.indexOf(_audioSpeed) + 1) % steps.length];
    setState(() => _audioSpeed = next);
    if (_playingAudioId != null) {
      AudioPlaybackService.I.setSpeed(next);
    }
    Analytics.capture('voice_note_speed', {'speed': next});
  }

  Future<void> _openGroupInfo() async {
    if (widget.chat.gid == null) return;
    final g = await GroupStore().byId(widget.chat.gid!);
    if (g == null || !mounted) return;
    final left = await Navigator.push<bool>(context,
        MaterialPageRoute(builder: (_) => GroupInfoScreen(group: g)));
    if (left == true && mounted) Navigator.pop(context); // left/deleted → close thread
  }

  Future<void> _openVideo(_Msg m) async {
    if (m.media == null && m.localBytes == null) return;
    if (m.media != null) {
      Navigator.push(context, MaterialPageRoute(
          builder: (_) => VideoPlayerScreen(media: m.media!, bytes: m.localBytes)));
    }
  }

  /// The image URL carried by an Ava-generated image bubble (envelope
  /// `media_ref`), or '' if this message isn't one. Lets "Copy image" / viewer
  /// work on Ava images too, which have no `m.media`.
  String _imageRefOf(_Msg m) => (m.extra?['media_ref'] ?? '').toString();

  /// True when the message shows an image — a real chat photo OR an Ava image.
  bool _msgHasImage(_Msg m) =>
      m.media?.kind == MediaKind.image || _imageRefOf(m).isNotEmpty;

  // ---- Phase 5: floating reaction pill (anchored to the bubble) ----
  void _closeReactionOverlay() {
    _reactionOverlay?.remove();
    _reactionOverlay = null;
  }

  // Long-press / right-click a bubble → a floating emoji pill + compact action
  // menu anchored to the touch point (iMessage / WhatsApp style), instead of a
  // bottom sheet. "+" opens the full emoji picker; "More…" opens the full menu.
  void _onBubbleLongPressAt(_Msg m, Offset pos) {
    HapticFeedback.mediumImpact();
    Analytics.capture('chat_reaction_pill_open', {'group': widget.chat.group});
    _closeReactionOverlay();
    final size = MediaQuery.of(context).size;
    const pillW = 312.0;
    final left = pos.dx.clamp(12.0, math.max(12.0, size.width - pillW - 12.0)).toDouble();
    final top = (pos.dy - 64).clamp(90.0, math.max(90.0, size.height - 360.0)).toDouble();
    const quick = ['❤️', '👍', '😂', '😮', '😢', '👏'];
    final hasImage = _msgHasImage(m);

    Widget pillBtn(Widget child, VoidCallback onTap) => GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: child,
          ),
        );

    Widget menuRow(IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
        InkWell(
          onTap: () { _closeReactionOverlay(); onTap(); },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            child: Row(children: [
              Icon(icon, size: 18, color: danger ? AD.danger : AD.textPrimary),
              const SizedBox(width: 12),
              Text(label, style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
            ]),
          ),
        );

    _reactionOverlay = OverlayEntry(builder: (octx) => Stack(children: [
          // Tap anywhere to dismiss.
          Positioned.fill(child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _closeReactionOverlay,
            child: Container(color: Colors.black.withOpacity(0.05)),
          )),
          Positioned(
            left: left, top: top, width: pillW,
            child: Material(
              color: Colors.transparent,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                // Floating emoji pill.
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  decoration: BoxDecoration(
                    color: AD.overlaySheet,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: AD.borderControl, width: 2),
                    boxShadow: const [],
                  ),
                  child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    for (final e in quick)
                      pillBtn(
                        Text(e, style: TextStyle(fontSize: m.reaction == e ? 30 : 26)),
                        () { _closeReactionOverlay(); _react(m, e); },
                      ),
                    // "+" → full emoji picker.
                    pillBtn(
                      Container(
                        width: 30, height: 30, alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: AD.card, shape: BoxShape.circle,
                          border: Border.all(color: AD.borderControl, width: 1.5)),
                        child: PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 15, color: AD.textPrimary),
                      ),
                      () async {
                        _closeReactionOverlay();
                        final picked = await _openEmojiPicker();
                        if (picked != null) {
                          Analytics.capture('chat_react_custom_emoji', {'emoji': picked});
                          _react(m, picked);
                        }
                      },
                    ),
                  ]),
                ),
                const SizedBox(height: 8),
                // Compact action menu.
                Container(
                  decoration: BoxDecoration(
                    color: AD.overlaySheet,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: AD.borderControl, width: 2),
                    boxShadow: const [],
                  ),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    menuRow(PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), 'Reply',
                        () => setState(() => _replyTo = m)),
                    if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                      menuRow(PhosphorIcons.copy(PhosphorIconsStyle.bold),
                          m.media != null ? 'Copy caption' : 'Copy text', () => _copyText(m)),
                    if (hasImage)
                      menuRow(PhosphorIcons.image(PhosphorIconsStyle.bold), 'Copy image',
                          () => _copyImageFromMsg(m)),
                    menuRow(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), 'Forward', () => _forward(m)),
                    menuRow(PhosphorIcons.star(m.starred ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                        m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
                    if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
                      menuRow(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', () => _startEdit(m)),
                    // [AVAGRP-BUBBLE-1 / message-info] WhatsApp only shows "Info"
                    // on YOUR OWN sent messages — never on an incoming bubble.
                    if (m.me && m.ts > 0)
                      menuRow(PhosphorIcons.info(PhosphorIconsStyle.bold), 'Info', () => _showMessageInfo(m)),
                    menuRow(PhosphorIcons.dotsThree(PhosphorIconsStyle.bold), 'More…',
                        () => _onBubbleLongPress(m)),
                  ]),
                ),
              ]),
            ),
          ),
        ]));
    Overlay.of(context).insert(_reactionOverlay!);
  }

  // ---- bubble long-press actions ----
  void _onBubbleLongPress(_Msg m) {
    HapticFeedback.mediumImpact();
    final hasImage = _msgHasImage(m);
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      // Tall menus must be able to grow + scroll; the default sheet clips its
      // child. isScrollControlled lets it size up, the ListView scrolls, and
      // SafeArea keeps the last items clear of the phone's nav bar.
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.8),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            // Fixed header: quick reactions.
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
                for (final e in ['❤️', '👍', '😂', '😮', '😢', '👏'])
                  GestureDetector(
                    onTap: () { Navigator.pop(ctx); _react(m, e); },
                    child: Text(e, style: const TextStyle(fontSize: 28)),
                  ),
              ]),
            ),
            const Divider(height: 24),
            // Scrollable action list — grows with the number of items and
            // scrolls when it can't fit, so nothing hides off-screen.
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 8),
                children: [
                  _action(ctx, PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), 'Reply', () => setState(() => _replyTo = m)),
                  if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                    _action(ctx, PhosphorIcons.copy(PhosphorIconsStyle.bold),
                        m.media != null ? 'Copy caption' : 'Copy text', () => _copyText(m)),
                  // Copy a detected link. When the bubble holds exactly one URL
                  // we copy it straight; with several we pop a small chooser.
                  if (urlSpans(m.text).isNotEmpty)
                    _action(ctx, PhosphorIcons.link(PhosphorIconsStyle.bold),
                        urlSpans(m.text).length > 1 ? 'Copy link…' : 'Copy link',
                        () => _copyLink(m)),
                  // Copy the actual IMAGE to the clipboard (paste into any app).
                  if (hasImage)
                    _action(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Copy image',
                        () => _copyImageFromMsg(m)),
                  _action(ctx, PhosphorIcons.pushPin(PhosphorIconsStyle.bold), 'Pin message', () => _pinMessage(m)),
                  _action(ctx, PhosphorIcons.star(m.starred ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                      m.starred ? 'Unstar' : 'Star', () => _toggleStar(m)),
                  if (m.me && m.evId != null && m.media == null && m.text != 'You deleted this message')
                    _action(ctx, PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), 'Edit', () => _startEdit(m)),
                  // STREAM G [GROUP-AI-5]: inline translate any text bubble into the
                  // user's remembered language (added via the existing _action menu
                  // extension point — no Stream K geometry change).
                  if (m.text.trim().isNotEmpty && m.special != 'ava_status')
                    _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold), 'Translate',
                        () => _inlineTranslate(m)),
                  // Voice notes: transcribe the audio (cloud Whisper) and/or
                  // translate that transcript. Viewer-only, cached per message.
                  if (_isVoiceNote(m)) ...[
                    _action(ctx, PhosphorIcons.textAa(PhosphorIconsStyle.bold), 'Transcribe',
                        () => _transcribeVoice(m)),
                    _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold), 'Translate',
                        () => _translateVoice(m)),
                  ],
                  // Phase A (Ava Copilot §7): Ava doc actions on doc/PDF/image
                  // bubbles — Summarize ✨ · Translate ✨ · Auto-translate file ✨,
                  // in the plan's order BEFORE the download/share rows. Each is
                  // labelled "only you will see this" (results land in the
                  // private Ava lane). Hidden when "Ava in this chat" is off
                  // (D29) or the message has no server media ref.
                  ...AvaDocActions.menuItems(
                    sheetContext: ctx,
                    threadContext: context,
                    conv: _serverConvId,
                    mediaRef: m.media?.id,
                    name: m.media?.name,
                    show: _avaInChatOn &&
                        m.media != null &&
                        (m.media!.kind == MediaKind.file ||
                            m.media!.kind == MediaKind.image),
                  ),
                  _action(ctx, PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), 'Forward', () => _forward(m)),
                  // [AVAGRP-BUBBLE-1 / message-info] "Info" (§4, WhatsApp-style):
                  // how many members have seen my message. Own-message-only, same
                  // gate as the floating-pill menu above.
                  if (m.me && m.ts > 0)
                    _action(ctx, PhosphorIcons.info(PhosphorIconsStyle.bold), 'Info', () => _showMessageInfo(m)),
                  // Share OUT to another app (WhatsApp, Files, etc.) via the OS
                  // share sheet — works for any media, including voice notes.
                  if (m.media != null || m.localBytes != null)
                    _action(ctx, PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), 'Share to other apps', () => _shareMedia(m)),
                  if (m.media != null)
                    _action(ctx, PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.bold), 'Save to my AvaTOK Drive', () => _saveMediaToDrive(m)),
                  _action(ctx, PhosphorIcons.trash(PhosphorIconsStyle.bold), 'Delete for me', () => _deleteForMe(m)),
                  _action(ctx, PhosphorIcons.trashSimple(PhosphorIconsStyle.bold), 'Delete for everyone', () => _deleteForEveryone(m), danger: true),
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _action(BuildContext ctx, IconData icon, String label, VoidCallback onTap, {bool danger = false}) =>
      ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        leading: Icon(icon, color: danger ? AD.danger : AD.textPrimary),
        title: Text(label,
            style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
        onTap: () { Navigator.pop(ctx); onTap(); },
      );

  /// Copy a bubble's text (or a media caption) to the system clipboard — e.g.
  /// copy Ava's private reply, flip out of Ava-mode, and paste it to the person.
  void _copyText(_Msg m) {
    final text = m.text.trim();
    if (text.isEmpty) return;
    Clipboard.setData(ClipboardData(text: text));
    HapticFeedback.selectionClick();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)));
    }
  }

  /// Copy a URL detected inside a bubble to the clipboard. One link → copied
  /// straight; multiple links → a small chooser so the user picks which one.
  Future<void> _copyLink(_Msg m) async {
    final urls = urlSpans(m.text).map((s) => s.url).toList();
    if (urls.isEmpty) return;
    String url = urls.first;
    if (urls.length > 1) {
      final picked = await showModalBottomSheet<String>(
        context: context,
        backgroundColor: AD.overlaySheet,
        shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
        builder: (ctx) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('Copy which link?', style: ADText.rowName()),
              ),
            ),
            for (final u in urls)
              ListTile(
                leading: Icon(PhosphorIcons.link(PhosphorIconsStyle.bold), color: AD.textPrimary),
                title: Text(u, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ADText.preview(c: AD.textPrimary)),
                onTap: () => Navigator.pop(ctx, u),
              ),
          ]),
        ),
      );
      if (picked == null) return;
      url = picked;
    }
    await Clipboard.setData(ClipboardData(text: url));
    HapticFeedback.selectionClick();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Link copied'), duration: Duration(seconds: 1)));
    }
    Analytics.capture('chat_link_copied', {'count': urls.length});
  }

  Future<void> _toggleStar(_Msg m) async {
    if (m.evId == null) { setState(() => m.starred = !m.starred); return; }
    final set = await _starStore.toggle(m.evId!);
    if (mounted) setState(() { _starred = set; m.starred = set.contains(m.evId); });
  }

  void _startEdit(_Msg m) {
    setState(() {
      _editing = m; _replyTo = null;
      _ctrl.text = m.text; _hasText = m.text.trim().isNotEmpty;
    });
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
  }

  Future<void> _pinMessage(_Msg m) async {
    if (_convKey == null) return;
    final pin = {'id': m.evId ?? '${m.id}', 'text': m.text};
    await PinnedMsgStore().set(_convKey!, jsonEncode(pin));
    if (mounted) setState(() => _pinned = pin);
  }

  Future<void> _unpin() async {
    if (_convKey == null) return;
    await PinnedMsgStore().set(_convKey!, '');
    if (mounted) setState(() => _pinned = null);
  }

  void _openInfo() {
    if (widget.chat.group) { _openGroupInfo(); return; }
    if (!widget.chat.seed.startsWith('user_')) return;
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => ContactProfileScreen(
            name: widget.chat.name, uid: widget.chat.seed,
            avatarUrl: widget.chat.avatarUrl.isEmpty ? null : widget.chat.avatarUrl,
            me: _meId)));
  }

  /// [AVA-GRP-UI] Open the full profile popup — photo, name, AvaTOK number and
  /// the QR "add me" share card — for a tapped avatar (a group member's bubble
  /// avatar, or a 1:1 peer). Reuses the existing `ContactProfileScreen`, whose
  /// own header carries a back button that returns to the chat; we do not build
  /// a bespoke sheet. Only opens for a real user id (Clerk `user_…`); Ava and
  /// unknown-number `tel:` rows have no profile and are skipped by the callers.
  /// `from` records the tap surface for telemetry (`grp_profile_popup_opened`);
  /// the viewer's email/phone are auto-stamped by `Analytics._base`.
  void _openMemberProfile({
    required String uid,
    required String name,
    String? avatarUrl,
    required String from,
  }) {
    if (uid.isEmpty || !uid.startsWith('user_')) return;
    Analytics.capture('grp_profile_popup_opened', {
      'from': from,
      'gid': widget.chat.gid ?? '',
      'group': widget.chat.group,
    });
    final url = (avatarUrl?.isNotEmpty ?? false) ? avatarUrl : _memberAvatars[uid];
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => ContactProfileScreen(
            name: name, uid: uid,
            avatarUrl: (url?.isNotEmpty ?? false) ? url : null,
            me: _meId)));
  }

  static const _reactionSounds = {
    '❤️': 'heart', '👍': 'like', '😂': 'laugh', '😮': 'wow', '😢': 'sad', '👏': 'clap',
  };

  void _react(_Msg m, String emoji) {
    final adding = m.reaction != emoji;
    final prev = m.reaction;
    final myUidTag = _meId?.uid ?? 'me';
    setState(() {
      // Maintain MY single reaction + the aggregate count shown on the bubble.
      if (prev != null) { // remove my previous emoji from the tally
        m.reactCounts[prev] = ((m.reactCounts[prev] ?? 1) - 1).clamp(0, 9999);
        if (m.reactCounts[prev] == 0) m.reactCounts.remove(prev);
        m.reactBy[prev]?.remove(myUidTag);
        if (m.reactBy[prev]?.isEmpty ?? false) m.reactBy.remove(prev);
      }
      m.reaction = adding ? emoji : null;
      if (adding) {
        m.reactCounts[emoji] = (m.reactCounts[emoji] ?? 0) + 1;
        m.reactBy.putIfAbsent(emoji, () => <String>{}).add(myUidTag);
      }
    });
    Analytics.capture('chat_reaction', {'emoji': emoji, 'op': adding ? 'add' : 'remove'});
    HapticFeedback.lightImpact();
    if (adding) {
      final file = _reactionSounds[emoji];
      if (file != null) {
        _sfx.stop();
        _sfx.play(AssetSource('sounds/$file.wav'));
      }
    }
    // PartyKit live reaction (the reaction's home now that Ably is retired).
    final p = _party;
    final mid = m.evId;
    if (p != null && mid != null) {
      if (prev != null && prev != emoji) {
        p.send(<String, dynamic>{'t': 'reaction', 'mid': mid, 'emoji': prev, 'add': false, 'whoName': _fromNameTag});
      }
      p.send(<String, dynamic>{'t': 'reaction', 'mid': mid, 'emoji': emoji, 'add': adding, 'whoName': _fromNameTag});
    }
  }

  // Phase 5: a curated, categorized emoji picker. Returns the chosen emoji (or
  // null). Kept package-free (a scrollable grid of common emoji) so it builds in
  // CI without a new dependency.
  static const Map<String, List<String>> _emojiCatalog = {
    'Smileys': ['😀','😁','😂','🤣','😊','😍','😘','😎','🤩','😢','😭','😡','🥺','🤔','😴','🤯','😱','🥳','😅','😉','🙃','😇','🤗','🤭','😬','🙄','😏','😌','🤤','🤪'],
    'Gestures': ['👍','👎','👏','🙏','🤝','💪','👊','✊','🤞','✌️','🤟','🤙','👌','🖐️','✋','👋','🫶','🫰','👇','👆'],
    'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','❤️‍🔥'],
    'Fun': ['🔥','🎉','🎊','✨','⭐','🌟','💯','🚀','🏆','🎈','🎁','💎','👑','💥','💫','🌈','☀️','⚡','🍾','🥂'],
    'Animals': ['🐶','🐱','🦄','🐼','🦁','🐯','🐸','🐵','🐧','🐢','🦋','🐝','🐬','🐳','🦊','🐰','🐨','🐮','🐷','🐙'],
    'Food': ['🍕','🍔','🍟','🌮','🍣','🍦','🍩','🍪','🎂','🍰','🍫','🍿','☕','🍺','🍷','🥤','🍓','🍉','🍌','🥑'],
  };

  Future<String?> _openEmojiPicker() {
    return showModalBottomSheet<String>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Align(alignment: Alignment.centerLeft,
                  child: Text('React with…', style: ADText.rowName())),
            ),
            Flexible(
              child: ListView(
                padding: const EdgeInsets.only(bottom: 12),
                children: [
                  for (final cat in _emojiCatalog.entries) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 8, 20, 4),
                      child: Align(alignment: Alignment.centerLeft,
                          child: Text(cat.key.toUpperCase(), style: ADText.statCaption(c: AD.textSecondary))),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Wrap(children: [
                        for (final e in cat.value)
                          GestureDetector(
                            onTap: () => Navigator.pop(ctx, e),
                            child: Padding(
                              padding: const EdgeInsets.all(6),
                              child: Text(e, style: const TextStyle(fontSize: 28)),
                            ),
                          ),
                      ]),
                    ),
                  ],
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  // Resolve a reactor uid to a friendly name. Mine → "You"; a learned group
  // member name (from a message or reaction that carried fromName) → that name;
  // a 1:1 peer → the chat name; otherwise a short id.
  String _reactorName(String uid) {
    if (uid == (_meId?.uid ?? 'me') || uid == 'me') return 'You';
    final known = _memberNames[uid];
    if (known != null && known.isNotEmpty && known != 'You') return known;
    if (!widget.chat.group) return widget.chat.name;
    return _shortPub(uid);
  }

  // Phase 5: "reacted by" — long-press a reaction chip to see who reacted.
  void _showReactedBy(_Msg m) {
    if (m.reactBy.isEmpty) return;
    Analytics.capture('chat_reacted_by_view', {'kinds': m.reactBy.length});
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Reactions', style: ADText.rowName())),
          ),
          for (final e in m.reactBy.entries)
            for (final uid in e.value)
              ListTile(
                dense: true,
                leading: Text(e.key, style: const TextStyle(fontSize: 22)),
                title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
              ),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  /// [AVAGRP-BUBBLE-1 / message-info §4] WhatsApp-style "Info" sheet for MY OWN
  /// message: who has read it and who it's been delivered to. Modelled EXACTLY
  /// on `_showReactedBy` above (same sheet chrome, same `_reactorName`/
  /// `_memberNames` resolution) plus the group avatars from `_memberAvatars`.
  ///
  /// [AVAGRP-BUBBLE-2] CONTRACT SEAM CLOSED: `m.readBy`/`m.deliveredTo`
  /// (`Map<uid, epochSeconds>`) are now actually populated — live, via
  /// `_applyMsgReceipt` (`{"t":"msg_receipt",...}` frames, `sync_hub.dart`
  /// `_ingestMsgReceipt`), and on cold open via `_hydrateMsgReceipts`
  /// (`GET /api/msg/seen`). Gated end-to-end on `RemoteConfig.groupReceiptsEnabled`
  /// (dark launch, default false) — while off this sheet still shows "No read
  /// receipts yet" for every group message exactly as before, by construction
  /// (nothing writes into the maps with the flag off).
  void _showMessageInfo(_Msg m) {
    // Two-sided telemetry (CLAUDE.md): this event fires on the SENDER's device
    // (Info is own-messages-only), so `Analytics.capture` auto-stamps the
    // sender's email. `mid` is the join key against the reader-side
    // `chat_group_receipt_*` events below, which tag the READER's uid — either
    // party's telemetry can be pulled and cross-referenced via `mid`.
    Analytics.capture('chat_message_info_view', {
      'group': widget.chat.group,
      'group_size': widget.chat.group ? widget.chat.members : 1,
      'read_count': m.readBy.length,
      'delivered_count': m.deliveredTo.length,
      'mid': m.evId ?? '',
      'group_receipts_enabled': RemoteConfig.groupReceiptsEnabled,
    });
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Info', style: ADText.rowName())),
          ),
          if (m.readBy.isEmpty && m.deliveredTo.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
              // [AVA-GRP-SENDSTATE] Honest empty state. With `groupReceiptsEnabled`
              // OFF nothing EVER populates readBy/deliveredTo, so the old
              // unconditional "No read receipts yet" was misleading — it implied the
              // feature was on and simply had no data, when receipts are switched
              // off entirely. Tell the truth so a "seen by everyone" message doesn't
              // look like the receipt system is broken.
              child: Text(
                RemoteConfig.groupReceiptsEnabled
                    ? 'No read receipts yet'
                    : 'Read receipts are off for group chats.',
                style: ADText.bubbleBody(c: AD.textSecondary)),
            )
          else ...[
            if (m.readBy.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
                child: Text('READ BY (${m.readBy.length})', style: ADText.sectionLabel(c: AD.iconSearch)),
              ),
              for (final uid in m.readBy.keys)
                ListTile(
                  dense: true,
                  leading: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderAvatar, width: 1.5),
                    ),
                    child: Avatar(
                      seed: uid,
                      name: _reactorName(uid),
                      size: 32,
                      avatarUrl: (_memberAvatars[uid]?.isNotEmpty ?? false) ? _memberAvatars[uid] : null,
                    ),
                  ),
                  title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
                  trailing: Text(_fmtTime(m.readBy[uid]!), style: ADText.statCaption(c: AD.textSecondary)),
                ),
            ],
            if (m.deliveredTo.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 4),
                child: Text('DELIVERED TO (${m.deliveredTo.length})', style: ADText.sectionLabel(c: AD.textSecondary)),
              ),
              for (final uid in m.deliveredTo.keys)
                ListTile(
                  dense: true,
                  leading: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderAvatar, width: 1.5),
                    ),
                    child: Avatar(
                      seed: uid,
                      name: _reactorName(uid),
                      size: 32,
                      avatarUrl: (_memberAvatars[uid]?.isNotEmpty ?? false) ? _memberAvatars[uid] : null,
                    ),
                  ),
                  title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
                  trailing: Text(_fmtTime(m.deliveredTo[uid]!), style: ADText.statCaption(c: AD.textSecondary)),
                ),
            ],
          ],
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  // "Who voted" for a poll option (group threads) — long-press an option.
  void _showPollVoters(String option, Set<String> uids) {
    if (uids.isEmpty) return;
    Analytics.capture('poll_voters_view', {'count': uids.length});
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Align(alignment: Alignment.centerLeft,
                child: Text('Voted "$option"', style: ADText.rowName())),
          ),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 360), child: ListView(shrinkWrap: true, children: [
            for (final uid in uids)
              ListTile(
                dense: true,
                leading: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 20, color: AD.primaryBadge),
                title: Text(_reactorName(uid), style: ADText.rowName(c: AD.textPrimary)),
              ),
          ])),
          const SizedBox(height: 6),
        ]),
      ),
    );
  }

  // Save a chat media file into the user's OWN AvaTOK Google Drive folder
  // (Hybrid: their own copy in Drive; the shared original stays on encrypted R2).
  Future<void> _saveMediaToDrive(_Msg m) async {
    if (m.media == null) return;
    _capNote('Saving to your AvaTOK Drive…');
    final bytes = m.localBytes ?? await MediaService.downloadAndDecrypt(m.media!);
    if (bytes == null) { _capNote('Could not load this file.'); return; }
    final kind = m.media!.kind;
    final bucket = kind == MediaKind.image ? 'Photos' : kind == MediaKind.video ? 'Videos' : 'Files';
    final mime = kind == MediaKind.image ? 'image/jpeg' : kind == MediaKind.video ? 'video/mp4' : 'application/octet-stream';
    final ok = await DriveService.I.upload(bucket, m.media!.name, mime, bytes);
    if (mounted) _capNote(ok ? 'Saved to your AvaTOK Drive ✓' : "Couldn't save — connect Drive in AvaStorage.");
  }

  // DELETE FOR ME — soft-hide on MY device only. The content is RETAINED (not
  // erased) so I can Undo to recover it later (copy something I lost, then re-hide).
  void _deleteForMe(_Msg m) {
    setState(() => m.hidden = true);
    _persistHidden(m.evId, true); // durable on THIS device — survives app updates
    _schedulePersist();
    _syncHidden(m, true); // mirror the hide to my other devices
    Analytics.capture('message_deleted', {
      'scope': 'me', 'group': _group != null,
      if (m.evId != null) 'delete_id': m.evId!,
    });
  }

  // Persist a soft-delete/Undo to the durable, per-account [HiddenStore] AND the
  // in-memory map, so it's re-applied on the next cold open even if the capped
  // per-conversation message cache was cleared by an app update / OEM wipe. This
  // is the local-first source of truth; the server mirror (_syncHidden) is purely
  // for cross-device. Without this, a delete only lived in the cache + a best-
  // effort server POST, so a re-sync after an update brought the message back.
  void _persistHidden(String? evId, bool hidden) {
    if (evId == null || evId.isEmpty) return;
    _hiddenIds[evId] = hidden;
    HiddenStore().set(evId, hidden);
  }

  // Sync MY soft-delete/Undo to my OTHER devices via the InboxDO (owner-only state).
  void _syncHidden(_Msg m, bool hidden) {
    final conv = _guardianConv; // server conv id for this thread
    final target = m.evId;
    if (conv == null || target == null || target.isEmpty) {
      // The hide can't be mirrored to my other devices (no server conv / evId) —
      // this is the silent gap behind "my Mac still shows it". Make it visible.
      Analytics.capture('chat_hide_send_skipped', {
        'hidden': hidden, 'has_conv': conv != null, 'has_evid': target != null && target.isNotEmpty,
      });
      return;
    }
    // Sender-side anchor for the multi-device funnel: this hide/undo went to the
    // server (which broadcasts live + FCM-wakes my other devices). Join `target`
    // to chat_hide_fanout (worker) and chat_hide_applied (each device).
    ApiAuth.postJson(kMsgHideUrl, {'conv': conv, 'target': target, 'hidden': hidden}).then(
      (res) => Analytics.capture('chat_hide_sent', {
        'target': target, 'hidden': hidden, 'ok': res.statusCode == 200, 'status': res.statusCode,
      }),
      onError: (e) => Analytics.capture('chat_hide_sent', {
        'target': target, 'hidden': hidden, 'ok': false, 'err': e.toString(),
      }),
    );
  }

  // Apply a hide/Undo that arrived from one of my OTHER devices.
  void _applyHide(String target, bool hidden) {
    _persistHidden(target, hidden); // keep this device's durable state current
    final i = _msgs.indexWhere((x) => x.evId == target);
    if (i >= 0 && mounted) {
      setState(() => _msgs[i].hidden = hidden);
      _schedulePersist();
    }
  }

  // DELETE FOR EVERYONE — soft-hide MY copy (retained, so I can Undo and recover my
  // own data), AND tell the peer(s) to delete on THEIR side. KEY DIFFERENCE from
  // WhatsApp: my own copy isn't destroyed. The recipient's copy IS hard-removed
  // (server tombstone + _applyDelete) — only I, the owner, can Undo to see it again.
  void _deleteForEveryone(_Msg m) {
    final target = m.evId;
    var channel = 'none';
    if (_realMode && target != null && target.isNotEmpty) {
      try {
        // [AVA-CHAT-INSTANT] An unsend is an author-verified, NON-idempotent server
        // op — it MUST NOT ride the durable Outbox (`.send`), whose at-least-once
        // retry loops `403 not_author` after the first POST tombstones the target
        // (production bug: 50× in 3 days for one tester). `sendControl` is the
        // one-shot, 403-terminal transport for these controls.
        if (_group != null && _gdm != null) {
          unawaited(_gdm!.sendControl(jsonEncode({'t': 'gdel', 'gid': _group!.id, 'target': target})));
          channel = 'gdm';
        } else if (_dm != null) {
          unawaited(_dm!.sendControl(jsonEncode({'t': 'del', 'target': target})));
          channel = 'dm';
        }
      } catch (e) {/* best-effort; local hide still applies */
        Analytics.capture('chat_delete_send_failed', {
          if (target != null) 'delete_id': target, 'group': _group != null, 'err': e.toString(),
        });
      }
    }
    setState(() => m.hidden = true); // retained — Undo brings it back for ME only
    _persistHidden(m.evId, true); // durable on THIS device — survives app updates
    _schedulePersist();
    _syncHidden(m, true); // mirror the hide to my other devices
    Analytics.capture('message_deleted', {
      'scope': 'everyone', 'group': _group != null, 'had_evid': target != null,
      if (target != null) 'delete_id': target,
    });
    // Sender-side lifecycle anchor: join this delete_id to the worker's
    // chat_delete_delivery/fanout and the recipient's chat_delete_applied to see,
    // per delete, whether it went out live vs push and whether it ever landed.
    Analytics.capture('chat_delete_sent', {
      if (target != null) 'delete_id': target,
      'group': _group != null, 'channel': channel, 'realmode': _realMode,
    });
  }

  // Undo MY own soft-delete — restore the message in my view only (never re-sent to
  // anyone). Owner-only recovery: a peer's hard-deleted copy has no Undo.
  void _undoDelete(_Msg m) {
    setState(() => m.hidden = false);
    _persistHidden(m.evId, false); // clear the durable hide on THIS device too
    _schedulePersist();
    _syncHidden(m, false); // mirror the Undo to my other devices
    Analytics.capture('message_delete_undo', {'group': _group != null});
  }

  // Apply a delete-for-everyone the PEER sent: HARD-remove the targeted message
  // from my view (no Undo — I'm not its owner). The server also tombstones my
  // stored copy so it never re-syncs.
  // Convert a message in place into the delete-for-everyone tombstone.
  void _tombstone(_Msg m) {
    m.text = 'This message was deleted';
    m.media = null; m.localBytes = null;
    m.reaction = null; m.special = null; m.extra = null;
    m.mediaCaption = ''; m.hidden = false;
  }

  void _applyDelete(String target) {
    if (target.isEmpty) return;
    _deletedIds.add(target);
    DeletedStore().add(target); // durable — re-applies even after the cache is rebuilt
    final i = _msgs.indexWhere((x) => x.evId == target);
    Analytics.capture('message_delete_applied', {
      'group': _group != null, 'on_screen': i >= 0,
    });
    if (i >= 0 && mounted) {
      setState(() => _tombstone(_msgs[i]));
      _schedulePersist();
    }
  }

  // STREAM I (FWD-1): open the multi-select Forward sheet (Groups + Contacts,
  // search, checkmarks, single Send). If forwarding is flag-disabled, fall back
  // to a quiet no-op. One selected contact with editable text still gets the
  // caption editor; everything else fans out straight to the chosen targets.
  Future<void> _forward(_Msg m) async {
    if (!RemoteConfig.unlimitedForwardEnabled) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Forwarding is temporarily unavailable')));
      return;
    }
    final msgKind = m.media?.kind.name ?? 'text';
    final targets = await showForwardSheet(context, msgKind: msgKind);
    if (targets == null || targets.isEmpty || !mounted) return;
    // Preserve the single-contact caption-edit UX when it's exactly one DM.
    if (targets.length == 1 && !targets.first.isGroup) {
      final peerUid = targets.first.peerUid;
      final saved = await ContactsStore().load();
      final hit = saved.where((c) => c.uid == peerUid).toList();
      final match = hit.isNotEmpty
          ? hit.first
          : Contact(uid: peerUid, name: targets.first.label);
      if (!mounted) return;
      await _forwardWithText(m, match);
      return;
    }
    await _forwardToTargets(m, targets);
  }

  /// Fan a single message out to a MIX of DMs + groups in ONE server call
  /// (/api/msg/forward). The envelope carries `fwd:true` (Stream K renders the
  /// "↪ Forwarded" label from this) and — for privacy (FWD-1) — NOTHING about
  /// the original sender. Media re-references the SAME content-addressed R2 key
  /// via the same envelope (its per-blob AES key rides in the envelope, so no
  /// re-upload is ever needed — FWD-2, all cases including cross-context).
  Future<void> _forwardToTargets(_Msg m, List<ForwardTarget> targets,
      {String? caption}) async {
    final id = _meId;
    if (id == null) return;
    final Map<String, dynamic> payload;
    if (m.media != null) {
      // Same envelope → same media_ref → one R2 copy, never re-uploaded.
      payload = {...m.media!.toEnvelope(), 'fwd': true, 'forwarded': true};
      final cap = (caption ?? _mediaCaptionOf(m)).trim();
      if (cap.isEmpty) { payload.remove('cap'); } else { payload['cap'] = cap; }
    } else {
      payload = {'t': 'text', 'body': caption ?? m.text, 'fwd': true, 'forwarded': true};
    }
    // media_ref: the R2 content hash so the server indexes the forward against
    // the SAME object (zero duplication). For text this stays null.
    final mediaRef = m.media?.id;
    final body = jsonEncode(payload);
    final serverTargets = [
      for (final t in targets)
        t.isGroup ? {'conv': t.groupId} : {'to': t.peerUid},
    ];
    final nGroups = targets.where((t) => t.isGroup).length;
    Analytics.capture('chat_message_forwarded', {
      'has_media': m.media != null,
      'media_kind': m.media?.kind.name ?? 'text',
      'n_targets': targets.length,
      'n_groups': nGroups,
      'edited_caption': caption != null,
    });
    int status = 0;
    try {
      final res = await ApiAuth.postJson(kMsgForwardUrl, {
        'kind': 'text',
        'body': body,
        if (mediaRef != null) 'media_ref': mediaRef,
        'targets': serverTargets,
      });
      status = res.statusCode;
      // Wake the DM peers (groups fan out server-side).
      final dmUids = [for (final t in targets) if (!t.isGroup) t.peerUid];
      if (dmUids.isNotEmpty) PushService.notifyMessage(dmUids, _myName ?? 'AvaTOK');
      // FWD-4 telemetry (email auto-attached by Analytics.identify person props).
      if (status == 429) {
        Analytics.capture('forward_rate_capped', {
          'n_targets': targets.length, 'n_groups': nGroups,
        });
      } else if (status == 200) {
        Analytics.capture('forward_sent', {
          'n_targets': targets.length, 'n_groups': nGroups,
          'media_kind': m.media?.kind.name ?? 'text',
          'cross_context': true,
        });
      }
    } catch (_) {}
    if (!mounted) return;
    final n = targets.length;
    final msg = status == 429
        ? 'Slow down — too many forwards. Try again shortly.'
        : (status == 200 || status == 0)
            ? 'Forwarded to $n chat${n == 1 ? '' : 's'}'
            : "Couldn't forward — try again";
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Step between picking a recipient and sending: when the message has text
  /// associated with it (a media caption, or a plain text body), show that text
  /// in an EDITABLE box so the user can tweak or clear it before forwarding.
  /// Media with no caption forwards straight through (unchanged behaviour).
  Future<void> _forwardWithText(_Msg m, Contact c) async {
    final isMedia = m.media != null;
    final initial = (isMedia ? _mediaCaptionOf(m) : m.text).trim();
    // No associated text on a media item → nothing to edit, forward as-is.
    if (isMedia && initial.isEmpty) { await _doForward(m, c); return; }

    final edit = TextEditingController(text: initial);
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 16, right: 16, top: 16,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 16,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Forward to ${c.name}', style: ADText.threadName()),
          const SizedBox(height: 4),
          Text(isMedia ? 'Edit or remove the caption before sending'
                       : 'Edit the message before sending',
              style: ADText.preview(c: AD.textTertiary)),
          const SizedBox(height: 12),
          // For media, show a small preview chip so it's clear what rides along.
          if (isMedia) ...[
            Row(children: [
              if (m.localBytes != null && m.media!.kind == MediaKind.image)
                ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: Image.memory(m.localBytes!, width: 44, height: 44, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
                )
              else
                PhosphorIcon(
                    m.media!.kind == MediaKind.video
                        ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                        : m.media!.kind == MediaKind.image
                            ? PhosphorIcons.image(PhosphorIconsStyle.bold)
                            : PhosphorIcons.file(PhosphorIconsStyle.bold),
                    size: 26, color: AD.textPrimary),
              const SizedBox(width: 10),
              Expanded(child: Text(m.media!.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.rowName())),
            ]),
            const SizedBox(height: 12),
          ],
          Row(children: [
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(AD.rInput),
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: TextField(
                  controller: edit,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (v) => Navigator.pop(ctx, v),
                  style: ADText.rowName(),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: isMedia ? 'Add a caption…' : 'Message',
                    hintStyle: ADText.preview(c: AD.textTertiary),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            _sendCircle(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                () => Navigator.pop(ctx, edit.text)),
          ]),
        ]),
      ),
    ).whenComplete(edit.dispose);

    if (result == null) return; // dismissed without sending
    final text = result.trim();
    // A plain text message edited down to nothing → don't forward an empty line.
    if (!isMedia && text.isEmpty) return;
    await _doForward(m, c, caption: text);
  }

  /// Really forward [m] to contact [c] over a one-off send, flagged forwarded.
  /// [caption] (when provided) overrides the carried text/caption — empty means
  /// forward the media with no caption.
  Future<void> _doForward(_Msg m, Contact c, {String? caption}) async {
    final id = _meId;
    final peerHex = c.uid;
    if (id == null || peerHex.isEmpty) return;
    final Map<String, dynamic> payload;
    // STREAM I: carry `fwd:true` (Stream K renders "↪ Forwarded") + keep the
    // legacy `forwarded` key for the existing bubble renderer. NOTHING about the
    // original sender travels (privacy, FWD-1).
    if (m.media != null) {
      payload = {...m.media!.toEnvelope(), 'fwd': true, 'forwarded': true};
      final cap = (caption ?? _mediaCaptionOf(m)).trim();
      if (cap.isEmpty) { payload.remove('cap'); } else { payload['cap'] = cap; }
    } else {
      payload = {'t': 'text', 'body': caption ?? m.text, 'fwd': true, 'forwarded': true};
    }
    Analytics.capture('chat_message_forwarded', {
      'has_media': m.media != null,
      'media_kind': m.media?.kind.name ?? 'text',
      'edited_caption': caption != null,
      'conv_kind': _isGroup ? 'group' : 'dm',
      'n_targets': 1,
      'n_groups': 0,
    });
    try {
      // STREAM I: route single-contact forwards through /api/msg/forward too, so
      // the rate cap + liveness guard apply uniformly. Media re-references the
      // SAME R2 key via media_ref (no re-upload — FWD-2, all cases).
      await ApiAuth.postJson(kMsgForwardUrl, {
        'kind': 'text', 'body': jsonEncode(payload),
        if (m.media?.id != null) 'media_ref': m.media!.id,
        'targets': [{'to': peerHex}],
      });
      PushService.notifyMessage([c.uid], _myName ?? 'AvaTOK');
    } catch (_) {}
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Forwarded to ${c.name}')));
  }

  // ---- STREAM G [GROUP-AI-2/3] per-member group translation ----
  /// Toggle "Translate this group for me". When turned ON, translate the loaded
  /// TEXT messages into the user's Stream-A language on FETCH (server caches per
  /// msg_id+lang). Voice notes are not translated (only text rows are sent).
  Future<void> _toggleGroupTranslate() async {
    if (!(widget.chat.group || widget.chat.gid != null)) return;
    final turningOn = !_groupTranslateOn;
    setState(() => _groupTranslateOn = turningOn);
    if (!turningOn) {
      // Revert: drop the translations so bubbles show the original again.
      setState(() { for (final m in _msgs) { m.extra?.remove('translated'); m.extra?.remove('translated_lang'); } });
      Analytics.capture('group_translate_enabled', {'lang': _transLang.code, 'on': false});
      return;
    }
    Analytics.capture('group_translate_enabled', {'lang': _transLang.code, 'on': true});
    await _applyGroupTranslation();
  }

  /// Fetch translations for the currently-loaded, not-mine text messages of the
  /// group into the remembered language and stash them on each bubble's extra so
  /// the TranslatedText wrapper renders "translated · show original".
  Future<void> _applyGroupTranslation() async {
    if (!_groupTranslateOn || _groupTranslateBusy) return;
    final conv = _serverConvId;
    if (conv == null) return;
    final lang = _transLang.code;
    // Only text rows the member actually fetched, no media/voice, not mine.
    final targets = _msgs.where((m) => !m.me && m.special == null && m.media == null
        && m.text.trim().isNotEmpty && (m.extra?['translated'] == null)).toList();
    if (targets.isEmpty) return;
    setState(() => _groupTranslateBusy = true);
    final batch = <Map<String, String>>[
      for (final m in targets) {'id': m.evId ?? '${m.id}', 'text': m.text.trim()},
    ];
    final out = await AiChatApi.groupTranslate(conv, lang, batch);
    if (!mounted) { return; }
    setState(() {
      _groupTranslateBusy = false;
      for (final m in targets) {
        final t = out[m.evId ?? '${m.id}'];
        if (t != null && t.isNotEmpty) {
          (m.extra ??= <String, dynamic>{})['translated'] = t;
          m.extra!['translated_lang'] = lang;
        }
      }
    });
  }

  // ---- STREAM G [GROUP-AI-1] group catch-up ("What did I miss?") ----
  /// Server conv id for THIS thread computed from the conv key (works for DM +
  /// group). Renamed from _serverConv to avoid clashing with the stranger-gate
  /// field `_serverConv` (both were added by concurrent streams).
  String? get _serverConvId {
    final key = _convKey;
    final myUid = _meId?.uid;
    if (key == null || myUid == null || myUid.isEmpty) return null;
    return serverConvFromKey(key, myUid);
  }

  /// Count of unread INCOMING messages currently loaded (drives the >25 gate).
  int get _unreadIncoming => _msgs.where((m) => !m.me && m.special == null).length;

  /// Whether the "What did I miss?" button should be offered: a group thread with
  /// >25 unread and the messaging AvaBrain guardrail ON.
  Future<bool> _catchupAvailable() async {
    if (!(widget.chat.group || widget.chat.gid != null)) return false;
    if (_unreadIncoming <= 25) return false;
    return BrainConsent.isOn('messaging');
  }

  Future<void> _whatDidIMiss() async {
    final conv = _serverConvId;
    if (conv == null) return;
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to use catch-up.');
      return;
    }
    setState(() { _catchupLoading = true; _catchupDismissed = false; });
    // since_seq 0 = summarise the whole loaded unread window; the server pulls
    // text-only from my own InboxDO and never stores the summary.
    final bullets = await AiChatApi.catchup(conv, sinceSeq: 0);
    if (!mounted) return;
    setState(() {
      _catchupLoading = false;
      _catchupBullets = bullets;
      _catchupCount = _unreadIncoming;
    });
    if (bullets.isEmpty) _toast('Nothing to catch up on.');
  }

  void _dismissCatchup() => setState(() { _catchupDismissed = true; _catchupBullets = const []; });

  // ---- STREAM G [GROUP-AI-4] smart replies (DMs) ----
  /// Debounced fetch after an incoming DM. Only fires for 1:1 threads when the
  /// screen is mounted (open + foreground). Guardrail + flag are enforced server-side.
  void _maybeFetchSmartReplies() {
    if (widget.chat.group || widget.chat.gid != null) return; // DMs only
    _smartReplyDebounce?.cancel();
    _smartReplyDebounce = Timer(const Duration(milliseconds: 900), () async {
      if (!mounted) return;
      // Don't suggest replies to my own last message.
      final tail = _msgs.where((m) => m.special == null && m.text.trim().isNotEmpty).toList();
      if (tail.isEmpty || tail.last.me) { if (_smartReplies.isNotEmpty) setState(() => _smartReplies = const []); return; }
      final last4 = tail.length <= 4 ? tail : tail.sublist(tail.length - 4);
      final payload = <Map<String, Object>>[
        for (final m in last4) {'me': m.me, 'text': m.text.trim()},
      ];
      final s = await AiChatApi.smartReplies(payload);
      if (!mounted) return;
      setState(() => _smartReplies = s);
    });
  }

  void _insertSmartReply(String text) {
    Analytics.capture('smart_reply_used', {'len': text.length});
    _ctrl.text = _ctrl.text.isEmpty ? text : '${_ctrl.text} $text';
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    setState(() { _hasText = _ctrl.text.trim().isNotEmpty; _smartReplies = const []; });
    _composerFocus.requestFocus();
  }

  // ---- STREAM G [GROUP-AI-5] inline translate one bubble ----
  Future<void> _inlineTranslate(_Msg m) async {
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to translate.');
      return;
    }
    final text = m.text.trim();
    if (text.isEmpty) return;
    final to = _transLang.code; // user's Stream-A / remembered language
    // Local drift cache first (scoped per account) so a re-translate is free.
    final cached = await _msgStore.readTranslation(m.evId ?? '${m.id}', to);
    if (cached != null && cached.isNotEmpty) {
      if (mounted) _showInlineTranslation(m, cached, to);
      return;
    }
    _toast('Translating…');
    final out = await AiChatApi.translate(text, to);
    if (!mounted) return;
    if (out == null) { _toast('Could not translate.'); return; }
    Analytics.capture('inline_translate_used', {'lang': to});
    try { await _msgStore.writeTranslation(m.evId ?? '${m.id}', to, out); } catch (_) {}
    _showInlineTranslation(m, out, to);
  }

  /// Stash the translation on the message's `extra` so the bubble can render it
  /// under the original (via TranslatedText) without touching Stream K geometry.
  void _showInlineTranslation(_Msg m, String translated, String lang) {
    setState(() {
      (m.extra ??= <String, dynamic>{})['translated'] = translated;
      m.extra!['translated_lang'] = lang;
    });
  }

  // ---- voice-note Transcribe + Translate ------------------------------------
  // A voice note is an audio-kind media bubble (recorded via the mic composer).
  bool _isVoiceNote(_Msg m) =>
      m.media?.kind == MediaKind.audio && m.special == null;

  /// Stable per-message cache key: the durable rumor id when present, else the
  /// local monotonic id. Matches the scheme used by inline text translation.
  String _msgCacheKey(_Msg m) => m.evId ?? '${m.id}';

  /// Fetch the DECRYPTED voice bytes (local-first, per-account MediaService
  /// cache), POST them to the existing cloud-Whisper transcribe route, and cache
  /// the transcript per message (account-scoped). Returns '' on failure. The
  /// transcript is stashed on m.extra['transcript'] so the bubble renders it.
  Future<String> _ensureTranscript(_Msg m) async {
    final key = _msgCacheKey(m);
    // 1) Already on the message this session.
    final live = (m.extra?['transcript'] as String?)?.trim();
    if (live != null && live.isNotEmpty) return live;
    // 2) Per-account disk cache (never re-transcribe on reopen).
    final cached = await _msgStore.readTranscript(key);
    if (cached != null && cached.trim().isNotEmpty) {
      if (mounted) setState(() => (m.extra ??= <String, dynamic>{})['transcript'] = cached);
      return cached;
    }
    // 3) Transcribe: decrypted bytes → /api/stt/transcribe (same route the
    //    composer's cloud dictation uses). Voice notes are m4a/AAC.
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      final bytes = m.localBytes ??
          (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (bytes == null || bytes.isEmpty) {
        Analytics.capture('voice_transcribe', {'ok': false, 'reason': 'no_bytes'});
        return '';
      }
      final r = await ApiAuth.postJson(
        '$kApiBase/stt/transcribe',
        {'audio': base64Encode(bytes), 'format': 'm4a'},
        timeout: const Duration(seconds: 45),
      );
      final ms = DateTime.now().millisecondsSinceEpoch - t0;
      if (r.statusCode != 200) {
        AvaLog.I.log('voice_stt', 'transcribe HTTP ${r.statusCode}: ${r.body}');
        Analytics.capture('voice_transcribe', {'ok': false, 'status': r.statusCode, 'ms': ms});
        return '';
      }
      final decoded = jsonDecode(r.body);
      final text = (decoded is Map && decoded['text'] is String)
          ? (decoded['text'] as String).trim()
          : '';
      Analytics.capture('voice_transcribe', {'ok': text.isNotEmpty, 'ms': ms, 'chars': text.length});
      if (text.isEmpty) return '';
      try { await _msgStore.writeTranscript(key, text); } catch (_) {}
      if (mounted) setState(() => (m.extra ??= <String, dynamic>{})['transcript'] = text);
      return text;
    } catch (e) {
      final ms = DateTime.now().millisecondsSinceEpoch - t0;
      AvaLog.I.log('voice_stt', 'transcribe FAILED: $e');
      Analytics.capture('voice_transcribe', {'ok': false, 'reason': 'exception', 'ms': ms});
      return '';
    }
  }

  /// Long-press → Transcribe: show the Whisper transcript below the voice bubble
  /// (viewer-only, cached). Inline snackbar on failure — never crashes.
  Future<void> _transcribeVoice(_Msg m) async {
    if ((m.extra?['transcript'] as String?)?.trim().isNotEmpty == true) return;
    _toast('Transcribing…');
    final text = await _ensureTranscript(m);
    if (!mounted) return;
    if (text.isEmpty) {
      _toast("Couldn't transcribe this voice message.");
    }
  }

  /// Long-press → Translate a voice note: pick a language, transcribe (if not
  /// cached), translate the transcript with the existing engine, then show
  /// "translated (Language)" below the bubble. Viewer-only, cached per message
  /// in the SAME translation cache keyed by '<msgId>|<lang>'.
  Future<void> _translateVoice(_Msg m) async {
    if (!await BrainConsent.isOn('messaging')) {
      if (mounted) _toast('Turn on AvaBrain for your messages in Settings to translate.');
      return;
    }
    // Reuse the shared language picker sheet.
    final picked = await _pickVoiceLang();
    if (picked == null || !mounted) return;
    final to = picked.code;
    final key = _msgCacheKey(m);
    // Translation already cached for this note+language?
    final cachedTr = await _msgStore.readTranslation(key, to);
    if (cachedTr != null && cachedTr.trim().isNotEmpty) {
      if (mounted) _showVoiceTranslation(m, cachedTr, picked.label);
      return;
    }
    _toast('Transcribing…');
    final transcript = await _ensureTranscript(m);
    if (!mounted) return;
    if (transcript.isEmpty) { _toast("Couldn't transcribe this voice message."); return; }
    _toast('Translating…');
    final t0 = DateTime.now().millisecondsSinceEpoch;
    final out = await AiChatApi.translate(transcript, to);
    final ms = DateTime.now().millisecondsSinceEpoch - t0;
    if (!mounted) return;
    if (out == null) {
      Analytics.capture('voice_translate', {'ok': false, 'lang': to, 'ms': ms});
      _toast('Could not translate.');
      return;
    }
    Analytics.capture('voice_translate', {'ok': true, 'lang': to, 'ms': ms, 'chars': out.length});
    try { await _msgStore.writeTranslation(key, to, out); } catch (_) {}
    _showVoiceTranslation(m, out, picked.label);
  }

  /// Language picker for voice-note translation — same list/sheet style as the
  /// composer Translate picker, but returns the chosen language instead of
  /// remembering it as the composer target.
  Future<ComposerLang?> _pickVoiceLang() => showModalBottomSheet<ComposerLang>(
        context: context,
        backgroundColor: AD.overlaySheet,
        shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
        builder: (ctx) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Row(children: [
                PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                    size: 20, color: AD.textPrimary),
                const SizedBox(width: 10),
                Text('Translate into…', style: ADText.threadName()),
              ]),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final l in ComposerAi.languages)
                    ListTile(
                      title: Text(l.label, style: ADText.rowName()),
                      subtitle: l.code != l.label
                          ? Text(l.code, style: ADText.preview())
                          : null,
                      onTap: () => Navigator.pop(ctx, l),
                    ),
                ],
              ),
            ),
          ]),
        ),
      );

  /// Stash the transcript translation on the message so the bubble renders it
  /// as "translated (Language)" below the voice waveform. Viewer-only.
  void _showVoiceTranslation(_Msg m, String translated, String langLabel) {
    setState(() {
      (m.extra ??= <String, dynamic>{})['transcript_translated'] = translated;
      m.extra!['transcript_translated_lang'] = langLabel;
    });
  }

  // ---- header overflow ----
  /// Phase A (Ava Copilot, D29/§6): on thread open, reset this conv's private
  /// Ava-lane unread counter (the user is looking at the lane now) and load the
  /// per-chat "Ava in this chat" switch state from the worker. Best-effort —
  /// failures leave the D29 default (ON) in place.
  void _initAvaChatState() {
    final key = _convKey;
    if (key == null) return;
    // ignore: unawaited_futures
    AvaUnread.clear(key);
    final conv = _serverConvId;
    if (conv == null) return;
    // ignore: unawaited_futures
    AvaChatToggle.fetch(conv).then((on) {
      if (mounted && on != _avaInChatOn) setState(() => _avaInChatOn = on);
    });
  }

  /// Flip "Ava in this chat" (D29) — optimistic local state, server write via
  /// POST /api/ava/chat-toggle. In groups only admins may flip it; the server
  /// enforces that, and a rejection quietly reverts the switch here.
  Future<void> _setAvaInChat(bool on) async {
    final conv = _serverConvId;
    if (conv == null) return;
    setState(() => _avaInChatOn = on);
    Analytics.capture('ava_chat_toggle', {
      'on': on, 'conv': conv, 'conv_kind': _isGroup ? 'group' : 'dm',
    });
    final ok = await AvaChatToggle.set(conv, on);
    if (!ok && mounted) {
      setState(() => _avaInChatOn = !on);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(_isGroup
            ? 'Only group admins can change Ava for this group.'
            : "Couldn't update Ava for this chat — try again."),
        duration: const Duration(seconds: 2),
      ));
    }
  }

  void _overflow() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      // This sheet grows to ~14 rows depending on thread type (group, tel
      // thread, unsaved caller, flags). Without isScrollControlled the sheet is
      // capped near half-screen and the tail items (Mute / Block / Delete) were
      // clipped off the bottom with no way to scroll to them.
      isScrollControlled: true,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 8),
          if (_isTelThread && !_callerSaved)
            _action(ctx, PhosphorIcons.userPlus(PhosphorIconsStyle.bold), 'Save to contacts',
                () { Navigator.pop(ctx); _saveUnknownContact(source: 'thread_menu'); }),
          if (kDiscussWithAvaEnabled && _convKey != null)
            _action(ctx, PhosphorIcons.sparkle(PhosphorIconsStyle.bold), 'Discuss with Ava',
                _discussWithAva),
          // Phase A (Ava Copilot, D29): per-chat "Ava in this chat" switch —
          // ON by default. 1:1 = your own Ava only; groups = admins only (the
          // server enforces; a rejected flip reverts quietly). OFF hides the
          // Ava doc context-menu items and stops copilot processing here.
          if (_convKey != null)
            StatefulBuilder(builder: (sctx, setSheet) => SwitchListTile(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                  secondary: Icon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: AD.textPrimary),
                  title: Text('Ava in this chat', style: ADText.rowName(c: AD.textPrimary)),
                  subtitle: Text(
                      _avaInChatOn ? 'Ava can help in this chat' : 'Ava is off for this chat',
                      style: ADText.preview(c: AD.textTertiary)),
                  value: _avaInChatOn,
                  activeColor: AD.textPrimary,
                  onChanged: (v) async {
                    await _setAvaInChat(v);
                    if (sctx.mounted) setSheet(() {});
                  },
                )),
          // STREAM G [GROUP-AI-1]: catch-up on a busy group thread. Shown only for
          // a group with >25 unread; the guardrail is re-checked in _whatDidIMiss.
          if ((widget.chat.group || widget.chat.gid != null) && _unreadIncoming > 25)
            _action(ctx, PhosphorIcons.sparkle(PhosphorIconsStyle.bold), 'What did I miss?',
                () { Navigator.pop(ctx); _whatDidIMiss(); }),
          // STREAM G [GROUP-AI-2/3]: per-member "translate this group for me".
          // Hidden while the groupTranslationEnabled flag (cost watch) is OFF.
          if ((widget.chat.group || widget.chat.gid != null) && RemoteConfig.groupTranslationEnabled)
            _action(ctx, PhosphorIcons.translate(PhosphorIconsStyle.bold),
                _groupTranslateOn ? 'Stop translating this group' : 'Translate this group for me',
                () { Navigator.pop(ctx); _toggleGroupTranslate(); }),
          _action(ctx, PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), 'Search',
              () { Navigator.pop(ctx); setState(() { _searchMode = true; _searchQuery = ''; }); }),
          _action(ctx, PhosphorIcons.images(PhosphorIconsStyle.bold), 'Media, links & docs',
              () { Navigator.pop(ctx); _openMediaLibrary(); }),
          _action(
              ctx,
              _hideDeleted
                  ? PhosphorIcons.eye(PhosphorIconsStyle.bold)
                  : PhosphorIcons.eyeSlash(PhosphorIconsStyle.bold),
              _hideDeleted ? 'Show deleted messages' : 'Hide deleted messages',
              () { Navigator.pop(ctx); _toggleHideDeleted(); }),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.timer(PhosphorIconsStyle.bold),
                _disappearSecs == 0 ? 'Disappearing messages' : 'Disappearing: ${_disappearLabel(_disappearSecs)}',
                _pickDisappear),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.paintRoller(PhosphorIconsStyle.bold), 'Chat theme', _pickWallpaper),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.archive(PhosphorIconsStyle.bold), 'Archive chat', () async {
              await ChatFlagsStore().toggle('archived', _convKey!);
              if (mounted) Navigator.pop(context);
            }),
          if (_convKey != null)
            _action(ctx, PhosphorIcons.bellSlash(PhosphorIconsStyle.bold), 'Mute chat',
                () => ChatFlagsStore().toggle('muted', _convKey!)),
          if (_convKey != null && !widget.chat.group)
            _action(ctx, PhosphorIcons.prohibit(PhosphorIconsStyle.bold), 'Block user', () async {
              await ChatFlagsStore().toggle('blocked', _convKey!);
              if (mounted) Navigator.pop(context);
            }, danger: true),
          _action(ctx, PhosphorIcons.broom(PhosphorIconsStyle.bold), 'Delete chat', () => Navigator.pop(context)),
          ]),
        ),
      ),
    );
  }

  /// Toggle (and remember, per-conversation) whether deleted-message pills and
  /// tombstones are hidden from the thread.
  Future<void> _toggleHideDeleted() async {
    final next = !_hideDeleted;
    setState(() => _hideDeleted = next);
    try {
      await _aiPrefs.write(
          key: scopedKey('${_kHideDeletedKey}_${widget.chat.seed}'),
          value: next ? '1' : '0');
    } catch (_) {/* preference best-effort */}
    Analytics.capture('chat_hide_deleted_toggled', {'on': next});
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(next ? 'Deleted messages hidden' : 'Deleted messages shown'),
        duration: const Duration(seconds: 2),
      ));
    }
  }

  /// "Discuss with Ava" — open ChatAVA (the Companion thread) pointed at THIS
  /// conversation. The transcript is assembled on-device from the already-decoded
  /// bubbles and passed transiently as grounding context; it is never indexed
  /// server-side (DM/group content stays on the phone). Gated at use by the
  /// matching AvaBrain consent toggle.
  Future<void> _discussWithAva() async {
    final isGroup = widget.chat.group || widget.chat.gid != null;
    // Consent gate: DMs use 'avatok_dms' (on-device only), groups 'group_chats'.
    final allowed = await BrainConsent.isOn(isGroup ? 'group_chats' : 'avatok_dms');
    if (!mounted) return;
    if (!allowed) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Turn on AvaBrain for your messages in Settings to discuss '
            'a chat with Ava. Your messages stay on this device.'),
      ));
      return;
    }
    // Build the transcript from the visible bubbles (skip Ava/system/special).
    final turns = <DiscussTurn>[];
    for (final m in _msgs) {
      if (m.special != null) continue; // ava bubbles, receipts, calls, etc.
      final text = m.text.trim();
      if (text.isEmpty) continue;
      // Groups: attribute each non-mine bubble to its sender so Ava can tell
      // participants apart. 1:1 falls back to the peer label.
      turns.add(DiscussTurn(me: m.me, text: text, speaker: m.me ? null : m.senderLabel));
    }
    // Long threads need a summarisation pass — let the user know we're reading.
    if (turns.length > ThreadContext.kRawTailTurns * 4) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        duration: Duration(seconds: 2),
        content: Text('Reading your chat for Ava…'),
      ));
    }
    // Assemble the grounding block on-device. Short threads come back verbatim;
    // long ones are map-reduce summarised (recent tail kept raw) to stay lean.
    final transcript = await ThreadContext.buildSmart(
      peerLabel: widget.chat.name,
      turns: turns,
      isGroup: isGroup,
      summarize: (chunk) async {
        final ans = await AvaAiClient.I.ask(
          message: 'Summarise these chat messages in 2-3 sentences. Preserve who '
              'said what and any decisions, plans, questions, or feelings:\n\n$chunk',
        );
        return ans.answer;
      },
    );
    if (!mounted) return;
    if (transcript.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Not enough messages here yet for Ava to weigh in.'),
      ));
      return;
    }
    Analytics.capture('discuss_with_ava_opened', {
      'surface': 'thread',
      'is_group': isGroup,
      'turns': turns.length,
      'chars': transcript.length,
      'summarized': transcript.contains('(summarised)'),
    });
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CompanionThreadScreen(
        persona: discussPersona(widget.chat.name, isGroup: isGroup),
        discussContext: transcript,
        initialTitle: 'Chat with ${widget.chat.name}',
        onUseDraft: _prefillComposer,
      ),
    ));
  }

  /// Pre-fill the composer with a draft Ava handed back from "Discuss with Ava".
  /// We never auto-send — the user reviews/edits before it goes to the peer.
  void _prefillComposer(String text) {
    _ctrl.text = text;
    _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    _composerFocus.requestFocus();
  }

  /// Open the chat library — every photo, video, link and doc shared here.
  void _openMediaLibrary() {
    final media = <ChatMedia>[];
    final docs = <ChatMedia>[];
    final links = <LinkItem>[];
    final linkRe = RegExp(r'(https?://[^\s]+)', caseSensitive: false);
    for (final m in _msgs) {
      if (m.media != null) {
        final k = m.media!.kind;
        if (k == MediaKind.image || k == MediaKind.video) {
          media.add(m.media!);
        } else {
          docs.add(m.media!); // file + audio/voice
        }
      }
      for (final match in linkRe.allMatches(m.text)) {
        final url = match.group(1);
        if (url != null) links.add(LinkItem(url: url, ts: m.ts, me: m.me));
      }
    }
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => MediaLibraryScreen(
            title: widget.chat.name, media: media, docs: docs, links: links)));
  }

  String _disappearLabel(int s) => s == 0 ? 'Off' : (s >= 604800 ? '1 week' : (s >= 86400 ? '1 day' : '1 hour'));

  void _pickDisappear() {
    showModalBottomSheet(
      context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.all(14),
            child: Text('Disappearing messages', style: ADText.threadName())),
        for (final opt in [['Off', 0], ['1 hour', 3600], ['1 day', 86400], ['1 week', 604800]])
          ListTile(
            title: Text(opt[0] as String),
            trailing: _disappearSecs == opt[1]
                ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.iconSearch)
                : null,
            onTap: () async {
              final secs = opt[1] as int;
              await ChatTimerStore().set(_convKey!, secs == 0 ? '' : '$secs');
              if (mounted) { setState(() => _disappearSecs = secs); Navigator.pop(ctx); }
            },
          ),
      ])),
    );
  }

  // [CHAT-PASTE-1] One-time tip (per account) shown the first time the attach
  // menu is opened, now that the redundant 'Paste image' tile is gone: it tells
  // users the message box itself pastes images via long-press.
  static const String _kPasteHintKey = 'chat_paste_hint_shown';
  Future<void> _maybeShowPasteHint() async {
    try {
      final seen = await readScoped(_aiPrefs, _kPasteHintKey);
      if (seen == '1') return;
      await _aiPrefs.write(key: scopedKey(_kPasteHintKey), value: '1');
      if (mounted) _capNote('Tip: long-press the message box to paste images');
    } catch (_) {/* best-effort */}
  }

  // ---- attach menu (+) ----
  void _attach() {
    // ignore: unawaited_futures
    _maybeShowPasteHint();
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(spacing: 18, runSpacing: 18, children: [
            _attachItem(ctx, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Photos', AD.iconSearch, _pickPhotos),
            // [CHAT-PASTE-1] 'Paste image' removed — the message box already pastes
            // images natively (keyboard commitContent + context-menu Paste). A
            // one-time hint (below) points users at the long-press paste instead.
            _attachItem(ctx, PhosphorIcons.camera(PhosphorIconsStyle.bold), 'Camera', AD.primaryBadge, () => _pickImage(ImageSource.camera)),
            _attachItem(ctx, PhosphorIcons.folderOpen(PhosphorIconsStyle.bold), 'Library', AD.online, _addFromLibrary),
            _attachItem(ctx, PhosphorIcons.videoCamera(PhosphorIconsStyle.bold), 'Video', AD.danger, () => _pickVideo(ImageSource.camera)),
            _attachItem(ctx, PhosphorIcons.file(PhosphorIconsStyle.bold), 'File', AD.iconVideo, _pickFile),
            _attachItem(ctx, PhosphorIcons.mapPin(PhosphorIconsStyle.bold), 'Location', AD.online, _shareLocation),
            _attachItem(ctx, PhosphorIcons.broadcast(PhosphorIconsStyle.bold), 'Live location', AD.danger, _shareLiveLocation),
            _attachItem(ctx, PhosphorIcons.user(PhosphorIconsStyle.bold), 'Contact', AD.iconSearch, _shareContactCard),
            _attachItem(ctx, PhosphorIcons.chartBar(PhosphorIconsStyle.bold), 'Poll', AD.primaryBadge, _createPoll),
            _attachItem(ctx, PhosphorIcons.smiley(PhosphorIconsStyle.bold), 'Sticker', AD.iconVideo, _stickerPicker),
          ]),
        ),
      ),
    );
  }

  // Attachment tile — zine icon badge (flat accent fill, ink border, hard
  // shadow) + mono label. Accents rotate per tile (§6).
  Widget _attachItem(BuildContext ctx, IconData icon, String label, Color color, VoidCallback onTap) =>
      GestureDetector(
        onTap: () { Navigator.pop(ctx); onTap(); },
        child: SizedBox(
          width: 72,
          child: Column(children: [
            Container(width: 56, height: 56,
                decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(AD.rListCard),
                    border: Border.all(color: AD.borderControl, width: 1),
                    boxShadow: const []),
                child: Icon(icon, color: color == AD.danger ? Colors.white : AD.textPrimary, size: 24)),
            const SizedBox(height: 8),
            Text(label.toUpperCase(), style: ADText.statCaption(c: AD.textSecondary)),
          ]),
        ),
      );

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
                              ? (c.group ? '${_typingWho ?? "Someone"} is typing…' : 'typing…')
                              : (c.group ? '${c.members} members · tap to manage'
                                  : (_peerOnline ? 'online' : _relLastSeen()))).toUpperCase(),
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
                  // Phase 10 RULE CHANGE: group conferences (LiveKit, ≤25).
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
                var visible = _msgs
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
                final searching = _searchMode && _searchQuery.trim().isNotEmpty;
                if (searching) {
                  final q = _foldSearch(_searchQuery);
                  visible = visible.where((m) => _foldSearch(m.text).contains(q)).toList();
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
                // [AVA-CHAT-INSTANT] Keep the list laid out but invisible + inert
                // until the first jump-to-end lands, so the thread opens already
                // anchored on the newest message (no visible scroll-through).
                return Opacity(
                  opacity: _openReveal ? 1.0 : 0.0,
                  child: IgnorePointer(
                  ignoring: !_openReveal,
                  child: ListView.builder(
                  controller: _scroll,
                  // [UI-BUBBLE-1] Symmetric 12dp horizontal thread padding for both
                  // incoming & outgoing (bubbles cap at 78% of the thread width).
                  padding: const EdgeInsets.fromLTRB(12, 16, 12, 8),
                  itemCount: visible.length + headerCount + footerCount,
                  itemBuilder: (c, i) {
                    if (showArchiveHeader && i == 0) return _olderMessagesDivider();
                    final vi = i - headerCount;
                    if (showAiFooter && vi == visible.length) return _aiSearchFooter();
                    final m = visible[vi];
                    // Phase 5: insert a "Today / Yesterday / date" separator above
                    // the first message of each new calendar day.
                    final needsSep = m.ts != 0 &&
                        (vi == 0 || !_sameDay(visible[vi - 1].ts, m.ts));
                    if (!needsSep) return _bubble(m);
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [_daySeparator(_dayLabel(m.ts)), _bubble(m)],
                    );
                  },
                ))); // [AVA-CHAT-INSTANT] close ListView.builder / IgnorePointer / Opacity
              }),
              ),
            ),
            if (_mentionMatches.isNotEmpty) _mentionBar(),
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

  // Floating-emoji bursts rise + fade from the bottom. Each _BurstFx self-removes
  // after the animation (see _spawnBurst). Horizontal offset is deterministic per
  // id so concurrent bursts spread out instead of stacking.
  Widget _burstOverlay() {
    final w = MediaQuery.of(context).size.width;
    return Stack(children: [
      for (final b in _burstFx)
        TweenAnimationBuilder<double>(
          key: ValueKey(b.id),
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 2100),
          curve: Curves.easeOut,
          builder: (_, t, __) => Positioned(
            left: 24 + ((b.id * 53) % (w.toInt().clamp(120, 4000) - 80)).toDouble(),
            bottom: 90 + t * (MediaQuery.of(context).size.height * 0.5),
            child: Opacity(
              opacity: (1 - t).clamp(0.0, 1.0),
              child: Transform.scale(scale: 1 + t * 0.6, child: Text(b.emoji, style: const TextStyle(fontSize: 34))),
            ),
          ),
        ),
    ]);
  }

  // Uniform header action button — fixed 40x40 hit area, zero internal padding,
  // so the row of actions sits with even spacing and no trailing dead space.
  // ---- shield watchdog (Ava guardian) -----------------------------------------
  String? get _guardianConv {
    final key = _convKey;
    final uid = _meId?.uid;
    if (key == null || uid == null || uid.isEmpty) return null;
    return serverConvFromKey(key, uid);
  }

  // STREAM B (SAFE-GATE-1/2): gate a NEW thread from a NON-CONTACT. The contact
  // check is client-side (ContactsStore is local); the server enforces the
  // receipt suppression once the state is 'pending'. We reconcile with the
  // server (multi-device) but render the local decision instantly.
  Future<void> _initStrangerGate(String peerHex) async {
    if (!StrangerGateBar.enabled) return;
    final conv = _serverConv;
    if (conv == null || peerHex.isEmpty) return;
    try {
      // Respect an explicit stored/server decision. NOTE: 'accepted' is also the
      // DEFAULT for a fresh thread, so we do NOT early-return on accepted here —
      // the contact check + inbound/outbound guards below decide a new thread. Only
      // a blocked thread short-circuits (handled elsewhere).
      final serverState = await StrangerGateApi.state(conv);
      if (serverState == AcceptState.blocked) return;
      // If I already explicitly accepted (I have outbound below) this stays open.
      // Confirm the peer is really a non-contact before gating.
      final contacts = await ContactsStore().load();
      final isContact = contacts.any((c) => c.uid == peerHex);
      if (isContact) { if (mounted) setState(() => _threadAcceptState = 'accepted'); return; } // a saved contact is never gated
      // Only INBOUND-first threads are gated: if I already sent in this thread I
      // initiated contact (e.g. marketplace "Contact seller"), so no gate. History
      // loads async, so we re-check once (the send path also clears the gate via
      // implicit-accept). Empty thread with no inbound → nothing to gate yet.
      final hasOutbound = _msgs.any((m) => m.me);
      final hasInbound = _msgs.any((m) => !m.me);
      if (hasOutbound || !hasInbound) return;
      // Non-contact. If the server hasn't recorded a pending state yet (a brand-new
      // inbound thread reads as the 'accepted' default), DECLARE it pending so the
      // server starts suppressing our read-receipts to the stranger.
      if (serverState != AcceptState.pending) {
        await StrangerGateApi.declarePending(conv);
      }
      if (!mounted) return;
      setState(() { _strangerGatePending = true; _threadAcceptState = 'pending'; });
      StrangerGateBar.trackShown(conv, peerHex);
      // Prompt a decision up front with a modal overlay (once per open). The
      // inline StrangerGateBar remains for when the user dismisses the overlay.
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowStrangerGateSheet(peerHex));
    } catch (_) { /* fail open — no gate rather than a broken thread */ }
  }

  /// Modal overlay shown when a non-contact thread is opened: Accept, Decline
  /// (leave it in Message requests), Block or Report. Mirrors StrangerGateBar's
  /// actions/telemetry so the two entry points stay consistent. Shown once per
  /// thread open; the inline bar handles subsequent decisions.
  Future<void> _maybeShowStrangerGateSheet(String peerHex) async {
    if (!mounted || _gatePromptShown || !_strangerGatePending) return;
    if (_serverConv == null || !StrangerGateBar.enabled) return;
    _gatePromptShown = true;
    final conv = _serverConv!;
    final name = widget.chat.name.trim().isEmpty ? 'This person' : widget.chat.name.trim();
    bool busy = false;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      isDismissible: true,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderControl, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        Future<void> run(Future<void> Function() action, String verb) async {
          if (busy) return;
          setSheet(() => busy = true);
          try { await action(); } catch (_) {}
        }
        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                PhosphorIcon(PhosphorIcons.userCircle(PhosphorIconsStyle.bold), size: 26, color: AD.iconSearch),
                const SizedBox(width: 10),
                Expanded(child: Text('Message request', style: ADText.rowName())),
              ]),
              const SizedBox(height: 10),
              Text('$name is not in your contacts. Accept to reply, or block/report if it looks like spam. Decline keeps it under Message requests.',
                  style: ADText.preview()),
              const SizedBox(height: 18),
              // Accept — restore the composer and resume normal receipts.
              _gateSheetBtn(
                icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold),
                label: 'Accept', bg: AD.primaryBadge, fg: AD.textPrimary, busy: busy,
                onTap: () => run(() async {
                  await StrangerGateApi.accept(conv);
                  trackStrangerGate('stranger_gate_accept', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                  if (mounted) setState(() { _strangerGatePending = false; _threadAcceptState = 'accepted'; });
                  if (ctx.mounted) Navigator.of(ctx).pop();
                }, 'accept'),
              ),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: _gateSheetBtn(
                  icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                  label: 'Block', bg: AD.iconVideo, fg: AD.textPrimary, busy: busy,
                  onTap: () => run(() async {
                    await StrangerGateApi.block(conv: conv, uid: peerHex.isEmpty ? null : peerHex);
                    trackStrangerGate('stranger_gate_block', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                    if (ctx.mounted) Navigator.of(ctx).pop();
                    if (mounted) Navigator.of(context).maybePop(); // leave the thread
                  }, 'block'),
                )),
                const SizedBox(width: 10),
                Expanded(child: _gateSheetBtn(
                  icon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
                  label: 'Report', bg: AD.danger, fg: Colors.white, busy: busy,
                  onTap: () => run(() async {
                    final id = await StrangerGateApi.report(conv: conv, lastN: 10);
                    trackStrangerGate('stranger_gate_report', {'conv': conv, 'peer': peerHex, 'ok': id != null, 'via': 'overlay'});
                    if (ctx.mounted) Navigator.of(ctx).pop();
                    if (mounted) Navigator.of(context).maybePop();
                  }, 'report'),
                )),
              ]),
              const SizedBox(height: 10),
              // Decline = not now: dismiss, keep pending so it stays in Message requests.
              Center(child: TextButton(
                onPressed: busy ? null : () {
                  trackStrangerGate('stranger_gate_decline', {'conv': conv, 'peer': peerHex, 'via': 'overlay'});
                  Navigator.of(ctx).pop();
                },
                child: Text('Decline', style: ADText.rowName(c: AD.textSecondary)),
              )),
            ]),
          ),
        );
      }),
    );
  }

  Widget _gateSheetBtn({
    required IconData icon, required String label, required Color bg,
    required Color fg, required bool busy, required VoidCallback onTap,
  }) => ZinePressable(
        onTap: busy ? null : onTap,
        color: bg,
        radius: BorderRadius.circular(14),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          PhosphorIcon(icon, size: 18, color: fg),
          const SizedBox(width: 8),
          Text(label, style: ADText.rowName(c: fg)),
        ]),
      );

  Future<void> _loadGuardian() async {
    final conv = _guardianConv;
    if (conv == null) return;
    try {
      final p = await GuardianPrefsClient.I.get(conv);
      if (mounted) setState(() => _guardian = p);
    } catch (_) {/* keep default off */}
  }

  // Tap the shield → toggle Ava watching THIS chat for scams/grooming/unsafe
  // behaviour. Green = on. Single tap toggles off with no confirmation. Long-press
  // opens the full guardian sheet. G1.3: for MINOR accounts Guardian is force-ON —
  // the shield is locked and this is a no-op (guarded in _shieldAction too).
  Future<void> _toggleGuardian() async {
    if (_isMinorAccount) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Guardian always protects this account')));
      return;
    }
    final conv = _guardianConv;
    if (conv == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Guardian isn’t available for this chat yet')));
      return;
    }
    final next = await GuardianPrefsClient.I.set(conv, secureChat: !_guardian.secureChat, source: 'tap');
    if (!mounted) return;
    setState(() => _guardian = next);
    // Turning ON pops the centered Guardian notice (design 2026-07-13); turning
    // OFF shows a quick snackbar.
    if (next.secureChat) {
      _showGuardianNotice(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Ava watch turned off for this chat')));
    }
  }

  /// Centered Guardian notice modal (design 2026-07-13): dark card, shield glyph,
  /// title + body, single "Got it" button. [on] switches between the "watching"
  /// and "not monitoring" copy/icon.
  void _showGuardianNotice(bool on) {
    showDialog<void>(
      context: context,
      barrierColor: Colors.black.withValues(alpha: 0.7),
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.symmetric(horizontal: 34),
        child: Container(
          decoration: BoxDecoration(
            color: AD.popover,
            border: Border.all(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(18),
            boxShadow: AD.dialogShadow,
          ),
          padding: const EdgeInsets.fromLTRB(24, 26, 24, 22),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 56, height: 56,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: kGuardianGreen.withValues(alpha: 0.15),
              ),
              child: PhosphorIcon(
                  on ? PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold)
                     : PhosphorIcons.shieldSlash(PhosphorIconsStyle.bold),
                  size: 26, color: on ? kGuardianGreen : AD.danger),
            ),
            const SizedBox(height: 12),
            Text(
              on ? 'Guardian is watching this chat'
                 : 'Guardian is not monitoring this chat',
              textAlign: TextAlign.center,
              style: ADText.threadName().copyWith(fontSize: 16.5),
            ),
            const SizedBox(height: 8),
            Text(
              on
                  ? 'Ava is now reviewing this conversation for safety. You’ll get a private heads-up if something looks unsafe.'
                  : 'Messages in this conversation aren’t being reviewed for safety. Stay alert and only share what you’re comfortable with.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary).copyWith(height: 1.55),
            ),
            const SizedBox(height: 18),
            GestureDetector(
              onTap: () => Navigator.of(ctx).pop(),
              child: Container(
                height: 40,
                padding: const EdgeInsets.symmetric(horizontal: 28),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AD.sendActiveBg,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text('Got it',
                    style: ADText.rowName(c: AD.sendActiveInk)),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  // G1.2: when the user ACCEPTS a message request from a non-contact stranger,
  // auto-enable Guardian for the chat (source: 'stranger_accept') and show a brief
  // notice. Best-effort — a failed prefs write never blocks the accept. Skipped for
  // minors (already force-ON) and when the shield is already on.
  Future<void> _autoEnableGuardianOnAccept() async {
    if (_isMinorAccount || _guardian.secureChat) return;
    final conv = _guardianConv;
    if (conv == null) return;
    try {
      final next = await GuardianPrefsClient.I.set(conv, secureChat: true, source: 'stranger_accept');
      if (!mounted) return;
      setState(() => _guardian = next);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Ava Guardian is on for this chat — tap the shield to turn it off.')));
    } catch (_) {/* best-effort — never block the accept */}
  }

  void _openGuardianSheet() {
    final conv = _guardianConv;
    if (conv == null) return;
    // U1-lite: pass the peer uid for 1:1 chats so the (dark) "Require verification"
    // row can address the peer. Null for groups → the row is hidden there.
    GuardianSettingsSheet.show(context,
            conv: conv,
            chatLabel: widget.chat.name,
            peerUid: _isGroup ? null : _peerNpub)
        .then((_) => _loadGuardian());
  }

  // Header action icons (shield / search / call / video / ⋮). Bumped to 26px
  // with 46px tap targets (owner request 2026-06-24: the top-bar icons were too
  // small to read/tap comfortably).
  Widget _headerAction(IconData icon, VoidCallback onTap,
          {double size = 26, Color color = AD.textPrimary}) =>
      IconButton(
        icon: PhosphorIcon(icon, size: size, color: color),
        onPressed: onTap,
        visualDensity: VisualDensity.compact,
        padding: EdgeInsets.zero,
        splashRadius: 26,
        constraints: const BoxConstraints(minWidth: 46, minHeight: 46),
      );

  // Shield watchdog toggle: GREEN when Ava is watching this chat. Single tap
  // toggles (no confirmation); long-press opens the full guardian settings.
  // G1.3: for MINOR accounts the shield is LOCKED-ON — green, no toggle, a tooltip
  // explaining Guardian always protects the account.
  Widget _shieldAction() {
    if (_isMinorAccount) {
      return Tooltip(
        message: 'Guardian always protects this account',
        child: _headerAction(
          PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
          () => ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Guardian always protects this account'))),
          color: kGuardianGreen,
        ),
      );
    }
    final on = _guardian.secureChat;
    return GestureDetector(
      onLongPress: _openGuardianSheet,
      child: _headerAction(
        on ? PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill)
           : PhosphorIcons.shield(PhosphorIconsStyle.bold),
        _toggleGuardian,
        color: on ? kGuardianGreen : AD.textSecondary,
      ),
    );
  }

  // Lime circular send button — ink border, hard shadow (the screen's one
  // lime primary action).
  Widget _sendCircle(IconData icon, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(width: 44, height: 44,
            decoration: BoxDecoration(
                color: AD.sendActiveBg, shape: BoxShape.circle,
                border: Border.all(color: AD.borderControl, width: 1), boxShadow: const []),
            child: Icon(icon, color: AD.sendActiveInk, size: 20)),
      );

  /// [VOICE-REC-1] (owner report 2026-07-16, pic 5) The recording bar.
  ///
  /// Replaces a single line of static text ("Recording… tap to send") with the
  /// four things the owner asked for, and that WhatsApp has:
  ///   • a LIVE waveform driven by the mic's real amplitude, so you can see it
  ///     hearing you — the whole point of his "I am not even sure if it is
  ///     listening to me";
  ///   • the elapsed time, so a long note isn't a guess;
  ///   • a bin to discard the take (there was NO way to cancel — the only
  ///     control sent it, so a fluffed sentence had to be sent and deleted);
  ///   • a pause/resume, which is also what auto-pause-on-background resumes to.
  Widget _recordingBar(BoxDecoration bandDeco) {
    final mm = _recElapsed.inMinutes.toString();
    final ss = (_recElapsed.inSeconds % 60).toString().padLeft(2, '0');
    return Container(
      decoration: bandDeco,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      // NOTE: no SafeArea here — the caller already wraps _inputBar() in one.
      child: Row(children: [
          // Discard. Sits on the far left, away from send — a destructive action
          // should never be adjacent to the one you're reaching for.
          IconButton(
            tooltip: 'Delete recording',
            icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold),
                color: AD.danger, size: 22),
            onPressed: () => _cancelRecording(),
          ),
          // Blinking dot + elapsed. The dot stops blinking while paused, so
          // "paused" is legible at a glance and not just an icon swap.
          _RecordingDot(active: !_recPaused),
          const SizedBox(width: 8),
          SizedBox(
            width: 44,
            child: Text('$mm:$ss',
                style: ADText.bubbleMeta(c: AD.textSecondary)),
          ),
          // The live waveform.
          Expanded(
            child: SizedBox(
              height: 32,
              child: _recPaused
                  ? Align(
                      alignment: Alignment.centerLeft,
                      child: Text('Paused · tap ▶ to continue',
                          style: ADText.bubbleMeta(c: AD.textSecondary)),
                    )
                  : LiveWaveform(levels: _recLevels),
            ),
          ),
          const SizedBox(width: 4),
          IconButton(
            tooltip: _recPaused ? 'Resume recording' : 'Pause recording',
            icon: PhosphorIcon(
                _recPaused
                    ? PhosphorIcons.play(PhosphorIconsStyle.fill)
                    : PhosphorIcons.pause(PhosphorIconsStyle.fill),
                color: AD.textSecondary,
                size: 22),
            onPressed: _toggleRecordPause,
          ),
          _sendCircle(
              PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill), _toggleRecord),
      ]),
    );
  }

  // [AVA-GRP-UI] Full-width ORANGE rule that caps the composer, visually
  // separating the input area (hint row + field) from the bubble list above it
  // (owner request). Uses the app orange accent `AD.unreadAccent` (0xFFF2A65A);
  // sits at the very top of the composer band so it spans the whole screen width.
  Widget _composerTopDivider() =>
      Container(width: double.infinity, height: 2.5, color: AD.unreadAccent);

  Widget _inputBar() {
    // Input band: paper-2 with ink top border; field = ink-bordered pill.
    const bandDeco = BoxDecoration(
      color: AD.headerFooter,
      border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
    );
    if (_recording) return _recordingBar(bandDeco);
    // STREAM E: WhatsApp-parity rich input bar + emoji/GIF/sticker panel (flag ON
    // by default). Reuses the SAME handlers as the legacy row below (_send,
    // _attach, camera, _toggleRecord, _onInputChanged) so send/attach/camera/mic
    // behaviour is unchanged; adds the emoji/GIF/sticker panel + GIF/sticker send.
    // The reply/listening banners + quick-tools ride in `topSlot`. When the flag
    // is OFF we fall through to the legacy composer below.
    if (RemoteConfig.richInputEnabled) {
      return RichInputBar(
        controller: _ctrl,
        focusNode: _composerFocus,
        hasText: _hasText,
        hintText: _avaMode ? 'Ask Ava privately…' : 'Message',
        fieldColor: _avaMode ? AD.micIdleBg : AD.inputField,
        onSend: _send,
        onAttach: _attach,
        onCamera: () => _pickImage(ImageSource.camera),
        onMic: _toggleRecord,
        onChanged: _onInputChanged,
        onGif: _sendGif,
        onSticker: _sendStickerAsset,
        topSlot: Column(mainAxisSize: MainAxisSize.min, children: [
          _composerTopDivider(),
          if (_replyTo != null || _editing != null) _replyBanner(),
          if (_sttActive) _listeningBanner(),
          if (_showComposePreview) _composePreviewBar(),
          _composerTools(),
        ]),
      );
    }
    return Container(
      decoration: bandDeco,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        _composerTopDivider(),
        if (_replyTo != null || _editing != null) _replyBanner(),
        if (_sttActive) _listeningBanner(),
        if (_showComposePreview) _composePreviewBar(),
        _composerTools(),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 12, 10),
          // Bottom-align so the + and send controls stay pinned to the bottom
          // as the multi-line field grows upward. (The Ava-mode toggle now
          // lives in the quick-tools row above — see _avaModeChip.)
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        IconButton(
            icon: PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.bold), color: AD.iconClipOnWhite, size: 26),
            onPressed: _attach),
        // Phase 4: tap = send a 🎉 burst to the room; long-press picks the emoji.
        if (_party != null)
          GestureDetector(
            onLongPress: _pickBurstEmoji,
            child: IconButton(
              icon: PhosphorIcon(PhosphorIcons.confetti(PhosphorIconsStyle.bold), color: AD.danger, size: 24),
              onPressed: () => _sendBurst('🎉'),
            ),
          ),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
                color: _avaMode ? AD.micIdleBg : AD.inputField,
                borderRadius: BorderRadius.circular(AD.rInput),
                border: Border.all(color: AD.borderControl, width: 1)),
            // Wrap the field so BOTH a hardware Cmd/Ctrl+V and the long-press
            // toolbar "Paste" route through _onComposerPaste — which pastes an
            // image from the clipboard (super_clipboard) when one is present and
            // otherwise pastes text as usual. Without this the box silently
            // ignores copied images (Flutter's clipboard is text-only).
            child: Actions(
              actions: {
                PasteTextIntent: CallbackAction<PasteTextIntent>(
                  onInvoke: (intent) {
                    _onComposerPaste(via: 'keyboard');
                    return null;
                  },
                ),
              },
              child: TextField(
              controller: _ctrl,
              focusNode: _composerFocus,
              onChanged: _onInputChanged,
              onSubmitted: (_) => _send(),
              // Accept images inserted by the keyboard / system clipboard (Samsung
              // "super paste", Gboard image paste, GIF insert). These arrive via
              // Android's InputConnection.commitContent — NOT PasteTextIntent — so
              // without this config the image is silently dropped (the input box
              // stays empty and the system falls back to a blank editor view).
              contentInsertionConfiguration: ContentInsertionConfiguration(
                allowedMimeTypes: const [
                  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
                ],
                onContentInserted: _onContentInserted,
              ),
              // Auto-grow upward as the user types (1 line → max 5, then it
              // scrolls internally so the text always stays in view). Enter
              // still sends — the keyboard action button is wired to send.
              minLines: 1,
              maxLines: 5,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.send,
              style: ADText.rowName(c: AD.textOnInput),
              cursorColor: AD.iconSearch,
              contextMenuBuilder: (ctx, editableState) {
                // Rebuild the default selection toolbar but re-point its "Paste"
                // button at our image-aware handler, so pasting a copied image
                // works from the toolbar too.
                final items = editableState.contextMenuButtonItems
                    .map((b) => b.type == ContextMenuButtonType.paste
                        ? ContextMenuButtonItem(
                            type: ContextMenuButtonType.paste,
                            onPressed: () {
                              editableState.hideToolbar();
                              _onComposerPaste();
                            },
                          )
                        : b)
                    .toList();
                return AdaptiveTextSelectionToolbar.buttonItems(
                  anchors: editableState.contextMenuAnchors,
                  buttonItems: items,
                );
              },
              decoration: InputDecoration(
                  hintText: _avaMode ? 'Ask Ava privately…' : 'Message',
                  hintStyle: ADText.rowName(c: AD.placeholderOnWhite).copyWith(
                      fontWeight: FontWeight.w600),
                  border: InputBorder.none, isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 12)),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        if (_sttActive)
          GestureDetector(
            onTap: _stopVoiceToText,
            child: Container(width: 44, height: 44,
                decoration: BoxDecoration(
                    color: AD.danger, shape: BoxShape.circle,
                    border: Border.all(color: AD.borderControl, width: 1), boxShadow: const []),
                child: Icon(Icons.stop_rounded, color: Colors.white, size: 22)),
          )
        else
          // Mic is now a pure voice-note record button (owner request
          // 2026-06-27): tapping it starts/stops recording a voice message.
          // The old "Record audio / Convert voice to text" chooser (_openMicMenu)
          // and the speech-to-text path are no longer surfaced.
          _sendCircle(
              _hasText
                  ? PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill)
                  : PhosphorIcons.microphone(PhosphorIconsStyle.fill),
              _hasText ? _send : _toggleRecord),
          ]),
        ),
      ]),
    );
  }

  // Thin "Listening…" banner shown above the composer during voice-to-text.
  Widget _listeningBanner() => Container(
        padding: const EdgeInsets.fromLTRB(16, 8, 12, 0),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.waveform(PhosphorIconsStyle.fill),
              color: AD.online, size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: ValueListenableBuilder<String>(
              valueListenable: AvaOnDeviceStt.I.statusLine,
              builder: (_, s, __) => Text(
                s.isEmpty ? 'Listening…' : s,
                style: ADText.sectionLabel(c: AD.online),
              ),
            ),
          ),
          Text('TAP ■ TO INSERT', style: ADText.sectionLabel()),
        ]),
      );

  // ===========================================================================
  // Composer quick-tools row (Translate · Fix grammar · Rewrite · Reply ideas)
  // ===========================================================================

  /// The little horizontally-scrolling chip bar that sits right on top of the
  /// text field. Each chip runs one Ava call and writes the result back into
  /// the input box. The whole row dims while a job is in flight.
  Widget _composerTools() {
    // Centered, evenly-spaced quick tools. Each tool gets a distinct pastel
    // fill so it's recognizable at a glance. Wrap keeps them centered and never
    // overflows on narrow screens (falls to a second centered row if needed).
    // Spread the quick-tools evenly across the FULL width of the composer with
    // bigger, better-separated touch targets — they used to be tiny and bunched
    // in the centre with empty space either side. spaceEvenly gives equal gutters
    // left, right and between, so the row breathes and each chip is easy to hit.
    // Owner request (2026-06-27): the three quick-tool chips — Talk-to-Ava (✦),
    // Translate, and Help-me-write-better — are retired from the composer. In
    // their place a tiny PAID-ONLY hint reminds people how to summon Ava inline:
    // `@ava` for a private reply, `#ava` to ask Ava in front of everyone. Free
    // users see nothing here (Ava AI in chat is a paid feature). The old chip
    // builders below are intentionally left in place (unused) to keep this a
    // surgical, low-risk change.
    if (!_premium) return const SizedBox.shrink();
    return _avaHintNote();
  }

  /// Tiny paid-only reminder above the field: how to call Ava without a button.
  Widget _avaHintNote() => Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              size: 14, color: AD.iconSearch),
          const SizedBox(width: 6),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                const TextSpan(text: 'Type '),
                TextSpan(text: '@ava', style: ADText.preview(c: const Color(0xFF8FC0F5))
                    .copyWith(fontWeight: FontWeight.w800)),
                const TextSpan(text: ' for a private reply, or '),
                TextSpan(text: '#ava', style: ADText.preview(c: const Color(0xFF7BD98C))
                    .copyWith(fontWeight: FontWeight.w800)),
                const TextSpan(text: ' to ask Ava in the chat.'),
              ]),
              // White base text (was grey) so the hint reads clearly on dark.
              style: ADText.preview(c: AD.textPrimary),
            ),
          ),
        ]),
      );

  /// Ava-mode toggle chip — sits at the front of the quick-tools row. Flip ON
  /// to talk privately to Ava without typing @ava; flip back to message the
  /// person. Fills lilac + sparkle-fill when ON.
  Widget _avaModeChip() {
    return Tooltip(
        message: _avaMode
            ? 'Talking to Ava (tap to message ${widget.chat.name})'
            : 'Talk privately to Ava',
        child: GestureDetector(
          onTap: () {
            setState(() => _avaMode = !_avaMode);
            _composerFocus.requestFocus();
          },
          child: Container(
            width: 48, height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _avaMode ? AD.iconVideo : AD.card,
              shape: BoxShape.circle,
              border: Border.all(color: AD.borderControl, width: 1),
              boxShadow: const [],
            ),
            child: PhosphorIcon(
                PhosphorIcons.sparkle(
                    _avaMode ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                size: 23,
                color: _avaMode ? AD.iconSearch : AD.textPrimary),
          ),
        ),
      );
  }

  /// Consolidated "Help me write better" control — replaces the separate Fix
  /// grammar / Rewrite / Reply ideas chips. Tapping opens a menu of writing
  /// actions, so the composer row stays clean (Ava · Translate · Write help).
  Widget _writeHelpChip() {
    const writeTools = {'grammar', 'rewrite', 'reply_ideas'};
    final busy = _aiTool != null && writeTools.contains(_aiTool);
    final dimmed = _aiBusy && !busy;
    return Opacity(
      opacity: dimmed ? 0.4 : 1,
      child: GestureDetector(
        onTap: _aiBusy ? null : _openWriteHelp,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: busy ? AD.primaryBadge : AD.card,
            borderRadius: BorderRadius.circular(100),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: const [],
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            busy
                ? const SizedBox(width: 18, height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AD.textPrimary))
                : PhosphorIcon(PhosphorIcons.magicWand(PhosphorIconsStyle.bold), size: 20, color: AD.textPrimary),
            const SizedBox(width: 8),
            Text('Help me write better', style: ADText.statCaption(c: AD.textPrimary)),
          ]),
        ),
      ),
    );
  }

  /// Menu for [_writeHelpChip]: Fix grammar, the rewrite tones (flattened so a
  /// tone is one tap), and Reply ideas.
  Future<void> _openWriteHelp() async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
        child: SafeArea(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('HELP ME WRITE BETTER', style: ADText.sectionLabel()),
          const SizedBox(height: 12),
          _writeHelpRow(ctx, PhosphorIcons.checkCircle(PhosphorIconsStyle.bold), AD.iconSearch,
              'Fix grammar', 'Spelling & grammar, same meaning', 'grammar'),
          _writeHelpRow(ctx, PhosphorIcons.smiley(PhosphorIconsStyle.bold), AD.primaryBadge,
              'Friendlier', 'Warmer, friendlier tone', 'friendly'),
          _writeHelpRow(ctx, PhosphorIcons.briefcase(PhosphorIconsStyle.bold), AD.online,
              'More formal', 'Formal and professional', 'formal'),
          _writeHelpRow(ctx, PhosphorIcons.scissors(PhosphorIconsStyle.bold), AD.iconVideo,
              'Shorter & clearer', 'Trim it down, keep the point', 'short'),
          _writeHelpRow(ctx, PhosphorIcons.lightbulb(PhosphorIconsStyle.bold), AD.danger,
              'Reply ideas', 'Suggest replies to the last message', 'reply_ideas'),
        ])),
      ),
    );
    if (action == null || !mounted) return;
    switch (action) {
      case 'grammar': _runFixGrammar(); break;
      case 'reply_ideas': _runReplyIdeas(); break;
      case 'friendly': _runRewriteStyle('Friendlier', 'warmer and friendlier'); break;
      case 'formal': _runRewriteStyle('More formal', 'more formal and professional'); break;
      case 'short': _runRewriteStyle('Shorter & clearer', 'shorter, clearer and more concise'); break;
    }
  }

  Widget _writeHelpRow(BuildContext ctx, IconData icon, Color accent, String title, String subtitle, String action) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZinePressable(
        onTap: () => Navigator.pop(ctx, action),
        radius: BorderRadius.circular(AD.rListCard),
        boxShadow: const [],
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent, size: 32),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(subtitle, style: ADText.preview()),
          ])),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
        ]),
      ),
    );
  }

  /// Translate chip — split into two tap zones: the left runs a translation
  /// into the remembered language; the trailing language + caret opens the
  /// picker to change it.
  Widget _translateChip() {
    final busy = _aiTool == 'translate';
    final dimmed = _aiBusy && !busy;
    return Opacity(
        opacity: dimmed ? 0.4 : 1,
        child: Container(
          decoration: BoxDecoration(
            color: busy ? AD.primaryBadge : AD.online,
            borderRadius: BorderRadius.circular(100),
            border: Border.all(color: AD.borderControl, width: 1),
            boxShadow: const [],
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Tooltip(
              message: 'Translate',
              child: GestureDetector(
                onTap: _aiBusy ? null : _runTranslate,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(15, 13, 12, 13),
                  child: busy
                      ? const SizedBox(
                          width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: AD.textPrimary),
                        )
                      : PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                          size: 23, color: AD.textPrimary),
                ),
              ),
            ),
            GestureDetector(
              onTap: _aiBusy ? null : _pickTransLang,
              child: Container(
                padding: const EdgeInsets.fromLTRB(9, 9, 12, 9),
                decoration: const BoxDecoration(
                  border: Border(left: BorderSide(color: AD.borderControl, width: 1)),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(_transLang.label,
                      style: ADText.statCaption(c: AD.iconSearch)),
                  const SizedBox(width: 3),
                  PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                      size: 12, color: AD.iconSearch),
                ]),
              ),
            ),
          ]),
        ),
      );
  }

  /// Shared runner: flips the busy flags, fires the [call], reports failures,
  /// and returns the trimmed answer (or null on block/empty/error).
  Future<String?> _runAiTool(String tool, Future<AvaAnswer> Function() call,
      {Map<String, Object> props = const <String, Object>{}}) async {
    if (_aiBusy) return null;
    setState(() { _aiBusy = true; _aiTool = tool; });
    final t0 = DateTime.now().millisecondsSinceEpoch;
    var retried = false;
    Analytics.capture('composer_ai_used', <String, Object>{
      'tool': tool, 'is_group': _isGroup, ...props,
    });
    // Rich latency breakdown so we can answer "why was translate/suggest slow?":
    // client_ms (round-trip the user felt), server_ms/gen_ms/setup_ms (where the
    // server spent it), tool_calls (agentic round-trips — should be 0 for these),
    // whether we retried, and the network type. Attached to ok AND failure events.
    Map<String, Object> timing(AvaAnswer a) => <String, Object>{
          'total_ms': DateTime.now().millisecondsSinceEpoch - t0,
          'retried': retried,
          if (a.clientMs != null) 'client_ms': a.clientMs!,
          if (a.serverMs != null) 'server_ms': a.serverMs!,
          if (a.genMs != null) 'gen_ms': a.genMs!,
          if (a.setupMs != null) 'setup_ms': a.setupMs!,
          if (a.toolCalls != null) 'tool_calls': a.toolCalls!,
        };
    try {
      // One silent auto-retry on a TRANSIENT failure (a dropped request or a 5xx)
      // so a single network blip doesn't make the user re-tap the chip. A real
      // block (moderation / daily cap) or a populated answer is returned as-is.
      var a = await call();
      final transient1 = a.blocked &&
          (a.reason == 'network' || (a.reason?.startsWith('http_5') ?? false));
      if (transient1) {
        retried = true;
        await Future.delayed(const Duration(milliseconds: 350));
        if (!mounted) return null;
        a = await call();
      }
      if (!mounted) return null;
      if (a.blocked) {
        // Distinct copy per cause so the user knows whether to wait, top up, or
        // check their connection — not one catch-all "couldn't help".
        final String msg;
        if (a.hitDailyCap) {
          msg = 'Daily free AI limit reached — connect your own key in Settings for unlimited.';
        } else if (a.reason == 'network') {
          msg = 'Couldn’t reach Ava — check your connection and try again.';
        } else if (a.reason?.startsWith('http_5') ?? false) {
          msg = 'Ava is busy right now — give it a moment and try again.';
        } else {
          msg = 'Ava couldn’t help with that right now.';
        }
        _toolHint(msg);
        Analytics.capture('composer_ai_blocked', <String, Object>{
          'tool': tool, 'reason': a.reason ?? 'unknown', ...timing(a),
        });
        return null;
      }
      final out = a.answer.trim();
      if (out.isEmpty) {
        _toolHint('Ava returned nothing — try again.');
        Analytics.capture('composer_ai_empty', <String, Object>{'tool': tool, ...timing(a)});
        return null;
      }
      Analytics.capture('composer_ai_ok', <String, Object>{
        'tool': tool, 'tier': a.tier ?? 'unknown', ...timing(a),
      });
      return out;
    } catch (e) {
      if (mounted) _toolHint('Something went wrong. Check your connection.');
      Analytics.capture('composer_ai_error', {
        'tool': tool, 'total_ms': DateTime.now().millisecondsSinceEpoch - t0, 'retried': retried,
      });
      return null;
    } finally {
      if (mounted) setState(() { _aiBusy = false; _aiTool = null; });
    }
  }

  /// Drop [out] into the input box (replacing the draft), cursor at the end,
  /// keyboard kept up — the user just hits send.
  void _replaceComposer(String out) {
    _ctrl.value = TextEditingValue(
      text: out,
      selection: TextSelection.collapsed(offset: out.length),
    );
    setState(() => _hasText = out.trim().isNotEmpty);
    _refreshComposePreview(out);
    _composerFocus.requestFocus();
  }

  void _toolHint(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      behavior: SnackBarBehavior.floating,
      duration: const Duration(seconds: 3),
    ));
  }

  Future<void> _runTranslate() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a message first, then tap Translate'); return; }
    if (_aiBusy) return;
    // INSTANT PATH (pic4): on-device ML Kit translation (~tens of ms, offline,
    // free). Falls through to the server (Gemini) path when the language pair
    // isn't supported on-device or the model isn't downloaded yet (the download
    // runs deferred in the background, so the next tap is instant).
    final t0 = DateTime.now().millisecondsSinceEpoch;
    setState(() { _aiBusy = true; _aiTool = 'translate'; });
    final local = await OnDeviceTranslate.I.translate(text, _transLang.code);
    if (!mounted) return;
    setState(() { _aiBusy = false; _aiTool = null; });
    if (local != null) {
      Analytics.capture('composer_ai_ok', <String, Object>{
        'tool': 'translate', 'engine': 'ondevice', 'lang': _transLang.code,
        'total_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      _replaceComposer(local);
      return;
    }
    final out = await _runAiTool('translate',
        () => ComposerAi.translate(text, _transLang.code),
        props: {'lang': _transLang.code, 'engine': 'server'});
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runFixGrammar() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a message first, then tap Fix grammar'); return; }
    final out = await _runAiTool('grammar', () => ComposerAi.fixGrammar(text));
    if (out != null) _replaceComposer(out);
  }

  /// Rewrite the draft in a fixed [style] (called from the write-help menu).
  Future<void> _runRewriteStyle(String label, String style) async {
    final text = _ctrl.text.trim();
    if (text.isEmpty) { _toolHint('Type a draft first, then pick a style'); return; }
    final out = await _runAiTool('rewrite',
        () => ComposerAi.rewrite(text, style), props: {'tone': label});
    if (out != null) _replaceComposer(out);
  }

  Future<void> _runReplyIdeas() async {
    final incoming = _lastIncomingText();
    if (incoming == null) { _toolHint('No message to reply to yet'); return; }
    final out = await _runAiTool('reply_ideas',
        () => ComposerAi.replyIdeas(incoming));
    if (out == null) return;
    final ideas = ComposerAi.parseIdeas(out);
    if (ideas.isEmpty) { _toolHint('No suggestions — try again.'); return; }
    _showReplyIdeas(ideas);
  }

  /// The most recent non-empty message FROM the other side (skips my own
  /// messages, control envelopes and special bubbles like polls/location).
  String? _lastIncomingText() {
    for (var i = _msgs.length - 1; i >= 0; i--) {
      final m = _msgs[i];
      if (m.me || m.special != null) continue;
      final t = m.text.trim();
      if (t.isEmpty || _isControlEnvelope(t)) continue;
      return t;
    }
    return null;
  }

  // ---- pickers --------------------------------------------------------------

  Future<void> _pickTransLang() async {
    final picked = await showModalBottomSheet<ComposerLang>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                  size: 20, color: AD.textPrimary),
              const SizedBox(width: 10),
              Text('Translate into…', style: ADText.threadName()),
            ]),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final l in ComposerAi.languages)
                  ListTile(
                    title: Text(l.label, style: ADText.rowName()),
                    subtitle: l.code != l.label
                        ? Text(l.code, style: ADText.preview())
                        : null,
                    trailing: l.code == _transLangCode
                        ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                            color: AD.iconSearch)
                        : null,
                    onTap: () => Navigator.pop(ctx, l),
                  ),
              ],
            ),
          ),
        ]),
      ),
    );
    if (picked == null) return;
    setState(() => _transLangCode = picked.code);
    try {
      await _aiPrefs.write(key: scopedKey(_kTransLangKey), value: picked.code);
    } catch (_) {/* preference best-effort */}
    // Translate straight away with the new choice — one tap less.
    await _runTranslate();
  }

  void _showReplyIdeas(List<String> ideas) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.lightbulb(PhosphorIconsStyle.bold),
                  size: 20, color: AD.textPrimary),
              const SizedBox(width: 10),
              Text('Reply ideas', style: ADText.threadName()),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Tap one to drop it into your message.',
                  style: ADText.preview()),
            ),
          ),
          for (final idea in ideas)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
              child: GestureDetector(
                onTap: () { Navigator.pop(ctx); _replaceComposer(idea); },
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: AD.card,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AD.borderControl, width: 1),
                    boxShadow: const [],
                  ),
                  child: Text(idea, style: ADText.rowName()),
                ),
              ),
            ),
          const SizedBox(height: 12),
        ]),
      ),
    );
  }

  Widget _replyBanner() {
    final isEdit = _editing != null;
    final preview = isEdit ? _editing!.text : (_replyTo?.text ?? '');
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
      child: Row(children: [
        Container(width: 3, height: 32, color: AD.iconSearch),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text((isEdit ? 'Editing' : 'Replying to ${_replyTo!.me ? "yourself" : (_replyTo!.senderLabel ?? widget.chat.name)}').toUpperCase(),
                style: ADText.sectionLabel(c: AD.iconSearch)),
            Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.preview()),
          ]),
        ),
        IconButton(
          icon: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 16, color: AD.textSecondary),
          onPressed: () => setState(() {
            _replyTo = null;
            if (_editing != null) { _editing = null; _ctrl.clear(); _hasText = false; }
          }),
        ),
      ]),
    );
  }

  /// True if [text] is a control/receipt envelope (read/delivered/typing/ack)
  /// that should never appear as a chat bubble.
  bool _isControlEnvelope(String text) {
    final t = text.trim();
    if (t.isEmpty || t.codeUnitAt(0) != 0x7B /* { */) return false;
    if (t.contains('"read_ts"') || t.contains('"delivered_ts"')) return true;
    try {
      final j = jsonDecode(t);
      if (j is Map) {
        const ctrl = {'read', 'delivered', 'typing', 'ack', 'receipt', 'seen', 'del', 'gdel'};
        return ctrl.contains(j['t']) || ctrl.contains(j['type']);
      }
    } catch (_) { /* not JSON → real text */ }
    return false;
  }

  /// [CHAT-RAWENV-1] (owner report 2026-07-16, pic 4) — the backstop that turns
  /// "render the machine's plumbing at the user" into "render nothing".
  ///
  /// True if [text] is one of OUR wire envelopes rather than something a human
  /// typed. `_onDm` seeds `text = m.payload` and only overwrites it inside a
  /// `try` block, so ANY envelope it doesn't explicitly branch on — a new `t`
  /// from a newer build, a `status` fan-out, a field-shape change that makes
  /// `fromEnvelope` throw — falls out of the `catch` with the raw JSON still in
  /// `text` and gets drawn as a chat bubble. That is how a photo turned into a
  /// wall of `{"t":"status",…,"who":"Humphrey Davy"}` on the recipient's screen.
  ///
  /// `_isControlEnvelope` only ever covered receipts, so it never caught this.
  /// This is deliberately broader: an object with a **string `t`** is, by
  /// construction, an AvaTOK envelope — `toEnvelope()` and every `_send…` path
  /// stamps one, and nothing else does. A real user typing `{"t":"hi"}` is a
  /// rounding error next to leaking key material into a conversation. Drop it.
  bool _isAppEnvelope(String text) {
    final t = text.trim();
    if (t.isEmpty || t.codeUnitAt(0) != 0x7B /* { */) return false;
    try {
      final j = jsonDecode(t);
      return j is Map && j['t'] is String;
    } catch (_) { /* not JSON → real text */ }
    return false;
  }

  /// Normalise text for in-thread search: lower-case and strip the most common
  /// accents so "cafe" matches "café" and case never matters. Keeps it simple —
  /// no full Unicode NFD dependency.
  static String _foldSearch(String s) {
    var t = s.toLowerCase();
    const from = 'áàâäãåéèêëíìîïóòôöõúùûüñçý';
    const to = 'aaaaaaeeeeiiiiooooouuuuncy';
    final b = StringBuffer();
    for (final ch in t.split('')) {
      final i = from.indexOf(ch);
      b.write(i >= 0 ? to[i] : ch);
    }
    return b.toString().trim();
  }

  /// Reset any smart-search state — called when the query text changes so stale
  /// AI results/spinner/error never linger for a different query.
  void _resetAiSearch() {
    if (_aiSearching || _aiHits.isNotEmpty || _aiSearchError ||
        _aiSearchedQuery.isNotEmpty || _aiShowOther || _aiBrainOff) {
      _aiSearching = false;
      _aiHits = const [];
      _aiSearchError = false;
      _aiSearchedQuery = '';
      _aiShowOther = false;
      _aiBrainOff = false;
    }
  }

  /// Run "smart search": query the user's own semantic index (Cloudflare AI
  /// Search) scoped best-effort to THIS conversation, then map hits back to local
  /// messages by fuzzy text match. Literal search is untouched — this is additive.
  ///
  /// Gated by the messaging AvaBrain consent (the same ingestion the smart index
  /// is built from): if it's off we show only the literal results plus a one-line
  /// "enable AvaBrain" hint. Never throws — errors surface as a graceful state.
  Future<void> _smartSearch() async {
    final q = _searchQuery.trim();
    if (q.isEmpty || _aiSearching) return;
    // Same query already answered → don't refetch.
    if (_aiSearchedQuery == q && (_aiHits.isNotEmpty || _aiSearchError)) return;

    // Respect the existing BrainConsent gate (E2E/private content is only ever
    // indexed under the user's own consented ingestion; if that's off there is
    // nothing to search and we must not pretend otherwise).
    if (!await BrainConsent.isOn('messaging')) {
      if (!mounted) return;
      setState(() { _aiBrainOff = true; _aiHits = const []; _aiSearchError = false; });
      return;
    }

    setState(() { _aiSearching = true; _aiSearchError = false; _aiBrainOff = false; });
    final t0 = DateTime.now().millisecondsSinceEpoch;
    var ok = false;
    var matchedLocal = 0;
    List<_AiHit> hits = const [];
    try {
      final res = await ApiAuth.postJson(
        _brainSearchUrl(),
        {'q': q, 'conv': _serverConvId ?? '', 'name': widget.chat.name},
        timeout: const Duration(seconds: 12),
      );
      if (res.statusCode == 200) {
        final body = jsonDecode(res.body) as Map<String, dynamic>;
        final raw = (body['hits'] as List?) ?? const [];
        final parsed = <_AiHit>[];
        for (final h in raw) {
          if (h is! Map) continue;
          final snip = (h['text'] ?? '').toString().trim();
          if (snip.isEmpty) continue;
          final inThread = h['inThread'] == true;
          final local = _matchLocalMessage(snip);
          if (local != null) matchedLocal++;
          parsed.add(_AiHit(snip, inThread, local?.id, local?.text ?? ''));
        }
        // Order: in-thread matches first, then in-thread unmatched, then others.
        parsed.sort((a, b) {
          int rank(_AiHit x) => x.localId != null ? 0 : (x.inThread ? 1 : 2);
          return rank(a).compareTo(rank(b));
        });
        hits = parsed;
        ok = true;
      }
    } catch (_) {
      ok = false;
    }
    final ms = DateTime.now().millisecondsSinceEpoch - t0;
    Analytics.capture('chat_ai_search',
        {'ok': ok, 'ms': ms, 'hits': hits.length, 'matched_local': matchedLocal});
    if (!mounted) return;
    setState(() {
      _aiSearching = false;
      _aiSearchedQuery = q;
      _aiSearchError = !ok;
      _aiHits = hits;
    });
  }

  static String _brainSearchUrl() {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin${AvaApi.brainThreadSearch}';
  }

  /// Fuzzy-match a server snippet to a message loaded in THIS thread. Strips any
  /// "Me: "/"Them: "/"Ava: " speaker label the index added, folds accents/case,
  /// then looks for a two-way containment against each local bubble's text.
  _Msg? _matchLocalMessage(String snippet) {
    var s = snippet.replaceFirst(RegExp(r'^(me|them|you|ava)\s*:\s*', caseSensitive: false), '').trim();
    final needle = _foldSearch(s);
    if (needle.length < 3) return null;
    _Msg? best;
    var bestLen = 0;
    for (final m in _msgs) {
      if (m.special != null || m.text.trim().isEmpty) continue;
      final hay = _foldSearch(m.text);
      if (hay.isEmpty) continue;
      // Two-way containment: the message contains the snippet, or the snippet
      // (a longer indexed line) contains the whole message.
      final overlap = hay.contains(needle) || (needle.length > hay.length && needle.contains(hay));
      if (overlap && hay.length > bestLen) { best = m; bestLen = hay.length; }
    }
    return best;
  }

  /// Tap a matched AI hit → reuse the existing literal-search filter to reveal the
  /// message: set the query to a distinctive slice of the matched local text so
  /// the list filters down to (and shows) that bubble.
  void _openAiHit(_AiHit hit) {
    if (hit.localId == null || hit.localText.trim().isEmpty) return;
    Analytics.capture('chat_ai_search_open', {'in_thread': hit.inThread});
    // Pick a distinctive slice (first ~5 words) so the literal filter narrows to
    // this message but the search box stays readable/editable.
    final words = hit.localText.trim().split(RegExp(r'\s+'));
    final slice = (words.length > 6 ? words.sublist(0, 6) : words).join(' ');
    _searchCtrl.text = slice;
    setState(() {
      _searchQuery = slice;
      _resetAiSearch();
    });
  }

  /// Compact "AI results" section rendered under the literal hits (or in the empty
  /// state). Handles spinner / error / empty / consent-off, all in Zine styling.
  // [AVAGRP-BUBBLE-2] This whole search-results section renders directly on the
  // canvas (inside the message ListView, not a modal sheet) — every
  // `AD.textTertiary`/`ADText.preview()` bare-default below was white/white-45%
  // text tuned for the old dark canvas and is close to invisible on the new
  // white one. Swapped to the wallpaper-aware `_canvas*` getters (same class of
  // fix as `_hiddenBubble`/`_daySeparator`). `AD.iconSearch`/`AD.danger` are
  // saturated accent colours that already read fine on both light and dark
  // backgrounds, so those are left as-is.
  Widget _aiResultsSection() {
    final children = <Widget>[
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
        child: Row(children: [
          Expanded(child: Container(height: 1, color: _canvasTertiary.withValues(alpha: 0.4))),
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 13, color: AD.iconSearch),
          const SizedBox(width: 5),
          Text('AI RESULTS', style: ADText.statCaption(c: AD.iconSearch)),
          const SizedBox(width: 8),
          Expanded(child: Container(height: 1, color: _canvasTertiary.withValues(alpha: 0.4))),
        ]),
      ),
    ];

    if (_aiBrainOff) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text('Enable AvaBrain for your messages in Settings to search by meaning.',
            textAlign: TextAlign.center, style: ADText.preview(c: _canvasMeta)),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    if (_aiSearching) {
      children.add(const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Center(child: SizedBox(
            width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch))),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    if (_aiSearchError) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text("Couldn't reach smart search. Tap to retry.",
            textAlign: TextAlign.center, style: ADText.preview(c: AD.danger)),
      ));
      children.add(_aiSearchButton(label: 'Retry smart search'));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }

    final inThread = _aiHits.where((h) => h.localId != null).toList();
    final other = _aiHits.where((h) => h.localId == null).toList();
    if (inThread.isEmpty && other.isEmpty) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text('No meaning-based matches in this chat.',
            textAlign: TextAlign.center, style: ADText.preview(c: _canvasMeta)),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    for (final h in inThread) children.add(_aiHitTile(h, tappable: true));
    if (other.isNotEmpty) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
        child: GestureDetector(
          onTap: () => setState(() => _aiShowOther = !_aiShowOther),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(
                _aiShowOther ? PhosphorIcons.caretDown(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                size: 12, color: _canvasTertiary),
            const SizedBox(width: 4),
            Text('${other.length} from your other chats',
                style: ADText.statCaption(c: _canvasTertiary)),
          ]),
        ),
      ));
      if (_aiShowOther) for (final h in other) children.add(_aiHitTile(h, tappable: false));
    }
    return Column(mainAxisSize: MainAxisSize.min, children: children);
  }

  /// Footer under the literal hits: either the "Search with AI" opt-in pill (not
  /// yet run for this query) or the AI results section (spinner/hits/error).
  Widget _aiSearchFooter() {
    final q = _searchQuery.trim();
    final ranForThisQuery = _aiSearchedQuery == q &&
        (_aiHits.isNotEmpty || _aiSearchError || _aiBrainOff);
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 4),
      child: (_aiSearching || ranForThisQuery)
          ? _aiResultsSection()
          : _aiSearchButton(),
    );
  }

  Widget _aiHitTile(_AiHit h, {required bool tappable}) {
    final label = h.localId != null ? h.localText : h.snippet;
    final tile = Container(
      margin: const EdgeInsets.fromLTRB(16, 3, 16, 3),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: _sysPillBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tappable ? _canvasInk : _canvasTertiary, width: tappable ? 2 : 1),
      ),
      child: Row(children: [
        Expanded(child: Text(label, maxLines: 2, overflow: TextOverflow.ellipsis,
            style: ADText.rowName(c: _canvasInk))),
        if (tappable) ...[
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), size: 15, color: AD.iconSearch),
        ],
      ]),
    );
    if (!tappable) return tile;
    return GestureDetector(onTap: () => _openAiHit(h), behavior: HitTestBehavior.opaque, child: tile);
  }

  /// The explicit "Search with AI" pill — shown under literal results (and in the
  /// empty state) so the user can opt into the semantic step.
  Widget _aiSearchButton({String label = 'Search with AI'}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: GestureDetector(
            onTap: _smartSearch,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
              decoration: BoxDecoration(
                color: AD.iconVideo,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: _sysPillBorder, width: 1),
                boxShadow: const [],
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 15, color: AD.iconSearch),
                const SizedBox(width: 6),
                Text(label, style: ADText.rowName(c: AD.iconSearch)),
              ]),
            ),
          ),
        ),
      );

  /// Empty state shown when an in-thread search finds no literal match. Keeps the
  /// user IN the thread (the complaint was being kicked out) and offers Ava as a
  /// meaning-based fallback over the on-device transcript.
  /// [AVAGRP-BUBBLE-2] Renders directly on the canvas — every colour below was
  /// `AD.textTertiary`/bare `ADText.rowName()`/`ADText.preview()` (white /
  /// white-alpha, tuned for the old dark canvas) and read as invisible text on
  /// the new white one, plus a dark `AD.overlaySheet` pill for "Discuss with
  /// Ava" that was its own small hole punched in the page. Swapped to the
  /// wallpaper-aware `_canvas*`/`_sysPill*` getters (same fix class as
  /// `_hiddenBubble`).
  Widget _searchEmptyState(String query) {
    final q = query.trim();
    final ranForThisQuery = _aiSearchedQuery == q &&
        (_aiHits.isNotEmpty || _aiSearchError || _aiBrainOff);
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            size: 30, color: _canvasTertiary),
        const SizedBox(height: 10),
        Text('No messages match “$query”.',
            textAlign: TextAlign.center, style: ADText.rowName(c: _canvasInk)),
        const SizedBox(height: 4),
        Text('Search this chat by meaning, not just exact words.',
            textAlign: TextAlign.center, style: ADText.preview(c: _canvasMeta)),
        const SizedBox(height: 14),
        // Server-side smart (semantic) search over the user's own consented
        // index — the primary "AI search" path. Shows spinner/hits/error once run.
        if (_aiSearching || ranForThisQuery)
          _aiResultsSection()
        else
          _aiSearchButton(),
        const SizedBox(height: 10),
        // On-device "Discuss with Ava" — reads the visible bubbles locally and
        // answers by meaning (kept as a secondary, fully-local option).
        GestureDetector(
          onTap: () {
            setState(() { _searchMode = false; _searchQuery = ''; _resetAiSearch(); });
            _discussWithAva();
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
            decoration: BoxDecoration(
              color: _sysPillBg,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: _sysPillBorder, width: 1),
              boxShadow: const [],
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.chatCircleText(PhosphorIconsStyle.bold),
                  size: 15, color: _canvasInk),
              const SizedBox(width: 6),
              Text('Discuss with Ava',
                  style: ADText.rowName(c: _canvasInk)),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _searchBar() => Row(children: [
        IconButton(icon: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold), color: AD.textPrimary),
            onPressed: () => setState(() { _searchMode = false; _searchQuery = ''; _resetAiSearch(); })),
        Expanded(child: TextField(
          autofocus: true,
          controller: _searchCtrl,
          onChanged: (v) => setState(() { _searchQuery = v; _resetAiSearch(); }),
          style: ADText.rowName(),
          cursorColor: AD.iconSearch,
          decoration: InputDecoration(
              hintText: 'Search messages',
              hintStyle: ADText.rowName().copyWith(
                  color: AD.textTertiary, fontWeight: FontWeight.w700),
              border: InputBorder.none),
        )),
      ]);

  void _pickWallpaper() {
    showModalBottomSheet(context: context, backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
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
                      gradient: _gradientFor(id), borderRadius: BorderRadius.circular(14),
                      border: Border.all(
                          color: _wallpaperId == id ? AD.textPrimary : AD.textTertiary,
                          width: _wallpaperId == id ? 3 : 2)),
                ),
              ),
          ]),
        ]))));
  }

  // ---- @mentions (groups) ----
  void _onInputChanged(String v) {
    setState(() => _hasText = v.trim().isNotEmpty);
    _onTyping();
    if (_isGroup) _updateMentions(v);
    _refreshComposePreview(v);
  }

  // ── Compose-time link preview ───────────────────────────────────────────────

  /// Called on every keystroke/paste. Debounced 450ms so we unfurl once the user
  /// stops typing, not per character. Cheap no-op when the text has no URL, the
  /// URL hasn't changed, previews are off, or the thread is a pending stranger
  /// thread (same gate the bubbles use).
  void _refreshComposePreview(String v) {
    if (!RemoteConfig.linkPreviewsEnabled || _threadAcceptState == 'pending') return;
    final url = _firstUrl(v);

    // URL gone (or replaced) → drop the stale card immediately.
    if (url == null) {
      _composeUnfurlDebounce?.cancel();
      if (_composePreviewUrl != null || _composePreviewLoading) {
        setState(() {
          _composePreviewUrl = null;
          _composePreview = null;
          _composePreviewLoading = false;
        });
      }
      return;
    }
    if (url == _composePreviewUrl) return;          // already showing/fetching it
    if (_composePreviewDismissed.contains(url)) return; // user ✕'d this one

    _composeUnfurlDebounce?.cancel();
    setState(() {
      _composePreviewUrl = url;
      _composePreview = null;
      _composePreviewLoading = true;
    });
    _composeUnfurlDebounce = Timer(const Duration(milliseconds: 450), () async {
      final fetched = await _unfurl(url);
      if (!mounted || _composePreviewUrl != url) return; // user moved on
      setState(() {
        _composePreview = fetched;
        _composePreviewLoading = false;
        // Nothing unfurlable → hide the bar entirely (raw link only).
        if (fetched == null) _composePreviewUrl = null;
      });
    });
  }

  void _clearComposePreview({bool remember = false}) {
    _composeUnfurlDebounce?.cancel();
    final u = _composePreviewUrl;
    setState(() {
      if (remember && u != null) _composePreviewDismissed.add(u);
      _composePreviewUrl = null;
      _composePreview = null;
      _composePreviewLoading = false;
    });
  }

  /// True when there's a compose-time card to show above the input bar.
  bool get _showComposePreview =>
      _composePreviewUrl != null &&
      (_composePreviewLoading || _composePreview != null);

  /// The card that rides above the composer while a link is in the input box.
  Widget _composePreviewBar() {
    return ComposeLinkPreview(
      loading: _composePreviewLoading,
      preview: _composePreview == null
          ? null
          : LinkPreview.fromEnvelope(_composePreview),
      onDismiss: () {
        Analytics.capture('compose_preview_dismissed', {
          if (Analytics.currentEmail != null) 'email': Analytics.currentEmail!,
        });
        _clearComposePreview(remember: true);
      },
    );
  }

  void _updateMentions(String v) {
    final m = RegExp(r'@(\w*)$').firstMatch(v);
    if (m == null) { if (_mentionMatches.isNotEmpty) setState(() => _mentionMatches = []); return; }
    final q = m.group(1)!.toLowerCase();
    final names = _memberNames.values.where((n) => n != 'You' && n.toLowerCase().contains(q)).toSet().toList();
    setState(() => _mentionMatches = names.take(6).toList());
  }

  void _insertMention(String name) {
    final v = _ctrl.text.replaceFirst(RegExp(r'@\w*$'), '@$name ');
    _ctrl.text = v;
    _ctrl.selection = TextSelection.collapsed(offset: v.length);
    setState(() { _mentionMatches = []; _hasText = v.trim().isNotEmpty; });
  }

  Widget _mentionBar() => Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(top: BorderSide(color: AD.borderHairline, width: 2)),
        ),
        constraints: const BoxConstraints(maxHeight: 160),
        child: ListView(shrinkWrap: true, children: [
          for (final n in _mentionMatches)
            ListTile(
              dense: true,
              leading: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: AD.borderControl, width: 2),
                ),
                child: Avatar(seed: n, name: n, size: 32),
              ),
              title: Text(n, style: ADText.rowName()),
              onTap: () => _insertMention(n),
            ),
        ]),
      );

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
                borderRadius: BorderRadius.circular(100),
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
          Icon(Icons.voicemail, size: 15, color: AD.textTertiary),
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

  // When a guardian warning arrives, remember WHICH message it flagged (by the
  // shared created_at ms) so that incoming message gets painted red.
  void _noteGuardianFlag(String? special, Map<String, dynamic>? extra) {
    if (special != 'ava_private' || extra == null) return;
    final meta = extra['meta'];
    if (meta is Map && (meta['guardian'] == true || meta['red_flag'] == true)) {
      final ts = meta['flagged_created_at'];
      if (ts is num && ts > 0) _flaggedTs.add(ts.toInt());
    }
  }

  // U1-lite: a Guardian human-verification REQUEST (meta.verify_request) posted
  // privately to ME because the other participant asked Ava to confirm a human
  // is behind this account. Rendered by _verifyRequestBubble.
  bool _isVerifyRequest(_Msg m) {
    if (m.special != 'ava_private') return false;
    final meta = m.extra?['meta'];
    return meta is Map && meta['verify_request'] == true;
  }

  /// Lilac request card: warning text + "Start face check" → the existing
  /// liveness [HumanCheckPage] (source: guardian). On PASS the server-side
  /// liveness success path calls markGatePassed() → the chat's gate flips to
  /// 'passed' with no further client work; we just confirm with a toast.
  Widget _verifyRequestBubble(_Msg m) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        decoration: BoxDecoration(
          color: AD.bubbleInBg,
          border: Border.all(color: AD.bubbleInInk, width: 2),
          boxShadow: const [],
          borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), size: 14, color: AD.bubbleInInk),
            const SizedBox(width: 5),
            Text('AVA · HUMAN CHECK', style: TextStyle(color: AD.bubbleInInk, fontSize: 9.5,
                fontWeight: FontWeight.w800, letterSpacing: 0.6)),
          ]),
          const SizedBox(height: 4),
          Text(m.text, style: TextStyle(color: AD.bubbleInInk, fontSize: 13.5, height: 1.3,
              fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: AD.bubbleInInk, foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 10),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              onPressed: () async {
                Analytics.capture('verify_human_started', {'trigger': 'chat_prompt'});
                // [AVA-IDGATE-1] Was HumanCheckPage(guardian), which opened the camera
                // WITHOUT the BIPA consent screen and showed retention copy that
                // contradicted the published schedule. Now routes through the one
                // consent-first gate: consent (tick-box + state) → Didit → server
                // records the pass and flips the chat gate exactly as before.
                final passed = await ensurePublicActionAllowed(context, 'guardian_verify');
                if (passed && mounted) {
                  _toast('Verified — thanks for keeping chats human.');
                }
              },
              child: const Text('Start face check',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(height: 3),
          Text(m.time, style: TextStyle(color: AD.bubbleInInk.withValues(alpha: 0.55), fontSize: 10)),
        ]),
      ),
    );
  }

  // A guardian SAFETY ALERT (private warning Ava posts to the at-risk user).
  bool _isGuardianWarn(_Msg m) {
    if (m.special != 'ava_private') return false;
    final meta = m.extra?['meta'];
    return (meta is Map && (meta['guardian'] == true || meta['red_flag'] == true)) ||
        m.extra?['source'] == 'guardian';
  }

  // RED bubble: white text, shield icon — used for the safety alert AND for an
  // incoming message Ava flagged. Deliberately self-contained so it never touches
  // the normal media/special bubble path.
  // Soft-deleted (by me) pill: "You deleted this message" + an Undo that restores
  // it in MY view only. The content lives on in `m` until I tap Undo (recover) or
  // leave it hidden. onRight for my own messages, left for received ones I hid.
  // [AVAGRP-BUBBLE-2] REGRESSION FIX: this was still `AD.headerFooter`
  // (near-black, 0xFF131316) + `AD.textSecondary` (white 60%) — a hole punched
  // in the white canvas ([AVAGRP-BUBBLE-1] made the canvas white but missed
  // this bubble). Same pale/system pill treatment as `_daySeparator`/
  // `_systemBubble`, wallpaper-aware via `_sysPillBg`/`_sysPillBorder`/
  // `_sysPillMeta` — this is a system-style row (no per-sender tint applies).
  Widget _hiddenBubble(_Msg m) {
    return Align(
      alignment: m.me ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: _sysPillBg,
          border: Border.all(color: _sysPillBorder, width: 1.5),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.prohibit(PhosphorIconsStyle.bold), size: 14, color: _sysPillMeta),
          const SizedBox(width: 6),
          Text('You deleted this message',
              style: ADText.preview(c: _sysPillMeta)),
          const SizedBox(width: 12),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => _undoDelete(m),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), size: 13, color: AD.iconSearch),
              const SizedBox(width: 3),
              Text('UNDO', style: ADText.statCaption(c: AD.iconSearch)),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _redFlagBubble(_Msg m, String label) {
    return GestureDetector(
      onLongPress: () => _onBubbleLongPress(m),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          decoration: BoxDecoration(
            color: const Color(0xFFD32F2F), // strong red — unmistakable danger
            border: Border.all(color: AD.borderControl, width: 2),
            boxShadow: const [],
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill), size: 14, color: Colors.white),
              const SizedBox(width: 5),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 9.5,
                  fontWeight: FontWeight.w800, letterSpacing: 0.6)),
            ]),
            const SizedBox(height: 4),
            Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.3,
                fontWeight: FontWeight.w500)),
            const SizedBox(height: 3),
            Text(m.time, style: const TextStyle(color: Colors.white70, fontSize: 10)),
          ]),
        ),
      ),
    );
  }

  // ── F6: safety-flag bubble + tap-sheet ──────────────────────────────────────
  // The server posts {type:'safety_flag', conv, msg_id, category} to MY InboxDO;
  // SyncHub persists it (per-account, keyed by msg_id) and fans it out. Here the
  // flagged bubble renders red and, on tap/long-press, opens a sheet with the
  // category explanation + Block / Report / This is fine. The sender is NEVER
  // notified (block/report are one-sided; "This is fine" is a local dismiss).

  /// The active safety category for [m] (null ⇒ not flagged, or locally
  /// dismissed). Matches on the message's rumor id (evId), the flag's msg_id.
  String? _safetyCategoryFor(_Msg m) {
    final id = m.evId;
    if (id == null || id.isEmpty) return null;
    return _safetyFlaggedIds[id];
  }

  /// Plain-language explanation for a guardian category (kept generic so an
  /// unknown/new category still reads sensibly).
  String _safetyCategoryExplain(String category) {
    switch (category.toLowerCase()) {
      case 'grooming':
        return 'Ava spotted signs of grooming — an adult trying to build secret trust, '
            'move you off the app, or ask for private things. Please tell an adult you trust.';
      case 'scam':
      case 'fraud':
        return 'Ava thinks this may be a scam — an unexpected offer, a prize, or a request '
            'for money or codes. Never send money or personal details.';
      case 'sextortion':
      case 'csam':
      case 'sexual':
        return 'Ava flagged sexual or exploitative content. You do not have to reply. '
            'Block this person and tell an adult you trust — you are not in trouble.';
      case 'harassment':
      case 'bullying':
        return 'Ava flagged bullying or harassment. You can block or report this person, '
            'and it is okay to ask an adult for help.';
      case 'violence':
      case 'self_harm':
      case 'selfharm':
        return 'Ava flagged content about harm. If you or someone is in danger, please '
            'reach out to an adult you trust right away.';
      case 'spam':
        return 'Ava thinks this looks like spam or an unsolicited promo. You can ignore, '
            'block, or report it.';
      default:
        return 'Ava flagged this message as possibly unsafe. Trust your gut — you can block '
            'or report this person, or dismiss this if you know it is fine.';
    }
  }

  String _safetyCategoryLabel(String category) {
    final c = category.trim();
    if (c.isEmpty) return 'FLAGGED BY AVA';
    return '⚠ ${c.replaceAll('_', ' ').toUpperCase()} — FLAGGED BY AVA';
  }

  Widget _safetyFlagBubble(_Msg m, String category) {
    return GestureDetector(
      onTap: () => _openSafetySheet(m, category),
      onLongPress: () => _openSafetySheet(m, category),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
          decoration: BoxDecoration(
            color: const Color(0xFFD32F2F), // strong red — unmistakable danger
            border: Border.all(color: AD.borderControl, width: 2),
            boxShadow: const [],
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill), size: 14, color: Colors.white),
              const SizedBox(width: 5),
              Flexible(child: Text(_safetyCategoryLabel(category),
                  style: const TextStyle(color: Colors.white, fontSize: 9.5,
                      fontWeight: FontWeight.w800, letterSpacing: 0.5))),
            ]),
            const SizedBox(height: 4),
            Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.3,
                fontWeight: FontWeight.w500)),
            const SizedBox(height: 4),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Text(m.time, style: const TextStyle(color: Colors.white70, fontSize: 10)),
              const SizedBox(width: 8),
              Text('Tap for options', style: const TextStyle(color: Colors.white70, fontSize: 10,
                  fontWeight: FontWeight.w600)),
            ]),
          ]),
        ),
      ),
    );
  }

  /// Bottom sheet for a flagged message: category explanation + Block sender /
  /// Report / This is fine. The sender is never told about any of these.
  void _openSafetySheet(_Msg m, String category) {
    HapticFeedback.mediumImpact();
    Analytics.capture('safety_flag_sheet_opened', {'category': category, 'is_group': _isGroup});
    showModalBottomSheet(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: AD.danger, size: 40),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Ava flagged this message', style: ADText.threadName()),
                Text('From Ava — only you can see this', style: ADText.preview()),
              ])),
            ]),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: AD.headerFooter,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: Text(_safetyCategoryExplain(category), style: ADText.preview()),
            ),
            const SizedBox(height: 16),
            AdButton(
              label: 'Block sender',
              variant: AdButtonVariant.danger,
              fullWidth: true,
              icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _blockSender(category); },
            ),
            const SizedBox(height: 8),
            AdButton(
              label: 'Report',
              variant: AdButtonVariant.teal,
              fullWidth: true,
              icon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _reportFlagged(m, category); },
            ),
            const SizedBox(height: 8),
            AdButton(
              label: 'This is fine',
              variant: AdButtonVariant.ghost,
              fullWidth: true,
              icon: PhosphorIcons.check(PhosphorIconsStyle.bold),
              trailingIcon: false,
              onPressed: () { Navigator.pop(ctx); _dismissFlag(m, category); },
            ),
          ]),
        ),
      ),
    );
  }

  Future<void> _blockSender(String category) async {
    final uid = _peerNpub;
    if (uid == null || uid.isEmpty) {
      _toast('Couldn\'t identify the sender to block.');
      return;
    }
    Analytics.capture('safety_flag_block', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (block).
    Analytics.capture('guardian_warning_actioned', {'action': 'block', 'category': category, 'is_group': _isGroup});
    try {
      // Same `blocks` table the messaging gate reads — a block silently stops all
      // future sends from this uid. The sender is not notified.
      final res = await ApiAuth.postJson('$kApiBase/creators/$uid/block', const {});
      _toast(res.statusCode == 200 ? 'Blocked. They can no longer message you.'
                                   : 'Couldn\'t block right now — try again.');
    } catch (_) {
      _toast('Couldn\'t block right now — try again.');
    }
  }

  Future<void> _reportFlagged(_Msg m, String category) async {
    Analytics.capture('safety_flag_report', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (report).
    Analytics.capture('guardian_warning_actioned', {'action': 'report', 'category': category, 'is_group': _isGroup});
    final targetId = _peerNpub ?? _convKey ?? '';
    try {
      // Generic moderation report (POST /api/report {targetType,targetId,reason}).
      // Carry the flagged message id (msg_id) so moderation can locate the row.
      final res = await ApiAuth.postJson('$kApiBase/report', {
        'targetType': 'message',
        'targetId': targetId,
        'reason': 'safety_flag:$category',
        if (m.evId != null) 'msgId': m.evId,
      });
      _toast(res.statusCode == 200 ? 'Thanks — reported to our safety team.'
                                   : 'Couldn\'t send the report — try again.');
    } catch (_) {
      _toast('Couldn\'t send the report — try again.');
    }
  }

  /// "This is fine" — local dismiss. Persists the dismissal (so it stays hidden
  /// on reopen) and removes the red state now. NO network call — the sender is
  /// never notified.
  Future<void> _dismissFlag(_Msg m, String category) async {
    final id = m.evId;
    if (id == null || id.isEmpty) return;
    Analytics.capture('safety_flag_dismissed', {'category': category, 'is_group': _isGroup});
    // Guardian telemetry spec §2.2 — user acted on a warning (dismiss = "This is fine").
    Analytics.capture('guardian_warning_actioned', {'action': 'dismiss', 'category': category, 'is_group': _isGroup});
    setState(() => _safetyFlaggedIds.remove(id));
    await _safetyStore.dismiss(id);
    // [G2] Also push the dismissal to the server so "This is fine" reaches my OTHER
    // devices and survives a reinstall (store-and-forward). Best-effort — the local
    // dismiss above already applied; a failed round-trip reconciles on the next sync.
    unawaited(GuardianPrefsClient.I.dismissFlag(id, conv: _serverConvId ?? ''));
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Widget _bubble(_Msg m) {
    // [AVAGRP-BUBBLE-2] Group SYSTEM announcement — a centered pill, never a
    // normal per-sender bubble. Checked FIRST: a system row has no avatar, no
    // sender-name header, no bubble tail, and must never fall into any of the
    // special/hidden/media logic below.
    if (m.system) return _systemBubble(m);
    // Ava "working…" chip (kind 'ava_status') — inline, not a bubble. A 'phase:end'
    // frame is the CLOSE signal (e.g. image done/failed) — it must collapse the
    // chip, not render as a stuck "generating…" placeholder.
    if (m.special == 'ava_status') {
      if ((m.extra?['phase'] ?? '').toString() == 'end') return const SizedBox.shrink();
      return _avaStatusChip(m);
    }
    // SOFT-DELETED (by me) — a slim "deleted" pill with an Undo so I can recover my
    // own data. The real content stays in `m` (hidden, not erased) until I confirm.
    if (m.hidden) return _hiddenBubble(m);
    // U1-lite: a Guardian "verify you're human" request from the other side —
    // renders as a lilac card with a Start-face-check button (opens the existing
    // liveness HumanCheckPage; on PASS the server flips the gate automatically).
    if (_isVerifyRequest(m)) return _verifyRequestBubble(m);
    // RED FLAGS — Ava's safety alert, and any incoming message Ava flagged as
    // unsafe. Both render red/white so the danger is obvious to the child.
    if (_isGuardianWarn(m)) return _redFlagBubble(m, 'AVA · SAFETY ALERT');
    // F6: a persisted `safety_flag` frame for THIS message (keyed by rumorId).
    // Tap / long-press opens the safety sheet (Block · Report · This is fine).
    // Kept ahead of the legacy _flaggedTs fallback so the newer, richer path wins;
    // the _flaggedTs path below still fires for older guardian-warning flags.
    final flagCat = _safetyCategoryFor(m);
    if (flagCat != null && !m.me && m.special == null && m.media == null && m.localBytes == null) {
      return _safetyFlagBubble(m, flagCat);
    }
    if (!m.me && m.special == null && m.media == null && m.localBytes == null && _flaggedTs.contains(m.ts)) {
      return _redFlagBubble(m, '⚠ FLAGGED BY AVA — DO NOT TRUST');
    }
    // Phase A (Ava Copilot §6/D3): PRIVATE-LANE Ava rows (copilot Moments, doc
    // results, Guardian notes — lane:"private" or a guardian payload in the
    // body) render via the dedicated AvaLaneBubble: soft orchid fill, "Ava ✨"
    // author label, info affordance → disclosure sheet, safety accent for the
    // Guardian variant. Ava's ordinary @ava turn replies (a2ui/email/image
    // bubbles etc.) keep the existing lilac path below, unchanged.
    if (_isAvaBubble(m) && m.media == null &&
        m.extra?['a2ui'] == null && m.extra?['media_ref'] == null &&
        (m.extra?['lane'] == 'private' || m.extra?['guardian'] is Map)) {
      return GestureDetector(
        onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
        child: AvaLaneBubble(
          text: m.text,
          time: m.time,
          guardian: (m.extra?['guardian'] as Map?)?.cast<String, dynamic>(),
        ),
      );
    }
    final hasMedia = m.media != null || m.localBytes != null;
    // Ava bubbles always render on the LEFT (she is a participant, not "me"),
    // in a distinct feminine lilac fill — visually separate from my lime and
    // peers' card bubbles.
    final isAva = _isAvaBubble(m);
    // My OWN message that I sent TO Ava (private @ava question). Colour it the
    // same lilac as Ava's replies so a glance tells me "this is an Ava
    // conversation", never confused with a green message to a person.
    final toAva = m.me && m.aiLocal;
    final onRight = m.me && !isAva;
    // [AVAGRP-BUBBLE-1] Resolve ONE BubbleTheme for this whole bubble — never
    // re-derive a colour further down (in `_specialContent`, the meta row, the
    // reply strip, etc). `mine` excludes `toAva` (my own private question TO Ava
    // still renders in her lilac, not my green) and `senderKey` is the STABLE
    // `senderPub` uid, never the display name — see the `_Msg.senderPub` doc.
    final t = resolveBubbleTheme(
      mine: onRight && !toAva,
      isGroup: widget.chat.group,
      isAva: isAva || toAva,
      senderKey: m.senderPub,
    );
    // Telemetry seam: a group peer bubble with a senderPub but no learned name
    // AND no learned avatar is exactly the failure mode that used to render the
    // bare '?' avatar — flag it once per message so a future regression is
    // diagnosable from PostHog alone, without needing a screenshot report.
    if (widget.chat.group && !m.me && (m.senderPub?.isNotEmpty ?? false) &&
        _memberNames[m.senderPub] == null && _memberAvatars[m.senderPub] == null) {
      Analytics.capture('chat_group_sender_unresolved', {
        // Analytics.capture already stamps the account's email/phone on every
        // event (Analytics._base) — no need to pass them explicitly here.
        'gid': widget.chat.gid ?? '',
        'sender_pub': _shortPub(m.senderPub!),
        'has_label': m.senderLabel != null,
      });
    }
    // [UI-BUBBLE-STICKER] Fully bubble-LESS sticker (Stream E follow-up). A
    // sticker rides the media pipeline tagged via `isStickerName`. WhatsApp-parity:
    // render StickerMediaView (160dp) with NO bubble chrome — no background, no
    // padding, no tail, no border — aligned to the sender side, with the timestamp
    // + read receipt in a small row BELOW the sticker (also side-aligned). Long-
    // press still opens the reaction/action sheet; tap opens the fullscreen viewer.
    // Moved below the `t` resolution ([AVAGRP-BUBBLE-1]) so the meta row under
    // the sticker can carry the same per-sender colour as every other bubble.
    if (isStickerName(m.media?.name ?? '')) {
      return _stickerBubbleLess(m, t);
    }
    // [UI-BUBBLE-2] "media IS the bubble": for a bare image/video (no caption,
    // no reply, no special kind) the media fills the bubble edge-to-edge and the
    // forwarded label + timestamp/status overlay ON the media (bottom-right scrim
    // + top-left label) instead of the normal below-bubble rows.
    final _mediaKind = m.media?.kind ??
        (m.localBytes != null ? MediaKind.image : null);
    final isPureMedia = m.special == null &&
        hasMedia &&
        m.replyTo == null &&
        _mediaCaptionOf(m).isEmpty &&
        !isStickerName(m.media?.name ?? '') && // stickers keep their own bubble-less path
        (_mediaKind == MediaKind.image || _mediaKind == MediaKind.video);
    final core = GestureDetector(
        // Phase 5: long-press / right-click → floating reaction pill anchored at
        // the touch point. Double-tap → quick ❤️ (toggle), like iMessage.
        onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
        // Double-tap → quick ❤️ (toggle). Disabled on media bubbles so the
        // single-tap "open image/video" stays instant (no double-tap wait).
        onDoubleTap: hasMedia
            ? null
            : () {
                Analytics.capture('chat_react_doubletap', const <String, Object>{});
                _react(m, '❤️');
              },
        child: Column(
          crossAxisAlignment: onRight ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Container(
              margin: EdgeInsets.only(bottom: m.reaction == null ? 8 : 2),
              // Visual media (image/video/file/pdf cards) hug the bubble edge with
              // a slim border. Resolve the kind via localBytes too, so a still-
              // uploading attachment (m.media == null) doesn't fall back to the
              // wide text padding — that was the broad white border on sent media.
              // Voice notes stay on the normal padding (they're an inline row).
              // [AVAGRP-BUBBLE-1] Owner (2026-07-17): every bubble kind, including
              // pure image/video, must be "enclosed inside a pale color" — the old
              // ZERO padding for `isPureMedia` put the media flush to the outer
              // rounded edge with no pale surround at all. Give it the SAME 3px hug
              // as every other media kind instead of a special-cased zero.
              padding: (m.special == null &&
                          hasMedia &&
                          (m.media?.kind ??
                                  (m.localBytes != null ? MediaKind.image : MediaKind.file)) !=
                              MediaKind.audio)
                      ? const EdgeInsets.all(3)
                      // A link-preview card hugs the bubble edge (3px, like
                      // media) instead of floating inside a 14px gutter.
                      : (m.extra?['preview'] is Map)
                          ? const EdgeInsets.fromLTRB(4, 4, 4, 6)
                          : const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              // Ava email-card and GenUI/A2UI bubbles need more room (the design
              // uses ~92%); everything else stays at the standard [UI-BUBBLE-1] 78%
              // (symmetric for incoming & outgoing — text sizes to content up to this).
              // Link-preview bubbles also take the wide lane: the card is the
              // content, and at 78% it left a dead gutter of bubble colour on
              // both sides of the thumbnail.
              constraints: BoxConstraints(
                  maxWidth: MediaQuery.of(context).size.width *
                      (((m.extra?['emails'] is List && (m.extra!['emails'] as List).isNotEmpty) ||
                              m.extra?['a2ui'] is Map ||
                              m.extra?['preview'] is Map)
                          ? 0.92
                          : 0.78)),
              // [AVAGRP-BUBBLE-1] Pale fill from the ONE resolved `t`: mine =
              // pale green, Ava (or my message TO Ava) = pale blue, a 1:1 peer =
              // pale lilac, and in GROUPS each sender gets their own stable pale
              // tint (keyed on `senderPub`, never the display name) so you can
              // tell at a glance who said what. A hairline `t.border` gives pale
              // bubbles an edge against the white canvas.
              decoration: BoxDecoration(
                color: t.bg,
                border: Border.all(color: t.border, width: 1),
                boxShadow: const [],
                borderRadius: t.radius,
              ),
              // [UI-BUBBLE-2] clip edge-to-edge media to the bubble's rounded shape.
              clipBehavior: isPureMedia ? Clip.antiAlias : Clip.none,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Ava label — a small "AVA" tag on her bubbles. ava_private
                  // adds a "· private" hint so the recipient knows it is just
                  // for them (consent/disclosure, proposal §9).
                  if (isAva)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                            size: 11, color: t.ink),
                        const SizedBox(width: 4),
                        Text(
                            m.special == 'ava_private' ? 'AVA · PRIVATE' : 'AVA',
                            style: ADText.bubbleMeta(c: t.ink)),
                      ]),
                    ),
                  // [UI-BUBBLE-2] For pure media the FORWARDED label overlays the
                  // media (top-left) instead of this inline row.
                  if (m.forwarded && !isPureMedia)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 1),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold),
                            size: 11, color: t.meta),
                        const SizedBox(width: 3),
                        Text('FORWARDED', style: ADText.bubbleMeta(c: t.meta)),
                      ]),
                    ),
                  // [AVAGRP-BUBBLE-1] Sender name header uses the same saturated
                  // sibling colour as the bubble's own tint (`groupSenderNameColor`)
                  // so the name always matches the bubble it sits above.
                  if (m.senderLabel != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Text(m.senderLabel!.toUpperCase(),
                          style: ADText.bubbleMeta(
                              c: (m.senderPub?.isNotEmpty ?? false)
                                  ? groupSenderNameColor(m.senderPub!)
                                  : t.play)),
                    ),
                  if (m.replyTo != null)
                    Container(
                      margin: const EdgeInsets.only(bottom: 4),
                      padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
                      decoration: BoxDecoration(
                          color: t.bg.withValues(alpha: 0.6),
                          border: Border(left: BorderSide(color: t.play, width: 3)),
                          borderRadius: BorderRadius.circular(6)),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                        Text((m.replyTo!['who'] ?? '').toString().toUpperCase(),
                            style: ADText.bubbleMeta(c: t.play)),
                        Text((m.replyTo!['preview'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: ADText.bubbleBody(c: t.ink)),
                      ]),
                    ),
                  if (m.special != null) _specialContent(m, t)
                  else if (hasMedia) ...[
                    // [UI-BUBBLE-2] pure image/video → media fills edge-to-edge with
                    // the forwarded label + timestamp/status overlaid on it.
                    _mediaContent(m, t, overlayMeta: isPureMedia),
                    // WhatsApp-style caption: the attachment's own text, in the
                    // SAME bubble. A hairline divider above it separates the media
                    // area from the text area so the two read as distinct zones.
                    if (_mediaCaptionOf(m).isNotEmpty) ...[
                      // Full-bleed divider: negative horizontal margin (= the 3px
                      // media padding) pushes it flush to the bubble's inner edge,
                      // and a 2px border-toned rule clearly splits the media + text zones.
                      Container(
                        margin: const EdgeInsets.fromLTRB(-3, 7, -3, 0),
                        height: 2,
                        color: t.border,
                      ),
                      Padding(
                        padding: const EdgeInsets.only(top: 7, left: 5, right: 5),
                        child: Text(_mediaCaptionOf(m),
                            style: ADText.bubbleBody(c: t.ink)),
                      ),
                    ],
                    // Voice-note transcript / translation (viewer-only). Rendered
                    // below the waveform when the user long-pressed → Transcribe
                    // or Translate. Both are cached per message, per-account.
                    ..._voiceTranscriptBlock(m, t),
                  ]
                  else _textContent(m, t),
                  // [UI-BUBBLE-2] pure media carries its timestamp/status as an
                  // overlay scrim on the media itself, so skip this inline row.
                  if (!isPureMedia)
                  Padding(
                    padding: const EdgeInsets.only(top: 3, left: 2, right: 2),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      if (m.starred) ...[
                        PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill), size: 11, color: t.play),
                        const SizedBox(width: 3),
                      ],
                      if (m.edited) ...[
                        Text('EDITED ', style: ADText.bubbleMeta(c: t.meta)),
                      ],
                      // Mono timestamp (10px) — Phase 5: live relative age for
                      // recent messages ("now"/"2m"/"1h"), fixed HH:MM for older.
                      // [AVAGRP-BUBBLE-1] Every bubble kind reaches this row (or
                      // the pure-media overlay / sticker meta row below) — the
                      // owner's "every message needs a date+time stamp" rule.
                      Text(m.ts != 0 ? _relTime(m.ts) : m.time,
                          style: ADText.bubbleMeta(c: t.meta)),
                      if (m.expireAt != null) ...[
                        const SizedBox(width: 4),
                        PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold), size: 11, color: t.meta),
                      ],
                      // Delivery status (my 1:1 messages): tick + tiny caption —
                      // sending → "waiting to reach phone" (1 tick) → "delivered"
                      // (2 grey) → "read" (2 blue). Tap to retry when failed.
                      Builder(builder: (_) {
                        final st = _statusFor(m);
                        if (st == null) return const SizedBox.shrink();
                        final row = Row(mainAxisSize: MainAxisSize.min, children: [
                          const SizedBox(width: 4),
                          Icon(st.icon, size: 13, color: st.color),
                          const SizedBox(width: 3),
                          Text(st.label.toUpperCase(),
                              style: ADText.bubbleMeta(c: st.color)), // status colour is semantic (danger/read/etc.), not theme-tinted
                        ]);
                        if (!m.failed) return row;
                        return GestureDetector(
                          onTap: () {
                            // [AVA-CHAT-INSTANT] Manual retry telemetry + fresh
                            // round-trip anchor (email auto-attached by _base).
                            m.sendStartedMs = DateTime.now().millisecondsSinceEpoch;
                            Analytics.capture('msg_send_retry', {
                              'conv_kind': _isGroup ? 'group' : 'dm',
                              'has_media': m.localBytes != null || m.media != null,
                            });
                            if (m.localBytes != null) {
                              // [AVAVM-PLAYER-1] Prefer the real `pendingKind`
                              // over a blind `MediaKind.file` fallback — a
                              // failed voice-note retry was re-uploading as a
                              // generic file, which upload-succeeds but then
                              // renders wrong on the recipient's side too.
                              final kind = m.pendingKind ?? m.media?.kind ?? MediaKind.file;
                              _upload(m, m.localBytes!, kind, 'application/octet-stream', m.text);
                            } else if (_realMode && _dm != null && m.media == null && m.special == null) {
                              // Resend a failed text message; track the new wrap.
                              // [AVA-IDGATE-1 / CSAM-GATE-1] Do NOT optimistically mark this
                              // `sent` — that showed a false "SENT" tick (and could show one
                              // for a message the server 403s as identity_required) before the
                              // outbox's own ACK. Re-queue as "sending…" and let
                              // _onSendStatus() flip `sent` only once the server actually
                              // returns 200 for this client_id.
                              final newId = _dm!.send(jsonEncode({'t': 'text', 'body': m.text,
                                  if (m.replyTo != null) 'replyTo': m.replyTo, if (m.expireAt != null) 'exp': m.expireAt}));
                              setState(() { m.evId = newId; m.failed = false; m.sent = false; _seenEv.add(newId); });
                            }
                          },
                          child: row,
                        );
                      }),
                      if (m.uploading && _statusFor(m) == null) ...[
                        const SizedBox(width: 6),
                        const SizedBox(width: 10, height: 10,
                            child: CircularProgressIndicator(strokeWidth: 1.5, color: AD.bubbleInMeta)),
                      ],
                    ]),
                  ),
                ],
              ),
            ),
            // Phase 4: aggregate reaction chips (emoji + live count). Falls back to
            // a single sticker when there are no counts yet (legacy local-only tap).
            if (m.reactCounts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10, top: 1),
                child: Wrap(spacing: 4, children: [
                  for (final e in m.reactCounts.entries)
                    GestureDetector(
                      onTap: () => _react(m, e.key),
                      onLongPress: () => _showReactedBy(m), // Phase 5: who reacted
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                            color: m.reaction == e.key ? AD.primaryBadge : t.bg,
                            borderRadius: BorderRadius.circular(100),
                            border: Border.all(color: t.border, width: 2),
                            boxShadow: const []),
                        child: Text(e.value > 1 ? '${e.key} ${e.value}' : e.key,
                            style: const TextStyle(fontSize: 13)),
                      ),
                    ),
                ]),
              )
            else if (m.reaction != null)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                // Reaction sticker — themed border, no blur.
                decoration: BoxDecoration(
                    color: t.bg,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: t.border, width: 2),
                    boxShadow: const []),
                child: Text(m.reaction!, style: const TextStyle(fontSize: 14)),
              ),
          ],
        ),
      );
    // My own bubbles: avatar circle on the RIGHT (my photo / initials).
    if (onRight) {
      return Padding(
        padding: const EdgeInsets.only(left: 28),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            Flexible(child: core),
            const SizedBox(width: 6),
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: t.border, width: 1.5),
              ),
              child: Avatar(
                seed: _myNpub ?? 'me',
                name: _myName ?? 'You',
                size: 30,
                avatarUrl: _myAvatarUrl.isEmpty ? null : _myAvatarUrl,
              ),
            ),
          ],
        ),
      );
    }
    // Incoming bubbles (a 1:1 peer, a group member, or Ava) get a tiny avatar
    // circle on the left so you can tell at a glance who said it.
    return Padding(
      padding: const EdgeInsets.only(right: 28),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          _bubbleAvatar(m, isAva, t),
          const SizedBox(width: 6),
          Flexible(child: core),
        ],
      ),
    );
  }

  // [UI-BUBBLE-STICKER] A sticker rendered with ZERO bubble chrome: just the
  // 160dp sticker aligned to the sender's side, with a slim timestamp + read-
  // receipt row underneath (WhatsApp-parity). Long-press → reaction/action sheet;
  // tap → fullscreen viewer once bytes are available.
  Widget _stickerBubbleLess(_Msg m, BubbleTheme t) {
    final onRight = m.me && !_isAvaBubble(m);
    final st = _statusFor(m);
    // The sticker itself (decrypt on demand for received stickers).
    Widget sticker() {
      final bytes = m.localBytes;
      if (bytes != null) return StickerMediaView(bytes: bytes, mine: m.me);
      if (m.media != null) {
        return FutureBuilder<Uint8List>(
          future: MediaService.downloadAndDecrypt(m.media!),
          builder: (c, snap) {
            if (snap.hasData) m.localBytes = snap.data; // cache decrypted bytes
            return snap.hasData
                ? StickerMediaView(bytes: snap.data!, mine: m.me)
                : const SizedBox(
                    width: kStickerRenderSize, height: kStickerRenderSize);
          },
        );
      }
      return const SizedBox(
          width: kStickerRenderSize, height: kStickerRenderSize);
    }

    // Timestamp + delivery-status row, mirroring the in-bubble meta row but with
    // no bubble surround. Aligned to the sender's side.
    final meta = Padding(
      padding: const EdgeInsets.only(top: 2, left: 4, right: 4),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (m.starred) ...[
          PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill),
              size: 11, color: t.play),
          const SizedBox(width: 3),
        ],
        // [AVAGRP-BUBBLE-1] Sticker bubbles are bubble-LESS, but the owner's
        // "every message needs a date+time stamp" rule still applies — this row
        // is that stamp, themed to match the sender like every other bubble.
        Text(m.ts != 0 ? _relTime(m.ts) : m.time,
            style: ADText.bubbleMeta(c: t.meta)),
        if (st != null) ...[
          const SizedBox(width: 4),
          Icon(st.icon, size: 13, color: st.color),
        ],
      ]),
    );

    final column = Column(
      crossAxisAlignment:
          onRight ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
          onTap: () {
            final b = m.localBytes;
            if (b != null) _openImageBytes(b, mime: m.media?.contentType);
          },
          child: sticker(),
        ),
        meta,
        if (m.reactCounts.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 8),
            child: Wrap(spacing: 4, children: [
              for (final e in m.reactCounts.entries)
                GestureDetector(
                  onTap: () => _react(m, e.key),
                  onLongPress: () => _showReactedBy(m),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                        color: m.reaction == e.key ? AD.primaryBadge : t.bg,
                        borderRadius: BorderRadius.circular(100),
                        border: Border.all(color: t.border, width: 2),
                        boxShadow: const []),
                    child: Text(e.value > 1 ? '${e.key} ${e.value}' : e.key,
                        style: const TextStyle(fontSize: 13)),
                  ),
                ),
            ]),
          )
        else
          const SizedBox(height: 8),
      ],
    );

    // Align to the sender's side, matching the padding gutters used by the
    // normal bubble rows (so the sticker sits under the same margin).
    return Padding(
      padding: EdgeInsets.only(left: onRight ? 34 : 0, right: onRight ? 0 : 34),
      child: Align(
        alignment: onRight ? Alignment.centerRight : Alignment.centerLeft,
        child: column,
      ),
    );
  }

  // The tiny avatar shown beside an incoming bubble. Ava uses her sitewide
  // asset (with a lilac-sparkle fallback if the asset is missing); a 1:1 peer
  // uses the chat's avatar; a group member uses their OWN photo (from
  // `_memberAvatars`, keyed by the stable `senderPub`) when known, else
  // initials from their learned name — NEVER a bare '?'.
  //
  // [AVAGRP-BUBBLE-1] Root cause of the old '?' bug: the group branch passed no
  // `avatarUrl` (so a photo could never render) AND seeded/named off
  // `m.senderLabel`, which is null until a name is learned from the wire — so
  // `Avatar._initials` fell through to '?'. Both are fixed here: `avatarUrl`
  // is threaded through, and the seed/name chain always resolves to SOMETHING
  // human before ever reaching an empty string.
  Widget _bubbleAvatar(_Msg m, bool isAva, BubbleTheme t) {
    const s = 30.0;
    Widget inner;
    if (isAva) {
      inner = ClipOval(
        child: Image.asset(
          AvaId.avatarAsset,
          width: s, height: s, fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => Container(
            width: s, height: s, color: t.bg, alignment: Alignment.center,
            child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                size: 15, color: t.ink),
          ),
        ),
      );
    } else if (widget.chat.group) {
      final pub = m.senderPub ?? '';
      final learnedName = pub.isNotEmpty ? _memberNames[pub] : null;
      // Fallback chain: learned name → senderLabel (may already BE a short
      // pub from `_groupLabelFor`) → short pub → 'peer'. Always non-empty.
      final name = (learnedName != null && learnedName.isNotEmpty)
          ? learnedName
          : (m.senderLabel != null && m.senderLabel!.isNotEmpty)
              ? m.senderLabel!
              : (pub.isNotEmpty ? _shortPub(pub) : 'peer');
      final avatarUrl = pub.isNotEmpty ? _memberAvatars[pub] : null;
      inner = Avatar(
        seed: pub.isNotEmpty ? pub : name, // stable uid seed, never the mutable label
        name: name,
        size: s,
        avatarUrl: (avatarUrl?.isNotEmpty ?? false) ? avatarUrl : null,
      );
    } else {
      inner = Avatar(seed: widget.chat.seed, name: widget.chat.name, size: s,
          avatarUrl: widget.chat.avatarUrl.isEmpty ? null : widget.chat.avatarUrl);
    }
    final avatarBox = Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: t.border, width: 1.5),
      ),
      child: inner,
    );
    // [AVA-GRP-UI] Tapping a real person's avatar opens their full profile popup.
    // Ava has no profile; unknown-number tel: rows aren't `user_…` ids so
    // `_openMemberProfile` no-ops for them.
    if (isAva) return avatarBox;
    String? tapUid;
    String tapName = '';
    String? tapAvatar;
    if (widget.chat.group) {
      final pub = m.senderPub ?? '';
      if (pub.isNotEmpty) {
        tapUid = pub;
        tapName = (_memberNames[pub]?.isNotEmpty ?? false)
            ? _memberNames[pub]!
            : (m.senderLabel?.isNotEmpty ?? false) ? m.senderLabel! : _shortPub(pub);
        tapAvatar = _memberAvatars[pub];
      }
    } else {
      tapUid = widget.chat.seed;
      tapName = widget.chat.name;
      tapAvatar = widget.chat.avatarUrl;
    }
    if (tapUid == null || !tapUid.startsWith('user_')) return avatarBox;
    final uid = tapUid;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _openMemberProfile(
        uid: uid,
        name: tapName,
        avatarUrl: tapAvatar,
        from: widget.chat.group ? 'group_bubble_avatar' : 'dm_bubble_avatar',
      ),
      child: avatarBox,
    );
  }

  // The caption to show under a media bubble — the instant local value (set on
  // send) or, for received/restored messages, whatever rode in the envelope.
  String _mediaCaptionOf(_Msg m) =>
      m.mediaCaption.isNotEmpty ? m.mediaCaption : (m.media?.caption ?? '');

  /// Below-the-waveform transcript + translation for a voice note (viewer-only).
  /// Styled like the inline text-translate rendering: a hairline rule then the
  /// text, with a small translate/transcript glyph + label. Empty for anything
  /// that hasn't been transcribed/translated yet, so it costs nothing until used.
  List<Widget> _voiceTranscriptBlock(_Msg m, BubbleTheme t) {
    final transcript = (m.extra?['transcript'] as String?)?.trim();
    final translated = (m.extra?['transcript_translated'] as String?)?.trim();
    final tLang = (m.extra?['transcript_translated_lang'] as String?) ?? '';
    if ((transcript == null || transcript.isEmpty) &&
        (translated == null || translated.isEmpty)) {
      return const [];
    }
    Widget line(IconData icon, String label, String body) => Padding(
          padding: const EdgeInsets.only(top: 6, left: 5, right: 5),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(icon, size: 11, color: t.play),
              const SizedBox(width: 4),
              Text(label, style: ADText.bubbleMeta(c: t.play)),
            ]),
            const SizedBox(height: 2),
            Text(body, style: ADText.bubbleBody(c: t.ink)),
          ]),
        );
    return [
      Container(
        margin: const EdgeInsets.fromLTRB(-3, 7, -3, 0),
        height: 2,
        color: t.border,
      ),
      if (transcript != null && transcript.isNotEmpty)
        line(PhosphorIcons.textAa(PhosphorIconsStyle.bold), 'transcript', transcript),
      if (translated != null && translated.isNotEmpty)
        line(PhosphorIcons.translate(PhosphorIconsStyle.bold),
            tLang.isEmpty ? 'translated' : 'translated · $tLang', translated),
    ];
  }

  // Plain-text bubble content: links are tappable, and a YouTube link renders a
  // rich card with inline playback right inside the chat (no leaving the thread).
  Widget _textContent(_Msg m, BubbleTheme t) {
    final style = ADText.bubbleBody(c: t.ink);
    final link = ChatLinkText(text: m.text, style: style, theme: t);

    // STREAM G [GROUP-AI-3/5]: translated bubble → "show original" toggle. Wraps
    // the ORIGINAL child; does NOT alter Stream K geometry.
    final translated = m.extra?['translated'] as String?;
    if (translated != null && translated.trim().isNotEmpty) {
      // Translations suppress the preview card (the text is the point).
      return TranslatedText(original: link, translated: translated, translatedStyle: style);
    }

    // STREAM C [PREVIEW-3]: STRANGER GATE — while the thread's accept_state is
    // pending, render raw URL text only (never a card). Also honours the master
    // linkPreviewsEnabled flag ([PREVIEW-4]).
    final pending = _threadAcceptState == 'pending';
    if (pending || !RemoteConfig.linkPreviewsEnabled) return link;

    // Preferred path: render the card from the SENDER's compose-time envelope
    // preview (m.extra['preview']) — zero recipient fetch.
    final envPreview = LinkPreview.fromEnvelope(m.extra?['preview']);
    if (envPreview != null) {
      final card = buildLinkPreviewCard(envPreview, pending: pending, theme: t);
      if (card != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && envPreview.isYouTube) {
            Analytics.capture('chat_youtube_card_shown', {'video_id': envPreview.videoId ?? ''});
          }
        });
        // WhatsApp order: the rich card sits ON TOP, the raw URL text below it.
        // The bubble drops to 4px padding for preview messages, so the text
        // below the card re-adds its own breathing room.
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            card,
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: link,
            ),
          ],
        );
      }
    }

    // Fallback (older messages / sender had no preview): keep the legacy inline
    // YouTube card so a bare youtube link still plays inline.
    final ytId = firstYouTubeId(m.text);
    if (ytId == null) return link;
    final ytUrl = urlSpans(m.text)
        .map((s) => s.url)
        .firstWhere((u) => firstYouTubeId(u) == ytId, orElse: () => 'https://youtu.be/$ytId');
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Analytics.capture('chat_youtube_card_shown', {'video_id': ytId});
    });
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      YouTubeCard(videoId: ytId, url: ytUrl, theme: t),
      const SizedBox(height: 6),
      link,
    ]);
  }

  /// [UI-BUBBLE-2] The overlay stack children for an edge-to-edge image/video:
  /// the "↪ Forwarded" label (top-left, when fwd:true) and the timestamp/status
  /// scrim (bottom-right). White-on-scrim so it reads over any image.
  List<Widget> _mediaMetaOverlays(_Msg m) {
    final st = _statusFor(m);
    final trailing = Row(mainAxisSize: MainAxisSize.min, children: [
      Text(m.ts != 0 ? _relTime(m.ts) : m.time,
          style: ADText.statCaption(c: Colors.white)),
      if (m.expireAt != null) ...[
        const SizedBox(width: 4),
        PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold), size: 11, color: Colors.white),
      ],
      if (st != null) ...[
        const SizedBox(width: 5),
        Icon(st.icon, size: 13, color: st.color == AD.iconSearch ? const Color(0xFF7EC8FF) : Colors.white),
      ],
    ]);
    return [
      if (m.forwarded) const MediaForwardedLabel(),
      MediaTimestampScrim(trailing: trailing),
    ];
  }

  Widget _mediaContent(_Msg m, BubbleTheme t, {bool overlayMeta = false}) {
    // STREAM E: sticker media (tagged via stickerMediaName). Renders at a fixed
    // 160dp via StickerMediaView. NOTE: pure sticker messages are now intercepted
    // in _bubble() and rendered fully bubble-LESS via _stickerBubbleLess (no
    // background/padding/tail) — see [UI-BUBBLE-STICKER]. This branch is retained
    // as a defensive fallback for any sticker that reaches _mediaContent (e.g. a
    // sticker with a caption/reply that keeps the normal bubble).
    final stName = m.media?.name ?? '';
    if (isStickerName(stName)) {
      final bytes = m.localBytes;
      if (bytes != null) return StickerMediaView(bytes: bytes, mine: m.me);
      if (m.media != null) {
        return FutureBuilder<Uint8List>(
          future: MediaService.downloadAndDecrypt(m.media!),
          builder: (c, snap) => snap.hasData
              ? StickerMediaView(bytes: snap.data!, mine: m.me)
              : const SizedBox(width: kStickerRenderSize, height: kStickerRenderSize),
        );
      }
    }
    // [AVAVM-PLAYER-1] Prefer the real `pendingKind` stamped at send time
    // (`_sendMedia`) over guessing `image` from `localBytes != null` alone —
    // that guess was ALWAYS wrong for an in-flight voice note (and video),
    // routing raw non-image bytes into `Image.memory()`, whose decode failure
    // fell through `errorBuilder` to a blank `SizedBox.shrink()`. `media?.kind`
    // stays authoritative once the upload completes.
    final kind = m.media?.kind ?? m.pendingKind ??
        (m.localBytes != null ? MediaKind.image : MediaKind.file);
    switch (kind) {
      case MediaKind.image:
        if (m.localBytes != null) {
          // [UI-BUBBLE-2] edge-to-edge, 78%-wide, ≤320dp, overlaid meta.
          if (overlayMeta) {
            return ChatImageCard(
              bytes: m.localBytes!,
              onTap: () => _openImageBytes(m.localBytes!, mime: m.media?.contentType),
              overlays: _mediaMetaOverlays(m),
              theme: t,
            );
          }
          // Tap → full-screen, pinch-to-zoom viewer with an X to close (and a
          // Copy button). Long-press still opens the message action sheet.
          return GestureDetector(
            onTap: () => _openImageBytes(m.localBytes!, mime: m.media?.contentType),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: Image.memory(m.localBytes!, width: 220, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
            ),
          );
        }
        if (m.media != null) {
          // STREAM J (D17): auto-download off + no local bytes -> tap-to-download
          // placeholder instead of eagerly fetching. Tapping is a MANUAL fetch
          // (always allowed); it caches into m.localBytes and repaints the preview.
          if (!_mediaAutoFetch) {
            return MediaDownloadPlaceholder(
              key: ValueKey('imgph_${m.media!.id}'),
              media: m.media!,
              width: 220,
              height: 160,
              onFetched: (bytes) {
                if (!mounted) return;
                setState(() => m.localBytes = bytes);
              },
            );
          }
          return FutureBuilder<Uint8List>(
            future: MediaService.downloadAndDecrypt(m.media!),
            builder: (ctx, snap) {
              if (snap.hasData) {
                m.localBytes = snap.data; // cache decrypted bytes
                // [UI-BUBBLE-2] edge-to-edge, 78%-wide, ≤320dp, overlaid meta.
                if (overlayMeta) {
                  return ChatImageCard(
                    bytes: snap.data!,
                    onTap: () => _openImageBytes(snap.data!, mime: m.media?.contentType),
                    overlays: _mediaMetaOverlays(m),
                    theme: t,
                  );
                }
                return GestureDetector(
                  onTap: () => _openImageBytes(snap.data!, mime: m.media?.contentType),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(14),
                    child: Image.memory(snap.data!, width: 220, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const SizedBox.shrink()),
                  ),
                );
              }
              if (snap.hasError) return _fileChip(m, PhosphorIcons.imageBroken(PhosphorIconsStyle.bold), 'Photo');
              return Container(
                width: 220, height: 140, alignment: Alignment.center,
                child: const CircularProgressIndicator(strokeWidth: 2),
              );
            },
          );
        }
        return _fileChip(m, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Photo');
      case MediaKind.audio:
        // [AVAVM-PLAYER-1] Explicit posting feedback while `media` is still
        // null and the upload is in flight — this is the fix for the "empty
        // bubble, is my voice note gone?" report. Checked BEFORE the
        // auto-fetch placeholder below (which is only for ALREADY-uploaded,
        // not-yet-downloaded notes) and before the playable bubble.
        if (m.media == null && m.uploading) {
          return PendingVoiceNoteBubble(onRight: m.me && !_isAvaBubble(m), theme: t);
        }
        // Upload FAILED — an explicit error beats a bubble that spins
        // forever. Retry re-runs the exact same upload the status-row "tap to
        // retry" affordance uses (both now honour `m.pendingKind`).
        if (m.media == null && m.failed) {
          return FailedVoiceNoteBubble(
            onRight: m.me && !_isAvaBubble(m),
            onRetry: m.localBytes == null
                ? null
                : () => _upload(m, m.localBytes!, MediaKind.audio, 'audio/mp4', 'voice.m4a'),
            theme: t,
          );
        }
        // STREAM J (D17): auto-download off + nothing cached -> small download
        // button. Tapping fetches (manual = allowed) and repaints into play control.
        if (!_mediaAutoFetch && m.localBytes == null && m.media != null) {
          return MediaDownloadPlaceholder(
            key: ValueKey('audioph_${m.media!.id}'),
            media: m.media!,
            compact: true,
            onFetched: (bytes) {
              if (!mounted) return;
              setState(() => m.localBytes = bytes);
            },
          );
        }
        // [UI-BUBBLE-3] rich voice-note bubble: large circular play, waveform,
        // live duration, and a 1x/1.5x/2x speed chip after play starts.
        // [VOICE-SCRUB-1] Feed the bubble the shared player's REAL position and
        // duration — but only for the note that's actually open. Every other
        // voice bubble gets zero/null, so they render idle instead of all
        // mirroring the playhead of whichever note happens to be playing.
        final isOpen = _openAudioId == m.id;
        // [AVAVM-PLAYER-1] "Resume where you left off": for a note that ISN'T
        // the currently-open one, fall back to its persisted saved
        // position/duration (per-account, survives navigating away and a
        // cold start) so the bubble renders already parked where the user
        // paused it, instead of looking untouched until re-opened.
        final trackId = _audioTrackId(m);
        final savedPos = isOpen ? null : AudioPlaybackService.I.savedPosition(trackId);
        final savedDur = isOpen ? null : AudioPlaybackService.I.knownDuration(trackId);
        return VoiceNoteBubble(
          key: ValueKey('voice_${m.media?.id ?? m.id}'),
          playing: _playingAudioId == m.id,
          speed: _audioSpeed,
          onRight: m.me && !_isAvaBubble(m),
          onPlayPause: () => _playAudio(m),
          onCycleSpeed: _cycleAudioSpeed,
          position: isOpen ? _audioPos : (savedPos ?? Duration.zero),
          duration: isOpen ? _audioDur : savedDur,
          onSeek: isOpen ? (to) => _seekAudio(m, to) : null,
          theme: t,
        );
      case MediaKind.video:
        // Rich card: first-frame thumbnail + tap-to-play inline; the expand
        // glyph opens the fullscreen player. [UI-BUBBLE-2] when it's the whole
        // bubble, fill the width (≤78%, capped ~320dp by the card's 16:9) and
        // overlay the forwarded label + timestamp scrim.
        if (overlayMeta) {
          return LayoutBuilder(builder: (ctx, cons) {
            final w = cons.maxWidth.isFinite
                ? cons.maxWidth
                : MediaQuery.of(context).size.width * 0.78;
            return Stack(children: [
              ChatVideoCard(
                key: ValueKey('vid_${m.media?.id ?? m.id}'),
                media: m.media,
                localBytes: m.localBytes,
                width: w,
                autoFetch: _mediaAutoFetch,
                onFullscreen: () => _openVideo(m),
                theme: t,
              ),
              ..._mediaMetaOverlays(m),
            ]);
          });
        }
        return ChatVideoCard(
          key: ValueKey('vid_${m.media?.id ?? m.id}'),
          media: m.media,
          localBytes: m.localBytes,
          width: 220,
          autoFetch: _mediaAutoFetch,
          onFullscreen: () => _openVideo(m),
          theme: t,
        );
      case MediaKind.file:
        // Rich card: PDF first-page thumbnail, or a typed card (badge + name +
        // size) for any other file. Tap downloads/opens it.
        final fname = (m.media?.name.isNotEmpty == true)
            ? m.media!.name
            : m.text.replaceFirst('📎 ', '');
        // [UI-BUBBLE-2] full-width file row (no dead right space): fill the bubble
        // width so the filename can use the whole line, ellipsised.
        return LayoutBuilder(builder: (ctx, cons) {
          final w = cons.maxWidth.isFinite && cons.maxWidth > 0
              ? cons.maxWidth
              : MediaQuery.of(context).size.width * 0.78;
          final card = ChatFileCard(
            key: ValueKey('file_${m.media?.id ?? m.id}'),
            media: m.media,
            localBytes: m.localBytes,
            name: fname,
            mime: m.media?.contentType ?? '',
            size: m.media?.size ?? (m.localBytes?.length ?? 0),
            width: w,
            autoFetch: _mediaAutoFetch,
            onOpen: () => _openFile(m, fname),
            theme: t,
          );
          // [CHAT-PDFVIEW-1] Overlay a spinner while the tap downloads/decrypts
          // so the bubble shows progress instead of appearing dead.
          if (!m.fileOpening) return card;
          return Stack(alignment: Alignment.center, children: [
            card,
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                    color: Colors.black.withOpacity(0.18),
                    borderRadius: BorderRadius.circular(AD.rListCard)),
                child: const Center(
                    child: SizedBox(
                        width: 22, height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2))),
              ),
            ),
          ]);
        });
    }
  }

  /// [CHAT-PDFVIEW-1] Open an attachment. Downloads + decrypts (or reuses cached
  /// bytes) with a bubble spinner, then routes PDFs/images to the in-app viewer
  /// (pinch-zoom, page indicator, share). Any other type goes to the OS open sheet
  /// with a CLEAR snackbar when no handler exists — replacing the old silent
  /// `launchUrl(external)` that "did nothing" when no app claimed the file.
  Future<void> _openFile(_Msg m, String name) async {
    if (m.fileOpening) return;
    Analytics.capture('chat_file_open', {
      'kind': 'file',
      'mime': m.media?.contentType ?? '',
    });
    setState(() => m.fileOpening = true);
    try {
      final bytes = m.localBytes ??
          (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (!mounted) return;
      if (bytes == null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("Couldn't load $name")));
        return;
      }
      m.localBytes = bytes;
      final mime = m.media?.contentType ?? '';
      if (FileViewerScreen.canView(mime, name)) {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => FileViewerScreen(bytes: bytes, name: name, mime: mime),
        ));
      } else {
        final ok = await openFileWithOs(bytes, name, mime);
        if (!ok && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text("No app on this device can open $name — tap share to send it elsewhere.")));
        }
      }
    } catch (e) {
      AvaLog.I.log('media', 'open file failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("Couldn't open $name")));
      }
    } finally {
      if (mounted) setState(() => m.fileOpening = false);
    }
  }

  Widget _fileChip(_Msg m, IconData icon, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, color: AD.bubbleInInk),
        const SizedBox(width: 8),
        Flexible(child: Text(label,
            maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ADText.rowName(c: AD.bubbleInInk))),
      ]);
}

/// AvaMarketplace deal card (special kind 'marketplace_deal'). Shows the agent
/// negotiation result + a play button for the 2-voice audio note. Colour-coded:
/// DEAL = green (go), IMPASSE = pale yellow (no-go). Audio streams from the
/// authed /api/marketplace/audio endpoint (the render is server-side, not E2E).
class _MarketplaceDealCard extends StatefulWidget {
  const _MarketplaceDealCard({required this.extra});
  final Map<String, dynamic> extra;
  @override
  State<_MarketplaceDealCard> createState() => _MarketplaceDealCardState();
}

class _MarketplaceDealCardState extends State<_MarketplaceDealCard> {
  final AudioPlayer _player = AudioPlayer();
  bool _loading = false;
  bool _playing = false;
  bool _sharing = false;
  bool _expanded = false;
  Uint8List? _bytes; // cached downloaded audio (play + share reuse it)

  Map<String, dynamic> get _e => widget.extra;
  bool get _isDeal => _e['outcome'] == 'deal';
  String get _audioKey => (_e['audio_key'] ?? '').toString();
  bool get _isMp3 => _audioKey.toLowerCase().endsWith('.mp3');
  String get _mime => _isMp3 ? 'audio/mpeg' : 'audio/wav';

  @override
  void dispose() { _player.dispose(); super.dispose(); }

  /// Download the audio once and cache it (play + share both use it).
  Future<Uint8List?> _fetchBytes() async {
    if (_bytes != null) return _bytes;
    if (_audioKey.isEmpty) return null;
    final url = 'https://$kSignalingHost/api/marketplace/audio?key=${Uri.encodeQueryComponent(_audioKey)}';
    final r = await ApiAuth.getBytes(url);
    if (r.statusCode != 200 || r.bodyBytes.isEmpty) return null;
    _bytes = r.bodyBytes;
    return _bytes;
  }

  Future<void> _toggle() async {
    if (_playing) { await _player.stop(); if (mounted) setState(() => _playing = false); return; }
    if (_audioKey.isEmpty) return;
    setState(() => _loading = true);
    try {
      final b = await _fetchBytes();
      if (b == null) { if (mounted) setState(() => _loading = false); return; }
      _player.onPlayerComplete.listen((_) { if (mounted) setState(() => _playing = false); });
      await _player.play(BytesSource(b, mimeType: _mime));
      if (mounted) setState(() { _loading = false; _playing = true; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Save the voice note to a temp file and open the native share sheet, so the
  /// user can send it to WhatsApp / Telegram / anywhere.
  Future<void> _share() async {
    if (_audioKey.isEmpty || _sharing) return;
    setState(() => _sharing = true);
    try {
      final b = await _fetchBytes();
      if (b == null) { if (mounted) setState(() => _sharing = false); return; }
      final dir = await getTemporaryDirectory();
      final ext = _isMp3 ? 'mp3' : 'wav';
      final f = File('${dir.path}/negotiation_${DateTime.now().millisecondsSinceEpoch}.$ext');
      await f.writeAsBytes(b, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: _mime)],
          text: 'Voice conversation from my AvaTOK agents');
    } catch (_) {/* best-effort */} finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bg = _isDeal ? const Color(0xFFD7F5DD) : const Color(0xFFFFF6CC); // green / pale yellow
    final transcript = (_e['transcript'] as List?) ?? const [];
    final text = (_e['text'] ?? (_isDeal ? 'Your agents reached a deal.' : 'Your agents finished negotiating.')).toString();
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: AD.bubbleInInk, width: 2),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text(_isDeal ? '🤝 Deal' : '💬 No deal',
              style: ADText.bubbleMeta(c: AD.bubbleInInk)),
        ]),
        const SizedBox(height: 4),
        Text(text, style: ADText.bubbleBody(c: AD.bubbleInInk)),
        const SizedBox(height: 8),
        Row(children: [
          GestureDetector(
            onTap: _audioKey.isEmpty ? null : _toggle,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: _audioKey.isEmpty ? AD.bubbleInMeta : AD.bubbleInInk,
                borderRadius: BorderRadius.circular(100),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(_loading ? Icons.hourglass_top : _playing ? Icons.stop : Icons.play_arrow,
                    color: Colors.white, size: 18),
                const SizedBox(width: 6),
                Text(_audioKey.isEmpty ? 'No audio' : _playing ? 'Stop' : 'Play conversation',
                    style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600)),
              ]),
            ),
          ),
          if (_audioKey.isNotEmpty) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap: _sharing ? null : _share,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: AD.mediaPlaceholderBg,
                  border: Border.all(color: AD.bubbleInInk, width: 1.5),
                  borderRadius: BorderRadius.circular(100),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(_sharing ? Icons.hourglass_top : Icons.ios_share, color: AD.bubbleInInk, size: 16),
                  const SizedBox(width: 5),
                  const Text('Share', style: TextStyle(color: Colors.black, fontSize: 12, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
          ],
          const Spacer(),
          if (transcript.isNotEmpty)
            GestureDetector(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Text(_expanded ? 'Hide' : 'Transcript',
                  style: ADText.bubbleMeta(c: AD.bubbleInMeta)),
            ),
        ]),
        if (_expanded && transcript.isNotEmpty) ...[
          const SizedBox(height: 8),
          ...transcript.whereType<Map>().map((t) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text('${t['speaker'] ?? 'Agent'}: ${t['text'] ?? ''}',
                    style: ADText.bubbleBody(c: AD.bubbleInInk)),
              )),
        ],
      ]),
    );
  }
}

/// Ava Receptionist message card (special kind 'recept', v2). Renders inside a
/// chat bubble when Ava answered a call the owner missed: who called, the
/// AI summary, an expandable transcript and a play button for the voicemail
/// recording (streamed from /api/receptionist/recording, owner-authed).
/// Spec: Specs/PROPOSAL-RECEPTIONIST-V2.md §5.
class _ReceptionistCard extends StatefulWidget {
  const _ReceptionistCard({required this.extra, required this.sessionId});
  final Map<String, dynamic> extra;
  final String sessionId;
  @override
  State<_ReceptionistCard> createState() => _ReceptionistCardState();
}

class _ReceptionistCardState extends State<_ReceptionistCard> {
  final AudioPlayer _player = AudioPlayer();
  bool _expanded = false;
  bool _loadingAudio = false;
  bool _playing = false;
  bool _saved = true; // assume saved until the contacts check says otherwise

  @override
  void initState() {
    super.initState();
    // Prefetch the voicemail into the per-account cache as soon as the card
    // renders, so tapping Play replays LOCAL bytes instantly instead of waiting
    // on a fresh owner-authed download — the "playing the message took too long"
    // complaint. Best-effort; _togglePlay still fetches on demand if this misses.
    // ignore: unawaited_futures
    _prefetch();
    _checkSaved();
  }

  /// The caller's E.164 number (if the card carries one).
  String get _phone => (_e['caller_phone'] ?? '').toString();

  /// Decide whether to offer "Save contact": only when we have a phone number
  /// and no real (named) contact yet exists for it.
  Future<void> _checkSaved() async {
    final p = _phone;
    if (p.isEmpty) return;
    final e164 = DeviceContactsService.normPhone(p);
    try {
      final cs = await ContactsStore().load();
      if (mounted) setState(() => _saved = callerIsSaved(cs, e164));
    } catch (_) {/* leave the button hidden on failure */}
  }

  Future<void> _save() async {
    final p = _phone;
    if (p.isEmpty) return;
    final saved = await showSavePhoneContactSheet(context, phone: p, source: 'recept_card');
    if (saved != null && mounted) setState(() => _saved = true);
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Map<String, dynamic> get _e => widget.extra;

  bool _sharing = false;

  /// Export the voicemail recording to the OS share sheet (WhatsApp, Files, …).
  /// Cache-first, mirroring playback, so a previously-played recording shares
  /// instantly. This is the "no option to share a voice recording" fix.
  Future<void> _shareRecording() async {
    if (_sharing) return;
    setState(() => _sharing = true);
    try {
      final cacheKey = _cacheKey;
      Uint8List? bytes = await MediaService.cachedBlob(cacheKey);
      if (bytes == null || bytes.isEmpty) {
        final url = 'https://$kSignalingHost/api/receptionist/recording?sid=${widget.sessionId}';
        final r = await ApiAuth.getBytes(url);
        if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
          bytes = r.bodyBytes;
          await MediaService.writeBlob(cacheKey, bytes);
        }
      }
      if (bytes == null || bytes.isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Couldn’t load the recording to share.')));
        }
        return;
      }
      final dir = await getTemporaryDirectory();
      final caller = (_e['caller'] ?? _e['caller_name'] ?? 'voicemail').toString()
          .replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
      final f = File('${dir.path}/ava_${caller}_${widget.sessionId}.wav');
      await f.writeAsBytes(bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: 'audio/wav')],
          subject: 'Voicemail from ${_e['caller'] ?? 'a caller'}');
      Analytics.capture('ava_recept_share', {'session_id': widget.sessionId, 'ok': true});
    } catch (e) {
      Analytics.capture('ava_recept_share', {'session_id': widget.sessionId, 'ok': false});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Couldn’t share the recording.')));
      }
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  bool get _hasRecording =>
      _e['has_recording'] == true ||
      (_e['recording_url'] ?? '').toString().isNotEmpty;

  /// [AVAVM-PLAYER-2] KEY SCHEME NOTE: this card renders the AI-receptionist
  /// intercept session (`kind:'receptionist'`, worker/src/do/reception_room_cf.ts),
  /// a DIFFERENT server entity from the PSTN `kind:'voicemail'` row the Inbox
  /// card and `business_thread_widgets.dart`'s `VoicemailCard` render. Those
  /// two share ONE cache entry via `vm_<media_ref>` because `media_ref` (the R2
  /// key) rides inside their envelope body (GAP-3 fix, voicemail_room.ts). The
  /// receptionist session's envelope does NOT carry an R2 key at all — only
  /// `session_id` (reception_room_cf.ts's `postMessage` puts the R2 key
  /// (`recordingUrl`) in the top-level `/inbox/append` `media_ref` field, but
  /// never bakes it into the `body` JSON the client decodes into `extra`, so it
  /// never reaches this card). Grafting a client-side guess at that R2 key
  /// (`receptionist/<owner_uid>/<phoneKey>/<sid>.wav`) would be inventing a
  /// second, fragile key scheme from a different server file this issue does
  /// not own (worker/** is out of scope here) — so this card intentionally
  /// KEEPS its own `recept_<sessionId>` cache key. `sessionId` already 1:1
  /// identifies one recording, so this IS still a real, working cache — it
  /// just can't be unified with the other two lanes without a worker-side
  /// change to add `media_ref` inside the envelope body (follow-up, not done
  /// here).
  String get _cacheKey => 'recept_${widget.sessionId}';

  Future<void> _prefetch() async {
    final sid = widget.sessionId;
    if (sid.isEmpty || !_hasRecording) return;
    final cacheKey = _cacheKey;
    try {
      final cached = await MediaService.cachedBlob(cacheKey);
      if (cached != null && cached.isNotEmpty) {
        Analytics.capture('voicemail_cache', {
          'hit': true, 'stage': 'prefetch', 'lane': 'receptionist', 'session_id': sid,
        });
        return; // already on-device
      }
      final t0 = DateTime.now().millisecondsSinceEpoch;
      final url = 'https://$kSignalingHost/api/receptionist/recording?sid=$sid';
      final r = await ApiAuth.getBytes(url);
      if (r.statusCode != 200 || r.bodyBytes.isEmpty) return;
      await MediaService.writeBlob(cacheKey, r.bodyBytes); // best-effort
      Analytics.capture('ava_recept_recording_prefetched', {
        'session_id': sid,
        'bytes': r.bodyBytes.length,
        'fetch_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      Analytics.capture('voicemail_cache', {
        'hit': false, 'stage': 'prefetch', 'lane': 'receptionist', 'session_id': sid,
        'bytes': r.bodyBytes.length,
      });
    } catch (_) {/* on-demand fetch in _togglePlay is the fallback */}
  }

  String get _caller {
    final summary = _e['summary'];
    final name = (summary is Map ? summary['caller_name'] : null) ??
        _e['caller_name'] ?? _e['caller_phone'] ?? 'Unknown caller';
    return name.toString();
  }

  String get _reason {
    final summary = _e['summary'];
    if (summary is Map && (summary['reason'] ?? '').toString().trim().isNotEmpty) {
      return summary['reason'].toString();
    }
    return 'Left a message.';
  }

  String get _durationLabel {
    final s = (_e['duration_s'] as num?)?.toInt() ?? 0;
    if (s <= 0) return '';
    final m = s ~/ 60, sec = s % 60;
    return '${m}:${sec.toString().padLeft(2, '0')}';
  }

  Future<void> _togglePlay() async {
    if (_playing) {
      await _player.stop();
      if (mounted) setState(() => _playing = false);
      return;
    }
    if (widget.sessionId.isEmpty) return;
    setState(() => _loadingAudio = true);
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      // Cache-first: a voicemail recording never changes, so once fetched we
      // keep the bytes in the per-account media cache and replay locally instead
      // of re-downloading on every tap / chat reopen.
      final cacheKey = _cacheKey;
      Uint8List? bytes = await MediaService.cachedBlob(cacheKey);
      final fromCache = bytes != null && bytes.isNotEmpty;
      Analytics.capture('voicemail_cache', {
        'hit': fromCache, 'stage': 'play', 'lane': 'receptionist', 'session_id': widget.sessionId,
      });
      if (!fromCache) {
        final url = 'https://$kSignalingHost/api/receptionist/recording?sid=${widget.sessionId}';
        final r = await ApiAuth.getBytes(url);
        if (r.statusCode != 200 || r.bodyBytes.isEmpty) {
          Analytics.capture('ava_recept_playback', {
            'session_id': widget.sessionId, 'ok': false, 'cached': false,
            'status': r.statusCode,
            'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
          });
          if (mounted) setState(() => _loadingAudio = false);
          return;
        }
        bytes = r.bodyBytes;
        await MediaService.writeBlob(cacheKey, bytes); // best-effort
      }
      _player.onPlayerComplete.listen((_) {
        if (mounted) setState(() => _playing = false);
      });
      await _player.play(BytesSource(bytes, mimeType: 'audio/wav'));
      // Playback latency, split by cache vs network — the signal behind "the
      // message took too long to play". cached=true should be near-instant.
      Analytics.capture('ava_recept_playback', {
        'session_id': widget.sessionId, 'ok': true, 'cached': fromCache,
        'bytes': bytes.length,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      if (mounted) setState(() { _loadingAudio = false; _playing = true; });
    } catch (_) {
      Analytics.capture('ava_recept_playback', {
        'session_id': widget.sessionId, 'ok': false, 'cached': false,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      if (mounted) setState(() => _loadingAudio = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final transcript = (_e['transcript'] ?? '').toString().trim();
    final hasRec = _e['has_recording'] == true || (_e['recording_url'] ?? '').toString().isNotEmpty;
    final dur = _durationLabel;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.phone_callback, size: 18, color: AD.bubbleInBg),
        const SizedBox(width: 6),
        Flexible(child: Text('$_caller called', style: ADText.rowName(c: AD.bubbleInInk))),
      ]),
      const SizedBox(height: 2),
      Text('Ava took a message', style: ADText.sectionLabel(c: AD.bubbleInMeta)),
      // Caller's phone number — always shown when present, even if Ava also
      // captured a name, so the owner can identify/return the call.
      if (_phone.isNotEmpty) ...[
        const SizedBox(height: 4),
        Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.phone, size: 13, color: AD.bubbleInMeta),
          const SizedBox(width: 5),
          Flexible(child: Text(formatTelDisplay(_phone),
              style: ADText.bubbleMeta(c: AD.bubbleInMeta))),
        ]),
      ],
      const SizedBox(height: 6),
      Text(_reason, style: ADText.bubbleBody(c: AD.bubbleInInk)),
      const SizedBox(height: 8),
      // Unknown caller → offer to save them as a contact right from the card.
      if (_phone.isNotEmpty && !_saved) ...[
        GestureDetector(
          onTap: _save,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: AD.mediaPlaceholderBg,
              borderRadius: BorderRadius.circular(100),
              border: Border.all(color: AD.bubbleInInk, width: 2),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.person_add_alt, size: 15, color: AD.bubbleInInk),
              const SizedBox(width: 5),
              Text('Save contact', style: ADText.bubbleMeta(c: AD.bubbleInMeta)),
            ]),
          ),
        ),
        const SizedBox(height: 8),
      ],
      Row(mainAxisSize: MainAxisSize.min, children: [
        if (hasRec)
          GestureDetector(
            onTap: _loadingAudio ? null : _togglePlay,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: AD.mediaPlaceholderBg,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: AD.bubbleInInk, width: 2),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _loadingAudio
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(_playing ? Icons.stop : Icons.play_arrow, size: 16, color: AD.bubbleInInk),
                const SizedBox(width: 5),
                Text(_playing ? 'Stop' : 'Play recording', style: ADText.bubbleMeta(c: AD.bubbleInMeta)),
              ]),
            ),
          ),
        if (hasRec && dur.isNotEmpty) ...[
          const SizedBox(width: 8),
          Text('⏱ $dur', style: ADText.bubbleMeta(c: AD.bubbleInMeta)),
        ],
        if (hasRec) ...[
          const SizedBox(width: 8),
          GestureDetector(
            onTap: _sharing ? null : _shareRecording,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: AD.mediaPlaceholderBg,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: AD.bubbleInInk, width: 2),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _sharing
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(Icons.ios_share, size: 15, color: AD.bubbleInInk),
                const SizedBox(width: 4),
                Text('Share', style: ADText.bubbleMeta(c: AD.bubbleInMeta)),
              ]),
            ),
          ),
        ],
      ]),
      if (transcript.isNotEmpty) ...[
        const SizedBox(height: 8),
        GestureDetector(
          onTap: () => setState(() => _expanded = !_expanded),
          child: Text(_expanded ? 'Hide transcript' : 'Show transcript',
              style: ADText.bubbleMeta(c: AD.iconSearch)),
        ),
        if (_expanded) ...[
          const SizedBox(height: 4),
          Text(transcript, style: ADText.bubbleBody(c: AD.bubbleInMeta)),
        ],
      ],
    ]);
  }
}

/// Phase 4 (ABLY-R2): one active floating-emoji burst animation.
class _BurstFx {
  final int id;
  final String emoji;
  const _BurstFx({required this.id, required this.emoji});
}

// ─────────────────────────────────────────────────────────────────────────────
// [VOICE-REC-1] Recording-bar chrome (owner report 2026-07-16, pic 5).
// ─────────────────────────────────────────────────────────────────────────────

/// A red dot that pulses while the recorder is live and holds steady while
/// paused. Small, but it is the ambient "this is running" signal that the old
/// bar's static text couldn't give — a still icon reads the same whether the
/// mic is hot or the recorder has quietly fallen over.
class _RecordingDot extends StatefulWidget {
  const _RecordingDot({required this.active});
  final bool active;

  @override
  State<_RecordingDot> createState() => _RecordingDotState();
}

class _RecordingDotState extends State<_RecordingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) {
      return const _Dot(opacity: 0.45);
    }
    return FadeTransition(
      opacity: Tween<double>(begin: 1.0, end: 0.25).animate(_c),
      child: const _Dot(opacity: 1),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.opacity});
  final double opacity;

  @override
  Widget build(BuildContext context) => Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(
          color: AD.danger.withValues(alpha: opacity),
          shape: BoxShape.circle,
        ),
      );
}

// [NOANSWER-LEAVE-NOTE-1] The live recording waveform moved to the shared
// `voice_note_waveform.dart` (LiveWaveform) so the call "leave a voice note"
// card draws the identical waveform from ONE definition. Usage above updated.
