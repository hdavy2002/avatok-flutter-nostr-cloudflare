// [AUMFE-POD-CORE-1] Printrove adapter. Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 3. This is the ONLY file
// that may name a Printrove field. The API docs (2021) give no response examples and no units for design `dimensions`, so
// every response mapping here is DEFENSIVE (several plausible keys, raw kept) and every guess is marked `// PROBE:`;
// scripts/printrove_probe.mjs prints the real shapes so they can be corrected the day the owner supplies the login.
//
// Secrets: PRINTROVE_EMAIL / PRINTROVE_PASSWORD are Worker secrets. They are used only in the token call body; they are
// never put in KV, logs, error details, PostHog or any response. The bearer token is cached in KV (TOKENS) at
// `pod:printrove:token` until 1 h before it expires.
import type { Env } from '../../types';
import { trackException } from '../../hooks';
import { PRINT_SPECS } from './specs';
import {
  PodError,
  type CatalogProduct, type CatalogVariant, type FulfilmentOrder, type ListingInput, type NormalisedState, type NormalisedStatus,
  type PodProvider,
} from './types';

const BASE = 'https://api.printrove.com/api/external/';
const TOKEN_KV_KEY = 'pod:printrove:token';
const TOKEN_REFRESH_BEFORE_MS = 3_600_000; // refresh 1 h before expiry
const MIN_GAP_MS = 500; // <= 2 requests per second
const MAX_TRIES = 3;
const PAGE_SIZE = 20; // lists return at most 20 per page
const MAX_PAGES = 50;
const MAX_DETAIL_FETCHES = 80; // product-detail calls per catalogue sync (each is one rate-limited request)
const REQUEST_TIMEOUT_MS = 25_000;
// PROBE: units of design `dimensions` are undocumented. Assumed pixels at 300 DPI; change to 1 if the probe shows inches.
const DIMENSION_UNITS_PER_INCH = 300;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const pick = (o: Rec | null, keys: string[]): unknown => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};
const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const r = rec(v);
  if (r) return str(pick(r, ['name', 'label', 'title', 'value']));
  return null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- rate limit: one slot every MIN_GAP_MS, per isolate ---------------------------------------------------------------
let nextSlot = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

// --- token cache (isolate memo + KV) ---------------------------------------------------------------------------------
type StoredToken = { token: string; expires_at: number };
let tokenMemo: StoredToken | null = null;
let tokenInflight: Promise<StoredToken> | null = null;

