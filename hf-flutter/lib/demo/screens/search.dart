import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/repos/search_repo.dart';
import '../../data/services.dart';
import '../data.dart';
import '../presence_bridge.dart';
import '../search_real.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';

/// Search (HF-REEL-9): Online / Offline / Not on the app. Invite = a vote to bring them in.
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, this.repo});

  /// Tests pass a repo on a fake API; the app uses [Services]. Real mode only (HF-WIRE-9).
  final SearchRepo? repo;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _q = TextEditingController();

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (PresenceBridge.real) return RealSearch(repo: widget.repo ?? Services.instance.searchRepo); // [HF-WIRE-9]
    final q = _q.text.trim().toLowerCase();
    final hits = q.isEmpty
        ? <Influencer>[]
        : influencers.where((i) => i.name.toLowerCase().contains(q) || i.handle.contains(q) || i.niche.toLowerCase().contains(q)).toList();
    final missing = q.isEmpty
        ? <String>[]
        : [
            ...notOnNetwork.where((h) => h.contains(q.replaceAll(' ', ''))),
            if (hits.isEmpty && !notOnNetwork.any((h) => h.contains(q.replaceAll(' ', '')))) '@${q.replaceAll(' ', '').replaceAll('@', '')}',
          ];
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) => ListView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
            children: [
              const Headline(solid: 'FIND', outline: 'YOUR PERSON', size: 40),
              const SizedBox(height: 14),
              TextField(
                controller: _q,
                onChanged: (_) => setState(() {}),
                textInputAction: TextInputAction.search,
                style: t(17, w: FontWeight.w700),
                decoration: InputDecoration(
                  hintText: 'Name, @handle or topic',
                  prefixIcon: const Icon(Icons.search_rounded, color: C.maroon),
                  suffixIcon: q.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear',
                          icon: const Icon(Icons.close_rounded, color: C.maroon),
                          onPressed: () => setState(_q.clear),
                        ),
                ),
              ),
              const SizedBox(height: 20),
              if (q.isEmpty) ...[
                Text('Online now', style: t(18, color: C.maroon)),
                const SizedBox(height: 10),
                SizedBox(
                  height: 104,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: [
                      for (final i in influencers.where((i) => i.online))
                        Padding(
                          padding: const EdgeInsets.only(right: 14),
                          child: GestureDetector(
                            onTap: () => context.push('/profile/${i.id}'),
                            child: Column(
                              children: [
                                Avatar(i, size: 70),
                                const SizedBox(height: 6),
                                Text(i.name.split(' ').first, style: t(14)),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 18),
                Text('Most-wanted, not here yet', style: t(18, color: C.maroon)),
                const SizedBox(height: 4),
                Text('Tap Invite to vote. We ask the top names to join.', style: t(14, color: C.muted, w: FontWeight.w700)),
                const SizedBox(height: 8),
                for (final h in notOnNetwork) _missingRow(h),
                const SizedBox(height: 18),
                Text('Try a topic', style: t(18, color: C.maroon)),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final topic in ['cooking', 'fitness', 'travel', 'comedy', 'gaming', 'cricket', 'makeup', 'music'])
                      ActionChip(
                        label: Text(topic, style: t(15, color: C.maroon)),
                        backgroundColor: C.paper,
                        shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
                        onPressed: () => setState(() => _q.text = topic),
                      ),
                  ],
                ),
              ] else ...[
                for (final i in hits) _hitRow(i),
                for (final h in missing) _missingRow(h),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _hitRow(Influencer i) {
    return InkWell(
      onTap: () => context.push('/profile/${i.id}'),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sandLine, width: 2))),
        child: Row(
          children: [
            Avatar(i, size: 54, ring: i.online),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(i.name, style: t(17)),
                  Text('${i.handle} · ₹${i.rate}/min', style: t(14, color: C.tan)),
                ],
              ),
            ),
            StatusPill(online: i.online, dark: i.online),
          ],
        ),
      ),
    );
  }

  Widget _missingRow(String handle) {
    final voted = demo.myVotes.contains(handle);
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sandLine, width: 2))),
      child: Row(
        children: [
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(shape: BoxShape.circle, color: C.sand, border: Border.all(color: C.brass, width: 2)),
            child: const Icon(Icons.person_outline_rounded, color: C.muted),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(handle, style: t(17)),
                Text('Not on ${Brand.name} · ${demo.votesFor(handle)} votes', style: t(14, color: C.muted, w: FontWeight.w700)),
              ],
            ),
          ),
          SizedBox(
            height: 48,
            child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: voted ? C.sand : C.marigold, foregroundColor: C.deep, shape: const StadiumBorder()),
              onPressed: voted
                  ? null
                  : () => requireAccount(context, () {
                        demo.vote(handle);
                        toast(context, 'Voted! We will ask $handle to join.');
                      }, reason: 'to vote'),
              child: Text(voted ? 'VOTED' : 'INVITE', style: t(14, color: C.deep, ls: 0.06)),
            ),
          ),
        ],
      ),
    );
  }
}
