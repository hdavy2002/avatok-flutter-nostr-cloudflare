/// Currency metadata used for displaying server-authored money snapshots.
///
/// The client never derives Tokens from a currency amount. This type only
/// formats an already-authoritative minor-unit value for presentation.
class MoneyCurrency {
  const MoneyCurrency({required this.code, required this.exponent, this.symbol});

  final String code;
  final int exponent;
  final String? symbol;

  static MoneyCurrency fromCode(String value, {int? exponent}) {
    final code = value.trim().toUpperCase();
    const defaults = <String, int>{
      'BHD': 3, 'CLP': 0, 'ISK': 0, 'JOD': 3, 'JPY': 0,
      'KMF': 0, 'KRW': 0, 'OMR': 3, 'PYG': 0, 'TND': 3,
      'UGX': 0, 'VND': 0, 'VUV': 0, 'XAF': 0, 'XOF': 0, 'XPF': 0,
    };
    const symbols = <String, String>{
      'EUR': '€', 'GBP': '£', 'INR': '₹', 'JPY': '¥', 'KRW': '₩',
      'USD': '\$',
    };
    return MoneyCurrency(
      code: code.isEmpty ? 'XXX' : code,
      exponent: exponent ?? defaults[code] ?? 2,
      symbol: symbols[code],
    );
  }

  String formatMinor(int minor) {
    final negative = minor < 0;
    final absolute = minor.abs();
    final base = _pow10(exponent);
    final whole = absolute ~/ base;
    final fraction = exponent == 0
        ? ''
        : '.${(absolute % base).toString().padLeft(exponent, '0')}';
    final grouped = _group(whole.toString());
    final prefix = symbol ?? '$code ';
    final value = '$prefix$grouped$fraction';
    return negative ? '-$value' : value;
  }

  static int _pow10(int exponent) {
    var result = 1;
    for (var i = 0; i < exponent; i++) result *= 10;
    return result;
  }

  static String _group(String value) {
    final out = StringBuffer();
    for (var i = 0; i < value.length; i++) {
      if (i > 0 && (value.length - i) % 3 == 0) out.write(',');
      out.write(value[i]);
    }
    return out.toString();
  }
}
