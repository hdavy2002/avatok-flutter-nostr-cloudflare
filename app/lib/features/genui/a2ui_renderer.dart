// a2ui_renderer.dart — AvaTOK's A2UI renderer (the "GenUI" client surface).
//
// The worker emits an A2UI surface (see worker/src/lib/a2ui.ts) inside the Ava
// message envelope; this renders it from our Zine design system — the agent picks
// COMPONENTS + LAYOUT, we own the colours/fonts (design tokens = the catalog's
// look). One generic renderer serves every Composio tool, so a new app needs no
// new Flutter. Calendar is the pilot consumer.
//
// Implementation note: this is a self-contained native renderer behind the
// [AvaGenUi] boundary. It consumes the A2UI v0.9 surface shape, so the official
// `flutter/genui` SDK (which uses A2UI under the hood) can be swapped in here
// later without changing the worker or the call sites.

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/ui/zine.dart';

/// Entry widget: renders an A2UI surface map `{version, surfaceId, root, components}`.
/// [onPrompt] is fired for `prompt` actions (send text back to Ava).
class AvaA2uiSurface extends StatefulWidget {
  final Map<String, dynamic> surface;
  final void Function(String text)? onPrompt;
  const AvaA2uiSurface({super.key, required this.surface, this.onPrompt});

  @override
  State<AvaA2uiSurface> createState() => _AvaA2uiSurfaceState();
}

class _AvaA2uiSurfaceState extends State<AvaA2uiSurface> {
  @override
  void initState() {
    super.initState();
    final comps = widget.surface['components'];
    Analytics.capture('genui_render', {
      'surface_id': (widget.surface['surfaceId'] ?? '').toString(),
      'mode': 'client',
      'nodes': comps is Map ? comps.length : 0,
    });
  }

  Map<String, dynamic> get _components =>
      (widget.surface['components'] as Map?)?.cast<String, dynamic>() ?? const {};

  Map<String, dynamic>? _node(String? id) {
    if (id == null) return null;
    final n = _components[id];
    return n is Map ? n.cast<String, dynamic>() : null;
  }

  @override
  Widget build(BuildContext context) {
    final root = (widget.surface['root'] ?? '').toString();
    return _render(root);
  }

  Widget _render(String? id) {
    final n = _node(id);
    if (n == null) return const SizedBox.shrink();
    switch ((n['type'] ?? '').toString()) {
      case 'column':
        return _column(n);
      case 'row':
        return _row(n);
      case 'text':
        return _text(n);
      case 'card':
        return _card(n);
      case 'pill':
        return _pill(n);
      case 'button':
        return _button(n);
      case 'divider':
        return const Divider(color: Zine.inkMute, height: 1, thickness: 1);
      case 'spacer':
        return SizedBox(height: (n['size'] as num?)?.toDouble() ?? 8);
      case 'icon':
        return PhosphorIcon(_icon(n['name']?.toString()),
            size: (n['size'] as num?)?.toDouble() ?? 16, color: _tok(n['color']?.toString()));
      case 'openDay':
        return _openDay(n);
      case 'eventRow':
        return _eventRow(n);
      default:
        return const SizedBox.shrink();
    }
  }

  List<String> _children(Map<String, dynamic> n) =>
      (n['children'] as List?)?.map((e) => e.toString()).toList() ?? const [];

  Widget _column(Map<String, dynamic> n) {
    final gap = (n['gap'] as num?)?.toDouble() ?? 8;
    final ids = _children(n);
    final out = <Widget>[];
    for (var i = 0; i < ids.length; i++) {
      if (i > 0 && gap > 0) out.add(SizedBox(height: gap));
      out.add(_render(ids[i]));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: out);
  }

