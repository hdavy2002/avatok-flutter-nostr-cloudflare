import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/brand.dart';
import '../data/bag_store.dart';
import '../data/telemetry.dart';
import '../ui/net_image.dart';
import 'theme.dart';

/// [HF-CHANNEL-APP-1] Shared pieces of the "Galli Pop" screens (channel page, product, bag, checkout, profile photo), built to the
/// owner-approved phone mocks (.agent-wt/mock/Phone*.dc.html, 2026-10-23). Colours come from the [GP] tokens in theme.dart.
/// Nunito only (Comfortaa is not bundled in the app), every text at least 14 sp, every tap target at least 48 dp.

/// Catalog events of the channel work (see Telemetry.catalogEvents). Never throws.
void channelEvent(String name, [Map<String, Object?> props = const {}]) => Telemetry.event(name, props);

/// Small red caps label above a heading.
TextStyle gpEyebrow({Color color = GP.red}) => t(14, color: color, w: FontWeight.w800, ls: .14);

/// The hand-painted truck lettering: red italic with a marigold and an ink drop shadow.
TextSpan gpPaintedSpan(String text, double size) => TextSpan(
      text: text,
      style: t(size, color: GP.red, w: FontWeight.w900, h: 1.05).copyWith(
        fontStyle: FontStyle.italic,
        shadows: const [Shadow(color: GP.mari, offset: Offset(2, 2)), Shadow(color: GP.ink, offset: Offset(4, 4))],
      ),
    );

/// The Bollywood-poster title: yellow italic with a red drop shadow (for the dark sections).
TextStyle gpPoster(double size) => t(size, color: GP.yel, w: FontWeight.w900, h: .95).copyWith(
      fontStyle: FontStyle.italic,
      shadows: const [Shadow(color: GP.red, offset: Offset(3, 3))],
    );

/// A stand-in icon for a product with no picture, by category slug.
IconData gpCategoryIcon(String slug) {
  switch (slug) {
    case 'mugs':
      return Icons.coffee_rounded;
    case 'phone-covers':
      return Icons.smartphone_rounded;
    case 'bags':
      return Icons.shopping_bag_rounded;
    case 'posters':
      return Icons.image_rounded;
    default:
      return Icons.checkroom_rounded;
  }
}

// ------------------------------------------------------------------------------------------------ buttons and chips

enum GpBtn { red, ink, yellow, outline }

/// Chunky rounded button with a solid under-edge (the mock's `.btn`). Minimum 56 dp tall; the label wraps rather than being cut.
class GpButton extends StatelessWidget {
  const GpButton(this.label, {super.key, required this.onTap, this.kind = GpBtn.red, this.icon, this.height = 56});

  final String label;
  final VoidCallback? onTap;
  final GpBtn kind;
  final IconData? icon;
  final double height;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg, Color? edge, Color? border) = switch (kind) {
      GpBtn.red => (GP.red, GP.paper, GP.redDeep, null),
      GpBtn.ink => (GP.ink, GP.paper, GP.black, null),
      GpBtn.yellow => (GP.yel, GP.ink, GP.yelDeep, null),
      GpBtn.outline => (GP.paper, GP.ink, null, GP.ink),
    };
    final on = onTap != null;
    return Semantics(
      button: true,
      enabled: on,
      child: Container(
        decoration: ShapeDecoration(
          shape: const StadiumBorder(),
          shadows: [if (on && edge != null) BoxShadow(color: edge, offset: const Offset(0, 5))],
        ),
        child: Material(
          color: on ? bg : GP.line,
          shape: StadiumBorder(side: border != null && on ? BorderSide(color: border, width: 2) : BorderSide.none),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: height),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
                child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  if (icon != null) ...[Icon(icon, size: 20, color: on ? fg : GP.muted), const SizedBox(width: 8)],
                  Flexible(child: Text(label, textAlign: TextAlign.center, style: t(17, color: on ? fg : GP.muted, w: FontWeight.w900))),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Filter / length chip (the mock's `.chip`): white with a line, ink when chosen.
class GpChip extends StatelessWidget {
  const GpChip(this.label, {super.key, required this.on, required this.onTap});

  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: on,
      label: label,
      child: Material(
        color: on ? GP.ink : GP.paper,
        shape: StadiumBorder(side: BorderSide(color: on ? GP.ink : GP.line, width: 1.5)),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
              child: Center(widthFactor: 1, child: Text(label, style: t(15, color: on ? GP.paper : GP.ink, w: FontWeight.w800))),
            ),
          ),
        ),
      ),
    );
  }
}

