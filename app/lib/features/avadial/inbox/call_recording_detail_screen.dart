import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/audio_playback_service.dart';
import '../../../core/call_recording/call_recording_api.dart';
import '../../../core/call_recording/call_recording_model.dart';
import '../../../core/call_recording/call_recording_store.dart';
import '../../../core/profile_store.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../identity/identity.dart';
import '../avadial_theme.dart';
import 'call_recording_card.dart';
import 'inbox_api.dart';

/// [CALLREC-UI-1] One call recording, full screen: play, rename, describe,
/// share, download, delete.
///
/// Spec: `Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md` §5.2. There is NO
/// transcript, NO AI summary, NO summary email and NO "summarize" button here —
/// all four were removed by the owner in rev 11. Adding one back is a product
/// decision, not a missing feature.
///
/// TWO SOURCES, ONE SCREEN. The Inbox row ([card]) is the server's copy and is
/// what got us here; [CallRecordingStore] holds the LOCAL row and the audio
/// blob. The local row wins for title/description (the store writes locally
/// first so an edit survives a failed network call), and the local blob wins for
/// playback. When a recording was made on ANOTHER of the user's devices there is
/// no local row at all — the screen still works, falling back to a fresh
/// presigned read, and says so honestly if even that fails.
class CallRecordingDetailScreen extends StatefulWidget {
  const CallRecordingDetailScreen({super.key, required this.card});

  final InboxCard card;

  @override
  State<CallRecordingDetailScreen> createState() =>
      _CallRecordingDetailScreenState();
}

class _CallRecordingDetailScreenState extends State<CallRecordingDetailScreen> {
  final TextEditingController _title = TextEditingController();
  final TextEditingController _desc = TextEditingController();

  CallRecording? _local;
  bool _loading = false;
  bool _saving = false;
  bool _dirty = false;
  String? _error;

  String _myName = '';
  String _myAvatar = '';

  InboxCard get _c => widget.card;

  /// The envelope's `call_id` is the primary key everywhere (local drift PK,
  /// wire, `client_id = callrec:<callId>`) — see [callRecIdOf], which the Inbox
  /// card shares so the two surfaces can never resolve to different ids.
  String get _callId => callRecIdOf(_c);

  String get _peerName {
    final n = _c.recPeerName.trim();
    if (n.isNotEmpty) return n;
    final c = (_c.callerName ?? '').trim();
    return c.isEmpty ? 'Unknown' : c;
  }

  /// Namespaced `callrec:` so a recording can never collide with the `ibx:`
  /// voicemail tracks or a chat voice note in the shared player.
  String get _trackId => 'callrec:$_callId';

  int get _durationS =>
      (_local?.durationS ?? 0) > 0 ? _local!.durationS : _c.durationSec;

  int get _bytes => (_local?.bytes ?? 0) > 0 ? _local!.bytes : _c.recBytes;

  DateTime get _startedAt {
    final ms = (_local?.startedAt ?? 0) > 0
        ? _local!.startedAt
        : (_c.recStartedAtMs > 0 ? _c.recStartedAtMs : _c.createdAtMs);
    return DateTime.fromMillisecondsSinceEpoch(ms <= 0 ? 0 : ms);
  }

  @override
  void initState() {
    super.initState();
    _title.text = _c.recTitle;
    _desc.text = _c.recDescription;
    _loadLocal();
    _loadMe();
  }

  @override
  void dispose() {
    _title.dispose();
    _desc.dispose();
    super.dispose();
  }

