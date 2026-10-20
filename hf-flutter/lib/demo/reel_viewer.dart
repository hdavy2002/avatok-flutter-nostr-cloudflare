import 'package:flutter/material.dart';

import '../data/models/reel.dart';
import 'reel_player.dart';
import 'reels_real.dart';
import 'theme.dart';

/// Full-screen player for the videos on a profile (HF-WIRE-4): swipe up or down, the visible one plays, the next one is readied.
class ReelViewer extends StatefulWidget {
  const ReelViewer({super.key, required this.reels, this.start = 0});

  final List<FeedReel> reels;
  final int start;

  @override
  State<ReelViewer> createState() => _ReelViewerState();
}

class _ReelViewerState extends State<ReelViewer> {
  late final PageController _pager = PageController(initialPage: widget.start);
  late int _index = widget.start;

  @override
  void dispose() {
    _pager.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.cinema,
      body: Stack(
        children: [
          PageView.builder(
            controller: _pager,
            scrollDirection: Axis.vertical,
            itemCount: widget.reels.length,
            onPageChanged: (i) => setState(() => _index = i),
            itemBuilder: (_, i) {
              final r = widget.reels[i];
              return Stack(
                fit: StackFit.expand,
                children: [
                  ReelPlayer(reel: r, active: i == _index, preload: i == _index + 1),
                  const IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Color(0x001A0B26), Color(0x001A0B26), Color(0xE61A0B26)],
                          stops: [0, 0.7, 1],
                        ),
                      ),
                      child: SizedBox.expand(),
                    ),
                  ),
                  Positioned(
                    left: 22,
                    right: 22,
                    // Above the phone's own navigation bar.
                    bottom: 28 + MediaQuery.paddingOf(context).bottom,
                    child: IgnorePointer(child: Text('${r.caption}\n▶ ${compactCount(r.views)}', style: t(15, color: C.ivory, w: FontWeight.w600, h: 1.4))),
                  ),
                ],
              );
            },
          ),
          Positioned(
            top: MediaQuery.paddingOf(context).top + 10,
            left: 16,
            child: Semantics(
              button: true,
              label: 'Close',
              child: InkWell(
                key: const ValueKey('viewer-close'),
                borderRadius: BorderRadius.circular(24),
                onTap: () => Navigator.of(context).maybePop(),
                child: Container(
                  width: 48,
                  height: 48,
                  decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0x991A0B26)),
                  child: const Icon(Icons.close_rounded, color: C.ivory, size: 26),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
