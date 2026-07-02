import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/profile_store.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'contacts.dart';

/// Just-in-time @handle prompt. We no longer collect a handle during onboarding
/// (keeping signup to 4 screens), so the FIRST time a user enters AvaTok without
/// one we ask for it here. Picking a handle saves it to the local profile and
/// publishes it to the directory in the BACKGROUND (so the sheet closes instantly
/// — discovery catches up a moment later). Fully skippable ("Maybe later").
///
/// Returns the chosen handle on success, or null if the user skipped.
Future<String?> showHandlePromptSheet(BuildContext context, {required String uid}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Zine.paper,
    shape: const RoundedRectangleBorder(
      side: BorderSide(color: Zine.ink, width: Zine.bw),
      borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
    ),
    builder: (_) => _HandlePromptSheet(uid: uid),
  );
}

class _HandlePromptSheet extends StatefulWidget {
  final String uid;
  const _HandlePromptSheet({required this.uid});
  @override
  State<_HandlePromptSheet> createState() => _HandlePromptSheetState();
}

class _HandlePromptSheetState extends State<_HandlePromptSheet> {
  final _ctrl = TextEditingController();
  Timer? _debounce;
  bool? _available; // null = unknown/checking, true/false = result
  bool _checking = false;
  bool _saving = false;
  String? _msg;

  @override
  void initState() {
    super.initState();
    Analytics.capture('handle_prompt_shown', const {});
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    _debounce?.cancel();
    setState(() { _available = null; _msg = null; _checking = v.trim().isNotEmpty; });
    if (v.trim().isEmpty) { setState(() => _checking = false); return; }
    _debounce = Timer(const Duration(milliseconds: 400), () async {
      final res = await Directory.checkHandle(_ctrl.text, uid: widget.uid);
      if (!mounted) return;
      setState(() { _checking = false; _available = res.ok; _msg = res.message; });
    });
  }

  bool get _ready => _available == true && !_checking && !_saving;

  Future<void> _save() async {
    if (!_ready) return;
    final handle = _ctrl.text.trim().toLowerCase().replaceAll('@', '');
    setState(() => _saving = true);
    // Persist locally first so the rest of the app sees the handle immediately.
    try {
      final prof = await ProfileStore().load();
      await ProfileStore().save(prof.copyWith(handle: handle));
      // Publish to the directory in the BACKGROUND — don't block closing the sheet.
      unawaited(Directory.registerProfile(
          uid: widget.uid, handle: handle, name: prof.displayName));
    } catch (_) {/* local save is best-effort; the field is still set in UI */}
    Analytics.capture('handle_prompt_set', {'len': handle.length});
    if (!mounted) return;
    Navigator.pop(context, handle);
  }

  void _skip() {
    Analytics.capture('handle_prompt_skipped', const {});
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final bottom = mq.viewInsets.bottom + mq.padding.bottom + 16;
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(22, 12, 22, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 44, height: 5, margin: const EdgeInsets.only(bottom: 18),
                decoration: BoxDecoration(color: Zine.inkMute, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            ZineIconBadge(icon: PhosphorIcons.at(PhosphorIconsStyle.bold), color: Zine.lime, size: 40),
            const SizedBox(height: 14),
            ZineMarkTitle(pre: 'Pick your ', mark: 'handle', fontSize: 26, textAlign: TextAlign.left),
            const SizedBox(height: 8),
            Text('A @handle is how friends find and tag you on AvaTok. You can change it '
                'later in your profile.',
                style: ZineText.sub(size: 13.5)),
            const SizedBox(height: 18),
            ZineField(
              controller: _ctrl,
              leadText: '@',
              hint: 'yourname',
              autofocus: true,
              onChanged: _onChanged,
              onSubmitted: (_) => _save(),
              error: _available == false,
              trailing: _trailing(),
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'[a-zA-Z0-9_]')),
                LengthLimitingTextInputFormatter(20),
              ],
            ),
            const SizedBox(height: 10),
            _status(),
            const SizedBox(height: 16),
            ZineButton(
              label: 'Set handle',
              fullWidth: true,
              fontSize: 18,
              loading: _saving,
              onPressed: _ready ? _save : null,
            ),
            const SizedBox(height: 10),
            Center(child: ZineLink('Maybe later', onTap: _saving ? null : _skip)),
          ],
        ),
      ),
    );
  }

  Widget? _trailing() {
    if (_checking) {
      return const SizedBox(width: 18, height: 18,
          child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.blueInk));
    }
    if (_available == true) {
      return PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 20, color: Zine.mintInk);
    }
    if (_available == false) {
      return PhosphorIcon(PhosphorIcons.xCircle(PhosphorIconsStyle.fill), size: 20, color: Zine.coral);
    }
    return null;
  }

  Widget _status() {
    if (_msg != null) {
      return ZineSticker(
        _msg!,
        kind: _available == true ? ZineStickerKind.ok : ZineStickerKind.no,
        icon: _available == true
            ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
            : PhosphorIcons.xCircle(PhosphorIconsStyle.fill),
      );
    }
    if (_available == true) {
      return ZineSticker('@${_ctrl.text.trim().toLowerCase()} is available',
          kind: ZineStickerKind.ok, icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill));
    }
    return ZineSticker('3–20 letters, numbers or _',
        kind: ZineStickerKind.hint, icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill));
  }
}
