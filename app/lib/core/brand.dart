// GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.
// To change the brand name or domain, edit Specs/brand.json and re-run the script.

/// Public brand name and domain. See Specs/brand.json.
abstract final class Brand {
  static const String name = 'Aum Fe';
  static const String nameUpper = 'AUM FE';
  static const String nameCompact = 'Aum Fe';
  static const String slug = 'aumfe';
  static const String nameHindi = 'ॐ फ़े';
  static const String slogan = 'Faith, brought home to you.';
  static const List<String> previousNames = <String>['Saa Thum'];
  static const String nameMeaningShort = 'Aum (ॐ) is the sacred sound of the East; Fe is the word for faith in Spanish and Portuguese. Aum Fe is a meeting ground for East and West.';
  static const String nameMeaningLong = 'Our name joins two words from two worlds. Aum — written ॐ and also spoken as Om — is the ancient Sanskrit syllable that Hindu tradition holds as the sound at the heart of every prayer. Fe is the plain word for faith in Spanish and Portuguese. The East has Aum; the West speaks of faith. Aum Fe is where the two meet: a home for anyone, anywhere, who wants to take part in a havan or puja performed with devotion in the Himalayas.';
  static const String domain = 'aumfe.com';
  static const String webOrigin = 'https://aumfe.com';
  static const String apiHost = 'api.aumfe.com';
  static const String mediaHost = 'media.aumfe.com';
  static const String mediaOrigin = 'https://media.aumfe.com';
  static const String authHost = 'clerk.aumfe.com';
  static const String mailHost = 'mail.aumfe.com';
  /// Former domains. Their api./media. hosts stay attached forever.
  static const List<String> legacyDomains = <String>['saathum.com'];
  static const List<String> legacyMediaHosts = <String>['media.saathum.com'];
  static const List<String> legacyApiHosts = <String>['api.saathum.com'];
  static const String supportEmail = 'support@aumfe.com';
  static const String noreplyEmail = 'noreply@aumfe.com';
  static const String helloEmail = 'hello@aumfe.com';
  /// PERMANENT — a Play package id can never change.
  static const String playPackageId = 'com.saathum.app';

  /// Absolute URL on the public website.
  static String url([String path = '/']) =>
      webOrigin + (path.startsWith('/') ? path : '/$path');

  /// True for the brand domain and any subdomain of it.
  static bool isBrandHost(String host) {
    final h = host.toLowerCase();
    return h == domain || h.endsWith('.$domain');
  }

  /// True for the brand domain, any legacy domain, and subdomains of either.
  static bool isBrandOrLegacyHost(String host) {
    final h = host.toLowerCase();
    if (isBrandHost(h)) return true;
    return legacyDomains.any((d) => h == d || h.endsWith('.$d'));
  }
}
