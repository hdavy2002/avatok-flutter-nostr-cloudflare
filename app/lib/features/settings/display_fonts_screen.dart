import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/font_scale.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Settings → Display & fonts. Lets the user make the whole app's text bigger or
/// smaller (applied live at the app root via [FontScale]).
class DisplayFontsScreen extends StatefulWidget {
  const DisplayFontsScreen({super.key});
  @override
  State<DisplayFontsScreen> createState() => _DisplayFontsScreenState();
}

class _DisplayFontsScreenState extends State<DisplayFontsScreen> {
  late double _v = FontScale.scale.value;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('settings', 'display_fonts');
  }

  void _apply(double v) {
    setState(() => _v = v);
    FontScale.set(v); // live — the root listens and re-scales the whole app
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Display & fonts', markWord: 'fonts'),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Text('Make text across the whole app bigger or smaller. This applies '
            'everywhere — chats, contacts, menus and more.', style: ZineText.sub(size: 13.5)),
        const SizedBox(height: 18),
        // Live preview card — text inside scales with the chosen value.
        ZineCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('PREVIEW', style: ZineText.kicker()),
            const SizedBox(height: 10),
            MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(_v)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Amy Williams', style: ZineText.cardTitle(size: 17)),
                const SizedBox(height: 4),
                Text('Hey! Did you get my message? 👋', style: ZineText.value(size: 15)),
                const SizedBox(height: 2),
                Text('Delivered · 19:59', style: ZineText.sub(size: 12.5)),
              ]),
            ),
          ]),
        ),
        const SizedBox(height: 20),
        Row(children: [
          Text('TEXT SIZE', style: ZineText.kicker()),
          const Spacer(),
          Text(FontScale.labelFor(_v), style: ZineText.tag(size: 12, color: Zine.blueInk)),
        ]),
        Row(children: [
          PhosphorIcon(PhosphorIcons.textAa(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
          Expanded(
            child: Slider(
              value: _v,
              min: FontScale.min,
              max: FontScale.max,
              divisions: 6,
              activeColor: Zine.blueInk,
              label: FontScale.labelFor(_v),
              onChanged: _apply,
            ),
          ),
          PhosphorIcon(PhosphorIcons.textAa(PhosphorIconsStyle.bold), size: 26, color: Zine.ink),
        ]),
        const SizedBox(height: 6),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final p in const [('Small', 0.9), ('Default', 1.0), ('Large', 1.18), ('Larger', 1.35), ('Largest', 1.6)])
            ChoiceChip(
              label: Text(p.$1, style: ZineText.value(size: 13)),
              selected: (_v - p.$2).abs() < 0.02,
              selectedColor: Zine.lime,
              backgroundColor: Zine.card,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(100),
                side: const BorderSide(color: Zine.ink, width: 1.5)),
              onSelected: (_) => _apply(p.$2),
            ),
        ]),
        const SizedBox(height: 18),
        Center(child: ZineButton(
          label: 'Reset to default', variant: ZineButtonVariant.ghost, fontSize: 14,
          icon: PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), trailingIcon: false,
          onPressed: () => _apply(1.0))),
      ]),
    );
  }
}
