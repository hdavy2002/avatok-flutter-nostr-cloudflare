import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/api_exception.dart';
import '../data/models/merch.dart';
import '../data/telemetry.dart';
import '../ui/net_image.dart';
import 'desi.dart';
import 'merch_designer/contract.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-MERCH-APP-1] Small shared pieces of the merch screens (influencer studio and fan shop).

/// Whole rupees without paise, otherwise with: 700 -> ₹700, 6050 paise -> ₹60.50.
String merchRupees(int paise) => inr(paise / 100, paise: paise % 100 != 0);

const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String merchDate(DateTime d) {
  final l = d.toLocal();
  return '${l.day} ${_months[l.month - 1]} ${l.year}';
}

String merchDateTime(DateTime d) {
  final l = d.toLocal();
  final h12 = l.hour % 12 == 0 ? 12 : l.hour % 12;
  final mm = l.minute.toString().padLeft(2, '0');
  return '${merchDate(l)}, $h12:$mm ${l.hour < 12 ? 'am' : 'pm'}';
}

/// What to tell the person when a call failed: the worker's own sentence, or the stock line.
String merchErrorText(Object e) => e is ApiException ? e.userMessage : ApiException.genericText;

/// Catalog events `merch_*` (see Telemetry.catalogEvents). Never throws.
void merchEvent(String name, [Map<String, Object?> props = const {}]) => Telemetry.event(name, props);

/// A failure that is not an API error (for example the picture could not be drawn). The API client already reports its own.
void merchCapture(Object error, StackTrace stack, String where) => Telemetry.crash(error, stack, source: 'merch_$where');

/// Opens a tracking or receipt link in the browser.
Future<void> openMerchLink(BuildContext context, String url) async {
  final uri = Uri.tryParse(url);
  var ok = false;
  if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) {
    try {
      ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      ok = false;
    }
  }
  if (!ok && context.mounted) toast(context, 'Could not open that link.');
}

/// A rounded product picture; a shirt icon while it loads or when there is none.
class MerchThumb extends StatelessWidget {
  const MerchThumb(this.url, {super.key, this.size = 76});

  final String? url;
  final double size;

  @override
  Widget build(BuildContext context) {
    final fallback = Container(
      color: C.sand,
      alignment: Alignment.center,
      child: Icon(Icons.checkroom_rounded, size: size * 0.45, color: C.brassDark),
    );
    final u = url;
    return ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: SizedBox(width: size, height: size, child: u == null ? fallback : NetImage(u, fallback: fallback)),
    );
  }
}

/// A selectable pill (filters and tabs).
class MerchPill extends StatelessWidget {
  const MerchPill({super.key, required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: Material(
        color: selected ? C.maroon : C.white,
        shape: StadiumBorder(side: BorderSide(color: selected ? C.maroon : C.line, width: 1.5)),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 18),
            alignment: Alignment.center,
            child: Text(label, style: t(15, color: selected ? C.white : C.maroon)),
          ),
        ),
      ),
    );
  }
}

DesiChip merchProductChip(String status) => switch (status) {
      'live' => const DesiChip('Live', tone: DesiTone.tea, icon: Icons.check_circle_rounded),
      'pending' => const DesiChip('In review', tone: DesiTone.gold, icon: Icons.hourglass_top_rounded),
      'rejected' => const DesiChip('Needs a change', tone: DesiTone.rani, icon: Icons.error_outline_rounded),
      'hidden' => const DesiChip('Hidden', tone: DesiTone.lav, icon: Icons.visibility_off_rounded),
      _ => DesiChip(status, tone: DesiTone.white),
    };

DesiChip merchSellerStatusChip(String status) => switch (status) {
      'new' => const DesiChip('New', tone: DesiTone.rani, icon: Icons.fiber_new_rounded),
      'processing' => const DesiChip('Getting ready', tone: DesiTone.gold, icon: Icons.print_rounded),
      'shipped' => const DesiChip('Shipped', tone: DesiTone.lav, icon: Icons.local_shipping_rounded),
      'delivered' => const DesiChip('Delivered', tone: DesiTone.tea, icon: Icons.check_circle_rounded),
      'cancelled' => const DesiChip('Cancelled', tone: DesiTone.white, icon: Icons.cancel_rounded),
      _ => DesiChip(status, tone: DesiTone.white),
    };

