// Built-in sticker packs (STREAM E v1).
//
// v1 ships a few small local packs as .webp assets under app/assets/stickers/.
// Each sticker is sent as a normal media message tagged kind:"sticker" (see
// RichInputBar._sendSticker) and renders at a fixed 160dp WITHOUT a bubble.
//
// Adding a pack: drop <name>/*.webp under app/assets/stickers/, add the dir to
// pubspec.yaml assets, and register it here. (The manifest is code, not JSON, so
// there's no extra asset to bundle/parse.)
class StickerPack {
  final String id;
  final String name;
  final String tray; // asset shown in the pack picker row
  final List<String> stickers; // asset paths
  const StickerPack({
    required this.id,
    required this.name,
    required this.tray,
    required this.stickers,
  });
}

const String _base = 'assets/stickers';

/// The built-in packs. Placeholder .webp files ship in v1 — replace the assets
/// (same paths) with designed art without touching code.
const List<StickerPack> kStickerPacks = [
  StickerPack(
    id: 'ava_hearts',
    name: 'Ava Hearts',
    tray: '$_base/ava_hearts/tray.webp',
    stickers: [
      '$_base/ava_hearts/s1.webp',
      '$_base/ava_hearts/s2.webp',
      '$_base/ava_hearts/s3.webp',
      '$_base/ava_hearts/s4.webp',
    ],
  ),
  StickerPack(
    id: 'ava_reactions',
    name: 'Ava Reactions',
    tray: '$_base/ava_reactions/tray.webp',
    stickers: [
      '$_base/ava_reactions/s1.webp',
      '$_base/ava_reactions/s2.webp',
      '$_base/ava_reactions/s3.webp',
      '$_base/ava_reactions/s4.webp',
    ],
  ),
  StickerPack(
    id: 'ava_paws',
    name: 'Ava Paws',
    tray: '$_base/ava_paws/tray.webp',
    stickers: [
      '$_base/ava_paws/s1.webp',
      '$_base/ava_paws/s2.webp',
      '$_base/ava_paws/s3.webp',
      '$_base/ava_paws/s4.webp',
    ],
  ),
];
