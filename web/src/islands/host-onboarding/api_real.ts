/* [HF-HOST-PLATFORM-1] Real onboarding client. Talks to the worker with the Clerk bearer token.
 * Contract: Specs/HF-HOST-PLATFORM-CONTRACT.md. Screens never call fetch(); they use OnboardingApi. */
import { ApiError, request } from '../../lib/apiClient';
import { API_BASE } from '../../lib/env';
import { DAYS, EMPTY_DRAFT } from './data';
import type {
  ApiResult, Avatar, AgeBand, AvatarStyle, Draft, GeneratedProfile, GenerationStage, KycGender,
  OnboardingApi, ServerDraft, StageState, StageStates, VoiceStatus,
} from './types';

const STAGE_KEYS: GenerationStage[] = ['text', 'images', 'safety'];
const POLL_MS = 3000;
const POLL_MAX_MS = 20 * 60_000;
const SAVE_DEBOUNCE_MS = 800;

/** Style labels shown to the host -> values the worker stores. */
const STYLE_TO_SERVER: Record<string, string> = {
  'Steady & encouraging': 'warm',
  'Cheerful & chatty': 'energetic',
  'Calm listener': 'calm',
  'Funny & light': 'playful',
  'Straight-talking': 'straightforward',
  'Gentle & patient': 'thoughtful',
};
const STYLE_FROM_SERVER: Record<string, string> = Object.fromEntries(Object.entries(STYLE_TO_SERVER).map(([k, v]) => [v, k]));

