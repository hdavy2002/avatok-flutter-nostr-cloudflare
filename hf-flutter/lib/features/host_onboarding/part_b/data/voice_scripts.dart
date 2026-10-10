/// Example scripts for the voice introduction, copied word for word from the website
/// (`web/src/islands/host-onboarding/data.ts` VOICE_SCRIPTS). The names are examples only: the host says their own
/// first name. Hindi first, then English.
class VoiceScriptSet {
  const VoiceScriptSet({required this.code, required this.label, required this.items});

  /// `hi` or `en`.
  final String code;
  final String label;
  final List<String> items;
}

const List<VoiceScriptSet> kVoiceScripts = <VoiceScriptSet>[
  VoiceScriptSet(
    code: 'hi',
    label: 'हिंदी',
    items: <String>[
      'नमस्ते, मैं प्रिया हूँ। मैं हिंदी और अंग्रेज़ी में बात करती हूँ। मुझे लोगों की बातें सुनना अच्छा लगता है — चाहे दिन खराब रहा हो, घर की याद आ रही हो, या बस किसी से बात करनी हो। मुझे फ़िल्में, गाने और खाना बनाना पसंद है। मैं ज़्यादातर शाम को ऑनलाइन रहती हूँ। जब भी मन करे, बेझिझक कॉल कीजिए — मैं सुनने के लिए यहाँ हूँ।',
      'नमस्ते, मेरा नाम अर्जुन है। मैं शांत स्वभाव का हूँ और ध्यान से सुनता हूँ। क्रिकेट, पुराने गाने, नौकरी की टेंशन या नए शहर का अकेलापन — किसी भी बारे में बात कर सकते हैं। मैं रात को देर तक जागता हूँ, तो देर शाम मुझसे बात करना आसान रहेगा।',
    ],
  ),
  VoiceScriptSet(
    code: 'en',
    label: 'English',
    items: <String>[
      "Hi, I'm Arjun. I speak English and Hindi. I'm a calm listener — if you've had a long day, feel lonely in a new city, or just want to chat about cricket or movies, I'd love to hear from you. I'm usually around late evenings. No pressure, no judgement — just a friendly conversation.",
      "Hello, I'm Meera. I love a good chat over chai — about books, family, work stress or anything on your mind. I speak English, Hindi and a little Marathi. I'm usually free in the afternoons. Call me whenever you need someone to talk to.",
    ],
  ),
];
