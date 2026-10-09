/* [HF-HOST-ONBOARD-1] Phase 1 mock API. Fake delays, no network. Replaced by the real worker client later. */
import { SAMPLE_AVATARS, STYLES, TOPICS } from './data';
import type { Draft, GeneratedProfile, GenerationStage, OnboardingApi, StageStates } from './types';

const wait = (min = 400, max = 1200) => new Promise<void>(r => setTimeout(r, min + Math.random() * (max - min)));
const digits = (s: string) => s.replace(/\D/g, '');

const TAGLINES = [
  'Steady words for when things feel heavy',   // Steady & encouraging
  'Chai, chatter and a very good mood',        // Cheerful & chatty
  'A calm ear, whenever you need one',         // Calm listener
  'Light talk, big smiles, zero pressure',     // Funny & light
  'Honest, kind and straight to the point',    // Straight-talking
  'No hurry. Say it your way.',                // Gentle & patient
];

export const mockApi: OnboardingApi = {
  mode: 'mock',
  async sendOtp(phone) {
    await wait();
    const d = digits(phone);
    if (d.length !== 10 || !/^[6-9]/.test(d)) return { ok: false, error: 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9.' };
    return { ok: true };
  },
  async verifyOtp(_phone, code) {
    await wait();
    const d = digits(code);
    if (d.length !== 6 || d === '000000') return { ok: false, error: 'Wrong code. Try again.' };
    return { ok: true };
  },
  /* [HF-KYC-OTP-FALLBACK-1] Preview: OTP 123456 works; an Aadhaar number ending 0000 shows the DigiLocker fallback. */
  async aadhaarSendOtp(aadhaar, consent) {
    await wait();
    if (!consent) return { ok: false, error: 'Please tick the box to continue.', field: 'consent' };
    const d = digits(aadhaar);
    if (d.length !== 12 || /^[01]/.test(d)) return { ok: false, error: 'Enter your 12-digit Aadhaar number.', field: 'aadhaar', code: 'invalid_aadhaar' };
    if (d.endsWith('0000')) return { ok: false, error: 'We cannot send an OTP right now. You can verify with DigiLocker instead.', code: 'otp_unavailable', fallback: 'digilocker' };
    return { ok: true };
  },
  async aadhaarVerifyOtp(otp, mockGender) {
    await wait();
    if (digits(otp) !== '123456') return { ok: false, error: 'That OTP is not right. Please try again.', code: 'invalid_otp', attemptsLeft: 2 };
    return { ok: true, last4: '4821', name: 'SEEMA', gender: mockGender ?? 'woman' };
  },
  async digilockerStart(consent) {
    await wait();
    if (!consent) return { ok: false, error: 'Please tick the box to continue.' };
    return { ok: true };
  },
  async digilockerComplete(mockGender) {
    await wait(1200, 1800);
    return { ok: true, last4: '4821', name: 'SEEMA', gender: mockGender ?? 'woman', };
  },
  async getSelfieCode() {
    return { ok: true, code: String(Math.floor(1000 + Math.random() * 9000)) };
  },
  async uploadSelfie(_blob, _code) {
    await wait(700, 1400);
    return { ok: true };
  },
  async verifyPayout({ upi, account, ifsc }) {
    await wait(900, 1600);
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) || !/^\d{9,18}$/.test(account) || !upi.includes('@')) return { ok: false, error: 'We could not check these details. Please look at them again.' };
    return { ok: true, nameAtBank: 'SEEMA DEVI', match: true };
  },
  async listAvatars() {
    await wait(300, 700);
    return SAMPLE_AVATARS;
  },
  async claimAvatar() { return { ok: true }; },
  async loadServerDraft() { return null; },
  saveServerDraft() { /* mock: nothing is sent */ },
  async flushServerDraft() { /* mock */ },
  async editGenerated() { return { ok: true }; },
  async uploadVoice(_blob, _sec, consent) {
    await wait();
    if (!consent) return { ok: false, error: 'Please tick the box to continue.' };
    return { ok: true, status: 'pending' };
  },
  async generateProfile(draft: Draft, onStages: (stages: StageStates) => void): Promise<GeneratedProfile> {
    const stages: GenerationStage[] = ['text', 'images', 'safety'];
    const st: StageStates = { text: 'waiting', images: 'waiting', safety: 'waiting' };
    for (const s of stages) { st[s] = 'working'; onStages({ ...st }); await new Promise(r => setTimeout(r, 900)); st[s] = 'done'; }
    onStages({ ...st });
    const av = SAMPLE_AVATARS.find(a => a.id === draft.avatarId);
    const img = av?.image ?? SAMPLE_AVATARS[0].image;
    const idx = Math.max(0, STYLES.indexOf(draft.style ?? ''));
    const name = draft.displayName.trim() || 'Your host';
    const topic = TOPICS.find(t => t.slug === draft.topics[0])?.label;
    const quote = topic
      ? `Aaram se baithiye, chai lijiye, aur ${topic} ke baare mein jo bhi mann mein hai, bol dijiye. Main sun rahi hoon.`
      : 'Aaram se baithiye, chai lijiye, aur jo bhi mann mein hai, bol dijiye. Main sun rahi hoon.';
    return {
      tagline: TAGLINES[idx] ?? TAGLINES[0],
      about: draft.about.trim(),
      quote,
      gallery: ['Chai at home', 'Reading corner', 'Evening walk', 'Festival lights', 'Work desk'].map(caption => ({ image: img, caption })),
      profileImage: img,
    };
  },
  async submitForReview() {
    await wait(700, 1200);
    return { ok: true };
  },
};
