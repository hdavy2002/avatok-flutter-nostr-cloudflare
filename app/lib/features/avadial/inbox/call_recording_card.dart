import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/analytics.dart';
import '../../../core/audio_playback_service.dart';
import '../../../core/avatar.dart';
import '../../../core/call_recording/call_recording_api.dart';
import '../../../core/call_recording/call_recording_store.dart';
import '../../../core/profile_store.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../identity/identity.dart';
import '../avadial_channel.dart';
import '../avadial_theme.dart';
import 'call_recording_detail_screen.dart';
import 'inbox_api.dart';
import 'inbox_heard_store.dart';

/// [CALLREC-UI-1] The Inbox card for one call recording.
///
/// Spec: `Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md` §5.2 — overlapping
/// avatar pair (you + the peer) → title, or `Call with <peer>` when untitled →
/// a small green `Call between {peer} and you` → date · time · duration · size.
///
/// Lives in its OWN file, entered through [buildCallRecordingCard], for exactly
/// the reason `buildCampaignCard` does: `inbox_thread_screen.dart` is a large,
/// shared file and the render branch there has to stay a three-line delegation
/// rather than another 200-line card class.
///
/// There is deliberately NO transcript, NO summary and NO "summarize" affordance
/// anywhere in this widget — the owner removed all AI from this feature in rev 11
/// of the spec. If a future reader is tempted to add one, that is a product
/// decision, not a gap.
///
/// [CALLREC-UX-1] GESTURE MODEL — deliberately the SAME as `_VoicemailCard`
/// (inbox_thread_screen.dart), because a user trained on voicemails brings that
/// training here:
///   • tap the play icon  → plays INLINE on the card (it used to be a purely
///     decorative glyph: the whole card was one GestureDetector, so tapping the
///     green play button pushed a screen instead of making a sound)
///   • long-press the card → the bottom-sheet menu
///   • tap the card BODY   → the detail screen, which is where title/description
///     are edited. Long-press alone would hide that, so the body tap is kept.
/// The play icon's own GestureDetector is nested INSIDE the card's, so the
/// innermost recognizer wins the tap and the card tap never double-fires; the
/// icon declares no long-press, so a long-press anywhere (icon included) falls
/// through to the card's menu.
Widget buildCallRecordingCard(
  BuildContext context,
  InboxCard card, {
  VoidCallback? onDeleted,
}) =>
    _CallRecordingCard(card: card, onDeleted: onDeleted);

class _CallRecordingCard extends StatefulWidget {
  const _CallRecordingCard({required this.card, this.onDeleted});
  final InboxCard card;

  /// Called once the recording is really gone (menu → Delete, or Delete on the
  /// detail screen), so the thread can drop the row without a full refetch.
  final VoidCallback? onDeleted;

  @override
  State<_CallRecordingCard> createState() => _CallRecordingCardState();
}

class _CallRecordingCardState extends State<_CallRecordingCard> {
  /// My own display name + photo, for the near half of the avatar pair. Loaded
  /// once; a failure just leaves the initials avatar, never an error state.
  String _myName = '';
  String _myAvatar = '';

  /// Inline-playback state, mirroring `_VoicemailCard`: a spinner while the
  /// bytes are being found, and an honest one-liner if they cannot be.
  bool _loading = false;
  String? _error;

  InboxCard get _c => widget.card;

  @override
  void initState() {
    super.initState();
    _loadMe();
  }

  Future<void> _loadMe() async {
    try {
      final p = await ProfileStore().load();
      if (!mounted) return;
      setState(() {
        _myName = p.displayName;
        _myAvatar = p.avatarUrl;
      });
    } catch (_) {/* initials fallback */}
  }

  String get _peerName {
    final n = _c.recPeerName.trim();
    if (n.isNotEmpty) return n;
    final c = (_c.callerName ?? '').trim();
    return c.isEmpty ? 'Unknown' : c;
  }

  /// The user's own title when they typed one; otherwise the same fallback the
  /// local model uses (`CallRecording.displayTitle`) so the card reads the same
  /// whether it renders from the server row or the local drift row.
  String get _title {
    final t = _c.recTitle.trim();
    if (t.isNotEmpty) return t;
    return 'Call with $_peerName';
  }

