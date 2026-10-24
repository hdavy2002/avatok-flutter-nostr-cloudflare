import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/brand.dart';
import '../../data/models/reel.dart';
import '../../data/models/reel_engage.dart';
import '../../data/reel_engage_store.dart';
import '../../data/repos/reel_engage_repo.dart';
import '../../data/telemetry.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-REEL-ENGAGE-APP-1] "5 min ago" for a comment time (ms since the epoch).
String commentTimeAgo(int ms, {DateTime? now}) {
  if (ms <= 0) return '';
  final d = (now ?? DateTime.now()).difference(DateTime.fromMillisecondsSinceEpoch(ms));
  if (d.inMinutes < 1) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  if (d.inDays < 7) return '${d.inDays} d ago';
  if (d.inDays < 30) return '${d.inDays ~/ 7} w ago';
  if (d.inDays < 365) return '${d.inDays ~/ 30} mo ago';
  return '${d.inDays ~/ 365} y ago';
}

/// 2000 -> "2,000".
String groupedCount(int n) {
  final s = n.abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return n < 0 ? '-$b' : '$b';
}

/// "2,000 likes · 1,500 on YouTube · 500 on Hello Fraands" (spec section 3). Our number is never called a YouTube number.
String engageBreakdown(EngageCount likes, String platform) {
  final name = platform == 'instagram' ? 'Instagram' : 'YouTube';
  final n = likes.total;
  return '${groupedCount(n)} ${n == 1 ? 'like' : 'likes'} · ${groupedCount(likes.platform)} on $name · ${groupedCount(likes.ours)} on ${Brand.name}';
}

/// Opens the comment sheet. Resolves to true when the person asked to open the original Instagram post.
Future<bool?> showReelComments(
  BuildContext context, {
  required String reelId,
  required String platform,
  required ReelEngageApi repo,
  required ReelEngageStore store,
  bool canOpenOriginal = false,
}) {
  Telemetry.event('hf_reel_action', {'action': 'comments_open'});
  return showModalBottomSheet<bool>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    backgroundColor: C.clear,
    builder: (sheetContext) => Padding(
      // the sheet shrinks above the keyboard so the composer stays visible
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(sheetContext).bottom),
      child: ReelCommentsSheet(reelId: reelId, platform: platform, repo: repo, store: store, canOpenOriginal: canOpenOriginal),
    ),
  );
}

class ReelCommentsSheet extends StatefulWidget {
  const ReelCommentsSheet({
    super.key,
    required this.reelId,
    required this.platform,
    required this.repo,
    required this.store,
    this.canOpenOriginal = false,
  });

  final String reelId;
  final String platform;
  final ReelEngageApi repo;
  final ReelEngageStore store;
  final bool canOpenOriginal;

  @override
  State<ReelCommentsSheet> createState() => _ReelCommentsSheetState();
}

