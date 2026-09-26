// [OG-AD-HOOK-1 2026-09-26, owner decision] The share card is an AD.
//
// WhatsApp already prints the article title and description UNDER the image, so
// the words ON the image are one devotional line that makes a person want to
// join. These are written per ritual (by AI, reviewed against the owner's copy
// rules): warm, positive, name the deity and the blessing people traditionally
// seek — NO guaranteed outcomes, NO fear selling, NO health cures, NO prices
// (the price pill is printed separately from HAVAN_SHARE_PRICE below).
//
// Listings get the same treatment from the worker (lib/listing_ad_hook.ts writes
// attrs.ad_hook with AI when a listing is submitted or approved).
//
// Adding a ritual: add its line here. A ritual without a line still gets a card —
// the template falls back to "Join the <title> live".

/** Price printed on havan share cards. ₹111 — amounts ending in 1 are shagun. */
export const HAVAN_SHARE_PRICE = 111;

export const ritualAdHooks: Record<string, string> = {
  // Havans
  'saraswati-havan': "Seek Maa Saraswati's blessings for studies and exams",
  'gayatri-havan': 'Chant the Gayatri mantra together for a clear, calm mind',
  'hayagriva-havan': 'Invite Lord Hayagriva’s grace on every page you study',
  'dakshinamurthy-havan': 'Sit at the feet of Shiva, the first teacher, for focus',
  'brihaspati-havan': 'Seek Guru Brihaspati’s blessings for wisdom and growth',
  'ganapati-havan': 'Begin anew with Ganpati Bappa’s blessings',
  'satyanarayana-havan': 'Thank Lord Satyanarayana for every blessing at home',
  'navagraha-havan': 'Offer ahuti to all nine grahas for a smoother path',
  'vastu-shanti-havan': 'Fill your home with peace and positive energy',
  'griha-pravesh-havan': 'Welcome Maa Lakshmi into your new home',
  'lakshmi-havan': 'Invite Maa Lakshmi’s ashirwad into your home',
  'kubera-havan': 'Seek Lord Kubera’s blessings to grow and guard your savings',
  'sri-suktam-havan': 'Offer the ancient Sri Suktam to Maa Lakshmi together',
  'dhanvantari-lakshmi-havan': 'Seek health and wealth together this Dhanteras',
  'vishwakarma-havan': 'Seek Lord Vishwakarma’s blessings on your work and tools',
  'surya-havan': 'Seek Surya Dev’s blessings for confidence and recognition',
  'lakshmi-narayana-havan': 'Seek Lakshmi–Narayan’s blessings for honest growth',
  'rudra-havan': 'Chant the Sri Rudram with devotees for Mahadev’s grace',
  'mahamrityunjaya-havan': 'Pray together for a loved one’s strength and wellbeing',
  'dhanvantari-havan': 'Pray to Lord Dhanvantari for wellbeing in your family',
  'ayush-havan': 'Pray for a long, healthy life for the ones you love',
  'swayamvara-parvati-havan': 'Seek Maa Parvati’s blessings for the right life partner',
  'uma-maheshwara-havan': 'Seek Shiv–Parvati’s blessings for a loving marriage',
  'santana-gopala-havan': 'Pray to Bal Gopal for the blessing of a child',
  'lalita-havan': 'Seek Maa Lalita’s grace for love and harmony at home',
  'shanti-havan': 'Bring shanti home — join devotees in one sacred fire',
  'sudarshana-havan': 'Seek the shelter of Lord Vishnu’s Sudarshan Chakra',
  'hanuman-havan': 'Seek Bajrangbali’s strength and protection',
  'rama-havan': 'Seek Prabhu Shri Ram’s blessings for your family',
  'krishna-havan': 'Fill your heart with Shri Krishna’s joy and devotion',
  // Pujas
  'ganesh-puja': 'Start every good thing with Ganpati Bappa',
  'satyanarayan-puja': 'Hear the Satyanarayan katha with your whole family',
  'lakshmi-puja': 'Welcome Maa Lakshmi into your home and heart',
  'saraswati-puja': 'Place your books before Maa Saraswati for her blessing',
  'birthday-puja': 'Begin your new year with a puja in your name',
  'vahan-puja': 'Bless your new vehicle for safe journeys ahead',
  'business-opening-puja': 'Open your new shop with Ganesh–Lakshmi’s blessings',
  'chopda-pujan': 'Bless your new account books this Diwali',
  'vastu-puja': 'Bless your home or office with peace and balance',
  'rudrabhishek': 'Offer abhishek to Mahadev and feel his grace',
  'hanuman-chalisa-path': 'Recite the Hanuman Chalisa together for courage',
  'sundarkand-path': 'Hear the Sundarkand and feel Hanumanji’s strength',
  'navagraha-puja': 'Seek the nine grahas’ blessings for a smoother path',
  'shani-shanti-puja': 'Seek Shani Dev’s grace through patience and prayer',
  'durga-puja': 'Seek Maa Durga’s protection for your family',
  'kanya-puja': 'Honour the Devi in young girls this Navratri',
  'tulsi-puja': 'Light a diya for Tulsi Maa and Lord Vishnu',
  'gau-puja': 'Honour Gau Mata and invite abundance home',
  'ganga-puja': 'Offer a diya to Maa Ganga, wherever you are',
  'surya-arghya': 'Offer arghya to Surya Dev with devotees everywhere',
  'vidyarambham': 'Begin your child’s learning with Maa Saraswati',
  'namkaran-puja': 'Name your little one with the family’s blessings',
  'annaprashan-puja': 'Bless your baby’s first bite of rice',
  'mundan-puja': 'Bless your child’s mundan with the family deity',
  'karwa-chauth-puja': 'Pray for your husband’s long life this Karwa Chauth',
};

/** The share-card ad for a ritual article. Havans carry the shared-havan price;
 *  pujas are private and priced per family, so their card shows no price. */
export function ritualAd(ritual: { slug: string; type: 'havan' | 'puja'; title: string }): { hook: string; price?: string } {
  const hook = ritualAdHooks[ritual.slug] ?? `Join the ${ritual.title.replace(/\s*\(.*\)\s*/, ' ').trim()} live`;
  return ritual.type === 'havan' ? { hook, price: `₹${HAVAN_SHARE_PRICE}` } : { hook };
}
