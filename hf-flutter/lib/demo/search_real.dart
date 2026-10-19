import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/brand.dart';
import '../data/api_exception.dart';
import '../data/models/reel.dart';
import '../data/models/search.dart';
import '../data/repos/search_repo.dart';
import '../ui/async_view.dart';
import 'reels_real.dart';
import 'theme.dart';
import 'widgets.dart';

/// The real Search screen (HF-WIRE-9): `GET /api/hf/search` debounced 350 ms, results Online then Offline,
/// "Most-wanted, not here yet" with INVITE votes, and topic chips from `GET /api/hf/options`.
class RealSearch extends StatefulWidget {
  const RealSearch({super.key, required this.repo, this.debounce = const Duration(milliseconds: 350)});

  final SearchRepo repo;
  final Duration debounce;

  @override
  State<RealSearch> createState() => _RealSearchState();
}

class _RealSearchState extends State<RealSearch> {
  final _q = TextEditingController();
  Timer? _timer;
  int _run = 0;
  String? _topic;
  AsyncState<SearchResult> _state = const AsyncLoading();
  List<TopicOption> _topics = const [];
  List<MissingCreator> _top = const [];
  final Set<String> _voted = {};
  final Map<String, int> _votes = {};

  bool get _browsing => _q.text.trim().isEmpty && _topic == null;

