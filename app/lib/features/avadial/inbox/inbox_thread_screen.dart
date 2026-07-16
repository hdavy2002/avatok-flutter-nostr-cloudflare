import 'dart:async';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../avatok/media.dart' show MediaService;
import '../avadial_theme.dart';
import '../block_list.dart';
import '../contact_edit_screen.dart';
import '../device_contacts.dart';
import 'inbox_api.dart';

/// AvaDial Inbox thread — one caller's voicemail/Ava-Receptionist history,
/// chat-thread style (Specs/PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md
/// AVA-RCPT-9): each screened call is a card (audio player + transcript
/// underneath + timestamp), newest at the BOTTOM, a back button at the top,
/// and every future call from the same number appends to this same thread.
///
/// Reuses the pattern already proven by `_ReceptionistCard` /
/// `VoicemailCard` in app/lib/features/avatok/ (audio fetched owner-authed and
/// cached per-account via `MediaService.cachedBlob`/`writeBlob`) WITHOUT
/// importing those private/feature-coupled widgets — this is a fresh,
/// self-contained card for the standalone Inbox surface, per the lane's hard
/// rule to leave chat_thread.dart untouched.
class InboxThreadScreen extends StatefulWidget {
  final InboxThread thread;
  const InboxThreadScreen({super.key, required this.thread});

  @override
  State<InboxThreadScreen> createState() => _InboxThreadScreenState();
}

class _InboxThreadScreenState extends State<InboxThreadScreen> {
  late Future<List<InboxCard>> _future;
  final _scroll = ScrollController();

  String? get _phone => widget.thread.telPhone ??
      (widget.thread.cards.isNotEmpty ? widget.thread.cards.last.callerPhone : null);

  String get _title {
    if (widget.thread.isAnonymous) return 'Hidden number';
    final phone = _phone;
    if (phone != null) {
      final name = DeviceContacts.I.lookup(phone)?.name;
      return (name != null && name.trim().isNotEmpty) ? name : phone;
    }
    final name = widget.thread.latest.callerName;
    return (name != null && name.isNotEmpty) ? name : 'Unknown caller';
  }

  bool get _isSavedContact {
    final phone = _phone;
    if (phone == null) return true; // no number to save → hide the action
    final name = DeviceContacts.I.lookup(phone)?.name;
    return name != null && name.trim().isNotEmpty;
  }

  @override
  void initState() {
    super.initState();
    DeviceContacts.I.load();
    _future = InboxApi.cardsFor(widget.thread.conv);
    Analytics.capture('inbox_thread_opened', {
      'conv_hash': widget.thread.conv.hashCode,
      'anonymous': widget.thread.isAnonymous,
      'cards': widget.thread.cards.length,
    });
    // Mark read immediately — matches every other AvaTOK thread's open-to-read
    // behaviour so the list's unread dot clears on return.
    unawaited(InboxApi.markRead(widget.thread.conv));
    WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToEnd());
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _jumpToEnd() {
    if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  /// [INBOX-DAYGROUP-1] Splits [cards] (already oldest-first) into a flat
  /// header+card list with a date separator inserted before the first card of
  /// each calendar day, so the thread reads like a chat log grouped by day as
  /// the user scrolls — "Today" / "Yesterday" / "Mon, 14 Jul 2026".
  List<_ThreadItem> _dayGrouped(List<InboxCard> cards) {
    final out = <_ThreadItem>[];
    String? lastDayKey;
    for (final c in cards) {
      final dt = c.createdAtMs > 0
          ? DateTime.fromMillisecondsSinceEpoch(c.createdAtMs)
          : DateTime.now();
      final dayKey = '${dt.year}-${dt.month}-${dt.day}';
      if (dayKey != lastDayKey) {
        out.add(_ThreadItem.header(_dayLabel(dt)));
        lastDayKey = dayKey;
      }
      out.add(_ThreadItem.card(c));
    }
    return out;
  }

  String _dayLabel(DateTime dt) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final that = DateTime(dt.year, dt.month, dt.day);
    final diffDays = today.difference(that).inDays;
    if (diffDays == 0) return 'Today';
    if (diffDays == 1) return 'Yesterday';
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final wd = weekdays[dt.weekday - 1];
    final mo = months[dt.month - 1];
    return '$wd, ${dt.day} $mo ${dt.year}';
  }

