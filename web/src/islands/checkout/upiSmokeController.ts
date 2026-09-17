/** Protocol-v2 smoke coordinator. No browser persistence and no commercial effects. */
export interface SmokeIntent {
  intent_id: string; status: 'pending'|'expired'|'confirmed'|'review_pending'|'superseded';
  protocol_version: number; amount_paise: number;
  expires_at: number; recover_until: number; updated_at: number; order_id: string|null;
  smoke_test: boolean; claim_submitted: boolean; reference_revision: number; reason_code: string|null; upi_url?: string;
}
export interface SmokeCurrent {
  account_id: string; enabled: boolean;
  intent: SmokeIntent|null;
}
export interface CallOptions { method?: 'GET'|'POST'; body?: unknown; query?: Record<string,string>; auth: string; signal: AbortSignal }
export interface SmokeDependencies {
  token: (refresh: boolean) => Promise<string|null>;
  request: <T>(path: string, options: CallOptions) => Promise<T>;
  emit?: (event: string) => void;
  now?: () => number;
  uuid?: () => string;
}
export interface SmokeSnapshot {
  current: SmokeCurrent|null; intent: SmokeIntent|null; busy: boolean;
  message: string; authRequired: boolean; timedOut: boolean;
}
export class SmokeFailure extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status=status; }
}
const code = (e: unknown) => typeof e === 'object' && e !== null && 'status' in e ? Number(e.status) : 0;
const terminal = (i: SmokeIntent) => i.protocol_version !== 2 || ['confirmed','superseded','review_pending'].includes(i.status);
export const REQUEST_MS = 10_000;
export const POLL_MS = 2500;

