import 'dart:math' as math;

import 'package:drift/drift.dart' show Variable;

import '../analytics.dart';
import '../ava_log.dart';
import '../db.dart';
import '../profile_store.dart';

/// AvaProfileMemory — Ava's on-device, per-account long-term memory base.
///
/// The product idea: with Local Ava AI on, Ava is YOUR personal AI. She keeps
/// what she learns about you ON THE DEVICE, answers from it locally, and only
/// consults the cloud reasoning model for things she doesn't have.
///
/// We deliberately do NOT add mem0 / redis / a second vector engine on the phone.
/// Everything lives in the SAME per-account SQLite file we already use (`Db.I`,
/// scoped by `AccountScope.id`), and semantic/episodic memory keeps living in the
/// existing on-device vector store ([AvaOnDeviceRag]). This class adds the four
/// cheap, robust STRUCTURED layers around it:
///
///   • Layer 1 — Profile     : who you are (name, handle, bio). Seeded from the
///                             account profile; rarely changes.
///   • Layer 2 — Preferences : likes / dislikes / answer style Ava picks up.
///   • Layer 3 — Habits      : topics you ask about, your active hours, and
///                             average message length — counted, not guessed.
///   • Layer 4 — Traits      : Ava's synthesized opinion of you ("technical",
///                             "privacy-focused", "prefers concise"), DERIVED
///                             from the habits above by simple rules — so it
///                             never depends on the tiny model emitting JSON.
///
/// [contextBlock] assembles a short "About the user" note (kept small on
/// purpose — a handful of facts, not hundreds) that callers inject before each
/// on-device answer so Ava always knows who she's talking to.
class AvaProfileMemory {
  AvaProfileMemory._();
  static final AvaProfileMemory I = AvaProfileMemory._();

  bool _ready = false;
  bool _seeded = false;

  Future<void> _ensure() async {
    if (_ready) return;
    final db = Db.I;
    // Layer 1 — Profile (key/value).
    await db.customStatement(
        "CREATE TABLE IF NOT EXISTS ava_profile (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0);");
    // Layer 2 — Preferences (weighted; weight rises each time we see the cue).
    await db.customStatement(
        "CREATE TABLE IF NOT EXISTS ava_prefs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0);");
    // Layer 3 — Habits: topic frequency + counters (msg_count, len_sum, hour_*).
    await db.customStatement(
        "CREATE TABLE IF NOT EXISTS ava_topics (topic TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0);");
    await db.customStatement(
        "CREATE TABLE IF NOT EXISTS ava_stats (k TEXT PRIMARY KEY, v REAL NOT NULL DEFAULT 0);");
    _ready = true;
    // Best-effort first seed of the static profile layer.
    if (!_seeded) {
      _seeded = true;
      await seedFromProfile();
    }
  }

  // ── Layer 1: Profile ─────────────────────────────────────────────────────────

  /// Pull the static facts from the account profile into Ava's memory. Safe to
  /// call repeatedly (e.g. after the user edits their profile) — only non-empty
  /// fields are written.
  Future<void> seedFromProfile() async {
    try {
      await _ensure();
      final p = await ProfileStore().load();
      if (p.displayName.isNotEmpty) await setProfileField('name', p.displayName);
      if (p.handle.isNotEmpty) await setProfileField('handle', '@${p.handle}');
      if (p.bio.isNotEmpty) await setProfileField('bio', p.bio);
    } catch (e) {
      AvaLog.I.log('ava_mem', 'seedFromProfile failed: $e');
    }
  }

  Future<void> setProfileField(String key, String value) async {
    final v = value.trim();
    if (v.isEmpty) return;
    await _ensure();
    await Db.I.customStatement(
      'INSERT INTO ava_profile (k, v, updated_at) VALUES (?1, ?2, ?3) '
      'ON CONFLICT(k) DO UPDATE SET v=?2, updated_at=?3',
      [key, v, DateTime.now().millisecondsSinceEpoch],
    );
  }

  // ── Layer 2: Preferences ─────────────────────────────────────────────────────

  /// Record a preference Ava has observed. [kind] is like|dislike|style. The
  /// same preference seen again just gains weight, so the strongest float to the
  /// top of [contextBlock].
  Future<void> addPreference(String kind, String value) async {
    final val = value.trim();
    if (val.isEmpty) return;
    await _ensure();
    final id = '$kind:${val.toLowerCase()}';
    await Db.I.customStatement(
      'INSERT INTO ava_prefs (id, kind, value, weight, updated_at) VALUES (?1, ?2, ?3, 1, ?4) '
      'ON CONFLICT(id) DO UPDATE SET weight=weight+1, updated_at=?4',
      [id, kind, val, DateTime.now().millisecondsSinceEpoch],
    );
  }

  // ── Layer 3: Habits (observed, not guessed) ──────────────────────────────────