  Future<void> _addToContacts() async {
    final phone = _phone;
    if (phone == null) return;
    Analytics.capture('inbox_add_to_contacts_tapped', {'has_number': true});
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ContactEditScreen(number: phone, create: true),
    ));
    if (mounted) setState(() {}); // re-check _isSavedContact after return
  }

  Future<void> _block({required bool reportSpam}) async {
    final phone = _phone;
    if (phone == null) return;
    if (reportSpam) {
      await BlockList.I.reportSpam(phone, label: 'Reported from Inbox');
    } else {
      await BlockList.I.block(phone);
    }
    Analytics.capture('inbox_block_tapped', {'report_spam': reportSpam});
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(reportSpam ? 'Blocked and reported as spam.' : 'Number blocked.'),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final phone = _phone;
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        foregroundColor: AvaDialTheme.text,
        leading: AdBackButton(),
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_title, style: ADText.threadName(c: AvaDialTheme.text)),
          if (phone != null && _title != phone)
            Text(phone, style: ADText.statCaption(c: AvaDialTheme.textMute)),
        ]),
        actions: [
          if (phone != null)
            PopupMenuButton<String>(
              icon: Icon(Icons.more_vert, color: AvaDialTheme.text),
              color: AvaDialTheme.surface,
              onSelected: (v) {
                switch (v) {
                  case 'add': _addToContacts(); break;
                  case 'spam': _block(reportSpam: true); break;
                  case 'block': _block(reportSpam: false); break;
                }
              },
              itemBuilder: (context) => [
                if (!_isSavedContact)
                  PopupMenuItem(
                    value: 'add',
                    child: Text('Add to contacts', style: ADText.preview(c: AvaDialTheme.text)),
                  ),
                PopupMenuItem(
                  value: 'spam',
                  child: Text('Block & report spam', style: ADText.preview(c: AvaDialTheme.text)),
                ),
                PopupMenuItem(
                  value: 'block',
                  child: Text('Block', style: ADText.preview(c: AvaDialTheme.text)),
                ),
              ],
            ),
        ],
      ),
      body: SafeArea(
        child: FutureBuilder<List<InboxCard>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
            }
            final cards = snap.data ?? widget.thread.cards;
            if (cards.isEmpty) {
              return Center(
                child: Text('No messages in this thread yet',
                    style: ADText.preview(c: AvaDialTheme.textSoft)),
              );
            }
            WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToEnd());
            final items = _dayGrouped(cards);
            return ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 16),
              itemCount: items.length,
              itemBuilder: (context, i) {
                final item = items[i];
                if (item.isHeader) {
                  return Padding(
                    padding: const EdgeInsets.only(top: 4, bottom: 10),
                    child: _DateSeparator(label: item.dayLabel!),
                  );
                }
                final card = item.card!;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _VoicemailCard(
                    card: card,
                    callerName: _title,
                    callerNumber: card.callerPhone ?? _phone,
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }
}

/// A flat-list entry for the day-grouped thread view: either a date-separator
/// header or one voicemail card. Kept as a tiny sum type rather than two
/// parallel lists so `ListView.builder` can address both by a single index.
class _ThreadItem {
  final String? dayLabel;
  final InboxCard? card;
  const _ThreadItem._(this.dayLabel, this.card);
  factory _ThreadItem.header(String label) => _ThreadItem._(label, null);
  factory _ThreadItem.card(InboxCard c) => _ThreadItem._(null, c);
  bool get isHeader => dayLabel != null;
}

/// Centered day-separator pill ("Today" / "Yesterday" / "Mon, 14 Jul 2026").
class _DateSeparator extends StatelessWidget {
  final String label;
  const _DateSeparator({required this.label});
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        decoration: BoxDecoration(
          color: AvaDialTheme.surface2,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AvaDialTheme.border, width: 1),
        ),
        child: Text(label, style: ADText.statCaption(c: AvaDialTheme.textMute)),
      ),
    );
  }
}

/// One voicemail/receptionist message: caller name + number, audio player +
/// transcript underneath + time/date. Mirrors `_ReceptionistCard`'s
/// cache-first playback (chat_thread.dart) but is its own widget so this lane
/// never imports that file.
class _VoicemailCard extends StatefulWidget {
  final InboxCard card;
  /// Thread-level caller display name (resolved contact name, or a formatted
  /// number/"Hidden number"/"Unknown caller" fallback) — shown on every card
  /// so the metadata reads correctly even scrolled far from the header.
  final String callerName;
  /// The PSTN number for this specific card, if any (falls back to the
  /// thread's number when the card itself doesn't carry one).
  final String? callerNumber;
  const _VoicemailCard({required this.card, required this.callerName, this.callerNumber});

  @override
  State<_VoicemailCard> createState() => _VoicemailCardState();
}

class _VoicemailCardState extends State<_VoicemailCard> {
  final AudioPlayer _player = AudioPlayer();
  bool _playing = false;
  bool _loading = false;
  bool _expanded = true; // transcript shown by default, per the product spec

  InboxCard get _c => widget.card;

  /// Per-account cache key — content-addressed by session/row id, scoped
  /// internally by [MediaService] via AccountScope.id (rulebook rule 2: one
  /// phone shared by parent + child accounts, decrypted/downloaded media MUST
  /// live under a per-account subdir).
  String get _cacheKey => 'inbox_${_c.sessionId ?? _c.id}';