  /// `started_at` is epoch MILLISECONDS (unlike `Messages.createdAt`, which is
  /// seconds) — see `CallRecording.startedAt`. Falls back to the row's own
  /// `created_at` when the envelope is missing it.
  DateTime get _startedAt {
    final ms = _c.recStartedAtMs > 0 ? _c.recStartedAtMs : _c.createdAtMs;
    return DateTime.fromMillisecondsSinceEpoch(ms <= 0 ? 0 : ms);
  }

  /// Same derivation as `CallRecordingDetailScreen._callId` — the envelope's
  /// `call_id`, falling back to stripping the `callrec:` prefix off `client_id`
  /// for a row whose body failed to parse.
  String get _callId => callRecIdOf(_c);

  /// Namespaced `callrec:` so a recording can never collide with the `ibx:`
  /// voicemail tracks in the shared player — and IDENTICAL to the detail
  /// screen's, so play here and pause there act on one track, not two.
  String get _trackId => 'callrec:$_callId';

  String get _fileName => callRecFileName(
        title: _c.recTitle,
        peerName: _peerName,
        startedAt: _startedAt,
      );

  // ── playback ──────────────────────────────────────────────────────────────

  /// Inline play/pause on the card — the same shape as
  /// `_VoicemailCard._togglePlay`. Bytes come from the ONE shared local-first
  /// path ([CallRecordingStore.audioBytesAnywhere]).
  Future<void> _togglePlay() async {
    final cur = AudioPlaybackService.I.state.value;
    final isThis = AudioPlaybackService.I.isCurrent(_trackId);
    if (isThis && cur != null && cur.playing) {
      await AudioPlaybackService.I.pause();
      return;
    }
    if (isThis && cur != null && !cur.playing) {
      await AudioPlaybackService.I.resume();
      unawaited(markCallRecordingHeard(_c));
      return;
    }
    if (_callId.isEmpty) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    final t0 = DateTime.now().millisecondsSinceEpoch;
    final bytes = await CallRecordingStore.I.audioBytesAnywhere(_callId);
    if (!mounted) return;
    if (bytes == null || bytes.isEmpty) {
      setState(() {
        _loading = false;
        _error = 'Not on this phone and couldn’t be downloaded. Nothing is '
            'lost — try again when you are online.';
      });
      unawaited(Analytics.capture('callrec_playback', {
        'ok': false,
        'surface': 'inbox_card',
        'call_id': _callId,
        'rec_id': 'callrec:$_callId',
        // [CALLREC-TELEM-1] WHY it could not be played: `unavailable` (no local
        // copy and the server has no row — the recording is genuinely lost),
        // `download_failed` (the presign worked, the fetch did not — network),
        // or `error`. Without this every playback failure looked the same.
        'source': CallRecordingStore.I.lastAudioSource,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
        if (_c.recPeerUid.isNotEmpty) 'peer_uid': _c.recPeerUid,
      }));
      return;
    }
    try {
      await AudioPlaybackService.I.play(
        track: AudioTrack(
          trackId: _trackId,
          title: _title,
          subtitle: 'Call recording',
          originRoute: 'inbox:${_c.conv}',
        ),
        bytes: bytes,
      );
      unawaited(Analytics.capture('callrec_playback', {
        'ok': true,
        'surface': 'inbox_card',
        'call_id': _callId,
        'rec_id': 'callrec:$_callId',
        // `local` = on-device blob (disk); `remote` = fresh presign + download.
        // "Playback is slow" means two completely different things for the two,
        // and a `remote` on a recording made on THIS phone means the local blob
        // has been evicted — which is a real defect wearing a latency costume.
        'source': CallRecordingStore.I.lastAudioSource,
        'bytes': bytes.length,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
        if (_c.recPeerUid.isNotEmpty) 'peer_uid': _c.recPeerUid,
      }));
      // [CALLREC-UX-1] Defect 3: the unread dot used to be permanent because
      // NOTHING ever marked a recording heard. Mark it at exactly the moment a
      // voicemail does — on play, from whichever surface played it first.
      unawaited(markCallRecordingHeard(_c));
    } catch (e, st) {
      unawaited(Analytics.captureException(e, st,
          screen: 'inbox_callrec_card', handled: true, extra: {'stage': 'play'}));
      if (mounted) setState(() => _error = 'Could not play this recording.');
    }
    if (mounted) setState(() => _loading = false);
  }

  // ── navigation + menu ─────────────────────────────────────────────────────

