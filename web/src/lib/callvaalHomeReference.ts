export type ReferenceRect = readonly [number, number, number, number];
export interface Mood { slug: string; label: string; group: string }
export const moods: Mood[] = [
  { group: 'Mann ki baat', slug: 'bas-baat-karni-hai', label: 'bas baat karni hai' },
  { group: 'Mann ki baat', slug: 'aaj-akela-lag-raha-hai', label: 'aaj akela lag raha hai' },
  { group: 'Mann ki baat', slug: 'din-kharab-tha', label: 'din kharab tha' },
  { group: 'Mann ki baat', slug: 'raat-ko-neend-nahi-aati', label: 'raat ko neend nahi aati' },
  { group: 'Mann ki baat', slug: 'shaam-ki-company', label: 'shaam ki company' },
  { group: 'Tension', slug: 'exam-ki-tension', label: 'exam ki tension' },
  { group: 'Tension', slug: 'interview-se-darr', label: 'interview se darr' },
  { group: 'Tension', slug: 'shaadi-ka-pressure', label: 'shaadi ka pressure' },
  { group: 'Tension', slug: 'ghar-waalon-se-jhagda', label: 'ghar waalon se jhagda' },
  { group: 'Tension', slug: 'naukri-ki-chinta', label: 'naukri ki chinta' },
  { group: 'Tension', slug: 'breakup', label: 'breakup' },
  { group: 'Gap-shap', slug: 'kisi-topic-pe-baat', label: 'kisi topic pe baat (cricket, films, books)' },
  { group: 'Gap-shap', slug: 'apni-bhasha-mein-baat', label: 'apni bhasha mein baat (Garhwali, Kumaoni, Bhojpuri, Tamil…)' },
  { group: 'Gap-shap', slug: 'english-mein-casual-chat', label: 'English mein casual chat' },
  { group: 'Taare', slug: 'kundli', label: 'kundli' },
  { group: 'Taare', slug: 'horoscope', label: 'horoscope' },
  { group: 'Taare', slug: 'tarot', label: 'tarot' },
];
export const moodGroups = ['Mann ki baat', 'Tension', 'Gap-shap', 'Taare'] as const;
export interface SampleProfile { detailPath?: string; name: string; moods: string[]; languages: string; online: boolean; price: number; rating: number; talkedTo: number; portrait: string; videoKyc?: boolean }
export const profiles: SampleProfile[] = [
  { detailPath: '/people/neha', name: 'Neha', moods: ['raat-ko-neend-nahi-aati','aaj-akela-lag-raha-hai'], languages: 'Hindi, Marathi', online: true, price: 20, rating: 4.9, talkedTo: 164, portrait: 'portrait-7.png', videoKyc: true },
  { detailPath: '/people/priya', name: 'Priya', moods: ['english-mein-casual-chat','interview-se-darr','exam-ki-tension'], languages: 'Hindi, English', online: false, price: 25, rating: 4.9, talkedTo: 132, portrait: 'portrait-9.png' },
  { detailPath: '/people/sana', name: 'Sana', moods: ['shaadi-ka-pressure','ghar-waalon-se-jhagda','breakup'], languages: 'Hindi, English', online: true, price: 25, rating: 4.9, talkedTo: 98, portrait: 'portrait-5.png' },
  { detailPath: '/people/kavya', name: 'Kavya', moods: ['kundli','horoscope','tarot'], languages: 'Hindi, Kannada', online: true, price: 30, rating: 4.8, talkedTo: 86, portrait: 'portrait-6.png' },
  { detailPath: '/people/dr-ananya', name: 'Ananya', moods: ['shaam-ki-company','din-kharab-tha'], languages: 'Hindi, English', online: false, price: 20, rating: 4.8, talkedTo: 120, portrait: 'portrait-ananya.png' },
  { name: 'Rohan', moods: ['naukri-ki-chinta','exam-ki-tension'], languages: 'Hindi, English', online: true, price: 20, rating: 4.7, talkedTo: 130, portrait: 'portrait-3.png' },
  { name: 'Arjun', moods: ['bas-baat-karni-hai','shaam-ki-company'], languages: 'Hindi, English', online: false, price: 25, rating: 4.9, talkedTo: 110, portrait: 'portrait-4.png' },
  { name: 'Dev', moods: ['kisi-topic-pe-baat','apni-bhasha-mein-baat'], languages: 'English, Hindi', online: true, price: 30, rating: 4.8, talkedTo: 70, portrait: 'portrait-8.png' },
];
