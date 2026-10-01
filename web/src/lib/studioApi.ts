// [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Typed client for the Studio admin API — Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md §4.
// Every call goes through adminApi() (AdminNav owns the page's only ClerkProvider), exactly like the shop admin islands.
// The worker (STUDIO-API) is built in parallel: shapes below follow the spec text, and the readers (normDesign,
// normPhoto) accept both parsed columns (`art_checks`) and the raw `*_json` strings so a small naming difference
// on the server does not break the screens.
import { ApiError, adminApi, adminBlob, whenAdmin, adminToken } from '../islands/admin2/adminApi';
import { API_BASE } from './env';
import { fileNameHeader } from './uploadHeaders';
import type { FrameShape, PrintSide, SavedPlacement } from './studioGeometry';

export { ApiError, errMessage, errCode } from '../islands/admin2/adminApi';

export const STUDIO = '/api/admin/v2/shop/studio';
const dp = (id: string): string => `${STUDIO}/designs/${encodeURIComponent(id)}`;

/* ───────── shapes ───────── */

export type StudioStatus = 'draft' | 'ready' | 'live' | 'retired';
export type StudioStep = 'upload' | 'product' | 'design' | 'photos' | 'publish';
export const STEP_ORDER: StudioStep[] = ['upload', 'product', 'design', 'photos', 'publish'];
export const STEP_LABEL: Record<StudioStep, string> = {
  upload: 'Upload artwork', product: 'Product', design: 'Design on shirt', photos: 'Your photos', publish: 'Publish',
};
/** Page path segment of each step (`/admin/shop/studio/<id>/<segment>`). */
export const STEP_PATH: Record<StudioStep, string> = { upload: 'upload', product: 'product', design: 'design', photos: 'photos', publish: 'publish' };
export const stepHref = (id: string | null, step: StudioStep): string => (id ? `/admin/shop/studio/${encodeURIComponent(id)}/${STEP_PATH[step]}` : '/admin/shop/studio/new');
export const STUDIO_HOME = '/admin/shop/studio';

export interface ArtChecks {
  w?: number; h?: number; bytes?: number; mime?: string; rgb?: boolean | null; has_alpha?: boolean | null;
  trimmed_px?: number; soft_edge_pct?: number; dominant_colours?: string[]; cmyk_converted?: boolean;
}
export interface ChosenProduct { kind: string; provider_product_id: string; side: PrintSide }
export interface PhotoChecks { size_ok?: boolean; colour_sold?: boolean }
export interface StudioPhoto {
  id: string; design_id: string; kind: 'model' | 'flat' | 'closeup'; colour: string | null; url: string;
  width: number | null; height: number | null; checks: PhotoChecks; status: 'kept' | 'removed'; sort: number; is_main: boolean;
}
export interface PublishStepRow { key: string; label: string; status: 'done' | 'skipped' | 'failed' | 'pending'; note: string }
export interface DesignCopy { name?: string; description?: string; seo_title?: string; publish_steps?: PublishStepRow[]; [k: string]: unknown }
/** [AUMFE-POD-COST-1] What the print partner charges per size for this print (rupees). */
export interface CostRange { min: number; max: number }
export interface SizeCost {
  size: string; garment_rupees: CostRange | null; print_rupees: CostRange | null; partner_gst_pct: number;
  shipping_rupees: number | null; total_rupees: number | null; in_stock: boolean;
}
export interface DesignCosts { provider_product_id: string; side: PrintSide; print_w_in: number; print_h_in: number; shipping_rupees: number | null; sizes: SizeCost[] }
export type CatalogSource = 'printrove' | 'builtin';
export interface ColourInfo { name: string; hex: string; unavailable: boolean }
export interface Design {
  id: string; name: string; status: StudioStatus; step: StudioStep;
  art_w: number | null; art_h: number | null; art_bytes: number | null; art_mime: string | null;
  art_checks: ArtChecks; art_preview_url: string | null; art_url: string | null;
  products: ChosenProduct[]; placement: SavedPlacement | null;
  print_w: number | null; print_h: number | null; print_preview_url: string | null; print_url: string | null;
  version: number; locked_at: number | null; colours: string[];
  /** Chosen colours with their swatch; `unavailable` = the print partner does not sell it on this product. */
  colour_info: ColourInfo[];
  catalog_source: CatalogSource; catalog_reason: string | null; costs: DesignCosts | null;
  copy: DesignCopy; prices: Record<string, number>; product_id: string | null;
  photos: StudioPhoto[]; photo_coverage: { colour: string; photos: number }[];
  created_at: number; updated_at: number;
}
export interface DesignCard {
  id: string; name: string; status: StudioStatus; step: StudioStep; art_preview_url: string | null; print_preview_url: string | null;
  products_label: string; colours: string[]; updated_at: number; product_slug: string | null; photo_count?: number;
}
export interface DesignList { items: DesignCard[]; counts: Record<string, number> }

