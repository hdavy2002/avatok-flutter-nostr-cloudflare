part of '../chat_thread.dart';


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
        borderRadius: BorderRadius.circular(Msg.rMd),
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
                borderRadius: BorderRadius.circular(Msg.rMd),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(_loading ? PhosphorIcons.hourglass(PhosphorIconsStyle.bold) : _playing ? PhosphorIcons.stop(PhosphorIconsStyle.fill) : PhosphorIcons.play(PhosphorIconsStyle.fill),
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
                  borderRadius: BorderRadius.circular(Msg.rMd),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(_sharing ? PhosphorIcons.hourglass(PhosphorIconsStyle.bold) : PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), color: AD.bubbleInInk, size: 16),
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

  /// [RECEPT-EMPTY-CARD-1 2026-08-06] Did a conversation actually happen?
  ///
  /// The server has always known this and has been sending the right sentence in
  /// `text` — for a 0.7-second call on 2026-08-05 it read "Missed call — they
  /// hung up before leaving a message". This card ignored `text` entirely and
  /// hardcoded "Ava took a message" + "Left a message.", so the owner saw a
  /// message card with no Play button and reasonably concluded a recording had
  /// been lost. Nothing was lost; there was never any audio.
  ///
  /// `had_conversation` is the explicit signal. Older messages predate it, so
  /// absence falls back to the recording/transcript/duration evidence rather
  /// than defaulting either way — an existing card in someone's thread must not
  /// suddenly re-label itself as a missed call.
  bool get _hadConversation {
    final flag = _e['had_conversation'];
    if (flag is bool) return flag;
    return _hasRec ||
        (_e['transcript'] ?? '').toString().trim().isNotEmpty ||
        ((_e['duration_s'] as num?)?.toInt() ?? 0) > 0;
  }

  /// The card's subtitle. "Ava took a message" is a claim, and it has to be true.
  String get _headline => _hadConversation ? 'Ava took a message' : 'Missed call';

  String get _reason {
    final summary = _e['summary'];
    if (summary is Map && (summary['reason'] ?? '').toString().trim().isNotEmpty) {
      return summary['reason'].toString();
    }
    if (!_hadConversation) {
      // Says what happened instead of implying a message exists. `turns: 0` with
      // no recording means the caller rang off before Ava could take anything.
      return 'They hung up before leaving a message.';
    }
    return _hasRec ? 'Left a message.' : 'Ava answered.';
  }

  /// A recording actually exists. The envelope carries `has_recording`;
  /// `recording_url` is the older shape and is still accepted.
  bool get _hasRec =>
      _e['has_recording'] == true ||
      (_e['recording_url'] ?? '').toString().isNotEmpty;

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
    final hasRec = _hasRec;
    final dur = _durationLabel;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(PhosphorIcons.phoneIncoming(PhosphorIconsStyle.fill), size: 18, color: AD.bubbleInBg),
        const SizedBox(width: 6),
        Flexible(child: Text('$_caller called', style: ADText.rowName(c: AD.bubbleInInk))),
      ]),
      const SizedBox(height: 2),
      // [RECEPT-EMPTY-CARD-1] Was 'Ava took a message', hardcoded. It is a claim
      // about a recording existing, so it has to be earned — see [_headline].
      Text(_headline, style: ADText.sectionLabel(c: AD.bubbleInMeta)),
      // Caller's phone number — always shown when present, even if Ava also
      // captured a name, so the owner can identify/return the call.
      if (_phone.isNotEmpty) ...[
        const SizedBox(height: 4),
        Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(PhosphorIcons.phone(PhosphorIconsStyle.fill), size: 13, color: AD.bubbleInMeta),
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
              borderRadius: BorderRadius.circular(Msg.rMd),
              border: Border.all(color: AD.bubbleInInk, width: 2),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(PhosphorIcons.userPlus(PhosphorIconsStyle.bold), size: 15, color: AD.bubbleInInk),
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
                borderRadius: BorderRadius.circular(Msg.rMd),
                border: Border.all(color: AD.bubbleInInk, width: 2),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _loadingAudio
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(_playing ? PhosphorIcons.stop(PhosphorIconsStyle.fill) : PhosphorIcons.play(PhosphorIconsStyle.fill), size: 16, color: AD.bubbleInInk),
                const SizedBox(width: 5),
                Text(_playing ? 'Stop' : 'Play recording', style: ADText.bubbleMeta(c: AD.bubbleInMeta)),
              ]),
            ),
          ),
        if (hasRec && dur.isNotEmpty) ...[
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.regular),
              size: 12, color: AD.bubbleInMeta),
          const SizedBox(width: Msg.s1),
          Text(dur, style: ADText.bubbleMeta(c: AD.bubbleInMeta)),
        ],
        if (hasRec) ...[
          const SizedBox(width: 8),
          GestureDetector(
            onTap: _sharing ? null : _shareRecording,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: AD.mediaPlaceholderBg,
                borderRadius: BorderRadius.circular(Msg.rMd),
                border: Border.all(color: AD.bubbleInInk, width: 2),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _sharing
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : Icon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold), size: 15, color: AD.bubbleInInk),
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
