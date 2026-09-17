import 'package:flutter/widgets.dart';

class UiLocale {
  final String code, nativeName, script;
  final bool rtl;
  const UiLocale(this.code, this.nativeName, this.script, [this.rtl = false]);
  Locale get locale {
    final parts = code.split('-');
    return Locale.fromSubtags(languageCode: parts.first,
        scriptCode: parts.length > 1 ? parts[1] : script);
  }
}
const uiLocales = <UiLocale>[
  UiLocale('en', 'English', 'Latn'),
  UiLocale('hi-Latn', 'Hinglish', 'Latn'),
  UiLocale('as', 'অসমীয়া', 'Beng'),
  UiLocale('bn', 'বাংলা', 'Beng'),
  UiLocale('brx', 'बड़ो', 'Deva'),
  UiLocale('doi', 'डोगरी', 'Deva'),
  UiLocale('gu', 'ગુજરાતી', 'Gujr'),
  UiLocale('hi', 'हिन्दी', 'Deva'),
  UiLocale('kn', 'ಕನ್ನಡ', 'Knda'),
  UiLocale('ks', 'کٲشُر', 'Arab', true),
  UiLocale('kok', 'कोंकणी', 'Deva'),
  UiLocale('mai', 'मैथिली', 'Deva'),
  UiLocale('ml', 'മലയാളം', 'Mlym'),
  UiLocale('mni', 'ꯃꯤꯇꯩ ꯂꯣꯟ', 'Mtei'),
  UiLocale('mr', 'मराठी', 'Deva'),
  UiLocale('ne', 'नेपाली', 'Deva'),
  UiLocale('or', 'ଓଡ଼ିଆ', 'Orya'),
  UiLocale('pa', 'ਪੰਜਾਬੀ', 'Guru'),
  UiLocale('sa', 'संस्कृतम्', 'Deva'),
  UiLocale('sat', 'ᱥᱟᱱᱛᱟᱲᱤ', 'Olck'),
  UiLocale('sd', 'سنڌي', 'Arab', true),
  UiLocale('ta', 'தமிழ்', 'Taml'),
  UiLocale('te', 'తెలుగు', 'Telu'),
  UiLocale('ur', 'اردو', 'Arab', true),
  UiLocale('bho', 'भोजपुरी', 'Deva'),
  UiLocale('awa', 'अवधी', 'Deva'),
];
UiLocale uiLocale(String code) =>
    uiLocales.firstWhere((v) => v.code == code, orElse: () => uiLocales.first);
