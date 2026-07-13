import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/profile_store.dart';
import '../../core/ui/avatok_dark.dart';
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
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
      side: BorderSide(color: AD.borderControl, width: 1),
      borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
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
    // RESPUI: wrap in a scroll view so a small screen + open keyboard (which
    // shrinks available height via viewInsets.bottom) never overflows — the
    // sheet's content simply scrolls instead of clipping/erroring.
    return SingleChildScrollView(
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
                decoration: BoxDecoration(color: AD.textFaint, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            // Accent glyph badge (@).
            Container(
              width: 40, height: 40,
              decoration: BoxDecoration(
                color: AD.primaryBadge.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(AD.rIconButton),
              ),
              child: Center(child: PhosphorIcon(
                  PhosphorIcons.at(PhosphorIconsStyle.bold), size: 22, color: AD.primaryBadge)),
            ),
            const SizedBox(height: 14),
            Text.rich(
              TextSpan(children: [
                TextSpan(text: 'Pick your ', style: ADText.appTitle()),
                TextSpan(text: 'handle', style: ADText.appTitle(c: AD.primaryBadge)),
              ]),
            ),
            const SizedBox(height: 8),
            Text('A @handle is how friends find and tag you on AvaTok. You can change it '
                'later in your profile.',
                style: ADText.preview()),
            const SizedBox(height: 18),
            // White dark-v2 handle field with a leading @ and a status trailing.
            Container(
              decoration: BoxDecoration(
                color: AD.inputField,
                borderRadius: BorderRadius.circular(AD.rInput),
                border: _available == false ? Border.all(color: AD.danger, width: 1.5) : null,
              ),
              padding: const EdgeInsets.only(left: 14, right: 12),
              child: Row(children: [
                Text('@', style: ADText.rowName(c: AD.placeholderOnWhite)),
                const SizedBox(width: 4),
                Expanded(
                  child: TextField(
                    controller: _ctrl,
                    autofocus: true,
                    cursorColor: AD.primaryBadge,
                    style: ADText.rowName(c: AD.textOnInput),
                    onChanged: _onChanged,
                    onSubmitted: (_) => _save(),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[a-zA-Z0-9_]')),
                      LengthLimitingTextInputFormatter(20),
                    ],
                    decoration: InputDecoration(
                      isDense: true,
                      border: InputBorder.none,
                      hintText: 'yourname',
                      hintStyle: ADText.rowName(c: AD.placeholderOnWhite),
                      contentPadding: const EdgeInsets.symmetric(vertical: 15),
                    ),
                  ),
                ),
                if (_trailing() != null) ...[const SizedBox(width: 8), _trailing()!],
              ]),
            ),
            const SizedBox(height: 10),
            _status(),
            const SizedBox(height: 16),
            GestureDetector(
              onTap: _ready ? _save : null,
              child: Opacity(
                opacity: _ready ? 1 : 0.5,
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AD.primaryBadge,
                    borderRadius: BorderRadius.circular(100),
                  ),
                  child: _saving
                      ? const SizedBox(width: 20, height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text('Set handle', style: ADText.threadName(c: Colors.white)),
                ),
              ),
            ),
            const SizedBox(height: 10),
            Center(child: GestureDetector(
              onTap: _saving ? null : _skip,
              child: Text('Maybe later', style: ADText.preview(c: AD.textSecondary)),
            )),
          ],
        ),
      ),
    );
  }

  Widget? _trailing() {
    if (_checking) {
      return const SizedBox(width: 18, height: 18,
          child: CircularProgressIndicator(strokeWidth: 2.4, color: AD.iconSearch));
    }
    if (_available == true) {
      return PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 20, color: AD.online);
    }
    if (_available == false) {
      return PhosphorIcon(PhosphorIcons.xCircle(PhosphorIconsStyle.fill), size: 20, color: AD.danger);
    }
    return null;
  }

  Widget _status() {
    if (_msg != null) {
      return _sticker(_msg!,
          ok: _available == true,
          hint: false,
          icon: _available == true
              ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
              : PhosphorIcons.xCircle(PhosphorIconsStyle.fill));
    }
    if (_available == true) {
      return _sticker('@${_ctrl.text.trim().toLowerCase()} is available',
          ok: true, hint: false, icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill));
    }
    return _sticker('3–20 letters, numbers or _',
        ok: false, hint: true, icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill));
  }

  /// Inline dark-v2 status sticker: ok = green, error = danger, hint = neutral.
  Widget _sticker(String text, {required bool ok, required bool hint, required IconData icon}) {
    final accent = hint ? AD.textTertiary : (ok ? AD.online : AD.danger);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(AD.rStatCard),
        border: Border.all(color: AD.borderControl, width: 1),
      ),
      child: Row(children: [
        PhosphorIcon(icon, size: 16, color: accent),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: ADText.preview(c: AD.textSecondary))),
      ]),
    );
  }
}
