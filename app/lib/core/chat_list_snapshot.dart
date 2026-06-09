import '../features/avatok/contacts.dart';
import 'group_store.dart';

/// Tiny in-memory cache of the LAST-RENDERED chat list for the currently-open
/// app, so navigating away from AvaTok and back repaints synchronously (no blank
/// "No chats yet" flash) without re-reading anything.
///
/// Deliberately NOT a background pre-warm: pre-loading every AvaVerse app's data
/// into memory on launch wouldn't scale (memory bloat on cheap phones across many
/// apps). Cold-start speed instead comes from the persisted SQLite projection
/// (`Db.chatsOnce`), which the chat list reads on demand in a single indexed
/// query. This holds only the open app's working set and is seeded by the chat
/// list itself via [update]; it is empty on a true cold start (fresh process).
class ChatListSnapshot {
  static List<Contact> contacts = [];
  static List<Group> groups = [];
  static Map<String, ({String text, int ts, bool me})> previews = {};
  static Map<String, Set<String>> flags = {};
  static Map<String, int> lastRead = {};
  static bool has = false;

  /// The chat list calls this after its authoritative load to keep the snapshot
  /// fresh for the next open within this session.
  static void update({
    required List<Contact> contacts,
    required List<Group> groups,
    required Map<String, ({String text, int ts, bool me})> previews,
    required Map<String, Set<String>> flags,
    required Map<String, int> lastRead,
  }) {
    ChatListSnapshot.contacts = contacts;
    ChatListSnapshot.groups = groups;
    ChatListSnapshot.previews = previews;
    ChatListSnapshot.flags = flags;
    ChatListSnapshot.lastRead = lastRead;
    has = true;
  }
}
