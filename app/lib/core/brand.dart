// GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.
// To change the brand name or domain, edit Specs/brand.json and re-run the script.

/// Public brand name and domain. See Specs/brand.json.
abstract final class Brand {
  static const String name = 'Saa Thum';
  static const String nameUpper = 'SAA THUM';
  static const String nameCompact = 'Saathum';
  static const String slug = 'saathum';
  static const String nameHindi = 'सा थम';
  static const String slogan = 'Faith, brought home to you.';
  static const String domain = 'saathum.com';
  static const String webOrigin = 'https://saathum.com';
  static const String apiHost = 'api.saathum.com';
  static const String mediaHost = 'media.saathum.com';
  static const String mediaOrigin = 'https://media.saathum.com';
  static const String authHost = 'clerk.saathum.com';
  static const String mailHost = 'mail.saathum.com';
  /// Former domains. Their api./media. hosts stay attached forever.
  static const List<String> legacyDomains = <String>[];
  static const List<String> legacyMediaHosts = <String>[];
  static const List<String> legacyApiHosts = <String>[];
  static const String supportEmail = 'support@saathum.com';
  static const String noreplyEmail = 'noreply@saathum.com';
  static const String helloEmail = 'hello@saathum.com';
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