/** PROBE: `expires_at` format is undocumented; accepts epoch seconds, epoch ms or a date string. */
function parseExpiry(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const asNum = Number(v);
    if (Number.isFinite(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now() + 2 * 3_600_000; // unknown: assume 2 h so the 1 h refresh margin still leaves 1 h of cache
}

/** Classify a product into a Studio print kind from its name/category (the API has no kind field). */
export function classifyKind(name: string, category: string | null): string {
  const t = `${name} ${category ?? ''}`.toLowerCase();
  const isTee = /\b(t-?shirt|tee|tshirt)s?\b|t shirt/.test(t);
  if (t.includes('crop') && t.includes('hood')) return 'crop_hoodie';
  if (t.includes('crop')) return 'crop_top';
  if (t.includes('hood')) return 'hoodie';
  if (t.includes('sweat')) return 'sweatshirt';
  if (t.includes('polo')) return 'polo';
  if (isTee && /toddler|infant|baby/.test(t)) return 'toddler_tee';
  if (isTee && /\b(kid|kids|boys?|girls?|youth|junior)\b/.test(t)) return 'kids_tee';
  if (isTee && /\b(women|womens|women's|ladies|female)\b/.test(t)) return 'womens_tee';
  if (isTee) return 'mens_tee';
  return 'other';
}

/** Map a partner status string to our normalised state. Unknown statuses stay `sent` (provider_status is kept verbatim). */
export function mapPartnerStatus(status: string): NormalisedState {
  const s = status.toLowerCase();
  if (/undeliver|rto|return|fail|reject|hold|problem|issue|exception|lost|damag/.test(s)) return 'problem';
  if (/cancel/.test(s)) return 'cancelled';
  if (/deliver/.test(s)) return 'delivered';
  if (/ship|dispatch|transit|out for|picked/.test(s)) return 'shipped';
  if (/print|production|process|packed|pack|ready|quality|manufactur/.test(s)) return 'printing';
  return 'sent';
}

type Opts = { query?: Record<string, string | number | undefined>; json?: unknown; form?: FormData; auth?: boolean };

export class PrintroveProvider implements PodProvider {
  id = 'printrove' as const;
  label = 'Printrove';
  supportsApi = true;

  constructor(private env: Env) {}

  private configured(): boolean {
    return Boolean(this.env.PRINTROVE_EMAIL?.trim() && this.env.PRINTROVE_PASSWORD?.trim());
  }

  // --- auth ---------------------------------------------------------------------------------------------------------
  private async trackSoft(e: unknown, route: string): Promise<void> {
    await trackException(this.env, e, { route, handled: true, app_name: 'saathum' });
  }

  private async readKvToken(): Promise<StoredToken | null> {
    try {
      const v = (await this.env.TOKENS.get(TOKEN_KV_KEY, 'json')) as StoredToken | null;
      return v && typeof v.token === 'string' && typeof v.expires_at === 'number' ? v : null;
    } catch (e) {
      await this.trackSoft(e, 'pod/printrove/token_read');
      return null;
    }
  }

  private async fetchToken(): Promise<StoredToken> {
    if (!this.configured()) throw new PodError('not_configured', 'Printrove login is not set. Add PRINTROVE_EMAIL and PRINTROVE_PASSWORD as Worker secrets.');
    await throttle();
    let res: Response;
    try {
      res = await fetch(`${BASE}token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: this.env.PRINTROVE_EMAIL, password: this.env.PRINTROVE_PASSWORD }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new PodError('unavailable', 'Could not reach Printrove to log in.', { cause: String((e as Error)?.message ?? e) });
    }
    if (res.status === 401 || res.status === 403 || res.status === 422 || res.status === 400) {
      throw new PodError('auth_failed', 'Printrove rejected the login email/password.', { status: res.status }); // never echo the body
    }
    if (!res.ok) throw new PodError('unavailable', `Printrove login failed (HTTP ${res.status}).`, { status: res.status });
    const body = rec(await res.json().catch(() => null));
    const data = rec(pick(body, ['data'])) ?? body;
    const token = str(pick(data, ['access_token', 'token'])); // PROBE: token key
    if (!token) throw new PodError('unavailable', 'Printrove login returned no token.', { keys: body ? Object.keys(body) : null });
    const expires_at = parseExpiry(pick(data, ['expires_at', 'expires_in', 'expiry'])); // PROBE: expiry key + format
    const stored: StoredToken = { token, expires_at };
    const ttl = Math.floor((expires_at - TOKEN_REFRESH_BEFORE_MS - Date.now()) / 1000);
    if (ttl >= 60) {
      try { await this.env.TOKENS.put(TOKEN_KV_KEY, JSON.stringify(stored), { expirationTtl: ttl }); }
      catch (e) { await this.trackSoft(e, 'pod/printrove/token_write'); }
    }
    return stored;
  }

  private async getToken(force = false): Promise<StoredToken> {
    const fresh = (t: StoredToken | null) => (t && t.expires_at - TOKEN_REFRESH_BEFORE_MS > Date.now() ? t : null);
    if (!force) {
      const memo = fresh(tokenMemo);
      if (memo) return memo;
      const kv = fresh(await this.readKvToken());
      if (kv) { tokenMemo = kv; return kv; }
    }
    if (!tokenInflight) {
      tokenInflight = this.fetchToken()
        .then((t) => { tokenMemo = t; return t; })
        .finally(() => { tokenInflight = null; });
    }
    return tokenInflight;
  }

  private async dropToken(): Promise<void> {
    tokenMemo = null;
    try { await this.env.TOKENS.delete(TOKEN_KV_KEY); }
    catch (e) { await this.trackSoft(e, 'pod/printrove/token_drop'); }
  }

  // --- HTTP ---------------------------------------------------------------------------------------------------------
  /** One logical call: <= 2 req/s, retry 429/5xx/network 3 times with backoff, one re-login on 401. Returns parsed JSON. */
  private async call(method: 'GET' | 'POST', path: string, opts: Opts = {}): Promise<unknown> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let relogged = false;
    let lastErr: PodError | null = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const tok = await this.getToken();
      await throttle();
      const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${tok.token}` };
      let body: BodyInit | undefined;
      if (opts.form) body = opts.form;
      else if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
      let res: Response;
      try {
        res = await fetch(url.toString(), { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (e) {
        lastErr = new PodError('unavailable', 'Could not reach Printrove.', { cause: String((e as Error)?.message ?? e) });
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      if (res.status === 401 && !relogged) {
        relogged = true;
        await this.dropToken();
        attempt--; // the re-login retry does not consume a backoff try
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new PodError('unavailable', `Printrove is busy (HTTP ${res.status}).`, { status: res.status });
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 600 * 2 ** (attempt - 1));
        continue;
      }
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text.slice(0, 500); }
      if (res.ok) return parsed;
      const detail = { status: res.status, body: typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 800) };
      const msg = str(pick(rec(parsed), ['message', 'error'])) ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new PodError('auth_failed', `Printrove refused the request: ${msg}`, detail);
      if (res.status === 404) throw new PodError('not_found', `Printrove: ${msg}`, detail);
      throw new PodError('rejected', `Printrove rejected the request: ${msg}`, detail);
    }
    throw lastErr ?? new PodError('unavailable', 'Printrove did not respond.');
  }

  /** PROBE: list envelope. Finds the items array in a bare array or under data/products/categories/orders/items/results. */
  private items(body: unknown, depth = 0): unknown[] {
    if (Array.isArray(body)) return body;
    const r = rec(body);
    if (!r || depth > 2) return [];
    for (const k of ['data', 'products', 'categories', 'orders', 'designs', 'items', 'results']) {
      const v = r[k];
      if (Array.isArray(v)) return v;
      const inner = rec(v);
      if (inner) { const found = this.items(inner, depth + 1); if (found.length) return found; }
    }
    return [];
  }

  /** Pages through a list (max 20 per page). `stop` ends early. Guards against an API that ignores `page` (repeated page). */
  private async paginate(path: string, query: Opts['query'] = {}, stop?: (items: unknown[]) => boolean): Promise<unknown[]> {
    const all: unknown[] = [];
    let prevSig = '';
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.call('GET', path, { query: { ...query, page } }); // PROBE: page param name
      const got = this.items(body);
      if (!got.length) break;
      const sig = JSON.stringify(got.slice(0, 3));
      if (sig === prevSig) break; // same page again: `page` was ignored
      prevSig = sig;
      all.push(...got);
      if (stop?.(all)) break;
      const meta = rec(pick(rec(body), ['meta', 'pagination']));
      const last = num(pick(meta, ['last_page', 'total_pages'])) ?? num(pick(rec(body), ['last_page', 'total_pages'])); // PROBE
      if (last !== null && page >= last) break;
      if (got.length < PAGE_SIZE) break;
    }
    return all;
  }

  // --- PodProvider --------------------------------------------------------------------------------------------------
  async testConnection(): Promise<{ ok: boolean; message: string; token_expires_at?: number }> {
    try {
      const t = await this.getToken(true);
      return { ok: true, message: 'Connected to Printrove.', token_expires_at: t.expires_at };
    } catch (e) {
      if (e instanceof PodError) return { ok: false, message: e.message };
      throw e;
    }
  }

  /** Flatten any variant-looking objects (an id plus a colour key) found inside a product payload, carrying a parent size. */
  private collectVariants(node: unknown, inheritedSize: string | null, out: CatalogVariant[], depth = 0): void {
    if (depth > 4) return;
    if (Array.isArray(node)) { for (const n of node) this.collectVariants(n, inheritedSize, out, depth + 1); return; }
    const o = rec(node);
    if (!o) return;
    const size = str(pick(o, ['size', 'size_name', 'size_label'])) ?? inheritedSize; // PROBE: size key
    const id = str(pick(o, ['id', 'variant_id']));
    const colourRaw = pick(o, ['colour', 'color', 'colour_name', 'color_name']); // PROBE: colour key (string or {name,hex})
    const colour = str(colourRaw);
    if (id && colour && size) {
      const hex = str(pick(rec(colourRaw), ['hex', 'code', 'color_code'])) ?? str(pick(o, ['colour_hex', 'color_hex', 'hex', 'color_code', 'colour_code'])); // PROBE
      const rupees = num(pick(o, ['price', 'base_price', 'cost', 'mrp'])); // PROBE: assumed rupees
      const sku = str(pick(o, ['sku']));
      const v: CatalogVariant = { provider_variant_id: id, colour, colour_hex: hex && /^#?[0-9a-f]{3,8}$/i.test(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : null, size, base_cost_paise: rupees === null ? null : Math.round(rupees * 100) };
      if (sku) v.sku = sku;
      out.push(v);
      return;
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') this.collectVariants(v, size, out, depth + 1);
  }

  private sizeChart(p: Rec): CatalogProduct['size_chart'] {
    const raw = pick(p, ['size_chart', 'sizechart', 'measurements']); // PROBE: size-chart key + row keys
    const rows = Array.isArray(raw) ? raw : this.items(raw);
    const out: Array<{ size: string; chest_in?: number; length_in?: number }> = [];
    for (const r of rows) {
      const o = rec(r);
      const size = str(pick(o, ['size', 'name']));
      if (!o || !size) continue;
      const row: { size: string; chest_in?: number; length_in?: number } = { size };
      const chest = num(pick(o, ['chest', 'chest_in', 'width', 'bust']));
      const len = num(pick(o, ['length', 'length_in', 'height']));
      if (chest !== null) row.chest_in = chest;
      if (len !== null) row.length_in = len;
      out.push(row);
    }
    return out.length ? out : null;
  }

  async syncCatalog(): Promise<CatalogProduct[]> {
    const categories = await this.paginate('categories');
    const products: CatalogProduct[] = [];
    const failures: Array<{ id: string; why: string }> = [];
    let detail = 0;
    outer: for (const c of categories) {
      const cat = rec(c);
      const catId = str(pick(cat, ['id', 'category_id']));
      const catName = str(pick(cat, ['name', 'title'])) ;
      if (!catId) continue;
      const list = await this.paginate(`categories/${encodeURIComponent(catId)}`);
      for (const pr of list) {
        const p = rec(pr);
        const pid = str(pick(p, ['id', 'product_id']));
        const name = str(pick(p, ['name', 'title'])) ?? `Product ${pid}`;
        if (!pid) continue;
        const kind = classifyKind(name, catName);
        if (kind === 'other') continue; // the Studio only offers the known garment kinds; skip the rest to save calls
        if (detail >= MAX_DETAIL_FETCHES) break outer;
        detail++;
        try {
          const body = await this.call('GET', `categories/${encodeURIComponent(catId)}/products/${encodeURIComponent(pid)}`);
          const full = rec(pick(rec(body), ['product', 'data'])) ?? rec(body) ?? {};
          const variants: CatalogVariant[] = [];
          this.collectVariants(full, null, variants);
          const seen = new Set<string>();
          const unique = variants.filter((v) => (seen.has(v.provider_variant_id) ? false : (seen.add(v.provider_variant_id), true)));
          if (!unique.length) { failures.push({ id: pid, why: 'no variants recognised in product payload' }); continue; }
          products.push({
            provider: 'printrove', provider_product_id: pid, kind, name: str(pick(full, ['name', 'title'])) ?? name,
            category: catName, variants: unique, size_chart: this.sizeChart(full),
          });
        } catch (e) {
          if (e instanceof PodError && (e.code === 'auth_failed' || e.code === 'not_configured')) throw e;
          failures.push({ id: pid, why: String((e as Error)?.message ?? e) });
        }
      }
    }
    if (failures.length) {
      await trackException(this.env, new Error(`printrove catalogue sync: ${failures.length} product(s) skipped; first: ${failures[0].why}`), {
        route: 'pod/printrove/sync', handled: true, app_name: 'saathum', extra: { skipped: failures.length, first_id: failures[0].id },
      });
    }
    if (!products.length) throw new PodError('unavailable', 'Printrove returned no usable products.', { skipped: failures.length });
    return products;
  }

  async uploadDesign(file: Uint8Array, name: string): Promise<{ design_ref: string }> {
    if (file.byteLength > PRINT_SPECS.max_upload_bytes) throw new PodError('rejected', 'Print file is larger than the 15 MB upload limit.');
    const form = new FormData();
    const safe = name.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'design';
    form.append('file', new Blob([file], { type: 'image/png' }), safe.endsWith('.png') ? safe : `${safe}.png`);
    const body = await this.call('POST', 'designs', { form });
    const r = rec(body);
    const d = rec(pick(r, ['design', 'data'])) ?? r;
    const id = str(pick(d, ['id', 'design_id'])); // PROBE: design id key
    if (!id) throw new PodError('unavailable', 'Printrove accepted the design but returned no id.', { keys: r ? Object.keys(r) : null });
    return { design_ref: id };
  }

  async createListing(input: ListingInput): Promise<{ listing_ref: string; variant_refs: Record<string, string> }> {
    const p = input.placement;
    const dims = { // PROBE: units + origin of dimensions are undocumented (see DIMENSION_UNITS_PER_INCH)
      width: Math.round(p.width_in * DIMENSION_UNITS_PER_INCH), height: Math.round(p.height_in * DIMENSION_UNITS_PER_INCH),
      top: Math.round(p.top_in * DIMENSION_UNITS_PER_INCH), left: Math.round(p.left_in * DIMENSION_UNITS_PER_INCH),
    };
    const asId = (s: string): string | number => (/^\d+$/.test(s) ? Number(s) : s);
    const body = await this.call('POST', 'products', {
      json: {
        name: input.name, product_id: asId(input.provider_product_id),
        design: { [p.side]: { id: asId(input.design_ref), dimensions: dims } },
        variants: input.variants.map((v) => ({ product_id: asId(v.provider_variant_id), sku: v.sku })), // PROBE: `product_id` here is the variant id
        is_plain: false,
      },
    });
    const r = rec(body);
    const d = rec(pick(r, ['product', 'data'])) ?? r;
    const listing_ref = str(pick(d, ['id', 'product_id'])); // PROBE: listing id key
    if (!listing_ref) throw new PodError('unavailable', 'Printrove created the product but returned no id.', { keys: r ? Object.keys(r) : null });
    // PROBE: map our catalogue variant id -> the listing's own variant id. Falls back to identity for any we cannot match.
    const variant_refs: Record<string, string> = {};
    const returned = Array.isArray(pick(d, ['variants'])) ? (pick(d, ['variants']) as unknown[]) : [];
    for (const rv of returned) {
      const o = rec(rv);
      const own = str(pick(o, ['id']));
      const base = str(pick(o, ['variant_id', 'product_variant_id', 'base_variant_id', 'product_id']));
      if (own && base) variant_refs[base] = own;
    }
    for (const v of input.variants) if (!variant_refs[v.provider_variant_id]) variant_refs[v.provider_variant_id] = v.provider_variant_id;
    return { listing_ref, variant_refs };
  }

  async serviceability(pincode: string, weight_g: number): Promise<{ ok: boolean; eta_days: number | null }> {
    try {
      const body = await this.call('GET', 'serviceability', { query: { country: 'India', pincode, weight: weight_g, cod: 'false' } });
      const r = rec(body);
      const d = rec(pick(r, ['data'])) ?? r;
      const flag = pick(d, ['serviceable', 'is_serviceable', 'available', 'success']); // PROBE: serviceable flag
      const list = this.items(body);
      const ok = typeof flag === 'boolean' ? flag : list.length > 0;
      const eta = num(pick(d, ['eta_days', 'etd', 'estimated_delivery_days', 'delivery_days', 'tat'])); // PROBE: ETA key
      return { ok, eta_days: eta };
    } catch (e) {
      if (e instanceof PodError && (e.code === 'rejected' || e.code === 'not_found')) return { ok: false, eta_days: null };
      throw e;
    }
  }

  async findOrderByReference(reference_number: string): Promise<{ provider_order_id: string } | null> {
    const isMatch = (o: unknown) => str(pick(rec(o), ['reference_number', 'reference'])) === reference_number; // PROBE: reference key
    // The filter may be ignored, so verify client-side and keep paging until found.
    const list = await this.paginate('orders', { reference_number }, (items) => items.some(isMatch));
    const hit = list.find(isMatch);
    const id = hit ? str(pick(rec(hit), ['id', 'order_id'])) : null;
    return id ? { provider_order_id: id } : null;
  }

  async createOrder(order: FulfilmentOrder): Promise<{ provider_order_id: string; raw: unknown }> {
    const c = order.customer;
    const asId = (s: string): string | number => (/^\d+$/.test(s) ? Number(s) : s);
    const json: Rec = {
      reference_number: order.reference_number,
      retail_price: order.retail_price_rupees,
      customer: {
        name: c.name, email: c.email ?? '', number: c.phone10, address1: c.address1, address2: c.address2, address3: c.address3 ?? '',
        pincode: c.pincode, state: c.state, city: c.city, country: c.country,
      },
      order_products: order.lines.map((l) => ({ variant_id: asId(l.provider_variant_id), quantity: l.quantity })),
      cod: false,
    };
    if (order.invoice_url) json.invoice_url = order.invoice_url;
    const raw = await this.call('POST', 'orders', { json });
    const r = rec(raw);
    const d = rec(pick(r, ['order', 'data'])) ?? r;
    const id = str(pick(d, ['id', 'order_id'])); // PROBE: order id key
    if (id) return { provider_order_id: id, raw };
    // The order may exist even though we cannot read its id from the reply: look it up before declaring failure.
    const found = await this.findOrderByReference(order.reference_number);
    if (found) return { provider_order_id: found.provider_order_id, raw };
    throw new PodError('unavailable', 'Printrove accepted the order but returned no id.', { keys: r ? Object.keys(r) : null });
  }

  async getOrder(provider_order_id: string): Promise<NormalisedStatus> {
    const raw = await this.call('GET', `orders/${encodeURIComponent(provider_order_id)}`);
    const r = rec(raw);
    const d = rec(pick(r, ['order', 'data'])) ?? r;
    const provider_status = str(pick(d, ['status', 'order_status', 'state'])) ?? 'unknown'; // PROBE: status key
    const state = mapPartnerStatus(provider_status);
    const shipment = rec(pick(d, ['shipment', 'shipping', 'tracking']));
    const pickS = (keys: string[]) => str(pick(shipment, keys)) ?? str(pick(d, keys));
    return {
      provider_order_id,
      state,
      provider_status,
      courier: pickS(['courier', 'courier_name', 'carrier']), // PROBE
      awb: pickS(['awb', 'awb_number', 'tracking_number', 'tracking_id']), // PROBE
      tracking_url: pickS(['tracking_url', 'tracking_link', 'track_url']), // PROBE
      eta_text: pickS(['estimated_delivery', 'eta', 'expected_delivery']), // PROBE
      problem: state === 'problem' ? (str(pick(d, ['remarks', 'message', 'reason', 'failure_reason'])) ?? provider_status) : null, // PROBE
      raw,
    };
  }
}

/** The cached bearer token's expiry, if one is cached (no network call). Used by the admin page to show "token valid till". */
export async function peekPrintroveToken(env: Env): Promise<{ token_expires_at: number } | null> {
  if (tokenMemo && tokenMemo.expires_at - TOKEN_REFRESH_BEFORE_MS > Date.now()) return { token_expires_at: tokenMemo.expires_at };
  const kv = (await env.TOKENS.get(TOKEN_KV_KEY, 'json')) as StoredToken | null;
  return kv && typeof kv.expires_at === 'number' && kv.expires_at - TOKEN_REFRESH_BEFORE_MS > Date.now() ? { token_expires_at: kv.expires_at } : null;
}
