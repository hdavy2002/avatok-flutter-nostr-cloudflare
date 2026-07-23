import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';
import '../../../core/moderation_service.dart';
import '../../../core/receptionist_api.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/voice/google_voice.dart';
import '../../wallet/wallet_balance_chip.dart' show WalletBalanceStore;
import '../../wallet/wallet_screen.dart';
import '../settings_registry.dart';
import 'receptionist_analytics_page.dart';

/// [RECEPT-SETTINGS-1] Client-side token gate (must agree with the backend
/// deduction agent). When the wallet's SPENDABLE token balance is AT OR BELOW
/// this floor, the receptionist can't be enabled: every toggle refuses to turn
/// ON and points the user to top up. The server enforces the same cutoff on
/// hand-off, so a stale client can never overspend past it.
const int kReceptTokenFloor = 2;

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

/// F2: greeting presets. id → label shown in the dropdown. The id MUST be one of
/// GREETING_PRESETS in worker/src/routes/receptionist.ts (an unknown id is coerced
/// to a plain open server-side). The label shows the phrase Ava opens with, e.g.
/// "Jai Shree Ram <caller>, <you> can't take the call…". 'custom' uses the free
/// text greeting field; 'none' opens plainly.
const Map<String, String> kReceptionistGreetingPresets = {
  'none': 'No greeting (plain)',
  'namaste': 'Namaste',
  'namaskar': 'Namaskar',
  'jai_shree_ram': 'Jai Shree Ram',
  'radhe_radhe': 'Radhe Radhe',
  'ram_ram': 'Ram Ram',
  'sat_sri_akal': 'Sat Sri Akal',
  'assalam': 'Assalam-o-Alaikum',
  'vanakkam': 'Vanakkam',
  'khamma_ghani': 'Khamma Ghani',
  'hello': 'Hello',
  'custom': 'Custom…',
};

/// F2: server cap on the custom greeting text (MAX_GREETING in receptionist.ts).
const int kReceptionistGreetingMax = 200;

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