export interface FitCatalog { provider_product_id: string; colours: { name: string; hex: string | null }[]; sizes: string[]; cost_from_paise: number | null }
export interface FitItem {
  kind: string; label: string; side: PrintSide; area_in: [number, number]; full_area_dpi: number; sharp_w_in: number;
  verdict: 'great' | 'good' | 'small_only' | 'too_small'; note: string; catalog: FitCatalog | null;
}
export interface Fits { catalog_source?: CatalogSource; catalog_reason?: string | null; items: FitItem[]; best: { kind: string; side?: PrintSide; colours: string[]; text: string } | null }

export interface PublishInput { collection_id: string; badge: string; prices: Record<string, number>; slots: string[] }
export interface PublishResult { design: Design; steps: PublishStepRow[] }

/* ───────── tolerant readers ───────── */

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
function pj<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function normPhoto(r: Raw): StudioPhoto {
  const checks = pj<PhotoChecks>(r.checks ?? r.checks_json, {});
  return {
    id: String(r.id), design_id: String(r.design_id ?? ''), kind: (r.kind as StudioPhoto['kind']) ?? 'model',
    colour: str(r.colour), url: String(r.url ?? ''), width: num(r.width), height: num(r.height),
    checks: isObj(checks) ? checks : {}, status: r.status === 'removed' ? 'removed' : 'kept',
    sort: num(r.sort) ?? 0, is_main: r.is_main === true || r.is_main === 1,
  };
}

export function normDesign(r: Raw): Design {
  const colours = pj<unknown[]>(r.colours ?? r.colours_json, []);
  return {
    id: String(r.id), name: String(r.name ?? ''), status: (r.status as StudioStatus) ?? 'draft', step: (r.step as StudioStep) ?? 'upload',
    art_w: num(r.art_w), art_h: num(r.art_h), art_bytes: num(r.art_bytes), art_mime: str(r.art_mime),
    art_checks: pj<ArtChecks>(r.art_checks ?? r.art_checks_json, {}) ?? {},
    art_preview_url: str(r.art_preview_url), art_url: str(r.art_url),
    products: pj<ChosenProduct[]>(r.products ?? r.products_json, []),
    placement: pj<SavedPlacement | null>(r.placement ?? r.placement_json, null),
    print_w: num(r.print_w), print_h: num(r.print_h), print_preview_url: str(r.print_preview_url), print_url: str(r.print_url),
    version: num(r.version) ?? 1, locked_at: num(r.locked_at),
    // Colours are stored as names; an object form {name} is tolerated.
    colours: colours.map((c) => (isObj(c) ? String(c.name ?? '') : String(c))).filter(Boolean),
    colour_info: colours.filter(isObj).map((c) => ({ name: String(c.name ?? ''), hex: typeof c.hex === 'string' ? c.hex : '#888888', unavailable: c.unavailable === true })).filter((c) => c.name),
    catalog_source: r.catalog_source === 'printrove' ? 'printrove' : 'builtin',
    catalog_reason: str(r.catalog_reason),
    costs: isObj(r.costs) && Array.isArray(r.costs.sizes) ? (r.costs as unknown as DesignCosts) : null,
    copy: pj<DesignCopy>(r.copy ?? r.copy_json, {}) ?? {},
    prices: pj<Record<string, number>>(r.prices ?? r.prices_json, {}) ?? {},
    product_id: str(r.product_id),
    photos: (Array.isArray(r.photos) ? (r.photos as Raw[]) : []).map(normPhoto),
    photo_coverage: Array.isArray(r.photo_coverage) ? (r.photo_coverage as { colour: string; photos: number }[]) : [],
    created_at: num(r.created_at) ?? 0, updated_at: num(r.updated_at) ?? 0,
  };
}

/* ───────── JSON endpoints ───────── */

export const listDesigns = (status?: string) =>
  adminApi<DesignList>(`${STUDIO}/designs`, { query: status ? { status } : undefined });
