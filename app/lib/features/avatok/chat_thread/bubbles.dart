part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

// ─────────────────────────────────────────────────────────────────────────────
// [CHAT-UI-STATIC-1] Per-attachment decrypt-future cache.
//
// `_mediaContent` used to build `FutureBuilder(future: MediaService
// .downloadAndDecrypt(m.media!))` INLINE inside `build`. A `FutureBuilder`
// restarts whenever it is handed a NEW Future instance, so every rebuild kicked
// off a fresh download+decrypt AND dropped the bubble straight back to the
// loading placeholder before re-showing the image. Because `_msgsRev` is a
// single thread-wide counter, ANY message change invalidates EVERY row — so
// during the staged load right after a thread opens, every media bubble
// re-decrypted and flashed at least once. That is the flicker the owner sees.
//
// Keyed by [ChatMedia.id], which is the sha256 of the ciphertext — content
// addressed, so it is stable across rebuilds AND correct across threads (the
// same blob genuinely is the same bytes). NOT keyed by message id, which is
// per-thread-local.
//
// RETRY CONTRACT: a cached future that COMPLETED WITH AN ERROR would be
// re-awaited forever and silently kill the retry affordance. Every path that
// clears `m.localBytes` to force a re-fetch MUST also call
// [_forgetChatMediaFuture] — see the `onRetry` in `_mediaContent`.
final Map<String, Future<Uint8List>> _chatMediaFutures = {};

/// Soft cap. Each entry retains the decrypted bytes for as long as it lives, so
/// this is a memory bound, not just a tidy-up. Well past a screenful of media.
const int _kChatMediaFutureCap = 32;

Future<Uint8List> _chatMediaFuture(ChatMedia media) {
  final cached = _chatMediaFutures[media.id];
  if (cached != null) return cached;
  if (_chatMediaFutures.length >= _kChatMediaFutureCap) {
    // Insertion-ordered (LinkedHashMap): drop the oldest.
    _chatMediaFutures.remove(_chatMediaFutures.keys.first);
  }
  final f = MediaService.downloadAndDecrypt(media);
  _chatMediaFutures[media.id] = f;
  return f;
}

/// Drop the cached future so the next build starts a genuinely NEW
/// download+decrypt. Call this from every retry path.
void _forgetChatMediaFuture(ChatMedia? media) {
  if (media != null) _chatMediaFutures.remove(media.id);
}

extension _ChatThreadBubbles on _ChatThreadScreenState {

