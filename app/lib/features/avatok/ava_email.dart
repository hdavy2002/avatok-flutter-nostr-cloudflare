// ava_email.dart — the in-chat email surface (AvaTOK "Ava inbox"). When Ava
// answers an "what's in my inbox" turn, the server embeds an `emails` array in
// her bubble envelope; chat_thread.dart renders [EmailInboxCards] from it. Each
// card → View / Spam / Delete; View opens [EmailViewerScreen] (read → reply →
// sent → back to the chat). Actions call the worker /api/ava/email/* routes,
// which act on the user's Gmail via Composio.
//
// Styling follows the design kit (theme/design/gmail/ui_kits/avatok) mapped onto
// the Zine design system. Telemetry (PostHog, email-stamped) tracks design
// render, view opens, reply speed and every Composio action's ok/ms/error.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_log.dart';
import '../../core/config.dart';
import '../../core/ui/zine.dart';

/// One inbox email as sent by the worker (lib/gmail.ts InboxEmail).
class AvaInboxEmail {
  final String id;
  final String threadId;
  final String from;
  final String addr;
  final String subject;
  final String snippet;
  String body; // filled lazily on View via /email/get
  final String time;
  final String? flag; // "Action" → coral pill
  final String accentToken; // e.g. "var(--blue)"

  AvaInboxEmail({
    required this.id, required this.threadId, required this.from, required this.addr,
    required this.subject, required this.snippet, required this.time,
    this.body = '', this.flag, this.accentToken = 'var(--card)',
  });

  factory AvaInboxEmail.fromJson(Map<String, dynamic> j) => AvaInboxEmail(
        id: (j['id'] ?? '').toString(),
        threadId: (j['threadId'] ?? '').toString(),
        from: (j['from'] ?? '').toString(),
        addr: (j['addr'] ?? '').toString(),
        subject: (j['subject'] ?? '(no subject)').toString(),
        snippet: (j['snippet'] ?? '').toString(),
        body: (j['body'] ?? '').toString(),
        time: (j['time'] ?? '').toString(),
        flag: (j['flag'] == null || j['flag'].toString().isEmpty) ? null : j['flag'].toString(),
        accentToken: (j['accent'] ?? 'var(--card)').toString(),
      );

  static List<AvaInboxEmail> listFrom(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((m) => AvaInboxEmail.fromJson(m.cast<String, dynamic>()))
        .where((e) => e.id.isNotEmpty)
        .toList();
  }
}

/// Map a design-kit accent token to a Zine colour.
Color avaEmailAccent(String? token) {
  switch (token) {
    case 'var(--blue)':
      return Zine.blue;
    case 'var(--lime)':
      return Zine.lime;
    case 'var(--mint)':
      return Zine.mint;
    case 'var(--coral)':
      return Zine.coral;
    case 'var(--lilac)':
      return Zine.lilac;
    default:
      return Zine.card;
  }
}

/// Worker client for the per-card actions + full-body fetch. All routes are
/// premium + Gmail-connected gated server-side; here we just surface ok/throw.
class AvaEmailApi {
  static String get _base => '$kApiBase/ava/email';

  static Future<String> body(String id) async {
    final res = await ApiAuth.postJson('$_base/get', {'id': id},
        timeout: const Duration(seconds: 20));
    if (res.statusCode != 200) throw _err('get', res);
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return (j['body'] ?? '').toString();
  }

  static Future<bool> spam(String id) => _act('spam', {'id': id});
  static Future<bool> trash(String id) => _act('trash', {'id': id});

  static Future<bool> reply({required String threadId, required String to, required String body}) =>
      _act('reply', {'threadId': threadId, 'to': to, 'body': body});

  static Future<bool> _act(String path, Map<String, dynamic> b) async {
    final res = await ApiAuth.postJson('$_base/$path', b, timeout: const Duration(seconds: 25));
    if (res.statusCode != 200) {
      AvaLog.I.log('email', '$path FAILED ${res.statusCode}: ${res.body}');
      throw _err(path, res);
    }
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return j['ok'] == true;
  }

  static Exception _err(String path, dynamic res) =>
      Exception('email $path ${res.statusCode}');
}

const _mono = TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700, letterSpacing: 0.5);

/// The inbox header strip + email cards, rendered inside an Ava bubble.
class EmailInboxCards extends StatefulWidget {
  final List<AvaInboxEmail> emails;
  const EmailInboxCards({super.key, required this.emails});

  @override
  State<EmailInboxCards> createState() => _EmailInboxCardsState();
}

class _EmailInboxCardsState extends State<EmailInboxCards> {
  final Set<String> _gone = {}; // ids removed locally (spam / delete)

