/* [HF-CHANNEL-WEB-1 2026-10-23] Art slots of the "Galli Pop" channel page, bag and checkout.
 * The owner is generating the painted art (prompts: .agent-wt/mock/artwork-prompts.md, GP-01..GP-09). Files land in
 * web/public/assets/hf-channel/. Until a file exists the page draws the CSS stand-in shown in the approved mock.
 * The channel page is SSR, so it cannot test for a file at request time: flip the flag below to true when the file has been added
 * (a one-line change per slot). artUrl() returns the asset path only for a slot whose flag is true, otherwise null (use the stand-in). */
import { publicImage } from './config';

export type ArtSlot =
  | 'bandTruck' | 'stickerNoCap' | 'stickerPov' | 'stickerMeter' | 'stickerRentFree'
  | 'stickerMainCharacter' | 'stickerBagFull' | 'orderDone' | 'nowShowingBg'
  | 'emptyMerch' | 'emptyBag' | 'meterIcon' | 'noPhoto';

export const ART_DIR = '/assets/hf-channel/';

/** Slot -> file name inside ART_DIR (names fixed by the artwork prompts). */
export const ART_FILES: Record<ArtSlot, string> = {
  bandTruck: 'band-truck.png',
  stickerNoCap: 'sticker-no-cap.png',
  stickerPov: 'sticker-pov.png',
  stickerMeter: 'sticker-meter.png',
  stickerRentFree: 'sticker-rent-free.png',
  stickerMainCharacter: 'sticker-main-character.png',
  stickerBagFull: 'sticker-bag-full.png',
  orderDone: 'order-done.webp',
  nowShowingBg: 'now-showing-bg.webp',
  emptyMerch: 'empty-merch.webp',
  emptyBag: 'empty-bag.webp',
  meterIcon: 'meter-icon.png',
  noPhoto: 'no-photo.webp',
};

/** true = the owner's art file is in web/public/assets/hf-channel/. All false while the CSS stand-ins are in use. */
export const ART_READY: Record<ArtSlot, boolean> = {
  bandTruck: true,
  stickerNoCap: true,
  stickerPov: true,
  stickerMeter: true,
  stickerRentFree: true,
  stickerMainCharacter: true,
  stickerBagFull: true,
  orderDone: true,
  nowShowingBg: true,
  emptyMerch: true,
  emptyBag: true,
  meterIcon: true,
  noPhoto: true,
};

/** Exact sticker words (owner decision D10). The image carries the words, so the alt text repeats them. */
export const STICKER_TEXT: Record<'merch' | 'videos' | 'booking' | 'reviews' | 'product' | 'bag', string> = {
  merch: 'Fan merch, no cap.',
  videos: 'POV: you found your fav creator',
  booking: 'Meter down, baat shuru.',
  reviews: 'Rent-free in our heads',
  product: 'It’s giving main character.',
  bag: 'Bag full, dil full.',
};
export const STICKER_SLOT: Record<keyof typeof STICKER_TEXT, ArtSlot> = {
  merch: 'stickerNoCap', videos: 'stickerPov', booking: 'stickerMeter', reviews: 'stickerRentFree', product: 'stickerMainCharacter', bag: 'stickerBagFull',
};

/** Pixel size of each file (for width/height attributes) and the width the page asks the image service for. */
export const ART_DIMS: Record<ArtSlot, { w: number; h: number; ask: number }> = {
  bandTruck: { w: 1600, h: 160, ask: 1600 },
  stickerNoCap: { w: 900, h: 450, ask: 600 }, stickerPov: { w: 900, h: 450, ask: 600 }, stickerMeter: { w: 900, h: 450, ask: 600 },
  stickerRentFree: { w: 900, h: 450, ask: 600 }, stickerMainCharacter: { w: 900, h: 450, ask: 600 }, stickerBagFull: { w: 900, h: 450, ask: 600 },
  orderDone: { w: 1600, h: 1200, ask: 1200 }, nowShowingBg: { w: 2400, h: 1200, ask: 2048 },
  emptyMerch: { w: 1200, h: 900, ask: 1200 }, emptyBag: { w: 1000, h: 1000, ask: 600 }, meterIcon: { w: 600, h: 600, ask: 256 }, noPhoto: { w: 1200, h: 1500, ask: 1200 },
};

/** Image-service URL of a slot (null while its flag is off). Every art image goes through publicImage with fit scale-down. */
export function artUrl(slot: ArtSlot): string | null {
  return ART_READY[slot] ? publicImage(ART_DIR + ART_FILES[slot], { width: ART_DIMS[slot].ask, quality: 80, fit: 'scale-down' }) : null;
}
