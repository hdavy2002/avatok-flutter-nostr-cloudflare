import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/models/reel.dart';
import '../../data/repos/search_repo.dart';
import '../reel_viewer.dart';
import '../reels_real.dart';
import '../theme.dart';
import '../widgets.dart';
import 'feed.dart';

/// [HF-REELS-FAV-1] Extra passed with `/creator/:platform/:handle`: the creator plus the reels of theirs we already hold.
class InviteProfileArgs {
  const InviteProfileArgs({required this.creator, this.reels = const []});

  final InviteCreator creator;
  final List<FeedReel> reels;
}

/// The location of the page for a creator who is not on the app yet.
String creatorPath(InviteCreator c) => '/creator/${Uri.encodeComponent(c.platform)}/${Uri.encodeComponent(c.handle)}';

/// Profile-style page for a creator who is NOT on the app yet (HF-REEL-9 / HF-REEL-40): name, handle, followers,
/// their reels we already hold, and VOTE TO INVITE instead of Call / Book. [HF-REEL-CALL-2]
class InviteProfileScreen extends StatelessWidget {
  const InviteProfileScreen({super.key, required this.creator, this.reels = const [], this.searchRepo});

  final InviteCreator creator;
  final List<FeedReel> reels;
  final SearchRepo? searchRepo;

  String get _title => creator.name.isNotEmpty ? creator.name : creator.handle;

