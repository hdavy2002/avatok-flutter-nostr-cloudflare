import brandConfig from '../../../Specs/brand.json';
import { profiles, type SampleProfile } from './callvaalHomeReference';

// [HF-PROFILE-DETAIL-2] Every card in callvaalHomeReference.ts has a detail page.
// Card facts (tagline, price, rating, languages, moods, talked-to, regulars,
// conversation style, availability) come from the CARD — one source, so the card
// and the page can never disagree. This file holds only what the card does not.
export type ProfileDetailId = 'neha' | 'priya' | 'sana' | 'kavya' | 'dr-ananya' | 'rohan' | 'arjun' | 'dev';
export interface ProfilePhoto { path: string; width: number; height: number; alt: string; }
export interface ProfileTip { icon: 'notes' | 'pill' | 'user' | 'chat'; title: string; text: string; }
export interface ProfileBenefit { icon: 'lock' | 'shield' | 'chat'; title: string; text: string; }
export interface SampleReview { name: string; initials: string; text: string; date: string; iso: string; rating: 1 | 2 | 3 | 4 | 5; mood?: string; minutes?: number; regular?: boolean; }
/** Star counts, 5★ first. Their weighted average matches the card's rating. */
export type RatingBreakdown = [number, number, number, number, number];

export interface CallvaalProfileDetail {
  id: ProfileDetailId;
  card: SampleProfile;
  displayName: string;
  roleLabel: string;
  isSample: true;
  description: string;
  portrait: ProfilePhoto;
  gallery: ProfilePhoto[];
  online: boolean;
  availabilityLabel: string;
  nextAvailableLabel?: string;
  verification: { status: 'illustrative' };
  personalQuote: string;
  about: string;
  intro: string;
  rating: { average: number; count: number; breakdown: RatingBreakdown };
  reviews: SampleReview[];
  reviewLabel: string;
  preparationTips: ProfileTip[];
  benefits: ProfileBenefit[];
  sampleDisclosure: string;
  serviceDisclosure: string;
  previewDisclosure: string;
  yellowNote: string[];
  pinkNote: string[];
}

export const shortCallDisclaimer = 'Yahan sirf baat hoti hai. No medical, legal or money advice. No miracles, no guaranteed results. Not a replacement for a doctor or counsellor. 18+ only.';
const sampleDisclosure = 'Sample profile · Illustrative. Images, availability, video-KYC badges, reviews and prices are illustrative; no identity checks have been completed.';
const previewDisclosure = 'Preview only. Calls, bookings and payments are unavailable.';
const preparationTips: ProfileTip[] = [
  { icon: 'chat', title: 'Just a conversation', text: 'Talk and share at your own pace. No professional advice or promised results.' },
  { icon: 'user', title: 'Keep it respectful', text: '18+ only. You can end a call at any time. Sexual or abusive talk is prohibited. End and report the call if you feel unsafe.' },
  { icon: 'notes', title: 'Know before you start', text: 'Calls are not recorded; AI keeps an eye on every live call for safety. In crisis, call Tele-MANAS 14416 or 112.' },
];
const benefits: ProfileBenefit[] = [
  { icon: 'lock', title: 'Your number stays private', text: `Your number is masked: calls are bridged through ${brandConfig.homepageIdentity.name}. Hosts appear only as an AI avatar they chose, never a real photo.` },
  { icon: 'shield', title: 'Video-KYC badge', text: 'Illustrative badge; this sample is not verified' },
  { icon: 'chat', title: 'Your pace, your choice', text: 'Share only what feels comfortable' },
];

interface Extra { quote: string; about: string; intro: string; count: number; breakdown: RatingBreakdown; reviews: SampleReview[]; next?: string; }
const r = (name: string, rating: SampleReview['rating'], iso: string, text: string, extra: Partial<SampleReview> = {}): SampleReview => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const initials = name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();
  return { name, initials, rating, iso, date, text, ...extra };
};

