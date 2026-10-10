/// Account-scoped local state.
///
/// STANDARD: all per-user local state is account-scoped. One phone is routinely shared by several
/// accounts, so a store keyed by one global key leaks data between them. Every SharedPreferences or
/// secure-storage key that holds USER data goes through [scopedKey]. The only exceptions are
/// device-level, account-agnostic values: the Clerk client token, and public caches such as the
/// host list (it is the same for everybody).
///
/// Trimmed from the avaTOK app's core/account_storage.dart. The legacy-key migration is gone: this
/// app has no pre-scoping data to claim.
abstract final class AccountScope {
  /// The active Clerk user id, or null when signed out (guest).
  static String? id;
}

/// The namespace used when no account is active (guest browsing).
const String kGuestScope = 'guest';

/// `<base>_<clerk user id>`, or `<base>_guest` when signed out. Never returns the raw [base].
String scopedKey(String base) {
  final id = AccountScope.id;
  return (id == null || id.isEmpty) ? '${base}_$kGuestScope' : '${base}_$id';
}
