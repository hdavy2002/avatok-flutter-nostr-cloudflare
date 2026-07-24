import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ava_ai_client.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../avabrain/brain_settings_screen.dart';

/// Private-content export sheet — [AVABRAIN-CLIENT-MEM-1] (Product Bible §6.1,
/// §9.2 `POST /api/brain/export`).
///
/// The §6.1 rule: the on-device `device_private` lane (DMs/group messages) can
/// never become server-readable AvaBrain memory silently. A cloud "remember
/// everything" mode requires EXPLICIT export consent and a clear non-E2E
/// disclosure — never a background producer. This sheet is that explicit
/// consent moment: it shows the disclosure, the exact item/char count being
/// sent, and only calls the export endpoint after the user taps Export.
///
/// STANDALONE WIDGET — intentionally NOT wired into `companion_thread.dart` or
/// `chat_thread.dart` (those files belong to other agents). Integration note
/// for whoever owns those screens:
///
/// ```dart
/// // From a message-selection action (e.g. a long-press multi-select menu):
/// final items = selectedMessages.map((m) => BrainExportItem(
///   text: m.text,
///   source: isGroup ? 'group' : 'dm', // server validates source ∈ {dm,group,note}
///   contextHint: peerOrGroupName, // human label, for the user's own reference
/// )).toList();
/// await showBrainExportSheet(context, items);
/// ```
///
/// That's the entire integration surface — this file owns the disclosure UI,
/// the confirm action, and the API call.
Future<bool> showBrainExportSheet(BuildContext context, List<BrainExportItem> items) async {
  if (items.isEmpty) return false;
  Analytics.uiInteraction('brain_export_sheet_opened', 0, extra: {'items': items.length});
  final result = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: AD.overlaySheet,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
        side: BorderSide(color: AD.borderHairline, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
    builder: (ctx) => _BrainExportSheet(items: items),
  );
  return result == true;
}

class _BrainExportSheet extends StatefulWidget {
  final List<BrainExportItem> items;
  const _BrainExportSheet({required this.items});

  @override
  State<_BrainExportSheet> createState() => _BrainExportSheetState();
}

class _BrainExportSheetState extends State<_BrainExportSheet> {
  bool _sending = false;
  String? _error;
  bool _showSettingsButton = false;

  int get _charCount => widget.items.fold(0, (sum, i) => sum + i.text.length);

  Future<void> _confirm() async {
    setState(() {
      _sending = true;
      _error = null;
      _showSettingsButton = false;
    });
    final start = DateTime.now().millisecondsSinceEpoch;
    BrainExportResult result = const BrainExportResult(ok: false, status: 0);
    try {
      result = await BrainExportApi.exportItems(widget.items);
    } catch (e, st) {
      await Analytics.captureException(e, st, screen: 'brain_export_sheet', handled: true);
    }
    final latency = DateTime.now().millisecondsSinceEpoch - start;
    await Analytics.uiInteraction('brain_export_confirmed', latency, extra: {
      'items': widget.items.length,
      'chars': _charCount,
      'ok': result.ok,
      'status': result.status,
      if (result.error != null) 'error': result.error,
    });
    if (!mounted) return;
    if (result.ok) {
      Navigator.pop(context, true);
      return;
    }
    // 403/consent_required — the user hasn't opted in to private export yet;
    // 429/daily_cap_reached — a daily export cap; anything else is generic.
    if (result.status == 403 && result.error == 'consent_required') {
      setState(() {
        _sending = false;
        _error = "Turn on 'Private export' in AvaBrain settings first.";
        _showSettingsButton = true;
      });
    } else if (result.status == 429 && result.error == 'daily_cap_reached') {
      setState(() {
        _sending = false;
        _error = 'Daily export limit reached — try tomorrow.';
        _showSettingsButton = false;
      });
    } else {
      setState(() {
        _sending = false;
        _error = 'Could not export right now. Please try again.';
        _showSettingsButton = false;
      });
    }
  }

  void _openBrainSettings() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const BrainSettingsScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 14, 20, 18 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 40),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Remember this in the cloud?', style: ADText.threadName(c: AD.textPrimary)),
              Text('${widget.items.length} message${widget.items.length == 1 ? '' : 's'} · $_charCount characters',
                  style: ADText.preview()),
            ])),
          ]),
          const SizedBox(height: 14),
          AdCard(
            color: AD.card,
            padding: const EdgeInsets.all(14),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              PhosphorIcon(PhosphorIcons.warningCircle(PhosphorIconsStyle.bold), size: 18, color: AD.iconBell),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Your messages are normally end-to-end encrypted and stay on this '
                  'device only. Exporting sends the exact text above to Ava’s '
                  'cloud so it can be remembered and recalled later — this is NOT '
                  'end-to-end encrypted once exported. Nothing else in this '
                  'conversation is sent, and you can forget any exported memory '
                  'later from AvaBrain Memory.',
                  style: ADText.preview(c: AD.textSecondary),
                ),
              ),
            ]),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: ADText.preview(c: AD.danger)),
            if (_showSettingsButton) ...[
              const SizedBox(height: 8),
              AdButton(
                label: 'Open AvaBrain Settings',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                onPressed: _openBrainSettings,
              ),
            ],
          ],
          const SizedBox(height: 18),
          Row(children: [
            Expanded(
              child: AdButton(
                label: 'Cancel',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                onPressed: _sending ? null : () => Navigator.pop(context, false),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: AdButton(
                label: 'Export',
                variant: AdButtonVariant.primary,
                fullWidth: true,
                loading: _sending,
                icon: PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold),
                onPressed: _sending ? null : _confirm,
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}
