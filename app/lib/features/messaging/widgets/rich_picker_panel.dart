// The keyboard-height picker panel that slides under the input bar (STREAM E).
//
// Segmented top control: Emoji | GIF | Sticker, with a search icon on the left
// and a backspace on the right (backspace only meaningful on the Emoji tab).
//   - Emoji  : "Recents" row + categorized grid + bottom category icon bar.
//   - GIF    : an IN-PANEL grid sourced from our Cloudflare proxy (GifApi →
//              worker/src/routes/gif.ts), which caches results in KV and enforces
//              a daily budget — so browsing costs (almost) ZERO GIPHY API calls
//              and can never blow the free 100/day quota. Shows TRENDING on open,
//              debounced SEARCH as you type, infinite scroll, account-scoped
//              recents. A tiny "Open full GIPHY ↗" link demotes the native SDK
//              dialog (which bypasses our cache/guard) to a secondary path.
//   - Sticker: built-in packs (always) + optional GIPHY sticker grid via the
//              same cached proxy (kind=sticker); tap → send as kind:"sticker".
//
// The panel is a pure view: it calls back to the host (RichInputBar) for the
// actual send/insert/backspace actions and for recents. It never talks to the
// chat state directly.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/analytics.dart';
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
        return _StickerTab(onPick: widget.onSticker, onGiphy: widget.onGif);
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
// GIF tab: an IN-PANEL grid backed by our Cloudflare proxy (GifApi). Browsing
// this grid hits the CACHED proxy (KV cache + daily budget guard), so it costs
// (almost) ZERO GIPHY API calls even when many users search the same terms —
// the ONLY thing that spends quota is an uncached search/trending JSON call, and
// that is now server-cached. On open we show TRENDING; typing in the panel's
// search field debounces ~350ms and calls search(). Infinite scroll follows the
// `next` cursor. Recents show first as a row. A small "Open full GIPHY ↗" link
// still allows the richer native SDK dialog, but it is NOT the default path (it
// bypasses our cache/quota guard and hits GIPHY directly).
// ---------------------------------------------------------------------------
class _GifTab extends StatefulWidget {
  final String query;
  final ValueChanged<GifResult> onPick;
  const _GifTab({required this.query, required this.onPick});

  @override
  State<_GifTab> createState() => _GifTabState();
}

