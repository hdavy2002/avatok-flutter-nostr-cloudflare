// [AUMFE-CONSULT-F1-1 2026-10-02] Category content for the consultant pages — copied verbatim from the approved mockup
// (Specs/consultants-mockup/Guide*.dc.html and Guide*M.dc.html). ONE typed module so copy edits never touch components.
//
// NOTE FOR AI:
//  - Tokens: {ji} -> "<First name> ji", {first} -> "<First name>". Replace with fill() — never hardcode a consultant's name here.
//  - `m` on a prep item = the shorter mobile wording from the Guide*M mockups; `m: null` = hidden on mobile.
//  - Brand name/domain are never typed here (BRAND only).
//  - Palette comes from the cat-* class in styles/consultants.css; the per-category hero text colours are the three
//    hero* values below (set as CSS variables on the hero).
import type { Discipline } from '../../lib/consultTypes';

export type CatKey = 'astro' | 'numero' | 'palm' | 'face' | 'tarot';

export const CAT_OF: Record<Discipline, CatKey> = {
  astrology: 'astro',
  numerology: 'numero',
  palmistry: 'palm',
  face_reading: 'face',
  tarot: 'tarot',
};

export interface PrepItem { ic: string; h: string; p: string; m?: { h: string; p: string } | null }
export interface AskTile { deva: string; en: string; m?: string }
export interface PhotoTile { label: string; note: string; bad?: boolean }
export interface Qa { q: string; a: string }
export interface Step { n: string; h: string; hint: string }

export interface CategoryContent {
  key: CatKey;
  /** Class that sets the palette (.cat-astro …). */
  cls: string;
  deva: string;
  label: string;
  /** Hex used for accents that the mockup colours inline (price, headings): --deep, --c2 equivalents. */
  deep: string;
  accent: string;
  heroBlurb: string;
  heroMeta: string;
  heroSub: string;
  fallbackBlurb: string;
  fallbackSub: string;
  bookLabel: string;
  cardHint: string;
  readyDeva: string;
  readyTitle: string;
  readyTitleM?: string;
  readyBlurb: string;
  readyBlurbM: string;
  previewKind: CatKey;
  prep: PrepItem[];
  ask: AskTile[];
  keepKind: 'list' | 'photo';
  keepTitle: string;
  keepTitleM: string;
  photoTiles: PhotoTile[];
  keepList: string[];
  keepListM: string[];
  keepNote: string | null;
  keepNoteM: string | null;
  stepsTitle: string;
  stepsTitleM: string;
  steps: Step[];
  faq: Qa[];
  faqM: Qa[];
  promise: { deva: string; h: string; p: string; pM: string };
}

export const MONTH_DEVA = [
  'पौष · माघ', 'माघ · फाल्गुन', 'फाल्गुन · चैत्र', 'चैत्र · वैशाख', 'वैशाख · ज्येष्ठ', 'ज्येष्ठ · आषाढ़',
  'आषाढ़ · श्रावण', 'श्रावण · भाद्रपद', 'भाद्रपद · आश्विन', 'आश्विन · कार्तिक', 'कार्तिक · मार्गशीर्ष', 'मार्गशीर्ष · पौष',
];

export const REMINDER_LINE = 'Reminders reach you on WhatsApp and email a day before and 15 minutes before.';

const STEP_N = ['१', '२', '३', '४'];
const steps = (rows: [string, string][]): Step[] => rows.map(([h, hint], i) => ({ n: STEP_N[i], h, hint }));

