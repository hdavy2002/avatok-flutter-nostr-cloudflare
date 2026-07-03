// Marketplace Agent settings (AI Messenger Batch — STREAM A, MKT-LANG-2).
//
// A full-screen editor for the user's negotiation-agent preferences, opened from
// a "Marketplace Agent" tile in Settings (registered below via
// SettingsSectionRegistry — NEVER by editing settings_screen.dart). Fields:
//   • Agent name (text, default "<first name>'s Agent", max 30)
//   • Default language (BCP-47 allowlist, default en)
//   • Voice (the canonical 30-voice Gemini picker — GoogleVoiceCatalog)
//   • Tone (Friendly / Professional / Brief)
//   • Negotiation guardrails: price-floor toggle + "never below X%" slider
//     (50-100, default 80), "Ask me before committing" toggle (default OFF)
//   • Auto-respond toggle + quiet hours (two time pickers)
//   • Digest (Every exchange / Summary only, default Summary)
//
// Persisted SERVER-SIDE via MarketplaceApi.getAgentSettings / putAgentSettings,
// and MIRRORED to a per-account local cache (DiskCache is already scoped by
// AccountScope.id) so the screen paints instantly offline. The whole surface is
// hidden when RemoteConfig.marketplaceAgentSettingsEnabled is false.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/disk_cache.dart';
import '../../core/marketplace_api.dart';
import '../../core/profile_store.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/voice/google_voice.dart';
import 'settings_registry.dart';

/// Default-language allowlist (BCP-47 short codes) — MUST match AGENT_LANGS in
/// worker/src/routes/agent_settings.ts. `label` is the English language name.
class MktAgentLang {
  final String code;
  final String label;
  const MktAgentLang(this.code, this.label);
}

const List<MktAgentLang> kMktAgentLangs = [
  MktAgentLang('en', 'English'),
  MktAgentLang('es', 'Spanish'),
  MktAgentLang('hi', 'Hindi'),
  MktAgentLang('fr', 'French'),
  MktAgentLang('de', 'German'),
  MktAgentLang('pt', 'Portuguese'),
  MktAgentLang('ar', 'Arabic'),
  MktAgentLang('zh', 'Chinese'),
  MktAgentLang('ja', 'Japanese'),
  MktAgentLang('ru', 'Russian'),
  MktAgentLang('id', 'Indonesian'),
  MktAgentLang('ur', 'Urdu'),
  MktAgentLang('bn', 'Bengali'),
  MktAgentLang('sw', 'Swahili'),
  MktAgentLang('tr', 'Turkish'),
  MktAgentLang('vi', 'Vietnamese'),
  // Indian regional languages — MUST match AGENT_LANGS in agent_settings.ts.
  MktAgentLang('gu', 'Gujarati (ગુજરાતી)'),
  MktAgentLang('mr', 'Marathi (मराठी)'),
  MktAgentLang('ta', 'Tamil (தமிழ்)'),
  MktAgentLang('te', 'Telugu (తెలుగు)'),
  MktAgentLang('kn', 'Kannada (ಕನ್ನಡ)'),
  MktAgentLang('ml', 'Malayalam (മലയാളം)'),
  MktAgentLang('pa', 'Punjabi (ਪੰਜਾਬੀ)'),
  MktAgentLang('or', 'Odia (ଓଡ଼ିଆ)'),
  MktAgentLang('as', 'Assamese (অসমীয়া)'),
];

/// Register the "Marketplace Agent" settings tile. Hidden when the feature flag
/// is off (the builder returns an empty box so the section vanishes). Registered
/// via [SettingsSectionRegistry] from AvaBootstrap.init.
void registerMarketplaceAgentSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'marketplace_agent',
      title: 'Marketplace Agent',
      order: 32, // near the other Ava/marketplace sections
      builder: (context) => const _MarketplaceAgentTile(),
    ),
  );
}

class _MarketplaceAgentTile extends StatelessWidget {
  const _MarketplaceAgentTile();