export class UpiSmokeController {
  private generation = 0;
  private abort: AbortController|null = null;
  private timer: ReturnType<typeof setTimeout>|null = null;
  private account: string|null = null;
  private paused = false;
  private resumeId: string|undefined;
  private requestKey: string|null = null;
  private requestedReplacement: string|undefined;
  state: SmokeSnapshot = { current:null, intent:null, busy:false, message:'', authRequired:false, timedOut:false };
  private deps: SmokeDependencies;
  private publish: (s: SmokeSnapshot) => void;
  constructor(deps: SmokeDependencies, publish: (s: SmokeSnapshot) => void) {this.deps=deps;this.publish=publish;}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private update(patch: Partial<SmokeSnapshot>) { this.state = {...this.state,...patch}; this.publish(this.state); }
  private event(name: string) { try {this.deps.emit?.(name);} catch {/* telemetry never controls payment state */} }
  cancel(clear = false) {
    this.generation++; this.abort?.abort(); this.abort = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (clear) { this.account = null; this.resumeId = undefined; this.requestKey = null; this.requestedReplacement = undefined; this.update({current:null,intent:null,busy:false,message:'',authRequired:false,timedOut:false}); }
  }
  private async call<T>(path: string, opts: Omit<CallOptions,'auth'|'signal'> = {}, timeoutMs = REQUEST_MS): Promise<T> {
    const controller = new AbortController();
    this.abort = controller;
    const parentGeneration = this.generation;
    let timer: ReturnType<typeof setTimeout>;
    const work = async () => {
      const run = async (refresh: boolean) => {
        const auth = await this.deps.token(refresh);
        if (controller.signal.aborted || parentGeneration !== this.generation) throw new Error('cancelled');
        if (!auth) throw new SmokeFailure(401,'Sign in again to check this payment.');
        return this.deps.request<T>(path,{...opts,auth,signal:controller.signal});
      };
      try { return await run(false); }
      catch (e) {
        if (code(e) !== 401 || controller.signal.aborted || parentGeneration !== this.generation) throw e;
        const result = await run(true);
        if (controller.signal.aborted || parentGeneration !== this.generation) throw new Error('cancelled');
        this.event('auth_renewed');
        return result;
      }
    };
    try {
      return await Promise.race([work(), new Promise<never>((_,reject) => {
        timer = setTimeout(() => {controller.abort(); reject(new Error('deadline'));}, Math.max(1,timeoutMs));
        controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), {once:true});
      })]);
    } finally { clearTimeout(timer!); if (this.abort === controller) this.abort = null; }
  }
  private async identity(until?: number): Promise<SmokeCurrent> {
    const generation = this.generation;
    const current = await this.call<SmokeCurrent>('/api/pay/hdfc-sms/current',{},until ? Math.min(REQUEST_MS,until-this.now()) : REQUEST_MS);
    if (generation !== this.generation) throw new Error('cancelled');
    if (this.account && current.account_id !== this.account) {
      this.cancel(true);
      throw new SmokeFailure(409,'Account changed. Resume payments for the current account.');
    }
    this.account = current.account_id;
    this.update({current});
    return current;
  }
  private accept(intent: SmokeIntent|null) {
    const previous = this.state.intent;
    this.resumeId = intent?.intent_id;
    this.update({intent});
    if (intent && previous?.status !== intent.status) {
      if (intent.protocol_version === 2 && intent.status === 'confirmed') this.event('confirmed');
      if (intent.status === 'review_pending') this.event('review_required');
    }
  }
  private fail(e: unknown) {
    const status = code(e);
    this.update({...([401,403,404].includes(status) ? {current:null,intent:null} : {}),busy:false,authRequired:status === 401,message:
      status === 401 ? 'Sign in again to check this payment.' :
      status === 403 ? 'Access denied. This test is restricted to authorized administrators.' :
      status === 404 ? 'This payment is unavailable for this account.' :
      status === 409 ? 'The payment changed. Check this payment again before correcting the reference or replacing its QR.' :
      status === 400 ? 'Enter the 12-digit UPI transaction reference for this payment.' :
      status === 429 ? 'Too many attempts. Wait briefly, then check this same payment again.' :
      'Unable to check right now. Your existing payment remains available; check it again.'});
  }
  async resume(intentId?: string) {
    this.resumeId = intentId;
    this.cancel(); const generation = this.generation;
    this.update({busy:true,message:'',authRequired:false,timedOut:false});
    try {
      const current = await this.identity();
      if (generation !== this.generation) return;
      const intent = intentId ? await this.call<SmokeIntent>('/api/pay/hdfc-sms/status',{query:{intent_id:intentId}}) : current.intent;
      if (generation !== this.generation) return;
      this.accept(intent); this.update({busy:false}); if (intent) this.event('resumed');
      this.schedule();
    } catch(e) { if (generation === this.generation) this.fail(e); }
  }
  private expired() {
    if (!this.state.timedOut) this.event('timeout');
    this.update({timedOut:true,message:'The QR expired. Check this same payment again for matching evidence; do not pay again.'});
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const intent = this.state.intent;
    if (!intent || terminal(intent)) return;
    if (this.now() >= intent.expires_at) { this.expired(); return; }
    if (this.paused) return;
    this.timer = setTimeout(() => {this.timer=null;void this.poll();}, Math.min(POLL_MS,intent.expires_at-this.now()));
  }
  private async poll() {
    const deadline = this.state.intent?.expires_at;
    if (!deadline) return;
    if (this.now() >= deadline) { this.expired(); return; }
    const generation = this.generation;
    const id = this.state.intent?.intent_id;
    if (!id || this.paused) return;
    try {
      await this.identity(deadline);
      if (generation !== this.generation) return;
      if (this.now() >= deadline) {this.schedule();return;}
      const intent = await this.call<SmokeIntent>('/api/pay/hdfc-sms/status',{query:{intent_id:id}},Math.min(REQUEST_MS,deadline-this.now()));
      if (generation !== this.generation) return;
      this.accept(intent); this.update({message:'',authRequired:false});
    } catch(e) {
      if (generation !== this.generation) return;
      if ([400,401,403,404,409,429].includes(code(e))) { this.fail(e); return; }
      this.update({message:'Connection interrupted. Your payment remains available.'});
    }
    this.schedule();
  }
  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) { this.cancel(); this.update({busy:false}); }
    else if (!this.state.current) void this.resume(this.resumeId);
    else this.schedule();
  }
  async create(replace = false) {
    if (this.state.busy) return;
    const replacement = replace ? this.state.intent?.intent_id : undefined;
    if (replace && !replacement) return;
    if (!this.requestKey || replacement !== this.requestedReplacement) {
      this.requestKey = this.deps.uuid?.() ?? crypto.randomUUID();
      this.requestedReplacement = replacement;
    }
    const key = this.requestKey;
    const accepted = await this.mutate('/order',{listingId:'avatok-upi-smoke-2026',request_key:key,...(replacement ? {replace_intent_id:replacement} : {})},'created');
    // Keep the idempotency key after an uncertain response; successful retry resumes it.
    if (accepted) this.requestKey = null;
  }
  async claim(reference: string) {
    if (!this.state.intent || this.state.busy) return;
    await this.mutate('/claim',{intent_id:this.state.intent.intent_id,bank_reference:reference.trim(),expected_reference_revision:this.state.intent.reference_revision});
  }
  async recheck() {
    if (!this.state.intent || this.state.busy) return;
    await this.mutate('/recheck',{intent_id:this.state.intent.intent_id});
  }
  private async mutate(path: string, body: unknown, event?: string) {
    this.cancel(); const generation = this.generation;
    this.update({busy:true,message:'',timedOut:false,authRequired:false});
    try {
      await this.identity();
      if (generation !== this.generation) return;
      const intent = await this.call<SmokeIntent>('/api/pay/hdfc-sms'+path,{method:'POST',body});
      if (generation !== this.generation) return;
      this.accept(intent); this.update({busy:false}); if (event) this.event(event); this.schedule(); return true;
    } catch(e) { if (generation === this.generation) this.fail(e); }
  }
}
