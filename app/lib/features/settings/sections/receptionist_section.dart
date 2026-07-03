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

/// F1: server cap on the status note (MAX_STATUS_NOTE in
/// worker/src/routes/receptionist.ts). The live counter and field maxLength both
/// use this; the server also slices to it defensively.
const int kReceptionistNoteMax = 500;

/// F1: answering-language options for Ava. code = BCP-47 that MUST be one of the
/// server's LANG_CODES set (worker/src/routes/receptionist.ts) — a value outside
/// that set is silently reset to auto-detect server-side. `native` is the
/// language's own name (shown to the owner); `english` powers search matching.
class ReceptionistLang {
  final String code;    // BCP-47, e.g. 'hi-IN'
  final String native;  // e.g. 'हिन्दी'
  final String english; // e.g. 'Hindi'
  const ReceptionistLang(this.code, this.native, this.english);
}

/// Mirror of the server LANG_CODES (27 verified Gemini-Live codes). Order roughly
/// by launch-market reach; the picker is searchable so order is cosmetic.
const List<ReceptionistLang> kReceptionistLangs = [
  ReceptionistLang('en-US', 'English (US)', 'English United States'),
  ReceptionistLang('en-GB', 'English (UK)', 'English United Kingdom'),
  ReceptionistLang('en-IN', 'English (India)', 'English India'),
  ReceptionistLang('en-AU', 'English (Australia)', 'English Australia'),
  ReceptionistLang('hi-IN', 'हिन्दी', 'Hindi'),
  ReceptionistLang('bn-IN', 'বাংলা', 'Bengali'),
  ReceptionistLang('ta-IN', 'தமிழ்', 'Tamil'),
  ReceptionistLang('te-IN', 'తెలుగు', 'Telugu'),
  ReceptionistLang('es-ES', 'Español (España)', 'Spanish Spain'),
  ReceptionistLang('es-US', 'Español (US)', 'Spanish United States'),
  ReceptionistLang('fr-FR', 'Français', 'French'),
  ReceptionistLang('de-DE', 'Deutsch', 'German'),
  ReceptionistLang('it-IT', 'Italiano', 'Italian'),
  ReceptionistLang('pt-BR', 'Português (Brasil)', 'Portuguese Brazil'),
  ReceptionistLang('pt-PT', 'Português (Portugal)', 'Portuguese Portugal'),
  ReceptionistLang('nl-NL', 'Nederlands', 'Dutch'),
  ReceptionistLang('pl-PL', 'Polski', 'Polish'),
  ReceptionistLang('ru-RU', 'Русский', 'Russian'),
  ReceptionistLang('tr-TR', 'Türkçe', 'Turkish'),
  ReceptionistLang('ar-XA', 'العربية', 'Arabic'),
  ReceptionistLang('uk-UA', 'Українська', 'Ukrainian'),
  ReceptionistLang('ja-JP', '日本語', 'Japanese'),
  ReceptionistLang('ko-KR', '한국어', 'Korean'),
  ReceptionistLang('cmn-CN', '中文', 'Chinese Mandarin'),
  ReceptionistLang('vi-VN', 'Tiếng Việt', 'Vietnamese'),
  ReceptionistLang('id-ID', 'Bahasa Indonesia', 'Indonesian'),
  ReceptionistLang('th-TH', 'ไทย', 'Thai'),
];

/// Map a bare 2-letter GeoIP suggestion (server `answer_lang_default`, e.g. 'hi')
/// to a full BCP-47 code we actually offer, so the picker can pre-select it and
/// label it "(detected)". Falls back to en-US.
String receptionistDefaultLangCode(String twoLetter) {
  final ll = twoLetter.trim().toLowerCase();
  // A few server COUNTRY_LANG codes don't share a prefix with our BCP-47 tags.
  const alias = {'zh': 'cmn-CN'};
  if (alias.containsKey(ll)) return alias[ll]!;
  for (final l in kReceptionistLangs) {
    if (l.code.toLowerCase().startsWith('$ll-') || l.code.toLowerCase() == ll) {
      return l.code;
    }
  }
  return 'en-US';
}

