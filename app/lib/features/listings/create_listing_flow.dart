import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/listings_api.dart';
import '../../core/theme.dart';
import '../explore/listing_detail.dart';
import '../explore/widgets.dart';
import '../identity/identity_gate.dart';
import '../translation/translation_langs.dart';

/// Phase 6 creator pipeline — guided stepper:
/// 1 type · 2 title/description/category · 3 price (+capacity | date/time, with
/// pricing extras A5) · 4 cover photos · 5 icons (country, 18+, badges) ·
/// 6 preview-as-buyer (REAL details widget, A6) → Publish (KYC gate).
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
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Published! Your listing is live in AvaExplore.')));
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
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
          title: const Text('New listing')),
      body: Stepper(
        currentStep: _step,
        type: StepperType.vertical,
        onStepContinue: () {
          if (!_validStep(_step)) {
            setState(() => _error = _step == 1
                ? 'A title is required.'
                : _step == 3
                    ? 'Add at least one photo (up to 5).'
                    : 'Pick a future date & time.');
            return;
          }
          setState(() { _error = null; if (_step < 5) _step++; });
        },
        onStepCancel: () => setState(() { if (_step > 0) { _step--; } else { Navigator.pop(context); } }),
        controlsBuilder: (c, d) => Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Row(children: [
            if (_step < 5) FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AvaColors.ink),
              onPressed: d.onStepContinue, child: const Text('Continue'),
            ),
            if (_step == 5) FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AvaColors.brand),
              onPressed: _publishing ? null : _publish,
              child: _publishing
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Publish', style: TextStyle(fontWeight: FontWeight.w800)),
            ),
            const SizedBox(width: 8),
            TextButton(onPressed: d.onStepCancel, child: Text(_step == 0 ? 'Cancel' : 'Back')),
            if (_error != null) Expanded(child: Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 12))),
          ]),
        ),
        steps: [
          Step(title: const Text('What are you offering?'), isActive: _step >= 0, content: _stepType()),
          Step(title: const Text('Title & description'), isActive: _step >= 1, content: _stepText()),
          Step(title: const Text('Price & schedule'), isActive: _step >= 2, content: _stepPrice()),
          Step(title: const Text('Cover photos'), isActive: _step >= 3, content: _stepCovers()),
          Step(title: const Text('Icons & flags'), isActive: _step >= 4, content: _stepIcons()),
          Step(title: const Text('Preview & publish'), isActive: _step >= 5, content: _stepPreview()),
        ],
      ),
    );
  }

  Widget _stepType() => Column(children: [
        RadioListTile<String>(
          value: 'live_event', groupValue: _kind, onChanged: (v) => setState(() => _kind = v!),
          title: const Text('Live event'), subtitle: const Text('Stream to many viewers at a set time (AvaLive)'),
        ),
        RadioListTile<String>(
          value: 'consult', groupValue: _kind, onChanged: (v) => setState(() => _kind = v!),
          title: const Text('Consultation'), subtitle: const Text('Bookable 1:1 or small-group sessions from your availability'),
        ),
      ]);

  Widget _stepText() => Column(children: [
        TextField(controller: _title, maxLength: 140,
            decoration: const InputDecoration(labelText: 'Title', counterText: '')),
        const SizedBox(height: 8),
        TextField(controller: _desc, maxLines: 4,
            decoration: const InputDecoration(labelText: 'Description', hintText: 'What will attendees get?')),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          value: _category,
          decoration: const InputDecoration(labelText: 'Category'),
          items: [
            if (_cats.isEmpty) const DropdownMenuItem(value: 'teachers', child: Text('Teachers')),
            for (final c in _cats) DropdownMenuItem(value: c.id, child: Text('${c.emoji} ${c.label}')),
          ],
          onChanged: (v) => setState(() => _category = v ?? 'teachers'),
        ),
      ]);

  Widget _stepPrice() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        TextField(controller: _price, keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Price (USD)', prefixText: '\$ ', helperText: '0 = free')),
        const SizedBox(height: 10),
        if (_kind == 'consult') ...[
          const Text('Group size', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
          const SizedBox(height: 6),
          Wrap(spacing: 8, children: [
            for (final c in const [1, 10, 20])
              ChoiceChip(label: Text(c == 1 ? '1:1' : 'Up to $c'), selected: _capacity == c,
                  onSelected: (_) => setState(() => _capacity = c)),
          ]),
          const SizedBox(height: 10),
        ],
        if (_kind == 'live_event') ...[
          OutlinedButton.icon(
            icon: const Icon(Icons.event, size: 17),
            label: Text(_start == null ? 'Pick date & time' : fmtWhen(_start!.millisecondsSinceEpoch)),
            onPressed: () async {
              final d = await showDatePicker(context: context, initialDate: DateTime.now().add(const Duration(days: 1)),
                  firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 180)));
              if (d == null || !mounted) return;
              final t = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 18, minute: 0));
              if (t == null) return;
              setState(() => _start = DateTime(d.year, d.month, d.day, t.hour, t.minute));
            },
          ),
          const SizedBox(height: 6),
          const Text('If the time conflicts with your calendar, publish will flag it (greyed slot).',
              style: TextStyle(fontSize: 11.5, color: AvaColors.sub)),
          const SizedBox(height: 10),
        ],
        Row(children: [
          const Text('Duration', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
          const SizedBox(width: 10),
          DropdownButton<int>(
            value: _duration,
            items: [for (final m in const [15, 30, 45, 60, 90, 120, 180]) DropdownMenuItem(value: m, child: Text('$m min'))],
            onChanged: (v) => setState(() => _duration = v ?? 60),
          ),
        ]),
        const Divider(height: 24),
        const Text('Pricing extras', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5)),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _earlyBird, onChanged: (v) => setState(() => _earlyBird = v),
          title: const Text('Early-bird discount', style: TextStyle(fontSize: 14)),
        ),
        if (_earlyBird) Row(children: [
          SizedBox(width: 90, child: TextField(controller: _ebPct, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: '% off', isDense: true))),
          const SizedBox(width: 10),
          TextButton.icon(icon: const Icon(Icons.schedule, size: 16),
              label: Text(_ebEnds == null ? 'Until…' : fmtWhen(_ebEnds!.millisecondsSinceEpoch)),
              onPressed: () async {
                final d = await showDatePicker(context: context, initialDate: DateTime.now().add(const Duration(days: 3)),
                    firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 180)));
                if (d != null) setState(() => _ebEnds = d);
              }),
        ]),
        const SizedBox(height: 4),
        Row(children: [
          Expanded(child: TextField(controller: _promoCode, textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Promo code (optional)', isDense: true))),
          const SizedBox(width: 8),
          SizedBox(width: 70, child: TextField(controller: _promoPct, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: '% off', isDense: true))),
          const SizedBox(width: 8),
          SizedBox(width: 80, child: TextField(controller: _promoMax, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Max uses', isDense: true))),
        ]),
      ]);

  Widget _stepCovers() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 10, runSpacing: 10, children: [
          for (var i = 0; i < _coverUrls.length; i++)
            Stack(children: [
              CoverImage(url: _coverUrls[i], seed: i, width: 90, height: 90),
              Positioned(right: 0, top: 0, child: GestureDetector(
                onTap: () => setState(() => _coverUrls.removeAt(i)),
                child: Container(decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                    padding: const EdgeInsets.all(3), child: const Icon(Icons.close, size: 14, color: Colors.white)),
              )),
            ]),
          if (_coverUrls.length < 5)
            GestureDetector(
              onTap: _pickCover,
              child: Container(
                width: 90, height: 90,
                decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
                child: _uploading
                    ? const Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
                    : const Icon(Icons.add_a_photo_outlined, color: AvaColors.sub),
              ),
            ),
        ]),
        const SizedBox(height: 6),
        const Text('1–5 photos (at least one required). Served via Cloudflare (AVIF) and cached on devices.',
            style: TextStyle(fontSize: 11.5, color: AvaColors.sub)),
      ]);

  Widget _stepIcons() => Column(children: [
        TextField(controller: _country, maxLength: 2, textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(labelText: 'Country code (e.g. IN, US)', counterText: '')),
        TextField(controller: _language,
            decoration: const InputDecoration(labelText: 'Language (badge, optional)')),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _adultsOnly, onChanged: (v) => setState(() => _adultsOnly = v),
          title: const Text('18+ only'),
        ),
        const Divider(height: 20),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _translationEnabled, onChanged: (v) => setState(() => _translationEnabled = v),
          title: const Text('🌐 Voice translation available'),
          subtitle: const Text(
            'Attendees can hear you live in their own language. They pay \$3/hour '
            'in AvaCoins on top of your price — your earnings are not affected.',
            style: TextStyle(fontSize: 12),
          ),
        ),
        if (_translationEnabled)
          DropdownButtonFormField<String>(
            value: _spokenLang,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Language of transmission (the language you speak)'),
            items: [
              for (final l in kTranslationLangs) DropdownMenuItem(value: l.code, child: Text(l.label)),
            ],
            onChanged: (v) => setState(() => _spokenLang = v),
          ),
      ]);

  // A6: the preview renders the REAL details-page widget with draft data.
  Widget _stepPreview() => Container(
        height: 460,
        decoration: BoxDecoration(border: Border.all(color: AvaColors.line), borderRadius: BorderRadius.circular(16)),
        clipBehavior: Clip.antiAlias,
        child: ListingDetailView(card: _draftCard()),
      );
}
