part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// [CHAT-THREAD-SPLIT-2] Theme getters, day/time formatting and small label helpers.
extension _ChatThreadFormatting on _ChatThreadScreenState {


  /// Human "last seen <time>" label from the tracked unix-seconds timestamp.
  String _relLastSeen() {
    if (_peerLastSeen <= 0) return 'tap for contact info';
    final dt = DateTime.fromMillisecondsSinceEpoch(_peerLastSeen * 1000);
    final diff = DateTime.now().difference(dt);
    if (diff.inSeconds < 60) return 'last seen just now';
    if (diff.inMinutes < 60) return 'last seen ${diff.inMinutes}m ago';
    if (diff.inHours < 24) return 'last seen ${diff.inHours}h ago';
    if (diff.inDays == 1) return 'last seen yesterday';
    if (diff.inDays < 7) return 'last seen ${diff.inDays}d ago';
    return 'last seen ${dt.day}/${dt.month}/${dt.year}';
  }


  String _shortPub(String hex) => hex.length > 8 ? '${hex.substring(0, 6)}…' : hex;


  // Phase 5: my display name, stamped onto outgoing group messages + reactions so
  // peers can show "Reacted by <name>" and a real sender label (not a short id).
  String get _fromNameTag =>
      (_myName != null && _myName!.trim().isNotEmpty) ? _myName!.trim() : 'Member';


  // Resolve a sender/reactor uid to a friendly group label: my uid → "You", a
  // learned name (from a message or reaction that carried fromName) → that name,
  // else a short id. Empty uid → null (no label).
  String? _groupLabelFor(String uid, {bool mine = false}) {
    if (mine) return null;
    if (uid.isEmpty) return null;
    return _memberNames[uid] ?? _shortPub(uid);
  }