  @override
  Widget build(BuildContext context) {
    final who = influencerFromHost(
      ReelHost(slug: '', name: _title, handle: creator.handle, avatar: creator.avatar, followers: creator.followers),
      videos: reels.length,
    );
    final platformName = creator.platform == 'instagram' ? 'Instagram' : 'YouTube';
    return Scaffold(
      key: const ValueKey('invite-profile'),
      backgroundColor: C.cream,
      body: CustomScrollView(
        slivers: [
          SliverToBoxAdapter(
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Container(
                  height: 210,
                  width: double.infinity,
                  decoration: BoxDecoration(gradient: RadialGradient(center: const Alignment(0.2, -0.4), radius: 1.3, colors: [who.tones.first, who.tones.last, C.cinema])),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 22,
                  child: Art('profile/gota-border.webp', fit: BoxFit.fitHeight, alignment: Alignment.centerLeft, fallback: const ColoredBox(color: C.maroon)),
                ),
                Positioned(top: MediaQuery.paddingOf(context).top + 10, left: 16, child: const BackBtn()),
                Positioned(left: 22, bottom: -62, child: Avatar(who, size: 124)),
              ],
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(22, 76, 22, 0),
            sliver: SliverList.list(
              children: [
                Text(_title, style: t(32, color: C.maroon, ls: 0.03, h: 1.05)),
                const SizedBox(height: 4),
                Text('${creator.handle} · $platformName', style: t(15, color: C.tan)),
                const SizedBox(height: 10),
                Container(
                  key: const ValueKey('not-on-pill'),
                  alignment: Alignment.centerLeft,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(color: C.sand, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.maroon, width: 1.5)),
                    child: Text('Vote to invite', style: t(14, color: C.deep)), // [HF-REEL-CALL-2]
                  ),
                ),
                const SizedBox(height: 16),
                Container(
                  decoration: const BoxDecoration(border: Border.symmetric(horizontal: BorderSide(color: C.deep, width: 3))),
                  child: IntrinsicHeight(
                    child: Row(
                      children: [
                        _stat('Followers', compactCount(creator.followers)),
                        const VerticalDivider(color: C.brass, width: 2, thickness: 2),
                        _stat('Videos', '${reels.length}'),
                        const VerticalDivider(color: C.brass, width: 2, thickness: 2),
                        Expanded(child: _VotesStat(creator: creator, searchRepo: searchRepo)), // [HF-VOTE-COUNT-1]
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                InviteButton(creator: creator, repo: searchRepo),
                const SizedBox(height: 8),
                // [HF-REEL-CALL-2]
                Text("$_title isn't on ${Brand.name} yet. Your vote tells us to invite them.", key: const ValueKey('invite-helper'), style: t(14, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 22),
                Container(
                  decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sand, width: 3))),
                  child: Container(
                    height: 48,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.marigold, width: 4))),
                    child: Text('Videos', style: t(17, color: C.maroon)),
                  ),
                ),
                const SizedBox(height: 14),
              ],
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(22, 0, 22, 40),
            sliver: reels.isEmpty
                ? SliverToBoxAdapter(child: Text('No videos yet.', key: const ValueKey('invite-no-videos'), style: t(15, color: C.muted, w: FontWeight.w700)))
                : SliverGrid.builder(
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, mainAxisSpacing: 6, crossAxisSpacing: 6, childAspectRatio: 0.62),
                    itemCount: reels.length,
                    itemBuilder: (_, i) {
                      final r = reels[i];
                      return Semantics(
                        button: true,
                        label: 'Watch video ${i + 1}',
                        child: GestureDetector(
                          key: ValueKey('video-${r.id}'),
                          onTap: () => ReelPreview.open(context, r), // [HF-REEL-CALL-2] a light preview: video, close and mute only
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: Stack(
                              fit: StackFit.expand,
                              children: [
                                r.thumbUrl == null
                                    ? const ColoredBox(color: C.cinema)
                                    : Image.network(r.thumbUrl!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const ColoredBox(color: C.cinema)),
                                Positioned(left: 6, bottom: 6, child: Text('▶ ${compactCount(r.views)}', style: t(14, color: C.ivory))),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _stat(String label, String value) => Expanded(child: _statBody(label, value));
}

Widget _statBody(String label, String value) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Column(
      children: [
        Text(label, style: t(14, color: C.tan)),
        const SizedBox(height: 2),
        FittedBox(child: Text(value, style: t(22, color: C.maroon))),
      ],
    ),
  );
}

/// [HF-VOTE-COUNT-1] The Votes number on a not-yet-here creator's page. It used to show the count carried in from the
/// (cached) reels feed and never changed, so a signed-in vote stayed at 0 on screen although the server counted it.
/// Now it reads the live total when the page opens and follows the total the server returns after a vote.
class _VotesStat extends StatefulWidget {
  const _VotesStat({required this.creator, this.searchRepo});

  final InviteCreator creator;
  final SearchRepo? searchRepo;

  @override
  State<_VotesStat> createState() => _VotesStatState();
}

class _VotesStatState extends State<_VotesStat> {
  int? _live;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final repo = widget.searchRepo;
    if (repo == null) return; // no repo (previews / tests): keep the count we were given
    final v = await repo.voteCount(widget.creator.platform, widget.creator.handle);
    if (v != null && mounted) setState(() => _live = v);
  }

  @override
  Widget build(BuildContext context) {
    final key = widget.creator.key;
    return ValueListenableBuilder<int>(
      valueListenable: InviteVotes.changed,
      builder: (_, __, ___) {
        var n = widget.creator.votes;
        if (_live != null && _live! > n) n = _live!;
        final after = InviteVotes.totals[key];
        if (after != null && after > n) n = after;
        if (n == 0 && InviteVotes.voted.contains(key)) n = 1; // our own vote always counts
        return _statBody('Votes', '$n');
      },
    );
  }
}

/// Builds the page from a route: the extra when we have it, else just the path (a shared link or a restored app).
Widget inviteProfileFromRoute(GoRouterState s, {SearchRepo? searchRepo}) {
  final extra = s.extra;
  if (extra is InviteProfileArgs) return InviteProfileScreen(creator: extra.creator, reels: extra.reels, searchRepo: searchRepo);
  final handle = s.pathParameters['handle'] ?? '';
  return InviteProfileScreen(
    creator: InviteCreator(platform: s.pathParameters['platform'] ?? 'youtube', handle: handle.startsWith('@') ? handle : '@$handle'),
    searchRepo: searchRepo,
  );
}
