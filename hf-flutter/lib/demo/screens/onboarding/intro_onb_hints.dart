/// [HF-INTRO-A1] Languages and "You could say..." / "Please avoid" ideas for the influencer's intro video (owner decision D6).
/// Ideas exist for Hindi and English for every category (including the four sensitive ones). Any other language falls back to the
/// English ideas, with a note that tells the person to speak in her own language.

class OnbLang {
  const OnbLang(this.code, this.native, this.english);

  /// Matches the server's `langs` list (`hi en mr bn ta te gu pa kn ml`).
  final String code;
  final String native;
  final String english;

  /// "हिन्दी · Hindi", or just "English".
  String get label => native == english ? english : '$native · $english';
}

/// The ten languages of the recorder prep screen, in the order the owner listed them.
const List<OnbLang> kOnbLangs = <OnbLang>[
  OnbLang('hi', 'हिन्दी', 'Hindi'),
  OnbLang('en', 'English', 'English'),
  OnbLang('mr', 'मराठी', 'Marathi'),
  OnbLang('bn', 'বাংলা', 'Bengali'),
  OnbLang('ta', 'தமிழ்', 'Tamil'),
  OnbLang('te', 'తెలుగు', 'Telugu'),
  OnbLang('gu', 'ગુજરાતી', 'Gujarati'),
  OnbLang('pa', 'ਪੰਜਾਬੀ', 'Punjabi'),
  OnbLang('kn', 'ಕನ್ನಡ', 'Kannada'),
  OnbLang('ml', 'മലയാളം', 'Malayalam'),
];

OnbLang onbLang(String? code) {
  for (final l in kOnbLangs) {
    if (l.code == code) return l;
  }
  return kOnbLangs.first;
}

/// Languages that have their own ideas; the rest use English.
const Set<String> kHintLangs = <String>{'hi', 'en'};

class OnbHint {
  const OnbHint({required this.say, required this.avoid});

  final List<String> say;
  final List<String> avoid;
}

/// The "topic" that is not a category.
const String kTopicGeneral = 'general';

/// True when [lang] has its own ideas (otherwise [hintFor] answers the English ones).
bool hasOwnHints(String lang) => kHintLangs.contains(lang);

/// The ideas for [topic] (a category id or `general`) in [lang]. Never null: an unknown topic gets the General ideas.
OnbHint hintFor(String topic, String lang) {
  final byTopic = kOnbHints[topic] ?? kOnbHints[kTopicGeneral]!;
  final key = hasOwnHints(lang) ? lang : 'en';
  return byTopic[key] ?? byTopic['en']!;
}

/// The note under the ideas when the person's language has no ideas of its own.
String englishFallbackNote(String langEnglishName) =>
    'Ideas for $langEnglishName are coming soon, so these are in English. Please speak in $langEnglishName.';

