import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/merch_art_picker.dart';
import '../../data/models/support.dart';
import '../../data/repos/support_repo.dart';
import '../../data/services.dart';
import '../desi.dart';
import '../support_kit.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-SUPPORT-APP] Contact Support, route `/support` (`?topic=report` preselects a topic). Built to the owner-approved mock-up
/// "AppSupport" (2026-10-29): topic chips, Subject, the message, Add a screenshot, SEND TO SUPPORT, then My tickets.
/// Every send becomes a ticket on the server (`POST /api/hf/support/tickets`); the app version and phone details go along.
class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key, this.initialTopic, this.repo, this.pick});

  /// A topic slug (`calls`, `wallet`, `withdraw`, `bookings`, `influencer`, `app`, `report`, `other`).
  final String? initialTopic;

  /// Tests pass their own; the app uses `Services.instance.supportRepo`.
  final SupportRepo? repo;

  /// Tests replace the picture chooser.
  final Future<PickedArt?> Function()? pick;

  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  final TextEditingController _subject = TextEditingController();
  final TextEditingController _message = TextEditingController();
  final List<SupportDraft> _files = <SupportDraft>[];

  late String _topic;
  bool _busy = false;
  String? _error;
  SupportTicket? _sent;

  List<SupportTicket>? _tickets;
  Object? _ticketsError;
  bool _ticketsLoading = true;
  int _ticketsRun = 0;

  SupportRepo get _repo => widget.repo ?? Services.instance.supportRepo;

  bool get _canSend => !_busy && _subject.text.trim().length >= 3 && _message.text.trim().length >= 5;

  @override
  void initState() {
    super.initState();
    final want = widget.initialTopic;
    _topic = kSupportTopics.any((x) => x.slug == want) ? want! : 'other';
    _subject.addListener(_changed);
    _message.addListener(_changed);
    unawaited(_loadTickets());
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _subject.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _loadTickets() async {
    final run = ++_ticketsRun;
    if (mounted && _tickets == null) setState(() => _ticketsLoading = true);
    try {
      final list = await _repo.tickets();
      if (!mounted || run != _ticketsRun) return;
      setState(() {
        _tickets = list;
        _ticketsError = null;
        _ticketsLoading = false;
      });
    } catch (e) {
      if (!mounted || run != _ticketsRun) return;
      setState(() {
        _ticketsError = e;
        _ticketsLoading = false;
      });
    }
  }

  Future<void> _attach() async {
    if (_files.length >= kSupportMaxFiles) {
      toast(context, 'You can add up to $kSupportMaxFiles pictures.');
      return;
    }
    final d = await pickSupportPicture(widget.pick, (p) {
      if (mounted) setState(() => _error = p);
    });
    if (d == null || !mounted) return;
    setState(() {
      _files.add(d);
      _error = null;
    });
  }

  Future<void> _send() async {
    if (!_canSend) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final ids = await uploadSupportDrafts(_repo, _files);
      final meta = await supportMeta();
      final t = await _repo.create(category: _topic, subject: _subject.text, message: _message.text, attachmentIds: ids, meta: meta);
      if (!mounted) return;
      setState(() {
        _sent = t;
        _busy = false;
      });
      unawaited(_loadTickets());
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = supportErrorText(e);
      });
    }
  }

  void _another() {
    setState(() {
      _sent = null;
      _subject.clear();
      _message.clear();
      _files.clear();
      _error = null;
    });
  }

  Future<void> _openTicket(String number) async {
    await context.push<Object?>('/support/${Uri.encodeComponent(number)}');
    if (mounted) unawaited(_loadTickets());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          const SupHeader(title: 'Contact Support'),
          Expanded(
            child: RefreshIndicator(
              color: C.maroon,
              onRefresh: _loadTickets,
              child: ListView(
                key: const Key('support-list'),
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 28),
                children: [
                  _sent != null ? _sentCard(_sent!) : _formCard(),
                  const SizedBox(height: 16),
                  _ticketsCard(),
                ],
              ),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _label(String text) => Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(text, style: t(14, w: FontWeight.w800)));

  Widget _formCard() => SupCard(
        corner: DesiCorner.hibiscus,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const SupHeading('Open a ticket', sub: 'We reply by email and right here. Mon–Sat, 10 am–7 pm IST.'),
          _label('What is it about?'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final topic in kSupportTopics)
              _TopicChip(
                key: Key('topic-${topic.slug}'),
                label: topic.label,
                selected: _topic == topic.slug,
                onTap: () => setState(() => _topic = topic.slug),
              ),
          ]),
          const SizedBox(height: 16),
          _label('Subject'),
          TextField(
            key: const Key('support-subject'),
            controller: _subject,
            maxLength: 150,
            textCapitalization: TextCapitalization.sentences,
            textInputAction: TextInputAction.next,
            style: t(15, w: FontWeight.w700),
            decoration: supField(),
          ),
          const SizedBox(height: 14),
          _label('Tell us what happened'),
          TextField(
            key: const Key('support-message'),
            controller: _message,
            maxLength: 5000,
            minLines: 4,
            maxLines: 8,
            keyboardType: TextInputType.multiline,
            textCapitalization: TextCapitalization.sentences,
            style: t(15, w: FontWeight.w600, h: 1.5),
            decoration: supField(),
          ),
          const SizedBox(height: 12),
          if (_files.isNotEmpty) ...[
            SupportDraftChips(drafts: _files, onRemove: (d) => setState(() => _files.remove(d))),
            const SizedBox(height: 10),
          ],
          Semantics(
            button: true,
            child: Material(
              color: C.lavtint,
              borderRadius: BorderRadius.circular(16),
              child: InkWell(
                key: const Key('support-attach'),
                borderRadius: BorderRadius.circular(16),
                onTap: _busy ? null : _attach,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 48),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    child: Row(children: [
                      const Icon(Icons.add_photo_alternate_rounded, size: 22, color: C.lav),
                      const SizedBox(width: 10),
                      Text('Add a screenshot', style: t(14, color: C.lav, w: FontWeight.w800)),
                    ]),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text('Your app version and phone details are added for us automatically.', style: t(14, color: C.muted, w: FontWeight.w600)),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, key: const Key('support-error'), style: t(15, color: C.ruby, w: FontWeight.w700)),
          ],
          const SizedBox(height: 16),
          SupSolidButton(key: const Key('support-send'), label: 'SEND TO SUPPORT', height: 60, busy: _busy, onTap: _canSend ? _send : null),
        ]),
      );

  Widget _sentCard(SupportTicket t0) => SupCard(
        corner: DesiCorner.hibiscus,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const SupHeading('We got your message'),
          Row(children: [
            const DesiIconSquare(Icons.check_circle_rounded, tone: DesiTone.tea, size: 44),
            const SizedBox(width: 12),
            Expanded(child: Text(t0.number, key: const Key('support-sent-number'), style: supTitle(22))),
          ]),
          const SizedBox(height: 12),
          Text(supAckText(t0.number), key: const Key('support-sent-note'), style: t(15, w: FontWeight.w600, h: 1.5)),
          const SizedBox(height: 16),
          SupSolidButton(key: const Key('support-view'), label: 'VIEW TICKET', onTap: () => unawaited(_openTicket(t0.number))),
          const SizedBox(height: 4),
          Center(
            child: TextButton(
              key: const Key('support-another'),
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: _another,
              child: Text('Send another message', style: t(15, color: C.maroon, w: FontWeight.w800)),
            ),
          ),
        ]),
      );

  Widget _ticketsCard() {
    final Widget body;
    final list = _tickets;
    if (list == null && _ticketsLoading) {
      body = const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Center(child: SizedBox(width: 32, height: 32, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 4))));
    } else if (list == null) {
      final e = _ticketsError;
      body = Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Row(children: [
          Expanded(child: Text(e is ApiException ? e.userMessage : 'We could not load your tickets.', key: const Key('tickets-error'), style: t(15, color: C.muted, w: FontWeight.w700))),
          TextButton(
            onPressed: () {
              setState(() => _ticketsLoading = true);
              unawaited(_loadTickets());
            },
            child: Text('Try again', style: t(15, color: C.maroon, w: FontWeight.w800)),
          ),
        ]),
      );
    } else if (list.isEmpty) {
      body = Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Text('No tickets yet. When you contact us, your tickets show up here.', key: const Key('tickets-empty'), style: t(15, color: C.muted, w: FontWeight.w600, h: 1.5)),
      );
    } else {
      body = Column(children: [for (final k in list) _TicketRow(ticket: k, onTap: () => unawaited(_openTicket(k.number)))]);
    }
    return SupCard(
      corner: DesiCorner.yellow,
      padding: const EdgeInsets.fromLTRB(18, 20, 18, 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [const SupHeading('My tickets'), body]),
    );
  }
}

