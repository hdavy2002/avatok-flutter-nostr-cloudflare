// [SAATHUM-SHOP-ADMIN-1 2026-10-01] Types, endpoint wrappers and display helpers for the
// Admin 2 Shop screens. Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §4.4 + §4.5.
// Every call goes through adminApi() (AdminNav owns the page's only ClerkProvider).
import { adminApi, errMessage } from '../adminApi';

export const SHOP = '/api/admin/v2/shop';

export { errMessage };

/* ───────── shapes ───────── */

export interface Colour { name: string; hex: string }
export interface ProductImage { url: string; label: string }
export type ProductStatus = 'live' | 'draft' | 'hidden' | 'archived';
export type Badge = '' | 'new' | 'best' | 'sale';

export interface AdminProduct {
  id: string; slug: string; name: string;
  price_rupees: number; mrp_rupees: number | null; off_pct?: number | null;
  badge: Badge; colours: Colour[]; sizes: string[];
  image_url: string | null;
  collection: { slug: string; name: string } | null;
  status: ProductStatus; collection_id: string | null;
  promoted_on: string[]; printrove_ref: string | null; updated_at: number;
  // Present when the API returns the full row (GET products/:id); optional on the list.
  description?: string; fit?: 'Regular' | 'Oversized'; print_type?: string; audience?: 'Adults' | 'Kids';
  images?: ProductImage[];
}

export interface AdminCollection {
  id: string; slug: string; name: string; blurb: string; image_url: string | null;
  sort: number; active: boolean | number; count: number;
}

export type SlotKey = 'hero_hotspots' | 'new_arrivals' | 'featured_banner' | 'bestsellers' | 'sale' | 'also_like';
/** Order and wording are the mockup's `SLOTS` keys. */
export const SLOTS: { key: SlotKey; title: string; short: string }[] = [
  { key: 'hero_hotspots', title: 'Hero hotspots (photo dots)', short: 'Hero hotspots' },
  { key: 'new_arrivals', title: 'New arrivals rail', short: 'New arrivals' },
  { key: 'featured_banner', title: 'Featured banner', short: 'Featured banner' },
  { key: 'bestsellers', title: 'Bestsellers rail', short: 'Bestsellers' },
  { key: 'sale', title: 'Sale badge', short: 'Sale badge' },
  { key: 'also_like', title: 'Product page · You may also like', short: 'Product page' },
];
export const slotShort = (k: string): string => SLOTS.find((s) => s.key === k)?.short ?? k;

export interface HeroSettings {
  image_url?: string | null; eyebrow?: string; title?: string; title_em?: string; lead?: string;
  cta_label?: string; second_cta_collection?: string; ticks?: string[];
  promise?: { title: string; sub: string }[]; hotspots?: { product_id: string; x: number; y: number }[];
}
export interface BannerSettings {
  product_id?: string | null; eyebrow?: string; title?: string; text?: string; cta_label?: string; image_url?: string | null;
}
export interface PolicySettings {
  delivery_text?: string; report_window_hours?: number; print_partner?: string; alerts_whatsapp?: boolean;
  [k: string]: unknown;
}

export interface Coupon {
  code: string; kind: 'pct' | 'flat'; value: number; min_order_rupees: number;
  max_uses: number | null; used_count: number; valid_until: number | null; active: boolean | number;
}

export interface Kpis {
  orders_today: number; orders_yesterday: number; revenue_30d_rupees: number; orders_30d: number;
  to_print: number; to_ship: number; stale_48h: number;
}

export interface OrderLine { name: string; size?: string; colour?: string; qty: number; unit_rupees?: number; amount_rupees?: number; image_url?: string | null; slug?: string }
export interface AdminOrder {
  order_id: string; order_no: string; created_at: number;
  customer: { uid?: string; name?: string | null; email?: string | null; phone_masked?: string | null; city?: string | null };
  items: OrderLine[]; total_rupees: number;
  pay_status: string; payer_reference: string | null; utr_last4: string | null;
  fulfil_status: string; courier: string | null; awb: string | null; tracking_url: string | null; eta_text: string | null;
}
export interface SmsCandidate { message_hash: string; amount_paise: number; bank_reference: string | null; received_at: number }
export interface OrderDetail extends AdminOrder {
  timeline?: { kind: string; at: number; actor?: string | null; note?: string | null }[];
  problem?: { message?: string; photo_url?: string | null; at?: number; reported_at?: number } | null;
  sms_candidates?: SmsCandidate[];
  address?: { name?: string; phone?: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string } | null;
}

/* ───────── calls ───────── */

export const getKpis = () => adminApi<Kpis>(`${SHOP}/kpis`);

export const listProducts = (status: string) => adminApi<{ items: AdminProduct[]; counts: Record<string, number> }>(`${SHOP}/products`, { query: { status } });
export const getProduct = (id: string) => adminApi<{ product: AdminProduct }>(`${SHOP}/products/${encodeURIComponent(id)}`);
export const saveProduct = (id: string | null, body: unknown) =>
  adminApi<{ product: AdminProduct }>(id ? `${SHOP}/products/${encodeURIComponent(id)}` : `${SHOP}/products`, { method: id ? 'PUT' : 'POST', body });
