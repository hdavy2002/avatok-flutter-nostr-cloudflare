import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'ava_number.dart';

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
  final VoidCallback? onSignOut;
  const NumberSettingsScreen({super.key, this.gate = false, this.onAssigned, this.onSignOut});
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
      Analytics.capture('number_country_selected', {'country': chosen.iso2, 'name': chosen.name});
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
    setState(() { _me = me; _busy = false; _picking = me.canGenerate; });
    if (_picking) _loadAvailable();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !widget.gate, // mandatory gate can't be backed out of
      child: Scaffold(
        backgroundColor: Zine.paper,
        appBar: ZineAppBar(
            title: widget.gate ? 'Choose your number' : 'Your number',
            markWord: 'number', showBack: !widget.gate),
        body: _me == null
            ? const Center(child: CircularProgressIndicator())
            : widget.gate
                ? Column(children: [
                    Expanded(child: ListView(padding: const EdgeInsets.all(20), children: _content())),
                    SafeArea(
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: TextButton(
                          onPressed: widget.onSignOut,
                          child: Text('Sign out instead',
                              style: ZineText.link(size: 13, color: Zine.inkSoft)),
                        ),
                      ),
                    ),
                  ])
                : ListView(padding: const EdgeInsets.all(20), children: _content()),
      ),
    );
  }

  List<Widget> _content() {
    final me = _me!;
    if (!me.featureOn) {
      return [_infoCard('Not available', 'AvaTOK numbers aren’t available right now. Check back soon.')];
    }
    final widgets = <Widget>[];
    if (widget.gate) {
      widgets.add(ZineCard(
        color: Zine.lime,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('PICK YOUR AVATOK NUMBER', style: ZineText.kicker()),
          const SizedBox(height: 8),
          Text('Choose a number to finish setting up. It represents you on AvaTOK — '
              'people call and message you on it — and keeps your real phone private. '
              'Pick any available number below.', style: ZineText.value(size: 14)),
        ]),
      ));
      widgets.add(const SizedBox(height: 14));
    }
    if (me.hasNumber && !_picking) {
      widgets.add(
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
      );
      if (me.canGenerate) {
        // Paid: regenerate / release freely.
        widgets.addAll([
          const SizedBox(height: 14),
          ZineButton(label: 'Change number', variant: ZineButtonVariant.ghost, fullWidth: true, fontSize: 16,
              icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold), trailingIcon: false,
              onPressed: _busy ? null : () { setState(() => _picking = true); _loadAvailable(); }),
          const SizedBox(height: 10),
          ZineButton(label: 'Release number', variant: ZineButtonVariant.ghost, fullWidth: true, fontSize: 16,
              icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), trailingIcon: false,
              onPressed: _busy ? null : _release),
        ]);
      } else {
        // Free: this is their one free number — locked. Upgrade to change it.
        widgets.addAll([
          const SizedBox(height: 14),
          ZineCard(
            color: Zine.lime,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                ZineIconBadge(icon: PhosphorIcons.lockSimple(PhosphorIconsStyle.bold), color: Zine.card, size: 28),
                const SizedBox(width: 10),
                Expanded(child: Text('Your number is locked', style: ZineText.cardTitle(size: 17))),
              ]),
              const SizedBox(height: 8),
              Text('You get one AvaTOK number free. Upgrade to a paid plan to generate a new number any time.', style: ZineText.value(size: 14)),
            ]),
          ),
          const SizedBox(height: 12),
          ZineButton(label: 'See plans', fullWidth: true,
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
        ZineCard(
          color: Zine.lime,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.hash(PhosphorIconsStyle.bold), color: Zine.card, size: 30),
              const SizedBox(width: 10),
              Expanded(child: Text('Generate a new number', style: ZineText.cardTitle(size: 18))),
            ]),
            const SizedBox(height: 10),
            Text('Your free number generation is used up. Upgrade to a paid plan to generate a new number that represents you and hides your real phone.', style: ZineText.value(size: 14)),
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