  /// Update Ava's lightweight intuition from one USER message. Pure counting —
  /// no model call — so it's cheap enough to run on every message and can never
  /// hallucinate. Tracks message volume, length, active hour, the topics you
  /// raise, and a couple of explicit answer-style cues.
  Future<void> observeUserMessage(String text) async {
    final t = text.trim();
    if (t.isEmpty) return;
    try {
      await _ensure();
      final now = DateTime.now();
      await _bumpStat('msg_count', 1);
      await _bumpStat('msg_len_sum', t.length.toDouble());
      await _bumpStat('hour_${now.hour}', 1);

      for (final topic in _topicsIn(t)) {
        await Db.I.customStatement(
          'INSERT INTO ava_topics (topic, hits, last_at) VALUES (?1, 1, ?2) '
          'ON CONFLICT(topic) DO UPDATE SET hits=hits+1, last_at=?2',
          [topic, now.millisecondsSinceEpoch],
        );
        // Surface "Ava is getting smarter" milestones: the first time a topic
        // appears, and again once it's confirmed enough to be a real interest.
        final rows = await Db.I
            .customSelect('SELECT hits FROM ava_topics WHERE topic = ?1',
                variables: [Variable<String>(topic)])
            .get();
        final hits = rows.isNotEmpty ? rows.first.read<int>('hits') : 1;
        if (hits == 1) {
          _emitLearned('interest_seen', topic, _confidence(1), 1);
        } else if (hits == kConfirmEvidence) {
          _emitLearned('interest_confirmed', topic, _confidence(hits), hits);
        }
      }

      final lower = t.toLowerCase();
      if (lower.contains('keep it short') ||
          lower.contains('be brief') ||
          lower.contains('in short') ||
          lower.contains('tl;dr') ||
          lower.contains('short answer')) {
        await addPreference('style', 'prefers short, concise answers');
      }
      if (lower.contains('in detail') ||
          lower.contains('step by step') ||
          lower.contains('step-by-step') ||
          lower.contains('explain fully')) {
        await addPreference('style', 'likes detailed, step-by-step answers');
      }
    } catch (e) {
      AvaLog.I.log('ava_mem', 'observe failed: $e');
    }
  }

  Future<void> _bumpStat(String key, double by) => Db.I.customStatement(
        'INSERT INTO ava_stats (k, v) VALUES (?1, ?2) '
        'ON CONFLICT(k) DO UPDATE SET v=v+?2',
        [key, by],
      );

  // ── The injected "About the user" note ───────────────────────────────────────

  /// A compact note for Ava's prompt so she knows who she's helping. Kept small
  /// on purpose (a handful of facts, top few topics/prefs) — stuffing hundreds of
  /// memories destroys the small model's context. Returns '' when nothing is
  /// known yet (so callers can skip it cleanly).
  Future<String> contextBlock() async {
    try {
      await _ensure();
      final db = Db.I;
      final profRows = await db.customSelect('SELECT k, v FROM ava_profile').get();
      final prof = <String, String>{
        for (final r in profRows) r.read<String>('k'): r.read<String>('v'),
      };
      final prefs = (await db
              .customSelect('SELECT value FROM ava_prefs ORDER BY weight DESC LIMIT 6')
              .get())
          .map((r) => r.read<String>('value'))
          .toList();
      // Topics with CONFIDENCE (evidence) + DECAY (recency): a one-off comment
      // never makes it in, and an interest the user stopped raising fades out —
      // so Ava reflects who the user is NOW, not a pile of stale facts.
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      final topicRows = await db
          .customSelect('SELECT topic, hits, last_at FROM ava_topics ORDER BY hits DESC LIMIT 24')
          .get();
      final scored = <MapEntry<String, double>>[];
      for (final r in topicRows) {
        final topic = r.read<String>('topic');
        final hits = r.read<int>('hits');
        final lastAt = r.read<int>('last_at');
        final days = (nowMs - lastAt) / 86400000.0;
        if (hits < 2 && days > 7) continue; // forget one-off mentions
        final score = _confidence(hits) * _recency(days);
        if (score < 0.12) continue; // decayed away
        scored.add(MapEntry(topic, score));
      }
      scored.sort((a, b) => b.value.compareTo(a.value));
      final topics = scored.take(6).map((e) => e.key).toList();
      final traits = _synthTraits(topics, prefs);
      final hours = await _activeHours();

      if (prof.isEmpty && prefs.isEmpty && topics.isEmpty) return '';

      final sb = StringBuffer();
      sb.writeln(
          "ABOUT THE USER (Ava's private on-device notes — use to personalise; do not recite verbatim):");
      final name = prof['name'] ?? '';
      final handle = prof['handle'] ?? '';
      if (name.isNotEmpty) {
        sb.writeln('- Name: $name${handle.isNotEmpty ? ' ($handle)' : ''}');
      }
      if ((prof['bio'] ?? '').isNotEmpty) sb.writeln('- About: ${prof['bio']}');
      if (traits.isNotEmpty) sb.writeln('- Seems: ${traits.join(', ')}');
      if (topics.isNotEmpty) sb.writeln('- Often asks about: ${topics.join(', ')}');
      if (prefs.isNotEmpty) sb.writeln('- Preferences: ${prefs.join('; ')}');
      if (hours.isNotEmpty) sb.writeln('- Usually active around: $hours');
      final out = sb.toString().trim();

      // ignore: unawaited_futures
      Analytics.capture('ava_memory_context', {
        'chars': out.length,
        'topics': topics.length,
        'prefs': prefs.length,
        'traits': traits.length,
      });
      return out;
    } catch (e) {
      AvaLog.I.log('ava_mem', 'contextBlock failed: $e');
      return '';
    }
  }

