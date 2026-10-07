export type ReferenceRect = readonly [number, number, number, number];
export interface Mood { slug: string; label: string; group: string }
export const moods: Mood[] = [
  { group: 'Naye dost', slug: 'roz-thodi-baat', label: 'roz thodi baat' },
  { group: 'Naye dost', slug: 'koi-jo-mujhe-jaane', label: 'koi jo mujhe jaane' },
  { group: 'Naye dost', slug: 'shaam-ka-saathi', label: 'shaam ka saathi' },
  { group: 'Naye dost', slug: 'ek-dost-jo-sune', label: 'ek dost jo sune' },
  { group: 'Naye dost', slug: 'apni-bhasha-mein-dost', label: 'apni bhasha mein dost' },
  { group: 'Naye dost', slug: 'kisi-topic-pe-baat', label: 'kisi topic pe baat (cricket, films, books)' },
  { group: 'Naye dost', slug: 'apni-bhasha-mein-baat', label: 'apni bhasha mein baat (Garhwali, Kumaoni, Bhojpuri, Tamil…)' },
  { group: 'Naye dost', slug: 'english-mein-casual-chat', label: 'English mein casual chat' },
  { group: 'Mann ki baat', slug: 'bas-baat-karni-hai', label: 'bas baat karni hai' },
  { group: 'Mann ki baat', slug: 'aaj-akela-lag-raha-hai', label: 'aaj akela lag raha hai' },
  { group: 'Mann ki baat', slug: 'din-kharab-tha', label: 'din kharab tha' },
  { group: 'Mann ki baat', slug: 'raat-ko-neend-nahi-aati', label: 'raat ko neend nahi aati' },
  { group: 'Mann ki baat', slug: 'shaam-ki-company', label: 'shaam ki company' },
  { group: 'Mann ki baat', slug: 'ghar-ki-yaad-aa-rahi-hai', label: 'ghar ki yaad aa rahi hai' },
  { group: 'Mann ki baat', slug: 'kisi-se-share-karna-hai', label: 'kisi se share karna hai' },
  { group: 'Mann ki baat', slug: 'bore-ho-raha-hoon', label: 'bore ho raha hoon' },
  { group: 'Mann ki baat', slug: 'raat-ki-shift-koi-jaga-hai', label: 'raat ki shift, koi jaga hai?' },
  { group: 'Mann ki baat', slug: 'subah-ki-chai-thodi-baat', label: 'subah ki chai, thodi baat' },
  { group: 'Mann ki baat', slug: 'mann-bhaari-hai', label: 'mann bhaari hai' },
  { group: 'Tension', slug: 'exam-ki-tension', label: 'exam ki tension' },
  { group: 'Tension', slug: 'interview-se-darr', label: 'interview se darr' },
  { group: 'Tension', slug: 'shaadi-ka-pressure', label: 'shaadi ka pressure' },
  { group: 'Tension', slug: 'ghar-waalon-se-jhagda', label: 'ghar waalon se jhagda' },
  { group: 'Tension', slug: 'naukri-ki-chinta', label: 'naukri ki chinta' },
  { group: 'Tension', slug: 'breakup', label: 'breakup' },
  { group: 'Zindagi ki baatein', slug: 'shaadi-ki-baatein', label: 'shaadi ki baatein' },
  { group: 'Zindagi ki baatein', slug: 'naya-sheher-nayi-job', label: 'naya sheher, nayi job' },
  { group: 'Zindagi ki baatein', slug: 'paise-ki-tension', label: 'paise ki tension' },
  { group: 'Zindagi ki baatein', slug: 'bachchon-ki-padhai', label: 'bachchon ki padhai' },
  { group: 'Zindagi ki baatein', slug: 'maa-baap-ki-sehat', label: 'maa-baap ki sehat' },
  { group: 'Zindagi ki baatein', slug: 'sehat-ki-chinta', label: 'sehat ki chinta' },
];
export const moodGroups = ['Naye dost', 'Mann ki baat', 'Tension', 'Zindagi ki baatein'] as const;
export interface SampleProfile { id: string; detailPath?: string; name: string; gender: 'woman' | 'man'; moods: string[]; languages: string; availability: 'online' | 'busy' | 'offline'; regulars: string; previewFavourite?: boolean; price: number; rating: number; talkedTo: number; portrait: string; videoKyc?: boolean }
export const availabilityLabel = { online: 'Online now', busy: 'On a call', offline: 'Offline' } as const;
export const callActionLabel = { online: 'Call', busy: 'Notify me when free', offline: 'Notify me when online' } as const;
export const profiles: SampleProfile[] = [
  { id: 'neha', detailPath: '/people/neha', name: 'Neha', gender: 'woman', moods: ['raat-ko-neend-nahi-aati','aaj-akela-lag-raha-hai','roz-thodi-baat','koi-jo-mujhe-jaane','apni-bhasha-mein-dost'], languages: 'Hindi, Marathi', availability: 'online', regulars: 'Regulars: 23', previewFavourite: true, price: 20, rating: 4.9, talkedTo: 164, portrait: 'portrait-7.png', videoKyc: true },
  { id: 'priya', detailPath: '/people/priya', name: 'Priya', gender: 'woman', moods: ['english-mein-casual-chat','interview-se-darr','exam-ki-tension','kisi-topic-pe-baat'], languages: 'Hindi, English', availability: 'offline', regulars: 'Usually online 8–11pm', price: 25, rating: 4.9, talkedTo: 132, portrait: 'portrait-9.png' },
  { id: 'sana', detailPath: '/people/sana', name: 'Sana', gender: 'woman', moods: ['shaadi-ka-pressure','ghar-waalon-se-jhagda','breakup','shaam-ka-saathi','ek-dost-jo-sune'], languages: 'Hindi, English', availability: 'online', regulars: 'Regulars: 18', price: 25, rating: 4.9, talkedTo: 98, portrait: 'portrait-5.png' },
  { id: 'kavya', detailPath: '/people/kavya', name: 'Kavya', gender: 'woman', moods: ['maa-baap-ki-sehat','naya-sheher-nayi-job'], languages: 'Hindi, Kannada', availability: 'online', regulars: 'Regulars: 12', price: 30, rating: 4.8, talkedTo: 86, portrait: 'portrait-6.png' },
  { id: 'dr-ananya', detailPath: '/people/dr-ananya', name: 'Ananya', gender: 'woman', moods: ['shaam-ki-company','din-kharab-tha','apni-bhasha-mein-baat'], languages: 'Hindi, English', availability: 'offline', regulars: 'Usually online 8–11pm', price: 20, rating: 4.8, talkedTo: 120, portrait: 'portrait-ananya.png' },
  { id: 'rohan', name: 'Rohan', gender: 'man', moods: ['naukri-ki-chinta','exam-ki-tension','roz-thodi-baat','koi-jo-mujhe-jaane','apni-bhasha-mein-dost'], languages: 'Hindi, English', availability: 'busy', regulars: 'Regulars: 21', previewFavourite: true, price: 20, rating: 4.7, talkedTo: 130, portrait: 'portrait-3.png' },
  { id: 'arjun', name: 'Arjun', gender: 'man', moods: ['bas-baat-karni-hai','shaam-ki-company','shaam-ka-saathi','ek-dost-jo-sune'], languages: 'Hindi, English', availability: 'offline', regulars: 'Usually online 8–11pm', previewFavourite: true, price: 25, rating: 4.9, talkedTo: 110, portrait: 'portrait-4.png' },
  { id: 'dev', name: 'Dev', gender: 'man', moods: ['kisi-topic-pe-baat','apni-bhasha-mein-baat','english-mein-casual-chat'], languages: 'English, Hindi', availability: 'online', regulars: 'Regulars: 16', price: 30, rating: 4.8, talkedTo: 70, portrait: 'portrait-8.png' },
];
