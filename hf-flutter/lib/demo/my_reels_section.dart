import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../data/api_exception.dart';
import '../data/models/reel.dart';
import '../data/repos/reels_repo.dart';
import '../data/services.dart';
import '../ui/net_image.dart';
import 'reels_real.dart';
import 'theme.dart';
import 'widgets.dart';

/// Influencer Home, "My reels" (HF-WIRE-4, rule HF-REEL-27): her imported videos start hidden; she picks which ones fans
/// see in the feed with Show on feed / Hide. Real mode only (demo mode keeps the dummy strip).
class MyReelsSection extends StatefulWidget {
  const MyReelsSection({super.key, this.repo});

  /// Tests pass a repo on a fake API.
  final ReelsRepo? repo;

  @override
  State<MyReelsSection> createState() => _MyReelsSectionState();
}

const String kPickReelsText = 'All your public videos are shown. Hide any you do not want fans to see.';

class _MyReelsSectionState extends State<MyReelsSection> {
  late final ReelsRepo _repo = widget.repo ?? Services.instance.reelsRepo;
  List<MyReel>? _reels;
  Object? _error;
  final Set<String> _busy = {};

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final r = await _repo.mine();
      if (mounted) setState(() => _reels = r);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _toggle(MyReel r) async {
    if (_busy.contains(r.id)) return;
    final want = !r.visible;
    _busy.add(r.id);
    _swap(r.id, want); // optimistic
    try {
      await _repo.setVisible(r.id, want);
    } catch (e) {
      _swap(r.id, !want); // roll back
      if (mounted) toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    } finally {
      _busy.remove(r.id);
    }
  }

  void _swap(String id, bool visible) {
    if (!mounted) return;
    setState(() => _reels = [for (final x in _reels ?? const <MyReel>[]) x.id == id ? x.copyWith(visible: visible) : x]);
  }

  @override
  Widget build(BuildContext context) {
    final reels = _reels;
    final on = reels?.where((r) => r.visible).length ?? 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text('My reels', style: t(20, color: C.maroon))),
            TextButton(onPressed: () => context.push('/inf/channels'), child: Text('Social media verification', style: t(15, color: C.maroon))),
          ],
        ),
        const SizedBox(height: 4),
        Text(kPickReelsText, style: t(14, color: C.muted, w: FontWeight.w700)),
        if (reels != null && reels.isNotEmpty) ...[
          const SizedBox(height: 2),
          Text('$on of ${reels.length} are in the feed.', key: const ValueKey('reels-count'), style: t(14, color: C.muted, w: FontWeight.w700)),
        ],
        const SizedBox(height: 10),
        if (_error != null)
          Row(children: [
            Expanded(child: Text(_error is ApiException ? (_error! as ApiException).userMessage : ApiException.genericText, style: t(14, color: C.ruby, w: FontWeight.w700))),
            TextButton(onPressed: () => unawaited(_load()), child: Text('Try again', style: t(15, color: C.maroon))),
          ])
        else if (reels == null)
          const SizedBox(height: 60, child: Center(child: CircularProgressIndicator(color: C.maroon)))
        else if (reels.isEmpty)
          Text('No videos yet. Sign in with YouTube and we bring in your public videos.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.35))
        else
          SizedBox(
            height: 210,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: reels.length,
              separatorBuilder: (_, __) => const SizedBox(width: 10),
              itemBuilder: (_, i) => _tile(reels[i]),
            ),
          ),
      ],
    );
  }

  Widget _tile(MyReel r) {
    return SizedBox(
      width: 112,
      child: Column(
        children: [
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  r.thumbUrl == null
                      ? const ColoredBox(color: C.cinema)
                      : NetImage(r.thumbUrl!, fit: BoxFit.cover, fallback: const ColoredBox(color: C.cinema)),
                  if (r.visible) const Positioned(top: 6, right: 6, child: Icon(Icons.check_circle_rounded, color: C.lemon, size: 22)),
                  Positioned(left: 6, bottom: 6, child: Text('▶ ${compactCount(r.views)}', style: t(14, color: C.ivory))),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          Semantics(
            button: true,
            label: r.visible ? 'Hide this video from the feed' : 'Show this video on the feed',
            child: InkWell(
              key: ValueKey('toggle-${r.id}'),
              borderRadius: BorderRadius.circular(10),
              onTap: () => unawaited(_toggle(r)),
              child: Container(
                height: 48,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: r.visible ? C.paper : C.marigold,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: r.visible ? C.maroon : C.marigold, width: 2),
                ),
                child: Text(r.visible ? 'Hide' : 'Show on feed', style: t(14, color: r.visible ? C.maroon : C.deep)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