enum GpStickerTone { yellow, pink, blue }

/// A tilted meme sticker (owner copy, decision D10), drawn by the owner's art in assets/channel/. The exact sticker text is the
/// semantic label. A text not in [_art] falls back to a plain pill so a new line of copy never shows nothing.
class GpSticker extends StatelessWidget {
  const GpSticker(this.text, {super.key, this.tone = GpStickerTone.yellow, this.angle = 0, this.width = 200});

  final String text;
  final GpStickerTone tone;
  final double angle;
  final double width;

  static const Map<String, String> _art = {
    'Fan merch, no cap.': 'assets/channel/sticker-no-cap.png',
    'POV: you found your fav creator': 'assets/channel/sticker-pov.png',
    'Meter down, baat shuru.': 'assets/channel/sticker-meter.png',
    'Rent-free in our heads': 'assets/channel/sticker-rent-free.png',
    "It's giving main character.": 'assets/channel/sticker-main-character.png',
    'Bag full, dil full.': 'assets/channel/sticker-bag-full.png',
  };

  @override
  Widget build(BuildContext context) {
    final asset = _art[text];
    if (asset != null) {
      return Padding(
        padding: const EdgeInsets.all(4),
        child: Transform.rotate(
          angle: angle,
          child: Image.asset(asset, width: width, fit: BoxFit.contain, semanticLabel: text),
        ),
      );
    }
    final (Color bg, Color fg) = switch (tone) {
      GpStickerTone.yellow => (GP.yel, GP.ink),
      GpStickerTone.pink => (GP.rani, GP.paper),
      GpStickerTone.blue => (GP.blue, GP.paper),
    };
    return Padding(
      padding: const EdgeInsets.all(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14), border: Border.all(color: GP.paper, width: 3)),
        child: Text(text, textAlign: TextAlign.center, style: t(16, color: fg, w: FontWeight.w900, h: 1.15)),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------------ header, bag button, bottom bar

/// The page header of the Galli Pop screens: round back, the brand logo or a [title] in the middle, and the Bag with its count.
class GpHeader extends StatelessWidget {
  const GpHeader({super.key, this.title, this.logo = false, this.bag = true});

  final String? title;
  final bool logo;
  final bool bag;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: GP.paper,
      child: Container(
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: GP.line))),
        child: SafeArea(
          bottom: false,
          child: SizedBox(
            height: 60,
            child: Row(children: [
              const _GpBack(),
              Expanded(
                child: Center(
                  child: logo
                      ? Text(
                          Brand.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: t(23, color: GP.red, w: FontWeight.w900).copyWith(fontStyle: FontStyle.italic, shadows: const [Shadow(color: GP.mari, offset: Offset(2, 2))]),
                        )
                      : Text(title ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(18, color: GP.ink, w: FontWeight.w900)),
                ),
              ),
              if (bag) const GpBagButton() else const SizedBox(width: 48),
            ]),
          ),
        ),
      ),
    );
  }
}

class _GpBack extends StatelessWidget {
  const _GpBack();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Back',
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: () => context.canPop() ? context.pop() : context.go('/reels'),
        child: const SizedBox(width: 48, height: 48, child: Icon(Icons.arrow_back_rounded, color: GP.ink)),
      ),
    );
  }
}

/// The Bag icon with a red count badge. Opens the bag.
class GpBagButton extends StatefulWidget {
  const GpBagButton({super.key});

