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
  // Fires a `composio` card action (Rename, Delete, Schedule a meeting…). The
  // host (chat thread) POSTs {tool, args} to /api/ava/genui/action, appends any
  // refreshed surface it returns, and gives back a short answer for a snackbar.
  // Returns null if no host is wired.
  final Future<String?> Function(String tool, Map<String, dynamic> args)? onComposio;
  const AvaA2uiSurface({super.key, required this.surface, this.onPrompt, this.onComposio});

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
    // Alternation: "${id|messageId|event_id}" → first candidate that resolves.
    // Lets one id binding work across apps (Drive row exposes `id`, Gmail row
    // exposes `messageId`) without per-app code.
    if (path.contains('|')) {
      for (final cand in path.split('|')) {
        final v = _lookup(cand.trim(), scope);
        if (v != null && v.toString().isNotEmpty) return v;
      }
      return null;
    }
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
      case 'input': return _inlineInput(n, scope);
      case 'form': return _form(n, scope);
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

  // ---- inline inputs + form (used when the composer emits an explicit form;
  // affordance actions use the modal sheet path in _dispatchComposio instead) ----
  _FieldSpec? _inputSpec(Map<String, dynamic> n, Map scope) {
    final name = (n['name'] ?? '').toString();
    if (name.isEmpty) return null;
    return _FieldSpec(
      name: name,
      label: (n['label'] ?? name).toString(),
      kind: (n['inputKind'] ?? n['kind'] ?? 'text').toString(),
      required: n['required'] == true,
      placeholder: n['placeholder']?.toString(),
      initial: n['value'] != null ? _resolve(n['value'], scope) : null,
      options: (n['options'] is List)
          ? (n['options'] as List).whereType<Map>().map((o) => _Opt(
                (o['value'] ?? '').toString(), (o['label'] ?? o['value'] ?? '').toString())).toList()
          : const [],
    );
  }

  // A lone input outside a form: render it read-only (it has nowhere to submit).
  Widget _inlineInput(Map<String, dynamic> n, Map scope) {
    final spec = _inputSpec(n, scope);
    if (spec == null) return const SizedBox.shrink();
    return _FieldLabel(label: spec.label, child: Text(spec.initial ?? spec.placeholder ?? '', style: ZineText.sub(size: 13, color: Zine.inkSoft)));
  }

  Widget _form(Map<String, dynamic> n, Map scope) {
    final specs = <_FieldSpec>[];
    for (final id in _childIds(n)) {
      final c = _node(id);
      if (c != null && (c['type'] ?? '') == 'input') {
        final s = _inputSpec(c, scope);
        if (s != null) specs.add(s);
      }
    }
    final submit = (n['submit'] is Map) ? (n['submit'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    final action = submit['action'];
    final label = (submit['label'] ?? 'Submit').toString();
    return _ComposioForm(
      title: '',
      fields: specs,
      inlineSubmitLabel: label,
      onInlineSubmit: (values) async {
        if (action is! Map) return;
        final a = action.cast<String, dynamic>();
        final tool = (a['tool'] ?? '').toString();
        final onComposio = widget.onComposio;
        if (tool.isEmpty || onComposio == null) return;
        final args = <String, dynamic>{};
        if (a['args'] is Map) {
          (a['args'] as Map).forEach((k, v) {
            final r = _resolve(v, scope);
            if (r.isNotEmpty) args[k.toString()] = r;
          });
        }
        final answer = await onComposio(tool, {...args, ...values});
        if (!mounted) return;
        final msg = (a['successText'] ?? answer ?? 'Done.').toString();
        if (msg.isNotEmpty) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            SnackBar(content: Text(msg), behavior: SnackBarBehavior.floating, duration: const Duration(seconds: 2)));
        }
      },
    );
  }

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
      case 'composio':
        await _dispatchComposio(a, scope);
        break;
    }
  }

  // Execute a `composio` action: (1) optional confirm for destructive actions,
  // (2) optional form to collect the tool's fields, (3) resolve id/${binding}
  // args against the row, (4) hand {tool, finalArgs} to the host to run + render.
  Future<void> _dispatchComposio(Map<String, dynamic> a, Map scope) async {
    final onComposio = widget.onComposio;
    final tool = (a['tool'] ?? '').toString();
    if (tool.isEmpty || onComposio == null) return;

    // 1) confirm (destructive)
    final confirm = a['confirm'];
    if (confirm != null && confirm.toString().isNotEmpty) {
      final ok = await _confirmDialog(_resolve(confirm, scope), destructive: true);
      if (ok != true) return;
    }

    // 2) collect fields (if any)
    final fields = _parseFields(a['fields'], scope);
    Map<String, dynamic> collected = const {};
    if (fields.isNotEmpty) {
      final res = await _collectFields(_resolve(a['label'], scope), fields);
      if (res == null) return; // cancelled
      collected = res;
    }

    // 3) resolve static / ${binding} args (ids, container defaults).
    final args = <String, dynamic>{};
    final rawArgs = a['args'];
    if (rawArgs is Map) {
      rawArgs.forEach((k, v) {
        final resolved = _resolve(v, scope);
        if (resolved.isNotEmpty) args[k.toString()] = resolved;
      });
    }
    // collected fields win (user input); ids/defaults fill the rest.
    final finalArgs = <String, dynamic>{...args, ...collected};

    Analytics.capture('genui_action', {'type': 'composio', 'tool': tool, 'fields': fields.length});
    final answer = await onComposio(tool, finalArgs);
    if (!mounted) return;
    final msg = (a['successText'] ?? answer ?? 'Done.').toString();
    if (msg.isNotEmpty) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text(msg), behavior: SnackBarBehavior.floating, duration: const Duration(seconds: 2)),
      );
    }
  }

  Future<bool?> _confirmDialog(String message, {bool destructive = false}) => showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: Zine.paper,
          content: Text(message, style: ZineText.value(size: 15)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text('Cancel', style: ZineText.button(size: 14, color: Zine.inkSoft))),
            TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(destructive ? 'Delete' : 'Confirm', style: ZineText.button(size: 14, color: destructive ? Zine.coralMark : Zine.ink)),
            ),
          ],
        ),
      );

  // Parse the action's `fields` array into typed specs, resolving any default
  // `value` bindings against the current row scope.
  List<_FieldSpec> _parseFields(dynamic raw, Map scope) {
    if (raw is! List) return const [];
    final out = <_FieldSpec>[];
    for (final f in raw) {
      if (f is! Map) continue;
      final m = f.cast<String, dynamic>();
      final name = (m['name'] ?? '').toString();
      if (name.isEmpty) continue;
      out.add(_FieldSpec(
        name: name,
        label: (m['label'] ?? name).toString(),
        kind: (m['kind'] ?? 'text').toString(),
        required: m['required'] == true,
        placeholder: m['placeholder']?.toString(),
        initial: m['value'] != null ? _resolve(m['value'], scope) : null,
        options: (m['options'] is List)
            ? (m['options'] as List).whereType<Map>().map((o) => _Opt(
                  (o['value'] ?? '').toString(),
                  (o['label'] ?? o['value'] ?? '').toString(),
                )).toList()
            : const [],
      ));
    }
    return out;
  }

  // Modal sheet that collects the action's fields. Returns the value map, or null
  // if the user cancelled. Validates that required fields are filled.
  Future<Map<String, dynamic>?> _collectFields(String title, List<_FieldSpec> fields) {
    return showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: _ComposioForm(title: title.isEmpty ? 'Details' : title, fields: fields),
      ),
    );
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
      // capability-action icons
      case 'pencil-simple': return PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill);
      case 'trash': return PhosphorIcons.trash(PhosphorIconsStyle.fill);
      case 'folder': return PhosphorIcons.folder(PhosphorIconsStyle.fill);
      case 'copy': return PhosphorIcons.copy(PhosphorIconsStyle.fill);
      case 'share-network': return PhosphorIcons.shareNetwork(PhosphorIconsStyle.fill);
      case 'download-simple': return PhosphorIcons.downloadSimple(PhosphorIconsStyle.fill);
      case 'arrow-square-out': return PhosphorIcons.arrowSquareOut(PhosphorIconsStyle.bold);
      case 'arrow-bend-up-left': return PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold);
      case 'plus': return PhosphorIcons.plus(PhosphorIconsStyle.bold);
      case 'dots-three': return PhosphorIcons.dotsThree(PhosphorIconsStyle.bold);
      default: return PhosphorIcons.circle(PhosphorIconsStyle.bold);
    }
  }
}

