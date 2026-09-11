import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/availability_time.dart';
import '../../../core/cached_image.dart';
import '../../../core/listings_api.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/ui/motion/motion.dart';
import '../../identity/listing_liveness_gate.dart';
import '../../identity/public_action_gate.dart' show isIdentityRequired;

/// The app-native counterpart of the web listing wizard.
///
/// This screen deliberately talks to the wizard endpoints rather than the
/// legacy flat listing editor. The Worker remains authoritative for field
/// validation, eligibility, moderation, review, and publishing.
class NativeListingWizardScreen extends StatefulWidget {
  const NativeListingWizardScreen({
    super.key,
    this.listingId,
    this.initialKind,
    this.source = 'menu',
    this.returnOnSubmit = false,
  });

  final String? listingId;
  final String? initialKind;
  final String source;
  final bool returnOnSubmit;

  @override
  State<NativeListingWizardScreen> createState() => _NativeListingWizardScreenState();
}

class _NativeListingWizardScreenState extends State<NativeListingWizardScreen> {
  static const _steps = <String>[
    'Type', 'Pitch', 'Money', 'Time', 'How it works', 'House rules', 'Photos', 'Review'
  ];

  final _title = TextEditingController();
  final _blurb = TextEditingController();
  final _description = TextEditingController();
  final _price = TextEditingController();
  final _location = TextEditingController();
  final _timezone = TextEditingController();
  final _how = TextEditingController();
  final _rules = TextEditingController();
  final _faq = TextEditingController();
  final _preparation = TextEditingController();
  final _whatGet = TextEditingController();
  final _whoFor = TextEditingController();
  final _notFor = TextEditingController();
  final _joinRequirements = TextEditingController();
  final _videoUrl = TextEditingController();
  final _startsAt = TextEditingController();
  final _duration = TextEditingController(text: '60');
  final _capacity = TextEditingController(text: '0');

  int _step = 0;
  String _kind = 'live_event';
  String _category = '';
  String _mediaMode = 'audio_video';
  String _scheduleMode = 'fixed_date';
  String? _id;
  String? _error;
  bool _loading = false, _freeEntry = false, _adultsOnly = false, _dirty = false;
  bool _saving = false;
  bool _publishing = false;
  bool _copyReviewed = false;
  List<ExploreCategory> _categories = const [];
  final _coverUrls = <String>[];
  String? _faceUrl;

  @override
  void initState() {
    super.initState();
    _id = widget.listingId;
    _kind = widget.initialKind ?? _kind;
    Analytics.capture('listing_native_wizard_opened', {
      'source': widget.source,
      'resumed': widget.listingId != null,
    });
    _load();
  }

  @override
  void dispose() {
    for (final c in [_title, _blurb, _description, _price, _location, _timezone, _how, _rules, _faq, _preparation, _whatGet, _whoFor, _notFor, _joinRequirements, _videoUrl, _startsAt, _duration, _capacity]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      _categories = await ListingsApi.categories();
      if (_id != null) {
        final raw = await ListingsApi.wizardGet(_id!);
        if (raw['ok'] != true) throw StateError('Could not load listing');
        final detail = ListingDetail.fromJson(raw);
        final l = detail.listing;
        _kind = l.kind == 'live' ? 'live_event' : l.kind;
        _title.text = l.title;
        _blurb.text = l.blurb ?? '';
        _description.text = l.description ?? '';
        _price.text = l.price > 0 ? '${l.price}' : '';
        _location.text = l.location ?? '';
        _timezone.text = l.timezone ?? '';
        _category = l.category;
        _mediaMode = l.mediaMode;
        _scheduleMode = l.scheduleMode ?? _scheduleMode;
        _freeEntry = l.freeEntry;
        _startsAt.text = _epochToLocal(l.startsAt, (l.timezone ?? '').isEmpty ? 'Asia/Kolkata' : l.timezone!);
        _duration.text = '${l.durationMin ?? 60}';
        _capacity.text = '${l.capacity ?? 0}';
        _coverUrls.addAll(l.coverMedia.map((m) => m is Map ? m['url']?.toString() : null).whereType<String>().where((u) => u.isNotEmpty));
        final attrs = l.attrs;
        _how.text = _asText(attrs['content_how_it_works']);
        _rules.text = _asText(attrs['content_house_rules']);
        _faq.text = _asText(attrs['content_faq']);
        _preparation.text = (attrs['commercial_preparation_instructions'] ?? '').toString();
        _whatGet.text = _asText(attrs['content_what_you_get']);
        _whoFor.text = _asText(attrs['content_who_for']);
        _notFor.text = _asText(attrs['content_not_for']);
        _joinRequirements.text = attrs['join_requirements'] is Map ? jsonEncode(attrs['join_requirements']) : '';
        _videoUrl.text = l.videoUrl ?? '';
        final face = attrs['face_photo'];
        _faceUrl = face is String ? face : (face is Map ? face['url']?.toString() : null);
        _step = 7;
      }
    } catch (e) {
      _error = 'Could not load this listing. Try again.';
    }
    if (mounted) setState(() => _loading = false);
  }

