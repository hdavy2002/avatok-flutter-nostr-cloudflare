// The keyboard-height picker panel that slides under the input bar (STREAM E).
//
// Segmented top control: Emoji | GIF | Sticker, with a search icon on the left
// and a backspace on the right (backspace only meaningful on the Emoji tab).
//   - Emoji  : "Recents" row + categorized grid + bottom category icon bar.
//   - GIF    : opens the full GIPHY experience (native GIPHY SDK) — GIFs,
//              Stickers, GIPHY Text (dynamic), Emoji, and Clips (GIF+sound);
//              also shows account-scoped recents inline. tap → send.
//   - Sticker: built-in packs; tap → send as a kind:"sticker" media message.
//
// The panel is a pure view: it calls back to the host (RichInputBar) for the
// actual send/insert/backspace actions and for recents. It never talks to the
// chat state directly.
import 'package:flutter/material.dart';

import '../../../core/ui/zine.dart';
import 'emoji_data.dart';
import 'gif_api.dart';
import 'giphy_controller.dart';
import 'picker_recents_store.dart';
import 'sticker_packs.dart';

enum PickerTab { emoji, gif, sticker }

class RichPickerPanel extends StatefulWidget {
  final double height;
  final PickerTab initialTab;
  final ValueChanged<PickerTab> onTabChanged;
  final ValueChanged<String> onEmoji; // insert emoji char into the field
  final VoidCallback onBackspace; // emoji backspace
  final ValueChanged<GifResult> onGif; // send a GIF
  final ValueChanged<String> onSticker; // send a sticker (asset path)

  const RichPickerPanel({
    super.key,
    required this.height,
    required this.initialTab,
    required this.onTabChanged,
    required this.onEmoji,
    required this.onBackspace,
    required this.onGif,
    required this.onSticker,
  });

  @override
  State<RichPickerPanel> createState() => _RichPickerPanelState();
}

class _RichPickerPanelState extends State<RichPickerPanel> {
  late PickerTab _tab;
  final _search = TextEditingController();
  bool _searching = false;

  @override
  void initState() {
    super.initState();
    _tab = widget.initialTab;
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _setTab(PickerTab t) {
    if (t == _tab) return;
    setState(() {
      _tab = t;
      _searching = false;
      _search.clear();
    });
    widget.onTabChanged(t);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: widget.height,
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: Column(children: [
        _topBar(),
        Expanded(child: _body()),
      ]),
    );
  }

  // Search (left) · segmented Emoji|GIF|Sticker · backspace (right).
  Widget _topBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Zine.ink, width: 1)),
      ),
      child: Row(children: [
        IconButton(
          icon: Icon(_searching ? Icons.close_rounded : Icons.search_rounded,
              color: Zine.ink, size: 22),
          visualDensity: VisualDensity.compact,
          onPressed: () => setState(() {
            _searching = !_searching;
            if (!_searching) _search.clear();
          }),
        ),
        Expanded(
          child: _searching
              ? _searchField()
              : Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  _seg('Emoji', PickerTab.emoji),
                  _seg('GIF', PickerTab.gif),
                  _seg('Sticker', PickerTab.sticker),
                ]),
        ),
        IconButton(
          icon: const Icon(Icons.backspace_outlined, color: Zine.ink, size: 20),
          visualDensity: VisualDensity.compact,
          onPressed: _tab == PickerTab.emoji ? widget.onBackspace : null,
        ),
      ]),
    );
  }

  Widget _searchField() => TextField(
        controller: _search,
        autofocus: true,
        onChanged: (_) => setState(() {}),
        style: ZineText.input(size: 14.5),
        decoration: InputDecoration(
          isDense: true,
          hintText: _tab == PickerTab.gif ? 'Search GIFs' : 'Search emoji',
          hintStyle: ZineText.input(size: 14.5).copyWith(color: Zine.placeholder),
          border: InputBorder.none,
        ),
      );

  Widget _seg(String label, PickerTab t) {
    final on = _tab == t;
    return GestureDetector(
      onTap: () => _setTab(t),
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: on ? Zine.lime : Colors.transparent,
          borderRadius: BorderRadius.circular(20),
          border: on ? Zine.border : Border.all(color: Colors.transparent, width: Zine.bw),
        ),
        child: Text(label,
            style: ZineText.value(size: 13.5).copyWith(
                fontWeight: FontWeight.w800,
                color: on ? Zine.ink : Zine.inkSoft)),
      ),
    );
  }

  Widget _body() {
    switch (_tab) {
      case PickerTab.emoji:
        return _EmojiTab(
          query: _searching ? _search.text : '',
          onEmoji: (e) {
            PickerRecentsStore.I.pushEmoji(e);
            widget.onEmoji(e);
          },
        );
      case PickerTab.gif:
        return _GifTab(query: _searching ? _search.text : '', onPick: widget.onGif);
      case PickerTab.sticker:
        return _StickerTab(onPick: widget.onSticker);
    }
  }
}

