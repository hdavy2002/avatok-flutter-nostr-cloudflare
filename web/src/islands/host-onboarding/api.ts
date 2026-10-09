/* [HF-HOST-ONBOARD-1] Phase 1 mock API. Fake delays, no network. Replaced by the real worker client later. */
import { SAMPLE_AVATARS, STYLES, TOPICS } from './data';
import type { Draft, GeneratedProfile, GenerationStage, OnboardingApi } from './types';

const wait = (min = 400, max = 1200) => new Promise<void>(r => setTimeout(r, min + Math.random() * (max - min)));
const digits = (s: string) => s.replace(/\D/g, '');
let aadhaarOnFile = '';

const TAGLINES = [
  'Steady words for when things feel heavy',   // Steady & encouraging
  'Chai, chatter and a very good mood',        // Cheerful & chatty
  'A calm ear, whenever you need one',         // Calm listener
  'Light talk, big smiles, zero pressure',     // Funny & light
  'Honest, kind and straight to the point',    // Straight-talking
  'No hurry. Say it your way.',                // Gentle & patient
];

export const mockApi: OnboardingApi = {
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
  async runVideoKyc(mockGender) {
    await new Promise(r => setTimeout(r, 2000));
    return { ok: true, gender: mockGender };
  },
  async sendAadhaarOtp(aadhaar) {
    await wait();
    const d = digits(aadhaar);
    if (d.length !== 12) return { ok: false, error: 'Aadhaar number must be 12 digits.' };
    aadhaarOnFile = d;
    return { ok: true };
  },
  async verifyAadhaarOtp(code) {
    await wait();
    if (digits(code).length !== 6) return { ok: false, error: 'Wrong code. Try again.' };
    return { ok: true, last4: aadhaarOnFile.slice(-4) };
  },
  async listAvatars() {
    await wait(300, 700);
    return SAMPLE_AVATARS;
  },
  async uploadVoice(blob) {
    await wait();
    return { ok: true, url: URL.createObjectURL(blob) };
  },
  async generateProfile(draft: Draft, onStage: (stage: GenerationStage) => void): Promise<GeneratedProfile> {
    const stages: GenerationStage[] = ['text', 'images', 'voice', 'conversation', 'safety'];
    for (const s of stages) { onStage(s); await new Promise(r => setTimeout(r, 900)); }
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
      conversation: [
        { speaker: 'caller', text: 'Hello... aaj ka din bahut bura tha. Office mein sab kuch ulta ho gaya.' },
        { speaker: 'host', text: `Hello! Main ${name} hoon. Pehle thoda saans lijiye. Kya hua, aaram se bataiye.` },
        { speaker: 'caller', text: 'Boss ne sabke saamne meri report pe bahut sunaya. Mujhe bahut bura laga.' },
        { speaker: 'host', text: 'Ouch, yeh toh sach mein chubhne wali baat hai. Aapne itni mehnat ki thi, mujhe pata hai.' },
        { speaker: 'caller', text: 'Haan... lagta hai main kuch bhi theek se nahi kar pata.' },
        { speaker: 'host', text: 'Arre nahi! Ek kharab din poori kahani nahi hota. Chaliye, ab chai banaiye, phir mujhe aapka din sunna hai. Main yahin hoon.' },
      ],
      gallery: ['Chai at home', 'Reading corner', 'Evening walk', 'Festival lights', 'Work desk'].map(caption => ({ image: img, caption })),
      profileImage: img,
    };
  },
  async submitForReview() {
    await wait(700, 1200);
    return { ok: true };
  },
};
