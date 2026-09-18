export interface PublicIntent {
  intent_id: string;
  status: 'pending' | 'confirmed' | 'expired' | 'review_pending';
  reason_code: string | null;
  matching_mode: 'payer_vpa' | 'bank_reference';
  amount_paise: number;
  currency: 'INR';
  expires_at: number;
  recover_until: number;
  reference_revision: number;
  confirmed_at?: number | null;
  upi_url?: string;
}
export interface PublicPaymentState {
  intent: PublicIntent | null;
  enabled: boolean;
  busy: boolean;
  error: string;
  reference: string;
  started: boolean;
}
interface Session { bearer: string; request_key: string; intent_id?: string; reference?: string; started?: boolean }
const STORAGE_KEY = 'hdfc-public-payment-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 3000;
export const initialPaymentState: PublicPaymentState = {intent: null, enabled: false, busy: false,
  error: '', reference: '', started: false};

export function paymentAmount(paise: number): string {
  return new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR',
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2}).format(paise / 100);
}
function persist(saved: Session) {
  const value = JSON.stringify(saved);
  try { sessionStorage.setItem(STORAGE_KEY, value); } catch { /* continue with local recovery */ }
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* storage can be unavailable in private mode */ }
}
function session(): Session {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(STORAGE_KEY); } catch { /* continue */ }
  if (!raw) try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* continue */ }
  if (raw) {
    const saved = JSON.parse(raw) as Session;
    if (!/^[0-9a-f]{64}$/.test(saved.bearer) || !UUID.test(saved.request_key)
      || (saved.intent_id !== undefined && !UUID.test(saved.intent_id))
      || (saved.reference !== undefined && typeof saved.reference !== 'string')
      || (saved.started !== undefined && typeof saved.started !== 'boolean')) throw new Error('session');
    return saved;
  }
  const saved: Session = {
    bearer: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
    request_key: crypto.randomUUID(),
  };
  persist(saved);
  return saved;
}
function parseIntent(value: unknown, expectedId?: string): PublicIntent {
  const intent = value as PublicIntent;
  if (!intent || !UUID.test(intent.intent_id) || (expectedId && intent.intent_id !== expectedId)
    || !['pending', 'confirmed', 'expired', 'review_pending'].includes(intent.status)
    || !['payer_vpa', 'bank_reference'].includes(intent.matching_mode)
    || !Number.isSafeInteger(intent.amount_paise) || intent.amount_paise <= 0 || intent.currency !== 'INR'
    || !Number.isFinite(intent.expires_at) || !Number.isFinite(intent.recover_until)
    || !Number.isSafeInteger(intent.reference_revision) || intent.reference_revision < 0) throw new Error('invalid');
  if (intent.upi_url) {
    const url = new URL(intent.upi_url);
    if (url.protocol !== 'upi:' || url.hostname !== 'pay' || !url.searchParams.get('pa')
      || url.searchParams.get('cu') !== 'INR'
      || url.searchParams.get('am') !== (intent.amount_paise / 100).toFixed(2)) throw new Error('invalid');
  }
  return intent;
}

/** A saved attempt survives refresh; app return only checks an existing payment. */
export class UpiPublicController {
  private state = {...initialPaymentState};
  private saved: Session | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  constructor(private apiBase: string, private notify: (state: PublicPaymentState) => void) {}
  private publish(patch: Partial<PublicPaymentState>) {
    if (this.stopped) return;
    this.state = {...this.state, ...patch};
    this.notify(this.state);
  }
  async start() {
    try {
      this.saved = session();
      this.saved = {...this.saved, started: true};
      persist(this.saved);
      this.publish({reference: this.saved.reference || '', started: true, busy: false, error: ''});
    } catch {
      this.publish({error: 'This browser could not restore the payment session. Keep any payment receipt and do not pay again.'});
      return;
    }
    await this.refresh();
  }
  anotherPayment() {
    if (!this.saved || this.request || this.state.intent?.status !== 'confirmed') return;
    const next = {...this.saved, request_key: crypto.randomUUID(), intent_id: undefined, started: false};
    try { persist(next); } catch {
      this.publish({error: 'Could not save a new payment session. Please keep this payment receipt.'}); return;
    }
    this.saved = next;
    this.publish({intent: null, enabled: false, started: true, reference: '', error: ''});
    void this.refresh();
  }
  async refresh(recheck = false) {
    if (!this.saved || this.stopped || this.request || this.state.intent?.status === 'confirmed') return;
    const id = this.saved.intent_id;
    if (!id && !this.saved.started) return;
    await this.perform(id ? (recheck ? '/recheck' : '/status?intent_id=' + encodeURIComponent(id)) : '/order',
      id ? (recheck ? {intent_id: id} : undefined) : {request_key: this.saved.request_key});
  }
  async claim(reference: string) {
    const intent = this.state.intent;
    if (!intent || intent.matching_mode !== 'bank_reference' || this.request || intent.status === 'confirmed' || intent.recover_until <= Date.now()) return;
    const value = reference.trim();
    if (!/^\d{12}$/.test(value)) { this.publish({error: 'Enter the 12-digit UPI payment reference shown by your payment app.'}); return; }
    this.saved = {...this.saved!, reference: value};
    persist(this.saved);
    this.publish({reference: value, error: ''});
    await this.perform('/claim', {intent_id: intent.intent_id, bank_reference: value,
      expected_reference_revision: intent.reference_revision});
  }
  private async perform(path: string, body?: object) {
    if (!this.saved || this.stopped || this.request) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const abort = new AbortController();
    this.request = abort;
    const timeout = setTimeout(() => abort.abort(), 10_000);
    this.publish({busy: true});
    try {
      const response = await fetch(this.apiBase + '/api/pay/hdfc-sms/public' + path, {
        method: body ? 'POST' : 'GET', signal: abort.signal, cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: {Authorization: 'Bearer ' + this.saved.bearer, ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
      const value = await response.json();
      if (!response.ok) {
        const messages: Record<string, string> = {
          intent_busy: 'Another payment attempt is still unresolved. Return to its payment page or contact support with your receipt. Do not pay again.',
          reference_must_be_12_digits: 'Enter the 12-digit UPI payment reference shown by your payment app.',
          reference_conflict: 'The payment reference changed. Check again before resubmitting.',
          invalid_reference: 'Enter the UTR or bank reference shown on your payment receipt.',
          rail_paused: 'Payments are temporarily unavailable. If you paid, keep your receipt and do not pay again.',
        };
        if (path === '/order' && response.status === 400
          && ['invalid_payer_vpa', 'invalid_payer_phone'].includes(value.error)) {
          const next = {...this.saved, started: false};
          persist(next);
          this.saved = next;
          this.publish({started: false});
        }
        this.publish({error: messages[value.error] || 'Could not check the payment. Please try again; do not pay again.'});
        return;
      }
      if (value.ok !== true || typeof value.enabled !== 'boolean') throw new Error('invalid');
      const intent = parseIntent(value.intent, this.saved.intent_id);
      if (this.stopped) return;
      const next = {...this.saved, intent_id: intent.intent_id};
      persist(next);
      this.saved = next;
      this.publish({intent, enabled: value.enabled, error: ''});
    } catch {
      this.publish({error: 'Could not check the payment. Please try again; do not pay again.'});
    } finally {
      clearTimeout(timeout);
      this.request = null;
      if (!this.stopped) {
        this.publish({busy: false});
        const intent = this.state.intent;
        if (intent && intent.status !== 'confirmed' && intent.recover_until > Date.now()) {
          this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, POLL_MS);
        }
      }
    }
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort();
  }
}
