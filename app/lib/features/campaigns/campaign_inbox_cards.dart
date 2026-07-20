import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/audio_playback_service.dart';
import '../../core/config.dart';
import '../../core/ui/avatok_dark.dart';
import '../avadial/avadial_theme.dart';
import '../avatok/media.dart' show MediaService;

/// AvaDial Inbox cards for outbound-campaign messages (Issue AVA-CAMP-FL-CARDS).
///
/// The backend posts campaign results into the SAME per-account InboxDO thread
/// stream `inbox_thread_screen.dart` already reads (`GET /api/msg/sync`), with
/// `sender = 'ava_campaign'` and a JSON `body` envelope carrying a `t` (type)
/// discriminator: `campaign_call` (one answered outbound call), `campaign_
/// missed_digest` (the periodic "who didn't pick up" roundup), and `campaign_
/// status` (launched/paused/completed events). This file is a FRESH, parallel
/// card set — mirrors `_VoicemailCard`'s look-and-feel (bubble
/// colors/padding/radius/text styles from `AvaDialTheme`/`AD`/`ADText`, and the
/// exact cache-first `MediaService` + shared `AudioPlaybackService` playback
/// pattern for `media_ref` recordings) WITHOUT importing or editing
/// `inbox_thread_screen.dart`, per the lane brief. `inbox_thread_screen.dart`
/// (or wherever the Inbox screen ends up switching on message kind) wires this
/// in later via the single [buildCampaignCard] entry point below — nothing is
/// wired from this file.
///
/// ASSUMPTIONS (no campaign envelope spec file was available to cross-check
/// against, only the shapes given in the lane brief):
///  * `campaign_call.media_ref` is an R2 recording key read through the SAME
///    generic `GET /api/voicemail/recording?key=<r2key>` route `_VoicemailCard`
///    already uses in `inbox_thread_screen.dart` — that route serves owner-
///    authed R2 audio by key regardless of which lane wrote the object, and no
///    campaign-specific recording route was mentioned in the brief.
///  * "Test Call" purpose is signalled by `envelope['purpose'] == 'test'` OR a
///    boolean `envelope['test'] == true` — the brief says "marks purpose test"
///    without pinning an exact key name, so both are checked defensively.
///  * `campaign_missed_digest.unreached[].reason` / `.attempts` are optional;
///    missing values degrade gracefully (reason omitted, attempts omitted).
///  * `campaign_status.stats` is a loosely-typed `Map` — rendered as
///    `key: value` chips in insertion order rather than assuming fixed keys,
///    since the brief doesn't enumerate them.

/// Single switchboard the Inbox screen can call in one line: returns the right
/// card for a parsed `body` envelope, or `null` if `body['t']` isn't one of
/// this lane's three campaign types (so a non-campaign message falls through
/// to whatever card the caller already builds for it).
Widget? buildCampaignCard(
  Map<String, dynamic> body, {
  VoidCallback? onRetryMissed,
  VoidCallback? onOpenDashboard,
}) {
  final t = (body['t'] ?? '').toString();
  switch (t) {
    case 'campaign_call':
      return CampaignCallCard(envelope: body);
    case 'campaign_missed_digest':
      return CampaignMissedDigestCard(
        envelope: body,
        onRetry: onRetryMissed,
        onOpenDashboard: onOpenDashboard,
      );
    case 'campaign_status':
      return CampaignStatusCard(envelope: body);
    default:
      return null;
  }
}

// Shared bubble tokens — lifted verbatim from `_VoicemailCard`'s "read"
// (grey) bubble in inbox_thread_screen.dart so campaign cards sit in the same
// thread without looking like a different app. Campaign cards have no
// heard/unheard concept, so they always use the neutral grey surface (never
// the pale-green "unheard" one, which is voicemail-specific read state).
const _kCardBg = Color(0xFFE7E8EB);
const _kCardBorder = Color(0xFFCED0D6);
const _kInk = Color(0xFF14161A);
const _kSubInk = Color(0xFF3B3D45);

Widget _cardShell(Widget child) => Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _kCardBg,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: _kCardBorder, width: 1),
      ),
      child: child,
    );

/// t='campaign_call' — one answered outbound call: contact + number, duration
/// chip, 1-line summary, expandable transcript, a recording player (reusing
/// `_VoicemailCard`'s exact cache-first `MediaService`/`AudioPlaybackService`
/// approach), language tag, Booked/Handed-over badges, and a token-cost line.
class CampaignCallCard extends StatefulWidget {
  final Map<String, dynamic> envelope;
  const CampaignCallCard({super.key, required this.envelope});

  @override
  State<CampaignCallCard> createState() => _CampaignCallCardState();
}

