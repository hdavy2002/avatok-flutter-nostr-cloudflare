import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import 'ava_calendar_service.dart';
import 'calendar_models.dart';

/// Action sheets for the AVA calendar cards: New meeting, Block focus, New
/// reminder, and the Email-invite composer. Each create-sheet returns a
/// [CreatedResult] (or null if dismissed) that the calling card turns into an
/// [AvaResultCard] confirmation chip. All writes go through [AvaCalendarService]
/// → Strata `GOOGLECALENDAR_CREATE_EVENT` / `GMAIL_SEND_EMAIL`.

/// Outcome of a successful create-sheet, used to render the confirmation card.
class CreatedResult {
  final CalEvent event;
  final String lead; // the AVA sentence for the result card
  final String calendarLabel; // e.g. "hdavy2002@gmail.com · PRIMARY"
  final int guestCount;
  final bool invited;
  final bool canEmailInvite;
  final String inviteTo;
  final String inviteSubject;
  final String inviteBody;
  const CreatedResult({
    required this.event,
    required this.lead,
    required this.calendarLabel,
    this.guestCount = 0,
    this.invited = false,
    this.canEmailInvite = false,
    this.inviteTo = '',
    this.inviteSubject = '',
    this.inviteBody = '',
  });
}

// ── public entry points ──────────────────────────────────────────────────────

Future<CreatedResult?> showNewMeetingSheet(BuildContext context,
    {required AvaCalendarService service, required CalDay day}) {
  return _show(context, _SheetForm(service: service, day: day, kind: _Kind.meeting));
}

Future<CreatedResult?> showBlockFocusSheet(BuildContext context,
    {required AvaCalendarService service, required CalDay day}) {
  return _show(context, _SheetForm(service: service, day: day, kind: _Kind.focus));
}

Future<CreatedResult?> showReminderSheet(BuildContext context,
    {required AvaCalendarService service, required CalDay day}) {
  return _show(context, _SheetForm(service: service, day: day, kind: _Kind.reminder));
}

Future<void> showEmailInviteSheet(BuildContext context,
    {required AvaCalendarService service, required CreatedResult result}) async {
  await _show<void>(context, _EmailInviteSheet(service: service, result: result));
}

Future<T?> _show<T>(BuildContext context, Widget child) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    barrierColor: Zine.ink.withValues(alpha: 0.35),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r)),
    ),
    builder: (ctx) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
      child: FractionallySizedBox(heightFactor: 0.92, child: child),
    ),
  );
}

enum _Kind { meeting, focus, reminder }

// ── create form (meeting / focus / reminder share one form) ──────────────────

class _SheetForm extends StatefulWidget {
  final AvaCalendarService service;
  final CalDay day;
  final _Kind kind;
  const _SheetForm({required this.service, required this.day, required this.kind});
  @override
  State<_SheetForm> createState() => _SheetFormState();
}

class _SheetFormState extends State<_SheetForm> {
  late final TextEditingController _title;
  final _guest = TextEditingController();
  final _notes = TextEditingController();
  late int _startMin; // minutes from midnight
  late int _endMin;
  final List<String> _guests = [];
  bool _video = false;
  late String _calId;
  int _notify = 10; // minutes before; -1 == AT TIME
  bool _busy = false;

  bool get _isReminder => widget.kind == _Kind.reminder;
  bool get _isMeeting => widget.kind == _Kind.meeting;

  @override
  void initState() {
    super.initState();
    _title = TextEditingController(
        text: widget.kind == _Kind.focus ? 'Focus block' : '');
    // Default to the next half-hour, 30-min block.
    final now = DateTime.now();
    final base = (now.hour * 60 + now.minute);
    _startMin = (((base ~/ 30) + 1) * 30) % (24 * 60);
    _endMin = (_startMin + 30) % (24 * 60);
    final primary = widget.day.sources.where((s) => s.primary);
    _calId = primary.isNotEmpty
        ? primary.first.id
        : (widget.day.sources.isNotEmpty ? widget.day.sources.first.id : 'primary');
  }