  @override
  void initState() {
    super.initState();
    unawaited(_loadHome());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _loadHome() async {
    unawaited(widget.repo.topics().then((t) {
      if (mounted) setState(() => _topics = t);
    }).catchError((_) {}));
    unawaited(widget.repo.topInvites().then((t) {
      if (mounted) setState(() => _top = t);
    }).catchError((_) {}));
    await _search();
  }

  void _onChanged(String _) {
    setState(() {});
    _timer?.cancel();
    _timer = Timer(widget.debounce, () => unawaited(_search()));
  }

  Future<void> _search() async {
    final run = ++_run;
    setState(() => _state = const AsyncLoading());
    AsyncState<SearchResult> next;
    try {
      next = AsyncData(await widget.repo.search(_q.text, topic: _topic));
    } catch (e) {
      next = AsyncFailure(e);
    }
    if (!mounted || run != _run) return; // a newer search is on its way
    setState(() => _state = next);
  }

  void _pickTopic(String? slug) {
    _timer?.cancel();
    setState(() => _topic = _topic == slug ? null : slug);
    unawaited(_search());
  }

  Future<void> _vote(MissingCreator c) async {
    try {
      final total = await widget.repo.vote(c);
      if (!mounted) return;
      setState(() {
        _voted.add(c.key);
        _votes[c.key] = total;
      });
      toast(context, 'Voted! We will ask ${c.handle} to join.');
    } on ApiException catch (e) {
      if (mounted) toast(context, e.userMessage);
    } catch (_) {
      if (mounted) toast(context, ApiException.genericText);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.text.trim();
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
          children: [
            const Headline(solid: 'FIND', outline: 'YOUR PERSON', size: 40),
            const SizedBox(height: 14),
            TextField(
              key: const ValueKey('search-field'),
              controller: _q,
              onChanged: _onChanged,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) {
                _timer?.cancel();
                unawaited(_search());
              },
              style: t(17, w: FontWeight.w700),
              decoration: InputDecoration(
                hintText: 'Name, @handle or topic',
                prefixIcon: const Icon(Icons.search_rounded, color: C.maroon),
                suffixIcon: q.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear',
                        icon: const Icon(Icons.close_rounded, color: C.maroon),
                        onPressed: () {
                          _q.clear();
                          _onChanged('');
                        },
                      ),
              ),
            ),
            const SizedBox(height: 16),
            if (_topics.isNotEmpty) ...[
              Text('Try a topic', style: t(18, color: C.maroon)),
              const SizedBox(height: 10),
              SizedBox(
                height: 44,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    for (final topic in _topics.take(16))
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          key: ValueKey('topic-${topic.slug}'),
                          label: Text(topic.label, style: t(15, color: _topic == topic.slug ? C.deep : C.maroon)),
                          selected: _topic == topic.slug,
                          selectedColor: C.marigold,
                          backgroundColor: C.paper,
                          shape: const StadiumBorder(side: BorderSide(color: C.maroon, width: 2)),
                          onSelected: (_) => _pickTopic(topic.slug),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 18),
            ],
            AsyncView<SearchResult>(
              state: _state,
              onRetry: () => unawaited(_search()),
              isEmpty: (r) => !_browsing && r.isEmpty,
              emptyTitle: 'No one found',
              emptyMessage: 'Try another name, or type their @handle to ask them to join.',
              builder: (context, r) => _browsing ? _home(context, r) : _results(context, r),
            ),
          ],
        ),
      ),
    );
  }

  /// Nothing typed: who is online, and who fans want most.
  Widget _home(BuildContext context, SearchResult r) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Online now', style: t(18, color: C.maroon)),
        const SizedBox(height: 10),
        if (r.online.isEmpty)
          Text('No one is online right now.', style: t(15, color: C.muted, w: FontWeight.w700))
        else
          SizedBox(
            height: 104,
            child: ListView(
              key: const ValueKey('online-row'),
              scrollDirection: Axis.horizontal,
              children: [
                for (final h in r.online)
                  Padding(
                    padding: const EdgeInsets.only(right: 14),
                    child: GestureDetector(
                      onTap: () => context.push('/profile/${h.slug}'),
                      child: Column(
                        children: [
                          Avatar(influencerFromHost(h), size: 70),
                          const SizedBox(height: 6),
                          Text(h.name.split(' ').first, style: t(13)),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        if (_top.isNotEmpty) ...[
          const SizedBox(height: 18),
          Text('Most-wanted, not here yet', style: t(18, color: C.maroon)),
          const SizedBox(height: 4),
          Text('Tap Invite to vote. We ask the top names to join.', style: t(14, color: C.muted, w: FontWeight.w700)),
          const SizedBox(height: 8),
          for (final c in _top) _missingRow(c),
        ],
      ],
    );
  }

  /// Something typed (or a topic picked): Online first, then Offline, then people who are not on the app.
  Widget _results(BuildContext context, SearchResult r) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (r.online.isNotEmpty) ...[
          _label('Online'),
          for (final h in r.online) _hitRow(context, h),
        ],
        if (r.offline.isNotEmpty) ...[
          _label('Offline'),
          for (final h in r.offline) _hitRow(context, h),
        ],
        if (r.notOnNetwork.isNotEmpty) ...[
          _label('Not on ${Brand.name} yet'),
          for (final c in r.notOnNetwork) _missingRow(c),
        ],
      ],
    );
  }

  Widget _label(String s) => Padding(padding: const EdgeInsets.only(top: 6, bottom: 4), child: Text(s, style: t(18, color: C.maroon)));

  Widget _hitRow(BuildContext context, ReelHost h) {
    return InkWell(
      key: ValueKey('hit-${h.slug}'),
      onTap: () => context.push('/profile/${h.slug}'),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.sandLine, width: 2))),
        child: Row(
          children: [
            Avatar(influencerFromHost(h), size: 54, ring: h.online),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(h.name, style: t(17)),
                  Text('${h.handle ?? ''}${h.handle == null ? '' : ' · '}₹${h.rateRupees}/min', style: t(14, color: C.tan)),
                ],
              ),
            ),
            StatusPill(online: h.online, dark: h.online),
          ],
        ),
      ),
    );
  }

  Widget _missingRow(MissingCreator c) {
    final voted = _voted.contains(c.key);
    final votes = _votes[c.key] ?? c.votes;
    return Container(
      key: ValueKey('missing-${c.key}'),
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
                Text(c.handle, style: t(17)),
                Text('Not on ${Brand.name} · $votes votes', style: t(13, color: C.muted, w: FontWeight.w700)),
              ],
            ),
          ),
          SizedBox(
            height: 44,
            child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: voted ? C.sand : C.marigold, foregroundColor: C.deep, shape: const StadiumBorder()),
              onPressed: voted ? null : () => requireAccount(context, () => unawaited(_vote(c)), reason: 'to vote'),
              child: Text(voted ? 'VOTED' : 'INVITE', style: t(14, color: C.deep, ls: 0.06)),
            ),
          ),
        ],
      ),
    );
  }
}
