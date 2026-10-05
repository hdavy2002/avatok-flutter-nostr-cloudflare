import type { CategoryId } from './callvaalHomeReference';

export type ProfileDetailId = 'dr-ananya' | 'sana' | 'neha' | 'kavya' | 'priya';
export interface ProfilePhoto { path: string; width: number; height: number; alt: string; }
export interface ProfileTip { icon: 'notes' | 'pill' | 'user' | 'chat'; title: string; text: string; }
export interface ProfileBenefit { icon: 'lock' | 'shield' | 'chat'; title: string; text: string; }
export interface SampleReview { name: string; initials: string; text: string; date?: string; iso?: string; rating?: 1 | 2 | 3 | 4 | 5; }
// Static, illustrative fixtures only. Optional facts are never filled with invented defaults.
export interface CallvaalProfileDetail {
  id: ProfileDetailId;
  categoryId: CategoryId;
  categoryLabel: string;
  displayName: string;
  roleLabel: string;
  isSample: true;
  description: string;
  portrait: ProfilePhoto;
  gallery: ProfilePhoto[];
  languages: string[];
  ratePerMinute: number;
  experienceYears?: number;
  rating?: { average: number; count: number };
  conversationCount?: number;
  availabilityLabel?: string;
  nextAvailableLabel?: string;
  verification?: { registry: 'NMC'; status: 'illustrative' };
  personalQuote?: string;
  about: string;
  topicTags: string[];
  services: string[];
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
const sampleDisclosure = 'Sample profile · Images, profile details, reviews and prices are illustrative. No credentials have been verified.';
const previewDisclosure = 'This is an illustrative profile. Calling, booking and payments are not available.';

export const profileDetails: Record<ProfileDetailId, CallvaalProfileDetail> = {
  'dr-ananya': {
    id: 'dr-ananya', categoryId: 'doctors', categoryLabel: 'Doctors', displayName: 'Dr. Ananya', roleLabel: 'General physician', isSample: true,
    description: 'An illustrative general physician profile. Explore this sample consultation experience; calls, bookings and payments are unavailable.',
    portrait: photo('portrait-1', 'Illustrative portrait of Dr. Ananya', true),
    gallery: [photo('portrait-1', 'Illustrative portrait of Dr. Ananya in her clinic', true), photo('doctor-notes', 'Illustrative Dr. Ananya writing notes in her clinic'), photo('doctor-consultation', 'Illustrative Dr. Ananya listening during a consultation')],
    languages: ['Hindi', 'English'], ratePerMinute: 25, experienceYears: 5, rating: { average: 4.8, count: 42 }, conversationCount: 120,
    availabilityLabel: 'Online now', nextAvailableLabel: '4:30 PM', verification: { registry: 'NMC', status: 'illustrative' },
    personalQuote: 'I believe in simple, practical advice for a healthier, happier you.',
    about: 'Dr. Ananya is a general physician with over 5 years of experience in preventive and primary care. She focuses on listening carefully, explaining things in simple language, and helping you make informed choices about your health.',
    topicTags: ['Preventive care', 'Lifestyle & nutrition', 'Common illnesses', 'Health guidance'],
    services: ['General health consultations', 'Lifestyle & diet guidance', 'Fever, cold, cough and common illnesses', 'Second opinion on diagnosis', 'Medication guidance (non-prescription advice)', 'Health check-up planning'],
    reviews: [
      { name: 'Riya S.', date: '12 Feb 2024', iso: '2024-02-12', initials: 'RS', rating: 5, text: 'Very patient and explains things so well. Felt comfortable and got helpful advice.' },
      { name: 'Amit K.', date: '3 Feb 2024', iso: '2024-02-03', initials: 'AK', rating: 5, text: 'Listened carefully and gave practical suggestions. Highly recommend!' },
    ],
    preparationTips: [
      { icon: 'notes', title: 'Keep your questions ready', text: 'Jot down your symptoms or concerns to make the most of your call.' },
      { icon: 'pill', title: 'Have relevant reports handy', text: 'Lab reports or previous prescriptions can be useful.' },
      { icon: 'user', title: 'Find a quiet place', text: 'For a better and more private conversation.' },
    ],
    benefits: [
      { icon: 'lock', title: 'Private number', text: 'Your number stays private' },
      { icon: 'shield', title: 'Verified professional', text: 'NMC verified · sample badge' },
      { icon: 'shield', title: 'Safe & respectful space', text: 'Real people, real conversations' },
    ],
    sampleDisclosure: 'Sample profile · Availability, qualifications, NMC badge, reviews and prices are illustrative. No registry check has been completed.',
    previewDisclosure: `${previewDisclosure} No qualifications or NMC registry checks have been verified.`,
    yellowNote: ['People', 'Healthier', 'Happier', 'Brighter'], pinkNote: ['Apni health.', 'Apne terms. ♡'],
  },
  sana: {
    id: 'sana', categoryId: 'counsellor', categoryLabel: 'Counsellor', displayName: 'Sana', roleLabel: 'Counsellor', isSample: true,
    description: 'Explore Sana’s illustrative counselling profile. Calls, bookings and payments are unavailable; credentials have not been verified.',
    portrait: photo('portrait-5', 'Illustrative portrait of Sana', true),
    gallery: [photo('portrait-5', 'Illustrative portrait of Sana', true), photo('sana-notes', 'Illustrative Sana reflecting on notes'), photo('sana-conversation', 'Illustrative Sana in a thoughtful conversation')],
    languages: ['Hindi', 'English'], ratePerMinute: 15, reviewLabel: 'Sample review',
    personalQuote: 'You can take your time. We can start with what feels most important today.',
    about: 'Sana offers a thoughtful space to talk about everyday stress, emotions and changes in life. Her approach centres on listening, reflection and helping you put your concerns into words, at a pace you choose.',
    topicTags: ['Everyday stress', 'Emotional wellbeing', 'Life changes', 'Communication'],
    services: ['Talk through everyday stress', 'Explore feelings and recurring concerns', 'Reflect on changes in work or family life', 'Practise expressing needs and boundaries', 'Prepare questions for a counselling appointment', 'Discuss what you would like from support'],
    reviews: [
      { name: 'Riya S.', initials: 'RS', text: 'I had room to pause and put my thoughts into words.' },
      { name: 'Amit K.', initials: 'AK', text: 'The conversation felt thoughtful and unhurried.' },
    ],
    preparationTips: [
      { icon: 'notes', title: 'Start where you are', text: 'Note a concern or feeling you would like to talk about.' },
      { icon: 'chat', title: 'Set your boundaries', text: 'You can pause or say when a topic feels uncomfortable.' },
      { icon: 'user', title: 'Choose a private place', text: 'Choose somewhere you feel comfortable speaking.' },
    ],
    benefits: [
      { icon: 'chat', title: 'Your pace', text: 'Take time to put things into words' },
      { icon: 'shield', title: 'Clear boundaries', text: 'Choose what you want to share' },
      { icon: 'shield', title: 'Credentials matter', text: 'No credentials verified in this sample' },
    ],
    sampleDisclosure,
    serviceDisclosure: 'Illustrative counselling profile. No credentials or clinical services have been verified. Not emergency or crisis care.',
    previewDisclosure,
    yellowNote: ['Take your', 'time.', 'Start', 'anywhere.'], pinkNote: ['Your pace.', 'Your space. ♡'],
  },
  neha: {
    id: 'neha', categoryId: 'listener', categoryLabel: 'Listener', displayName: 'Neha', roleLabel: 'Listener', isSample: true,
    description: 'Explore Neha’s illustrative listener profile for non-clinical conversation. Calls, bookings and payments are unavailable.',
    portrait: photo('portrait-7', 'Illustrative portrait of Neha', true),
    gallery: [photo('portrait-7', 'Illustrative portrait of Neha', true), photo('neha-tea', 'Illustrative Neha taking time for tea'), photo('neha-conversation', 'Illustrative Neha listening during a friendly conversation')],
    languages: ['Hindi', 'Marathi'], ratePerMinute: 10, reviewLabel: 'Sample review',
    personalQuote: 'You don’t need a perfect way to explain it. I’m here to listen.',
    about: 'Neha offers friendly, non-clinical conversation when you want to talk things through or simply be heard. Bring an everyday worry, a difficult day or a story you have been keeping to yourself. You can ask for listening without advice.',
    topicTags: ['Feeling lonely', 'Heartbreak', 'Family pressure', 'Everyday venting'],
    services: ['Talk about a difficult day', 'Share feelings after a breakup', 'Have a friendly conversation', 'Talk through family pressure', 'Share memories of someone you miss', 'Ask for listening without advice'],
    reviews: [
      { name: 'Riya S.', initials: 'RS', text: 'It felt good to tell my story without being rushed.' },
      { name: 'Amit K.', initials: 'AK', text: 'A friendly conversation with space for what I wanted to share.' },
    ],
    preparationTips: [
      { icon: 'notes', title: 'Say what you need', text: 'Ask for listening without advice if that feels right.' },
      { icon: 'chat', title: 'Share at your comfort level', text: 'You choose what to share, and can pause at any time.' },
      { icon: 'user', title: 'Make a little space', text: 'Choose somewhere you feel comfortable speaking.' },
    ],
    benefits: [
      { icon: 'chat', title: 'Listening first', text: 'A little room to be heard' },
      { icon: 'shield', title: 'Non-clinical support', text: 'Friendly conversation, not therapy' },
      { icon: 'shield', title: 'Your boundaries', text: 'Share only what feels comfortable' },
    ],
    sampleDisclosure,
    serviceDisclosure: 'Listening and companionship only. Not therapy, medical advice or crisis support.',
    previewDisclosure,
    yellowNote: ['A little', 'space to', 'be heard.'], pinkNote: ['Your story.', 'Your pace. ♡'],
  },
  kavya: {
    id: 'kavya', categoryId: 'astrology', categoryLabel: 'Astrology', displayName: 'Kavya', roleLabel: 'Astrology', isSample: true,
    description: 'Explore Kavya’s illustrative astrology profile for reflection and entertainment. Calls, bookings and payments are unavailable.',
    portrait: photo('portrait-6', 'Illustrative portrait of Kavya', true),
    gallery: [photo('portrait-6', 'Illustrative portrait of Kavya', true), photo('kavya-chart', 'Illustrative Kavya exploring an astrology chart'), photo('kavya-tarot', 'Illustrative Kavya reflecting on tarot cards')],
    languages: ['Hindi', 'Kannada'], ratePerMinute: 15, reviewLabel: 'Sample review',
    personalQuote: 'A reading can open a conversation. Your choices remain your own.',
    about: 'Kavya offers conversations about astrology and symbolic traditions for personal reflection. Explore questions, discuss an interpretation and take away what feels meaningful to you. Readings describe perspectives, not certainties.',
    topicTags: ['Kundli', 'Numerology', 'Tarot', 'Horoscope'],
    services: ['Explore kundli interpretations', 'Discuss horoscope themes', 'Try a tarot reflection', 'Explore numerology traditions', 'Discuss Vastu concepts', 'Reflect on questions and possible choices'],
    reviews: [
      { name: 'Riya S.', initials: 'RS', text: 'An interesting conversation about different interpretations.' },
      { name: 'Amit K.', initials: 'AK', text: 'I enjoyed reflecting on my questions at my own pace.' },
    ],
    preparationTips: [
      { icon: 'notes', title: 'Bring one question', text: 'Think of a theme you would like to reflect on.' },
      { icon: 'chat', title: 'Choose a reading style', text: 'Consider the tradition or reading you want to explore.' },
      { icon: 'user', title: 'Share details carefully', text: 'Share only what you are comfortable discussing. This preview collects no birth details.' },
    ],
    benefits: [
      { icon: 'chat', title: 'Your choice', text: 'Take away what feels meaningful' },
      { icon: 'shield', title: 'No promised outcomes', text: 'Readings are not guarantees' },
      { icon: 'shield', title: 'Clear scope', text: 'Reflection and entertainment only' },
    ],
    sampleDisclosure,
    serviceDisclosure: 'For reflection and entertainment. No guaranteed predictions or outcomes; not medical, legal or financial advice.',
    previewDisclosure,
    yellowNote: ['Reflect.', 'Explore.', 'Choose.'], pinkNote: ['Your choices.', 'Always yours. ♡'],
  },
  priya: {
    id: 'priya', categoryId: 'practice', categoryLabel: 'Practice', displayName: 'Priya', roleLabel: 'English & interview practice', isSample: true,
    description: 'Explore Priya’s illustrative English and interview practice profile. Calls, bookings and payments are unavailable.',
    portrait: photo('portrait-9', 'Illustrative portrait of Priya', true),
    gallery: [photo('portrait-9', 'Illustrative portrait of Priya', true), photo('priya-practice', 'Illustrative Priya practising spoken English'), photo('priya-interview', 'Illustrative Priya preparing an interview conversation')],
    languages: ['Hindi', 'English'], ratePerMinute: 15, reviewLabel: 'Sample review',
    personalQuote: 'Let’s practise one conversation at a time, with room to pause and try again.',
    about: 'Priya helps you practise spoken English and interview conversations in a supportive setting. Choose an everyday situation or job interview, try your answers aloud and ask for specific feedback. Sessions can be paced around your comfort and goals.',
    topicTags: ['Spoken English', 'Mock interviews', 'Introductions', 'Workplace conversations'],
    services: ['Practise everyday English conversation', 'Rehearse a self-introduction', 'Try a mock job interview', 'Practise common interview questions', 'Role-play workplace conversations', 'Get feedback on clarity and delivery'],
    reviews: [
      { name: 'Riya S.', initials: 'RS', text: 'There was room to pause and try my introduction again.' },
      { name: 'Amit K.', initials: 'AK', text: 'The feedback gave me specific points to keep practising.' },
    ],
    preparationTips: [
      { icon: 'notes', title: 'Choose your goal', text: 'Pick a conversation or interview skill you want to practise.' },
      { icon: 'chat', title: 'Bring a short prompt', text: 'Have a situation or interview question ready to rehearse aloud.' },
      { icon: 'user', title: 'Say how you prefer feedback', text: 'Ask for feedback during your answer or after you finish.' },
    ],
    benefits: [
      { icon: 'chat', title: 'Practice at your pace', text: 'Pause and try again when you need' },
      { icon: 'shield', title: 'Specific feedback', text: 'Focus on clarity and delivery' },
      { icon: 'shield', title: 'Supportive conversation', text: 'Room to rehearse and ask questions' },
    ],
    sampleDisclosure,
    serviceDisclosure: 'Practice and feedback only. No job, interview, exam or fluency outcomes are guaranteed.',
    previewDisclosure,
    yellowNote: ['Pause.', 'Practise.', 'Try again.'], pinkNote: ['One conversation', 'at a time. ♡'],
  },
};