  @override
  void dispose() {
    _title.dispose();
    _guest.dispose();
    _notes.dispose();
    super.dispose();
  }

  String get _heading => switch (widget.kind) {
        _Kind.meeting => 'New meeting',
        _Kind.focus => 'Block focus time',
        _Kind.reminder => 'New reminder',
      };

  String get _cta => switch (widget.kind) {
        _Kind.meeting => _guests.isEmpty ? 'Create event' : 'Create & invite ${_guests.length}',
        _Kind.focus => 'Create event',
        _Kind.reminder => 'Set reminder',
      };

  DateTime _at(int minutes) {
    final d = widget.day.date;
    return DateTime(d.year, d.month, d.day, minutes ~/ 60, minutes % 60);
  }

  void _addGuest() {
    final e = _guest.text.trim();
    if (e.isEmpty || !e.contains('@')) return;
    if (!_guests.contains(e)) setState(() => _guests.add(e));
    _guest.clear();
  }

  Future<void> _submit() async {
    final title = _title.text.trim().isEmpty
        ? (_isReminder ? 'Reminder' : 'Untitled')
        : _title.text.trim();
    setState(() => _busy = true);

    final start = _at(_startMin);
    final duration = _isReminder
        ? 0
        : ((_endMin - _startMin) <= 0 ? 30 : (_endMin - _startMin));

    final out = await widget.service.createEvent(
      calendarId: _calId,
      title: title,
      start: start,
      durationMinutes: _isReminder ? 0 : duration,
      attendees: _isMeeting ? _guests : const [],
      withVideo: _isMeeting && _video,
      notify: _isMeeting && _guests.isNotEmpty,
      description: _notes.text.trim().isEmpty ? null : _notes.text.trim(),
      reminderMinutes: _notify < 0 ? 0 : _notify,
    );
    if (!mounted) return;
    setState(() => _busy = false);

    if (out.state == CalState.needsConnect) {
      _snack('Connect Google Calendar first, then try again.');
      return;
    }
    if (out.state != CalState.ok || out.event == null) {
      _snack(out.message ?? 'Couldn\'t create that — try again.');
      return;
    }

    final calLabel = _calLabel();
    final lead = switch (widget.kind) {
      _Kind.meeting => _guests.isEmpty
          ? 'Done — “$title” is on your calendar.'
          : 'Done — “$title” is on your calendar. I emailed the invite to '
              '${_guests.length} guest${_guests.length == 1 ? '' : 's'}.',
      _Kind.focus => 'Done — I blocked “$title” on your calendar.',
      _Kind.reminder => 'Done — I\'ll remind you about “$title”.',
    };

    Navigator.of(context).pop(CreatedResult(
      event: out.event!,
      lead: lead,
      calendarLabel: calLabel,
      guestCount: _isMeeting ? _guests.length : 0,
      invited: _isMeeting && _guests.isNotEmpty,
      canEmailInvite: _isMeeting && _guests.isNotEmpty,
      inviteTo: _guests.isNotEmpty ? _guests.first : '',
      inviteSubject: 'Invite: $title',
      inviteBody: _inviteBody(title, start, duration),
    ));
  }

  String _inviteBody(String title, DateTime start, int duration) {
    final when = '${_weekday(start)}, ${_month(start)} ${start.day}, ${start.year} · '
        '${_t12(_startMin)}–${_t12(_endMin)}';
    return 'You\'re invited to “$title”.\n\nWhen: $when'
        '${_video ? '\nJoin: (video link in the calendar invite)' : ''}'
        '\n\nHope you can make it!';
  }

  String _calLabel() {
    for (final s in widget.day.sources) {
      if (s.id == _calId) {
        return s.primary ? '${s.title} · PRIMARY' : s.title;
      }
    }
    return _calId;
  }

