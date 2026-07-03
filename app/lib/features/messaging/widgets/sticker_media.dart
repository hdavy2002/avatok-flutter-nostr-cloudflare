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
import 'dart:typed_data';

import 'package:flutter/material.dart';

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
  final Uint8List bytes;
  final bool mine;
  const StickerMediaView({super.key, required this.bytes, this.mine = true});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: SizedBox(
        width: kStickerRenderSize,
        height: kStickerRenderSize,
        child: Image.memory(
          bytes,
          fit: BoxFit.contain,
          gaplessPlayback: true,
          errorBuilder: (_, __, ___) =>
              const Icon(Icons.emoji_emotions_outlined, size: 64),
        ),
      ),
    );
  }
}
