import 'package:flutter/material.dart';

import '../data/models/reel.dart';
import 'reel_player.dart';
import 'theme.dart';

/// [HF-REEL-CALL-2] The light preview a profile's video opens (owner 2026-10-25): the video plays on its own with only a
/// close X and a mute toggle. No Call / Invite bar, no side rail and no information sheet (those belong to the Reels feed).
/// Replaces the old full-screen swipe viewer.
class ReelPreview extends StatefulWidget {
  const ReelPreview({super.key, required this.reel});

  final FeedReel reel;

  /// Opens the preview over the current screen.
  static Future<void> open(BuildContext context, FeedReel reel) =>
      Navigator.of(context).push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => ReelPreview(reel: reel)));

  @override
  State<ReelPreview> createState() => _ReelPreviewState();
}

class _ReelPreviewState extends State<ReelPreview> {
  bool _muted = false;

  Widget _round({required Key key, required String label, required IconData icon, required VoidCallback onTap}) => Semantics(
        button: true,
        label: label,
        child: InkWell(
          key: key,
          borderRadius: BorderRadius.circular(24),
          onTap: onTap,
          child: Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(shape: BoxShape.circle, color: C.cinema.withValues(alpha: 0.6)),
            child: Icon(icon, color: C.ivory, size: 26),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top + 10;
    return Scaffold(
      key: const ValueKey('reel-preview'),
      backgroundColor: C.cinema,
      body: Stack(
        fit: StackFit.expand,
        children: [
          ReelPlayer(key: ValueKey('preview-${widget.reel.id}'), reel: widget.reel, active: true, muted: _muted),
          Positioned(
            top: top,
            left: 16,
            child: _round(
              key: const ValueKey('preview-close'),
              label: 'Close',
              icon: Icons.close_rounded,
              onTap: () => Navigator.of(context).maybePop(),
            ),
          ),
          Positioned(
            top: top,
            right: 16,
            child: _round(
              key: const ValueKey('preview-mute'),
              label: _muted ? 'Unmute' : 'Mute',
              icon: _muted ? Icons.volume_off_rounded : Icons.volume_up_rounded,
              onTap: () => setState(() => _muted = !_muted),
            ),
          ),
        ],
      ),
    );
  }
}