  void _snack(String m) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      _SheetHeader(title: _heading, onClose: () => Navigator.of(context).maybePop()),
      Expanded(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 8),
          children: [
            ZineField(
              controller: _title,
              hint: _isReminder ? 'Remind me to…' : 'Add a title',
              autofocus: !_isReminder,
              textCapitalization: TextCapitalization.sentences,
            ),
            const SizedBox(height: 18),
            _label('WHEN'),
            const SizedBox(height: 9),
            _dateRow(),
            if (!_isReminder) ...[
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: _timeDropdown(true)),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: PhosphorIcon(PhosphorIcons.arrowRight(PhosphorIconsStyle.bold), size: 16, color: Zine.ink),
                ),
                Expanded(child: _timeDropdown(false)),
              ]),
            ],
            if (_isMeeting) ...[
              const SizedBox(height: 18),
              _label('GUESTS'),
              const SizedBox(height: 9),
              if (_guests.isNotEmpty) ...[
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final g in _guests) _guestChip(g),
                ]),
                const SizedBox(height: 10),
              ],
              Row(children: [
                Expanded(
                  child: ZineField(
                    controller: _guest,
                    hint: 'Name or email',
                    keyboardType: TextInputType.emailAddress,
                    onSubmitted: (_) => _addGuest(),
                  ),
                ),
                const SizedBox(width: 10),
                ZinePressable(
                  onTap: _addGuest,
                  color: Zine.lime,
                  radius: BorderRadius.circular(100),
                  child: const SizedBox(
                    width: 52, height: 52,
                    child: Center(child: Icon(Icons.add, size: 24, color: Zine.ink)),
                  ),
                ),
              ]),
              const SizedBox(height: 16),
              _videoToggle(),
            ],
            const SizedBox(height: 18),
            _label('ADD TO CALENDAR'),
            const SizedBox(height: 9),
            for (final s in widget.day.sources) ...[
              _calRadio(s),
              const SizedBox(height: 8),
            ],
            const SizedBox(height: 12),
            _label('NOTIFY ME'),
            const SizedBox(height: 9),
            Wrap(spacing: 8, runSpacing: 8, children: [
              _notifyChip('AT TIME', -1),
              _notifyChip('10 MIN', 10),
              _notifyChip('30 MIN', 30),
              _notifyChip('1 HOUR', 60),
              _notifyChip('1 DAY', 1440),
            ]),
            const SizedBox(height: 18),
            _label(_isMeeting ? 'NOTES FOR GUESTS' : 'DETAILS'),
            const SizedBox(height: 9),
            ZineField(
              controller: _notes,
              hint: 'Add an agenda, address, or anything else…',
              maxLines: 3,
              textCapitalization: TextCapitalization.sentences,
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
      _footer(),
    ]);
  }

  Widget _footer() => Container(
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        child: SafeArea(
          top: false,
          child: ZineButton(
            label: _cta,
            fullWidth: true,
            loading: _busy,
            trailingIcon: false,
            icon: _isReminder
                ? PhosphorIcons.check(PhosphorIconsStyle.bold)
                : (_isMeeting && _guests.isNotEmpty
                    ? PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill)
                    : PhosphorIcons.check(PhosphorIconsStyle.bold)),
            onPressed: _busy ? null : _submit,
          ),
        ),
      );

  Widget _label(String s) => Text(s, style: ZineText.kicker());

  Widget _dateRow() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(Zine.rField),
          border: Zine.border,
          boxShadow: Zine.shadowSm,
        ),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold), size: 18, color: Zine.ink),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '${_weekday(widget.day.date)}, ${_month(widget.day.date)} '
              '${widget.day.date.day}, ${widget.day.date.year}',
              style: ZineText.input(size: 16),
            ),
          ),
          Text(_relLabel(widget.day.date), style: ZineText.link(size: 13, color: Zine.mintInk)),
        ]),
      );

  Widget _timeDropdown(bool isStart) {
    final value = isStart ? _startMin : _endMin;
    return ZineDropdown<int>(
      value: value,
      items: [
        for (var m = 0; m < 24 * 60; m += 30)
          DropdownMenuItem(value: m, child: Text(_t12(m), style: ZineText.input(size: 16))),
      ],
      onChanged: (m) {
        if (m == null) return;
        setState(() {
          if (isStart) {
            _startMin = m;
            if (_endMin <= _startMin) _endMin = (_startMin + 30) % (24 * 60);
          } else {
            _endMin = m;
          }
        });
      },
    );
  }

  Widget _guestChip(String g) => Container(
        padding: const EdgeInsets.fromLTRB(12, 7, 8, 7),
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(100),
          border: Zine.border,
          boxShadow: Zine.shadowXs,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          _avatar(g),
          const SizedBox(width: 8),
          Text(g.split('@').first, style: ZineText.value(size: 13, weight: FontWeight.w700)),
          const SizedBox(width: 6),
          GestureDetector(
            onTap: () => setState(() => _guests.remove(g)),
            child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 14, color: Zine.inkSoft),
          ),
        ]),
      );

  Widget _avatar(String g) {
    final init = g.trim().isEmpty ? '?' : g.trim()[0].toUpperCase();
    return Container(
      width: 22, height: 22,
      decoration: BoxDecoration(
        shape: BoxShape.circle, color: Zine.blue, border: Border.all(color: Zine.ink, width: 1.5),
      ),
      alignment: Alignment.center,
      child: Text(init, style: ZineText.tag(size: 11)),
    );
  }

  Widget _videoToggle() => GestureDetector(
        onTap: () => setState(() => _video = !_video),
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: _video ? Zine.blue : Zine.card,
            borderRadius: BorderRadius.circular(Zine.rField),
            border: Zine.border,
            boxShadow: Zine.shadowSm,
          ),
          child: Row(children: [
            PhosphorIcon(PhosphorIcons.videoCamera(PhosphorIconsStyle.fill), size: 22, color: Zine.ink),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('AvaTOK video call', style: ZineText.value(size: 14, weight: FontWeight.w800)),
                Text('Adds a join link to the invite', style: ZineText.sub(size: 11.5, color: Zine.inkSoft)),
              ]),
            ),
            ZineToggle(value: _video, onChanged: (v) => setState(() => _video = v)),
          ]),
        ),
      );

  Widget _calRadio(CalSource s) {
    final selected = s.id == _calId;
    return GestureDetector(
      onTap: () => setState(() => _calId = s.id),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
        decoration: BoxDecoration(
          color: Zine.card,
          borderRadius: BorderRadius.circular(Zine.rField),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: selected ? Zine.shadowSm : null,
        ),
        child: Row(children: [
          Container(
            width: 13, height: 13,
            decoration: BoxDecoration(shape: BoxShape.circle, color: s.color, border: Border.all(color: Zine.ink, width: 1.5)),
          ),
          const SizedBox(width: 11),
          Expanded(child: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis,
              style: ZineText.value(size: 14, weight: FontWeight.w700))),
          if (s.primary || s.shared) ...[
            ZineSticker(s.primary ? 'PRIMARY' : 'SHARED', kind: ZineStickerKind.hint),
            const SizedBox(width: 10),
          ],
          _radioDot(selected),
        ]),
      ),
    );
  }

  Widget _radioDot(bool on) => Container(
        width: 24, height: 24,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: on ? Zine.lime : Zine.card,
          border: Border.all(color: Zine.ink, width: Zine.bw),
        ),
        child: on ? const Icon(Icons.check, size: 15, color: Zine.ink) : null,
      );

  Widget _notifyChip(String label, int minutes) =>
      ZineChip(label: label, active: _notify == minutes, onTap: () => setState(() => _notify = minutes));
}