  @override
  Widget build(BuildContext context) {
    // Client-side hide when the kill switch is off.
    return ValueListenableBuilder<int>(
      valueListenable: RemoteConfig.revision,
      builder: (context, _, __) {
        if (!RemoteConfig.marketplaceAgentSettingsEnabled) {
          return const SizedBox.shrink();
        }
        return ZineCard(
          radius: Zine.rSm,
          padding: const EdgeInsets.all(4),
          boxShadow: Zine.shadowXs,
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const MarketplaceAgentSettingsPage()),
          ),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(children: [
              ZineIconBadge(
                icon: PhosphorIcons.storefront(PhosphorIconsStyle.fill),
                color: Zine.coral,
                size: 36,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Marketplace Agent', style: ZineText.value(size: 14.5)),
                  const SizedBox(height: 2),
                  Text(
                    'Language, voice, tone and negotiation limits your buying/selling '
                    'agent uses on your behalf.',
                    style: ZineText.sub(size: 12),
                  ),
                ]),
              ),
              const SizedBox(width: 8),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 18, color: Zine.inkSoft),
            ]),
          ),
        );
      },
    );
  }
}

/// Per-account local mirror of the agent settings (server is authoritative).
/// DiskCache is already namespaced by AccountScope.id, so this is safe on a
/// shared phone (parent + child accounts never see each other's settings).
class MarketplaceAgentPrefs {
  MarketplaceAgentPrefs._();
  static const _kKey = 'mkt_agent_settings';

  static Future<Map<String, dynamic>> loadLocal() async {
    try {
      final raw = await DiskCache.read(_kKey);
      if (raw == null || raw.isEmpty) return const {};
      final j = jsonDecode(raw);
      return j is Map<String, dynamic> ? j : const {};
    } catch (_) {
      return const {};
    }
  }

  static Future<void> saveLocal(Map<String, dynamic> m) async {
    try {
      await DiskCache.write(_kKey, jsonEncode(m));
    } catch (_) {/* best-effort */}
  }
}

class MarketplaceAgentSettingsPage extends StatefulWidget {
  const MarketplaceAgentSettingsPage({super.key});
  @override
  State<MarketplaceAgentSettingsPage> createState() => _MarketplaceAgentSettingsPageState();
}

class _MarketplaceAgentSettingsPageState extends State<MarketplaceAgentSettingsPage> {
  final _name = TextEditingController();

  String _lang = 'en';
  String _voice = GoogleVoiceCatalog.defaultVoice;
  String _tone = 'friendly';
  bool _floorOn = true;
  int _floorPct = 80;
  bool _askBeforeCommit = false;
  bool _autoRespond = true;
  TimeOfDay? _quietStart;
  TimeOfDay? _quietEnd;
  String _digest = 'summary';

  bool _loading = true;
  bool _saving = false;
  String _defaultName = 'My Agent';

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

  Future<void> _load() async {
    // Default name from the profile first name.
    try {
      final p = await ProfileStore().load();
      final first = p.nameParts.isNotEmpty ? p.nameParts.first : '';
      if (first.isNotEmpty) _defaultName = "$first's Agent";
    } catch (_) {}

    // Local mirror first (instant paint), then server (authoritative).
    final local = await MarketplaceAgentPrefs.loadLocal();
    _applyMap(local);
    final server = await MarketplaceApi.getAgentSettings();
    if (server != null) {
      _applyMap(server);
      await MarketplaceAgentPrefs.saveLocal(server);
    }
    if (!mounted) return;
    if (_name.text.trim().isEmpty) _name.text = _defaultName;
    setState(() => _loading = false);
  }

  TimeOfDay? _parseTod(dynamic v) {
    final s = (v ?? '').toString();
    final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(s);
    if (m == null) return null;
    return TimeOfDay(hour: int.parse(m.group(1)!), minute: int.parse(m.group(2)!));
  }