  // ── Layer 4: Traits (derived from habits by simple rules) ─────────────────────

  /// Evidence count at which a topic is treated as a confirmed interest.
  static const int kConfirmEvidence = 5;

  /// Confidence in a learned fact from how many times we've seen it. One mention
  /// is weak (~12%); it climbs fast and saturates (47 mentions ≈ 99.7%).
  static double _confidence(int hits) =>
      double.parse((1 - math.exp(-hits / 8.0)).toStringAsFixed(2));

  /// Recency weight — a fact the user stopped raising decays (≈45-day half-life)
  /// so Ava forgets stale interests instead of hoarding them forever.
  static double _recency(double days) => math.exp(-days / 45.0);

  void _emitLearned(String type, String value, double confidence, int evidence) {
    // ignore: unawaited_futures
    Analytics.capture('ava_memory_learned', {
      'type': type,
      'value': value,
      'confidence': confidence,
      'evidence_count': evidence,
    });
  }

  List<String> _synthTraits(List<String> topics, List<String> prefs) {
    final t = topics.map((e) => e.toLowerCase()).toList();
    final traits = <String>{};
    if (t.any((x) =>
        x.contains('ai') || x.contains('coding') || x.contains('cloudflare'))) {
      traits.add('technical');
    }
    if (t.any((x) => x.contains('startup'))) traits.add('entrepreneurial');
    if (t.any((x) => x.contains('privacy') || x.contains('nostr'))) {
      traits.add('privacy-focused');
    }
    if (prefs.any((p) => p.toLowerCase().contains('short') ||
        p.toLowerCase().contains('concise'))) {
      traits.add('prefers concise answers');
    }
    return traits.toList();
  }

  Future<String> _activeHours() async {
    try {
      final rows = await Db.I
          .customSelect("SELECT k, v FROM ava_stats WHERE k LIKE 'hour_%' ORDER BY v DESC LIMIT 2")
          .get();
      final hrs = <String>[];
      for (final r in rows) {
        final k = r.read<String>('k');
        final h = int.tryParse(k.substring(5)) ?? -1;
        if (h >= 0) hrs.add('${h.toString().padLeft(2, '0')}:00');
      }
      return hrs.join(', ');
    } catch (_) {
      return '';
    }
  }

  // ── Topic detection (word-boundary aware so 'ai' ≠ 'email') ───────────────────

  static final Map<String, List<String>> _lexicon = {
    'AI': ['ai', 'llm', 'model', 'gpt', 'gemini', 'gemma', 'inference', 'embedding', 'embeddings'],
    'Nostr': ['nostr', 'relay', 'relays', 'npub'],
    'Cloudflare': ['cloudflare', 'worker', 'workers', 'd1', 'r2', 'vectorize', 'wrangler'],
    'Coding': ['code', 'bug', 'api', 'flutter', 'dart', 'deploy', 'function', 'database'],
    'Startup': ['startup', 'founder', 'business', 'revenue', 'pricing', 'investor', 'investors'],
    'Privacy': ['privacy', 'private', 'encrypt', 'encryption', 'secure'],
    'Food & Aquaculture': ['food', 'aquaculture', 'fish', 'trout', 'fishery', 'processing'],
    'Payments': ['payment', 'payments', 'wallet', 'coin', 'coins', 'crypto', 'bitcoin'],
    'Marketing': ['marketing', 'ads', 'campaign', 'growth', 'seo'],
  };

  static Set<String> _topicsIn(String text) {
    final lower = text.toLowerCase();
    final words = lower
        .split(RegExp(r'[^a-z0-9]+'))
        .where((w) => w.isNotEmpty)
        .toSet();
    final found = <String>{};
    _lexicon.forEach((topic, kws) {
      for (final kw in kws) {
        final hit = kw.contains(' ') ? lower.contains(kw) : words.contains(kw);
        if (hit) {
          found.add(topic);
          break;
        }
      }
    });
    return found;
  }
}
