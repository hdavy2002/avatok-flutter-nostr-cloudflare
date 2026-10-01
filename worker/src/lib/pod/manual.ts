// [AUMFE-POD-CORE-1] The `manual` print partner: today's hand workflow (the owner places the order in the partner's
// dashboard and types in the AWB). It keeps the Studio usable before any partner API is connected by serving a built-in
// catalogue derived from PRINT_SPECS. Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 3.
import { PRINT_SPECS } from './specs';
import {
  PodError,
  type CatalogProduct, type CatalogVariant, type FulfilmentOrder, type ListingInput, type NormalisedStatus, type PodProvider,
} from './types';

const COLOURS: Array<{ name: string; hex: string }> = [
  { name: 'Black', hex: '#1a1a1a' },
  { name: 'Maroon', hex: '#6b1f2a' },
  { name: 'Navy', hex: '#1b2a4a' },
  { name: 'Bottle green', hex: '#0f4a35' },
  { name: 'Off-white', hex: '#f1ead9' },
  { name: 'White', hex: '#ffffff' },
];
const SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One product per print kind; colours x sizes; cost unknown (null) until a real partner supplies it. */
export function builtInCatalog(): CatalogProduct[] {
  return (Object.keys(PRINT_SPECS.areas) as Array<keyof typeof PRINT_SPECS.areas>).map((kind) => {
    const variants: CatalogVariant[] = [];
    for (const c of COLOURS) {
      for (const size of SIZES) {
        variants.push({
          provider_variant_id: `manual:${kind}:${slug(c.name)}:${size}`,
          colour: c.name, colour_hex: c.hex, size, base_cost_paise: null,
        });
      }
    }
    return {
      provider: 'manual', provider_product_id: `manual:${kind}`, kind,
      name: PRINT_SPECS.areas[kind].label, category: 'Built-in', variants, size_chart: null,
    };
  });
}

export class ManualProvider implements PodProvider {
  id = 'manual' as const;
  label = 'By hand';
  supportsApi = false;

  async testConnection() {
    return { ok: true, message: 'Manual mode: nothing to connect. You place orders in the partner dashboard yourself.' };
  }

  async syncCatalog(): Promise<CatalogProduct[]> { return builtInCatalog(); }

  async uploadDesign(_file: Uint8Array, name: string): Promise<{ design_ref: string }> {
    return { design_ref: `manual:${name}` };
  }

  async createListing(input: ListingInput): Promise<{ listing_ref: string; variant_refs: Record<string, string> }> {
    const variant_refs: Record<string, string> = {};
    for (const v of input.variants) variant_refs[v.provider_variant_id] = v.provider_variant_id;
    return { listing_ref: `manual:${input.provider_product_id}`, variant_refs };
  }

  async serviceability(_pincode: string, _weight_g: number): Promise<{ ok: boolean; eta_days: number | null }> {
    return { ok: true, eta_days: null };
  }

  async findOrderByReference(_reference_number: string): Promise<{ provider_order_id: string } | null> { return null; }

  async createOrder(_order: FulfilmentOrder): Promise<{ provider_order_id: string; raw: unknown }> {
    throw new PodError('not_configured', "Place this order in the partner's dashboard, then use 'Sent to Printrove'.");
  }

  async getOrder(_provider_order_id: string): Promise<NormalisedStatus> {
    throw new PodError('not_configured', 'Manual mode has no partner order to look up.');
  }
}
