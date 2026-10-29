/// [HF-PAGES-1] A policy page as `GET /api/hf/pages/:slug` sends it (worker/src/routes/hf_pages.ts, lib/hf_pages.ts):
/// `{ok, slug, title, summary, related:[{href,label}], version, updatedAt:'YYYY-MM-DD', blocks:[...]}`.
///
/// Blocks: `h2 {text}`, `p {spans, lang?}`, `note {spans}`, `ul|ol {items: [spans]}`, `links {items: [{href,title,text}]}`.
/// A span is `{text, href?, em?, strong?}`; a span whose text is a single `"\n"` is a line break.
/// Parsing is tolerant: anything it does not understand is skipped, so a new block type never crashes an old app.
library;

/// One run of text inside a paragraph, list item or note.
class PageSpan {
  const PageSpan(this.text, {this.href, this.em = false, this.strong = false});

  final String text;

  /// `/terms`, `mailto:...`, `https://...` or null.
  final String? href;
  final bool em;
  final bool strong;

  bool get isBreak => text == '\n';

  factory PageSpan.fromJson(Object? j) {
    if (j is! Map) return const PageSpan('');
    final href = j['href'];
    return PageSpan(
      (j['text'] ?? '').toString(),
      href: href is String && href.isNotEmpty ? href : null,
      em: j['em'] == true,
      strong: j['strong'] == true,
    );
  }

  static List<PageSpan> listFrom(Object? j) {
    if (j is! List) return const <PageSpan>[];
    return [for (final e in j) PageSpan.fromJson(e)].where((s) => s.text.isNotEmpty).toList();
  }
}

/// A row of a `links` block: a tappable title with a line under it.
class PageLinkItem {
  const PageLinkItem({required this.href, required this.title, required this.text});

  final String href;
  final String title;
  final String text;
}

/// One block of the page body. Only the fields of its own type are filled.
class PageBlock {
  const PageBlock(
    this.type, {
    this.text = '',
    this.spans = const <PageSpan>[],
    this.items = const <List<PageSpan>>[],
    this.links = const <PageLinkItem>[],
    this.lang,
  });

  /// `h2 | p | note | ul | ol | links`
  final String type;
  final String text;
  final List<PageSpan> spans;
  final List<List<PageSpan>> items;
  final List<PageLinkItem> links;
  final String? lang;

  /// Null for a block this app version does not know.
  static PageBlock? fromJson(Object? j) {
    if (j is! Map) return null;
    final type = (j['t'] ?? '').toString();
    switch (type) {
      case 'h2':
        final text = (j['text'] ?? '').toString();
        return text.isEmpty ? null : PageBlock('h2', text: text);
      case 'p':
      case 'note':
        final spans = PageSpan.listFrom(j['spans']);
        if (spans.isEmpty) return null;
        final lang = j['lang'];
        return PageBlock(type, spans: spans, lang: lang is String && lang.isNotEmpty ? lang : null);
      case 'ul':
      case 'ol':
        final rawItems = j['items'];
        if (rawItems is! List) return null;
        final items = [for (final e in rawItems) PageSpan.listFrom(e)].where((s) => s.isNotEmpty).toList();
        return items.isEmpty ? null : PageBlock(type, items: items);
      case 'links':
        final rawLinks = j['items'];
        if (rawLinks is! List) return null;
        final links = <PageLinkItem>[];
        for (final e in rawLinks) {
          if (e is! Map) continue;
          final href = (e['href'] ?? '').toString();
          if (href.isEmpty) continue;
          links.add(PageLinkItem(href: href, title: (e['title'] ?? '').toString(), text: (e['text'] ?? '').toString()));
        }
        return links.isEmpty ? null : PageBlock('links', links: links);
      default:
        return null;
    }
  }
}

/// A "Related pages" chip.
class PageRelated {
  const PageRelated({required this.href, required this.label});

  final String href;
  final String label;
}

class PolicyPage {
  const PolicyPage({
    required this.slug,
    required this.title,
    this.summary = '',
    this.related = const <PageRelated>[],
    this.version = 0,
    this.updatedAt = '',
    this.blocks = const <PageBlock>[],
  });

  final String slug;
  final String title;
  final String summary;
  final List<PageRelated> related;
  final int version;

  /// `YYYY-MM-DD` (the day the page last changed).
  final String updatedAt;
  final List<PageBlock> blocks;

  factory PolicyPage.fromJson(Map<String, dynamic> j) {
    final rel = <PageRelated>[];
    final rawRel = j['related'];
    if (rawRel is List) {
      for (final e in rawRel) {
        if (e is! Map) continue;
        final href = (e['href'] ?? '').toString();
        final label = (e['label'] ?? '').toString();
        if (href.isNotEmpty && label.isNotEmpty) rel.add(PageRelated(href: href, label: label));
      }
    }
    final blocks = <PageBlock>[];
    final rawBlocks = j['blocks'];
    if (rawBlocks is List) {
      for (final e in rawBlocks) {
        final b = PageBlock.fromJson(e);
        if (b != null) blocks.add(b);
      }
    }
    final v = j['version'];
    return PolicyPage(
      slug: (j['slug'] ?? '').toString(),
      title: (j['title'] ?? '').toString(),
      summary: (j['summary'] ?? '').toString(),
      related: rel,
      version: v is num ? v.toInt() : int.tryParse('$v') ?? 0,
      updatedAt: (j['updatedAt'] ?? '').toString(),
      blocks: blocks,
    );
  }

  /// "29 Oct 2026" from `2026-10-29`; the raw text when it is not a date.
  String get updatedLabel {
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(updatedAt);
    if (m == null) return updatedAt;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final month = int.parse(m.group(2)!);
    if (month < 1 || month > 12) return updatedAt;
    return '${int.parse(m.group(3)!)} ${months[month - 1]} ${m.group(1)}';
  }
}