// ---------------------------------------------------------------------------
// Emoji tab: Recents row + categorized grid + bottom category bar.
// ---------------------------------------------------------------------------
class _EmojiTab extends StatefulWidget {
  final String query;
  final ValueChanged<String> onEmoji;
  const _EmojiTab({required this.query, required this.onEmoji});

  @override
  State<_EmojiTab> createState() => _EmojiTabState();
}

class _EmojiTabState extends State<_EmojiTab> {
  final _scroll = ScrollController();
  // Byte offsets into the scroll list for each category header (jump targets).
  final Map<String, GlobalKey> _catKeys = {
    for (final c in kEmojiCategories) c.id: GlobalKey(),
  };

  @override
  Widget build(BuildContext context) {
    if (widget.query.trim().isNotEmpty) {
      final hits = searchEmoji(widget.query);
      return hits.isEmpty
          ? Center(child: Text('No emoji', style: ZineText.sub()))
          : _grid(hits);
    }
    final recents = PickerRecentsStore.I.emoji;
    return Column(children: [
      Expanded(
        child: CustomScrollView(controller: _scroll, slivers: [
          if (recents.isNotEmpty) ...[
            _header('Recents'),
            _sliverGrid(recents),
          ],
          for (final c in kEmojiCategories) ...[
            _header(c.label, key: _catKeys[c.id]),
            _sliverGrid(c.emojis),
          ],
        ]),
      ),
      _categoryBar(),
    ]);
  }

  Widget _header(String label, {Key? key}) => SliverToBoxAdapter(
        // Key goes on the inner box (not the sliver) so Scrollable.ensureVisible
        // — which needs a RenderBox context — can jump to this category.
        child: Padding(
          key: key,
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
          child: Text(label.toUpperCase(),
              style: ZineText.kicker(size: 11, color: Zine.inkMute)),
        ),
      );

  Widget _sliverGrid(List<String> emojis) => SliverPadding(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        sliver: SliverGrid(
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 44,
            childAspectRatio: 1,
          ),
          delegate: SliverChildBuilderDelegate(
            (ctx, i) => _cell(emojis[i]),
            childCount: emojis.length,
          ),
        ),
      );

  Widget _grid(List<String> emojis) => GridView.builder(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 44,
          childAspectRatio: 1,
        ),
        itemCount: emojis.length,
        itemBuilder: (ctx, i) => _cell(emojis[i]),
      );

  Widget _cell(String e) => GestureDetector(
        onTap: () => widget.onEmoji(e),
        child: Center(child: Text(e, style: const TextStyle(fontSize: 26))),
      );

  Widget _categoryBar() => Container(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: Zine.ink, width: 1)),
        ),
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
          for (final c in kEmojiCategories)
            GestureDetector(
              onTap: () {
                final k = _catKeys[c.id];
                final ctx = k?.currentContext;
                if (ctx != null) {
                  Scrollable.ensureVisible(ctx,
                      duration: const Duration(milliseconds: 250));
                }
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
                child: Text(c.icon, style: const TextStyle(fontSize: 20)),
              ),
            ),
        ]),
      );
}

// ---------------------------------------------------------------------------
// GIF tab: launches the full GIPHY experience (native GIPHY SDK dialog — GIFs,
// Stickers, GIPHY Text, Emoji, Clips). Also shows account-scoped recents inline
// (tap a recent to re-send instantly, or tap the launcher to browse GIPHY).
// ---------------------------------------------------------------------------
class _GifTab extends StatefulWidget {
  final String query;
  final ValueChanged<GifResult> onPick;
  const _GifTab({required this.query, required this.onPick});

