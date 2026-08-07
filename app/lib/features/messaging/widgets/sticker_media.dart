// Sticker / GIF media rendering helpers (STREAM E).
//
// Stickers and GIFs are sent through the EXISTING encrypted media pipeline
// (MediaService.encryptAndUpload → R2), so recipients fetch from R2 and never
// hit Tenor or a bundled asset over the wire. A sticker is just a media message
// whose envelope carries `sticker:true`, so it can render at a fixed 160dp
// WITHOUT a chat bubble.
//
// We DON'T modify Stream K's bubble geometry here. This file only provides:
//   - kStickerNameTag / isStickerName: a marker on the media `name` so a message
//     can be recognised as a sticker without a schema change, and
//   - StickerMediaView: the 160dp, bubble-less renderer the bubble builder can
//     switch to for sticker messages (wiring point reported to Stream K).
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Fixed sticker render size (WhatsApp-parity).
const double kStickerRenderSize = 160;

/// Marker embedded in a sticker media message's `name` field. Lets the bubble
/// builder detect a sticker with no envelope-schema change.
const String kStickerNameTag = 'ava-sticker';

bool isStickerName(String name) => name.startsWith('$kStickerNameTag/');

/// Builds the media `name` for a sticker so it's recognisable later.
String stickerMediaName(String assetPath) => '$kStickerNameTag/$assetPath';

/// 160dp, bubble-less sticker/GIF renderer. `bytes` is the decrypted media.
class StickerMediaView extends StatelessWidget {
  /// [CHAT-MEDIA-THUMB-2] NULLABLE. When [file] is supplied from the synchronous
  /// media index there are no decrypted bytes in hand — that is the whole point
  /// (fetching them is the async work being avoided) — so callers pass only the
  /// file. Exactly one of [bytes] or [file] must be non-null; if the file turns
  /// out to be unreadable and there are no bytes to fall back to, the view
  /// degrades to a fixed-size placeholder so the row height never changes.
  final Uint8List? bytes;
  final bool mine;

  /// [CHAT-MEDIA-THUMB-2] OPTIONAL on-disk source, preferred over [bytes] when
  /// given. Same reasoning as `ChatImageCard.file`: `MemoryImage` keys the
  /// decoded frame in `PaintingBinding.imageCache` on the byte buffer's
  /// IDENTITY, so bytes re-read from the media cache are a brand-new key and the
  /// sticker is re-decoded from scratch on every thread open; `FileImage` keys
  /// on the PATH, so a warm cache paints synchronously.
  ///
  /// Pass `MediaService.peekThumb(id) ?? MediaService.peekFile(id)` — both are
  /// synchronous, no-I/O and safe to call from `build()`. Null keeps the exact
  /// previous behaviour.
  final File? file;

  const StickerMediaView({
    super.key,
    this.bytes,
    this.mine = true,
    this.file,
  }) : assert(bytes != null || file != null,
            'StickerMediaView needs bytes or a file');

  @override
  Widget build(BuildContext context) {
    // [CHAT-MEDIA-THUMB-2] Bound the decode. A sticker/GIF is drawn into a fixed
    // 160dp box, but sticker packs commonly ship 512px assets — without this the
    // full-resolution bitmap was materialised for every sticker in the thread.
    final int cw =
        (kStickerRenderSize * MediaQuery.of(context).devicePixelRatio).round();
    Widget broken(BuildContext _, Object __, StackTrace? ___) =>
        Icon(PhosphorIcons.smiley(PhosphorIconsStyle.regular), size: 64);
    final f = file;
    final b = bytes;
    // Only reachable if a cached file failed to decode AND no bytes were handed
    // in. Keeps the 160dp box so a failure can never change the row's height.
    Widget placeholder() => const SizedBox(
        width: kStickerRenderSize, height: kStickerRenderSize);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: SizedBox(
        width: kStickerRenderSize,
        height: kStickerRenderSize,
        child: f != null
            ? Image.file(
                f,
                fit: BoxFit.contain,
                gaplessPlayback: true,
                cacheWidth: cw,
                // A bad cached file degrades to the bytes we were handed, or to
                // a same-size placeholder when the caller had none — never to a
                // broken tile and never to a height change.
                errorBuilder: (_, __, ___) => b == null
                    ? placeholder()
                    : Image.memory(
                        b,
                        fit: BoxFit.contain,
                        gaplessPlayback: true,
                        cacheWidth: cw,
                        errorBuilder: broken,
                      ),
              )
            : (b == null
                ? placeholder()
                : Image.memory(
                    b,
                    fit: BoxFit.contain,
                    gaplessPlayback: true,
                    cacheWidth: cw,
                    errorBuilder: broken,
                  )),
      ),
    );
  }
}