  @override
  State<GpBagButton> createState() => _GpBagButtonState();
}

class _GpBagButtonState extends State<GpBagButton> {
  @override
  void initState() {
    super.initState();
    unawaited(BagStore.instance.ensureLoaded());
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: BagStore.instance,
      builder: (context, _) {
        final n = BagStore.instance.count;
        return Semantics(
          button: true,
          label: n == 0 ? 'Bag, empty' : 'Bag, $n ${n == 1 ? 'item' : 'items'}',
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: () => unawaited(context.push<Object?>('/bag')),
            child: SizedBox(
              width: 48,
              height: 48,
              child: Stack(clipBehavior: Clip.none, alignment: Alignment.center, children: [
                const Icon(Icons.shopping_bag_outlined, color: GP.ink, size: 26),
                if (n > 0)
                  Positioned(
                    right: 0,
                    top: 2,
                    child: Container(
                      constraints: const BoxConstraints(minWidth: 22, minHeight: 22),
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: GP.red, borderRadius: BorderRadius.circular(99)),
                      child: Text('$n', style: t(14, color: GP.paper, w: FontWeight.w900, h: 1.1)),
                    ),
                  ),
              ]),
            ),
          ),
        );
      },
    );
  }
}

/// The sticky bottom bar: white with a soft shadow, above the system gesture area.
class GpBottomBar extends StatelessWidget {
  const GpBottomBar({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: GP.paper,
        border: Border(top: BorderSide(color: GP.line)),
        boxShadow: [BoxShadow(color: GP.shadow, blurRadius: 24, offset: Offset(0, -8), spreadRadius: -12)],
      ),
      child: SafeArea(top: false, child: Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 12), child: child)),
    );
  }
}

// ------------------------------------------------------------------------------------------------ bands, qty

/// The owner's painted truck band between sections: 56 dp tall, repeated sideways, never stretched ([rick] is kept only so old
/// callers still compile; every band is the same art).
class GpBand extends StatelessWidget {
  const GpBand({super.key, this.rick = false});

  final bool rick;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox(
        height: 56,
        width: double.infinity,
        child: Image.asset('assets/channel/band-truck.png', height: 56, fit: BoxFit.fitHeight, repeat: ImageRepeat.repeatX, alignment: Alignment.centerLeft),
      ),
    );
  }
}

/// A − 1 + stepper in a white pill.
class GpQty extends StatelessWidget {
  const GpQty({super.key, required this.value, required this.onChanged, this.min = 1, this.max = 3});

  final int value;
  final ValueChanged<int> onChanged;
  final int min;
  final int max;

  @override
  Widget build(BuildContext context) {
    Widget step(IconData icon, String label, VoidCallback? onTap) => IconButton(
          tooltip: label,
          constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          onPressed: onTap,
          icon: Icon(icon, color: onTap == null ? GP.line : GP.ink),
        );
    return Material(
      color: GP.paper,
      shape: const StadiumBorder(side: BorderSide(color: GP.line, width: 1.5)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        step(Icons.remove_rounded, 'One less', value > min ? () => onChanged(value - 1) : null),
        Semantics(label: 'Quantity $value', child: SizedBox(width: 30, child: Text('$value', textAlign: TextAlign.center, style: t(19, color: GP.ink, w: FontWeight.w900)))),
        step(Icons.add_rounded, 'One more', value < max ? () => onChanged(value + 1) : null),
      ]),
    );
  }
}

/// The last pincode the fan checked or typed, kept in memory for this app session (the website keeps it in the tab's session
/// storage the same way) so the product page and the checkout fill it in. Nothing is written to disk.
class MerchLastPincode {
  static String? value;

  /// Remembers [pin] when it is a valid 6 digit pincode.
  static void remember(String pin) {
    final v = pin.trim();
    if (RegExp(r'^[1-9][0-9]{5}$').hasMatch(v)) value = v;
  }
}

// ------------------------------------------------------------------------------------------------ product card