class _TopicChip extends StatelessWidget {
  const _TopicChip({super.key, required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        selected: selected,
        label: label,
        child: Material(
          color: selected ? C.maroon : C.cream,
          shape: StadiumBorder(side: BorderSide(color: selected ? C.maroon : C.line, width: 1.5)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Row(mainAxisSize: MainAxisSize.min, children: [Text(label, style: t(14, color: selected ? C.white : C.maroon, w: FontWeight.w800))]),
              ),
            ),
          ),
        ),
      );
}

class _TicketRow extends StatelessWidget {
  const _TicketRow({required this.ticket, required this.onTap});

  final SupportTicket ticket;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final (bg, ink) = SupStatusChip.colors(ticket.tone);
    final when = ticket.updatedAt == null ? '' : ' · ${supWhen(ticket.updatedAt!)}';
    return Semantics(
      button: true,
      child: InkWell(
        key: Key('ticket-${ticket.number}'),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 72),
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: const BoxDecoration(border: Border(top: BorderSide(color: Color(0xFFF1E3D6)))),
          child: Row(children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14)),
              child: Icon(Icons.confirmation_number_outlined, size: 22, color: ink),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${ticket.number}$when', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w800)),
                Text(ticket.subject.isEmpty ? supportTopicLabel(ticket.category) : ticket.subject,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: t(15, w: ticket.unread ? FontWeight.w800 : FontWeight.w700)),
              ]),
            ),
            if (ticket.unread)
              Container(key: Key('unread-${ticket.number}'), width: 10, height: 10, margin: const EdgeInsets.only(right: 8), decoration: const BoxDecoration(color: C.rani, shape: BoxShape.circle)),
            SupStatusChip(tone: ticket.tone, label: ticket.label),
          ]),
        ),
      ),
    );
  }
}
