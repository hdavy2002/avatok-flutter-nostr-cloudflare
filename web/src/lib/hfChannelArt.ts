/* [HF-CHANNEL-WEB-1 2026-10-23] Art slots of the "Galli Pop" channel page, bag and checkout.
 * The owner is generating the painted art (prompts: .agent-wt/mock/artwork-prompts.md, GP-01..GP-09). Files land in
 * web/public/assets/hf-channel/. Until a file exists the page draws the CSS stand-in shown in the approved mock.
 * The channel page is SSR, so it cannot test for a file at request time: flip the flag below to true when the file has been added
 * (a one-line change per slot). artUrl() returns the asset path only for a slot whose flag is true, otherwise null (use the stand-in). */
export type ArtSlot =
  | 'bandTruck' | 'stickerNoCap' | 'stickerPov' | 'stickerMeter' | 'stickerRentFree'
  | 'stickerMainCharacter' | 'stickerBagFull' | 'orderDone' | 'nowShowingBg';

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
};

/** true = the owner's art file is in web/public/assets/hf-channel/. All false while the CSS stand-ins are in use. */
export const ART_READY: Record<ArtSlot, boolean> = {
  bandTruck: false,
  stickerNoCap: false,
  stickerPov: false,
  stickerMeter: false,
  stickerRentFree: false,
  stickerMainCharacter: false,
  stickerBagFull: false,
  orderDone: false,
  nowShowingBg: false,
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

export function artUrl(slot: ArtSlot): string | null {
  return ART_READY[slot] ? ART_DIR + ART_FILES[slot] : null;
}
