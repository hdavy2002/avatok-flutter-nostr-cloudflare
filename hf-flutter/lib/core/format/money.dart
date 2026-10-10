/// Money and token formatting. The server sends integers (paise, micro-tokens) or already-computed
/// rupee numbers; the app only DISPLAYS them. No balance, price or fee is ever computed on the phone.
///
/// - 1 rupee = 100 paise. Rupees use Indian digit grouping (12,34,567).
/// - 1 token = 1,000,000 micro-tokens. Tokens show 2 decimals, rounded half up on the integer.
abstract final class Money {
  /// Paise to rupees: `1250` -> `₹12.50`, `1200` -> `₹12`, `-500` -> `-₹5`.
  static String paise(int paise) {
    final negative = paise < 0;
    final abs = paise.abs();
    final rupees = abs ~/ 100;
    final rest = abs % 100;
    final body = rest == 0 ? _group(rupees) : '${_group(rupees)}.${rest.toString().padLeft(2, '0')}';
    return '${negative ? '-' : ''}₹$body';
  }

  /// A rupee amount the server already computed (a `num` from JSON, like `spentToday`): whole rupees
  /// show without decimals, anything else with 2. Converted to paise with one rounding step.
  static String rupees(num rupees) => paise((rupees * 100).round());

  /// Micro-tokens to tokens with 2 decimals: `45200000` -> `45.20`, `999999` -> `1.00`.
  static String microTokens(int micro) {
    final negative = micro < 0;
    final abs = micro.abs();
    // Round half up to 2 decimals on the integer: add half of 10,000 micro, then divide.
    final hundredths = (abs + 5000) ~/ 10000;
    final whole = hundredths ~/ 100;
    final frac = (hundredths % 100).toString().padLeft(2, '0');
    // A value that rounds to 0.00 never shows a minus sign.
    final sign = negative && hundredths != 0 ? '-' : '';
    return '$sign${_group(whole)}.$frac';
  }

  /// A token amount the server sent as a `num` (for example `45.2`): 2 decimals.
  static String tokens(num tokens) => microTokens((tokens * 1000000).round());

  /// `3 tokens` / `1 token` / `0.50 tokens`: the unit word follows the shown number.
  static String tokensWithUnit(num tokens) {
    final text = Money.tokens(tokens);
    return text == '1.00' ? '$text token' : '$text tokens';
  }

  /// Seconds as a call clock: `65` -> `01:05`, `3725` -> `1:02:05`.
  static String clock(int seconds) {
    final s = seconds < 0 ? 0 : seconds;
    final h = s ~/ 3600;
    final m = (s % 3600) ~/ 60;
    final sec = s % 60;
    final mm = m.toString().padLeft(2, '0');
    final ss = sec.toString().padLeft(2, '0');
    return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
  }

  /// Plain-English duration for a call summary: `65` -> `1 min 5 s`, `600` -> `10 min`, `40` -> `40 s`.
  static String duration(int seconds) {
    final s = seconds < 0 ? 0 : seconds;
    final m = s ~/ 60;
    final sec = s % 60;
    if (m == 0) return '$sec s';
    if (sec == 0) return '$m min';
    return '$m min $sec s';
  }

  /// Indian grouping: last three digits, then groups of two.
  static String _group(int n) {
    final s = n.toString();
    if (s.length <= 3) return s;
    final last3 = s.substring(s.length - 3);
    var head = s.substring(0, s.length - 3);
    final parts = <String>[];
    while (head.length > 2) {
      parts.insert(0, head.substring(head.length - 2));
      head = head.substring(0, head.length - 2);
    }
    if (head.isNotEmpty) parts.insert(0, head);
    return '${parts.join(',')},$last3';
  }
}
