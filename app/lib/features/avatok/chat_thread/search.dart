part of '../chat_thread.dart';

// Extension on the private State class: same library, so every private
// field/method of `_ChatThreadScreenState` resolves unchanged.
// ignore_for_file: invalid_use_of_protected_member

extension _ChatThreadSearch on _ChatThreadScreenState {

  /// True if [text] is a control/receipt envelope (read/delivered/typing/ack)
  /// that should never appear as a chat bubble.
  bool _isControlEnvelope(String text) {
    final t = text.trim();
    if (t.isEmpty || t.codeUnitAt(0) != 0x7B /* { */) return false;
    if (t.contains('"read_ts"') || t.contains('"delivered_ts"')) return true;
    try {
      final j = jsonDecode(t);
      if (j is Map) {
        const ctrl = {'read', 'delivered', 'typing', 'ack', 'receipt', 'seen', 'del', 'gdel'};
        return ctrl.contains(j['t']) || ctrl.contains(j['type']);
      }
    } catch (_) { /* not JSON → real text */ }
    return false;
  }

  /// [CHAT-RAWENV-1] (owner report 2026-07-16, pic 4) — the backstop that turns
  /// "render the machine's plumbing at the user" into "render nothing".
  ///
  /// True if [text] is one of OUR wire envelopes rather than something a human
  /// typed. `_onDm` seeds `text = m.payload` and only overwrites it inside a
  /// `try` block, so ANY envelope it doesn't explicitly branch on — a new `t`
  /// from a newer build, a `status` fan-out, a field-shape change that makes
  /// `fromEnvelope` throw — falls out of the `catch` with the raw JSON still in
  /// `text` and gets drawn as a chat bubble. That is how a photo turned into a
  /// wall of `{"t":"status",…,"who":"Humphrey Davy"}` on the recipient's screen.
  ///
  /// `_isControlEnvelope` only ever covered receipts, so it never caught this.
  /// This is deliberately broader: an object with a **string `t`** is, by
  /// construction, an AvaTOK envelope — `toEnvelope()` and every `_send…` path
  /// stamps one, and nothing else does. A real user typing `{"t":"hi"}` is a
  /// rounding error next to leaking key material into a conversation. Drop it.
  bool _isAppEnvelope(String text) {
    final t = text.trim();
    if (t.isEmpty || t.codeUnitAt(0) != 0x7B /* { */) return false;
    try {
      final j = jsonDecode(t);
      return j is Map && j['t'] is String;
    } catch (_) { /* not JSON → real text */ }
    return false;
  }

  /// Reset any smart-search state — called when the query text changes so stale
  /// AI results/spinner/error never linger for a different query.
  void _resetAiSearch() {
    if (_aiSearching || _aiHits.isNotEmpty || _aiSearchError ||
        _aiSearchedQuery.isNotEmpty || _aiShowOther || _aiBrainOff) {
      _aiSearching = false;
      _aiHits = const [];
      _aiSearchError = false;
      _aiSearchedQuery = '';
      _aiShowOther = false;
      _aiBrainOff = false;
    }
  }