// ── email invite sheet ───────────────────────────────────────────────────────

class _EmailInviteSheet extends StatefulWidget {
  final AvaCalendarService service;
  final CreatedResult result;
  const _EmailInviteSheet({required this.service, required this.result});
  @override
  State<_EmailInviteSheet> createState() => _EmailInviteSheetState();
}

class _EmailInviteSheetState extends State<_EmailInviteSheet> {
  late final TextEditingController _body;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _body = TextEditingController(text: widget.result.inviteBody);
  }

  @override
  void dispose() {
    _body.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    setState(() => _busy = true);
    final ok = await widget.service.sendInvite(
      to: widget.result.inviteTo,
      subject: widget.result.inviteSubject,
      body: _body.text.trim(),
    );
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(ok ? 'Invite sent ✓' : 'Couldn\'t send — is Gmail connected?')),
    );
    if (ok) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.result;
    return Column(children: [
      _SheetHeader(title: 'Email invite', onClose: () => Navigator.of(context).maybePop(), back: true),
      Expanded(
        child: ListView(padding: const EdgeInsets.fromLTRB(18, 18, 18, 8), children: [
          _kv('TO', Container(
            padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
            decoration: BoxDecoration(
              color: Zine.card, borderRadius: BorderRadius.circular(100), border: Zine.border, boxShadow: Zine.shadowXs,
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 22, height: 22,
                decoration: BoxDecoration(shape: BoxShape.circle, color: Zine.blue, border: Border.all(color: Zine.ink, width: 1.5)),
                alignment: Alignment.center,
                child: Text(r.inviteTo.isEmpty ? '?' : r.inviteTo[0].toUpperCase(), style: ZineText.tag(size: 11)),
              ),
              const SizedBox(width: 8),
              Text(r.inviteTo, style: ZineText.value(size: 13.5, weight: FontWeight.w700)),
            ]),
          )),
          const SizedBox(height: 14),
          _kv('SUBJ', Text(r.inviteSubject, style: ZineText.cardTitle(size: 16))),
          const Divider(height: 28, thickness: Zine.bw, color: Zine.ink),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Zine.card, borderRadius: BorderRadius.circular(Zine.rSm), border: Zine.border, boxShadow: Zine.shadowSm,
            ),
            child: TextField(
              controller: _body,
              maxLines: 9,
              style: ZineText.input(size: 15),
              decoration: const InputDecoration(border: InputBorder.none, isDense: true),
            ),
          ),
        ]),
      ),
      Container(
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
        decoration: const BoxDecoration(
          color: Zine.paper2, border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        child: SafeArea(
          top: false,
          child: ZineButton(
            label: 'Send invite',
            fullWidth: true,
            loading: _busy,
            trailingIcon: false,
            icon: PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
            onPressed: _busy ? null : _send,
          ),
        ),
      ),
    ]);
  }

  Widget _kv(String k, Widget v) => Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
        SizedBox(width: 44, child: Text(k, style: ZineText.kicker())),
        const SizedBox(width: 8),
        Expanded(child: v),
      ]);
}

