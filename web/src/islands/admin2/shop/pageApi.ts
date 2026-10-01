// [SAATHUM-SHOP-EDITOR-1 2026-10-01] Calls behind the shop-page editor (worker: routes/admin2_shop_catalog.ts, /api/admin/v2/shop/page*).
// PageEditor talks to the `PageApi` interface so the same editor can be mounted against a mock in local checks.
import { adminApi } from '../adminApi';
import { uploadCover } from '../eventsApi';
import { listCollections, listProducts, SHOP } from './shopApi';
import type { CollectionInfo, PageData, ShopResolved } from '../../shop/blocks/types';
import type { EditProduct } from '../../shop/blocks/editorCtx';

export interface PageHistoryEntry { index: number; at: number; by: string | null }
export interface PageState {
  source: 'draft' | 'published' | 'default';
  data: PageData;
  draft_at: number | null; published_at: number | null; has_draft: boolean; has_published: boolean;
  history: PageHistoryEntry[];
}

export interface PageApi {
  load(): Promise<PageState>;
  saveDraft(data: PageData): Promise<{ draft_at: number }>;
  discardDraft(): Promise<void>;
  publish(data: PageData): Promise<{ published_at: number; history: PageHistoryEntry[] }>;
  revert(index: number): Promise<{ data: PageData; published_at: number; history: PageHistoryEntry[] }>;
  resolve(data: PageData): Promise<ShopResolved>;
  products(): Promise<EditProduct[]>;
  collections(): Promise<CollectionInfo[]>;
  upload(file: File): Promise<string>;
}

export const realPageApi: PageApi = {
  load: () => adminApi<PageState>(`${SHOP}/page`),
  saveDraft: (data) => adminApi<{ draft_at: number }>(`${SHOP}/page/draft`, { method: 'PUT', body: { data } }),
  discardDraft: async () => { await adminApi(`${SHOP}/page/draft`, { method: 'DELETE' }); },
  publish: (data) => adminApi(`${SHOP}/page/publish`, { method: 'POST', body: { data } }),
  revert: (index) => adminApi(`${SHOP}/page/revert`, { method: 'POST', body: { index } }),
  resolve: async (data) => (await adminApi<{ resolved: ShopResolved }>(`${SHOP}/page/resolve`, { method: 'POST', body: { data } })).resolved,
  products: async () => (await listProducts('live')).items.map((p) => ({ id: p.id, name: p.name, image_url: p.image_url })),
  collections: async () => (await listCollections()).items.filter((c) => Number(c.active) === 1 || c.active === true)
    .map((c) => ({ id: c.id, slug: c.slug, name: c.name, blurb: c.blurb, image_url: c.image_url, count: c.count })),
  upload: uploadCover,
};
