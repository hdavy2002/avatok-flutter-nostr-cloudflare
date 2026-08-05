import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/subscribe_api.dart';
import '../../core/team_api.dart';
import '../../core/voice/google_voice.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../subscribe/subscribe_screen.dart';
import 'team_inbox.dart';
import 'team_ivr_screen.dart';

/// TeamHomeScreen — manager dashboard for the Team Receptionist (IVR).
/// Spec: Specs/TEAM-RECEPTIONIST-IVR-SPEC.md. Shows the team number, greeting,
/// monthly pools, and the staff list (which IS the press-1/press-2 menu). The
/// manager adds staff by {name, role, voice, greeting, AvaTOK number}.
class TeamHomeScreen extends StatefulWidget {
  const TeamHomeScreen({super.key});
  @override
  State<TeamHomeScreen> createState() => _TeamHomeScreenState();
}

class _TeamHomeScreenState extends State<TeamHomeScreen> {
  bool _loading = true;
  String? _role;
  Team? _team;
  // Adding staff is a Team-plan capability: free-tier users (subscription tier 0)
  // can view the team but the "Add staff" action is locked behind an upgrade.
  bool _paidPlan = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final s = await TeamApi.status();
    // Subscription tier — 0 = Free. Adding staff requires a paid (Team) plan.
    // Fail-closed (treat as free) so the gate is never silently bypassed offline.
    var paid = false;
    try {
      final p = await SubscribeApi.plans();
      final cur = (p['current'] as Map?)?.cast<String, dynamic>() ?? const {};
      paid = ((cur['tier'] as num?)?.toInt() ?? 0) > 0;
    } catch (_) { paid = false; }
    if (!mounted) return;
    setState(() {
      _role = s.role;
      _team = s.team;
      _paidPlan = paid;
      _loading = false;
    });
  }

  Future<void> _createTeam() async {
    final name = await _promptText('Name your team', hint: 'e.g. Hilton');
    if (name == null || name.trim().isEmpty) return;
    final t = await TeamApi.create(name.trim());
    if (!mounted) return;
    if (t == null) {
      _toast('Could not create the team');
    } else {
      setState(() { _team = t; _role = 'owner'; });
    }
  }

  Future<String?> _promptText(String title, {String? hint, String? initial}) {
    final c = TextEditingController(text: initial ?? '');
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            side: const BorderSide(color: AD.borderControl, width: 1),
            borderRadius: Msg.brLg),
        title: Text(title, style: ADText.threadName().copyWith(fontSize: 17)),
        content: ZineField(controller: c, hint: hint, autofocus: true, textCapitalization: TextCapitalization.words),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: ADText.threadName(c: AD.textSecondary))),
          TextButton(onPressed: () => Navigator.pop(ctx, c.text), child: Text('Save', style: ADText.threadName(c: Msg.accent))),
        ],
      ),
    );
  }

  void _toast(String m) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(
        content: Text(m, style: ADText.preview(c: AD.textPrimary)),
        backgroundColor: AD.card,
      ));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(
        title: 'Team', markWord: 'Team', tag: 'AI receptionist',
        actions: [
          if (_team != null)
            ZineBackButton(
              icon: PhosphorIcons.trayArrowDown(PhosphorIconsStyle.regular),
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const TeamInboxScreen())),
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
          : _team == null
              ? _empty()
              : RefreshIndicator(
                  onRefresh: _load,
                  color: AD.primaryBadge,
                  backgroundColor: AD.card,
                  child: _dashboard()),
    );
  }

  Widget _empty() => Center(
        child: Padding(
          padding: const EdgeInsets.all(Msg.s5),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ZineEmptyState(
                icon: PhosphorIcons.usersThree(PhosphorIconsStyle.regular),
                text: 'Create a team to set up an AI receptionist that greets callers and routes them to your staff.'),
            const SizedBox(height: Msg.s5),
            ZineButton(
                label: 'Create team', icon: PhosphorIcons.plus(PhosphorIconsStyle.bold),
                variant: ZineButtonVariant.blue, onPressed: _createTeam),
          ]),
        ),
      );

  Widget _dashboard() {
    final t = _team!;
    final isOwner = _role == 'owner';
    return ListView(
      padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
      children: [
        // Team identity card
        ZineCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.buildings(PhosphorIconsStyle.regular), color: AD.newGroup),
              const SizedBox(width: Msg.s3),
              Expanded(child: Text(t.name, style: ADText.threadName().copyWith(fontSize: 19))),
              if (isOwner)
                ZineBackButton(icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.regular), onTap: _editTeam),
            ]),
            const SizedBox(height: Msg.s3),
            _kv(PhosphorIcons.phone(PhosphorIconsStyle.regular), 'Team number', t.teamNumber == null || t.teamNumber!.isEmpty ? 'Not set — tap edit' : '+${t.teamNumber}'),
            const SizedBox(height: Msg.s2),
            _kv(PhosphorIcons.chatCircleText(PhosphorIconsStyle.regular), 'Greeting', t.greetingText.isEmpty ? "You've reached ${t.name}" : t.greetingText),
            if (t.teamNumber != null && t.teamNumber!.isNotEmpty) ...[
              const SizedBox(height: Msg.s3),
              ZineButton(
                label: 'Preview caller menu', icon: PhosphorIcons.playCircle(PhosphorIconsStyle.regular),
                variant: ZineButtonVariant.ghost, fullWidth: true, fontSize: 14,
                onPressed: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => TeamIvrScreen(teamNumber: t.teamNumber!, preview: true))),
              ),
            ],
          ]),
        ),
        const SizedBox(height: Msg.s4),
        // Monthly pools
        ZineCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('This month', style: ADText.sectionLabel()),
            const SizedBox(height: Msg.s3),
            _pool('Calls', 'Unlimited', 1, AD.online, unlimited: true),
            const SizedBox(height: Msg.s3),
            _pool('Receptionist minutes', '${t.receptMin.used} / ${t.receptMin.quota}', t.receptMin.fraction, AD.newGroup),
            const SizedBox(height: Msg.s3),
            _pool('AI messages', '${t.aiMsg.used} / ${t.aiMsg.quota}', t.aiMsg.fraction, AD.tabCalls),
          ]),
        ),
        const SizedBox(height: Msg.s4),
        // Staff / menu
        Row(children: [
          Text('Menu · ${t.members.length}/${t.seatLimit}', style: ADText.sectionLabel()),
          const Spacer(),
          if (isOwner) _addStaffAction(),
        ]),
        const SizedBox(height: Msg.s3),
        if (t.members.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Msg.s5),
            child: ZineEmptyState(icon: PhosphorIcons.listNumbers(PhosphorIconsStyle.regular), text: 'Add staff to build your "press 1, press 2" menu.'),
          )
        else
          ...t.members.map((m) => _memberTile(m, isOwner)),
      ],
    );
  }

  Widget _kv(IconData icon, String k, String v) => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        PhosphorIcon(icon, size: 16, color: AD.textSecondary),
        const SizedBox(width: Msg.s2),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(k, style: ADText.statCaption()),
            Text(v, style: ADText.preview(c: AD.textPrimary)),
          ]),
        ),
      ]);

  Widget _pool(String label, String value, double frac, Color color, {bool unlimited = false}) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(label, style: ADText.rowName().copyWith(fontSize: 14))),
          Text(value, style: ADText.timestamp(c: AD.textSecondary)),
        ]),
        const SizedBox(height: Msg.s2),
        ClipRRect(
          // A progress track is a genuine pill.
          borderRadius: Msg.brPill,
          child: LinearProgressIndicator(
            value: unlimited ? 1 : frac,
            minHeight: 8,
            // Track sits ON AD.card, so it has to be a step darker than the card
            // itself or the bar reads as a floating sliver with no groove.
            backgroundColor: AD.borderHairline,
            valueColor: AlwaysStoppedAnimation(color),
          ),
        ),
      ]);

  Widget _memberTile(TeamMember m, bool isOwner) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Msg.s3),
      child: ZinePressable(
        onTap: isOwner ? () => _editMember(m) : null,
        radius: Msg.brMd,
        boxShadow: Msg.none,
        padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s3),
        child: Row(children: [
          // Slot digit. Accent sits on the ring + numeral, not as a fill — white
          // on AD.primaryBadge measures ~2.6:1, which is unreadable at 16px.
          Container(
            width: 34, height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AD.bg, shape: BoxShape.circle,
              border: Border.all(color: AD.primaryBadge, width: 1),
            ),
            child: Text('${m.slot}', style: ADText.threadName(c: AD.primaryBadge)),
          ),
          const SizedBox(width: Msg.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(m.roleLabel, style: ADText.rowName()),
              const SizedBox(height: 1),
              Text('${m.displayName} · +${m.memberNumber}',
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.statCaption(c: AD.textSecondary)),
            ]),
          ),
          _statusPill(m.inviteStatus),
        ]),
      ),
    );
  }

  // Status is carried by the LABEL colour on a neutral card fill. The light
  // system paired a pale mint fill with dark mint ink; the dark counterpart of
  // that fill (AD.online) under white text is ~2.9:1, so the colour moved to
  // the text instead.
  Widget _statusPill(String status) {
    final (Color fg, String text) = switch (status) {
      'active' => (AD.online, 'Pro'),
      'pending' => (AD.textSecondary, 'Pending'),
      _ => (AD.textTertiary, '—'),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
      decoration: BoxDecoration(
        color: AD.card,
        // A status tag is one of the shapes a pill is reserved for.
        borderRadius: Msg.brPill,
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Text(text, style: ADText.statCaption(c: fg)),
    );
  }

  Future<void> _editTeam() async {
    final t = _team!;
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _EditTeamSheet(team: t, onSaved: (nt) { setState(() => _team = nt); }),
    );
  }

  /// The "Add staff" affordance. On a paid plan it's the lime+blue add action;
  /// on the free plan it's visibly greyed with a small lock and opens the Team
  /// plan upsell sheet instead of the add-member form.
  Widget _addStaffAction() {
    if (_paidPlan) {
      return GestureDetector(
        onTap: _addMember,
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.fill), size: 20, color: Msg.accent),
          const SizedBox(width: Msg.s1),
          Text('Add staff', style: ADText.rowName(c: Msg.accent).copyWith(fontSize: 14)),
        ]),
      );
    }
    // Locked (free plan) — greyed out + tap explains the Team plan.
    return GestureDetector(
      onTap: () {
        Analytics.capture('team_add_staff_locked_tapped', const {'reason': 'free_plan'});
        _showTeamPlanSheet();
      },
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.regular), size: 18, color: AD.textTertiary),
        const SizedBox(width: Msg.s1),
        Text('Add staff', style: ADText.rowName(c: AD.textTertiary).copyWith(fontSize: 14)),
      ]),
    );
  }

  /// Team plan upsell — what it is, why it helps a business, and an upgrade CTA.
  Future<void> _showTeamPlanSheet() async {
    Analytics.capture('team_plan_upsell_shown', const {'source': 'add_staff'});
    final go = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _SheetShell(
        title: 'Add staff is a Team plan feature',
        children: [
          Text(
            'Your team’s AI receptionist greets every caller and routes them to the '
            'right person — “press 1 for Sales, press 2 for Support”. Adding staff '
            'builds that menu.',
            style: ADText.preview(),
          ),
          const SizedBox(height: Msg.s4),
          _benefit(PhosphorIcons.usersThree(PhosphorIconsStyle.regular),
              'Unlimited staff seats', 'Add your whole team to the call menu — each with their own AvaTOK number, voice and greeting.'),
          _benefit(PhosphorIcons.phoneCall(PhosphorIconsStyle.regular),
              'One business number', 'Callers reach a single team line; Ava answers 24/7 and warm-transfers to whoever is free.'),
          _benefit(PhosphorIcons.voicemail(PhosphorIconsStyle.regular),
              'Never miss a call', 'When staff don’t pick up, Ava takes a message and drops it in your team inbox.'),
          _benefit(PhosphorIcons.chartLineUp(PhosphorIconsStyle.regular),
              'Higher monthly pools', 'Generous receptionist-minute and AI-message allowances, billed to one team wallet.'),
          const SizedBox(height: Msg.s4),
          ZineButton(
            label: 'See Team plans', fullWidth: true, variant: ZineButtonVariant.blue,
            icon: PhosphorIcons.crown(PhosphorIconsStyle.bold), trailingIcon: false,
            onPressed: () => Navigator.pop(context, true),
          ),
          const SizedBox(height: Msg.s2),
          Center(child: TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text('Maybe later', style: ADText.rowName(c: AD.textSecondary).copyWith(fontSize: 14)))),
        ],
      ),
    );
    if (go == true && mounted) {
      Analytics.capture('team_plan_upgrade_opened', const {'source': 'add_staff'});
      await Navigator.push(context, MaterialPageRoute(builder: (_) => const SubscribeScreen()));
      _load(); // tier may have changed on return
    }
  }

  Widget _benefit(IconData icon, String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ZineIconBadge(icon: icon, color: AD.newGroup, size: 32),
          const SizedBox(width: Msg.s3),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: 1),
            Text(body, style: ADText.preview().copyWith(fontSize: 13)),
          ])),
        ]),
      );

  Future<void> _addMember() async {
    if (!_paidPlan) { _showTeamPlanSheet(); return; }
    final t = _team!;
    if (t.members.length >= t.seatLimit) { _toast('Seat limit reached (${t.seatLimit})'); return; }
    final added = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const AddMemberSheet(),
    );
    if (added == true) _load();
  }

  Future<void> _editMember(TeamMember m) async {
    final changed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AddMemberSheet(existing: m),
    );
    if (changed == true) _load();
  }
}

