// WhatsApp-parity chat input bar + emoji/GIF/sticker panel (STREAM E).
//
// Layout (owner's WhatsApp screenshot):
//   [emoji]  [ expanding text field ]  [attach 📎]  [camera]     ( ( mic ) )
// The trailing green round button is a MIC when the field is empty and morphs to
// a SEND paper-plane the moment there's text. Tapping the emoji icon opens a
// keyboard-height panel BELOW the input that smoothly swaps with the OS keyboard.
//
// This is a pure view driven by callbacks — it owns NO chat state. The host
// (chat_thread.dart) passes in the controller, focus node, the "has text" flag,
// and the send/attach/camera/mic handlers, plus the GIF/sticker senders. The
// host also owns the account-scoped recents + keyboard-height persistence via
// PickerRecentsStore.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/ui/avatok_dark.dart';
import 'gif_api.dart';
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
    this.hintText = 'Message',
    this.fieldColor = AD.inputField,
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
    const bandDeco = BoxDecoration(
      color: AD.headerFooter,
      border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
    );
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        decoration: bandDeco,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (widget.topSlot != null) widget.topSlot!,
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 6, 8, 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              // Emoji toggle (left).
              IconButton(
                icon: Icon(
                    _panelOpen && _tab == PickerTab.emoji
                        ? Icons.keyboard_alt_outlined
                        : Icons.emoji_emotions_outlined,
                    color: AD.iconEmoji,
                    size: 26),
                visualDensity: VisualDensity.compact,
                onPressed: _toggleEmoji,
              ),
              // Expanding text field with attach + camera trailing INSIDE it.
              Expanded(
                child: Container(
                  padding: const EdgeInsets.only(left: 14, right: 4),
                  decoration: BoxDecoration(
                    color: widget.fieldColor,
                    borderRadius: BorderRadius.circular(22),
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
                            fontWeight: FontWeight.w600, fontSize: 15.5, color: AD.textOnInput),
                        cursorColor: AD.iconSearch,
                        decoration: InputDecoration(
                          hintText: widget.hintText,
                          hintStyle: const TextStyle(fontFamily: ADText.family,
                              fontSize: 15.5, color: AD.placeholderOnWhite,
                              fontWeight: FontWeight.w600),
                          border: InputBorder.none,
                          isDense: true,
                          contentPadding:
                              const EdgeInsets.symmetric(vertical: 12),
                        ),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.attach_file_rounded,
                          color: AD.iconClipOnWhite, size: 22),
                      visualDensity: VisualDensity.compact,
                      onPressed: widget.onAttach,
                    ),
                    if (!widget.hasText)
                      IconButton(
                        icon: const Icon(Icons.photo_camera_outlined,
                            color: AD.iconCameraOnWhite, size: 22),
                        visualDensity: VisualDensity.compact,
                        onPressed: widget.onCamera,
                      ),
                  ]),
                ),
              ),
              const SizedBox(width: 6),
              // Green round mic → send-morph.
              _greenButton(),
            ]),
          ),
        ]),
      ),
      // Panel occupies the OS-keyboard slot when open.
      AnimatedSize(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        child: _panelOpen
            ? RichPickerPanel(
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
              )
            : const SizedBox.shrink(),
      ),
    ]);
  }

  Widget _greenButton() {
    final send = widget.hasText;
    // Send = green send pill; idle = lilac mic (dark v2).
    // [CHAT-UI-COMPOSER-1] Mic<->send morph: the fill colour animates via
    // AnimatedContainer and the glyph cross-fades + scales via AnimatedSwitcher
    // instead of hard-swapping — this button used to instant-swap despite a
    // "morphs" comment that was never actually implemented.
    return GestureDetector(
      onTap: send ? widget.onSend : widget.onMic,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        width: 46,
        height: 46,
        decoration: BoxDecoration(
          color: send ? AD.sendActiveBg : AD.micIdleBg,
          shape: BoxShape.circle,
        ),
        child: Center(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 180),
            transitionBuilder: (child, anim) =>
                ScaleTransition(scale: anim, child: FadeTransition(opacity: anim, child: child)),
            child: Icon(
              send ? Icons.send_rounded : Icons.mic_rounded,
              key: ValueKey(send),
              color: send ? AD.sendActiveInk : AD.micIdleInk,
              size: 22,
            ),
          ),
        ),
      ),
    );
  }
}
