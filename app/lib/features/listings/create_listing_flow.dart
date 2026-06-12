import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avavoice/studio/agent_form_flow.dart';
import '../explore/listing_detail.dart';
import '../explore/widgets.dart';
import '../identity/identity_gate.dart';
import '../translation/translation_langs.dart';

/// Phase 6 creator pipeline — guided stepper:
/// 1 type · 2 title/description/category · 3 price (+capacity | date/time, with
/// pricing extras A5) · 4 cover photos · 5 icons (country, 18+, badges) ·
/// 6 preview-as-buyer (REAL details widget, A6) → Publish (KYC gate).
///
/// Visuals: AvaTOK design system ("Create Listing" flow, restyled from the
/// legacy mockup into the zine system) — ink-ringed step rail, bordered cards,
/// lime Continue, sticker hints.
class CreateListingFlow extends StatefulWidget {
  const CreateListingFlow({super.key});
  @override
  State<CreateListingFlow> createState() => _CreateListingFlowState();
}

class _CreateListingFlowState extends State<CreateListingFlow> {
  int _step = 0;
  String _kind = 'live_event';
  final _title = TextEditingController();
  final _desc = TextEditingController();
  String _category = 'teachers';
  List<ExploreCategory> _cats = [];
  final _price = TextEditingController(text: '10');
  int _capacity = 1;
  DateTime? _start;
  int _duration = 60;
  final List<String> _coverUrls = [];
  bool _uploading = false;
  final _country = TextEditingController();
  bool _adultsOnly = false;
  final _language = TextEditingController();
  // Voice translation: "available" toggle + language of transmission.
  bool _translationEnabled = false;
  String? _spokenLang;
  // A5 pricing extras
  bool _earlyBird = false;
  final _ebPct = TextEditingController(text: '20');
  DateTime? _ebEnds;
  final _promoCode = TextEditingController();
  final _promoPct = TextEditingController(text: '10');
  final _promoMax = TextEditingController(text: '20');
  bool _publishing = false;
  String? _error;

  static const _stepTitles = [
    'What are you offering?',
    'Title & description',
    'Price & schedule',
    'Cover photos',
    'Icons & flags',
    'Preview & publish',
  ];

  @override
  void initState() {
    super.initState();
    ListingsApi.categories().then((c) {
      if (mounted && c.isNotEmpty) setState(() => _cats = c);
    });
    Analytics.capture('listing_pipeline_opened');
  }

  int get _priceCoins {
    final usd = double.tryParse(_price.text.trim()) ?? 0;
    return (usd * 100).round().clamp(0, 1000000).toInt();
  }

  List<String> get _badges => [
        if (_language.text.trim().isNotEmpty) '🗣 ${_language.text.trim()}',
      ];

  ListingCard _draftCard() => ListingCard.fromJson({
        'id': 'draft', 'kind': _kind, 'title': _title.text.trim().isEmpty ? 'Untitled' : _title.text.trim(),
        'one_liner': _desc.text.trim().split('\n').first,
        'description': _desc.text.trim(),
        'category': _category, 'status': 'draft',
        'price': _priceCoins, 'effective_price': _priceCoins, 'promo_pct': 0,
        'currency_display': 'USD',
        'country': _country.text.trim().isEmpty ? null : _country.text.trim().toUpperCase(),
        'adults_only': _adultsOnly,
        'badges': _badges,
        'cover_media': [for (final u in _coverUrls) {'type': 'image', 'url': u}],
        'starts_at': _kind == 'live_event' ? _start?.millisecondsSinceEpoch : null,
        'duration_min': _duration,
        'capacity': _kind == 'consult' ? _capacity : null,
        'joined_count': 0, 'rating_count': 0,
        'translation_enabled': _translationEnabled,
        'spoken_lang': _spokenLang,
        'creator': {'uid': '', 'name': 'You', 'kyc_verified': true},
      });

