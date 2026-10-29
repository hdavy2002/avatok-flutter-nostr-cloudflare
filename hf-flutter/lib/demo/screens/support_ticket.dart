import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/brand.dart';
import '../../data/api_exception.dart';
import '../../data/merch_art_picker.dart';
import '../../data/models/support.dart';
import '../../data/repos/support_repo.dart';
import '../../data/services.dart';
import '../support_kit.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-SUPPORT-APP] One ticket, route `/support/:number`. Built to the owner-approved mock-up "AppTicket" (2026-10-29): the thread
/// (your messages on the right in lavender, support on the left in white with its signature, system lines as centred chips),
/// "This solved my issue", and a reply box with attach and send. Opening the ticket marks it read on the server.
class SupportTicketScreen extends StatefulWidget {
  const SupportTicketScreen({super.key, required this.number, this.repo, this.pick, this.openAttachment});

  /// `HF-10234`
  final String number;
  final SupportRepo? repo;
  final Future<PickedArt?> Function()? pick;

  /// Tests replace how an attachment is opened; the app shows an image in a viewer and hands a PDF to the share sheet.
  final Future<void> Function(BuildContext context, SupportAttachment a)? openAttachment;

  @override
  State<SupportTicketScreen> createState() => _SupportTicketScreenState();
}

class _SupportTicketScreenState extends State<SupportTicketScreen> {
  final TextEditingController _reply = TextEditingController();
  final ScrollController _scroll = ScrollController();
  final List<SupportDraft> _files = <SupportDraft>[];

  SupportThread? _thread;
  Object? _error;
  bool _loading = true;
  bool _sending = false;
  bool _acting = false; // solve / reopen in flight
  String? _sendError;
  bool _firstShown = false;

  SupportRepo get _repo => widget.repo ?? Services.instance.supportRepo;

  @override
  void initState() {
    super.initState();
    _reply.addListener(() {
      if (mounted) setState(() {});
    });
    unawaited(_load());
  }

