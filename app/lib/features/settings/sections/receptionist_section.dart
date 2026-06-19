import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/avavoice_api.dart' show kFallbackVoices, VoiceOption;
import '../../../core/disk_cache.dart';
import '../../../core/paid_feature.dart';
import '../../../core/receptionist_api.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../settings_registry.dart';

/// Settings → "Ava Receptionist" section (Specs/PROPOSAL-AI-RECEPTIONIST.md).
///
/// PREMIUM feature: when ON, Ava answers calls the user misses (after ~5 rings),
/// talks for up to 2 minutes following the user's written brief, takes a message
/// and leaves a recording under the caller's phone number. This is the first real
/// AvaVoice deployment — the future AvaVoice pipeline is built on this.
///
/// The server is the source of truth (config + the hidden system prompt live on
/// the Worker so the caller can never tamper). This card just edits it. Enabling
/// is the premium gate (wrapped in [PaidFeature]); turning OFF is always free.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init]
/// (`registerReceptionistSection()`).
void registerReceptionistSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_receptionist',
      title: 'Ava Receptionist',
      order: 24, // just above "Ava voice" (25)
      builder: (context) => const _ReceptionistCard(),
    ),
  );
}

/// Per-account local mirror of the enabled flag (server is authoritative). Lets
/// other surfaces react instantly. Account-scoped via [DiskCache].
class ReceptionistPref {
  ReceptionistPref._();
  static const _kKey = 'receptionist_enabled';
  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);

  static Future<bool> load() async {
    final raw = await DiskCache.read(_kKey);
    final v = raw == '1';
    if (enabled.value != v) enabled.value = v;
    return v;
  }

  static Future<void> set(bool v) async {
    enabled.value = v;
    await DiskCache.write(_kKey, v ? '1' : '0');
  }
}

class _ReceptionistCard extends StatefulWidget {
  const _ReceptionistCard();
  @override
  State<_ReceptionistCard> createState() => _ReceptionistCardState();
}

