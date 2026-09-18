export interface PublicIntent {
  intent_id: string;
  status: 'pending' | 'confirmed' | 'expired' | 'review_pending';
  reason_code: string | null;
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
}
interface Session { bearer: string; request_key: string; intent_id?: string }
const STORAGE_KEY = 'hdfc-public-payment-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 3000;

export function paymentAmount(paise: number): string {
  return new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR',
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2}).format(paise / 100);
}

function session(): Session {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw) {
    const saved = JSON.parse(raw) as Session;
    if (!/^[0-9a-f]{64}$/.test(saved.bearer) || !UUID.test(saved.request_key)
      || (saved.intent_id !== undefined && !UUID.test(saved.intent_id))) throw new Error('session');
    return saved;
  }
  const saved: Session = {
    bearer: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
    request_key: crypto.randomUUID(),
  };
  // Save before creating: even a lost response must retry this same payment.
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

function parseIntent(value: unknown, expectedId?: string): PublicIntent {
  const intent = value as PublicIntent;
  if (!intent || !UUID.test(intent.intent_id) || (expectedId && intent.intent_id !== expectedId)
    || !['pending', 'confirmed', 'expired', 'review_pending'].includes(intent.status)
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

/** One request and one scheduled poll per mounted page; browser return only checks status. */
export class UpiPublicController {
  private state: PublicPaymentState = {intent: null, enabled: false, busy: false, error: ''};
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
    try { this.saved = session(); }
    catch {
      this.publish({error: 'This browser could not restore the payment session. Keep any payment receipt and do not pay again.'});
      return;
    }
    await this.refresh();
  }
  async refresh(recheck = false) {
    if (!this.saved || this.stopped || this.request || this.state.intent?.status === 'confirmed') return;
    const id = this.saved.intent_id;
    await this.perform(id ? (recheck ? '/recheck' : '/status?intent_id=' + encodeURIComponent(id)) : '/order',
      id ? (recheck ? {intent_id: id} : undefined) : {request_key: this.saved.request_key});
  }
  async claim(reference: string) {
    const intent = this.state.intent;
    if (!intent || this.request || intent.status === 'confirmed' || intent.recover_until <= Date.now()) return;
    await this.perform('/claim', {intent_id: intent.intent_id, bank_reference: reference.trim(),
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
          intent_busy: 'Another test payment is in progress. Please try again shortly.',
          reference_conflict: 'The payment reference changed. Check again before resubmitting.',
          invalid_reference: 'Enter the UTR or bank reference shown on your payment receipt.',
          rail_paused: 'Payments are temporarily unavailable. If you paid, keep your receipt and do not pay again.',
        };
        throw new Error(messages[value.error] || 'Could not check the payment. Please try again; do not pay again.');
      }
      if (value.ok !== true || typeof value.enabled !== 'boolean') throw new Error('invalid');
      const intent = parseIntent(value.intent, this.saved.intent_id);
      if (this.stopped) return;
      this.saved.intent_id = intent.intent_id;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.saved));
      this.publish({intent, enabled: value.enabled, error: ''});
    } catch (error) {
      if (!this.stopped) {
        const message = error instanceof Error ? error.message : '';
        this.publish({error: message && !['invalid', 'Failed to fetch'].includes(message) && !(error instanceof DOMException)
          ? message : 'Could not check the payment. Please try again; do not pay again.'});
      }
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