  @override
  void dispose() {
    _reply.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final th = await _repo.ticket(widget.number);
      if (!mounted) return;
      setState(() {
        _thread = th;
        _error = null;
        _loading = false;
      });
      if (!_firstShown) {
        _firstShown = true;
        _toBottom();
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (_thread == null) _error = e;
      });
    }
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _attach() async {
    if (_files.length >= kSupportMaxFiles) {
      toast(context, 'You can add up to $kSupportMaxFiles pictures.');
      return;
    }
    final d = await pickSupportPicture(widget.pick, (p) {
      if (mounted) setState(() => _sendError = p);
    });
    if (d == null || !mounted) return;
    setState(() {
      _files.add(d);
      _sendError = null;
    });
  }

  bool get _canSend => !_sending && _reply.text.trim().isNotEmpty;

  Future<void> _sendReply() async {
    if (!_canSend) return;
    setState(() {
      _sending = true;
      _sendError = null;
    });
    try {
      final ids = await uploadSupportDrafts(_repo, _files);
      await _repo.reply(widget.number, _reply.text, attachmentIds: ids);
      if (!mounted) return;
      _reply.clear();
      _files.clear();
      setState(() => _sending = false);
      await _load();
      _toBottom();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _sendError = supportErrorText(e);
      });
    }
  }

  Future<void> _act(Future<void> Function() job, String done) async {
    if (_acting) return;
    setState(() {
      _acting = true;
      _sendError = null;
    });
    try {
      await job();
      if (!mounted) return;
      await _load();
      if (mounted) toast(context, done);
      _toBottom();
    } catch (e) {
      if (mounted) setState(() => _sendError = supportErrorText(e));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _open(SupportAttachment a) async {
    final custom = widget.openAttachment;
    if (custom != null) {
      await custom(context, a);
      return;
    }
    await openSupportAttachment(context, _repo, a);
  }

  @override
  Widget build(BuildContext context) {
    final th = _thread;
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          SupHeader(
            title: th != null && th.ticket.subject.isNotEmpty ? th.ticket.subject : 'Your ticket',
            eyebrow: widget.number,
            titleSize: 21,
            flower: false,
          ),
          if (th != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(82, 0, 20, 12),
              child: Align(alignment: Alignment.centerLeft, child: SupStatusChip(key: const Key('ticket-status'), tone: th.ticket.tone, label: th.ticket.label, big: true)),
            ),
          Expanded(child: th != null ? _thread0(th) : (_loading ? _spinner() : _errorBody())),
          if (th != null && th.ticket.status != 'closed') _composer(),
        ]),
      ),
    );
  }

  Widget _spinner() => const Center(child: SizedBox(width: 44, height: 44, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 5)));

  Widget _errorBody() {
    final e = _error;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        SupCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SupHeading(e is ApiException ? e.failureTitle : 'That did not work', flower: false),
            Text(e is ApiException ? e.failureMessage : ApiException.genericText, key: const Key('ticket-error'), style: t(15, color: C.muted, w: FontWeight.w600, h: 1.5)),
            const SizedBox(height: 16),
            SupSolidButton(
              label: 'Try again',
              onTap: () {
                setState(() {
                  _loading = true;
                  _error = null;
                });
                unawaited(_load());
              },
            ),
          ]),
        ),
      ],
    );
  }

  Widget _thread0(SupportThread th) {
    final status = th.ticket.status;
    final canSolve = const {'new', 'open', 'waiting', 'on_hold'}.contains(status) && th.hasSupportReply;
    final items = <Widget>[];
    final first = th.messages.isEmpty ? null : th.messages.first;
    if (th.createdAt != null && (first == null || !first.fromSystem)) {
      items.add(_SystemLine('Ticket opened · ${supStamp(th.createdAt!)}'));
    }
    for (final m in th.messages) {
      items.add(switch (m.author) {
        'customer' => _CustomerBubble(message: m, onOpen: _open),
        'system' => _SystemLine(m.createdAt == null ? m.text : '${m.text} · ${supClock(m.createdAt!)}'),
        _ => _SupportBubble(message: m, onOpen: _open),
      });
    }
    if (canSolve) {
      items.add(SupSolidButton(
        key: const Key('ticket-solve'),
        label: 'This solved my issue',
        color: C.kycGreen,
        busy: _acting,
        onTap: () => unawaited(_act(() => _repo.solve(widget.number), 'Marked as solved. Thank you.')),
      ));
    }
    if (status == 'solved' && th.canReopen) {
      items.add(SupSolidButton(
        key: const Key('ticket-reopen'),
        label: 'Reopen this ticket',
        busy: _acting,
        onTap: () => unawaited(_act(() => _repo.reopen(widget.number), 'Your ticket is open again.')),
      ));
    }
    if (status == 'closed') {
      items.add(SupCard(
        radius: 22,
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('This ticket is closed.', style: t(16, color: C.maroon, w: FontWeight.w800)),
          const SizedBox(height: 4),
          Text('If you still need help, open a new ticket from Contact Support.', style: t(15, color: C.muted, w: FontWeight.w600, h: 1.5)),
          const SizedBox(height: 14),
          SupSolidButton(key: const Key('ticket-new'), label: 'Contact Support', onTap: () => unawaited(context.push<Object?>('/support'))),
        ]),
      ));
    }
    return RefreshIndicator(
      color: C.maroon,
      onRefresh: _load,
      child: ListView.separated(
        key: const Key('ticket-thread'),
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 18),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 14),
        itemBuilder: (_, i) => items[i],
      ),
    );
  }

  Widget _composer() => Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
        decoration: const BoxDecoration(color: C.cream, border: Border(top: BorderSide(color: C.line))),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_sendError != null)
            Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_sendError!, key: const Key('ticket-send-error'), style: t(14, color: C.ruby, w: FontWeight.w700))),
          if (_files.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: SupportDraftChips(drafts: _files, onRemove: (d) => setState(() => _files.remove(d)))),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            _RoundButton(key: const Key('ticket-attach'), icon: Icons.attach_file_rounded, label: 'Attach a picture', bg: C.lavtint, ink: C.lav, onTap: _sending ? null : _attach),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                key: const Key('ticket-reply'),
                controller: _reply,
                minLines: 1,
                maxLines: 4,
                maxLength: 5000,
                keyboardType: TextInputType.multiline,
                textCapitalization: TextCapitalization.sentences,
                style: t(15, w: FontWeight.w600, h: 1.4),
                decoration: supField(hint: 'Write a reply…').copyWith(
                  fillColor: C.white,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: const BorderSide(color: C.line, width: 1.5)),
                  enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: const BorderSide(color: C.line, width: 1.5)),
                  focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: const BorderSide(color: C.maroon, width: 2)),
                ),
              ),
            ),
            const SizedBox(width: 10),
            _RoundButton(key: const Key('ticket-send'), icon: Icons.arrow_forward_rounded, label: 'Send reply', bg: C.maroon, ink: C.white, busy: _sending, onTap: _canSend ? _sendReply : null),
          ]),
        ]),
      );
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({super.key, required this.icon, required this.label, required this.bg, required this.ink, required this.onTap, this.busy = false});

  final IconData icon;
  final String label;
  final Color bg;
  final Color ink;
  final VoidCallback? onTap;
  final bool busy;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        enabled: onTap != null,
        label: label,
        child: Opacity(
          opacity: onTap == null && !busy ? 0.45 : 1,
          child: Material(
            color: bg,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: onTap,
              child: SizedBox(
                width: 48,
                height: 48,
                child: busy ? Padding(padding: const EdgeInsets.all(13), child: CircularProgressIndicator(strokeWidth: 3, color: ink)) : Icon(icon, size: 22, color: ink),
              ),
            ),
          ),
        ),
      );
}

