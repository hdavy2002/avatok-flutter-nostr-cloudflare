import brandConfig from '../../../Specs/brand.json';
export type ProfileDetailId = 'dr-ananya' | 'sana' | 'neha' | 'kavya' | 'priya';
export interface ProfilePhoto { path: string; width: number; height: number; alt: string; }
export interface ProfileTip { icon: 'notes' | 'pill' | 'user' | 'chat'; title: string; text: string; }
export interface ProfileBenefit { icon: 'lock' | 'shield' | 'chat'; title: string; text: string; }
export interface SampleReview { name: string; initials: string; text: string; date?: string; iso?: string; rating?: 1 | 2 | 3 | 4 | 5; }
// Static, illustrative fixtures only. Optional facts are never filled with invented defaults.
export interface CallvaalProfileDetail {
  id: ProfileDetailId;
  displayName: string;
  roleLabel: string;
  isSample: true;
  description: string;
  portrait: ProfilePhoto;
  gallery: ProfilePhoto[];
  languages: string[];
  ratePerMinute: number;
  rating?: { average: number; count: number };
  conversationCount?: number;
  availabilityLabel?: string;
  nextAvailableLabel?: string;
  verification: { status: 'illustrative' };
  online: boolean;
  personalQuote?: string;
  about: string;
  topicTags: string[];
  reviews?: SampleReview[];
  reviewLabel?: string;
  preparationTips: ProfileTip[];
  benefits: ProfileBenefit[];
  sampleDisclosure: string;
  serviceDisclosure?: string;
  previewDisclosure: string;
  yellowNote: string[];
  pinkNote: string[];
}

