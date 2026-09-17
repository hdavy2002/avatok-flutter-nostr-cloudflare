import type { CallOptions, SmokeIntent } from './upiSmokeController';

/** The invitation grants this test only; every request still needs ordinary Clerk auth. */
export interface TestBooking {
  booking_id: string; service_id: 'upi-demo-consultation'; service_title: string;
  duration_minutes: 15; test_mode: true;
  status: 'awaiting_payment'|'confirmed'|'review_pending'|'expired'|'unavailable';
  created_at: number; confirmed_at: number|null; amount_paise: 100; currency: 'INR';
}
export interface CustomerCurrent {
  ok: true; protocol_version: 2; account_id: string; enabled: boolean; reason_code: string|null;
  invite: {invite_id: string; expires_at: number; can_create: boolean};
  service: {id: 'upi-demo-consultation'; title: string; duration_minutes: 15; test_mode: true; amount_paise: 100; currency: 'INR'};
  intent: SmokeIntent|null; booking: TestBooking|null;
}
export interface InvitationHandle { token: string|null; inviteId?: string; invalid?: boolean }
export interface CustomerDependencies {
  token: (refresh: boolean) => Promise<string|null>;
  request: <T>(path: string, options: CallOptions) => Promise<T>;
  emit?: (event: string, code?: string) => void;
  redeemed?: (inviteId: string) => void;
  now?: () => number; uuid?: () => string;
}
export interface CustomerSnapshot {
  current: CustomerCurrent|null; busy: boolean; message: string; authRequired: boolean; timedOut: boolean;
}
export class CustomerFailure extends Error {
  status: number; error: string;
  constructor(status: number, error: string) { super(error); this.status=status; this.error=error; }
}
export const CUSTOMER_REQUEST_MS = 10_000;
export const CUSTOMER_POLL_MS = 2500;
const PREFIX = '/api/pay/hdfc-sms/customer';
const statusOf = (e: unknown) => e && typeof e === 'object' && 'status' in e ? Number(e.status) : 0;
const errorOf = (e: unknown) => {
  if (!e || typeof e !== 'object') return '';
  if ('error' in e && typeof e.error === 'string') return e.error;
  if ('body' in e && e.body && typeof e.body === 'object' && 'error' in e.body) return String(e.body.error);
  return '';
};
const KNOWN_ERRORS = new Set(['invite_required','invite_unavailable','invite_expired','intent_busy','reference_conflict',
  'invalid_reference','rail_paused','schema_not_ready','configuration_incomplete','account_changed']);