  @override
  void initState() {
    super.initState();
    Analytics.capture('ava_email_design_render', {
      'count': widget.emails.length,
      'surface': 'ava_chat',
    });
  }

  List<AvaInboxEmail> get _visible =>
      widget.emails.where((e) => !_gone.contains(e.id)).toList();

  Future<void> _spam(AvaInboxEmail e) async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    setState(() => _gone.add(e.id)); // optimistic
    try {
      final ok = await AvaEmailApi.spam(e.id);
      Analytics.capture('ava_email_card_action',
          {'action': 'spam', 'ok': ok, 'ms': DateTime.now().millisecondsSinceEpoch - t0});
      if (!ok && mounted) { setState(() => _gone.remove(e.id)); _toast('Could not report spam'); }
    } catch (err) {
      Analytics.capture('ava_email_card_action', {'action': 'spam', 'ok': false});
      if (mounted) { setState(() => _gone.remove(e.id)); _toast('Could not report spam'); }
    }
  }

  Future<void> _delete(AvaInboxEmail e) async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    setState(() => _gone.add(e.id)); // optimistic
    try {
      final ok = await AvaEmailApi.trash(e.id);
      Analytics.capture('ava_email_card_action',
          {'action': 'trash', 'ok': ok, 'ms': DateTime.now().millisecondsSinceEpoch - t0});
      if (!ok && mounted) { setState(() => _gone.remove(e.id)); _toast('Could not delete'); }
    } catch (err) {
      Analytics.capture('ava_email_card_action', {'action': 'trash', 'ok': false});
      if (mounted) { setState(() => _gone.remove(e.id)); _toast('Could not delete'); }
    }
  }

  Future<void> _view(AvaInboxEmail e) async {
    Analytics.capture('ava_email_view_open', {'has_body': e.body.isNotEmpty});
    final removed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => EmailViewerScreen(email: e), fullscreenDialog: true),
    );
    if (removed == true && mounted) setState(() => _gone.add(e.id)); // deleted from viewer
  }

  void _toast(String m) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  Widget build(BuildContext context) {
    final visible = _visible;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // inbox header strip
        Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: Zine.paper,
            border: Zine.border,
            borderRadius: BorderRadius.circular(100),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.tray(PhosphorIconsStyle.fill), size: 13, color: Zine.ink),
            const SizedBox(width: 6),
            Text('INBOX · ${visible.length} ${visible.length == 1 ? 'EMAIL' : 'EMAILS'}',
                style: _mono.copyWith(fontSize: 9.5, color: Zine.ink)),
          ]),
        ),
        if (visible.isEmpty)
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Zine.card, border: Zine.border, borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 18, color: Zine.mintInk),
              const SizedBox(width: 8),
              Flexible(child: Text('Inbox zero — all caught up.',
                  style: ZineText.sub(size: 13, color: Zine.inkSoft))),
            ]),
          )
        else
          for (final e in visible)
            Padding(
              padding: const EdgeInsets.only(bottom: 7),
              child: _EmailCard(e: e, onView: () => _view(e), onSpam: () => _spam(e), onDelete: () => _delete(e)),
            ),
      ],
    );
  }
}

class _EmailCard extends StatelessWidget {
  final AvaInboxEmail e;
  final VoidCallback onView, onSpam, onDelete;
  const _EmailCard({required this.e, required this.onView, required this.onSpam, required this.onDelete});

