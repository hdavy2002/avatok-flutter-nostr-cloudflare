import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar_cache.dart';
import '../../core/library_api.dart';
import '../../core/ui/avatok_dark.dart';

/// Inline dark v2 header band (replaces the light ZineAppBar): header/footer
/// surface, hairline bottom border, back button + Nunito title.
PreferredSizeWidget _darkHeader({
  required String title,
  String? tag,
  List<Widget> actions = const [],
  bool showBack = true,
}) {
  return PreferredSize(
    preferredSize: Size.fromHeight(tag == null ? 76 : 92),
    child: Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          child: Row(children: [
            if (showBack) ...[
              const AdBackButton(),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis),
                  if (tag != null) ...[
                    const SizedBox(height: 2),
                    Text(tag.toUpperCase(), style: ADText.sectionLabel()),
                  ],
                ],
              ),
            ),
            ...actions,
          ]),
        ),
      ),
    ),
  );
}

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
      backgroundColor: AD.bg,
      appBar: _darkHeader(title: 'Add from Library'),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
          child: Row(children: [
            for (final f in const ['all', 'image', 'video', 'document']) ...[
              AdChip(label: _label(f), active: _filter == f, onTap: () => _setFilter(f)),
              const SizedBox(width: 8),
            ],
          ]),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
              : _items.isEmpty
                  ? Center(child: Text('No files here yet.', style: ADText.preview()))
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
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.borderControl, width: 1)),
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
            child: Text(it.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.statCaption(c: AD.textSecondary)),
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
    return Container(color: AD.cardHover, child: Center(child: PhosphorIcon(icon, size: 30, color: AD.textTertiary)));
  }
}
