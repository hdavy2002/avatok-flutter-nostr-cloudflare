import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/avavoice_api.dart' show kFallbackVoices, VoiceOption;
import '../../../core/disk_cache.dart';
import '../../../core/moderation_service.dart';
import '../../../core/paid_feature.dart';
import '../../../core/receptionist_api.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/voice/google_voice.dart' show AvaLangCatalog;
import '../settings_registry.dart';

/// Availability presets (Mode B). id → label shown in the dropdown. Must match
/// the server's STATUS_PRESETS keys in worker/src/routes/receptionist.ts.
const Map<String, String> kReceptionistStatusPresets = {
  '': 'No status',
  'busy': 'Busy',
  'travelling': 'Travelling',
  'meeting': 'In a meeting',
  'driving': 'Driving',
  'holiday': 'On holiday',
  'after_hours': 'After hours',
  'custom': 'Custom…',
};

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
  static const _kDecline = 'receptionist_decline_to_ava'; // v2 Mode C mirror
  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);
  /// Local mirror of decline_to_ava so the incoming-call decline handler (in
  /// push_service) can route a declined call to Ava without a network round-trip.
  static final ValueNotifier<bool> declineToAva = ValueNotifier<bool>(false);

  static Future<bool> load() async {
    final raw = await DiskCache.read(_kKey);
    final v = raw == '1';
    if (enabled.value != v) enabled.value = v;
    final d = (await DiskCache.read(_kDecline)) == '1';
    if (declineToAva.value != d) declineToAva.value = d;
    return v;
  }

  static Future<void> set(bool v) async {
    enabled.value = v;
    await DiskCache.write(_kKey, v ? '1' : '0');
  }

  static Future<void> setDeclineToAva(bool v) async {
    declineToAva.value = v;
    await DiskCache.write(_kDecline, v ? '1' : '0');
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
  final _persona = TextEditingController();       // v2: Ava's own name
  final _greeting = TextEditingController();       // v2: exact opening line
  final _custom = TextEditingController();         // v2: advanced behaviour prompt
  final _statusCustom = TextEditingController();   // v2: custom availability text
  String _voice = 'Aoede';
  String _lang = '';                               // v2: '' = auto-detect
  String _statusPreset = '';                       // v2
  bool _answerAll = false;                          // v2: Mode B
  bool _declineToAva = false;                       // v2: Mode C decline path
  bool _advancedOpen = false;                       // v2: custom-prompt expander
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
    _persona.dispose();
    _greeting.dispose();
    _custom.dispose();
    _statusCustom.dispose();
    super.dispose();
  }

  // Local mirror (per-account via DiskCache) of the last-seen settings, so the
  // screen renders INSTANTLY on open instead of waiting on the server round-trip.
  // Refreshed from the server right after, and re-written on every save.
  static const String _mirrorKey = 'receptionist_settings_mirror';

  Future<void> _load() async {
    // 1) Instant paint from the local mirror, if present.
    try {
      final raw = await DiskCache.read(_mirrorKey);
      if (raw != null && mounted) {
        final m = (jsonDecode(raw) as Map).cast<String, dynamic>();
        setState(() { _applyMirror(m); _loading = false; });
      }
    } catch (_) {/* no/invalid mirror — fall through to the server fetch */}

    // 2) Authoritative refresh from the server.
    final s = await ReceptionistApi.getSettings();
    if (!mounted) return;
    setState(() {
      if (s != null) {
        _enabled = s.enabled;
        _instr.text = s.instructions;
        _name.text = s.displayName;
        _voice = s.voiceName.isEmpty ? 'Aoede' : s.voiceName;
        _premium = s.premium;
        _hasKb = s.hasKb;
        // v2
        _persona.text = s.personaName;
        _greeting.text = s.greetingText;
        _custom.text = s.customPrompt;
        _statusCustom.text = s.statusCustom;
        _lang = AvaLangCatalog.isValid(s.languageCode) ? s.languageCode : '';
        _statusPreset = kReceptionistStatusPresets.containsKey(s.statusPreset) ? s.statusPreset : '';
        _answerAll = s.answerAll;
        _declineToAva = s.declineToAva;
        _advancedOpen = s.customPrompt.isNotEmpty;
      }
      _loading = false;
    });
    if (s != null) await _writeMirror();
    await ReceptionistPref.load();
  }

  /// Populate the form fields from a cached mirror map (best-effort, tolerant of
  /// missing keys).
  void _applyMirror(Map<String, dynamic> m) {
    _enabled = m['enabled'] == true;
    _instr.text = (m['instructions'] ?? '').toString();
    _name.text = (m['displayName'] ?? '').toString();
    final v = (m['voice'] ?? 'Aoede').toString();
    _voice = v.isEmpty ? 'Aoede' : v;
    _premium = m['premium'] == true;
    _hasKb = m['hasKb'] == true;
    _persona.text = (m['persona'] ?? '').toString();
    _greeting.text = (m['greeting'] ?? '').toString();
    _custom.text = (m['custom'] ?? '').toString();
    _statusCustom.text = (m['statusCustom'] ?? '').toString();
    final lang = (m['lang'] ?? '').toString();
    _lang = AvaLangCatalog.isValid(lang) ? lang : '';
    final sp = (m['statusPreset'] ?? '').toString();
    _statusPreset = kReceptionistStatusPresets.containsKey(sp) ? sp : '';
    _answerAll = m['answerAll'] == true;
    _declineToAva = m['declineToAva'] == true;
    _advancedOpen = _custom.text.isNotEmpty;
  }

  /// Persist the current field values to the local mirror.
  Future<void> _writeMirror() async {
    try {
      await DiskCache.write(_mirrorKey, jsonEncode({
        'enabled': _enabled, 'instructions': _instr.text, 'displayName': _name.text,
        'voice': _voice, 'premium': _premium, 'hasKb': _hasKb,
        'persona': _persona.text, 'greeting': _greeting.text, 'custom': _custom.text,
        'statusCustom': _statusCustom.text, 'lang': _lang, 'statusPreset': _statusPreset,
        'answerAll': _answerAll, 'declineToAva': _declineToAva,
      }));
    } catch (_) {/* best-effort */}
  }

  // AI content validation — block the save (with a clear reason) when any of the
  // user-authored fields is unsafe. Server re-checks too; this surfaces the reason.
  Future<String?> _moderateBeforeSave() async {
    final checks = <List<String>>[
      [_instr.text.trim(), ModField.prompt],
      [_custom.text.trim(), ModField.prompt],
      [_greeting.text.trim(), ModField.greeting],
      [_statusCustom.text.trim(), ModField.status],
      [_name.text.trim(), ModField.name],
      [_persona.text.trim(), ModField.personaName],
    ];
    for (final c in checks) {
      if (c[0].isEmpty) continue;
      final r = await ModerationService.check(c[0], c[1]);
      if (!r.allow) return r.reason.isEmpty ? 'Please revise your text to be appropriate.' : r.reason;
    }
    return null;
  }

  Future<bool> _save({required bool enabled}) async {
    // Validate content first when turning ON / saving real content.
    if (enabled) {
      final problem = await _moderateBeforeSave();
      if (problem != null) { _toast(problem); return false; }
    }
    setState(() => _saving = true);
    final res = await ReceptionistApi.saveSettings(
      enabled: enabled,
      instructions: _instr.text.trim(),
      voiceName: _voice,
      displayName: _name.text.trim(),
      personaName: _persona.text.trim(),
      languageCode: _lang,
      greetingText: _greeting.text.trim(),
      customPrompt: _custom.text.trim(),
      answerAll: _answerAll,
      statusPreset: _statusPreset,
      statusCustom: _statusCustom.text.trim(),
      declineToAva: _declineToAva,
    );
    if (!mounted) return res.ok;
    setState(() {
      _saving = false;
      if (res.ok) _enabled = enabled;
    });
    if (res.ok) {
      await ReceptionistPref.set(enabled);
      await ReceptionistPref.setDeclineToAva(enabled && _declineToAva);
      await _writeMirror(); // keep the instant-render mirror in sync with the save
      Analytics.capture('ava_recept_settings_saved', {
        'enabled': enabled, 'voice': _voice, 'answer_all': _answerAll,
        'decline_to_ava': _declineToAva, 'has_persona': _persona.text.trim().isNotEmpty,
        'language': _lang.isEmpty ? 'auto' : _lang, 'status_preset': _statusPreset,
      });
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
                const SizedBox(height: 10),
                ZineField(
                  controller: _persona,
                  label: 'Ava’s name (how she introduces herself)',
                  hint: 'e.g. Maya — leave blank to use “Ava”',
                  maxLength: 40,
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 10),
                ZineField(
                  controller: _greeting,
                  label: 'Opening greeting (optional)',
                  hint: 'e.g. Hi, you’ve reached Sonal’s assistant.',
                  maxLines: 2,
                  maxLength: 200,
                  textCapitalization: TextCapitalization.sentences,
                ),
                const SizedBox(height: 14),
                // ── Availability (Mode B) ──────────────────────────────────
                Text('Availability', style: ZineText.value(size: 13)),
                const SizedBox(height: 6),
                Row(children: [
                  Text('Ava says you’re', style: ZineText.sub(size: 12.5)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: _statusPreset,
                      underline: const SizedBox.shrink(),
                      items: [
                        for (final e in kReceptionistStatusPresets.entries)
                          DropdownMenuItem(value: e.key, child: Text(e.value, style: ZineText.sub(size: 12.5))),
                      ],
                      onChanged: (v) => setState(() => _statusPreset = v ?? ''),
                    ),
                  ),
                ]),
                if (_statusPreset == 'custom') ...[
                  const SizedBox(height: 8),
                  ZineField(
                    controller: _statusCustom,
                    hint: 'e.g. is away from the desk until Monday',
                    maxLength: 120,
                    textCapitalization: TextCapitalization.sentences,
                  ),
                ],
                const SizedBox(height: 10),
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _answerAll,
                  onChanged: (v) => setState(() => _answerAll = v),
                  title: Text('Answer every call on the first ring',
                      style: ZineText.value(size: 12.5)),
                  subtitle: Text(
                      'For when you’re away. Ava picks up immediately instead of waiting 5 rings.',
                      style: ZineText.sub(size: 11)),
                ),
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _declineToAva,
                  onChanged: (v) => setState(() => _declineToAva = v),
                  title: Text('Let Ava take calls I decline',
                      style: ZineText.value(size: 12.5)),
                  subtitle: Text(
                      'When you hit Decline, Ava answers instead of a plain missed call.',
                      style: ZineText.sub(size: 11)),
                ),
                const SizedBox(height: 12),
                // ── Language ───────────────────────────────────────────────
                Row(children: [
                  Text('Ava’s language', style: ZineText.sub(size: 12.5)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: AvaLangCatalog.isValid(_lang) ? _lang : '',
                      underline: const SizedBox.shrink(),
                      items: [
                        for (final l in AvaLangCatalog.all)
                          DropdownMenuItem(value: l.code, child: Text(l.label, style: ZineText.sub(size: 12.5))),
                      ],
                      onChanged: (v) => setState(() => _lang = v ?? ''),
                    ),
                  ),
                ]),
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
                      onChanged: (v) => setState(() => _voice = v ?? 'Aoede'),
                    ),
                  ),
                ]),
                const SizedBox(height: 12),
                // ── Advanced: custom behaviour prompt ──────────────────────
                InkWell(
                  onTap: () => setState(() => _advancedOpen = !_advancedOpen),
                  child: Row(children: [
                    Text('Advanced', style: ZineText.sub(size: 12.5)),
                    const SizedBox(width: 4),
                    Icon(_advancedOpen ? Icons.expand_less : Icons.expand_more,
                        size: 18, color: Zine.inkMute),
                  ]),
                ),
                if (_advancedOpen) ...[
                  const SizedBox(height: 8),
                  ZineField(
                    controller: _custom,
                    hint: 'Extra behaviour for Ava. Safety rules and the 2-minute '
                        'limit always apply and can’t be overridden here.',
                    maxLines: 4,
                    maxLength: 1000,
                    textCapitalization: TextCapitalization.sentences,
                  ),
                ],
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
      kFallbackVoices.any((v) => v.name == _voice) ? _voice : 'Aoede';
}