class _SystemLine extends StatelessWidget {
  const _SystemLine(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.center,
        child: Container(
          constraints: const BoxConstraints(maxWidth: 320),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(color: C.sand, borderRadius: BorderRadius.circular(16)),
          child: Text(text, textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w800, h: 1.35)),
        ),
      );
}

double _bubbleWidth(BuildContext context, double cap) => math.min(cap, MediaQuery.sizeOf(context).width * 0.8);

class _CustomerBubble extends StatelessWidget {
  const _CustomerBubble({required this.message, required this.onOpen});

  final SupportMessage message;
  final Future<void> Function(SupportAttachment a) onOpen;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: _bubbleWidth(context, 300)),
          child: Container(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
            decoration: const BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.only(topLeft: Radius.circular(22), topRight: Radius.circular(22), bottomLeft: Radius.circular(22), bottomRight: Radius.circular(6))),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (message.text.isNotEmpty) Text(message.text, style: t(15, w: FontWeight.w600, h: 1.55)),
              if (message.attachments.isNotEmpty) Padding(padding: EdgeInsets.only(top: message.text.isEmpty ? 0 : 10), child: _Attachments(items: message.attachments, onOpen: onOpen)),
              const SizedBox(height: 8),
              Text(message.createdAt == null ? 'You' : 'You · ${supClock(message.createdAt!)}', textAlign: TextAlign.right, style: t(14, color: C.muted, w: FontWeight.w700)),
            ]),
          ),
        ),
      );
}

class _SupportBubble extends StatelessWidget {
  const _SupportBubble({required this.message, required this.onOpen});

  final SupportMessage message;
  final Future<void> Function(SupportAttachment a) onOpen;

  /// "Hello Fraands" -> "HF"
  static String get _initials => Brand.name.split(' ').where((w) => w.isNotEmpty).map((w) => w[0].toUpperCase()).take(2).join();

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: _bubbleWidth(context, 310)),
          child: Container(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
            decoration: BoxDecoration(
              color: C.white,
              border: Border.all(color: C.line),
              borderRadius: const BorderRadius.only(topLeft: Radius.circular(22), topRight: Radius.circular(22), bottomLeft: Radius.circular(6), bottomRight: Radius.circular(22)),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(message.authorName.isEmpty ? '${Brand.name} Support' : message.authorName, style: t(14, color: C.peacock, w: FontWeight.w800)),
              ),
              if (message.text.isNotEmpty) Text(message.text, style: t(15, w: FontWeight.w600, h: 1.55)),
              if (message.attachments.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: _Attachments(items: message.attachments, onOpen: onOpen)),
              if (message.signature.isNotEmpty) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.only(top: 10),
                  decoration: const BoxDecoration(border: Border(top: BorderSide(color: Color(0xFFF1E3D6)))),
                  child: Row(children: [
                    Container(
                      width: 34,
                      height: 34,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: C.goldtint, borderRadius: BorderRadius.circular(10)),
                      child: Text(_initials, style: supTitle(14, color: C.amber)),
                    ),
                    const SizedBox(width: 10),
                    Expanded(child: Text(message.signature, key: const Key('support-signature'), style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4))),
                  ]),
                ),
              ],
              const SizedBox(height: 8),
              if (message.createdAt != null) Text(supStampDot(message.createdAt!), style: t(14, color: C.muted, w: FontWeight.w700)),
            ]),
          ),
        ),
      );
}

