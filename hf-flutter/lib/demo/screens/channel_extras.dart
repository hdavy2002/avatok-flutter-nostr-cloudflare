import 'dart:async';

import 'package:audioplayers/audioplayers.dart' as ap;
import 'package:flutter/material.dart';

import '../../core/brand.dart';
import '../../data/models/reel.dart';
import '../../data/services.dart';
import '../channel_pop_kit.dart';
import '../theme.dart';

/// [HF-APP-CHANNEL-PARITY-1] The parts of the website profile page (/h/<slug>) the app channel page was missing:
/// the voice introduction, the privacy line, "Let's talk about" + Languages / Verified / Private facts, and Reviews.

const Map<String, String> _langNames = {
  'hi': 'Hindi', 'en': 'English', 'mr': 'Marathi', 'bn': 'Bengali', 'ta': 'Tamil', 'te': 'Telugu', 'kn': 'Kannada', 'ml': 'Malayalam',
  'gu': 'Gujarati', 'pa': 'Punjabi', 'or': 'Odia', 'bho': 'Bhojpuri', 'gbm': 'Garhwali', 'kfy': 'Kumaoni', 'ur': 'Urdu', 'as': 'Assamese',
};

/// "hi" -> "Hindi"; a name stays a name. Mirror of web/src/lib/hfLanguages.ts.
String hfLangLabel(String v) {
  final s = v.trim();
  if (s.isEmpty) return '';
  return _langNames[s.toLowerCase()] ?? '${s[0].toUpperCase()}${s.substring(1)}';
}

/// Unique, readable language names.
List<String> hfLangLabels(List<String> list) => {for (final l in list) hfLangLabel(l)}.where((e) => e.isNotEmpty).toList();

/// "EN · HI" for the hero stats, like the website.
String hfLangTags(List<String> list) {
  final tags = <String>{};
  for (final l in list) {
    final s = l.trim().toLowerCase();
    if (s.isEmpty) continue;
    final code = _langNames.containsKey(s) ? s : _langNames.entries.firstWhere((e) => e.value.toLowerCase() == s, orElse: () => MapEntry(s, s)).key;
    tags.add(code.length <= 3 ? code.toUpperCase() : code.substring(0, 2).toUpperCase());
  }
  return tags.take(3).join(' · ');
}

String _slugLabel(String slug) {
  final w = slug.replaceAll('-', ' ').trim();
  return w.isEmpty ? slug : '${w[0].toUpperCase()}${w.substring(1)}';
}

/// "Your number stays private. Calls are bridged through <brand>."
class ChannelPrivacyLine extends StatelessWidget {
  const ChannelPrivacyLine({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 18),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        const Icon(Icons.lock_rounded, size: 18, color: GP.muted),
        const SizedBox(width: 8),
        Flexible(child: Text('Your number stays private. Calls are bridged through ${Brand.name}.', textAlign: TextAlign.center, style: t(15, color: GP.muted, w: FontWeight.w700, h: 1.35))),
      ]),
    );
  }
}

/// Shown instead of Call / Book when the profile is not verified or not live (same text as the website).
class ChannelCallsUnavailable extends StatelessWidget {
  const ChannelCallsUnavailable({super.key});

  @override
  Widget build(BuildContext context) => Semantics(
        liveRegion: true,
        child: Text('Calls and bookings are unavailable for this profile.', textAlign: TextAlign.center, style: t(15, color: GP.muted, w: FontWeight.w800, h: 1.3)),
      );
}

/// The influencer's own voice introduction: one play / pause button with the length.
class ChannelVoiceIntro extends StatefulWidget {
  const ChannelVoiceIntro({super.key, required this.url, required this.slug, required this.firstName, this.seconds});

  final String url;
  final String slug;
  final String firstName;
  final int? seconds;

  @override
  State<ChannelVoiceIntro> createState() => _ChannelVoiceIntroState();
}

class _ChannelVoiceIntroState extends State<ChannelVoiceIntro> {
  ap.AudioPlayer? _player;
  final List<StreamSubscription<Object?>> _subs = [];
  bool _playing = false;
  bool _failed = false;

