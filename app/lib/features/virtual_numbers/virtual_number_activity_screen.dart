import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../avadial/avadial_theme.dart';
import 'virtual_numbers_api.dart';
import 'virtual_numbers_demo.dart';
import 'virtual_numbers_models.dart';
import 'virtual_numbers_widgets.dart';

class VirtualNumberActivityScreen extends StatefulWidget {
  const VirtualNumberActivityScreen(
      {super.key,
      required this.line,
      required this.api,
      this.demoMode = false});
  final VirtualLine line;
  final VirtualNumbersApi api;
  final bool demoMode;
  @override
  State<VirtualNumberActivityScreen> createState() =>
      _VirtualNumberActivityScreenState();
}

class _VirtualNumberActivityScreenState
    extends State<VirtualNumberActivityScreen> {
  VirtualActivityType _filter = VirtualActivityType.all;
  List<VirtualLineActivity> _items = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final items = widget.demoMode
          ? VirtualNumbersDemo.activity(widget.line.id)
          : await widget.api.activity(widget.line.id, filter: _filter);
      final filtered = _filter == VirtualActivityType.all
          ? items
          : items.where((item) => item.type == _filter).toList();
      if (mounted)
        setState(() {
          _items = filtered;
          _loading = false;
        });
    } catch (e) {
      if (mounted)
        setState(() {
          _loading = false;
          _error = e.toString();
        });
    }
  }

  @override
  Widget build(BuildContext context) => VirtualNumbersUi.shell(
        title: widget.line.label,
        onBack: () => Navigator.of(context).pop(),
        actions: [
          IconButton(
              onPressed: _load,
              icon: Icon(PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular)),
              tooltip: 'Refresh activity')
        ],
        child: Column(children: [
          Container(
            color: AvaDialTheme.surface,
            padding: const EdgeInsets.fromLTRB(16, 3, 16, 12),
            child: Row(children: [
              VirtualLineAvatar(line: widget.line, size: 40),
              const SizedBox(width: 10),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(widget.line.displayNumber, style: AvaDialTheme.tag()),
                    Text(
                        '${widget.line.typeLabel} · ${widget.line.statusLabel}',
                        style: AvaDialTheme.sub(size: 12)),
                  ])),
            ]),
          ),
          SizedBox(
            height: 58,
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              scrollDirection: Axis.horizontal,
              itemCount: _filters.length,
              separatorBuilder: (_, __) => const SizedBox(width: 7),
              itemBuilder: (_, index) {
                final f = _filters[index];
                final selected = f == _filter;
                return ChoiceChip(
                  label: Text(_filterLabel(f)),
                  selected: selected,
                  onSelected: (_) {
                    setState(() => _filter = f);
                    _load();
                  },
                  selectedColor: AvaDialTheme.accent,
                  labelStyle: AvaDialTheme.tag(
                      color: selected ? Colors.white : AvaDialTheme.textSoft),
                );
              },
            ),
          ),
          Expanded(child: _body()),
        ]),
      );

  List<VirtualActivityType> get _filters => const [
        VirtualActivityType.all,
        VirtualActivityType.calls,
        VirtualActivityType.recordings,
        VirtualActivityType.voicemail,
        VirtualActivityType.receptionist,
        VirtualActivityType.otp,
        VirtualActivityType.textMessages
      ];
  String _filterLabel(VirtualActivityType type) => switch (type) {
        VirtualActivityType.all => 'All',
        VirtualActivityType.calls => 'Calls',
        VirtualActivityType.recordings => 'Recordings',
        VirtualActivityType.voicemail => 'Voicemail',
        VirtualActivityType.receptionist => 'Ava receptionist',
        VirtualActivityType.otp => 'OTP',
        VirtualActivityType.textMessages => 'Text messages'
      };

  Widget _body() {
    if (_loading && _items.isEmpty)
      return const Center(child: CircularProgressIndicator());
    if (_error != null && _items.isEmpty)
      return Center(
          child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Text('Activity could not be loaded'),
                const SizedBox(height: 12),
                OutlinedButton(onPressed: _load, child: const Text('Try again'))
              ])));
    if (_items.isEmpty)
      return Center(
          child: Text('No ${_filterLabel(_filter).toLowerCase()} yet',
              style: AvaDialTheme.sub()));
    return RefreshIndicator(
        onRefresh: _load,
        child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
            itemCount: _items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (_, index) => _row(_items[index])));
  }

  Widget _row(VirtualLineActivity item) => Semantics(
      label: '${_filterLabel(item.type)}, ${item.title}, ${item.subtitle}',
      button: item.hasRecording,
      child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
              color: AvaDialTheme.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                  color:
                      item.unread ? AvaDialTheme.accent : AvaDialTheme.border,
                  width: item.unread ? 1.5 : 1)),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
                width: 38,
                height: 38,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                    color: _typeColor(item.type).withValues(alpha: .16),
                    borderRadius: BorderRadius.circular(11)),
                child: Icon(_typeIcon(item.type),
                    color: _typeColor(item.type), size: 19)),
            const SizedBox(width: 11),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Row(children: [
                    Expanded(
                        child: Text(item.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AvaDialTheme.value(size: 14))),
                    Text(_dateLabel(item.occurredAt.toLocal()),
                        style: AvaDialTheme.tag(
                            size: 10, color: AvaDialTheme.textMute))
                  ]),
                  const SizedBox(height: 4),
                  Text(
                      item.subtitle.isEmpty
                          ? _filterLabel(item.type)
                          : item.subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: AvaDialTheme.sub(size: 12)),
                  if (item.durationSeconds > 0)
                    Padding(
                        padding: const EdgeInsets.only(top: 5),
                        child: Text(
                            '${item.durationSeconds ~/ 60}m ${item.durationSeconds % 60}s · ${item.direction}',
                            style: AvaDialTheme.tag(
                                size: 10, color: AvaDialTheme.textMute))),
                  if (item.hasRecording)
                    Padding(
                        padding: const EdgeInsets.only(top: 7),
                        child: OutlinedButton.icon(
                            onPressed: () => _showRecording(item),
                            icon: Icon(PhosphorIcons.play(PhosphorIconsStyle.regular), size: 16),
                            label: const Text('Play recording'),
                            style: OutlinedButton.styleFrom(
                                visualDensity: VisualDensity.compact)))
                ])),
            if (item.unread)
              Container(
                  width: 8,
                  height: 8,
                  margin: const EdgeInsets.only(left: 7, top: 5),
                  decoration: const BoxDecoration(
                      shape: BoxShape.circle, color: AvaDialTheme.accent)),
          ])));

  void _showRecording(VirtualLineActivity item) => showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => SafeArea(
          child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Recording', style: AvaDialTheme.title()),
                    const SizedBox(height: 8),
                    Text(
                        'Playback is authorized for this line and will use the existing private recording cache.',
                        style: AvaDialTheme.sub()),
                    const SizedBox(height: 18),
                    VirtualNumbersUi.primaryButton(
                        label: 'Play',
                        onPressed: () {},
                        icon: PhosphorIcons.play(PhosphorIconsStyle.regular)),
                    const SizedBox(height: 8)
                  ]))));
  IconData _typeIcon(VirtualActivityType type) => switch (type) {
        VirtualActivityType.calls => PhosphorIcons.phone(PhosphorIconsStyle.regular),
        VirtualActivityType.recordings => PhosphorIcons.microphone(PhosphorIconsStyle.regular),
        VirtualActivityType.voicemail => PhosphorIcons.voicemail(PhosphorIconsStyle.regular),
        VirtualActivityType.receptionist => PhosphorIcons.sparkle(PhosphorIconsStyle.regular),
        VirtualActivityType.otp => PhosphorIcons.password(PhosphorIconsStyle.regular),
        VirtualActivityType.textMessages => PhosphorIcons.chatText(PhosphorIconsStyle.regular),
        VirtualActivityType.all => PhosphorIcons.clockCounterClockwise(PhosphorIconsStyle.regular)
      };
  Color _typeColor(VirtualActivityType type) => switch (type) {
        VirtualActivityType.otp => AvaDialTheme.unknown,
        VirtualActivityType.receptionist => AvaDialTheme.lilac,
        VirtualActivityType.textMessages => AvaDialTheme.contact,
        VirtualActivityType.voicemail => AvaDialTheme.spam,
        _ => AvaDialTheme.accent
      };
  String _dateLabel(DateTime value) {
    final minute = value.minute.toString().padLeft(2, '0');
    return '${value.day}/${value.month} · ${value.hour}:$minute';
  }
}