/// Mirror of the server LANG_CODES (Gemini-Live-verified codes). Order roughly
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
  // Indian regional languages — MUST match the server LANG_CODES set.
  ReceptionistLang('mr-IN', 'मराठी', 'Marathi'),
  ReceptionistLang('gu-IN', 'ગુજરાતી', 'Gujarati'),
  ReceptionistLang('kn-IN', 'ಕನ್ನಡ', 'Kannada'),
  ReceptionistLang('ml-IN', 'മലയാളം', 'Malayalam'),
  ReceptionistLang('pa-IN', 'ਪੰਜਾਬੀ', 'Punjabi'),
  ReceptionistLang('ur-IN', 'اردو', 'Urdu'),
  ReceptionistLang('or-IN', 'ଓଡ଼ିଆ', 'Odia'),
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
      // [AVARECEPT-LANES-1] voicemail retired; single "AI receptionist" page with
      // per-lane + per-scenario toggles and the folded-in voice picker.
      title: 'AI receptionist',
      order: 24,
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
  // ALWAYS-ON (owner decision 2026-07-07): the receptionist can no longer be
  // turned off by the user — the mirror defaults true and stays true.
  static final ValueNotifier<bool> enabled = ValueNotifier<bool>(true);
  /// Local mirror of decline_to_ava (kept for the incoming-call handler in
  /// push_service). The simplified settings UI no longer exposes it, so it stays
  /// off, but the mirror is preserved so existing callers don't break.
  static final ValueNotifier<bool> declineToAva = ValueNotifier<bool>(false);

  static Future<bool> load() async {
    // ALWAYS-ON: ignore any stored '0' — Ava answers missed calls for everyone.
    const v = true;
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
  // F2: the custom greeting free-text (used only when the preset = 'custom').
  final _greeting = TextEditingController();
  bool _enabled = true; // ALWAYS-ON: kept only for the mirror/save payload
  bool _premium = false;
  bool _loading = true;
  bool _saving = false;

  // F2 — greeting: a preset id ('none' = plain open, 'custom' = _greeting text) and
  // the festival auto-greeting toggle.
  String _greetingStyle = 'none';
  bool _festivalGreeting = false;
  // [RECEPT-SETTINGS-1] (owner 2026-07-23) voicemail retired. The AI receptionist
  // is the only unanswered-call handler. TWO groups (PSTN + AvaTOK), each with
  // FOUR INDEPENDENT toggles — every toggle alone decides whether Ava answers in
  // that scenario for that lane. Defaults: not-picked-up + rejected ON (she
  // answers and takes a message); phone-off/unreachable + redirect-all OFF
  // (opt-in). Redirect-all means EVERY call on that lane goes straight to Ava.
  bool _pstnNotPickedUp = true;
  bool _pstnRejected = true;
  bool _pstnUnreachable = false;
  bool _pstnRedirectAll = false;
  bool _avatokNotPickedUp = true;
  bool _avatokRejected = true;
  bool _avatokUnreachable = false;
  bool _avatokRedirectAll = false;

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
    // [AVARECEPT-LANES-1] the "Ava voice" picker is folded into this page now.
    GoogleVoicePref.load().then((_) { if (mounted) setState(() {}); });
    AvaVoiceLangPref.load().then((_) { if (mounted) setState(() {}); });
    // [RECEPT-SETTINGS-1] token gate. Pull the spendable balance and rebuild
    // whenever it changes (top-up landing, wallet refresh) so the gate + banner
    // are always live without polling.
    WalletBalanceStore.spendable.addListener(_onBalance);
    WalletBalanceStore.load();
  }

  void _onBalance() { if (mounted) setState(() {}); }

  /// [RECEPT-SETTINGS-1] spendable tokens (paid + welcome bonus + daily free) —
  /// the DO snap()'s `spendable`, the same field the availability gate uses.
  /// null until the first balance lands; treated as 0 for the gate.
  int get _tokens => WalletBalanceStore.spendable.value ?? 0;
  bool get _tokensOk => _tokens > kReceptTokenFloor; // >2 == at least 3

  @override
  void dispose() {
    WalletBalanceStore.spendable.removeListener(_onBalance);
    _note.dispose();
    _greeting.dispose();
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
        // F2: greeting preset + festival toggle + custom greeting text.
        _greetingStyle = kReceptionistGreetingPresets.containsKey(s.greetingStyle)
            ? s.greetingStyle
            : 'none';
        _festivalGreeting = s.festivalGreeting;
        _greeting.text = s.greetingText;
        // [RECEPT-SETTINGS-1] two groups × four independent toggles (server
        // authoritative).
        _pstnNotPickedUp = s.receptPstnNotPickedUp;
        _pstnRejected = s.receptPstnRejected;
        _pstnUnreachable = s.receptPstnUnreachable;
        _pstnRedirectAll = s.receptPstnRedirectAll;
        _avatokNotPickedUp = s.receptAvatokNotPickedUp;
        _avatokRejected = s.receptAvatokRejected;
        _avatokUnreachable = s.receptAvatokUnreachable;
        _avatokRedirectAll = s.receptAvatokRedirectAll;
      }
      _loading = false;
    });
    if (s != null) await _writeMirror();
    await ReceptionistPref.load();
    // Refresh the spendable balance whenever the settings page opens so the gate
    // reflects a recent top-up done elsewhere.
    await WalletBalanceStore.load(force: true);
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
    // F2: greeting preset + festival toggle + custom greeting text.
    final gs = (m['greeting_style'] ?? 'none').toString();
    _greetingStyle = kReceptionistGreetingPresets.containsKey(gs) ? gs : 'none';
    _festivalGreeting = m['festival_greeting'] == true;
    _greeting.text = (m['greeting_text'] ?? '').toString();
    // [RECEPT-SETTINGS-1] two groups × four independent toggles. ON-by-default
    // toggles use `!= false` so a mirror written before this field existed still
    // reads the sensible default; OFF-by-default read plainly.
    _pstnNotPickedUp = m['pstn_not_picked_up'] != false;
    _pstnRejected = m['pstn_rejected'] != false;
    _pstnUnreachable = m['pstn_unreachable'] == true;
    _pstnRedirectAll = m['pstn_redirect_all'] == true;
    _avatokNotPickedUp = m['avatok_not_picked_up'] != false;
    _avatokRejected = m['avatok_rejected'] != false;
    _avatokUnreachable = m['avatok_unreachable'] == true;
    _avatokRedirectAll = m['avatok_redirect_all'] == true;
  }

  Future<void> _writeMirror() async {
    try {
      await DiskCache.write(_mirrorKey, jsonEncode({
        'enabled': _enabled, 'note': _note.text, 'premium': _premium,
        'expires_at': _expiresAtMs,
        'answer_lang': _answerLang,
        'lang_default': _langDefault,
        'greeting_style': _greetingStyle,
        'festival_greeting': _festivalGreeting,
        'greeting_text': _greeting.text,
        'pstn_not_picked_up': _pstnNotPickedUp,
        'pstn_rejected': _pstnRejected,
        'pstn_unreachable': _pstnUnreachable,
        'pstn_redirect_all': _pstnRedirectAll,
        'avatok_not_picked_up': _avatokNotPickedUp,
        'avatok_rejected': _avatokRejected,
        'avatok_unreachable': _avatokUnreachable,
        'avatok_redirect_all': _avatokRedirectAll,
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
    // F2: the custom greeting text is only meaningful when the preset is 'custom'.
    final greetingText = _greetingStyle == 'custom' ? _greeting.text.trim() : '';
    final res = await ReceptionistApi.saveSettings(
      enabled: enabled,
      instructions: note, // the single availability note (also mirrored to status_note)
      displayName: '',    // name now comes from the Profile
      personaName: '',
      languageCode: '',
      // F2: the greeting free text (custom preset). Empty for non-custom presets.
      greetingText: greetingText,
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
      // F2 — greeting preset + festival auto-greeting toggle.
      greetingStyle: _greetingStyle,
      festivalGreeting: _festivalGreeting,
      // [AVARECEPT-LANES-1] voicemail retired — pin mode to '' (server default =
      // live agent) so any legacy per-owner mode='vm' is cleared on the next save.
      mode: '',
      // [RECEPT-SETTINGS-1] two groups × four independent toggles. Always sent so
      // the server's stored state is explicit and the token-gated deduction agent
      // reads exact values. When the wallet is at/below the token floor we force
      // every toggle OFF on save so a stale ON can't authorise a hand-off the
      // user can't pay for (the server enforces the same floor as a backstop).
      receptPstnNotPickedUp: _tokensOk && _pstnNotPickedUp,
      receptPstnRejected: _tokensOk && _pstnRejected,
      receptPstnUnreachable: _tokensOk && _pstnUnreachable,
      receptPstnRedirectAll: _tokensOk && _pstnRedirectAll,
      receptAvatokNotPickedUp: _tokensOk && _avatokNotPickedUp,
      receptAvatokRejected: _tokensOk && _avatokRejected,
      receptAvatokUnreachable: _tokensOk && _avatokUnreachable,
      receptAvatokRedirectAll: _tokensOk && _avatokRedirectAll,
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
      // F2 telemetry — mirror the server's receptionist_greeting_saved event.
      Analytics.capture('receptionist_greeting_saved', {
        'style': _greetingStyle,
        'festival': _festivalGreeting,
        'answer_lang': answerLang.isEmpty ? 'auto' : answerLang,
      });
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

  // ── [RECEPT-ONBOARD-1] onboarding flows (plan §B) ─────────────────────────
  // Both flows persist through THIS state's _save (which owns the full settings
  // payload — the PUT overwrites every column, so a minimal save from the wizard
  // would wipe the note/greeting/language). State is set optimistically before
  // the save and rolled back if it fails, so a failed save never leaves the
  // toggle lying about what the server has.

  @override
  Widget build(BuildContext context) {
    return AdCard(
      padding: const EdgeInsets.all(14),
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
                    color: AD.iconVideo,
                    size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('AI receptionist', style: ADText.rowName()),
                    const SizedBox(height: 2),
                    Text(
                      'When you don’t take a call, Ava answers for you as a live '
                      'AI voice agent. Choose which calls she handles and when.',
                      style: ADText.preview(),
                    ),
                  ]),
                ),
                // ALWAYS-ON (owner decision 2026-07-07): the on/off toggle is gone —
                // Ava Receptionist can no longer be disabled per user.
              ]),
              ...[
                const SizedBox(height: 16),
                // ── [RECEPT-SETTINGS-1] token gate banner ──────────────────
                // Ava talks to callers on your tokens (3 tokens/min, capped at 3
                // minutes). At or below the floor she can't answer — the toggles
                // below are disabled and this banner points to a top-up.
                if (!_tokensOk) ...[
                  _TokenGateBanner(
                    tokens: _tokens,
                    onTopUp: () async {
                      Analytics.uiInteraction('recept_topup_cta', 0,
                          extra: {'tokens': _tokens, 'source': 'gate_banner'});
                      await Navigator.of(context).push(MaterialPageRoute<void>(
                          builder: (_) => const WalletScreen()));
                      if (mounted) await WalletBalanceStore.load(force: true);
                    },
                  ),
                  const SizedBox(height: 16),
                ],
                // ── [RECEPT-SETTINGS-1] Group 1 — Cell (PSTN) calls ─────────
                // Four INDEPENDENT toggles. Each alone decides whether Ava
                // answers that scenario for cell calls.
                Text('CELL (PSTN) CALLS', style: ADText.sectionLabel()),
                const SizedBox(height: 6),
                _receptToggle(
                  'Call not picked up',
                  'You didn’t answer before it stopped ringing.',
                  _pstnNotPickedUp,
                  'pstn_not_picked_up',
                  (v) => _pstnNotPickedUp = v,
                ),
                const SizedBox(height: 8),
                _receptToggle(
                  'Call rejected',
                  'You tapped Decline.',
                  _pstnRejected,
                  'pstn_rejected',
                  (v) => _pstnRejected = v,
                ),
                const SizedBox(height: 8),
                _receptToggle(
                  'Phone offline / unreachable',
                  'Your phone is off or has no connection.',
                  _pstnUnreachable,
                  'pstn_unreachable',
                  (v) => _pstnUnreachable = v,
                ),
                const SizedBox(height: 8),
                _receptToggle(
                  'Redirect ALL calls to Ava',
                  'Every cell call goes straight to Ava — she always answers first.',
                  _pstnRedirectAll,
                  'pstn_redirect_all',
                  (v) => _pstnRedirectAll = v,
                ),
                const SizedBox(height: 16),
                // ── [RECEPT-SETTINGS-1] Group 2 — AvaTOK-to-AvaTOK calls ────
                Text('AVATOK CALLS', style: ADText.sectionLabel()),
                const SizedBox(height: 6),
                _receptToggle(
                  'Call not picked up',
                  'You didn’t answer before it stopped ringing.',
                  _avatokNotPickedUp,
                  'avatok_not_picked_up',
                  (v) => _avatokNotPickedUp = v,
                ),
                const SizedBox(height: 8),
                _receptToggle(
                  'Call rejected',
                  'You tapped Decline.',
                  _avatokRejected,
                  'avatok_rejected',
                  (v) => _avatokRejected = v,
                ),
                const SizedBox(height: 8),
                _receptToggle(
                  'Phone offline / unreachable',
                  'Your phone is off or has no connection.',
                  _avatokUnreachable,
                  'avatok_unreachable',
                  (v) => _avatokUnreachable = v,
                ),
                const SizedBox(height: 8),
                _receptToggle(
                  'Redirect ALL calls to Ava',
                  'Every AvaTOK call goes straight to Ava — she always answers first.',
                  _avatokRedirectAll,
                  'avatok_redirect_all',
                  (v) => _avatokRedirectAll = v,
                ),
                const SizedBox(height: 6),
                Text(
                  'Each toggle works on its own. If nothing here is on, an '
                  'unanswered call is simply a missed call. Ava costs 3 tokens '
                  'per minute, capped at 3 minutes.',
                  style: ADText.preview(),
                ),
                const SizedBox(height: 14),
                // ── The note: tell Ava your availability ───────────────────
                AdField(
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
                    style: ADText.statCaption(
                      c: _note.text.length > kReceptionistNoteMax
                          ? AD.danger
                          : AD.textTertiary,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Ava uses this to tell callers why you can’t pick up and to take a '
                  'message in your words. Your name and gender come from your Profile.',
                  style: ADText.preview(),
                ),
                const SizedBox(height: 16),
                // ── Expiry chips ───────────────────────────────────────────
                Text('CLEAR THIS NOTE AFTER', style: ADText.sectionLabel()),
                const SizedBox(height: 9),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final o in _kExpiryOptions)
                    AdChip(
                      label: o.label,
                      active: _isExpiryActive(o),
                      onTap: () => _onExpiryTap(o),
                    ),
                ]),
                if (_expiresAtMs != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Note clears at ${_formatExpiry(_expiresAtMs!)}',
                    style: ADText.preview(),
                  ),
                ],
                const SizedBox(height: 16),
                // ── Greeting ───────────────────────────────────────────────
                Text('GREETING', style: ADText.sectionLabel()),
                const SizedBox(height: 9),
                _greetingDropdown(),
                if (_greetingStyle == 'custom') ...[
                  const SizedBox(height: 10),
                  AdField(
                    controller: _greeting,
                    label: 'Your greeting',
                    hint: 'e.g. Jai Shree Ram',
                    maxLength: kReceptionistGreetingMax,
                    textCapitalization: TextCapitalization.sentences,
                    onChanged: (_) => setState(() {}),
                  ),
                ],
                const SizedBox(height: 6),
                Text(
                  'Ava opens with this, then the caller’s name — e.g. '
                  '“${_greetingPreview()} Anita, you can’t take the call right now…”.',
                  style: ADText.preview(),
                ),
                const SizedBox(height: 12),
                _toggleRow(
                  'Festival greetings',
                  'On festival days (Diwali, Holi, Eid, Christmas, New Year) Ava '
                      'greets with the festival instead — e.g. “Happy Diwali”.',
                  _festivalGreeting,
                  (v) => setState(() => _festivalGreeting = v),
                ),
                const SizedBox(height: 16),
                // ── Answering language ─────────────────────────────────────
                Text('ANSWERING LANGUAGE', style: ADText.sectionLabel()),
                const SizedBox(height: 9),
                ZinePressable(
                  onTap: _pickLanguage,
                  color: AD.card,
                  borderColor: AD.borderControl,
                  radius: BorderRadius.circular(AD.rInput),
                  boxShadow: const [],
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                  child: Row(children: [
                    Icon(PhosphorIcons.translate(PhosphorIconsStyle.bold),
                        size: 18, color: AD.textSecondary),
                    const SizedBox(width: 10),
                    Expanded(child: Text(_langLabel(), style: ADText.rowName())),
                    Icon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                        size: 16, color: AD.textTertiary),
                  ]),
                ),
                const SizedBox(height: 6),
                Text(
                  'Ava opens in this language, then follows the caller if they speak '
                  'another.',
                  style: ADText.preview(),
                ),
                const SizedBox(height: 18),
                const Divider(height: 1, color: AD.borderHairline),
                const SizedBox(height: 16),
                // ── [AVARECEPT-LANES-1] Ava's voice (folded in from the old
                // standalone "Ava voice" page). The voice + call language a
                // hands-free Ava call speaks with; saved instantly via the prefs.
                _voiceSection(),
                const SizedBox(height: 16),
                AdButton(
                  label: _saving ? 'Saving…' : 'Save',
                  fullWidth: true,
                  fontSize: 15,
                  loading: _saving,
                  onPressed: _saving ? null : () => _save(enabled: true),
                ),
                const SizedBox(height: 10),
                // ── [RECEPT-STATS-1] Call analytics entry (plan §C3) ───────
                ZinePressable(
                  onTap: () {
                    Analytics.capture('recept_analytics_entry_tapped', {});
                    Navigator.of(context).push(MaterialPageRoute(
                        builder: (_) => const ReceptionistAnalyticsPage()));
                  },
                  color: AD.card,
                  borderColor: AD.borderControl,
                  radius: BorderRadius.circular(AD.rInput),
                  boxShadow: const [],
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                  child: Row(children: [
                    Icon(PhosphorIcons.chartBar(PhosphorIconsStyle.bold),
                        size: 18, color: AD.textSecondary),
                    const SizedBox(width: 10),
                    Expanded(
                        child:
                            Text('View call analytics', style: ADText.rowName())),
                    Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                        size: 16, color: AD.textTertiary),
                  ]),
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

  // ── Greeting helpers ────────────────────────────────────────────────────────

  /// The greeting phrase to preview (the preset phrase, or the custom text). Used
  /// only for the example sentence under the dropdown.
  String _greetingPreview() {
    if (_greetingStyle == 'none' || _greetingStyle.isEmpty) return 'Hey';
    if (_greetingStyle == 'custom') {
      final t = _greeting.text.trim();
      return t.isEmpty ? 'Hey' : t;
    }
    // The preset label doubles as the phrase for the built-in ones; strip any
    // parenthetical annotation ("Custom…" isn't reachable here).
    return kReceptionistGreetingPresets[_greetingStyle] ?? 'Hey';
  }

  Widget _greetingDropdown() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: AD.card,
        border: Border.all(color: AD.borderControl, width: 1),
        borderRadius: BorderRadius.circular(AD.rInput),
      ),
      child: DropdownButton<String>(
        value: _greetingStyle,
        isExpanded: true,
        underline: const SizedBox.shrink(),
        dropdownColor: AD.menu,
        iconEnabledColor: AD.textSecondary,
        items: [
          for (final e in kReceptionistGreetingPresets.entries)
            DropdownMenuItem(value: e.key, child: Text(e.value, style: ADText.rowName())),
        ],
        onChanged: (v) { if (v != null) setState(() => _greetingStyle = v); },
      ),
    );
  }

  /// [RECEPT-SETTINGS-1] A receptionist scenario toggle with the client-side
  /// token gate baked in. [apply] mutates the backing field; [key] tags
  /// telemetry + the top-up path. When the wallet is at/below [kReceptTokenFloor]
  /// the row shows OFF and refuses to turn ON — tapping routes to a top-up
  /// instead of silently enabling a feature the user can't pay for.
  Widget _receptToggle(
    String title,
    String sub,
    bool value,
    String key,
    void Function(bool) apply,
  ) {
    final gated = !_tokensOk;
    return _toggleRow(
      title,
      sub,
      gated ? false : value, // never show ON while gated
      (v) {
        if (gated) {
          // Refuse to enable; point the user at their wallet.
          Analytics.uiInteraction('recept_toggle_blocked', 0,
              extra: {'toggle': key, 'tokens': _tokens, 'want': v});
          AvaLog.I.log('receptionist',
              'toggle $key blocked (tokens=$_tokens <= $kReceptTokenFloor)');
          _showTopUp();
          return;
        }
        setState(() => apply(v));
        Analytics.uiInteraction('recept_toggle', 0,
            extra: {'toggle': key, 'value': v, 'tokens': _tokens});
      },
    );
  }

  /// [RECEPT-SETTINGS-1] Told the user their wallet is too low to use Ava
  /// Receptionist, with a one-tap route to top up.
  void _showTopUp() {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: const Text(
          'Top up your wallet to use Ava Receptionist — she needs tokens to '
          'answer your calls.'),
      action: SnackBarAction(
        label: 'Top up',
        onPressed: () async {
          Analytics.uiInteraction('recept_topup_cta', 0,
              extra: {'tokens': _tokens, 'source': 'toggle_snackbar'});
          await Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => const WalletScreen()));
          if (mounted) await WalletBalanceStore.load(force: true);
        },
      ),
    ));
  }

  Widget _toggleRow(String title, String sub, bool value, ValueChanged<bool> onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(sub, style: ADText.preview()),
          ]),
        ),
        const SizedBox(width: 8),
        _AdToggle(value: value, onChanged: onChanged),
      ]),
    );
  }

  // ── [AVARECEPT-LANES-1] Ava's voice (folded in from the old "Ava voice" page) ──
  // The voice + call-language Ava speaks with on a hands-free call. Choices are
  // persisted instantly via GoogleVoicePref / AvaVoiceLangPref (not the receptionist
  // PUT), mirroring the standalone section this replaces.
  Widget _voiceSection() {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text("AVA'S VOICE", style: ADText.sectionLabel()),
      const SizedBox(height: 4),
      Text('The voice Ava speaks with on a hands-free call.',
          style: ADText.preview()),
      const SizedBox(height: 10),
      ValueListenableBuilder<String>(
        valueListenable: GoogleVoicePref.voice,
        builder: (context, current, _) {
          final sel = GoogleVoiceCatalog.byName(current);
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (sel != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  'Selected: ${sel.name} · ${sel.style} '
                  '(${sel.female ? "female" : "male"})',
                  style: ADText.preview(c: AD.iconSearch),
                ),
              ),
            Text('FEMALE', style: ADText.sectionLabel()),
            const SizedBox(height: 8),
            _voiceWrap(GoogleVoiceCatalog.female, current),
            const SizedBox(height: 16),
            Text('MALE', style: ADText.sectionLabel()),
            const SizedBox(height: 8),
            _voiceWrap(GoogleVoiceCatalog.male, current),
          ]);
        },
      ),
      const SizedBox(height: 16),
      Text('CALL LANGUAGE', style: ADText.sectionLabel()),
      const SizedBox(height: 4),
      Text('The language Ava speaks on a call. Auto follows whatever you speak.',
          style: ADText.preview()),
      const SizedBox(height: 10),
      ValueListenableBuilder<String>(
        valueListenable: AvaVoiceLangPref.lang,
        builder: (context, code, _) => Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final l in AvaLangCatalog.all)
              AdChip(
                label: l.label,
                active: l.code == code,
                onTap: () => AvaVoiceLangPref.set(l.code),
              ),
          ],
        ),
      ),
    ]);
  }

  Widget _voiceWrap(List<GoogleVoice> voices, String current) => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final v in voices)
            AdChip(
              label: v.name,
              active: v.name == current,
              onTap: () => GoogleVoicePref.set(v.name),
            ),
        ],
      );

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
      backgroundColor: AD.overlaySheet,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
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
                color: AD.borderControl,
                borderRadius: BorderRadius.circular(100),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
              child: AdField(
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
      title: Text(title, style: ADText.rowName()),
      subtitle: Text(subtitle, style: ADText.preview()),
      trailing: active
          ? Icon(PhosphorIcons.check(PhosphorIconsStyle.bold),
              size: 18, color: AD.iconSearch)
          : null,
    );
  }
}

