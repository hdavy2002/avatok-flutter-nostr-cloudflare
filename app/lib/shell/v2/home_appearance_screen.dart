import 'dart:io';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'home_personalisation.dart';

/// Home → Appearance (plan §3 personalisation, §D): font size, accent theme and
/// wallpaper. All per-account scoped via [HomePersonalisation]; changes apply to
/// the Home surface live (the store's revision notifier repaints HomeRoot).
class HomeAppearanceScreen extends StatefulWidget {
  const HomeAppearanceScreen({super.key});

  @override
  State<HomeAppearanceScreen> createState() => _HomeAppearanceScreenState();
}

class _HomeAppearanceScreenState extends State<HomeAppearanceScreen> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper2,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Appearance', style: ZineText.appbar()),
      ),
      body: ValueListenableBuilder<int>(
        valueListenable: HomePersonalisation.revision,
        builder: (context, _, __) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            Text('FONT SIZE', style: ZineText.kicker()),
            const SizedBox(height: 8),
            _fontRow(),
            const SizedBox(height: 22),
            Text('ACCENT', style: ZineText.kicker()),
            const SizedBox(height: 8),
            _accentRow(),
            const SizedBox(height: 22),
            Text('WALLPAPER', style: ZineText.kicker()),
            const SizedBox(height: 8),
            _wallpaperCard(),
          ],
        ),
      ),
    );
  }

  Widget _fontRow() {
    const labels = {'small': 'Small', 'default': 'Default', 'large': 'Large'};
    final cur = HomePersonalisation.fontKey;
    return ZineCard(
      padding: const EdgeInsets.all(10),
      child: Row(children: [
        for (final e in labels.entries)
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => HomePersonalisation.setFont(e.key),
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 4),
                padding: const EdgeInsets.symmetric(vertical: 12),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: cur == e.key ? Zine.lime : Zine.card,
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Border.all(color: Zine.ink, width: Zine.bw),
                  boxShadow: cur == e.key ? Zine.shadowXs : const <BoxShadow>[],
                ),
                child: Text(e.value,
                    style: ZineText.value(
                        size: e.key == 'small' ? 12.5 : e.key == 'large' ? 16.5 : 14.5)),
              ),
            ),
          ),
      ]),
    );
  }

  Widget _accentRow() {
    final cur = HomePersonalisation.accentKey;
    return Row(children: [
      for (final e in HomePersonalisation.accents.entries)
        Padding(
          padding: const EdgeInsets.only(right: 12),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => HomePersonalisation.setAccent(e.key),
            child: Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: e.value,
                borderRadius: BorderRadius.circular(Zine.rSm),
                border: Border.all(color: Zine.ink, width: cur == e.key ? Zine.bw + 1.5 : Zine.bw),
                boxShadow: cur == e.key ? Zine.shadowXs : const <BoxShadow>[],
              ),
              child: cur == e.key
                  ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: Zine.ink, size: 22)
                  : null,
            ),
          ),
        ),
    ]);
  }

  Widget _wallpaperCard() {
    final path = HomePersonalisation.wallpaperPath;
    return ZineCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (path != null)
          ClipRRect(
            borderRadius: BorderRadius.circular(Zine.rSm),
            child: Image.file(File(path), height: 140, width: double.infinity, fit: BoxFit.cover),
          )
        else
          Container(
            height: 120,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Zine.paper2,
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Border.all(color: Zine.inkMute, width: 1),
            ),
            child: Text('No wallpaper', style: ZineText.sub(size: 13.5)),
          ),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(
            child: ZineButton(
              label: 'Choose image',
              variant: ZineButtonVariant.blue,
              fontSize: 14.5,
              trailingIcon: false,
              onPressed: _busy ? null : _pick,
            ),
          ),
          if (path != null) ...[
            const SizedBox(width: 10),
            ZineButton(
              label: 'Remove',
              variant: ZineButtonVariant.ghost,
              fontSize: 14.5,
              trailingIcon: false,
              onPressed: _busy ? null : () => HomePersonalisation.clearWallpaper(),
            ),
          ],
        ]),
      ]),
    );
  }

  Future<void> _pick() async {
    setState(() => _busy = true);
    final ok = await HomePersonalisation.pickWallpaper();
    if (mounted) setState(() => _busy = false);
    Analytics.capture('shellv2_wallpaper_set', {'ok': ok});
  }
}
