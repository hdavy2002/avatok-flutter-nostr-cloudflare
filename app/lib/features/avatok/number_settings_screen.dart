import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import 'ava_number.dart';

/// Green used for number accents — reads clearly on the dark v2 surfaces.
const Color _numGreen = AD.online;

/// Settings → "Your number" (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §10C).
///
/// Everyone gets one virtual, country-standard, NON-PSTN number (free) that
/// represents them on the network and REPLACES the real phone as the user's
/// identity (card / QR / search). The picker only ever offers AVAILABLE numbers,
/// so no two users share one. Only PAID users can regenerate/change it — a free
/// user's number is locked after their one free generation (owner request 2026-06-27).
class NumberSettingsScreen extends StatefulWidget {
  /// Mandatory "choose your number" GATE (onboarding + existing users with no
  /// number). When true: the screen can't be dismissed (no back / system-back
  /// blocked), assigning a number calls [onAssigned], and a "Sign out instead"
  /// escape is shown so a user is never fully trapped (owner decision 2026-06-27).
  final bool gate;
  final VoidCallback? onAssigned;
  /// Fired alongside [onAssigned] with the pretty display of the number the user
  /// just picked, so the very next screen (the profile setup) can show it LOCKED
  /// without depending on the `me` cache/network round-trip landing first — the
  /// deterministic source that fixes the "Assigned just now" blank on onboarding.
  final ValueChanged<String>? onAssignedNumber;
  final VoidCallback? onSignOut;
  const NumberSettingsScreen({super.key, this.gate = false, this.onAssigned, this.onAssignedNumber, this.onSignOut});
  @override
  State<NumberSettingsScreen> createState() => _NumberSettingsScreenState();
}