  Future<void> _pickCover() async {
    if (_coverUrls.length >= 5 || _uploading) return;
    final x = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 85);
    if (x == null) return;
    setState(() => _uploading = true);
    try {
      final bytes = await x.readAsBytes();
      final res = await ApiAuth.postBytes(kUploadPublicUrl, bytes,
          extraHeaders: {'x-content-type': 'image/jpeg'}, timeout: const Duration(seconds: 60));
      if (res.statusCode == 200) {
        final url = (jsonDecode(res.body) as Map)['url']?.toString();
        if (url != null && url.isNotEmpty && mounted) setState(() => _coverUrls.add(url));
      }
    } catch (_) {/* keep UI responsive */}
    if (mounted) setState(() => _uploading = false);
  }

  bool _validStep(int s) {
    switch (s) {
      case 1: return _title.text.trim().isNotEmpty;
      case 2:
        if (_kind == 'live_event') return _start != null && _start!.isAfter(DateTime.now());
        return true;
      case 3: return _coverUrls.isNotEmpty; // at least one photo required
      default: return true;
    }
  }

  void _continue() {
    // AI voice agents have their own dedicated create + publish wizard
    // (name/voice/brain files/pricing). Hand off to it from the type step
    // rather than forcing the generic listing fields onto a voice agent.
    if (_step == 0 && _kind == 'ai_agent') {
      Analytics.capture('listing_pipeline_ai_agent_handoff');
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const AgentFormFlow()),
      );
      return;
    }
    if (!_validStep(_step)) {
      setState(() => _error = _step == 1
          ? 'A title is required.'
          : _step == 3
              ? 'Add at least one photo (up to 5).'
              : 'Pick a future date & time.');
      return;
    }
    setState(() { _error = null; if (_step < 5) _step++; });
  }

  void _back() {
    if (_step > 0) {
      setState(() { _error = null; _step--; });
    } else {
      Navigator.pop(context);
    }
  }

  Future<void> _publish() async {
    if (_coverUrls.isEmpty) {
      setState(() { _step = 3; _error = 'Add at least one photo (up to 5) before publishing.'; });
      return;
    }
    setState(() { _publishing = true; _error = null; });
    // KYC gate intercepts here if unverified (server enforces too: API 403).
    final ok = await IdentityGate.ensureVerified(context, reason: 'publish a listing');
    if (!ok) { setState(() => _publishing = false); return; }

    final id = await ListingsApi.createDraft(_kind, {
      'title': _title.text.trim(),
      'description': _desc.text.trim(),
      'category': _category,
      'price': _priceCoins,
      'country': _country.text.trim().isEmpty ? null : _country.text.trim().toUpperCase(),
      'adults_only': _adultsOnly,
      'badges': _badges,
      'cover_media': [for (final u in _coverUrls) {'type': 'image', 'url': u}],
      if (_kind == 'live_event') 'starts_at': _start!.millisecondsSinceEpoch,
      'duration_min': _duration,
      if (_kind == 'consult') 'capacity': _capacity,
      'translation_enabled': _translationEnabled,
      'spoken_lang': _spokenLang,
    });
    if (id == null) {
      if (mounted) setState(() { _publishing = false; _error = 'Could not save the listing — try again.'; });
      return;
    }
    // A5 pricing extras before publish.
    if (_earlyBird && (int.tryParse(_ebPct.text) ?? 0) > 0) {
      await ListingsApi.addPromotion(id, kind: 'early_bird', pctOff: int.parse(_ebPct.text),
          endsAt: (_ebEnds ?? _start ?? DateTime.now().add(const Duration(days: 7))).millisecondsSinceEpoch);
    }
    if (_promoCode.text.trim().isNotEmpty && (int.tryParse(_promoPct.text) ?? 0) > 0) {
      await ListingsApi.addPromotion(id, kind: 'promo_code', pctOff: int.parse(_promoPct.text),
          code: _promoCode.text.trim().toUpperCase(), maxUses: int.tryParse(_promoMax.text));
    }
    final r = await ListingsApi.publish(id);
    if (!mounted) return;
    if (r.isEmpty) {
      Analytics.capture('listing_published_client', {'kind': _kind});
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Published! Your listing is live in AvaExplore.')));
      return;
    }
    setState(() {
      _publishing = false;
      final err = r['error']?.toString();
      if (err == 'conflict') {
        final c = r['conflictWith'] as Map?;
        _error = 'That time slot is occupied${c != null ? ' by "${c['title'] ?? c['source_app']}"' : ''} — pick another time.';
      } else if (r['reason'] == 'kyc') {
        _error = 'Identity verification required before publishing.';
      } else if (err == 'no_availability') {
        _error = 'Set your availability in AvaCalendar first, then publish this consult listing.';
      } else {
        _error = r['detail']?.toString() ?? err ?? 'Publish failed.';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ZineAppBar(
        title: 'New listing',
        markWord: 'listing',
        tag: 'creator · ${_step + 1} / 6',
      ),
      body: ZinePaper(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 32),
          children: [
            for (var i = 0; i < 6; i++) _stepBlock(i),
          ],
        ),
      ),
    );
  }

  // ---- zine stepper chrome -------------------------------------------------

  Widget _stepBlock(int i) {
    final state = i == _step ? _StepState.active : (i < _step ? _StepState.done : _StepState.todo);
    final last = i == 5;
    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // rail: numbered dot + connector line
        SizedBox(
          width: 36,
          child: Column(children: [
            _stepDot(i, state),
            if (!last)
              Expanded(
                child: Container(width: 2.5, color: Zine.ink.withValues(alpha: 0.25),
                    margin: const EdgeInsets.symmetric(vertical: 4)),
              ),
          ]),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(bottom: last ? 0 : 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              GestureDetector(
                // can only jump to current or already-reached steps
                onTap: state == _StepState.todo ? null : () => setState(() { _error = null; _step = i; }),
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Text(_stepTitles[i],
                      style: ZineText.cardTitle(
                          color: state == _StepState.todo ? Zine.inkMute : Zine.ink)),
                ),
              ),
              if (state == _StepState.active) ...[
                const SizedBox(height: 8),
                ZineCard(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    _stepBody(i),
                    if (_error != null) ZineErrorMsg(_error!),
                    const SizedBox(height: 16),
                    Row(children: [
                      Expanded(
                        child: i == 5
                            ? ZineButton(
                                label: 'Publish',
                                icon: PhosphorIcons.rocketLaunch(PhosphorIconsStyle.bold),
                                fullWidth: true,
                                fontSize: 18,
                                loading: _publishing,
                                onPressed: _publishing ? null : _publish,
                              )
                            : ZineButton(
                                label: 'Continue',
                                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                                fullWidth: true,
                                fontSize: 18,
                                onPressed: _continue,
                              ),
                      ),
                      const SizedBox(width: 12),
                      ZineLink(i == 0 ? 'cancel' : 'back', fontSize: 14, onTap: _back),
                    ]),
                  ]),
                ),
              ],
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _stepDot(int i, _StepState state) {
    final (fill, fg) = switch (state) {
      _StepState.active => (Zine.lime, Zine.ink),
      _StepState.done => (Zine.ink, Zine.paper),
      _StepState.todo => (Zine.card, Zine.inkMute),
    };
    return Container(
      width: 34, height: 34,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: fill,
        border: Border.all(color: state == _StepState.todo ? Zine.inkMute : Zine.ink, width: Zine.bw),
        boxShadow: state == _StepState.active ? Zine.shadowXs : null,
      ),
      child: Center(
        child: state == _StepState.done
            ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 16, color: fg)
            : Text('${i + 1}',
                style: TextStyle(fontFamily: ZineText.display, fontWeight: FontWeight.w600,
                    fontSize: 16, color: fg)),
      ),
    );
  }

  Widget _stepBody(int i) => switch (i) {
        0 => _stepType(),
        1 => _stepText(),
        2 => _stepPrice(),
        3 => _stepCovers(),
        4 => _stepIcons(),
        _ => _stepPreview(),
      };

  // ---- step 1: offering type ----
  Widget _stepType() => Column(children: [
        _radioCard('live_event', 'Live event', 'Stream to many viewers at a set time (AvaLive)',
            PhosphorIcons.broadcast(PhosphorIconsStyle.bold), Zine.coral),
        const SizedBox(height: 10),
        _radioCard('consult', 'Consultation', 'Bookable 1:1 or small-group sessions from your availability',
            PhosphorIcons.user(PhosphorIconsStyle.bold), Zine.lilac),
        const SizedBox(height: 10),
        _radioCard('ai_agent', 'AI voice agent',
            'A Gemini-powered voice agent callers can talk to 24/7 (AvaVoice)',
            PhosphorIcons.robot(PhosphorIconsStyle.bold), Zine.blueInk),
      ]);

  Widget _radioCard(String value, String title, String sub, IconData icon, Color accent) {
    final sel = _kind == value;
    return ZinePressable(
      onTap: () => setState(() => _kind = value),
      color: sel ? Zine.blue : Zine.card,
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: sel ? Zine.shadowSm : const <BoxShadow>[],
      padding: const EdgeInsets.all(14),
      child: Row(children: [
        Container(
          width: 22, height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Zine.card,
            border: Border.all(color: Zine.ink, width: Zine.bw),
          ),
          child: sel
              ? Center(
                  child: Container(width: 9, height: 9,
                      decoration: const BoxDecoration(shape: BoxShape.circle, color: Zine.ink)))
              : null,
        ),
        const SizedBox(width: 12),
        ZineIconBadge(icon: icon, color: accent, size: 30),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.cardTitle(size: 16.5)),
            const SizedBox(height: 2),
            Text(sub, style: ZineText.sub(size: 13)),
          ]),
        ),
      ]),
    );
  }

  // ---- step 2: title / description / category ----
  Widget _stepText() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _title,
          label: 'title',
          labelIcon: PhosphorIcons.textT(PhosphorIconsStyle.bold),
          hint: 'e.g. Vedic chart reading',
          maxLength: 140,
          textCapitalization: TextCapitalization.sentences,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _desc,
          label: 'description',
          labelIcon: PhosphorIcons.article(PhosphorIconsStyle.bold),
          hint: 'What attendees will get…',
          maxLines: 4,
          textCapitalization: TextCapitalization.sentences,
        ),
        const SizedBox(height: 16),
        ZineDropdown<String>(
          label: 'category',
          value: _category,
          items: [
            if (_cats.isEmpty) const DropdownMenuItem(value: 'teachers', child: Text('Teachers')),
            for (final c in _cats) DropdownMenuItem(value: c.id, child: Text('${c.emoji} ${c.label}')),
          ],
          onChanged: (v) => setState(() => _category = v ?? 'teachers'),
        ),
      ]);

  // ---- step 3: price & schedule ----
  Widget _stepPrice() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _price,
          label: 'price (usd)',
          labelIcon: PhosphorIcons.coins(PhosphorIconsStyle.bold),
          leadText: r'$',
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
        ),
        const SizedBox(height: 8),
        const ZineSticker('0 = free', kind: ZineStickerKind.hint),
        const SizedBox(height: 16),
        if (_kind == 'consult') ...[
          Text('GROUP SIZE', style: ZineText.kicker()),
          const SizedBox(height: 9),
          Row(children: [
            for (final c in const [1, 10, 20]) ...[
              Expanded(
                child: ZineChip(
                  label: c == 1 ? '1:1' : 'Up to $c',
                  active: _capacity == c,
                  onTap: () => setState(() => _capacity = c),
                ),
              ),
              if (c != 20) const SizedBox(width: 9),
            ],
          ]),
          const SizedBox(height: 16),
        ],
        if (_kind == 'live_event') ...[
          ZinePressable(
            onTap: _pickWhen,
            color: _start == null ? Zine.card : Zine.blue,
            radius: BorderRadius.circular(Zine.rField),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            child: Row(children: [
              PhosphorIcon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold), size: 19, color: Zine.ink),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  _start == null ? 'Pick date & time' : fmtWhen(_start!.millisecondsSinceEpoch),
                  style: ZineText.value(size: 15.5),
                ),
              ),
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
            ]),
          ),
          const SizedBox(height: 8),
          Text('If the time conflicts with your calendar, publish will flag it (greyed slot).',
              style: ZineText.sub(size: 12.5)),
          const SizedBox(height: 16),
        ],
        Row(children: [
          Expanded(child: Text('DURATION', style: ZineText.kicker())),
          SizedBox(
            width: 132,
            child: ZineDropdown<int>(
              value: _duration,
              items: [for (final m in const [15, 30, 45, 60, 90, 120, 180])
                DropdownMenuItem(value: m, child: Text('$m min'))],
              onChanged: (v) => setState(() => _duration = v ?? 60),
            ),
          ),
        ]),
        const SizedBox(height: 18),
        const Divider(),
        const SizedBox(height: 6),
        Text('PRICING EXTRAS', style: ZineText.kicker()),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: Text('Early-bird discount', style: ZineText.value(size: 15))),
          ZineToggle(value: _earlyBird, onChanged: (v) => setState(() => _earlyBird = v)),
        ]),
        if (_earlyBird) ...[
          const SizedBox(height: 12),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            SizedBox(width: 92, child: ZineField(controller: _ebPct, label: '% off', keyboardType: TextInputType.number)),
            const SizedBox(width: 10),
            Expanded(
              child: ZinePressable(
                onTap: () async {
                  final d = await showDatePicker(context: context,
                      initialDate: DateTime.now().add(const Duration(days: 3)),
                      firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 180)));
                  if (d != null) setState(() => _ebEnds = d);
                },
                radius: BorderRadius.circular(Zine.rField),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                child: Row(children: [
                  PhosphorIcon(PhosphorIcons.clock(PhosphorIconsStyle.bold), size: 16, color: Zine.ink),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(_ebEnds == null ? 'Until…' : fmtWhen(_ebEnds!.millisecondsSinceEpoch),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 14)),
                  ),
                ]),
              ),
            ),
          ]),
        ],
        const SizedBox(height: 14),
        ZineField(
          controller: _promoCode,
          label: 'promo code (optional)',
          textCapitalization: TextCapitalization.characters,
          hint: 'AVATOK10',
        ),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: ZineField(controller: _promoPct, label: '% off', keyboardType: TextInputType.number)),
          const SizedBox(width: 10),
          Expanded(child: ZineField(controller: _promoMax, label: 'max uses', keyboardType: TextInputType.number)),
        ]),
      ]);

  Future<void> _pickWhen() async {
    final d = await showDatePicker(context: context,
        initialDate: DateTime.now().add(const Duration(days: 1)),
        firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 180)));
    if (d == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 18, minute: 0));
    if (t == null) return;
    setState(() => _start = DateTime(d.year, d.month, d.day, t.hour, t.minute));
  }

  // ---- step 4: cover photos ----
  Widget _stepCovers() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 12, runSpacing: 12, children: [
          for (var i = 0; i < _coverUrls.length; i++)
            Stack(clipBehavior: Clip.none, children: [
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Zine.border,
                  boxShadow: Zine.shadowXs,
                ),
                clipBehavior: Clip.antiAlias,
                child: CoverImage(url: _coverUrls[i], seed: i, width: 88, height: 88),
              ),
              Positioned(
                right: -7, top: -7,
                child: GestureDetector(
                  onTap: () => setState(() => _coverUrls.removeAt(i)),
                  child: Container(
                    width: 26, height: 26,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle, color: Zine.coral,
                      border: Border.all(color: Zine.ink, width: 2),
                    ),
                    child: const Icon(Icons.close, size: 14, color: Colors.white),
                  ),
                ),
              ),
            ]),
          if (_coverUrls.length < 5)
            GestureDetector(
              onTap: _pickCover,
              child: Container(
                width: 88, height: 88,
                decoration: BoxDecoration(
                  color: Zine.paper2,
                  borderRadius: BorderRadius.circular(Zine.rSm),
                  border: Border.all(color: Zine.ink.withValues(alpha: 0.45), width: 2),
                ),
                child: _uploading
                    ? const Center(child: SizedBox(width: 20, height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk)))
                    : PhosphorIcon(PhosphorIcons.cameraPlus(PhosphorIconsStyle.bold),
                        size: 26, color: Zine.inkSoft),
              ),
            ),
        ]),
        const SizedBox(height: 12),
        Text('1–5 photos (at least one required). Served via Cloudflare (AVIF) and cached on devices.',
            style: ZineText.sub(size: 12.5)),
      ]);

  // ---- step 5: icons & flags ----
  Widget _stepIcons() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ZineField(
          controller: _country,
          label: 'country code (e.g. IN, US)',
          labelIcon: PhosphorIcons.flag(PhosphorIconsStyle.bold),
          maxLength: 2,
          textCapitalization: TextCapitalization.characters,
          hint: 'IN',
        ),
        const SizedBox(height: 16),
        ZineField(
          controller: _language,
          label: 'language (badge, optional)',
          labelIcon: PhosphorIcons.translate(PhosphorIconsStyle.bold),
          hint: 'e.g. Hindi',
        ),
        const SizedBox(height: 18),
        Row(children: [
          Expanded(child: Text('18+ only', style: ZineText.value(size: 15))),
          ZineToggle(value: _adultsOnly, onChanged: (v) => setState(() => _adultsOnly = v)),
        ]),
        const SizedBox(height: 16),
        const Divider(),
        const SizedBox(height: 12),
        // Voice translation banner — lilac (AI/magic accent, §2).
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Zine.lilac,
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Zine.border,
            boxShadow: Zine.shadowXs,
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  PhosphorIcon(PhosphorIcons.globe(PhosphorIconsStyle.bold), size: 17, color: Zine.ink),
                  const SizedBox(width: 7),
                  Expanded(child: Text('Voice translation available', style: ZineText.cardTitle(size: 15.5))),
                ]),
                const SizedBox(height: 6),
                Text(
                  'Attendees can hear you live in their own language. They pay \$3/hour '
                  'in AvaCoins on top of your price — your earnings are not affected.',
                  style: ZineText.sub(size: 12.5, color: Zine.ink),
                ),
              ]),
            ),
            const SizedBox(width: 10),
            ZineToggle(value: _translationEnabled, onChanged: (v) => setState(() => _translationEnabled = v)),
          ]),
        ),
        if (_translationEnabled) ...[
          const SizedBox(height: 16),
          ZineDropdown<String>(
            label: 'language of transmission (the language you speak)',
            value: _spokenLang,
            hint: 'Pick a language',
            items: [
              for (final l in kTranslationLangs) DropdownMenuItem(value: l.code, child: Text(l.label)),
            ],
            onChanged: (v) => setState(() => _spokenLang = v),
          ),
        ],
      ]);

  // ---- step 6: preview & publish (A6 — REAL details widget with draft data) ----
  Widget _stepPreview() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('PREVIEW — WHAT BUYERS SEE', style: ZineText.kicker()),
        const SizedBox(height: 10),
        Container(
          height: 440,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Zine.rSm),
            border: Zine.border,
            boxShadow: Zine.shadowSm,
          ),
          clipBehavior: Clip.antiAlias,
          child: ListingDetailView(card: _draftCard()),
        ),
      ]);
}

enum _StepState { active, done, todo }
