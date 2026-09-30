import '../brand.dart';

/// [SAATHUM-BRAND-CENTRAL-I18N-1] Reserved brand tokens for UI catalog text.
/// Catalog copy writes `{brand}` etc.; they are filled here from [Brand]
/// (Specs/brand.json), so callers never pass them. Token table:
/// shared/i18n/README.md.
final Map<String, String> uiBrandTokens = <String, String>{
  'brand': Brand.nameCompact,
  'brandCompactUpper': Brand.nameCompact.toUpperCase(),
  'brandDomain': Brand.domain,
  'brandSupportEmail': Brand.supportEmail,
};

final RegExp _brandToken = RegExp(r'\{(brand[A-Za-z]*)\}');

String expandUiBrandTokens(String text) => text.replaceAllMapped(
    _brandToken, (m) => uiBrandTokens[m.group(1)!] ?? m.group(0)!);
