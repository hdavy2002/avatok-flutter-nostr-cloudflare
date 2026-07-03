// STREAM F (AI Messenger Batch) — Auto-Responder settings page.
// "Ava replies while you're away." Master toggle + mode presets + audience +
// duration + conversation depth + language/urgent/digest toggles.
//
// Loads/saves via GET/PUT /api/auto-responder (worker/src/routes/auto_responder.ts).
// The config is per-account (server scopes by the Clerk-verified uid; the client
// simply sends the authed request — no client-side key needed). Any per-account
// LOCAL cache added later MUST use scopedKey/AccountScope per the Rulebook; this
// page currently keeps no local state (server is the source of truth).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

const String _kAutoResponderUrl = '$kApiBase/auto-responder';

/// Mode presets → default away message (mirrors MODE_DEFAULTS in
/// worker/src/routes/auto_responder.ts). Editable; server also applies the default
/// when the message is blank.
const Map<String, String> _kModeLabels = {
  'travelling': 'Travelling',
  'busy': 'Busy',
  'sleeping': 'Sleeping',
  'driving': 'Driving',
  'custom': 'Custom',
};

class AutoResponderSettingsPage extends StatefulWidget {
  const AutoResponderSettingsPage({super.key});
  @override
  State<AutoResponderSettingsPage> createState() => _AutoResponderSettingsPageState();
}

class _AutoResponderSettingsPageState extends State<AutoResponderSettingsPage> {
  bool _loading = true;
  bool _saving = false;
  bool _featureEnabled = true;

  // Editable state
  bool _enabled = false;
  String _mode = 'travelling';
  final TextEditingController _msg = TextEditingController();
  String _audience = 'known'; // known | everyone
  String _durationKind = 'off'; // off | hours | schedule
  int _durationHours = 4; // 1|4|8|24
  int _schedStart = 22 * 60; // minutes from midnight
  int _schedEnd = 7 * 60;
  String _depth = 'once'; // once | chat
  bool _replyLang = true;
  bool _urgent = true;
  bool _digest = true;