class _CampaignCallCardState extends State<CampaignCallCard> {
  bool _loading = false;
  bool _expanded = false;

  Map<String, dynamic> get _e => widget.envelope;

  String? get _contactName {
    final v = _e['contact_name'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  String? get _contactPhone {
    final v = _e['contact_e164'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  String? get _summary {
    final v = _e['summary'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  String? get _transcript {
    final v = _e['transcript'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  String? get _mediaRef {
    final v = _e['media_ref'];
    return (v == null || v.toString().isEmpty) ? null : v.toString();
  }

  bool get _hasRecording => _mediaRef != null;

  int get _durationSec => (_e['duration_s'] as num?)?.toInt() ?? 0;

  String? get _lang {
    final v = _e['lang'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  int? get _tokens => (_e['tokens'] as num?)?.toInt();

  bool get _booked => _e['booked'] == true;
  bool get _handover => _e['handover'] == true;

  // See file-level ASSUMPTIONS note — the brief names no exact key, so both
  // a `purpose: 'test'` discriminator and a plain boolean `test` are honored.
  bool get _isTest => _e['purpose']?.toString() == 'test' || _e['test'] == true;

  /// Content-addressed cache key, mirroring `_VoicemailCard._cacheKey` —
  /// keyed off the R2 `media_ref` so a recording already cached by any other
  /// surface (voicemail/receptionist) that happens to reference the same
  /// object is reused rather than re-downloaded.
  String get _cacheKey {
    final ref = _mediaRef;
    if (ref != null) {
      return 'camp_${ref.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_')}';
    }
    return 'camp_${_e['session_id'] ?? _contactPhone ?? identityHashCode(_e)}';
  }

  /// Namespaced `camp:` so this can never collide with the inbox lane's own
  /// `ibx:` track ids or a chat voice-note's id in the shared
  /// [AudioPlaybackService].
  String get _trackId => 'camp:$_cacheKey';

  String? get _recordingUrl {
    final key = _mediaRef;
    if (key == null) return null;
    // Same generic owner-authed R2-by-key route `_VoicemailCard` uses — see
    // file-level ASSUMPTIONS note.
    return '$kApiBase/voicemail/recording?key=${Uri.encodeQueryComponent(key)}';
  }

  Future<void> _togglePlay() async {
    final cur = AudioPlaybackService.I.state.value;
    final isThisTrack = AudioPlaybackService.I.isCurrent(_trackId);
    if (isThisTrack && cur != null && cur.playing) {
      await AudioPlaybackService.I.pause();
      return;
    }
    if (isThisTrack && cur != null && !cur.playing) {
      await AudioPlaybackService.I.resume();
      return;
    }
    if (!_hasRecording) return;
    setState(() => _loading = true);
    try {
      Uint8List? bytes = await MediaService.cachedBlob(_cacheKey);
      final fromCache = bytes != null && bytes.isNotEmpty;
      if (!fromCache) {
        final url = _recordingUrl;
        if (url == null) {
          if (mounted) setState(() => _loading = false);
          return;
        }
        final r = await ApiAuth.getBytes(url);
        if (r.statusCode != 200 || r.bodyBytes.isEmpty) {
          if (mounted) setState(() => _loading = false);
          return;
        }
        bytes = r.bodyBytes;
        await MediaService.writeBlob(_cacheKey, bytes);
      }
      await AudioPlaybackService.I.play(
        track: AudioTrack(
          trackId: _trackId,
          title: _contactName ?? _contactPhone ?? 'Campaign call',
          subtitle: 'Campaign call',
          originRoute: null,
        ),
        bytes: bytes,
      );
      if (mounted) setState(() => _loading = false);
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Same "m:ss" formatting `_VoicemailCard._durationLabel` uses — prefers
  /// the shared player's live/known duration once decoded, falls back to the
  /// envelope's `duration_s`.
  String _durationLabel(Duration? liveDuration) {
    if (liveDuration != null && liveDuration.inSeconds > 0) {
      final m = liveDuration.inMinutes, sec = liveDuration.inSeconds % 60;
      return '$m:${sec.toString().padLeft(2, '0')}';
    }
    final s = _durationSec;
    if (s <= 0) return '';
    final m = s ~/ 60, sec = s % 60;
    return '$m:${sec.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return _cardShell(
      Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          if (_isTest) ...[
            AvaDialTheme.chip('Test Call', color: AD.iconSearch, icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold)),
            const SizedBox(width: 6),
          ],
          Expanded(
            child: Text(_contactName ?? _contactPhone ?? 'Unknown contact',
                style: ADText.threadName(c: _kInk)),
          ),
          if (_durationSec > 0) ...[
            const SizedBox(width: 6),
            AvaDialTheme.chip(_durationLabel(null), color: AD.iconVideo, icon: PhosphorIcons.clock(PhosphorIconsStyle.bold)),
          ],
        ]),
        if (_contactPhone != null && _contactPhone != _contactName) ...[
          const SizedBox(height: 1),
          Text(_contactPhone!, style: ADText.statCaption(c: _kSubInk)),
        ],
        if (_summary != null) ...[
          const SizedBox(height: 6),
          Text(_summary!, style: ADText.bubbleBody(c: _kInk)),
        ],
        // ---- Recording player — identical shared-service pattern to
        // `_VoicemailCard` (survives navigation, resumes in place). ----
        if (_hasRecording) ...[
          const SizedBox(height: 8),
          ValueListenableBuilder<PlaybackState?>(
            valueListenable: AudioPlaybackService.I.state,
            builder: (context, st, _) {
              final isThis = st != null && st.track.trackId == _trackId;
              final playing = isThis && st.playing;
              final dur = (isThis ? st.duration : null) ?? AudioPlaybackService.I.knownDuration(_trackId);
              return GestureDetector(
                onTap: _togglePlay,
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  _loading
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2, color: AD.bubbleOutPlay),
                        )
                      : Icon(
                          playing
                              ? PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill)
                              : PhosphorIcons.playCircle(PhosphorIconsStyle.fill),
                          size: 30,
                          color: AD.bubbleOutPlay,
                        ),
                  const SizedBox(width: 8),
                  Text(
                    _durationLabel(dur).isNotEmpty ? 'Recording · ${_durationLabel(dur)}' : 'Play recording',
                    style: ADText.rowName(c: AD.bubbleOutPlay),
                  ),
                ]),
              );
            },
          ),
        ],
        // ---- Expandable transcript underneath, same idiom as
        // `_VoicemailCard`'s "Show/Hide transcript" toggle. ----
        if (_transcript != null) ...[
          const SizedBox(height: 8),
          GestureDetector(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Text(_expanded ? 'Hide transcript ▲' : 'Show transcript ▼',
                style: ADText.statCaption(c: _kSubInk)),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(_transcript!, style: ADText.preview(c: _kSubInk)),
            ),
        ],
        // ---- Language tag + outcome badges ----
        if (_lang != null || _booked || _handover) ...[
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 4, children: [
            if (_lang != null) AvaDialTheme.chip(_lang!.toUpperCase(), color: AD.iconSearch),
            if (_booked)
              AvaDialTheme.chip('Booked', color: AD.online, icon: PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold)),
            if (_handover)
              AvaDialTheme.chip('Handed over', color: AD.primaryBadge, icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold)),
          ]),
        ],
        // ---- Token-cost line ----
        if (_tokens != null) ...[
          const SizedBox(height: 6),
          Text('$_tokens tokens', style: ADText.statCaption(c: _kSubInk)),
        ],
      ]),
    );
  }
}

