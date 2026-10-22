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
import '../desi.dart';
import '../search_kit.dart';
import 'sheets.dart';

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
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([demo, Services.instance.authAccount]),
    builder: (context, _) => (PresenceBridge.real ? Services.instance.isSignedIn : demo.signedIn)
        ? _authenticated(context)
        : const AccountInvitation(reason: 'Find your favourite creators'),
  );

  Widget _authenticated(BuildContext context) {
    if (PresenceBridge.real) return RealSearch(key: ValueKey(Services.instance.user?.id), repo: widget.repo ?? Services.instance.searchRepo); // [HF-WIRE-9]
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
    // [HF-APP-DESI-2] Layout from the owner-approved canvas preview "2 · Search".
    final offline = influencers.where((i) => !i.online).toList();
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListenableBuilder(
          listenable: demo,
          builder: (context, _) => ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              SearchHeader(
                field: SearchPill(
                  controller: _q,
                  onChanged: (_) => setState(() {}),
                  onClear: () => setState(_q.clear),
                ),
              ),
              if (q.isEmpty) ...[
                SearchTopics(
                  topics: [for (final t in const ['cooking', 'fitness', 'travel', 'comedy', 'makeup', 'music', 'cricket', 'gaming']) (t, t)],
                  onTap: (t) => setState(() => _q.text = t),
                ),
                const SizedBox(height: 14),
                OnlineNowCard(people: [for (final i in influencers.where((i) => i.online)) (i, () => context.push('/profile/${i.id}'))]),
                if (offline.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  BookTimeCard(rows: [
                    for (var k = 0; k < offline.length; k++) _hitRow(offline[k], last: k == offline.length - 1),
                  ]),
                ],
                const SizedBox(height: 14),
                MostWantedCard(rows: [for (var k = 0; k < notOnNetwork.length; k++) _missingRow(notOnNetwork[k], k + 1)]),
                const DesiMogra(),
              ] else ...[
                if (hits.isNotEmpty)
                  DesiCard(
                    title: 'Found',
                    corner: DesiCorner.marigold,
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
                    child: Column(children: [for (var k = 0; k < hits.length; k++) _hitRow(hits[k], last: k == hits.length - 1)]),
                  ),
                if (missing.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  MostWantedCard(title: 'Not on ${Brand.name} yet', rows: [for (var k = 0; k < missing.length; k++) _missingRow(missing[k], k + 1)]),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _hitRow(Influencer i, {bool last = false}) {
    return SearchPersonRow(
      who: i,
      online: i.online,
      rate: i.rate,
      last: last,
      subtitle: Text('${i.handle} · ${i.niche}', style: t(14, color: C.muted, w: FontWeight.w600)),
      onTap: () => context.push('/profile/${i.id}'),
    );
  }

  Widget _missingRow(String handle, int rank) {
    final voted = demo.myVotes.contains(handle);
    return MostWantedRow(
      rank: rank,
      handle: handle,
      votes: demo.votesFor(handle),
      voted: voted,
      onInvite: () => requireAccount(context, () {
        demo.vote(handle);
        toast(context, 'Voted! We will ask $handle to join.');
      }, reason: 'to vote'),
    );
  }
}
