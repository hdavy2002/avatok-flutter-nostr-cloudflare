// Pixel coordinates in the approved 1024 × 1536 reference. Artwork is unchanged;
// headings, navigation and interactive controls remain semantic HTML.
export type ReferenceRect = readonly [number, number, number, number];
export type CategoryId = 'doctors' | 'legal' | 'tax' | 'career' | 'relationships' | 'counsellor' | 'listener' | 'astrology' | 'practice';
export type VerificationRegistry = 'NMC' | 'Bar Council' | 'ICAI' | 'RCI';
export const artwork = {
  logo: [116, 8, 215, 62], sticky: [9, 10, 106, 113], kite: [758, 7, 104, 93],
  hero: [520, 88, 504, 313], privacy: [432, 767, 558, 146],
  numberNote: [309, 858, 114, 58], earn: [24, 1274, 331, 111],
  footerLogo: [58, 1417, 184, 57], cricket: [884, 1385, 140, 110], stitch: [0, 1490, 1024, 46],
} satisfies Record<string, ReferenceRect>;
export const categories = [
  { id: 'doctors', name: 'Doctors', topics: ['Second opinion on diagnosis', 'Explain my report', 'Sexual health', 'Women’s health', 'Mental health meds'], verificationRegistry: 'NMC', spriteIndex: 0, icon: [45, 463, 80, 72], color: '#fbd5e6' },
  { id: 'legal', name: 'Legal', topics: ['Divorce & custody', 'Police / FIR', 'Cheque bounce & loan recovery harassment', 'Tenant / landlord disputes', 'Workplace harassment'], verificationRegistry: 'Bar Council', spriteIndex: 1, icon: [370, 462, 84, 72], color: '#ffedb5' },
  { id: 'tax', name: 'Tax & money', topics: ['IT / GST notice', 'Undisclosed income', 'Debt & EMI defaults', 'Is this investment a scam?'], verificationRegistry: 'ICAI', spriteIndex: 2, icon: [685, 462, 80, 73], color: '#ffcdcd' },
  { id: 'career', name: 'Career & workplace', topics: ['Salary negotiation', 'Should I resign?', 'Toxic boss', 'Job offer A vs B', 'Layoff'], verificationRegistry: null, spriteIndex: 3, icon: [45, 559, 79, 71], color: '#ead0fc' },
  { id: 'relationships', name: 'Relationships & marriage', topics: ['Arranged-marriage doubts', 'In-laws', 'Suspecting cheating', 'Breakup', 'Pre-divorce'], verificationRegistry: null, spriteIndex: 4, icon: [370, 558, 82, 71], color: '#ffd7ca' },
  { id: 'counsellor', name: 'Counsellor', topics: ['Anxiety', 'Depression', 'Addiction', 'Therapy second opinion'], verificationRegistry: 'RCI', spriteIndex: 6, icon: [43, 652, 85, 77], color: '#fbd6e3' },
  { id: 'listener', name: 'Listener', topics: ['Heartbreak', 'Loneliness', 'Grief', 'Late-night vent', 'Family pressure'], verificationRegistry: null, spriteIndex: 8, icon: [682, 654, 89, 73], color: '#ffd9ba' },
  { id: 'astrology', name: 'Astrology', topics: ['Kundli', 'Numerology', 'Tarot', 'Horoscope', 'Vastu'], verificationRegistry: null, spriteIndex: 7, icon: [367, 653, 88, 72], color: '#eacdfb' },
  { id: 'practice', name: 'Practice', topics: ['Spoken English', 'Mock interview'], verificationRegistry: null, spriteIndex: 5, icon: [684, 557, 85, 76], color: '#fdcdea' },
] satisfies Array<{ id: CategoryId; name: string; topics: string[]; verificationRegistry: VerificationRegistry | null; spriteIndex: number; icon: ReferenceRect; color: string }>;
export interface SampleProfile { detailPath?: string; name: string; role: string; category: CategoryId; verification: { registry: VerificationRegistry; status: 'illustrative' } | null; languages: string; price: number; portrait: ReferenceRect }
export const profiles: SampleProfile[] = [
  { detailPath: '/people/dr-ananya', name: 'Dr. Ananya', role: 'General physician', category: 'doctors', verification: { registry: 'NMC', status: 'illustrative' }, languages: 'Hindi, English', price: 25, portrait: [40, 985, 108, 114] },
  { name: 'Adv. Meera', role: 'Property law', category: 'legal', verification: { registry: 'Bar Council', status: 'illustrative' }, languages: 'Hindi, English', price: 25, portrait: [286, 985, 109, 114] },
  { name: 'CA Rohan', role: 'Income tax', category: 'tax', verification: { registry: 'ICAI', status: 'illustrative' }, languages: 'Hindi, English', price: 20, portrait: [524, 985, 108, 114] },
  { name: 'Arjun', role: 'Career mentor', category: 'career', verification: null, languages: 'Hindi, English', price: 15, portrait: [761, 985, 109, 114] },
  { name: 'Sana', role: 'Counsellor', category: 'counsellor', verification: { registry: 'RCI', status: 'illustrative' }, languages: 'Hindi, English', price: 15, portrait: [40, 1119, 108, 116] },
  { name: 'Kavya', role: 'Astrology', category: 'astrology', verification: null, languages: 'Hindi, Kannada', price: 15, portrait: [286, 1119, 108, 116] },
  { name: 'Neha', role: 'Listener', category: 'listener', verification: null, languages: 'Hindi, Marathi', price: 10, portrait: [523, 1119, 109, 116] },
  { name: 'Dev', role: 'Relationship guide', category: 'relationships', verification: null, languages: 'English, Hindi', price: 12, portrait: [761, 1119, 109, 116] },
  { name: 'Priya', role: 'English & interview practice', category: 'practice', verification: null, languages: 'Hindi, English', price: 15, portrait: [761, 1119, 109, 116] },
];