  @override
  Widget build(BuildContext context) {
    final accent = avaEmailAccent(e.accentToken);
    final initial = (e.from.trim().isEmpty ? '?' : e.from.trim()[0]).toUpperCase();
    return Container(
      decoration: BoxDecoration(
        color: Zine.card, border: Zine.border,
        borderRadius: BorderRadius.circular(14), boxShadow: Zine.shadowXs,
      ),
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // sender monogram
          Container(
            width: 34, height: 34,
            decoration: BoxDecoration(color: accent, border: Zine.border, borderRadius: BorderRadius.circular(11)),
            alignment: Alignment.center,
            child: Text(initial, style: ZineText.value(size: 16)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(e.from, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: ZineText.value(size: 13.5))),
                if (e.flag != null) ...[
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(color: Zine.coral, border: Zine.border, borderRadius: BorderRadius.circular(100)),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.fill), size: 9, color: Zine.paper),
                      const SizedBox(width: 3),
                      Text(e.flag!.toUpperCase(), style: _mono.copyWith(fontSize: 8.5, color: Zine.paper)),
                    ]),
                  ),
                ],
              ]),
              if (e.addr.isNotEmpty)
                Padding(padding: const EdgeInsets.only(top: 1),
                    child: Text(e.addr, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: _mono.copyWith(fontSize: 10, color: Zine.inkMute))),
              Padding(padding: const EdgeInsets.only(top: 6),
                  child: Text(e.subject, maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 13.5))),
              if (e.snippet.isNotEmpty)
                Padding(padding: const EdgeInsets.only(top: 2),
                    child: Text(e.snippet, maxLines: 2, overflow: TextOverflow.ellipsis,
                        style: ZineText.sub(size: 12.5, color: Zine.inkSoft))),
            ]),
          ),
        ]),
        const SizedBox(height: 9),
        Row(children: [
          _pill('View', PhosphorIcons.envelopeOpen(PhosphorIconsStyle.fill), Zine.lime, onView),
          const SizedBox(width: 6),
          _pill('Spam', PhosphorIcons.prohibit(PhosphorIconsStyle.bold), Zine.coralMark, onSpam),
          const SizedBox(width: 6),
          _pill('Delete', PhosphorIcons.trash(PhosphorIconsStyle.bold), Zine.card, onDelete),
        ]),
      ]),
    );
  }

  Widget _pill(String label, IconData icon, Color fill, VoidCallback onTap) => Expanded(
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
            decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(100), boxShadow: Zine.shadowXs),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              PhosphorIcon(icon, size: 13, color: Zine.ink),
              const SizedBox(width: 5),
              Flexible(child: Text(label.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: _mono.copyWith(fontSize: 10, color: Zine.ink))),
            ]),
          ),
        ),
      );
}

/// Full-screen email overlay: read → reply → sent, then pops back to the chat.
/// Returns `true` if the email was deleted (so the list can drop the card).
class EmailViewerScreen extends StatefulWidget {
  final AvaInboxEmail email;
  const EmailViewerScreen({super.key, required this.email});

  @override
  State<EmailViewerScreen> createState() => _EmailViewerScreenState();
}