class _Attachments extends StatelessWidget {
  const _Attachments({required this.items, required this.onOpen});

  final List<SupportAttachment> items;
  final Future<void> Function(SupportAttachment a) onOpen;

  @override
  Widget build(BuildContext context) => Wrap(spacing: 8, runSpacing: 8, children: [
        for (final a in items)
          Semantics(
            button: true,
            label: 'Open ${a.name}',
            child: Material(
              color: C.white,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                key: Key('attachment-${a.id}'),
                borderRadius: BorderRadius.circular(12),
                onTap: () => unawaited(onOpen(a)),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 48, maxWidth: 230),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(a.isImage ? Icons.image_rounded : Icons.picture_as_pdf_rounded, size: 18, color: C.lav),
                      const SizedBox(width: 6),
                      Flexible(child: Text(a.name.isEmpty ? 'Attachment' : a.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.lav, w: FontWeight.w800))),
                    ]),
                  ),
                ),
              ),
            ),
          ),
      ]);
}

/// Opens an attachment inside the app: a picture in the viewer, anything else (a PDF) through the phone's share sheet (open in a PDF
/// app, save to Drive or Files). The file needs the sign-in, so it is fetched through the API client first.
Future<void> openSupportAttachment(BuildContext context, SupportRepo repo, SupportAttachment a) async {
  if (a.isImage) {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => SupportImageViewer(title: a.name, bytes: () => repo.attachmentBytes(a.id)),
    ));
    return;
  }
  try {
    final bytes = await repo.attachmentBytes(a.id);
    final safe = (a.name.isEmpty ? 'attachment-${a.id}' : a.name).replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    final file = File('${Directory.systemTemp.path}/support-$safe');
    await file.writeAsBytes(bytes, flush: true);
    await Share.shareXFiles([XFile(file.path, mimeType: a.isPdf ? 'application/pdf' : (a.contentType.isEmpty ? null : a.contentType))], subject: a.name);
  } on ApiException catch (e) {
    if (context.mounted) toast(context, e.isOffline ? e.userMessage : 'We could not get that file. Please try again in a little while.');
  } catch (_) {
    if (context.mounted) toast(context, 'We could not open that file. Please try again.');
  }
}

/// Full-screen picture viewer (pinch to zoom). Loads the picture through the API client because it needs the sign-in.
class SupportImageViewer extends StatefulWidget {
  const SupportImageViewer({super.key, required this.title, required this.bytes});

  final String title;
  final Future<List<int>> Function() bytes;

  @override
  State<SupportImageViewer> createState() => _SupportImageViewerState();
}

class _SupportImageViewerState extends State<SupportImageViewer> {
  Uint8List? _data;
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final b = await widget.bytes();
      if (mounted) setState(() => _data = Uint8List.fromList(b));
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    return Scaffold(
      backgroundColor: C.cinema,
      appBar: AppBar(
        backgroundColor: C.cinema,
        foregroundColor: C.white,
        title: Text(widget.title.isEmpty ? 'Picture' : widget.title, style: t(16, color: C.white), overflow: TextOverflow.ellipsis),
      ),
      body: Center(
        child: data != null
            ? InteractiveViewer(
                maxScale: 5,
                child: Image.memory(data, fit: BoxFit.contain, errorBuilder: (_, __, ___) => Text('We could not show this picture.', style: t(16, color: C.white, w: FontWeight.w700))),
              )
            : _error != null
                ? Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Text(_error is ApiException ? (_error as ApiException).userMessage : 'We could not load this picture.', textAlign: TextAlign.center, style: t(16, color: C.white, w: FontWeight.w700)),
                      const SizedBox(height: 14),
                      SupSolidButton(label: 'Try again', color: C.marigold, onTap: () => unawaited(_load())),
                    ]),
                  )
                : const CircularProgressIndicator(color: C.white),
      ),
    );
  }
}