  String? _fmtTod(TimeOfDay? t) =>
      t == null ? null : '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  void _applyMap(Map<String, dynamic> m) {
    if (m.isEmpty) return;
    final name = (m['agent_name'] ?? '').toString();
    if (name.isNotEmpty) _name.text = name;
    final lang = (m['lang'] ?? 'en').toString();
    if (kMktAgentLangs.any((l) => l.code == lang)) _lang = lang;
    final voice = (m['voice'] ?? '').toString();
    if (voice.isNotEmpty && GoogleVoiceCatalog.isValid(voice)) _voice = voice;
    final tone = (m['tone'] ?? 'friendly').toString();
    if (const {'friendly', 'professional', 'brief'}.contains(tone)) _tone = tone;
    final fp = int.tryParse('${m['floor_pct']}');
    if (fp != null) { _floorPct = fp.clamp(50, 100); _floorOn = true; }
    _askBeforeCommit = m['ask_before_commit'] == true || m['ask_before_commit'] == 1;
    _autoRespond = !(m['auto_respond'] == false || m['auto_respond'] == 0);
    _quietStart = _parseTod(m['quiet_start']);
    _quietEnd = _parseTod(m['quiet_end']);
    final digest = (m['digest'] ?? 'summary').toString();
    if (const {'every', 'summary'}.contains(digest)) _digest = digest;
  }

  Map<String, dynamic> _toMap() => {
        'agent_name': _name.text.trim(),
        'lang': _lang,
        'voice': _voice,
        'tone': _tone,
        // The floor toggle: off → send 50 (the minimum, effectively "no extra floor").
        'floor_pct': _floorOn ? _floorPct : 50,
        'ask_before_commit': _askBeforeCommit,
        'auto_respond': _autoRespond,
        'quiet_start': _fmtTod(_quietStart),
        'quiet_end': _fmtTod(_quietEnd),
        'digest': _digest,
      };

  Future<void> _save() async {
    setState(() => _saving = true);
    final body = _toMap();
    final saved = await MarketplaceApi.putAgentSettings(body);
    // Mirror locally regardless (server-normalised map when available).
    await MarketplaceAgentPrefs.saveLocal(saved ?? body);
    // Telemetry mirror (the server also emits mkt_agent_settings_saved with email).
    Analytics.capture('mkt_agent_settings_saved_client', {
      'lang': _lang,
      'tone': _tone,
      'floor_pct': _floorOn ? _floorPct : 50,
      'ask_before_commit': _askBeforeCommit,
      'ok': saved != null,
    });
    if (!mounted) return;
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(saved != null ? 'Marketplace Agent saved' : 'Could not reach the server — saved on this device')),
    );
  }

  Future<void> _pickTime(bool start) async {
    final init = (start ? _quietStart : _quietEnd) ?? const TimeOfDay(hour: 22, minute: 0);
    final t = await showTimePicker(context: context, initialTime: init);
    if (t == null) return;
    setState(() { if (start) { _quietStart = t; } else { _quietEnd = t; } });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper,
        elevation: 0,
        leading: const ZineBackButton(),
        title: Text('Marketplace Agent', style: ZineText.appbar()),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                // ── Agent name ──
                _label('Agent name'),
                ZineField(
                  controller: _name,
                  hint: _defaultName,
                  maxLength: 30,
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 16),

                // ── Default language ──
                _label('Default language'),
                _langDropdown(),
                const SizedBox(height: 16),

                // ── Voice ──
                _label('Voice'),
                _voiceDropdown(),
                const SizedBox(height: 16),

                // ── Tone ──
                _label('Tone'),
                _segmented(
                  const {'friendly': 'Friendly', 'professional': 'Professional', 'brief': 'Brief'},
                  _tone,
                  (v) => setState(() => _tone = v),
                ),
                const SizedBox(height: 20),

                // ── Negotiation guardrails ──
                _sectionKicker('Negotiation guardrails'),
                _toggleRow(
                  'Price floor',
                  'Never sell below a share of your asking price.',
                  _floorOn,
                  (v) => setState(() => _floorOn = v),
                ),
                if (_floorOn) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Row(children: [
                      Expanded(
                        child: Slider(
                          value: _floorPct.toDouble(),
                          min: 50, max: 100, divisions: 50,
                          label: '$_floorPct%',
                          activeColor: Zine.coral,
                          onChanged: (v) => setState(() => _floorPct = v.round()),
                        ),
                      ),
                      SizedBox(
                        width: 56,
                        child: Text('Never below $_floorPct%', style: ZineText.sub(size: 12)),
                      ),
                    ]),
                  ),
                ],
                _toggleRow(
                  'Ask me before committing',
                  'Hold any agreed deal for your approval before it becomes binding.',
                  _askBeforeCommit,
                  (v) => setState(() => _askBeforeCommit = v),
                ),
                const SizedBox(height: 20),

                // ── Auto-respond + quiet hours ──
                _sectionKicker('Availability'),
                _toggleRow(
                  'Auto-respond',
                  'Let your agent reply to buyers/sellers automatically.',
                  _autoRespond,
                  (v) => setState(() => _autoRespond = v),
                ),
                _label('Quiet hours'),
                Row(children: [
                  Expanded(child: _timeBtn('Start', _quietStart, () => _pickTime(true))),
                  const SizedBox(width: 10),
                  Expanded(child: _timeBtn('End', _quietEnd, () => _pickTime(false))),
                ]),
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    'During quiet hours your agent defers new negotiations until they end.',
                    style: ZineText.sub(size: 12),
                  ),
                ),
                const SizedBox(height: 20),

                // ── Digest ──
                _sectionKicker('Updates'),
                _label('Digest'),
                _segmented(
                  const {'every': 'Every exchange', 'summary': 'Summary only'},
                  _digest,
                  (v) => setState(() => _digest = v),
                ),
                const SizedBox(height: 28),

                ZineButton(
                  label: 'Save',
                  fullWidth: true,
                  loading: _saving,
                  variant: ZineButtonVariant.coral,
                  onPressed: _saving ? null : _save,
                ),
              ],
            ),
    );
  }

  Widget _label(String s) => Padding(
        padding: const EdgeInsets.only(bottom: 6, top: 2),
        child: Text(s, style: ZineText.value(size: 13.5)),
      );

  Widget _sectionKicker(String s) => Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 4),
        child: Text(s.toUpperCase(), style: ZineText.kicker()),
      );

  Widget _langDropdown() {
    return _dropdownShell(
      DropdownButton<String>(
        value: _lang,
        isExpanded: true,
        underline: const SizedBox.shrink(),
        items: [
          for (final l in kMktAgentLangs)
            DropdownMenuItem(value: l.code, child: Text('${l.label}  (${l.code})', style: ZineText.value(size: 15))),
        ],
        onChanged: (v) { if (v != null) setState(() => _lang = v); },
      ),
    );
  }

  Widget _voiceDropdown() {
    final all = [...GoogleVoiceCatalog.female, ...GoogleVoiceCatalog.male];
    return _dropdownShell(
      DropdownButton<String>(
        value: GoogleVoiceCatalog.isValid(_voice) ? _voice : GoogleVoiceCatalog.defaultVoice,
        isExpanded: true,
        underline: const SizedBox.shrink(),
        items: [
          for (final v in all)
            DropdownMenuItem(
              value: v.name,
              child: Text(
                '${v.name} — ${v.female ? 'female' : 'male'}${v.style.isNotEmpty ? ' · ${v.style.toLowerCase()}' : ''}',
                style: ZineText.value(size: 15),
              ),
            ),
        ],
        onChanged: (v) { if (v != null) setState(() => _voice = v); },
      ),
    );
  }

  Widget _dropdownShell(Widget child) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: Zine.card,
          border: Zine.border,
          borderRadius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowXs,
        ),
        child: child,
      );

  Widget _segmented(Map<String, String> opts, String sel, ValueChanged<String> onSel) {
    return Row(
      children: [
        for (final e in opts.entries) ...[
          Expanded(
            child: GestureDetector(
              onTap: () => onSel(e.key),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 11),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: sel == e.key ? Zine.coral : Zine.card,
                  border: Zine.border,
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  boxShadow: sel == e.key ? Zine.shadowXs : null,
                ),
                child: Text(
                  e.value,
                  textAlign: TextAlign.center,
                  style: ZineText.value(size: 13, color: sel == e.key ? Colors.white : Zine.ink),
                ),
              ),
            ),
          ),
          if (e.key != opts.keys.last) const SizedBox(width: 8),
        ],
      ],
    );
  }

  Widget _toggleRow(String title, String sub, bool value, ValueChanged<bool> onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14)),
            const SizedBox(height: 2),
            Text(sub, style: ZineText.sub(size: 12)),
          ]),
        ),
        const SizedBox(width: 8),
        Switch(value: value, activeColor: Zine.coral, onChanged: onChanged),
      ]),
    );
  }

  Widget _timeBtn(String label, TimeOfDay? t, VoidCallback onTap) {
    final txt = t == null ? 'Not set' : t.format(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
          color: Zine.card,
          border: Zine.border,
          borderRadius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text('$label: $txt', style: ZineText.value(size: 13.5)),
          PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
        ]),
      ),
    );
  }
}
