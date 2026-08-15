part of '../chat_thread.dart';


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
  // [MEDIA-INSTANT-1] Epoch ms when the user's PICK action started (picker
  // invoked / record-stop tapped) — the anchor for `ms_pick_to_bubble`
  // telemetry. Null when the send didn't originate from a picker (gif/sticker/
  // library-attach), in which case that metric is simply omitted.
  int? pickStartedMs;
  // [MEDIA-INSTANT-1a] True while a video bubble's background 720p transcode
  // is still running (upload hasn't started yet) — lets the bubble show a
  // "processing" label instead of a bare spinner.
  bool transcoding = false;
  // [MEDIA-OUTBOX-DURABLE-1] This attachment's row key in `MediaOutbox` (the
  // durable upload-leg ledger) — set at bubble creation, before encryption/
  // upload starts. Null for non-media bubbles.
  String? mediaClientId;
  // [MEDIA-RETRY-KIND-1] The EXACT mime + filename the attachment was sent
  // with, captured at send time (before `media` exists) so a retry — manual
  // or auto — re-uploads with the identical kind/mime/name instead of the old
  // generic 'application/octet-stream' fallback that could silently reclass a
  // failed voice note as a generic file.
  String? pendingMime;
  String? pendingFilename;
  // [MEDIA-RETRY-KIND-1] Non-null once a retry has been attempted; feeds the
  // `attempt` property on chat_media_retry_* telemetry.
  int? retryAttempt;
  _Msg(this.id, this.me, this.text, this.time,
      {this.ts = 0, this.evId, this.senderLabel, this.senderPub, this.reaction, this.media, this.pendingKind, this.mediaCaption = '', this.localBytes,
       this.uploading = false, this.failed = false, this.sent = false, this.replyTo, this.edited = false,
       this.starred = false, this.forwarded = false, this.hidden = false, this.expireAt, this.special, this.extra,
       this.aiLocal = false, Map<String, int>? readBy, Map<String, int>? deliveredTo, this.system = false})
      : readBy = readBy ?? {}, deliveredTo = deliveredTo ?? {};

  /// Stable identity for rows that do not have a transport event id.
  ///
  /// Private Ava prompts and AI media job cards are deliberately local-only, so
  /// [evId] is null. The warm snapshot and disk cache are both restored on an
  /// open; without an identity those rows were appended twice on every reopen.
  String get cacheIdentity {
    final transportId = evId;
    if (transportId != null && transportId.isNotEmpty) {
      return 'event:$transportId';
    }
    if (special == 'ai_job') {
      final jobId = (extra?['job_id'] ?? '').toString();
      if (jobId.isNotEmpty) return 'ai_job:$jobId';
    }
    return 'local:${jsonEncode(<Object?>[
      me,
      ts,
      special ?? '',
      media?.id ?? '',
      text,
    ])}';
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

/// Phase 4 (ABLY-R2): one active floating-emoji burst animation.
class _BurstFx {
  final int id;
  final String emoji;
  const _BurstFx({required this.id, required this.emoji});
}

// [NOANSWER-LEAVE-NOTE-1] The live recording waveform moved to the shared
// `voice_note_waveform.dart` (LiveWaveform) so the call "leave a voice note"
// card draws the identical waveform from ONE definition. Usage above updated.

// [CHAT-MENTIONS-1] One row in the composer's "@" picker. Immutable value type:
// `token` is the exact string inserted into the input box, everything else is
// display-only. `kind` is what telemetry reports, so keep the values stable
// ('ava_private' | 'ava_public' | 'member' | 'peer').
class _MentionOption {
  final String token;      // '@ava', '#ava', '@Sonal'
  final String label;      // human name, may contain spaces
  final String? trailing;  // 'Private' / 'Public' badge, Ava rows only
  final String? subtitle;  // one-line explanation, Ava rows only
  final String? uid;       // group member uid, when known
  final String avatarUrl;
  final String kind;

  const _MentionOption({
    required this.token,
    required this.label,
    required this.kind,
    this.trailing,
    this.subtitle,
    this.uid,
    this.avatarUrl = '',
  });
}
