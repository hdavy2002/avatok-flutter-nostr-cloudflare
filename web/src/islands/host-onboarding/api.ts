/* [HF-HOST-ONBOARD-1] Phase 1 mock API. Fake delays, no network. Replaced by the real worker client later. */
import { SAMPLE_AVATARS, STYLES, TOPICS } from './data';
import type { ChannelItem, ChannelsInfo, Draft, GeneratedProfile, GenerationStage, OnboardingApi, StageStates } from './types';

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

/** [HF-CREATOR-SPACES-1] Preview-only channel list so the channel step can be clicked through. */
let mockChannels: ChannelItem[] = [];
const MOCK_MIN = { minFollowers: 20, minViews: 1000 };
const mockInfo = (): ChannelsInfo => ({ channels: mockChannels, ...MOCK_MIN, qualified: mockChannels.some(c => c.state === 'approved') });

export const mockApi: OnboardingApi = {
  mode: 'mock',
  async getSpacesMe() { return null; },
  async setCreator() { await wait(300, 700); return { ok: true }; },
  async setSpace() { await wait(300, 700); return { ok: true }; },
  async setCallerLevel() { await wait(200, 500); return { ok: true }; },
  async listChannels() { return mockInfo(); },
  async addChannel(platform, handle) {
    await wait();
    const h = handle.trim().replace(/^@/, '');
    if (h.length < 2) return { ok: false, error: 'Please enter your channel name or link.', field: 'handleOrUrl' };
    const ch: ChannelItem = { id: `m${Date.now()}`, platform, handle: h, url: null, followers: 0, views: 0, state: 'checking', verified: false, needsCode: true, verifyCode: 'HF-4821' };
    mockChannels = [...mockChannels, ch];
    return { ok: true, channel: ch, info: mockInfo() };
  },
  async checkChannel(id) {
    await wait(700, 1300);
    mockChannels = mockChannels.map(c => c.id === id ? { ...c, verified: true, needsCode: false, verifyCode: null, followers: 240, views: c.platform === 'youtube' ? 5200 : 0, state: 'approved' } : c);
    const channel = mockChannels.find(c => c.id === id);
    return { ok: true, result: 'approved', message: 'Your channel is connected.', channel, info: mockInfo() };
  },
  async connectYoutube() {
    await wait(700, 1300);
    const ch: ChannelItem = { id: `m${Date.now()}`, platform: 'youtube', handle: 'yourchannel', url: null, followers: 240, views: 5200, state: 'approved', verified: true, needsCode: false };
    mockChannels = [...mockChannels, ch];
    return { ok: true, result: 'approved', message: 'Your channel is connected.', channel: ch, info: mockInfo() };
  },
  async removeChannel(id) { mockChannels = mockChannels.filter(c => c.id !== id); return { ok: true }; },
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
  async verifyPayout({ upi }) {
    await wait(900, 1600);
    if (!upi.includes('@')) return { ok: false, error: 'We could not save this UPI ID. Please look at it again.' };
    return { ok: true, match: true };
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
    const name = draft.displayName.trim() || 'Your influencer';
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
