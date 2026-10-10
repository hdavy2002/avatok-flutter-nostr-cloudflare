// Pure rules of onboarding part B, copied from the website (`web/src/islands/host-onboarding/data.ts`) and the
// worker (`worker/src/lib/hf_options.ts`, `hf_intro.ts`). No widgets: unit-tested.

// ---------------------------------------------------------------------------------------------
// About you
// ---------------------------------------------------------------------------------------------

final RegExp _nameRe = RegExp(r'^[A-Za-zऀ-ॿ ]{2,20}$');

/// First name: 2 to 20 letters (Latin or Devanagari) and spaces. No numbers or symbols.
bool isValidFirstName(String name) => _nameRe.hasMatch(name.trim());

const int kAboutMin = 40;
const int kAboutMax = 500;
const int kMaxTopics = 6;
const int kMaxLanguages = 6;

final RegExp _phoneLike = RegExp(r'\d[\d\s-]{5,}\d');
final RegExp _linkLike = RegExp(r'@|https?:|www\.|\.com\b|\.in\b', caseSensitive: false);
final RegExp _appNames = RegExp(r'\b(whats\s?app|insta(gram)?|facebook|fb|snap(chat)?|telegram|upi|paytm|gpay)\b', caseSensitive: false);

/// Text a caller must never see: numbers, emails, links, social handles, app and payment names.
/// Returns the friendly message to show, or null when the text is fine. The worker checks again.
String? contactLeakMessage(String text) {
  if (_phoneLike.hasMatch(text)) return 'Please remove phone numbers.';
  if (_linkLike.hasMatch(text)) return 'Please remove emails, links or @handles.';
  if (_appNames.hasMatch(text)) return 'Please do not mention apps or payment IDs.';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Style, days, price
// ---------------------------------------------------------------------------------------------

/// A conversation style: the value the worker stores, the label the host sees and a one-line help.
class StyleChoice {
  const StyleChoice(this.slug, this.label, this.help);
  final String slug;
  final String label;
  final String help;
}

const List<StyleChoice> kStyleChoices = <StyleChoice>[
  StyleChoice('warm', 'Steady & encouraging', 'You help people feel they can do it.'),
  StyleChoice('energetic', 'Cheerful & chatty', 'You bring energy and love a long talk.'),
  StyleChoice('calm', 'Calm listener', 'You listen well and speak softly.'),
  StyleChoice('playful', 'Funny & light', 'You make people smile, even on a bad day.'),
  StyleChoice('straightforward', 'Straight-talking', 'You are honest and give clear advice.'),
  StyleChoice('thoughtful', 'Gentle & patient', 'You take your time and never rush anyone.'),
];

/// Day 0 is Monday: the worker stores `hours.days` as numbers 0 to 6.
const List<String> kDayLabels = <String>['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const int kDefaultPrice = 20;
const List<int> kQuickPrices = <int>[10, 15, 20, 25, 30];

/// What the host earns per minute, in paise: the platform keeps Rs 2 and 40% of the rest (HF-PAY-6), so the host
/// gets 60% of the amount above Rs 2. Whole paise, no floating point: Rs 20 gives 1080 paise.
int hostSharePaise(int pricePerMin) => pricePerMin <= 2 ? 0 : (pricePerMin - 2) * 60;

/// Paise as rupees text: `1080` -> `Rs 10.80`, `1000` -> `Rs 10`. Uses the rupee sign.
String rupeesFromPaise(int paise) {
  final whole = paise ~/ 100;
  final rest = paise % 100;
  if (rest == 0) return '₹$whole';
  return '₹$whole.${rest.toString().padLeft(2, '0')}';
}

String rupeesText(int rupees) => '₹$rupees';

/// `HH:MM` for the worker.
String hhmm(int hour, int minute) => '${hour.toString().padLeft(2, '0')}:${minute.toString().padLeft(2, '0')}';

final RegExp _hhmmRe = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');

/// A valid `HH:MM`, or [fallback].
String validHhmm(Object? v, String fallback) {
  final s = (v ?? '').toString();
  return _hhmmRe.hasMatch(s) ? s : fallback;
}

// ---------------------------------------------------------------------------------------------
// Voice introduction
// ---------------------------------------------------------------------------------------------

const int kVoiceMinSeconds = 30;
const int kVoiceMaxSeconds = 300;
const int kVoiceSuggestSeconds = 60;

enum VoiceLength { ok, tooShort, tooLong }

/// The worker rounds the length to whole seconds and wants 30 to 300. The phone checks first, so a clip the
/// server would refuse is never uploaded.
VoiceLength checkVoiceSeconds(num seconds) {
  final s = seconds.round();
  if (s < kVoiceMinSeconds) return VoiceLength.tooShort;
  if (s > kVoiceMaxSeconds) return VoiceLength.tooLong;
  return VoiceLength.ok;
}

/// `65` -> `1:05`.
String mmss(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

// ---------------------------------------------------------------------------------------------
// Making the profile
// ---------------------------------------------------------------------------------------------

/// The three stages of the profile job, in order.
const List<String> kGenerationStages = <String>['text', 'images', 'safety'];

/// The step to open for a `missing` entry that the worker names (`profile_incomplete`, `incomplete`).
String? stepForMissing(String key) {
  switch (key) {
    case 'aadhaar':
      return 'aadhaar';
    case 'selfie':
      return 'selfie';
    case 'payout':
      return 'payout';
    case 'avatar':
      return 'avatar';
    case 'displayName':
    case 'about':
    case 'profile':
      return 'about';
    case 'conversationLang':
    case 'languages':
      return 'languages';
    case 'topics':
      return 'topics';
    case 'agreements':
      return 'review';
    case 'voice':
      return 'voice';
    case 'media':
      return 'generating';
  }
  return null;
}