  /// Run "smart search": query the user's own semantic index (Cloudflare AI
  /// Search) scoped best-effort to THIS conversation, then map hits back to local
  /// messages by fuzzy text match. Literal search is untouched — this is additive.
  ///
  /// Gated by the messaging AvaBrain consent (the same ingestion the smart index
  /// is built from): if it's off we show only the literal results plus a one-line
  /// "enable AvaBrain" hint. Never throws — errors surface as a graceful state.
  Future<void> _smartSearch() async {
    final q = _searchQuery.trim();
    if (q.isEmpty || _aiSearching) return;
    // Same query already answered → don't refetch.
    if (_aiSearchedQuery == q && (_aiHits.isNotEmpty || _aiSearchError)) return;

    // Respect the existing BrainConsent gate (E2E/private content is only ever
    // indexed under the user's own consented ingestion; if that's off there is
    // nothing to search and we must not pretend otherwise).
    if (!await BrainConsent.isOn('messaging')) {
      if (!mounted) return;
      setState(() { _aiBrainOff = true; _aiHits = const []; _aiSearchError = false; });
      return;
    }

    setState(() { _aiSearching = true; _aiSearchError = false; _aiBrainOff = false; });
    final t0 = DateTime.now().millisecondsSinceEpoch;
    var ok = false;
    var matchedLocal = 0;
    List<_AiHit> hits = const [];
    try {
      final res = await ApiAuth.postJson(
        _brainSearchUrl(),
        {'q': q, 'conv': _serverConvId ?? '', 'name': widget.chat.name},
        timeout: const Duration(seconds: 12),
      );
      if (res.statusCode == 200) {
        final body = jsonDecode(res.body) as Map<String, dynamic>;
        final raw = (body['hits'] as List?) ?? const [];
        final parsed = <_AiHit>[];
        for (final h in raw) {
          if (h is! Map) continue;
          final snip = (h['text'] ?? '').toString().trim();
          if (snip.isEmpty) continue;
          final inThread = h['inThread'] == true;
          final local = _matchLocalMessage(snip);
          if (local != null) matchedLocal++;
          parsed.add(_AiHit(snip, inThread, local?.id, local?.text ?? ''));
        }
        // Order: in-thread matches first, then in-thread unmatched, then others.
        parsed.sort((a, b) {
          int rank(_AiHit x) => x.localId != null ? 0 : (x.inThread ? 1 : 2);
          return rank(a).compareTo(rank(b));
        });
        hits = parsed;
        ok = true;
      }
    } catch (_) {
      ok = false;
    }
    final ms = DateTime.now().millisecondsSinceEpoch - t0;
    Analytics.capture('chat_ai_search',
        {'ok': ok, 'ms': ms, 'hits': hits.length, 'matched_local': matchedLocal});
    if (!mounted) return;
    setState(() {
      _aiSearching = false;
      _aiSearchedQuery = q;
      _aiSearchError = !ok;
      _aiHits = hits;
    });
  }

  /// Fuzzy-match a server snippet to a message loaded in THIS thread. Strips any
  /// "Me: "/"Them: "/"Ava: " speaker label the index added, folds accents/case,
  /// then looks for a two-way containment against each local bubble's text.
  _Msg? _matchLocalMessage(String snippet) {
    var s = snippet.replaceFirst(RegExp(r'^(me|them|you|ava)\s*:\s*', caseSensitive: false), '').trim();
    final needle = _foldSearch(s);
    if (needle.length < 3) return null;
    _Msg? best;
    var bestLen = 0;
    for (final m in _msgs) {
      if (m.special != null || m.text.trim().isEmpty) continue;
      final hay = _foldSearch(m.text);
      if (hay.isEmpty) continue;
      // Two-way containment: the message contains the snippet, or the snippet
      // (a longer indexed line) contains the whole message.
      final overlap = hay.contains(needle) || (needle.length > hay.length && needle.contains(hay));
      if (overlap && hay.length > bestLen) { best = m; bestLen = hay.length; }
    }
    return best;
  }

  /// Tap a matched AI hit → reuse the existing literal-search filter to reveal the
  /// message: set the query to a distinctive slice of the matched local text so
  /// the list filters down to (and shows) that bubble.
  void _openAiHit(_AiHit hit) {
    if (hit.localId == null || hit.localText.trim().isEmpty) return;
    Analytics.capture('chat_ai_search_open', {'in_thread': hit.inThread});
    // Pick a distinctive slice (first ~5 words) so the literal filter narrows to
    // this message but the search box stays readable/editable.
    final words = hit.localText.trim().split(RegExp(r'\s+'));
    final slice = (words.length > 6 ? words.sublist(0, 6) : words).join(' ');
    _searchCtrl.text = slice;
    setState(() {
      _searchQuery = slice;
      _resetAiSearch();
    });
  }

