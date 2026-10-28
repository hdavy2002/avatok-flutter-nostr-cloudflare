// [HF-INTRO-B2] Dev-only mock of the intro-application admin API (used when the island gets mock=true AND import.meta.env.DEV; stripped from production builds).
import type { IntroDetail, IntroListItem, IntroStatus, RejectReason } from '../../../lib/hfIntroAdminApi';

const REASONS: RejectReason[] = [
  { code: 'face_unclear', text: 'Your face is not clearly visible in the video.' },
  { code: 'video_dark', text: 'The video is too dark. Please record in good light.' },
  { code: 'audio_unclear', text: 'We could not hear you clearly.' },
  { code: 'contact_shared', text: 'Please do not share phone numbers or social handles in the video.' },
  { code: 'unsuitable', text: 'The content is not suitable for our platform.' },
  { code: 'wrong_category', text: 'Your categories do not match what you talk about.' },
  { code: 'description_fix', text: 'Please improve your description.' },
  { code: 'rate_fix', text: 'Please change your rate per minute.' },
  { code: 'aadhaar_mismatch', text: 'Your Aadhaar details do not match your profile.' },
  { code: 'other', text: 'Other (see note).' },
];
const cat = (id: string, label: string) => ({ id, label });
const now = Date.now();
const mk = (n: number, name: string, cats: [string, string][], o: Partial<IntroListItem> = {}): IntroListItem => ({
  id: `hfia_mock${n}`, uid: `u${n}`, status: 'submitted', name, categories: cats.map(([i, l]) => cat(i, l)), lang: 'hi', ratePerMin: 20 + n * 5,
  callOption: n % 2 ? 'A' : 'B', submittedAt: now - n * 3_600_000 * 5, reviewedAt: null, hasSocials: true, aadhaar: { status: 'verified', female: false }, ...o,
});
const ALL: IntroListItem[] = [
  mk(1, 'Priya Sharma', [['astrology', 'Astrology'], ['spirituality', 'Spirituality'], ['women_to_women', 'Women-to-Women']], { aadhaar: { status: 'verified', female: true }, socialPlatforms: ['youtube', 'instagram'] }),
  mk(2, 'Rohit Verma', [['fitness', 'Fitness'], ['health_wellness', 'Health & Wellness']], { lang: 'en', socialPlatforms: ['instagram'] }),
  mk(3, 'Sunita Devi', [['cook', 'Cooking'], ['teacher', 'Teacher'], ['language', 'Language'], ['career', 'Career'], ['music', 'Music'], ['beauty', 'Beauty']], { lang: 'mr', aadhaar: { status: 'none', female: false }, socialPlatforms: ['facebook'] }),
  mk(4, 'Arjun Nair', [['tech', 'Tech']], { lang: 'ml', hasSocials: false, aadhaar: { status: 'none', female: false } }),
  mk(5, 'Meera Iyer', [['listener', 'Listener'], ['women_to_women', 'Women-to-Women']], { lang: 'ta', aadhaar: { status: 'verified', female: true }, socialPlatforms: ['youtube'] }),
];
const gone = new Set<string>();
const wait = <T,>(v: T, ms = 450) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export const mockIntroApi = {
  list: async (status: IntroStatus) => {
    const base = status === 'submitted' ? ALL.filter((i) => !gone.has(i.id)) : status === 'approved' ? [{ ...ALL[1], id: 'hfia_mockA', status: 'approved' as const, reviewedAt: now - 3_600_000 }] : [{ ...ALL[2], id: 'hfia_mockR', status: 'rejected' as const, reviewedAt: now - 7_200_000 }];
    return wait({ items: base, rejectReasons: REASONS });
  },
  detail: async (id: string): Promise<IntroDetail> => {
    const it = ALL.find((i) => i.id === id) ?? ALL[0];
    const w2w = it.categories.some((c) => c.id === 'women_to_women');
    return wait({
      application: { id, status: it.status, categories: it.categories, lang: it.lang, topic: 'general', callOption: it.callOption, submittedAt: it.submittedAt, rejectReasons: id === 'hfia_mockR' ? [REASONS[1], REASONS[6]] : [], rejectNote: id === 'hfia_mockR' ? 'Try recording near a window.' : null },
      host: { uid: it.uid, name: it.name, description: 'Namaste! I read kundli and guide people on career and marriage questions. 8 years of practice, calm and simple language. Ask me anything about your birth chart.', ratePerMin: it.ratePerMin, photoUrl: null, callOption: it.callOption, createdAt: now - 12 * 86_400_000 },
      video: { videoUrl: '/mock-intro.mp4', posterUrl: null, durationMs: 14000, width: 720, height: 1280, lang: it.lang, topic: 'general' },
      socials: it.hasSocials ? [{ platform: 'youtube', handle: '@priyaastro', url: 'https://youtube.com/@priyaastro', followers: 12400 }, { platform: 'instagram', handle: 'priya.astro', url: 'https://instagram.com/priya.astro', followers: 5300 }] : [],
      aadhaar: { done: it.aadhaar.status === 'verified', female: it.aadhaar.female, gender: it.aadhaar.status === 'verified' ? (it.aadhaar.female ? 'F' : 'M') : null },
      whatsappVerified: true, womenToWomen: w2w,
      calendar: it.id === 'hfia_mock4' ? { timezone: 'Asia/Kolkata', weekly: [], empty: true } : { timezone: 'Asia/Kolkata', weekly: [{ weekday: 1, ranges: [{ startMin: 600, endMin: 780 }] }, { weekday: 3, ranges: [{ startMin: 600, endMin: 780 }, { startMin: 1020, endMin: 1200 }] }, { weekday: 0, ranges: [{ startMin: 480, endMin: 600 }] }] },
      history: [], rejectReasons: REASONS,
    });
  },
  approve: async (id: string) => { await wait(0, 600); gone.add(id); return { ok: true as const, status: 'approved' as const, notified: true, notifyReason: null }; },
  reject: async (id: string, _reasons: string[], _note: string) => { await wait(0, 600); gone.add(id); return { ok: true as const, status: 'rejected' as const, notified: true, notifyReason: null }; },
};
