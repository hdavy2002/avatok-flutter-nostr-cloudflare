/* [HF-HOST-ONBOARD-1] Static option lists for the onboarding mock. */
import { moods, moodGroups } from '../../lib/callvaalHomeReference';
import type { Avatar, Draft, StepGroup, StepKey } from './types';

export const STEPS: { key: StepKey; group: StepGroup; title: string }[] = [
  { key: 'welcome', group: 'start', title: 'Welcome' },
  { key: 'phone', group: 'verify', title: 'Your WhatsApp number' },
  { key: 'aadhaar', group: 'verify', title: 'Aadhaar check' },
  { key: 'selfie', group: 'verify', title: 'Selfie video' },
  { key: 'payout', group: 'verify', title: 'Where we pay you' },
  { key: 'avatar', group: 'profile', title: 'Choose your avatar' },
  { key: 'about', group: 'profile', title: 'About you' },
  { key: 'languages', group: 'profile', title: 'Languages & style' },
  { key: 'topics', group: 'profile', title: 'What you like to talk about' },
  { key: 'price', group: 'profile', title: 'Your price' },
  { key: 'hours', group: 'profile', title: 'Hours & comfort' },
  { key: 'voice', group: 'voice', title: 'Record your voice' },
  { key: 'review', group: 'finish', title: 'Check everything' },
  { key: 'generating', group: 'finish', title: 'Creating your profile' },
  { key: 'preview', group: 'finish', title: 'Your profile' },
  { key: 'done', group: 'finish', title: 'Sent for review' },
];

export const GROUP_LABEL: Record<StepGroup, string> = {
  start: 'Start', verify: 'Verify', profile: 'Profile', voice: 'Voice', finish: 'Finish',
};

const p = (n: string) => `/assets/callvaal/scrapbook/${n}`;
/** Phase 1: the 12 existing sample portraits stand in for the real avatar catalogue. */
export const SAMPLE_AVATARS: Avatar[] = [
  { id: 'av-young-1', image: p('women-photo-young.png'), gender: 'woman', age: '20s', style: 'casual' },
  { id: 'av-w-7', image: p('portrait-7.png'), gender: 'woman', age: '20s', style: 'casual' },
  { id: 'av-w-9', image: p('portrait-9.png'), gender: 'woman', age: '20s', style: 'casual' },
  { id: 'av-w-5', image: p('portrait-5.png'), gender: 'woman', age: '20s', style: 'casual' },
  { id: 'av-w-2', image: p('portrait-2.png'), gender: 'woman', age: '30s', style: 'office' },
  { id: 'av-w-1', image: p('portrait-1.png'), gender: 'woman', age: '30s', style: 'office', takenBy: 'another host' },
  { id: 'av-w-6', image: p('portrait-6.png'), gender: 'woman', age: '30s', style: 'traditional' },
  { id: 'av-midage-1', image: p('women-photo-midage.png'), gender: 'woman', age: '50s+', style: 'traditional' },
  { id: 'av-w-ananya', image: p('portrait-ananya.png'), gender: 'woman', age: '50s+', style: 'casual' },
  { id: 'av-m-3', image: p('portrait-3.png'), gender: 'man', age: '30s', style: 'casual' },
  { id: 'av-m-4', image: p('portrait-4.png'), gender: 'man', age: '30s', style: 'casual' },
  { id: 'av-m-8', image: p('portrait-8.png'), gender: 'man', age: '20s', style: 'casual' },
];

export const LANGUAGES = ['Hindi', 'English', 'Marathi', 'Bengali', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Gujarati', 'Punjabi', 'Odia', 'Bhojpuri', 'Garhwali', 'Kumaoni', 'Urdu', 'Assamese'];

export const STYLES = ['Steady & encouraging', 'Cheerful & chatty', 'Calm listener', 'Funny & light', 'Straight-talking', 'Gentle & patient'];

export const TOPICS = moods;            // existing mood list = topic list
export const TOPIC_GROUPS = moodGroups;
export const MAX_TOPICS = 6;

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const PRICE_MIN = 5;
export const PRICE_MAX = 100;
/** HF-PAY-6: platform keeps ₹2 + 40% of the amount above ₹2 (GST inside). ₹20 → host ₹10.80. */
export function hostShare(price: number): number {
  return Math.round(Math.max(0, price - 2) * 0.6 * 100) / 100;
}
export const rupees = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Text a caller must never see: numbers, emails, links, social handles. */
export function contactLeak(text: string): string | null {
  if (/\d[\d\s-]{5,}\d/.test(text)) return 'Please remove phone numbers.';
  if (/@|https?:|www\.|\.com\b|\.in\b/i.test(text)) return 'Please remove emails, links or @handles.';
  if (/\b(whats\s?app|insta(gram)?|facebook|fb|snap(chat)?|telegram|upi|paytm|gpay)\b/i.test(text)) return 'Please do not mention apps or payment IDs.';
  return null;
}

export const VOICE_SCRIPT = 'Namaste! Main aapse baat karke khush hoon. Din kaisa raha? Aaram se baithiye, chai ki ek chuski lijiye, aur jo mann mein hai woh boliye. Main sun rahi hoon. Hello, I am happy to talk to you. Take your time — there is no rush, and no judgement here.';
export const GENDER_LABEL: Record<'woman' | 'man' | 'transgender', string> = { woman: 'Woman', man: 'Man', transgender: 'Transgender' };
export const SELFIE_SEC = 10;
export const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const VOICE_MIN_SEC = 30;
export const VOICE_MAX_SEC = 60;

export const EMPTY_DRAFT: Draft = {
  phone: '', phoneVerified: false,
  kycGender: null,
  aadhaarDone: false, aadhaarLast4: '', aadhaarName: '',
  selfie: { recorded: false, consent: false, code: '' },
  payout: { upi: '', accountLast4: '', ifsc: '', nameAtBank: '', verified: false },
  avatarId: null,
  displayName: '', about: '',
  languages: [], style: null,
  topics: [],
  pricePerMin: 20,
  hours: { days: [], from: '19:00', to: '22:00' },
  healthConsent: false, womenOnlyLane: false,
  lgbtqLane: false, lgbtqShowOnProfile: false,
  voice: { recorded: false, durationSec: 0, consent: false, source: null },
  agreements: { rules: false, agreement: false, welfare: false },
  generated: null,
  submitted: false,
};