class _EmailViewerScreenState extends State<EmailViewerScreen> {
  String _mode = 'read'; // read | reply | sent
  final _reply = TextEditingController();
  bool _loadingBody = false;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    if (widget.email.body.isEmpty) _loadBody();
  }

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _loadBody() async {
    setState(() => _loadingBody = true);
    try {
      final b = await AvaEmailApi.body(widget.email.id);
      if (mounted) setState(() => widget.email.body = b);
    } catch (e) {
      AvaLog.I.log('email', 'body load failed: $e');
    } finally {
      if (mounted) setState(() => _loadingBody = false);
    }
  }

  Future<void> _send() async {
    final text = _reply.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    final t0 = DateTime.now().millisecondsSinceEpoch;
    bool ok = false;
    try {
      ok = await AvaEmailApi.reply(threadId: widget.email.threadId, to: widget.email.addr, body: text);
    } catch (e) {
      AvaLog.I.log('email', 'reply send failed: $e');
    }
    Analytics.capture('ava_email_reply_send',
        {'ok': ok, 'ms': DateTime.now().millisecondsSinceEpoch - t0, 'len': text.length});
    if (!mounted) return;
    setState(() => _sending = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Reply failed — try again')));
      return;
    }
    setState(() => _mode = 'sent');
    // Auto-return to the chat after the confirmation (matches the design).
    Future.delayed(const Duration(milliseconds: 1700), () { if (mounted) Navigator.of(context).pop(false); });
  }

  Future<void> _trash() async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    bool ok = false;
    try {
      ok = await AvaEmailApi.trash(widget.email.id);
    } catch (_) {}
    Analytics.capture('ava_email_card_action',
        {'action': 'trash', 'ok': ok, 'ms': DateTime.now().millisecondsSinceEpoch - t0, 'from': 'viewer'});
    if (mounted) Navigator.of(context).pop(ok);
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.email;
    final title = _mode == 'reply' ? 'Reply' : _mode == 'sent' ? 'Sent' : 'Email';
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Column(children: [
          // header
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(color: Zine.paper2, border: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw))),
            child: Row(children: [
              _circleBtn(_mode == 'reply' ? PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold) : PhosphorIcons.x(PhosphorIconsStyle.bold),
                  () => _mode == 'reply' ? setState(() => _mode = 'read') : Navigator.of(context).pop(false)),
              const SizedBox(width: 11),
              Expanded(child: Text(title, style: ZineText.cardTitle(size: 19))),
              if (_mode != 'sent')
                _circleBtn(PhosphorIcons.trash(PhosphorIconsStyle.regular), _trash),
            ]),
          ),
          Expanded(child: _body(e)),
          if (_mode == 'read') _footer(
            'Reply', PhosphorIcons.arrowBendUpLeft(PhosphorIconsStyle.bold), Zine.lime,
            () => setState(() => _mode = 'reply')),
          if (_mode == 'reply') _footer(
            _sending ? 'Sending…' : 'Send', PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
            _reply.text.trim().isEmpty ? Zine.card : Zine.lime, _send,
            enabled: _reply.text.trim().isNotEmpty && !_sending),
        ]),
      ),
    );
  }

  Widget _body(AvaInboxEmail e) {
    if (_mode == 'sent') {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 76, height: 76,
            decoration: BoxDecoration(color: Zine.mint, border: Zine.borderLg, borderRadius: BorderRadius.circular(100), boxShadow: Zine.shadowSm),
            child: Center(child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 38, color: Zine.ink)),
          ),
          const SizedBox(height: 16),
          Text('Message sent', style: ZineText.cardTitle(size: 26)),
          const SizedBox(height: 8),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 40),
              child: Text('Your reply to ${e.from} is on its way. Returning to chat…',
                  textAlign: TextAlign.center, style: ZineText.sub(size: 14, color: Zine.inkSoft))),
        ]),
      );
    }
    if (_mode == 'reply') {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _metaRow('TO', '${e.from}  ·  ${e.addr}'),
          const SizedBox(height: 7),
          _metaRow('SUBJ', 'Re: ${e.subject}'),
          const SizedBox(height: 12),
          Container(
            decoration: BoxDecoration(color: Zine.card, border: Zine.border, borderRadius: BorderRadius.circular(Zine.rField), boxShadow: Zine.shadowXs),
            padding: const EdgeInsets.all(14),
            child: TextField(
              controller: _reply,
              autofocus: true,
              minLines: 6,
              maxLines: 14,
              onChanged: (_) => setState(() {}),
              style: ZineText.sub(size: 15, color: Zine.ink),
              decoration: const InputDecoration.collapsed(hintText: 'Write your reply…'),
            ),
          ),
        ]),
      );
    }
    // read
    final accent = avaEmailAccent(e.accentToken);
    final initial = (e.from.trim().isEmpty ? '?' : e.from.trim()[0]).toUpperCase();
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            width: 46, height: 46,
            decoration: BoxDecoration(color: accent, border: Zine.border, borderRadius: BorderRadius.circular(14), boxShadow: Zine.shadowXs),
            alignment: Alignment.center,
            child: Text(initial, style: ZineText.value(size: 21)),
          ),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(e.from, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 16)),
            Text(e.addr, maxLines: 1, overflow: TextOverflow.ellipsis, style: _mono.copyWith(fontSize: 11, color: Zine.inkMute)),
            Padding(padding: const EdgeInsets.only(top: 2),
                child: Text('to me · ${e.time}', style: _mono.copyWith(fontSize: 10.5, color: Zine.inkMute))),
          ])),
        ]),
        const SizedBox(height: 14),
        Text(e.subject, style: ZineText.cardTitle(size: 23)),
        const SizedBox(height: 12),
        const Divider(color: Zine.inkMute, height: 1, thickness: 1),
        const SizedBox(height: 14),
        if (_loadingBody)
          const Padding(padding: EdgeInsets.symmetric(vertical: 20),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)))
        else
          Text(e.body.isNotEmpty ? e.body : e.snippet,
              style: ZineText.sub(size: 15, color: Zine.inkSoft).copyWith(height: 1.5)),
      ]),
    );
  }

  Widget _metaRow(String label, String value) => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 44, child: Text(label, style: _mono.copyWith(fontSize: 10, color: Zine.inkMute))),
        Expanded(child: Text(value, style: ZineText.value(size: 14))),
      ]);

  Widget _circleBtn(IconData icon, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          width: 42, height: 42,
          decoration: BoxDecoration(color: Zine.card, border: Zine.border, borderRadius: BorderRadius.circular(100), boxShadow: Zine.shadowSm),
          child: Center(child: PhosphorIcon(icon, size: 19, color: Zine.ink)),
        ),
      );

  Widget _footer(String label, IconData icon, Color fill, VoidCallback onTap, {bool enabled = true}) => Container(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        decoration: BoxDecoration(color: Zine.paper2, border: const Border(top: BorderSide(color: Zine.ink, width: Zine.bw))),
        child: GestureDetector(
          onTap: enabled ? onTap : null,
          child: Opacity(
            opacity: enabled ? 1 : 0.55,
            child: Container(
              height: 50,
              decoration: BoxDecoration(color: fill, border: Zine.border, borderRadius: BorderRadius.circular(100), boxShadow: enabled ? Zine.shadowSm : null),
              child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                PhosphorIcon(icon, size: 20, color: Zine.ink),
                const SizedBox(width: 8),
                Text(label, style: ZineText.button(size: 16)),
              ]),
            ),
          ),
        ),
      );
}
