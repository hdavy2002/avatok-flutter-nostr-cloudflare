import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/ava_ai_client.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../avabrain/brain_settings_screen.dart';

/// AvaBrain Memory — [AVABRAIN-CLIENT-MEM-1] (Product Bible §P1.5: "memory
/// review, correction, forget and export screens").
///
/// A paged, type-grouped list of the user's derived AvaBrain memories
/// (`GET /api/brain/memory/list`). Each row can be Confirmed, Corrected (inline
/// edit), or Forgotten. The header exposes "Export my memory"
/// (`POST /api/brain/memory/export`) and a link to the existing consent
/// toggles screen ([BrainSettingsScreen]) so the two controls a user needs
/// (what Ava remembers vs. what's actually stored) are one tap apart.
///
/// The server routes this screen calls are being built in parallel by another
/// agent — every API call already feature-detects a 404/failure
/// (`ava_ai_client.dart`'s `BrainMemoryApi`), so a not-yet-shipped backend
/// renders a graceful empty state here rather than crashing.
class BrainMemoryScreen extends StatefulWidget {
  const BrainMemoryScreen({super.key});
  @override
  State<BrainMemoryScreen> createState() => _BrainMemoryScreenState();
}

class _BrainMemoryScreenState extends State<BrainMemoryScreen> {
  List<BrainMemoryItem> _items = [];
  String? _cursor;
  bool _loading = true;
  bool _loadingMore = false;
  bool _hasMore = false;
  bool _fetchFailed = false;
  bool _exporting = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avatok', 'avabrain_memory');
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final page = await BrainMemoryApi.list();
    if (!mounted) return;
    setState(() {
      _items = page.items;
      _cursor = page.nextCursor;
      _hasMore = page.ok && page.nextCursor != null && page.nextCursor!.isNotEmpty;
      _fetchFailed = !page.ok;
      _loading = false;
    });
    Analytics.capture('avabrain_memory_listed', {
      'count': _items.length,
      'ok': page.ok,
    });
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore) return;
    setState(() => _loadingMore = true);
    final page = await BrainMemoryApi.list(cursor: _cursor);
    if (!mounted) return;
    setState(() {
      if (page.ok) _items = [..._items, ...page.items];
      _cursor = page.nextCursor;
      _hasMore = page.ok && page.nextCursor != null && page.nextCursor!.isNotEmpty;
      _loadingMore = false;
    });
  }

  Map<String, List<BrainMemoryItem>> get _grouped {
    final out = <String, List<BrainMemoryItem>>{};
    for (final it in _items) {
      out.putIfAbsent(it.type, () => []).add(it);
    }
    return out;
  }

  Future<void> _confirm(BrainMemoryItem item) async {
    final start = DateTime.now().millisecondsSinceEpoch;
    final ok = await BrainMemoryApi.confirm(item.id);
    await Analytics.uiInteraction('avabrain_memory_confirmed',
        DateTime.now().millisecondsSinceEpoch - start,
        extra: {'ok': ok, 'type': item.type});
    if (!mounted) return;
    if (ok) {
      setState(() {
        final i = _items.indexWhere((e) => e.id == item.id);
        if (i >= 0) {
          _items[i] = BrainMemoryItem(
            id: item.id,
            content: item.content,
            type: item.type,
            confidence: item.confidence,
            sourceDomain: item.sourceDomain,
            userConfirmed: true,
            createdAt: item.createdAt,
          );
        }
      });
    } else {
      _showSnack('Could not confirm right now.');
    }
  }

  Future<void> _correct(BrainMemoryItem item) async {
    final ctrl = TextEditingController(text: item.content);
    final newText = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Correct this memory', style: ADText.threadName(c: AD.textPrimary)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLines: 4,
          minLines: 2,
          style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
              fontSize: 14, color: AD.textPrimary),
          decoration: InputDecoration(hintText: 'What should Ava remember instead?',
              hintStyle: ADText.preview(c: AD.textTertiary)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Cancel', style: ADText.preview(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: Text('Save', style: ADText.preview(c: AD.iconSearch))),
        ],
      ),
    );
    if (newText == null || newText.isEmpty || newText == item.content) return;
    final start = DateTime.now().millisecondsSinceEpoch;
    final ok = await BrainMemoryApi.correct(item.id, newText);
    await Analytics.uiInteraction('avabrain_memory_corrected',
        DateTime.now().millisecondsSinceEpoch - start,
        extra: {'ok': ok, 'type': item.type});
    if (!mounted) return;
    if (ok) {
      setState(() {
        final i = _items.indexWhere((e) => e.id == item.id);
        if (i >= 0) {
          _items[i] = BrainMemoryItem(
            id: item.id,
            content: newText,
            type: item.type,
            confidence: item.confidence,
            sourceDomain: item.sourceDomain,
            userConfirmed: true,
            createdAt: item.createdAt,
          );
        }
      });
    } else {
      _showSnack('Could not save the correction right now.');
    }
  }

  Future<void> _forget(BrainMemoryItem item) async {
    final ok0 = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Forget this memory?', style: ADText.threadName(c: AD.textPrimary)),
        content: Text(
            'Ava will stop using "${item.content}" to answer you. This can’t be undone.',
            style: ADText.preview()),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
              child: Text('Cancel', style: ADText.preview(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, true),
              child: Text('Forget', style: ADText.preview(c: AD.danger))),
        ],
      ),
    );
    if (ok0 != true) return;
    final start = DateTime.now().millisecondsSinceEpoch;
    final ok = await BrainMemoryApi.forget(item.id);
    await Analytics.uiInteraction('avabrain_memory_forgotten',
        DateTime.now().millisecondsSinceEpoch - start,
        extra: {'ok': ok, 'type': item.type});
    if (!mounted) return;
    if (ok) {
      setState(() => _items.removeWhere((e) => e.id == item.id));
      Analytics.capture('avabrain_memory_deleted', {'type': item.type});
    } else {
      _showSnack('Could not forget this right now.');
    }
  }

  Future<void> _exportAll() async {
    setState(() => _exporting = true);
    final start = DateTime.now().millisecondsSinceEpoch;
    String? body;
    try {
      body = await BrainMemoryApi.exportAll();
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'avabrain_memory', handled: true);
    }
    final ok = body != null && body.isNotEmpty;
    await Analytics.uiInteraction('avabrain_memory_exported',
        DateTime.now().millisecondsSinceEpoch - start, extra: {'ok': ok});
    if (!mounted) return;
    setState(() => _exporting = false);
    if (!ok) {
      _showSnack('Export is not available right now. Please try again later.');
      return;
    }
    try {
      // Pretty-print when the body is valid JSON; fall back to the raw body.
      String out = body;
      try {
        final decoded = jsonDecode(body);
        out = const JsonEncoder.withIndent('  ').convert(decoded);
      } catch (_) {/* not JSON, or already formatted — share as-is */}
      await Share.shareXFiles(
        [XFile.fromData(Uint8List.fromList(utf8.encode(out)),
            mimeType: 'application/json', name: 'avabrain-memory-export.json')],
        subject: 'My AvaBrain memory export',
      );
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'avabrain_memory', handled: true);
      _showSnack('Could not open the share sheet.');
    }
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  void _openConsent() {
    Analytics.uiInteraction('avabrain_memory_consent_link_tapped', 0);
    Navigator.push(context, MaterialPageRoute(builder: (_) => const BrainSettingsScreen()));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Column(children: [
          _header(),
          Expanded(child: _body()),
        ]),
      ),
    );
  }

  Widget _header() {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 12, 12),
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: Row(children: [
        const AdBackButton(),
        const SizedBox(width: 4),
        ZineIconBadge(icon: PhosphorIcons.brain(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 40),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('AvaBrain Memory', style: ADText.threadName(c: AD.textPrimary)),
            Text('What Ava remembers about you', style: ADText.preview()),
          ]),
        ),
        IconButton(
          tooltip: 'Consent settings',
          icon: PhosphorIcon(PhosphorIcons.slidersHorizontal(PhosphorIconsStyle.bold),
              color: AD.textSecondary, size: 20),
          onPressed: _openConsent,
        ),
        IconButton(
          tooltip: 'Export my memory',
          icon: _exporting
              ? const SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch))
              : PhosphorIcon(PhosphorIcons.export(PhosphorIconsStyle.bold),
                  color: AD.textSecondary, size: 20),
          onPressed: _exporting ? null : _exportAll,
        ),
      ]),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(
          child: SizedBox(width: 22, height: 22,
              child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch)));
    }
    if (_items.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineIconBadge(icon: PhosphorIcons.brain(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 54),
            const SizedBox(height: 14),
            Text(_fetchFailed ? 'Memory isn’t available yet' : 'Nothing remembered yet',
                style: ADText.threadName(c: AD.textPrimary), textAlign: TextAlign.center),
            const SizedBox(height: 6),
            Text(
              _fetchFailed
                  ? 'Check back soon — this screen turns on as AvaBrain memory rolls out.'
                  : 'As you chat with Ava and use AvaTOK, durable facts and preferences '
                      'will show up here for you to confirm, correct, or forget.',
              style: ADText.preview(), textAlign: TextAlign.center,
            ),
          ]),
        ),
      );
    }
    final groups = _grouped;
    final types = groups.keys.toList()..sort();
    return NotificationListener<ScrollNotification>(
      onNotification: (n) {
        if (n.metrics.pixels >= n.metrics.maxScrollExtent - 200) _loadMore();
        return false;
      },
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
        itemCount: types.length + (_hasMore ? 1 : 0),
        itemBuilder: (context, i) {
          if (i >= types.length) {
            return const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Center(child: SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch))),
            );
          }
          final type = types[i];
          final rows = groups[type]!;
          return Padding(
            padding: const EdgeInsets.only(bottom: 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 0, 8),
                child: Text(_typeLabel(type), style: ADText.sectionLabel()),
              ),
              for (final item in rows)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _MemoryRow(
                    item: item,
                    onConfirm: () => _confirm(item),
                    onCorrect: () => _correct(item),
                    onForget: () => _forget(item),
                  ),
                ),
            ]),
          );
        },
      ),
    );
  }

  static String _typeLabel(String type) {
    switch (type) {
      case 'preference': return 'PREFERENCES';
      case 'goal': return 'GOALS';
      case 'habit': return 'HABITS';
      case 'deadline': return 'DEADLINES';
      case 'decision': return 'DECISIONS';
      case 'reminder': return 'REMINDERS';
      case 'insight': return 'INSIGHTS';
      default: return type.toUpperCase();
    }
  }
}