export class UpiCustomerTestController {
  state: CustomerSnapshot = {current:null,busy:false,message:'',authRequired:false,timedOut:false};
  private generation = 0;
  private abort: AbortController|null = null;
  private timer: ReturnType<typeof setTimeout>|null = null;
  private account: string|null = null;
  private paused = false;
  private handle: InvitationHandle = {token:null};
  private requestKey: string|null = null;
  private deps: CustomerDependencies;
  private publish: (s: CustomerSnapshot) => void;
  constructor(deps: CustomerDependencies, publish: (s: CustomerSnapshot) => void) { this.deps=deps; this.publish=publish; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private update(patch: Partial<CustomerSnapshot>) { this.state={...this.state,...patch}; this.publish(this.state); }
  private event(event: string, code?: string) {
    try { this.deps.emit?.(event,code && KNOWN_ERRORS.has(code) ? code : undefined); } catch { /* telemetry is optional */ }
  }
  cancel(clear = false) {
    this.generation++; this.abort?.abort(); this.abort=null;
    if (this.timer) clearTimeout(this.timer); this.timer=null;
    if (clear) {
      this.handle.token=null; this.handle={token:null}; this.account=null; this.requestKey=null;
      this.update({current:null,busy:false,message:'',authRequired:false,timedOut:false});
    }
  }
  private async call<T>(path: string, opts: Omit<CallOptions,'auth'|'signal'> = {}): Promise<T> {
    const abort = new AbortController(); this.abort=abort;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout>|undefined;
    const work = async () => {
      const run = async (refresh: boolean) => {
        const auth = await this.deps.token(refresh);
        if (abort.signal.aborted || generation !== this.generation) throw new Error('cancelled');
        if (!auth) throw new CustomerFailure(401,'authentication_required');
        return this.deps.request<T>(PREFIX+path,{...opts,auth,signal:abort.signal});
      };
      try { return await run(false); }
      catch(e) {
        if (statusOf(e) !== 401 || abort.signal.aborted || generation !== this.generation) throw e;
        const value = await run(true);
        if (abort.signal.aborted || generation !== this.generation) throw new Error('cancelled');
        this.event('auth_renewed'); return value;
      }
    };
    try {
      return await Promise.race([work(),new Promise<never>((_,reject) => {
        timer=setTimeout(() => {abort.abort();reject(new Error('deadline'));},CUSTOMER_REQUEST_MS);
        abort.signal.addEventListener('abort',() => reject(new Error('cancelled')),{once:true});
      })]);
    } finally { if (timer) clearTimeout(timer); if (this.abort === abort) this.abort=null; }
  }
  private checkAccount(account: string) {
    if (this.account && this.account !== account) {
      this.handle.token=null; this.requestKey=null;
      this.update({current:null});
      throw new CustomerFailure(409,'account_changed');
    }
    this.account=account;
  }
  private accept(current: CustomerCurrent) {
    this.checkAccount(current.account_id);
    const oldStatus=this.state.current?.booking?.status;
    this.handle.inviteId=current.invite.invite_id;
    this.update({current,busy:false,message:'',authRequired:false,timedOut:false});
    if (current.booking?.status !== oldStatus) {
      if (current.booking?.status === 'confirmed') this.event('confirmed');
      if (current.booking?.status === 'review_pending') this.event('review_required');
    }
  }
  private fail(e: unknown) {
    const status=statusOf(e), error=errorOf(e);
    this.event('error',error);
    this.update({busy:false,authRequired:status===401,
      ...([401,403,404].includes(status) || error==='account_changed' ? {current:null} : {}),
      message: status===401 ? 'Sign in again to resume this test booking.' :
        status===403 ? 'This account cannot access the test. Sign in with an eligible account.' :
        error==='account_changed' ? 'Your account changed. Resume the test for your current account.' :
        error==='intent_busy' ? 'Another test payment is in progress. Try again shortly; no payment has been created for you.' :
        error==='reference_conflict' ? 'The saved reference changed. Check this payment again before correcting the reference.' :
        error==='invite_required' ? 'A private invitation is required. Open your invitation link after signing in.' :
        error==='invite_expired' ? 'This invitation expired before a payment was created. Ask for a new invitation.' :
        status===404 ? 'This invitation is unavailable for this account. Use the account that first opened it, or ask for a new invitation.' :
        status===400 ? 'Enter the 12-digit UPI transaction reference for this payment.' :
        status===409 ? 'The payment changed. Check this same payment again.' :
        status===429 ? 'Too many attempts. Wait briefly, then resume this same test.' :
        error==='rail_paused' ? 'Payments are temporarily paused. Your existing booking reference remains available.' :
        'Unable to check right now. Resume this same test; do not pay again.'});
  }
  async resume(handle?: InvitationHandle) {
    if (handle) this.handle=handle;
    if (this.paused) return;
    this.cancel(); const generation=this.generation;
    this.update({busy:true,message:'',authRequired:false});
    try {
      if (this.handle.invalid) throw new CustomerFailure(404,'invite_unavailable');
      if (this.handle.token) {
        const redeemed=await this.call<{account_id:string;invite_id:string}>('/redeem',
          {method:'POST',body:{invite_token:this.handle.token}});
        if (generation !== this.generation) return;
        this.checkAccount(redeemed.account_id);
        this.handle.token=null; this.handle.inviteId=redeemed.invite_id;
        this.deps.redeemed?.(redeemed.invite_id);
        this.event('redeemed');
      }
      const current=await this.call<CustomerCurrent>('/current',
        {query:this.handle.inviteId ? {invite_id:this.handle.inviteId} : undefined});
      if (generation !== this.generation) return;
      this.accept(current); this.event('resumed'); this.schedule();
    } catch(e) { if (generation === this.generation) this.fail(e); }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer); this.timer=null;
    const intent=this.state.current?.intent;
    if (!intent || intent.protocol_version!==2 || ['confirmed','superseded','review_pending'].includes(intent.status)) return;
    if (intent.expires_at<=this.now()) {
      this.update({timedOut:true}); return;
    }
    if (this.paused) return;
    this.timer=setTimeout(() => { this.timer=null; void this.poll(); },Math.min(CUSTOMER_POLL_MS,intent.expires_at-this.now()));
  }
  private async poll() {
    const current=this.state.current, generation=this.generation;
    if (!current?.intent || this.paused) return;
    if (current.intent.expires_at<=this.now()) { this.schedule(); return; }
    try {
      const next=await this.call<CustomerCurrent>('/status',
        {query:{invite_id:current.invite.invite_id,intent_id:current.intent.intent_id}});
      if (generation!==this.generation) return;
      this.accept(next);
    } catch(e) {
      if (generation!==this.generation) return;
      this.fail(e);
      if ([400,401,403,404,409,429].includes(statusOf(e))) return;
    }
    this.schedule();
  }
  setPaused(paused: boolean) {
    if (paused===this.paused) return;
    this.paused=paused;
    if (paused) { this.cancel(); this.update({busy:false}); }
    else void this.resume();
  }
  async create() {
    const current=this.state.current;
    if (this.state.busy || !current || current.intent || current.booking || !current.invite.can_create || !current.enabled) return;
    this.requestKey ??= this.deps.uuid?.() ?? crypto.randomUUID();
    if (await this.mutate('/order',{invite_id:current.invite.invite_id,service_id:'upi-demo-consultation',request_key:this.requestKey}))
      this.requestKey=null;
  }
  async claim(reference: string) {
    const current=this.state.current;
    if (!current?.intent || this.state.busy) return;
    if (!/^[0-9]{12}$/.test(reference.trim())) { this.fail(new CustomerFailure(400,'invalid_reference')); return; }
    await this.mutate('/claim',{invite_id:current.invite.invite_id,intent_id:current.intent.intent_id,
      bank_reference:reference.trim(),expected_reference_revision:current.intent.reference_revision});
  }
  async recheck() {
    const current=this.state.current;
    if (!current?.intent || this.state.busy) return;
    await this.mutate('/recheck',{invite_id:current.invite.invite_id,intent_id:current.intent.intent_id});
  }
  private async mutate(path: string, body: unknown) {
    if (this.paused) { this.update({message:'You are offline or this page is hidden. Return online to resume this test.'}); return false; }
    this.cancel(); const generation=this.generation;
    this.update({busy:true,message:'',authRequired:false});
    try {
      // Re-read identity/ownership before sending a mutation. Preserve the revision
      // the user saw, so a concurrent correction yields an explicit conflict.
      const current=await this.call<CustomerCurrent>('/current',{query:{invite_id:this.handle.inviteId!}});
      if (generation!==this.generation) return false;
      this.checkAccount(current.account_id);
      if (path==='/order' && current.booking) {
        this.accept(current); this.schedule(); return true;
      }
      const next=await this.call<CustomerCurrent>(path,{method:'POST',body});
      if (generation!==this.generation) return false;
      this.accept(next); this.event(path==='/order' ? 'created' : 'checked'); this.schedule(); return true;
    } catch(e) { if (generation===this.generation) this.fail(e); return false; }
  }
}
