import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import '../../core/analytics.dart';
import '../avadial/avadial_theme.dart';
import 'virtual_number_activity_screen.dart';
import 'virtual_number_add_screen.dart';
import 'virtual_number_settings_screen.dart';
import 'virtual_numbers_api.dart';
import 'virtual_numbers_demo.dart';
import 'virtual_numbers_models.dart';
import 'virtual_numbers_store.dart';
import 'virtual_numbers_widgets.dart';

/// Integration entry point for the sidebar's **Virtual Numbers** destination.
/// It intentionally owns no shell/navigation concerns; hosts may push this
/// widget from either legacy shell or Shell V2.
class VirtualNumbersScreen extends StatefulWidget {
  const VirtualNumbersScreen({super.key, this.api, this.store});
  final VirtualNumbersApi? api;
  final VirtualNumbersStore? store;
  @override
  State<VirtualNumbersScreen> createState() => _VirtualNumbersScreenState();
}

class _VirtualNumbersScreenState extends State<VirtualNumbersScreen> {
  late final VirtualNumbersStore _store =
      widget.store ?? VirtualNumbersStore(api: widget.api);
  late final VirtualNumbersApi _api = _store.api;
  List<VirtualLine> _lines = const [];
  bool _loading = true;
  String? _error;
  bool _demoMode = false;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('virtual_numbers', 'list');
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final lines = await _api.listLines();
      final reconciled = await _store.reconcileDefault(lines);
      if (mounted)
        setState(() {
          _lines = reconciled;
          _loading = false;
        });
      Analytics.capture(
          'virtual_numbers_opened', {'line_count': reconciled.length});
    } catch (e) {
      if (mounted)
        setState(() {
          _loading = false;
          _error = null;
          _demoMode = true;
          _lines = VirtualNumbersDemo.lines;
        });
    }
  }

  Future<void> _add() async {
    if (_demoMode) {
      _message(
          'Demo mode · no number was purchased and no tokens were charged.');
      return;
    }
    final added = await Navigator.of(context).push<VirtualLine>(
        MaterialPageRoute(builder: (_) => VirtualNumberAddScreen(api: _api)));
    if (added != null && mounted) await _load();
  }

  Future<void> _open(VirtualLine line) async {
    Analytics.capture(
        'virtual_number_activity_opened', {'line_kind': line.kind.name});
    await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => VirtualNumberActivityScreen(
            line: line, api: _api, demoMode: _demoMode)));
    if (mounted) _load();
  }

  Future<void> _settings(VirtualLine line) async {
    await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) =>
            VirtualNumberSettingsScreen(line: line, api: _api, store: _store)));
    if (mounted) _load();
  }

  Future<void> _makeDefault(VirtualLine line) async {
    if (!line.isDid || !line.isActive || !line.can('outbound_caller_id')) {
      _message('This line cannot be used as a PSTN caller ID.');
      return;
    }
    try {
      await _api.setDefaultOutgoing(line.id);
      await _store.saveDefaultDidId(line.id);
      if (mounted)
        setState(() => _lines = _lines
            .map((item) => item.copyWith(isDefaultOutgoing: item.id == line.id))
            .toList());
    } catch (e) {
      _message(e.toString());
    }
  }

  Future<void> _toggleSuspend(VirtualLine line) async {
    try {
      if (line.status == VirtualLineStatus.suspended) {
        await _api.resume(line.id);
      } else {
        await _api.suspend(line.id);
      }
      await _load();
    } catch (e) {
      _message(e.toString());
    }
  }

  void _message(String message) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(message)));

  @override
  Widget build(BuildContext context) => VirtualNumbersUi.shell(
        title: 'Virtual Numbers',
        actions: [
          IconButton(
              onPressed: _loading ? null : _load,
              icon: Icon(PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular)),
              tooltip: 'Refresh numbers')
        ],
        child: RefreshIndicator(onRefresh: _load, child: _body()),
      );

  Widget _body() {
    if (_loading && _lines.isEmpty)
      return const Center(child: CircularProgressIndicator());
    if (_error != null && _lines.isEmpty)
      return ListView(children: [
        const SizedBox(height: 120),
        Center(child: Text('Could not load your numbers')),
        Padding(
            padding: const EdgeInsets.all(16),
            child: VirtualNumbersUi.primaryButton(
                label: 'Try again', onPressed: _load, icon: PhosphorIcons.arrowClockwise(PhosphorIconsStyle.regular)))
      ]);
    return ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
        children: [
          if (_demoMode) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AvaDialTheme.unknown.withValues(alpha: .12),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AvaDialTheme.unknown),
              ),
              child: Row(children: [
                Icon(PhosphorIcons.eye(PhosphorIconsStyle.regular),
                    color: AvaDialTheme.unknown),
                const SizedBox(width: 10),
                Expanded(
                    child: Text(
                  'Sponsor demo · sample data only. No calls, purchases or token charges are made.',
                  style: AvaDialTheme.sub(size: 12),
                )),
              ]),
            ),
            const SizedBox(height: 12),
          ],
          Text('Your lines · ${_lines.length}',
              style: AvaDialTheme.tag(size: 11, color: AvaDialTheme.textMute)),
          const SizedBox(height: 10),
          if (_lines.isEmpty)
            _empty()
          else
            ..._lines.map((line) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _card(line))),
          const SizedBox(height: 4),
          Center(
              child: OutlinedButton.icon(
                  onPressed: _add,
                  icon: Icon(PhosphorIcons.plus(PhosphorIconsStyle.regular)),
                  label: const Text('Add new number'),
                  style: OutlinedButton.styleFrom(
                      side:
                          BorderSide(color: AvaDialTheme.textSoft, width: 1.5),
                      foregroundColor: AvaDialTheme.text))),
          const SizedBox(height: 14),
          Text(
              'AvaTOK numbers work in-network. DID numbers can receive calls and SMS where supported.',
              style: AvaDialTheme.sub(size: 12)),
        ]);
  }

  Widget _empty() => Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
          color: AvaDialTheme.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AvaDialTheme.border)),
      child: Column(children: [
        Icon(PhosphorIcons.phoneCall(PhosphorIconsStyle.regular), size: 40),
        const SizedBox(height: 10),
        Text('No virtual numbers yet', style: AvaDialTheme.value()),
        const SizedBox(height: 6),
        Text('Add a free AvaTOK alias or rent a DID for PSTN calls.',
            textAlign: TextAlign.center, style: AvaDialTheme.sub()),
        const SizedBox(height: 14),
        VirtualNumbersUi.primaryButton(
            label: 'Add a number', onPressed: _add, icon: PhosphorIcons.plus(PhosphorIconsStyle.regular))
      ]));

  Widget _card(VirtualLine line) => Semantics(
        label:
            '${line.label}, ${line.displayNumber}, ${line.typeLabel}, ${line.statusLabel}${line.unreadCount > 0 ? ', ${line.unreadCount} unread' : ''}',
        button: true,
        child: Material(
            color: virtualLineColor(line.colorKey),
            borderRadius: BorderRadius.circular(16),
            child: InkWell(
              onTap: () => _open(line),
              borderRadius: BorderRadius.circular(16),
              child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(children: [
                    VirtualLineAvatar(line: line),
                    const SizedBox(width: 12),
                    Expanded(
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                          Text(line.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AvaDialTheme.value(
                                  color: Colors.white, size: 16)),
                          const SizedBox(height: 3),
                          Text(line.displayNumber,
                              style: AvaDialTheme.tag(
                                  color: Colors.white.withValues(alpha: .82))),
                          const SizedBox(height: 7),
                          Row(children: [
                            VirtualNumbersUi.lineTypeChip(line),
                            const SizedBox(width: 6),
                            if (line.isDefaultOutgoing)
                              AvaDialTheme.chip('Default outgoing',
                                  color: Colors.white, icon: PhosphorIcons.phoneOutgoing(PhosphorIconsStyle.regular))
                          ]),
                        ])),
                    if (line.unreadCount > 0)
                      Padding(
                          padding: const EdgeInsets.only(right: 7),
                          child: CircleAvatar(
                              radius: 12,
                              backgroundColor: AvaDialTheme.unknown,
                              child: Text('${line.unreadCount}',
                                  style:
                                      AvaDialTheme.tag(color: Colors.white)))),
                    PopupMenuButton<String>(
                        tooltip: 'Options for ${line.label}',
                        iconColor: Colors.white,
                        onSelected: (value) {
                          switch (value) {
                            case 'settings':
                              _settings(line);
                            case 'default':
                              _makeDefault(line);
                            case 'suspend':
                              _toggleSuspend(line);
                          }
                        },
                        itemBuilder: (_) => [
                              const PopupMenuItem(
                                  value: 'settings', child: Text('Settings')),
                              if (line.isDid && !line.isDefaultOutgoing)
                                const PopupMenuItem(
                                    value: 'default',
                                    child: Text('Make default outgoing')),
                              if (line.isDid &&
                                  line.status != VirtualLineStatus.released)
                                PopupMenuItem(
                                    value: 'suspend',
                                    child: Text(line.status ==
                                            VirtualLineStatus.suspended
                                        ? 'Resume'
                                        : 'Suspend'))
                            ]),
                    Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.regular), color: Colors.white),
                  ])),
            )),
      );
}