export const archiveProduct = (id: string) => adminApi<{ ok?: boolean }>(`${SHOP}/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const restoreProduct = (id: string) => adminApi<{ ok?: boolean }>(`${SHOP}/products/${encodeURIComponent(id)}/restore`, { method: 'POST' });
export const promoteProduct = (id: string, slots: string[], badge: Badge) =>
  adminApi<{ ok?: boolean }>(`${SHOP}/products/${encodeURIComponent(id)}/promote`, { method: 'PUT', body: { slots, badge } });

export const listCollections = () => adminApi<{ items: AdminCollection[] }>(`${SHOP}/collections`);
export const createCollection = (body: { name: string; blurb?: string; image_url?: string | null }) =>
  adminApi<{ collection?: AdminCollection }>(`${SHOP}/collections`, { method: 'POST', body });
export const updateCollection = (id: string, body: Record<string, unknown>) =>
  adminApi<{ collection?: AdminCollection }>(`${SHOP}/collections/${encodeURIComponent(id)}`, { method: 'PUT', body });
export const deleteCollection = (id: string) => adminApi<{ ok?: boolean }>(`${SHOP}/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const reorderCollections = (ids: string[]) => adminApi<{ ok?: boolean }>(`${SHOP}/collections/reorder`, { method: 'POST', body: { ids } });

export const getSlots = () => adminApi<{ slots: Partial<Record<SlotKey, string[]>> }>(`${SHOP}/slots`);
export const putSlot = (slot: SlotKey, product_ids: string[]) => adminApi<{ ok?: boolean }>(`${SHOP}/slots/${slot}`, { method: 'PUT', body: { product_ids } });

export const getSettings = () => adminApi<{ hero?: HeroSettings; featured_banner?: BannerSettings; policy?: PolicySettings }>(`${SHOP}/settings`);
export const putSetting = (key: 'hero' | 'featured_banner' | 'policy', value: unknown) =>
  adminApi<{ ok?: boolean }>(`${SHOP}/settings/${key}`, { method: 'PUT', body: { value } });

export const listCoupons = () => adminApi<{ items: Coupon[] }>(`${SHOP}/coupons`);
export const createCoupon = (body: unknown) => adminApi<{ coupon?: Coupon }>(`${SHOP}/coupons`, { method: 'POST', body });
export const updateCoupon = (code: string, body: unknown) => adminApi<{ coupon?: Coupon }>(`${SHOP}/coupons/${encodeURIComponent(code)}`, { method: 'PUT', body });

export const listOrders = (tab: string, q: string, cursor: string | null) =>
  adminApi<{ items: AdminOrder[]; next_cursor: string | null; counts?: Record<string, number> }>(`${SHOP}/orders`, {
    query: { tab, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) },
  });
export const getOrder = (id: string) => adminApi<{ order: OrderDetail }>(`${SHOP}/orders/${encodeURIComponent(id)}`);
export const orderAction = (id: string, action: 'confirm-payment' | 'reject-payment' | 'at-printer' | 'shipped' | 'delivered' | 'cancel' | 'refund', body: unknown = {}) =>
  adminApi<{ order?: AdminOrder }>(`${SHOP}/orders/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });

/* ───────── helpers ───────── */

export const inr = (n: number): string => '₹' + Math.round(n).toLocaleString('en-IN');

export function dmy(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export function dmyTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

/** Mockup status keys → chip colour class (`st-*`) and label. */
export type UiStatus = 'pending' | 'paid' | 'packed' | 'shipped' | 'delivered' | 'cancelled';
export const ST_LABEL: Record<UiStatus, string> = {
  pending: 'Awaiting payment', paid: 'Paid · going to print', packed: 'Printing at Printrove',
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled',
};

export function uiStatus(o: Pick<AdminOrder, 'pay_status' | 'fulfil_status'>): UiStatus {
  const f = o.fulfil_status;
  if (f === 'cancelled' || f === 'refunded' || o.pay_status === 'cancelled' || o.pay_status === 'expired') return 'cancelled';
  if (o.pay_status !== 'confirmed') return 'pending';
  if (f === 'at_printer') return 'packed';
  if (f === 'shipped') return 'shipped';
  if (f === 'delivered') return 'delivered';
  return 'paid';
}

export const ORDER_TABS: { f: string; label: string }[] = [
  { f: 'all', label: 'All' },
  { f: 'awaiting', label: 'Awaiting payment' },
  { f: 'to_print', label: 'Paid · send to printer' },
  { f: 'at_printer', label: 'At Printrove' },
  { f: 'shipped', label: 'Shipped' },
  { f: 'delivered', label: 'Delivered' },
  { f: 'cancelled', label: 'Cancelled / refunded' },
];

export const COURIERS = ['Printrove · Delhivery', 'Printrove · Bluedart', 'Printrove · Xpressbees', 'Printrove · India Post'];
export const PHOTO_LABELS = ['Front', 'Back', 'Print close-up', 'On model'];

export const digitsOnly = (v: string, max: number): string => v.replace(/\D/g, '').slice(0, max);

/** Tell the admin nav how many paid orders are waiting to be sent to the printer. */
export function announceToPrint(n: number): void {
  try { window.dispatchEvent(new CustomEvent('shop-admin:to-print', { detail: n })); } catch { /* old browser */ }
}
