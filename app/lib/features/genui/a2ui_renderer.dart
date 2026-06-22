// a2ui_renderer.dart — AvaTOK's A2UI renderer (the "GenUI" client surface).
//
// The worker emits an A2UI surface (worker/src/lib/a2ui.ts) in the Ava envelope:
// a flat map of components (the TEMPLATE) + a `data` model. Templates are cached
// globally (Redis) and hydrated per user here: string fields may contain
// `${path}` bindings and a `list` node repeats its `item` per array element. The
// renderer maps each component to a Zine widget (catalog) styled by our tokens —
// the agent picks COMPONENTS + LAYOUT, we own the colours/fonts. One renderer
// serves every Composio app, so a new app needs no new Flutter.
//
// Self-contained behind the AvaGenUi boundary; the official flutter/genui SDK
// (same A2UI shape) can swap in later without touching the worker or call sites.

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/ui/zine.dart';

class AvaA2uiSurface extends StatefulWidget {
  final Map<String, dynamic> surface;
  final void Function(String text)? onPrompt;
  const AvaA2uiSurface({super.key, required this.surface, this.onPrompt});

  @override
  State<AvaA2uiSurface> createState() => _AvaA2uiSurfaceState();
}

class _AvaA2uiSurfaceState extends State<AvaA2uiSurface> {
  static final _bind = RegExp(r'\$\{([^}]+)\}');

  @override
  void initState() {
    super.initState();
    final comps = widget.surface['components'];
    final nodes = comps is Map ? comps.length : 0;
    Analytics.capture('genui_render', {
      'surface_id': (widget.surface['surfaceId'] ?? '').toString(),
      'mode': 'client',
      'nodes': nodes,
    });
    // Blank-card guard: a surface with no components, or whose root id isn't in
    // the component map, renders to an empty SizedBox — a blank-looking reply.
    // Surface it as a distinct signal so these are queryable, not invisible.
    final root = (widget.surface['root'] ?? '').toString();
    if (nodes == 0 || _node(root) == null) {
      Analytics.genuiBlankSurface(
        tool: widget.surface['tool']?.toString(),
        reason: nodes == 0 ? 'no_components' : 'root_missing',
        nodes: nodes,
      );
    }
  }

  Map<String, dynamic> get _components =>
      (widget.surface['components'] as Map?)?.cast<String, dynamic>() ?? const {};
  Map<String, dynamic> get _data =>
      (widget.surface['data'] as Map?)?.cast<String, dynamic>() ?? const {};

  Map<String, dynamic>? _node(String? id) {
    if (id == null) return null;
    final n = _components[id];
    return n is Map ? n.cast<String, dynamic>() : null;
  }

  // ---- data binding ----
  dynamic _lookupIn(String path, dynamic base) {
    dynamic cur = base;
    for (final seg in path.split('.')) {
      if (seg == 'length' && cur is List) return cur.length;
      if (cur is Map && cur.containsKey(seg)) {
        cur = cur[seg];
      } else {
        return null;
      }
    }
    return cur;
  }

  dynamic _lookup(String path, Map scope) {
    final v = _lookupIn(path, scope);
    if (v != null) return v;
    if (!identical(scope, _data)) return _lookupIn(path, _data); // fall back to root
    return null;
  }

  String _resolve(Object? raw, Map scope) {
    final s = raw?.toString() ?? '';
    if (!s.contains(r'${')) return s;
    return s.replaceAllMapped(_bind, (m) {
      final v = _lookup(m.group(1)!.trim(), scope);
      return v == null ? '' : v.toString();
    });
  }

  @override
  Widget build(BuildContext context) => _render((widget.surface['root'] ?? '').toString(), _data);

  Widget _render(String? id, Map scope) {
    final n = _node(id);
    if (n == null) return const SizedBox.shrink();
    switch ((n['type'] ?? '').toString()) {
      case 'column': return _column(n, scope);
      case 'row': return _row(n, scope);
      case 'list': return _list(n, scope);
      case 'text': return _text(n, scope);
      case 'card': return _card(n, scope);
      case 'pill': return _pill(n, scope);
      case 'button': return _button(n, scope);
      case 'divider': return const Divider(color: Zine.inkMute, height: 1, thickness: 1);
      case 'spacer': return SizedBox(height: (n['size'] as num?)?.toDouble() ?? 8);
      case 'icon': return PhosphorIcon(_icon(n['name']?.toString()),
          size: (n['size'] as num?)?.toDouble() ?? 16, color: _tok(n['color']?.toString()));
      case 'openDay': return _openDay(n, scope);
      case 'eventRow': return _eventRow(n, scope);
      default: return const SizedBox.shrink();
    }
  }

  List<String> _childIds(Map<String, dynamic> n) =>
      (n['children'] as List?)?.map((e) => e.toString()).toList() ?? const [];

