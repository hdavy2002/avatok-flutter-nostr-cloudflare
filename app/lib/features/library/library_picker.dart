import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar_cache.dart';
import '../../core/library_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// LibraryPickerScreen — browse AvaLibrary and pick ONE file to attach into a
/// chat. Returns the chosen [LibraryItem] via Navigator.pop (null if cancelled).
/// The caller downloads its bytes and sends it through the normal media path.
class LibraryPickerScreen extends StatefulWidget {
  const LibraryPickerScreen({super.key});
  @override
  State<LibraryPickerScreen> createState() => _LibraryPickerScreenState();
}

class _LibraryPickerScreenState extends State<LibraryPickerScreen> {
  final List<LibraryItem> _items = [];
  int? _cursor;
  bool _loading = true, _more = false;
  String _filter = 'all'; // all|image|video|document

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load({bool append = false}) async {
    try {
      final cat = _filter == 'all' ? null : _filter;
      final res = await LibraryApi.list(category: cat, cursor: append ? _cursor : null);
      if (!mounted) return;
      setState(() {
        if (!append) _items.clear();
        _items.addAll(res.items);
        _cursor = res.cursor;
        _loading = false; _more = false;
      });
    } catch (_) {
      if (mounted) setState(() { _loading = false; _more = false; });
    }
  }

  void _setFilter(String f) {
    if (_filter == f) return;
    setState(() { _filter = f; _loading = true; _items.clear(); });
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Add from Library', markWord: 'Library'),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
          child: Row(children: [
            for (final f in const ['all', 'image', 'video', 'document']) ...[
              ZineChip(label: _label(f), active: _filter == f, onTap: () => _setFilter(f)),
              const SizedBox(width: 8),
            ],
          ]),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
              : _items.isEmpty
                  ? Center(child: Text('No files here yet.', style: ZineText.sub(size: 14)))
                  : GridView.builder(
                      padding: const EdgeInsets.all(14),
                      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: 3, mainAxisSpacing: 10, crossAxisSpacing: 10, childAspectRatio: 0.8),
                      itemCount: _items.length,
                      itemBuilder: (_, i) => _tile(_items[i]),
                    ),
        ),
      ]),
    );
  }

  String _label(String f) => f == 'all' ? 'All' : f == 'image' ? 'Photos' : f == 'video' ? 'Videos' : 'Files';

  Widget _tile(LibraryItem it) {
    final thumb = (it.thumbnailUrl?.isNotEmpty == true) ? it.thumbnailUrl! : it.displayUrl;
    final isMedia = it.category == 'image' || it.category == 'video';
    return GestureDetector(
      onTap: () => Navigator.pop(context, it),
      child: Container(
        decoration: BoxDecoration(
          color: Zine.card, borderRadius: BorderRadius.circular(Zine.rSm), border: Zine.border),
        clipBehavior: Clip.antiAlias,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(
            child: (isMedia && thumb.isNotEmpty)
                ? Stack(fit: StackFit.expand, children: [
                    Image.network(AvatarCache.sizedUrl(thumb, 400), fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => _iconFor(it)),
                    if (it.category == 'video')
                      const Center(child: Icon(Icons.play_circle_fill, color: Colors.white70, size: 30)),
                  ])
                : _iconFor(it),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
            child: Text(it.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 11)),
          ),
        ]),
      ),
    );
  }

  Widget _iconFor(LibraryItem it) {
    final icon = it.category == 'image'
        ? PhosphorIcons.image(PhosphorIconsStyle.bold)
        : it.category == 'video'
            ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
            : it.category == 'audio'
                ? PhosphorIcons.musicNote(PhosphorIconsStyle.bold)
                : PhosphorIcons.file(PhosphorIconsStyle.bold);
    return Container(color: Zine.paper2, child: Center(child: PhosphorIcon(icon, size: 30, color: Zine.inkSoft)));
  }
}
