import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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

  // Dark-v2 accents. `ZineIconBadge` picks the glyph colour from the fill's
  // luminance, and every value here is mid-dark, so all seven render a white
  // glyph — no fill/ink collapse.
  static const Map<String, Color> _colors = {
    'wallet': AD.online,
    'calllogs': AD.tabCalls,
    'messages': AD.tabChats,
    'analytics': AD.tabCalls,
    'earnings': AD.online,
    'visitors': AD.danger,
    'listings': AD.newGroup,
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
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: Msg.hairline),
        title: Text('Cards', style: ADText.appTitle()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
          : Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s2),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text('Toggle cards on or off, and drag to reorder your Home dashboard.',
                      style: ADText.preview()),
                ),
              ),
              Expanded(
                child: ReorderableListView.builder(
                  padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s2, Msg.s4, Msg.s5),
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
      padding: const EdgeInsets.only(bottom: Msg.s3),
      child: ZineCard(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
        child: Row(children: [
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(right: Msg.s3),
              child: PhosphorIcon(PhosphorIcons.dotsSixVertical(PhosphorIconsStyle.regular),
                  size: 18, color: AD.textTertiary),
            ),
          ),
          ZineIconBadge(icon: (icon ?? _fallbackIcon)(), color: _colors[id] ?? AD.tabCalls),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(HomeCardPrefs.labels[id] ?? id, style: ADText.rowName()),
              const SizedBox(height: 1),
              Text(HomeCardPrefs.subtitles[id] ?? '',
                  style: ADText.statCaption(c: AD.textSecondary)),
            ]),
          ),
          // Thumb goes near-black on the accent track — white-on-accent would
          // have been ~2.5:1.
          Switch(
            value: on,
            activeColor: AD.textOnInput,
            activeTrackColor: AD.primaryBadge,
            inactiveThumbColor: AD.textSecondary,
            inactiveTrackColor: AD.card,
            onChanged: (v) => _toggle(id, v),
          ),
        ]),
      ),
    );
  }

  static IconData _fallbackIcon() => PhosphorIcons.squaresFour(PhosphorIconsStyle.bold);
}

typedef IconDataBuilder = IconData Function();