class _ReelCommentsSheetState extends State<ReelCommentsSheet> {
  final _field = TextEditingController();
  final List<ReelComment> _items = [];
  String? _next;
  bool _loading = true;
  bool _loadingMore = false;
  String? _loadError;
  String? _notice;
  bool _noticeIsError = true;
  ReelComment? _replyTo;
  ScrollController? _attached;
  int _tmp = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_first());
  }

  @override
  void dispose() {
    _attached?.removeListener(_onScroll);
    _field.dispose();
    super.dispose();
  }

  void _syncCounts(CommentsPage p) {
    final cur = widget.store.of(widget.reelId);
    if (p.likes == null && p.comments == null) return;
    widget.store.put(
      widget.reelId,
      EngageState(
        likes: p.likes ?? cur?.likes ?? const EngageCount(),
        comments: p.comments ?? cur?.comments ?? const EngageCount(),
        // a like tapped while this page loaded wins over the older answer
        liked: cur?.liked ?? p.likedByMe,
      ),
    );
  }

  Future<void> _first() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final p = await widget.repo.comments(widget.reelId);
      if (!mounted) return;
      _syncCounts(p);
      setState(() {
        _items
          ..clear()
          ..addAll(p.items);
        _next = p.nextCursor;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = engageErrorText(e, fallback: 'Could not load comments. Please try again.');
      });
    }
  }

  Future<void> _more() async {
    if (_loadingMore || _next == null) return;
    setState(() => _loadingMore = true);
    try {
      final p = await widget.repo.comments(widget.reelId, cursor: _next);
      if (!mounted) return;
      final have = {for (final c in _items) c.id};
      setState(() {
        _items.addAll(p.items.where((c) => !have.contains(c.id)));
        _next = p.nextCursor;
        _loadingMore = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _attach(ScrollController c) {
    if (identical(_attached, c)) return;
    _attached?.removeListener(_onScroll);
    _attached = c..addListener(_onScroll);
  }

  void _onScroll() {
    final c = _attached;
    if (c == null || !c.hasClients) return;
    if (c.position.pixels >= c.position.maxScrollExtent - 300) unawaited(_more());
  }

  void _say(String text, {bool error = true}) {
    if (!mounted) return;
    setState(() {
      _notice = text;
      _noticeIsError = error;
    });
  }

  void _bumpComments(int d) => widget.store.update(widget.reelId, (s) => s.copyWith(comments: s.comments.plusOurs(d)));

  Future<void> _send() async {
    final body = _field.text.trim();
    if (body.isEmpty) return;
    unawaited(requireAccount(context, () => unawaited(_doSend(body)), reason: 'to comment'));
  }

  Future<void> _doSend(String body) async {
    final reply = _replyTo;
    final parentId = reply == null ? null : (reply.parentId ?? reply.id);
    final tmpId = 'tmp_${_tmp++}';
    final temp = ReelComment(
      id: tmpId,
      authorName: 'You',
      body: body,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      mine: true,
      parentId: parentId,
    );
    setState(() {
      _notice = null;
      _field.clear();
      _replyTo = null;
      _insert(temp);
    });
    _bumpComments(1);
    Telemetry.event('hf_reel_action', {'action': 'comment_send'});
    try {
      final sent = await widget.repo.send(widget.reelId, body, parentId: parentId);
      // the server's numbers win over our +1
      final cc = sent.comments;
      if (cc != null) widget.store.update(widget.reelId, (s) => s.copyWith(comments: cc, likes: sent.likes ?? s.likes));
      if (!mounted) return;
      setState(() => _swap(tmpId, sent.item));
    } catch (e) {
      _bumpComments(-1);
      if (!mounted) return;
      setState(() {
        _remove(tmpId);
        if (_field.text.isEmpty) _field.text = body; // give the words back
      });
      _say(engageErrorText(e, fallback: 'Could not send your comment. Please try again.'));
    }
  }

  void _insert(ReelComment c) {
    final pid = c.parentId;
    if (pid == null) {
      _items.insert(0, c);
      return;
    }
    final i = _items.indexWhere((e) => e.id == pid);
    if (i < 0) {
      _items.insert(0, c);
    } else {
      _items[i] = _items[i].withReplies([..._items[i].replies, c]);
    }
  }

  void _swap(String id, ReelComment saved) {
    for (var i = 0; i < _items.length; i++) {
      if (_items[i].id == id) {
        _items[i] = saved.withReplies(_items[i].replies);
        return;
      }
      final r = _items[i].replies.indexWhere((e) => e.id == id);
      if (r >= 0) {
        final list = [..._items[i].replies];
        list[r] = saved;
        _items[i] = _items[i].withReplies(list);
        return;
      }
    }
  }

  void _remove(String id) {
    _items.removeWhere((e) => e.id == id);
    for (var i = 0; i < _items.length; i++) {
      if (_items[i].replies.any((e) => e.id == id)) {
        _items[i] = _items[i].withReplies([for (final r in _items[i].replies) if (r.id != id) r]);
      }
    }
  }

  Future<void> _delete(ReelComment c) async {
    final before = [..._items];
    setState(() => _remove(c.id));
    _bumpComments(-1);
    try {
      await widget.repo.delete(c.id);
    } catch (e) {
      _bumpComments(1);
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(before);
      });
      _say(engageErrorText(e, fallback: 'Could not delete that comment. Please try again.'));
    }
  }

  Future<void> _report(ReelComment c) async {
    final reason = await showDialog<String>(
      context: context,
      useRootNavigator: true,
      builder: (ctx) => SimpleDialog(
        title: Text('Report this comment', style: t(18)),
        children: [
          for (final r in const [
            ('spam', 'Spam'),
            ('abuse', 'Rude or hateful'),
            ('sexual', 'Sexual content'),
            ('other', 'Something else'),
          ])
            SimpleDialogOption(
              key: ValueKey('report-${r.$1}'),
              onPressed: () => Navigator.of(ctx).pop(r.$1),
              child: Text(r.$2, style: t(16, w: FontWeight.w700)),
            ),
        ],
      ),
    );
    if (reason == null) return;
    try {
      final res = await widget.repo.report(c.id, reason);
      Telemetry.event('hf_reel_action', {'action': 'comment_report'});
      if (res.hidden && mounted) setState(() => _remove(c.id));
      _say('Thank you. We will look at it.', error: false);
    } catch (e) {
      _say(engageErrorText(e, fallback: 'Could not send your report. Please try again.'));
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      expand: false,
      builder: (context, controller) {
        _attach(controller);
        return Material(
          color: C.ivory,
          shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              _header(context),
              // [HF-REEL-IG-COMMENTS-1] no "stay on Instagram" note and no per-platform count line (owner 2026-10-24)
              Expanded(child: _list(controller)),
              if (_notice != null) _noticeBar(),
              _composer(context),
            ],
          ),
        );
      },
    );
  }

  Widget _header(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final s = widget.store.of(widget.reelId);
        final n = s?.comments.total ?? _items.length;
        return Padding(
          padding: const EdgeInsets.fromLTRB(20, 10, 8, 6),
          child: Column(
            children: [
              Container(width: 40, height: 4, decoration: BoxDecoration(color: C.brass, borderRadius: BorderRadius.circular(2))),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${groupedCount(n)} ${n == 1 ? 'comment' : 'comments'}',
                          key: const ValueKey('comments-title'),
                          style: t(20),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    key: const ValueKey('comments-close'),
                    tooltip: 'Close',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded, color: C.deep),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }


  Widget _list(ScrollController controller) {
    if (_loading) {
      return ListView(controller: controller, children: const [Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()))]);
    }
    if (_loadError != null) {
      return ListView(
        controller: controller,
        padding: const EdgeInsets.all(24),
        children: [
          Text(_loadError!, textAlign: TextAlign.center, style: t(16, w: FontWeight.w700)),
          const SizedBox(height: 8),
          Center(
            child: TextButton(key: const ValueKey('comments-retry'), onPressed: _first, child: Text('Try again', style: t(16, color: C.maroon))),
          ),
        ],
      );
    }
    if (_items.isEmpty) {
      return ListView(
        controller: controller,
        padding: const EdgeInsets.all(32),
        children: [Text('No comments yet. Be the first.', key: const ValueKey('comments-empty'), textAlign: TextAlign.center, style: t(16, color: C.muted, w: FontWeight.w700))],
      );
    }
    return ListView.builder(
      controller: controller,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      itemCount: _items.length + (_loadingMore ? 1 : 0),
      itemBuilder: (_, i) {
        if (i >= _items.length) {
          return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
        }
        final c = _items[i];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _row(c),
            for (final r in c.replies) Padding(padding: const EdgeInsets.only(left: 44), child: _row(r)),
          ],
        );
      },
    );
  }

  Widget _row(ReelComment c) {
    final label = c.sourceLabel;
    final ago = commentTimeAgo(c.createdAt);
    return Padding(
      key: ValueKey('comment-${c.id}'),
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: C.sand,
            foregroundImage: c.authorAvatar == null ? null : NetworkImage(c.authorAvatar!),
            child: Text(c.authorName.isEmpty ? '?' : c.authorName.characters.first.toUpperCase(), style: t(14, color: C.maroon)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 2,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(c.mine ? 'You' : c.authorName, style: t(14)),
                    if (label != null)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(10)),
                        child: Text(label, style: t(14, color: C.maroon, w: FontWeight.w700)),
                      ),
                    if (ago.isNotEmpty) Text(ago, style: t(14, color: C.muted, w: FontWeight.w600)),
                  ],
                ),
                const SizedBox(height: 2),
                Text(c.body, style: t(15, w: FontWeight.w600, h: 1.35)),
                Row(
                  children: [
                    TextButton(
                      key: ValueKey('reply-${c.id}'),
                      style: TextButton.styleFrom(minimumSize: const Size(48, 44), padding: const EdgeInsets.only(right: 12)),
                      onPressed: c.id.startsWith('tmp_')
                          ? null
                          : () => setState(() {
                              _replyTo = c;
                              _notice = null;
                            }),
                      child: Text('Reply', style: t(14, color: C.maroon)),
                    ),
                    const Spacer(),
                    if (!c.id.startsWith('tmp_'))
                      PopupMenuButton<String>(
                        key: ValueKey('more-${c.id}'),
                        tooltip: 'More',
                        icon: const Icon(Icons.more_horiz_rounded, color: C.muted),
                        onSelected: (v) => v == 'delete' ? unawaited(_delete(c)) : unawaited(_report(c)),
                        itemBuilder: (_) => [
                          if (c.mine)
                            PopupMenuItem(value: 'delete', child: Text('Delete', style: t(16, w: FontWeight.w700)))
                          else
                            PopupMenuItem(value: 'report', child: Text('Report', style: t(16, w: FontWeight.w700))),
                        ],
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _noticeBar() => Container(
    width: double.infinity,
    color: _noticeIsError ? C.blush : C.lavtint,
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
    child: Text(_notice!, key: const ValueKey('comments-notice'), style: t(14, color: _noticeIsError ? C.ruby : C.maroon, w: FontWeight.w700)),
  );

  Widget _composer(BuildContext context) {
    final reply = _replyTo;
    return Container(
      color: C.paper,
      padding: EdgeInsets.fromLTRB(16, 8, 12, 8 + (MediaQuery.viewInsetsOf(context).bottom > 0 ? 0 : MediaQuery.paddingOf(context).bottom)),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (reply != null)
            Row(
              children: [
                Expanded(child: Text('Replying to ${reply.mine ? 'yourself' : reply.authorName}', key: const ValueKey('replying-to'), style: t(14, color: C.muted, w: FontWeight.w700))),
                IconButton(
                  key: const ValueKey('reply-cancel'),
                  tooltip: 'Cancel reply',
                  onPressed: () => setState(() => _replyTo = null),
                  icon: const Icon(Icons.close_rounded, size: 20, color: C.muted),
                ),
              ],
            ),
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: const ValueKey('comment-field'),
                  controller: _field,
                  maxLength: 500,
                  minLines: 1,
                  maxLines: 4,
                  textCapitalization: TextCapitalization.sentences,
                  style: t(16, w: FontWeight.w600),
                  decoration: InputDecoration(
                    counterText: '',
                    hintText: 'Add a comment…',
                    hintStyle: t(16, color: C.muted, w: FontWeight.w600),
                    filled: true,
                    fillColor: C.sand,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
                  ),
                  onSubmitted: (_) => unawaited(_send()),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                key: const ValueKey('comment-send'),
                tooltip: 'Send',
                onPressed: () => unawaited(_send()),
                style: IconButton.styleFrom(backgroundColor: C.rani, minimumSize: const Size(48, 48)),
                icon: const Icon(Icons.send_rounded, color: C.white),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
