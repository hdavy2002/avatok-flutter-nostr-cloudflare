// [HF-INTRO-B2] Dev-only mock of the intro-application admin API (used when the island gets mock=true AND import.meta.env.DEV; stripped from production builds).
import type { AiDetail, AiScores, IntroDetail, IntroListItem, IntroStatus, IntroVerify, ModerationQueue, RejectReason } from '../../../lib/hfIntroAdminApi';

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
  { code: 'nudity', text: 'Nudity or private parts showing in the video.' },
  { code: 'cover_unsuitable', text: 'Your channel cover photo is not suitable for the site.' },
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
ALL.push(mk(6, 'Isha Kapoor', [['dating', 'Dating advice']], { lang: 'en', hasSocials: false, aadhaar: { status: 'none', female: false } }));

// [HF-MOD-ADMIN-UI] AI verdict samples: 1 passed, 2 flagged (nudity + cover), 3 needs a look, 4 checking, 5 child safety, 6 queued.
const sc = (o: Partial<AiScores> = {}): AiScores => ({ face: 0.97, nudity: 0.01, sexual: 0.01, minor: 0.03, quality: 0.04, ...o });
const base = { reasons: [] as string[], childSafety: false, posterReasons: [] as string[], where: null, whereConfidence: null, checkedAt: now - 600_000, model: 'clef', policyVersion: 'v1', jobId: 'vmj_8f21c4', override: null };
const AI: Record<string, AiDetail> = {
  hfia_mock1: { ...base, status: 'passed', scores: sc() },
  hfia_mock2: { ...base, status: 'flagged', reasons: ['nudity'], posterReasons: ['nudity'], scores: sc({ nudity: 0.92 }), where: 'middle', whereConfidence: 0.6, jobId: 'vmj_3c907a' },
  hfia_mock3: { ...base, status: 'needs_look', reasons: ['poor_quality', 'no_face'], scores: sc({ face: 0.31, quality: 0.74 }) },
  hfia_mock4: { ...base, status: 'checking', scores: null, checkedAt: null, jobId: null, policyVersion: null },
  hfia_mock5: { ...base, status: 'flagged', reasons: ['minor'], childSafety: true, scores: sc({ minor: 0.88 }), where: 'start', whereConfidence: 0.5 },
  hfia_mock6: { ...base, status: 'queued', scores: null, checkedAt: null, jobId: null, policyVersion: null },
};
const SOCIALS = { youtube: ['@priyaastro', 'https://youtube.com/@priyaastro', 12400], instagram: ['priya.astro', 'https://instagram.com/priya.astro', 48200], facebook: ['Sunita Devi Page', 'https://facebook.com/sunita', 8400] } as const;
const verifyOf = (it: IntroListItem): IntroVerify => ({
  aadhaar: { verified: it.aadhaar.status === 'verified', gender: it.aadhaar.status === 'verified' ? (it.aadhaar.female ? 'F' : 'M') : null },
  socials: (it.socialPlatforms ?? []).map((p) => ({ platform: p as 'youtube', handle: SOCIALS[p as 'youtube'][0], url: SOCIALS[p as 'youtube'][1], followers: SOCIALS[p as 'youtube'][2] })),
  whatsapp: true,
});
const summ = (a: AiDetail) => ({ status: a.status, reasons: a.reasons, childSafety: a.childSafety, scores: a.scores, posterReasons: a.posterReasons });
for (const it of ALL) { it.verify = verifyOf(it); if (AI[it.id]) it.ai = summ(AI[it.id]); }
const COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 72"><rect width="120" height="72" fill="#fbbf24"/><circle cx="92" cy="20" r="11" fill="#ea6a12"/><path d="M0 72l34-34 22 20 18-14 46 28z" fill="#6d4fd0"/></svg>');
const gone = new Set<string>();
const wait = <T,>(v: T, ms = 450) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export const mockIntroApi = {
  list: async (status: IntroStatus) => {
    const base = status === 'submitted' ? ALL.filter((i) => !gone.has(i.id)) : status === 'approved' ? [{ ...ALL[1], id: 'hfia_mockA', status: 'approved' as const, reviewedAt: now - 3_600_000 }] : [{ ...ALL[2], id: 'hfia_mockR', status: 'rejected' as const, reviewedAt: now - 7_200_000 }];
    return wait({ items: base, rejectReasons: REASONS });
  },
  queue: async (): Promise<ModerationQueue> => wait({ ok: true, counts: [{ kind: 'video', status: 'queued', n: 1 }, { kind: 'video', status: 'checking', n: 1 }, { kind: 'photo', status: 'failed', n: 0 }], avgWaitMs: 14_000 }, 200),
  detail: async (id: string): Promise<IntroDetail> => {
    const it = ALL.find((i) => i.id === id) ?? ALL[0];
    const ai = AI[id];
    const bad = ai?.status === 'flagged';
    const w2w = it.categories.some((c) => c.id === 'women_to_women');
    return wait({
      application: { id, status: it.status, categories: it.categories, lang: it.lang, topic: 'general', callOption: it.callOption, submittedAt: it.submittedAt, rejectReasons: id === 'hfia_mockR' ? [REASONS[1], REASONS[6]] : [], rejectNote: id === 'hfia_mockR' ? 'Try recording near a window.' : null },
      host: { uid: it.uid, name: it.name, description: 'Namaste! I read kundli and guide people on career and marriage questions. 8 years of practice, calm and simple language. Ask me anything about your birth chart.', ratePerMin: it.ratePerMin, photoUrl: null, callOption: it.callOption, createdAt: now - 12 * 86_400_000 },
      video: id === 'hfia_mockR'
        ? { videoUrl: null, posterUrl: null, durationMs: 14000, width: 720, height: 1280, lang: it.lang, topic: 'general', deletedAt: now - 7_200_000, deletedReason: 'rejected' }
        : { videoUrl: '/mock-intro.mp4', posterUrl: COVER, durationMs: 14000, width: 720, height: 1280, lang: it.lang, topic: 'general' },
      socials: it.hasSocials ? [{ platform: 'youtube', handle: '@priyaastro', url: 'https://youtube.com/@priyaastro', followers: 12400 }, { platform: 'instagram', handle: 'priya.astro', url: 'https://instagram.com/priya.astro', followers: 5300 }] : [],
      aadhaar: { done: it.aadhaar.status === 'verified', female: it.aadhaar.female, name: it.name, verifiedAt: now - 2 * 86_400_000, gender: it.aadhaar.status === 'verified' ? (it.aadhaar.female ? 'F' : 'M') : null },
      ai, photos: ai ? { host: { url: null, status: ai.status === 'checking' || ai.status === 'queued' ? 'checking' : 'active', reason: null }, poster: { status: bad && ai.posterReasons.length ? 'refused' : 'active', reasons: ai.posterReasons } } : undefined,
      whatsappVerified: true, womenToWomen: w2w,
      calendar: it.id === 'hfia_mock4' ? { timezone: 'Asia/Kolkata', weekly: [], empty: true } : { timezone: 'Asia/Kolkata', weekly: [{ weekday: 1, ranges: [{ startMin: 600, endMin: 780 }] }, { weekday: 3, ranges: [{ startMin: 600, endMin: 780 }, { startMin: 1020, endMin: 1200 }] }, { weekday: 0, ranges: [{ startMin: 480, endMin: 600 }] }] },
      history: [], rejectReasons: REASONS,
    });
  },
  approve: async (id: string, note?: string) => {
    await wait(0, 600);
    const a = AI[id];
    const fail = (error: string, message: string) => Object.assign(new Error(message), { body: { ok: false, error, message } });
    if (a?.childSafety) throw fail('child_safety', 'The AI found a child-safety problem. This one can only be rejected.');
    if (a?.status === 'queued' || a?.status === 'checking') throw fail('ai_pending', 'The AI is still checking this application. Try again in a minute.');
    if (a?.status === 'flagged' && !note?.trim()) throw fail('note_required', 'Please write why the AI is wrong before approving.'); gone.add(id); return { ok: true as const, status: 'approved' as const, notified: true, notifyReason: null }; },
  reject: async (id: string, _reasons: string[], _note: string) => { await wait(0, 600); gone.add(id); return { ok: true as const, status: 'rejected' as const, notified: true, notifyReason: null }; },
};
