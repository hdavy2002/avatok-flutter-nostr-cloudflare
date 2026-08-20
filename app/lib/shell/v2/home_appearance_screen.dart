import 'dart:io';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
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
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: Msg.hairline),
        title: Text('Appearance', style: ADText.appTitle()),
      ),
      body: ValueListenableBuilder<int>(
        valueListenable: HomePersonalisation.revision,
        builder: (context, _, __) => ListView(
          padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s5),
          children: [
            Text('Font size', style: ADText.sectionLabel()),
            const SizedBox(height: Msg.s2),
            _fontRow(),
            const SizedBox(height: Msg.s5),
            Text('Accent', style: ADText.sectionLabel()),
            const SizedBox(height: Msg.s2),
            _accentRow(),
            const SizedBox(height: Msg.s5),
            Text('Wallpaper', style: ADText.sectionLabel()),
            const SizedBox(height: Msg.s2),
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
      padding: const EdgeInsets.all(Msg.s2),
      child: Row(children: [
        for (final e in labels.entries)
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => HomePersonalisation.setFont(e.key),
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: Msg.s1),
                padding: const EdgeInsets.symmetric(vertical: Msg.s3),
                alignment: Alignment.center,
                // FILL/INK PAIR: the selected chip keeps DARK ink on the accent
                // (7.1:1). White-on-orange would have been ~2.5:1.
                decoration: BoxDecoration(
                  color: cur == e.key ? AD.primaryBadge : AD.card,
                  borderRadius: Msg.brMd,
                  border: Border.all(
                      color: cur == e.key ? AD.primaryBadge : AD.borderControl, width: 1),
                ),
                child: Text(e.value,
                    style: ADText.rowName(
                            c: cur == e.key ? AD.textOnInput : AD.textPrimary)
                        .copyWith(
                            fontSize: e.key == 'small'
                                ? 13
                                : e.key == 'large'
                                    ? 17
                                    : 15)),
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
          padding: const EdgeInsets.only(right: Msg.s3),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => HomePersonalisation.setAccent(e.key),
            child: Container(
              width: 52,
              height: 52,
              // Selection now reads as a WHITE ring — the old dark ink ring is
              // invisible against the near-black page.
              decoration: BoxDecoration(
                color: e.value,
                borderRadius: Msg.brMd,
                border: Border.all(
                    // [AVATAR-NORING-1] Was `AD.borderAvatar` when selected,
                    // which is now TRANSPARENT (the avatar ring was retired
                    // app-wide) — a selected swatch would have lost its ring
                    // entirely. This is a colour swatch, not an avatar, so it
                    // takes `borderControl`, the same ink `borderAvatar` used
                    // to hold. Selection is still signalled by the width jump
                    // (2.5 vs 1) plus the check glyph below.
                    color: AD.borderControl,
                    width: cur == e.key ? 2.5 : 1),
              ),
              child: cur == e.key
                  ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                      color: AD.textOnInput, size: 22)
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
            borderRadius: Msg.brMd,
            child: Image.file(File(path), height: 140, width: double.infinity, fit: BoxFit.cover),
          )
        else
          Container(
            height: 120,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AD.cardHover,
              borderRadius: Msg.brMd,
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: Text('No wallpaper', style: ADText.preview()),
          ),
        const SizedBox(height: Msg.s3),
        Row(children: [
          Expanded(
            child: ZineButton(
              label: 'Choose image',
              variant: ZineButtonVariant.blue,
              fontSize: 14,
              trailingIcon: false,
              onPressed: _busy ? null : _pick,
            ),
          ),
          if (path != null) ...[
            const SizedBox(width: Msg.s3),
            ZineButton(
              label: 'Remove',
              variant: ZineButtonVariant.ghost,
              fontSize: 14,
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
