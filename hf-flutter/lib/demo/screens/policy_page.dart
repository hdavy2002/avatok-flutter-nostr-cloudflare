import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/models/page.dart';
import '../../data/repos/pages_repo.dart';
import '../../data/services.dart';
import '../desi.dart';
import '../support_kit.dart';
import '../theme.dart';

/// [HF-PAGES-1] The policy pages inside the app (Terms, Privacy, Refunds...), route `/page/:slug`.
/// Built to the owner-approved mock-up "Main" (2026-10-29). Nothing here opens a browser.

/// The pages stored by the server (`site_pages`). A link to one of these opens `/page/<slug>`.
const Set<String> kPolicySlugs = {
  'terms',
  'privacy',
  'refunds',
  'wallet-terms',
  'community-guidelines',
  'disclaimer',
  'rules-of-engagement',
  'grievance',
  'safety',
  'cookies',
  'data-deletion',
  'age-policy',
  'child-safety',
  'intermediary-policy',
};

const Map<String, String> _fallbackTitles = {
  'terms': 'Terms of use',
  'privacy': 'Privacy policy',
  'refunds': 'Refund & cancellation',
  'wallet-terms': 'Payment & wallet terms',
  'community-guidelines': 'Community guidelines',
  'disclaimer': 'Service disclaimer',
  'rules-of-engagement': 'Rules of engagement',
  'grievance': 'Grievance redressal',
  'safety': 'Safety centre',
  'cookies': 'Cookie policy',
  'data-deletion': 'Data deletion',
  'age-policy': 'Age policy',
  'child-safety': 'Child safety standards',
  'intermediary-policy': 'Intermediary & content policy',
};

/// Where a link inside a page goes in the app, as a go_router location, or null when the app has no screen for it (the link is then
/// shown as plain text and does nothing). Never an outside browser.
///
/// - `/terms`, `/privacy`... (the stored pages) -> `/page/<slug>`
/// - `mailto:` to the brand's own addresses (support, grievance) -> `/support`; `/contact`, `/support`, a `support.<domain>` link -> `/support`
/// - `/report` -> `/support?topic=report`; `/help`, `/faq`, `/help/...` -> `/help`; `/wallet` -> `/wallet`; `/account/close` -> `/settings`
/// - the brand's own https links are read by their path; other websites and `tel:` -> null
String? inAppRouteForHref(String href) {
  final raw = href.trim();
  if (raw.isEmpty) return null;
  final uri = Uri.tryParse(raw);
  if (uri == null) return null;
  if (uri.scheme == 'mailto') {
    final to = uri.path.toLowerCase();
    final at = to.lastIndexOf('@');
    if (at < 0) return null;
    return Brand.isBrandOrLegacyHost(to.substring(at + 1)) ? '/support' : null;
  }
  var path = '';
  if (uri.scheme == 'http' || uri.scheme == 'https') {
    if (!Brand.isBrandOrLegacyHost(uri.host)) return null;
    if (uri.host.toLowerCase().startsWith('support.')) return '/support';
    path = uri.path;
  } else if (uri.scheme.isEmpty && raw.startsWith('/') && !raw.startsWith('//')) {
    path = uri.path;
  } else {
    return null;
  }
  final segs = path.split('/').where((s) => s.isNotEmpty).map((s) => s.toLowerCase()).toList();
  if (segs.isEmpty) return null;
  if (segs.length == 1) {
    final s = segs.first;
    if (kPolicySlugs.contains(s)) return '/page/$s';
    return switch (s) {
      'contact' || 'support' => '/support',
      'report' => '/support?topic=report',
      'help' || 'faq' => '/help',
      'wallet' => '/wallet',
      _ => null,
    };
  }
  if (segs.first == 'help') return '/help';
  if (segs.length == 2 && segs[0] == 'account' && segs[1] == 'close') return '/settings';
  if (segs.length == 2 && segs[0] == 'support' && RegExp(r'^hf-\d+$').hasMatch(segs[1])) return '/support/HF-${segs[1].substring(3)}';
  return null;
}

class PolicyPageScreen extends StatefulWidget {
  const PolicyPageScreen({super.key, required this.slug, this.repo, this.onBack, this.onNavigate});

  final String slug;

  /// Tests pass their own; the app uses `Services.instance.pagesRepo`.
  final PagesRepo? repo;

  /// The re-accept prompt shows a page above the app, so it supplies its own back and link handling.
  final VoidCallback? onBack;
  final void Function(String route)? onNavigate;

  @override
  State<PolicyPageScreen> createState() => _PolicyPageScreenState();
}

class _PolicyPageScreenState extends State<PolicyPageScreen> {
  PolicyPage? _page;
  bool _loading = true;
  bool _stale = false; // the quiet refresh failed, the saved copy is what is shown
  Object? _error;
  int _run = 0;

