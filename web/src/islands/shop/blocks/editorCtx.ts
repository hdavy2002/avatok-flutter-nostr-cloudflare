// [SAATHUM-SHOP-EDITOR-1 2026-10-01] What the admin editor feeds its canvas and sidebar fields (admin chunk only — never imported by the public page).
import { createContext, useContext } from 'react';
import type { CollectionInfo, ShopResolved } from './types';
import { emptyResolved } from './types';

export interface EditProduct { id: string; name: string; image_url: string | null }
export interface EditCtxValue {
  products: EditProduct[];
  collections: CollectionInfo[];
  resolved: ShopResolved;
  /** Upload a JPG/PNG/WebP (<= 8 MB) and return its https URL. */
  upload: (file: File) => Promise<string>;
}

export const EditCtx = createContext<EditCtxValue>({
  products: [], collections: [], resolved: emptyResolved(), upload: async () => { throw new Error('Uploads are not available here.'); },
});
export const useEditCtx = (): EditCtxValue => useContext(EditCtx);