DesiChip merchFanStatusChip(String status) => switch (status) {
      'awaiting_payment' => const DesiChip('Waiting for payment', tone: DesiTone.gold, icon: Icons.hourglass_top_rounded),
      'placed' => const DesiChip('Order placed', tone: DesiTone.lav, icon: Icons.receipt_long_rounded),
      'approved' => const DesiChip('Approved', tone: DesiTone.lav, icon: Icons.thumb_up_rounded),
      'printing' => const DesiChip('Being printed', tone: DesiTone.gold, icon: Icons.print_rounded),
      'shipped' => const DesiChip('On the way', tone: DesiTone.rani, icon: Icons.local_shipping_rounded),
      'delivered' => const DesiChip('Delivered', tone: DesiTone.tea, icon: Icons.check_circle_rounded),
      'cancelled' => const DesiChip('Cancelled', tone: DesiTone.white, icon: Icons.cancel_rounded),
      'refunded' => const DesiChip('Refunded', tone: DesiTone.white, icon: Icons.undo_rounded),
      _ => DesiChip(status, tone: DesiTone.white),
    };

/// A label on the left, a value on the right.
class MerchKv extends StatelessWidget {
  const MerchKv(this.label, this.value, {super.key, this.strong = false});

  final String label;
  final String value;
  final bool strong;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(flex: 4, child: Text(label, style: t(15, color: C.muted, w: FontWeight.w700))),
        const SizedBox(width: 8),
        Expanded(flex: 6, child: Text(value, textAlign: TextAlign.right, style: t(15, w: strong ? FontWeight.w800 : FontWeight.w700))),
      ]),
    );
  }
}

/// The steps an order has been through, newest last.
class MerchTimeline extends StatelessWidget {
  const MerchTimeline(this.entries, {super.key});

  final List<TimelineEntry> entries;

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final e in entries)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Padding(padding: EdgeInsets.only(top: 3), child: Icon(Icons.circle, size: 12, color: C.rani)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(e.label, style: t(16)),
                Text(merchDateTime(e.at), style: t(14, color: C.muted, w: FontWeight.w600)),
              ]),
            ),
          ]),
        ),
    ]);
  }
}

/// A white input field with a label above it (the theme draws the border).
class MerchField extends StatelessWidget {
  const MerchField({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.keyboard,
    this.maxLines = 1,
    this.formatters,
    this.onChanged,
    this.capitalization = TextCapitalization.none,
    this.fieldKey,
  });

  final String label;
  final TextEditingController controller;
  final String? hint;
  final TextInputType? keyboard;
  final int maxLines;
  final List<TextInputFormatter>? formatters;
  final ValueChanged<String>? onChanged;
  final TextCapitalization capitalization;
  final Key? fieldKey;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: t(15, color: C.maroon)),
        const SizedBox(height: 6),
        TextField(
          key: fieldKey,
          controller: controller,
          keyboardType: keyboard,
          maxLines: maxLines,
          inputFormatters: formatters,
          onChanged: onChanged,
          textCapitalization: capitalization,
          style: t(17, w: FontWeight.w700),
          decoration: InputDecoration(hintText: hint),
        ),
      ]),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── [HF-MERCH-STUDIO-2]

/// AI style chips: server id and the friendly label.
const List<(String, String)> merchAiStyles = [
  ('bollywood_poster', 'Bollywood poster'),
  ('madhubani', 'Madhubani'),
  ('warli', 'Warli'),
  ('kalamkari', 'Kalamkari'),
  ('pop_art', 'Pop art'),
  ('truck_art', 'Truck art'),
  ('watercolour', 'Watercolour'),
  ('line_art', 'Line art'),
  ('retro_70s', 'Retro 70s'),
  ('typography', 'Words and lettering'),
  ('clay_3d', '3D clay'),
  ('photo_real', 'Real photo look'),
];

/// Page header whose back arrow calls [onBack] (the wizard decides what back means on each step).
class MerchHeader extends StatelessWidget {
  const MerchHeader(this.title, {super.key, required this.onBack});