  ap.AudioPlayer _ensure() {
    final existing = _player;
    if (existing != null) return existing;
    final p = ap.AudioPlayer();
    _subs.add(p.onPlayerStateChanged.listen((s) {
      if (mounted) setState(() => _playing = s == ap.PlayerState.playing);
    }));
    _subs.add(p.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = false);
    }));
    _player = p;
    return p;
  }

  Future<void> _toggle() async {
    final p = _ensure();
    try {
      if (_playing) {
        await p.pause();
      } else {
        await p.play(ap.UrlSource(widget.url));
        channelEvent('channel_voice_intro_played', {'slug': widget.slug, 'surface': 'app', 'seconds': widget.seconds});
      }
    } catch (e) {
      if (mounted) setState(() => _failed = true);
      channelEvent('channel_voice_intro_failed', {'slug': widget.slug, 'surface': 'app', 'error': e.runtimeType.toString()});
    }
  }

  @override
  void dispose() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    unawaited(_player?.dispose());
    super.dispose();
  }

  String get _len {
    final s = widget.seconds;
    if (s == null || s <= 0) return '';
    return ' · ${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 18),
      child: Column(children: [
        Semantics(
          button: true,
          label: _playing ? 'Pause ${widget.firstName}’s voice introduction' : 'Play ${widget.firstName}’s voice introduction',
          child: Material(
            color: GP.ink,
            shape: const StadiumBorder(),
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: () => unawaited(_toggle()),
              child: Container(
                constraints: const BoxConstraints(minHeight: 56),
                padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(_playing ? Icons.pause_rounded : Icons.play_arrow_rounded, color: GP.yel, size: 28),
                  const SizedBox(width: 10),
                  Flexible(child: Text('Hear ${widget.firstName}’s voice$_len', style: t(16, color: GP.paper, w: FontWeight.w900))),
                ]),
              ),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(_failed ? 'Could not play the introduction. Please try again.' : 'Recorded by the influencer', style: t(14, color: _failed ? GP.redDeep : GP.muted, w: FontWeight.w700)),
      ]),
    );
  }
}

/// "Let's talk about" chips, then Languages / Verified / Private, under the About quote (same facts as the website).
class ChannelFacts extends StatefulWidget {
  const ChannelFacts({super.key, required this.topics, required this.languages, required this.verified});

  final List<String> topics;
  final List<String> languages;
  final bool verified;

  @override
  State<ChannelFacts> createState() => _ChannelFactsState();
}

class _ChannelFactsState extends State<ChannelFacts> {
  Map<String, String> _labels = const {};

  @override
  void initState() {
    super.initState();
    if (widget.topics.isNotEmpty) unawaited(_loadLabels());
  }

  Future<void> _loadLabels() async {
    try {
      final opts = await Services.instance.searchRepo.topics();
      if (mounted) setState(() => _labels = {for (final o in opts) o.slug: o.label});
    } catch (_) {
      // labels are a nicety: the slug is turned into words instead
    }
  }

  Widget _fact(IconData icon, String title, String body) => Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: GP.bg, borderRadius: BorderRadius.circular(18)),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, color: GP.red, size: 24),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: t(17, color: GP.ink, w: FontWeight.w900)),
              const SizedBox(height: 2),
              Text(body, style: t(15, color: GP.muted, w: FontWeight.w700, h: 1.35)),
            ]),
          ),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final langs = hfLangLabels(widget.languages);
    return ColoredBox(
      color: GP.paper,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 36),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (widget.topics.isNotEmpty) ...[
            Text('Let’s talk about', textAlign: TextAlign.center, style: t(20, color: GP.ink, w: FontWeight.w900)),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
              for (final s in widget.topics)
                Container(
                  constraints: const BoxConstraints(minHeight: 40),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  decoration: BoxDecoration(color: GP.mariTint, borderRadius: BorderRadius.circular(999)),
                  child: Text(_labels[s] ?? _slugLabel(s), style: t(15, color: GP.ink, w: FontWeight.w800)),
                ),
            ]),
            const SizedBox(height: 20),
          ],
          if (langs.isNotEmpty) _fact(Icons.record_voice_over_rounded, 'Languages', langs.join(', ')),
          if (widget.verified) _fact(Icons.verified_rounded, 'Verified', 'WhatsApp number verified by OTP'),
          _fact(Icons.lock_rounded, 'Private', 'Numbers never shared'),
        ]),
      ),
    );
  }
}