class _ReceptionistCardState extends State<_ReceptionistCard> {
  final _instr = TextEditingController();
  final _name = TextEditingController();
  String _voice = 'Puck';
  bool _enabled = false;
  bool _premium = false;
  bool _loading = true;
  bool _saving = false;
  bool _hasKb = false;
  bool _kbBusy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _instr.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final s = await ReceptionistApi.getSettings();
    if (!mounted) return;
    setState(() {
      if (s != null) {
        _enabled = s.enabled;
        _instr.text = s.instructions;
        _name.text = s.displayName;
        _voice = s.voiceName.isEmpty ? 'Puck' : s.voiceName;
        _premium = s.premium;
        _hasKb = s.hasKb;
      }
      _loading = false;
    });
    await ReceptionistPref.load();
  }

  Future<bool> _save({required bool enabled}) async {
    setState(() => _saving = true);
    final res = await ReceptionistApi.saveSettings(
      enabled: enabled,
      instructions: _instr.text.trim(),
      voiceName: _voice,
      displayName: _name.text.trim(),
    );
    if (!mounted) return res.ok;
    setState(() {
      _saving = false;
      if (res.ok) _enabled = enabled;
    });
    if (res.ok) {
      await ReceptionistPref.set(enabled);
      Analytics.capture('ava_recept_settings_saved', {'enabled': enabled, 'voice': _voice});
      AvaLog.I.log('receptionist', 'settings saved (enabled=$enabled, voice=$_voice)');
      _toast(enabled ? 'Ava will answer your missed calls' : 'Saved');
    } else if (res.blocked) {
      _toast('That’s a premium feature — top up to enable Ava.');
    } else {
      _toast('Couldn’t save. Try again.');
    }
    return res.ok;
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _pickKb() async {
    if (_kbBusy) return;
    try {
      final res = await FilePicker.platform.pickFiles(withData: true);
      final f = res?.files.isNotEmpty == true ? res!.files.first : null;
      final bytes = f?.bytes;
      if (f == null || bytes == null) return;
      setState(() => _kbBusy = true);
      final ok = await ReceptionistApi.uploadKb(bytes, f.name);
      if (!mounted) return;
      setState(() {
        _kbBusy = false;
        if (ok) _hasKb = true;
      });
      Analytics.capture('ava_recept_kb_uploaded', {'ok': ok});
      AvaLog.I.log('receptionist', 'kb upload ${ok ? "ok" : "failed"}: ${f.name}');
      _toast(ok ? 'Added to Ava’s knowledge' : 'Upload failed');
    } catch (e) {
      if (kDebugMode) debugPrint('receptionist kb pick failed: $e');
      if (mounted) setState(() => _kbBusy = false);
    }
  }

  Future<void> _clearKb() async {
    setState(() => _kbBusy = true);
    final ok = await ReceptionistApi.clearKb();
    if (!mounted) return;
    setState(() {
      _kbBusy = false;
      if (ok) _hasKb = false;
    });
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
              child: Center(child: SizedBox(
                  width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))),
            )
          : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.phoneCall(PhosphorIconsStyle.fill),
                    color: Zine.lilac,
                    size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Text('Ava Receptionist', style: ZineText.value(size: 14.5)),
                      const SizedBox(width: 8),
                      const PaidBadge(),
                    ]),
                    const SizedBox(height: 2),
                    Text(
                      _enabled
                          ? 'When you miss a call, Ava answers after 5 rings, talks for up '
                              'to 2 minutes, takes a message and leaves you a recording.'
                          : 'Premium. Let Ava answer the calls you miss, take a message, '
                              'and leave you a recording.',
                      style: ZineText.sub(size: 12),
                    ),
                  ]),
                ),
                const SizedBox(width: 10),
                if (_enabled)
                  ZineToggle(value: true, onChanged: (_) => _save(enabled: false))
                else
                  PaidFeature(
                    actionLabel: 'Enable Ava Receptionist',
                    onRun: () async => _save(enabled: true),
                    child: const IgnorePointer(
                        child: ZineToggle(value: false, onChanged: null)),
                  ),
              ]),
              if (_enabled) ...[
                const SizedBox(height: 14),
                Text('Leave Instructions for Ava', style: ZineText.value(size: 13)),
                const SizedBox(height: 6),
                ZineField(
                  controller: _instr,
                  hint: 'e.g. Take a message and let them know I’m in a meeting. '
                      'If it’s urgent, tell them to text me.',
                  maxLines: 4,
                  maxLength: 2000,
                  textCapitalization: TextCapitalization.sentences,
                ),
                const SizedBox(height: 10),
                ZineField(
                  controller: _name,
                  label: 'How Ava refers to you',
                  hint: 'e.g. Sonal',
                  maxLength: 60,
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 12),
                Row(children: [
                  Text('Ava’s voice', style: ZineText.sub(size: 12.5)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: _voiceValue(),
                      underline: const SizedBox.shrink(),
                      items: [
                        for (final VoiceOption v in kFallbackVoices)
                          DropdownMenuItem(value: v.name, child: Text(v.label, style: ZineText.sub(size: 12.5))),
                      ],
                      onChanged: (v) => setState(() => _voice = v ?? 'Puck'),
                    ),
                  ),
                ]),
                const SizedBox(height: 12),
                ZineButton(
                  label: _saving ? 'Saving…' : 'Save instructions',
                  fullWidth: true,
                  fontSize: 15,
                  loading: _saving,
                  onPressed: _saving ? null : () => _save(enabled: true),
                ),
                const SizedBox(height: 12),
                // Knowledge (Gemini File Search RAG) — optional. Lets Ava answer
                // quick questions from the owner's files during the call.
                Row(children: [
                  Expanded(
                    child: Text(
                      _hasKb
                          ? 'Ava can answer from your uploaded knowledge.'
                          : 'Optional: add files Ava can answer questions from.',
                      style: ZineText.sub(size: 11.5),
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (_hasKb)
                    TextButton(
                      onPressed: _kbBusy ? null : _clearKb,
                      child: Text('Clear', style: ZineText.sub(size: 12)),
                    ),
                  ZineButton(
                    label: _kbBusy ? '…' : (_hasKb ? 'Add more' : 'Add knowledge'),
                    variant: ZineButtonVariant.ghost,
                    fontSize: 13,
                    loading: _kbBusy,
                    onPressed: _kbBusy ? null : _pickKb,
                  ),
                ]),
                if (!_premium) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Note: requires a premium (topped-up) account to stay active.',
                    style: ZineText.sub(size: 11),
                  ),
                ],
              ],
            ]),
    );
  }

  // Guard against a saved voice that isn't in the picker list.
  String _voiceValue() =>
      kFallbackVoices.any((v) => v.name == _voice) ? _voice : 'Puck';
}
