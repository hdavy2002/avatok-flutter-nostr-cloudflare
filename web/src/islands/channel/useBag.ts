/* [HF-CHANNEL-WEB-1] React view of the bag store (merchBag.ts). Server render and first client render are the empty bag, so hydration matches. */
import { useSyncExternalStore } from 'react';
import { parseBag, rawBag, subscribeBag, type BagLine } from '../../lib/merchBag';

const EMPTY: BagLine[] = [];
export function useBag(): BagLine[] {
  return useSyncExternalStore(subscribeBag, () => parseBag(rawBag()), () => EMPTY);
}
