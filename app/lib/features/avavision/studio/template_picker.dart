import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/avavision_api.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../widgets.dart';

/// Pick-a-template — the FIRST step of creating a vision agent and the key
/// difference from AvaVoice. The creator picks a Category (7 from the catalog),
/// then a Use-Case template; selecting one returns its full [VisionTemplate]
/// object to the form flow, which prefills capability/overlay/scoring/prompt.
///
/// Templates not runnable on the current platform are filtered out by the API
/// client (belt-and-braces) — we never offer a capability the device can't run.
class TemplatePickerScreen extends StatefulWidget {
  const TemplatePickerScreen({super.key});
  @override
  State<TemplatePickerScreen> createState() => _TemplatePickerScreenState();
}

class _TemplatePickerScreenState extends State<TemplatePickerScreen> {
  List<VisionCategory> _categories = [];
  VisionCategory? _open; // null = showing the category grid
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavision', 'template_picker');
    _load();
  }

  Future<void> _load() async {
    final cats = await AvaVisionApi.templates();
    if (!mounted) return;
    setState(() {
      _categories = cats;
      _loading = false;
    });
  }

  IconData _categoryIcon(String capability) => switch (capability) {
        'pose' || 'holistic' => PhosphorIcons.personSimpleRun(PhosphorIconsStyle.bold),
        'hand' => PhosphorIcons.fingerprint(PhosphorIconsStyle.bold),
        'face_landmark' || 'face_detect' => PhosphorIcons.smiley(PhosphorIconsStyle.bold),
        'gesture' => PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
        'object' => PhosphorIcons.squaresFour(PhosphorIconsStyle.bold),
        'segmentation' => PhosphorIcons.image(PhosphorIconsStyle.bold),
        _ => PhosphorIcons.eye(PhosphorIconsStyle.bold),
      };

  Color _accentFor(int i) => Zine.accents[i % Zine.accents.length];

  void _pickTemplate(VisionTemplate t) {
    Analytics.capture('avavision_template_picked', {
      'template': t.id,
      'capability': t.capability,
      'overlay': t.overlayStyle,
      'scoring': t.scoringMode,
    });
    Navigator.pop(context, t);
  }

  @override
  Widget build(BuildContext context) {
    final open = _open;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: open == null ? 'Pick a template' : open.name,
        markWord: open == null ? 'template' : null,
        tag: open == null ? 'what should your agent coach?' : open.tagline,
        showBack: true,
        onBack: open == null
            ? null
            : () => setState(() => _open = null), // back to categories without leaving
      ),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.lilac))
            : _categories.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(28),
                      child: ZineEmptyState(
                          icon: PhosphorIcons.eye(PhosphorIconsStyle.bold),
                          text: 'No templates are available on this device yet. '
                              'Some vision capabilities are Android/Web only.'),
                    ),
                  )
                : open == null
                    ? _categoryGrid()
                    : _templateList(open),
      ),
    );
  }

  // ── category grid ─────────────────────────────────────────────────────────
  Widget _categoryGrid() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Zine.lilac,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Zine.border,
            boxShadow: Zine.shadowXs,
          ),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.eye(PhosphorIconsStyle.fill), size: 28, color: Zine.ink),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Start from a use-case. We prefill the camera capability, overlay, score and a starter prompt — you just edit the text and set your rate.',
                style: ZineText.sub(size: 12.5, color: Zine.ink),
              ),
            ),
          ]),
        ),
        const SizedBox(height: 16),
        for (var i = 0; i < _categories.length; i++) ...[
          _categoryCard(_categories[i], _accentFor(i)),
          const SizedBox(height: 12),
        ],
      ],
    );
  }

  Widget _categoryCard(VisionCategory c, Color accent) {
    return ZinePressable(
      onTap: () {
        Analytics.capture('avavision_category_opened', {'category': c.id, 'templates': c.templates.length});
        setState(() => _open = c);
      },
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: Zine.shadowSm,
      padding: const EdgeInsets.all(14),
      child: Row(children: [
        ZineIconBadge(icon: _categoryIcon(c.capability), color: accent, size: 46),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(c.name, style: ZineText.cardTitle(size: 17))),
              MiniPill('${c.templates.length}', fill: Zine.card, fg: Zine.inkSoft, shadow: false),
            ]),
            const SizedBox(height: 4),
            Text(c.tagline, style: ZineText.sub(size: 12.5)),
          ]),
        ),
        const SizedBox(width: 8),
        PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 20, color: Zine.inkSoft),
      ]),
    );
  }

  // ── use-case template list ────────────────────────────────────────────────
  Widget _templateList(VisionCategory c) {
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
      itemCount: c.templates.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (_, i) => _templateCard(c.templates[i]),
    );
  }

  Widget _templateCard(VisionTemplate t) {
    return ZinePressable(
      onTap: () => _pickTemplate(t),
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: Zine.shadowSm,
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: _categoryIcon(t.capability), color: Zine.lilac, size: 38),
          const SizedBox(width: 12),
          Expanded(child: Text(t.name, style: ZineText.cardTitle(size: 16))),
          PhosphorIcon(PhosphorIcons.plusCircle(PhosphorIconsStyle.fill), size: 26, color: Zine.lilac),
        ]),
        const SizedBox(height: 10),
        Text(t.starterPrompt,
            maxLines: 3, overflow: TextOverflow.ellipsis, style: ZineText.sub(size: 12.5)),
        const SizedBox(height: 12),
        Wrap(spacing: 6, runSpacing: 6, children: [
          CapabilityBadge(t.capability),
          if (t.hasOverlay) OverlayBadge(t.overlayStyle),
          if (t.hasScore && t.scoreLabel != null) ScoreBadge(t.scoreLabel!),
          if (t.agenticSnapshotEnabled)
            MiniPill('analyze', fill: Zine.coral, fg: Colors.white, icon: PhosphorIcons.camera(PhosphorIconsStyle.bold)),
          PlatformBadges(t.platforms),
        ]),
      ]),
    );
  }
}