  Future<void> _loadLocal() async {
    if (_callId.isEmpty) return;
    try {
      final rec = await CallRecordingStore.I.byCallId(_callId);
      if (!mounted || rec == null) return;
      setState(() {
        _local = rec;
        // The local row is authoritative for user-typed meta — but only
        // overwrite a field the user has NOT already started editing on this
        // screen, or an async load would eat their keystrokes.
        if (!_dirty) {
          if (rec.title.isNotEmpty) _title.text = rec.title;
          if (rec.description.isNotEmpty) _desc.text = rec.description;
        }
      });
    } catch (_) {/* server row is enough to render */}
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

  // ── audio ─────────────────────────────────────────────────────────────────

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
        _error = 'This recording isn’t on this phone and could not be '
            'downloaded. Nothing has been lost — try again when you are online.';
      });
      unawaited(Analytics.capture('callrec_playback', {
        'ok': false,
        // [CALLREC-TELEM-1] `surface` was missing on this branch only, so a
        // failed play from the detail screen was indistinguishable from one on
        // the Inbox card — the two have different loading paths.
        'surface': 'callrec_detail',
        'call_id': _callId,
        'rec_id': 'callrec:$_callId',
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
          title: _title.text.trim().isEmpty
              ? 'Call with $_peerName'
              : _title.text.trim(),
          subtitle: 'Call recording',
          originRoute: 'inbox:${_c.conv}',
        ),
        bytes: bytes,
      );
      unawaited(Analytics.capture('callrec_playback', {
        'ok': true,
        'surface': 'callrec_detail',
        'call_id': _callId,
        'rec_id': 'callrec:$_callId',
        'source': CallRecordingStore.I.lastAudioSource,
        'bytes': bytes.length,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
        if (_c.recPeerUid.isNotEmpty) 'peer_uid': _c.recPeerUid,
      }));
      // [CALLREC-UX-1] Defect 3 — either surface can be where the user first
      // hears this, so both clear the Inbox unread dot.
      unawaited(markCallRecordingHeard(_c));
    } catch (e, st) {
      unawaited(Analytics.captureException(e, st,
          screen: 'callrec_detail', handled: true, extra: {'stage': 'play'}));
      if (mounted) setState(() => _error = 'Could not play this recording.');
    }
    if (mounted) setState(() => _loading = false);
  }

  // ── meta ──────────────────────────────────────────────────────────────────

  Future<void> _save() async {
    if (_callId.isEmpty || _saving) return;
    setState(() => _saving = true);
    final title = _title.text.trim();
    final desc = _desc.text.trim();
    try {
      var ok = true;
      if (_local != null) {
        // Local-first: the store writes the drift row, then best-effort patches
        // the Inbox row, and re-pushes after a later upload if needed. The local
        // write is the one that matters, so this path always "succeeds".
        await CallRecordingStore.I
            .updateMeta(_callId, title: title, description: desc);
      } else {
        // No local row (the recording was made on another device), so the
        // server IS the only copy of this text — a failed patch is a real
        // failure and must not be reported as "Saved".
        ok = await CallRecordingApi.updateMeta(_callId,
            title: title, description: desc);
      }
      if (!mounted) return;
      setState(() {
        _saving = false;
        _dirty = !ok;
      });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(ok ? 'Saved' : 'Couldn’t save. Try again.')));
    } catch (e, st) {
      unawaited(Analytics.captureException(e, st,
          screen: 'callrec_detail', handled: true, extra: {'stage': 'save_meta'}));
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Couldn’t save. Try again.')));
    }
  }

  // ── share / download / delete ────────────────────────────────────────────

  /// The live edit box wins over the saved title, so sharing right after typing
  /// a name uses the name the user is looking at.
  String get _fileName => callRecFileName(
        title: _title.text,
        peerName: _peerName,
        startedAt: _startedAt,
      );

  // [CALLREC-UX-1] Share / Download / Delete moved into call_recording_card.dart
  // as shared helpers, because the Inbox card's long-press menu now offers the
  // same three actions. One implementation, two entry points.

  Future<void> _share() =>
      callRecShare(context,
          callId: _callId, fileName: _fileName, peerUid: _c.recPeerUid);

  Future<void> _download() =>
      callRecDownload(context, callId: _callId, fileName: _fileName);

  Future<void> _delete() async {
    final gone = await callRecConfirmDelete(context, callId: _callId);
    if (gone && mounted) Navigator.of(context).pop(true);
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final meta = <String>[
      callRecDateLabel(_startedAt),
      callRecTimeLabel(_startedAt),
      if (callRecDurationLabel(_durationS).isNotEmpty)
        callRecDurationLabel(_durationS),
      if (callRecBytesLabel(_bytes).isNotEmpty) callRecBytesLabel(_bytes),
    ].join(' · ');

    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, Msg.s6),
          children: [
            Row(children: [
              AdBackButton(onTap: () => Navigator.of(context).pop()),
              const SizedBox(width: Msg.s3),
              Expanded(
                child: Text('Call recording',
                    style: AvaDialTheme.title(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis),
              ),
            ]),
            const SizedBox(height: Msg.s5),
            Center(
              child: CallRecAvatarPair(
                peerSeed: _c.recPeerUid.isEmpty ? _c.conv : _c.recPeerUid,
                peerName: _peerName,
                peerAvatar: _c.recPeerAvatar,
                meSeed: AccountScope.id ?? '',
                meName: _myName.isEmpty ? 'You' : _myName,
                meAvatar: _myAvatar,
                size: 64,
              ),
            ),
            const SizedBox(height: Msg.s3),
            Center(
              child: Text('Call between $_peerName and you',
                  style: ADText.statCaption(c: AD.bubbleOutPlay)
                      .copyWith(fontWeight: FontWeight.w700)),
            ),
            const SizedBox(height: Msg.s1),
            Center(
              child: Text(meta,
                  textAlign: TextAlign.center,
                  style: ADText.statCaption(c: AvaDialTheme.textMute)),
            ),
            const SizedBox(height: Msg.s5),

            // ---- player ----
            ValueListenableBuilder<PlaybackState?>(
              valueListenable: AudioPlaybackService.I.state,
              builder: (context, st, _) {
                final isThis = st != null && st.track.trackId == _trackId;
                final playing = isThis && st.playing;
                final live = (isThis ? st.duration : null) ??
                    AudioPlaybackService.I.knownDuration(_trackId);
                final label = (live != null && live.inSeconds > 0)
                    ? callRecDurationLabel(live.inSeconds)
                    : callRecDurationLabel(_durationS);
                return Container(
                  padding: const EdgeInsets.all(Msg.s4),
                  decoration: BoxDecoration(
                    color: AvaDialTheme.surface,
                    borderRadius: BorderRadius.circular(AD.rListCard),
                    border: Border.all(color: AvaDialTheme.border, width: 1),
                  ),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    // The play row is the tap target; the seek bar below owns
                    // its own drags, so it deliberately sits OUTSIDE this
                    // GestureDetector — a drag on the timeline must never
                    // double as a play/pause tap.
                    GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: _loading ? null : _togglePlay,
                      child: Row(children: [
                        _loading
                            ? const SizedBox(
                                width: 48,
                                height: 48,
                                child: CircularProgressIndicator(
                                    strokeWidth: 3, color: AD.bubbleOutPlay))
                            // [CALLREC-PLAYER-UI-1] 34 → 56: owner report, the
                            // play control was too small.
                            : PhosphorIcon(
                                playing
                                    ? PhosphorIcons.pauseCircle(
                                        PhosphorIconsStyle.fill)
                                    : PhosphorIcons.playCircle(
                                        PhosphorIconsStyle.fill),
                                size: 56,
                                color: AD.bubbleOutPlay,
                              ),
                        const SizedBox(width: Msg.s3),
                        Expanded(
                          child: Text(
                            playing
                                ? 'Playing${label.isEmpty ? '' : ' · $label'}'
                                : (label.isEmpty
                                    ? 'Play recording'
                                    : 'Play recording · $label'),
                            style: ADText.rowName(c: AvaDialTheme.text),
                          ),
                        ),
                      ]),
                    ),
                    // [CALLREC-PLAYER-UI-1] Draggable timeline (shared widget
                    // with the Inbox card). Interactive once this recording is
                    // the loaded track; muted before that.
                    CallRecSeekBar(
                      trackId: _trackId,
                      fallbackDurationS: _durationS,
                      surface: 'callrec_detail',
                    ),
                  ]),
                );
              },
            ),
            if (_error != null) ...[
              const SizedBox(height: Msg.s2),
              Text(_error!, style: ADText.preview(c: AD.danger)),
            ],
            if (_local != null && !_local!.isUploaded) ...[
              const SizedBox(height: Msg.s2),
              // Honest, not alarming: the file is safe on this phone; it is the
              // BACKUP that hasn't happened yet.
              ValueListenableBuilder<Map<String, CallRecordingUploadIssue>>(
                valueListenable: CallRecordingStore.I.uploadIssues,
                builder: (_, issues, __) => Text(
                  issues[_callId]?.message ??
                      'Not backed up yet — saved on this phone.',
                  style: ADText.statCaption(c: AD.unreadAccent),
                ),
              ),
            ],
            const SizedBox(height: Msg.s5),

            // ---- editable title + description ----
            Text('Title', style: ADText.sectionLabel(c: AvaDialTheme.textMute)),
            const SizedBox(height: Msg.s1),
            _field(_title, hint: 'Call with $_peerName', maxLines: 1),
            const SizedBox(height: Msg.s4),
            Text('Description',
                style: ADText.sectionLabel(c: AvaDialTheme.textMute)),
            const SizedBox(height: Msg.s1),
            _field(_desc, hint: 'What was this call about?', maxLines: 4),
            const SizedBox(height: Msg.s3),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: (_saving || !_dirty) ? null : _save,
                icon: PhosphorIcon(
                    PhosphorIcons.floppyDisk(PhosphorIconsStyle.regular),
                    size: 18,
                    color: _dirty ? AvaDialTheme.accent : AvaDialTheme.textMute),
                label: Text(_saving ? 'Saving…' : 'Save',
                    style: ADText.rowName(
                        c: _dirty ? AvaDialTheme.accent : AvaDialTheme.textMute)),
              ),
            ),
            const SizedBox(height: Msg.s4),

            // ---- actions ----
            _action(
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.regular),
              label: 'Share',
              onTap: _share,
            ),
            _action(
              icon: PhosphorIcons.downloadSimple(PhosphorIconsStyle.regular),
              label: 'Download',
              onTap: _download,
            ),
            _action(
              icon: PhosphorIcons.trash(PhosphorIconsStyle.regular),
              label: 'Delete',
              danger: true,
              onTap: _delete,
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(TextEditingController c,
          {required String hint, required int maxLines}) =>
      TextField(
        controller: c,
        maxLines: maxLines,
        onChanged: (_) {
          if (!_dirty) setState(() => _dirty = true);
        },
        style: ADText.rowName(c: AvaDialTheme.text),
        cursorColor: AvaDialTheme.accent,
        decoration: InputDecoration(
          isDense: true,
          filled: true,
          fillColor: AvaDialTheme.surface,
          hintText: hint,
          hintStyle: ADText.preview(c: AvaDialTheme.textMute),
          contentPadding: const EdgeInsets.symmetric(
              horizontal: Msg.s3, vertical: Msg.s3),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AD.rInput),
            borderSide: const BorderSide(color: AvaDialTheme.border, width: 1),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AD.rInput),
            borderSide:
                const BorderSide(color: AvaDialTheme.accent, width: 1.5),
          ),
        ),
      );

  Widget _action({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    bool danger = false,
  }) =>
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: PhosphorIcon(icon,
            color: danger ? AD.danger : AvaDialTheme.textSoft),
        title: Text(label,
            style: ADText.rowName(
                c: danger ? AD.danger : AvaDialTheme.text)),
        onTap: onTap,
      );
}