class _NumberSettingsScreenState extends State<NumberSettingsScreen> {
  MyNumber? _me;
  List<NumberCountry> _countries = [];
  NumberCountry? _country;
  final _patternCtrl = TextEditingController();
  List<AvailableNumber> _avail = [];
  bool _loadingAvail = false;
  bool _busy = false;
  bool _picking = false; // showing the picker (vs the current-number summary)

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _patternCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final me = await AvaNumber.me();
    final countries = await AvaNumber.countries();
    if (!mounted) return;
    setState(() {
      _me = me;
      _countries = countries;
      // Default to United States (owner request 2026-06-27); fall back to the
      // first available country if the US plan isn't in the list.
      _country = countries.isEmpty
          ? null
          : countries.firstWhere((c) => c.iso2 == 'US', orElse: () => countries.first);
      _picking = !me.hasNumber; // jump straight to picking when no number yet
    });
    if (!me.canGenerate) Analytics.capture('assign_blocked_free_tier', const {'where': 'settings'});
    if (_picking && me.canGenerate) _loadAvailable();
  }

  Future<void> _loadAvailable() async {
    final c = _country;
    if (c == null) return;
    setState(() => _loadingAvail = true);
    final res = await AvaNumber.available(c.iso2, pattern: _patternCtrl.text.trim());
    if (!mounted) return;
    setState(() {
      _avail = res.numbers;
      _loadingAvail = false;
    });
  }

  Future<void> _pickCountry() async {
    final chosen = await showModalBottomSheet<NumberCountry>(
      context: context,
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: AD.borderControl, width: 1),
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet))),
      builder: (_) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: 8),
          children: [
            for (final c in _countries)
              ListTile(
                leading: Text(c.flag, style: const TextStyle(fontSize: 24)),
                title: Text(c.name, style: ADText.rowName()),
                subtitle: Text('+${c.dial}  ·  ${c.example}', style: ADText.preview(c: AD.textSecondary)),
                onTap: () => Navigator.pop(context, c),
              ),
          ],
        ),
      ),
    );
    if (chosen != null) {
      setState(() => _country = chosen);
      Analytics.capture('number_country_selected', {'country': chosen.iso2, 'name': chosen.name});
      _loadAvailable();
    }
  }

  Future<void> _confirm(AvailableNumber n) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Use this number?', style: ADText.threadName().copyWith(fontSize: 18)),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(n.display, style: ADText.appTitle(c: _numGreen).copyWith(fontSize: 20, letterSpacing: 0)),
          const SizedBox(height: 12),
          Row(children: [
            PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), size: 16, color: AD.online),
            const SizedBox(width: 6),
            Expanded(child: Text('Your real number stays private and is never shown.', style: ADText.preview(c: AD.textSecondary))),
          ]),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: Text('Back', style: ADText.rowName(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(context, true), child: Text('Use this number', style: ADText.rowName(c: _numGreen))),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    final prev = _me; // current number/plan BEFORE this assign (for change tracking)
    final res = await AvaNumber.assign(_country!.iso2, n.nsn);
    if (!mounted) return;
    setState(() => _busy = false);
    if (res.ok) {
      final me = await AvaNumber.me();
      final paid = prev?.entitled ?? me.entitled;
      final newDisplay = res.display ?? n.display;
      // Rich telemetry: who got which number, country, free/paid, and — for a
      // paid CHANGE — their previous number. `$set` writes person properties so a
      // user becomes findable in PostHog by their AvaTOK number.
      Analytics.capture('number_assigned', {
        'country': _country!.iso2,
        'number': newDisplay,
        'nsn': n.nsn,
        'plan': paid ? 'paid' : 'free',
        'is_change': prev?.hasNumber == true,
        if (prev?.hasNumber == true && (prev?.display ?? '').isNotEmpty)
          'previous_number': prev!.display!,
        'via': widget.gate ? 'onboarding_gate' : 'settings',
        if (Analytics.currentEmail != null) 'account_email': Analytics.currentEmail!,
        r'$set': <String, Object>{
          'avatok_number': newDisplay,
          'number_country': _country!.iso2,
          'number_plan': paid ? 'paid' : 'free',
        },
      });
      if (!mounted) return;
      setState(() { _me = me; _picking = false; });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Your number is now ${res.display}')));
      if (widget.gate) {
        Analytics.capture('number_gate_completed', {'country': _country!.iso2, 'plan': paid ? 'paid' : 'free'});
        // Hand the just-assigned number straight to the profile step (deterministic,
        // no cache/replica dependency), THEN leave the mandatory gate.
        widget.onAssignedNumber?.call(newDisplay);
        widget.onAssigned?.call(); // leave the mandatory gate
      }
    } else {
      Analytics.error(
        domain: 'number', code: res.error ?? 'assign_failed', action: 'assign',
        extra: {'country': _country!.iso2, 'via': widget.gate ? 'onboarding_gate' : 'settings'},
      );
      final msg = res.error == 'number_taken'
          ? 'Just taken — pick another'
          : res.error == 'upgrade_required'
              ? 'Available on paid plans'
              : 'Could not assign that number';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      if (res.error == 'number_taken') _loadAvailable();
    }
  }

  Future<void> _release() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: BorderRadius.circular(AD.rDialog)),
        title: Text('Release your number?', style: ADText.threadName().copyWith(fontSize: 18)),
        content: Text('Your real number will represent you again until you choose a new one.', style: ADText.preview(c: AD.textSecondary)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: Text('Cancel', style: ADText.rowName(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(context, true), child: Text('Release', style: ADText.rowName(c: AD.danger))),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    await AvaNumber.release();
    final me = await AvaNumber.me();
    if (!mounted) return;
    setState(() { _me = me; _busy = false; _picking = me.canGenerate; });
    if (_picking) _loadAvailable();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !widget.gate, // mandatory gate can't be backed out of
      child: Scaffold(
        resizeToAvoidBottomInset: true,
        backgroundColor: AD.bg,
        appBar: _header(
            title: widget.gate ? 'Choose your number' : 'Your number',
            showBack: !widget.gate),
        body: _me == null
            ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
            : widget.gate
                ? Column(children: [
                    Expanded(child: ListView(padding: const EdgeInsets.all(20), children: _content())),
                    SafeArea(
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: TextButton(
                          onPressed: widget.onSignOut,
                          child: Text('Sign out instead',
                              style: ADText.preview(c: AD.textSecondary)),
                        ),
                      ),
                    ),
                  ])
                : SafeArea(
                    child: ListView(padding: const EdgeInsets.all(20), children: _content()),
                  ),
      ),
    );
  }

  /// Inline dark v2 header (mirrors chat_list.dart) — replaces the light ZineAppBar.
  PreferredSizeWidget _header({required String title, bool showBack = true}) {
    return PreferredSize(
      preferredSize: const Size.fromHeight(72),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.headerFooter,
          border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
            child: Row(children: [
              if (showBack) ...[
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Container(
                    width: 42, height: 42,
                    decoration: BoxDecoration(
                      color: AD.card,
                      shape: BoxShape.circle,
                      border: Border.all(color: AD.borderControl, width: 1),
                    ),
                    child: Center(
                      child: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
                          size: 20, color: AD.textPrimary),
                    ),
                  ),
                ),
                const SizedBox(width: 14),
              ],
              Expanded(
                child: Text(title, style: ADText.appTitle(),
                    maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  // ---- Dark v2 building blocks (inline, replacing the light Zine* widgets) ---

  /// List/settings card surface.
  Widget _card({required Widget child, VoidCallback? onTap,
      EdgeInsetsGeometry padding = const EdgeInsets.all(18)}) {
    final box = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderCard, width: 1),
      ),
      child: child,
    );
    if (onTap == null) return box;
    return GestureDetector(behavior: HitTestBehavior.opaque, onTap: onTap, child: box);
  }

  /// Highlighted/accent card (pale accent tint) for calls-to-action.
  Widget _accentCard({required Widget child, Color accent = AD.primaryBadge}) => Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: accent.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: accent.withValues(alpha: 0.40), width: 1),
        ),
        child: child,
      );

  Widget _iconBadge(IconData icon, {Color color = AD.iconSearch, double size = 28}) => Container(
        width: size, height: size,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(AD.rBadge),
        ),
        child: Icon(icon, size: size * 0.53, color: color),
      );

  /// Inline dark v2 button. [ghost] = card surface; else filled [fill] (primary).
  Widget _button({
    required String label,
    required VoidCallback? onPressed,
    IconData? icon,
    bool trailingIcon = true,
    bool fullWidth = false,
    double fontSize = 16,
    Color? fill,
    bool ghost = false,
  }) {
    final disabled = onPressed == null;
    late final Color bg, fg;
    Color? border;
    if (disabled) { bg = AD.card; fg = AD.textTertiary; border = AD.borderControl; }
    else if (ghost) { bg = AD.card; fg = AD.textPrimary; border = AD.borderControl; }
    else { bg = fill ?? AD.primaryBadge; fg = Colors.white; }
    final content = Row(
      mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null && !trailingIcon) ...[
          Icon(icon, size: fontSize + 2, color: fg),
          const SizedBox(width: 10),
        ],
        Flexible(
          child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w800, fontSize: fontSize, color: fg)),
        ),
        if (icon != null && trailingIcon) ...[
          const SizedBox(width: 10),
          Icon(icon, size: fontSize + 2, color: fg),
        ],
      ],
    );
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onPressed,
      child: Container(
        width: fullWidth ? double.infinity : null,
        padding: EdgeInsets.symmetric(horizontal: 24, vertical: fontSize >= 21 ? 17 : 14),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(100),
          border: border == null ? null : Border.all(color: border, width: 1),
        ),
        child: content,
      ),
    );
  }

  /// Body copy style on dark surfaces.
  TextStyle get _bodyStyle => ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14, height: 1.35);

  List<Widget> _content() {
    final me = _me!;
    if (!me.featureOn) {
      return [_infoCard('Not available', 'AvaTOK numbers aren’t available right now. Check back soon.')];
    }
    final widgets = <Widget>[];
    if (widget.gate) {
      widgets.add(_accentCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('PICK YOUR AVATOK NUMBER', style: ADText.sectionLabel(c: AD.primaryBadge)),
          const SizedBox(height: 8),
          Text('Choose a number to finish setting up. It represents you on AvaTOK — '
              'people call and message you on it — and keeps your real phone private. '
              'Pick any available number below.', style: _bodyStyle),
        ]),
      ));
      widgets.add(const SizedBox(height: 14));
    }
    if (me.hasNumber && !_picking) {
      widgets.add(
        _card(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('YOUR AVATOK NUMBER', style: ADText.sectionLabel()),
            const SizedBox(height: 10),
            Text(me.display ?? '', style: ADText.appTitle(c: _numGreen).copyWith(fontSize: 24, letterSpacing: 0)),
            const SizedBox(height: 8),
            Row(children: [
              PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), size: 15, color: AD.online),
              const SizedBox(width: 6),
              Expanded(child: Text('Your real number is hidden — people see this instead.', style: ADText.preview(c: AD.textSecondary))),
            ]),
          ]),
        ),
      );
      if (me.canGenerate) {
        // Paid: regenerate / release freely.
        widgets.addAll([
          const SizedBox(height: 14),
          _button(label: 'Change number', ghost: true, fullWidth: true, fontSize: 16,
              icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold), trailingIcon: false,
              onPressed: _busy ? null : () { setState(() => _picking = true); _loadAvailable(); }),
          const SizedBox(height: 10),
          _button(label: 'Release number', ghost: true, fullWidth: true, fontSize: 16,
              icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), trailingIcon: false,
              onPressed: _busy ? null : _release),
        ]);
      } else {
        // Free: this is their one free number — locked. Upgrade to change it.
        widgets.addAll([
          const SizedBox(height: 14),
          _accentCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                _iconBadge(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), color: AD.primaryBadge, size: 28),
                const SizedBox(width: 10),
                Expanded(child: Text('Your number is locked', style: ADText.threadName().copyWith(fontSize: 17))),
              ]),
              const SizedBox(height: 8),
              Text('You get one AvaTOK number free. Upgrade to a paid plan to generate a new number any time.', style: _bodyStyle),
            ]),
          ),
          const SizedBox(height: 12),
          _button(label: 'See plans', fullWidth: true,
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              onPressed: () { Navigator.of(context).maybePop(); }),
        ]);
      }
      return widgets;
    }

    // No number yet, or a paid user changing it. A free account that already used
    // its one free generation can't generate again — show the upgrade gate.
    if (!me.canGenerate) {
      return [
        _accentCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              _iconBadge(PhosphorIcons.hash(PhosphorIconsStyle.bold), color: AD.primaryBadge, size: 30),
              const SizedBox(width: 10),
              Expanded(child: Text('Generate a new number', style: ADText.threadName().copyWith(fontSize: 18))),
            ]),
            const SizedBox(height: 10),
            Text('Your free number generation is used up. Upgrade to a paid plan to generate a new number that represents you and hides your real phone.', style: _bodyStyle),
          ]),
        ),
        const SizedBox(height: 16),
        _button(
          label: 'See plans',
          fullWidth: true,
          icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
          onPressed: () { Navigator.of(context).maybePop(); },
        ),
      ];
    }

    // Picker — generate a fresh AvaTOK number. (Bringing your own number is a
    // premium feature reserved for later; for now everyone gets a generated one.)
    widgets.addAll([
      _card(
        onTap: _busy ? null : _pickCountry,
        child: Row(children: [
          Text(_country?.flag ?? '🌍', style: const TextStyle(fontSize: 22)),
          const SizedBox(width: 10),
          Expanded(child: Text(_country?.name ?? 'Choose country', style: ADText.rowName(), overflow: TextOverflow.ellipsis)),
          PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
        ]),
      ),
      const SizedBox(height: 12),
      // Pattern field (no cramped inline button — Search is its own button below).
      _patternField(),
      const SizedBox(height: 10),
      Row(children: [
        Expanded(
          child: _button(
            label: 'Search', fill: AD.iconSearch, fullWidth: true, fontSize: 15,
            icon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), trailingIcon: false,
            onPressed: _busy || _loadingAvail ? null : _loadAvailable),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _button(
            label: 'Shuffle', ghost: true, fullWidth: true, fontSize: 15,
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold), trailingIcon: false,
            onPressed: _busy || _loadingAvail ? null : () { _patternCtrl.clear(); _loadAvailable(); }),
        ),
      ]),
      const SizedBox(height: 12),
      Text('AVAILABLE NUMBERS', style: ADText.sectionLabel()),
      const SizedBox(height: 6),
    ]);
    if (_loadingAvail) {
      widgets.add(const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator(color: AD.iconSearch))));
    } else if (_avail.isEmpty) {
      widgets.add(Padding(padding: const EdgeInsets.symmetric(vertical: 16), child: Text('No matches — try different digits or tap Shuffle.', style: ADText.preview(c: AD.textSecondary))));
    } else {
      for (final n in _avail) {
        widgets.add(Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: _card(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            onTap: _busy ? null : () => _confirm(n),
            child: Row(children: [
              Expanded(child: Text(n.display, style: ADText.rowName().copyWith(fontSize: 16), overflow: TextOverflow.ellipsis)),
              const SizedBox(width: 6),
              Flexible(
                child: Text('available', style: ADText.statCaption(c: _numGreen),
                    overflow: TextOverflow.ellipsis, maxLines: 1),
              ),
              const SizedBox(width: 8),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 15, color: AD.textTertiary),
            ]),
          ),
        ));
      }
    }
    if (me.hasNumber) {
      widgets.addAll([
        const SizedBox(height: 8),
        _button(label: 'Keep current number', ghost: true, fullWidth: true, fontSize: 15,
            onPressed: _busy ? null : () => setState(() => _picking = false)),
      ]);
    }
    return widgets;
  }

  /// White pattern input (search dock idiom) with a coloured leading cell.
  Widget _patternField() => Container(
        decoration: BoxDecoration(
          color: AD.inputField,
          borderRadius: BorderRadius.circular(AD.rInput),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(children: [
          Container(
            width: 50,
            constraints: const BoxConstraints(minHeight: 52),
            color: AD.primaryBadge,
            alignment: Alignment.center,
            child: Icon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold), size: 22, color: Colors.white),
          ),
          Expanded(
            child: TextField(
              controller: _patternCtrl,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              onSubmitted: (_) => _loadAvailable(),
              cursorColor: AD.iconSearch,
              style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w700, fontSize: 15, color: AD.textOnInput),
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Want certain digits? e.g. 777',
                hintStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w700, fontSize: 15, color: AD.placeholderOnWhite),
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
              ),
            ),
          ),
        ]),
      );

  Widget _infoCard(String title, String body) => _card(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: ADText.threadName().copyWith(fontSize: 17)),
          const SizedBox(height: 8),
          Text(body, style: _bodyStyle),
        ]),
      );
}