  final String title;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
      child: Row(children: [
        Semantics(
          button: true,
          label: 'Back',
          child: GestureDetector(
            onTap: onBack,
            behavior: HitTestBehavior.opaque,
            child: SizedBox(
              width: 48,
              height: 48,
              child: Center(
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: const BoxDecoration(shape: BoxShape.circle, color: C.sand),
                  child: const Icon(Icons.arrow_back_rounded, color: C.deep),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(child: Semantics(header: true, child: Text(title, style: t(24, color: C.maroon, w: FontWeight.w900)))),
        const Marigold(size: 38),
      ]),
    );
  }
}

/// Four steps under a toran (a string of hanging flower petals). Steps already done can be tapped to go back.
class MerchStepper extends StatelessWidget {
  const MerchStepper({super.key, required this.current, required this.onTap, this.compact = false, this.labels = const ['Your art', 'Product', 'Design', 'Price']});

  /// No toran: used on the design step, where the picture needs the room.
  final bool compact;

  final int current;
  final ValueChanged<int> onTap;
  final List<String> labels;

  Widget _node(int i) {
    final done = i < current;
    final on = i == current;
    final last = i == labels.length - 1;
    final circle = Container(
      width: 34,
      height: 34,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: on ? C.rani : (done ? C.maroon : C.white),
        border: Border.all(color: on || done ? C.clear : C.brass, width: 2),
      ),
      child: done ? const Icon(Icons.check_rounded, size: 20, color: C.white) : Text('${i + 1}', style: t(15, color: on ? C.white : C.muted)),
    );
    return Semantics(
      button: done,
      selected: on,
      label: 'Step ${i + 1}, ${labels[i]}${done ? ', done' : ''}',
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: done ? () => onTap(i) : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Row(children: [
              Expanded(child: i == 0 ? const SizedBox(height: 3) : Container(height: 3, color: i <= current ? C.maroon : C.line)),
              circle,
              Expanded(child: last ? const SizedBox(height: 3) : Container(height: 3, color: i < current ? C.maroon : C.line)),
            ]),
            const SizedBox(height: 4),
            Text(labels[i], maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: on ? C.maroon : C.muted, w: on ? FontWeight.w800 : FontWeight.w700)),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 6),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (!compact) ...[
          const SizedBox(height: 20, width: double.infinity, child: CustomPaint(painter: _ToranPainter())),
          const SizedBox(height: 4),
        ],
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [for (var i = 0; i < labels.length; i++) Expanded(child: _node(i))]),
      ]),
    );
  }
}

class _ToranPainter extends CustomPainter {
  const _ToranPainter();

  static const List<Color> _petals = [C.marigold, C.rani, C.lav, C.saffron];

  @override
  void paint(Canvas canvas, Size size) {
    final rope = Paint()
      ..color = C.brass
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawLine(const Offset(0, 2), Offset(size.width, 2), rope);
    final n = (size.width / 24).floor().clamp(4, 40).toInt();
    final step = size.width / n;
    for (var i = 0; i < n; i++) {
      final cx = step * (i + 0.5);
      final len = i.isEven ? 16.0 : 12.0;
      final path = Path()
        ..moveTo(cx - step * 0.34, 2)
        ..quadraticBezierTo(cx, 2 + len * 1.5, cx + step * 0.34, 2)
        ..close();
      canvas.drawPath(path, Paint()..color = _petals[i % _petals.length]);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// One picture of the tray: a rounded tile, a pink ring and tick when [selected], a small cross when [onRemove] is given.
class MerchArtThumb extends StatelessWidget {
  const MerchArtThumb(this.art, {super.key, this.size = 84, this.selected = false, this.onTap, this.onRemove, this.semanticLabel});

  final StudioArt art;
  final double size;
  final bool selected;
  final VoidCallback? onTap;
  final VoidCallback? onRemove;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final fallback = Container(color: C.sand, alignment: Alignment.center, child: const Icon(Icons.image_rounded, size: 28, color: C.brassDark));
    final bytes = art.bytes;
    final Widget picture = bytes != null
        ? Image.memory(bytes, fit: BoxFit.contain, cacheWidth: (size * 2).round(), gaplessPlayback: true, errorBuilder: (_, __, ___) => fallback)
        : (art.art.url.isEmpty ? fallback : NetImage(art.art.url, fallback: fallback, fit: BoxFit.contain));
    return Semantics(
      button: onTap != null,
      selected: selected,
      label: semanticLabel ?? 'Picture',
      child: SizedBox(
        width: size,
        height: size,
        child: Stack(clipBehavior: Clip.none, children: [
          Positioned.fill(
            child: Material(
              color: C.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: selected ? C.rani : C.line, width: selected ? 3 : 1.5)),
              clipBehavior: Clip.antiAlias,
              child: InkWell(onTap: onTap, child: Padding(padding: const EdgeInsets.all(5), child: picture)),
            ),
          ),
          if (selected)
            Positioned(
              left: 6,
              top: 6,
              child: Container(
                width: 24,
                height: 24,
                decoration: const BoxDecoration(shape: BoxShape.circle, color: C.rani),
                child: const Icon(Icons.check_rounded, size: 17, color: C.white),
              ),
            ),
          if (onRemove != null)
            Positioned(
              right: -12,
              top: -12,
              child: Semantics(
                button: true,
                label: 'Remove picture',
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: onRemove,
                  child: SizedBox(
                    width: 48,
                    height: 48,
                    child: Center(
                      child: Container(
                        width: 28,
                        height: 28,
                        decoration: BoxDecoration(shape: BoxShape.circle, color: C.deep, border: Border.all(color: C.white, width: 2)),
                        child: const Icon(Icons.close_rounded, size: 17, color: C.white),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ]),
      ),
    );
  }
}

/// A round colour swatch with its name underneath.
class MerchSwatch extends StatelessWidget {
  const MerchSwatch({super.key, required this.colour, required this.fill, required this.selected, required this.onTap});

  final MerchColour colour;
  final Color fill;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: colour.name,
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: SizedBox(
          width: 72,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const SizedBox(height: 2),
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(shape: BoxShape.circle, color: fill, border: Border.all(color: selected ? C.rani : C.brass, width: selected ? 4 : 1.5)),
              child: selected ? Icon(Icons.check_rounded, size: 24, color: fill.computeLuminance() > 0.5 ? C.deep : C.white) : null,
            ),
            const SizedBox(height: 2),
            Text(colour.name, maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700, h: 1.1)),
          ]),
        ),
      ),
    );
  }
}