  @override
  State<_GifTab> createState() => _GifTabState();
}

class _GifTabState extends State<_GifTab> {
  @override
  void initState() {
    super.initState();
    // Warm the SDK so the first "Open GIPHY" tap is instant.
    GiphyController.instance.ensureConfigured();
  }

  void _openGiphy() {
    GiphyController.instance.open(context, onPick: widget.onPick);
  }

  @override
  Widget build(BuildContext context) {
    final recents =
        PickerRecentsStore.I.gif.map((m) => GifResult.fromRecent(m)).toList();
    return Column(children: [
      // Prominent launcher into the full GIPHY picker.
      Padding(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
        child: GestureDetector(
          onTap: _openGiphy,
          child: Container(
            height: 44,
            decoration: BoxDecoration(
              color: Zine.lime,
              borderRadius: BorderRadius.circular(22),
              border: Zine.border,
              boxShadow: Zine.shadowXs,
            ),
            child: Center(
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.gif_box_rounded, color: Zine.ink, size: 22),
                const SizedBox(width: 8),
                Text('Browse GIPHY',
                    style: ZineText.value(size: 14)
                        .copyWith(fontWeight: FontWeight.w800, color: Zine.ink)),
              ]),
            ),
          ),
        ),
      ),
      if (recents.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 4, 14, 2),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('RECENTS',
                style: ZineText.kicker(size: 11, color: Zine.inkMute)),
          ),
        ),
      Expanded(
        child: recents.isEmpty
            ? GestureDetector(
                onTap: _openGiphy,
                behavior: HitTestBehavior.opaque,
                child: Center(
                  child: Text('Tap “Browse GIPHY” to find a GIF, sticker or clip',
                      textAlign: TextAlign.center, style: ZineText.sub()),
                ),
              )
            : GridView.builder(
                padding: const EdgeInsets.all(6),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  mainAxisSpacing: 6,
                  crossAxisSpacing: 6,
                ),
                itemCount: recents.length,
                itemBuilder: (ctx, i) {
                  final g = recents[i];
                  return GestureDetector(
                    onTap: () => widget.onPick(g),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(6),
                      child: Container(
                        color: Zine.card,
                        child: Image.network(
                          g.preview,
                          fit: BoxFit.cover,
                          gaplessPlayback: true,
                          errorBuilder: (_, __, ___) => const Icon(
                              Icons.gif_box_outlined,
                              color: Zine.inkMute),
                          loadingBuilder: (c, w, p) =>
                              p == null ? w : Container(color: Zine.card),
                        ),
                      ),
                    ),
                  );
                },
              ),
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Sticker tab: built-in packs + recents. Tap → send.
// ---------------------------------------------------------------------------
class _StickerTab extends StatelessWidget {
  final ValueChanged<String> onPick;
  const _StickerTab({required this.onPick});

  @override
  Widget build(BuildContext context) {
    final recents = PickerRecentsStore.I.sticker;
    return CustomScrollView(slivers: [
      if (recents.isNotEmpty) ...[
        _header('Recents'),
        _grid(recents),
      ],
      for (final p in kStickerPacks) ...[
        _header(p.name),
        _grid(p.stickers),
      ],
    ]);
  }

  Widget _header(String label) => SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
          child: Text(label.toUpperCase(),
              style: ZineText.kicker(size: 11, color: Zine.inkMute)),
        ),
      );

  Widget _grid(List<String> assets) => SliverPadding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        sliver: SliverGrid(
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 4,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
          ),
          delegate: SliverChildBuilderDelegate(
            (ctx, i) => GestureDetector(
              onTap: () => onPick(assets[i]),
              child: Image.asset(assets[i],
                  fit: BoxFit.contain,
                  errorBuilder: (_, __, ___) =>
                      const Icon(Icons.emoji_emotions_outlined,
                          color: Zine.inkMute)),
            ),
            childCount: assets.length,
          ),
        ),
      );
}
