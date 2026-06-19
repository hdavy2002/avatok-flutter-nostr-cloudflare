import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/feature_flags.dart';
import '../../../core/ringtone_api.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../avavision/widgets.dart' show MiniPill;
import '../settings_registry.dart';

/// Settings → "Ringback tone" section.
/// Spec: Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md.
///
/// FREE feature. The user generates a ringtone with AI (MiniMax Music 2.6),
/// keeps up to 5 in a library, sets one as the default callers hear, previews
/// any, and deletes any (which also removes it from storage server-side).
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init].
void registerRingtoneSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ai_ringback',
      title: 'Ringback tone',
      order: 26, // just below "Ava voice" (25) / Receptionist (24)
      builder: (context) => const _RingtoneCard(),
    ),
  );
}

const List<String> _presetPrompts = [
  'Calm lo-fi piano with soft vinyl crackle',
  'Upbeat synth-pop hook, bright and catchy',
  'Warm acoustic guitar, gentle and friendly',
  'Cinematic orchestral swell, short and grand',
];

class _RingtoneCard extends StatefulWidget {
  const _RingtoneCard();
  @override
  State<_RingtoneCard> createState() => _RingtoneCardState();
}

class _RingtoneCardState extends State<_RingtoneCard> {
  final _prompt = TextEditingController();
  final AudioPlayer _preview = AudioPlayer();
  List<Ringtone> _tones = const [];
  bool _loading = true;
  bool _generating = false;
  int _remaining = -1; // -1 = unknown
  String? _playingId;

  @override
  void initState() {
    super.initState();
    _preview.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playingId = null);
    });
    _load();
  }

  @override
  void dispose() {
    _prompt.dispose();
    _preview.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final list = await RingtoneApi.list();
    if (!mounted) return;
    setState(() {
      _tones = list;
      _loading = false;
    });
  }

  Future<void> _generate() async {
    final prompt = _prompt.text.trim();
    if (prompt.isEmpty) {
      _toast('Describe the ringtone you want first');
      return;
    }
    // At the cap, generating replaces the oldest (server FIFO) — warn first.
    if (_tones.length >= kMaxRingtonesPerAccount) {
      final ok = await _confirm(
        'Replace your oldest ringtone?',
        'You already have $kMaxRingtonesPerAccount saved (the max). Generating a '
            'new one removes the oldest.',
        'Generate',
      );
      if (ok != true) return;
    }
    setState(() => _generating = true);
    final res = await RingtoneApi.generate(prompt, instrumental: true);
    if (!mounted) return;
    setState(() => _generating = false);
    if (res.error == null) {
      setState(() {
        _tones = res.ringtones;
        _remaining = res.remaining;
        _prompt.clear();
      });
      Analytics.capture('ringtone_generated', {'count': _tones.length});
      AvaLog.I.log('ringback', 'generated ringtone (remaining=$_remaining)');
      _toast('Ringtone ready — set it as default to use it');
    } else if (res.error == 'daily-limit') {
      _toast('You’ve hit today’s generation limit — try again tomorrow');
    } else if (res.error == 'disabled') {
      _toast('Ringtones are temporarily unavailable');
    } else {
      _toast('Couldn’t generate that one — try a different description');
    }
  }

  Future<void> _setDefault(Ringtone t) async {
    final list = await RingtoneApi.setDefault(t.id);
    if (!mounted || list.isEmpty) return;
    setState(() => _tones = list);
    Analytics.capture('ringback_set', {'id': t.id});
    _toast('Callers will now hear “${t.name}”');
  }

  Future<void> _delete(Ringtone t) async {
    final ok = await _confirm('Delete “${t.name}”?',
        'This removes it from your ringtones and from storage. This can’t be undone.', 'Delete');
    if (ok != true) return;
    if (_playingId == t.id) {
      await _preview.stop();
      if (mounted) setState(() => _playingId = null);
    }
    final list = await RingtoneApi.delete(t.id);
    if (!mounted) return;
    setState(() => _tones = list);
    Analytics.capture('ringback_cleared', {'id': t.id});
  }

  Future<void> _togglePreview(Ringtone t) async {
    try {
      if (_playingId == t.id) {
        await _preview.stop();
        if (mounted) setState(() => _playingId = null);
        return;
      }
      await _preview.stop();
      await _preview.play(UrlSource(t.url));
      if (mounted) setState(() => _playingId = t.id);
    } catch (e) {
      AvaLog.I.log('ringback', 'preview failed: $e');
      _toast('Couldn’t play that preview');
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<bool?> _confirm(String title, String body, String action) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(action)),
        ],
      ),
    );
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
                      'Generate a tune with AI and set it as your ringback — the '
                      'sound people hear while your phone is ringing.',
                      style: ZineText.sub(size: 12),
                    ),
                  ]),
                ),
              ]),
              const SizedBox(height: 14),

              // --- generate ---
              ZineField(
                controller: _prompt,
                hint: 'Describe a ringtone, e.g. “calm lo-fi piano”',
                maxLines: 2,
                maxLength: 200,
                textCapitalization: TextCapitalization.sentences,
              ),
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final p in _presetPrompts)
                  ActionChip(
                    label: Text(p.split(',').first, style: ZineText.sub(size: 11.5)),
                    onPressed: () => setState(() => _prompt.text = p),
                  ),
              ]),
              const SizedBox(height: 10),
              ZineButton(
                label: _generating ? 'Generating…' : 'Generate ringtone',
                fullWidth: true,
                fontSize: 15,
                loading: _generating,
                onPressed: _generating ? null : _generate,
              ),
              const SizedBox(height: 4),
              Text(
                _remaining >= 0
                    ? '${_tones.length}/$kMaxRingtonesPerAccount saved · $_remaining generations left today'
                    : '${_tones.length}/$kMaxRingtonesPerAccount saved · up to $kMaxRingtonesPerAccount ringtones',
                style: ZineText.sub(size: 11),
              ),

              // --- library ---
              if (_tones.isNotEmpty) ...[
                const SizedBox(height: 14),
                Text('YOUR RINGTONES', style: ZineText.sub(size: 11)),
                const SizedBox(height: 6),
                for (final t in _tones) _row(t),
              ],
            ]),
    );
  }

  Widget _row(Ringtone t) {
    final playing = _playingId == t.id;
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
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(t.name, style: ZineText.value(size: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
            Text('${t.seconds}s', style: ZineText.sub(size: 10.5)),
          ]),
        ),
        const SizedBox(width: 6),
        if (t.isDefault)
          const MiniPill('Default', fill: Zine.mint, fg: Zine.ink)
        else
          ZineButton(
            label: 'Set as default',
            variant: ZineButtonVariant.ghost,
            fontSize: 12,
            onPressed: () => _setDefault(t),
          ),
        IconButton(
          visualDensity: VisualDensity.compact,
          icon: Icon(PhosphorIcons.trash(), color: Zine.coral, size: 18),
          onPressed: () => _delete(t),
        ),
      ]),
    );
  }
}
