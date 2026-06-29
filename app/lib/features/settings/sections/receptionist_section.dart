import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';
import '../../../core/moderation_service.dart';
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
  // Single free-text note: "Let Ava know if you're busy, away, etc." Feeds the
  // server's instructions_text, which the (Claude) prompt uses to greet + answer
  // ("Sat is busy right now — can I take a message for him?"). All the old knobs
  // (name/voice/availability/auto-answer) are gone: the name + gender now come
  // from the Profile, and the CF engine uses one fixed warm female voice.
  final _note = TextEditingController();
  String _voice = GoogleVoiceCatalog.defaultVoice; // kept for save() compat (unused in UI)
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
    _note.dispose();
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
        _note.text = s.instructions;
        _premium = s.premium;
      }
      _loading = false;
    });
    if (s != null) await _writeMirror();
    await ReceptionistPref.load();
  }

  void _applyMirror(Map<String, dynamic> m) {
    _enabled = m['enabled'] == true;
    _note.text = (m['note'] ?? '').toString();
    _premium = m['premium'] == true;
  }

  Future<void> _writeMirror() async {
    try {
      await DiskCache.write(_mirrorKey, jsonEncode({
        'enabled': _enabled, 'note': _note.text, 'premium': _premium,
      }));
    } catch (_) {/* best-effort */}
  }

  // Only the name is user-authored free text now, so that's all we moderate
  // (server re-checks too; this surfaces the reason).
  Future<String?> _moderateBeforeSave() async {
    final note = _note.text.trim();
    if (note.isEmpty) return null;
    final r = await ModerationService.check(note, ModField.name);
    if (!r.allow) {
      return r.reason.isEmpty ? 'Please revise the note to be appropriate.' : r.reason;
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
      instructions: _note.text.trim(), // the single availability note
      voiceName: _voice,
      displayName: '',                 // name now comes from the Profile
      personaName: '',
      languageCode: '',
      greetingText: '',
      customPrompt: '',
      answerAll: false,
      statusPreset: 'busy',
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
        'enabled': enabled, 'has_note': _note.text.trim().isNotEmpty,
      });
      AvaLog.I.log('receptionist', 'settings saved (enabled=$enabled, note=${_note.text.trim().isNotEmpty})');
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
                    Text('Ava Receptionist', style: ZineText.value(size: 14.5)),
                    const SizedBox(height: 2),
                    Text(
                      _enabled
                          ? 'When you miss a call, Ava answers, tells the caller why '
                              'you can’t pick up, takes a message and leaves you a recording.'
                          : 'Let Ava answer the calls you miss, take a message, and '
                              'leave you a recording.',
                      style: ZineText.sub(size: 12),
                    ),
                  ]),
                ),
                const SizedBox(width: 10),
                ZineToggle(value: _enabled, onChanged: (v) => _save(enabled: v)),
              ]),
              if (_enabled) ...[
                const SizedBox(height: 14),
                // ── The ONE setting: tell Ava your availability ────────────
                ZineField(
                  controller: _note,
                  label: 'Let Ava know if you’re busy, away, etc.',
                  hint: 'e.g. I’m in meetings until 5pm — please take a message and I’ll call back.',
                  maxLength: 280,
                  textCapitalization: TextCapitalization.sentences,
                ),
                const SizedBox(height: 6),
                Text(
                  'Ava uses this to tell callers why you can’t pick up and to take a '
                  'message in your words. Your name and gender come from your Profile.',
                  style: ZineText.sub(size: 11),
                ),
                const SizedBox(height: 12),
                ZineButton(
                  label: _saving ? 'Saving…' : 'Save',
                  fullWidth: true,
                  fontSize: 15,
                  loading: _saving,
                  onPressed: _saving ? null : () => _save(enabled: true),
                ),
              ],
            ]),
    );
  }
}