// ── shared sheet header ──────────────────────────────────────────────────────

class _SheetHeader extends StatelessWidget {
  final String title;
  final VoidCallback onClose;
  final bool back;
  const _SheetHeader({required this.title, required this.onClose, this.back = false});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 18, 12),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: Row(children: [
        ZineBackButton(
          icon: back
              ? PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold)
              : PhosphorIcons.x(PhosphorIconsStyle.bold),
          onTap: onClose,
        ),
        const SizedBox(width: 12),
        Expanded(child: Text(title, style: ZineText.cardTitle(size: 20))),
        Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 14, color: Zine.ink),
          const SizedBox(width: 5),
          Text('AVA', style: ZineText.tag(size: 11, color: Zine.inkSoft)),
        ]),
      ]),
    );
  }
}

// ── date helpers (no intl) ───────────────────────────────────────────────────

const _wdFull = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const _moFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

String _weekday(DateTime d) => _wdFull[d.weekday - 1];
String _month(DateTime d) => _moFull[d.month - 1];

String _relLabel(DateTime d) {
  final now = DateTime.now();
  final diff = DateTime(d.year, d.month, d.day).difference(DateTime(now.year, now.month, now.day)).inDays;
  if (diff == 0) return 'TODAY';
  if (diff == 1) return 'TOMORROW';
  return '';
}

String _t12(int minutes) {
  final h24 = (minutes ~/ 60) % 24;
  final m = minutes % 60;
  final ap = h24 < 12 ? 'AM' : 'PM';
  var h = h24 % 12;
  if (h == 0) h = 12;
  return '$h:${m.toString().padLeft(2, '0')} $ap';
}
