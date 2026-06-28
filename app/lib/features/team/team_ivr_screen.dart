import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/team_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/call_screen.dart';

/// TeamIvrScreen — the caller-facing auto-attendant ("press 1 / press 2") for a
/// team's AvaTOK number. Spec: Specs/TEAM-RECEPTIONIST-IVR-SPEC.md.
///
/// These are in-network app calls (no PSTN keypad), so the menu is on-screen
/// tappable buttons. Tapping a slot resolves the target staffer server-side and
/// places a normal 1:1 call; if they don't answer, their Ava takes a message
/// (the existing receptionist path, carrying team context for the message card).
///
/// Reached two ways: the dialer pushes it when a dialed number is a team number,
/// and the manager can open it from the team dashboard to preview the experience.
class TeamIvrScreen extends StatefulWidget {
  final String teamNumber;
  final bool preview; // manager preview → don't actually place calls
  const TeamIvrScreen({super.key, required this.teamNumber, this.preview = false});
  @override
  State<TeamIvrScreen> createState() => _TeamIvrScreenState();
}

class _TeamIvrScreenState extends State<TeamIvrScreen> {
  bool _loading = true;
  bool _routing = false;
  Map<String, dynamic>? _menu;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final m = await TeamApi.ivrMenu(widget.teamNumber);
    if (!mounted) return;
    setState(() { _menu = m; _loading = false; });
  }

  Future<void> _tap(int slot, String roleLabel, bool available) async {
    if (_routing) return;
    setState(() => _routing = true);
    final r = await TeamApi.ivrRoute(widget.teamNumber, slot);
    if (!mounted) return;
    setState(() => _routing = false);
    if (r == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not connect')));
      return;
    }
    if (widget.preview) {
      final fb = r['fallback'] == true;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(fb ? 'Would route to reception (no staffer on slot $slot)' : 'Would call ${r['target_name'] ?? roleLabel}'),
        backgroundColor: Zine.ink));
      return;
    }
    // Place the 1:1 call to the resolved target. The callee's app rings; on no
    // answer, the caller-side receptionist hand-off carries team_id + slot so the
    // voicemail card reaches the staffer + manager.
    final number = (r['target_number'] ?? '').toString();
    final name = (r['target_name'] ?? roleLabel).toString();
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(
        room: 'avatok-$number', title: name, seed: number,
        video: false, outgoing: true, avatarUrl: ''),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final menu = _menu;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: widget.preview ? 'Menu preview' : 'Connecting',
        markWord: widget.preview ? 'preview' : null,
        tag: 'AUTO-ATTENDANT'),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.ink))
          : menu == null
              ? Center(child: Padding(padding: const EdgeInsets.all(28), child: ZineEmptyState(icon: PhosphorIcons.phoneX(PhosphorIconsStyle.bold), text: 'This number is not a team auto-attendant.')))
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
                  children: [
                    // Greeting
                    ZineCard(
                      color: Zine.lilac,
                      child: Row(children: [
                        ZineIconBadge(icon: PhosphorIcons.buildings(PhosphorIconsStyle.bold), color: Zine.card),
                        const SizedBox(width: 12),
                        Expanded(child: Text(
                          (menu['greeting_text'] ?? "You've reached ${menu['team_name']}").toString(),
                          style: ZineText.cardTitle(size: 16))),
                      ]),
                    ),
                    const SizedBox(height: 8),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(6, 12, 6, 8),
                      child: Text('CHOOSE A DEPARTMENT', style: ZineText.kicker()),
                    ),
                    ...((menu['entries'] ?? []) as List).map((e) {
                      final m = e as Map<String, dynamic>;
                      final slot = (m['slot'] as num?)?.toInt() ?? 0;
                      final role = (m['role_label'] ?? '').toString();
                      final available = m['available'] == true;
                      return _entry(slot, role, (m['display_name'] ?? '').toString(), available);
                    }),
                    if (_routing) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: CircularProgressIndicator(color: Zine.ink))),
                  ],
                ),
    );
  }

  Widget _entry(int slot, String role, String name, bool available) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZinePressable(
          onTap: () => _tap(slot, role, available),
          color: Zine.card,
          radius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowSm,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          child: Row(children: [
            Container(
              width: 40, height: 40, alignment: Alignment.center,
              decoration: BoxDecoration(
                color: Zine.lime, shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: Zine.bw)),
              child: Text('$slot', style: ZineText.cardTitle(size: 18)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(role, style: ZineText.cardTitle(size: 16)),
                Text(available ? 'Press to connect' : 'Ava will take a message',
                    style: ZineText.tag(size: 11, color: Zine.inkSoft)),
              ]),
            ),
            PhosphorIcon(PhosphorIcons.phoneCall(PhosphorIconsStyle.fill),
                size: 20, color: available ? Zine.mintInk : Zine.inkMute),
          ]),
        ),
      );
}
