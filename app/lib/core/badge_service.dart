import 'dart:async';

import 'package:app_badge_plus/app_badge_plus.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../features/avadial/sms/sms_unread_store.dart';
import '../features/avatok/contacts.dart' show ContactsStore;
import '../features/avatok/unknown_caller.dart' show isReceptTelConv, phoneFromReceptConv;
import 'analytics.dart';
import 'chat_state.dart';
import 'db.dart';

/// [ISSUE-BADGE-UNREAD-1] The ONE owner of the launcher-icon badge.
///
/// Owner report (2026-07-14): "I don't have any notification or messages inside
/// AvaTOK, but this number is stuck on the icon." The badge used to be a PUSH
/// COUNTER — [bumpOptimistic]'s ancestor was incremented on every banner and only
/// ever reset to 0 by a TAP that landed on [ChatListScreen]. It never walked down
/// as threads were read, it never reconciled against reality, and with ShellV2
/// landing on AvaDial the chat list often never mounted at all, so it never
/// cleared either. A swipe-away left it stuck forever.
///
/// The required semantics are now enforced in exactly one place:
///
///     badge == (unread AvaTOK chat messages) + (unread AvaDialer SMS/OTP)
///
/// derived from the REAL stores every time [recompute] runs, so it rises as
/// messages arrive, falls as they're read, and reaches 0 when nothing is unread.
///
/// The two real sources:
///  • Chat  — the per-account drift DB ([Db.I], file `avatok_<scope>.sqlite`)
///    counted against [ReadStateStore] (`avatok_readstate`, a per-account
///    [DiskCache] file). Both are ALREADY scoped to the active account, so the
///    chat total can never leak another account's unread into the badge. This is
///    deliberately NOT `ChatListScreen._unread` — that map only exists while the
///    widget is mounted, which is the whole reason the badge got stuck.
///  • SMS   — [SmsUnreadStore], which reads the OS SMS provider live. Reused, not
///    duplicated; it resolves to 0 when `avaSms` is off or the SMS role/permission
///    isn't held, so a missing permission can never block the chat count.
///
/// The stored count itself stays DEVICE-level under the pre-existing global
/// `avatok_badge_count` key (the rulebook's explicit exception for device-level
/// values — the launcher badge is one OS affordance for the whole phone, and the
/// BACKGROUND FCM isolate, which has no [AccountScope], must be able to read and
/// bump it).
class BadgeService {
  BadgeService._();

  /// Unchanged on purpose — the background isolate reads/writes this same key.
  /// Device-level (NOT account-scoped): see the class doc.
  static const String kBadgeKey = 'avatok_badge_count';