/// Reviews: the rating, a 5..1 breakdown and the latest reviews, or "No reviews yet" (same as the website).
class ChannelReviewsSection extends StatelessWidget {
  const ChannelReviewsSection({super.key, required this.profile, required this.firstName});

  final PublicProfile profile;
  final String firstName;

  static String _stars(int n) => '★' * n + '☆' * (5 - n);

  static String _ago(DateTime d) {
    final days = DateTime.now().difference(d).inDays;
    if (days <= 0) return 'Today';
    if (days == 1) return 'Yesterday';
    if (days < 30) return '$days days ago';
    final months = days ~/ 30;
    if (months < 12) return months == 1 ? '1 month ago' : '$months months ago';
    final years = days ~/ 365;
    return years <= 1 ? '1 year ago' : '$years years ago';
  }

  @override
  Widget build(BuildContext context) {
    final p = profile;
    final has = p.reviewCount > 0 && p.rating != null;
    final rating = p.rating ?? 0.0;
    final total = p.ratingBreakdown.values.fold<int>(0, (a, b) => a + b);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 44, 16, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        GpSectionHead(eyebrow: 'Reviews', title: TextSpan(text: has ? 'What people say' : 'No reviews yet', style: t(32, color: GP.ink, w: FontWeight.w900, h: 1.05))),
        const SizedBox(height: 16),
        if (!has)
          Text('Be the first to talk to $firstName and tell others how it went.', textAlign: TextAlign.center, style: t(16, color: GP.muted, w: FontWeight.w700, h: 1.4))
        else ...[
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(22)),
            child: Row(children: [
              Column(children: [
                Text(rating.toStringAsFixed(1), style: t(44, color: GP.ink, w: FontWeight.w900, h: 1)),
                Text(_stars(rating.round().clamp(0, 5)), style: t(16, color: GP.mari, w: FontWeight.w900)),
                const SizedBox(height: 2),
                Text('${p.reviewCount} ${p.reviewCount == 1 ? 'review' : 'reviews'}', style: t(14, color: GP.muted, w: FontWeight.w700)),
              ]),
              const SizedBox(width: 18),
              Expanded(
                child: Column(children: [
                  for (final k in const [5, 4, 3, 2, 1])
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Row(children: [
                        SizedBox(width: 18, child: Text('$k', style: t(14, color: GP.ink, w: FontWeight.w800))),
                        Expanded(
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(99),
                            child: LinearProgressIndicator(
                              value: total == 0 ? 0 : (p.ratingBreakdown[k] ?? 0) / total,
                              minHeight: 8,
                              backgroundColor: GP.line,
                              valueColor: const AlwaysStoppedAnimation<Color>(GP.mari),
                            ),
                          ),
                        ),
                        SizedBox(width: 30, child: Text('${p.ratingBreakdown[k] ?? 0}', textAlign: TextAlign.right, style: t(14, color: GP.muted, w: FontWeight.w700))),
                      ]),
                    ),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: 14),
          for (final r in p.reviews)
            Container(
              margin: const EdgeInsets.only(bottom: 12),
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(20)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(r.firstName, style: t(17, color: GP.ink, w: FontWeight.w900))),
                  Text(_stars(r.stars), style: t(15, color: GP.mari, w: FontWeight.w900)),
                ]),
                if (r.text.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(r.text, style: t(15, color: GP.ink, w: FontWeight.w700, h: 1.4)),
                ],
                const SizedBox(height: 6),
                Text(
                  [
                    if (r.regular) 'Regular',
                    if ((r.minutes ?? 0) > 0) '${r.minutes} min call',
                    if (r.date != null) _ago(r.date!),
                  ].join(' · '),
                  style: t(14, color: GP.muted, w: FontWeight.w700),
                ),
              ]),
            ),
        ],
      ]),
    );
  }
}