/// A rounded note line: an icon and a sentence (warnings, tips).
class MerchNote extends StatelessWidget {
  const MerchNote(this.text, {super.key, this.icon = Icons.info_outline_rounded, this.color = C.amber});

  final String text;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 20, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: t(14, color: C.deep, w: FontWeight.w700))),
      ]),
    );
  }
}

/// A big tappable choice: icon, title and a line under it.
class MerchChoiceCard extends StatelessWidget {
  const MerchChoiceCard({super.key, required this.icon, required this.title, required this.sub, required this.tone, required this.onTap, this.busy = false, this.corner = DesiCorner.none});

  final IconData icon;
  final String title;
  final String sub;
  final DesiTone tone;
  final VoidCallback? onTap;
  final bool busy;
  final DesiCorner corner;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: '$title. $sub',
      child: DesiCard(
        tone: tone,
        corner: corner,
        padding: const EdgeInsets.all(16),
        onTap: onTap,
        child: Row(children: [
          busy
              ? const SizedBox(width: 60, height: 60, child: Center(child: SizedBox(width: 32, height: 32, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 4))))
              : DesiIconSquare(icon, tone: tone, size: 60),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(busy ? 'Uploading…' : title, style: t(19, color: C.maroon)),
              const SizedBox(height: 2),
              Text(sub, style: t(15, color: C.muted, w: FontWeight.w700)),
            ]),
          ),
          const Icon(Icons.chevron_right_rounded, size: 30, color: C.maroon),
        ]),
      ),
    );
  }
}

/// Swipeable pictures of the finished product (the mockups), with dots. Falls back to the designer's own preview.
class MerchGallery extends StatefulWidget {
  const MerchGallery({super.key, required this.urls, required this.previewPng, required this.wIn, required this.hIn});

  final List<String> urls;
  final Uint8List previewPng;
  final double wIn;
  final double hIn;

  @override
  State<MerchGallery> createState() => _MerchGalleryState();
}