  Widget _bubble(_Msg m) {
    // [AVAGRP-BUBBLE-2] Group SYSTEM announcement — a centered pill, never a
    // normal per-sender bubble. Checked FIRST: a system row has no avatar, no
    // sender-name header, no bubble tail, and must never fall into any of the
    // special/hidden/media logic below.
    if (m.system) return _systemBubble(m);
    // Ava "working…" chip (kind 'ava_status') — inline, not a bubble. A 'phase:end'
    // frame is the CLOSE signal (e.g. image done/failed) — it must collapse the
    // chip, not render as a stuck "generating…" placeholder.
    if (m.special == 'ava_status') {
      if ((m.extra?['phase'] ?? '').toString() == 'end') return const SizedBox.shrink();
      return _avaStatusChip(m);
    }
    // [AVA-MEDIA-JOB-2] A durable image/doc/audio job placeholder — keyed only
    // by `job_id` (extra['job_id']), never swept by the legacy `ava_status`
    // cleanup (see `_isJobStatusChip`). Reads LIVE state from the repository
    // every rebuild.
    if (m.special == 'ai_job') {
      final jobId = (m.extra?['job_id'] ?? '').toString();
      final job = jobId.isEmpty ? null : AiMediaJobRepository.I.byId(jobId);
      if (job == null) return const SizedBox.shrink(); // forgotten/not-yet-hydrated — nothing to render
      return _aiJobBubble(job);
    }
    // SOFT-DELETED (by me) — a slim "deleted" pill with an Undo so I can recover my
    // own data. The real content stays in `m` (hidden, not erased) until I confirm.
    if (m.hidden) return _hiddenBubble(m);
    // U1-lite: a Guardian "verify you're human" request from the other side —
    // renders as a lilac card with a Start-face-check button (opens the existing
    // liveness HumanCheckPage; on PASS the server flips the gate automatically).
    if (_isVerifyRequest(m)) return _verifyRequestBubble(m);
    // RED FLAGS — Ava's safety alert, and any incoming message Ava flagged as
    // unsafe. Both render red/white so the danger is obvious to the child.
    if (_isGuardianWarn(m)) return _redFlagBubble(m, 'AVA · SAFETY ALERT');
    // F6: a persisted `safety_flag` frame for THIS message (keyed by rumorId).
    // Tap / long-press opens the safety sheet (Block · Report · This is fine).
    // Kept ahead of the legacy _flaggedTs fallback so the newer, richer path wins;
    // the _flaggedTs path below still fires for older guardian-warning flags.
    final flagCat = _safetyCategoryFor(m);
    if (flagCat != null && !m.me && m.special == null && m.media == null && m.localBytes == null) {
      return _safetyFlagBubble(m, flagCat);
    }
    if (!m.me && m.special == null && m.media == null && m.localBytes == null && _flaggedTs.contains(m.ts)) {
      return _redFlagBubble(m, '⚠ FLAGGED BY AVA — DO NOT TRUST');
    }
    // Phase A (Ava Copilot §6/D3): PRIVATE-LANE Ava rows (copilot Moments, doc
    // results, Guardian notes — lane:"private" or a guardian payload in the
    // body) render via the dedicated AvaLaneBubble: soft orchid fill, "Ava ✨"
    // author label, info affordance → disclosure sheet, safety accent for the
    // Guardian variant. Ava's ordinary @ava turn replies (a2ui/email/image
    // bubbles etc.) keep the existing lilac path below, unchanged.
    if (_isAvaBubble(m) && m.media == null &&
        m.extra?['a2ui'] == null && m.extra?['media_ref'] == null &&
        (m.extra?['lane'] == 'private' || m.extra?['guardian'] is Map)) {
      return GestureDetector(
        onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
        child: AvaLaneBubble(
          text: m.text,
          time: m.time,
          guardian: (m.extra?['guardian'] as Map?)?.cast<String, dynamic>(),
        ),
      );
    }
    final hasMedia = m.media != null || m.localBytes != null;
    // Ava bubbles always render on the LEFT (she is a participant, not "me"),
    // in a distinct feminine lilac fill — visually separate from my lime and
    // peers' card bubbles.
    final isAva = _isAvaBubble(m);
    // My OWN message that I sent TO Ava (private @ava question). Colour it the
    // same lilac as Ava's replies so a glance tells me "this is an Ava
    // conversation", never confused with a green message to a person.
    final toAva = m.me && m.aiLocal;
    final onRight = m.me && !isAva;
    // [AVAGRP-BUBBLE-1] Resolve ONE BubbleTheme for this whole bubble — never
    // re-derive a colour further down (in `_specialContent`, the meta row, the
    // reply strip, etc). `mine` excludes `toAva` (my own private question TO Ava
    // still renders in her lilac, not my green) and `senderKey` is the STABLE
    // `senderPub` uid, never the display name — see the `_Msg.senderPub` doc.
    final t = resolveBubbleTheme(
      mine: onRight && !toAva,
      isGroup: widget.chat.group,
      isAva: isAva || toAva,
      senderKey: m.senderPub,
    );
    // Telemetry seam: a group peer bubble with a senderPub but no learned name
    // AND no learned avatar is exactly the failure mode that used to render the
    // bare '?' avatar — flag it once per message so a future regression is
    // diagnosable from PostHog alone, without needing a screenshot report.
    // [CHAT-UI-LIST-1c] Fire at most once per message id — `_bubble` reruns on
    // every rebuild of the thread State (any keystroke/tick/reaction), and this
    // used to re-emit the event for every unresolved-sender bubble on screen
    // each time, not once per actual unresolved sender.
    if (widget.chat.group && !m.me && (m.senderPub?.isNotEmpty ?? false) &&
        _memberNames[m.senderPub] == null && _memberAvatars[m.senderPub] == null &&
        _unresolvedSenderLogged.add(m.id)) {
      Analytics.capture('chat_group_sender_unresolved', {
        // Analytics.capture already stamps the account's email/phone on every
        // event (Analytics._base) — no need to pass them explicitly here.
        'gid': widget.chat.gid ?? '',
        'sender_pub': _shortPub(m.senderPub!),
        'has_label': m.senderLabel != null,
      });
    }
    // [UI-BUBBLE-STICKER] Fully bubble-LESS sticker (Stream E follow-up). A
    // sticker rides the media pipeline tagged via `isStickerName`. WhatsApp-parity:
    // render StickerMediaView (160dp) with NO bubble chrome — no background, no
    // padding, no tail, no border — aligned to the sender side, with the timestamp
    // + read receipt in a small row BELOW the sticker (also side-aligned). Long-
    // press still opens the reaction/action sheet; tap opens the fullscreen viewer.
    // Moved below the `t` resolution ([AVAGRP-BUBBLE-1]) so the meta row under
    // the sticker can carry the same per-sender colour as every other bubble.
    if (isStickerName(m.media?.name ?? '')) {
      return _stickerBubbleLess(m, t);
    }
    // [UI-BUBBLE-2] "media IS the bubble": for a bare image/video (no caption,
    // no reply, no special kind) the media fills the bubble edge-to-edge and the
    // forwarded label + timestamp/status overlay ON the media (bottom-right scrim
    // + top-left label) instead of the normal below-bubble rows.
    final _mediaKind = m.media?.kind ??
        (m.localBytes != null ? MediaKind.image : null);
    final isPureMedia = m.special == null &&
        hasMedia &&
        m.replyTo == null &&
        _mediaCaptionOf(m).isEmpty &&
        !isStickerName(m.media?.name ?? '') && // stickers keep their own bubble-less path
        (_mediaKind == MediaKind.image || _mediaKind == MediaKind.video);
    final core = GestureDetector(
        // Phase 5: long-press / right-click → floating reaction pill anchored at
        // the touch point. Double-tap → quick ❤️ (toggle), like iMessage.
        onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
        // Double-tap → quick ❤️ (toggle). Disabled on media bubbles so the
        // single-tap "open image/video" stays instant (no double-tap wait).
        onDoubleTap: hasMedia
            ? null
            : () {
                Analytics.capture('chat_react_doubletap', const <String, Object>{});
                _react(m, '❤️');
              },
        child: Column(
          crossAxisAlignment: onRight ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Container(
              margin: EdgeInsets.only(bottom: m.reaction == null ? 8 : 2),
              // Visual media (image/video/file/pdf cards) hug the bubble edge with
              // a slim border. Resolve the kind via localBytes too, so a still-
              // uploading attachment (m.media == null) doesn't fall back to the
              // wide text padding — that was the broad white border on sent media.
              // Voice notes stay on the normal padding (they're an inline row).
              // [AVAGRP-BUBBLE-1] Owner (2026-07-17): every bubble kind, including
              // pure image/video, must be "enclosed inside a pale color" — the old
              // ZERO padding for `isPureMedia` put the media flush to the outer
              // rounded edge with no pale surround at all. Give it the SAME 3px hug
              // as every other media kind instead of a special-cased zero.
              padding: (m.special == null &&
                          hasMedia &&
                          (m.media?.kind ??
                                  (m.localBytes != null ? MediaKind.image : MediaKind.file)) !=
                              MediaKind.audio)
                      ? const EdgeInsets.all(3)
                      // A link-preview card hugs the bubble edge (3px, like
                      // media) instead of floating inside a 14px gutter.
                      : (m.extra?['preview'] is Map)
                          ? const EdgeInsets.fromLTRB(4, 4, 4, 6)
                          : const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              // Ava email-card and GenUI/A2UI bubbles need more room (the design
              // uses ~92%); everything else stays at the standard [UI-BUBBLE-1] 78%
              // (symmetric for incoming & outgoing — text sizes to content up to this).
              // Link-preview bubbles also take the wide lane: the card is the
              // content, and at 78% it left a dead gutter of bubble colour on
              // both sides of the thumbnail.
              constraints: BoxConstraints(
                  maxWidth: MediaQuery.of(context).size.width *
                      (((m.extra?['emails'] is List && (m.extra!['emails'] as List).isNotEmpty) ||
                              m.extra?['a2ui'] is Map ||
                              m.extra?['preview'] is Map)
                          ? 0.92
                          : 0.78)),
              // [AVAGRP-BUBBLE-1] Pale fill from the ONE resolved `t`: mine =
              // pale green, Ava (or my message TO Ava) = pale blue, a 1:1 peer =
              // pale lilac, and in GROUPS each sender gets their own stable pale
              // tint (keyed on `senderPub`, never the display name) so you can
              // tell at a glance who said what. A hairline `t.border` gives pale
              // bubbles an edge against the white canvas.
              decoration: BoxDecoration(
                color: t.bg,
                border: Border.all(color: t.border, width: 1),
                boxShadow: const [],
                borderRadius: t.radius,
              ),
              // [UI-BUBBLE-2] clip edge-to-edge media to the bubble's rounded shape.
              clipBehavior: isPureMedia ? Clip.antiAlias : Clip.none,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Ava label — a small "AVA" tag on her bubbles. ava_private
                  // adds a "· private" hint so the recipient knows it is just
                  // for them (consent/disclosure, proposal §9).
                  if (isAva)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                            size: 11, color: t.ink),
                        const SizedBox(width: 4),
                        Text(
                            m.special == 'ava_private' ? 'AVA · PRIVATE' : 'AVA',
                            style: ADText.bubbleMeta(c: t.ink)),
                      ]),
                    ),
                  // [UI-BUBBLE-2] For pure media the FORWARDED label overlays the
                  // media (top-left) instead of this inline row.
                  if (m.forwarded && !isPureMedia)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 1),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold),
                            size: 11, color: t.meta),
                        const SizedBox(width: 3),
                        Text('FORWARDED', style: ADText.bubbleMeta(c: t.meta)),
                      ]),
                    ),
                  // [AVAGRP-BUBBLE-1] Sender name header uses the same saturated
                  // sibling colour as the bubble's own tint (`groupSenderNameColor`)
                  // so the name always matches the bubble it sits above.
                  if (m.senderLabel != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Text(m.senderLabel!,
                          style: ADText.bubbleMeta(
                              c: (m.senderPub?.isNotEmpty ?? false)
                                  ? groupSenderNameColor(m.senderPub!)
                                  : t.play)),
                    ),
                  if (m.replyTo != null)
                    Container(
                      margin: const EdgeInsets.only(bottom: 4),
                      padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
                      decoration: BoxDecoration(
                          color: t.bg.withValues(alpha: 0.6),
                          border: Border(left: BorderSide(color: t.play, width: 3)),
                          borderRadius: BorderRadius.circular(Msg.rSm)),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                        Text((m.replyTo!['who'] ?? '').toString(),
                            style: ADText.bubbleMeta(c: t.play)),
                        Text((m.replyTo!['preview'] ?? '').toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: ADText.bubbleBody(c: t.ink)),
                      ]),
                    ),
                  if (m.special != null) _specialContent(m, t)
                  else if (hasMedia) ...[
                    // [UI-BUBBLE-2] pure image/video → media fills edge-to-edge with
                    // the forwarded label + timestamp/status overlaid on it.
                    _mediaContent(m, t, overlayMeta: isPureMedia),
                    // WhatsApp-style caption: the attachment's own text, in the
                    // SAME bubble. A hairline divider above it separates the media
                    // area from the text area so the two read as distinct zones.
                    if (_mediaCaptionOf(m).isNotEmpty) ...[
                      // Full-bleed divider: negative horizontal margin (= the 3px
                      // media padding) pushes it flush to the bubble's inner edge,
                      // and a 2px border-toned rule clearly splits the media + text zones.
                      Container(
                        margin: const EdgeInsets.fromLTRB(-3, 7, -3, 0),
                        height: 2,
                        color: t.border,
                      ),
                      Padding(
                        padding: const EdgeInsets.only(top: 7, left: 5, right: 5),
                        child: Text(_mediaCaptionOf(m),
                            style: ADText.bubbleBody(c: t.ink)),
                      ),
                    ],
                    // Voice-note transcript / translation (viewer-only). Rendered
                    // below the waveform when the user long-pressed → Transcribe
                    // or Translate. Both are cached per message, per-account.
                    ..._voiceTranscriptBlock(m, t),
                  ]
                  else _textContent(m, t),
                  // [UI-BUBBLE-2] pure media carries its timestamp/status as an
                  // overlay scrim on the media itself, so skip this inline row.
                  if (!isPureMedia)
                  Padding(
                    padding: const EdgeInsets.only(top: 3, left: 2, right: 2),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      if (m.starred) ...[
                        PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill), size: 11, color: t.play),
                        const SizedBox(width: 3),
                      ],
                      if (m.edited) ...[
                        Text('EDITED ', style: ADText.bubbleMeta(c: t.meta)),
                      ],
                      // Mono timestamp (10px) — Phase 5: live relative age for
                      // recent messages ("now"/"2m"/"1h"), fixed HH:MM for older.
                      // [AVAGRP-BUBBLE-1] Every bubble kind reaches this row (or
                      // the pure-media overlay / sticker meta row below) — the
                      // owner's "every message needs a date+time stamp" rule.
                      Text(m.ts != 0 ? _relTime(m.ts) : m.time,
                          style: ADText.bubbleMeta(c: t.meta)),
                      if (m.expireAt != null) ...[
                        const SizedBox(width: 4),
                        PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold), size: 11, color: t.meta),
                      ],
                      // Delivery status (my 1:1 messages): tick + tiny caption —
                      // sending → "waiting to reach phone" (1 tick) → "delivered"
                      // (2 grey) → "read" (2 blue). Tap to retry when failed.
                      Builder(builder: (_) {
                        final st = _statusFor(m);
                        if (st == null) return const SizedBox.shrink();
                        final row = Row(mainAxisSize: MainAxisSize.min, children: [
                          const SizedBox(width: 4),
                          Icon(st.icon, size: 13, color: st.color),
                          const SizedBox(width: 3),
                          Text(st.label,
                              style: ADText.bubbleMeta(c: st.color)), // status colour is semantic (danger/read/etc.), not theme-tinted
                        ]);
                        if (!m.failed) return row;
                        return GestureDetector(
                          onTap: () {
                            // [AVA-CHAT-INSTANT] Manual retry telemetry + fresh
                            // round-trip anchor (email auto-attached by _base).
                            m.sendStartedMs = DateTime.now().millisecondsSinceEpoch;
                            Analytics.capture('msg_send_retry', {
                              'conv_kind': _isGroup ? 'group' : 'dm',
                              'has_media': m.localBytes != null || m.media != null,
                            });
                            if (m.localBytes != null) {
                              // [MEDIA-RETRY-KIND-1] Retry with the EXACT kind/
                              // mime/filename the original attempt used — never
                              // the generic 'application/octet-stream' fallback
                              // that let a failed voice note silently re-upload
                              // and render as a different kind on both sides.
                              _retryMediaUpload(m);
                            } else if (_realMode && _dm != null && m.media == null && m.special == null) {
                              // Resend a failed text message; track the new wrap.
                              // [AVA-IDGATE-1 / CSAM-GATE-1] Do NOT optimistically mark this
                              // `sent` — that showed a false "SENT" tick (and could show one
                              // for a message the server 403s as identity_required) before the
                              // outbox's own ACK. Re-queue as "sending…" and let
                              // _onSendStatus() flip `sent` only once the server actually
                              // returns 200 for this client_id.
                              final newId = _dm!.send(jsonEncode({'t': 'text', 'body': m.text,
                                  if (m.replyTo != null) 'replyTo': m.replyTo, if (m.expireAt != null) 'exp': m.expireAt}));
                              _mutMsgs(() { m.evId = newId; m.failed = false; m.sent = false; _seenEv.add(newId); });
                            }
                          },
                          child: row,
                        );
                      }),
                      if (m.uploading && _statusFor(m) == null) ...[
                        const SizedBox(width: 6),
                        const SizedBox(width: 10, height: 10,
                            child: CircularProgressIndicator(strokeWidth: 1.5, color: AD.bubbleInMeta)),
                      ],
                    ]),
                  ),
                ],
              ),
            ),
            // Phase 4: aggregate reaction chips (emoji + live count). Falls back to
            // a single sticker when there are no counts yet (legacy local-only tap).
            if (m.reactCounts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10, top: 1),
                child: Wrap(spacing: 4, children: [
                  for (final e in m.reactCounts.entries)
                    GestureDetector(
                      onTap: () => _react(m, e.key),
                      onLongPress: () => _showReactedBy(m), // Phase 5: who reacted
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                            color: m.reaction == e.key ? AD.primaryBadge : t.bg,
                            borderRadius: Msg.brPill,
                            border: Border.all(color: t.border, width: 2),
                            boxShadow: const []),
                        child: Text(e.value > 1 ? '${e.key} ${e.value}' : e.key,
                            style: const TextStyle(fontSize: 13)),
                      ),
                    ),
                ]),
              )
            else if (m.reaction != null)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                // Reaction sticker — themed border, no blur.
                decoration: BoxDecoration(
                    color: t.bg,
                    borderRadius: Msg.brPill,
                    border: Border.all(color: t.border, width: 2),
                    boxShadow: const []),
                child: Text(m.reaction!, style: const TextStyle(fontSize: 14)),
              ),
          ],
        ),
      );
    // My own bubbles: avatar circle on the RIGHT (my photo / initials).
    if (onRight) {
      return Padding(
        padding: const EdgeInsets.only(left: 28),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            Flexible(child: core),
            const SizedBox(width: 6),
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: t.border, width: 1.5),
              ),
              child: Avatar(
                seed: _myNpub ?? 'me',
                name: _myName ?? 'You',
                size: 30,
                avatarUrl: _myAvatarUrl.isEmpty ? null : _myAvatarUrl,
              ),
            ),
          ],
        ),
      );
    }
    // Incoming bubbles (a 1:1 peer, a group member, or Ava) get a tiny avatar
    // circle on the left so you can tell at a glance who said it.
    return Padding(
      padding: const EdgeInsets.only(right: 28),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          _bubbleAvatar(m, isAva, t),
          const SizedBox(width: 6),
          Flexible(child: core),
        ],
      ),
    );
  }

  // [UI-BUBBLE-STICKER] A sticker rendered with ZERO bubble chrome: just the
  // 160dp sticker aligned to the sender's side, with a slim timestamp + read-
  // receipt row underneath (WhatsApp-parity). Long-press → reaction/action sheet;
  // tap → fullscreen viewer once bytes are available.
  Widget _stickerBubbleLess(_Msg m, BubbleTheme t) {
    final onRight = m.me && !_isAvaBubble(m);
    final st = _statusFor(m);
    // The sticker itself (decrypt on demand for received stickers).
    Widget sticker() {
      final bytes = m.localBytes;
      if (bytes != null) return StickerMediaView(bytes: bytes, mine: m.me);
      if (m.media != null) {
        return FutureBuilder<Uint8List>(
          // [CHAT-UI-STATIC-1] Cached per attachment — same defect as the other
          // media FutureBuilders: an inline `downloadAndDecrypt(...)` is a NEW
          // Future on every rebuild, restarting the decrypt and flashing the
          // sticker back to an empty box.
          future: _chatMediaFuture(m.media!),
          builder: (c, snap) {
            if (snap.hasData) m.localBytes = snap.data; // cache decrypted bytes
            return snap.hasData
                ? StickerMediaView(bytes: snap.data!, mine: m.me)
                : const SizedBox(
                    width: kStickerRenderSize, height: kStickerRenderSize);
          },
        );
      }
      return const SizedBox(
          width: kStickerRenderSize, height: kStickerRenderSize);
    }

    // Timestamp + delivery-status row, mirroring the in-bubble meta row but with
    // no bubble surround. Aligned to the sender's side.
    final meta = Padding(
      padding: const EdgeInsets.only(top: 2, left: 4, right: 4),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (m.starred) ...[
          PhosphorIcon(PhosphorIcons.star(PhosphorIconsStyle.fill),
              size: 11, color: t.play),
          const SizedBox(width: 3),
        ],
        // [AVAGRP-BUBBLE-1] Sticker bubbles are bubble-LESS, but the owner's
        // "every message needs a date+time stamp" rule still applies — this row
        // is that stamp, themed to match the sender like every other bubble.
        Text(m.ts != 0 ? _relTime(m.ts) : m.time,
            style: ADText.bubbleMeta(c: t.meta)),
        if (st != null) ...[
          const SizedBox(width: 4),
          Icon(st.icon, size: 13, color: st.color),
        ],
      ]),
    );

    final column = Column(
      crossAxisAlignment:
          onRight ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          onLongPressStart: (d) => _onBubbleLongPressAt(m, d.globalPosition),
          onTap: () {
            final b = m.localBytes;
            if (b != null) _openImageBytes(b, mime: m.media?.contentType);
          },
          child: sticker(),
        ),
        meta,
        if (m.reactCounts.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 8),
            child: Wrap(spacing: 4, children: [
              for (final e in m.reactCounts.entries)
                GestureDetector(
                  onTap: () => _react(m, e.key),
                  onLongPress: () => _showReactedBy(m),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                        color: m.reaction == e.key ? AD.primaryBadge : t.bg,
                        borderRadius: Msg.brPill,
                        border: Border.all(color: t.border, width: 2),
                        boxShadow: const []),
                    child: Text(e.value > 1 ? '${e.key} ${e.value}' : e.key,
                        style: const TextStyle(fontSize: 13)),
                  ),
                ),
            ]),
          )
        else
          const SizedBox(height: 8),
      ],
    );

    // Align to the sender's side, matching the padding gutters used by the
    // normal bubble rows (so the sticker sits under the same margin).
    return Padding(
      padding: EdgeInsets.only(left: onRight ? 34 : 0, right: onRight ? 0 : 34),
      child: Align(
        alignment: onRight ? Alignment.centerRight : Alignment.centerLeft,
        child: column,
      ),
    );
  }

  // The tiny avatar shown beside an incoming bubble. Ava uses her sitewide
  // asset (with a lilac-sparkle fallback if the asset is missing); a 1:1 peer
  // uses the chat's avatar; a group member uses their OWN photo (from
  // `_memberAvatars`, keyed by the stable `senderPub`) when known, else
  // initials from their learned name — NEVER a bare '?'.
  //
  // [AVAGRP-BUBBLE-1] Root cause of the old '?' bug: the group branch passed no
  // `avatarUrl` (so a photo could never render) AND seeded/named off
  // `m.senderLabel`, which is null until a name is learned from the wire — so
  // `Avatar._initials` fell through to '?'. Both are fixed here: `avatarUrl`
  // is threaded through, and the seed/name chain always resolves to SOMETHING
  // human before ever reaching an empty string.
  Widget _bubbleAvatar(_Msg m, bool isAva, BubbleTheme t) {
    const s = 30.0;
    Widget inner;
    if (isAva) {
      inner = ClipOval(
        child: Image.asset(
          AvaId.avatarAsset,
          width: s, height: s, fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => Container(
            width: s, height: s, color: t.bg, alignment: Alignment.center,
            child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                size: 15, color: t.ink),
          ),
        ),
      );
    } else if (widget.chat.group) {
      final pub = m.senderPub ?? '';
      final learnedName = pub.isNotEmpty ? _memberNames[pub] : null;
      // Fallback chain: learned name → senderLabel (may already BE a short
      // pub from `_groupLabelFor`) → short pub → 'peer'. Always non-empty.
      final name = (learnedName != null && learnedName.isNotEmpty)
          ? learnedName
          : (m.senderLabel != null && m.senderLabel!.isNotEmpty)
              ? m.senderLabel!
              : (pub.isNotEmpty ? _shortPub(pub) : 'peer');
      final avatarUrl = pub.isNotEmpty ? _memberAvatars[pub] : null;
      inner = Avatar(
        seed: pub.isNotEmpty ? pub : name, // stable uid seed, never the mutable label
        name: name,
        size: s,
        avatarUrl: (avatarUrl?.isNotEmpty ?? false) ? avatarUrl : null,
      );
    } else {
      inner = Avatar(seed: widget.chat.seed, name: widget.chat.name, size: s,
          avatarUrl: widget.chat.avatarUrl.isEmpty ? null : widget.chat.avatarUrl);
    }
    final avatarBox = Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: t.border, width: 1.5),
      ),
      child: inner,
    );
    // [AVA-GRP-UI] Tapping a real person's avatar opens their full profile popup.
    // Ava has no profile; unknown-number tel: rows aren't `user_…` ids so
    // `_openMemberProfile` no-ops for them.
    if (isAva) return avatarBox;
    String? tapUid;
    String tapName = '';
    String? tapAvatar;
    if (widget.chat.group) {
      final pub = m.senderPub ?? '';
      if (pub.isNotEmpty) {
        tapUid = pub;
        tapName = (_memberNames[pub]?.isNotEmpty ?? false)
            ? _memberNames[pub]!
            : (m.senderLabel?.isNotEmpty ?? false) ? m.senderLabel! : _shortPub(pub);
        tapAvatar = _memberAvatars[pub];
      }
    } else {
      tapUid = widget.chat.seed;
      tapName = widget.chat.name;
      tapAvatar = widget.chat.avatarUrl;
    }
    if (tapUid == null || !tapUid.startsWith('user_')) return avatarBox;
    final uid = tapUid;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _openMemberProfile(
        uid: uid,
        name: tapName,
        avatarUrl: tapAvatar,
        from: widget.chat.group ? 'group_bubble_avatar' : 'dm_bubble_avatar',
      ),
      child: avatarBox,
    );
  }

  // The caption to show under a media bubble — the instant local value (set on
  // send) or, for received/restored messages, whatever rode in the envelope.
  String _mediaCaptionOf(_Msg m) =>
      m.mediaCaption.isNotEmpty ? m.mediaCaption : (m.media?.caption ?? '');

  /// Below-the-waveform transcript + translation for a voice note (viewer-only).
  /// Styled like the inline text-translate rendering: a hairline rule then the
  /// text, with a small translate/transcript glyph + label. Empty for anything
  /// that hasn't been transcribed/translated yet, so it costs nothing until used.
  List<Widget> _voiceTranscriptBlock(_Msg m, BubbleTheme t) {
    final transcript = (m.extra?['transcript'] as String?)?.trim();
    final translated = (m.extra?['transcript_translated'] as String?)?.trim();
    final tLang = (m.extra?['transcript_translated_lang'] as String?) ?? '';
    if ((transcript == null || transcript.isEmpty) &&
        (translated == null || translated.isEmpty)) {
      return const [];
    }
    Widget line(IconData icon, String label, String body) => Padding(
          padding: const EdgeInsets.only(top: 6, left: 5, right: 5),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(icon, size: 11, color: t.play),
              const SizedBox(width: 4),
              Text(label, style: ADText.bubbleMeta(c: t.play)),
            ]),
            const SizedBox(height: 2),
            Text(body, style: ADText.bubbleBody(c: t.ink)),
          ]),
        );
    return [
      Container(
        margin: const EdgeInsets.fromLTRB(-3, 7, -3, 0),
        height: 2,
        color: t.border,
      ),
      if (transcript != null && transcript.isNotEmpty)
        line(PhosphorIcons.textAa(PhosphorIconsStyle.bold), 'transcript', transcript),
      if (translated != null && translated.isNotEmpty)
        line(PhosphorIcons.translate(PhosphorIconsStyle.bold),
            tLang.isEmpty ? 'translated' : 'translated · $tLang', translated),
    ];
  }

  // Plain-text bubble content: links are tappable, and a YouTube link renders a
  // rich card with inline playback right inside the chat (no leaving the thread).
  Widget _textContent(_Msg m, BubbleTheme t) {
    final style = ADText.bubbleBody(c: t.ink);
    final link = ChatLinkText(text: m.text, style: style, theme: t);

    // STREAM G [GROUP-AI-3/5]: translated bubble → "show original" toggle. Wraps
    // the ORIGINAL child; does NOT alter Stream K geometry.
    final translated = m.extra?['translated'] as String?;
    if (translated != null && translated.trim().isNotEmpty) {
      // Translations suppress the preview card (the text is the point).
      return TranslatedText(original: link, translated: translated, translatedStyle: style);
    }

    // STREAM C [PREVIEW-3]: STRANGER GATE — while the thread's accept_state is
    // pending, render raw URL text only (never a card). Also honours the master
    // linkPreviewsEnabled flag ([PREVIEW-4]).
    final pending = _threadAcceptState == 'pending';
    if (pending || !RemoteConfig.linkPreviewsEnabled) return link;

    // Preferred path: render the card from the SENDER's compose-time envelope
    // preview (m.extra['preview']) — zero recipient fetch.
    final envPreview = LinkPreview.fromEnvelope(m.extra?['preview']);
    if (envPreview != null) {
      final card = buildLinkPreviewCard(envPreview, pending: pending, theme: t);
      if (card != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && envPreview.isYouTube) {
            Analytics.capture('chat_youtube_card_shown', {'video_id': envPreview.videoId ?? ''});
          }
        });
        // WhatsApp order: the rich card sits ON TOP, the raw URL text below it.
        // The bubble drops to 4px padding for preview messages, so the text
        // below the card re-adds its own breathing room.
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            card,
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: link,
            ),
          ],
        );
      }
    }

    // Fallback (older messages / sender had no preview): keep the legacy inline
    // YouTube card so a bare youtube link still plays inline.
    final ytId = firstYouTubeId(m.text);
    if (ytId == null) return link;
    final ytUrl = urlSpans(m.text)
        .map((s) => s.url)
        .firstWhere((u) => firstYouTubeId(u) == ytId, orElse: () => 'https://youtu.be/$ytId');
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Analytics.capture('chat_youtube_card_shown', {'video_id': ytId});
    });
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      YouTubeCard(videoId: ytId, url: ytUrl, theme: t),
      const SizedBox(height: 6),
      link,
    ]);
  }

  /// [UI-BUBBLE-2] The overlay stack children for an edge-to-edge image/video:
  /// the "↪ Forwarded" label (top-left, when fwd:true) and the timestamp/status
  /// scrim (bottom-right). White-on-scrim so it reads over any image.
  List<Widget> _mediaMetaOverlays(_Msg m) {
    final st = _statusFor(m);
    final trailing = Row(mainAxisSize: MainAxisSize.min, children: [
      Text(m.ts != 0 ? _relTime(m.ts) : m.time,
          style: ADText.statCaption(c: Colors.white)),
      if (m.expireAt != null) ...[
        const SizedBox(width: 4),
        PhosphorIcon(PhosphorIcons.timer(PhosphorIconsStyle.bold), size: 11, color: Colors.white),
      ],
      if (st != null) ...[
        const SizedBox(width: 5),
        Icon(st.icon, size: 13, color: st.color == AD.iconSearch ? const Color(0xFF7EC8FF) : Colors.white),
      ],
    ]);
    return [
      if (m.forwarded) const MediaForwardedLabel(),
      MediaTimestampScrim(trailing: trailing),
    ];
  }

  Widget _mediaContent(_Msg m, BubbleTheme t, {bool overlayMeta = false}) {
    // STREAM E: sticker media (tagged via stickerMediaName). Renders at a fixed
    // 160dp via StickerMediaView. NOTE: pure sticker messages are now intercepted
    // in _bubble() and rendered fully bubble-LESS via _stickerBubbleLess (no
    // background/padding/tail) — see [UI-BUBBLE-STICKER]. This branch is retained
    // as a defensive fallback for any sticker that reaches _mediaContent (e.g. a
    // sticker with a caption/reply that keeps the normal bubble).
    final stName = m.media?.name ?? '';
    if (isStickerName(stName)) {
      final bytes = m.localBytes;
      if (bytes != null) return StickerMediaView(bytes: bytes, mine: m.me);
      if (m.media != null) {
        return FutureBuilder<Uint8List>(
          // [CHAT-UI-STATIC-1] Cached per attachment — an inline
          // `downloadAndDecrypt(...)` here restarted the decrypt (and flashed
          // the sticker back to an empty box) on every single rebuild.
          future: _chatMediaFuture(m.media!),
          builder: (c, snap) => snap.hasData
              ? StickerMediaView(bytes: snap.data!, mine: m.me)
              : const SizedBox(width: kStickerRenderSize, height: kStickerRenderSize),
        );
      }
    }
    // [AVAVM-PLAYER-1] Prefer the real `pendingKind` stamped at send time
    // (`_sendMedia`) over guessing `image` from `localBytes != null` alone —
    // that guess was ALWAYS wrong for an in-flight voice note (and video),
    // routing raw non-image bytes into `Image.memory()`, whose decode failure
    // fell through `errorBuilder` to a blank `SizedBox.shrink()`. `media?.kind`
    // stays authoritative once the upload completes.
    final kind = m.media?.kind ?? m.pendingKind ??
        (m.localBytes != null ? MediaKind.image : MediaKind.file);
    switch (kind) {
      case MediaKind.image:
        if (m.localBytes != null) {
          // [UI-BUBBLE-2] edge-to-edge, 78%-wide, overlaid meta.
          // [CHAT-UI-STATIC-1] The Hero flight is GONE (owner: no animation, no
          // effects). It lifted a third copy of the photo into the Navigator
          // overlay and tweened it at interpolated sizes, which read as the
          // photo appearing twice. Both the source wrapper here and the
          // `heroTag:` arguments are removed; `_openImageBytes` hard-cuts.
          if (overlayMeta) {
            return ChatImageCard(
              bytes: m.localBytes!,
              onTap: () => _openImageBytes(m.localBytes!, mime: m.media?.contentType),
              overlays: _mediaMetaOverlays(m),
              theme: t,
            );
          }
          // Tap → full-screen, pinch-to-zoom viewer with an X to close (and a
          // Copy button). Long-press still opens the message action sheet.
          return GestureDetector(
            onTap: () => _openImageBytes(m.localBytes!, mime: m.media?.contentType),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(Msg.rMd),
              // [CHAT-UI-MEDIA-1] cacheWidth bounds the decoded bitmap to ~2x the
              // layout width (DPR-aware) instead of decoding at full source
              // resolution — a scrolling thread of full-res photos was a memory
              // spike + jank source per the audit.
              // [CHAT-UI-STATIC-1] FIXED width AND height: with a width only,
              // the row had no height until the bitmap decoded and then grew.
              child: Image.memory(m.localBytes!,
                  width: kChatInlineImageWidth,
                  height: kChatInlineImageHeight,
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                  cacheWidth: (kChatInlineImageWidth * MediaQuery.of(context).devicePixelRatio * 2).round(),
                  errorBuilder: (_, __, ___) => _brokenMediaPlaceholder(
                      m: m, kind: 'image', reason: 'decode_failed',
                      width: kChatInlineImageWidth, height: kChatInlineImageHeight)),
            ),
          );
        }
        if (m.media != null) {
          // STREAM J (D17): auto-download off + no local bytes -> tap-to-download
          // placeholder instead of eagerly fetching. Tapping is a MANUAL fetch
          // (always allowed); it caches into m.localBytes and repaints the preview.
          // [CHAT-UI-STATIC-1] The loading/placeholder states must use the SAME
          // box the finished image will occupy, or the row shifts when the real
          // bytes land. `overlayMeta` picks between the edge-to-edge card
          // (bubble-wide × kChatImageBoxHeight) and the inline thumbnail.
          final phW = overlayMeta ? double.infinity : kChatInlineImageWidth;
          final phH = overlayMeta ? kChatImageBoxHeight : kChatInlineImageHeight;
          if (!_mediaAutoFetch) {
            return MediaDownloadPlaceholder(
              key: ValueKey('imgph_${m.media!.id}'),
              media: m.media!,
              width: phW,
              height: phH,
              onFetched: (bytes) {
                if (!mounted) return;
                _mutMsgs(() => m.localBytes = bytes);
              },
            );
          }
          return FutureBuilder<Uint8List>(
            // [CHAT-UI-STATIC-1] Cached per attachment. Built INLINE here it was
            // a brand-new Future on every rebuild, so the FutureBuilder restarted
            // the decrypt and dropped back to the placeholder each time — with
            // `_msgsRev` being thread-wide, that meant every media bubble in the
            // thread flashed whenever any one message changed.
            future: _chatMediaFuture(m.media!),
            builder: (ctx, snap) {
              if (snap.hasData) {
                m.localBytes = snap.data; // cache decrypted bytes
                // [UI-BUBBLE-2] edge-to-edge, 78%-wide, overlaid meta.
                // [CHAT-UI-STATIC-1] No Hero — see the local-bytes branch above.
                if (overlayMeta) {
                  return ChatImageCard(
                    bytes: snap.data!,
                    onTap: () => _openImageBytes(snap.data!, mime: m.media?.contentType),
                    overlays: _mediaMetaOverlays(m),
                    theme: t,
                  );
                }
                return GestureDetector(
                  onTap: () => _openImageBytes(snap.data!, mime: m.media?.contentType),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(Msg.rMd),
                    // [CHAT-UI-MEDIA-1] Same cacheWidth bound as the local-bytes
                    // branch above.
                    // [CHAT-UI-STATIC-1] Same FIXED width AND height too.
                    child: Image.memory(snap.data!,
                        width: kChatInlineImageWidth,
                        height: kChatInlineImageHeight,
                        fit: BoxFit.cover,
                        gaplessPlayback: true,
                        cacheWidth: (kChatInlineImageWidth * MediaQuery.of(context).devicePixelRatio * 2).round(),
                        errorBuilder: (_, __, ___) => _brokenMediaPlaceholder(
                            m: m, kind: 'image', reason: 'decode_failed',
                            width: kChatInlineImageWidth, height: kChatInlineImageHeight,
                            // [CHAT-UI-STATIC-1] RETRY CONTRACT: clearing
                            // `localBytes` alone is no longer enough — the future
                            // is cached now, so without the eviction below the
                            // retry would re-await the SAME failed/stale future
                            // forever and silently do nothing.
                            onRetry: () {
                              _forgetChatMediaFuture(m.media);
                              _mutMsgs(() => m.localBytes = null);
                            })),
                  ),
                );
              }
              if (snap.hasError) {
                // [CHAT-UI-STATIC-1] A cached future that completed with an error
                // would be re-awaited forever; drop it so the next rebuild (or an
                // explicit retry) starts a real new fetch.
                _forgetChatMediaFuture(m.media);
                return _fileChip(m, PhosphorIcons.imageBroken(PhosphorIconsStyle.bold), 'Photo');
              }
              // [CHAT-UI-MEDIA-1] Fixed-size placeholder instead of a bare
              // spinner. [CHAT-UI-STATIC-1] Sized to the EXACT box the decoded
              // image will occupy (it used to be 220x140 regardless), so the row
              // does not resize when the decrypted image lands.
              return MediaShimmerPlaceholder(width: phW, height: phH);
            },
          );
        }
        return _fileChip(m, PhosphorIcons.image(PhosphorIconsStyle.bold), 'Photo');
      case MediaKind.audio:
        // [AVAVM-PLAYER-1] Explicit posting feedback while `media` is still
        // null and the upload is in flight — this is the fix for the "empty
        // bubble, is my voice note gone?" report. Checked BEFORE the
        // auto-fetch placeholder below (which is only for ALREADY-uploaded,
        // not-yet-downloaded notes) and before the playable bubble.
        if (m.media == null && m.uploading) {
          return PendingVoiceNoteBubble(onRight: m.me && !_isAvaBubble(m), theme: t);
        }
        // Upload FAILED — an explicit error beats a bubble that spins
        // forever. Retry re-runs the exact same upload the status-row "tap to
        // retry" affordance uses (both now honour `m.pendingKind`).
        if (m.media == null && m.failed) {
          return FailedVoiceNoteBubble(
            onRight: m.me && !_isAvaBubble(m),
            // [MEDIA-RETRY-KIND-1] Same exact-kind retry path the status-row
            // "tap to retry" affordance uses.
            onRetry: m.localBytes == null ? null : () => _retryMediaUpload(m),
            theme: t,
          );
        }
        // STREAM J (D17): auto-download off + nothing cached -> small download
        // button. Tapping fetches (manual = allowed) and repaints into play control.
        if (!_mediaAutoFetch && m.localBytes == null && m.media != null) {
          return MediaDownloadPlaceholder(
            key: ValueKey('audioph_${m.media!.id}'),
            media: m.media!,
            compact: true,
            onFetched: (bytes) {
              if (!mounted) return;
              _mutMsgs(() => m.localBytes = bytes);
            },
          );
        }
        // [UI-BUBBLE-3] rich voice-note bubble: large circular play, waveform,
        // live duration, and a 1x/1.5x/2x speed chip after play starts.
        // [VOICE-SCRUB-1] Feed the bubble the shared player's REAL position and
        // duration — but only for the note that's actually open. Every other
        // voice bubble gets zero/null, so they render idle instead of all
        // mirroring the playhead of whichever note happens to be playing.
        final isOpen = _openAudioId == m.id;
        // [AVAVM-PLAYER-1] "Resume where you left off": for a note that ISN'T
        // the currently-open one, fall back to its persisted saved
        // position/duration (per-account, survives navigating away and a
        // cold start) so the bubble renders already parked where the user
        // paused it, instead of looking untouched until re-opened.
        final trackId = _audioTrackId(m);
        final savedPos = isOpen ? null : AudioPlaybackService.I.savedPosition(trackId);
        final savedDur = isOpen ? null : AudioPlaybackService.I.knownDuration(trackId);
        return VoiceNoteBubble(
          key: ValueKey('voice_${m.media?.id ?? m.id}'),
          playing: _playingAudioId == m.id,
          speed: _audioSpeed,
          onRight: m.me && !_isAvaBubble(m),
          onPlayPause: () => _playAudio(m),
          onCycleSpeed: _cycleAudioSpeed,
          position: isOpen ? _audioPos : (savedPos ?? Duration.zero),
          duration: isOpen ? _audioDur : savedDur,
          onSeek: isOpen ? (to) => _seekAudio(m, to) : null,
          theme: t,
        );
      case MediaKind.video:
        // Rich card: first-frame thumbnail + tap-to-play inline; the expand
        // glyph opens the fullscreen player. [UI-BUBBLE-2] when it's the whole
        // bubble, fill the width (≤78%, capped ~320dp by the card's 16:9) and
        // overlay the forwarded label + timestamp scrim.
        if (overlayMeta) {
          return LayoutBuilder(builder: (ctx, cons) {
            final w = cons.maxWidth.isFinite
                ? cons.maxWidth
                : MediaQuery.of(context).size.width * 0.78;
            return Stack(children: [
              ChatVideoCard(
                key: ValueKey('vid_${m.media?.id ?? m.id}'),
                media: m.media,
                localBytes: m.localBytes,
                width: w,
                autoFetch: _mediaAutoFetch,
                onFullscreen: () => _openVideo(m),
                theme: t,
              ),
              ..._mediaMetaOverlays(m),
            ]);
          });
        }
        return ChatVideoCard(
          key: ValueKey('vid_${m.media?.id ?? m.id}'),
          media: m.media,
          localBytes: m.localBytes,
          width: 220,
          autoFetch: _mediaAutoFetch,
          onFullscreen: () => _openVideo(m),
          theme: t,
        );
      case MediaKind.file:
        // Rich card: PDF first-page thumbnail, or a typed card (badge + name +
        // size) for any other file. Tap downloads/opens it.
        final fname = (m.media?.name.isNotEmpty == true)
            ? m.media!.name
            : m.text.replaceFirst('📎 ', '');
        // [UI-BUBBLE-2] full-width file row (no dead right space): fill the bubble
        // width so the filename can use the whole line, ellipsised.
        return LayoutBuilder(builder: (ctx, cons) {
          final w = cons.maxWidth.isFinite && cons.maxWidth > 0
              ? cons.maxWidth
              : MediaQuery.of(context).size.width * 0.78;
          final card = ChatFileCard(
            key: ValueKey('file_${m.media?.id ?? m.id}'),
            media: m.media,
            localBytes: m.localBytes,
            name: fname,
            mime: m.media?.contentType ?? '',
            size: m.media?.size ?? (m.localBytes?.length ?? 0),
            width: w,
            autoFetch: _mediaAutoFetch,
            onOpen: () => _openFile(m, fname),
            theme: t,
          );
          // [CHAT-PDFVIEW-1] Overlay a spinner while the tap downloads/decrypts
          // so the bubble shows progress instead of appearing dead.
          if (!m.fileOpening) return card;
          return Stack(alignment: Alignment.center, children: [
            card,
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                    color: Colors.black.withOpacity(0.18),
                    borderRadius: BorderRadius.circular(AD.rListCard)),
                child: const Center(
                    child: SizedBox(
                        width: 22, height: 22,
                        child: CircularProgressIndicator(strokeWidth: 2))),
              ),
            ),
          ]);
        });
    }
  }

  /// [CHAT-PDFVIEW-1] Open an attachment. Downloads + decrypts (or reuses cached
  /// bytes) with a bubble spinner, then routes PDFs/images to the in-app viewer
  /// (pinch-zoom, page indicator, share). Any other type goes to the OS open sheet
  /// with a CLEAR snackbar when no handler exists — replacing the old silent
  /// `launchUrl(external)` that "did nothing" when no app claimed the file.
  Future<void> _openFile(_Msg m, String name) async {
    if (m.fileOpening) return;
    Analytics.capture('chat_file_open', {
      'kind': 'file',
      'mime': m.media?.contentType ?? '',
    });
    _mutMsgs(() => m.fileOpening = true);
    try {
      final bytes = m.localBytes ??
          (m.media != null ? await MediaService.downloadAndDecrypt(m.media!) : null);
      if (!mounted) return;
      if (bytes == null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("Couldn't load $name")));
        return;
      }
      _msgsRev++; // m.localBytes assigned directly below (no setState needed here — the finally block's _mutMsgs repaints)
      m.localBytes = bytes;
      final mime = m.media?.contentType ?? '';
      if (FileViewerScreen.canView(mime, name)) {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => FileViewerScreen(bytes: bytes, name: name, mime: mime),
        ));
      } else {
        final ok = await openFileWithOs(bytes, name, mime);
        if (!ok && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text("No app on this device can open $name — tap share to send it elsewhere.")));
        }
      }
    } catch (e) {
      AvaLog.I.log('media', 'open file failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("Couldn't open $name")));
      }
    } finally {
      if (mounted) _mutMsgs(() => m.fileOpening = false);
    }
  }

  Widget _fileChip(_Msg m, IconData icon, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, color: AD.bubbleInInk),
        const SizedBox(width: 8),
        Flexible(child: Text(label,
            maxLines: 1, overflow: TextOverflow.ellipsis,
            style: ADText.rowName(c: AD.bubbleInInk))),
      ]);
}