  String? get _recordingUrl {
    final key = _c.mediaRef;
    if (key == null || key.isEmpty) return null;
    // Explicit endpoint per this lane's brief: GET /api/voicemail/recording?key=<r2key>.
    return '$kApiBase/voicemail/recording?key=${Uri.encodeQueryComponent(key)}';
  }

  @override
  void initState() {
    super.initState();
    _prefetch();
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = false);
    });
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _prefetch() async {
    if (!_c.hasRecording) return;
    try {
      final cached = await MediaService.cachedBlob(_cacheKey);
      if (cached != null && cached.isNotEmpty) return;
      final url = _recordingUrl;
      if (url == null) return;
      final r = await ApiAuth.getBytes(url);
      if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
        await MediaService.writeBlob(_cacheKey, r.bodyBytes);
      }
    } catch (_) {
      // Best-effort — _togglePlay() fetches on demand if this misses.
    }
  }

  Future<void> _togglePlay() async {
    if (_playing) {
      await _player.pause();
      if (mounted) setState(() => _playing = false);
      return;
    }
    if (!_c.hasRecording) return;
    setState(() => _loading = true);
    final t0 = DateTime.now().millisecondsSinceEpoch;
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
          Analytics.capture('inbox_voicemail_playback', {
            'ok': false, 'cached': false, 'status': r.statusCode,
          });
          if (mounted) setState(() => _loading = false);
          return;
        }
        bytes = r.bodyBytes;
        await MediaService.writeBlob(_cacheKey, bytes);
      }
      await _player.play(BytesSource(bytes, mimeType: 'audio/wav'));
      Analytics.capture('inbox_voicemail_playback', {
        'ok': true, 'cached': fromCache, 'bytes': bytes.length,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      if (mounted) setState(() { _loading = false; _playing = true; });
    } catch (e) {
      Analytics.capture('inbox_voicemail_playback', {'ok': false, 'cached': false});
      if (mounted) setState(() => _loading = false);
    }
  }

  String get _durationLabel {
    final s = _c.durationSec;
    if (s <= 0) return '';
    final m = s ~/ 60, sec = s % 60;
    return '$m:${sec.toString().padLeft(2, '0')}';
  }

  /// "14:32 · 16 Jul 2026" — owner spec (JOB 2 item 4): time + date together
  /// on every card, distinct from the day-separator header above it.
  String get _timeLabel {
    if (_c.createdAtMs <= 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(_c.createdAtMs);
    final hh = dt.hour.toString().padLeft(2, '0');
    final mm = dt.minute.toString().padLeft(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '$hh:$mm · ${dt.day} ${months[dt.month - 1]} ${dt.year}';
  }

  @override
  Widget build(BuildContext context) {
    return AdCard(
      color: AvaDialTheme.surface2,
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        // ---- Caller metadata: display name + PSTN number (JOB 2 item 4) ----
        Text(widget.callerName, style: ADText.threadName(c: AvaDialTheme.text)),
        if (widget.callerNumber != null && widget.callerNumber != widget.callerName) ...[
          const SizedBox(height: 1),
          Text(widget.callerNumber!, style: ADText.statCaption(c: AvaDialTheme.textMute)),
        ],
        const SizedBox(height: 6),
        if (_c.summaryText != null) ...[
          Text(_c.summaryText!, style: ADText.bubbleBody(c: AvaDialTheme.text)),
          const SizedBox(height: 8),
        ],
        // ---- Audio player ----
        if (_c.hasRecording)
          GestureDetector(
            onTap: _togglePlay,
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              _loading
                  ? const SizedBox(width: 22, height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconShield))
                  : Icon(
                      _playing
                          ? PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill)
                          : PhosphorIcons.playCircle(PhosphorIconsStyle.fill),
                      size: 30, color: AD.iconShield,
                    ),
              const SizedBox(width: 8),
              Text(
                _durationLabel.isNotEmpty ? 'Voicemail · $_durationLabel' : 'Play voicemail',
                style: ADText.rowName(c: AD.iconShield),
              ),
            ]),
          ),
        // ---- Transcript underneath ----
        if (_c.transcript != null) ...[
          const SizedBox(height: 8),
          GestureDetector(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Text(_expanded ? 'Hide transcript ▲' : 'Show transcript ▼',
                style: ADText.statCaption(c: AvaDialTheme.textMute)),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(_c.transcript!, style: ADText.preview(c: AvaDialTheme.textSoft)),
            ),
        ],
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerRight,
          child: Text(_timeLabel, style: ADText.statCaption(c: AvaDialTheme.textMute)),
        ),
      ]),
    );
  }
}