  PagesRepo get _repo => widget.repo ?? Services.instance.pagesRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant PolicyPageScreen old) {
    super.didUpdateWidget(old);
    if (old.slug != widget.slug) {
      _page = null;
      _error = null;
      _loading = true;
      _stale = false;
      unawaited(_load());
    }
  }

  Future<void> _load() async {
    final run = ++_run;
    final slug = widget.slug;
    final saved = await _repo.cached(slug);
    if (!mounted || run != _run) return;
    if (saved != null) {
      setState(() {
        _page = saved;
        _loading = false;
      });
    }
    try {
      final fresh = await _repo.fetch(slug);
      if (!mounted || run != _run) return;
      setState(() {
        _page = fresh;
        _loading = false;
        _error = null;
        _stale = false;
      });
    } catch (e) {
      if (!mounted || run != _run) return;
      setState(() {
        _loading = false;
        if (_page == null) {
          _error = e;
        } else {
          _stale = true;
        }
      });
    }
  }

  void _retry() {
    setState(() {
      _loading = true;
      _error = null;
    });
    unawaited(_load());
  }

  void _go(String href) {
    final route = inAppRouteForHref(href);
    if (route == null || route == '/page/${widget.slug}') return;
    final nav = widget.onNavigate;
    if (nav != null) {
      nav(route);
    } else {
      unawaited(context.push<Object?>(route));
    }
  }

  @override
  Widget build(BuildContext context) {
    final page = _page;
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          SupHeader(title: page?.title ?? _fallbackTitles[widget.slug] ?? 'Policy', onBack: widget.onBack),
          Expanded(child: page != null ? _content(page) : (_loading ? _spinner() : _errorCard())),
        ]),
      ),
    );
  }

  Widget _spinner() => const Center(child: SizedBox(width: 44, height: 44, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 5)));

  Widget _errorCard() {
    final e = _error;
    final title = e is ApiException ? e.failureTitle : 'That did not work';
    final msg = e is ApiException ? e.failureMessage : ApiException.genericText;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        SupCard(
          corner: DesiCorner.hibiscus,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SupHeading(title),
            Text(msg, key: const Key('page-error'), style: t(15, color: C.muted, w: FontWeight.w600, h: 1.5)),
            const SizedBox(height: 16),
            SupSolidButton(label: 'Try again', onTap: _retry),
          ]),
        ),
      ],
    );
  }

  Widget _content(PolicyPage page) {
    final cards = <Widget>[];
    // Blocks before the first heading, then one white card per heading.
    var current = <PageBlock>[];
    var firstCard = true;
    void flush() {
      if (current.isEmpty) return;
      cards.add(_SectionCard(blocks: current, flower: firstCard, onLink: _go));
      firstCard = false;
      current = <PageBlock>[];
    }

    for (final b in page.blocks) {
      if (b.type == 'h2') flush();
      current.add(b);
    }
    flush();

    return ListView(
      key: const Key('page-list'),
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 14),
          child: Wrap(spacing: 8, runSpacing: 8, children: [
            if (page.updatedLabel.isNotEmpty) _Pill('Last updated ${page.updatedLabel}', bg: C.goldtint, ink: C.amber),
            if (page.version > 0) _Pill('Version ${page.version}', bg: C.lavtint, ink: C.lav),
          ]),
        ),
        if (page.summary.trim().isNotEmpty) ...[
          SupCard(
            radius: 22,
            padding: const EdgeInsets.all(18),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const DesiIconSquare(Icons.description_rounded, tone: DesiTone.rani, size: 40),
              const SizedBox(width: 12),
              Expanded(child: Text(page.summary, key: const Key('page-summary'), style: t(15, color: C.muted, w: FontWeight.w700, h: 1.5))),
            ]),
          ),
          const SizedBox(height: 14),
        ],
        for (final c in cards) ...[c, const SizedBox(height: 14)],
        if (page.related.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 6, 4, 10),
            child: Semantics(header: true, child: Text('RELATED PAGES', style: t(14, color: C.tan, w: FontWeight.w800, ls: .08))),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              for (final r in page.related)
                if (inAppRouteForHref(r.href) != null && inAppRouteForHref(r.href) != '/page/${widget.slug}') _RelatedChip(label: r.label, onTap: () => _go(r.href)),
            ]),
          ),
        ],
        const SizedBox(height: 18),
        if (_stale)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text('Could not refresh. Showing the copy saved on your phone.', key: const Key('page-stale'), textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700)),
          ),
        Text('Saved on your phone · reads offline', key: const Key('page-offline-note'), textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700)),
      ],
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text, {required this.bg, required this.ink});

  final String text;
  final Color bg;
  final Color ink;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: t(14, color: ink, w: FontWeight.w800)),
      );
}