/// t='campaign_missed_digest' — periodic "who didn't pick up" roundup: header
/// "Today's unreachable (N)", a collapsed list of names+numbers+reason, and a
/// "Tap to retry / open dashboard" affordance. Callbacks are plain params —
/// nothing here navigates; the caller (Inbox screen, once wired) decides what
/// "retry" and "open dashboard" actually do.
class CampaignMissedDigestCard extends StatefulWidget {
  final Map<String, dynamic> envelope;
  final VoidCallback? onRetry;
  final VoidCallback? onOpenDashboard;
  const CampaignMissedDigestCard({
    super.key,
    required this.envelope,
    this.onRetry,
    this.onOpenDashboard,
  });

  @override
  State<CampaignMissedDigestCard> createState() => _CampaignMissedDigestCardState();
}

class _CampaignMissedDigestCardState extends State<CampaignMissedDigestCard> {
  bool _expanded = false;

  Map<String, dynamic> get _e => widget.envelope;

  List<Map<String, dynamic>> get _unreached {
    final raw = _e['unreached'];
    if (raw is! List) return const [];
    return raw.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
  }

  int get _count => (_e['count'] as num?)?.toInt() ?? _unreached.length;

  String? get _date {
    final v = _e['date'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  String? get _text {
    final v = _e['text'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  @override
  Widget build(BuildContext context) {
    final unreached = _unreached;
    // Collapsed = first 3 names, matching the "collapsed list" spec — tap the
    // header to see the rest, same show/hide idiom used elsewhere in this file.
    final visible = _expanded ? unreached : unreached.take(3).toList();
    return _cardShell(
      Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          Icon(PhosphorIcons.phoneX(PhosphorIconsStyle.bold), size: 16, color: AD.danger),
          const SizedBox(width: 6),
          Expanded(
            child: Text("Today's unreachable ($_count)", style: ADText.threadName(c: _kInk)),
          ),
        ]),
        if (_date != null) ...[
          const SizedBox(height: 1),
          Text(_date!, style: ADText.statCaption(c: _kSubInk)),
        ],
        if (_text != null) ...[
          const SizedBox(height: 6),
          Text(_text!, style: ADText.bubbleBody(c: _kInk)),
        ],
        if (visible.isNotEmpty) ...[
          const SizedBox(height: 8),
          for (final row in visible) _unreachedRow(row),
          if (unreached.length > 3)
            GestureDetector(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  _expanded ? 'Show less ▲' : 'Show ${unreached.length - 3} more ▼',
                  style: ADText.statCaption(c: _kSubInk),
                ),
              ),
            ),
        ],
        const SizedBox(height: 10),
        Row(children: [
          if (widget.onRetry != null)
            GestureDetector(
              onTap: widget.onRetry,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(PhosphorIcons.arrowClockwise(PhosphorIconsStyle.bold), size: 15, color: AD.bubbleOutPlay),
                const SizedBox(width: 4),
                Text('Retry', style: ADText.rowName(c: AD.bubbleOutPlay)),
              ]),
            ),
          if (widget.onRetry != null && widget.onOpenDashboard != null) const SizedBox(width: 16),
          if (widget.onOpenDashboard != null)
            GestureDetector(
              onTap: widget.onOpenDashboard,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(PhosphorIcons.chartBar(PhosphorIconsStyle.bold), size: 15, color: AD.iconVideo),
                const SizedBox(width: 4),
                Text('Open dashboard', style: ADText.rowName(c: AD.iconVideo)),
              ]),
            ),
        ]),
      ]),
    );
  }

  Widget _unreachedRow(Map<String, dynamic> row) {
    final name = row['name']?.toString();
    final e164 = row['e164']?.toString();
    final reason = row['reason']?.toString();
    final attempts = (row['attempts'] as num?)?.toInt();
    final label = (name != null && name.trim().isNotEmpty) ? name : (e164 ?? 'Unknown');
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: RichText(
            text: TextSpan(children: [
              TextSpan(text: label, style: ADText.rowName(c: _kInk)),
              if (e164 != null && e164 != label)
                TextSpan(text: '  $e164', style: ADText.statCaption(c: _kSubInk)),
            ]),
          ),
        ),
        if (reason != null && reason.isNotEmpty || attempts != null)
          Text(
            [
              if (reason != null && reason.isNotEmpty) reason,
              if (attempts != null) '${attempts}x',
            ].join(' · '),
            style: ADText.statCaption(c: _kSubInk),
          ),
      ]),
    );
  }
}

