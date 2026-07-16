import '../../avatok/contacts.dart';
import '../contact_overrides.dart';
import '../device_contacts.dart';
import 'inbox_api.dart';

/// [AVAINBOX-1] Canonical caller-name resolver for the AvaDial Inbox surface
/// (owner report 2026-07-16, pic3: "All these guys are part of my contacts
/// and yet it says 'unknown callers'").
///
/// ROOT CAUSE this replaces: `inbox_list_screen.dart`'s `_labelFor` and
/// `inbox_thread_screen.dart`'s `_title` each duplicated the SAME lookup
/// (override → device contact → fallback), and NEITHER ever consulted
/// [ContactsStore] — the actual AvaTOK contact book. `DeviceContacts` and
/// [ContactOverrides] are indexed by PHONE NUMBER only, so any thread whose
/// `callerKey` is a bare AvaTOK uid (a business-call voicemail,
/// `voicemail_<owner>__<callerUid>`, do/voicemail_room.ts) had NO client-side
/// lookup at all and fell straight through to whatever `caller_name` the
/// server stamped — frequently null, rendering "Unknown caller" for someone
/// who is, in fact, a saved AvaTOK contact.
///
/// SEPARATE, ALSO-FIXED-HERE gap found while diagnosing the above: PSTN missed-
/// call voicemails (worker/src/routes/pstn.ts `handleRecordCb`) use
/// `conv = voicemail_<owner>__<sanitizeKey(phone)>` — the caller-key segment is
/// a SANITIZED phone (not `tel:<E.164>`), so [InboxThread.isTel]/[telPhone]
/// (which require the literal `tel:` prefix) are both false for these threads,
/// even though the envelope carries a perfectly good `caller_phone`. Without a
/// phone number, no phone-keyed lookup (override/contacts/device) could ever
/// run for a PSTN voicemail. This resolver additionally reads [InboxCard
/// .callerPhone] as a phone source, not just [InboxThread.telPhone], so this
/// class of thread ALSO gets a real contact-name lookup.
///
/// Priority (owner-specified order): [ContactOverrides] rename (phone-keyed)
/// → [ContactsStore] by uid (bare-uid business-voicemail threads) →
/// [ContactsStore] by normalized phone/AvaTOK number → [DeviceContacts] →
/// server-stamped `caller_name` → formatted E.164 → "Unknown caller".
///
/// NOTE for AVANOTIF-VM-1 (reconcile): that lane is independently building a
/// similar resolution chain for the missed-call/voicemail PUSH NOTIFICATION
/// path (a different surface — no BuildContext, no live ContactsStore
/// subscription available at push-receive time). This class owns the INBOX
/// list/thread screens only; the two chains should be reconciled (or one
/// should delegate to the other) in a follow-up rather than silently drifting.
class ResolvedCallerName {
  final String name;
  /// Which tier won — proven out in telemetry (`inbox_name_resolution`) so we
  /// can see in PostHog whether this fix is actually landing in production,
  /// not just reading it off DEFAULTS/local code (CLAUDE.md Rule 1).
  final String tier; // override | contacts_uid | contacts_phone | device_contacts | server | formatted_number | anonymous | unknown
  const ResolvedCallerName(this.name, this.tier);

  bool get isFallback => tier == 'unknown';
}

class InboxCallerName {
  InboxCallerName._();

  /// Resolves the best display name for [thread]. Pass [card] to resolve a
  /// SPECIFIC card's caller (a thread can, in principle, carry cards with
  /// slightly different caller_phone/caller_name stamps); defaults to the
  /// thread's latest card. Pass a pre-loaded [contactsCache] (from
  /// `ContactsStore().load()`) when resolving MANY threads in a loop so each
  /// one doesn't re-hit disk — see `inbox_list_screen.dart`'s `_loadThreads`.
  static Future<ResolvedCallerName> resolve({
    required InboxThread thread,
    InboxCard? card,
    List<Contact>? contactsCache,
  }) async {
    if (thread.isAnonymous) {
      return const ResolvedCallerName('Hidden number', 'anonymous');
    }

    final effectiveCard = card ?? (thread.cards.isNotEmpty ? thread.latest : null);
    final phone = thread.telPhone ??
        (effectiveCard?.callerPhone != null && effectiveCard!.callerPhone!.trim().isNotEmpty
            ? effectiveCard.callerPhone
            : null);
    // A bare AvaTOK uid only when the thread is neither `tel:` nor `anon_` —
    // see InboxThread.callerKey doc (business-call voicemail case).
    final uid = (!thread.isTel && !thread.isAnonymous && (thread.callerKey ?? '').isNotEmpty)
        ? thread.callerKey
        : null;

    // 1) ContactOverrides rename — phone-keyed, wins over everything (the
    //    user explicitly renamed this caller from the thread/card menu).
    if (phone != null && phone.isNotEmpty) {
      try {
        final o = await ContactOverrides.I.forNumber(phone);
        final name = o?.displayName;
        if (name != null && name.trim().isNotEmpty) {
          return ResolvedCallerName(name.trim(), 'override');
        }
      } catch (_) {/* fall through */}
    }

    List<Contact> contacts;
    try {
      contacts = contactsCache ?? await ContactsStore().load();
    } catch (_) {
      contacts = contactsCache ?? const [];
    }

    // 2) ContactsStore by uid — the missing lookup that caused "Unknown
    //    caller" for business-voicemail threads from a saved AvaTOK contact.
    if (uid != null) {
      for (final c in contacts) {
        if (c.uid == uid && c.name.trim().isNotEmpty) {
          return ResolvedCallerName(c.name.trim(), 'contacts_uid');
        }
      }
    }

    // 3) ContactsStore by normalized phone/AvaTOK number.
    if (phone != null && phone.isNotEmpty) {
      final key = DeviceContacts.normKey(phone);
      for (final c in contacts) {
        final matchesPhone = c.phone.isNotEmpty && DeviceContacts.normKey(c.phone) == key;
        final matchesNumber = c.number.isNotEmpty && DeviceContacts.normKey(c.number) == key;
        if ((matchesPhone || matchesNumber) && c.name.trim().isNotEmpty) {
          return ResolvedCallerName(c.name.trim(), 'contacts_phone');
        }
      }
    }

    // 4) DeviceContacts (OS phone book) — the ORIGINAL lookup this resolver
    //    replaces, kept as a lower-priority tier since ContactsStore (the
    //    AvaTOK-native book) is the more authoritative source for AvaTOK use.
    if (phone != null && phone.isNotEmpty) {
      final dc = DeviceContacts.I.lookup(phone);
      final name = dc?.name;
      if (name != null && name.trim().isNotEmpty) {
        return ResolvedCallerName(name.trim(), 'device_contacts');
      }
    }

    // 5) Server-stamped caller_name (receptionist call summary / legacy rows).
    final serverName = effectiveCard?.callerName;
    if (serverName != null && serverName.trim().isNotEmpty) {
      return ResolvedCallerName(serverName.trim(), 'server');
    }

    // 6) Formatted E.164 — a real number beats "Unknown caller".
    if (phone != null && phone.isNotEmpty) {
      return ResolvedCallerName(phone, 'formatted_number');
    }

    return const ResolvedCallerName('Unknown caller', 'unknown');
  }
}
