// [SAATHUM-GUIDE-2 2026-09-25] "Why this deity" + "The story behind it" for every
// ritual article. OWNER BRIEF: sell hope, explain benefits, deity and history —
// "no lies". So every line here is either widely known scripture/legend, stated
// as tradition ("tradition holds", "the Purana tells"), or plain description.
// Never add invented verse numbers, statistics or promised outcomes.
export type RitualStory = { why: string; story: string };

export const ritualStories: Record<string, RitualStory> = {
  // ─── HAVANS ───
  'saraswati-havan': {
    why: 'Saraswati is the goddess of knowledge, speech, music and the arts. Her white lotus stands for purity of mind, her veena for harmony, and her book for learning — everything a student or artist prays for.',
    story: 'Saraswati is one of the oldest deities still worshipped today: in the Rig Veda she is a great river and a goddess who "inspires good thoughts". Over the centuries she became the patron of learning, and her festival, Vasant Panchami, is still the day children across India are blessed before they begin to read and write.',
  },
  'gayatri-havan': {
    why: 'Gayatri Devi is the Gayatri mantra itself, worshipped as a goddess — the mother of the Vedas. The mantra asks the divine light of the sun to illumine our intellect, which is why it is offered for clarity and wisdom.',
    story: 'The Gayatri mantra comes from the Rig Veda and is traditionally credited to the sage Vishwamitra. For thousands of years it has been the first mantra taught to a young student, and it is still chanted at sunrise in homes and temples across India.',
  },
  'hayagriva-havan': {
    why: 'Hayagriva is Lord Vishnu in his horse-headed form, honoured as the keeper of all knowledge. Scholars have prayed to him for centuries before study, exams and debate.',
    story: 'Tradition tells that two demons stole the Vedas from Brahma and hid them beneath the waters. Vishnu took the radiant horse-headed form of Hayagriva, recovered the Vedas and returned all knowledge to the world — which is why he is worshipped as the protector of learning.',
  },
  'dakshinamurthy-havan': {
    why: 'Dakshinamurthy is Lord Shiva as the supreme teacher. He is prayed to for deep understanding — the kind of knowing that goes beyond memorising.',
    story: 'Tradition tells of four great sages who came to the young Shiva seated under a banyan tree, seeking the highest truth. He taught them in complete silence, and in that silence all their doubts dissolved. His raised hand, in chin-mudra, symbolises the union of the individual with the divine.',
  },
  'brihaspati-havan': {
    why: 'Brihaspati is the guru of the devas and, in Vedic astrology, the planet Jupiter — the giver of wisdom, good counsel, children and fortune. Thursday (Guruvar) is named after him.',
    story: 'In the Vedas, Brihaspati is the priest and teacher of the gods, the lord of sacred speech and prayer. As the planet Jupiter he is considered the most benevolent of all the planets, and a havan to him is a traditional way to invite his kindly influence.',
  },
  'ganapati-havan': {
    why: 'Ganesha is Vighnaharta, the remover of obstacles, and Siddhidata, the giver of success. In Hindu worship he is remembered first, before every other deity and every new beginning.',
    story: 'The Puranas tell that Lord Shiva blessed his son Ganesha to be worshipped before all other gods. Ever since, from weddings to housewarmings to the first day of business, families begin by honouring Ganapati — and this havan is that blessing in its fullest form.',
  },
  'satyanarayana-havan': {
    why: 'Satyanarayana is Lord Vishnu as the embodiment of truth (satya). Worshipping him is an act of gratitude, and a promise to live truthfully.',
    story: 'The Satyanarayan katha, traditionally linked to the Skanda Purana, tells of a poor Brahmin, a woodcutter, a merchant and a king whose lives changed after they worshipped Satyanarayana with faith — and of the troubles that came when they forgot their promise. Its lesson is simple: remember the divine in good times, not only in bad.',
  },
  'navagraha-havan': {
    why: 'The Navagraha are the nine celestial influences of Vedic astrology: the Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Rahu and Ketu. Honouring all nine together seeks balance across every area of life.',
    story: 'Navagraha worship is an ancient part of Indian temple life — most great South Indian temples have a shrine where the nine planets stand facing different directions. A Navagraha havan offers each planet its own grain, colour and wood, a practice handed down through generations of priests.',
  },
  'vastu-shanti-havan': {
    why: 'Vastu Purusha is the spirit of every building and plot of land. Honouring him, with Ganesha, seeks harmony between the people who live in a space and the space itself.',
    story: 'Tradition, preserved in texts like the Matsya Purana, tells that a great being once covered the whole earth, and the gods pressed him down with their presence to steady the world. Moved by his plight, they granted him a boon: he would be honoured before any building rose. That being is Vastu Purusha, and this havan is his worship.',
  },
  'griha-pravesh-havan': {
    why: 'A new home is welcomed with Ganesha to clear the way, Vishnu to protect it, and Lakshmi to fill it with abundance — so the family’s first steps inside are blessed.',
    story: 'Griha Pravesh is one of the most cherished family ceremonies in India. Traditions such as boiling milk until it overflows — a sign of plenty that never runs out — and entering with the right foot first have been passed from generation to generation.',
  },
  'lakshmi-havan': {
    why: 'Lakshmi is the goddess of wealth, abundance, beauty and good fortune. She is not only money, but the grace that makes a home feel full.',
    story: 'The Puranas tell that Lakshmi rose from the churning of the cosmic ocean (Samudra Manthan), seated on a lotus, and chose Vishnu as her eternal consort. Where there is honesty, cleanliness and devotion, tradition says, Lakshmi loves to stay.',
  },
  'kubera-havan': {
    why: 'Kubera is the treasurer of the gods and the guardian of the north. He is prayed to not for sudden riches but for wealth that is kept, protected and grown.',
    story: 'A well-loved legend from the Tirupati tradition tells that when Lord Venkateswara needed wealth for his wedding to Padmavati, it was Kubera who lent it — a debt devotees still help "repay" with their offerings today. Kubera is worshipped especially on Dhanteras.',
  },
  'sri-suktam-havan': {
    why: 'The Sri Suktam is a hymn to Lakshmi as Sri — radiant, gracious abundance. It asks not just for wealth, but for prosperity that brings good character and a good name.',
    story: 'The Sri Suktam is one of the oldest hymns to Lakshmi, preserved as an appendix (khila) to the Rig Veda. For centuries priests have used its verses for havans on Fridays, full moons and Diwali, offering lotus, bilva and ghee with each verse.',
  },
  'dhanvantari-lakshmi-havan': {
    why: 'Dhanvantari is the divine physician and Lakshmi the goddess of abundance. On Dhanteras they are honoured together, because wealth without wellbeing is incomplete.',
    story: 'Both rose from the same churning of the cosmic ocean: Dhanvantari carrying the pot of amrit, the nectar of immortality, and Lakshmi seated on a lotus. Dhanteras — "the day of wealth", two days before Diwali — celebrates them both.',
  },
  'vishwakarma-havan': {
    why: 'Vishwakarma is the divine architect and craftsman of the gods. Everyone who builds, makes or repairs — engineers, artisans, factory workers, developers — honours him for skill and safety.',
    story: 'Tradition credits Vishwakarma with building the golden city of Lanka, Krishna’s Dwarka, the palace of Indraprastha and the flying chariot Pushpaka. On Vishwakarma Puja, workshops and factories across India pause to bless their tools and machines.',
  },
  'surya-havan': {
    why: 'Surya, the Sun, is the visible divine — the source of light, energy and life. In astrology he governs confidence, leadership and recognition.',
    story: 'In the Ramayana tradition, the sage Agastya taught Lord Rama the Aditya Hridayam, a hymn to the Sun, before his final battle, and Rama found fresh strength. Surya worship at sunrise is among the oldest continuous practices in India.',
  },
  'lakshmi-narayana-havan': {
    why: 'Vishnu and Lakshmi together are the preserver and the prosperity that follows him. Worshipped as a pair, they bless growth that is stable and ethical.',
    story: 'Wherever Vishnu takes birth to protect the world, the Puranas tell, Lakshmi accompanies him — as Sita with Rama, as Rukmini with Krishna. Their inseparable partnership is why they are worshipped together for businesses and partnerships.',
  },
  'rudra-havan': {
    why: 'Rudra is Lord Shiva in his most ancient Vedic form. The Sri Rudram praises him in every form — fierce and gentle — and asks for his peace and protection.',
    story: 'The Sri Rudram comes from the Krishna Yajurveda and is one of the most revered Vedic hymns. Its famous refrain, "Namah Shivaya", became the heart of the Panchakshari mantra that millions of devotees chant every day.',
  },
  'mahamrityunjaya-havan': {
    why: 'Mrityunjaya means "the one who conquers death" — Lord Shiva as the protector of life. His mantra prays for strength, healing and freedom from fear, as gently as a ripe cucumber is freed from its vine.',
    story: 'The Mahamrityunjaya mantra is found in the Rig Veda. A beloved legend tells of the young sage Markandeya, destined to die at sixteen, who clung to the Shiva linga in prayer; Shiva appeared and protected him, and Markandeya lived on as an eternal devotee.',
  },
  'dhanvantari-havan': {
    why: 'Dhanvantari is the physician of the gods and, in tradition, the source of Ayurveda. He is prayed to for health, healing and the wellbeing of the whole family.',
    story: 'The Puranas tell that Dhanvantari rose from the churning of the cosmic ocean holding the pot of amrit. Ayurvedic physicians still honour him, and his jayanti is observed on Dhanteras.',
  },
  'ayush-havan': {
    why: 'Ayush means long life. This havan honours the divine as the giver of health and years, and asks for protection over a child or a loved elder.',
    story: 'Blessings for a long life are among the oldest prayers in the Vedas, which contain hymns for a hundred autumns of life. Families traditionally perform the Ayush havan on a child’s first birthday, and on milestone birthdays of elders.',
  },
  'sudarshana-havan': {
    why: 'Sudarshana is Lord Vishnu’s divine discus, worshipped as a deity in its own right — a wheel of divine light that devotees pray to for protection.',
    story: 'One tradition tells that Vishnu worshipped Shiva with a thousand lotuses and, finding one missing, offered his own lotus-like eye; pleased, Shiva gifted him the Sudarshana Chakra. In South India, Sudarshana havans are a much-loved prayer for protection and peace.',
  },
  'swayamvara-parvati-havan': {
    why: 'Parvati won Lord Shiva as her husband through her own devotion and determination. She is prayed to for a loving, well-matched marriage.',
    story: 'The Puranas tell how the young Parvati gave up every comfort and performed deep tapasya until Shiva, deeply moved, accepted her. Their marriage is celebrated as the ideal union, and Parvati’s swayamvara prayer is still chanted by those hoping to marry.',
  },
  'uma-maheshwara-havan': {
    why: 'Uma (Parvati) and Maheshwara (Shiva) are the divine couple — two halves of one whole, famously shown together as Ardhanarishvara. They bless harmony between partners.',
    story: 'Shiva and Parvati’s household on Mount Kailash, with their sons Ganesha and Kartikeya, is the model of a divine family in Hindu tradition. Couples honour Uma Maheshwara on anniversaries and whenever they wish to renew their bond.',
  },
  'santana-gopala-havan': {
    why: 'Santana Gopala is Krishna as a child — the giver of children and the protector of little ones. He is prayed to by couples hoping for a baby.',
    story: 'A story in the Mahabharata tradition tells of a Brahmin in Dwarka who lost child after child. Arjuna vowed to help and failed; then Krishna himself travelled beyond the worlds and returned all the children to their parents. Santana Gopala is Krishna as that giver of children.',
  },
  'lalita-havan': {
    why: 'Lalita Tripurasundari is the Divine Mother in her most beautiful and playful form. She is honoured for love, grace, charm and joy.',
    story: 'The Lalita Sahasranama — her thousand names — appears in the Brahmanda Purana, where Lord Hayagriva teaches it to the sage Agastya. It is chanted in homes and temples across India, especially on Fridays and during Navratri.',
  },
  'shanti-havan': {
    why: 'Shanti means peace. This havan uses the Vedic Shanti mantras, which pray for peace in the sky, the earth, the waters, the plants and every living being.',
    story: 'Many Upanishads open and close with a Shanti mantra ending in "Om Shanti, Shanti, Shanti" — peace three times, for peace in body, in the world around us, and from forces beyond our control. A Shanti havan brings those ancient prayers to the fire.',
  },
  'hanuman-havan': {
    why: 'Hanuman is devotion, courage and strength combined. He is prayed to for fearlessness, protection and the strength to face any challenge.',
    story: 'In the Ramayana, Hanuman leapt across the ocean to find Sita, carried a mountain of healing herbs to save Lakshmana, and served Lord Rama with a love that asked nothing in return. Tradition holds that he lives on wherever Rama’s name is sung.',
  },
  'rama-havan': {
    why: 'Lord Rama is dharma in human form — the ideal son, husband, brother and king. He is prayed to for righteousness, strong family values and victory over hardship.',
    story: 'Valmiki’s Ramayana, one of the world’s great epics, tells of Rama’s exile, the loss and rescue of Sita, and his return to Ayodhya — a homecoming still celebrated every Diwali with rows of lamps. Ram Navami marks his birth.',
  },
  'krishna-havan': {
    why: 'Krishna is love, joy and wisdom — the playful child of Vrindavan and the teacher of the Bhagavad Gita. He is prayed to for happiness, devotion and clarity in decisions.',
    story: 'On the battlefield of Kurukshetra, Krishna taught Arjuna the Bhagavad Gita — to act with devotion and without fear of the result. In Vrindavan, his flute drew everyone in love. Both sides of Krishna are honoured in this joyful havan.',
  },
  // ─── PUJAS ───
  'ganesh-puja': {
    why: 'Ganesha is the remover of obstacles and the lord of beginnings. A simple Ganesh puja is the most common way to start anything new with a blessing.',
    story: 'The Puranas tell that Lord Shiva granted Ganesha the boon of being worshipped first. Lokmanya Tilak later turned Ganesh Chaturthi into a great public festival in the 1890s, and it remains one of India’s best-loved celebrations.',
  },
  'satyanarayan-puja': {
    why: 'Satyanarayana is Lord Vishnu as truth itself. The puja is an act of thanksgiving, usually done after a wish comes true or before a new chapter.',
    story: 'The Satyanarayan katha, traditionally linked to the Skanda Purana, is read aloud during the puja. Its stories teach that sincere gratitude — not grand offerings — is what the divine values most.',
  },
  'lakshmi-puja': {
    why: 'Lakshmi is the goddess of wealth and good fortune. Lighting lamps to welcome her is one of India’s most beloved traditions.',
    story: 'Diwali night is devoted to Lakshmi. Families clean their homes, draw rangoli and light diyas, because tradition says Lakshmi visits the homes that are bright, clean and welcoming.',
  },
  'saraswati-puja': {
    why: 'Saraswati is the goddess of learning and the arts. Placing books, pens and instruments before her invites her blessing on study and creativity.',
    story: 'In Bengal and eastern India, Saraswati Puja on Vasant Panchami is a festival of students — books are placed at her feet and no one studies that day, trusting her to bless the learning ahead.',
  },
  'vidyarambham': {
    why: 'Vidyarambham is a child’s first step into learning, taken under the blessing of Saraswati, goddess of knowledge, and Ganesha, the lord of beginnings.',
    story: 'On Vijayadashami, especially in Kerala and South India, thousands of little children write their first letters in a plate of rice, guided by a parent, teacher or priest. It is a tradition parents treasure for life.',
  },
  'namkaran-puja': {
    why: 'Namkaran is the naming ceremony, one of the traditional samskaras (rites of passage). The baby’s name is blessed by Ganesha, the nine planets and the family deity.',
    story: 'The Grihya Sutras describe the naming of a child as one of the sixteen samskaras that mark a life. Many families choose a name that begins with the syllable of the baby’s birth star.',
  },
  'annaprashan-puja': {
    why: 'Annaprashan is the baby’s first taste of grain, offered with prayers to Vishnu and Annapurna, the goddess of nourishment, for a lifetime of good health.',
    story: 'Annaprashan is one of the sixteen traditional samskaras. In many families, the baby is later shown a few objects — a book, a coin, a pen — and whatever they reach for is lovingly taken as a sign of their future.',
  },
  'mundan-puja': {
    why: 'Mundan, or Chudakarana, is the child’s first haircut — a fresh start, blessed by the family deity and Ganesha.',
    story: 'The first haircut is one of the sixteen traditional samskaras. Many families travel to a special temple or holy river for it, and the ceremony is a joyful gathering of grandparents and relatives.',
  },
  'birthday-puja': {
    why: 'A birthday puja thanks your ishta devata (personal deity) for another year of life, and asks for health and success in the year ahead.',
    story: 'Many families mark birthdays by the birth star (nakshatra) as well as the calendar date. Milestone birthdays — like the 60th, Shashtipurti — are traditionally celebrated with special prayers.',
  },
  'vahan-puja': {
    why: 'Ganesha clears the road ahead and Vishwakarma, the divine craftsman, blesses the machine itself — together they are prayed to for safe journeys.',
    story: 'From new cars to trucks and tractors, Indians have long blessed a new vehicle before its first journey — with a kumkum swastika, a garland and lemons under the wheels. Ayudha Puja during Navratri is another day tools and vehicles are honoured.',
  },
  'business-opening-puja': {
    why: 'Ganesha opens the way, Lakshmi brings prosperity and Kubera guards the wealth — the three are honoured together at the start of any business.',
    story: 'Indian traders have long opened a new shop only at an auspicious muhurat, lighting the first lamp and treating the first sale — the "bohni" — as a blessing for everything that follows.',
  },
  'chopda-pujan': {
    why: 'Lakshmi, Ganesha and Saraswati bless the new books of account — wealth, a smooth path and wisdom in managing it.',
    story: 'In Gujarati and Marwari trading families, Chopda Pujan (also called Sharda Pujan) on Diwali opens the new financial year. New ledgers are marked with "Shubh" and "Labh" — auspiciousness and profit.',
  },
  'vastu-puja': {
    why: 'Vastu Purusha is the spirit of a space. This lighter puja honours him with Ganesha, for harmony and peace in a home or workplace.',
    story: 'Tradition holds that Vastu Purusha lies beneath every plot of land, and that he was granted the boon of being honoured before any home is lived in. A Vastu puja keeps that ancient courtesy.',
  },
  'rudrabhishek': {
    why: 'Shiva is said to love abhisheka — the ritual bathing of the linga. Offering milk, honey, curd and water while the Rudram is chanted is one of the most cherished forms of Shiva worship.',
    story: 'During the month of Shravan, millions of devotees across India carry water to Shiva temples for abhisheka. The Rudram chanted during Rudrabhishek comes from the Krishna Yajurveda.',
  },
  'hanuman-chalisa-path': {
    why: 'Hanuman is courage and devotion. His Chalisa — forty verses of praise — is one of the most recited prayers in India for strength and freedom from fear.',
    story: 'The Hanuman Chalisa was written by the poet-saint Goswami Tulsidas in the 16th century. Its simple Awadhi verses made the prayer loved by everyone, and it is recited daily in countless homes.',
  },
  'sundarkand-path': {
    why: 'The Sundarkand tells of Hanuman’s journey to find Sita. Reciting it is a traditional way to seek hope and success when a task feels impossible.',
    story: 'Sundarkand is the fifth chapter of Tulsidas’s Ramcharitmanas. It follows Hanuman’s leap across the ocean, his meeting with Sita in Lanka and the joyful news he brings back to Rama — a story of hope from beginning to end.',
  },
  'navagraha-puja': {
    why: 'The nine planets of Vedic astrology are honoured together to bring balance to every part of life.',
    story: 'Navagraha shrines are found in temples across India, where devotees walk around the nine deities in prayer. This puja brings that same practice to the altar without the fire of a havan.',
  },
  'shani-shanti-puja': {
    why: 'Shani Dev, the planet Saturn, is the lord of karma and discipline. He rewards patience and honest effort, and is prayed to gently for his grace.',
    story: 'Tradition tells that Shani is the son of Surya, the Sun, and Chhaya. Devotees offer him sesame oil and black sesame on Saturdays, and Hanuman is also prayed to, because legend says Shani promised never to trouble Hanuman’s devotees.',
  },
  'durga-puja': {
    why: 'Durga is the Divine Mother as strength and protection. She is prayed to for courage and for the safety of the whole family.',
    story: 'The Devi Mahatmya, part of the Markandeya Purana, tells how the combined radiance of all the gods took form as Durga to restore peace to the world. Navratri honours her nine forms over nine nights.',
  },
  'kanya-puja': {
    why: 'During Navratri, young girls are honoured as living forms of the Devi — a way of worshipping the goddess through love, service and charity.',
    story: 'On Ashtami or Navami, families across North India invite little girls home, wash their feet, feed them puri, halwa and chana, and give them small gifts. It is one of the most joyful Navratri traditions.',
  },
  'karwa-chauth-puja': {
    why: 'Parvati, the ideal devoted wife, is honoured with Shiva and the Moon, as married women pray for their husband’s long life.',
    story: 'The vrat katha tells of Veeravati, who broke her fast too early when her brothers showed her a false moon — and whose devotion later restored her husband to her. Women hear the story together each Karwa Chauth evening.',
  },
  'tulsi-puja': {
    why: 'Tulsi is revered as a goddess and as the plant most dear to Lord Vishnu. Worshipping her brings auspiciousness into the home.',
    story: 'The Puranas tell of Vrinda, a woman of great devotion who became the tulsi plant. Tulsi Vivah celebrates her marriage to Vishnu in the form of Shaligram, and marks the start of the wedding season.',
  },
  'gau-puja': {
    why: 'The cow is honoured as Gau Mata, a mother who nourishes, and Kamadhenu is the wish-fulfilling cow of the gods.',
    story: 'Kamadhenu rose from the churning of the cosmic ocean. Krishna grew up as a cowherd, and Gopashtami celebrates the day he first took the cows to graze — why cows are lovingly decorated and fed on that day.',
  },
  'ganga-puja': {
    why: 'Ganga is the holiest river of India, worshipped as a goddess who purifies and brings peace.',
    story: 'The Puranas tell that King Bhagiratha prayed for years to bring Ganga down from heaven, and Shiva caught her in his hair to soften her fall. Evening lamp offerings at Haridwar, Rishikesh and Varanasi continue that devotion every day.',
  },
  'surya-arghya': {
    why: 'Surya, the Sun, is the giver of light and life. Offering water to him at sunrise is a daily act of gratitude for energy and health.',
    story: 'Chhath, celebrated especially in Bihar and eastern Uttar Pradesh, is one of India’s oldest festivals — devotees stand in rivers to offer arghya to both the setting and the rising sun. Tradition links Surya worship to Karna, the Sun’s son, in the Mahabharata.',
  },
};

export const storyFor = (slug: string): RitualStory => {
  const story = ritualStories[slug];
  if (!story) throw new Error('ritualStories missing: ' + slug);
  return story;
};