class _GifTabState extends State<_GifTab> {
  final _scroll = ScrollController();
  final List<GifResult> _items = [];
  String _next = '';
  bool _loading = false;
  bool _throttled = false;
  bool _unavailable = false;
  String _query = ''; // the query currently reflected in _items
  int _seq = 0; // guards against out-of-order async responses
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    // Warm the native SDK so the secondary "Open full GIPHY" tap is instant.
    GiphyController.instance.ensureConfigured();
    _scroll.addListener(_onScroll);
    _query = widget.query.trim();
    _load(reset: true);
  }

  @override
  void didUpdateWidget(covariant _GifTab old) {
    super.didUpdateWidget(old);
    final q = widget.query.trim();
    if (q == _query) return;
    // Debounce search-as-you-type so we don't fire (and cache-miss) per keystroke.
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      if (!mounted) return;
      _query = q;
      _load(reset: true);
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_loading || _next.isEmpty) return;
    if (_scroll.position.pixels >=
        _scroll.position.maxScrollExtent - 400) {
      _load(reset: false);
    }
  }

  Future<void> _load({required bool reset}) async {
    if (_loading) return;
    final seq = ++_seq;
    final q = _query;
    final source = q.isEmpty ? 'trending' : 'search';
    setState(() {
      _loading = true;
      if (reset) {
        _items.clear();
        _next = '';
        _throttled = false;
        _unavailable = false;
      }
    });
    if (reset) {
      // gif_grid_browsed carries the user's email via Analytics (global identify).
      Analytics.capture('gif_grid_browsed', {
        'source': source,
        'query_len': q.length,
      });
    }
    final page = q.isEmpty
        ? await GifApi.trending(pos: reset ? '' : _next)
        : await GifApi.search(q, pos: reset ? '' : _next);
    if (!mounted || seq != _seq) return;
    setState(() {
      _loading = false;
      _items.addAll(page.results);
      _next = page.next;
      _throttled = page.throttled;
      _unavailable = page.unavailable;
    });
  }

  void _openGiphy() {
    GiphyController.instance.open(context, onPick: widget.onPick);
  }

  @override
  Widget build(BuildContext context) {
    final recents =
        PickerRecentsStore.I.gif.map((m) => GifResult.fromRecent(m)).toList();
    return Column(children: [
      Expanded(child: _grid(recents)),
      _giphyLink(),
    ]);
  }

  // Secondary, demoted access to the full native GIPHY browser. Default browsing
  // is the cached proxy grid above; this link is the richer (uncached) option.
  Widget _giphyLink() => Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 6),
        child: GestureDetector(
          onTap: _openGiphy,
          behavior: HitTestBehavior.opaque,
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Text('Open full GIPHY ↗',
                style: ZineText.sub().copyWith(
                    fontWeight: FontWeight.w700, color: Zine.inkMute)),
          ]),
        ),
      );

  Widget _grid(List<GifResult> recents) {
    if (_unavailable && _items.isEmpty) {
      return _note('GIFs unavailable');
    }
    if (_throttled && _items.isEmpty) {
      return _note('GIFs are taking a break — try again later');
    }
    if (_items.isEmpty && _loading) {
      return Container();
    }
    if (_items.isEmpty && recents.isEmpty) {
      return _note('No GIFs found');
    }

    final showRecents = _query.isEmpty && recents.isNotEmpty;
    return CustomScrollView(controller: _scroll, slivers: [
      if (showRecents) ...[
        _sliverHeader('RECENTS'),
        _sliverGrid(recents),
      ],
      if (_items.isNotEmpty) ...[
        if (showRecents)
          _sliverHeader(_query.isEmpty ? 'TRENDING' : 'RESULTS'),
        _sliverGrid(_items),
      ],
      if (_loading && _items.isNotEmpty)
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.symmetric(vertical: 14),
            child: Center(
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          ),
        ),
    ]);
  }

  Widget _note(String msg) => Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Text(msg, textAlign: TextAlign.center, style: ZineText.sub()),
        ),
      );

  Widget _sliverHeader(String label) => SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 4),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(label,
                style: ZineText.kicker(size: 11, color: Zine.inkMute)),
          ),
        ),
      );

  Widget _sliverGrid(List<GifResult> items) => SliverPadding(
        padding: const EdgeInsets.all(6),
        sliver: SliverGrid(
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            mainAxisSpacing: 6,
            crossAxisSpacing: 6,
          ),
          delegate: SliverChildBuilderDelegate(
            (ctx, i) => _tile(items[i]),
            childCount: items.length,
          ),
        ),
      );

  Widget _tile(GifResult g) => GestureDetector(
        onTap: () => widget.onPick(g),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: Container(
            color: Zine.card,
            child: Image.network(
              // Muted autoplaying preview from GIPHY's CDN. CDN asset fetches do
              // NOT count against the API quota — only the (cached) JSON call does.
              g.preview,
              fit: BoxFit.cover,
              gaplessPlayback: true,
              errorBuilder: (_, __, ___) =>
                  const Icon(Icons.gif_box_outlined, color: Zine.inkMute),
              loadingBuilder: (c, w, p) =>
                  p == null ? w : Container(color: Zine.card),
            ),
          ),
        ),
      );
}

// ---------------------------------------------------------------------------
// Sticker tab: built-in packs + recents (ALWAYS present), plus an OPTIONAL GIPHY
// sticker section (transparent stickers via the SAME cached proxy, kind=sticker).
// The built-in packs send a bundled asset path via [onPick]; a GIPHY sticker is a
// GifResult (contentType=sticker) sent via [onGiphy] → the bubble-less sticker
// send path. GIPHY stickers are fetched lazily (trending) so opening the tab
// spends nothing until they scroll into view, and the JSON call is KV-cached.
// ---------------------------------------------------------------------------
class _StickerTab extends StatefulWidget {
  final ValueChanged<String> onPick; // built-in sticker asset path
  final ValueChanged<GifResult> onGiphy; // GIPHY sticker → bubble-less send
  const _StickerTab({required this.onPick, required this.onGiphy});

  @override
  State<_StickerTab> createState() => _StickerTabState();
}

class _StickerTabState extends State<_StickerTab> {
  final List<GifResult> _giphy = [];
  bool _loading = false;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _loadGiphy();
  }

  Future<void> _loadGiphy() async {
    if (_loading || _loaded) return;
    _loading = true;
    final page = await GifApi.trending(kind: 'sticker');
    if (!mounted) return;
    setState(() {
      _loading = false;
      _loaded = true;
      _giphy.addAll(page.results);
    });
  }

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
      // GIPHY stickers (only if the cached proxy returned any).
      if (_giphy.isNotEmpty) ...[
        _header('GIPHY Stickers'),
        _giphyGrid(_giphy),
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
              onTap: () => widget.onPick(assets[i]),
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

  Widget _giphyGrid(List<GifResult> items) => SliverPadding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        sliver: SliverGrid(
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 4,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
          ),
          delegate: SliverChildBuilderDelegate(
            (ctx, i) => GestureDetector(
              onTap: () => widget.onGiphy(items[i]),
              child: Image.network(items[i].preview,
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                  errorBuilder: (_, __, ___) =>
                      const Icon(Icons.emoji_emotions_outlined,
                          color: Zine.inkMute)),
            ),
            childCount: items.length,
          ),
        ),
      );
}