/// F1: a status-note expiry preset. [ttl] null = "No expiry"; ttl set = now+ttl.
/// [custom] flags the "Custom…" chip which opens a date/time picker.
class _ExpiryOption {
  final String label;
  final Duration? ttl; // null = No expiry (unless custom)
  final bool custom;
  const _ExpiryOption(this.label, this.ttl, {this.custom = false});
}

const List<_ExpiryOption> _kExpiryOptions = [
  _ExpiryOption('15 min', Duration(minutes: 15)),
  _ExpiryOption('30 min', Duration(minutes: 30)),
  _ExpiryOption('1 hour', Duration(hours: 1)),
  _ExpiryOption('4 hours', Duration(hours: 4)),
  _ExpiryOption('Custom…', null, custom: true),
  _ExpiryOption('No expiry', null),
];

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
  bool _enabled = false;
  bool _premium = false;
  bool _loading = true;
  bool _saving = false;

  // F1 — status note expiry. Null = no expiry; else the absolute epoch-ms instant
  // the note lapses. `_customExpiry` mirrors a picked custom instant so its chip
  // stays highlighted.
  int? _expiresAtMs;
  DateTime? _customExpiry;

  // F1 — answering language. '' = auto/detected. `_langDefault` is the
  // GeoIP-derived BCP-47 suggestion we pre-select and badge "(detected)".
  String _answerLang = '';
  String _langDefault = 'en-US';
  bool _langIsDetected = true; // true until the owner explicitly picks a language

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
        // F1: server is authoritative for the note + expiry + language.
        _expiresAtMs = s.statusExpiresAt;
        _customExpiry = _isCustomExpiry(s.statusExpiresAt) && s.statusExpiresAt != null
            ? DateTime.fromMillisecondsSinceEpoch(s.statusExpiresAt!)
            : null;
        // The status NOTE is a distinct field from instructions_text. If the
        // server has a saved status note, it wins over the availability note for
        // the notes box (they share the same UI box in this simplified screen).
        if (s.statusNote.isNotEmpty) _note.text = s.statusNote;
        _langDefault = receptionistDefaultLangCode(s.answerLangDefault);
        if (s.answerLang.isNotEmpty) {
          _answerLang = s.answerLang;
          _langIsDetected = false;
        } else {
          _answerLang = '';
          _langIsDetected = true;
        }
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
    _expiresAtMs = (m['expires_at'] as num?)?.toInt();
    _answerLang = (m['answer_lang'] ?? '').toString();
    _langIsDetected = _answerLang.isEmpty;
    _langDefault = receptionistDefaultLangCode((m['lang_default'] ?? 'en').toString());
    _customExpiry = _isCustomExpiry(_expiresAtMs) && _expiresAtMs != null
        ? DateTime.fromMillisecondsSinceEpoch(_expiresAtMs!)
        : null;
  }

  Future<void> _writeMirror() async {
    try {
      await DiskCache.write(_mirrorKey, jsonEncode({
        'enabled': _enabled, 'note': _note.text, 'premium': _premium,
        'expires_at': _expiresAtMs,
        'answer_lang': _answerLang,
        'lang_default': _langDefault,
      }));
    } catch (_) {/* best-effort */}
  }

  /// Does this epoch-ms expiry NOT correspond to one of the fixed preset
  /// durations (from "now")? If so, it's a custom instant. Presets are matched
  /// with a small tolerance window since they're computed as now+ttl on save.
  bool _isCustomExpiry(int? ms) {
    if (ms == null) return false;
    final rem = ms - DateTime.now().millisecondsSinceEpoch;
    for (final o in _kExpiryOptions) {
      if (o.ttl == null) continue;
      if ((rem - o.ttl!.inMilliseconds).abs() <= 90 * 1000) return false;
    }
    return true;
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
    // F1: resolve the note + expiry + language. The status note IS the note box.
    final note = _note.text.trim();
    // Expiry: only meaningful while there's a note. Sent as epoch ms (null=never).
    final expiresAt = note.isEmpty ? null : _expiresAtMs;
    // Language: '' when left on detected/auto (server keeps auto-detect). When the
    // owner explicitly kept the detected default, we still send auto ('') so the
    // server never pins the GeoIP guess — matching the F1 contract.
    final answerLang = _langIsDetected ? '' : _answerLang;
    final langSource = _langIsDetected ? 'detected' : 'user';
    // Pass empty values for the removed fields so any previously-saved
    // persona/greeting/custom prompt/legacy language are cleared and the call
    // stays on the short, message-first script. voice_name is omitted (server
    // pins Ava's one fixed female voice).
    final res = await ReceptionistApi.saveSettings(
      enabled: enabled,
      instructions: note, // the single availability note (also mirrored to status_note)
      displayName: '',    // name now comes from the Profile
      personaName: '',
      languageCode: '',
      greetingText: '',
      customPrompt: '',
      answerAll: false,
      statusPreset: 'busy',
      statusCustom: '',
      declineToAva: false,
      // F1 — status note + expiry + answering language.
      statusNote: note,
      statusExpiresAt: expiresAt,
      answerLang: answerLang,
      answerLangSource: langSource,
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
        'enabled': enabled, 'has_note': note.isNotEmpty,
      });
      // F1 telemetry — mirror the server events so client + server agree.
      Analytics.capture('recept_status_saved', {
        'has_expiry': expiresAt != null,
        'ttl_bucket': _ttlBucket(expiresAt),
      });
      if (answerLang.isNotEmpty) {
        Analytics.capture('recept_lang_set', {
          'lang': answerLang, 'source': langSource,
        });
      }
      AvaLog.I.log('receptionist', 'settings saved (enabled=$enabled, note=${note.isNotEmpty}, expiry=${expiresAt != null}, lang=${answerLang.isEmpty ? "auto" : answerLang})');
      _toast(enabled ? 'Ava will answer your missed calls' : 'Saved');
    } else if (res.blocked) {
      _toast('Ava Receptionist is a premium feature — upgrade to enable it.');
    } else {
      Analytics.capture('ava_recept_save_failed', {'enabled': enabled});
      AvaLog.I.log('receptionist', 'settings save FAILED (enabled=$enabled)');
      _toast('Couldn’t save — check your connection and try again.');
    }
    return res.ok;
  }

  /// F1: coarse TTL bucket for telemetry, mirroring the server's buckets.
  String _ttlBucket(int? expiresAtMs) {
    if (expiresAtMs == null) return 'never';
    final d = expiresAtMs - DateTime.now().millisecondsSinceEpoch;
    if (d <= 16 * 60 * 1000) return '15m';
    if (d <= 31 * 60 * 1000) return '30m';
    if (d <= 61 * 60 * 1000) return '1h';
    if (d <= (4.1 * 3600 * 1000).round()) return '4h';
    return 'custom';
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
                // ── The note: tell Ava your availability ───────────────────
                ZineField(
                  controller: _note,
                  label: 'Let Ava know if you’re busy, away, etc.',
                  hint: 'e.g. I’m in meetings until 5pm — please take a message and I’ll call back.',
                  maxLength: kReceptionistNoteMax,
                  minLines: 3,
                  maxLines: null,
                  textCapitalization: TextCapitalization.sentences,
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 6),
                // Live character counter against the 500-char server cap.
                Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    '${_note.text.length}/$kReceptionistNoteMax',
                    style: ZineText.tag(
                      size: 11,
                      color: _note.text.length > kReceptionistNoteMax
                          ? Zine.coral
                          : Zine.inkMute,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Ava uses this to tell callers why you can’t pick up and to take a '
                  'message in your words. Your name and gender come from your Profile.',
                  style: ZineText.sub(size: 11),
                ),
                const SizedBox(height: 16),
                // ── Expiry chips ───────────────────────────────────────────
                Text('CLEAR THIS NOTE AFTER', style: ZineText.kicker()),
                const SizedBox(height: 9),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final o in _kExpiryOptions)
                    ZineChip(
                      label: o.label,
                      active: _isExpiryActive(o),
                      onTap: () => _onExpiryTap(o),
                    ),
                ]),
                if (_expiresAtMs != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Note clears at ${_formatExpiry(_expiresAtMs!)}',
                    style: ZineText.sub(size: 11.5),
                  ),
                ],
                const SizedBox(height: 16),
                // ── Answering language ─────────────────────────────────────
                Text('ANSWERING LANGUAGE', style: ZineText.kicker()),
                const SizedBox(height: 9),
                ZinePressable(
                  onTap: _pickLanguage,
                  color: Zine.card,
                  radius: BorderRadius.circular(Zine.rField),
                  boxShadow: Zine.shadowSm,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                  child: Row(children: [
                    Icon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                        size: 18, color: Zine.inkSoft),
                    const SizedBox(width: 10),
                    Expanded(child: Text(_langLabel(), style: ZineText.value(size: 13.5))),
                    Icon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                        size: 16, color: Zine.inkMute),
                  ]),
                ),
                const SizedBox(height: 6),
                Text(
                  'Ava opens in this language, then follows the caller if they speak '
                  'another.',
                  style: ZineText.sub(size: 11),
                ),
                const SizedBox(height: 16),
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

  // ── Expiry helpers ──────────────────────────────────────────────────────────

  /// Is this preset the currently-selected expiry?
  bool _isExpiryActive(_ExpiryOption o) {
    if (o.custom) return _customExpiry != null;
    if (o.ttl == null) return _expiresAtMs == null; // "No expiry"
    if (_expiresAtMs == null || _customExpiry != null) return false;
    final rem = _expiresAtMs! - DateTime.now().millisecondsSinceEpoch;
    return (rem - o.ttl!.inMilliseconds).abs() <= 90 * 1000;
  }

  Future<void> _onExpiryTap(_ExpiryOption o) async {
    if (o.custom) {
      await _pickCustomExpiry();
      return;
    }
    setState(() {
      _customExpiry = null;
      _expiresAtMs = o.ttl == null
          ? null
          : DateTime.now().add(o.ttl!).millisecondsSinceEpoch;
    });
  }

  Future<void> _pickCustomExpiry() async {
    final now = DateTime.now();
    final maxDate = now.add(const Duration(days: 365)); // server cap: ~1 year
    final initial = _customExpiry ?? now.add(const Duration(hours: 2));
    final date = await showDatePicker(
      context: context,
      initialDate: initial.isBefore(now) ? now : initial,
      firstDate: now,
      lastDate: maxDate,
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(initial),
    );
    if (!mounted) return;
    final t = time ?? TimeOfDay.fromDateTime(initial);
    var picked = DateTime(date.year, date.month, date.day, t.hour, t.minute);
    // Guard the bounds: must be in the future and within a year.
    if (picked.isBefore(now)) picked = now.add(const Duration(minutes: 1));
    if (picked.isAfter(maxDate)) picked = maxDate;
    setState(() {
      _customExpiry = picked;
      _expiresAtMs = picked.millisecondsSinceEpoch;
    });
  }

  /// Absolute local time an expiry resolves to, e.g. "Fri 3 Jul, 5:30 PM".
  String _formatExpiry(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
    const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final h24 = d.hour;
    final h12 = h24 % 12 == 0 ? 12 : h24 % 12;
    final ap = h24 < 12 ? 'AM' : 'PM';
    final mm = d.minute.toString().padLeft(2, '0');
    return '${wd[d.weekday - 1]} ${d.day} ${mo[d.month - 1]}, $h12:$mm $ap';
  }

  // ── Language helpers ────────────────────────────────────────────────────────

  /// Label shown on the picker button: native name, plus "(detected)" when the
  /// selection is the auto/GeoIP default.
  String _langLabel() {
    if (_langIsDetected) {
      final def = kReceptionistLangs.firstWhere(
        (l) => l.code == _langDefault,
        orElse: () => kReceptionistLangs.first,
      );
      return '${def.native} (detected)';
    }
    final sel = kReceptionistLangs.firstWhere(
      (l) => l.code == _answerLang,
      orElse: () => kReceptionistLangs.first,
    );
    return sel.native;
  }

  Future<void> _pickLanguage() async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Zine.paper2,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.rSm)),
      ),
      builder: (ctx) => _LangPickerSheet(
        selected: _langIsDetected ? '' : _answerLang,
        detectedCode: _langDefault,
      ),
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (picked.isEmpty) {
        // "Detected" chosen → auto-detect; server never pins the GeoIP guess.
        _langIsDetected = true;
        _answerLang = '';
      } else {
        _langIsDetected = false;
        _answerLang = picked;
      }
    });
  }
}

