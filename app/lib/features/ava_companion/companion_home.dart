import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../identity/ladder_api.dart';
import 'companion_thread.dart';
import 'persona.dart';

/// CompanionHome (Phase 6 — Companion / Blank Ava Chat).
///
/// The "New chat with Ava" entry: pick a persona (Just chat / Brainstorm /
/// Language practice / Roleplay) then open a free-form [CompanionThreadScreen].
/// The companion text chat is FREE; only voice (Settings → Ava voice) is premium.
///
/// AGE-GATE: the Roleplay persona is limited to VERIFIED ADULTS. The accessor
/// used is the Trust Ladder ([LadderApi]) — there is no client-side birth-date /
/// explicit "isAdult" field, so the strongest available "verified human" signal
/// is ladder **L2+** (L2 = verified human via liveness; L3 = KYC). We require
/// L2+ to unlock roleplay. (llama-guard on the server still moderates the content
/// of every roleplay turn regardless — the gate is defence-in-depth, not the only
/// safety layer.) See the Phase 6 block in INTEGRATION-NOTES.md.
const int kRoleplayMinLadderLevel = 2;

class CompanionHome extends StatefulWidget {
  const CompanionHome({super.key});
  @override
  State<CompanionHome> createState() => _CompanionHomeState();
}

class _CompanionHomeState extends State<CompanionHome> {
  int _level = 1; // pessimistic default until the ladder resolves
  bool _levelLoaded = false;

  @override
  void initState() {
    super.initState();
    _loadLevel();
  }

  Future<void> _loadLevel() async {
    // Paint instantly from the per-account cached level, then refresh from server.
    final cached = await LadderApi.cachedLevel();
    if (mounted) setState(() => _level = cached);
    final fresh = await LadderApi.level();
    if (fresh != null && mounted) {
      setState(() {
        _level = fresh.level;
        _levelLoaded = true;
      });
    } else if (mounted) {
      setState(() => _levelLoaded = true);
    }
  }

  bool get _isVerifiedAdult => _level >= kRoleplayMinLadderLevel;

  Future<void> _open(AvaPersona p) async {
    if (p.adultOnly && !_isVerifiedAdult) {
      _showAdultGate();
      return;
    }
    await AvaPersonaStore.save(p);
    if (!mounted) return;
    Navigator.push(
        context, MaterialPageRoute(builder: (_) => CompanionThreadScreen(persona: p)));
  }

  void _showAdultGate() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          side: BorderSide(color: Zine.ink, width: Zine.bw),
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: Zine.lilac, size: 38),
              const SizedBox(width: 12),
              Expanded(child: Text('Adults only', style: ZineText.cardTitle(size: 18))),
            ]),
            const SizedBox(height: 12),
            Text(
              'Roleplay is limited to verified adults. Verify your identity in '
              'AvaIdentity (a quick liveness check) to unlock it. Everything stays '
              'safe and moderated either way.',
              style: ZineText.sub(size: 13.5),
            ),
            const SizedBox(height: 18),
            ZineButton(
              label: 'Verify in AvaIdentity',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 15,
              icon: PhosphorIcons.identificationCard(PhosphorIconsStyle.bold),
              onPressed: () {
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                    content: Text('Open AvaIdentity from the menu to verify (Level 2).')));
              },
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft)),
            ),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Column(children: [
          // Header band.
          Container(
            padding: const EdgeInsets.fromLTRB(8, 8, 14, 12),
            decoration: const BoxDecoration(
              color: Zine.paper2,
              border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
            ),
            child: Row(children: [
              const ZineBackButton(),
              const SizedBox(width: 4),
              ZineIconBadge(
                  icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                  color: Zine.lilac,
                  size: 40),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Chat with Ava', style: ZineText.cardTitle(size: 18)),
                  Text('Pick how you want to talk', style: ZineText.sub(size: 12)),
                ]),
              ),
            ]),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
              children: [
                for (final p in AvaPersonas.all) ...[
                  _PersonaTile(
                    persona: p,
                    locked: p.adultOnly && !_isVerifiedAdult,
                    loading: p.adultOnly && !_levelLoaded,
                    onTap: () => _open(p),
                  ),
                  const SizedBox(height: 12),
                ],
                const SizedBox(height: 8),
                Text(
                  'Talking to Ava is free. Replies are AI-generated and moderated. '
                  'Turn on Ava’s voice in Settings → Ava voice (premium).',
                  style: ZineText.sub(size: 12),
                ),
              ],
            ),
          ),
        ]),
      ),
    );
  }
}

class _PersonaTile extends StatelessWidget {
  final AvaPersona persona;
  final bool locked;
  final bool loading;
  final VoidCallback onTap;
  const _PersonaTile({
    required this.persona,
    required this.locked,
    required this.loading,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      onTap: onTap,
      child: Row(children: [
        Container(
          width: 46,
          height: 46,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: Zine.lilac,
            borderRadius: BorderRadius.circular(Zine.rBadge),
            border: Zine.border,
          ),
          child: Text(persona.glyph, style: const TextStyle(fontSize: 22)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(persona.name, style: ZineText.value(size: 15.5))),
              if (persona.adultOnly) ...[
                const SizedBox(width: 8),
                _AdultChip(locked: locked),
              ],
            ]),
            const SizedBox(height: 2),
            Text(persona.tagline, style: ZineText.sub(size: 12.5)),
          ]),
        ),
        const SizedBox(width: 6),
        if (loading)
          const SizedBox(
              width: 18, height: 18,
              child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))
        else
          PhosphorIcon(
              locked
                  ? PhosphorIcons.lock(PhosphorIconsStyle.bold)
                  : PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
              size: 18,
              color: locked ? Zine.inkMute : Zine.ink),
      ]),
    );
  }
}

class _AdultChip extends StatelessWidget {
  final bool locked;
  const _AdultChip({required this.locked});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(
          color: locked ? Zine.paper2 : Zine.mint,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: Zine.ink, width: 2),
          boxShadow: Zine.shadowXs,
        ),
        child: Text('18+', style: ZineText.tag(size: 9.5, color: Zine.ink)),
      );
}
