// WhatsApp-parity chat input bar + emoji/GIF/sticker panel (STREAM E).
//
// Layout — [CHAT-MENTIONS-1] 2026-08-04 (owner request). Everything now lives
// INSIDE one wide pill, all controls right-aligned, and the hint line that used
// to sit above the bar is gone:
//   [ expanding text field  😊 @ 📎 📷 🎤 ]
// and, only once there is text, a green send circle slides in outside it:
//   [ expanding text field  😊 @ 📎 ]  ( ▶ )
// The camera and mic hide while typing because send takes over that job — this
// is why the bar can carry five controls without crowding the text.
//
// The previous layout put the emoji picker OUTSIDE on the left and kept a
// permanent green mic circle on the right; both moved in to make the bar read as
// a single object. Tapping the emoji icon opens a keyboard-height panel BELOW
// the input that smoothly swaps with the OS keyboard.
//
// This is a pure view driven by callbacks — it owns NO chat state. The host
// (chat_thread.dart) passes in the controller, focus node, the "has text" flag,
// and the send/attach/camera/mic handlers, plus the GIF/sticker senders. The
// host also owns the account-scoped recents + keyboard-height persistence via
// PickerRecentsStore.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import 'gif_api.dart';
import 'mention_text_controller.dart';
import 'picker_recents_store.dart';
import 'rich_picker_panel.dart';

class RichInputBar extends StatefulWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool hasText;
  final String hintText;
  final Color fieldColor;

  final VoidCallback onSend;
  final VoidCallback onAttach;
  final VoidCallback onCamera;
  final VoidCallback onMic;
  final ValueChanged<String> onChanged;

  /// [CHAT-MENTIONS-1] Tapping the "@" control. The HOST owns the picker (it is
  /// the only thing that knows who is in the thread), so this bar just reports
  /// the tap — keeping this widget a pure view, as the header promises.
  /// Null hides the control entirely.
  final VoidCallback? onMention;

  // Panel senders.
  final ValueChanged<GifResult> onGif;
  final ValueChanged<String> onSticker; // asset path

  // Optional slot for banners that sit ABOVE the row (reply preview, listening).
  final Widget? topSlot;

  const RichInputBar({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.hasText,
    required this.onSend,
    required this.onAttach,
    required this.onCamera,
    required this.onMic,
    required this.onChanged,
    required this.onGif,
    required this.onSticker,
    this.onMention,
    this.hintText = 'Message',
    this.fieldColor = Msg.input,
    this.topSlot,
  });

  @override
  State<RichInputBar> createState() => _RichInputBarState();
}

class _RichInputBarState extends State<RichInputBar> with WidgetsBindingObserver {
  bool _panelOpen = false;
  PickerTab _tab = PickerTab.emoji;
  double _panelHeight = 300;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _panelHeight = PickerRecentsStore.I.keyboardHeight;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Track the real OS keyboard height and persist it (scoped) so the panel opens
  // at the same height next time — a smooth swap between keyboard and panel.
  @override
  void didChangeMetrics() {
    final insets = WidgetsBinding.instance.window.viewInsets;
    final dpr = WidgetsBinding.instance.window.devicePixelRatio;
    final kbd = insets.bottom / dpr;
    if (kbd > 180) {
      PickerRecentsStore.I.setKeyboardHeight(kbd);
      if (_panelOpen && (kbd - _panelHeight).abs() > 4) {
        // Keyboard came up over the panel — close the panel (keyboard wins).
        setState(() => _panelOpen = false);
      }
      _panelHeight = PickerRecentsStore.I.keyboardHeight;
    }
  }

  void _toggleEmoji() {
    if (_panelOpen && _tab == PickerTab.emoji) {
      _closePanel();
      widget.focusNode.requestFocus();
      return;
    }
    _openPanel(PickerTab.emoji);
  }

  void _openPanel(PickerTab t) {
    _panelHeight = PickerRecentsStore.I.keyboardHeight;
    // Drop the OS keyboard first so the panel takes its place cleanly.
    widget.focusNode.unfocus();
    setState(() {
      _tab = t;
      _panelOpen = true;
    });
  }

  void _closePanel() => setState(() => _panelOpen = false);