// ---- form field model + editors (shared by the modal sheet and inline forms) ----

class _Opt {
  final String value;
  final String label;
  const _Opt(this.value, this.label);
}

class _FieldSpec {
  final String name;
  final String label;
  final String kind; // text|textarea|number|date|time|datetime|select|checkbox
  final bool required;
  final String? placeholder;
  final String? initial;
  final List<_Opt> options;
  const _FieldSpec({
    required this.name,
    required this.label,
    required this.kind,
    required this.required,
    this.placeholder,
    this.initial,
    this.options = const [],
  });
}

// A labelled wrapper around any field editor (tag-style label above the control).
class _FieldLabel extends StatelessWidget {
  final String label;
  final Widget child;
  const _FieldLabel({required this.label, required this.child});
  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label.toUpperCase(), style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
          const SizedBox(height: 4),
          child,
        ],
      );
}

// The collecting form: renders an editor per field, validates required fields,
// and returns the value map. Used as a modal sheet (Navigator.pop) and inline
// (onInlineSubmit). One implementation for both keeps behaviour identical.
class _ComposioForm extends StatefulWidget {
  final String title;
  final List<_FieldSpec> fields;
  final String? inlineSubmitLabel;
  final Future<void> Function(Map<String, dynamic> values)? onInlineSubmit;
  const _ComposioForm({required this.title, required this.fields, this.inlineSubmitLabel, this.onInlineSubmit});
  @override
  State<_ComposioForm> createState() => _ComposioFormState();
}

