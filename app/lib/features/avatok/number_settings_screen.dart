import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_number.dart';

/// Settings → "Your number" (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §10C).
///
/// Paid users self-assign a virtual, country-standard, NON-PSTN number that
/// represents them on the network. Assigning one REPLACES the real phone as the
/// user's identity (card / QR / search). The picker only ever offers AVAILABLE
/// numbers, so no two users share one. Free users see an upgrade gate.
class NumberSettingsScreen extends StatefulWidget {
  const NumberSettingsScreen({super.key});
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
      _country = countries.isNotEmpty ? countries.first : null;
      _picking = !me.hasNumber; // jump straight to picking when no number yet
    });
    if (!me.entitled) Analytics.capture('assign_blocked_free_tier', const {'where': 'settings'});
    if (_picking && me.entitled) _loadAvailable();
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
      backgroundColor: Zine.paper,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: 8),
          children: [
            for (final c in _countries)
              ListTile(
                leading: Text(c.flag, style: const TextStyle(fontSize: 24)),
                title: Text(c.name, style: ZineText.value(size: 15)),
                subtitle: Text('+${c.dial}  ·  ${c.example}', style: ZineText.sub(size: 12)),
                onTap: () => Navigator.pop(context, c),
              ),
          ],
        ),
      ),
    );
    if (chosen != null) {
      setState(() => _country = chosen);
      _loadAvailable();
    }
  }

  Future<void> _confirm(AvailableNumber n) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Zine.paper,
        title: Text('Use this number?', style: ZineText.cardTitle(size: 18)),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(n.display, style: ZineText.cardTitle(size: 20, color: Zine.blue)),
          const SizedBox(height: 12),
          Row(children: [
            PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), size: 16, color: Zine.mint),
            const SizedBox(width: 6),
            Expanded(child: Text('Your real number stays private and is never shown.', style: ZineText.sub(size: 12.5))),
          ]),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: Text('Back', style: ZineText.button(size: 15, color: Zine.inkSoft))),
          TextButton(onPressed: () => Navigator.pop(context, true), child: Text('Use this number', style: ZineText.button(size: 15, color: Zine.blue))),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    final res = await AvaNumber.assign(_country!.iso2, n.nsn);
    if (!mounted) return;
    setState(() => _busy = false);
    if (res.ok) {
      final me = await AvaNumber.me();
      if (!mounted) return;
      setState(() { _me = me; _picking = false; });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Your number is now ${res.display}')));
    } else {
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
        backgroundColor: Zine.paper,
        title: Text('Release your number?', style: ZineText.cardTitle(size: 18)),
        content: Text('Your real number will represent you again until you choose a new one.', style: ZineText.sub(size: 13)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: Text('Cancel', style: ZineText.button(size: 15, color: Zine.inkSoft))),
          TextButton(onPressed: () => Navigator.pop(context, true), child: Text('Release', style: ZineText.button(size: 15, color: Zine.coral))),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    await AvaNumber.release();
    final me = await AvaNumber.me();
    if (!mounted) return;
    setState(() { _me = me; _busy = false; _picking = me.entitled; });
    if (_picking) _loadAvailable();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Your number', markWord: 'number'),
      body: _me == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(20), children: _content()),
    );
  }

  List<Widget> _content() {
    final me = _me!;
    if (!me.featureOn) {
      return [_infoCard('Not available', 'AvaTOK numbers aren’t available right now. Check back soon.')];
    }
    if (!me.entitled) {
      return [
        ZineCard(
          color: Zine.lime,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.hash(PhosphorIconsStyle.bold), color: Zine.card, size: 30),
              const SizedBox(width: 10),
              Expanded(child: Text('Keep your number private', style: ZineText.cardTitle(size: 18))),
            ]),
            const SizedBox(height: 10),
            Text('Get a number that represents you on AvaTOK and hides your real phone. Included free on any paid plan.', style: ZineText.value(size: 14)),
          ]),
        ),
        const SizedBox(height: 16),
        ZineButton(
          label: 'See plans',
          fullWidth: true,
          icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
          onPressed: () { Navigator.of(context).maybePop(); },
        ),
      ];
    }
    final widgets = <Widget>[];
    if (me.hasNumber && !_picking) {
      widgets.addAll([
        ZineCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('YOUR AVATOK NUMBER', style: ZineText.kicker()),
            const SizedBox(height: 10),
            Text(me.display ?? '', style: ZineText.cardTitle(size: 24, color: Zine.blue)),
            const SizedBox(height: 8),
            Row(children: [
              PhosphorIcon(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), size: 15, color: Zine.mint),
              const SizedBox(width: 6),
              Expanded(child: Text('Your real number is hidden — people see this instead.', style: ZineText.sub(size: 12.5))),
            ]),
          ]),
        ),
        const SizedBox(height: 14),
        ZineButton(label: 'Change number', variant: ZineButtonVariant.ghost, fullWidth: true, fontSize: 16,
            icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold), trailingIcon: false,
            onPressed: _busy ? null : () { setState(() => _picking = true); _loadAvailable(); }),
        const SizedBox(height: 10),
        ZineButton(label: 'Release number', variant: ZineButtonVariant.ghost, fullWidth: true, fontSize: 16,
            icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), trailingIcon: false,
            onPressed: _busy ? null : _release),
      ]);
      return widgets;
    }

    // Picker
    widgets.addAll([
      ZineCard(
        onTap: _busy ? null : _pickCountry,
        child: Row(children: [
          Text(_country?.flag ?? '🌍', style: const TextStyle(fontSize: 22)),
          const SizedBox(width: 10),
          Expanded(child: Text(_country?.name ?? 'Choose country', style: ZineText.value(size: 15))),
          PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
        ]),
      ),
      const SizedBox(height: 12),
      ZineField(
        controller: _patternCtrl,
        leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
        hint: 'Try a pattern, e.g. 555',
        keyboardType: TextInputType.number,
        onSubmitted: (_) => _loadAvailable(),
        trailing: TextButton(onPressed: _busy ? null : _loadAvailable, child: Text('Search', style: ZineText.button(size: 13, color: Zine.blue))),
      ),
      const SizedBox(height: 8),
      Row(children: [
        Text('AVAILABLE NUMBERS', style: ZineText.kicker()),
        const Spacer(),
        TextButton(onPressed: _busy || _loadingAvail ? null : _loadAvailable,
            child: Text('Shuffle', style: ZineText.button(size: 12.5, color: Zine.blue))),
      ]),
      const SizedBox(height: 4),
    ]);
    if (_loadingAvail) {
      widgets.add(const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())));
    } else if (_avail.isEmpty) {
      widgets.add(Padding(padding: const EdgeInsets.symmetric(vertical: 16), child: Text('No matches — try a different pattern.', style: ZineText.sub())));
    } else {
      for (final n in _avail) {
        widgets.add(Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: ZineCard(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            onTap: _busy ? null : () => _confirm(n),
            child: Row(children: [
              Expanded(child: Text(n.display, style: ZineText.value(size: 16))),
              Text('available', style: ZineText.sub(size: 11, color: Zine.mint)),
              const SizedBox(width: 8),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 15, color: Zine.inkMute),
            ]),
          ),
        ));
      }
    }
    if (me.hasNumber) {
      widgets.addAll([
        const SizedBox(height: 8),
        ZineButton(label: 'Keep current number', variant: ZineButtonVariant.ghost, fullWidth: true, fontSize: 15,
            onPressed: _busy ? null : () => setState(() => _picking = false)),
      ]);
    }
    return widgets;
  }

  Widget _infoCard(String title, String body) => ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: ZineText.cardTitle(size: 17)),
          const SizedBox(height: 8),
          Text(body, style: ZineText.value(size: 14)),
        ]),
      );
}