// ── Edit team sheet (name, greeting, number) ─────────────────────────────────
class _EditTeamSheet extends StatefulWidget {
  final Team team;
  final ValueChanged<Team> onSaved;
  const _EditTeamSheet({required this.team, required this.onSaved});
  @override
  State<_EditTeamSheet> createState() => _EditTeamSheetState();
}

class _EditTeamSheetState extends State<_EditTeamSheet> {
  late final _name = TextEditingController(text: widget.team.name);
  late final _greeting = TextEditingController(text: widget.team.greetingText);
  late final _number = TextEditingController(text: widget.team.teamNumber ?? '');
  bool _saving = false;

  @override
  Widget build(BuildContext context) {
    return _SheetShell(
      title: 'Edit team',
      children: [
        ZineField(controller: _name, label: 'Team name', textCapitalization: TextCapitalization.words),
        const SizedBox(height: Msg.s4),
        ZineField(controller: _greeting, label: 'Greeting', hint: "You've reached Hilton", maxLines: 2, maxLength: 200, textCapitalization: TextCapitalization.sentences),
        const SizedBox(height: Msg.s4),
        ZineField(controller: _number, label: 'Team AvaTOK number', leadText: '+', keyboardType: TextInputType.phone, inputFormatters: [FilteringTextInputFormatter.digitsOnly]),
        const SizedBox(height: Msg.s4),
        ZineButton(
          label: 'Save', fullWidth: true, loading: _saving, variant: ZineButtonVariant.blue,
          onPressed: _saving ? null : () async {
            setState(() => _saving = true);
            final t = await TeamApi.update(name: _name.text.trim(), greetingText: _greeting.text.trim(), teamNumber: _number.text.trim());
            if (!mounted) return;
            setState(() => _saving = false);
            if (t != null) { widget.onSaved(t); Navigator.pop(context); }
            else { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not save'))); }
          },
        ),
      ],
    );
  }
}

// ── Add / edit member sheet ──────────────────────────────────────────────────
class AddMemberSheet extends StatefulWidget {
  final TeamMember? existing;
  const AddMemberSheet({super.key, this.existing});
  @override
  State<AddMemberSheet> createState() => _AddMemberSheetState();
}

class _AddMemberSheetState extends State<AddMemberSheet> {
  late final _name = TextEditingController(text: widget.existing?.displayName ?? '');
  late final _role = TextEditingController(text: widget.existing?.roleLabel ?? '');
  late final _number = TextEditingController(text: widget.existing?.memberNumber ?? '');
  late final _greeting = TextEditingController(text: widget.existing?.greetingText ?? '');
  late String _voice = widget.existing?.voiceName ?? GoogleVoiceCatalog.defaultVoice;
  bool _saving = false;
  String? _error;