  /// Per-message delivery status for MY 1:1 messages (WhatsApp-style). Returns
  /// the tick icon, its colour, and a tiny human label; null when status doesn't
  /// apply (received messages, groups, demo mode). Drives both the ticks and the
  /// little caption under each of my bubbles so the sender always knows where a
  /// message is: still sending → on the relay but not yet on the phone →
  /// delivered to the phone → actually read.
  ({IconData icon, Color color, String label})? _statusFor(_Msg m) {
    if (m.aiLocal) return null; // private @ava question — never sent, so no ticks
    if (!m.me || !_realMode || m.ts <= 0) return null;
    // My bubbles are lime (ink text), so status ticks read in ink tones:
    // read = blue-ink, everything in-flight = ink-soft, failed = coral.
    if (m.failed) {
      return (icon: PhosphorIcons.warningCircle(PhosphorIconsStyle.bold), color: AD.danger, label: 'Not sent · tap to retry');
    }
    // [CHAT-UI-MEDIA-1] Background video transcode (moved off the pre-bubble
    // path by [MEDIA-INSTANT-1]) is otherwise invisible — the bubble just sits
    // there. Surface it explicitly instead of a bare "Sending…".
    if (m.transcoding) {
      return (icon: PhosphorIcons.filmSlate(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Processing video…');
    }
    if (m.uploading) {
      return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sending…');
    }
    // [AVAGRP-BUBBLE-1 / message-info] Groups were hard-gated out above
    // (`_isGroup` in the old guard) because only the 1:1 thread-level
    // high-water marks (`_peerReadTs`/`_peerDeliveredTs`) existed. Now that
    // `_Msg` carries per-member `readBy`/`deliveredTo` (Agent C's backend,
    // `worker/src/do/inbox.ts` + `sync_hub.dart`), a group message can report a
    // real status too: read once EVERY other member has read it, delivered once
    // EVERY other member has it. `_memberUids` is "every member except me" —
    // set in `_setupGroup`. [AVAGRP-BUBBLE-2] The wire-up is LIVE, gated on
    // `RemoteConfig.groupReceiptsEnabled` (dark launch, default false) — while
    // off, `readBy`/`deliveredTo` stay `{}` for every group message (nothing
    // populates them), so this still falls through to "Sent" exactly as before.
    if (_isGroup) {
      if (_memberUids.isNotEmpty && m.readBy.length >= _memberUids.length) {
        return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.iconSearch, label: 'Read');
      }
      if (_memberUids.isNotEmpty && m.deliveredTo.length >= _memberUids.length) {
        return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Delivered');
      }
      if (m.sent) {
        return (icon: PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sent');
      }
      return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sending…');
    }
    if (_peerReadTs > 0 && m.ts <= _peerReadTs) {
      return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.iconSearch, label: 'Read'); // 2 blue ticks
    }
    if (_peerDeliveredTs > 0 && m.ts <= _peerDeliveredTs) {
      return (icon: PhosphorIcons.checks(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Delivered'); // 2 grey ticks
    }
    if (m.sent) {
      // 1 tick = left this device / accepted. We deliberately DON'T claim
      // "waiting to reach phone" here — that contradicted the peer showing as
      // online (pic2). Truthful escalation: Sent → Delivered → Read.
      return (icon: PhosphorIcons.check(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sent'); // 1 tick
    }
    return (icon: PhosphorIcons.clock(PhosphorIconsStyle.bold), color: AD.bubbleOutMeta, label: 'Sending…');
  }


  // [AVAGRP-BUBBLE-2] Wallpaper-aware system/day-pill colours.
  //
  // REASONING (owner asked for a white DEFAULT canvas, 2026-07-17; see the
  // SANITY CHECK left in `wallpaper.dart`): `kChatSysPillBg`/`kChatCanvasMeta`
  // ([AVAGRP-BUBBLE-1]) are tuned for `kChatCanvas` (white) and read fine there
  // — but 5 SELECTABLE presets (teal/sunset/forest/lavender/sky) stay near-black
  // tints, and a near-white opaque pill floating on one of those is exactly the
  // "hole punched in the page" class of bug this pass is fixing elsewhere (see
  // `_hiddenBubble`), just inverted. Deriving from the ACTIVE wallpaper (rather
  // than hardcoding one pair) fixes both cases with one bubble/pill system
  // instead of a parallel dark theme. This is a minimal contrast fix, not a
  // vote to keep the presets — if the owner later retires them, delete
  // `wallpaperIsDark`/`kDarkWallpaperIds` (`wallpaper.dart`) and these getters
  // collapse back to the single pale-on-white pair.
  // [AVA-GRP-UI] Owner reversed the 2026-07-17 white-canvas decision (his
  // screenshot showed a white thread background he did not want): the 'default'
  // thread canvas is DARK/near-black again. `wallpaper.dart`/`bubble_theme.dart`
  // are owned elsewhere and left untouched, so the reversal lives here in the UI
  // layer — 'default' now counts as a dark wallpaper for every system/day-pill
  // and canvas-ink getter above, exactly like the 5 selectable dark presets, so
  // pills and separators invert to their dark-readable variants automatically.
  //
  // [UI-CHAT-2026] The `_wallpaperId == 'default'` half is DELETED. It was
  // added when the default canvas really was near-black, and the doc below
  // still says "`AD.bg` … near-black" — but `AD.bg` is `0xFFFBF3E2`, WARM
  // CREAM PAPER, and has been since the Rajasthani retheme. The stale override
  // meant the default thread (which is what everyone actually uses) took the
  // dark-canvas branch of all three getters below and drew:
  //   * `_sysPillBg`   = 0xB3202024, a dark slab, on cream;
  //   * `_sysPillMeta` = white @82%, i.e. day separators and the "older
  //     messages" caption in near-white text ON CREAM PAPER — unreadable;
  //   * `_sysPillBorder` = white @14%, invisible.
  // `wallpaperIsDark` is already the single source of truth (core/wallpaper.dart:
  // the 5 selectable presets are dark, 'default' and unknown ids are not), so
  // ask it and nothing else — that way a future canvas change updates one place.
  bool get _wallpaperDark => wallpaperIsDark(_wallpaperId);


  /// [AVA-GRP-UI] The thread canvas gradient. 'default' resolves to near-black
  /// (`AD.bg`) rather than the white `kChatCanvas` that `wallpaperGradient`
  /// would return — the owner wants a dark background with the pale bubbles +
  /// hairline borders sitting on top (they read fine on dark; see
  /// `bubble_theme.dart`). The 5 selectable presets keep their own tints.
  LinearGradient _gradientFor(String id) => id == 'default'
      ? const LinearGradient(
          colors: [AD.bg, AD.bg],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter)
      : wallpaperGradient(id);

  LinearGradient get _threadGradient => _gradientFor(_wallpaperId);

  Color get _sysPillBg => _wallpaperDark ? const Color(0xB3202024) : kChatSysPillBg;

  Color get _sysPillBorder => _wallpaperDark ? Colors.white.withValues(alpha: 0.14) : kChatCanvasMeta.withValues(alpha: 0.35);

  // Day-separator / older-messages caption tone (grey on light, pale-white on dark).
  Color get _sysPillMeta => _wallpaperDark ? Colors.white.withValues(alpha: 0.82) : kChatCanvasMeta;

  // The group-photo-change / "X created the group" announcement ink. Owner
  // instruction (2026-07-17): "Use small fonts in black" — literal black is
  // the light-canvas case; a dark wallpaper needs the inverse (white) or the
  // text is unreadable, which the instruction didn't anticipate (it predates
  // the dark-preset sanity check).
  Color get _sysAnnounceInk => _wallpaperDark ? Colors.white : Colors.black;

  // Text painted DIRECTLY on the canvas (no pill behind it) — day separators
  // already had their own pill so they're covered by `_sysPillMeta` above; this
  // pair is for canvas-level chrome like the in-thread search empty state.
  Color get _canvasInk => _wallpaperDark ? AD.textPrimary : kChatCanvasInk;

  Color get _canvasMeta => _wallpaperDark ? AD.textSecondary : kChatCanvasMeta;

  Color get _canvasTertiary => _wallpaperDark ? AD.textTertiary : kChatCanvasMeta.withValues(alpha: 0.7);


  // A subtle divider rendered above the oldest loaded messages once we've paged
  // (or are paging) deep archive, so the user understands they're now looking at
  // history pulled from the cloud backup.
  // [AVAGRP-BUBBLE-1] `AD.textPrimary`/`AD.textSecondary` are white/near-white —
  // tuned for the OLD dark thread canvas. On the new white `kChatCanvas` a
  // white-at-18%-alpha divider and white-60% caption are both close to
  // invisible. Use the pale-on-white pair from `bubble_theme.dart` instead.
  // [AVAGRP-BUBBLE-2] Now wallpaper-aware (`_sysPillMeta`) rather than
  // hardcoded to the pale-on-white pair — see the reasoning above.
  Widget _olderMessagesDivider() => Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 10),
        child: Row(children: [
          Expanded(child: Divider(color: _sysPillMeta.withValues(alpha: 0.35), thickness: 1)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: _archiveLoading
                ? Row(mainAxisSize: MainAxisSize.min, children: [
                    SizedBox(width: 12, height: 12,
                        child: CircularProgressIndicator(strokeWidth: 1.6, color: _sysPillMeta)),
                    const SizedBox(width: 7),
                    Text('Loading older messages…', style: ADText.statCaption(c: _sysPillMeta)),
                  ])
                : Text(_archiveDone ? 'Start of conversation' : 'Older messages',
                    style: ADText.statCaption(c: _sysPillMeta)),
          ),
          Expanded(child: Divider(color: _sysPillMeta.withValues(alpha: 0.35), thickness: 1)),
        ]),
      );


  String _fmtTime(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }


  // [CHAT-TS-ABS-1] (owner report 2026-07-16, pic 2): message bubbles now ALWAYS
  // carry the wall-clock HH:MM they were sent at.
  //
  // This used to return a relative age ("now" / "2m" / "4h") for anything under
  // 6 hours old, which is why a thread of voice notes and tombstones read as a
  // column of "4h" with no timestamp anywhere. Relative ages are fine on a chat
  // LIST (one row, "when did this thread last move"), but inside a thread the
  // question is "what time was this said", and only a clock answers that — every
  // other messenger (see WhatsApp, pic 5) shows the clock. The day a message
  // belongs to is carried by the day separator chip, so HH:MM is unambiguous.
  String _relTime(int epochSecs) {
    if (epochSecs <= 0) return '';
    return _fmtTime(epochSecs);
  }


  // A day-separator label: Today / Yesterday / weekday (this week) / d Mon.
  String _dayLabel(int epochSecs) {
    final d = DateTime.fromMillisecondsSinceEpoch(epochSecs * 1000);
    final now = DateTime.now();
    final day = DateTime(d.year, d.month, d.day);
    final today = DateTime(now.year, now.month, now.day);
    final delta = today.difference(day).inDays;
    if (delta == 0) return 'Today';
    if (delta == 1) return 'Yesterday';
    const wk = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (delta < 7) return wk[d.weekday - 1];
    final y = d.year == now.year ? '' : ' ${d.year}';
    return '${d.day} ${mo[d.month - 1]}$y';
  }


  bool _sameDay(int a, int b) {
    if (a == 0 && b == 0) return true; // both demo/unknown ts → no separator
    // [CHAT-TS-ABS-1] Exactly one side has no timestamp (a legacy/demo bubble):
    // it can't be proven to share a day with a real one, so treat it as a day
    // boundary. Previously this returned true, which meant a single ts-less
    // message sitting between two days silently swallowed the day chip for the
    // whole run of messages after it.
    if (a == 0 || b == 0) return false;
    final da = DateTime.fromMillisecondsSinceEpoch(a * 1000);
    final db = DateTime.fromMillisecondsSinceEpoch(b * 1000);
    return da.year == db.year && da.month == db.month && da.day == db.day;
  }


  // A centered "Today / Yesterday / date" chip rendered between day groups.
  // [AVAGRP-BUBBLE-1] `AD.card` (near-black) + `AD.borderControl` were tuned
  // for the old dark canvas; on white they'd read as a hard black pill. Use
  // the pale system-pill pair (`kChatSysPillBg`/`kChatCanvasMeta`) instead.
  // [AVAGRP-BUBBLE-2] Now wallpaper-aware (`_sysPillBg`/`_sysPillBorder`/
  // `_sysPillMeta`) instead of hardcoded — see the reasoning above `_sysPillBg`.
  Widget _daySeparator(String label) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(
              color: _sysPillBg,
              borderRadius: Msg.brPill,
              border: Border.all(color: _sysPillBorder, width: 1.5),
              boxShadow: const [],
            ),
            child: Text(label,
                style: ADText.statCaption(c: _sysPillMeta)),
          ),
        ),
      );