  static const FlutterSecureStorage _store =
      FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false));

  /// EVERY notification id that AvaTOK posts with `number: count`. Android
  /// launchers read that `number` for the icon badge, so a lingering 8001/8002/
  /// 8003 used to re-assert a count even after `AppBadgePlus.updateBadge(0)` —
  /// the old `_clearBadge` only cancelled 8000. All four are cancelled together.
  ///  8000 = message · 8001 = group invite · 8002 = missed call · 8003 = now free
  static const List<int> notifIds = <int>[8000, 8001, 8002, 8003];

  /// `FlutterLocalNotificationsPlugin()` is a singleton factory, so this is the
  /// same instance PushService shows banners on — cancels land on the real ones.
  static final FlutterLocalNotificationsPlugin _local = FlutterLocalNotificationsPlugin();

  /// True ONLY while [runInBackgroundIsolate] is executing the FCM background
  /// entry point. In that isolate there is no app state, no [AccountScope] and no
  /// open drift DB, so [recompute] is impossible and [bumpOptimistic] is the only
  /// honest option.
  ///
  /// This used to be a public one-way latch (`inBackgroundIsolate = true`, never
  /// reset). Dart statics are per-isolate, so that was *usually* invisible — but
  /// `firebaseBackgroundHandler` is a plain top-level function and nothing
  /// guarantees the OS/plugin always dispatches it on a separate isolate. One run
  /// on the main isolate and every later [recompute] returned [peek] forever: the
  /// badge silently froze for the whole process lifetime, i.e. it would reproduce
  /// the very "stuck on 1" bug this class exists to fix. It is now private and
  /// strictly scoped to the handler's execution.
  static bool _inBackgroundIsolate = false;

  /// Whether we're inside the FCM background entry point (see [_inBackgroundIsolate]).
  static bool get inBackgroundIsolate => _inBackgroundIsolate;

  /// Run [body] as the FCM background handler: [recompute] is impossible for its
  /// duration, so the badge falls back to [bumpOptimistic]. The flag is cleared in
  /// a `finally` — including when [body] throws — so a handler that happens to run
  /// on the main isolate can never permanently disable the real badge.
  static Future<T> runInBackgroundIsolate<T>(Future<T> Function() body) async {
    _inBackgroundIsolate = true;
    try {
      return await body();
    } finally {
      _inBackgroundIsolate = false;
    }
  }

  // ── recompute serialisation ────────────────────────────────────────────────
  // [ISSUE-BADGE-UNREAD-1] `app_resumed`, `shell_entered`, `sms_incoming`,
  // `push_+3s`, `thread_marked_read` and `thread_closed` all fire independently
  // and routinely overlap. [_apply] is last-writer-wins, so a SLOWER, OLDER run
  // could land after a newer one and stamp a stale count onto the launcher — a
  // pre-read count surviving the read is, once again, indistinguishable from the
  // stuck badge. So: one run at a time, and trailing-edge only. Every request
  // takes a ticket ([_seq]); a queued run that finds a newer ticket has been
  // superseded and drops out WITHOUT writing (the newer run reads a strictly
  // fresher view of the same stores, so its answer is the right one).
  static int _seq = 0;
  static Future<int>? _inFlight;

  /// THE AUTHORITATIVE PATH. Computes `chatUnread + smsUnread` from the real
  /// stores, pushes it to the launcher, persists it under [kBadgeKey] and — when
  /// the total is 0 — cancels every badge-bearing notification.
  ///
  /// Serialised + trailing-edge debounced (see above). Concurrent callers get the
  /// last-known count back if they were superseded; the newest run always writes.
  ///
  /// Never throws. If a source can't be read (DB not open yet, cold-start tap
  /// before the account scope is set, …) the badge is left EXACTLY as it was
  /// rather than being blindly zeroed, and the next call corrects it.
  static Future<int> recompute({String source = 'unknown'}) {
    if (_inBackgroundIsolate) return peek(); // no app state here — cannot be truthful
    final seq = ++_seq;
    final prev = _inFlight;
    late final Future<int> f;
    f = () async {
      if (prev != null) {
        try {
          await prev;
        } catch (_) {/* a failed predecessor must not cancel us */}
      }
      // Superseded while we waited → the newer run supersedes our answer too.
      if (seq != _seq) return peek();
      try {
        return await _recomputeNow(source);
      } finally {
        if (identical(_inFlight, f)) _inFlight = null;
      }
    }();
    _inFlight = f;
    return f;
  }

  static Future<int> _recomputeNow(String source) async {
    ({int total, int convs, int skipped}) chat;
    int sms;
    try {
      chat = await _chatUnread();
    } catch (_) {
      return peek(); // leave the badge untouched rather than lie about it
    }
    try {
      sms = await _smsUnread(source);
    } catch (_) {
      sms = 0; // no SMS permission / role → contributes nothing, never blocks chat
    }
    final total = chat.total + sms;
    await _apply(total);
    unawaited(Analytics.capture('badge_recomputed', {
      'chat_unread': chat.total,
      'sms_unread': sms,
      'total': total,
      'source': source,
      // [ISSUE-BADGE-UNREAD-1] Diagnostics for the next "my badge is stuck"
      // report: how many conversations carried countable unread, and how many
      // were dropped as blocked / hidden / tombstoned. A badge that won't go to
      // zero WITH convs_with_unread > 0 means a real thread the owner can't find;
      // WITH skipped_convs > 0 means a hide rule here disagrees with chat_list.
      'convs_with_unread': chat.convs,
      'skipped_convs': chat.skipped,
    }));
    return total;
  }

  /// PROVISIONAL, BACKGROUND-ISOLATE ONLY. A +1 placeholder for the banner's
  /// `number:` field when we genuinely cannot see the truth (the FCM background
  /// isolate has no Dart app state / DB). It is NOT authoritative: the next
  /// foreground [recompute] — on app resume, on opening the chat list, or on any
  /// thread being marked read — overwrites whatever this wrote with the real
  /// count. Do not call it as a substitute for [recompute] in the foreground.
  static Future<int> bumpOptimistic() async {
    try {
      final cur = int.tryParse(await _store.read(key: kBadgeKey) ?? '0') ?? 0;
      final next = cur + 1;
      await _store.write(key: kBadgeKey, value: '$next');
      try {
        await AppBadgePlus.updateBadge(next);
      } catch (_) {}
      return next;
    } catch (_) {
      return 1;
    }
  }

  /// Force the badge to 0 and cancel all four badge-bearing notifications.
  /// Use only when 0 is known-correct (e.g. sign-out / account switch) — the
  /// normal "user opened the app" path is [recompute], which must be allowed to
  /// keep a non-zero badge when messages really are unread.
  static Future<void> clear() async {
    try {
      await _store.write(key: kBadgeKey, value: '0');
    } catch (_) {}
    try {
      await AppBadgePlus.updateBadge(0);
    } catch (_) {}
    await _cancelAllNotifs();
  }

  /// The last persisted count, without touching any source. Never throws.
  static Future<int> peek() async {
    try {
      return int.tryParse(await _store.read(key: kBadgeKey) ?? '0') ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /// Called from the notification-show sites for the banner's `number:`.
  ///
  /// The optimistic +1 is what the banner shows INSTANTLY (a pushed message has
  /// not reached the local DB yet — it lands a beat later over the InboxDO
  /// socket — so recomputing at this exact instant would read a stale, too-low
  /// count and hide the badge for the message we're literally showing). In the
  /// foreground we then schedule the authoritative [recompute] a few seconds
  /// later, once the message has actually landed, and it wins.
  static Future<int> bump(String source) async {
    final n = await bumpOptimistic();
    if (!inBackgroundIsolate) {
      unawaited(Future<void>.delayed(const Duration(seconds: 3),
          () => recompute(source: 'push_$source')));
    }
    return n;
  }

  // ── real sources ───────────────────────────────────────────────────────────

  /// Unread AvaTOK chat messages for the ACTIVE account, across all threads,
  /// straight from the store layer — no widget required.
  ///
  /// Unread = messages in [Messages] that are not [mine], whose [Messages.kind]
  /// is in [AppDb.kCountableKinds], and whose [createdAt] (epoch SECONDS) is newer
  /// than this conversation's [ReadStateStore] high-water mark (also epoch seconds
  /// — see `ChatThreadScreen._markRead`, which writes `now ~/ 1000`).
  ///
  /// THE GOVERNING RULE: a conversation may only contribute to the badge if the
  /// user can SEE a row for it and open it. Anything the chat list refuses to
  /// render is a count with no way to clear it — a permanently stuck badge, which
  /// is the exact symptom this whole issue is about. So we mirror every hide rule
  /// `ChatListScreen` applies:
  ///  • BLOCKED     — never renders a row.
  ///  • HIDDEN      — "Remove contact" hides the thread but KEEPS the messages
  ///    (`ContactsStore.hiddenThreads()`, uid → hidden-at MS). A newer message
  ///    resurrects the row, so the thread only stops counting while its newest
  ///    message predates the hide. Units differ (message ts is SECONDS, hiddenAt
  ///    is MILLIS) — normalised exactly as `chat_list.dart` does it.
  ///  • DELETED     — `deleteContact` tombstones the contact and drops the row,
  ///    but leaves every `Messages` row behind. Without this, the owner deleting
  ///    a test contact that had unread messages would get a permanently stuck
  ///    badge FROM the fix meant to unstick it.
  /// Muted/archived threads DO count (WhatsApp semantics — mute silences the
  /// banner, it doesn't hide the count; archived rows are still reachable).
  ///
  /// ONE grouped query + two small [DiskCache] reads, no matter how many
  /// conversations exist (this replaced an N+1 that ran a COUNT per conversation
  /// on every resume / cold start / thread close / SMS arrival).
  /// Returns the total plus the shape of how it was reached — [convs] is how many
  /// conversations had countable unread, [skipped] how many of those were dropped
  /// as blocked/hidden/tombstoned. `skipped > 0` with a stuck-badge report is the
  /// smoking gun for a hide rule drifting out of step with `chat_list.dart`, so
  /// it ships to PostHog on every recompute.
  static Future<({int total, int convs, int skipped})> _chatUnread() async {
    final lastRead = await ReadStateStore().load();
    final flags = await ChatFlagsStore().load();
    final blocked = flags['blocked'] ?? const <String>{};
    final store = ContactsStore();
    final deleted = await store.deletedContacts(); // uid → deleted-at ms
    final hidden = await store.hiddenThreads(); // uid → hidden-at ms
    final unread = await Db.I.unreadByConv(lastRead);
    if (unread.isEmpty) return (total: 0, convs: 0, skipped: 0);
    // Only paid for when something is actually unread AND something is hidden.
    final lastTs = hidden.isEmpty ? const <String, int>{} : await Db.I.lastTsByConv();
    var total = 0;
    var skipped = 0;
    for (final e in unread.entries) {
      final k = e.key;
      if (k.isEmpty || blocked.contains(k)) {
        skipped++;
        continue;
      }
      final uid = _peerUidOf(k);
      if (uid != null) {
        if (deleted.containsKey(uid)) {
          skipped++; // tombstoned — no row to open
          continue;
        }
        final hiddenAt = hidden[uid];
        if (hiddenAt != null) {
          // Mirrors chat_list.dart's rule verbatim, including the s → ms
          // normalisation (values below 100000000000 are epoch SECONDS).
          final ts = lastTs[k] ?? 0;
          final tsMs = ts > 0 && ts < 100000000000 ? ts * 1000 : ts;
          if (tsMs <= hiddenAt) {
            skipped++; // still hidden — no row to open
            continue;
          }
        }
      }
      total += e.value;
    }
    return (total: total, convs: unread.length, skipped: skipped);
  }

  /// The peer uid behind a conversation key, in the SAME form the hidden/deleted
  /// maps are keyed by (`ContactsStore` keys them by `Contact.uid`), or null for
  /// a real group thread (groups are never hidden/tombstoned this way).
  ///  • `1:<uid>`                     → `<uid>`
  ///  • `g:recept_<me>__tel:<phone>`  → `tel:<phone>`, the synthetic id a
  ///    phone-only receptionist caller is saved under (see `unknown_caller.dart`;
  ///    `chat_list.dart` maps the same contact to this conv key in reverse).
  static String? _peerUidOf(String convKey) {
    if (convKey.startsWith('1:')) return convKey.substring(2);
    if (!isReceptTelConv(convKey)) return null; // a real group thread
    final phone = phoneFromReceptConv(convKey);
    return phone == null ? null : 'tel:$phone';
  }

  // The OS SMS content-provider scan behind [SmsUnreadStore.refresh] is the most
  // expensive thing in a recompute, and it used to run on EVERY trigger — including
  // `thread_closed`, which cannot possibly have changed SMS state. Short TTL +
  // an explicit list of triggers that already refreshed or can't matter.
  static DateTime? _smsReadAt;
  static const Duration _smsTtl = Duration(seconds: 5);

  /// Triggers that JUST refreshed the store themselves — `SmsUnreadStore` awaits
  /// its own `refresh()` before calling us, so re-reading was one redundant full
  /// provider scan per inbound SMS and per mark-read. These also (re)stamp the TTL.
  static const Set<String> _smsJustRefreshed = <String>{
    'sms_incoming',
    'sms_thread_marked_read',
  };

  /// AvaTOK chat triggers. Reading/closing a chat thread cannot change the OS SMS
  /// store, and an SMS landing meanwhile fires `sms_incoming` on its own — so we
  /// reuse whatever [SmsUnreadStore.total] already holds and never scan. These do
  /// NOT stamp the TTL: they learned nothing new, so the next resume still reads.
  static const Set<String> _smsUnaffectedSources = <String>{
    'thread_marked_read',
    'thread_closed',
  };

  /// Unread AvaDialer SMS/OTP. Reuses [SmsUnreadStore] (the live OS-provider
  /// reader) rather than duplicating its logic; it already resolves to 0 when
  /// `avaSms` is off or the SMS role isn't held.
  static Future<int> _smsUnread(String source) async {
    final now = DateTime.now();
    final fresh = _smsReadAt != null && now.difference(_smsReadAt!) < _smsTtl;
    if (_smsJustRefreshed.contains(source)) {
      _smsReadAt = now; // the caller awaited refresh() immediately before us
    } else if (!_smsUnaffectedSources.contains(source) && !fresh) {
      await SmsUnreadStore.I.refresh();
      _smsReadAt = DateTime.now();
    }
    return SmsUnreadStore.I.total.value;
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  static Future<void> _apply(int total) async {
    final n = total < 0 ? 0 : total;
    Object? storeErr;
    Object? launcherErr;
    try {
      await _store.write(key: kBadgeKey, value: '$n');
    } catch (e) {
      storeErr = e;
    }
    try {
      await AppBadgePlus.updateBadge(n);
    } catch (e) {
      launcherErr = e;
    }
    // [BADGE-APPLY-OBS-1] Both writes above used to be `catch (_) {}` — totally
    // silent. That is why the 2026-07-14 "no red count on the app icon" report
    // was unfalsifiable: `badge_recomputed` proved we COMPUTED 16, and nothing
    // at all proved whether the launcher ever accepted it.
    //
    // Worth knowing when reading this event: on stock Android/AOSP there is no
    // launcher badge API — `AppBadgePlus` is an OEM broadcast shim (Samsung /
    // Xiaomi / Huawei / Sony), and the dot is otherwise derived purely from
    // ACTIVE NOTIFICATIONS. So `launcher_ok:true` still does not guarantee a
    // visible count; correlate with `push_shown`. If `push_shown` never fires,
    // there is no notification for the dot to hang on and the badge cannot
    // appear no matter what this returns — the badge failure is downstream of
    // the notification failure, not independent of it.
    Analytics.capture('badge_applied', {
      'total': n,
      'launcher_ok': launcherErr == null,
      if (launcherErr != null) 'launcher_error': launcherErr.toString(),
      'store_ok': storeErr == null,
      if (storeErr != null) 'store_error': storeErr.toString(),
      'cancelled_notifs': n == 0,
      'bg_isolate': _inBackgroundIsolate,
    });
    // Nothing unread ⇒ no banner may keep re-asserting a count via `number:`.
    if (n == 0) await _cancelAllNotifs();
  }

  static Future<void> _cancelAllNotifs() async {
    for (final id in notifIds) {
      try {
        await _local.cancel(id);
      } catch (_) {}
    }
  }
}