class _RelatedChip extends StatelessWidget {
  const _RelatedChip({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Material(
          color: C.white,
          shape: const StadiumBorder(side: BorderSide(color: C.line)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Row(mainAxisSize: MainAxisSize.min, children: [Text(label, style: t(14, color: C.maroon, w: FontWeight.w800))]),
              ),
            ),
          ),
        ),
      );
}

/// One white card: the heading and the blocks under it.
class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.blocks, required this.flower, required this.onLink});

  final List<PageBlock> blocks;
  final bool flower;
  final void Function(String href) onLink;

  static TextStyle get _body => t(15, w: FontWeight.w600, h: 1.6);

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    for (var i = 0; i < blocks.length; i++) {
      final b = blocks[i];
      final last = i == blocks.length - 1;
      switch (b.type) {
        case 'h2':
          children.add(Padding(
            padding: EdgeInsets.only(bottom: 10, right: flower ? SupCard.flowerRoom : 0),
            child: Semantics(header: true, child: Text(b.text, style: t(18, color: C.maroon, w: FontWeight.w800, h: 1.3))),
          ));
        case 'p':
          children.add(Padding(padding: EdgeInsets.only(bottom: last ? 0 : 10), child: _Spans(b.spans, style: _body, onLink: onLink)));
        case 'ul' || 'ol':
          children.add(Padding(
            padding: EdgeInsets.only(bottom: last ? 0 : 12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (var n = 0; n < b.items.length; n++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    SizedBox(width: 24, child: Text(b.type == 'ol' ? '${n + 1}.' : '•', style: _body)),
                    Expanded(child: _Spans(b.items[n], style: _body, onLink: onLink)),
                  ]),
                ),
            ]),
          ));
        case 'note':
          children.add(Padding(
            padding: EdgeInsets.only(bottom: last ? 0 : 4),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(color: C.teatint, borderRadius: BorderRadius.circular(16)),
              child: _Spans(b.spans, style: t(14, color: C.peacock, w: FontWeight.w700, h: 1.5), onLink: onLink, linkColor: C.peacock),
            ),
          ));
        case 'links':
          children.add(Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var n = 0; n < b.links.length; n++) _LinkRow(item: b.links[n], last: n == b.links.length - 1, onLink: onLink),
          ]));
        default:
          break;
      }
    }
    return SupCard(
      corner: flower ? DesiCorner.hibiscus : DesiCorner.none,
      radius: 22,
      padding: const EdgeInsets.fromLTRB(18, 20, 18, 20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

class _LinkRow extends StatelessWidget {
  const _LinkRow({required this.item, required this.last, required this.onLink});

  final PageLinkItem item;
  final bool last;
  final void Function(String href) onLink;

  @override
  Widget build(BuildContext context) {
    final tappable = inAppRouteForHref(item.href) != null;
    final body = Container(
      constraints: const BoxConstraints(minHeight: 48),
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(item.title, style: t(16, color: tappable ? C.maroon : C.deep, w: FontWeight.w800)),
            if (item.text.isNotEmpty) Text(item.text, style: t(14, color: C.muted, w: FontWeight.w600, h: 1.4)),
          ]),
        ),
        if (tappable) const Icon(Icons.chevron_right_rounded, color: C.maroon),
      ]),
    );
    if (!tappable) return body;
    return Semantics(button: true, child: InkWell(onTap: () => onLink(item.href), child: body));
  }
}

/// Rich text for spans: bold, italic, line breaks, and links that go to [onLink] when the app has a screen for them.
class _Spans extends StatefulWidget {
  const _Spans(this.spans, {required this.style, required this.onLink, this.linkColor = C.lav});

  final List<PageSpan> spans;
  final TextStyle style;
  final void Function(String href) onLink;
  final Color linkColor;

  @override
  State<_Spans> createState() => _SpansState();
}

class _SpansState extends State<_Spans> {
  final List<TapGestureRecognizer> _recognizers = <TapGestureRecognizer>[];

  void _dispose() {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
  }

  @override
  void dispose() {
    _dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _dispose();
    final out = <InlineSpan>[];
    for (final s in widget.spans) {
      if (s.isBreak) {
        out.add(const TextSpan(text: '\n'));
        continue;
      }
      var style = widget.style;
      if (s.strong) style = style.copyWith(fontWeight: FontWeight.w800);
      if (s.em) style = style.copyWith(fontStyle: FontStyle.italic);
      GestureRecognizer? rec;
      final href = s.href;
      if (href != null && inAppRouteForHref(href) != null) {
        style = style.copyWith(color: widget.linkColor, decoration: TextDecoration.underline, decorationColor: widget.linkColor, fontWeight: FontWeight.w800);
        final r = TapGestureRecognizer()..onTap = () => widget.onLink(href);
        _recognizers.add(r);
        rec = r;
      }
      out.add(TextSpan(text: s.text, style: style, recognizer: rec));
    }
    return Text.rich(TextSpan(style: widget.style, children: out));
  }
}