export async function createDesign(name: string): Promise<Design> {
  const r = await adminApi<{ design: Raw }>(`${STUDIO}/designs`, { method: 'POST', body: { name } });
  return normDesign(r.design);
}
export async function getDesign(id: string): Promise<Design> {
  const r = await adminApi<{ design: Raw }>(dp(id));
  return normDesign(r.design);
}
export type DesignPatch = Partial<{ name: string; step: StudioStep; colours: string[]; copy: DesignCopy; prices: Record<string, number>; art_checks: ArtChecks }>;
export async function updateDesign(id: string, patch: DesignPatch): Promise<Design> {
  const r = await adminApi<{ design: Raw }>(dp(id), { method: 'PUT', body: patch });
  return normDesign(r.design);
}
export const retireDesign = (id: string) => adminApi<{ ok?: boolean }>(dp(id), { method: 'DELETE' });
export const getFits = (id: string) => adminApi<Fits>(`${dp(id)}/fits`);
export const putProducts = (id: string, products: ChosenProduct[]) =>
  adminApi<{ ok?: boolean }>(`${dp(id)}/products`, { method: 'PUT', body: { products } });
export interface PlacementBody {
  kind: string; side: PrintSide; shape: FrameShape; frame_w_in: number; frame_h_in: number; frame_top_in: number;
  zoom_pct: number; nudge_x_in: number; nudge_y_in: number; print_w_in: number; print_h_in: number; dpi: number;
  print_left_in: number; print_top_in: number;
}
export const putPlacement = (id: string, placement: PlacementBody) =>
  adminApi<{ ok?: boolean }>(`${dp(id)}/placement`, { method: 'PUT', body: { placement } });
export const newVersion = (id: string) => adminApi<{ design?: Raw }>(`${dp(id)}/new-version`, { method: 'POST', body: {} });
export const copyAi = (id: string) =>
  adminApi<{ name: string; description: string; seo_title: string }>(`${dp(id)}/copy-ai`, { method: 'POST', body: {}, timeoutMs: 45_000 });
export async function publishDesign(id: string, input: PublishInput): Promise<PublishResult> {
  const r = await adminApi<{ design: Raw; steps: PublishStepRow[] }>(`${dp(id)}/publish`, { method: 'POST', body: input, timeoutMs: 90_000 });
  return { design: normDesign(r.design), steps: r.steps ?? [] };
}
export async function updatePhoto(designId: string, photoId: string, patch: Partial<{ colour: string; status: 'kept' | 'removed'; sort: number; is_main: boolean }>): Promise<void> {
  await adminApi<unknown>(`${dp(designId)}/photos/${encodeURIComponent(photoId)}`, { method: 'PUT', body: patch });
}

/** Bytes of the private original / print file, through the authenticated admin API (never the presigned R2 URL: no CORS). */
export async function fetchArtBlob(id: string): Promise<Blob> { return (await adminBlob(`${dp(id)}/file/art`)).blob; }
export async function fetchPrintBlob(id: string): Promise<Blob> { return (await adminBlob(`${dp(id)}/file/print`)).blob; }

/* ───────── raw-body uploads (art, previews, print file, photos) ───────── */

/** Header values must be ISO-8859-1: percent-encode anything else (see lib/uploadHeaders). */
const headerSafe = (v: string): string => (/^[\x20-\x7e]*$/.test(v) ? v : encodeURIComponent(v));

async function adminRaw<T>(path: string, body: Blob, headers: Record<string, string>): Promise<T> {
  await whenAdmin();
  const token = await adminToken();
  if (!token) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST', body, cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': body.type || 'application/octet-stream', ...headers },
  });
  let json: Raw = {};
  try { json = (await res.json()) as Raw; } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, typeof json.error === 'string' ? json.error : 'upload_failed', { ...json, message: typeof json.message === 'string' ? json.message : `The upload failed (${res.status}).` });
  return json as T;
}

export const uploadArt = (id: string, blob: Blob, fileName: string) =>
  adminRaw<{ design?: Raw }>(`${dp(id)}/art`, blob, { 'x-file-name': fileNameHeader(fileName) });
