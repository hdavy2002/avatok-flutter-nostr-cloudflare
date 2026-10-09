/* [HF-TOPUP-1] Wallet top-up client. Worker: POST /api/hf/wallet/topup, GET /api/hf/wallet/topup/:id, flags from /api/config `hfTopup`.
 * The gateway checkout is loaded lazily, by name, from the `client_payload` each worker adapter already returns. Adding a gateway
 * here = one entry in LOADERS. Nothing loads until a signed-in buyer taps an amount. */
import { ApiError, request } from './apiClient';

export interface TopupConfig { enabled: boolean; gateway: string; packs: number[]; minRupees: number; maxRupees: number; testMode: boolean; confirmAboveRupees: number }
export interface TopupStatus { id: string; status: 'created' | 'paid' | 'failed' | 'refunded' | 'expired'; credited: boolean; amountRupees: number }
export interface TopupOrder { topupId: string; gateway: string; client_payload: Record<string, string | number>; testMode: boolean; amountRupees: number }

const OFF: TopupConfig = { enabled: false, gateway: 'none', packs: [], minRupees: 0, maxRupees: 0, testMode: false, confirmAboveRupees: 0 };

export async function fetchTopupConfig(): Promise<TopupConfig> {
  try {
    const c = await request<{ hfTopup?: Partial<TopupConfig> }>('/api/config', { timeoutMs: 8000 });
    const t = c?.hfTopup;
    if (!t || t.enabled !== true || !t.gateway || t.gateway === 'none') return OFF;
    return { enabled: true, gateway: String(t.gateway), packs: Array.isArray(t.packs) ? t.packs.map(Number).filter(n => n > 0) : [], minRupees: Number(t.minRupees) || 0, maxRupees: Number(t.maxRupees) || 0, testMode: t.testMode === true, confirmAboveRupees: Number.isFinite(Number(t.confirmAboveRupees)) ? Number(t.confirmAboveRupees) : 1000 };
  } catch { return OFF; }
}

async function authed<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) throw new ApiError(401, 'no_session');
  return request<T>(path, { method, auth: token, body, headers, timeoutMs: 25_000 });
}

export const startTopup = (amount: number): Promise<TopupOrder> =>
  authed<TopupOrder>('POST', '/api/hf/wallet/topup', { amount }, { 'Idempotency-Key': crypto.randomUUID() });
export const topupStatus = (id: string): Promise<TopupStatus> => authed<TopupStatus>('GET', `/api/hf/wallet/topup/${encodeURIComponent(id)}`);

export function topupErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Please sign in to add money.';
    if (e.status === 429) return 'Too many attempts. Please try again in a while.';
    if (e.status === 503) return 'Adding money is not open right now.';
    const b = (e.body && typeof e.body === 'object' ? e.body : {}) as { message?: string };
    if (b.message) return b.message;
  }
  return 'We could not start the payment. Please try again.';
}

// ── gateway checkout loaders ────────────────────────────────────────────────
type Payload = Record<string, string | number>;
/** Resolves when the buyer finished (paid or not: the server decides), rejects with 'dismissed' if they closed the sheet. */
type Loader = (p: Payload, o: { testMode: boolean }) => Promise<void>;

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => res();
      s.onerror = () => { scripts.delete(src); rej(new Error('script_failed')); };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

const LOADERS: Record<string, Loader> = {
  razorpay: async (p) => {
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    const Rzp = (window as unknown as { Razorpay?: new (o: unknown) => { open(): void } }).Razorpay;
    if (!Rzp) throw new Error('script_failed');
    await new Promise<void>((resolve, reject) => {
      new Rzp({
        key: String(p.key_id), order_id: String(p.razorpay_order_id), amount: Number(p.amount), currency: String(p.currency || 'INR'),
        handler: () => resolve(),
        modal: { ondismiss: () => reject(new Error('dismissed')) },
      }).open();
    });
  },
  cashfree: async (p, o) => {
    await loadScript('https://sdk.cashfree.com/js/v3/cashfree.js');
    const CF = (window as unknown as { Cashfree?: (c: { mode: string }) => { checkout(o: unknown): Promise<unknown> } }).Cashfree;
    if (!CF) throw new Error('script_failed');
    // Cashfree resolves on modal close too; the server poll afterwards is what decides paid or not.
    await CF({ mode: o.testMode ? 'sandbox' : 'production' }).checkout({ paymentSessionId: String(p.payment_session_id), redirectTarget: '_modal' });
  },
  paytm: async (p) => {
    // Paytm's Show Payment Page flow: POST a form to payment_url; the buyer returns through the webhook redirect to /wallet?topup=<id>.
    const f = document.createElement('form');
    f.method = 'POST'; f.action = String(p.payment_url);
    for (const [k, v] of [['mid', p.mid], ['orderId', p.order_id], ['txnToken', p.txn_token]] as const) {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = String(v); f.appendChild(i);
    }
    document.body.appendChild(f);
    f.submit();
    await new Promise<void>(() => { /* page navigates away */ });
  },
};

export const gatewaySupported = (g: string): boolean => g in LOADERS;
export const openCheckout = (gateway: string, payload: Payload, testMode: boolean): Promise<void> => {
  const l = LOADERS[gateway];
  return l ? l(payload, { testMode }) : Promise.reject(new Error('unsupported_gateway'));
};

/** Poll until the worker has credited the wallet (webhook or its own gateway read-back). Resolves the last status seen. */
export async function waitForTopup(id: string, opts: { tries?: number; gapMs?: number } = {}): Promise<TopupStatus | null> {
  const tries = opts.tries ?? 30, gap = opts.gapMs ?? 2000;
  let last: TopupStatus | null = null;
  for (let i = 0; i < tries; i++) {
    try { last = await topupStatus(id); } catch { /* transient: keep trying */ }
    if (last && (last.credited || last.status === 'failed' || last.status === 'expired' || last.status === 'refunded')) return last;
    await new Promise(r => setTimeout(r, gap));
  }
  return last;
}
