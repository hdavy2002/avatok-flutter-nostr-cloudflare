// [WEB-TEMPLES-1 2026-09-29] Data for /temples ("Our temples").
// OWNER DECISIONS (2026-09-29):
//  - Only benign temples. Removed after research/owner input: any temple tied to
//    ghosts/spirits, cults, black magic, animal (or legendary human) sacrifice,
//    Shani, Kali, Bhairav or fierce/"demonic" forms (e.g. Bhootnath, Mahasu Devta,
//    Kalimath, Chandrabadni, Shikari Devi, Bhimakali, Pokhu Devta, Chaurasi,
//    Daat Kali, Bhairavnath, Bhairon Ghati, Karna/Kandar Devta, Veerbhadra,
//    Narayani Shila, Hatu Mata, Surkanda, Santala Devi, Narsingh, Chandrabani).
//    Do NOT re-add any of these.
//  - Photos: the owner supplies AI-made pictures later. Until a temple's photo
//    exists, set `photo: false` and the card shows a "Photo coming soon" panel.
//    To add one: save web/public/assets/saathum-temples/<slug>.jpg and set
//    `photo: true`. Never ship third-party (e.g. Wikimedia CC BY-SA) photos
//    here without their credit line — the owner chose no credit lines.
//  - Mockup: design/temples-page/saathum-temples-mock.src.html (owner-approved).

export type PhotoCredit = { by: string; license: string; url: string };
export type Temple = { slug: string; name: string; place: string; deity: string; photo?: boolean; credit?: PhotoCredit };
export type TempleRegion = { key: string; name: string; blurb: string; temples: Temple[] };

// [WEB-TEMPLES-2 2026-09-29] OWNER DECISION: show the interim Wikimedia Commons
// photos on the live page so he can see the look before his AI pictures arrive.
// No credit line on the cards (owner choice); the licences (CC BY-SA) still require
// attribution, so every one is credited in the page's "Photo credits" footnote.
// Replace a photo with the owner's own picture -> delete its PHOTO_CREDITS entry.
const PHOTO_CREDITS: Record<string, PhotoCredit> = {
  "kunjapuri-devi-temple": {
    "by": "Travel & Shit from Brighton, UK",
    "license": "CC BY-SA 2.0",
    "url": "https://commons.wikimedia.org/wiki/File:Kunjapuri_Temple,_Rishikesh,_Uttarakhand,_India_(15110748073).jpg"
  },
  "bilkeshwar-mahadev-temple": {
    "by": "User:Pandeetjee",
    "license": "CC BY-SA 3.0",
    "url": "https://commons.wikimedia.org/wiki/File:Nandi_ji_bilkeshwar_mahadev_haridwar_2014-01-20_16-56.JPG"
  },
  "daksheshwar-mahadev-temple": {
    "by": "World8115",
    "license": "CC BY-SA 3.0",
    "url": "https://commons.wikimedia.org/wiki/File:Daksheshwar_Mahadev_temple,_Kankhal3.JPG"
  },
  "kashi-vishwanath-temple": {
    "by": "ShalinishuklaV",
    "license": "CC BY-SA 4.0",
    "url": "https://commons.wikimedia.org/wiki/File:Guptkashi.jpg"
  },
  "omkareshwar-temple": {
    "by": "Ms Sarah Welch",
    "license": "CC0",
    "url": "https://commons.wikimedia.org/wiki/File:005232023_Omkareshwar_temple,_Ukhimath_Uttarakhand_053.jpg"
  },
  "bijli-mahadev-temple": {
    "by": "Akshat Sharma",
    "license": "CC BY-SA 4.0",
    "url": "https://commons.wikimedia.org/wiki/File:Bijli_Mahadev_Temple.jpg"
  },
  "prashar-rishi-temple": {
    "by": "Harvinder Chandigarh",
    "license": "CC BY-SA 4.0",
    "url": "https://commons.wikimedia.org/wiki/File:Prashar_Lake,Mandi_,Himachal_Pardesh.jpg"
  }
};