  bool get _editing => widget.existing != null;

  List<DropdownMenuItem<String>> get _voiceItems {
    final items = <DropdownMenuItem<String>>[];
    for (final v in GoogleVoiceCatalog.female) {
      items.add(DropdownMenuItem(value: v.name, child: Text('${v.name} · woman · ${v.style}', overflow: TextOverflow.ellipsis)));
    }
    for (final v in GoogleVoiceCatalog.male) {
      items.add(DropdownMenuItem(value: v.name, child: Text('${v.name} · man · ${v.style}', overflow: TextOverflow.ellipsis)));
    }
    return items;
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final role = _role.text.trim();
    final number = _number.text.replaceAll(RegExp(r'[^0-9]'), '');
    if (name.isEmpty || role.isEmpty || number.isEmpty) {
      setState(() => _error = 'Name, role and AvaTOK number are required');
      return;
    }
    setState(() { _saving = true; _error = null; });
    bool ok;
    String? err;
    if (_editing) {
      ok = await TeamApi.updateMember(widget.existing!.id,
          displayName: name, roleLabel: role, voiceName: _voice, greetingText: _greeting.text.trim());
    } else {
      final r = await TeamApi.addMember(
          displayName: name, roleLabel: role, memberNumber: number,
          voiceName: _voice, greetingText: _greeting.text.trim());
      ok = r.ok; err = r.error;
    }
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      Navigator.pop(context, true);
    } else {
      setState(() => _error = switch (err) {
        'seat_limit' => 'Seat limit reached',
        'menu_full' => 'Menu is full (max 9)',
        _ => 'Could not save staff member',
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return _SheetShell(
      title: _editing ? 'Edit staff' : 'Add staff',
      children: [
        ZineField(controller: _name, label: 'Staff name', hint: 'e.g. Julie', textCapitalization: TextCapitalization.words),
        const SizedBox(height: Msg.s4),
        ZineField(controller: _role, label: 'Role / department', hint: 'e.g. Housekeeping', textCapitalization: TextCapitalization.words),
        const SizedBox(height: Msg.s4),
        ZineField(
          controller: _number, label: 'Their AvaTOK number', leadText: '+',
          enabled: !_editing, // number is the identity key; not editable after add
          keyboardType: TextInputType.phone,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        ),
        const SizedBox(height: Msg.s4),
        ZineDropdown<String>(label: 'Ava voice', value: _voice, items: _voiceItems, onChanged: (v) => setState(() => _voice = v ?? _voice)),
        const SizedBox(height: Msg.s4),
        ZineField(controller: _greeting, label: 'Greeting (optional)', hint: "Hi, you've reached Housekeeping", maxLines: 2, maxLength: 200, textCapitalization: TextCapitalization.sentences),
        if (_error != null) ...[const SizedBox(height: Msg.s3), ZineErrorMsg(_error!)],
        const SizedBox(height: Msg.s4),
        ZineButton(label: _editing ? 'Save' : 'Add to menu', fullWidth: true, loading: _saving, variant: ZineButtonVariant.blue, onPressed: _saving ? null : _save),
        if (_editing) ...[
          const SizedBox(height: Msg.s3),
          ZineButton(label: 'Remove from team', fullWidth: true, variant: ZineButtonVariant.coral, onPressed: _saving ? null : () async {
            final ok = await TeamApi.removeMember(widget.existing!.id);
            if (mounted && ok) Navigator.pop(context, true);
          }),
        ],
      ],
    );
  }
}

// Shared rounded sheet chrome.
class _SheetShell extends StatelessWidget {
  final String title;
  final List<Widget> children;
  const _SheetShell({required this.title, required this.children});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        decoration: const BoxDecoration(
          color: AD.overlaySheet,
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
          borderRadius: Msg.brSheetTop,
        ),
        padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s5),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            // The sheet drag handle is one of the shapes a pill is reserved for.
            Center(child: Container(width: 42, height: 5, decoration: BoxDecoration(color: AD.borderControl, borderRadius: Msg.brPill))),
            const SizedBox(height: Msg.s4),
            Text(title, style: ADText.threadName().copyWith(fontSize: 19)),
            const SizedBox(height: Msg.s4),
            ...children,
          ]),
        ),
      ),
    );
  }
}