export const CATEGORY: Record<CatKey, CategoryContent> = {
  astro: {
    key: 'astro', cls: 'cat-astro', deva: 'ज्योतिष', label: 'Vedic astrology', deep: '#1f2a5c', accent: '#e8892b',
    heroBlurb: '#e6e9f7', heroMeta: '#f2c14e', heroSub: '#c9cfe8',
    fallbackBlurb: 'Plain answers on career, marriage timing and your dasha — and only the remedies the shastras prescribe.',
    fallbackSub: '',
    bookLabel: 'Book a consultation',
    cardHint: 'Your kundli is drawn and checked before the call. No camera needed.',
    readyDeva: 'आपकी कुंडली पहले से तैयार', readyTitle: 'Ready before your call',
    readyBlurb: 'As soon as you book, we draw your chart from your birth details. {ji} studies it before you speak, so the whole half-hour is about you.',
    readyBlurbM: 'Your chart is drawn the moment you book. {ji} studies it before you speak.',
    previewKind: 'astro',
    prep: [
      { ic: 'ज', h: 'Janam kundli', p: 'Lagna chart and Navamsa (D9), drawn North-Indian style.', m: { h: 'Janam kundli', p: 'Lagna chart and Navamsa (D9).' } },
      { ic: 'द', h: 'Vimshottari dasha', p: 'The Mahadasha and Antardasha you are running, with dates.', m: { h: 'Vimshottari dasha', p: 'Your running Mahadasha and Antardasha, with dates.' } },
      { ic: 'दो', h: 'Dosha check', p: 'Manglik, Kaal Sarp, Sade Sati and Pitra — present or not.', m: { h: 'Dosha check', p: 'Manglik, Kaal Sarp, Sade Sati, Pitra.' } },
      { ic: 'पं', h: 'Panchang at birth', p: 'Tithi, nakshatra, yoga and karana of the day you were born.', m: { h: 'Panchang at birth', p: 'Tithi, nakshatra, yoga and karana.' } },
      { ic: 'गु', h: 'Gun milan', p: "The 36-gun match, if you add your partner's birth details.", m: { h: 'Gun milan', p: '36-gun match, if you add your partner.' } },
      { ic: 'उ', h: 'Upay, checked', p: 'Mantra, daan and puja suggestions — {ji} checks each before it is said.', m: null },
    ],
    ask: [
      { deva: 'कार्य', en: 'Career and business', m: 'Career' },
      { deva: 'विवाह', en: 'Marriage timing' },
      { deva: 'स्वास्थ्य', en: 'Health' },
      { deva: 'संतान', en: 'Children' },
      { deva: 'भूमि · यात्रा', en: 'Property and travel', m: 'Property, travel' },
      { deva: 'मुहूर्त', en: 'Auspicious dates' },
    ],
    keepKind: 'list', keepTitle: 'Keep these ready', keepTitleM: 'Keep these ready', photoTiles: [],
    keepList: [
      'Exact birth time — from your janam patri or hospital record',
      'Place of birth — town or village is enough',
      'Your gotra (optional)',
      "Your partner's birth details, for gun milan",
      'Up to three questions',
    ],
    keepListM: ['Exact birth time — janam patri or hospital record', 'Place of birth', 'Gotra (optional)', "Partner's details for gun milan"],
    keepNote: "<strong>Don't know your birth time?</strong> Book anyway. Tick \"I don't know\" and {ji} will read from your Chandra kundli.",
    keepNoteM: '<strong>No birth time?</strong> Book anyway — {ji} reads your Chandra kundli.',
    stepsTitle: 'How your consultation works', stepsTitleM: 'How it works',
    steps: steps([['Pick a time', "from {first}'s calendar"], ['Add birth details', 'saved for next time'], ['We draw your kundli', 'studied first'], ['Talk for 30 min', 'private audio call']]),
    faq: [
      { q: 'Can my family join the call?', a: 'Yes. Put your phone on speaker — parents often join for marriage questions.' },
      { q: 'Which language will {ji} speak?', a: 'Choose your language when you book, from those listed on this page.' },
      { q: 'Is the call recorded?', a: "No. Only your kundli and {ji}'s notes are kept, so your next consultation starts where this one ended." },
      { q: "What if {ji} can't join?", a: 'You are told straight away, and we sort it out with you — a refund, or another time. Refunds are made by hand, not automatically.' },
    ],
    faqM: [
      { q: 'Can my family join?', a: 'Yes — put the phone on speaker.' },
      { q: 'Is the call recorded?', a: "No. Only your kundli and {ji}'s notes are kept." },
      { q: "What if {ji} can't join?", a: 'We sort it out with you — a refund, or another time.' },
    ],
    promise: {
      deva: 'शास्त्र सम्मत', h: 'By the book, never by fear',
      p: 'No scare talk and no gemstone selling on the call. Remedies are only those the shastras prescribe — mantra, daan, vrat or a puja. If a puja is advised, you can book it here, or at your own temple.',
      pM: 'No scare talk, no gemstone selling. Remedies only as the shastras prescribe.',
    },
  },
  numero: {
    key: 'numero', cls: 'cat-numero', deva: 'अंक शास्त्र', label: 'Numerology', deep: '#6e1a26', accent: '#d28a12',
    heroBlurb: '#f7e3e6', heroMeta: '#f2c14e', heroSub: '#f0c9cf',
    fallbackBlurb: 'Your name, your birth date and the numbers you live with every day — mobile, house, business. Read together, to tell you which ones work for you.',
    fallbackSub: '',
    bookLabel: 'Book a consultation',
    cardHint: 'Your numbers are worked out before the call. No camera needed.',
    readyDeva: 'आपके अंक पहले से तैयार', readyTitle: 'Ready before your call',
    readyBlurb: 'From your name and date of birth we work out every number below. {ji} checks them before you speak.',
    readyBlurbM: 'Your numbers are worked out the moment you book. {ji} checks them first.',
    previewKind: 'numero',
    prep: [
      { ic: 'मू', h: 'Moolank and Bhagyank', p: 'Your root number and destiny number, from your date of birth.', m: { h: 'Moolank and Bhagyank', p: 'Root and destiny numbers.' } },
      { ic: 'ना', h: 'Naamank', p: 'Your name number, Chaldean method, for the name you actually use.', m: { h: 'Naamank', p: 'Name number, Chaldean method.' } },
      { ic: 'लो', h: 'Lo Shu grid', p: 'Which numbers are strong, repeated or missing in your chart.', m: null },
      { ic: 'मो', h: 'Mobile number', p: 'The total of your mobile number, and whether it suits you.', m: { h: 'Mobile number', p: 'Its total, and whether it suits you.' } },
      { ic: 'शु', h: 'Shubh table', p: 'Lucky days, colours, numbers and the deity for your number.', m: { h: 'Shubh table', p: 'Lucky days, colours and deity.' } },
      { ic: 'व्य', h: 'Business name', p: 'Totals for the shop, firm or brand names you are considering.', m: { h: 'Business name', p: 'Totals for names you are considering.' } },
    ],
    ask: [
      { deva: 'नाम', en: 'Name spelling' },
      { deva: 'व्यापार', en: 'Business or brand name' },
      { deva: 'मोबाइल', en: 'Mobile number' },
      { deva: 'तिथि', en: 'Dates for big steps' },
      { deva: 'गृह', en: 'House or flat number' },
      { deva: 'मेल', en: 'Compatibility' },
    ],
    keepKind: 'list', keepTitle: 'Keep these ready', keepTitleM: 'Keep these ready', photoTiles: [],
    keepList: [
      'Your full name exactly as it is spelt on your documents',
      'The name you use day to day, if different',
      'Date of birth',
      'Your mobile number, and any you are thinking of switching to',
      "Business or child's names you want checked",
    ],
    keepListM: ['Full name as on your documents', 'The name you use day to day', 'Date of birth', 'Mobile number(s) to check'],
    keepNote: '<strong>Time of birth is not needed</strong> for numerology — only your name and date.',
    keepNoteM: '<strong>No birth time needed</strong> — only your name and date.',
    stepsTitle: 'How your consultation works', stepsTitleM: 'How it works',
    steps: steps([['Pick a time', "from {first}'s calendar"], ['Add names and date', 'two minutes'], ['We work out your numbers', 'checked first'], ['Talk for 30 min', 'private audio call']]),
    faq: [
      { q: 'Will {ji} ask me to change my name?', a: '{ji} may suggest a spelling. Whether you change it is your choice — nothing else is sold.' },
      { q: "Can {ji} check my child's name?", a: "Yes. Add your child's name and date of birth when you book." },
      { q: 'Do I need my birth time?', a: 'No. Numerology uses only your name and date of birth.' },
      { q: 'Is the call recorded?', a: 'No. Your numbers and the notes are kept for your next consultation.' },
    ],
    faqM: [
      { q: 'Will {ji} ask me to change my name?', a: 'A spelling may be suggested. The choice is yours.' },
      { q: "Can {ji} check my child's name?", a: 'Yes — add it when you book.' },
      { q: 'Do I need my birth time?', a: 'No. Only your name and date of birth.' },
    ],
    promise: {
      deva: 'आपका निर्णय', h: 'Your numbers, your decision',
      p: 'No forced name changes and no "lucky" products on the call. You get your numbers, what they mean, and clear options — then you choose.',
      pM: 'No forced name changes, no "lucky" products. You get your numbers, then you choose.',
    },
  },
  palm: {
    key: 'palm', cls: 'cat-palm', deva: 'हस्तरेखा', label: 'Palmistry', deep: '#5a2a12', accent: '#b0561c',
    heroBlurb: '#f6e7d6', heroMeta: '#f6dcb5', heroSub: '#e8cfb4',
    fallbackBlurb: 'Samudrika Shastra. The photo of your palm is studied before you call — every line, mount and finger — then talked through with you.',
    fallbackSub: 'Also reads faces — see the face-reading page',
    bookLabel: 'Book a consultation',
    cardHint: 'You take two palm photos while booking. The call itself is audio only.',
    readyDeva: 'आपकी हथेली पहले से पढ़ी हुई', readyTitle: 'Read before your call',
    readyBlurb: 'Your palm photo is mapped the moment you book. {ji} checks every line on your own photo, so the call starts with answers, not set-up.',
    readyBlurbM: 'Your palm photo is mapped the moment you book. {ji} checks every line first.',
    previewKind: 'palm',
    prep: [
      { ic: 'त', h: 'Hand type (tattva)', p: 'Prithvi, jal, agni or vayu — from palm shape and finger length.', m: { h: 'Hand type (tattva)', p: 'Prithvi, jal, agni or vayu.' } },
      { ic: 'ह्र', h: 'Hriday rekha', p: 'Heart line: emotions, love and how you give it.', m: { h: 'The four main lines', p: 'Heart, head, life and fate, on your photo.' } },
      { ic: 'म', h: 'Mastishk rekha', p: 'Head line: how you think, decide and learn.', m: null },
      { ic: 'जी', h: 'Jeevan rekha', p: 'Life line: energy, health and big turns in life.', m: null },
      { ic: 'भा', h: 'Bhagya rekha', p: 'Fate line: work, career and where effort pays.', m: null },
      { ic: 'प', h: 'Parvat — the mounts', p: 'Guru, Shani, Surya, Budh, Shukra, Chandra and Mangal.', m: { h: 'Parvat — mounts', p: 'Guru, Shani, Surya, Budh, Shukra, Chandra, Mangal.' } },
    ],
    ask: [
      { deva: 'कार्य', en: 'Career' }, { deva: 'धन', en: 'Money' }, { deva: 'प्रेम', en: 'Love' },
      { deva: 'विवाह', en: 'Marriage' }, { deva: 'स्वास्थ्य', en: 'Health' }, { deva: 'भाग्य', en: 'Luck and timing' },
    ],
    keepKind: 'photo', keepTitle: 'Taking a good palm photo', keepTitleM: 'Taking a good palm photo',
    photoTiles: [
      { label: '✓ Daylight', note: 'Near a window, no flash' },
      { label: '✓ Fingers apart', note: 'Whole palm and wrist in frame' },
      { label: '✗ Fresh mehndi', note: 'Henna hides the fine lines', bad: true },
    ],
    keepList: [
      'Your dominant hand first, then the other one',
      'Take off rings and bangles that cover the wrist',
      'The camera turns on the button only when the photo is sharp',
    ],
    keepListM: ['Dominant hand first, then the other', 'Take off rings and bangles', 'The button turns on when the photo is sharp'],
    keepNote: null, keepNoteM: null,
    stepsTitle: 'How your consultation works', stepsTitleM: 'How it works',
    steps: steps([['Pick a time', "from {first}'s calendar"], ['Photograph both palms', 'we guide the camera'], ['Lines are mapped', 'checked line by line'], ['Talk for 30 min', 'private audio call']]),
    faq: [
      { q: 'Left hand or right hand?', a: 'Both. Your dominant hand shows what you are making of life; the other shows what you were born with.' },
      { q: 'Who sees my palm photo?', a: 'Only {ji}. It is stored privately and never shown on the site.' },
      { q: 'My photo was rejected — why?', a: 'Usually low light, blur or mehndi. The camera tells you what to fix before you pay.' },
      { q: 'Is the call recorded?', a: 'No. Your palm map and the notes are kept for your next consultation.' },
    ],
    faqM: [
      { q: 'Left hand or right hand?', a: 'Both — what you make of life, and what you were born with.' },
      { q: 'Who sees my palm photo?', a: 'Only {ji}. Stored privately.' },
      { q: 'My photo was rejected — why?', a: 'Light, blur or mehndi. The camera tells you before you pay.' },
    ],
    promise: {
      deva: 'कर्म प्रधान', h: 'Your hand shows a path, not a sentence',
      p: 'Lines change with the life you live. {ji} tells you what your hand shows today and what you can work on — never frightening predictions.',
      pM: 'Lines change with the life you live. What your hand shows today — never frightening predictions.',
    },
  },
  face: {
    key: 'face', cls: 'cat-face', deva: 'मुख सामुद्रिक', label: 'Face reading', deep: '#7d1820', accent: '#c8611f',
    heroBlurb: '#fbe3e0', heroMeta: '#f6dcb5', heroSub: '#f0c7c3',
    fallbackBlurb: 'Mukh Samudrika — the old Indian reading of the face. From one clear photo, your forehead, eyes, nose and chin are read for what they say about your nature and the years ahead.',
    fallbackSub: 'Same guide as palmistry — book either, or both together',
    bookLabel: 'Book a consultation',
    cardHint: 'You take one face photo while booking. The call itself is audio only.',
    readyDeva: 'आपका मुख पहले से पढ़ा हुआ', readyTitle: 'Read before your call',
    readyBlurb: 'Your photo is mapped as soon as you book — shape, proportions and features. {ji} goes through it before you speak.',
    readyBlurbM: 'Your photo is mapped the moment you book. {ji} goes through it first.',
    previewKind: 'face',
    prep: [
      { ic: 'आ', h: 'Mukh aakriti', p: 'Face shape and the balance of the three zones.', m: { h: 'Mukh aakriti', p: 'Face shape and the three zones.' } },
      { ic: 'ल', h: 'Lalaat — forehead', p: 'Height, width and lines: thinking and early years.', m: null },
      { ic: 'ने', h: 'Netra — eyes', p: 'Shape, set and spacing: feeling and trust.', m: { h: 'Netra and nasika', p: 'Eyes and nose: feeling and drive.' } },
      { ic: 'ना', h: 'Nasika — nose', p: 'Bridge and tip: drive, wealth and middle years.', m: null },
      { ic: 'ओ', h: 'Oshth and chibuk', p: 'Lips and chin: speech, steadiness and later life.', m: { h: 'Oshth and chibuk', p: 'Lips and chin: speech and steadiness.' } },
      { ic: 'सं', h: 'Santulan — symmetry', p: 'How the two sides of your face match.', m: { h: 'Santulan', p: 'How the two sides of your face match.' } },
    ],
    ask: [
      { deva: 'स्वभाव', en: 'Your nature' }, { deva: 'कार्य', en: 'Career' }, { deva: 'धन', en: 'Wealth' },
      { deva: 'विवाह', en: 'Marriage' }, { deva: 'परिवार', en: 'Family' }, { deva: 'चुनौती', en: 'Challenges' },
    ],
    keepKind: 'photo', keepTitle: 'Taking a good face photo', keepTitleM: 'Taking a good face photo',
    photoTiles: [
      { label: '✓ Look straight', note: 'Neutral face, eyes open' },
      { label: '✓ Forehead clear', note: 'Hair back; bindi or tilak is fine' },
      { label: '✗ Filters', note: 'No beauty mode, no glasses', bad: true },
    ],
    keepList: [
      'One person in the frame, in daylight',
      'A side photo helps, but is optional',
      'Edited or AI-made photos are refused by the reader',
    ],
    keepListM: ['One person, in daylight', 'A side photo helps (optional)', 'Edited photos are refused'],
    keepNote: null, keepNoteM: null,
    stepsTitle: 'How your consultation works', stepsTitleM: 'How it works',
    steps: steps([['Pick a time', "from {first}'s calendar"], ['Take one photo', 'we guide the camera'], ['Face is mapped', 'the map is checked'], ['Talk for 30 min', 'private audio call']]),
    faq: [
      { q: 'Who sees my face photo?', a: 'Only {ji}. It is stored privately, never shown on the site, and you can ask us to delete it after your call.' },
      { q: 'Can I book palmistry and face reading together?', a: 'Yes — choose both while booking and take both photos; the session becomes 45 minutes.' },
      { q: 'Why was my photo refused?', a: 'Beauty filters, glasses, two faces or an edited picture. The camera tells you what to change.' },
      { q: 'Is the call recorded?', a: 'No. Your face map and the notes are kept for your next consultation.' },
    ],
    faqM: [
      { q: 'Who sees my face photo?', a: 'Only {ji}. Stored privately; delete it on request.' },
      { q: 'Palmistry and face reading together?', a: 'Yes — choose both while booking; 45 minutes.' },
      { q: 'Why was my photo refused?', a: 'Filters, glasses, two faces or an edit.' },
    ],
    promise: {
      deva: 'गुण, दोष नहीं', h: 'About your nature, never your looks',
      p: 'Face reading is about character and tendencies, not beauty. Nothing about your appearance is judged or stored beyond your consultation.',
      pM: 'Character and tendencies, not beauty. Nothing about your looks is judged.',
    },
  },
  tarot: {
    key: 'tarot', cls: 'cat-tarot', deva: 'पत्ते', label: 'Tarot', deep: '#16305e', accent: '#2f6db5',
    heroBlurb: '#e3e9f7', heroMeta: '#f2c14e', heroSub: '#cdd6f0',
    fallbackBlurb: 'You draw your own three cards while booking — love, work and money. The spread is read before your call, to help you think through the choice in front of you.',
    fallbackSub: '',
    bookLabel: 'Book a reading',
    cardHint: 'You shuffle and draw while booking. No birth time needed.',
    readyDeva: 'आपके पत्ते पहले से खुले', readyTitle: 'Your spread, ready before the call', readyTitleM: 'Your spread, ready',
    readyBlurb: 'The cards you draw are saved with your booking. {first} studies the spread and your questions first; during the call more cards can be drawn and shown on your screen.',
    readyBlurbM: 'The cards you draw are saved with your booking and read before the call.',
    previewKind: 'tarot',
    prep: [
      { ic: '३', h: 'Three-card spread', p: 'Love, work and money — drawn by you.' },
      { ic: 'हाँ', h: 'Yes-or-no card', p: 'One card for each yes-or-no question you add.', m: { h: 'Yes-or-no card', p: 'One for each yes-or-no question.' } },
      { ic: 'उ', h: 'Upright or reversed', p: "Each card's meaning, both ways, ready for the reading.", m: null },
      { ic: 'प्र', h: 'Your questions', p: 'Up to three, so cards can be matched to what you asked.', m: { h: 'Your questions', p: 'Up to three, matched to your cards.' } },
    ],
    ask: [
      { deva: 'निर्णय', en: 'A decision' }, { deva: 'प्रेम', en: 'Relationships' }, { deva: 'कार्य', en: 'Work crossroads' },
      { deva: 'स्थान', en: 'A move or new city' }, { deva: 'परिवार', en: 'Family' }, { deva: 'मन', en: 'Peace of mind' },
    ],
    keepKind: 'list', keepTitle: 'Before you draw', keepTitleM: 'Before you draw', photoTiles: [],
    keepList: [
      'Sit somewhere quiet and think of your question',
      'Write it simply — "Should I take the Hyderabad job?"',
      'Shuffle as long as feels right, then pick three cards',
      'Add a yes-or-no question if you have one',
    ],
    keepListM: ['Sit somewhere quiet', 'Write your question simply', 'Shuffle, then pick three'],
    keepNote: '<strong>No birth details needed.</strong> Just your name and your question.',
    keepNoteM: '<strong>No birth details needed.</strong> Just your name and question.',
    stepsTitle: 'How your reading works', stepsTitleM: 'How it works',
    steps: steps([['Pick a time', "from {first}'s calendar"], ['Shuffle and draw', 'three cards'], ['The spread is read', 'before the call'], ['Talk for 30 min', 'cards appear on screen']]),
    faq: [
      { q: 'Do I really pick the cards myself?', a: 'Yes. You shuffle and choose on your phone while booking; those exact cards are what {first} reads.' },
      { q: 'Can more cards be drawn in the call?', a: 'Yes. Any card drawn appears on your call screen as it is turned.' },
      { q: 'Will tarot tell me the future?', a: "Tarot helps you see your situation clearly. {first} won't make predictions about death, illness or exams." },
      { q: 'Is the call recorded?', a: 'No. Your spread and the notes are kept for your next reading.' },
    ],
    faqM: [
      { q: 'Do I really pick the cards myself?', a: 'Yes — on your phone, while booking.' },
      { q: 'Can more cards be drawn in the call?', a: 'Yes — they appear on your call screen.' },
      { q: 'Will tarot tell me the future?', a: "It helps you see your situation clearly. No predictions about death, illness or exams." },
    ],
    promise: {
      deva: 'मार्गदर्शन, भविष्यवाणी नहीं', h: 'Guidance, not fortune-telling',
      p: 'The cards are a way to look at your question from new sides. The choice — and the effort — stay yours.',
      pM: 'The cards are a way to look at your question from new sides. The choice stays yours.',
    },
  },
};

/** Replace {ji} / {first} with the consultant's first name. */
export function fill(text: string, fullName: string): string {
  const first = (fullName || '').trim().split(/\s+/)[0] || 'Your guide';
  return text.replace(/\{ji\}/g, `${first} ji`).replace(/\{first\}/g, first);
}

export const OTHER_LABEL: Record<Discipline, string> = {
  astrology: 'Astrology · ज्योतिष',
  numerology: 'Numerology · अंक शास्त्र',
  palmistry: 'Palmistry · हस्तरेखा',
  face_reading: 'Face reading · मुख सामुद्रिक',
  tarot: 'Tarot',
};
export const OTHER_SHORT: Record<Discipline, string> = {
  astrology: 'Astrology', numerology: 'Numerology', palmistry: 'Palmistry', face_reading: 'Face reading', tarot: 'Tarot',
};

export function catOf(d: Discipline): CategoryContent {
  return CATEGORY[CAT_OF[d]];
}
