import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session.dart';
import '../../../core/format/money.dart';
import '../../explore/data/host_options.dart' show noAutoRetry;
import '../../wallet/wallet_providers.dart';

/// The balance on the Discover wallet pill ("₹342"), or null for a guest and whenever it cannot be read
/// (the pill then just says "Wallet"). Read live from `GET /api/hf/wallet`, never cached (money is never cached).
/// It never throws, and never retries on its own: the pill is a shortcut, the Wallet screen is the truth.
final homeBalanceProvider = FutureProvider.autoDispose<String?>(
  retry: noAutoRetry,
  (ref) async {
    final signedIn = ref.watch(sessionProvider.select((s) => s.isSignedIn));
    if (!signedIn) return null;
    try {
      final w = await ref.watch(walletApiProvider).wallet();
      if (!w.tokenMode) return Money.rupees(w.spendable);
      final text = w.availableText;
      return '₹${text.endsWith('.00') ? text.substring(0, text.length - 3) : text}';
    } catch (_) {
      return null;
    }
  },
);