/// topic id (a category id or `general`) -> language code (`en`, `hi`) -> ideas.
const Map<String, Map<String, OnbHint>> kOnbHints = <String, Map<String, OnbHint>>{
  'general': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. Call me and let’s talk.”',
        '“You can talk to me about [what you are good at].”',
        '“I’ll listen carefully and give you my honest view.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Romantic or sexual talk', 'Promises like “100% guaranteed”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मुझे कॉल करें, बात करते हैं।”',
        '“आप मुझसे [अपनी खूबी] के बारे में बात कर सकते हैं।”',
        '“मैं ध्यान से सुनूँगा/सुनूँगी और अपनी सच्ची राय दूँगा/दूँगी।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'रोमांटिक या अश्लील बातें', '“100% गारंटी” जैसे वादे'],
    ),
  },
  'astrology': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I have been reading kundlis for [N] years.”',
        '“Marriage, career or a hard phase of life: talk to me.”',
        '“On the call I will look at your chart and show you the way ahead.”',
      ],
      avoid: ['Phone numbers or social media handles', 'Fear-based warnings like “something bad will happen”', 'Promises like “100% guaranteed”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। [N] साल से कुंडली देख रही/रहा हूँ।”',
        '“शादी, करियर या कोई मुश्किल दौर: मुझसे बात करें।”',
        '“कॉल पर मैं आपकी कुंडली देखकर आगे का रास्ता बताऊँगा/बताऊँगी।”',
      ],
      avoid: ['फ़ोन नंबर या सोशल मीडिया हैंडल', 'डराने वाली बातें, जैसे “कुछ बुरा होगा”', '“100% गारंटी” जैसे वादे'],
    ),
  },
  'teacher': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I teach [subject].”',
        '“Stuck on a topic? Call me and we will go through it step by step.”',
        '“Students of [class or exam] are welcome.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Promises like “you will pass for sure”', 'Asking students to pay outside the app'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं [विषय] पढ़ाता/पढ़ाती हूँ।”',
        '“किसी टॉपिक में अटके हैं? कॉल करें, हम स्टेप बाय स्टेप समझेंगे।”',
        '“[कक्षा या परीक्षा] के छात्रों का स्वागत है।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', '“पास होना पक्का” जैसे वादे', 'ऐप के बाहर पैसे माँगना'],
    ),
  },
  'traveller': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I have travelled to [places].”',
        '“Planning a trip? Ask me about routes, budget and the best time to go.”',
        '“I will tell you what to see and what to skip.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Selling tour packages or bookings', 'Promises like “cheapest trip guaranteed”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं [जगहों] की यात्रा कर चुकी/चुका हूँ।”',
        '“ट्रिप बना रहे हैं? रूट, बजट और जाने का सही समय मुझसे पूछें।”',
        '“मैं बताऊँगा/बताऊँगी कि क्या देखना है और क्या छोड़ना है।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'टूर पैकेज या बुकिंग बेचना', '“सबसे सस्ती ट्रिप की गारंटी” जैसे वादे'],
    ),
  },
  'cook': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I love cooking [type of food].”',
        '“Recipe not coming out right? Call me and I will help you fix it.”',
        '“Ask me about everyday meals, festival food or tiffin ideas.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Selling products or masalas', 'Medical claims like “this food cures a disease”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मुझे [तरह का खाना] बनाना बहुत पसंद है।”',
        '“रेसिपी ठीक नहीं बन रही? कॉल करें, मैं ठीक करना सिखाऊँगा/सिखाऊँगी।”',
        '“रोज़ के खाने, त्योहार के पकवान या टिफ़िन के आइडिया मुझसे पूछें।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'प्रोडक्ट या मसाले बेचना', '“इस खाने से बीमारी ठीक होती है” जैसे दावे'],
    ),
  },
  'fitness': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I help people get fit at home.”',
        '“Tell me your goal, weight loss or strength, and I will plan it with you.”',
        '“Simple workouts, no fancy equipment needed.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Medical advice or promises like “lose 10 kg in a week”', 'Selling supplements'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं घर पर फ़िट रहने में मदद करता/करती हूँ।”',
        '“अपना लक्ष्य बताइए, वज़न घटाना या ताकत बढ़ाना, मैं आपके साथ प्लान बनाऊँगा/बनाऊँगी।”',
        '“आसान वर्कआउट, किसी महँगे सामान की ज़रूरत नहीं।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'दवा की सलाह या “एक हफ़्ते में 10 किलो” जैसे वादे', 'सप्लीमेंट बेचना'],
    ),
  },
  'music': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I sing and play [instrument].”',
        '“Want to learn a song or improve your voice? Call me.”',
        '“I can talk about riyaz, playlists and starting out in music.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Playing copyrighted songs for the whole video', 'Promises like “become a star”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं गाता/गाती हूँ और [वाद्य] बजाता/बजाती हूँ।”',
        '“कोई गाना सीखना है या आवाज़ सुधारनी है? कॉल करें।”',
        '“रियाज़, प्लेलिस्ट और संगीत में शुरुआत के बारे में मुझसे बात करें।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'पूरे वीडियो में किसी और का गाना चलाना', '“आप स्टार बन जाएँगे” जैसे वादे'],
    ),
  },
  'beauty': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I talk about skin, hair and makeup.”',
        '“Tell me your skin type and I will suggest a simple routine.”',
        '“Budget-friendly tips for everyday and wedding looks.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Medical claims or promises like “spotless skin in 3 days”', 'Selling products'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं स्किन, बाल और मेकअप पर बात करती/करता हूँ।”',
        '“अपनी स्किन का टाइप बताइए, मैं आसान रूटीन बताऊँगी/बताऊँगा।”',
        '“रोज़ के और शादी के लुक के लिए बजट में टिप्स।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'दवा जैसे दावे या “3 दिन में बेदाग़ त्वचा” जैसे वादे', 'प्रोडक्ट बेचना'],
    ),
  },
  'tech': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I help with phones, apps and gadgets.”',
        '“Confused which phone or laptop to buy? Call me.”',
        '“I explain tech in simple words.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Asking for passwords, OTPs or bank details', 'Promises like “I can hack anything”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं फ़ोन, ऐप और गैजेट में मदद करता/करती हूँ।”',
        '“कौन-सा फ़ोन या लैपटॉप लें, समझ नहीं आ रहा? कॉल करें।”',
        '“मैं टेक्नोलॉजी आसान शब्दों में समझाता/समझाती हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'पासवर्ड, OTP या बैंक की जानकारी माँगना', '“मैं कुछ भी हैक कर सकता हूँ” जैसी बातें'],
    ),
  },
  'comedy': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. Call me for a good laugh.”',
        '“Had a bad day? Let me cheer you up.”',
        '“I do mimicry, jokes and funny stories.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Jokes about religion, caste or anyone’s body', 'Abusive words'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। हँसने का मन हो तो मुझे कॉल करें।”',
        '“दिन बुरा गया? मैं आपका मूड ठीक कर दूँगा/दूँगी।”',
        '“मैं मिमिक्री, चुटकुले और मज़ेदार किस्से सुनाता/सुनाती हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'धर्म, जाति या किसी के शरीर पर मज़ाक', 'गाली-गलौज'],
    ),
  },
  'spirituality': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I talk about meditation and inner peace.”',
        '“Feeling restless or lost? Let us talk calmly.”',
        '“I share what I have learned from [practice or teacher].”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Claiming miracles or special powers', 'Asking for donations outside the app'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं ध्यान और मन की शांति पर बात करता/करती हूँ।”',
        '“बेचैन हैं या रास्ता नहीं सूझ रहा? शांति से बात करते हैं।”',
        '“मैंने [साधना या गुरु] से जो सीखा, वह साझा करूँगा/करूँगी।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'चमत्कार या ख़ास शक्तियों का दावा', 'ऐप के बाहर दान माँगना'],
    ),
  },
  'career': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I have worked in [field] for [N] years.”',
        '“Confused about your next job or course? Let us talk.”',
        '“I can help with your CV, interviews and switching careers.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Promises like “I will get you a job”', 'Asking for money for a job outside the app'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं [क्षेत्र] में [N] साल से काम कर रहा/रही हूँ।”',
        '“अगली नौकरी या कोर्स को लेकर उलझन है? बात करते हैं।”',
        '“CV, इंटरव्यू और करियर बदलने में मैं मदद कर सकता/सकती हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', '“मैं आपको नौकरी दिला दूँगा” जैसे वादे', 'नौकरी के नाम पर ऐप के बाहर पैसे माँगना'],
    ),
  },
  'health_wellness': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I talk about healthy habits, sleep and stress.”',
        '“Small daily changes can make a big difference. Let me show you.”',
        '“I share simple food, yoga and routine ideas.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Diagnosing illness or recommending medicines', 'Promises like “this will cure you”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं अच्छी आदतों, नींद और तनाव पर बात करता/करती हूँ।”',
        '“रोज़ के छोटे बदलाव बड़ा फ़र्क़ लाते हैं। मैं बताऊँगा/बताऊँगी।”',
        '“मैं खाने, योग और दिनचर्या के आसान आइडिया साझा करता/करती हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'बीमारी बताना या दवा सुझाना', '“इससे आप ठीक हो जाएँगे” जैसे वादे'],
    ),
  },
  'language': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I help people speak [language] with confidence.”',
        '“Call me to practise talking. No shame, no judgement.”',
        '“I can help with spoken English, interviews and daily conversation.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Promises like “fluent in 7 days”', 'Asking students to pay outside the app'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं [भाषा] आत्मविश्वास से बोलना सिखाता/सिखाती हूँ।”',
        '“बोलने की प्रैक्टिस के लिए कॉल करें। कोई शर्म नहीं, कोई जजमेंट नहीं।”',
        '“स्पोकन इंग्लिश, इंटरव्यू और रोज़ की बातचीत में मैं मदद कर सकता/सकती हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', '“7 दिन में फ़र्राटेदार” जैसे वादे', 'ऐप के बाहर पैसे माँगना'],
    ),
  },
  'gaming': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I play [game] and love talking strategy.”',
        '“Want to improve your rank? Call me for tips.”',
        '“I can help you choose a phone or setup for gaming.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Selling accounts, hacks or top-ups', 'Promises like “I will boost your rank for sure”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं [गेम] खेलता/खेलती हूँ और स्ट्रैटेजी पर बात करना पसंद है।”',
        '“रैंक सुधारनी है? टिप्स के लिए कॉल करें।”',
        '“गेमिंग के लिए फ़ोन या सेटअप चुनने में मैं मदद कर सकता/सकती हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'अकाउंट, हैक या टॉप-अप बेचना', '“रैंक पक्का बढ़ा दूँगा” जैसे वादे'],
    ),
  },
  'other': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. Here is what I can talk to you about: [your topic].”',
        '“If you are curious about [your topic], call me.”',
        '“I am happy to answer your questions.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Romantic or sexual talk', 'Promises like “100% guaranteed”'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं आपसे [अपने विषय] पर बात कर सकता/सकती हूँ।”',
        '“अगर आपको [अपने विषय] में दिलचस्पी है, तो मुझे कॉल करें।”',
        '“आपके सवालों के जवाब देकर मुझे खुशी होगी।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'रोमांटिक या अश्लील बातें', '“100% गारंटी” जैसे वादे'],
    ),
  },
  'listener': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. If you need someone to listen, I’m here.”',
        '“Share what is on your mind. I will listen without judging.”',
        '“I am not a doctor or a counsellor, just a caring listener.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Medical or mental-health treatment advice', 'Romantic or sexual talk'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। अगर आपको कोई सुनने वाला चाहिए, तो मैं यहाँ हूँ।”',
        '“जो मन में है, बताइए। मैं बिना जज किए सुनूँगा/सुनूँगी।”',
        '“मैं डॉक्टर या काउंसलर नहीं हूँ, बस एक परवाह करने वाला सुनने वाला/वाली हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'इलाज या मानसिक सेहत की दवा की सलाह', 'रोमांटिक या अश्लील बातें'],
    ),
  },
  'prayer': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. I can pray with you, say the rosary with you, pray for your family.”',
        '“What you give supports my time.”',
        '“Call me when you want to pray together in peace.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Promising miracles, cures or that a prayer will surely work', 'Asking for donations outside the app'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। मैं आपके साथ प्रार्थना कर सकता/सकती हूँ, माला जप सकता/सकती हूँ, आपके परिवार के लिए प्रार्थना कर सकता/सकती हूँ।”',
        '“आप जो देते हैं, वह मेरे समय का सहयोग है।”',
        '“जब शांति से साथ प्रार्थना करना चाहें, मुझे कॉल करें।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'चमत्कार, इलाज या “प्रार्थना ज़रूर असर करेगी” जैसे वादे', 'ऐप के बाहर दान माँगना'],
    ),
  },
  'virtual_friend': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. Want a friendly chat? Call me.”',
        '“We can talk about your day, movies, music or anything fun.”',
        '“A friend to talk to, simple and friendly.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Romantic, flirty or sexual talk', 'Asking to meet in person'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। दोस्ताना बातचीत करनी है? मुझे कॉल करें।”',
        '“हम आपके दिन, फ़िल्मों, गानों या किसी भी मज़ेदार चीज़ पर बात कर सकते हैं।”',
        '“बात करने के लिए एक दोस्त, सीधा और दोस्ताना।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'रोमांटिक, फ़्लर्ट वाली या अश्लील बातें', 'मिलने के लिए कहना'],
    ),
  },
  'women_to_women': {
    'en': OnbHint(
      say: [
        '“Hi, I’m [your name]. This is a space where women can talk freely with a woman.”',
        '“Share what is on your mind. It stays between us.”',
        '“I can talk about [your topic] as one woman to another.”',
      ],
      avoid: ['Phone numbers, links or social media handles', 'Sharing other people’s private details', 'Romantic or sexual talk'],
    ),
    'hi': OnbHint(
      say: [
        '“नमस्ते, मैं [अपना नाम] हूँ। यहाँ महिलाएँ एक महिला से खुलकर बात कर सकती हैं।”',
        '“जो मन में है, बताइए। यह बात हमारे बीच रहेगी।”',
        '“मैं एक महिला के तौर पर [अपने विषय] पर बात कर सकती हूँ।”',
      ],
      avoid: ['फ़ोन नंबर, लिंक या सोशल मीडिया हैंडल', 'दूसरों की निजी बातें बताना', 'रोमांटिक या अश्लील बातें'],
    ),
  },
};
