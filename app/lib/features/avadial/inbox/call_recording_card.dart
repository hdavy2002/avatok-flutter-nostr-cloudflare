import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/avatar.dart';
import '../../../core/profile_store.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../identity/identity.dart';
import 'call_recording_detail_screen.dart';
import 'inbox_api.dart';

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
Widget buildCallRecordingCard(BuildContext context, InboxCard card) =>
    _CallRecordingCard(card: card);

class _CallRecordingCard extends StatefulWidget {
  const _CallRecordingCard({required this.card});
  final InboxCard card;

  @override
  State<_CallRecordingCard> createState() => _CallRecordingCardState();
}

class _CallRecordingCardState extends State<_CallRecordingCard> {
  /// My own display name + photo, for the near half of the avatar pair. Loaded
  /// once; a failure just leaves the initials avatar, never an error state.
  String _myName = '';
  String _myAvatar = '';

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

  @override
  Widget build(BuildContext context) {
    final dur = callRecDurationLabel(_c.durationSec);
    final size = callRecBytesLabel(_c.recBytes);
    final meta = <String>[
      callRecDateLabel(_startedAt),
      callRecTimeLabel(_startedAt),
      if (dur.isNotEmpty) dur,
      if (size.isNotEmpty) size,
    ].join(' · ');

    return GestureDetector(
      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => CallRecordingDetailScreen(card: _c),
      )),
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
                  Row(children: [
                    PhosphorIcon(
                      PhosphorIcons.playCircle(PhosphorIconsStyle.fill),
                      size: 22,
                      color: AD.bubbleOutPlay,
                    ),
                    const SizedBox(width: Msg.s2),
                    Expanded(
                      child: Text(meta,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ADText.statCaption(c: AD.bubbleOutMeta)),
                    ),
                  ]),
                ],
              ),
            ),
          ],
        ),
      ),
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