const photo = (file: string, alt: string, portrait = false): ProfilePhoto => ({
  path: `/assets/callvaal/scrapbook/${file}.png`, alt,
  width: portrait ? 1254 : 1536, height: portrait ? 1254 : 1024,
});
export const shortCallDisclaimer = 'Yahan sirf baat hoti hai. No medical, legal or money advice. No miracles, no guaranteed results. Not a replacement for a doctor or counsellor. 18+ only.';
const sampleDisclosure = 'Sample profile · Illustrative. Images, availability, video-KYC badges, reviews and prices are illustrative; no identity checks have been completed.';
const previewDisclosure = 'Preview only. Calls, bookings and payments are unavailable.';
const preparationTips: ProfileTip[] = [
  { icon: 'chat', title: 'Just a conversation', text: 'Talk and share at your own pace. No professional advice or promised results.' },
  { icon: 'user', title: 'Keep it respectful', text: '18+ only. You can end a call at any time. Sexual or abusive talk is prohibited. End and report the call if you feel unsafe.' },
  { icon: 'notes', title: 'Know before you start', text: 'Calls are recorded with consent for safety and kept for 30 days. In crisis, call Tele-MANAS 14416 or 112.' },
];
const benefits: ProfileBenefit[] = [
  { icon: 'lock', title: 'Your number stays private', text: `Calls are bridged through ${brandConfig.homepageIdentity.name}` },
  { icon: 'shield', title: 'Video-KYC badge', text: 'Illustrative badge; this sample is not verified' },
  { icon: 'chat', title: 'Your pace, your choice', text: 'Share only what feels comfortable' },
];
const common = { isSample: true as const, roleLabel: 'Someone to talk to', verification: { status: 'illustrative' as const }, preparationTips, benefits, sampleDisclosure, previewDisclosure, serviceDisclosure: shortCallDisclaimer, reviewLabel: 'Illustrative review', yellowNote: ['A little', 'space to', 'be heard.'], pinkNote: ['Your story.', 'Your pace.'] };
export const profileDetails: Record<ProfileDetailId, CallvaalProfileDetail> = {
  "dr-ananya": { ...common,
    id: "dr-ananya", displayName: "Ananya",
    description: "Talk to Ananya — an illustrative sample host. Your number stays private. Preview only; calls and payments are unavailable.",
    portrait: photo("portrait-ananya", "Illustrative portrait of middle-aged host Ananya", true), gallery: [],
    languages: ["Hindi", "English"], ratePerMinute: 20, online: false, availabilityLabel: "Offline",
    rating: { average: 4.8, count: 42 }, conversationCount: 120,
    personalQuote: "A cup of chai and a little company can make an ordinary evening feel warmer.", about: "Ananya enjoys long chats about films, family stories and the small things in everyday life. Bring a story, talk about your day, or simply spend a little time together.", topicTags: ["shaam ki company", "din kharab tha"],
    reviews: [{ name: 'Riya S.', initials: 'RS', rating: 5, text: 'It felt good to tell my story without being rushed.' }, { name: 'Amit K.', initials: 'AK', rating: 5, text: 'A friendly conversation with room to pause.' }],
  },
  "sana": { ...common,
    id: "sana", displayName: "Sana",
    description: "Talk to Sana — an illustrative sample host. Your number stays private. Preview only; calls and payments are unavailable.",
    portrait: photo("portrait-5", "Illustrative portrait of Sana", true), gallery: [],
    languages: ["Hindi", "English"], ratePerMinute: 25, online: true, availabilityLabel: "Online now",
    rating: { average: 4.9, count: 36 }, conversationCount: 98,
    personalQuote: "Take your time. Start wherever you like.", about: "Sana enjoys hearing people’s stories. Talk about a difficult day, family pressure or a change in your life. She is an ordinary person here for a friendly conversation.", topicTags: ["shaadi ka pressure", "ghar waalon se jhagda", "breakup"],
    reviews: [{ name: 'Riya S.', initials: 'RS', rating: 5, text: 'It felt good to tell my story without being rushed.' }, { name: 'Amit K.', initials: 'AK', rating: 5, text: 'A friendly conversation with room to pause.' }],
  },
  "neha": { ...common,
    id: "neha", displayName: "Neha",
    description: "Talk to Neha — an illustrative sample host. Your number stays private. Preview only; calls and payments are unavailable.",
    portrait: photo("portrait-7", "Illustrative portrait of Neha", true), gallery: [],
    languages: ["Hindi", "Marathi"], ratePerMinute: 20, online: true, availabilityLabel: "Online now",
    rating: { average: 4.9, count: 58 }, conversationCount: 164,
    personalQuote: "You don’t need a perfect way to explain it. I’m here to listen.", about: "Neha loves a relaxed conversation, whether it is a late-night story or a little company after a long day. Speak in Hindi or Marathi and share as much or as little as you like.", topicTags: ["raat ko neend nahi aati", "aaj akela lag raha hai"],
    reviews: [{ name: 'Riya S.', initials: 'RS', rating: 5, text: 'It felt good to tell my story without being rushed.' }, { name: 'Amit K.', initials: 'AK', rating: 5, text: 'A friendly conversation with room to pause.' }],
  },
  "kavya": { ...common,
    id: "kavya", displayName: "Kavya",
    description: "Talk to Kavya — an illustrative sample host. Your number stays private. Preview only; calls and payments are unavailable.",
    portrait: photo("portrait-6", "Illustrative portrait of Kavya", true), gallery: [],
    languages: ["Hindi", "Kannada"], ratePerMinute: 30, online: true, availabilityLabel: "Online now",
    rating: { average: 4.8, count: 29 }, conversationCount: 86,
    personalQuote: "A reading can open a conversation. Your choices remain your own.", about: "Kavya enjoys chatting about kundli, horoscope and tarot as ways to reflect and explore stories. Taare conversations are for reflection and entertainment; no outcome is promised.", topicTags: ["kundli", "horoscope", "tarot"],
    reviews: [{ name: 'Riya S.', initials: 'RS', rating: 5, text: 'It felt good to tell my story without being rushed.' }, { name: 'Amit K.', initials: 'AK', rating: 5, text: 'A friendly conversation with room to pause.' }],
  },
  "priya": { ...common,
    id: "priya", displayName: "Priya",
    description: "Talk to Priya — an illustrative sample host. Your number stays private. Preview only; calls and payments are unavailable.",
    portrait: photo("portrait-9", "Illustrative portrait of Priya", true), gallery: [],
    languages: ["Hindi", "English"], ratePerMinute: 25, online: false, availabilityLabel: "Offline",
    rating: { average: 4.9, count: 45 }, conversationCount: 132,
    personalQuote: "Let’s talk, with room to pause and find your words.", about: "Priya enjoys everyday English chats, films and books. Talk about exam tension or interview nerves, or simply have a casual conversation in Hindi or English.", topicTags: ["English mein casual chat", "interview se darr", "exam ki tension"],
    reviews: [{ name: 'Riya S.', initials: 'RS', rating: 5, text: 'It felt good to tell my story without being rushed.' }, { name: 'Amit K.', initials: 'AK', rating: 5, text: 'A friendly conversation with room to pause.' }],
  },
};
