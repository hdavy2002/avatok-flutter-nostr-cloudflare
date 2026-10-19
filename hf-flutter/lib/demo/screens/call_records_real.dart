import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/models/call.dart';
import '../../data/repos/calls_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../theme.dart';
import '../widgets.dart';
import 'call_real.dart';

const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "Today, 6:42 pm", "Mon, 9:10 pm" (this week) or "12 Oct, 9:10 pm".
String callWhen(int ms, {DateTime? now}) {
  final at = DateTime.fromMillisecondsSinceEpoch(ms);
  final n = now ?? DateTime.now();
  final h = at.hour % 12 == 0 ? 12 : at.hour % 12;
  final time = '$h:${at.minute.toString().padLeft(2, '0')} ${at.hour >= 12 ? 'pm' : 'am'}';
  final today = DateTime(n.year, n.month, n.day);
  final day = DateTime(at.year, at.month, at.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return 'Today, $time';
  if (diff == 1) return 'Yesterday, $time';
  if (diff > 1 && diff < 7) return '${_days[at.weekday - 1]}, $time';
  return '${at.day} ${_months[at.month - 1]}, $time';
}

/// Call records from the server (HF-WIRE-7): every outcome, newest first, loaded a page at a time.
class RealCallRecordsScreen extends StatefulWidget {
  const RealCallRecordsScreen({super.key, this.repo});

  final CallsRepo? repo;

  @override
  State<RealCallRecordsScreen> createState() => _RealCallRecordsScreenState();
}

class _RealCallRecordsScreenState extends State<RealCallRecordsScreen> {
  AsyncState<List<CallRecordItem>> _state = const AsyncLoading();
  String? _cursor;
  bool _more = false;
  String? _moreError;
  final _scroll = ScrollController();

  CallsRepo get _repo => widget.repo ?? Services.instance.callsRepo;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.hasClients && _scroll.position.extentAfter < 240) unawaited(_loadMore());
    });
    unawaited(_load());
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final page = await _repo.history();
      if (!mounted) return;
      setState(() {
        _cursor = page.nextCursor;
        _state = AsyncData(page.items);
      });
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _loadMore() async {
    final s = _state;
    final cursor = _cursor;
    if (_more || cursor == null || s is! AsyncData<List<CallRecordItem>>) return;
    setState(() {
      _more = true;
      _moreError = null;
    });
    try {
      final page = await _repo.history(cursor: cursor);
      if (!mounted) return;
      setState(() {
        _cursor = page.nextCursor;
        _state = AsyncData([...s.value, ...page.items]);
      });
    } catch (e) {
      if (mounted) setState(() => _moreError = e is ApiException ? e.userMessage : ApiException.genericText);
    } finally {
      if (mounted) setState(() => _more = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const PageHeader(title: 'Call records'),
            Expanded(
              child: AsyncView<List<CallRecordItem>>(
                state: _state,
                onRetry: () => unawaited(_load()),
                emptyTitle: 'No calls yet',
                emptyMessage: 'Calls you make will show up here.',
                builder: (context, items) => ListView(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(22, 8, 22, 24),
                  children: [
                    for (final c in items) _Row(c),
                    if (_cursor != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Column(
                          children: [
                            if (_moreError != null) Text(_moreError!, textAlign: TextAlign.center, style: t(14, color: C.ruby)),
                            const SizedBox(height: 6),
                            ChunkyButton(label: _more ? 'LOADING…' : 'LOAD MORE', filled: false, onTap: _more ? null : () => unawaited(_loadMore())),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.c);

  final CallRecordItem c;

  String get _detail {
    if (c.didNotConnect) {
      return switch (c.reason) {
        'declined' => "Didn't connect · declined",
        'missed' => "Didn't connect · no answer",
        'busy' => "Didn't connect · busy",
        _ => "Didn't connect",
      };
    }
    return '${callWhen(c.at)} · ${c.minutes} min';
  }

  @override
  Widget build(BuildContext context) {
    final who = callPerson(c.hostSlug, c.hostName);
    final cost = c.amountPaise;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: C.paper, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.sand, width: 2)),
      child: Row(
        children: [
          Avatar(who, size: 50, ring: false),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(c.hostName, style: t(16)),
                if (c.didNotConnect) Text(callWhen(c.at), style: t(13, color: C.muted, w: FontWeight.w700)),
                Text(_detail, style: t(13, color: C.muted, w: FontWeight.w700)),
                if (c.stars > 0) Text('★' * c.stars, style: t(14, color: C.marigold)),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(cost == null || c.didNotConnect ? '₹0' : '-${paiseText(cost)}', style: t(16, color: C.ruby)),
              const SizedBox(height: 4),
              if (c.hostSlug != null)
                GestureDetector(
                  onTap: () => context.push('/profile/${c.hostSlug}'),
                  child: Text('Call again', style: t(13, color: C.maroon)),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
