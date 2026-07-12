import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'home_cards_store.dart';

/// Home → Cards manager (plan §3, §9 item 5). A master list of the v1 card types
/// with per-card on/off switches, persisted per-account via [HomeCardPrefs]
/// (scopedKey — a parent + child on one phone keep independent layouts).
/// Drag-reorder + additional cards land in Phase 3; v1 is a fixed set + order.
class HomeCardsManagerScreen extends StatefulWidget {
  const HomeCardsManagerScreen({super.key});

  @override
  State<HomeCardsManagerScreen> createState() => _HomeCardsManagerScreenState();
}

class _HomeCardsManagerScreenState extends State<HomeCardsManagerScreen> {
  Map<String, bool> _visible = {for (final id in HomeCardPrefs.ids) id: true};
  bool _loading = true;

  static final Map<String, IconDataBuilder> _icons = {
    'wallet': _walletIcon,
    'calllogs': _callsIcon,
    'messages': _messagesIcon,
  };

  static const Map<String, Color> _colors = {
    'wallet': Zine.mint,
    'calllogs': Zine.blue,
    'messages': Zine.lilac,
  };

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final v = await HomeCardPrefs.load();
    if (mounted) setState(() { _visible = v; _loading = false; });
  }

  Future<void> _toggle(String id, bool on) async {
    setState(() => _visible = {..._visible, id: on});
    await HomeCardPrefs.setVisible(id, on);
    Analytics.capture('shellv2_card_toggled', {'card': id, 'on': on});
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
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
              children: [
                Text('Choose what shows on your Home dashboard.',
                    style: ZineText.sub(size: 14)),
                const SizedBox(height: 16),
                for (final id in HomeCardPrefs.ids) _cardRow(id),
              ],
            ),
    );
  }

  Widget _cardRow(String id) {
    final on = _visible[id] ?? true;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ZineCard(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ZineIconBadge(icon: _icons[id]!(), color: _colors[id] ?? Zine.blue),
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

  static IconData _walletIcon() => PhosphorIcons.wallet(PhosphorIconsStyle.bold);
  static IconData _callsIcon() => PhosphorIcons.phone(PhosphorIconsStyle.bold);
  static IconData _messagesIcon() => PhosphorIcons.chatCircle(PhosphorIconsStyle.bold);
}

typedef IconDataBuilder = IconData Function();