  Widget _row(Map<String, dynamic> n) {
    final gap = (n['gap'] as num?)?.toDouble() ?? 6;
    final align = (n['align'] ?? 'center').toString();
    final ids = _children(n);
    final out = <Widget>[];
    for (var i = 0; i < ids.length; i++) {
      if (i > 0 && gap > 0) out.add(SizedBox(width: gap));
      out.add(_render(ids[i]));
    }
    return Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: align == 'between' ? MainAxisAlignment.spaceBetween : MainAxisAlignment.start,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: out,
    );
  }

  Widget _text(Map<String, dynamic> n) {
    final v = (n['value'] ?? '').toString();
    final variant = (n['variant'] ?? 'body').toString();
    final color = _tok(n['color']?.toString(), fallback: Zine.ink);
    switch (variant) {
      case 'display':
        return Text(v, style: ZineText.cardTitle(size: 19, color: color));
      case 'title':
        return Text(v, style: ZineText.value(size: 16, color: color));
      case 'tag':
        return Text(v.toUpperCase(), style: ZineText.tag(size: 9.5, color: color));
      case 'sub':
        return Text(v, style: ZineText.sub(size: 12.5, color: color));
      case 'body':
      default:
        return Text(v, style: ZineText.sub(size: 13.5, color: color));
    }
  }

  Widget _card(Map<String, dynamic> n) {
    final fill = _tok(n['fill']?.toString(), fallback: Zine.card);
    final pad = (n['pad'] as num?)?.toDouble();
    final accent = n['accent'] != null ? _tok(n['accent'].toString()) : null;
    final child = _render(n['child']?.toString());
    final inner = Padding(padding: EdgeInsets.all(pad ?? 11), child: child);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(14), boxShadow: Zine.shadowXs),
      clipBehavior: Clip.antiAlias,
      child: accent == null
          ? inner
          : Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Container(width: 7, color: accent),
              Expanded(child: inner),
            ]),
    );
  }

  Widget _pill(Map<String, dynamic> n) {
    final fill = _tok(n['fill']?.toString(), fallback: Zine.paper);
    final fg = _tok(n['fg']?.toString(), fallback: Zine.ink);
    final icon = n['icon']?.toString();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(100)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[PhosphorIcon(_icon(icon), size: 13, color: fg), const SizedBox(width: 6)],
        Text((n['label'] ?? '').toString().toUpperCase(), style: ZineText.tag(size: 9.5, color: fg)),
      ]),
    );
  }

  Widget _button(Map<String, dynamic> n) {
    final fill = _tok(n['fill']?.toString(), fallback: Zine.card);
    final icon = n['icon']?.toString();
    final full = n['full'] == true;
    final label = (n['label'] ?? '').toString();
    final inner = Container(
      height: full ? 46 : null,
      padding: full ? null : const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
      decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(100), boxShadow: Zine.shadowSm),
      alignment: Alignment.center,
      child: Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: [
        if (icon != null) ...[PhosphorIcon(_icon(icon), size: 17, color: Zine.ink), const SizedBox(width: 7)],
        Text(label, style: ZineText.button(size: 15)),
      ]),
    );
    final btn = GestureDetector(onTap: () => _dispatch(n['action']), child: inner);
    return full ? SizedBox(width: double.infinity, child: btn) : btn;
  }

  Widget _openDay(Map<String, dynamic> n) => Row(children: [
        Container(
          width: 42, height: 42,
          decoration: BoxDecoration(color: Zine.card, border: Zine.border, borderRadius: BorderRadius.circular(12)),
          alignment: Alignment.center,
          child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 24, color: Zine.ink),
        ),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text((n['title'] ?? '').toString(), style: ZineText.cardTitle(size: 19)),
          Text((n['subtitle'] ?? '').toString(), style: ZineText.sub(size: 12.5, color: Zine.ink)),
        ])),
      ]);

  Widget _eventRow(Map<String, dynamic> n) {
    final accent = n['accent'] != null ? _tok(n['accent'].toString()) : Zine.lime;
    final start = (n['start'] ?? '').toString();
    final end = (n['end'] ?? '').toString();
    final meta = <Widget>[];
    final loc = n['location']?.toString();
    if (loc != null && loc.isNotEmpty) {
      meta.add(_metaChip(PhosphorIcons.mapPin(PhosphorIconsStyle.fill), loc, Zine.inkSoft));
    }
    if (n['video'] == true) {
      meta.add(_metaChip(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), 'Video call', Zine.blueInk));
    }
    final guests = (n['guests'] as num?)?.toInt() ?? 0;
    if (guests > 0) {
      meta.add(_metaChip(PhosphorIcons.usersThree(PhosphorIconsStyle.fill), '$guests', Zine.inkSoft));
    }
    return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      // time rail
      Container(
        width: 64,
        color: accent,
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Text(start, textAlign: TextAlign.center, style: ZineText.value(size: 12.5)),
          if (end.isNotEmpty) Text(end, textAlign: TextAlign.center, style: ZineText.tag(size: 8.5, color: Zine.ink)),
        ]),
      ),
      Container(width: Zine.bw, color: Zine.ink),
      Expanded(child: Padding(
        padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text((n['title'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 15)),
          if (meta.isNotEmpty) Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Wrap(spacing: 10, runSpacing: 4, children: meta),
          ),
        ]),
      )),
    ]);
  }

  Widget _metaChip(IconData icon, String label, Color color) => Row(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(icon, size: 12, color: color),
        const SizedBox(width: 4),
        Text(label, style: ZineText.sub(size: 11.5, color: color)),
      ]);

  // ---- actions ----
  Future<void> _dispatch(dynamic action) async {
    if (action is! Map) return;
    final a = action.cast<String, dynamic>();
    final type = (a['type'] ?? '').toString();
    Analytics.capture('genui_action', {'type': type});
    switch (type) {
      case 'prompt':
        widget.onPrompt?.call((a['text'] ?? '').toString());
        break;
      case 'link':
        final url = (a['url'] ?? '').toString();
        if (url.startsWith('http')) {
          try {
            await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
          } catch (e) {
            AvaLog.I.log('genui', 'link launch failed: $e');
          }
        }
        break;
      // 'composio' actions are server-validated; wired in a later phase.
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
