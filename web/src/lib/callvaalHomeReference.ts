// Pixel coordinates in the approved 1024 × 1536 reference. Artwork is unchanged;
// headings, navigation and interactive controls remain semantic HTML.
export type ReferenceRect = readonly [number, number, number, number];
export const artwork = {
  logo: [116, 8, 215, 62], sticky: [9, 10, 106, 113], kite: [758, 7, 104, 93],
  hero: [520, 88, 504, 313], privacy: [432, 767, 558, 146],
  numberNote: [309, 858, 114, 58], earn: [24, 1274, 331, 111],
  footerLogo: [58, 1417, 184, 57], cricket: [884, 1385, 140, 110], stitch: [0, 1490, 1024, 46],
} satisfies Record<string, ReferenceRect>;
export const categories = [
  { id: 'doctors', name: 'Doctors', topics: ['General physician', 'Skin', 'Child health', 'Second opinion'], icon: [45, 463, 80, 72], color: '#fbd5e6' },
  { id: 'legal', name: 'Legal advice', topics: ['Property', 'Family', 'Consumer rights', 'Contracts'], icon: [370, 462, 84, 72], color: '#ffedb5' },
  { id: 'tax', name: 'CA & tax', topics: ['Income tax', 'GST', 'ITR filing', 'Business accounts'], icon: [685, 462, 80, 73], color: '#ffcdcd' },
  { id: 'career', name: 'Career & business', topics: ['CV review', 'Interviews', 'Career switch', 'Startups'], icon: [45, 559, 79, 71], color: '#ead0fc' },
  { id: 'home', name: 'Home & property', topics: ['Buying', 'Renting', 'Home loans', 'Renovation'], icon: [370, 558, 82, 71], color: '#ffd7ca' },
  { id: 'learning', name: 'Learning & skills', topics: ['Spoken English', 'Exam prep', 'Guitar', 'Music theory'], icon: [684, 557, 85, 76], color: '#fdcdea' },
  { id: 'wellbeing', name: 'Wellbeing', topics: ['Mental health', 'Stress', 'Sleep', 'Mindfulness'], icon: [43, 652, 85, 77], color: '#fbd6e3' },
  { id: 'astrology', name: 'Astrology', topics: ['Kundli', 'Numerology', 'Tarot', 'Horoscope'], icon: [367, 653, 88, 72], color: '#eacdfb' },
  { id: 'listener', name: 'Listener', topics: ['Mental-health check-in', 'Divorce', 'Loneliness', 'Life changes'], icon: [682, 654, 89, 73], color: '#ffd9ba' },
] satisfies Array<{ id: string; name: string; topics: string[]; icon: ReferenceRect; color: string }>;
export const profiles = [
  { name: 'Dr. Ananya', role: 'General physician', category: 'doctors', languages: 'Hindi, English', price: 25, portrait: [40, 985, 108, 114] },
  { name: 'Adv. Meera', role: 'Property law', category: 'legal', languages: 'Hindi, English', price: 25, portrait: [286, 985, 109, 114] },
  { name: 'CA Rohan', role: 'Income tax', category: 'tax', languages: 'Hindi, English', price: 20, portrait: [524, 985, 108, 114] },
  { name: 'Arjun', role: 'Career mentor', category: 'career', languages: 'Hindi, English', price: 15, portrait: [761, 985, 109, 114] },
  { name: 'Sana', role: 'Wellbeing coach', category: 'wellbeing', languages: 'Hindi, English', price: 15, portrait: [40, 1119, 108, 116] },
  { name: 'Kavya', role: 'Astrology', category: 'astrology', languages: 'Hindi, Kannada', price: 15, portrait: [286, 1119, 108, 116] },
  { name: 'Neha', role: 'Listener', category: 'listener', languages: 'Hindi, Marathi', price: 10, portrait: [523, 1119, 109, 116] },
  { name: 'Dev', role: 'Guitar & music', category: 'learning', languages: 'English, Hindi', price: 12, portrait: [761, 1119, 109, 116] },
  { name: 'Priya', role: 'English tutor', category: 'learning', languages: 'Hindi, English', price: 15, portrait: [761, 1119, 109, 116] },
] satisfies Array<{ name: string; role: string; category: string; languages: string; price: number; portrait: ReferenceRect }>;
