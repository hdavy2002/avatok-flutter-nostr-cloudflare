import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/font_scale.dart';
import '../../core/ui/avatok_dark.dart';

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
      backgroundColor: AD.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(64),
        child: Container(
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 12, 10),
              child: Row(children: [
                const AdBackButton(),
                const SizedBox(width: 4),
                Expanded(child: Text('Display & fonts', style: ADText.appTitle(), maxLines: 1, overflow: TextOverflow.ellipsis)),
              ]),
            ),
          ),
        ),
      ),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Text('Make message, chat, contacts and menu text bigger or smaller. '
            'Big titles and icons stay the same size.', style: ADText.preview()),
        const SizedBox(height: 18),
        // Live preview card — text inside scales with the chosen value.
        AdCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('PREVIEW', style: ADText.sectionLabel()),
            const SizedBox(height: 10),
            MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(_v)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Amy Williams', style: ADText.threadName()),
                const SizedBox(height: 4),
                Text('Hey! Did you get my message? 👋', style: ADText.rowName()),
                const SizedBox(height: 2),
                Text('Delivered · 19:59', style: ADText.preview()),
              ]),
            ),
          ]),
        ),
        const SizedBox(height: 20),
        Row(children: [
          Text('TEXT SIZE', style: ADText.sectionLabel()),
          const Spacer(),
          Text(FontScale.labelFor(_v), style: ADText.statCaption(c: AD.iconSearch)),
        ]),
        Row(children: [
          PhosphorIcon(PhosphorIcons.textAa(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
          Expanded(
            child: Slider(
              value: _v,
              min: FontScale.min,
              max: FontScale.max,
              divisions: 6,
              activeColor: AD.iconSearch,
              label: FontScale.labelFor(_v),
              onChanged: _apply,
            ),
          ),
          PhosphorIcon(PhosphorIcons.textAa(PhosphorIconsStyle.bold), size: 26, color: AD.textPrimary),
        ]),
        const SizedBox(height: 6),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final p in const [('Small', 0.9), ('Default', 1.0), ('Large', 1.18), ('Larger', 1.35), ('Largest', 1.6)])
            ChoiceChip(
              label: Text(p.$1, style: ADText.rowName()),
              selected: (_v - p.$2).abs() < 0.02,
              selectedColor: AD.primaryBadge,
              backgroundColor: AD.card,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(100),
                side: const BorderSide(color: AD.borderControl, width: 1)),
              onSelected: (_) => _apply(p.$2),
            ),
        ]),
        const SizedBox(height: 18),
        Center(child: AdButton(
          label: 'Reset to default', variant: AdButtonVariant.ghost, fontSize: 14,
          icon: PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.bold), trailingIcon: false,
          onPressed: () => _apply(1.0))),
      ]),
    );
  }
}