  /// The detail screen pops `true` when it deleted the recording.
  Future<void> _openDetail() async {
    final deleted = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => CallRecordingDetailScreen(card: _c),
      ),
    );
    if (deleted == true && mounted) widget.onDeleted?.call();
  }

  Future<void> _delete() async {
    final gone = await callRecConfirmDelete(context, callId: _callId);
    if (gone && mounted) widget.onDeleted?.call();
  }

  /// Long-press menu — same idiom and row style as `_showCardMenu`
  /// (inbox_thread_screen.dart): grab handle, `isScrollControlled`, PhosphorIcon
  /// leading rows. Every item is wired to real code; there are no stubs.
  Future<void> _showMenu() async {
    final playing = AudioPlaybackService.I.isCurrent(_trackId) &&
        (AudioPlaybackService.I.state.value?.playing ?? false);
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AvaDialTheme.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: AvaDialTheme.border, width: 1),
        borderRadius: Msg.brSheetTop,
      ),
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: Msg.s2),
          Container(
            width: 40,
            height: 4,
            decoration: BoxDecoration(
                color: AvaDialTheme.textMute, borderRadius: Msg.brPill),
          ),
          const SizedBox(height: Msg.s1),
          _RecMenuRow(
            icon: playing
                ? PhosphorIcons.pauseCircle(PhosphorIconsStyle.bold)
                : PhosphorIcons.playCircle(PhosphorIconsStyle.bold),
            color: AD.bubbleOutPlay,
            label: playing ? 'Pause' : 'Play',
            onTap: () {
              Navigator.pop(sheetCtx);
              unawaited(_togglePlay());
            },
          ),
          _RecMenuRow(
            icon: PhosphorIcons.textAa(PhosphorIconsStyle.bold),
            color: AD.iconSearch,
            label: 'Edit title & description',
            onTap: () {
              Navigator.pop(sheetCtx);
              unawaited(_openDetail());
            },
          ),
          _RecMenuRow(
            icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
            color: AD.iconVideo,
            label: 'Share',
            onTap: () {
              Navigator.pop(sheetCtx);
              unawaited(callRecShare(context,
                  callId: _callId,
                  fileName: _fileName,
                  peerUid: _c.recPeerUid));
            },
          ),
          _RecMenuRow(
            icon: PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold),
            color: AD.iconSearch,
            label: 'Download',
            onTap: () {
              Navigator.pop(sheetCtx);
              unawaited(callRecDownload(context,
                  callId: _callId, fileName: _fileName));
            },
          ),
          _RecMenuRow(
            icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
            color: AD.danger,
            label: 'Delete',
            danger: true,
            onTap: () {
              Navigator.pop(sheetCtx);
              unawaited(_delete());
            },
          ),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final size = callRecBytesLabel(_c.recBytes);
    // Duration has moved onto the play row ("Play recording · 3:41"), so it is
    // deliberately NOT repeated here.
    final meta = <String>[
      callRecDateLabel(_startedAt),
      callRecTimeLabel(_startedAt),
      if (size.isNotEmpty) size,
    ].join(' · ');

    return GestureDetector(
      onTap: _openDetail,
      onLongPress: _showMenu,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          // The pale-mint bubble family, which is where this app already puts
          // "your own side of a conversation" — a recording IS the user's own
          // artefact of the call, so it belongs to the same visual family.
          color: AD.bubbleOutBg,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.bubbleOutPlay, width: 1.5),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CallRecAvatarPair(
              peerSeed: _c.recPeerUid.isEmpty ? _c.conv : _c.recPeerUid,
              peerName: _peerName,
              peerAvatar: _c.recPeerAvatar,
              meSeed: AccountScope.id ?? '',
              meName: _myName.isEmpty ? 'You' : _myName,
              meAvatar: _myAvatar,
            ),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(children: [
                    PhosphorIcon(
                      PhosphorIcons.microphone(PhosphorIconsStyle.fill),
                      size: 15,
                      color: AD.bubbleOutPlay,
                    ),
                    const SizedBox(width: Msg.s1),
                    Expanded(
                      child: Text(_title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: ADText.threadName(c: AD.bubbleOutInk)),
                    ),
                  ]),
                  const SizedBox(height: 2),
                  // The green consent line. Deliberately explicit about who is
                  // on the recording — this is the only place, once the call is
                  // over, that says both parties are on it.
                  Text('Call between $_peerName and you',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ADText.statCaption(c: AD.bubbleOutPlay)
                          .copyWith(fontWeight: FontWeight.w700)),
                  if (_c.recDescription.trim().isNotEmpty) ...[
                    const SizedBox(height: Msg.s1),
                    Text(_c.recDescription.trim(),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: ADText.preview(c: AD.bubbleOutMeta)),
                  ],
                  const SizedBox(height: Msg.s2),
                  // ---- inline player (was a decorative glyph until
                  // [CALLREC-UX-1]) — driven by the SHARED
                  // AudioPlaybackService, so playback survives leaving this
                  // thread and the detail screen shows the same play/pause
                  // state for the same track. ----
                  ValueListenableBuilder<PlaybackState?>(
                    valueListenable: AudioPlaybackService.I.state,
                    builder: (context, st, _) {
                      final isThis =
                          st != null && st.track.trackId == _trackId;
                      final playing = isThis && st.playing;
                      final live = (isThis ? st.duration : null) ??
                          AudioPlaybackService.I.knownDuration(_trackId);
                      final label = (live != null && live.inSeconds > 0)
                          ? callRecDurationLabel(live.inSeconds)
                          : callRecDurationLabel(_c.durationSec);
                      final playRow = Row(children: [
                        // Nested INSIDE the card's GestureDetector: the
                        // innermost recognizer wins the tap, so the play icon
                        // plays and does NOT also push the detail screen.
                        GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: _loading ? null : _togglePlay,
                          child: Padding(
                            padding: const EdgeInsets.only(
                                right: Msg.s2, top: 2, bottom: 2),
                            child: _loading
                                ? const SizedBox(
                                    width: 36,
                                    height: 36,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2.5,
                                        color: AD.bubbleOutPlay),
                                  )
                                // [CALLREC-PLAYER-UI-1] 26 → 40: the owner
                                // reported the play icon was too small to hit.
                                : PhosphorIcon(
                                    playing
                                        ? PhosphorIcons.pauseCircle(
                                            PhosphorIconsStyle.fill)
                                        : PhosphorIcons.playCircle(
                                            PhosphorIconsStyle.fill),
                                    size: 40,
                                    color: AD.bubbleOutPlay,
                                  ),
                          ),
                        ),
                        Expanded(
                          child: Text(
                            playing
                                ? 'Playing${label.isEmpty ? '' : ' · $label'}'
                                : (label.isEmpty
                                    ? 'Play recording'
                                    : 'Play recording · $label'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ADText.rowName(c: AD.bubbleOutPlay),
                          ),
                        ),
                      ]);
                      // [CALLREC-PLAYER-UI-1] The draggable timeline appears
                      // once THIS recording is the loaded track (playing or
                      // paused) — before that there is nothing to seek within.
                      return Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          playRow,
                          if (isThis)
                            CallRecSeekBar(
                              trackId: _trackId,
                              fallbackDurationS: _c.durationSec,
                              surface: 'inbox_card',
                            ),
                        ],
                      );
                    },
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: Msg.s1),
                    Text(_error!, style: ADText.statCaption(c: AD.danger)),
                  ],
                  const SizedBox(height: Msg.s1),
                  Text(meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ADText.statCaption(c: AD.bubbleOutMeta)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// [CALLREC-PLAYER-UI-1] Draggable timeline for a recording, shared by the
/// Inbox card and the detail screen so the two can never disagree about where
/// playback is. Owner request 2026-08-09: "I also need a timeline bar, so I can
/// drag the timeline and hear from the exact point in time."
///
/// Driven entirely by the shared [AudioPlaybackService]: position/duration come
/// off its state stream, and a drag ends in [AudioPlaybackService.seek]. While
/// the finger is down the local drag value wins over the stream so the thumb
/// doesn't fight the 1Hz position updates. The bar is interactive only while
/// THIS track is the loaded one — before first play there are no bytes loaded
/// to seek within, so it renders muted and inert rather than pretending.
class CallRecSeekBar extends StatefulWidget {
  const CallRecSeekBar({
    super.key,
    required this.trackId,
    required this.fallbackDurationS,
    required this.surface,
    this.activeColor = AD.bubbleOutPlay,
    this.inactiveColor = AD.bubbleOutMeta,
  });

  final String trackId;

  /// The envelope's `duration_s` — what the bar shows before the decoder has
  /// reported the clip's real length.
  final int fallbackDurationS;

  /// `inbox_card` | `callrec_detail` — the telemetry dimension.
  final String surface;

  final Color activeColor;
  final Color inactiveColor;

  @override
  State<CallRecSeekBar> createState() => _CallRecSeekBarState();
}

class _CallRecSeekBarState extends State<CallRecSeekBar> {
  /// Non-null while the user is dragging — wins over the stream position.
  double? _dragMs;

  static String _fmt(int ms) {
    final s = (ms / 1000).round();
    final h = s ~/ 3600;
    final m = (s % 3600) ~/ 60;
    final ss = (s % 60).toString().padLeft(2, '0');
    if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$ss';
    return '$m:$ss';
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<PlaybackState?>(
      valueListenable: AudioPlaybackService.I.state,
      builder: (context, st, _) {
        final isThis = st != null && st.track.trackId == widget.trackId;
        final durMs = ((isThis ? st.duration : null) ??
                    AudioPlaybackService.I.knownDuration(widget.trackId))
                ?.inMilliseconds ??
            widget.fallbackDurationS * 1000;
        if (durMs <= 0) return const SizedBox.shrink();
        final streamMs = isThis
            ? st.position.inMilliseconds
            : (AudioPlaybackService.I
                    .savedPosition(widget.trackId)
                    ?.inMilliseconds ??
                0);
        final posMs =
            (_dragMs ?? streamMs.toDouble()).clamp(0.0, durMs.toDouble());
        return Column(mainAxisSize: MainAxisSize.min, children: [
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              trackHeight: 3,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
              overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
              activeTrackColor: widget.activeColor,
              inactiveTrackColor: widget.inactiveColor,
              thumbColor: widget.activeColor,
              disabledActiveTrackColor: widget.inactiveColor,
              disabledInactiveTrackColor: widget.inactiveColor,
              disabledThumbColor: widget.inactiveColor,
              overlayColor: Colors.transparent,
            ),
            child: Slider(
              min: 0,
              max: durMs.toDouble(),
              value: posMs,
              onChanged: isThis ? (v) => setState(() => _dragMs = v) : null,
              onChangeEnd: isThis
                  ? (v) {
                      setState(() => _dragMs = null);
                      unawaited(AudioPlaybackService.I
                          .seek(Duration(milliseconds: v.round())));
                      unawaited(Analytics.capture('callrec_seek', {
                        'track_id': widget.trackId,
                        'surface': widget.surface,
                        'to_ms': v.round(),
                        'duration_ms': durMs,
                      }));
                    }
                  : null,
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Msg.s2),
            child: Row(children: [
              Text(_fmt(posMs.round()),
                  style: ADText.statCaption(c: widget.activeColor)),
              const Spacer(),
              Text(_fmt(durMs),
                  style: ADText.statCaption(c: widget.inactiveColor)),
            ]),
          ),
        ]);
      },
    );
  }
}