  void _insertEmoji(String e) {
    final t = widget.controller;
    final sel = t.selection;
    final base = sel.isValid ? sel.start : t.text.length;
    final end = sel.isValid ? sel.end : t.text.length;
    final newText = t.text.replaceRange(base, end, e);
    t.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: base + e.length),
    );
    widget.onChanged(newText);
  }

  void _backspaceEmoji() {
    final t = widget.controller;
    if (t.text.isEmpty) return;
    final sel = t.selection;
    final cursor = sel.isValid ? sel.start : t.text.length;
    if (cursor == 0) return;
    // Remove one user-perceived character (handle surrogate pairs / ZWJ crudely
    // by trimming a grapheme cluster's trailing code units).
    final chars = t.text.characters.toList();
    // Rebuild up to the cursor by characters and drop the last one before it.
    var acc = 0;
    var idx = 0;
    for (; idx < chars.length; idx++) {
      final next = acc + chars[idx].length;
      if (next >= cursor) break;
      acc = next;
    }
    final removeStart = acc;
    final removeEnd = (acc + (idx < chars.length ? chars[idx].length : 0))
        .clamp(0, t.text.length);
    final newText = t.text.replaceRange(removeStart, removeEnd, '');
    t.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: removeStart),
    );
    widget.onChanged(newText);
  }

  @override
  Widget build(BuildContext context) {
    const bandDeco = BoxDecoration(color: AD.headerFooter);
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        decoration: bandDeco,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (widget.topSlot != null) widget.topSlot!,
          Padding(
            padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s2, Msg.s3, Msg.s2),
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              // ONE wide pill holding the field and every control, right-aligned.
              Expanded(
                child: Container(
                  padding: const EdgeInsets.only(left: Msg.s4, right: 2),
                  decoration: BoxDecoration(
                    color: widget.fieldColor,
                    borderRadius: Msg.brLg,
                    border: Border.all(color: AD.borderControl, width: 1),
                  ),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Expanded(
                      child: TextField(
                        controller: widget.controller,
                        focusNode: widget.focusNode,
                        onChanged: widget.onChanged,
                        onTap: _panelOpen ? _closePanel : null,
                        onSubmitted: (_) => widget.onSend(),
                        minLines: 1,
                        maxLines: 5,
                        keyboardType: TextInputType.multiline,
                        textInputAction: TextInputAction.newline,
                        style: const TextStyle(fontFamily: ADText.family,
                            fontWeight: FontWeight.w400, fontSize: 16, color: AD.textPrimary),
                        cursorColor: AD.iconSearch,
                        decoration: InputDecoration(
                          hintText: widget.hintText,
                          hintStyle: const TextStyle(fontFamily: ADText.family,
                              fontSize: 16, color: AD.textTertiary,
                              fontWeight: FontWeight.w400),
                          border: InputBorder.none,
                          isDense: true,
                          contentPadding:
                              const EdgeInsets.symmetric(vertical: 12),
                        ),
                      ),
                    ),
                    // Fixed in-pill controls. The primary action lives in a
                    // separate fixed-width slot, so typing never reflows this row.
                    _barIcon(
                      icon: _panelOpen && _tab == PickerTab.emoji
                          ? PhosphorIcons.keyboard(PhosphorIconsStyle.regular)
                          : PhosphorIcons.smiley(PhosphorIconsStyle.regular),
                      color: AD.iconEmoji,
                      tooltip: 'Emoji, GIFs & stickers',
                      onTap: _toggleEmoji,
                    ),
                    if (widget.onMention != null)
                      _barIcon(
                        icon: PhosphorIcons.at(PhosphorIconsStyle.regular),
                        color: MentionTextController.mentionBlue,
                        tooltip: 'Mention someone',
                        onTap: widget.onMention!,
                      ),
                    _barIcon(
                      icon: PhosphorIcons.paperclip(PhosphorIconsStyle.regular),
                      color: AD.iconClipOnWhite,
                      tooltip: 'Attach a file',
                      onTap: widget.onAttach,
                    ),
                    _barIcon(
                      icon: PhosphorIcons.camera(PhosphorIconsStyle.regular),
                      color: AD.iconCameraOnWhite,
                      tooltip: 'Take a photo',
                      onTap: widget.onCamera,
                    ),
                  ]),
                ),
              ),
              // Always reserve the same action slot. Only the icon/action changes.
              Padding(
                padding: const EdgeInsets.only(left: Msg.s2),
                child: SizedBox(
                  width: 46,
                  height: 46,
                  child: widget.hasText ? _sendButton() : _micButton(),
                ),
              ),
            ]),
          ),
        ]),
      ),
      // Panel replaces the keyboard directly; its height must not animate the
      // composer or message viewport.
      if (_panelOpen)
        RichPickerPanel(
          height: _panelHeight,
          initialTab: _tab,
          onTabChanged: (t) => setState(() => _tab = t),
          onEmoji: _insertEmoji,
          onBackspace: _backspaceEmoji,
          onGif: (g) {
            widget.onGif(g);
            _closePanel();
          },
          onSticker: (s) {
            widget.onSticker(s);
            _closePanel();
          },
        ),
    ]);
  }

  /// One in-pill control. Deliberately NOT an `IconButton`: that ships a 48dp
  /// minimum square each, and five of those would eat most of a 360dp screen and
  /// squeeze the text field down to a couple of words.
  Widget _barIcon({
    required IconData icon,
    required Color color,
    required String tooltip,
    required VoidCallback onTap,
  }) =>
      Tooltip(
        message: tooltip,
        child: InkResponse(
          onTap: onTap,
          radius: 22,
          child: SizedBox(
            width: 34,
            height: 44,
            child: Icon(icon, color: color, size: 21),
          ),
        ),
      );

  /// The fixed action slot uses a stable circle; only its purpose changes.
  Widget _sendButton() => GestureDetector(
        onTap: widget.onSend,
        child: Container(
          width: 46,
          height: 46,
          decoration: const BoxDecoration(
            color: AD.sendActiveBg,
            shape: BoxShape.circle,
          ),
          child: Center(
            child: Icon(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.bold),
                color: AD.sendActiveInk, size: 22),
          ),
        ),
      );

  Widget _micButton() => GestureDetector(
        onTap: widget.onMic,
        child: Container(
          width: 46,
          height: 46,
          decoration: const BoxDecoration(
            color: AD.sendActiveBg,
            shape: BoxShape.circle,
          ),
          child: Center(
            child: Icon(PhosphorIcons.microphone(PhosphorIconsStyle.fill),
                color: AD.sendActiveInk, size: 21),
          ),
        ),
      );
}