const t = (name: string, place: string, deity: string): Temple => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const credit = PHOTO_CREDITS[slug];
  return { slug, name, place, deity, photo: Boolean(credit), credit };
};

export const TEMPLE_REGIONS: TempleRegion[] = [
  { key: 'rishikesh', name: 'Rishikesh', blurb: 'On the Ganga, at the foot of the Garhwal hills.', temples: [
    t('Kunjapuri Devi Temple', 'Hilltop above Rishikesh, Narendra Nagar road', 'Devi'),
    t('Shatrughan Temple', 'Muni ki Reti, Rishikesh', 'Shatrughan'),
  ] },
  { key: 'haridwar', name: 'Haridwar', blurb: 'Where the Ganga leaves the mountains.', temples: [
    t('Bilkeshwar Mahadev Temple', 'Near Har ki Pauri, Haridwar', 'Shiva'),
    t('Daksheshwar Mahadev Temple', 'Kankhal, Haridwar', 'Shiva'),
    t('Sureshwari Devi Temple', 'Rajaji forest, Ranipur, Haridwar', 'Devi'),
    t('Neeleshwar Mahadev Temple', 'Neel Parvat, Haridwar', 'Shiva'),
  ] },
  { key: 'dehradun', name: 'Dehradun', blurb: 'Old temples in the Doon valley and its forests.', temples: [
    t('Prakasheshwar Mahadev Temple', 'Mussoorie road, Dehradun', 'Shiva'),
    t('Laxman Siddh Temple', 'Haridwar road, Dehradun', 'Siddh'),
  ] },
  { key: 'purola', name: 'Purola & Rawain', blurb: 'Old shrines of the Rawain valley.', temples: [
    t('Kamleshwar Mahadev Temple', 'Kamal Siddh, Purola', 'Shiva'),
  ] },
  { key: 'badrinath', name: 'Badrinath', blurb: 'Smaller shrines on the road to Badri Vishal.', temples: [
    t('Yogadhyan Badri', 'Pandukeshwar', 'Vishnu'),
    t('Bhavishya Badri', 'Subhain, near Joshimath', 'Vishnu'),
    t('Vridha Badri', 'Animath, near Joshimath', 'Vishnu'),
    t('Mata Murti Temple', 'Mana village', 'Devi'),
  ] },
  { key: 'kedarnath', name: 'Kedarnath', blurb: 'Temples of the Kedar valley and the winter seat of Baba Kedar.', temples: [
    t('Kashi Vishwanath Temple', 'Guptkashi', 'Shiva'),
    t('Omkareshwar Temple', 'Ukhimath', 'Shiva'),
    t('Gauri Mai Temple', 'Gaurikund', 'Parvati'),
  ] },
  { key: 'gangotri', name: 'Gangotri', blurb: 'Along the Bhagirathi, from Harsil to Mukhba.', temples: [
    t('Mukhimath Ganga Temple', 'Mukhba village', 'Ganga'),
    t('Lakshmi Narayan Temple', 'Harsil', 'Vishnu'),
  ] },
  { key: 'himachal', name: 'Himachal Pradesh', blurb: 'Wooden hill temples in Kullu and Mandi.', temples: [
    t('Bijli Mahadev Temple', 'Kullu', 'Shiva'),
    t('Prashar Rishi Temple', 'Prashar lake, Mandi', 'Rishi Prashar'),
  ] },
];

export const TEMPLE_COUNT = TEMPLE_REGIONS.reduce((n, r) => n + r.temples.length, 0);
export const TEMPLE_PHOTO_CREDITS = TEMPLE_REGIONS.flatMap((r) => r.temples).filter((tm) => tm.credit);
export const templePhotoPath = (slug: string) => `/assets/saathum-temples/${slug}.jpg`;