  /// Compact "AI results" section rendered under the literal hits (or in the empty
  /// state). Handles spinner / error / empty / consent-off, all in Zine styling.
  // [AVAGRP-BUBBLE-2] This whole search-results section renders directly on the
  // canvas (inside the message ListView, not a modal sheet) — every
  // `AD.textTertiary`/`ADText.preview()` bare-default below was white/white-45%
  // text tuned for the old dark canvas and is close to invisible on the new
  // white one. Swapped to the wallpaper-aware `_canvas*` getters (same class of
  // fix as `_hiddenBubble`/`_daySeparator`). `AD.iconSearch`/`AD.danger` are
  // saturated accent colours that already read fine on both light and dark
  // backgrounds, so those are left as-is.
  Widget _aiResultsSection() {
    final children = <Widget>[
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
        child: Row(children: [
          Expanded(child: Container(height: 1, color: _canvasTertiary.withValues(alpha: 0.4))),
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 13, color: AD.iconSearch),
          const SizedBox(width: 5),
          Text('AI RESULTS', style: ADText.statCaption(c: AD.iconSearch)),
          const SizedBox(width: 8),
          Expanded(child: Container(height: 1, color: _canvasTertiary.withValues(alpha: 0.4))),
        ]),
      ),
    ];

    if (_aiBrainOff) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text('Enable AvaBrain for your messages in Settings to search by meaning.',
            textAlign: TextAlign.center, style: ADText.preview(c: _canvasMeta)),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    if (_aiSearching) {
      children.add(const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Center(child: SizedBox(
            width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: AD.iconSearch))),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    if (_aiSearchError) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text("Couldn't reach smart search. Tap to retry.",
            textAlign: TextAlign.center, style: ADText.preview(c: AD.danger)),
      ));
      children.add(_aiSearchButton(label: 'Retry smart search'));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }

    final inThread = _aiHits.where((h) => h.localId != null).toList();
    final other = _aiHits.where((h) => h.localId == null).toList();
    if (inThread.isEmpty && other.isEmpty) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 12),
        child: Text('No meaning-based matches in this chat.',
            textAlign: TextAlign.center, style: ADText.preview(c: _canvasMeta)),
      ));
      return Column(mainAxisSize: MainAxisSize.min, children: children);
    }
    for (final h in inThread) children.add(_aiHitTile(h, tappable: true));
    if (other.isNotEmpty) {
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
        child: GestureDetector(
          onTap: () => setState(() => _aiShowOther = !_aiShowOther),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(
                _aiShowOther ? PhosphorIcons.caretDown(PhosphorIconsStyle.bold)
                    : PhosphorIcons.caretRight(PhosphorIconsStyle.bold),
                size: 12, color: _canvasTertiary),
            const SizedBox(width: 4),
            Text('${other.length} from your other chats',
                style: ADText.statCaption(c: _canvasTertiary)),
          ]),
        ),
      ));
      if (_aiShowOther) for (final h in other) children.add(_aiHitTile(h, tappable: false));
    }
    return Column(mainAxisSize: MainAxisSize.min, children: children);
  }

  /// Footer under the literal hits: either the "Search with AI" opt-in pill (not
  /// yet run for this query) or the AI results section (spinner/hits/error).
  Widget _aiSearchFooter() {
    final q = _searchQuery.trim();
    final ranForThisQuery = _aiSearchedQuery == q &&
        (_aiHits.isNotEmpty || _aiSearchError || _aiBrainOff);
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 4),
      child: (_aiSearching || ranForThisQuery)
          ? _aiResultsSection()
          : _aiSearchButton(),
    );
  }

  Widget _aiHitTile(_AiHit h, {required bool tappable}) {
    final label = h.localId != null ? h.localText : h.snippet;
    final tile = Container(
      margin: const EdgeInsets.fromLTRB(16, 3, 16, 3),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: _sysPillBg,
        borderRadius: BorderRadius.circular(Msg.rMd),
        border: Border.all(color: tappable ? _canvasInk : _canvasTertiary, width: tappable ? 2 : 1),
      ),
      child: Row(children: [
        Expanded(child: Text(label, maxLines: 2, overflow: TextOverflow.ellipsis,
            style: ADText.rowName(c: _canvasInk))),
        if (tappable) ...[
          const SizedBox(width: 8),
          PhosphorIcon(PhosphorIcons.arrowUpRight(PhosphorIconsStyle.bold), size: 15, color: AD.iconSearch),
        ],
      ]),
    );
    if (!tappable) return tile;
    return GestureDetector(onTap: () => _openAiHit(h), behavior: HitTestBehavior.opaque, child: tile);
  }

  /// The explicit "Search with AI" pill — shown under literal results (and in the
  /// empty state) so the user can opt into the semantic step.
  Widget _aiSearchButton({String label = 'Search with AI'}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: GestureDetector(
            onTap: _smartSearch,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
              decoration: BoxDecoration(
                color: AD.iconVideo,
                borderRadius: Msg.brMd,
                border: Border.all(color: _sysPillBorder, width: 1),
                boxShadow: const [],
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), size: 15, color: AD.iconSearch),
                const SizedBox(width: 6),
                Text(label, style: ADText.rowName(c: AD.iconSearch)),
              ]),
            ),
          ),
        ),
      );

  /// Empty state shown when an in-thread search finds no literal match. Keeps the
  /// user IN the thread (the complaint was being kicked out) and offers Ava as a
  /// meaning-based fallback over the on-device transcript.
  /// [AVAGRP-BUBBLE-2] Renders directly on the canvas — every colour below was
  /// `AD.textTertiary`/bare `ADText.rowName()`/`ADText.preview()` (white /
  /// white-alpha, tuned for the old dark canvas) and read as invisible text on
  /// the new white one, plus a dark `AD.overlaySheet` pill for "Discuss with
  /// Ava" that was its own small hole punched in the page. Swapped to the
  /// wallpaper-aware `_canvas*`/`_sysPill*` getters (same fix class as
  /// `_hiddenBubble`).
  /// [CHAT-UI-TELEMETRY-1] Centered nudge for a genuinely empty, non-searching
  /// thread — a blank canvas used to be indistinguishable from "still loading".
  Widget _emptyThreadState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Row(mainAxisSize: MainAxisSize.min, children: [
            PhosphorIcon(PhosphorIcons.handWaving(PhosphorIconsStyle.regular),
                size: 18, color: _canvasInk),
            const SizedBox(width: Msg.s2),
            Text('Say hi', style: ADText.threadName(c: _canvasInk)),
          ]),
          const SizedBox(height: 8),
          Text(
            'Messages here are end-to-end encrypted. Nobody outside this chat — not even AvaTOK — can read them.',
            textAlign: TextAlign.center,
            style: ADText.preview(c: _canvasMeta),
          ),
        ]),
      ),
    );
  }

  Widget _searchEmptyState(String query) {
    final q = query.trim();
    final ranForThisQuery = _aiSearchedQuery == q &&
        (_aiHits.isNotEmpty || _aiSearchError || _aiBrainOff);
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            size: 30, color: _canvasTertiary),
        const SizedBox(height: 10),
        Text('No messages match “$query”.',
            textAlign: TextAlign.center, style: ADText.rowName(c: _canvasInk)),
        const SizedBox(height: 4),
        Text('Search this chat by meaning, not just exact words.',
            textAlign: TextAlign.center, style: ADText.preview(c: _canvasMeta)),
        const SizedBox(height: 14),
        // Server-side smart (semantic) search over the user's own consented
        // index — the primary "AI search" path. Shows spinner/hits/error once run.
        if (_aiSearching || ranForThisQuery)
          _aiResultsSection()
        else
          _aiSearchButton(),
        const SizedBox(height: 10),
        // On-device "Discuss with Ava" — reads the visible bubbles locally and
        // answers by meaning (kept as a secondary, fully-local option).
        GestureDetector(
          onTap: () {
            setState(() { _searchMode = false; _searchQuery = ''; _resetAiSearch(); });
            _discussWithAva();
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
            decoration: BoxDecoration(
              color: _sysPillBg,
              borderRadius: Msg.brMd,
              border: Border.all(color: _sysPillBorder, width: 1),
              boxShadow: const [],
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.chatCircleText(PhosphorIconsStyle.bold),
                  size: 15, color: _canvasInk),
              const SizedBox(width: 6),
              Text('Discuss with Ava',
                  style: ADText.rowName(c: _canvasInk)),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _searchBar() => Row(children: [
        IconButton(icon: PhosphorIcon(PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold), color: AD.textPrimary),
            onPressed: () => setState(() { _searchMode = false; _searchQuery = ''; _resetAiSearch(); })),
        Expanded(child: TextField(
          autofocus: true,
          controller: _searchCtrl,
          onChanged: (v) => setState(() { _searchQuery = v; _resetAiSearch(); }),
          style: ADText.rowName(),
          cursorColor: AD.iconSearch,
          decoration: InputDecoration(
              hintText: 'Search messages',
              hintStyle: ADText.rowName().copyWith(
                  color: AD.textTertiary, fontWeight: FontWeight.w700),
              border: InputBorder.none),
        )),
      ]);
}