/// A merch tile: plain soft square (no arch, no shelf), "+ Add" on it, category, title and price under it.
class GpProductCard extends StatelessWidget {
  const GpProductCard({
    super.key,
    required this.title,
    required this.categoryLabel,
    required this.priceText,
    required this.imageUrl,
    required this.onTap,
    this.onAdd,
    this.categorySlug = '',
    this.soldOut = false,
  });

  final String title;
  final String categoryLabel;
  final String priceText;
  final String? imageUrl;
  final VoidCallback onTap;
  final VoidCallback? onAdd;
  final String categorySlug;

  /// Every size is gone: the tile shows a disabled "Sold out" pill instead of "Add".
  final bool soldOut;

  @override
  Widget build(BuildContext context) {
    final stand = Center(child: Icon(gpCategoryIcon(categorySlug), size: 56, color: GP.muted));
    final url = imageUrl;
    return Semantics(
      button: true,
      label: '$title, $priceText',
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          AspectRatio(
            aspectRatio: 1,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: Stack(fit: StackFit.expand, children: [
                ColoredBox(color: GP.tile, child: url == null ? stand : NetImage(url, fit: BoxFit.contain, fallback: stand)),
                if (soldOut)
                  Positioned(
                    right: 8,
                    bottom: 8,
                    child: Semantics(
                      label: '$title is sold out',
                      child: Container(
                        constraints: const BoxConstraints(minHeight: 48),
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        alignment: Alignment.center,
                        decoration: const ShapeDecoration(color: GP.line, shape: StadiumBorder()),
                        child: Text('Sold out', style: t(15, color: GP.muted, w: FontWeight.w900)),
                      ),
                    ),
                  )
                else if (onAdd != null)
                  Positioned(
                    right: 8,
                    bottom: 8,
                    child: Semantics(
                      button: true,
                      label: 'Add $title to bag',
                      child: Material(
                        color: GP.ink,
                        shape: const StadiumBorder(),
                        child: InkWell(
                          customBorder: const StadiumBorder(),
                          onTap: onAdd,
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 14),
                              child: Row(mainAxisSize: MainAxisSize.min, children: [
                                const Icon(Icons.add_rounded, size: 18, color: GP.paper),
                                const SizedBox(width: 4),
                                Text('Add', style: t(15, color: GP.paper, w: FontWeight.w900)),
                              ]),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ]),
            ),
          ),
          const SizedBox(height: 8),
          if (categoryLabel.isNotEmpty) Text(categoryLabel.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: GP.muted, w: FontWeight.w800, ls: .06)),
          Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(16, color: GP.ink, w: FontWeight.w900, h: 1.2)),
          const SizedBox(height: 2),
          Text(priceText, style: t(16, color: GP.red, w: FontWeight.w900)),
        ]),
      ),
    );
  }
}

/// Centred section heading: eyebrow, big title, optional line, optional sticker.
class GpSectionHead extends StatelessWidget {
  const GpSectionHead({super.key, required this.eyebrow, this.title, this.titleWidget, this.sub, this.sticker, this.dark = false})
      : assert(title != null || titleWidget != null);

  final String eyebrow;
  final InlineSpan? title;

  /// Used instead of [title] when the heading needs a widget (for example a title scaled to fit one line).
  final Widget? titleWidget;
  final String? sub;
  final Widget? sticker;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Text(eyebrow.toUpperCase(), textAlign: TextAlign.center, style: gpEyebrow(color: dark ? GP.yel : GP.red)),
      const SizedBox(height: 6),
      Semantics(header: true, child: titleWidget ?? Text.rich(title!, textAlign: TextAlign.center)),
      if (sub != null) ...[
        const SizedBox(height: 6),
        Text(sub!, textAlign: TextAlign.center, style: t(15, color: dark ? GP.onDarkMuted : GP.muted, w: FontWeight.w700, h: 1.35)),
      ],
      if (sticker != null) ...[const SizedBox(height: 6), sticker!],
    ]);
  }
}
