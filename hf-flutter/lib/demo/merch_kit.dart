import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/api_exception.dart';
import '../data/models/merch.dart';
import '../data/telemetry.dart';
import '../ui/net_image.dart';
import 'desi.dart';
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
