import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'home_cards_store.dart';

/// Home → Cards manager (plan §3). A master list of every card type with a per-card
/// on/off switch AND drag-to-reorder (Phase 3), persisted per-account via
/// [HomeCardPrefs] (scopedKey — a parent + child on one phone keep independent
/// layouts). The active cards render on Home in the order shown here.
class HomeCardsManagerScreen extends StatefulWidget {
  const HomeCardsManagerScreen({super.key});

  @override
  State<HomeCardsManagerScreen> createState() => _HomeCardsManagerScreenState();
}

class _HomeCardsManagerScreenState extends State<HomeCardsManagerScreen> {
  Map<String, bool> _visible = {for (final id in HomeCardPrefs.ids) id: true};
  List<String> _order = List<String>.from(HomeCardPrefs.ids);
  bool _loading = true;

  static final Map<String, IconDataBuilder> _icons = {
    'wallet': () => PhosphorIcons.wallet(PhosphorIconsStyle.bold),
    'calllogs': () => PhosphorIcons.phone(PhosphorIconsStyle.bold),
    'messages': () => PhosphorIcons.chatCircle(PhosphorIconsStyle.bold),
    'analytics': () => PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
    'earnings': () => PhosphorIcons.trendUp(PhosphorIconsStyle.bold),
    'visitors': () => PhosphorIcons.mapPin(PhosphorIconsStyle.bold),
    'listings': () => PhosphorIcons.storefront(PhosphorIconsStyle.bold),
  };

  static const Map<String, Color> _colors = {
    'wallet': Zine.mint,
    'calllogs': Zine.blue,
    'messages': Zine.lilac,
    'analytics': Zine.blue,
    'earnings': Zine.mint,
    'visitors': Zine.coral,
    'listings': Zine.lime,
  };

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final v = await HomeCardPrefs.load();
    final o = await HomeCardPrefs.order();
    if (mounted) setState(() { _visible = v; _order = o; _loading = false; });
  }

  Future<void> _toggle(String id, bool on) async {
    setState(() => _visible = {..._visible, id: on});
    await HomeCardPrefs.setVisible(id, on);
    Analytics.capture('shellv2_card_toggled', {'card': id, 'on': on});
  }

  Future<void> _reorder(int oldIndex, int newIndex) async {
    setState(() {
      if (newIndex > oldIndex) newIndex -= 1;
      final id = _order.removeAt(oldIndex);
      _order.insert(newIndex, id);
    });
    await HomeCardPrefs.setOrder(_order);
    Analytics.capture('shellv2_cards_reordered', {'order': _order.join(',')});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper2,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Cards', style: ZineText.appbar()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
          : Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text('Toggle cards on or off, and drag to reorder your Home dashboard.',
                      style: ZineText.sub(size: 14)),
                ),
              ),
              Expanded(
                child: ReorderableListView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  itemCount: _order.length,
                  onReorder: _reorder,
                  proxyDecorator: (child, index, animation) =>
                      Material(color: Colors.transparent, child: child),
                  itemBuilder: (context, i) => _cardRow(_order[i], i),
                ),
              ),
            ]),
    );
  }

  Widget _cardRow(String id, int index) {
    final on = _visible[id] ?? true;
    final icon = _icons[id];
    return Padding(
      key: ValueKey(id),
      padding: const EdgeInsets.only(bottom: 12),
      child: ZineCard(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(right: 10),
              child: PhosphorIcon(PhosphorIcons.dotsSixVertical(PhosphorIconsStyle.bold),
                  size: 18, color: Zine.inkSoft),
            ),
          ),
          ZineIconBadge(icon: (icon ?? _fallbackIcon)(), color: _colors[id] ?? Zine.blue),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(HomeCardPrefs.labels[id] ?? id, style: ZineText.cardTitle(size: 15.5)),
              const SizedBox(height: 1),
              Text(HomeCardPrefs.subtitles[id] ?? '',
                  style: ZineText.tag(size: 10.5, color: Zine.inkSoft)),
            ]),
          ),
          Switch(
            value: on,
            activeColor: Zine.ink,
            activeTrackColor: Zine.lime,
            onChanged: (v) => _toggle(id, v),
          ),
        ]),
      ),
    );
  }

  static IconData _fallbackIcon() => PhosphorIcons.squaresFour(PhosphorIconsStyle.bold);
}

typedef IconDataBuilder = IconData Function();