const extras: Record<ProfileDetailId, Extra> = {
  neha: {
    quote: 'You don’t need a perfect way to explain it. I’m here to listen.',
    about: 'Neha loves a relaxed conversation, whether it is a late-night story or a little company after a long day. Speak in Hindi or Marathi and share as much or as little as you like.',
    intro: '“Namaste, main Neha. Raat ko neend nahi aa rahi ya din bhaari tha — aao, thodi baat karte hain.”',
    count: 58, breakdown: [53, 4, 1, 0, 0],
    reviews: [
      r('Riya S.', 5, '2026-10-06', 'Raat ke 1 baje call kiya tha. Neha ne bilkul jaldi nahi ki, bas suna. Neend achhi aayi uske baad.', { mood: 'raat ko neend nahi aati', minutes: 22, regular: true }),
      r('Amit K.', 5, '2026-10-02', 'Marathi mein baat karke ghar jaisa laga. Very calm voice.', { mood: 'apni bhasha mein dost', minutes: 15 }),
      r('Pooja M.', 5, '2026-09-27', 'I was feeling very alone after shifting to Pune. She made it feel normal to talk about it.', { mood: 'aaj akela lag raha hai', minutes: 30, regular: true }),
      r('Sameer D.', 4, '2026-09-19', 'Good conversation. Network dropped once but she called back time pe.', { minutes: 12 }),
      r('Kiran P.', 5, '2026-09-11', 'Roz 10 minute baat karta hoon, din ka best part hai.', { mood: 'roz thodi baat', minutes: 10, regular: true }),
    ],
  },
  priya: {
    quote: 'Let’s talk, with room to pause and find your words.',
    about: 'Priya enjoys everyday English chats, films and books. Talk about exam tension or interview nerves, or simply have a casual conversation in Hindi or English.',
    intro: '“Hi, I’m Priya! Interview kal hai? Ya bas English mein casual baat karni hai? Let’s talk.”',
    count: 45, breakdown: [41, 3, 1, 0, 0], next: 'today, 8:00 pm',
    reviews: [
      r('Ankit R.', 5, '2026-10-05', 'Practised my interview answers with her. Next day felt much less nervous.', { mood: 'interview se darr', minutes: 25 }),
      r('Meera J.', 5, '2026-09-30', 'Easy English chat, no judgement on mistakes. Exactly what I needed.', { mood: 'English mein casual chat', minutes: 18, regular: true }),
      r('Harsh V.', 4, '2026-09-22', 'Nice talk about books. Wish she was online earlier in the evening.', { mood: 'kisi topic pe baat', minutes: 14 }),
      r('Sneha T.', 5, '2026-09-14', 'Board exam ka stress tha. Usne bas suna aur hasaya. Felt light.', { mood: 'exam ki tension', minutes: 20 }),
      r('Rahul B.', 5, '2026-09-08', 'Friendly and patient. Will call again.', { minutes: 11 }),
    ],
  },
  sana: {
    quote: 'Take your time. Start wherever you like.',
    about: 'Sana enjoys hearing people’s stories. Talk about a difficult day, family pressure or a change in your life. She is an ordinary person here for a friendly conversation.',
    intro: '“Hi, main Sana. Ghar mein kuch chal raha hai ya bas shaam khaali hai? Aaram se baat karte hain.”',
    count: 36, breakdown: [33, 2, 1, 0, 0],
    reviews: [
      r('Nisha A.', 5, '2026-10-07', 'Shaadi ke pressure ki baat kisi se nahi kar paa rahi thi. Sana ne bina judge kiye suna.', { mood: 'shaadi ka pressure', minutes: 28, regular: true }),
      r('Farhan Q.', 5, '2026-09-29', 'After my breakup I just needed someone to talk to. Very kind.', { mood: 'breakup', minutes: 24 }),
      r('Divya L.', 5, '2026-09-21', 'Shaam ko 15 minute ki baat, mood theek ho gaya.', { mood: 'shaam ka saathi', minutes: 15 }),
      r('Vikas N.', 4, '2026-09-15', 'Good listener. Call thoda chhota raha, next time lamba karunga.', { minutes: 8 }),
      r('Ayesha K.', 5, '2026-09-06', 'Felt like talking to an old friend.', { mood: 'ek dost jo sune', minutes: 19, regular: true }),
    ],
  },
  kavya: {
    quote: 'A familiar voice can make a new city feel a little more like home.',
    about: 'Kavya enjoys friendly conversations about everyday life, caring for parents and finding your feet in a new city or job. Talk and share — not medical, legal or money advice.',
    intro: '“Namaskara, main Kavya. Naya sheher, nayi job, ya ghar ki fikar — aao baat karte hain, Hindi ya Kannada mein.”',
    count: 29, breakdown: [24, 4, 1, 0, 0],
    reviews: [
      r('Suresh G.', 5, '2026-10-04', 'Bengaluru mein pehla mahina tough tha. Kavya ne Kannada ke kuch words bhi sikhaye!', { mood: 'naya sheher, nayi job', minutes: 21, regular: true }),
      r('Lata R.', 5, '2026-09-28', 'Papa hospital mein the, kisi se baat karni thi. She was gentle and practical.', { mood: 'maa-baap ki sehat', minutes: 26 }),
      r('Manoj H.', 4, '2026-09-20', 'Good chat. Price thoda zyada laga but baat achhi hui.', { minutes: 12 }),
      r('Deepa S.', 5, '2026-09-12', 'Very warm. I call her every Sunday now.', { minutes: 17, regular: true }),
      r('Arvind K.', 5, '2026-09-03', 'She remembered what we talked about last time. Felt nice.', { mood: 'naya sheher, nayi job', minutes: 14, regular: true }),
    ],
  },
  'dr-ananya': {
    quote: 'A cup of chai and a little company can make an ordinary evening feel warmer.',
    about: 'Ananya enjoys long chats about films, family stories and the small things in everyday life. Bring a story, talk about your day, or simply spend a little time together.',
    intro: '“Namaste, main Ananya. Chai ready hai? Aaj ka din kaisa tha — sunao.”',
    count: 42, breakdown: [35, 6, 1, 0, 0], next: 'today, 8:00 pm',
    reviews: [
      r('Ramesh P.', 5, '2026-10-03', 'Retired hoon, shaam ko akela lagta hai. Ananya ji se baat karke achha lagta hai.', { mood: 'shaam ki company', minutes: 32, regular: true }),
      r('Shalini V.', 5, '2026-09-26', 'We talked about old Hindi films for half an hour. Lovely evening.', { minutes: 30, regular: true }),
      r('Gaurav T.', 4, '2026-09-18', 'Din kharab tha, baat karke halka laga.', { mood: 'din kharab tha', minutes: 13 }),
      r('Usha B.', 5, '2026-09-10', 'Bhojpuri mein baat ki, bahut apnapan laga.', { mood: 'apni bhasha mein baat', minutes: 20 }),
      r('Tarun M.', 5, '2026-09-02', 'Patient and kind. Never felt rushed.', { minutes: 16 }),
    ],
  },
  rohan: {
    quote: 'Big day tomorrow? Say it out loud once — it gets smaller.',
    about: 'Rohan has been through his own job hunts and exam seasons. Talk through the nerves, plan your day, or just chat about anything else for a while.',
    intro: '“Hey, main Rohan. Exam ya naukri ki tension? Ek baar bol ke dekho, halka lagega.”',
    count: 38, breakdown: [29, 6, 2, 1, 0],
    reviews: [
      r('Aditya S.', 5, '2026-10-06', 'Night before my campus placement. He calmed me down, got the job!', { mood: 'naukri ki chinta', minutes: 19 }),
      r('Neeraj K.', 4, '2026-09-30', 'Good talk about exam prep. He was busy on another call first, had to wait.', { mood: 'exam ki tension', minutes: 15 }),
      r('Imran H.', 5, '2026-09-24', 'Roz shaam ko 10 min, keeps me on track.', { mood: 'roz thodi baat', minutes: 10, regular: true }),
      r('Varun D.', 3, '2026-09-16', 'Okay chat. Was hoping for more cricket talk.', { minutes: 7 }),
      r('Kunal P.', 5, '2026-09-09', 'Felt like a big brother. Very encouraging.', { minutes: 22, regular: true }),
    ],
  },
  arjun: {
    quote: 'No agenda. Just two people and an evening.',
    about: 'Arjun is a good listener who enjoys easy evening conversations — your day, your city, music, anything. You don’t need a reason to call.',
    intro: '“Namaste, main Arjun. Bas baat karni hai? Perfect, wahi toh main bhi chahta hoon.”',
    count: 34, breakdown: [31, 2, 1, 0, 0], next: 'today, 8:00 pm',
    reviews: [
      r('Sanjay R.', 5, '2026-10-05', 'Bas baat karni thi, koi topic nahi. Arjun ke saath 25 minute nikal gaye.', { mood: 'bas baat karni hai', minutes: 25, regular: true }),
      r('Prakash L.', 5, '2026-09-27', 'Late shift ke baad shaam ki company. Very relaxed guy.', { mood: 'shaam ki company', minutes: 18 }),
      r('Mohit G.', 5, '2026-09-19', 'He listens more than he talks. Rare.', { mood: 'ek dost jo sune', minutes: 20, regular: true }),
      r('Jatin S.', 4, '2026-09-12', 'Nice chat. Usually online only after 8pm, plan accordingly.', { minutes: 11 }),
      r('Ravi N.', 5, '2026-09-04', 'Felt like chatting with a college friend.', { mood: 'shaam ka saathi', minutes: 16 }),
    ],
  },
  dev: {
    quote: 'Kohli ya Dhoni? Let’s argue nicely.',
    about: 'Dev loves cricket, films and long debates about both. Talk in English or Hindi, pick a topic, or let the conversation wander.',
    intro: '“Hi, Dev here. Last night ka match dekha? Ya koi nayi film? Let’s talk.”',
    count: 22, breakdown: [18, 3, 1, 0, 0],
    reviews: [
      r('Akash M.', 5, '2026-10-07', 'Full cricket discussion for 20 minutes. Made my evening.', { mood: 'kisi topic pe baat', minutes: 20, regular: true }),
      r('Siddharth P.', 5, '2026-09-29', 'Casual English chat, very fun and easy.', { mood: 'English mein casual chat', minutes: 15 }),
      r('Nikhil J.', 4, '2026-09-21', 'Good film recommendations. Talks fast though!', { minutes: 12 }),
      r('Rohit A.', 5, '2026-09-13', 'Tamil films pe baat ki, he knew a lot.', { mood: 'apni bhasha mein baat', minutes: 18 }),
      r('Yash B.', 5, '2026-09-05', 'Fun guy, made my boring evening better.', { minutes: 14, regular: true }),
    ],
  },
};