/** Language name -> conversationLang code (worker: hf_options LANGUAGE_CODES). */
const LANG_CODE: Record<string, string> = {
  Hindi: 'hi', English: 'en', Marathi: 'mr', Bengali: 'bn', Tamil: 'ta', Telugu: 'te', Kannada: 'kn', Malayalam: 'ml',
  Gujarati: 'gu', Punjabi: 'pa', Odia: 'or', Bhojpuri: 'bho', Garhwali: 'gbm', Kumaoni: 'kfy', Urdu: 'ur', Assamese: 'as',
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const baseMime = (t: string, fb: string) => (t || fb).split(';')[0].trim() || fb;

async function token(): Promise<string | null> {
  const { getActiveTokenWaited } = await import('../../lib/clerk');
  return getActiveTokenWaited(6000);
}

interface Failure extends ApiResult { ok: false; status: number; body: Record<string, unknown> }

const FRIENDLY: Record<string, string> = {
  not_enabled: 'This is not open yet. Please check back soon.',
  kyc_unavailable: 'Verification is not available right now. Please try again shortly.',
  too_many: 'Too many tries. Please wait a little and try again.',
  locked: 'This cannot be changed right now.',
};

function failure(e: unknown, fallback: string): Failure {
  if (e instanceof ApiError) {
    const body = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
    const msg = typeof body.message === 'string' && body.message.trim() ? body.message : '';
    const error = msg || (e.status === 401 ? 'Please sign in again to continue.' : FRIENDLY[e.error] || fallback);
    return { ok: false, status: e.status, body, error, field: typeof body.field === 'string' ? body.field : undefined, code: e.error };
  }
  return { ok: false, status: 0, body: {}, error: 'We could not reach the server. Check your internet and try again.', code: 'network' };
}

/** [HF-KYC-OTP-FALLBACK-1] Keep the worker's fallback / attemptsLeft / field hints for the Aadhaar step. */
function otpFailure(r: Failure): ApiResult & { fallback?: 'digilocker'; attemptsLeft?: number } {
  const b = r.body;
  return {
    ok: false, error: r.error, field: r.field, code: r.code,
    fallback: b.fallback === 'digilocker' ? 'digilocker' : undefined,
    attemptsLeft: typeof b.attemptsLeft === 'number' ? b.attemptsLeft : undefined,
  };
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, fallback = 'Something went wrong. Please try again.'): Promise<{ ok: true; data: T } | Failure> {
  const auth = await token();
  if (!auth) return { ok: false, status: 401, body: {}, error: 'Please sign in again to continue.', code: 'no_session' };
  try {
    const data = await request<T>(path, { method, auth, body, timeoutMs: 45_000 });
    return { ok: true, data };
  } catch (e) { return failure(e, fallback); }
}

/** [HF-VOICE-INTRO-1] Raw binary PUT with upload progress (XHR: fetch cannot report upload progress). 5 minutes of audio is ~5 MB, so allow 3 minutes on a slow link. */
function rawPut(path: string, blob: Blob, headers: Record<string, string>, onProgress?: (f: number) => void): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}${path}`);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = 180_000;
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { /* non-JSON */ }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send(blob);
  });
}

/** Raw binary POST (selfie video): request() only speaks JSON. */
async function rawPost<T>(path: string, blob: Blob, headers: Record<string, string>, fallback: string): Promise<{ ok: true; data: T } | Failure> {
  const auth = await token();
  if (!auth) return { ok: false, status: 401, body: {}, error: 'Please sign in again to continue.', code: 'no_session' };
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: blob, cache: 'no-store', headers: { Authorization: `Bearer ${auth}`, ...headers } });
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = typeof j.message === 'string' && j.message.trim() ? j.message : '';
      const code = typeof j.error === 'string' ? j.error : '';
      return { ok: false, status: res.status, body: j, error: msg || FRIENDLY[code] || fallback, field: typeof j.field === 'string' ? j.field : undefined, code };
    }
    return { ok: true, data: j as T };
  } catch (e) { return failure(e, fallback); }
}

// ── server shapes ───────────────────────────────────────────────────────────
interface MediaJson { id: string; kind: string; url: string; caption: string | null; transcript?: { speaker: 'host' | 'caller'; text: string }[]; sort: number }
interface HostJson {
  slug: string | null; status: string; displayName: string | null; about: string | null; tagline: string | null; quote: string | null; aboutPolished: string | null;
  languages: string[]; style: string | null; topics: string[]; conversationLang: string | null; pricePerMin: number | null;
  hours: { days?: number[]; from?: string; to?: string }; healthConsent: boolean; womenLane: boolean; lgbtqLane: boolean; lgbtqPublic: boolean;
  avatarId: string | null; avatarUrl: string | null; voice: { seconds: number; mime: string; status: VoiceStatus; uploadedAt: number | string } | null; agreementsAt?: number | null;
}
interface KycJson {
  aadhaar: { done: boolean; gender: string | null; last4: string | null };
  selfie: { status: string; reason: string | null };
  payout: { done: boolean; match: boolean; accountLast4: string | null };
}
interface MeJson { host: HostJson | null; kyc: KycJson; media: MediaJson[]; job: unknown }
interface StatusJson { status?: string; stages?: Partial<Record<GenerationStage, StageState>>; error?: string }

const kycGender = (g: string | null): KycGender | null => (g === 'F' ? 'woman' : g === 'M' ? 'man' : g === 'T' ? 'transgender' : null);

function stagesFrom(s: StatusJson | undefined): StageStates {
  const out = {} as StageStates;
  for (const k of STAGE_KEYS) out[k] = (s?.stages?.[k] as StageState | undefined) ?? 'waiting';
  return out;
}

function buildGenerated(me: MeJson): GeneratedProfile | null {
  const h = me.host;
  if (!h || !h.tagline) return null;
  const profile = me.media.find(m => m.kind === 'profile');
  const gallery = me.media.filter(m => m.kind === 'gallery').sort((a, b) => a.sort - b.sort).map(m => ({ image: m.url, caption: m.caption || 'AI image' }));
  return {
    tagline: h.tagline,
    about: h.aboutPolished || h.about || '',
    quote: h.quote || '',
    gallery,
    profileImage: profile?.url || h.avatarUrl || '',
  };
}

function draftFromServer(me: MeJson, phone: { verified: boolean; phone: string | null } | null): Partial<Draft> {
  const h = me.host;
  const k = me.kyc;
  const selfieSent = k.selfie.status !== 'none' && k.selfie.status !== 'rejected';
  const submitted = !!h && (h.status === 'pending_review' || h.status === 'live');
  const hasVoice = !!h && !!h.voice && (h.voice.seconds ?? 0) > 0;
  const out: Partial<Draft> = {
    phone: phone?.phone ? phone.phone.replace(/\D/g, '').slice(-10) : '',
    phoneVerified: !!phone?.verified,
    aadhaarDone: k.aadhaar.done,
    aadhaarLast4: k.aadhaar.last4 || '',
    kycGender: kycGender(k.aadhaar.gender),
    selfie: { recorded: selfieSent, consent: selfieSent, code: '' },
    payout: { upi: '', accountLast4: k.payout.accountLast4 || '', ifsc: '', nameAtBank: '', verified: k.payout.done },
  };
  if (h) {
    const days = Array.isArray(h.hours?.days) ? h.hours.days.map(i => DAYS[i]).filter(Boolean) : [];
    Object.assign(out, {
      avatarId: h.avatarId,
      displayName: h.displayName || '',
      about: h.about || '',
      languages: h.languages || [],
      style: h.style ? STYLE_FROM_SERVER[h.style] ?? null : null,
      topics: h.topics || [],
      pricePerMin: h.pricePerMin ?? EMPTY_DRAFT.pricePerMin,
      hours: { days, from: h.hours?.from && HHMM.test(h.hours.from) ? h.hours.from : EMPTY_DRAFT.hours.from, to: h.hours?.to && HHMM.test(h.hours.to) ? h.hours.to : EMPTY_DRAFT.hours.to },
      healthConsent: h.healthConsent,
      womenOnlyLane: h.womenLane,
      lgbtqLane: h.lgbtqLane,
      lgbtqShowOnProfile: h.lgbtqPublic,
      voice: { recorded: hasVoice, durationSec: h.voice?.seconds ?? 0, consent: hasVoice, source: null, status: h.voice?.status ?? null },
      agreements: { rules: submitted || !!h.agreementsAt, agreement: submitted || !!h.agreementsAt, welfare: submitted || !!h.agreementsAt },
      generated: buildGenerated(me),
      submitted,
    });
  }
  return out;
}

// ── autosave ────────────────────────────────────────────────────────────────
type Field = [string, unknown];
function fieldsOf(d: Draft): Field[] {
  const f: Field[] = [];
  const name = d.displayName.trim();
  if (name.length >= 2) f.push(['displayName', name]);
  const about = d.about.trim();
  if (about) f.push(['about', about]);
  if (d.languages.length) {
    f.push(['languages', d.languages]);
    const code = LANG_CODE[d.languages[0]];
    if (code) f.push(['conversationLang', code]);
  }
  const st = d.style ? STYLE_TO_SERVER[d.style] : undefined;
  if (st) f.push(['style', st]);
  if (d.topics.length) f.push(['topics', d.topics]);
  if (Number.isInteger(d.pricePerMin) && d.pricePerMin >= 5 && d.pricePerMin <= 100) f.push(['pricePerMin', d.pricePerMin]);
  if (d.hours.days.length && HHMM.test(d.hours.from) && HHMM.test(d.hours.to)) {
    f.push(['hours', { days: d.hours.days.map(x => DAYS.indexOf(x)).filter(i => i >= 0).sort(), from: d.hours.from, to: d.hours.to }]);
  }
  f.push(['healthConsent', d.healthConsent]);
  f.push(['lgbtqLane', d.lgbtqLane]);
  if (d.lgbtqLane) f.push(['lgbtqPublic', d.lgbtqShowOnProfile]);
  if (d.kycGender === 'woman') f.push(['womenLane', d.womenOnlyLane]);
  if (d.agreements.rules && d.agreements.agreement && d.agreements.welfare) f.push(['agreements', true]);
  return f;
}

const lastSent: Record<string, string> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let queued: { draft: Draft; onResult: (e: Record<string, string>) => void } | null = null;
let running: Promise<void> = Promise.resolve();
const errorState: Record<string, string> = {};

async function runSave(): Promise<void> {
  const job = queued;
  queued = null;
  if (!job) return;
  for (const [name, value] of fieldsOf(job.draft)) {
    const sig = JSON.stringify(value);
    if (lastSent[name] === sig) continue;
    const r = await call<{ host: unknown }>('PUT', '/api/hosts/me', { [name]: value }, 'We could not save that. Please try again.');
    if (r.ok) {
      lastSent[name] = sig;
      delete errorState[name];
      if (name === 'lgbtqLane') delete lastSent.lgbtqPublic; // turning the lane off resets "public" on the server
    } else if (r.code === 'locked') {
      lastSent[name] = sig; // not editable now; do not retry in a loop
    } else if (r.status === 401 || r.status === 0) {
      // transient: keep the field dirty and try again on the next change
    } else {
      errorState[r.field || name] = r.error || 'We could not save that.';
    }
  }
  job.onResult({ ...errorState });
}

function chain(): Promise<void> {
  running = running.then(runSave, runSave);
  return running;
}

// ── the client ──────────────────────────────────────────────────────────────
export const realApi: OnboardingApi = {
  mode: 'real',

  async sendOtp() { return { ok: false, error: 'Your WhatsApp number is verified when you sign in.' }; },
  async verifyOtp() { return { ok: false, error: 'Your WhatsApp number is verified when you sign in.' }; },

  /* [HF-KYC-OTP-FALLBACK-1] The full Aadhaar number goes in this one request body and nowhere else. */
  async aadhaarSendOtp(aadhaar, consent) {
    const r = await call<{ ok: boolean; already_verified?: boolean; gender?: string | null; last4?: string }>(
      'POST', '/api/hosts/kyc/aadhaar/otp', { aadhaar: aadhaar.replace(/\D/g, ''), consent, role: 'host' }, 'We could not send the OTP. Please check the number.');
    if (!r.ok) return otpFailure(r);
    if (r.data.already_verified) return { ok: true, alreadyVerified: { gender: kycGender(r.data.gender ?? null), last4: r.data.last4 || '' } };
    return { ok: true };
  },

  async aadhaarVerifyOtp(otp) {
    const r = await call<{ ok: boolean; gender: string; last4: string; firstName?: string }>(
      'POST', '/api/hosts/kyc/aadhaar/verify', { otp: otp.replace(/\D/g, '') }, 'That OTP is not right. Please try again.');
    if (!r.ok) return otpFailure(r);
    return { ok: true, last4: r.data.last4, name: r.data.firstName || '', gender: kycGender(r.data.gender) ?? undefined };
  },

  async digilockerStart(consent, returnPath) {
    const r = await call<{ ok: boolean; url?: string; already_verified?: boolean; gender?: string | null; last4?: string }>(
      'POST', '/api/hosts/kyc/digilocker/start',
      { consent, role: 'host', returnPath: returnPath || '/hosts/onboarding?step=aadhaar&dl=return' },
      'We could not open DigiLocker right now. Please try again.');
    if (!r.ok) return { ok: false, error: r.error };
    if (r.data.already_verified) return { ok: true, alreadyVerified: { gender: kycGender(r.data.gender ?? null), last4: r.data.last4 || '' } };
    if (!r.data.url) return { ok: false, error: 'We could not open DigiLocker right now. Please try again.' };
    return { ok: true, url: r.data.url };
  },

  async digilockerComplete() {
    const r = await call<{ ok: boolean; pending?: boolean; message?: string; gender?: string; last4?: string | null; firstName?: string }>(
      'POST', '/api/hosts/kyc/digilocker/complete', {}, 'We could not finish the check. Please try again.');
    if (!r.ok) {
      // no_session / session_expired / consent_denied / aadhaar_not_shared / under-18 / declined: starting again is the way forward
      // (the worker message says why); a network blip or 5xx may simply be asked again.
      const retry = r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429;
      return { ok: false, retry, error: r.error };
    }
    if (r.data.pending || r.data.ok === false) return { ok: false, pending: true, error: r.data.message || 'DigiLocker is still sending your details.' };
    return { ok: true, last4: r.data.last4 || '', name: r.data.firstName || '', gender: kycGender(r.data.gender ?? null) ?? undefined };
  },

  async getSelfieCode() {
    const r = await call<{ code: string }>('POST', '/api/hosts/kyc/selfie/code', undefined, 'We could not get your code. Please try again.');
    return r.ok ? { ok: true, code: String(r.data.code) } : { ok: false, error: r.error };
  },

  async uploadSelfie(blob, code) {
    const r = await rawPost<{ ok: boolean }>('/api/hosts/kyc/selfie', blob, { 'content-type': baseMime(blob.type, 'video/webm'), 'x-selfie-code': code }, 'We could not save your video. Please try again.');
    if (r.ok) return { ok: true };
    return { ok: false, error: r.error, codeExpired: r.code === 'code_expired' || r.code === 'code_mismatch' };
  },

  async verifyPayout(input) {
    const r = await call<{ ok: boolean; nameAtBank?: string; match?: boolean }>(
      'POST', '/api/hosts/payout/verify', { upi: input.upi, account: input.account, ifsc: input.ifsc }, 'We could not check these details. Please look at them again.');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, nameAtBank: r.data.nameAtBank, match: !!r.data.match };
  },

  async listAvatars() {
    const r = await call<{ id: string; url: string; gender: string; age: string; look: string; taken: boolean; mine?: boolean }[]>('GET', '/api/hosts/avatars');
    if (!r.ok) throw new Error(r.error);
    return r.data.map((a): Avatar => ({
      id: a.id, image: a.url,
      gender: /^(f|w)/i.test(a.gender) ? 'woman' : 'man',
      age: a.age as AgeBand, style: a.look as AvatarStyle,
      takenBy: a.taken && !a.mine ? 'another host' : null,
    }));
  },

  async claimAvatar(id) {
    const r = await call<{ ok: boolean }>('POST', `/api/hosts/avatars/${encodeURIComponent(id)}/claim`, undefined, 'We could not choose that avatar. Please try another.');
    return r.ok ? { ok: true } : { ok: false, error: r.error, code: r.code };
  },

  /* [HF-VOICE-INTRO-1] PUT the host's own introduction. 400 consent_required, 422 too_short/too_long, 413 too_large, 409 locked. */
  async uploadVoice(blob, durationSec, consent, onProgress) {
    if (!consent) return { ok: false, error: 'Please tick the box to continue.', code: 'consent_required' };
    const auth = await token();
    if (!auth) return { ok: false, error: 'Please sign in again to continue.', code: 'no_session' };
    try {
      const r = await rawPut('/api/hosts/me/voice', blob, {
        Authorization: `Bearer ${auth}`,
        'content-type': baseMime(blob.type, 'audio/mp4'),
        'x-duration-seconds': String(Math.round(durationSec)),
        'x-voice-consent': '1',
      }, onProgress);
      if (r.status >= 200 && r.status < 300) {
        const v = r.body.voice as { status?: VoiceStatus } | undefined;
        return { ok: true, status: v?.status ?? 'pending' };
      }
      const code = typeof r.body.error === 'string' ? r.body.error : '';
      const msg = typeof r.body.message === 'string' && r.body.message.trim() ? r.body.message : '';
      const byCode: Record<string, string> = {
        consent_required: 'Please tick the box to say this is your own voice.',
        too_short: 'Your introduction is too short. Please record at least 30 seconds.',
        too_long: 'Your introduction is too long. Please keep it under 5 minutes.',
        too_large: 'That recording is too big. Please record a shorter one.',
        locked: 'Your introduction cannot be changed right now.',
      };
      return { ok: false, code, error: msg || byCode[code] || (r.status === 401 ? 'Please sign in again to continue.' : 'We could not save your recording. Please try again.') };
    } catch (e) {
      const timeout = e instanceof Error && e.message === 'timeout';
      return { ok: false, code: 'network', error: timeout ? 'The upload is taking too long. Please check your internet and try again.' : 'We could not reach the server. Check your internet and try again.' };
    }
  },

  async fetchMyVoice() {
    const auth = await token();
    if (!auth) return null;
    try {
      const res = await fetch(`${API_BASE}/api/hosts/me/voice`, { headers: { Authorization: `Bearer ${auth}` }, cache: 'no-store' });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch { return null; }
  },

  async loadServerDraft(): Promise<ServerDraft> {
    const [me, ph] = await Promise.all([
      call<MeJson>('GET', '/api/hosts/me'),
      call<{ verified: boolean; phone: string | null }>('GET', '/api/account/phone/status'),
    ]);
    if (!me.ok) throw new Error(me.error || 'We could not load your details.');
    return { draft: draftFromServer(me.data, ph.ok ? ph.data : null), hostStatus: me.data.host?.status ?? null };
  },

  saveServerDraft(draft, onResult) {
    queued = { draft, onResult };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void chain(); }, SAVE_DEBOUNCE_MS);
  },

  async flushServerDraft() {
    if (timer) { clearTimeout(timer); timer = null; void chain(); }
    await running;
  },

  async generateProfile(draft, onStages) {
    await realApi.flushServerDraft();
    const start = await call<{ jobId?: string }>('POST', '/api/hosts/generate', undefined, 'We could not start making your profile.');
    let first: StatusJson | null = null;
    if (!start.ok) {
      // Already running (or finished) from an earlier visit? Then just follow it. Anything else is a real error.
      const s = await call<StatusJson>('GET', '/api/hosts/generate/status');
      const st = s.ok ? stagesFrom(s.data) : null;
      if (!s.ok || !st || STAGE_KEYS.every(k => st[k] === 'waiting')) throw new Error(start.error);
      first = s.data;
    }
    const t0 = Date.now();
    let status: StatusJson | null = first;
    for (;;) {
      if (!status) {
        const s = await call<StatusJson>('GET', '/api/hosts/generate/status');
        if (s.ok) status = s.data;
        else if (s.status !== 0) throw new Error(s.error);
      }
      if (status) {
        const st = stagesFrom(status);
        onStages(st);
        const failed = STAGE_KEYS.find(k => st[k] === 'failed');
        if (failed || status.status === 'failed' || status.status === 'error') throw new Error(status.error || 'Something went wrong while making your profile. Please try again.');
        if (STAGE_KEYS.every(k => st[k] === 'done' || st[k] === 'skipped')) break;
      }
      if (Date.now() - t0 > POLL_MAX_MS) throw new Error('This is taking longer than expected. You can close this page; we will message you on WhatsApp when it is ready.');
      status = null;
      await sleep(POLL_MS);
    }
    const me = await call<MeJson>('GET', '/api/hosts/me');
    if (!me.ok) throw new Error(me.error);
    const g = buildGenerated(me.data);
    if (!g) throw new Error('Your profile is not ready yet. Please try again in a moment.');
    return g;
  },

  async editGenerated(patch) {
    const r = await call<{ host: unknown }>('PUT', '/api/hosts/me/generated', patch, 'We could not save that. Please try again.');
    return r.ok ? { ok: true } : { ok: false, error: r.error, field: r.field };
  },

  async submitForReview() {
    await realApi.flushServerDraft();
    const r = await call<{ ok: boolean }>('POST', '/api/hosts/submit', undefined, 'We could not send your profile. Please try again.');
    if (r.ok) return { ok: true };
    const missing = Array.isArray(r.body.missing) ? (r.body.missing as unknown[]).map(String).join(', ') : '';
    return { ok: false, error: missing ? `${r.error} (${missing})` : r.error };
  },
};