/// [RECEPT-SETTINGS-1] Low-balance banner shown above the receptionist toggles
/// when the wallet is at/below [kReceptTokenFloor]. Explains why Ava can't
/// answer and offers a one-tap top-up.
class _TokenGateBanner extends StatelessWidget {
  final int tokens;
  final VoidCallback onTopUp;
  const _TokenGateBanner({required this.tokens, required this.onTopUp});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rInput),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(PhosphorIcons.wallet(PhosphorIconsStyle.fill),
              size: 18, color: AD.missedCall),
          const SizedBox(width: 8),
          Expanded(
            child: Text('Not enough tokens for Ava Receptionist',
                style: ADText.rowName()),
          ),
        ]),
        const SizedBox(height: 6),
        Text(
          'You have $tokens token${tokens == 1 ? '' : 's'}. Ava talks to callers '
          'on your tokens (3/min), so she can’t answer until you top up. Turning '
          'a toggle on below is disabled until then.',
          style: ADText.preview(),
        ),
        const SizedBox(height: 12),
        AdButton(
          label: 'Top up your wallet',
          variant: AdButtonVariant.teal,
          fullWidth: true,
          fontSize: 14,
          onPressed: onTopUp,
        ),
      ]),
    );
  }
}

/// Dark v2 inline toggle — track [AD.card] off / [AD.online] on, white thumb.
class _AdToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _AdToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 22, height: 22,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
          ),
        ),
      ),
    );
  }
}
