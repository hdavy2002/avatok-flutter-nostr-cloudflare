import 'package:flutter/material.dart';

import '../../../core/theme/hf_theme.dart';
import '../data/wallet_models.dart';

/// Wallet-only palette; inherited typography and the floating navigation stay intact.
class WalletStyle {
  const WalletStyle._(this.dark);
  factory WalletStyle.of(BuildContext context) =>
      WalletStyle._(HfBrightness.isDark(context));

  final bool dark;
  Color get page => dark ? const Color(0xFF000000) : const Color(0xFFF6F3EE);
  Color get card => dark ? const Color(0xFF343438) : const Color(0xFFFFFDF9);
  Color get inset => dark ? const Color(0xFF484850) : const Color(0xFFE8E2DA);
  Color get ink => dark ? const Color(0xFFF8F6FF) : const Color(0xFF000000);
  Color get muted => dark ? const Color(0xFFE0DBEB) : const Color(0xFF4C4740);
  Color get line => dark ? const Color(0xFF5C5C66) : const Color(0xFFD8D1C9);
  static const primary = Color(0xFFF28C28);

  List<BoxShadow> get shadows => [
    BoxShadow(
      color: Colors.black.withValues(alpha: dark ? 0.55 : 0.14),
      blurRadius: 18,
      offset: const Offset(0, 6),
    ),
    if (dark) const BoxShadow(color: Color(0x245C5C66), blurRadius: 8),
  ];
}

/// The Wallet's neutral surface: radius 22, visible hairline and soft shadow.
class WalletSurface extends StatelessWidget {
  const WalletSurface({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.color,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  /// A tint instead of white (a notice, the debt banner).
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final style = WalletStyle.of(context);
    return Container(
      decoration: BoxDecoration(
        color: color ?? style.card,
        borderRadius: BorderRadius.circular(HfRadius.tile),
        border: Border.all(color: style.line),
        boxShadow: style.shadows,
      ),
      child: Material(
        type: MaterialType.transparency,
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

/// Section heading: Nunito 20/800.
class WalletSectionTitle extends StatelessWidget {
  const WalletSectionTitle(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(text, style: HfText.section.copyWith(color: WalletStyle.of(context).ink)),
  );
}

/// `Today`, `Yesterday`, else `10 Oct 2026`. Display only.
String walletDayLabel(DateTime? d, {DateTime? now}) {
  if (d == null) return '';
  final n = now ?? DateTime.now();
  final today = DateTime(n.year, n.month, n.day);
  final day = DateTime(d.year, d.month, d.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Yesterday';
  return shortDate(d);
}

/// One list row: a 40 px leading tile, a title and a 14 sp subtitle, an amount on the right.
class WalletRow extends StatelessWidget {
  const WalletRow({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle = '',
    this.trailing = '',
    this.trailingColor,
    this.onTap,
    this.showChevron = false,
  });

  final Widget leading;
  final String title;
  final String subtitle;
  final String trailing;
  final Color? trailingColor;
  final VoidCallback? onTap;
  final bool showChevron;

  @override
  Widget build(BuildContext context) {
    final style = WalletStyle.of(context);
    final strong = HfText.bodyStrong.copyWith(fontSize: 15, color: style.ink);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: HfSpacing.tap),
          child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: HfSpacing.xl,
          vertical: HfSpacing.lg,
        ),
        child: Row(
          children: [
            leading,
            const SizedBox(width: HfSpacing.lg),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: strong),
                  if (subtitle.isNotEmpty)
                    Text(
                      subtitle,
                      style: HfText.of(
                        context,
                        HfText.label,
                      ).copyWith(fontWeight: FontWeight.w400, color: style.muted),
                    ),
                ],
              ),
            ),
            if (trailing.isNotEmpty) ...[
              const SizedBox(width: HfSpacing.lg),
              Flexible(
                child: Text(
                  trailing,
                  style: strong.copyWith(color: trailingColor),
                  textAlign: TextAlign.end,
                ),
              ),
            ],
            if (showChevron) ...[
              const SizedBox(width: HfSpacing.sm),
              const Icon(Icons.chevron_right_rounded, size: 22),
            ],
          ],
        ),
      ),
        ),
      ),
    );
  }
}

/// A 40 px rounded-14 tile for [WalletRow.leading].
class WalletRowTile extends StatelessWidget {
  const WalletRowTile({super.key, required this.tint, this.icon, this.text});

  final HfTint tint;
  final IconData? icon;
  final String? text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 40,
      height: 40,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: WalletStyle.of(context).inset,
        borderRadius: BorderRadius.circular(HfRadius.chip),
      ),
      child: icon != null
          ? Icon(icon, size: 18, color: WalletStyle.of(context).ink)
          : Text(
              text ?? '',
              style: HfText.subsection.copyWith(color: WalletStyle.of(context).ink),
            ),
    );
  }
}

/// A bordered list of [rows] with hairlines between them. Long lists show [limit] rows and a "Show all" row.
/// An empty list shows [emptyText].
class WalletRowsCard extends StatefulWidget {
  const WalletRowsCard({
    super.key,
    required this.rows,
    this.limit = 5,
    this.emptyText,
  });

  final List<Widget> rows;
  final int limit;
  final String? emptyText;

  @override
  State<WalletRowsCard> createState() => _WalletRowsCardState();
}

class _WalletRowsCardState extends State<WalletRowsCard> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final style = WalletStyle.of(context);
    final rows = widget.rows;
    if (rows.isEmpty) {
      return WalletSurface(
        child: Text(
          widget.emptyText ?? '',
          style: HfText.of(context, HfText.body),
        ),
      );
    }
    final long = rows.length > widget.limit;
    final shown = (!long || _all) ? rows : rows.sublist(0, widget.limit);
    final line = style.line;
    return WalletSurface(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < shown.length; i++) ...[
            if (i > 0) Divider(color: line, height: 1, thickness: 1),
            shown[i],
          ],
          if (long) ...[
            Divider(color: line, height: 1, thickness: 1),
            TextButton(
              style: TextButton.styleFrom(
                minimumSize: const Size.fromHeight(HfSpacing.tap),
              ),
              onPressed: () => setState(() => _all = !_all),
              child: Text(_all ? 'Show less' : 'Show all (${rows.length})'),
            ),
          ],
        ],
      ),
    );
  }
}