  static String _asText(dynamic value) {
    if (value is List) return value.map((v) => v.toString()).join('\n');
    return value?.toString() ?? '';
  }

  /// [LISTING-EXPIRY-1 / P1-6] The listing's IANA zone, IST when blank — the
  /// same default the server's `listings.timezone` column has.
  String get _zone {
    final z = _timezone.text.trim();
    return z.isEmpty ? 'Asia/Kolkata' : z;
  }

  /// Wall-clock text for the start field, in the LISTING's timezone. It used to
  /// be `toLocal()`, so the field showed a different time on a phone set to
  /// another zone than the time the buyer page advertises.
  static String _epochToLocal(int? epoch, [String timezone = 'Asia/Kolkata']) {
    if (epoch == null || epoch == 0) return '';
    final instant = DateTime.fromMillisecondsSinceEpoch(epoch < 100000000000 ? epoch * 1000 : epoch, isUtc: true);
    DateTime d;
    try {
      d = AvailabilityTime.inTimezone(instant, timezone);
    } catch (_) {
      d = instant.toLocal();
    }
    String p(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)}T${p(d.hour)}:${p(d.minute)}';
  }

  /// The typed start time read AS the listing's wall clock. `DateTime.tryParse`
  /// alone read it in the phone's zone — on a phone set to UTC, "21:12" became
  /// 02:42 IST, which is how the prod "Cooking with Davy" show got its time.
  int? _startsAtEpoch() {
    final text = _startsAt.text.trim();
    final parsed = DateTime.tryParse(text);
    if (parsed == null) return null;
    try {
      return AvailabilityTime.wallTimeToUtc(
        date: DateTime(parsed.year, parsed.month, parsed.day),
        minutes: parsed.hour * 60 + parsed.minute,
        timezone: _zone,
      ).millisecondsSinceEpoch;
    } catch (_) {
      return parsed.millisecondsSinceEpoch;
    }
  }

  Map<String, dynamic> _body() => {
        'title': _title.text.trim(),
        'blurb': _blurb.text.trim(),
        'description': _description.text.trim(),
        'category': _category,
        'price': _freeEntry ? 0 : (int.tryParse(_price.text.trim()) ?? 0),
        'free_entry': _freeEntry,
        'kind': _kind,
        'location': _location.text.trim(),
        'video_url': _videoUrl.text.trim(),
        'timezone': _timezone.text.trim().isEmpty ? null : _timezone.text.trim(),
        'schedule_mode': _scheduleMode,
        'starts_at': _startsAtEpoch(),
        'duration_min': int.tryParse(_duration.text) ?? 60,
        'capacity': int.tryParse(_capacity.text) ?? 0,
        'media_mode': _mediaMode,
        'cover_media': [for (final url in _coverUrls) {'type': 'image', 'url': url}],
        'adults_only': _adultsOnly,
        'attrs': {
          'content_how_it_works': _lines(_how.text),
          'content_house_rules': _lines(_rules.text),
          'content_faq': _lines(_faq.text),
          'content_what_you_get': _lines(_whatGet.text),
          'content_who_for': _lines(_whoFor.text),
          'content_not_for': _lines(_notFor.text),
          'join_requirements': _jsonMap(_joinRequirements.text),
          'commercial_preparation_instructions': _preparation.text.trim(),
          if (_faceUrl != null) 'face_photo': {'url': _faceUrl},
        },
      };

  static List<String> _lines(String value) => value.split('\n').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
  static dynamic _jsonMap(String value) { try { final v = jsonDecode(value); return v is Map ? v : <String, dynamic>{}; } catch (_) { return <String, dynamic>{}; } }

  String? _validate() {
    if (_step == 1 && (_title.text.trim().isEmpty || _description.text.trim().isEmpty)) return 'Add a title and description.';
    if (_step == 2 && !_freeEntry && (int.tryParse(_price.text.trim()) ?? 0) <= 0) return 'Enter a price greater than zero, or choose a free show.';
    if (_step == 3 && _kind == 'live_event' && ((_startsAtEpoch() ?? 0) <= DateTime.now().millisecondsSinceEpoch)) return 'Choose a future date and time.';
    if (_step == 6 && (_coverUrls.isEmpty || _faceUrl == null || _faceUrl!.isEmpty)) return 'Add a cover photo and private face photo.';
    if (_step == 7 && !_copyReviewed) return 'Review the copy before submitting.';
    return null;
  }

  Future<bool> _save() async {
    setState(() { _saving = true; _error = null; });
    try {
      final result = _id == null
          ? await ListingsApi.wizardCreate(_kind, _body())
          : await ListingsApi.wizardUpdate(_id!, _body());
      if (result['ok'] != true) throw StateError(_serverMessage(result));
      _id ??= result['listing_id']?.toString();
      if (_id == null) throw StateError('The server did not return a listing id.');
      _dirty = false;
      Analytics.capture('listing_native_wizard_saved', {'listing_id': _id!, 'step': _step});
      return true;
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _next() async {
    final problem = _validate();
    if (problem != null) { setState(() => _error = problem); return; }
    if (_step == 0) { setState(() => _step = 1); return; }
    if (!await _save()) return;
    if (mounted && _step < _steps.length - 1) setState(() => _step++);
  }

  Future<void> _upload({bool face = false}) async {
    if (!face && _coverUrls.length >= 5) return;
    final file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1800, imageQuality: 86);
    if (file == null) return;
    setState(() { _saving = true; _error = null; });
    try {
      final result = await ListingsApi.wizardUpload(await file.readAsBytes(), mime: 'image/jpeg', fileName: file.name);
      if (result['ok'] != true || result['url'] == null) throw StateError('Photo upload failed.');
      setState(() {
        if (face) {
          _faceUrl = result['url'].toString();
        } else {
          _coverUrls.add(result['url'].toString());
        }
        _dirty = true;
      });
      Analytics.capture('listing_native_wizard_upload_completed', {'source': widget.source});
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _submit() async {
    final problem = _validate();
    if (problem != null) { setState(() => _error = problem); return; }
    if (_id == null && !await _save()) return;
    setState(() { _publishing = true; _error = null; });
    try {
      final review = await ListingsApi.wizardReview(_id!);
      if (review['ok'] != true) throw StateError(_serverMessage(review));
      if (review['verdict']?.toString() == 'fail') {
        final issues = (review['issues'] as List? ?? const []).map((x) => x is Map ? (x['message'] ?? '').toString() : '').where((x) => x.isNotEmpty).join(' ');
        throw StateError(issues.isEmpty ? 'The server review found issues to fix before submitting.' : issues);
      }
      var result = await ListingsApi.wizardSubmit(_id!);
      if (isIdentityRequired((result['status'] as num?)?.toInt() ?? 0, jsonEncode(result))) {
        if (!mounted || !await ensureListingLiveness(context)) throw StateError('Verify your identity to submit this listing.');
        result = await ListingsApi.wizardSubmit(_id!);
      }
      if (result['ok'] != true) throw StateError(_serverMessage(result));
      Analytics.capture('listing_native_wizard_submitted', {'listing_id': _id!, 'source': widget.source});
      if (!mounted) return;
      showAdToast(context, message: 'Listing submitted for review.');
      Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _publishing = false);
    }
  }

  static String _serverMessage(Map<String, dynamic> result) =>
      (result['message'] ?? result['detail'] ?? result['error'] ?? result['reason'] ?? 'Could not save this listing.').toString();

  Widget _field(String label, TextEditingController controller, {int maxLines = 1, String? hint}) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: TextField(
          controller: controller,
          maxLines: maxLines,
          onChanged: (_) => _dirty = true,
          decoration: InputDecoration(labelText: label, hintText: hint, filled: true, fillColor: AD.inputField),
        ),
      );

  Widget _stepBody() {
    switch (_step) {
      case 0:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('What are you offering?', style: ADText.appTitle()),
          const SizedBox(height: Msg.s3),
          for (final option in const {'consult': '1:1 consultation', 'live_event': 'Live event'}.entries)
            RadioListTile<String>(title: Text(option.value), value: option.key, groupValue: _kind, onChanged: (v) => setState(() => _kind = v!)),
          SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('This is a free show'), value: _freeEntry, onChanged: (v) => setState(() { _freeEntry = v; _dirty = true; })),
        ]);
      case 1:
        return Column(children: [
          _field('Title', _title, hint: 'A clear, specific title'),
          _field('Short blurb', _blurb, hint: 'The one-line promise'),
          _field('Description', _description, maxLines: 6, hint: 'What customers should know'),
          DropdownButtonFormField<String>(value: _category.isEmpty ? null : _category, decoration: const InputDecoration(labelText: 'Category'), items: _categories.map((c) => DropdownMenuItem(value: c.id, child: Text('${c.emoji} ${c.label}'))).toList(), onChanged: (v) => setState(() => _category = v ?? '')),
        ]);
      case 2:
        return Column(children: [
          if (!_freeEntry) _field('Price per hour (Tokens = ₹)', _price, hint: 'Set a price per hour'),
          DropdownButtonFormField<String>(value: _mediaMode, decoration: const InputDecoration(labelText: 'Media mode'), items: const [DropdownMenuItem(value: 'audio_video', child: Text('Audio + video')), DropdownMenuItem(value: 'audio_only', child: Text('Audio only'))], onChanged: (v) => setState(() => _mediaMode = v ?? 'audio_video')),
        ]);
      case 3:
        return Column(children: [
          DropdownButtonFormField<String>(value: _scheduleMode, decoration: const InputDecoration(labelText: 'Schedule'), items: const [DropdownMenuItem(value: 'fixed_date', child: Text('Fixed date')), DropdownMenuItem(value: 'availability', child: Text('Use availability'))], onChanged: (v) => setState(() => _scheduleMode = v ?? 'fixed_date')),
          _field('Time zone', _timezone, hint: 'e.g. Asia/Kolkata'),
          _field('Start date and time (YYYY-MM-DDTHH:MM)', _startsAt, hint: '2026-12-31T18:00'),
          _field('Duration (minutes)', _duration, hint: '60'),
          _field('Capacity (0 = unlimited)', _capacity, hint: '0'),
          _field('Location / meeting note', _location),
        ]);
      case 4: return _field('How it works', _how, maxLines: 8, hint: 'One step per line');
      case 5: return Column(children: [_field('House rules', _rules, maxLines: 8, hint: 'One rule per line'), _field('What customers get (one per line)', _whatGet, maxLines: 5), _field('Who this is for (one per line)', _whoFor, maxLines: 5), _field('Who this is not for (one per line)', _notFor, maxLines: 5), _field('Join requirements JSON', _joinRequirements, maxLines: 3), _field('Preparation instructions', _preparation, maxLines: 5)]);
      case 6:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Cover photos (${_coverUrls.length}/5)', style: ADText.rowName()),
          const SizedBox(height: Msg.s2),
          Wrap(
            spacing: Msg.s2,
            runSpacing: Msg.s2,
            children: [
              for (var i = 0; i < _coverUrls.length; i++)
                Stack(children: [
                  CachedImage(_coverUrls[i], width: 84, height: 84, radius: Msg.brMd),
                  Positioned(right: 0, child: IconButton(icon: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold)), onPressed: () => setState(() => _coverUrls.removeAt(i)))),
                ]),
            ],
          ),
          const SizedBox(height: Msg.s3),
          OutlinedButton.icon(onPressed: _saving ? null : () => _upload(), icon: Icon(PhosphorIcons.imageSquare(PhosphorIconsStyle.regular)), label: const Text('Add photos')),
          const SizedBox(height: Msg.s3),
          Text('Private face photo', style: ADText.rowName()),
          Text('Used for identity-safe poster generation and never shown publicly.', style: ADText.preview()),
          if (_faceUrl != null) Padding(padding: const EdgeInsets.only(top: 8), child: CachedImage(_faceUrl!, width: 84, height: 84, radius: Msg.brMd)),
          OutlinedButton.icon(onPressed: _saving ? null : () => _upload(face: true), icon: Icon(PhosphorIcons.smiley(PhosphorIconsStyle.regular)), label: const Text('Choose face photo')),
          _field('Video URL', _videoUrl),
        ]);
      default:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_title.text.isEmpty ? 'Untitled listing' : _title.text, style: ADText.appTitle()),
          const SizedBox(height: Msg.s2),
          Text(_description.text.isEmpty ? 'Add a description before submitting.' : _description.text, style: ADText.preview()),
          const SizedBox(height: Msg.s3),
          _field('FAQ / final notes', _faq, maxLines: 5, hint: 'One question and answer per line'),
          CheckboxListTile(value: _copyReviewed, onChanged: (v) => setState(() => _copyReviewed = v ?? false), title: const Text('I reviewed this listing for accuracy')),
          if (_id != null) TextButton.icon(onPressed: _publishing ? null : () async {
            final result = await ListingsApi.wizardRepeat(_id!, 4);
            if (!mounted) return;
            showAdToast(context, message: result['ok'] == true ? 'Four draft copies created.' : _serverMessage(result));
          }, icon: Icon(PhosphorIcons.repeat(PhosphorIconsStyle.regular)), label: const Text('Repeat this listing for four weeks')),
        ]);
    }
  }

  @override
  Widget build(BuildContext context) {
    return WillPopScope(
      onWillPop: () async {
        if (!_dirty || _publishing) return true;
        return await showDialog<bool>(context: context, builder: (context) => AlertDialog(
          title: const Text('Leave listing?'),
          content: const Text('Your last saved draft will remain available in My listings.'),
          actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Stay')), FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Leave'))],
        )) ?? false;
      },
      child: Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(title: _id == null ? 'Create listing' : 'Edit listing', showBack: true),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : SafeArea(child: LayoutBuilder(builder: (context, constraints) {
              final width = constraints.maxWidth > 720 ? 640.0 : constraints.maxWidth;
              return Center(child: SizedBox(width: width, child: ListView(padding: const EdgeInsets.all(Msg.s4), children: [
                Text('Step ${_step + 1} of ${_steps.length} · ${_steps[_step]}', style: ADText.preview(c: AD.textSecondary)),
                const SizedBox(height: Msg.s2),
                LinearProgressIndicator(value: (_step + 1) / _steps.length),
                const SizedBox(height: Msg.s4),
                if (_error != null) AdCard(child: Text(_error!, style: ADText.preview(c: AD.danger))),
                _stepBody(),
                const SizedBox(height: Msg.s4),
                Row(children: [
                  if (_step > 0) TextButton(onPressed: _saving || _publishing ? null : () => setState(() => _step--), child: const Text('Back')),
                  const Spacer(),
                  FilledButton(onPressed: _saving || _publishing ? null : (_step == 7 ? _submit : _next), child: Text(_step == 7 ? (_publishing ? 'Submitting…' : 'Submit for review') : (_saving ? 'Saving…' : 'Save and continue'))),
                ]),
              ])));
            })),
      ),
    );
  }
}