class _ComposioFormState extends State<_ComposioForm> {
  final Map<String, dynamic> _values = {};
  final Map<String, TextEditingController> _controllers = {};
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    for (final f in widget.fields) {
      if (f.kind == 'checkbox') {
        _values[f.name] = (f.initial == 'true');
      } else if (f.kind == 'select') {
        _values[f.name] = f.initial ?? (f.options.isNotEmpty ? f.options.first.value : '');
      } else if (f.kind == 'date' || f.kind == 'time' || f.kind == 'datetime') {
        if (f.initial != null && f.initial!.isNotEmpty) _values[f.name] = f.initial;
      } else {
        final c = TextEditingController(text: f.initial ?? '');
        _controllers[f.name] = c;
      }
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Map<String, dynamic>? _gather() {
    final out = <String, dynamic>{};
    for (final f in widget.fields) {
      dynamic v;
      if (_controllers.containsKey(f.name)) {
        v = _controllers[f.name]!.text.trim();
      } else {
        v = _values[f.name];
      }
      final empty = v == null || (v is String && v.isEmpty);
      if (f.required && empty && f.kind != 'checkbox') {
        setState(() => _error = '${f.label} is required');
        return null;
      }
      if (!empty) out[f.name] = v;
    }
    return out;
  }

  Future<void> _submit() async {
    final values = _gather();
    if (values == null) return;
    if (widget.onInlineSubmit != null) {
      setState(() => _busy = true);
      try { await widget.onInlineSubmit!(values); } finally { if (mounted) setState(() => _busy = false); }
    } else {
      Navigator.of(context).pop(values);
    }
  }

  @override
  Widget build(BuildContext context) {
    final editors = <Widget>[];
    for (final f in widget.fields) {
      editors.add(Padding(padding: const EdgeInsets.only(bottom: 12), child: _editor(f)));
    }
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (widget.title.isNotEmpty) Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(widget.title, style: ZineText.cardTitle(size: 18)),
            ),
            ...editors,
            if (_error != null) Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(_error!, style: ZineText.sub(size: 12, color: Zine.coralMark)),
            ),
            SizedBox(
              width: double.infinity,
              child: GestureDetector(
                onTap: _busy ? null : _submit,
                child: Container(
                  height: 46,
                  decoration: BoxDecoration(color: Zine.lime, border: Zine.border, borderRadius: BorderRadius.circular(100), boxShadow: Zine.shadowSm),
                  alignment: Alignment.center,
                  child: _busy
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink))
                      : Text(widget.inlineSubmitLabel ?? 'Confirm', style: ZineText.button(size: 15)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _editor(_FieldSpec f) {
    switch (f.kind) {
      case 'checkbox':
        return Row(children: [
          Expanded(child: Text(f.label, style: ZineText.value(size: 14))),
          Switch(
            value: _values[f.name] == true,
            activeColor: Zine.lime,
            onChanged: (v) => setState(() => _values[f.name] = v),
          ),
        ]);
      case 'select':
        return _FieldLabel(
          label: f.label,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(color: Zine.card, border: Zine.border, borderRadius: BorderRadius.circular(12)),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                isExpanded: true,
                value: (_values[f.name] as String?)?.isNotEmpty == true ? _values[f.name] as String : (f.options.isNotEmpty ? f.options.first.value : null),
                items: f.options.map((o) => DropdownMenuItem(value: o.value, child: Text(o.label, style: ZineText.value(size: 14)))).toList(),
                onChanged: (v) => setState(() => _values[f.name] = v),
              ),
            ),
          ),
        );
      case 'date':
      case 'time':
      case 'datetime':
        return _FieldLabel(
          label: f.label,
          child: GestureDetector(
            onTap: () => _pickDateTime(f),
            child: Container(
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(color: Zine.card, border: Zine.border, borderRadius: BorderRadius.circular(12)),
              child: Text(
                (_values[f.name] ?? '').toString().isEmpty ? (f.placeholder ?? 'Pick…') : _values[f.name].toString(),
                style: ZineText.value(size: 14, color: (_values[f.name] ?? '').toString().isEmpty ? Zine.inkSoft : Zine.ink),
              ),
            ),
          ),
        );
      case 'number':
        return _FieldLabel(
          label: f.label,
          child: _textField(f, keyboardType: const TextInputType.numberWithOptions(decimal: true)),
        );
      case 'textarea':
        return _FieldLabel(label: f.label, child: _textField(f, maxLines: 4));
      default:
        return _FieldLabel(label: f.label, child: _textField(f));
    }
  }

  Widget _textField(_FieldSpec f, {int maxLines = 1, TextInputType? keyboardType}) => TextField(
        controller: _controllers[f.name],
        maxLines: maxLines,
        keyboardType: keyboardType,
        style: ZineText.value(size: 14),
        decoration: InputDecoration(
          hintText: f.placeholder,
          hintStyle: ZineText.sub(size: 13, color: Zine.inkMute),
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          filled: true,
          fillColor: Zine.card,
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Zine.ink, width: Zine.bw)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
      );

  // Pick a date/time and store as an ISO-8601 string Composio accepts
  // (start_datetime "2025-01-16T13:00:00"; date "2025-01-16"; time "13:00:00").
  Future<void> _pickDateTime(_FieldSpec f) async {
    final now = DateTime.now();
    DateTime? date = now;
    TimeOfDay? time = TimeOfDay.fromDateTime(now);
    if (f.kind != 'time') {
      date = await showDatePicker(context: context, initialDate: now, firstDate: DateTime(now.year - 1), lastDate: DateTime(now.year + 5));
      if (date == null) return;
    }
    if (f.kind != 'date') {
      time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(now));
      if (time == null) return;
    }
    String two(int x) => x.toString().padLeft(2, '0');
    String out;
    if (f.kind == 'date') {
      out = '${date!.year}-${two(date.month)}-${two(date.day)}';
    } else if (f.kind == 'time') {
      out = '${two(time!.hour)}:${two(time.minute)}:00';
    } else {
      out = '${date!.year}-${two(date.month)}-${two(date.day)}T${two(time!.hour)}:${two(time.minute)}:00';
    }
    setState(() => _values[f.name] = out);
  }
}
