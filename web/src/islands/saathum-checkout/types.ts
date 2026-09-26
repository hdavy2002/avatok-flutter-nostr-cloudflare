/* [SAATHUM-CHECKOUT-UI 2026-09-26] Local types mirroring the HTTP contract in
 * Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md exactly. A1 owns the worker side;
 * these are the wire shapes this island reads and writes. Do not add a field
 * the spec does not list — the backend will not send it.
 */

export type CheckoutStep = 'you' | 'sankalp' | 'offerings' | 'review' | 'pay' | 'done';

export interface ChadhavaItem {
  id: string;
  title: string;
  description?: string | null;
  price_rupees: number;
  image_url?: string | null;
}

export interface CheckoutConfigListing {
  id: string;
  title: string;
  starts_at: number;
  duration_min: number;
  price_rupees: number;
  prasad_available: boolean;
  prasad_price_rupees: number;
  visibility: 'public' | 'private';
  cover_url: string | null;
  deity?: string | null;
  location?: string | null;
}

export interface CheckoutConfig {
  listing: CheckoutConfigListing;
  chadhava: ChadhavaItem[];
  dakshina_presets: number[];
  gst: { enabled: boolean; rate_pct: number };
  bookable: boolean;
  reason?: string;
}

export interface QuoteLine {
  kind: 'ticket' | 'chadhava' | 'dakshina' | 'prasad';
  id?: string;
  label: string;
  qty: number;
  unit_rupees: number;
  amount_rupees: number;
}

export interface Quote {
  lines: QuoteLine[];
  subtotal_rupees: number;
  gst_rate_pct: number;
  gst_rupees: number;
  total_rupees: number;
}

export interface Address {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface Sankalp {
  name: string;
  gotra?: string;
  family?: string[];
  wish?: string;
}

export interface CheckoutPayment {
  upi_url: string | null;
  vpa: string;
  payee_name: string;
  amount_rupees: number;
  expires_at: number;
  utr: string | null;
  reference_revision: number;
  reason_code: string | null;
}

export type CheckoutStatus = 'awaiting_payment' | 'confirmed' | 'review_pending' | 'expired';

export interface Checkout {
  checkout_id: string;
  listing: { id: string; title: string; starts_at: number; duration_min: number; cover_url: string | null };
  status: CheckoutStatus;
  quote: Quote;
  sankalp: Sankalp;
  prasad: boolean;
  address: Address | null;
  can_edit_address: boolean;
  payment: CheckoutPayment;
  receipt_url: string | null;
  confirmed_at: number | null;
  created_at: number;
}

export interface ChadhavaSelection {
  id: string;
  qty: number;
}

export interface OfferingsState {
  chadhava: ChadhavaSelection[];
  dakshina_rupees: number;
  prasad: boolean;
}