class _MemoryRow extends StatelessWidget {
  final BrainMemoryItem item;
  final VoidCallback onConfirm;
  final VoidCallback onCorrect;
  final VoidCallback onForget;
  const _MemoryRow({
    required this.item,
    required this.onConfirm,
    required this.onCorrect,
    required this.onForget,
  });

  @override
  Widget build(BuildContext context) {
    final hedged = item.isLowConfidence;
    return AdCard(
      radius: AD.rListCard,
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Text(
              hedged ? 'Ava thinks: ${item.content}' : item.content,
              style: hedged
                  ? ADText.bubbleBody(c: AD.textSecondary).copyWith(fontStyle: FontStyle.italic)
                  : ADText.bubbleBody(c: AD.textPrimary),
            ),
          ),
          if (item.userConfirmed) ...[
            const SizedBox(width: 8),
            const _ConfirmedBadge(),
          ],
        ]),
        const SizedBox(height: 8),
        Row(children: [
          if (item.sourceDomain.isNotEmpty) ...[
            AdSticker(item.sourceDomain, kind: AdStickerKind.hint),
            const SizedBox(width: 6),
          ],
          if (hedged)
            AdSticker('low confidence', kind: AdStickerKind.hint, icon: PhosphorIcons.warning(PhosphorIconsStyle.bold)),
          const Spacer(),
          if (!item.userConfirmed)
            IconButton(
              visualDensity: VisualDensity.compact,
              tooltip: 'Confirm',
              icon: PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.bold), size: 20, color: AD.online),
              onPressed: onConfirm,
            ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: 'Correct',
            icon: PhosphorIcon(PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), size: 18, color: AD.textSecondary),
            onPressed: onCorrect,
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: 'Forget',
            icon: PhosphorIcon(PhosphorIcons.trash(PhosphorIconsStyle.bold), size: 18, color: AD.danger),
            onPressed: onForget,
          ),
        ]),
      ]),
    );
  }
}

class _ConfirmedBadge extends StatelessWidget {
  const _ConfirmedBadge();
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
        decoration: BoxDecoration(
          color: AD.online,
          borderRadius: BorderRadius.circular(100),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 10, color: Colors.white),
          const SizedBox(width: 3),
          Text('confirmed', style: ADText.statCaption(c: Colors.white)),
        ]),
      );
}
