// Editorial inspiration, separate from real marketplace listings.
export const topics = {
 faith: { label: 'Faith & traditions', art: 0 },
 travel: { label: 'Travel & outdoors', art: 1 },
 daily: { label: 'Daily life', art: 2 },
 food: { label: 'Food & cooking', art: 3 },
 conversation: { label: 'Conversation', art: 4 },
 learning: { label: 'Learning & languages', art: 5 },
 career: { label: 'Career & confidence', art: 6 },
 digital: { label: 'Digital skills', art: 7 },
 art: { label: 'Art & crafts', art: 8 },
 entertainment: { label: 'Music & entertainment', art: 9 },
 lifestyle: { label: 'Home & wellbeing', art: 10 },
 business: { label: 'Small business', art: 11 },
};
export const formats = { live: 'Live stream', private: '1:1 session', group: 'Group session' };
const rows = `live|faith|Mandir Se Live Darshan|Take viewers on a temple visit. Share the atmosphere and traditions from areas where filming is permitted.|out
live|faith|Subah Ki Aarti|Bring a morning aarti to people far from home, from your home shrine or a temple that permits streaming.|home
live|faith|Ganga Ghat Se Shaam|Share an evening by the ghats, local stories and permitted ceremony coverage with a distant audience.|out
live|faith|Guruji Ka Private Satsang|A spiritual teacher or baba hosts a private live talk for followers, with a moderator gathering questions.|home
live|faith|Bhajan Ki Mehfil|Create an intimate devotional music gathering with songs you have permission to perform and stream.|home
live|faith|Ghar Ka Festival|Share your household's Ganesh Chaturthi, Navratri, Onam or Pongal traditions with everyone's consent.|home
live|faith|NRI Festival Connection|Host a festival broadcast timed for Indians abroad, explaining rituals and inviting questions.|home
live|travel|Ladakh Ride Diaries|Share mountain stops and road-trip stories. Use a mounted camera for ride footage and chat with viewers while parked.|out
live|travel|Pahadon Se Sunrise|Host a sunrise from a hill station or campsite, with local stories and a quiet moment to enjoy the view.|out
live|travel|Monsoon Village Walk|Show rain-soaked lanes, fields and everyday rural life on a walk through your neighbourhood.|out
live|travel|Apne Gaon Ki Sair|Introduce your village through its landmarks, crafts, food and residents who are happy to be on camera.|out
live|travel|Purani Galiyon Ki Kahani|Walk through an old city and tell the stories behind its lanes, buildings and familiar meeting places.|out
live|business|Bazaar Live|Explore a flower market, spice bazaar or weekly haat and introduce the people and products with permission.|out
live|food|Street-Food Discovery|Introduce local dishes and the vendors behind them, asking permission before you film.|out
live|travel|Rail Yatra Window Seat|Share window-seat scenery and railway stories from permitted areas without intruding on other passengers.|out
live|travel|Mela Mere Saath|Take viewers through a local fair, craft mela or cultural festival where broadcasting is allowed.|out
live|daily|Farm Se Live|Show a planting or harvesting day and explain the small decisions behind work on your farm.|out
live|art|Artisan At Work|Let viewers watch pottery, weaving, embroidery or woodworking while you explain the process.|home
live|food|Maa Ki Rasoi Live|Prepare a regional meal from your kitchen, sharing family tips and answering cooking questions.|home
live|food|Achaar Aur Papad Day|Share your seasonal pickle, papad or spice-making routine and the family stories that go with it.|home
live|food|Regional Food Stories|Cook one dish and tell viewers about its place in your family and local culture.|home
live|entertainment|Original Music Baithak|Perform your own music or songs you have streaming rights to in an intimate home concert.|home
live|entertainment|Shayari Aur Kahani|Host an evening of original poetry, spoken word and storytelling in your favourite language.|home
live|entertainment|Ghar Ka Stand-Up Show|Perform an original comedy set for an online audience, with a little room for conversation afterwards.|home
live|digital|Backstage With a Creator|Show how you prepare a shoot, exhibition or performance, from early ideas to the final setup.|home
live|art|Build Something Live|Let viewers follow a miniature, furniture restoration, sewing project or handmade prop from start to finish.|home
live|entertainment|Gaming With Commentary|Share gameplay, challenges and strategy in games that permit streaming, with your own commentary.|home
live|entertainment|Local Talent Night|Bring consenting musicians, poets or comedians together for a hosted online showcase of original work.|home
private|conversation|Dil Ki Baat|Offer adults a friendly, nonjudgmental listening session: companionship, not therapy or emergency support.|home
private|conversation|Chai Pe Apni Bhasha Mein|Have a relaxed conversation in Hindi, Tamil, Bengali, Marathi or another language that feels like home.|home
private|conversation|NRI Homesick Adda|Give someone living abroad a little connection to home through conversation about food, festivals and daily life.|home
private|learning|English Bolo, Bindass|Help someone practise everyday English at their pace, using real conversations and gentle feedback.|home
private|learning|Regional Language Buddy|Practise speaking, pronunciation and useful phrases in an Indian language you know well.|home
private|career|Interview Rehearsal|Use your relevant experience to run a mock interview and give specific, constructive feedback.|home
private|career|Resume Review|Help someone explain their experience clearly and improve the structure and wording of their CV.|home
private|career|Portfolio Feedback|Review a design, writing, photography or development portfolio and suggest concrete improvements.|home
private|career|Presentation Practice|Help someone rehearse a college presentation or work pitch and improve clarity and delivery.|home
private|career|First Job Reality Check|Share firsthand experience of your profession: everyday tasks, expectations and lessons from starting out.|home
private|learning|College Senior Se Baat|Offer your personal perspective on a course, campus, hostel or college routine to a prospective student.|home
private|learning|Study Planning Session|Help someone break their syllabus or project into smaller tasks and a realistic study schedule.|home
private|learning|Subject Doubt Clearing|Explain a difficult topic and practise examples together, without completing assessed work for the student.|home
private|digital|Coding Debug Buddy|Work through a coding problem together and explain how you find and fix the issue.|home
private|digital|Excel / Canva Help Desk|Guide someone through a spreadsheet, presentation or poster so they learn while making it.|home
private|digital|Phone Se Reel Bana|Help someone improve filming, lighting, editing and captions using the phone they already own.|home
private|digital|Creator Profile Review|Give practical feedback on a creator's bio, content themes, sample videos and presentation.|home
private|business|Apni Dukaan Online|Help a shop owner create a digital menu, product catalogue or online business profile.|home
private|business|WhatsApp Business Setup|Walk a small-business owner through catalogues, quick replies, labels and useful account settings.|home
private|digital|Parents Ka Tech Saathi|Patiently explain video calls, photo backups, accessibility settings and everyday apps.|home
private|food|Family Recipe Rescue|Help someone troubleshoot a family dish, from batter consistency to timing and cooking technique.|home
private|lifestyle|Saree Draping Help|Guide someone through a drape step by step, giving feedback as they practise.|home
private|lifestyle|Style Your Own Wardrobe|Help someone put together outfits using the clothes they already have.|home
private|art|Mehendi Feedback|Guide a beginner on grip, consistency, patterns and a practical routine for improving their designs.|home
private|entertainment|Music Practice Coach|Offer individual feedback on singing or an instrument within your teaching experience.|home
private|learning|Regional Pronunciation Coach|Help someone practise pronunciation or dialogue for language learning, acting or hosting.|home
private|lifestyle|Plant Care Adda|Use your gardening experience to discuss likely care issues and improve a home plant routine.|home
private|lifestyle|Pet Training Basics|A qualified trainer helps with everyday behaviour, practice routines and training questions.|home
private|travel|Travel Plans With a Local|Help someone plan a trip using your firsthand knowledge of the destination and its neighbourhoods.|home
private|travel|Ladakh Trip Preparation|Discuss packing, route logistics and lessons from your own mountain travels with someone planning a trip.|home
private|faith|Spiritual Conversation|A knowledgeable religious teacher discusses traditions, texts or spiritual practice without promising cures or outcomes.|home
private|conversation|Family History Interview|Help someone or a consenting relative tell their life stories and preserve family memories.|home
 group|learning|English Practice Adda|Run small-group conversations, role-play and speaking games so everyone gets a turn.|home
 group|learning|Hindi for NRI Families|Teach useful Hindi through stories, songs and everyday situations in guardian-managed family sessions.|home
 group|learning|Regional Language Club|Bring learners together to practise an Indian language through conversation and shared activities.|home
 group|career|Interview Practice Circle|Let participants take turns answering interview questions and learning from your feedback.|home
 group|career|Group Discussion Practice|Moderate a placement-style discussion and help people practise listening, structure and participation.|home
 group|career|Public Speaking Club|Give everyone a chance to deliver a short talk and receive supportive, useful feedback.|home
 group|learning|Study With Me Club|Set shared goals, work quietly and check in during structured breaks to keep each other accountable.|home
 group|learning|Exam Revision Workshop|Lead a focused revision session on one subject or topic you are equipped to teach.|home
 group|digital|Beginner Coding Lab|Build a small project together, explaining each step and helping participants when they get stuck.|home
 group|digital|Excel for Your First Job|Practise useful workplace spreadsheet tasks together using sample data.|home
 group|business|Canva for Small Businesses|Help a group of business owners create a menu, offer poster or social post during the session.|home
 group|digital|Phone Photography Workshop|Practise framing and lighting with a phone and everyday objects available at home.|home
 group|digital|Reel Editing Workshop|Guide participants through editing a short clip and give feedback on their results.|home
 group|business|Apni Pehli Listing|Help new creators work on a clear service description, session outline and presentation.|home
 group|food|Regional Cooking Class|Cook a particular dish together, sharing the ingredient list before the session.|home
 group|food|Hostel Cooking Club|Make practical meals together using limited space and simple equipment.|home
 group|food|Pickle-Making Workshop|Teach one pickle recipe, its preparation method and appropriate storage basics.|home
 group|food|Festival Mithai Class|Make a festive sweet together and help participants with technique and timing.|home
 group|art|Rangoli Together|Lead a design step by step and give everyone time to share their finished rangoli.|home
 group|art|Warli / Madhubani Art Class|A knowledgeable artist introduces a folk-art technique and its cultural context.|home
 group|art|Embroidery & Crochet Circle|Work on a small project together with live demonstrations and troubleshooting.|home
 group|art|Mehendi Practice Club|Teach a set of patterns and give participants individual pointers as they practise.|home
 group|lifestyle|Saree Draping Circle|Teach a regional or occasion-specific drape and help participants practise together.|home
 group|entertainment|Bollywood Dance Workshop|Teach a dance routine with an instructor and music you have permission to use.|home
 group|entertainment|Folk Dance From Home|Introduce Garba, Bhangra or another folk-dance form through a guided practice session.|home
 group|entertainment|Music Riyaaz Circle|Lead vocal exercises, rhythm practice or instrumental technique within your teaching experience.|home
 group|faith|Bhajan Seekho|Teach a devotional song, helping participants with pronunciation, melody and meaning.|home
 group|faith|Satsang & Questions|A spiritual teacher leads a small-group discussion where participants can ask questions.|home
 group|faith|Scripture Reading Circle|A knowledgeable facilitator guides a reading and discussion of a chosen religious text.|home
 group|lifestyle|Yoga Basics|A qualified instructor leads a beginner class with clear guidance and suitable adaptations.|home
 group|lifestyle|Balcony Gardening Club|Help participants plan and care for small gardens using the space they have.|home
 group|entertainment|Antakshari Adda|Host a participatory singing game using material you have permission to share.|home
 group|entertainment|Bollywood Trivia Night|Run an original film quiz with teams, questions and a lively host.|home
 group|learning|Regional Book Club|Discuss a chosen book and invite different perspectives in English or an Indian language.|home
 group|art|Poetry & Story Feedback Circle|Let participants share their original work and exchange constructive feedback.|home
 group|entertainment|Board-Game / Chess Club|Host games, explain rules or analyse chess positions together.|home
 group|faith|NRI Cultural Sunday|Explore a festival, story, recipe or tradition through a guardian-managed family session.|home
 group|conversation|Grandparents' Story Circle|Host a gathering where consenting elders share memories and participants ask questions.|home
 group|travel|Travel Planning Circle|Help several travellers prepare for a similar trip with firsthand destination knowledge.|home
 group|business|Creator Accountability Club|Set weekly goals, share progress and exchange practical feedback with fellow creators.|home
live|daily|Gaon Ki Subah|Let viewers drop into your morning chai, household chores and village routine.|home
live|daily|Pahadon Mein Mera Din|Share the ordinary moments of living in a mountain town, from breakfast to evening views.|home
live|daily|Khet Ka Roz Ka Kaam|Show your regular farm routine and explain the work as viewers come and go.|out
live|daily|Meri Rasoi|Go live while preparing everyday meals and chat with viewers between kitchen tasks.|home
live|daily|Hostel Diaries|Share cooking, studying and decorating your own space, keeping roommates' privacy in mind.|home
live|daily|Quiet Study Companion|Let viewers drop in and study alongside you in a calm, mostly quiet live session.|home
live|daily|Artist's Workday|Share your working process as you paint, embroider, sculpt or make something at your desk.|home
live|daily|Chai Stall Chronicles|Show the rhythm of a chai stall, keeping customers and conversations off-camera unless they consent.|out
live|daily|Dukaan Ka Din|Share opening the shop, arranging displays and packing orders without exposing customer details.|out
live|daily|Small Business Behind the Scenes|Let people watch you make products and prepare deliveries, keeping names and addresses private.|home
live|daily|Van Life / Travel Diaries|Share campsite routines, cooking and travel updates while safely parked.|out
live|daily|Balcony Garden Time|Water, repot and tend your plants while chatting with viewers who share the interest.|home
live|daily|My Indian Life Abroad|Share cooking, groceries and everyday cultural differences from your life outside India.|home
live|daily|Shaam Ka Adda|Open an informal evening chat from home, with space for familiar faces and new visitors.|home
live|daily|Mera Din, Meri Kahani|Share selected everyday moments on your terms. Go live when you choose and keep private moments private.|home`;
const featured = new Set(['Mandir Se Live Darshan', 'Guruji Ka Private Satsang', 'Ladakh Ride Diaries', 'Dil Ki Baat', 'English Practice Adda', 'Gaon Ki Subah']);
const easy = new Set(['Chai Pe Apni Bhasha Mein', 'Quiet Study Companion', 'Shaam Ka Adda', 'Study With Me Club', 'Family History Interview']);
export const creatorIdeas = rows.split('\n').map((row, index) => {
 const [format, topic, title, description, setting] = row.trim().split('|');
 return { id: 'idea-' + (index + 1), format: format as keyof typeof formats, topic: topic as keyof typeof topics, title, description, setting, badge: featured.has(title) ? 'Featured idea' : easy.has(title) ? 'Easy to start' : '' };
});

// Open with a mix of formats and subjects, then preserve the full editorial list.
const openingTitles = ['Mandir Se Live Darshan','Ladakh Ride Diaries','Dil Ki Baat','English Practice Adda','Gaon Ki Subah','Maa Ki Rasoi Live','Phone Se Reel Bana','Warli / Madhubani Art Class','Guruji Ka Private Satsang','Original Music Baithak','Small Business Behind the Scenes','Plant Care Adda'];
creatorIdeas.sort((a,b) => {
 const rank = (title: string) => { const n=openingTitles.indexOf(title); return n < 0 ? openingTitles.length : n; };
 return rank(a.title)-rank(b.title);
});