/// t='campaign_status' — compact one-liner for a lifecycle event
/// (launched/paused/completed/etc) plus whatever `stats` the backend attaches.
class CampaignStatusCard extends StatelessWidget {
  final Map<String, dynamic> envelope;
  const CampaignStatusCard({super.key, required this.envelope});

  String? get _event {
    final v = envelope['event'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  String? get _text {
    final v = envelope['text'];
    return (v == null || v.toString().trim().isEmpty) ? null : v.toString();
  }

  Map<String, dynamic> get _stats {
    final raw = envelope['stats'];
    return raw is Map ? raw.cast<String, dynamic>() : const {};
  }

  IconData _iconFor(String? event) {
    switch (event) {
      case 'launched':
      case 'started':
      case 'resumed':
        return PhosphorIcons.playCircle(PhosphorIconsStyle.bold);
      case 'paused':
        return PhosphorIcons.pauseCircle(PhosphorIconsStyle.bold);
      case 'completed':
      case 'finished':
        return PhosphorIcons.checkCircle(PhosphorIconsStyle.bold);
      case 'failed':
      case 'error':
        return PhosphorIcons.warningCircle(PhosphorIconsStyle.bold);
      default:
        return PhosphorIcons.megaphone(PhosphorIconsStyle.bold);
    }
  }

  @override
  Widget build(BuildContext context) {
    final stats = _stats;
    return _cardShell(
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(_iconFor(_event), size: 18, color: AD.iconVideo),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(
              _text ?? (_event != null ? 'Campaign $_event' : 'Campaign update'),
              style: ADText.rowName(c: _kInk),
            ),
            if (stats.isNotEmpty) ...[
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final entry in stats.entries)
                    AvaDialTheme.chip('${entry.key}: ${entry.value}', color: AD.iconSearch),
                ],
              ),
            ],
          ]),
        ),
      ]),
    );
  }
}