const availabilityLabel = { online: 'Online now', busy: 'On a call', offline: 'Offline' } as const;
function build(id: ProfileDetailId): CallvaalProfileDetail {
  const card = profiles.find(profile => profile.id === id);
  if (!card) throw new Error(`profile ${id} missing from callvaalHomeReference.ts`);
  const extra = extras[id];
  return {
    id, card, displayName: card.name, roleLabel: 'Someone to talk to', isSample: true,
    description: `Talk to ${card.name} — an illustrative sample host. Your number stays private. Preview only; calls and payments are unavailable.`,
    portrait: { path: `/assets/callvaal/scrapbook/${card.portrait}`, width: 1254, height: 1254, alt: `Illustrative portrait of ${card.name}` },
    gallery: [],
    online: card.availability === 'online', availabilityLabel: availabilityLabel[card.availability],
    nextAvailableLabel: extra.next,
    verification: { status: 'illustrative' },
    personalQuote: extra.quote, about: extra.about, intro: extra.intro,
    rating: { average: card.rating, count: extra.count, breakdown: extra.breakdown },
    reviews: extra.reviews, reviewLabel: 'Illustrative review',
    preparationTips, benefits, sampleDisclosure, previewDisclosure, serviceDisclosure: shortCallDisclaimer,
    yellowNote: ['A little', 'space to', 'be heard.'], pinkNote: ['Your story.', 'Your pace.'],
  };
}
export const profileDetailIds = Object.keys(extras) as ProfileDetailId[];
export const profileDetails = Object.fromEntries(profileDetailIds.map(id => [id, build(id)])) as Record<ProfileDetailId, CallvaalProfileDetail>;
