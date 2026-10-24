import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../../data/services.dart';
import '../desi.dart';
import '../merch_kit.dart';
import '../theme.dart';

/// [HF-MERCH-APP-1] The merch entries on Me: "My merch" (influencers) and "My orders" (everyone). Shows nothing while
/// `/api/config` has `hfMerchEnabled` off. Put it once in the Me list; it brings its own spacing.
class MerchMeSection extends StatefulWidget {
  const MerchMeSection({super.key, required this.isInfluencer, this.repo});

  final bool isInfluencer;
  final MerchRepo? repo;

  @override
  State<MerchMeSection> createState() => _MerchMeSectionState();
}

class _MerchMeSectionState extends State<MerchMeSection> {
  MerchSummary? _summary;
  bool _asked = false;

  MerchRepo get _repo => widget.repo ?? Services.instance.merchRepo;

  @override
  void initState() {
    super.initState();
    MerchRepo.flags.addListener(_changed);
    unawaited(_repo.loadFlags());
    _changed();
  }

  @override
  void dispose() {
    MerchRepo.flags.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    if (MerchRepo.flags.value.enabled && widget.isInfluencer && !_asked) {
      _asked = true;
      unawaited(_loadSummary());
    }
  }

  Future<void> _loadSummary() async {
    try {
      final s = await _repo.summary();
      if (mounted) setState(() => _summary = s);
    } catch (_) {
      // the card works without the numbers (a host who is not live yet gets a 403)
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!MerchRepo.flags.value.enabled) return const SizedBox.shrink();
    final s = _summary;
    final line = s == null
        ? 'Sell your own T-shirts to your fans.'
        : '${s.live} live · ${s.ordersNew} new ${s.ordersNew == 1 ? 'order' : 'orders'} · ${merchRupees(s.availablePaise)} ready to withdraw';
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(children: [
        if (widget.isInfluencer)
          DesiCard(
            title: 'My merch',
            note: line,
            tone: DesiTone.lav,
            corner: DesiCorner.yellow,
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              DesiButton('Open My merch', icon: Icons.checkroom_rounded, kind: DesiButtonKind.rani, onTap: () => unawaited(context.push<Object?>('/merch'))),
              DesiButton('New product', icon: Icons.add_rounded, kind: DesiButtonKind.ghost, onTap: () => unawaited(context.push<Object?>('/merch/new'))),
            ]),
          ),
        if (widget.isInfluencer) const SizedBox(height: 12),
        DesiCard(
          onTap: () => unawaited(context.push<Object?>('/merch/orders')),
          child: Row(children: [
            const Icon(Icons.shopping_bag_rounded, color: C.maroon, size: 28),
            const SizedBox(width: 12),
            Expanded(child: Text('My orders', style: t(17))),
            Text('Merch you bought', style: t(14, color: C.muted, w: FontWeight.w700)),
            const SizedBox(width: 6),
            const Icon(Icons.chevron_right_rounded, color: C.muted),
          ]),
        ),
      ]),
    );
  }
}
