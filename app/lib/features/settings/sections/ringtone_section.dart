import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/ringtone_api.dart';
import '../../../core/ringtone_catalog.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../avavision/widgets.dart' show MiniPill;
import '../settings_registry.dart';

/// Settings → "Ringback tone" — phone-style picker over the bundled catalog.
/// Spec: Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md.
///
/// Pick a tone, preview it, make it your default — that's the sound callers hear
/// while your phone rings. No generation, no waiting: the tones ship in the app.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init].
void registerRingtoneSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ai_ringback',
      title: 'Ringback tone',
      order: 26,
      builder: (context) => const _RingtoneCard(),
    ),
  );
}

class _RingtoneCard extends StatefulWidget {
  const _RingtoneCard();
  @override
  State<_RingtoneCard> createState() => _RingtoneCardState();
}

class _RingtoneCardState extends State<_RingtoneCard> {
  final AudioPlayer _preview = AudioPlayer();
  String _selected = ''; // chosen catalog id
  String? _playingId;
  bool _loading = true;
  bool _saving = false;

  static String _assetRel(String p) => p.startsWith('assets/') ? p.substring(7) : p;

  @override
  void initState() {
    super.initState();
    _preview.onPlayerComplete.listen((_) {
      final done = _playingId;
      if (done != null) {
        Analytics.capture('ringback_preview_completed', {'id': done});
      }
      if (mounted) setState(() => _playingId = null);
    });
    _load();
  }

  @override
  void dispose() {
    _preview.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    Analytics.capture('ringback_settings_viewed', {'catalog_size': kRingtoneCatalog.length});
    final t0 = DateTime.now();
    final sel = await RingtoneApi.selected();
    if (!mounted) return;
    setState(() {
      _selected = sel;
      _loading = false;
    });
    Analytics.capture('ringback_selected_loaded', {
      'selected': sel,
      'has_default': sel.isNotEmpty,
      'load_ms': DateTime.now().difference(t0).inMilliseconds,
    });
  }

  Future<void> _togglePreview(RingtoneItem t) async {
    try {
      if (_playingId == t.id) {
        await _preview.stop();
        Analytics.capture('ringback_preview_stopped', {'id': t.id});
        if (mounted) setState(() => _playingId = null);
        return;
      }
      await _preview.stop();
      await _preview.play(AssetSource(_assetRel(t.asset)));
      Analytics.capture('ringback_preview_started', {'id': t.id, 'name': t.name});
      if (mounted) setState(() => _playingId = t.id);
    } catch (e) {
      AvaLog.I.log('ringback', 'preview failed: $e');
      Analytics.error(
        domain: 'ringback',
        code: 'preview_failed',
        message: e.toString(),
        screen: 'ringback_settings',
        action: 'preview',
        extra: {'id': t.id},
      );
    }
  }

  Future<void> _makeDefault(RingtoneItem t) async {
    Analytics.capture('ringback_make_default_tapped', {'id': t.id, 'name': t.name, 'prev_default': _selected});
    setState(() => _saving = true);
    final t0 = DateTime.now();
    final ok = await RingtoneApi.select(t.id);
    if (!mounted) return;
    setState(() {
      _saving = false;
      if (ok) _selected = t.id;
    });
    if (ok) {
      Analytics.capture('ringback_set', {'id': t.id, 'name': t.name, 'set_ms': DateTime.now().difference(t0).inMilliseconds});
      _toast('Callers will now hear “${t.name}”');
    } else {
      // The HTTP wrapper already emits api_error with endpoint+status; this adds
      // the product-level failure so it's queryable by ringback domain + email.
      Analytics.error(
        domain: 'ringback',
        code: 'set_failed',
        screen: 'ringback_settings',
        action: 'make_default',
        extra: {'id': t.id},
      );
      _toast('Couldn’t set that — try again');
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: _loading
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: Center(
                  child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))),
            )
          : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.musicNotes(PhosphorIconsStyle.fill),
                    color: Zine.lilac,
                    size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Ringback tone', style: ZineText.value(size: 14.5)),
                    const SizedBox(height: 2),
                    Text(
                      'Preview a tone and set it as your ringback — the sound people '
                      'hear while your phone is ringing.',
                      style: ZineText.sub(size: 12),
                    ),
                  ]),
                ),
              ]),
              const SizedBox(height: 12),
              for (final t in kRingtoneCatalog) _row(t),
            ]),
    );
  }

  Widget _row(RingtoneItem t) {
    final playing = _playingId == t.id;
    final isDefault = _selected == t.id;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [
        IconButton(
          visualDensity: VisualDensity.compact,
          icon: Icon(playing
              ? PhosphorIcons.stop(PhosphorIconsStyle.fill)
              : PhosphorIcons.play(PhosphorIconsStyle.fill)),
          color: Zine.ink,
          onPressed: () => _togglePreview(t),
        ),
        Expanded(
          child: Text(t.name, style: ZineText.value(size: 13.5), maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
        const SizedBox(width: 6),
        if (isDefault)
          const MiniPill('Default', fill: Zine.mint, fg: Zine.ink)
        else
          ZineButton(
            label: 'Make default',
            variant: ZineButtonVariant.ghost,
            fontSize: 12,
            onPressed: _saving ? null : () => _makeDefault(t),
          ),
      ]),
    );
  }
}