/// The overlapping "two people were on this" avatar pair: the peer behind, you
/// in front and slightly lower-right, each ringed so they read as two distinct
/// people rather than one clipped photo.
class CallRecAvatarPair extends StatelessWidget {
  const CallRecAvatarPair({
    super.key,
    required this.peerSeed,
    required this.peerName,
    required this.peerAvatar,
    required this.meSeed,
    required this.meName,
    required this.meAvatar,
    this.size = 34,
  });

  final String peerSeed;
  final String peerName;
  final String peerAvatar;
  final String meSeed;
  final String meName;
  final String meAvatar;
  final double size;

  @override
  Widget build(BuildContext context) {
    final overlap = size * 0.55;
    return SizedBox(
      width: size + overlap,
      height: size + overlap * 0.6,
      child: Stack(
        children: [
          Positioned(
            left: 0,
            top: 0,
            child: _ringed(
              Avatar(
                seed: peerSeed,
                name: peerName,
                size: size,
                avatarUrl: peerAvatar.isEmpty ? null : peerAvatar,
              ),
            ),
          ),
          Positioned(
            left: overlap,
            top: overlap * 0.6,
            child: _ringed(
              Avatar(
                seed: meSeed,
                name: meName,
                size: size,
                avatarUrl: meAvatar.isEmpty ? null : meAvatar,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _ringed(Widget child) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          // The pale bubble fill, not a bare white ring — the card underneath is
          // mint, and a white halo would read as a rendering artefact on it.
          border: Border.all(color: AD.bubbleOutBg, width: 2),
        ),
        child: child,
      );
}

// ── shared label helpers ─────────────────────────────────────────────────────
//
// Used by both the card and the detail screen, so the two can never disagree
// about how long a recording is or how big it is.

/// `m:ss` (or `h:mm:ss` past an hour). Empty for a zero/unknown duration, so a
/// caller can drop the segment entirely rather than printing "0:00".
String callRecDurationLabel(int seconds) {
  if (seconds <= 0) return '';
  final h = seconds ~/ 3600;
  final m = (seconds % 3600) ~/ 60;
  final s = seconds % 60;
  final ss = s.toString().padLeft(2, '0');
  if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$ss';
  return '$m:$ss';
}

/// Human file size. Deliberately decimal MB (not MiB) because that is the unit
/// the AvaStorage quota screens already speak in.
String callRecBytesLabel(int bytes) {
  if (bytes <= 0) return '';
  if (bytes < 1024) return '$bytes B';
  final kb = bytes / 1024;
  if (kb < 1024) return '${kb.toStringAsFixed(0)} KB';
  final mb = kb / 1024;
  if (mb < 1024) return '${mb.toStringAsFixed(mb < 10 ? 1 : 0)} MB';
  return '${(mb / 1024).toStringAsFixed(2)} GB';
}

const List<String> _kMonths = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// "16 Jul 2026". Empty for an unset timestamp.
String callRecDateLabel(DateTime dt) {
  if (dt.millisecondsSinceEpoch <= 0) return '';
  return '${dt.day} ${_kMonths[dt.month - 1]} ${dt.year}';
}

/// "14:32". Empty for an unset timestamp.
String callRecTimeLabel(DateTime dt) {
  if (dt.millisecondsSinceEpoch <= 0) return '';
  return '${dt.hour.toString().padLeft(2, '0')}:'
      '${dt.minute.toString().padLeft(2, '0')}';
}

// ── shared identity / actions ────────────────────────────────────────────────
//
// [CALLREC-UX-1] Play, share, download and delete are now reachable from BOTH
// the Inbox card's long-press menu and the detail screen. The implementations
// live here, once, so the two surfaces can never drift on what "Download"
// writes, what "Delete" removes, or whether a recording counts as heard.

/// The recording's primary key: the envelope's `call_id`, falling back to
/// stripping the `callrec:` prefix off `client_id` for a row whose body failed
/// to parse (which recovers the same id rather than leaving the UI inert).
String callRecIdOf(InboxCard card) {
  final id = card.recCallId.trim();
  if (id.isNotEmpty) return id;
  final cid = (card.clientId ?? '').trim();
  if (cid.startsWith('callrec:')) return cid.substring('callrec:'.length);
  return '';
}

/// "Call with Alice 2026-08-06.m4a" — the share/download filename, sanitized
/// against filesystem-illegal characters.
String callRecFileName({
  required String title,
  required String peerName,
  required DateTime startedAt,
}) {
  final base = (title.trim().isEmpty ? 'Call with $peerName' : title.trim())
      .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
  final date = startedAt.millisecondsSinceEpoch <= 0
      ? ''
      : ' ${startedAt.year}-${startedAt.month.toString().padLeft(2, '0')}-'
          '${startedAt.day.toString().padLeft(2, '0')}';
  return '$base$date.m4a';
}

/// [CALLREC-UX-1] Defect 3. `InboxHeardStore` is what clears the Inbox's orange
/// unread dot (`_unreadCount` in inbox_list_screen.dart counts cards with a
/// recording that are NOT in it) — and until this existed it was only ever
/// written by `_VoicemailCard`, so a call recording you made, opened and played
/// kept its "new" highlight forever.
///
/// Called on PLAY from both surfaces, exactly like the voicemail trigger
/// (`_VoicemailCard._markHeardOnce`), never on mere screen-open. Idempotent and
/// best-effort: a write failure just leaves the dot for next time, which is safe.
Future<void> markCallRecordingHeard(InboxCard card) async {
  try {
    if (await InboxHeardStore.I.isHeard(card.stableId)) return;
    await InboxHeardStore.I.markHeard(card.stableId);
    unawaited(Analytics.capture('callrec_heard_marked', {
      'conv_hash': card.conv.hashCode,
      'duration_s': card.durationSec,
      'call_id': callRecIdOf(card),
      'rec_id': 'callrec:${callRecIdOf(card)}',
      if (card.recPeerUid.isNotEmpty) 'peer_uid': card.recPeerUid,
    }));
  } catch (_) {/* the dot simply stays; nothing is lost */}
}

/// System share sheet with the audio file. The OS chooser covers WhatsApp,
/// Telegram, email and every other target — there is deliberately no per-app
/// share button.
Future<void> callRecShare(
  BuildContext context, {
  required String callId,
  required String fileName,
  String? peerUid,
}) async {
  // Captured BEFORE the first await: the widget that opened the menu may be
  // gone by the time the bytes land.
  final messenger = ScaffoldMessenger.of(context);
  final bytes = await CallRecordingStore.I.audioBytesAnywhere(callId);
  if (bytes == null || bytes.isEmpty) {
    // [CALLREC-TELEM-1] This branch reported NOTHING, so a share that failed
    // because the audio could not be loaded was invisible — it looked exactly
    // like a share the user never attempted.
    unawaited(Analytics.capture('callrec_shared', {
      'ok': false,
      'call_id': callId,
      'rec_id': 'callrec:$callId',
      'stage': 'load',
      'source': CallRecordingStore.I.lastAudioSource,
      if (peerUid != null && peerUid.isNotEmpty) 'peer_uid': peerUid,
    }));
    messenger.showSnackBar(const SnackBar(
        content: Text('Couldn’t load the recording to share.')));
    return;
  }
  try {
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}/$fileName');
    await f.writeAsBytes(bytes, flush: true);
    // `Share.shareXFiles` hands off to the OS chooser, which does NOT report
    // which app the user picked (and on Android below API 22 reports nothing at
    // all), so the share TARGET is deliberately not claimed here rather than
    // guessed. `bytes` is the useful dimension: it is what decides whether the
    // target app will accept the file.
    await Share.shareXFiles([XFile(f.path, mimeType: 'audio/mp4')],
        subject: fileName);
    unawaited(Analytics.capture('callrec_shared', {
      'ok': true,
      'call_id': callId,
      'rec_id': 'callrec:$callId',
      'stage': 'chooser_opened',
      'bytes': bytes.length,
      'source': CallRecordingStore.I.lastAudioSource,
      if (peerUid != null && peerUid.isNotEmpty) 'peer_uid': peerUid,
    }));
  } catch (e, st) {
    unawaited(Analytics.captureException(e, st,
        screen: 'callrec', handled: true, extra: {'stage': 'share', 'call_id': callId}));
    unawaited(Analytics.capture('callrec_shared', {
      'ok': false,
      'call_id': callId,
      'rec_id': 'callrec:$callId',
      'stage': 'chooser',
      'bytes': bytes.length,
      if (peerUid != null && peerUid.isNotEmpty) 'peer_uid': peerUid,
    }));
    messenger.showSnackBar(
        const SnackBar(content: Text('Couldn’t share the recording.')));
  }
}

/// Writes the audio into the public Downloads/AvaTok folder via the native
/// MediaStore bridge.
Future<void> callRecDownload(
  BuildContext context, {
  required String callId,
  required String fileName,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final bytes = await CallRecordingStore.I.audioBytesAnywhere(callId);
  if (bytes == null || bytes.isEmpty) {
    // [CALLREC-TELEM-1] Same silent branch as share — see the note there.
    unawaited(Analytics.capture('callrec_downloaded', {
      'ok': false,
      'call_id': callId,
      'rec_id': 'callrec:$callId',
      'stage': 'load',
      'source': CallRecordingStore.I.lastAudioSource,
    }));
    messenger.showSnackBar(const SnackBar(
        content: Text('Couldn’t load the recording to download.')));
    return;
  }
  try {
    final tmpDir = await getTemporaryDirectory();
    final tmp = File('${tmpDir.path}/$fileName');
    await tmp.writeAsBytes(bytes, flush: true);
    await AvaDialChannel.I.saveToDownloads(
      path: tmp.path,
      filename: fileName,
      mime: 'audio/mp4',
    );
    unawaited(Analytics.capture('callrec_downloaded', {
      'ok': true,
      'call_id': callId,
      'rec_id': 'callrec:$callId',
      'stage': 'saved',
      'bytes': bytes.length,
      'source': CallRecordingStore.I.lastAudioSource,
    }));
    messenger.showSnackBar(
        SnackBar(content: Text('Saved to Downloads/AvaTok/$fileName')));
  } catch (e, st) {
    unawaited(Analytics.captureException(e, st,
        screen: 'callrec', handled: true, extra: {'stage': 'download', 'call_id': callId}));
    unawaited(Analytics.capture('callrec_downloaded', {
      'ok': false,
      'call_id': callId,
      'rec_id': 'callrec:$callId',
      'stage': 'mediastore',
      'bytes': bytes.length,
    }));
    messenger.showSnackBar(
        const SnackBar(content: Text('Couldn’t save the recording.')));
  }
}

/// Confirms, then deletes. Returns true ONLY when the recording is really gone,
/// so a caller can drop its row / pop itself.
///
/// With a local drift row the store deletes server-side FIRST, then the blob and
/// the row, so a server failure can't strand a quota-consuming R2 object with no
/// local row to retry from. Without one (recorded on another device) the API is
/// the only thing to call, and its failure is a real failure.
Future<bool> callRecConfirmDelete(
  BuildContext context, {
  required String callId,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final ok = await showDialog<bool>(
    context: context,
    builder: (d) => AlertDialog(
      backgroundColor: AvaDialTheme.surface2,
      title: Text('Delete this recording?',
          style: ADText.threadName(c: AvaDialTheme.text)),
      content: Text(
        'The audio is removed from this phone and from your AvaStorage, and '
        'the space it used is freed. This cannot be undone.',
        style: ADText.preview(c: AvaDialTheme.textSoft),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(d, false),
            child:
                Text('Cancel', style: ADText.preview(c: AvaDialTheme.textSoft))),
        TextButton(
            onPressed: () => Navigator.pop(d, true),
            child: Text('Delete', style: ADText.preview(c: AD.danger))),
      ],
    ),
  );
  if (ok != true || callId.isEmpty) return false;
  try {
    final local = await CallRecordingStore.I.byCallId(callId);
    if (local != null) {
      await CallRecordingStore.I.delete(callId);
    } else if (!await CallRecordingApi.delete(callId)) {
      // [CALLREC-TELEM-1] A refused delete used to report nothing at all, so a
      // user repeatedly failing to remove a recording — which also means their
      // storage quota is never released — produced no signal whatsoever.
      unawaited(Analytics.capture('callrec_deleted', {
        'ok': false,
        'call_id': callId,
        'rec_id': 'callrec:$callId',
        'surface': 'inbox_card',
        'stage': 'server',
        'had_local_row': false,
      }));
      messenger.showSnackBar(const SnackBar(
          content: Text('Couldn’t delete the recording. Nothing was '
              'removed — try again.')));
      return false;
    }
  } catch (e, st) {
    unawaited(Analytics.captureException(e, st,
        screen: 'callrec', handled: true, extra: {'stage': 'delete', 'call_id': callId}));
    unawaited(Analytics.capture('callrec_deleted', {
      'ok': false,
      'call_id': callId,
      'rec_id': 'callrec:$callId',
      'surface': 'inbox_card',
      'stage': 'exception',
    }));
    messenger.showSnackBar(
        const SnackBar(content: Text('Couldn’t delete the recording.')));
    return false;
  }
  unawaited(Analytics.capture('callrec_deleted', {
    'ok': true,
    'call_id': callId,
    'rec_id': 'callrec:$callId',
    'surface': 'inbox_card',
  }));
  return true;
}

/// One long-press menu row — the same leading/label/onTap shape as
/// `_CardMenuRow` in inbox_thread_screen.dart, kept local so the recording card
/// does not have to reach into that (large, shared) file's private widgets.
class _RecMenuRow extends StatelessWidget {
  const _RecMenuRow({
    required this.icon,
    required this.color,
    required this.label,
    required this.onTap,
    this.danger = false,
  });

  final IconData icon;
  final Color color;
  final String label;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) => ListTile(
        leading: PhosphorIcon(icon, color: color),
        title: Text(label,
            style: ADText.rowName(c: danger ? AD.danger : AvaDialTheme.text)),
        onTap: onTap,
      );
}
