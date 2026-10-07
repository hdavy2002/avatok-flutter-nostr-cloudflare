// GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.
// To change the brand name or domain, edit Specs/brand.json and re-run the script.

/// Public brand name and domain. See Specs/brand.json.
abstract final class Brand {
  static const String name = 'Hello Fraands';
  static const String nameUpper = 'HELLO FRAANDS';
  static const String nameCompact = 'Hello Fraands';
  static const String slug = 'aumfe';
  static const String nameHindi = 'हेलो फ़्रैंड्स';
  static const String slogan = 'Real people. Baat se baat banti hai.';
  static const String nameMeaningShort = 'Hello Fraands is a friendly hello and an invitation to talk to a real person in your language.';
  static const String nameMeaningLong = 'Hello Fraands is our way of saying you can start a conversation. Talk to a real person in your language about everyday life, with a clear per-minute price and a call connection that keeps personal phone numbers private. The site is a preview while calling and verification are being prepared.';
  static const String domain = 'hellofraands.com';
  static const String webOrigin = 'https://hellofraands.com';
  static const String apiHost = 'api.hellofraands.com';
  static const String mediaHost = 'media.hellofraands.com';
  static const String mediaOrigin = 'https://media.hellofraands.com';
  static const String authHost = 'clerk.aumfe.com';
  static const String mailHost = 'mail.aumfe.com';
  /// Former domains. Their api./media. hosts stay attached forever.
  static const List<String> legacyDomains = <String>['saathum.com', 'aumfe.com'];
  static const List<String> legacyMediaHosts = <String>['media.saathum.com', 'media.aumfe.com'];
  static const List<String> legacyApiHosts = <String>['api.saathum.com', 'api.aumfe.com'];
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