export const uploadArtPreview = (id: string, blob: Blob) => adminRaw<unknown>(`${dp(id)}/art-preview`, blob, {});
export const uploadPrint = (id: string, blob: Blob) => adminRaw<{ design?: Raw }>(`${dp(id)}/print`, blob, {});
export const uploadPrintPreview = (id: string, blob: Blob) => adminRaw<unknown>(`${dp(id)}/print-preview`, blob, {});
export async function uploadPhoto(id: string, blob: Blob, fileName: string, kind: 'model' | 'flat' | 'closeup', colour: string): Promise<StudioPhoto> {
  const r = await adminRaw<{ photo: Raw }>(`${dp(id)}/photos`, blob, {
    'x-kind': kind, 'x-colour': headerSafe(colour), 'x-file-name': fileNameHeader(fileName),
  });
  return normPhoto(r.photo);
}

/* ───────── client-side mirror of lib/pod/specs.ts (display only; the server is the authority) ───────── */

export const PRINT_SPECS = {
  min_dpi: 300, max_px: 5000, max_upload_bytes: 15 * 1024 * 1024,
  areas: {
    mens_tee: { front: [15.6, 19.6], back: [15.6, 19.6], label: "Men's T-shirt" },
    womens_tee: { front: [11.6, 14.5], back: [11.6, 14.5], label: "Women's T-shirt" },
    kids_tee: { front: [11.6, 14.5], back: [11.6, 14.5], label: 'Kids T-shirt' },
    toddler_tee: { front: [7, 7.8], back: [7, 7.8], label: 'Toddler T-shirt' },
    hoodie: { front: [12, 10.5], back: [14, 16], label: 'Hoodie' },
    sweatshirt: { front: [11.6, 14.5], back: [11.6, 14.5], label: 'Sweatshirt' },
    polo: { front: [4, 4], back: [14, 16], label: 'Polo T-shirt' },
    crop_top: { front: [12, 10], back: [12, 10], label: 'Crop top' },
    crop_hoodie: { front: [10.6, 10.6], back: [10.6, 10.6], label: 'Crop hoodie' },
    oversized_tee: { front: [15.6, 19.6], back: [15.6, 19.6], label: 'Oversized T-shirt' },
    full_sleeve_tee: { front: [15.6, 19.6], back: [15.6, 19.6], label: 'Full sleeve T-shirt' },
    vneck_tee: { front: [16, 20], back: [16, 20], label: 'V-neck T-shirt' },
  },
} as const;
export type SpecKind = keyof typeof PRINT_SPECS.areas;

export function areaFor(kind: string, side: PrintSide): { w: number; h: number; label: string } {
  const a = (PRINT_SPECS.areas as Record<string, { front: readonly number[]; back: readonly number[]; label: string }>)[kind] ?? PRINT_SPECS.areas.mens_tee;
  const d = a[side];
  return { w: d[0], h: d[1], label: a.label };
}

/** px / 300, one decimal (mirrors maxSharpInches on the server). */
export const maxSharpInches = (pxW: number, pxH: number): { w: number; h: number } => ({
  w: Math.round((pxW / PRINT_SPECS.min_dpi) * 10) / 10, h: Math.round((pxH / PRINT_SPECS.min_dpi) * 10) / 10,
});

/* ───────── small display helpers ───────── */

export const fmtIn = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
export const fmtBytes = (b: number): string => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** GST 18% added at checkout (mockup arithmetic: price 799 → 144 → 943). */
export const gstOn = (rupees: number): number => Math.round(rupees * 0.18);

/** "Suggest prices": cost x 1.8, rounded up to the next price ending in 49 or 99 (₹x49 / ₹x99). */
export function suggestPrice(costRupees: number): number {
  let n = Math.max(1, Math.ceil(costRupees * 1.8));
  while (n % 50 !== 49) n += 1;
  return n;
}

/** Fallback swatches (the mockup's five) when the catalogue carries no colour hex. */
export const DEFAULT_COLOURS: { name: string; hex: string }[] = [
  { name: 'Black', hex: '#1f1b1a' }, { name: 'Maroon', hex: '#6e2326' }, { name: 'Navy', hex: '#1d2a4a' },
  { name: 'Bottle green', hex: '#1f4a35' }, { name: 'Off-white', hex: '#f4ede0' },
];
export function hexForColour(name: string, fits: Fits | null): string {
  for (const it of fits?.items ?? []) {
    const c = it.catalog?.colours.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (c?.hex) return c.hex;
  }
  return DEFAULT_COLOURS.find((x) => x.name.toLowerCase() === name.toLowerCase())?.hex ?? '#888888';
}
