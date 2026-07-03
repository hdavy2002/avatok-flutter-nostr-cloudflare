// Per-account recents for the rich input picker (emoji + GIF + sticker).
//
// STREAM E — MANDATORY per-account scoping. One phone is shared by a parent and
// each child account, so recents (and the last-known keyboard height) MUST be
// namespaced by AccountScope via scopedKey(...). A raw global key would leak one
// account's recent emoji/GIFs onto another. We persist to secure storage under
// scopedKey('picker_recents') / scopedKey('picker_kbd_height').
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/account_storage.dart';

/// Small persistent store for picker recents + last keyboard height.
///
/// Recents are kept as three capped lists (most-recent-first):
///   - emoji   : the emoji character
///   - gif     : {url, preview, w, h} JSON maps (so we can re-render the tile)
///   - sticker : the sticker asset path (assets/stickers/…/foo.webp)
class PickerRecentsStore {
  PickerRecentsStore._();
  static final PickerRecentsStore I = PickerRecentsStore._();

  static const _sec = FlutterSecureStorage();
  static const _kRecents = 'picker_recents';
  static const _kKbdHeight = 'picker_kbd_height';
  static const _cap = 30;

  List<String> _emoji = [];
  List<Map<String, dynamic>> _gif = [];
  List<String> _sticker = [];
  double _kbdHeight = 300;
  bool _loaded = false;

  List<String> get emoji => List.unmodifiable(_emoji);
  List<Map<String, dynamic>> get gif => List.unmodifiable(_gif);
  List<String> get sticker => List.unmodifiable(_sticker);

  /// Last known OS-keyboard height for THIS account, so the picker panel opens
  /// at the same height the keyboard would (smooth swap). Clamped to sane bounds.
  double get keyboardHeight => _kbdHeight.clamp(220.0, 420.0);

  Future<void> load() async {
    if (_loaded) return;
    try {
      final raw = await _sec.read(key: scopedKey(_kRecents));
      if (raw != null && raw.isNotEmpty) {
        final j = jsonDecode(raw) as Map<String, dynamic>;
        _emoji = (j['emoji'] as List?)?.map((e) => e.toString()).toList() ?? [];
        _gif = (j['gif'] as List?)
                ?.map((e) => (e as Map).cast<String, dynamic>())
                .toList() ??
            [];
        _sticker =
            (j['sticker'] as List?)?.map((e) => e.toString()).toList() ?? [];
      }
      final h = await _sec.read(key: scopedKey(_kKbdHeight));
      if (h != null) _kbdHeight = double.tryParse(h) ?? _kbdHeight;
    } catch (_) {}
    _loaded = true;
  }

  Future<void> _persist() async {
    try {
      await _sec.write(
        key: scopedKey(_kRecents),
        value: jsonEncode({'emoji': _emoji, 'gif': _gif, 'sticker': _sticker}),
      );
    } catch (_) {}
  }

  Future<void> pushEmoji(String e) async {
    _emoji.remove(e);
    _emoji.insert(0, e);
    if (_emoji.length > _cap) _emoji = _emoji.sublist(0, _cap);
    await _persist();
  }

  Future<void> pushGif(Map<String, dynamic> g) async {
    _gif.removeWhere((x) => x['url'] == g['url']);
    _gif.insert(0, g);
    if (_gif.length > _cap) _gif = _gif.sublist(0, _cap);
    await _persist();
  }

  Future<void> pushSticker(String assetPath) async {
    _sticker.remove(assetPath);
    _sticker.insert(0, assetPath);
    if (_sticker.length > _cap) _sticker = _sticker.sublist(0, _cap);
    await _persist();
  }

  Future<void> setKeyboardHeight(double h) async {
    if (h < 180 || h > 500) return; // ignore transient / bogus values
    if ((h - _kbdHeight).abs() < 4) return;
    _kbdHeight = h;
    try {
      await _sec.write(key: scopedKey(_kKbdHeight), value: h.toString());
    } catch (_) {}
  }
}
