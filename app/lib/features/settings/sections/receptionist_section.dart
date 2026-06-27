import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';
import '../../../core/moderation_service.dart';
import '../../../core/paid_feature.dart';
import '../../../core/receptionist_api.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/voice/google_voice.dart' show GoogleVoiceCatalog;
import '../settings_registry.dart';

/// Availability presets. id → label shown in the dropdown. Must match the
/// server's STATUS_PRESETS keys in worker/src/routes/receptionist.ts. Default is
/// 'busy' — the short greeting says "<you> is busy, can I take a message?".
const Map<String, String> kReceptionistStatusPresets = {
  'busy': 'Busy',
  'travelling': 'Travelling',
  'meeting': 'In a meeting',
  'driving': 'Driving',
  'holiday': 'On holiday',
  'unavailable': 'Unable to take calls',
};

/// Settings → "Ava Receptionist" section (Specs/PROPOSAL-AI-RECEPTIONIST.md).
///
/// PREMIUM feature (paid subscription only): when ON, Ava answers calls the user
/// misses, opens with a short "Hi, <you> is busy — can I take a message?", takes a
/// quick message within ~1 minute, and leaves a recording.
///
/// Simplified UI (owner decision 2026-06-28): the only knobs are a NAME (how Ava
/// refers to you), a VOICE (woman/man), an AVAILABILITY status, and whether Ava
/// should pick up every call automatically. The server holds the locked system
/// prompt, the 70-second cap and the premium gate.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init].
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
  static const _kDecline = 'receptionist_decline_to_ava';
  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(false);
  /// Local mirror of decline_to_ava (kept for the incoming-call handler in
  /// push_service). The simplified settings UI no longer exposes it, so it stays
  /// off, but the mirror is preserved so existing callers don't break.
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
  final _name = TextEditingController(); // how Ava refers to the owner
  String _voice = GoogleVoiceCatalog.defaultVoice;
  String _statusPreset = 'busy';
  bool _answerAll = false; // "pick up every call automatically"
  bool _enabled = false;
  bool _premium = false;
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  // Local mirror (per-account via DiskCache) of the last-seen settings, so the
  // screen renders INSTANTLY on open instead of waiting on the server round-trip.
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
        _name.text = s.displayName;
        _voice = GoogleVoiceCatalog.isValid(s.voiceName)
            ? s.voiceName
            : GoogleVoiceCatalog.defaultVoice;
        _premium = s.premium;
        _statusPreset = kReceptionistStatusPresets.containsKey(s.statusPreset)
            ? s.statusPreset
            : 'busy';
        _answerAll = s.answerAll;
      }
      _loading = false;
    });
    if (s != null) await _writeMirror();
    await ReceptionistPref.load();
  }

  void _applyMirror(Map<String, dynamic> m) {
    _enabled = m['enabled'] == true;
    _name.text = (m['displayName'] ?? '').toString();
    final v = (m['voice'] ?? GoogleVoiceCatalog.defaultVoice).toString();
    _voice = GoogleVoiceCatalog.isValid(v) ? v : GoogleVoiceCatalog.defaultVoice;
    _premium = m['premium'] == true;
    final sp = (m['statusPreset'] ?? 'busy').toString();
    _statusPreset = kReceptionistStatusPresets.containsKey(sp) ? sp : 'busy';
    _answerAll = m['answerAll'] == true;
  }

  Future<void> _writeMirror() async {
    try {
      await DiskCache.write(_mirrorKey, jsonEncode({
        'enabled': _enabled, 'displayName': _name.text,
        'voice': _voice, 'premium': _premium,
        'statusPreset': _statusPreset, 'answerAll': _answerAll,
      }));
    } catch (_) {/* best-effort */}
  }

  // Only the name is user-authored free text now, so that's all we moderate
  // (server re-checks too; this surfaces the reason).
  Future<String?> _moderateBeforeSave() async {
    final name = _name.text.trim();
    if (name.isEmpty) return null;
    final r = await ModerationService.check(name, ModField.name);
    if (!r.allow) {
      return r.reason.isEmpty ? 'Please revise the name to be appropriate.' : r.reason;
    }
    return null;
  }

  Future<bool> _save({required bool enabled}) async {
    if (enabled) {
      final problem = await _moderateBeforeSave();
      if (problem != null) { _toast(problem); return false; }
    }
    setState(() => _saving = true);
    // Pass empty values for the removed fields so any previously-saved
    // instructions/persona/greeting/custom prompt/language are cleared and the
    // call stays on the short, message-first script.
    final res = await ReceptionistApi.saveSettings(
      enabled: enabled,
      instructions: '',
      voiceName: _voice,
      displayName: _name.text.trim(),
      personaName: '',
      languageCode: '',
      greetingText: '',
      customPrompt: '',
      answerAll: _answerAll,
      statusPreset: _statusPreset,
      statusCustom: '',
      declineToAva: false,
    );
    if (!mounted) return res.ok;
    setState(() {
      _saving = false;
      if (res.ok) _enabled = enabled;
    });
    if (res.ok) {
      await ReceptionistPref.set(enabled);
      await ReceptionistPref.setDeclineToAva(false);
      await _writeMirror();
      Analytics.capture('ava_recept_settings_saved', {
        'enabled': enabled, 'voice': _voice,
        'voice_gender': _voiceGender(_voice),
        'answer_all': _answerAll, 'status_preset': _statusPreset,
      });
      AvaLog.I.log('receptionist', 'settings saved (enabled=$enabled, voice=$_voice)');
      _toast(enabled ? 'Ava will answer your missed calls' : 'Saved');
    } else if (res.blocked) {
      _toast('Ava Receptionist is a premium feature — upgrade to enable it.');
    } else {
      Analytics.capture('ava_recept_save_failed', {'enabled': enabled, 'voice': _voice});
      AvaLog.I.log('receptionist', 'settings save FAILED (enabled=$enabled)');
      _toast('Couldn’t save — check your connection and try again.');
    }
    return res.ok;
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  /// 'woman' / 'man' for a Gemini Live voice name (for telemetry + labels).
  static String _voiceGender(String name) {
    if (GoogleVoiceCatalog.female.any((v) => v.name == name)) return 'woman';
    if (GoogleVoiceCatalog.male.any((v) => v.name == name)) return 'man';
    return '';
  }

  /// Full voice catalog as dropdown items, grouped woman first then man, each
  /// clearly marked so the owner can pick by gender.
  List<DropdownMenuItem<String>> _voiceItems() {
    final items = <DropdownMenuItem<String>>[];
    for (final v in GoogleVoiceCatalog.female) {
      items.add(DropdownMenuItem(
        value: v.name,
        child: Text('${v.name} — woman · ${v.style}', style: ZineText.sub(size: 12.5)),
      ));
    }
    for (final v in GoogleVoiceCatalog.male) {
      items.add(DropdownMenuItem(
        value: v.name,
        child: Text('${v.name} — man · ${v.style}', style: ZineText.sub(size: 12.5)),
      ));
    }
    return items;
  }

  String _voiceValue() =>
      GoogleVoiceCatalog.isValid(_voice) ? _voice : GoogleVoiceCatalog.defaultVoice;

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
                          ? 'When you miss a call, Ava answers, says you’re '
                              'unavailable, takes a quick message and leaves you a recording.'
                          : 'Premium. Let Ava answer the calls you miss, take a '
                              'message, and leave you a recording.',
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
                // ── Name ───────────────────────────────────────────────────
                ZineField(
                  controller: _name,
                  label: 'Your name (how Ava refers to you)',
                  hint: 'e.g. Sonal',
                  maxLength: 60,
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 14),
                // ── Availability ───────────────────────────────────────────
                Text('Availability', style: ZineText.value(size: 13)),
                const SizedBox(height: 6),
                Row(children: [
                  Text('Ava says you’re', style: ZineText.sub(size: 12.5)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: kReceptionistStatusPresets.containsKey(_statusPreset)
                          ? _statusPreset
                          : 'busy',
                      underline: const SizedBox.shrink(),
                      items: [
                        for (final e in kReceptionistStatusPresets.entries)
                          DropdownMenuItem(value: e.key, child: Text(e.value, style: ZineText.sub(size: 12.5))),
                      ],
                      onChanged: (v) => setState(() => _statusPreset = v ?? 'busy'),
                    ),
                  ),
                ]),
                const SizedBox(height: 12),
                // ── Voice (woman / man) ────────────────────────────────────
                Row(children: [
                  Text('Ava’s voice', style: ZineText.sub(size: 12.5)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButton<String>(
                      isExpanded: true,
                      value: _voiceValue(),
                      underline: const SizedBox.shrink(),
                      items: _voiceItems(),
                      onChanged: (v) =>
                          setState(() => _voice = v ?? GoogleVoiceCatalog.defaultVoice),
                    ),
                  ),
                ]),
                const SizedBox(height: 4),
                // ── Auto-answer every call ─────────────────────────────────
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  value: _answerAll,
                  onChanged: (v) => setState(() => _answerAll = v),
                  title: Text('Let Ava pick up every call automatically',
                      style: ZineText.value(size: 12.5)),
                  subtitle: Text(
                      'For when you’re away. Ava answers immediately instead of '
                      'waiting for you to miss the call.',
                      style: ZineText.sub(size: 11)),
                ),
                const SizedBox(height: 12),
                ZineButton(
                  label: _saving ? 'Saving…' : 'Save',
                  fullWidth: true,
                  fontSize: 15,
                  loading: _saving,
                  onPressed: _saving ? null : () => _save(enabled: true),
                ),
                if (!_premium) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Note: Ava Receptionist requires a premium subscription to stay active.',
                    style: ZineText.sub(size: 11),
                  ),
                ],
              ],
            ]),
    );
  }
}