  Map<String, String> _modeDefaults = Map<String, String>.from({
    'travelling':
        "Hey — Davy is travelling and offline right now. I've noted your message; he hasn't read it yet and will see it when he's back.",
  });

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _msg.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await ApiAuth.getSigned(_kAutoResponderUrl);
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, dynamic>;
        _featureEnabled = j['featureEnabled'] != false;
        if (j['modeDefaults'] is Map) {
          _modeDefaults = (j['modeDefaults'] as Map).map((k, v) => MapEntry('$k', '$v'));
        }
        final c = (j['config'] as Map?) ?? {};
        _enabled = c['enabled'] == true;
        _mode = _kModeLabels.containsKey(c['mode']) ? '${c['mode']}' : 'travelling';
        _msg.text = (c['message'] as String?)?.trim().isNotEmpty == true
            ? '${c['message']}'
            : (_modeDefaults[_mode] ?? '');
        _audience = c['audience'] == 'everyone' ? 'everyone' : 'known';
        _durationKind = ['off', 'hours', 'schedule'].contains(c['durationKind']) ? '${c['durationKind']}' : 'off';
        _durationHours = [1, 4, 8, 24].contains(c['durationHours']) ? (c['durationHours'] as int) : 4;
        if (c['schedStart'] is int) _schedStart = c['schedStart'] as int;
        if (c['schedEnd'] is int) _schedEnd = c['schedEnd'] as int;
        _depth = c['depth'] == 'chat' ? 'chat' : 'once';
        _replyLang = c['replyLang'] != false;
        _urgent = c['urgentEscalate'] != false;
        _digest = c['awayDigest'] != false;
      }
    } catch (_) {/* keep defaults */}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final body = {
      'enabled': _enabled,
      'mode': _mode,
      'message': _msg.text.trim(),
      'audience': _audience,
      'durationKind': _durationKind,
      'durationHours': _durationHours,
      'schedStart': _schedStart,
      'schedEnd': _schedEnd,
      'depth': _depth,
      'replyLang': _replyLang,
      'urgentEscalate': _urgent,
      'awayDigest': _digest,
    };
    try {
      final res = await ApiAuth.putJson(_kAutoResponderUrl, body);
      final ok = res.statusCode == 200;
      try {
        Analytics.capture('autoresponder_enabled', <String, Object>{
          'enabled': _enabled, 'mode': _mode, 'ai_mode': _depth == 'chat',
          'audience': _audience, 'duration_kind': _durationKind, 'reply_lang': _replyLang,
          'urgent_escalate': _urgent, 'client': true,
        });
      } catch (_) {}
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(ok ? 'Auto-responder saved' : 'Could not save (${res.statusCode})')),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not save — check your connection')));
      }
    }
    if (mounted) setState(() => _saving = false);
  }

  void _onModeChanged(String m) {
    setState(() {
      // If the message field still holds the previous mode's default (untouched),
      // swap it for the new mode's default; otherwise keep the user's custom text.
      final wasDefault = _msg.text.trim().isEmpty ||
          _modeDefaults.values.contains(_msg.text.trim());
      _mode = m;
      if (wasDefault) _msg.text = _modeDefaults[m] ?? _msg.text;
    });
  }

  String _fmtMins(int m) {
    final h = (m ~/ 60).toString().padLeft(2, '0');
    final mm = (m % 60).toString().padLeft(2, '0');
    return '$h:$mm';
  }

  Future<void> _pickTime(bool start) async {
    final init = start ? _schedStart : _schedEnd;
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: init ~/ 60, minute: init % 60),
    );
    if (picked != null) {
      setState(() {
        final mins = picked.hour * 60 + picked.minute;
        if (start) {
          _schedStart = mins;
        } else {
          _schedEnd = mins;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(title: 'Auto-Responder', markWord: 'Auto', showBack: true),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                if (!_featureEnabled)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text('This feature is currently turned off by AvaTOK.',
                        style: ZineText.sub(size: 12, color: Zine.coral)),
                  ),
                _masterCard(),
                if (_enabled) ...[
                  const SizedBox(height: 16),
                  _modeCard(),
                  const SizedBox(height: 16),
                  _audienceCard(),
                  const SizedBox(height: 16),
                  _durationCard(),
                  const SizedBox(height: 16),
                  _depthCard(),
                  const SizedBox(height: 16),
                  _togglesCard(),
                ],
                const SizedBox(height: 24),
                ZineButton(
                  label: 'Save',
                  loading: _saving,
                  fullWidth: true,
                  onPressed: _saving ? null : _save,
                ),
                const SizedBox(height: 40),
              ],
            ),
    );
  }

  Widget _rowToggle(String title, String sub, bool value, ValueChanged<bool> onChanged) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14)),
            const SizedBox(height: 2),
            Text(sub, style: ZineText.sub(size: 12)),
          ])),
          const SizedBox(width: 12),
          ZineToggle(value: value, onChanged: onChanged),
        ]),
      );

  Widget _masterCard() => ZineCard(
        child: _rowToggle(
          'Auto-reply while I\'m away',
          'Ava sends a short reply so people know you\'ll get back to them.',
          _enabled,
          (v) => setState(() => _enabled = v),
        ),
      );

  Widget _chip(String label, bool selected, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.only(right: 8, bottom: 8),
        child: ZinePressable(
          onTap: onTap,
          radius: BorderRadius.circular(100),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          color: selected ? Zine.lime : Zine.paper2,
          child: Text(label, style: ZineText.value(size: 13, color: Zine.ink)),
        ),
      );

  Widget _modeCard() => ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Mode', style: ZineText.value(size: 15)),
          const SizedBox(height: 4),
          Text('Pick a preset — the message is editable.', style: ZineText.sub(size: 12)),
          const SizedBox(height: 12),
          Wrap(children: [
            for (final e in _kModeLabels.entries) _chip(e.value, _mode == e.key, () => _onModeChanged(e.key)),
          ]),
          const SizedBox(height: 8),
          TextField(
            controller: _msg,
            maxLength: 200,
            maxLines: 3,
            inputFormatters: [LengthLimitingTextInputFormatter(200)],
            decoration: const InputDecoration(
              hintText: 'Your away message',
              border: OutlineInputBorder(),
              counterText: '',
            ),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: Text('${_msg.text.length}/200', style: ZineText.sub(size: 11)),
          ),
        ]),
      );

  Widget _audienceCard() => ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Who gets an auto-reply', style: ZineText.value(size: 15)),
          const SizedBox(height: 4),
          Text('Ava never auto-replies to pending message requests from strangers.',
              style: ZineText.sub(size: 12)),
          const SizedBox(height: 12),
          Wrap(children: [
            _chip('Known contacts only', _audience == 'known', () => setState(() => _audience = 'known')),
            _chip('Everyone except blocked', _audience == 'everyone', () => setState(() => _audience = 'everyone')),
          ]),
        ]),
      );

  Widget _durationCard() => ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('How long', style: ZineText.value(size: 15)),
          const SizedBox(height: 12),
          Wrap(children: [
            _chip('Until I turn it off', _durationKind == 'off', () => setState(() => _durationKind = 'off')),
            _chip('For a set time', _durationKind == 'hours', () => setState(() => _durationKind = 'hours')),
            _chip('Daily schedule', _durationKind == 'schedule', () => setState(() => _durationKind = 'schedule')),
          ]),
          if (_durationKind == 'hours') ...[
            const SizedBox(height: 8),
            Wrap(children: [
              for (final h in [1, 4, 8, 24])
                _chip('$h ${h == 1 ? "hour" : "hours"}', _durationHours == h, () => setState(() => _durationHours = h)),
            ]),
          ],
          if (_durationKind == 'schedule') ...[
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: _timeField('Start', _fmtMins(_schedStart), () => _pickTime(true))),
              const SizedBox(width: 12),
              Expanded(child: _timeField('End', _fmtMins(_schedEnd), () => _pickTime(false))),
            ]),
            const SizedBox(height: 6),
            Text('Times are in UTC on the server.', style: ZineText.sub(size: 11)),
          ],
        ]),
      );

  Widget _timeField(String label, String value, VoidCallback onTap) => ZinePressable(
        onTap: onTap,
        radius: BorderRadius.circular(Zine.rSm),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        color: Zine.paper2,
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: ZineText.sub(size: 11)),
            Text(value, style: ZineText.value(size: 16)),
          ]),
          PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold), size: 18, color: Zine.inkMute),
        ]),
      );

  Widget _depthCard() => ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Conversation depth', style: ZineText.value(size: 15)),
          const SizedBox(height: 12),
          Wrap(children: [
            _chip('Reply once per contact', _depth == 'once', () => setState(() => _depth = 'once')),
            _chip('Let Ava chat briefly', _depth == 'chat', () => setState(() => _depth = 'chat')),
          ]),
          if (_depth == 'chat') ...[
            const SizedBox(height: 8),
            Text('AI mode: Ava replies briefly using your recent chat, capped at 3 exchanges per contact per day. Ava never invents commitments.',
                style: ZineText.sub(size: 12)),
          ],
        ]),
      );

  Widget _togglesCard() => ZineCard(
        child: Column(children: [
          _rowToggle('Reply in the sender\'s language', 'Match the language they wrote in.', _replyLang,
              (v) => setState(() => _replyLang = v)),
          const Divider(height: 20),
          _rowToggle('Urgent escalation', 'Push urgent messages through even while away.', _urgent,
              (v) => setState(() => _urgent = v)),
          const Divider(height: 20),
          _rowToggle('Away digest', 'When you turn this off, Ava sums up who it replied to.', _digest,
              (v) => setState(() => _digest = v)),
        ]),
      );
}