  /// [AVAGRP-BUBBLE-2] Centered system-announcement pill for a group ("Humphrey
  /// Davy created the group", "X added Y", "X changed the group photo" —
  /// `GroupApi.announce()`, wire envelope `{"t":"gtext","system":true,...}`).
  /// Modelled on `_daySeparator` immediately above (same pale pill), but with:
  ///   * NO avatar, NO sender-name header, NO bubble tail, NO per-sender tint —
  ///     a system row belongs to no one.
  ///   * Literal small BLACK text on the default white canvas, per the owner's
  ///     explicit "Use small fonts in black" instruction (2026-07-17) — NOT
  ///     `_sysPillMeta`'s grey caption tone, which `_daySeparator`/
  ///     `_olderMessagesDivider` use instead. `_sysAnnounceInk` inverts to
  ///     white on a dark wallpaper preset so it stays readable there too (see
  ///     the wallpaper reasoning above).
  ///   * Full-sentence casing (not the day-pill's uppercase) — this is a
  ///     readable announcement, not a date-chip label.
  Widget _systemBubble(_Msg m) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: Container(
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
            decoration: BoxDecoration(
              color: _sysPillBg,
              borderRadius: Msg.brMd,
              border: Border.all(color: _sysPillBorder, width: 1),
              boxShadow: const [],
            ),
            child: Text(m.text,
                textAlign: TextAlign.center,
                style: ADText.statCaption(c: _sysAnnounceInk)),
          ),
        ),
      );
}
