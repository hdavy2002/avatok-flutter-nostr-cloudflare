// [AUMFE-POD-CORE-1] The swappable print-partner boundary. Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 3.
// No partner field name (Printrove or otherwise) may appear outside lib/pod/<partner>.ts.
export type PodProviderId = 'manual' | 'printrove';
export type PrintSide = 'front' | 'back';
/** Per-side print pricing the partner charges on top of the garment: max(min_price_rupees, rate_per_sq_in_rupees x w_in x h_in). */
export type PrintCostRates = { rate_per_sq_in_rupees: number; min_price_rupees: number };
export type CatalogVariant = { provider_variant_id: string; colour: string; colour_hex: string | null; size: string; base_cost_paise: number | null; sku?: string;
  weight_g?: number; print_cost?: { front?: PrintCostRates; back?: PrintCostRates } };
export type CatalogProduct = { provider: PodProviderId; provider_product_id: string; kind: string; name: string; category: string | null;
  variants: CatalogVariant[]; size_chart: Array<{ size: string; chest_in?: number; length_in?: number }> | null;
  /** The partner's own printable area per side in inches ([w, h]); authoritative over PRINT_SPECS (the fallback) when present. */
  print_area_in?: { front?: [number, number]; back?: [number, number] } };
export type PrintPlacement = { side: PrintSide; width_in: number; height_in: number; top_in: number; left_in: number }; // relative to the print area's top-left
export type ListingInput = { name: string; provider_product_id: string; design_ref: string; placement: PrintPlacement;
  variants: Array<{ provider_variant_id: string; sku: string }> };
export type FulfilmentOrder = { reference_number: string; retail_price_rupees: number;
  customer: { name: string; email: string | null; phone10: string; address1: string; address2: string; address3?: string; city: string; state: string; pincode: string; country: 'India' };
  lines: Array<{ provider_variant_id: string; quantity: number; provider_listing_ref?: string; design_ref?: string; placement?: PrintPlacement }>;
  invoice_url?: string };
export type NormalisedState = 'sent' | 'printing' | 'shipped' | 'delivered' | 'problem' | 'cancelled';
export type NormalisedStatus = { provider_order_id: string; state: NormalisedState; provider_status: string; courier: string | null; awb: string | null;
  tracking_url: string | null; eta_text: string | null; problem: string | null; raw: unknown };
export class PodError extends Error {
  constructor(public code: 'not_configured' | 'auth_failed' | 'rejected' | 'unavailable' | 'not_found', message: string, public detail?: unknown) { super(message); }
}

export interface PodProvider {
  id: PodProviderId;
  label: string;                                   // shown in admin
  supportsApi: boolean;                            // manual = false
  testConnection(): Promise<{ ok: boolean; message: string; token_expires_at?: number }>;
  syncCatalog(): Promise<CatalogProduct[]>;
  uploadDesign(file: Uint8Array, name: string): Promise<{ design_ref: string }>;
  createListing(input: ListingInput): Promise<{ listing_ref: string; variant_refs: Record<string, string> }>; // provider_variant_id -> listing variant id
  serviceability(pincode: string, weight_g: number): Promise<{ ok: boolean; eta_days: number | null; shipping_cost_rupees?: number | null }>;
  findOrderByReference(reference_number: string): Promise<{ provider_order_id: string } | null>;
  createOrder(order: FulfilmentOrder): Promise<{ provider_order_id: string; raw: unknown }>;
  getOrder(provider_order_id: string): Promise<NormalisedStatus>;
}