/// Searchable language picker (native names). Returns the chosen BCP-47 code, or
/// '' for the "(detected)" auto option. Null on dismiss = no change.
class _LangPickerSheet extends StatefulWidget {
  final String selected;     // '' = detected/auto
  final String detectedCode; // BCP-47 default to badge "(detected)"
  const _LangPickerSheet({required this.selected, required this.detectedCode});
  @override
  State<_LangPickerSheet> createState() => _LangPickerSheetState();
}

class _LangPickerSheetState extends State<_LangPickerSheet> {
  final _search = TextEditingController();
  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = _search.text.trim().toLowerCase();
    final matches = q.isEmpty
        ? kReceptionistLangs
        : kReceptionistLangs.where((l) =>
            l.native.toLowerCase().contains(q) ||
            l.english.toLowerCase().contains(q) ||
            l.code.toLowerCase().contains(q)).toList();
    final detected = kReceptionistLangs.firstWhere(
      (l) => l.code == widget.detectedCode,
      orElse: () => kReceptionistLangs.first,
    );
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.72,
          ),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const SizedBox(height: 10),
            Container(
              width: 40, height: 4,
              decoration: BoxDecoration(
                color: Zine.inkMute,
                borderRadius: BorderRadius.circular(100),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
              child: ZineField(
                controller: _search,
                hint: 'Search languages',
                leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                autofocus: false,
                onChanged: (_) => setState(() {}),
              ),
            ),
            Flexible(
              child: ListView(
                padding: const EdgeInsets.only(bottom: 12),
                children: [
                  // Detected / auto row first (only when not filtered out).
                  if (q.isEmpty || 'detected auto'.contains(q))
                    _langTile(
                      title: '${detected.native} (detected)',
                      subtitle: 'Auto — matches the caller’s region',
                      active: widget.selected.isEmpty,
                      onTap: () => Navigator.of(context).pop(''),
                    ),
                  for (final l in matches)
                    _langTile(
                      title: l.native,
                      subtitle: l.english,
                      active: widget.selected == l.code,
                      onTap: () => Navigator.of(context).pop(l.code),
                    ),
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _langTile({
    required String title,
    required String subtitle,
    required bool active,
    required VoidCallback onTap,
  }) {
    return ListTile(
      onTap: onTap,
      title: Text(title, style: ZineText.value(size: 14.5)),
      subtitle: Text(subtitle, style: ZineText.sub(size: 11.5)),
      trailing: active
          ? Icon(PhosphorIcons.check(PhosphorIconsStyle.bold),
              size: 18, color: Zine.blueInk)
          : null,
    );
  }
}