  Widget _stack(List<Widget> kids, double gap, {bool row = false, String align = 'start'}) {
    final out = <Widget>[];
    for (var i = 0; i < kids.length; i++) {
      if (i > 0 && gap > 0) out.add(row ? SizedBox(width: gap) : SizedBox(height: gap));
      out.add(kids[i]);
    }
    if (row) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: align == 'between' ? MainAxisAlignment.spaceBetween : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: out,
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: out);
  }

  Widget _column(Map<String, dynamic> n, Map scope) =>
      _stack(_childIds(n).map((c) => _render(c, scope)).toList(), (n['gap'] as num?)?.toDouble() ?? 8);

  Widget _row(Map<String, dynamic> n, Map scope) => _stack(
        _childIds(n).map((c) => _render(c, scope)).toList(),
        (n['gap'] as num?)?.toDouble() ?? 6,
        row: true, align: (n['align'] ?? 'center').toString(),
      );

  // Repeat `item` once per array element at `path`; each element is the scope.
  Widget _list(Map<String, dynamic> n, Map scope) {
    final raw = _lookup((n['path'] ?? '').toString(), scope);
    final items = raw is List ? raw : const [];
    final item = (n['item'] ?? '').toString();
    final gap = (n['gap'] as num?)?.toDouble() ?? 7;
    final kids = <Widget>[];
    for (final e in items) {
      final elScope = e is Map ? e.cast<String, dynamic>() : {'value': e};
      kids.add(_render(item, elScope));
    }
    return _stack(kids, gap);
  }

  Widget _text(Map<String, dynamic> n, Map scope) {
    final v = _resolve(n['value'], scope);
    final color = _tok(n['color']?.toString(), fallback: Zine.ink);
    switch ((n['variant'] ?? 'body').toString()) {
      case 'display': return Text(v, style: ZineText.cardTitle(size: 19, color: color));
      case 'title': return Text(v, style: ZineText.value(size: 16, color: color));
      case 'tag': return Text(v.toUpperCase(), style: ZineText.tag(size: 9.5, color: color));
      case 'sub': return Text(v, style: ZineText.sub(size: 12.5, color: color));
      default: return Text(v, style: ZineText.sub(size: 13.5, color: color));
    }
  }

  Widget _card(Map<String, dynamic> n, Map scope) {
    final fill = _tok(n['fill']?.toString(), fallback: Zine.card);
    final pad = (n['pad'] as num?)?.toDouble();
    final accent = n['accent'] != null ? _tok(n['accent'].toString()) : null;
    final child = _render(n['child']?.toString(), scope);
    final inner = Padding(padding: EdgeInsets.all(pad ?? 11), child: child);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(14), boxShadow: Zine.shadowXs),
      clipBehavior: Clip.antiAlias,
      child: accent == null
          ? inner
          // IntrinsicHeight is REQUIRED: the accent bar is a childless coloured
          // Container with no height. In a Row(crossAxisAlignment.stretch) under
          // the chat ListView's UNBOUNDED height, that bar stretches to infinite
          // height. Debug builds assert; the release APK has assertions stripped,
          // so it silently lays out NaN/∞ → the whole thread renders BLANK on the
          // next relayout (e.g. when the keyboard opens). IntrinsicHeight bounds
          // the Row to its tallest real child so stretch is finite. Do not remove.
          : IntrinsicHeight(
              child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Container(width: 7, color: accent), Expanded(child: inner)]),
            ),
    );
  }

  Widget _pill(Map<String, dynamic> n, Map scope) {
    final fill = _tok(n['fill']?.toString(), fallback: Zine.paper);
    final fg = _tok(n['fg']?.toString(), fallback: Zine.ink);
    final icon = n['icon']?.toString();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(100)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[PhosphorIcon(_icon(icon), size: 13, color: fg), const SizedBox(width: 6)],
        Flexible(child: Text(_resolve(n['label'], scope).toUpperCase(),
            maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.tag(size: 9.5, color: fg))),
      ]),
    );
  }

  Widget _button(Map<String, dynamic> n, Map scope) {
    final fill = _tok(n['fill']?.toString(), fallback: Zine.card);
    final icon = n['icon']?.toString();
    final full = n['full'] == true;
    final label = _resolve(n['label'], scope);
    final inner = Container(
      height: full ? 46 : null,
      padding: full ? null : const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
      decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(100), boxShadow: Zine.shadowSm),
      alignment: Alignment.center,
      child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
        if (icon != null) ...[PhosphorIcon(_icon(icon), size: 17, color: Zine.ink), const SizedBox(width: 7)],
        Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.button(size: 15))),
      ]),
    );
    final btn = GestureDetector(onTap: () => _dispatch(n['action'], scope), child: inner);
    return full ? SizedBox(width: double.infinity, child: btn) : btn;
  }

  Widget _openDay(Map<String, dynamic> n, Map scope) => Row(children: [
        Container(
          width: 42, height: 42,
          decoration: BoxDecoration(color: Zine.card, border: Zine.border, borderRadius: BorderRadius.circular(12)),
          alignment: Alignment.center,
          child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 24, color: Zine.ink),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(_resolve(n['title'], scope), style: ZineText.cardTitle(size: 19)),
          Text(_resolve(n['subtitle'], scope), style: ZineText.sub(size: 12.5, color: Zine.ink)),
        ])),
      ]);

  Widget _eventRow(Map<String, dynamic> n, Map scope) {
    final accent = n['accent'] != null ? _tok(n['accent'].toString()) : Zine.lime;
    final start = _resolve(n['start'], scope);
    final end = _resolve(n['end'], scope);
    final meta = <Widget>[];
    final loc = _resolve(n['location'], scope);
    if (loc.isNotEmpty) meta.add(_metaChip(PhosphorIcons.mapPin(PhosphorIconsStyle.fill), loc, Zine.inkSoft));
    if (n['video'] == true) meta.add(_metaChip(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), 'Video call', Zine.blueInk));
    final guests = (n['guests'] as num?)?.toInt() ?? 0;
    if (guests > 0) meta.add(_metaChip(PhosphorIcons.usersThree(PhosphorIconsStyle.fill), '$guests', Zine.inkSoft));
    // IntrinsicHeight is REQUIRED here: the coloured date strip and the 1px
    // divider are childless/height-less Containers. In Row(stretch) under the
    // chat ListView's UNBOUNDED height they'd stretch to infinite height —
    // silently (assertions are stripped from the release APK), blanking the
    // whole thread on the next relayout (e.g. when the keyboard opens). Bounding
    // the Row to its tallest real child keeps stretch finite. Do not remove.
    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        width: 64, color: accent, padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Text(start, textAlign: TextAlign.center, style: ZineText.value(size: 12.5)),
          if (end.isNotEmpty) Text(end, textAlign: TextAlign.center, style: ZineText.tag(size: 8.5, color: Zine.ink)),
        ]),
      ),
      Container(width: Zine.bw, color: Zine.ink),
      Expanded(child: Padding(
        padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(_resolve(n['title'], scope), maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 15)),
          if (meta.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Wrap(spacing: 10, runSpacing: 4, children: meta)),
        ]),
      )),
    ]));
  }

  Widget _metaChip(IconData icon, String label, Color color) => Row(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(icon, size: 12, color: color),
        const SizedBox(width: 4),
        Text(label, style: ZineText.sub(size: 11.5, color: color)),
      ]);

  // ---- actions ----
  Future<void> _dispatch(dynamic action, Map scope) async {
    if (action is! Map) return;
    final a = action.cast<String, dynamic>();
    final type = (a['type'] ?? '').toString();
    Analytics.capture('genui_action', {'type': type});
    switch (type) {
      case 'prompt':
        widget.onPrompt?.call(_resolve(a['text'], scope));
        break;
      case 'link':
        final url = _resolve(a['url'], scope);
        if (url.startsWith('http')) {
          try {
            await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
          } catch (e) {
            AvaLog.I.log('genui', 'link launch failed: $e');
          }
        }
        break;
    }
  }

  // ---- token + icon resolution (the catalog's look) ----
  Color _tok(String? t, {Color fallback = Zine.card}) {
    switch (t) {
      case 'paper': return Zine.paper;
      case 'paper2': return Zine.paper2;
      case 'card': return Zine.card;
      case 'ink': return Zine.ink;
      case 'inkSoft': return Zine.inkSoft;
      case 'inkMute': return Zine.inkMute;
      case 'blue': return Zine.blue;
      case 'blueInk': return Zine.blueInk;
      case 'lime': return Zine.lime;
      case 'coral': return Zine.coral;
      case 'coralMark': return Zine.coralMark;
      case 'lilac': return Zine.lilac;
      case 'mint': return Zine.mint;
      case 'mintInk': return Zine.mintInk;
      default: return fallback;
    }
  }

  IconData _icon(String? name) {
    switch (name) {
      case 'calendar-blank': return PhosphorIcons.calendarBlank(PhosphorIconsStyle.fill);
      case 'calendar-plus': return PhosphorIcons.calendarPlus(PhosphorIconsStyle.fill);
      case 'calendar-check': return PhosphorIcons.calendarCheck(PhosphorIconsStyle.fill);
      case 'calendar-dots': return PhosphorIcons.calendarDots(PhosphorIconsStyle.fill);
      case 'clock': return PhosphorIcons.clock(PhosphorIconsStyle.fill);
      case 'video-camera': return PhosphorIcons.videoCamera(PhosphorIconsStyle.fill);
      case 'map-pin': return PhosphorIcons.mapPin(PhosphorIconsStyle.fill);
      case 'users-three': return PhosphorIcons.usersThree(PhosphorIconsStyle.fill);
      case 'check': return PhosphorIcons.check(PhosphorIconsStyle.bold);
      case 'bell': return PhosphorIcons.bell(PhosphorIconsStyle.fill);
      case 'moon-stars': return PhosphorIcons.moonStars(PhosphorIconsStyle.fill);
      case 'sparkle': return PhosphorIcons.sparkle(PhosphorIconsStyle.fill);
      case 'paper-plane-right': return PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill);
      case 'tray': return PhosphorIcons.tray(PhosphorIconsStyle.fill);
      default: return PhosphorIcons.circle(PhosphorIconsStyle.bold);
    }
  }
}