class _MerchGalleryState extends State<MerchGallery> {
  final PageController _pages = PageController();
  int _page = 0;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final urls = widget.urls;
    final count = urls.isEmpty ? 1 : urls.length;
    return Column(children: [
      SizedBox(
        height: 280,
        child: PageView.builder(
          controller: _pages,
          itemCount: count,
          onPageChanged: (i) => setState(() => _page = i),
          itemBuilder: (context, i) => Container(
            margin: const EdgeInsets.symmetric(horizontal: 4),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.lavtint, C.blush]),
              borderRadius: BorderRadius.circular(28),
              border: Border.all(color: C.line),
            ),
            clipBehavior: Clip.antiAlias,
            child: urls.isEmpty
                ? Image.memory(widget.previewPng, fit: BoxFit.contain, gaplessPlayback: true)
                : NetImage(urls[i], fit: BoxFit.contain, fallback: const Center(child: CircularProgressIndicator(color: C.maroon, strokeWidth: 3))),
          ),
        ),
      ),
      if (count > 1)
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            for (var i = 0; i < count; i++)
              AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                width: i == _page ? 22 : 9,
                height: 9,
                margin: const EdgeInsets.symmetric(horizontal: 3),
                decoration: BoxDecoration(color: i == _page ? C.rani : C.brass, borderRadius: BorderRadius.circular(5)),
              ),
          ]),
        ),
      const SizedBox(height: 6),
      Text('Prints ${widget.wIn.toStringAsFixed(1)} × ${widget.hIn.toStringAsFixed(1)} in', style: t(14, color: C.muted, w: FontWeight.w700)),
    ]);
  }
}

/// Flowers popping in above the "published" card.
class MerchCelebrate extends StatelessWidget {
  const MerchCelebrate({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 150,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: 0, end: 1),
        duration: const Duration(milliseconds: 900),
        curve: Curves.elasticOut,
        builder: (context, v, _) => Stack(alignment: Alignment.center, children: [
          Positioned(left: 28, top: 22, child: Transform.scale(scale: v, child: const Hibiscus(size: 54))),
          Positioned(right: 28, top: 30, child: Transform.scale(scale: v, child: const Hibiscus(size: 46))),
          Positioned(left: 70, bottom: 8, child: Transform.scale(scale: v, child: const Jasmine(size: 30))),
          Positioned(right: 74, bottom: 12, child: Transform.scale(scale: v, child: const Jasmine(size: 26))),
          Transform.scale(scale: v, child: const Marigold(size: 120)),
        ]),
      ),
    );
  }
}

/// The "Your prices" table: base, what the fan pays and what the influencer earns, per size.
class MerchPriceTable extends StatelessWidget {
  const MerchPriceTable({super.key, required this.item, required this.bases, required this.lines, required this.markup, required this.valid, required this.catalog});

  final CatalogItem? item;
  final Map<String, int>? bases;
  final Map<String, QuoteLine> lines;
  final int markup;
  final bool valid;
  final MerchCatalog? catalog;

  @override
  Widget build(BuildContext context) {
    final it = item;
    final b = bases;
    final cat = catalog;
    return Column(children: [
      Row(children: [
        SizedBox(width: 50, child: Text('Size', style: t(14, color: C.muted))),
        Expanded(child: Text('Base', style: t(14, color: C.muted))),
        Expanded(child: Text('Fan pays*', style: t(14, color: C.muted))),
        Expanded(child: Text('You earn', textAlign: TextAlign.right, style: t(14, color: C.muted))),
      ]),
      const SizedBox(height: 4),
      if (it != null && b != null)
        for (final s in it.sizes)
          if (b.containsKey(s.size))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  SizedBox(width: 50, child: Text(s.size, style: t(16))),
                  Expanded(child: Text(merchRupees(b[s.size] ?? 0), style: t(15, w: FontWeight.w700))),
                  Expanded(child: Text(valid ? merchRupees((b[s.size] ?? 0) + markup * 100) : '—', style: t(15, w: FontWeight.w700))),
                  Expanded(child: Text(valid && cat != null ? merchRupees(cat.youEarnPaise(markup)) : '—', textAlign: TextAlign.right, style: t(15, color: C.rani))),
                ]),
                if (lines[s.size]?.printingPaise != null && lines[s.size]?.shippingPaise != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 50),
                    child: Text('Printing incl. GST ${merchRupees(lines[s.size]!.printingPaise!)} + Shipping ${merchRupees(lines[s.size]!.shippingPaise!)}', style: t(14, color: C.muted)),
                  ),
              ]),
            ),
      const SizedBox(height: 6),
      Align(alignment: Alignment.centerLeft, child: Text('*Fan pays base + your markup, incl. GST & delivery.', style: t(14, color: C.muted))),
    ]);
  }
}
